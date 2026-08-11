// ---------------------------------------------------------------------------
// `cinatra install --mode preview` — the FRONT DOOR over the preview lifecycle
// (cinatra-ai/cinatra-cli#188).
//
// WHAT THIS IS: a documented COMPOSITION over the existing `instance preview
// create` path — normal `--mode dev` provisioning (checkout at --ref, infra,
// `.env.local`), then that instance's configuration wired into the existing
// preview create, terminating in a handoff to the `instance preview …` verb
// family. It is NOT a new runtime semantic, NOT a second preview
// implementation, and NOT a replacement for `instance preview create`.
//
// LOAD-BEARING INVARIANT (#188, must not be relaxed): `--mode preview` is a
// bootstrap recipe that TERMINATES IN A CONTAINER. It must NEVER write
// `CINATRA_RUNTIME_MODE=production` into the checkout's `.env.local` — that is
// the host-prod-of-main flow the S4 runtime-contract ADR declined
// (cinatra-ai/cinatra#1580), and it would trip `assertPreviewCheckoutAllowed`,
// disqualifying that checkout from previews for as long as the value remains.
//
//     Dev `.env.local` on disk; production semantics only inside the container.
//
// The mechanism that GUARANTEES this is `underlyingInstallMode()` in
// `install.mjs`: `preview` resolves to the underlying mode `dev` for env
// generation, setup, the checkout marker, and instance-registry bookkeeping
// before any of those see it (#188 AC6), so no install site can observe
// "preview" as a runtime mode at all.
//
// The three HARD NEVERs in `preview.mjs` are INHERITED UNCHANGED (#188):
//   (i)   no host `next start` / standalone boot — the only boot path is the
//         `docker build` + `docker run` this module delegates to;
//   (ii)  never tagged/pushed/presented as production — the tag namespace and
//         its guard are `preview.mjs`'s, reused untouched;
//   (iii) never sets or sanctions CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE
//         — asserted here against the AMBIENT environment before any build (the
//         composed container env is a fresh object that cannot carry it), and
//         re-asserted by `preview.mjs` on the env this module composes.
//
// The four things the composition has to solve that neither side does today
// (#188 AC3–AC7):
//   AC3  ENV PLUMBING      — `preview create` reads `process.env`, never parses
//                            `.env.local`, and has no env-file option. So the
//                            front door SOURCES the passthrough values from the
//                            install it just performed and hands them to create
//                            as an explicit `deps.env`, rather than relying on
//                            ambient shell state. cinatra-cli#197: an install's
//                            configuration is only PARTLY written down —
//                            `.env.example` defines neither REDIS_URL nor the
//                            agent-registry URL, so the app resolves those by
//                            fallback. "Sourced from the install" therefore
//                            means its EFFECTIVE configuration, not only its
//                            explicit lines: the caller supplies this instance's
//                            own endpoints for the implicit keys
//                            (`instance-endpoints.mjs`), and an explicit
//                            `.env.local` value always wins over them.
//   AC4  ENCRYPTION KEY    — a runtime-BOOT requirement of preview that a dev
//                            install deliberately does not mint. Provisioned +
//                            persisted HERE, outside the checkout, so the dev
//                            `.env.local` contract gains no prod-only secret.
//   AC5  REACHABILITY      — a dev install's `.env.local` carries host-loopback
//                            infra endpoints (127.0.0.1:<port>), which inside
//                            the container resolve to the container itself.
//                            The rewrite itself lives in `preview.mjs`
//                            (`rewriteLoopbackUrlForContainer` over
//                            `CONTAINER_REWRITE_ENV_KEYS`, cinatra-cli#190) —
//                            SUPABASE_DB_URL/REDIS_URL simply join that one set,
//                            so there is a single mechanism and a single
//                            `--add-host` mapping. What the front door owns is
//                            the DISTINCT half: the app/auth URLs, re-pointed at
//                            the preview's OWN published host port.
//   AC7  RERUN SEMANTICS   — `install` is contractually re-runnable but
//                            `preview create` hard-fails on an existing slug.
//                            A rerun SKIPS create, reports the existing
//                            preview, and points ref drift at `refresh`.
//
// Preserved by construction (asserted, not rebuilt): the preview registry
// (`previews.json`), slug rules, the 3400–3499 host-port pool, image tagging,
// and multi-preview coexistence are `preview.mjs`'s and are reused unchanged —
// no new registry, no new port pool.
//
// Plain ESM `.mjs`, node builtins + `preview.mjs` only (no import back into
// `install.mjs`, which lazy-imports THIS module — so there is no cycle). The
// effective endpoints #197 composes are DERIVED BY THE CALLER and handed in,
// which is what keeps that rule intact: only `install.mjs` knows the infra plan
// they are valid for. The pure helpers are re-exported as `__test` for hermetic
// vitest.
//
// LEAK DISCIPLINE: the passthrough surface carries secrets (BETTER_AUTH_SECRET,
// OPENAI_API_KEY, a password-bearing SUPABASE_DB_URL, the minted encryption
// key). This module logs KEY NAMES ONLY — never a value, never a redacted
// value, never a length.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_REWRITE_ENV_KEYS,
  ENCRYPTION_KEY_ENV,
  ENCRYPTION_KEY_HEX_LEN,
  PASSTHROUGH_ENV_KEYS,
  assertMaterializeNotDisabled,
  assertPreviewCheckoutAllowed,
  defaultDeps,
  defaultRegistryPath,
  deriveSlug,
  getPreview,
  readCheckoutEnvMode,
  requireUsableRegistry,
  runPreviewCreate,
  withRegistryLock,
} from "./preview.mjs";

// --- constants -------------------------------------------------------------

/** The CLI-surface mode value (#188). Never a runtime mode. */
export const PREVIEW_SURFACE_MODE = "preview";
/** The underlying install mode `preview` resolves to everywhere (#188 AC6). */
export const PREVIEW_UNDERLYING_MODE = "dev";

/**
 * The passthrough keys that name the APP's own base URL. These are NOT
 * host-infra endpoints: the preview application listens on container port 3000
 * published to the preview's own host port, so they are re-pointed at THAT
 * (`http://localhost:<previewHostPort>`) — a browser-reachable address — rather
 * than left to `preview.mjs`'s host-loopback rewrite (#188 AC5, explicitly
 * distinguished: these are BROWSER-resolved, so a container-only name would not
 * resolve — which is why `CONTAINER_REWRITE_ENV_KEYS` deliberately excludes them).
 */
export const PREVIEW_APP_URL_KEYS = Object.freeze([
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
]);

/** Where the front door persists the previews' boot encryption keys (#188 AC4).
 *  Deliberately OUTSIDE any checkout: the dev `.env.local` contract must not
 *  gain a prod-only secret. */
export function previewSecretsPath() {
  return path.join(os.homedir(), ".cinatra", "preview-secrets.json");
}

// --- env file reading (node builtins only) ---------------------------------

/**
 * Minimal `.env` body → { KEY: value } map (last wins; quotes stripped; inline
 * comments handled like the app's dotenv loader). A local copy of install.mjs's
 * `parseEnvBody` semantics so this module never imports install.mjs (which
 * lazy-imports this one).
 */
export function parsePreviewEnvBody(body) {
  const out = {};
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0];
      const close = v.indexOf(quote, 1);
      if (close !== -1) v = v.slice(1, close);
    } else {
      const commentAt = v.search(/\s#/);
      if (commentAt !== -1) v = v.slice(0, commentAt).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/** Read the installed checkout's `.env.local` (empty map when absent — the
 *  caller reports the resulting missing keys by NAME). */
export function readInstalledEnvValues(targetDir) {
  const envPath = path.join(targetDir, ".env.local");
  if (!existsSync(envPath)) return {};
  try {
    return parsePreviewEnvBody(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

// --- AC3: env plumbing from the install into the container ------------------

/**
 * Compose the container env for the preview from the install just performed
 * (#188 AC3), with the two rewrites AC5 distinguishes:
 *
 *   - a key naming the APP's own base URL → `http://localhost:<previewHostPort>`
 *     (the preview publishes container 3000 on its OWN host port);
 *   - every other value → forwarded verbatim. Host-loopback endpoints the
 *     CONTAINER dials are rewritten by `preview.mjs` itself, over
 *     `CONTAINER_REWRITE_ENV_KEYS` — one mechanism for the registry URL
 *     (cinatra-cli#190) and for the DB/Redis endpoints AC5 names, rather than a
 *     second rewrite here that could drift from it.
 *
 * The key set is `PASSTHROUGH_ENV_KEYS` — the set `preview.mjs` actually
 * forwards into the container, so composing anything outside it would be
 * silently dropped, and anything ADDED to it (as #190 added the registry URLs)
 * is composed from the install automatically, with no change here.
 *
 * Returns key NAMES only alongside the map — never values (leak discipline).
 *
 * `effectiveDefaults` (cinatra-cli#197) supplies the instance's own value for a
 * container-dialed key the install leaves IMPLICIT in `.env.local`. It fills
 * only what is absent — an explicit value always wins — and the caller decides
 * whether the composition is entitled to it at all.
 *
 * @param {{ envValues: Record<string,string>, previewHostPort: number,
 *           passthroughKeys?: readonly string[], onlyDefinedKeys?: boolean,
 *           effectiveDefaults?: Record<string,string> }} args
 * @returns {{ env: Record<string,string>, appUrlKeys: string[],
 *             containerDialedKeys: string[], forwardedKeys: string[],
 *             missingKeys: string[], synthesizedKeys: string[] }}
 */
export function derivePreviewEnvFromInstall({
  envValues = {},
  previewHostPort,
  passthroughKeys = PASSTHROUGH_ENV_KEYS,
  onlyDefinedKeys = false,
  effectiveDefaults = {},
}) {
  if (!Number.isInteger(previewHostPort) || previewHostPort <= 0) {
    throw new Error(
      `derivePreviewEnvFromInstall requires the preview's resolved host port (got ${JSON.stringify(previewHostPort)}).`,
    );
  }
  const appBaseUrl = `http://localhost:${previewHostPort}`;
  const appUrlKeys = new Set(PREVIEW_APP_URL_KEYS);
  const env = {};
  const containerDialed = new Set(CONTAINER_REWRITE_ENV_KEYS);
  const usedAppUrlKeys = [];
  const containerDialedKeys = [];
  const forwardedKeys = [];
  const missingKeys = [];
  const synthesizedKeys = [];

  for (const key of passthroughKeys) {
    if (appUrlKeys.has(key)) {
      // AC5: the preview's OWN published port — NOT host-infra rewriting, and
      // NOT the installed instance's app port (which is a different app).
      //
      // `onlyDefinedKeys` restricts this (and everything else) to keys the
      // install ACTUALLY defines. The front-door create always sets the app URLs
      // (it owns the instance it just built); a CONTINUATION of some other
      // preview must never invent env the operator did not have — see
      // `makePreviewComposition`.
      if (onlyDefinedKeys && !(typeof envValues[key] === "string" && envValues[key].length > 0)) {
        missingKeys.push(key);
        continue;
      }
      env[key] = appBaseUrl;
      usedAppUrlKeys.push(key);
      continue;
    }
    const explicit = envValues[key];
    const defined = typeof explicit === "string" && explicit.length > 0;
    // cinatra-cli#197: a key the install leaves IMPLICIT still has an effective
    // value — `.env.example` writes SUPABASE_DB_URL but not REDIS_URL and not
    // CINATRA_AGENT_REGISTRY_URL, so the app resolves those by FALLBACK. On the
    // host that fallback is correct; inside the container `127.0.0.1` is the
    // container itself and the registry default is the hosted one. The caller
    // supplies this instance's own effective endpoints for exactly those keys
    // (empty for a continuation, which must never invent env — see
    // `makePreviewComposition`), and an EXPLICIT `.env.local` value always wins.
    const synthesized = !defined && typeof effectiveDefaults?.[key] === "string" && effectiveDefaults[key].length > 0;
    if (!defined && !synthesized) {
      missingKeys.push(key);
      continue;
    }
    env[key] = defined ? explicit : effectiveDefaults[key];
    if (synthesized) synthesizedKeys.push(key);
    // Reported (by NAME) so the operator can see which values `preview.mjs` will
    // re-point at the host gateway before the container dials them.
    (containerDialed.has(key) ? containerDialedKeys : forwardedKeys).push(key);
  }
  return { env, appUrlKeys: usedAppUrlKeys, containerDialedKeys, forwardedKeys, missingKeys, synthesizedKeys };
}

// --- AC4: the preview's boot encryption key --------------------------------

/** True iff `key` is exactly the 64 hex chars preview's boot gate requires. */
export function isValidEncryptionKey(key) {
  return typeof key === "string" && new RegExp(`^[0-9a-fA-F]{${ENCRYPTION_KEY_HEX_LEN}}$`).test(key.trim());
}

/**
 * Provision + persist the preview's `CINATRA_ENCRYPTION_KEY` (#188 AC4).
 *
 * `preview` requires the key as a RUNTIME-BOOT requirement, explicitly
 * independent of the image build. A dev install deliberately does not mint this
 * prod-only secret, so the front door must supply one — WITHOUT adding it to the
 * dev checkout's `.env.local` contract. It is therefore persisted per-slug in
 * the CLI's own state dir at 0600, beside (never inside) `previews.json`:
 * `previews.json` is a reported, human-read registry, so a secret has no
 * business in it.
 *
 * Persisting (rather than minting per run) matters: the key encrypts
 * instance-secrets in the preview's DURABLE volume, so a rerun/refresh that
 * minted a fresh key would orphan already-encrypted data.
 *
 * @returns {{ key: string, minted: boolean, filePath: string }}
 */
export async function ensurePreviewEncryptionKey({
  slug,
  filePath = previewSecretsPath(),
  generate = () => randomBytes(32).toString("hex"),
} = {}) {
  const resolved = resolvePreviewEncryptionKey({ slug, filePath, generate });
  if (resolved.minted) await persistPreviewEncryptionKey({ slug, key: resolved.key, filePath });
  return { ...resolved, filePath };
}

/**
 * The boot key to USE, without writing anything: an already-persisted key when
 * one exists (that IS the association with the existing durable volume), else a
 * freshly generated one flagged `minted` for the caller to persist ONLY once the
 * preview it belongs to actually exists.
 *
 * Deferring the write matters: the front door mints before `preview create`
 * claims the slug, so persisting eagerly would leave a stale key behind whenever
 * create loses that claim to a racing `instance preview create` — and a later
 * key-less refresh would then boot the WINNER's volume with the loser's key.
 */
export function resolvePreviewEncryptionKey({
  slug,
  filePath = previewSecretsPath(),
  generate = () => randomBytes(32).toString("hex"),
} = {}) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("resolvePreviewEncryptionKey requires a slug.");
  }
  const existing = lookupPreviewEncryptionKey({ slug, filePath }); // fail-closed on corruption
  if (existing) return { key: existing, minted: false, filePath };
  const key = generate();
  if (!isValidEncryptionKey(key)) {
    throw new Error(
      `Generated ${ENCRYPTION_KEY_ENV} is not ${ENCRYPTION_KEY_HEX_LEN} hex characters — refusing to use it.`,
    );
  }
  return { key, minted: true, filePath };
}

/**
 * Persist a minted boot key. Serialized under the SAME advisory lock primitive
 * the preview registry uses — without it two concurrent front doors read the
 * same store and the last rename DROPS the other's key. First writer wins: if a
 * DIFFERENT valid key appeared for this slug meanwhile, refuse rather than
 * overwrite (overwriting would orphan whichever preview owns the stored one).
 */
export async function persistPreviewEncryptionKey({ slug, key, filePath = previewSecretsPath() }) {
  if (!isValidEncryptionKey(key)) {
    throw new Error(`Refusing to persist a ${ENCRYPTION_KEY_ENV} that is not ${ENCRYPTION_KEY_HEX_LEN} hex characters.`);
  }
  return withRegistryLock(filePath, async () => {
    const store = readPreviewSecretsStore(filePath);
    const current = store.keys[slug];
    if (current !== undefined) {
      if (isValidEncryptionKey(current) && current.trim() === key.trim()) return { key: key.trim(), filePath };
      throw new Error(
        `A different ${ENCRYPTION_KEY_ENV} is already stored for preview "${slug}" in ${filePath}. ` +
          `Refusing to overwrite it — that would orphan the encrypted data of whichever preview owns it.`,
      );
    }
    writePreviewSecretsStore(filePath, { ...store, keys: { ...store.keys, [slug]: key.trim() } });
    return { key: key.trim(), filePath };
  });
}

/** The locked body of `ensurePreviewEncryptionKey`. Also the read-only lookup
 *  used when continuing an existing front-door preview. */
function readPreviewSecretsStore(filePath) {
  if (!existsSync(filePath)) return { version: 1, keys: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(
      `The preview secrets store at ${filePath} is unreadable or malformed. ` +
        `It holds the boot encryption key(s) for existing previews — re-minting would orphan their ` +
        `encrypted data. Repair or move that file, then retry.`,
    );
  }
  // FAIL CLOSED on shape too, not only on a parse error: a file that parses but
  // has no usable `keys` map is corruption, and silently treating it as empty
  // would re-mint over live previews.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.keys ||
    typeof parsed.keys !== "object" ||
    Array.isArray(parsed.keys)
  ) {
    throw new Error(
      `The preview secrets store at ${filePath} is malformed (no usable "keys" map). ` +
        `Re-minting would orphan existing previews' encrypted data. Repair or move that file, then retry.`,
    );
  }
  return { version: 1, keys: { ...parsed.keys } };
}

function writePreviewSecretsStore(filePath, store) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

/** The persisted boot key for `slug`, or null when the front door never
 *  provisioned one. Read-only and FAIL-CLOSED: a present-but-malformed entry
 *  throws (it is a live preview's key — silently returning null would let the
 *  caller boot with a different key and orphan that preview's encrypted data). */
export function lookupPreviewEncryptionKey({ slug, filePath = previewSecretsPath() } = {}) {
  const store = readPreviewSecretsStore(filePath);
  if (!Object.prototype.hasOwnProperty.call(store.keys, slug)) return null;
  const key = store.keys[slug];
  if (!isValidEncryptionKey(key)) {
    throw new Error(
      `The stored ${ENCRYPTION_KEY_ENV} for preview "${slug}" in ${filePath} is not ` +
        `${ENCRYPTION_KEY_HEX_LEN} hex characters. Refusing to boot with a different key — that would orphan ` +
        `this preview's encrypted data. Repair the entry (or prune the preview and its volume) and retry.`,
    );
  }
  return key.trim();
}

// --- NEVER (iii) defense in depth ------------------------------------------

// --- AC9: the terminating handoff ------------------------------------------

/**
 * The explicit handoff naming the verb family that MANAGES the created preview
 * (#188 AC9) — so the lifecycle divergence is STATED, not discovered. Mirrors
 * `prodRuntimeGuidanceLines()`'s shape (the established install→preview handoff
 * pattern this issue generalises).
 */
export function previewHandoffLines({ slug, ref = "main", hostPort = null, running = true, indent = "    " } = {}) {
  const lines = [
    `${indent}This preview is managed by the \`cinatra instance preview …\` verb family:`,
    `${indent}  cinatra instance preview status --slug ${slug}`,
    `${indent}      # its resolved SHA, image tag, provenance, port + state`,
    `${indent}  cinatra instance preview refresh --slug ${slug} --ref ${ref}`,
    `${indent}      # rebuild at a NEW SHA (reuses the durable volume) — the ONLY way to rebuild the image`,
    `${indent}  cinatra instance preview list`,
    `${indent}      # every preview on this host`,
  ];
  // Only a preview this run left RUNNING is openable. An in-flight claim or a
  // degraded row has a recorded port but nothing serving on it — printing
  // "Open it at …" there would contradict the warning just above.
  if (hostPort && running) lines.push(`${indent}Open it at http://localhost:${hostPort}`);
  lines.push(
    `${indent}The production runtime lives INSIDE the container only — this checkout stays a dev`,
    `${indent}install (\`.env.local\` is CINATRA_RUNTIME_MODE=development; \`pnpm dev\` still works).`,
  );
  return lines;
}

// --- AC7: rerun semantics --------------------------------------------------

/**
 * Decide what a `--mode preview` run should do given the existing registry state
 * (#188 AC7). Pure — the caller performs the effect.
 *
 * `install` is contractually idempotent/re-runnable, but `preview create` hard
 * fails when the slug already has a registry row. So a SECOND
 * `install --mode preview` on the same directory must not fail and must not
 * implicitly rebuild the image: it reconciles the checkout/infra as a normal dev
 * install (already done by the time this is consulted), SKIPS create, reports
 * the existing preview, and — when the resolved `--ref` SHA differs from the
 * registered one — reports that drift and points at `instance preview refresh`.
 * Image rebuilds stay an explicit `refresh`.
 *
 * A `provisioning` row is NOT a preview: it is an in-flight claim (or one an
 * interrupted run abandoned), with no container behind it. Reporting it as "a
 * preview already exists" would be a lie that strands the operator — `refresh`
 * refuses a provisioning row too — so it is classified separately and reported
 * as what it is. Recovering such a row belongs to the preview lifecycle, not to
 * the front door, which must never silently adopt or delete another operation's
 * claim.
 *
 * @returns {{ action: "create"|"skip"|"in-flight", existing: object|null, drift: boolean }}
 */
export function decidePreviewAction({ existing = null, resolvedSha = null } = {}) {
  if (!existing) return { action: "create", existing: null, drift: false };
  if (existing.state === "provisioning") return { action: "in-flight", existing, drift: false };
  const drift = Boolean(resolvedSha) && existing.sha !== resolvedSha;
  return { action: "skip", existing, drift };
}

/** The lines an IN-FLIGHT (provisioning) claim reports (#188 AC7). Never claims a
 *  preview exists — there is no container behind a provisioning row. */
export function previewInFlightReportLines({ existing, indent = "  " }) {
  return [
    `${indent}- A preview operation is IN FLIGHT for slug "${existing.slug}" (state=provisioning) — not creating a`,
    `${indent}  second one. A provisioning row is a CLAIM, not a finished preview: another`,
    `${indent}  \`cinatra instance preview\` command may be building/booting it right now, or an earlier run`,
    `${indent}  may have been interrupted. Its container may be absent, starting, or (for an interrupted`,
    `${indent}  refresh) still the PREVIOUS one — this install does not assume, adopt, or remove it.`,
    `${indent}    slug: ${existing.slug}   sha: ${existing.sha}   port: ${existing.hostPort ?? "-"}`,
    `${indent}  Check its real state, and re-run this install once it has settled:`,
    `${indent}      cinatra instance preview status --slug ${existing.slug}`,
  ];
}

/** The lines a SKIPPED (rerun) preview reports (#188 AC7). Key facts from
 *  `previews.json`: slug / SHA / port — plus the drift pointer when the
 *  resolved ref has moved past the registered SHA. */
export function previewSkipReportLines({ existing, resolvedSha, ref, drift, indent = "  " }) {
  const lines = [
    `${indent}- A preview already exists for this checkout — SKIPPING create (an install rerun reconciles the`,
    `${indent}  checkout + infra; rebuilding the preview IMAGE stays an explicit \`instance preview refresh\`).`,
    `${indent}    slug: ${existing.slug}   sha: ${existing.sha}   port: ${existing.hostPort ?? "-"}   state: ${existing.state}`,
    `${indent}    image: ${existing.imageTag}   provenance: ${existing.provenance}`,
  ];
  if (drift) {
    lines.push(
      `${indent}  ⚠ Ref drift: --ref ${ref} now resolves to ${resolvedSha}, but this preview was built at ${existing.sha}.`,
      `${indent}    Rebuild it explicitly:`,
      `${indent}      cinatra instance preview refresh --slug ${existing.slug} --ref ${ref}`,
    );
  } else if (existing.state !== "ready") {
    // A `degraded` row is a preview whose last boot did NOT reach healthy — the
    // lifecycle records it with no running container. "Nothing to rebuild" would
    // be wrong there: recovery is an explicit refresh at the SAME SHA.
    lines.push(
      `${indent}  ⚠ This preview's recorded state is "${existing.state}" — its last boot did not reach healthy,`,
      `${indent}    so there is no running container to open. Recover it with an explicit rebuild:`,
      `${indent}      cinatra instance preview refresh --slug ${existing.slug} --ref ${ref}`,
    );
  } else {
    lines.push(`${indent}  The preview is already at the SHA --ref ${ref} resolves to (${existing.sha}) — nothing to rebuild.`);
  }
  return lines;
}

/**
 * The `--slug` argv the front door hands the preview lifecycle: an explicit
 * `rest` (a caller that already named one) wins; otherwise the INSTALLED
 * INSTANCE's slug, when it satisfies the shared slug rules. Returns `[]` to fall
 * back to the lifecycle's own default (the checkout's branch), which is the
 * documented behaviour of a bare `instance preview create`.
 */
export function previewSlugArgs({ instanceSlug = null, rest = [] } = {}) {
  if (Array.isArray(rest) && rest.some((t) => t === "--slug" || String(t).startsWith("--slug="))) {
    return rest;
  }
  // Same shape `preview.mjs`'s `isValidSlug` enforces — checked here so an
  // unexpected instance slug degrades to the branch default instead of throwing.
  if (typeof instanceSlug === "string" && /^[a-z0-9][a-z0-9-]{0,29}$/.test(instanceSlug)) {
    return ["--slug", instanceSlug];
  }
  return Array.isArray(rest) ? rest : [];
}

// --- orchestration ---------------------------------------------------------

/**
 * Bootstrap the FIRST preview for a just-installed dev checkout (#188 AC1–AC9).
 *
 * Everything side-effecting rides `preview.mjs`'s own injectable `deps`, so the
 * unit suite exercises this whole composition with no docker/git/network.
 *
 * `effectiveEndpoints` (cinatra-cli#197) carries this instance's own
 * container-dialed endpoints for the keys `.env.local` leaves implicit. The
 * caller (`install.mjs`) derives them, because only it knows which infra plan
 * this install took — an external/co-use instance dials infra the checkout's own
 * compose band does not describe, and gets nothing.
 *
 * @param {{ targetDir: string, ref?: string, rest?: string[], log?: Function,
 *           deps?: object, env?: Record<string,string>,
 *           effectiveEndpoints?: Record<string,string> }} args
 */
export async function runInstallPreviewBootstrap({
  targetDir,
  ref = "main",
  rest = [],
  instanceSlug = null,
  effectiveEndpoints = {},
  log = console.log,
  deps: injected = {},
  env: ambientEnv = process.env,
} = {}) {
  const deps = { ...defaultDeps({ log }), ...injected };
  const registryPath = deps.registryPath ?? defaultRegistryPath();

  // HARD NEVER (iii), inherited unchanged: an ambient truthy bypass refuses the
  // whole run. The composed container env is a fresh object that cannot carry
  // the flag, so this ambient check is what keeps the inherited guard live.
  assertMaterializeNotDisabled(ambientEnv);

  // The load-bearing invariant, asserted rather than assumed: this checkout is a
  // DEV install. `underlyingInstallMode()` guarantees it upstream; re-deriving it
  // from the checkout here means a regression fails loudly at the front door
  // instead of silently disqualifying the directory from previews.
  const envMode = deps.readCheckoutEnvMode
    ? deps.readCheckoutEnvMode(targetDir)
    : readCheckoutEnvMode(targetDir);
  assertPreviewCheckoutAllowed({ envMode });

  // The preview created by the front door belongs to the INSTANCE this install
  // just recorded, so its slug is that instance's slug — passed through the
  // preview lifecycle's OWN explicit-`--slug` seam (no parallel slug scheme, and
  // `deriveSlug` still enforces the shared slug rules). This is what keeps two
  // installs of the SAME branch in different directories from colliding on one
  // host-global preview row; without an instance slug (nothing recorded — e.g.
  // an unnamed target) it falls back to the lifecycle's documented default, the
  // checkout's branch.
  const slugRest = previewSlugArgs({ instanceSlug, rest });
  const slug = deriveSlug({ rest: slugRest, checkoutDir: targetDir });
  const resolvedSha = deps.resolveSha(ref, targetDir);

  // Consult the EXISTING registry (never a new one) for the rerun decision. This
  // is a READ ONLY: the host port is NOT pre-allocated here. Allocating outside
  // create's own locked claim would be a TOCTOU race — two concurrent front doors
  // could pick the same pool port and one boot would fail at `docker run`. The
  // port-dependent env is instead composed inside create, against the port it
  // actually claimed, via the `composeRuntimeEnv` seam below.
  let decision;
  await withRegistryLock(registryPath, async () => {
    const registry = requireUsableRegistry(registryPath);
    decision = decidePreviewAction({ existing: getPreview(registry, slug), resolvedSha });
  });

  if (decision.action === "in-flight") {
    for (const line of previewInFlightReportLines({ existing: decision.existing })) log(line);
    return {
      slug,
      created: false,
      skipped: true,
      inFlight: true,
      drift: false,
      sha: decision.existing.sha,
      resolvedSha,
      hostPort: decision.existing.hostPort ?? null,
      state: decision.existing.state,
    };
  }

  if (decision.action === "skip") {
    for (const line of previewSkipReportLines({
      existing: decision.existing,
      resolvedSha,
      ref,
      drift: decision.drift,
    })) {
      log(line);
    }
    return {
      slug,
      created: false,
      skipped: true,
      inFlight: false,
      drift: decision.drift,
      sha: decision.existing.sha,
      resolvedSha,
      hostPort: decision.existing.hostPort ?? null,
      state: decision.existing.state,
    };
  }

  // AC4: provision the boot key OUTSIDE the checkout. It is RESOLVED here (reused
  // when this preview already has one) but a freshly minted key is PERSISTED only
  // after create succeeds — a create that loses the slug claim to a racing
  // `instance preview create` must not leave a key behind that a later refresh
  // would boot the winner's volume with.
  const secret = resolvePreviewEncryptionKey({
    slug,
    ...(deps.previewSecretsPath ? { filePath: deps.previewSecretsPath } : {}),
    ...(deps.generateEncryptionKey ? { generate: deps.generateEncryptionKey } : {}),
  });

  log("");
  log(`- Preview front door (cinatra-cli#188): composing this install into a preview container…`);
  log(`    slug: ${slug}   ref: ${ref} -> ${resolvedSha}`);
  log(
    `    ${ENCRYPTION_KEY_ENV}: ${secret.minted ? "minted" : "reused"} for this preview, kept at ` +
      `${secret.filePath} (0600) — NOT written into the checkout's .env.local.`,
  );

  // AC3 + AC5: the container env is composed from THIS install (never ambient
  // shell state) at the moment create has CLAIMED its host port, so the app/auth
  // URLs name the port the container is really published on with no race.
  const plan = makePreviewComposition({
    targetDir,
    slug,
    encryptionKey: secret.key,
    // #197: the front-door create OWNS the instance it just built, so supplying
    // that instance's own effective endpoints is not inventing operator env.
    effectiveEndpoints,
    log,
    deps,
  });

  const result = await runPreviewCreate(["--slug", slug, "--ref", ref], {
    ...injected,
    checkoutDir: targetDir,
    // The pre-port env: enough for create's fail-fast encryption-key gate; the
    // port-dependent keys are filled by the hook once the claim is made.
    env: plan.preEnv,
    composeRuntimeEnv: plan.composeRuntimeEnv,
    log,
    registryPath,
  });

  // The preview now EXISTS and its durable volume is encrypted with this key —
  // only now is persisting it correct (and `refresh` can rely on it).
  if (secret.minted) {
    await persistPreviewEncryptionKey({ slug, key: secret.key, filePath: secret.filePath });
    log(`    ${ENCRYPTION_KEY_ENV} persisted at ${secret.filePath} (0600).`);
  }

  return {
    slug,
    created: true,
    skipped: false,
    drift: false,
    sha: result?.sha ?? resolvedSha,
    resolvedSha,
    hostPort: result?.hostPort ?? null,
    state: result?.state ?? "healthy",
    encryptionKeyPath: secret.filePath,
  };
}

/**
 * Build the pieces `preview.mjs` needs to boot a container that is wired to THIS
 * install: the pre-port env (create's fail-fast key gate reads it), the
 * `composeRuntimeEnv` hook that fills the port-dependent app/auth URLs once the
 * host port is claimed, and the host-gateway run args.
 *
 * `baseEnv` lets a caller keep an already-set ambient value authoritative (the
 * `instance preview refresh` continuation does; the front-door create does not —
 * AC3 is explicit that the values come from the install, not the shell).
 */
export function makePreviewComposition({
  targetDir,
  slug,
  encryptionKey = null,
  baseEnv = null,
  continuation = false,
  effectiveEndpoints = {},
  log = null,
  deps = {},
}) {
  const envValues = deps.readInstalledEnvValues
    ? deps.readInstalledEnvValues(targetDir)
    : readInstalledEnvValues(targetDir);

  // A CONTINUATION (`instance preview refresh`) must be a NO-OP for a preview the
  // front door did not create: it fills in what the install defines and nothing
  // else, and it adds the host-gateway mapping ONLY when a loopback endpoint was
  // actually rewritten (there is nothing to reach otherwise). A front-door create
  // owns the instance it just built, so it always sets the app URLs.
  //
  // `effectiveEndpoints` (cinatra-cli#197) is the instance's own value for the
  // container-dialed keys `.env.local` leaves implicit. Passing it is the
  // CALLER's assertion that this composition owns the instance — the front-door
  // create always does; a refresh does only for a preview the front door itself
  // built (#197 AC6: never invent env for a preview it did not build).
  const derive = (previewHostPort) =>
    derivePreviewEnvFromInstall({
      envValues,
      previewHostPort,
      onlyDefinedKeys: continuation,
      effectiveDefaults: effectiveEndpoints ?? {},
    });

  const probe = derive(3000);

  // Ambient wins whenever the caller's environment DEFINES the key — including
  // defining it as the empty string, which is how an operator suppresses a value
  // (`buildPreviewRunEnvArgs` then drops it, exactly as before this composition
  // existed). Only an ABSENT key is filled from the install.
  const ambient = baseEnv
    ? Object.fromEntries(Object.entries(baseEnv).filter(([, v]) => typeof v === "string"))
    : null;
  const overlay = (composedEnv) => (ambient ? { ...composedEnv, ...ambient } : composedEnv);
  const withKey = (composedEnv) =>
    overlay({ ...composedEnv, ...(encryptionKey ? { [ENCRYPTION_KEY_ENV]: encryptionKey } : {}) });

  // A port-independent snapshot (a placeholder port; only the app-URL keys
  // depend on it) so create's encryption-key gate has a complete env up front.
  const preEnv = withKey(probe.env);

  let reported = false;
  const composeRuntimeEnv = ({ hostPort }) => {
    const composed = derive(hostPort);
    if (log && !reported) {
      reported = true;
      // KEY NAMES ONLY — the passthrough surface carries secrets.
      log(`    host port: ${hostPort}`);
      log(`    app/auth URLs re-pointed at the preview's own port: ${composed.appUrlKeys.join(", ") || "(none)"}`);
      log(
        `    container-dialed endpoints (re-pointed at ${CONTAINER_HOST_GATEWAY} on boot): ` +
          `${composed.containerDialedKeys.join(", ") || "(none)"}`,
      );
      log(`    forwarded unchanged: ${composed.forwardedKeys.join(", ") || "(none)"}`);
      // cinatra-cli#197: name the keys whose value came from this instance's
      // EFFECTIVE endpoints rather than an explicit `.env.local` line, so the
      // composition never quietly supplies something the operator cannot see.
      if (composed.synthesizedKeys.length > 0) {
        log(
          `    implicit in .env.local — supplied from this instance's own endpoints: ` +
            `${composed.synthesizedKeys.join(", ")}`,
        );
      }
      if (composed.missingKeys.length > 0) {
        log(`    not set by this install (omitted): ${composed.missingKeys.join(", ")}`);
      }
    }
    return withKey(composed.env);
  };

  return { preEnv, composeRuntimeEnv, envValues, composes: Object.keys(probe.env).length > 0 };
}

/**
 * cinatra-cli#197 — the lines a CONTINUATION prints when this checkout leaves a
 * container-dialed key implicit.
 *
 * The front door's own handoff points at `refresh` ("the ONLY way to rebuild the
 * image"), and a create made healthy by the install's effective endpoints will
 * rebuild WITHOUT them, because a continuation forwards only what the install
 * WROTE DOWN (AC6). That difference must not be discovered from a health-gate
 * timeout: state it before the rebuild, with the remedy.
 *
 * Returns key NAMES only — never values.
 */
export function continuationImplicitEndpointLines({
  envValues = {},
  keys = CONTAINER_REWRITE_ENV_KEYS,
} = {}) {
  const implicit = keys.filter((k) => !(typeof envValues[k] === "string" && envValues[k].length > 0));
  if (implicit.length === 0) return [];
  return [
    `  NOTE: this checkout's .env.local leaves these container-dialed keys implicit: ${implicit.join(", ")}.`,
    `  A refresh CONTINUES an existing preview: it forwards what the install wrote down and invents`,
    `  nothing (cinatra-cli#197 AC6), so the rebuilt container resolves them by its own in-container`,
    `  fallback — which for a host-loopback endpoint means the CONTAINER, not this instance.`,
    `  Set them explicitly in .env.local (or export them) before refreshing if this preview needs them.`,
  ];
}

/**
 * `cinatra instance preview refresh`, able to CONTINUE a preview the
 * `install --mode preview` front door created (cinatra-cli#188 AC7/AC9).
 *
 * Without this the front door's own handoff would be a dead end: `refresh` reads
 * `process.env`, so a preview whose boot key was minted into the CLI's secrets
 * store and whose endpoints were rewritten for the container would fail the
 * encryption-key gate immediately, and — if the operator exported a key by hand —
 * would still boot with the checkout's host-loopback endpoints and the installed
 * instance's app URL.
 *
 * PURELY ADDITIVE for every other preview: the composed values are a BASE that
 * the ambient environment overrides, the persisted key is used only when
 * `CINATRA_ENCRYPTION_KEY` is unset, and a checkout with no `.env.local`
 * composes nothing — so a refresh driven entirely by exported env behaves exactly
 * as before.
 */
export async function runInstallPreviewRefresh(rest = [], injected = {}) {
  const { runPreviewRefresh } = await import("./preview.mjs");
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const ambientEnv = deps.env ?? process.env;
  const slug = deriveSlug({ rest, checkoutDir });

  const secretsFile = deps.previewSecretsPath ?? previewSecretsPath();
  const storedKey =
    typeof ambientEnv[ENCRYPTION_KEY_ENV] === "string" && ambientEnv[ENCRYPTION_KEY_ENV].trim().length > 0
      ? null
      : lookupPreviewEncryptionKey({ slug, filePath: secretsFile });

  // cinatra-cli#197 AC6, deliberately: a CONTINUATION invents NOTHING. It is
  // tempting to treat "a persisted boot key exists for this slug" as proof the
  // front door built this preview and therefore owns its endpoints, but that
  // marker is not sound — the key store is historical per-SLUG state, bound to
  // neither the current `previews.json` row nor the checkout nor the infra plan.
  // A slug reused after a registry repair (or a plain `instance preview create`
  // with the same slug) would inherit a stale key and, with it, endpoints
  // invented for someone else's preview. Worse, refresh cannot see the infra
  // plan at all, so it could not exclude an `external`/co-use instance the way
  // the front-door create does — it would synthesize a LOCAL Redis/Verdaccio for
  // infrastructure that was never started. So `effectiveEndpoints` stays empty
  // here and `onlyDefinedKeys` remains the whole story for a continuation.
  const plan = makePreviewComposition({
    targetDir: checkoutDir,
    slug,
    encryptionKey: storedKey,
    baseEnv: ambientEnv,
    continuation: true,
    deps,
  });

  // Nothing to contribute (no `.env.local` to source, no persisted key): hand the
  // refresh straight through, so a preview driven entirely by exported env — the
  // pre-#188 contract — runs on byte-identical arguments.
  if (!plan.composes && !storedKey) {
    return runPreviewRefresh(rest, { ...injected, checkoutDir });
  }

  // #197: this checkout HAS an `.env.local` we are composing from, so say which
  // container-dialed keys it does not define before the rebuild starts.
  const log = deps.log ?? console.log;
  for (const line of continuationImplicitEndpointLines({ envValues: plan.envValues })) log(line);

  return runPreviewRefresh(rest, {
    ...injected,
    checkoutDir,
    env: plan.preEnv,
    composeRuntimeEnv: plan.composeRuntimeEnv,
  });
}

/**
 * `cinatra instance preview start`, able to CONTINUE a preview the front door
 * created (cinatra-cli#220, the same continuation contract as `refresh`).
 *
 * This is the verb the stale-endpoint case actually needs: re-banding an
 * instance's infra rewrites `.env.local`, and the preview keeps the PREVIOUS
 * band's addresses baked into its container env until something replaces the
 * container. `start --recreate` replaces it with FRESHLY COMPOSED environment
 * and no build — so the composition has to be the same one `refresh` performs,
 * or the re-materialized container would boot on ambient shell state instead of
 * the install's.
 *
 * Identical rules to the refresh continuation, deliberately: the composed values
 * are only a BASE that the ambient environment overrides, the persisted boot key
 * is used only when `CINATRA_ENCRYPTION_KEY` is unset, a checkout with no
 * `.env.local` composes nothing (and is handed straight through), and a
 * continuation INVENTS NOTHING — no effective-endpoint synthesis, because start
 * cannot see the infra plan those values would only be valid for.
 */
export async function runInstallPreviewStart(rest = [], injected = {}) {
  const { runPreviewStart } = await import("./preview.mjs");
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const ambientEnv = deps.env ?? process.env;
  const slug = deriveSlug({ rest, checkoutDir });

  const secretsFile = deps.previewSecretsPath ?? previewSecretsPath();
  const storedKey =
    typeof ambientEnv[ENCRYPTION_KEY_ENV] === "string" && ambientEnv[ENCRYPTION_KEY_ENV].trim().length > 0
      ? null
      : lookupPreviewEncryptionKey({ slug, filePath: secretsFile });

  const plan = makePreviewComposition({
    targetDir: checkoutDir,
    slug,
    encryptionKey: storedKey,
    baseEnv: ambientEnv,
    continuation: true,
    deps,
  });

  if (!plan.composes && !storedKey) {
    return runPreviewStart(rest, { ...injected, checkoutDir });
  }

  return runPreviewStart(rest, {
    ...injected,
    checkoutDir,
    env: plan.preEnv,
    composeRuntimeEnv: plan.composeRuntimeEnv,
  });
}

// --- test surface ----------------------------------------------------------

export const __test = {
  PREVIEW_SURFACE_MODE,
  PREVIEW_UNDERLYING_MODE,
  PREVIEW_APP_URL_KEYS,
  previewSecretsPath,
  parsePreviewEnvBody,
  readInstalledEnvValues,
  derivePreviewEnvFromInstall,
  isValidEncryptionKey,
  ensurePreviewEncryptionKey,
  resolvePreviewEncryptionKey,
  persistPreviewEncryptionKey,
  lookupPreviewEncryptionKey,
  makePreviewComposition,
  continuationImplicitEndpointLines,
  previewHandoffLines,
  previewSlugArgs,
  decidePreviewAction,
  previewSkipReportLines,
  previewInFlightReportLines,
  runInstallPreviewBootstrap,
  runInstallPreviewRefresh,
};
