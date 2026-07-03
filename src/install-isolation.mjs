// ---------------------------------------------------------------------------
// Install isolation: positive conflict classification + the resolved-compose
// generator for an ISOLATED `cinatra install` (cinatra-cli#17, T4 + T7).
//
// Import-light: node builtins only (no index.mjs graph). The actual `docker`
// subprocess calls live in install.mjs; this module is pure functions over the
// parsed `docker compose config --format json` document + registry rows, so it
// is fully hermetically testable.
// ---------------------------------------------------------------------------

import { writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// ── T4 — positive conflict classifier ──────────────────────────────────────
//
// Given the set of conflicting host ports and a live `docker inspect` of the
// candidate holders, plus the instance + clone registries, return WHO owns the
// conflict. Authority order (cinatra-cli#17 §C.9): registry row state + LIVE
// Docker `working_dir` labels OVER the per-checkout marker. A `provisioning`
// row with no live containers is NOT "already installed".
//
// Degraded honesty (§C.6): we ONLY return a Cinatra-owned kind when we can
// POSITIVELY prove it (a live container whose compose `working_dir` matches a
// recorded install dir). Anything we cannot prove → `unrelated` (→ generic
// abort). And (review hardening #6) we never return a single-owner Cinatra kind
// unless EVERY conflicting port is owned by the SAME instance; a mix of
// Cinatra + stranger ports is `mixed` (destructive actions must refuse).

/** Canonicalise a publish interface to the key both sides compare on: an all-
 *  interfaces / unspecified bind (`0.0.0.0`, `::`, empty) folds to `0.0.0.0`;
 *  an explicit interface is kept verbatim. Mirrors install.mjs's normalizeHostKey
 *  so the classifier's interface granularity matches the conflict probe exactly. */
function normHost(host) {
  return host === "0.0.0.0" || host === "::" || !host ? "0.0.0.0" : String(host);
}

/**
 * Build interface-aware owner maps from live inspect rows, keyed by the compose
 * `working_dir` label (review hardening #4 — a same-port stack on a DIFFERENT interface
 * must NOT be blamed for a conflict held elsewhere). Only TCP host ports.
 * Returns { byKey, byAllPort, cinatraByDir } where:
 *   - byKey:     Map<`host:port`, workingDir> for explicit-interface binds
 *   - byAllPort: Map<port(number), workingDir> for `0.0.0.0` binds (which own the
 *                port on ANY interface — `0.0.0.0:p` also holds `127.0.0.1:p`).
 *   - cinatraByDir: Map<workingDir, {managed, kind, instance, project}> — the
 *                `ai.cinatra.*` ownership labels a container carries (cinatra-cli#39:
 *                POSITIVE proof a compose project IS a Cinatra stack, independent of
 *                the registry). Only recorded for containers carrying
 *                `ai.cinatra.managed === "true"`.
 * Pure.
 */
function portOwnersFromInspect(inspectRows) {
  const byKey = new Map();
  const byAllPort = new Map();
  const cinatraByDir = new Map();
  if (!Array.isArray(inspectRows)) return { byKey, byAllPort, cinatraByDir };
  for (const row of inspectRows) {
    const labels = row?.Config?.Labels ?? {};
    const workingDir = labels["com.docker.compose.project.working_dir"];
    if (typeof workingDir !== "string" || workingDir.length === 0) continue;
    // cinatra-cli#39: surface the `ai.cinatra.*` ownership labels per working_dir.
    // These are written by generateIsolatedCompose for every isolated stack — a
    // container carrying `ai.cinatra.managed:"true"` POSITIVELY proves the
    // owning compose project is a Cinatra instance, even without a registry row.
    if (labels["ai.cinatra.managed"] === "true" && !cinatraByDir.has(workingDir)) {
      cinatraByDir.set(workingDir, {
        managed: true,
        kind: labels["ai.cinatra.kind"] ?? null,
        instance: labels["ai.cinatra.instance"] ?? null,
        project: labels["ai.cinatra.project"] ?? null,
      });
    }
    const portMap = row?.NetworkSettings?.Ports ?? {};
    for (const [spec, bindings] of Object.entries(portMap)) {
      if (!/\/tcp$/i.test(spec)) continue;
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const hp = Number.parseInt(String(b?.HostPort ?? ""), 10);
        if (!Number.isFinite(hp) || hp <= 0) continue;
        const host = normHost(b?.HostIp);
        if (host === "0.0.0.0") byAllPort.set(hp, workingDir);
        else byKey.set(`${host}:${hp}`, workingDir);
      }
    }
  }
  return { byKey, byAllPort, cinatraByDir };
}

/** Resolve the owning working_dir of a single conflict (interface-aware). A
 *  `0.0.0.0` owner covers any interface for the same port; an explicit-interface
 *  bind only matches its own key. Returns the working_dir string or null. */
function ownerOfConflict(owners, host, port) {
  const h = normHost(host);
  // An all-interfaces owner covers the port on EVERY interface.
  if (owners.byAllPort.has(port)) return owners.byAllPort.get(port);
  // Exact interface key.
  if (owners.byKey.has(`${h}:${port}`)) return owners.byKey.get(`${h}:${port}`);
  // A conflict probed on all-interfaces is only owned by an all-interfaces bind
  // (already checked) — no narrower bind can satisfy it. Otherwise unowned.
  return null;
}

/**
 * Classify the holder of a port conflict (INTERFACE-AWARE, review hardening #4).
 *
 * @param {object} args
 * @param {Array}  [args.conflicts]     the conflicting bindings `[{host, port}]`
 *                                      (preferred — interface-aware).
 * @param {number[]} [args.conflictPorts] legacy port-only list (each port is
 *                                      treated as all-interfaces). Used when
 *                                      `conflicts` is absent (back-compat).
 * @param {Array}   args.inspectRows     parsed `docker inspect` of candidate containers
 * @param {object}  [args.instanceRegistry] parsed instances.json (or null)
 * @param {object}  [args.cloneRegistry]    parsed clones.json (or null)
 * @param {string}  [args.installDir]    the dir THIS install is targeting (for self-detection)
 * @param {function} [args.readMarker]   `(dir) => { status, marker }` — reads the
 *                                       per-checkout `.cinatra/instance.json` marker
 *                                       (cinatra-cli#39). Injected so this pure module
 *                                       stays import-light/hermetic; defaults to a
 *                                       no-op "missing" reader (label-only proof).
 * @returns {{ kind: 'self-instance'|'other-cinatra'|'idempotent-rerun'|'mixed'|'unrelated',
 *             instance?: object, ownerDir?: string, backfill?: object }}
 */
export function classifyPortHolder({
  conflicts = null,
  conflictPorts = [],
  inspectRows = [],
  instanceRegistry = null,
  cloneRegistry = null,
  installDir = null,
  readMarker = () => ({ status: "missing", marker: null }),
} = {}) {
  // Normalise the conflict set to `[{host, port}]`. A legacy port-only entry is
  // treated as an all-interfaces (0.0.0.0) probe so a `0.0.0.0` owner matches it.
  const conflictList = Array.isArray(conflicts) && conflicts.length
    ? conflicts.filter((c) => Number.isInteger(c?.port)).map((c) => ({ host: c.host ?? "0.0.0.0", port: c.port }))
    : (conflictPorts ?? []).filter((p) => Number.isInteger(p)).map((p) => ({ host: "0.0.0.0", port: p }));
  if (conflictList.length === 0) {
    return { kind: "unrelated" };
  }

  const owners = portOwnersFromInspect(inspectRows);
  const wantDir = installDir ? path.resolve(installDir) : null;

  // Resolve each conflicting binding to an owning working_dir (interface-aware).
  const ownerDirs = conflictList.map((c) => ownerOfConflict(owners, c.host, c.port));
  const provenDirs = ownerDirs.filter((d) => typeof d === "string" && d.length > 0);

  // No conflicting binding is provably owned by ANY live compose project → we
  // cannot positively prove Cinatra. Fail safe to `unrelated` (generic abort).
  if (provenDirs.length === 0) {
    return { kind: "unrelated" };
  }

  // Mixed: at least one conflicting binding has no proven Cinatra-owned
  // working_dir (held by a stranger), OR the proven bindings map to MORE THAN
  // ONE distinct working_dir. Either way a destructive single-owner action is
  // unsafe (review hardening #6/#4).
  const distinctDirs = new Set(provenDirs);
  if (provenDirs.length !== conflictList.length || distinctDirs.size > 1) {
    return { kind: "mixed", ownerDirs: [...distinctDirs] };
  }

  // Every conflicting port is owned by exactly ONE working_dir.
  const ownerDir = path.resolve([...distinctDirs][0]);

  // Is that working_dir a RECORDED Cinatra instance? (registry = authority).
  const instances = instanceRegistry?.instances ?? {};
  let matchedInstance = null;
  for (const slot of Object.values(instances)) {
    if (typeof slot?.installDir === "string" && path.resolve(slot.installDir) === ownerDir) {
      matchedInstance = slot;
      break;
    }
  }

  // Same checkout as the one we are (re-)installing → idempotent re-run / self.
  if (wantDir && ownerDir === wantDir) {
    // If the registry knows it AND it is ready, this is the canonical
    // idempotent re-run; otherwise it's still self (provisioning ghost we own).
    return {
      kind: "idempotent-rerun",
      instance: matchedInstance ?? undefined,
      ownerDir,
    };
  }

  // A DIFFERENT checkout that the registry records as a Cinatra instance.
  if (matchedInstance) {
    return { kind: "other-cinatra", instance: matchedInstance, ownerDir };
  }

  // Proven to be a live compose project at a single dir, but the registry does
  // NOT record it as a Cinatra instance. cinatra-cli#39: compose `working_dir`
  // alone is not Cinatra-proof (any compose project carries it), BUT the
  // `ai.cinatra.*` labels we stamp on every isolated stack AND the per-checkout
  // marker (`.cinatra/instance.json`) ARE positive proof. If EITHER is present
  // for this owner dir, recognise it as `other-cinatra` (with a synthesized
  // instance) and flag it for registry BACKFILL by the executor — so legacy /
  // never-recorded instances are no longer mis-classified `unrelated`.
  const proof = cinatraProofForDir(owners, ownerDir, readMarker);
  if (proof) {
    const instance = synthInstanceFromProof(ownerDir, proof);
    return { kind: "other-cinatra", instance, ownerDir, backfill: instance };
  }

  // No positive Cinatra proof (no `ai.cinatra.*` label, no marker) → unproven
  // → `unrelated` (degraded honesty: never claim a stranger's compose project is
  // a Cinatra instance).
  return { kind: "unrelated", ownerDir };
}

/** cinatra-cli#39 — positive Cinatra proof for an owner dir from EITHER the live
 *  `ai.cinatra.*` container labels OR the per-checkout marker. Returns a
 *  normalized `{ source, slug, project, kind }` proof or null. The label is the
 *  stronger signal (live container we stamped); the marker is the fallback (a
 *  checkout that recorded itself but whose containers predate / lack labels, or a
 *  default-stack checkout that has only a marker). Pure given `readMarker`.
 *
 *  HARDENING (codex #2): proof requires a STRUCTURALLY USEFUL identity — a
 *  non-empty compose `project` AND a non-empty `slug`. `ai.cinatra.managed:"true"`
 *  alone, or a marker with no `composeProject`/`slug`, is NOT enough to classify
 *  a holder as `other-cinatra`: the executor would otherwise hold an instance
 *  with `composeProject:null` and a destructive `stop-existing` could degrade to
 *  a BARE `docker compose down` in that dir. An incomplete signal falls through
 *  to `unrelated` (degraded honesty) — both our writers (generateIsolatedCompose
 *  / writeMarker) always emit a project + slug, so this loses no legitimate
 *  recognition while closing the false-positive destructive path. */
function cinatraProofForDir(owners, ownerDir, readMarker) {
  const label = owners?.cinatraByDir?.get(ownerDir) ?? null;
  if (label && label.managed === true) {
    const slug = typeof label.instance === "string" && label.instance.length ? label.instance : null;
    const project = typeof label.project === "string" && label.project.length ? label.project : null;
    if (slug && project) {
      return {
        source: "label",
        slug,
        project,
        kind: typeof label.kind === "string" && label.kind.length ? label.kind : null,
      };
    }
    // Managed label present but identity incomplete → not safe proof; fall through
    // (try the marker, then `unrelated`).
  }
  let read;
  try {
    read = readMarker(ownerDir);
  } catch {
    read = null;
  }
  const marker = read && read.status === "ok" ? read.marker : null;
  if (marker && typeof marker === "object") {
    const slug = typeof marker.slug === "string" && marker.slug.length ? marker.slug : null;
    const project =
      typeof marker.composeProject === "string" && marker.composeProject.length ? marker.composeProject : null;
    if (slug && project) {
      return {
        source: "marker",
        slug,
        project,
        kind: typeof marker.mode === "string" && marker.mode.length ? marker.mode : null,
        marker,
      };
    }
  }
  return null;
}

/** Build a minimal instance-shaped object from label/marker proof so the
 *  conflict menu + stop/attach can name + (after backfill) act on it. `proof`
 *  always carries a non-empty `slug` + `project` (guaranteed by cinatraProofForDir),
 *  so the synthesized holder ALWAYS has a usable `composeProject` — never a
 *  null-project holder that a bare `down` could act on. cinatra-cli#39. Pure. */
function synthInstanceFromProof(ownerDir, proof) {
  return {
    slug: proof.slug,
    installDir: ownerDir,
    composeProject: proof.project,
    // A marker records the exact compose files; a label-only proof does not, so
    // default to the generated isolated compose (every `ai.cinatra.*`-labelled
    // stack is brought up from it). The executor backfill / down path uses this.
    composeFiles:
      Array.isArray(proof?.marker?.composeFiles) && proof.marker.composeFiles.length
        ? proof.marker.composeFiles
        : [ISOLATED_COMPOSE_FILENAME],
    appPort: proof?.marker?.appPort ?? null,
    ports: null,
    proofSource: proof.source,
  };
}

// ── T7 — resolved-compose generator ─────────────────────────────────────────
//
// `docker compose config --format json` resolves the merged, interpolated
// compose document. We rewrite it for an ISOLATED instance:
//   1. shift every published host port by `offset`,
//   2. rewrite resolved resource NAMES so nothing is shared with the default
//      stack (review hardening #1): the top-level project `name`, every
//      `networks.*.name`, every `volumes.*.name`, and any service
//      `container_name` are re-prefixed with the isolated project name,
//   3. add `ai.cinatra.*` ownership labels to every service AND every named
//      volume (so future detection is uniform for isolated stacks),
//   4. scrub interpolated SECRET env values back to `${VAR}` placeholders (review
//      r1 finding #2): `config` bakes in secrets (NANGO_ENCRYPTION_KEY,
//      OPENAI_API_KEY, BETTER_AUTH_SECRET, *_PASSWORD, *_TOKEN, …). The
//      container reads those from its own env/.env at up-time, so re-symbolising
//      them keeps the generated file from persisting plaintext secrets.
//
// The result is the SOLE `-f` for the isolated up (an override would APPEND
// ports, leaving the original 127.0.0.1:5434 binding ALSO published — defeating
// isolation). It is written 0600.

// Env keys whose interpolated value must be re-symbolised (never persisted as
// plaintext in the generated compose). Matched case-insensitively, by suffix or
// exact name, so it catches `*_SECRET`, `*_PASSWORD`, `*_TOKEN`, `*_KEY`,
// `*_ENCRYPTION_KEY`, plus a few exact high-value names.
const SECRET_KEY_RE =
  /(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|ENCRYPTION_KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)$/i;
const SECRET_KEY_EXACT = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NANGO_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
]);
// Keys that commonly carry a connection URL/DSN whose value can embed
// credentials (review hardening #5). These are re-symbolised ONLY when the value
// actually contains an inline `user:pass@` (a credential-free URL is harmless
// and left intact so the generated file stays self-describing).
const URL_KEY_RE = /(_URL|_DSN|_URI|CONNECTION_STRING)$/i;

function isSecretEnvKey(key) {
  if (typeof key !== "string") return false;
  if (SECRET_KEY_EXACT.has(key)) return true;
  return SECRET_KEY_RE.test(key);
}

/** True iff a value is a URL/DSN carrying inline credentials (`scheme://user:pass@…`). */
function hasInlineUrlCredentials(value) {
  return typeof value === "string" && /:\/\/[^/@\s]+:[^/@\s]+@/.test(value);
}

/** Re-symbolise secret env VALUES to `${KEY}` in a service `environment` map.
 *  Compose `config` emits `environment` as an object (key→value). A value that
 *  is already `${...}` or empty is left alone. A `*_URL`/`*_DSN`/connection-string
 *  whose value embeds `user:pass@` is also re-symbolised (review hardening #5). Returns a
 *  NEW map.
 *
 *  cinatra-cli#57 — re-symbolising to `${KEY}` only resolves if SOMETHING supplies
 *  `KEY` at `docker compose up` time. The isolated `up` runs with
 *  `--env-file .env.local`, so we re-symbolise a secret value ONLY when the
 *  instance's env-file actually defines that key (`envFileKeys`). When it does
 *  NOT, the value is an infra-init DEFAULT baked into the donor's compose
 *  (`POSTGRES_PASSWORD: postgres`, `NANGO_DB_PASSWORD: nango`,
 *  `NANGO_DASHBOARD_PASSWORD: cinatra-local`, …) — those are PUBLIC, already in
 *  the donor's git, and DIFFER per service (postgres=`postgres` vs
 *  nango-db=`nango`). Re-symbolising them to a single flat `${POSTGRES_PASSWORD}`
 *  would (a) resolve to a BLANK string (nothing supplies them — the #57 bug) AND
 *  (b) COLLAPSE the per-service values into one (breaking nango-db / twenty /
 *  plane, which each hardcode a different `POSTGRES_PASSWORD`). So a
 *  compose-default secret is left as its LITERAL — it resolves correctly and
 *  stays self-contained. We still scrub the genuine operator secrets
 *  (`OPENAI_API_KEY`, `NANGO_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, the
 *  `${NEO4J_PASSWORD}`-sourced neo4j password, …) — those ARE in `.env.local`, so
 *  they both resolve AND never get persisted as plaintext in the generated file.
 *
 *  `envFileKeys` is a Set of the keys the instance's env-file supplies; when it
 *  is null (legacy / hermetic callers), every secret-shaped value is scrubbed
 *  (the prior behaviour) so existing tests + the credential-URL hardening hold.
 *  We NEVER log a value here. */
function scrubServiceEnv(environment, envFileKeys = null) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    return environment;
  }
  const supplies = (key) => {
    // No env-file context → preserve the legacy "scrub every secret" behaviour.
    if (!(envFileKeys instanceof Set)) return true;
    return envFileKeys.has(key);
  };
  const out = {};
  for (const [key, value] of Object.entries(environment)) {
    const isPlainSecret = isSecretEnvKey(key);
    const isCredUrl = URL_KEY_RE.test(key) && hasInlineUrlCredentials(value);
    const scrubbable =
      (isPlainSecret || isCredUrl) && typeof value === "string" && value.length > 0 && !/^\$\{.*\}$/.test(value);
    // Only re-symbolise when the env-file WILL supply this key (so `${KEY}`
    // resolves). A scrubbable value whose key is NOT in the env-file is an
    // infra-init compose DEFAULT → keep the literal (resolves; never collapses).
    if (scrubbable && supplies(key)) {
      out[key] = `\${${key}}`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Rewrite the published host ports of a service's `ports` list by `offset`.
 * `config --format json` emits the long form `{ published, target, host_ip,
 * protocol, mode }`. Returns a NEW list. Non-TCP / unpublished entries are kept
 * verbatim (only their `published` is shifted when present + numeric).
 */
function remapServicePorts(ports, offset) {
  if (!Array.isArray(ports)) return ports;
  return ports.map((p) => {
    if (!p || typeof p !== "object") return p;
    const published = p.published;
    if (published === undefined || published === null || published === "") return p;
    const raw = String(published).trim();
    // Single port only (the resolved config expands ranges to single entries).
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || String(n) !== raw) return p;
    return { ...p, published: String(n + offset) };
  });
}

// ── cinatra-cli#97 — self-advertised host-URL remap ──────────────────────────
//
// Shifting a service's PUBLISHED host ports (remapServicePorts) is not enough: a
// container that ADVERTISES its own public URL back to the host/browser does so
// as a loopback URL on that published port — e.g. Nango's
// `NANGO_SERVER_URL` / `NANGO_PUBLIC_SERVER_URL: http://localhost:3003` (used to
// build OAuth callback URLs the HOST browser must reach). If that URL is left on
// the donor/default port while the host binding moved to `<port>+offset`, the
// isolated stack's OAuth callbacks land on the MAIN instance's Nango — the
// cinatra-cli#97 isolation leak. Such URLs must follow the host-port shift.
//
// An IN-NETWORK infra URL is different: it uses service-DNS (`http://nango-db:
// 5432`, `redis://redis:6379`) — host = the service name, NOT loopback — and is
// left verbatim (the container resolves it over the compose network, not a host
// port). So the rewrite is gated to loopback hosts (`localhost` / `127.0.0.1`)
// AND to ports the stack actually publishes; a bare port number
// (`SERVER_PORT: "3003"`) has no `://` and is untouched.
const LOOPBACK_HOSTPORT_SRC = "\\b(localhost|127\\.0\\.0\\.1):(\\d{1,5})\\b";

/** Shift the port of every loopback URL (`localhost`/`127.0.0.1`) in `value` by
 *  `offset` when that port is in `publishedSet` (the stack's pre-shift published
 *  host ports). Only URL-shaped values (containing `://`) are considered, so a
 *  bare host:port config or a non-URL string is never touched. Surgical string
 *  replace — scheme/path/query are preserved exactly (no URL re-normalisation
 *  that could add a stray trailing slash). Returns the (possibly) new string.
 *  cinatra-cli#97. Pure. */
function remapEnvHostUrlPorts(value, offset, publishedSet) {
  if (typeof value !== "string" || !value.includes("://")) return value;
  if (!(publishedSet instanceof Set) || publishedSet.size === 0) return value;
  return value.replace(new RegExp(LOOPBACK_HOSTPORT_SRC, "gi"), (match, host, portStr) => {
    const port = Number.parseInt(portStr, 10);
    if (Number.isInteger(port) && publishedSet.has(port)) return `${host}:${port + offset}`;
    return match;
  });
}

/** cinatra-cli#97 invariant scan: return the `service.KEY` list of any generated
 *  compose `environment` value that STILL references a loopback URL on an
 *  UN-OFFSET (original) published host port — i.e. a self-advertised URL that did
 *  not follow the host-port shift. Empty ⇒ the invariant holds.
 *  `originalPublishedPorts` is the pre-shift published host-port set (numbers or
 *  a Set). Pure. */
function findUnmappedComposeHostUrls(doc, originalPublishedPorts) {
  const set =
    originalPublishedPorts instanceof Set
      ? originalPublishedPorts
      : new Set((Array.isArray(originalPublishedPorts) ? originalPublishedPorts : []).filter(Number.isInteger));
  const offenders = [];
  if (set.size === 0) return offenders;
  const services = doc?.services && typeof doc.services === "object" ? doc.services : {};
  for (const [svcName, svc] of Object.entries(services)) {
    const env = svc?.environment;
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string" || !value.includes("://")) continue;
      for (const m of value.matchAll(new RegExp(LOOPBACK_HOSTPORT_SRC, "gi"))) {
        const port = Number.parseInt(m[2], 10);
        if (set.has(port)) {
          offenders.push(`${svcName}.${key}`);
          break;
        }
      }
    }
  }
  return offenders;
}

/** Throwing wrapper: assert the generated compose leaves NO self-advertised
 *  loopback URL on an un-offset default port (cinatra-cli#97). Holds by
 *  construction (generateIsolatedCompose shifts them); asserted defensively so a
 *  future regression fails loud at install time, not as a silent cross-instance
 *  OAuth/self-URL leak. */
export function assertComposeHostUrlsRemapped(doc, originalPublishedPorts) {
  const offenders = findUnmappedComposeHostUrls(doc, originalPublishedPorts);
  if (offenders.length > 0) {
    throw new Error(
      `Isolated compose generation left ${offenders.length} app-facing URL(s) on an UN-OFFSET default port ` +
        `(${offenders.join(", ")}) — the isolated stack would advertise the donor/default host port and leak ` +
        `OAuth callbacks / self-URL traffic to the main instance (cinatra-cli#97). Internal invariant violation.`,
    );
  }
}

/**
 * Generate the resolved ISOLATED compose document.
 *
 * @param {object} args
 * @param {object} args.resolvedConfig  parsed `docker compose config --format json`
 * @param {number} args.offset          host-port remap offset
 * @param {string} args.projectName     the isolated compose project (e.g. cinatra_<slug>)
 * @param {string} args.slug            the instance slug (for labels)
 * @param {number} [args.appPort]       the host app port (recorded in a label)
 * @param {Set<string>} [args.envFileKeys] the keys the instance's env-file
 *   (`.env.local`) supplies. A secret value is re-symbolised to `${KEY}` ONLY
 *   when this Set contains its key — so every `${VAR}` the generator introduces
 *   resolves at `up` time (cinatra-cli#57). A secret-shaped value NOT in the
 *   env-file is a compose-baked infra-init DEFAULT and is left as its literal
 *   (resolves correctly; per-service values are never collapsed). When omitted,
 *   every secret-shaped value is scrubbed (legacy behaviour).
 * @returns {{ doc: object, ports: object, scrubbedKeys: string[], remappedEnvUrls: string[] }}
 *   - doc:   the rewritten compose document (valid YAML as JSON)
 *   - ports: `{ <service>: [hostPort, …] }` the FULL remapped published-port set
 *   - scrubbedKeys: the env-file-supplied keys re-symbolised to `${KEY}` (NAMES
 *     only — never values; for transparency / the executor's invariant check).
 *   - remappedEnvUrls: the `service.KEY` names whose self-advertised loopback URL
 *     was shifted to the isolated host port (cinatra-cli#97; NAMES only).
 */
export function generateIsolatedCompose({ resolvedConfig, offset, projectName, slug, appPort = null, envFileKeys = null }) {
  if (!resolvedConfig || typeof resolvedConfig !== "object") {
    throw new Error("generateIsolatedCompose requires a parsed resolvedConfig object.");
  }
  if (!Number.isInteger(offset) || offset <= 0) {
    throw new Error("generateIsolatedCompose requires a positive integer offset.");
  }
  if (typeof projectName !== "string" || projectName.length === 0) {
    throw new Error("generateIsolatedCompose requires a non-empty projectName.");
  }

  // Deep clone so the input is never mutated (hermetic).
  const doc = JSON.parse(JSON.stringify(resolvedConfig));

  // (2) Top-level project name → the isolated project. `COMPOSE_PROJECT_NAME`
  // already drives this at up-time, but the resolved config bakes in the
  // default `name`, so overwrite it for an unambiguous file.
  doc.name = projectName;

  const labelBase = {
    "ai.cinatra.managed": "true",
    "ai.cinatra.kind": "instance",
    "ai.cinatra.instance": slug ?? projectName,
    "ai.cinatra.project": projectName,
  };
  if (appPort != null) labelBase["ai.cinatra.app-port"] = String(appPort);

  // (2) Rewrite network names so the isolated stack gets its OWN networks (never
  // the default `cinatra_default`). Keep the network KEY (services reference it
  // by key); only rewrite the resolved `.name`.
  if (doc.networks && typeof doc.networks === "object") {
    for (const [key, net] of Object.entries(doc.networks)) {
      if (net && typeof net === "object") {
        net.name = `${projectName}_${key}`;
      }
    }
  }

  // (2)+(3) Rewrite named-volume `.name` AND label them. Keep the volume KEY.
  const remappedPorts = {};
  if (doc.volumes && typeof doc.volumes === "object") {
    for (const [key, vol] of Object.entries(doc.volumes)) {
      if (vol && typeof vol === "object") {
        vol.name = `${projectName}_${key}`;
        vol.labels = { ...(vol.labels ?? {}), ...labelBase };
      }
    }
  }

  // cinatra-cli#57: record which env-file-supplied KEYS we re-symbolised (names
  // only — never values) so the executor can assert the resolution invariant.
  const scrubbedKeys = new Set();
  const keySet = envFileKeys instanceof Set ? envFileKeys : null;

  // cinatra-cli#97: the PRE-SHIFT published host-port set (computed before the
  // loop mutates `svc.ports`). A container's self-advertised loopback URL on one
  // of these ports must follow the host-port shift (else it advertises the
  // donor/default port). Collected across every service.
  const originalPublishedPorts = new Set();
  if (doc.services && typeof doc.services === "object") {
    for (const svc of Object.values(doc.services)) {
      if (!svc || typeof svc !== "object" || !Array.isArray(svc.ports)) continue;
      for (const p of svc.ports) {
        const n = Number.parseInt(String(p?.published ?? ""), 10);
        if (Number.isInteger(n) && n > 0) originalPublishedPorts.add(n);
      }
    }
  }
  const remappedEnvUrls = new Set();

  // Services: remap ports, scrub secret env, add labels, rewrite container_name.
  if (doc.services && typeof doc.services === "object") {
    for (const [svcName, svc] of Object.entries(doc.services)) {
      if (!svc || typeof svc !== "object") continue;

      // (2) A pinned container_name would collide across stacks → re-prefix it.
      if (typeof svc.container_name === "string" && svc.container_name.length) {
        svc.container_name = `${projectName}-${svcName}`;
      }

      // (1) Remap published host ports + collect them for the registry `ports`.
      if (Array.isArray(svc.ports)) {
        svc.ports = remapServicePorts(svc.ports, offset);
        const collected = [];
        for (const p of svc.ports) {
          const pub = p && typeof p === "object" ? p.published : undefined;
          const n = Number.parseInt(String(pub ?? ""), 10);
          if (Number.isFinite(n) && n > 0) collected.push(n);
        }
        if (collected.length) remappedPorts[svcName] = collected;
      }

      // (4) Scrub interpolated secret env values back to ${VAR} — but ONLY for
      // keys the instance's env-file supplies (so the placeholder resolves; a
      // compose-baked infra-init default is left literal). cinatra-cli#57.
      if (svc.environment) {
        const before = svc.environment;
        svc.environment = scrubServiceEnv(before, keySet);
        for (const [k, v] of Object.entries(svc.environment)) {
          if (typeof v === "string" && v === `\${${k}}` && before[k] !== v) scrubbedKeys.add(k);
        }
      }

      // (5) cinatra-cli#97: shift any SELF-ADVERTISED loopback URL
      // (`localhost:<port>`) whose port is a published host port by the same
      // offset — so the isolated stack advertises its OWN host port (Nango's
      // NANGO_SERVER_URL / NANGO_PUBLIC_SERVER_URL, an OAuth callback/base URL),
      // not the donor's. Runs AFTER scrub (a `${VAR}` placeholder has no `://`,
      // so it is skipped); service-DNS infra URLs + bare ports are untouched.
      if (svc.environment && typeof svc.environment === "object" && !Array.isArray(svc.environment)) {
        for (const [k, v] of Object.entries(svc.environment)) {
          const shifted = remapEnvHostUrlPorts(v, offset, originalPublishedPorts);
          if (shifted !== v) {
            svc.environment[k] = shifted;
            remappedEnvUrls.add(`${svcName}.${k}`);
          }
        }
      }

      // (3) Ownership labels. `config` emits labels as an object.
      const existing =
        svc.labels && typeof svc.labels === "object" && !Array.isArray(svc.labels) ? svc.labels : {};
      svc.labels = { ...existing, ...labelBase, "ai.cinatra.service": svcName };
    }
  }

  return { doc, ports: remappedPorts, scrubbedKeys: [...scrubbedKeys], remappedEnvUrls: [...remappedEnvUrls] };
}

/**
 * Render the generated compose doc to a string. Docker Compose reads YAML, and
 * YAML 1.2 is a JSON superset, so a `.yml` file containing the doc as
 * pretty-printed JSON is a VALID compose file — this avoids taking on a YAML
 * serialisation dependency in the dependency-light CLI (verified: `docker
 * compose -f <json-in-yml> config` accepts it, review hardening).
 */
export function renderIsolatedComposeYaml(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Write the generated compose file 0600 (it may still carry non-secret-but-
 *  private config). The `mode` option only applies on CREATION, so we ALSO
 *  chmod (review hardening #5: tighten an already-existing/world-readable file).
 *  Returns the absolute path written. */
export function writeIsolatedComposeFile(filePath, doc) {
  writeFileSync(filePath, renderIsolatedComposeYaml(doc), { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
  return path.resolve(filePath);
}

export const __test = {
  classifyPortHolder,
  portOwnersFromInspect,
  cinatraProofForDir,
  synthInstanceFromProof,
  isSecretEnvKey,
  scrubServiceEnv,
  remapServicePorts,
  remapEnvHostUrlPorts,
  findUnmappedComposeHostUrls,
  generateIsolatedCompose,
  renderIsolatedComposeYaml,
};

// Expose the constant for callers that build the generated filename.
export const ISOLATED_COMPOSE_FILENAME = "docker-compose.cinatra-isolated.yml";
