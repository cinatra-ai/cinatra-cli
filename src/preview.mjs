// ---------------------------------------------------------------------------
// The `preview` lifecycle (cinatra-ai/cinatra-cli#149).
//
// A `preview` is a LOCALLY-BUILT container image at a resolved source SHA, run
// with PRODUCTION runtime semantics, explicitly local / non-production. It is
// the sanctioned, image-based successor to the "host-prod-of-main" flow the S4
// runtime-contract ADR declined (cinatra-ai/cinatra#1580): production is the
// pinned PUBLISHED release image only, so running a dev ref in production mode
// locally is a distinct, non-production lifecycle — NOT a production deploy.
//
// Why an IMAGE and never a host `next start`: the Dockerfile build stage does
// work a bare host checkout cannot — `extensions acquire-prod`, the
// required-extension OAS seed (`build-required-oas-seed.mjs`), presence-aware
// map regeneration (`generate-extension-manifest.mjs`), and the standalone
// assembly + runtime-stage copy. In production the required-extension
// materialize boot phase is FAIL-CLOSED and reads its seed from the image-baked
// `/app/.cinatra-required-oas-seed` with no boot-path override, so a host
// checkout can only "boot" by setting the safety-invariant bypass flag
// `CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE=true` — which #1580 forbids.
// A locally-built image HAS that seed, so it boots the fail-closed phase for
// real, WITHOUT the bypass. That is the whole reason preview is an image.
//
// HARD NEVERs (invariants, asserted by tests — see tests/preview.test.mjs):
//   (i)   preview never boots a bare host `next start` / `.next/standalone/
//         server.js` outside a built image — every boot path is a `docker
//         build` + `docker run`.
//   (ii)  preview never becomes / is presented as a production deployment — no
//         path pushes/publishes the local image, tags it a release version, or
//         points it at `ghcr.io/cinatra-ai/cinatra` / `docker.io/cinatra/
//         cinatra`. The local tag namespace is `cinatra-preview:local-<sha>`.
//   (iii) preview never sets or sanctions
//         `CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE=true` to force a boot;
//         if the fail-closed materialize phase aborts, preview surfaces that as
//         a real failure, it does not route around it.
//
// Runtime identity (AC2): the container runs `CINATRA_RUNTIME_MODE=production`
// with a recorded provenance value `local-image:<sha>` stored in THIS CLI's own
// registry (`~/.cinatra/previews.json`) and stamped as an OCI label — never
// presented/labeled/logged as a published production image name.
//
// Tracking (AC8): preview has its OWN registry (`previews.json`), modeled on
// `clone-registry.mjs`, SEPARATE from `instance-registry.mjs`'s dev/prod/demo
// instances — preview is NOT a third `install --mode` value and does NOT reuse
// `install --mode prod` (which provisions infra/DB only and never builds/boots
// an image).
//
// Plain ESM `.mjs`, node builtins only — importable from the light CLI core and
// the eager-`pg`-free unit tests. The pure helpers + the injectable-`deps`
// orchestration are re-exported as `__test` for hermetic vitest (no real docker
// / git / network in the unit suite).
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  fstatSync,
} from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// --- constants -------------------------------------------------------------

const REGISTRY_VERSION = 1;

// Local tag namespace, mirroring the `cinatra-wayflow:local` stable-tag pattern
// in `ensureWayflowImage`. A preview image is `cinatra-preview:local-<sha>` so
// it is NEVER confusable with a published production image name (AC7-ii).
export const PREVIEW_IMAGE_TAG_PREFIX = "cinatra-preview:local-";
export const PREVIEW_CONTAINER_PREFIX = "cinatra-preview-";
export const PREVIEW_VOLUME_PREFIX = "cinatra-preview-data-";

// The recorded provenance value (AC2). Stored in the registry row + as an OCI
// label; NEVER a published image name.
export const PROVENANCE_PREFIX = "local-image:";

// A preview always runs production runtime semantics (AC2).
export const PREVIEW_RUNTIME_MODE = "production";

// The durable local-data root. Matches prod's env-overridable
// `CINATRA_EXTENSION_DATA_ROOT` / `resolveExtensionDataRoot` (default
// `/data/extensions`); a named volume is mounted here so extension data is
// durable and REUSED across `refresh` (AC4). We pin the in-container mount path
// to the documented default so the named volume is the single source of durable
// state across rebuilds.
export const EXTENSION_DATA_ROOT_IN_CONTAINER = "/data/extensions";
export const EXTENSION_DATA_ROOT_ENV = "CINATRA_EXTENSION_DATA_ROOT";

// CINATRA_ENCRYPTION_KEY is its OWN preview boot gate (AC6): 64 hex chars (32
// bytes), validated at instance-secrets use time in the app
// (`src/lib/instance-secrets.ts`) — mirrored here so preview fails BEFORE boot
// with an actionable message rather than a silent degraded boot.
export const ENCRYPTION_KEY_ENV = "CINATRA_ENCRYPTION_KEY";
export const ENCRYPTION_KEY_HEX_LEN = 64;

// The safety-invariant bypass flag preview must NEVER set or sanction (AC7-iii,
// #1580). Its only sanctioned use is a CI screenshot context, never a boot
// workaround.
export const MATERIALIZE_DISABLE_ENV = "CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE";

// Published production image names the local tag must NEVER be (AC7-ii, #1580).
export const FORBIDDEN_PRODUCTION_IMAGE_NAMES = [
  "ghcr.io/cinatra-ai/cinatra",
  "docker.io/cinatra/cinatra",
  "cinatra/cinatra",
];

// Bounded-subprocess convention, mirroring `WAYFLOW_BUILD_TIMEOUT_MS` /
// `DOCKER_CLI_PROBE_TIMEOUT_MS` (AC5): a HUNG docker must never block the CLI.
export const PREVIEW_BUILD_TIMEOUT_MS = 1_800_000; // 30m — full multi-stage cold build ceiling
export const PREVIEW_HEALTH_TIMEOUT_MS = 180_000; // 3m health-gate budget (mirrors prod-boot-e2e default)
export const PREVIEW_HEALTH_POLL_INTERVAL_MS = 3_000; // 3s (mirrors prod-boot-e2e sleep 3)
export const DOCKER_CLI_PROBE_TIMEOUT_MS = 15_000; // 15s fast docker-CLI metadata probes

// Preview containers publish their app port (container 3000) to a host port in a
// DEDICATED pool, disjoint from every port the install/clone systems hand out:
// the default-stack app ports (3000 AND 3010 — 3010 is WayFlow's default, which
// instance-alloc reserves and never hands out), the static clone bands
// (3100-3219), and the instance app-port pool (3300-3399). Each preview gets its
// OWN host port (recorded in its registry row, reused across refresh); a fresh
// create allocates the lowest pool port not already claimed by another preview
// row and probed free on the host — so two previews never collide and a preview
// never lands on a live default install's (e.g. WayFlow's) port.
export const PREVIEW_HOST_PORT_MIN = 3400;
export const PREVIEW_HOST_PORT_MAX = 3499;

// The runtime env keys a preview container inherits from the ambient
// environment when present (the operator supplies DB / auth / redis via env or
// an --env-file, exactly like the prod-boot-e2e boot case). The encryption key
// and runtime mode are handled explicitly (gated + forced); the disable flag is
// deliberately EXCLUDED so it can never be forwarded into the container.
export const PASSTHROUGH_ENV_KEYS = [
  "SUPABASE_DB_URL",
  "SUPABASE_SCHEMA",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "REDIS_URL",
  "NANGO_ENCRYPTION_KEY",
  "OPENAI_API_KEY",
  "CINATRA_BRIDGE_TOKEN",
];

// --- slug / name / tag -----------------------------------------------------

/** A preview slug uses the same shape the clone/branch slugs enforce. */
export function isValidSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,29}$/.test(slug);
}

/** True iff `s` is a full immutable 40-hex git SHA. */
export function isImmutableSha(s) {
  return typeof s === "string" && /^[0-9a-f]{40}$/.test(s);
}

/** The stable local image tag for a resolved SHA (AC3). */
export function previewImageTag(sha) {
  if (!isImmutableSha(sha)) {
    throw new Error(`previewImageTag requires a 40-hex SHA (got ${JSON.stringify(sha)}).`);
  }
  return `${PREVIEW_IMAGE_TAG_PREFIX}${sha}`;
}

/** The recorded provenance value for a resolved SHA (AC2). */
export function previewProvenance(sha) {
  if (!isImmutableSha(sha)) {
    throw new Error(`previewProvenance requires a 40-hex SHA (got ${JSON.stringify(sha)}).`);
  }
  return `${PROVENANCE_PREFIX}${sha}`;
}

/** The container name for a slug. */
export function previewContainerName(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid preview slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  return `${PREVIEW_CONTAINER_PREFIX}${slug}`;
}

/** The durable named volume for a slug (created once, REUSED across refresh — AC4). */
export function previewVolumeName(slug) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid preview slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  return `${PREVIEW_VOLUME_PREFIX}${slug}`;
}

// --- hard-NEVER guards (AC7) -----------------------------------------------

/**
 * AC7-ii: the built local tag must NEVER be a published production image name
 * (a preview is never presented as / pushed as a production artifact). Also
 * asserts the tag lives in the `cinatra-preview:local-` namespace. Fail-closed.
 */
export function assertNotProductionImageTag(tag) {
  const t = String(tag ?? "");
  for (const name of FORBIDDEN_PRODUCTION_IMAGE_NAMES) {
    // Match the repository component (before any `:tag`), so
    // `cinatra/cinatra:anything` and a bare `ghcr.io/cinatra-ai/cinatra` both trip.
    const repo = t.split(":", 1)[0];
    if (repo === name || t === name || t.startsWith(`${name}:`)) {
      throw new Error(
        `Refusing: preview image tag "${t}" resolves to the published production image name "${name}". ` +
          `A preview is a LOCAL, non-production image (${PREVIEW_IMAGE_TAG_PREFIX}<sha>) — it must never be ` +
          `presented, tagged, or pushed as a production artifact (cinatra-ai/cinatra#1580).`,
      );
    }
  }
  if (!t.startsWith(PREVIEW_IMAGE_TAG_PREFIX)) {
    throw new Error(
      `Refusing: preview image tag "${t}" is outside the local preview namespace "${PREVIEW_IMAGE_TAG_PREFIX}<sha>".`,
    );
  }
  return true;
}

/**
 * AC7-iii: preview must NEVER set or sanction the required-extension materialize
 * bypass. If the ambient environment already forces it truthy, refuse loudly —
 * preview boots the fail-closed phase for real, never routes around it.
 */
export function assertMaterializeNotDisabled(env = process.env) {
  const raw = env[MATERIALIZE_DISABLE_ENV];
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") {
    throw new Error(
      `Refusing: ${MATERIALIZE_DISABLE_ENV}=${raw} disables a required-extension SAFETY invariant. ` +
        `preview boots the fail-closed required-extension-materialize phase for real from the image seed — ` +
        `it never sets or sanctions this bypass to force a boot (cinatra-ai/cinatra#1580). ` +
        `Unset ${MATERIALIZE_DISABLE_ENV} and retry; if the phase aborts, that is a real failure to fix.`,
    );
  }
  return true;
}

/**
 * AC6: preview boot requires a present, valid `CINATRA_ENCRYPTION_KEY` (64 hex
 * chars). Independent of and in addition to whatever prod/S1 requires — a
 * missing/invalid key fails create/refresh BEFORE boot with an actionable
 * message, never a silent degraded boot.
 */
export function assertEncryptionKey(env = process.env) {
  const key = env[ENCRYPTION_KEY_ENV];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(
      `preview boot requires ${ENCRYPTION_KEY_ENV} (a ${ENCRYPTION_KEY_HEX_LEN}-hex-char / 32-byte key). ` +
        `It is a runtime-boot requirement (instance-secrets encryption validates it at use time), independent ` +
        `of the image build. Set ${ENCRYPTION_KEY_ENV} in your environment or --env-file and retry. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  const trimmed = key.trim();
  if (!new RegExp(`^[0-9a-fA-F]{${ENCRYPTION_KEY_HEX_LEN}}$`).test(trimmed)) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be exactly ${ENCRYPTION_KEY_HEX_LEN} hex characters (32 bytes); ` +
        `got ${trimmed.length} char(s). Generate one with: openssl rand -hex 32`,
    );
  }
  return trimmed;
}

/**
 * AC9: preview refuses to run (create OR refresh) against a checkout whose
 * `.env.local` resolves to a real `--mode prod` install — so a preview command
 * is never misapplied against a genuine production checkout (and, symmetrically,
 * the dev-only `instance start`/`refresh` guards — which throw on a production
 * `.env.local` — are never bypassed, because a preview boots via `docker run
 * -e`, it never writes a production `.env.local` into the operator's dev
 * checkout).
 *
 * The refusal is UNCONDITIONAL on the checkout's env mode and is derived from
 * the CHECKOUT, never from the registry: a preview never writes a production
 * `.env.local`, so the only way this directory's `.env.local` reads
 * CINATRA_RUNTIME_MODE=production is that it IS a genuine `--mode prod` install
 * — there is no legitimate preview run from such a directory. Whether a preview
 * ROW happens to exist for the slug says nothing about whether THIS directory is
 * a production install, so it must never gate this refusal — that is exactly the
 * conflation that would make the guard a no-op for `refresh` (which requires an
 * existing row to proceed, forcing any such "row exists" signal permanently
 * true).
 *
 * @param {{ envMode: string|null }} args
 */
export function assertPreviewCheckoutAllowed({ envMode }) {
  if (normalizeMode(envMode) === "production") {
    throw new Error(
      `Refusing: this checkout's .env.local is a real production install ` +
        `(CINATRA_RUNTIME_MODE=production). A preview is a distinct, non-production lifecycle — ` +
        `it must not be run against a genuine --mode prod checkout. Run preview from a dev checkout ` +
        `(it builds an image at a resolved SHA and boots it in a container).`,
    );
  }
  return true;
}

/** Normalize a raw runtime-mode value to "production" | "development" | null. */
export function normalizeMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.length === 0) return null;
  if (v.startsWith("prod")) return "production";
  if (v.startsWith("dev")) return "development";
  return null;
}

/** Read `CINATRA_RUNTIME_MODE` from a checkout's `.env.local` (null when absent). */
export function readCheckoutEnvMode(checkoutDir) {
  const envPath = path.join(checkoutDir, ".env.local");
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:CINATRA_RUNTIME_MODE|APP_RUNTIME_MODE)=(.*)$/);
      if (m) return m[1].replace(/['"]/g, "").trim();
    }
  } catch {
    /* absent — no .env.local, or unreadable */
  }
  return null;
}

// --- runtime env for `docker run` (AC2 + the NEVERs) -----------------------

/**
 * Build the `-e KEY=VALUE` docker-run env args for a preview container.
 *
 *  - ALWAYS sets CINATRA_RUNTIME_MODE=production (AC2).
 *  - ALWAYS sets CINATRA_EXTENSION_DATA_ROOT to the durable-volume mount path (AC4).
 *  - Requires + forwards CINATRA_ENCRYPTION_KEY (AC6, validated by caller).
 *  - Forwards the known DB/auth/redis passthrough keys when present in `env`.
 *  - NEVER forwards CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE (AC7-iii): it
 *    is not in PASSTHROUGH_ENV_KEYS and is asserted-absent before boot.
 *
 * Returns a flat argv fragment: ["-e", "K=V", "-e", "K2=V2", ...].
 *
 * @param {{ encryptionKey: string, env?: Record<string,string> }} args
 */
export function buildPreviewRunEnvArgs({ encryptionKey, env = process.env }) {
  assertMaterializeNotDisabled(env);
  const pairs = [];
  pairs.push([ "CINATRA_RUNTIME_MODE", PREVIEW_RUNTIME_MODE ]);
  pairs.push([ EXTENSION_DATA_ROOT_ENV, EXTENSION_DATA_ROOT_IN_CONTAINER ]);
  pairs.push([ ENCRYPTION_KEY_ENV, encryptionKey ]);
  pairs.push([ "HOSTNAME", "0.0.0.0" ]);
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      pairs.push([ key, value ]);
    }
  }
  // Defense in depth: even if a caller mutated PASSTHROUGH_ENV_KEYS, never emit
  // the bypass flag.
  const args = [];
  for (const [k, v] of pairs) {
    if (k === MATERIALIZE_DISABLE_ENV) continue;
    args.push("-e", `${k}=${v}`);
  }
  return args;
}

// --- health-gate state machine (AC5) ---------------------------------------

/**
 * Classify a single `/api/health` response, mirroring the state machine proven
 * in `scripts/ci/prod-boot-e2e.sh` and the contract in AC5:
 *   - HTTP 200 + body `"status":"ok"`              → "healthy"  (terminal success)
 *   - HTTP 503 + body `"status":"degraded"|"error"`→ "degraded" (terminal failure)
 *   - body `"status":"starting"`                   → "starting" (TRANSIENT, keep polling)
 *   - anything else (a bare 200 without ok, a
 *     non-classified body, an unexpected code)      → "unknown"  (keep polling)
 *
 * NOTE (AC5): a bare TCP-reachable / HTTP-200-only check is NOT sufficient — a
 * 200 whose body is not `"status":"ok"` is "unknown", never "healthy". The
 * terminal-failure classification requires BOTH the 503 status AND a
 * degraded/error status field (the exact pairing the app's /api/health emits on
 * a durable-degraded / fatal boot), so a stray substring or a transient non-503
 * body can never be mis-read as a terminal failure — it keeps polling until the
 * bounded timeout fails loudly instead.
 *
 * @param {{ status: number, body: string }} res
 * @returns {"healthy"|"degraded"|"starting"|"unknown"}
 */
export function classifyHealthResponse({ status, body }) {
  const text = typeof body === "string" ? body : "";
  if (status === 200 && /"status"\s*:\s*"ok"/.test(text)) return "healthy";
  if (status === 503 && /"status"\s*:\s*"(degraded|error)"/.test(text)) return "degraded";
  if (/"status"\s*:\s*"starting"/.test(text)) return "starting";
  return "unknown";
}

/**
 * Poll `/api/health` to a TERMINAL state within a bounded budget (AC5). Mirrors
 * `run_boot_case`'s healthy/degraded/crashed/timeout classification:
 *   - "healthy"  → 200 status:"ok"                (success)
 *   - "degraded" → 503 status:"degraded"|"error"  (terminal failure — stop, fail loud)
 *   - "crashed"  → the container is no longer running before serving
 *   - "timeout"  → never reached a terminal state within `timeoutMs`
 *
 * status:"starting" and any unclassified/unreachable probe are TRANSIENT — keep
 * polling. The budget makes it fail loudly, never hang.
 *
 * `deps.probeHealth(url)` returns `{ status, body }` or `null` (unreachable —
 * transient). `deps.isRunning()` is the liveness check. `deps.now()` /
 * `deps.sleep(ms)` bound the loop.
 *
 * @returns {Promise<{ state: "healthy"|"degraded"|"crashed"|"timeout", status?: number, body?: string }>}
 */
export async function pollHealthGate({
  url,
  deps,
  timeoutMs = PREVIEW_HEALTH_TIMEOUT_MS,
  intervalMs = PREVIEW_HEALTH_POLL_INTERVAL_MS,
}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  // Loop is bounded by the deadline AND is checked BEFORE the first probe so a
  // zero/exhausted budget returns immediately instead of probing once.
  for (;;) {
    if (deps.isRunning && !(await deps.isRunning())) {
      return { state: "crashed" };
    }
    let res = null;
    try {
      res = await deps.probeHealth(url);
    } catch {
      res = null; // treat a probe throw as unreachable (transient)
    }
    if (res && typeof res.status === "number") {
      const cls = classifyHealthResponse(res);
      if (cls === "healthy") return { state: "healthy", status: res.status, body: res.body };
      if (cls === "degraded") return { state: "degraded", status: res.status, body: res.body };
      // "starting" / "unknown" → keep polling.
    }
    if (now() >= deadline) return { state: "timeout" };
    await sleep(intervalMs);
  }
}

// --- registry file I/O (modeled on clone-registry.mjs) ---------------------

export function defaultRegistryPath() {
  return path.join(os.homedir(), ".cinatra", "previews.json");
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, previews: {} };
}

const PREVIEW_STATES = new Set(["provisioning", "ready", "degraded"]);

/**
 * Structural validation of one preview slot. A registry entry that does not
 * match this shape is registry corruption — `readRegistry` classifies the whole
 * file `malformed` so `requireUsableRegistry` refuses to mutate it.
 */
function isValidPreviewSlot(slug, slot) {
  if (!isValidSlug(slug)) return false;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
  if (slot.slug !== slug) return false;
  if (typeof slot.ref !== "string" || slot.ref.length === 0) return false;
  if (!isImmutableSha(slot.sha)) return false;
  if (slot.imageTag !== previewImageTag(slot.sha)) return false;
  if (slot.provenance !== previewProvenance(slot.sha)) return false;
  if (slot.runtimeMode !== PREVIEW_RUNTIME_MODE) return false;
  if (slot.containerName !== previewContainerName(slug)) return false;
  if (slot.volumeName !== previewVolumeName(slug)) return false;
  if (!PREVIEW_STATES.has(slot.state)) return false;
  if (typeof slot.createdAt !== "string" || slot.createdAt.length === 0) return false;
  if (!Array.isArray(slot.history)) return false;
  return true;
}

function areRegistryEntriesValid(previews) {
  for (const [slug, slot] of Object.entries(previews)) {
    if (!isValidPreviewSlot(slug, slot)) return false;
  }
  return true;
}

/**
 * Read the registry file. NEVER throws.
 * Returns { status, registry }:
 *   - "missing"   → file absent; registry = fresh empty registry
 *   - "ok"        → parsed + deep-validated
 *   - "malformed" → unreadable/invalid JSON/bad shape; registry = null
 */
export function readRegistry(filePath) {
  if (!existsSync(filePath)) {
    return { status: "missing", registry: emptyRegistry() };
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { status: "malformed", registry: null, error: err };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "malformed", registry: null, error: err };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.previews !== "object" ||
    parsed.previews === null ||
    Array.isArray(parsed.previews)
  ) {
    return { status: "malformed", registry: null };
  }
  if (!areRegistryEntriesValid(parsed.previews)) {
    return { status: "malformed", registry: null };
  }
  if (typeof parsed.version !== "number") parsed.version = REGISTRY_VERSION;
  return { status: "ok", registry: parsed };
}

/** Read the registry for a MUTATING command — throws (never auto-resets) on malformed. */
export function requireUsableRegistry(filePath) {
  const result = readRegistry(filePath);
  if (result.status === "malformed") {
    throw new Error(
      `Preview registry at ${filePath} is malformed and was NOT modified. ` +
        `Inspect/repair it by hand (or delete it only if you are sure no previews exist), then retry.`,
    );
  }
  return result.registry;
}

/** Atomic write: temp file in the same dir + rename. Creates ~/.cinatra/ if absent. */
export function writeRegistry(filePath, data) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ ...data, version: data.version ?? REGISTRY_VERSION }, null, 2) + "\n";
  const tmp = path.join(dir, `.previews.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, filePath);
}

// --- file lock (best-effort, single-host) ----------------------------------

const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 10_000;

function lockHolderAlive(lockPath) {
  let pid = null;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim().split(/\s+/)[0], 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

/**
 * Run `fn` while holding an exclusive `<filePath>.lock`. Serialises
 * read→mutate→write so two concurrent preview commands can't corrupt the
 * registry. Best-effort steal of a lock older than LOCK_STALE_MS whose holder
 * pid is dead; always released in `finally`.
 */
export async function withRegistryLock(filePath, fn) {
  const lockPath = `${filePath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err && err.code === "EEXIST") {
        let stale = false;
        try {
          const st = statSync(lockPath);
          stale = Date.now() - st.mtimeMs > LOCK_STALE_MS && !lockHolderAlive(lockPath);
        } catch {
          /* vanished — retry */
        }
        if (stale) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* already gone */
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out after ${LOCK_TIMEOUT_MS}ms waiting for the preview registry lock (${lockPath}). ` +
              `If no other 'cinatra instance preview' command is running, delete the lock file and retry.`,
          );
        }
        await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        continue;
      }
      throw err;
    }
  }
  let ourInode = null;
  try {
    ourInode = fstatSync(fd).ino;
  } catch {
    /* fall back to unconditional unlink */
  }
  try {
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    /* diagnostics only */
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      if (ourInode === null || statSync(lockPath).ino === ourInode) unlinkSync(lockPath);
    } catch {
      /* already removed */
    }
  }
}

// --- slot operations (pure) ------------------------------------------------

function cloneRegistry(registry) {
  return { version: registry.version ?? REGISTRY_VERSION, previews: { ...registry.previews } };
}

export function getPreview(registry, slug) {
  return registry.previews[slug] ?? null;
}

export function listPreviews(registry) {
  return Object.entries(registry.previews)
    .map(([slug, slot]) => ({ ...slot, slug }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Build a fresh (create) preview slot record. Pure — the caller persists it.
 * `history` seeds with the initial sha/tag so a later `refresh` records
 * old→new without ever silently overwriting (AC3).
 */
export function makePreviewSlot({ slug, ref, sha, hostPort, state = "ready", now }) {
  if (!isValidSlug(slug)) throw new Error(`Invalid preview slug "${slug}".`);
  if (!isImmutableSha(sha)) throw new Error(`makePreviewSlot requires a 40-hex SHA (got ${JSON.stringify(sha)}).`);
  const at = (now ?? (() => new Date().toISOString()))();
  const imageTag = previewImageTag(sha);
  return {
    slug,
    ref: String(ref),
    sha,
    imageTag,
    provenance: previewProvenance(sha),
    runtimeMode: PREVIEW_RUNTIME_MODE,
    containerName: previewContainerName(slug),
    volumeName: previewVolumeName(slug),
    hostPort: hostPort ?? null,
    state,
    createdAt: at,
    refreshedAt: at,
    history: [{ sha, imageTag, at }],
  };
}

/**
 * Apply a `refresh` to an existing slot: record the NEW sha/tag pair, append the
 * old→new transition to `history`, and NEVER silently overwrite — the caller
 * logs old→new. The volumeName/containerName are stable (the durable volume is
 * REUSED, AC4). Pure — returns a new slot.
 */
export function refreshPreviewSlot(slot, { ref, sha, hostPort, state = "ready", now }) {
  if (!isImmutableSha(sha)) throw new Error(`refreshPreviewSlot requires a 40-hex SHA (got ${JSON.stringify(sha)}).`);
  const at = (now ?? (() => new Date().toISOString()))();
  const imageTag = previewImageTag(sha);
  return {
    ...slot,
    ref: ref !== undefined ? String(ref) : slot.ref,
    sha,
    imageTag,
    provenance: previewProvenance(sha),
    runtimeMode: PREVIEW_RUNTIME_MODE,
    hostPort: hostPort ?? slot.hostPort ?? null,
    state,
    refreshedAt: at,
    history: [...(slot.history ?? []), { sha, imageTag, at }],
  };
}

// --- default real deps (docker / git / fetch) ------------------------------

function runSpawn(cmd, args, { timeoutMs, stdio } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: stdio ?? ["ignore", "pipe", "pipe"],
    timeout: timeoutMs ?? DOCKER_CLI_PROBE_TIMEOUT_MS,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
    timedOut: res.error?.code === "ETIMEDOUT",
  };
}

/**
 * Resolve a git ref to an immutable 40-hex SHA using the checkout's own git.
 * `<ref>^{commit}` peels tags/branches to a commit SHA (AC1).
 */
function defaultResolveSha(ref, checkoutDir) {
  const r = runSpawn("git", ["-C", checkoutDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = (r.stdout ?? "").trim();
  if (r.status !== 0 || !isImmutableSha(sha)) {
    throw new Error(
      `Could not resolve git ref "${ref}" to a commit SHA in ${checkoutDir}` +
        (r.stderr ? `: ${r.stderr.trim()}` : ".") +
        ` Fetch first (git -C ${checkoutDir} fetch origin) or pass an existing --ref.`,
    );
  }
  return sha;
}

/**
 * Materialize a clean, SHA-pinned build context (AC1: "context = the resolved
 * checkout"). A detached git worktree at the resolved SHA is the build context;
 * the returned `cleanup()` removes it (the built image carries the artifact, so
 * the worktree is transient). `.dockerignore` in the checkout already excludes
 * `.git`, node_modules, extensions, .env.* etc.
 */
function defaultPrepareContext({ sha, checkoutDir }) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), "cinatra-preview-ctx-"));
  const contextDir = path.join(workRoot, "checkout");
  const add = runSpawn(
    "git",
    ["-C", checkoutDir, "worktree", "add", "--detach", "--force", contextDir, sha],
    { timeoutMs: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (add.status !== 0) {
    throw new Error(
      `Failed to materialize a build context at ${sha}` + (add.stderr ? `: ${add.stderr.trim()}` : ".") +
        ` (git worktree add).`,
    );
  }
  return {
    contextDir,
    cleanup() {
      // Remove the worktree registration, then the temp dir.
      runSpawn("git", ["-C", checkoutDir, "worktree", "remove", "--force", contextDir], {
        timeoutMs: 60_000,
      });
      try {
        // Best-effort remove the temp root (worktree remove clears contextDir).
        if (existsSync(workRoot)) runSpawn("rm", ["-rf", workRoot], { timeoutMs: 30_000 });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Real host-port probe: resolves true iff `port` can be bound on 0.0.0.0 — the
 * interface `docker run -p <host>:3000` publishes on. A bind error (EADDRINUSE /
 * EACCES) means the port is busy. Best-effort; used only as defense-in-depth on
 * top of the registry-recorded per-preview ports.
 */
function defaultProbePort(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function defaultProbeHealth(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), DOCKER_CLI_PROBE_TIMEOUT_MS);
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    clearTimeout(t);
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return null; // unreachable — transient, keep polling
  }
}

/**
 * The default real dependency surface. Every side-effecting operation goes
 * through `runDocker` / `resolveSha` / `prepareContext` / `probeHealth` so the
 * unit suite can inject hermetic fakes (no real docker/git/network).
 */
export function defaultDeps({ registryPath = defaultRegistryPath(), log = console.log, logError = (m) => console.error(m) } = {}) {
  return {
    registryPath,
    log,
    logError,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    resolveSha: defaultResolveSha,
    prepareContext: defaultPrepareContext,
    probeHealth: defaultProbeHealth,
    probePort: (port) => defaultProbePort(port),
    runDocker: (args, opts = {}) => runSpawn("docker", args, opts),
    env: process.env,
  };
}

// --- docker steps (via injected runDocker) ---------------------------------

/**
 * Build the preview image at `tag` from `contextDir` using the checkout's OWN
 * multi-stage Dockerfile (the same one build-image.yml uses: acquire-prod +
 * OAS-seed + presence-aware manifest regen + `next build` standalone + runtime
 * copy). Bounded by PREVIEW_BUILD_TIMEOUT_MS; fails loudly on error/timeout.
 * AC7-ii is enforced here: the tag can never be a published production name.
 */
export function buildPreviewImage({ tag, contextDir, deps, provenance, sha }) {
  assertNotProductionImageTag(tag);
  const args = ["build", "-t", tag];
  if (provenance) args.push("--label", `cinatra.preview.provenance=${provenance}`);
  if (sha) args.push("--label", `cinatra.preview.sha=${sha}`);
  args.push(contextDir);
  const r = deps.runDocker(args, {
    timeoutMs: PREVIEW_BUILD_TIMEOUT_MS,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.timedOut || r.error || r.status !== 0) {
    throw new Error(
      `docker build of ${tag} failed` +
        (r.timedOut ? " (timed out)" : "") +
        (r.stderr ? `: ${r.stderr.trim()}` : ".") +
        ` The build runs the checkout's own multi-stage Dockerfile (acquire-prod, required-OAS seed, ` +
        `manifest regen, next build); fix the underlying error and retry.`,
    );
  }
  return tag;
}

/** True iff a docker object (container/image/volume) with `ref` exists for `kind`. */
export function dockerObjectExists({ kind, ref, deps }) {
  const sub = { container: "container", image: "image", volume: "volume" }[kind];
  if (!sub) throw new Error(`dockerObjectExists: unknown kind ${JSON.stringify(kind)}.`);
  const r = deps.runDocker([sub, "inspect", ref], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
  return r.status === 0;
}

/**
 * True iff a container is actually RUNNING (not merely present). `docker
 * container inspect <name>` succeeds even for a STOPPED/exited container, so a
 * bare existence check would misclassify a crash as a timeout. Mirrors
 * prod-boot-e2e's `docker inspect -f '{{.State.Running}}'` liveness signal.
 */
export function containerRunning(name, deps) {
  const r = deps.runDocker(["container", "inspect", "-f", "{{.State.Running}}", name], {
    timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS,
  });
  if (r.status !== 0) return false; // absent/removed
  return (r.stdout ?? "").trim() === "true";
}

/**
 * Remove an image tag ONLY when no OTHER preview slot still references it. The
 * tag is SHA-global (`cinatra-preview:local-<sha>`), so two previews (distinct
 * slugs) at the same SHA share one tag — dropping it out from under a sibling
 * would leave that sibling pointing at a nonexistent image. `keepSlug` is the
 * slug being cleaned up (its own reference does not count).
 *
 * The reference-check and the `docker image rm` run ATOMICALLY under the
 * registry lock, so a concurrent create/refresh cannot CLAIM the tag (write a
 * provisioning row referencing it) between the check and the removal. It FAILS
 * CLOSED on a malformed registry — keep the image rather than risk deleting one
 * that is still referenced by an unreadable row.
 *
 * @returns {Promise<boolean>} true iff the image was removed.
 */
export async function removeImageIfUnreferenced(tag, { registryPath, keepSlug, deps }) {
  return withRegistryLock(registryPath, () => {
    const { status, registry } = readRegistry(registryPath);
    if (status === "malformed") {
      deps.log?.(`  keeping image ${tag} — preview registry is malformed (fail-closed; not removing).`);
      return false;
    }
    const reg = registry ?? emptyRegistry();
    for (const [slug, slot] of Object.entries(reg.previews)) {
      if (slug === keepSlug) continue;
      if (slot?.imageTag === tag) {
        deps.log?.(`  keeping image ${tag} — still referenced by preview "${slug}".`);
        return false;
      }
    }
    removeImage(tag, deps);
    return true;
  });
}

/** Remove a container (best-effort, forced). */
export function removeContainer(name, deps) {
  deps.runDocker(["rm", "-f", name], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
}

/** Remove an image tag (superseded-tag cleanup — AC4). Best-effort. */
export function removeImage(tag, deps) {
  deps.runDocker(["image", "rm", "-f", tag], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
}

/** Dump the container's recent logs for failure diagnostics (mirrors dump_logs). */
export function dumpContainerLogs(name, deps) {
  const r = deps.runDocker(["logs", "--tail", "200", name], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/**
 * Boot a preview container: `docker run -d` the built local image with
 * production runtime env (AC2), the durable named volume mounted at the
 * extension-data root (AC4), and the host port published. NEVER a host `next
 * start` (AC7-i): the ONLY boot path is docker run of the built image.
 *
 * @returns {string} the container name
 */
export function bootPreviewContainer({ slug, tag, hostPort, encryptionKey, provenance, sha, deps }) {
  assertNotProductionImageTag(tag);
  const containerName = previewContainerName(slug);
  const volumeName = previewVolumeName(slug);
  const envArgs = buildPreviewRunEnvArgs({ encryptionKey, env: deps.env ?? process.env });
  const args = [
    "run", "-d",
    "--name", containerName,
    "-v", `${volumeName}:${EXTENSION_DATA_ROOT_IN_CONTAINER}`,
    "-p", `${hostPort}:3000`,
    ...envArgs,
  ];
  if (provenance) args.push("--label", `cinatra.preview.provenance=${provenance}`);
  if (sha) args.push("--label", `cinatra.preview.sha=${sha}`);
  args.push(tag);
  const r = deps.runDocker(args, { timeoutMs: 60_000 });
  if (r.error || r.status !== 0) {
    throw new Error(
      `docker run of preview ${containerName} (${tag}) failed` +
        (r.stderr ? `: ${r.stderr.trim()}` : "."),
    );
  }
  return containerName;
}

// --- orchestration ---------------------------------------------------------

function readOption(rest, flag) {
  const eq = `${flag}=`;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === flag) return rest[i + 1];
    if (rest[i].startsWith(eq)) return rest[i].slice(eq.length);
  }
  return undefined;
}

/**
 * Derive the preview slug: explicit `--slug`, else the checkout's current git
 * branch sanitized, else "main".
 */
export function deriveSlug({ rest, checkoutDir }) {
  const explicit = readOption(rest, "--slug");
  if (explicit) {
    if (!isValidSlug(explicit)) {
      throw new Error(`Invalid --slug "${explicit}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
    }
    return explicit;
  }
  const r = runSpawn("git", ["-C", checkoutDir, "rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = (r.stdout ?? "").trim();
  const slug = String(branch || "main")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return isValidSlug(slug) ? slug : "main";
}

/** The host ports already claimed by existing preview rows (durable per-slug). */
export function usedPreviewHostPorts(registry) {
  const used = new Set();
  for (const slot of Object.values(registry?.previews ?? {})) {
    if (Number.isInteger(slot?.hostPort)) used.add(slot.hostPort);
  }
  return used;
}

/**
 * Allocate the lowest free preview host port: within the dedicated pool, not
 * already claimed by another preview row (`registry`), not in `exclude`, and —
 * when a `probe` is provided — live-bindable on the host. `probe(port)` resolves
 * true iff the port is free. Throws (actionable) when the pool is exhausted.
 *
 * Called UNDER the registry lock against the same snapshot the claim is written
 * to, so two concurrent creates never pick the same host port (the earlier
 * claim's row is visible to the later one).
 */
export async function allocatePreviewHostPort({
  registry,
  exclude = null,
  probe = null,
  min = PREVIEW_HOST_PORT_MIN,
  max = PREVIEW_HOST_PORT_MAX,
} = {}) {
  const used = usedPreviewHostPorts(registry);
  const skip = exclude instanceof Set ? exclude : new Set();
  for (let p = min; p <= max; p += 1) {
    if (used.has(p) || skip.has(p)) continue;
    if (typeof probe === "function") {
      let free = false;
      try {
        free = await probe(p);
      } catch {
        free = false; // a probe throw is treated as "busy" (fail closed on this port)
      }
      if (!free) continue;
    }
    return p;
  }
  throw new Error(
    `No free preview host port in ${min}-${max} (every port is claimed by another preview or busy on the host). ` +
      `Prune a preview, or pass --port <n> with a free port.`,
  );
}

/** Validate an explicit operator-supplied `--port` (SHAPE / range only). Rejects
 *  trailing garbage (`4321junk`) — the whole token must be digits. */
export function validatePreviewPort(value) {
  const raw = String(value).trim();
  const n = Number.parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`Invalid --port "${value}". Must be an integer between 1024 and 65535.`);
  }
  return n;
}

/**
 * `cinatra instance preview create` (AC1, AC2, AC5, AC6, AC7): resolve the git
 * ref to an immutable SHA, build the image at that SHA, boot it with production
 * runtime semantics + recorded provenance, and health-gate to a terminal state.
 * Fails if a preview already exists for the slug (use `refresh`).
 */
export async function runPreviewCreate(rest, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const env = deps.env ?? process.env;

  // AC6: encryption-key gate BEFORE any build/boot (fail early, actionable).
  const encryptionKey = assertEncryptionKey(env);
  // AC7-iii: never route around the materialize safety invariant.
  assertMaterializeNotDisabled(env);
  // AC9: refuse a genuine `--mode prod` checkout up front — before we even
  // resolve a SHA against or touch its `.git`. Checkout-derived, unconditional on
  // the env mode (never gated on a registry row).
  assertPreviewCheckoutAllowed({ envMode: readCheckoutEnvMode(checkoutDir) });

  const slug = deriveSlug({ rest, checkoutDir });
  const ref = readOption(rest, "--ref") ?? "main";
  const explicitPort = readOption(rest, "--port");

  const sha = deps.resolveSha(ref, checkoutDir);
  const tag = previewImageTag(sha);
  const provenance = previewProvenance(sha);
  const volumeName = previewVolumeName(slug);

  // Atomically CLAIM the slug under the registry lock (lifecycle ownership) AND
  // allocate this preview's OWN host port against the same snapshot: a concurrent
  // create/refresh on the same slug sees the claim and refuses, rather than
  // racing to replace the container / drop a shared image, and two creates never
  // pick the same host port. AC1's "already exists" refusal is enforced HERE (any
  // prior row — ready, degraded, or an in-flight provisioning claim — blocks a
  // fresh create).
  let hostPort;
  await withRegistryLock(deps.registryPath, async () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const existing = getPreview(reg, slug);
    if (existing) {
      const hint =
        existing.state === "provisioning"
          ? `An operation is already in-flight for "${slug}" (state=provisioning).`
          : `A preview already exists for slug "${slug}" (sha ${existing.sha}, ${existing.imageTag}).`;
      throw new Error(
        `${hint} Use \`cinatra instance preview refresh --slug ${slug} --ref <ref>\` to rebuild ` +
          `at a new SHA (it reuses the durable volume), or prune the existing preview first.`,
      );
    }
    hostPort =
      explicitPort !== undefined
        ? validatePreviewPort(explicitPort)
        : await allocatePreviewHostPort({ registry: reg, probe: deps.probePort });
    const next = cloneRegistry(reg);
    next.previews[slug] = makePreviewSlot({ slug, ref, sha, hostPort, state: "provisioning", now: () => new Date().toISOString() });
    writeRegistry(deps.registryPath, next);
  });

  // Whether the durable volume already existed BEFORE this create — so a FAILED
  // create only removes a volume IT created, never a pre-existing/recovered one
  // holding data.
  const volumePreexisted = dockerObjectExists({ kind: "volume", ref: volumeName, deps });

  deps.log(`preview create: slug=${slug} ref=${ref} -> sha=${sha}`);
  deps.log(`  image tag: ${tag}   provenance: ${provenance}   runtime: CINATRA_RUNTIME_MODE=production`);

  // Release the claim + tear down partial docker state on ANY failure after the
  // claim, then re-throw. Image removal is SHA-global-safe (only removes the tag
  // when no OTHER slug references it); the volume is removed only if this create
  // created it.
  const abort = async (err) => {
    removeContainer(previewContainerName(slug), deps);
    await removeImageIfUnreferenced(tag, { registryPath: deps.registryPath, keepSlug: slug, deps });
    if (!volumePreexisted) {
      deps.runDocker(["volume", "rm", "-f", volumeName], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
    }
    await withRegistryLock(deps.registryPath, () => {
      const reg = requireUsableRegistry(deps.registryPath);
      const cur = getPreview(reg, slug);
      // Only release OUR provisioning claim (never a row a racing op finalized).
      if (cur && cur.state === "provisioning" && cur.sha === sha) {
        const next2 = cloneRegistry(reg);
        delete next2.previews[slug];
        writeRegistry(deps.registryPath, next2);
      }
    });
    throw err;
  };

  try {
    const ctx = deps.prepareContext({ sha, checkoutDir });
    try {
      buildPreviewImage({ tag, contextDir: ctx.contextDir, deps, provenance, sha });
    } finally {
      try {
        ctx.cleanup?.();
      } catch {
        /* best-effort */
      }
    }

    const container = bootPreviewContainer({ slug, tag, hostPort, encryptionKey, provenance, sha, deps });
    deps.log(`  booted ${container}; health-gating http://localhost:${hostPort}/api/health ...`);
    const result = await pollHealthGate({
      url: `http://localhost:${hostPort}/api/health`,
      deps: { ...deps, isRunning: () => containerRunning(container, deps) },
    });
    if (result.state !== "healthy") {
      const diag = dumpContainerLogs(container, deps);
      await abort(
        new Error(
          `preview create for "${slug}" did not reach healthy (terminal state: ${result.state}` +
            (result.status ? `, http ${result.status}` : "") + `). ` +
            `The boot never returned 200 {"status":"ok"} within the health budget — this is a real failure, ` +
            `not a false success.\n--- container logs (tail) ---\n${diag.slice(-4000)}`,
        ),
      );
    }
  } catch (err) {
    // `abort` re-throws; if it already ran (the message carries our marker) do
    // not double-clean. Any OTHER throw (build/run) still needs teardown.
    if (/did not reach healthy/.test(String(err?.message))) throw err;
    await abort(err);
  }

  // Success: flip the claim to a ready row (AC3 — sha/tag/volume/provenance).
  await withRegistryLock(deps.registryPath, () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const cur = getPreview(reg, slug);
    const next = cloneRegistry(reg);
    next.previews[slug] = makePreviewSlot({ slug, ref, sha, hostPort, state: "ready", now: () => cur?.createdAt ?? new Date().toISOString() });
    writeRegistry(deps.registryPath, next);
  });
  deps.log(`preview "${slug}" is healthy: ${tag} (sha ${sha}) on http://localhost:${hostPort}`);
  return { slug, sha, tag, hostPort, state: "healthy" };
}

/**
 * `cinatra instance preview refresh` (AC1, AC3, AC4, AC5): rebuild at a NEW
 * resolved SHA, reboot, REUSE the prior durable volume, health-gate, then clean
 * up the superseded image + the replaced container. Records the new sha/tag and
 * logs old→new; never silently overwrites.
 */
export async function runPreviewRefresh(rest, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const env = deps.env ?? process.env;

  const encryptionKey = assertEncryptionKey(env); // AC6
  assertMaterializeNotDisabled(env); // AC7-iii
  // AC9: refuse a genuine `--mode prod` checkout up front — checkout-derived and
  // unconditional. Critically NOT gated on an existing registry row: refresh
  // requires an existing row to proceed, so gating the refusal on "a row exists"
  // would force it permanently satisfied and make the guard a no-op here.
  assertPreviewCheckoutAllowed({ envMode: readCheckoutEnvMode(checkoutDir) });

  const slug = deriveSlug({ rest, checkoutDir });
  const ref = readOption(rest, "--ref") ?? "main";
  const newSha = deps.resolveSha(ref, checkoutDir);
  const newTag = previewImageTag(newSha);
  const provenance = previewProvenance(newSha);

  // CLAIM the slug under the lock: require an existing (non-in-flight) row,
  // capture the prior sha/tag + reuse the durable host port, and flip the row to
  // `provisioning` so a concurrent op can't race the container replacement.
  let oldSha, oldTag, hostPort, volumeName;
  await withRegistryLock(deps.registryPath, async () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const existing = getPreview(reg, slug);
    if (!existing) {
      throw new Error(
        `No preview exists for slug "${slug}" to refresh. Run ` +
          `\`cinatra instance preview create --slug ${slug} --ref <ref>\` first.`,
      );
    }
    if (existing.state === "provisioning") {
      throw new Error(`An operation is already in-flight for preview "${slug}" (state=provisioning). Wait for it to finish.`);
    }
    oldSha = existing.sha;
    oldTag = existing.imageTag;
    // Reuse the preview's durable host port; allocate only if an older row never
    // recorded one (rows created by this CLI always carry a hostPort).
    hostPort = Number.isInteger(existing.hostPort)
      ? existing.hostPort
      : await allocatePreviewHostPort({ registry: reg, probe: deps.probePort });
    volumeName = existing.volumeName;
    const next = cloneRegistry(reg);
    // Persist the (possibly freshly-allocated, for a legacy row) durable host
    // port in the SAME locked transaction as the claim — so a concurrent create
    // sees it claimed via usedPreviewHostPorts and never picks the same port.
    next.previews[slug] = { ...existing, hostPort, state: "provisioning" };
    writeRegistry(deps.registryPath, next);
  });

  if (newSha === oldSha) {
    deps.log(`preview refresh: slug=${slug} ref=${ref} already at sha ${newSha} — rebuilding at the same SHA.`);
  }
  deps.log(`preview refresh: slug=${slug} ref=${ref} -> sha ${oldSha} -> ${newSha} (old->new)`);
  deps.log(`  old image ${oldTag} -> new image ${newTag}; reusing durable volume ${volumeName}`);

  // `replaced` flips true once we tear down the old container to boot the new
  // one. Before that (e.g. a build failure), the OLD preview is still running
  // and healthy, so abort leaves it UNTOUCHED and restores the row to `ready`.
  // After replacement, a failure leaves nothing running, so abort marks the row
  // `degraded`. Either way the durable volume is NEVER dropped (AC4) and the new
  // image is removed SHA-global-safe (only if no other slug references it).
  let replaced = false;
  const abort = async (err) => {
    if (replaced) removeContainer(previewContainerName(slug), deps);
    if (newTag !== oldTag) {
      await removeImageIfUnreferenced(newTag, { registryPath: deps.registryPath, keepSlug: slug, deps });
    }
    await withRegistryLock(deps.registryPath, () => {
      const reg = requireUsableRegistry(deps.registryPath);
      const cur = getPreview(reg, slug);
      if (cur && cur.state === "provisioning") {
        const next = cloneRegistry(reg);
        // Restore the row to the OLD (last-good) sha/tag. `ready` when the old
        // preview is still up (pre-replacement), `degraded` once replaced.
        next.previews[slug] = {
          ...cur,
          sha: oldSha,
          imageTag: oldTag,
          provenance: previewProvenance(oldSha),
          state: replaced ? "degraded" : "ready",
        };
        writeRegistry(deps.registryPath, next);
      }
    });
    throw err;
  };

  try {
    // Build the NEW image FIRST (a build failure leaves the running preview
    // untouched — we only replace the container after a successful build).
    const ctx = deps.prepareContext({ sha: newSha, checkoutDir });
    try {
      buildPreviewImage({ tag: newTag, contextDir: ctx.contextDir, deps, provenance, sha: newSha });
    } finally {
      try {
        ctx.cleanup?.();
      } catch {
        /* best-effort */
      }
    }

    // Replace the running container (AC4: the replaced container is removed —
    // no orphan accumulation), REUSING the durable volume (never dropped).
    replaced = true;
    removeContainer(previewContainerName(slug), deps);
    const container = bootPreviewContainer({ slug, tag: newTag, hostPort, encryptionKey, provenance, sha: newSha, deps });
    deps.log(`  booted ${container}; health-gating http://localhost:${hostPort}/api/health ...`);
    const result = await pollHealthGate({
      url: `http://localhost:${hostPort}/api/health`,
      deps: { ...deps, isRunning: () => containerRunning(container, deps) },
    });
    if (result.state !== "healthy") {
      const diag = dumpContainerLogs(container, deps);
      await abort(
        new Error(
          `preview refresh for "${slug}" did not reach healthy (terminal state: ${result.state}` +
            (result.status ? `, http ${result.status}` : "") + `). ` +
            `The durable volume ${volumeName} was preserved; the failed new image ${newTag} was removed. ` +
            `This is a real failure, not a false success.\n--- container logs (tail) ---\n${diag.slice(-4000)}`,
        ),
      );
    }
  } catch (err) {
    if (/did not reach healthy/.test(String(err?.message))) throw err;
    await abort(err);
  }

  // Success: flip the claim to a ready row at the NEW sha/tag with old->new
  // history (AC3), then clean up the superseded OLD image — SHA-global-safe.
  await withRegistryLock(deps.registryPath, () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const cur = getPreview(reg, slug);
    if (!cur) throw new Error(`preview "${slug}" vanished from the registry mid-refresh.`);
    // Restore the pre-claim sha into `cur` so refreshPreviewSlot appends a
    // correct old->new history entry (the claim had flipped state, not sha).
    const base = { ...cur, sha: oldSha, imageTag: oldTag, provenance: previewProvenance(oldSha) };
    const next = cloneRegistry(reg);
    next.previews[slug] = refreshPreviewSlot(base, { ref, sha: newSha, hostPort, state: "ready", now: () => new Date().toISOString() });
    writeRegistry(deps.registryPath, next);
  });
  if (oldTag !== newTag) {
    await removeImageIfUnreferenced(oldTag, { registryPath: deps.registryPath, keepSlug: slug, deps });
    deps.log(`  cleaned up superseded image ${oldTag} (${oldSha}) now that ${newTag} is healthy.`);
  }
  deps.log(`preview "${slug}" refreshed and healthy: ${newTag} (sha ${newSha}) on http://localhost:${hostPort}`);
  return { slug, sha: newSha, tag: newTag, previousSha: oldSha, hostPort, state: "healthy" };
}

/**
 * `cinatra instance preview status` / `list` (AC3): surface the resolved SHA,
 * built image tag, durable volume, provenance, and state per preview.
 */
export function runPreviewStatus(rest, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const read = readRegistry(deps.registryPath);
  // Surface corruption LOUDLY rather than silently reporting "no previews" — a
  // malformed registry is a real state a read should not conceal (it is left in
  // place for repair, never auto-reset).
  if (read.status === "malformed") {
    (deps.logError ?? deps.log)(
      `Preview registry at ${deps.registryPath} is MALFORMED and cannot be read. ` +
        `Inspect/repair it by hand (or delete it only if you are sure no previews exist).`,
    );
    return { malformed: true, rows: [] };
  }
  const registry = read.registry ?? emptyRegistry();
  const wantSlug = readOption(rest, "--slug") ?? (rest.includes("--all") ? null : deriveSlug({ rest, checkoutDir }));
  const rows = listPreviews(registry).filter((r) => (wantSlug ? r.slug === wantSlug : true));
  if (rows.length === 0) {
    deps.log(wantSlug ? `No preview registered for slug "${wantSlug}".` : "No previews registered.");
    return rows;
  }
  for (const r of rows) {
    deps.log(
      `preview ${r.slug}: state=${r.state} sha=${r.sha} tag=${r.imageTag} ` +
        `provenance=${r.provenance} volume=${r.volumeName} port=${r.hostPort ?? "-"} ref=${r.ref}`,
    );
    if (Array.isArray(r.history) && r.history.length > 1) {
      deps.log(`  history: ${r.history.map((h) => h.sha.slice(0, 12)).join(" -> ")}`);
    }
  }
  return rows;
}

export function runPreviewList(rest, injected = {}) {
  return runPreviewStatus([...rest, "--all"], injected);
}

// --- test surface ----------------------------------------------------------

export const __test = {
  // constants
  PREVIEW_IMAGE_TAG_PREFIX,
  PREVIEW_CONTAINER_PREFIX,
  PREVIEW_VOLUME_PREFIX,
  PROVENANCE_PREFIX,
  PREVIEW_RUNTIME_MODE,
  EXTENSION_DATA_ROOT_IN_CONTAINER,
  EXTENSION_DATA_ROOT_ENV,
  ENCRYPTION_KEY_ENV,
  ENCRYPTION_KEY_HEX_LEN,
  MATERIALIZE_DISABLE_ENV,
  FORBIDDEN_PRODUCTION_IMAGE_NAMES,
  PASSTHROUGH_ENV_KEYS,
  PREVIEW_HOST_PORT_MIN,
  PREVIEW_HOST_PORT_MAX,
  // pure helpers
  isValidSlug,
  isImmutableSha,
  previewImageTag,
  previewProvenance,
  previewContainerName,
  previewVolumeName,
  assertNotProductionImageTag,
  assertMaterializeNotDisabled,
  assertEncryptionKey,
  assertPreviewCheckoutAllowed,
  normalizeMode,
  readCheckoutEnvMode,
  buildPreviewRunEnvArgs,
  classifyHealthResponse,
  pollHealthGate,
  usedPreviewHostPorts,
  allocatePreviewHostPort,
  validatePreviewPort,
  // registry
  defaultRegistryPath,
  readRegistry,
  requireUsableRegistry,
  writeRegistry,
  withRegistryLock,
  getPreview,
  listPreviews,
  makePreviewSlot,
  refreshPreviewSlot,
  // docker steps
  buildPreviewImage,
  bootPreviewContainer,
  dockerObjectExists,
  containerRunning,
  removeContainer,
  removeImage,
  removeImageIfUnreferenced,
  dumpContainerLogs,
  deriveSlug,
  // orchestration
  runPreviewCreate,
  runPreviewRefresh,
  runPreviewStatus,
  runPreviewList,
  defaultDeps,
};
