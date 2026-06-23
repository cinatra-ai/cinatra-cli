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
 * Returns { byKey, byAllPort } where:
 *   - byKey:     Map<`host:port`, workingDir> for explicit-interface binds
 *   - byAllPort: Map<port(number), workingDir> for `0.0.0.0` binds (which own the
 *                port on ANY interface — `0.0.0.0:p` also holds `127.0.0.1:p`).
 * Pure.
 */
function portOwnersFromInspect(inspectRows) {
  const byKey = new Map();
  const byAllPort = new Map();
  if (!Array.isArray(inspectRows)) return { byKey, byAllPort };
  for (const row of inspectRows) {
    const labels = row?.Config?.Labels ?? {};
    const workingDir = labels["com.docker.compose.project.working_dir"];
    if (typeof workingDir !== "string" || workingDir.length === 0) continue;
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
  return { byKey, byAllPort };
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
 * @returns {{ kind: 'self-instance'|'other-cinatra'|'idempotent-rerun'|'mixed'|'unrelated',
 *             instance?: object, ownerDir?: string }}
 */
export function classifyPortHolder({
  conflicts = null,
  conflictPorts = [],
  inspectRows = [],
  instanceRegistry = null,
  cloneRegistry = null,
  installDir = null,
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
  // NOT record it as a Cinatra instance. We did NOT positively prove it is
  // Cinatra (compose `working_dir` alone is not Cinatra-proof — any compose
  // project carries it). Treat as a possibly-Cinatra "self-instance" ONLY when
  // it is our own target; otherwise it is unproven → `unrelated` (degraded
  // honesty: never claim a stranger's compose project is a Cinatra instance).
  return { kind: "unrelated", ownerDir };
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
 *  NEW map. */
function scrubServiceEnv(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    return environment;
  }
  const out = {};
  for (const [key, value] of Object.entries(environment)) {
    const isPlainSecret = isSecretEnvKey(key);
    const isCredUrl = URL_KEY_RE.test(key) && hasInlineUrlCredentials(value);
    if ((isPlainSecret || isCredUrl) && typeof value === "string" && value.length > 0 && !/^\$\{.*\}$/.test(value)) {
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

/**
 * Generate the resolved ISOLATED compose document.
 *
 * @param {object} args
 * @param {object} args.resolvedConfig  parsed `docker compose config --format json`
 * @param {number} args.offset          host-port remap offset
 * @param {string} args.projectName     the isolated compose project (e.g. cinatra_<slug>)
 * @param {string} args.slug            the instance slug (for labels)
 * @param {number} [args.appPort]       the host app port (recorded in a label)
 * @returns {{ doc: object, ports: object }}
 *   - doc:   the rewritten compose document (valid YAML as JSON)
 *   - ports: `{ <service>: [hostPort, …] }` the FULL remapped published-port set
 */
export function generateIsolatedCompose({ resolvedConfig, offset, projectName, slug, appPort = null }) {
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

      // (4) Scrub interpolated secret env values back to ${VAR}.
      if (svc.environment) svc.environment = scrubServiceEnv(svc.environment);

      // (3) Ownership labels. `config` emits labels as an object.
      const existing =
        svc.labels && typeof svc.labels === "object" && !Array.isArray(svc.labels) ? svc.labels : {};
      svc.labels = { ...existing, ...labelBase, "ai.cinatra.service": svcName };
    }
  }

  return { doc, ports: remappedPorts };
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
  isSecretEnvKey,
  scrubServiceEnv,
  remapServicePorts,
  generateIsolatedCompose,
  renderIsolatedComposeYaml,
};

// Expose the constant for callers that build the generated filename.
export const ISOLATED_COMPOSE_FILENAME = "docker-compose.cinatra-isolated.yml";
