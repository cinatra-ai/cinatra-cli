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
// instances — preview is NOT a runtime `install --mode` value and does NOT reuse
// `install --mode prod` (which provisions infra/DB only and never builds/boots
// an image).
//
// cinatra-cli#188 adds `install --mode preview` as a documented FRONT DOOR over
// this module: a COMPOSITION (dev install, then `runPreviewCreate` with that
// instance's configuration) living in `install-preview.mjs`. It is a caller, not
// a fork — this registry, the slug rules, the 3400–3499 host-port pool, the
// image tagging and every invariant below are reused UNCHANGED, and the surface
// mode resolves to underlying `dev` before any install site sees it, so no
// front-door path can write a production `.env.local` into the checkout.
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

// cinatra-cli#219 — the endpoint-ownership proof. Node-builtins-only and
// dependency-free in the other direction (it never imports this module), so
// there is no cycle and the light CLI core stays importable.
import { assertEndpointOwnership, resolveEndpointOwnershipMode } from "./preview-endpoint-ownership.mjs";

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
//
// cinatra-cli#194 — the build budget is a DEFAULT with an operator LEVER, not a
// fixed ceiling. The original fixed 30m could not fit a COLD build: the `next
// build` compile ALONE measured 31.6 minutes on a 24GB M4 Pro during #188's
// end-to-end proof, and it is one step among many in the checkout's multi-stage
// Dockerfile (two `pnpm install --frozen-lockfile` passes, a network
// `extensions acquire-prod`, the required-OAS seed, presence-aware manifest
// regen, bundled-digest recording, four esbuild bundles, `next build`,
// standalone assembly, then ~15 runtime-stage copies). So a first-ever preview
// on a machine with no layer cache was a GUARANTEED cancel with no lever.
//
// The default is therefore raised to 90m — evidence-INFORMED, not measured
// end-to-end: 31.6m is the one stage that was timed, and the rest of the cold
// build plus a slower or loaded host is the headroom. Because no single default
// can be right for every host, `CINATRA_PREVIEW_BUILD_TIMEOUT_MS` overrides it.
//
// The override is BOUNDED, deliberately (#194 AC3 — "the timeout still bounds a
// genuinely hung build"): it is validated to an integer in
// [PREVIEW_BUILD_TIMEOUT_MIN_MS, PREVIEW_BUILD_TIMEOUT_MAX_MS] and anything else
// — a non-integer, 0, a negative, `Infinity`, `never` — is a HARD, actionable
// error, never a silent fallback and never a silent clamp. There is no value
// that turns the bound OFF, so the hung-build ceiling survives the lever.
export const PREVIEW_BUILD_TIMEOUT_DEFAULT_MS = 5_400_000; // 90m — cold multi-stage build default
export const PREVIEW_BUILD_TIMEOUT_ENV = "CINATRA_PREVIEW_BUILD_TIMEOUT_MS";
// 1s floor: low enough that the lever itself is provable against a REAL build
// (an artificially low override must actually cancel one), which is how #194's
// acceptance is demonstrated without burning a full cold build.
export const PREVIEW_BUILD_TIMEOUT_MIN_MS = 1_000; // 1s
export const PREVIEW_BUILD_TIMEOUT_MAX_MS = 21_600_000; // 6h — the bound the lever can never remove
// cinatra-cli#210 — the image build had exactly ONE lever (the timeout above),
// and a build that dies out of memory is a MEMORY failure, not a time failure:
// raising the budget cannot fix it, it only lets the build die slower. So the
// build gets a second lever: the V8 old-space limit the `next build` node
// process runs under, in whole MEGABYTES, assembled into the `NODE_OPTIONS`
// build-arg (`--max-old-space-size=<MB>`).
//
// BE PRECISE ABOUT WHAT THIS IS, because over-selling it would send an operator
// down the wrong path (#210 review). `--max-old-space-size` bounds V8's OLD
// SPACE. It is NOT a total build-memory ceiling, it does NOT bound Turbopack's
// native (Rust) allocator, and it does NOT control build concurrency. It is
// decisive for a "JavaScript heap out of memory" failure. For a NATIVE
// "cannot allocate memory" — which is what #210's reporter measured, and which
// survived 4 GB → 14 GB of VM RAM — lowering this can only help to the extent
// that V8 would otherwise have consumed memory the native allocator needed; it
// reserves nothing for Turbopack and is not a demonstrated remedy for that wall.
// #210's native leg needs a concurrency / bundler-fallback knob that lives in
// the checkout, not here.
//
// WHY MB and not a raw NODE_OPTIONS string: a raw passthrough cannot be
// validated (a typo could silently disable the ceiling or inject an unrelated
// flag), and this lever exists to make ONE number controllable. A whole-MB
// integer is bounded and fail-closed exactly like the timeout.
//
// UNSET MEANS UNSET (#210 review, finding 1): with no override the CLI passes NO
// NODE_OPTIONS build-arg at all, so the resolved SHA's own Dockerfile keeps
// ownership of its default. A preview builds an ARBITRARY SHA — pinning the
// CLI's idea of a good ceiling onto it would silently override a checkout that
// deliberately chose a different one, and would drift the moment the checkout's
// value changed. The lever changes what is CONTROLLABLE, never what an untuned
// build does.
export const PREVIEW_BUILD_MEMORY_ENV = "CINATRA_PREVIEW_BUILD_MEMORY_MB";
// Documentation only — the value cinatra's Dockerfile bakes in today, quoted in
// help/error text so an operator knows what they are moving away FROM. The CLI
// never asserts it; see "UNSET MEANS UNSET" above.
export const PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB = 4096;
// 256 MB floor: below this no realistic `next build` starts, so a lower value is
// a configuration mistake, not a tuning choice. 65536 ceiling: 64 GB is past any
// dev host this lifecycle targets, and a finite max keeps a typo (a stray extra
// digit) from silently asking for an unsatisfiable heap.
export const PREVIEW_BUILD_MEMORY_MIN_MB = 256;
export const PREVIEW_BUILD_MEMORY_MAX_MB = 65_536;

// cinatra-cli#210 leg 2 — the in-build `tsc`. The checkout Dockerfile declares
// `ARG CI=` and passes it into the build RUN; `next.config` skips the redundant
// in-build typecheck when it is truthy, which is what the CI image build does.
// A local preview build got NO `--build-arg CI=...`, so it always ran the heavier
// tsc + Turbopack path — the cost #210 asks to remove.
//
// Preview forwards `CI=true` by DEFAULT, deliberately: a preview image is the
// LOCAL equivalent of the CI-built production image, and matching how that image
// is built is the point of the lifecycle. But be honest about the trade the
// checkout's own comment names — it keeps `CI` empty precisely so an ad-hoc
// build retains the typecheck as a safety net. A preview can be pointed at ANY
// resolved SHA, including a work-in-progress commit no required typecheck job
// has ever seen, and for that SHA skipping the in-build tsc removes a real
// check. `CINATRA_PREVIEW_BUILD_TYPECHECK` puts it back. Note also that `CI` is
// a GENERIC signal: the checkout and its dependencies may key other behaviour
// off it, so this switch is broader than "typecheck on/off" by nature.
export const PREVIEW_BUILD_TYPECHECK_ENV = "CINATRA_PREVIEW_BUILD_TYPECHECK";
// The build-arg NAMES the Dockerfile must declare for either lever to bite.
export const PREVIEW_BUILD_MEMORY_ARG = "NODE_OPTIONS";
export const PREVIEW_BUILD_CI_ARG = "CI";

export const PREVIEW_HEALTH_TIMEOUT_MS = 180_000; // 3m health-gate budget (mirrors prod-boot-e2e default)
export const PREVIEW_HEALTH_POLL_INTERVAL_MS = 3_000; // 3s (mirrors prod-boot-e2e sleep 3)
export const DOCKER_CLI_PROBE_TIMEOUT_MS = 15_000; // 15s fast docker-CLI metadata probes
// `docker stop`/`start` are not metadata probes: stop sends SIGTERM and waits
// out the container's own grace period (10s by default) before SIGKILL, so the
// metadata budget would abort a perfectly normal shutdown (cinatra-cli#220).
export const PREVIEW_STOP_TIMEOUT_MS = 60_000;
// Where an existing container is PARKED while a re-materialization is health-
// gated, so a failure can put it back instead of leaving nothing running
// (cinatra-cli#220 AC6).
//
// The DOT is load-bearing: a slug is `[a-z0-9][a-z0-9-]*` (`isValidSlug`), so no
// valid slug can contain one and `cinatra-preview-<slug>.superseded` can never
// collide with the canonical container of some OTHER preview. A `-` suffix could:
// `foo--superseded` is itself a valid slug, and parking `foo` would then target a
// real preview's container. Docker accepts `.` in a container name.
export const SUPERSEDED_CONTAINER_SUFFIX = ".superseded";

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
  // cinatra-cli#219: the connection service's ADDRESS and its CREDENTIAL. Only
  // `NANGO_ENCRYPTION_KEY` used to be forwarded, so a preview container could
  // neither reach nor authenticate to Nango: saving a provider key reported
  // partial success (the key validates directly against the provider, then the
  // connection-service copy fails and the remote state cannot be confirmed) and
  // connector flows were non-functional regardless of whether Nango ran.
  //
  // They are forwarded TOGETHER — an address without the credential still
  // cannot authenticate — and, being a locally-managed endpoint, the address is
  // subject to the SAME rewrite + ownership verification as every other
  // container-dialed key. cinatra-cli#214 made the INSTALL adopt the
  // nango-seeded secret key so connector saves stop 401'ing on the host; that
  // fix lives in the instance env and only reaches a container through here.
  "NANGO_SERVER_URL",
  "NANGO_SECRET_KEY",
  "OPENAI_API_KEY",
  "CINATRA_BRIDGE_TOKEN",
  // cinatra-cli#190: the agent-registry (Verdaccio) client URLs. Without them
  // the container falls back to the HOSTED default
  // (`https://registry.cinatra.ai`, `packages/registries` `loadVerdaccioConfig`)
  // for which it holds no credentials, so every marketplace/extension install
  // inside a preview fails 401 and the vendor-application reconcile sweep
  // reports its marketplace bearer unavailable. `install.mjs` already treats
  // exactly these two keys as isolation-critical (`ISOLATED_INFRA_ENV_KEYS`,
  // cinatra-cli#36): a WRONG value aborts an isolated install, so shipping NO
  // value — and landing on the public hosted registry — is the same
  // mis-routing. When neither is set on the host, nothing is forwarded and the
  // hosted default still applies (#190 AC6).
  "CINATRA_AGENT_REGISTRY_URL",
  "CINATRA_AGENT_REGISTRY_UI_URL",
];

// The container-side name for "the operator's host" (cinatra-cli#190). Docker
// Desktop resolves `host.docker.internal` natively; `bootPreviewContainer` also
// maps it explicitly via `--add-host …:host-gateway` so a Linux engine (Docker
// >= 20.10) resolves the same name. This mirrors the host-loopback treatment
// `rewriteConnectionStringForDocker` (`src/index.mjs`) already applies before
// handing a host connection string to a container.
export const CONTAINER_HOST_GATEWAY = "host.docker.internal";

// Hostnames that mean "the machine I am running on". On the HOST they address
// host services; INSIDE the container they address the container itself, so a
// forwarded value carrying one of these is not merely wrong, it is silently
// wrong — it trades the 401 for a connection refused.
const HOST_LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);

// The forwarded keys whose value is an endpoint the CONTAINER ITSELF dials on
// the operator's host, and which therefore needs the host-loopback rewrite.
//
// Deliberately NARROW — a forwarded value is rewritten only when the CONTAINER
// is the thing that resolves it:
//   - CINATRA_AGENT_REGISTRY_URL is the registry the server-side install/publish
//     path fetches from (`packages/registries` verdaccio client), so it IS
//     rewritten.
//   - CINATRA_AGENT_REGISTRY_UI_URL is NOT. In the app it feeds only the
//     `uiUrl` → `registryUiUrl` display field on package summaries; nothing
//     fetches it. It is resolved by the operator's BROWSER, where a
//     container-only name does not resolve — so it is forwarded VERBATIM
//     (still fixing the "falls back to the hosted registry" half of #190).
//   - `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` / `NEXT_PUBLIC_SITE_URL` are
//     browser-resolved for the same reason and are likewise never rewritten.
// This is the split cinatra-cli#188 AC5 draws between host-infra endpoints and
// app/auth URLs; the DB/Redis endpoints named there are the other members of
// the container-dialed class and join this list through the SAME helper rather
// than a second rewrite.
export const CONTAINER_REWRITE_ENV_KEYS = [
  "CINATRA_AGENT_REGISTRY_URL",
  // cinatra-cli#188 AC5: the other members of the container-dialed class. A dev
  // install seeds `.env.local` with host-loopback Postgres/Redis endpoints
  // (`127.0.0.1:<port>`), and `install --mode preview` forwards that instance's
  // configuration into the container — where those addresses resolve to the
  // CONTAINER. They join the list above rather than getting a second rewrite, so
  // there is exactly one mechanism (and one `--add-host` mapping) for all of it.
  "SUPABASE_DB_URL",
  "REDIS_URL",
  // cinatra-cli#219: the connection service the SERVER-side connector save
  // dials. `NANGO_SECRET_KEY` is its credential, not an address, so it is
  // forwarded verbatim and never rewritten.
  "NANGO_SERVER_URL",
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

// --- host-loopback → container-reachable rewrite (cinatra-cli#190) ---------

/**
 * True for a hostname that resolves to the local machine: `localhost`, the IPv6
 * loopback, or any address in the IPv4 loopback block 127.0.0.0/8. Octets are
 * range-checked because a NON-SPECIAL scheme (`postgresql:`, `redis:`) keeps an
 * opaque host, so `127.999.999.999` reaches here without the URL parser having
 * rejected it — and that is not a loopback address.
 */
function isHostLoopbackHostname(hostname) {
  const h = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (HOST_LOOPBACK_HOSTNAMES.has(h)) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Rewrite a host-loopback URL to one the preview CONTAINER can reach.
 *
 * The single rewrite mechanism for this file: `install --mode dev` seeds
 * `.env.local` with host-loopback endpoints (an isolated install writes
 * `CINATRA_AGENT_REGISTRY_URL=http://127.0.0.1:<verdaccio>`, `install.mjs`
 * cinatra-cli#36), and the preview container is bridged (`docker run -p`), so
 * forwarding such a value verbatim points the container at itself.
 *
 * Only the HOST changes. The rewrite goes through the URL parser rather than
 * splicing the raw string, so odd-but-accepted spellings (`http:////host`,
 * backslash forms) are normalised instead of corrupted; the one normalisation
 * that would visibly alter an operator's value — the root path `new URL()`
 * appends to an origin-only URL — is undone so `http://127.0.0.1:4873` stays
 * `http://<gateway>:4873`.
 *
 * Non-loopback hosts and values that are not URLs are returned UNCHANGED — the
 * rewrite never guesses. It is also idempotent: a value already pointing at the
 * gateway host parses to a non-loopback hostname and is left alone.
 *
 * @param {string} value
 * @param {string} [gatewayHost]
 * @returns {string}
 */
export function rewriteLoopbackUrlForContainer(value, gatewayHost = CONTAINER_HOST_GATEWAY) {
  if (typeof value !== "string" || value.length === 0) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value; // not a URL — leave it exactly as the operator set it
  }
  if (!isHostLoopbackHostname(parsed.hostname)) return value;
  parsed.hostname = gatewayHost;
  const rewritten = parsed.toString();
  if (
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    rewritten.endsWith("/") &&
    !value.endsWith("/")
  ) {
    return rewritten.slice(0, -1);
  }
  return rewritten;
}

/**
 * The container-dialed endpoints this composition would REWRITE — the exact set
 * cinatra-cli#219's ownership verification applies to.
 *
 * A key qualifies only when BOTH hold: it is container-dialed
 * (`CONTAINER_REWRITE_ENV_KEYS` — the rewrite is what makes it a host-gateway
 * address) AND its value is a host-LOOPBACK URL, i.e. an endpoint this project
 * is supposed to own. An external or hosted endpoint (a managed database, the
 * hosted registry) parses to a non-loopback host, is never rewritten, and is
 * therefore never verified — it legitimately belongs to no Compose project
 * (#219 AC4).
 *
 * Returns `{ key, value }` pairs. The values are credential-bearing; the caller
 * uses them only to derive a port.
 */
export function containerDialedLoopbackEndpoints(env = {}) {
  const entries = [];
  for (const key of CONTAINER_REWRITE_ENV_KEYS) {
    const value = env?.[key];
    if (typeof value !== "string" || value.length === 0) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      continue; // not a URL — the rewrite leaves it alone, so nothing to verify
    }
    if (!isHostLoopbackHostname(parsed.hostname)) continue;
    entries.push({ key, value });
  }
  return entries;
}

/**
 * cinatra-cli#219 — the ownership gate as ONE call site for both orchestrations.
 *
 * Runs on the RESOLVED runtime env (the values the container will really boot
 * with), and is invoked in `create`/`refresh` BEFORE the image build and — in
 * refresh — before the healthy old container is replaced, so a refusal costs
 * nothing and never destroys a working preview.
 */
function assertContainerDialedEndpointsOwned({ env, checkoutDir, deps }) {
  const entries = containerDialedLoopbackEndpoints(env);
  if (entries.length === 0) return null;
  return assertEndpointOwnership({
    entries,
    checkoutDir,
    deps,
    env: deps.ownershipControlEnv ?? deps.env ?? process.env,
    gatewayHost: CONTAINER_HOST_GATEWAY,
  });
}

// --- runtime env for `docker run` (AC2 + the NEVERs) -----------------------

/**
 * Build the `-e KEY=VALUE` docker-run env args for a preview container.
 *
 *  - ALWAYS sets CINATRA_RUNTIME_MODE=production (AC2).
 *  - ALWAYS sets CINATRA_EXTENSION_DATA_ROOT to the durable-volume mount path (AC4).
 *  - Requires + forwards CINATRA_ENCRYPTION_KEY (AC6, validated by caller).
 *  - Forwards the known DB/auth/redis/registry passthrough keys when present in `env`.
 *  - Rewrites the host-loopback endpoints the CONTAINER dials
 *    (CONTAINER_REWRITE_ENV_KEYS) to the container-reachable gateway host
 *    (cinatra-cli#190) — forwarding `127.0.0.1:<port>` verbatim would only trade
 *    a 401 for a connection refused.
 *  - NEVER forwards CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE (AC7-iii): it
 *    is not in PASSTHROUGH_ENV_KEYS and is asserted-absent before boot.
 *
 * Returns a flat argv fragment: ["-e", "K=V", "-e", "K2=V2", ...].
 *
 * @param {{ encryptionKey: string, env?: Record<string,string> }} args
 */
export function buildPreviewRunEnvArgs({ encryptionKey, env = process.env }) {
  assertMaterializeNotDisabled(env);
  const rewriteKeys = new Set(CONTAINER_REWRITE_ENV_KEYS);
  const pairs = [];
  pairs.push([ "CINATRA_RUNTIME_MODE", PREVIEW_RUNTIME_MODE ]);
  pairs.push([ EXTENSION_DATA_ROOT_ENV, EXTENSION_DATA_ROOT_IN_CONTAINER ]);
  pairs.push([ ENCRYPTION_KEY_ENV, encryptionKey ]);
  pairs.push([ "HOSTNAME", "0.0.0.0" ]);
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      pairs.push([ key, rewriteKeys.has(key) ? rewriteLoopbackUrlForContainer(value) : value ]);
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

/** Render a millisecond budget as a human duration for logs/errors ("90m", "1s"). */
export function formatBuildBudget(ms) {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Resolve the docker-build budget: `CINATRA_PREVIEW_BUILD_TIMEOUT_MS` when the
 * operator set it, else `PREVIEW_BUILD_TIMEOUT_DEFAULT_MS` (cinatra-cli#194).
 *
 * FAIL-CLOSED on a bad value. A malformed or out-of-range override THROWS with
 * the variable name, the offending value and the accepted range — it is never
 * silently ignored (which would strand the operator back on the default that
 * cancelled their build and look like the lever does not work) and never
 * silently clamped (which would conceal a configuration mistake). An absent or
 * ALL-WHITESPACE value means "not set" and takes the default; every other
 * non-integer input — `0`, a negative, `1.5`, `90m`, `Infinity`, `never` — is
 * rejected.
 *
 * The accepted band is what keeps #194 AC3 true: the maximum is finite, so no
 * override can disable the bound on a genuinely hung build.
 */
export function resolveBuildTimeoutMs(env = {}) {
  const raw = env?.[PREVIEW_BUILD_TIMEOUT_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return PREVIEW_BUILD_TIMEOUT_DEFAULT_MS;
  const value = raw.trim();
  const reject = (why) => {
    throw new Error(
      `${PREVIEW_BUILD_TIMEOUT_ENV}=${JSON.stringify(raw)} is invalid — ${why}. ` +
        `Set it to a whole number of MILLISECONDS between ${PREVIEW_BUILD_TIMEOUT_MIN_MS} ` +
        `(${formatBuildBudget(PREVIEW_BUILD_TIMEOUT_MIN_MS)}) and ${PREVIEW_BUILD_TIMEOUT_MAX_MS} ` +
        `(${formatBuildBudget(PREVIEW_BUILD_TIMEOUT_MAX_MS)}), or unset it to use the default ` +
        `${PREVIEW_BUILD_TIMEOUT_DEFAULT_MS} (${formatBuildBudget(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS)}). ` +
        `The build timeout is always bounded — there is no value that disables it.`,
    );
  };
  // Digits only: rules out "1.5", "1e6", "90m", "0x10", "+5", "-1", "Infinity",
  // "never" in one predicate, so the parse below cannot silently truncate.
  if (!/^\d+$/.test(value)) reject("it is not a whole number of milliseconds");
  const ms = Number(value);
  if (!Number.isSafeInteger(ms)) reject("it is not a representable whole number");
  if (ms < PREVIEW_BUILD_TIMEOUT_MIN_MS) reject(`it is below the ${PREVIEW_BUILD_TIMEOUT_MIN_MS}ms minimum`);
  if (ms > PREVIEW_BUILD_TIMEOUT_MAX_MS) reject(`it exceeds the ${PREVIEW_BUILD_TIMEOUT_MAX_MS}ms maximum`);
  return ms;
}

/**
 * Resolve the `next build` V8 old-space limit in whole MEGABYTES:
 * `CINATRA_PREVIEW_BUILD_MEMORY_MB` when the operator set it, else `null` —
 * meaning "not set", i.e. leave the resolved SHA's own Dockerfile default alone
 * (cinatra-cli#210).
 *
 * FAIL-CLOSED on a bad value, for the same reason `resolveBuildTimeoutMs` is: an
 * operator reaching for this lever is already fighting an OOM, so silently
 * ignoring their value would strand them on the setting that just failed and
 * look like the lever does not work, and silently clamping would conceal the
 * mistake. An absent or ALL-WHITESPACE value means "not set"; every other
 * non-integer input — `0`, a negative, `4.5`, `4g`, `4096MB`, `Infinity` — is a
 * hard, actionable error.
 */
export function resolveBuildMemoryMb(env = {}) {
  const raw = env?.[PREVIEW_BUILD_MEMORY_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = raw.trim();
  const reject = (why) => {
    throw new Error(
      `${PREVIEW_BUILD_MEMORY_ENV}=${JSON.stringify(raw)} is invalid — ${why}. ` +
        `Set it to a whole number of MEGABYTES between ${PREVIEW_BUILD_MEMORY_MIN_MB} and ` +
        `${PREVIEW_BUILD_MEMORY_MAX_MB}, or unset it to leave the checkout's own Dockerfile ceiling ` +
        `in place (cinatra's bakes in ${PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB}). ` +
        `It becomes --max-old-space-size=<MB> for the image build's node process; the unit is MB only ` +
        `(no "g"/"MB" suffix).`,
    );
  };
  // Digits only, mirroring the timeout lever: rules out "4.5", "4e3", "4g",
  // "4096MB", "0x1000", "+4096", "-1", "Infinity" in one predicate.
  if (!/^\d+$/.test(value)) reject("it is not a whole number of megabytes");
  const mb = Number(value);
  if (!Number.isSafeInteger(mb)) reject("it is not a representable whole number");
  if (mb < PREVIEW_BUILD_MEMORY_MIN_MB) reject(`it is below the ${PREVIEW_BUILD_MEMORY_MIN_MB} MB minimum`);
  if (mb > PREVIEW_BUILD_MEMORY_MAX_MB) reject(`it exceeds the ${PREVIEW_BUILD_MEMORY_MAX_MB} MB maximum`);
  return mb;
}

/**
 * Resolve whether the image build runs the checkout's redundant IN-BUILD `tsc`
 * (cinatra-cli#210 leg 2). Default FALSE — preview forwards `CI=true`, which is
 * what the CI image build does and what the Dockerfile's `ARG CI=` exists for.
 *
 * Fail-closed on anything that is not one of the documented boolean spellings:
 * a preview operator who writes `CINATRA_PREVIEW_BUILD_TYPECHECK=yes-please` must
 * not be silently given the opposite of what they asked for.
 */
export function resolveBuildTypecheck(env = {}) {
  const raw = env?.[PREVIEW_BUILD_TYPECHECK_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(
    `${PREVIEW_BUILD_TYPECHECK_ENV}=${JSON.stringify(raw)} is invalid — it is not a boolean. ` +
      `Use 1/true/yes/on to run the checkout's in-build tsc during the preview image build, ` +
      `or 0/false/no/off (or unset) to skip it the way the CI image build does.`,
  );
}

/**
 * Assemble the `--build-arg` pairs the preview image build passes to
 * `docker build` (cinatra-cli#210). This is the single env-assembly seam: both
 * levers are resolved here, from the OPERATOR's environment, and nowhere else.
 *
 * Returns `{ args, memoryMb, typecheck }` — `args` is the flat argv fragment,
 * `memoryMb` is `null` when the operator set no ceiling, and the rest is what
 * the caller logs.
 *
 * `CI` is always passed EXPLICITLY, including in the typecheck-on case where it
 * is passed empty. Passing `CI=` empty is not the same as omitting it: it pins
 * the build to the Dockerfile's documented "no CI" behaviour instead of leaving
 * it to whatever that SHA's ARG default happens to be. `NODE_OPTIONS` is the
 * opposite by design: it is passed ONLY on an explicit override, so an untuned
 * preview never overrides the resolved SHA's own ceiling.
 */
export function buildPreviewBuildArgs(env = {}) {
  const memoryMb = resolveBuildMemoryMb(env);
  const typecheck = resolveBuildTypecheck(env);
  const args = ["--build-arg", `${PREVIEW_BUILD_CI_ARG}=${typecheck ? "" : "true"}`];
  if (memoryMb !== null) {
    args.push("--build-arg", `${PREVIEW_BUILD_MEMORY_ARG}=--max-old-space-size=${memoryMb}`);
  }
  return { memoryMb, typecheck, args };
}

/**
 * The build-arg names a build CONTEXT's Dockerfile mentions in an `ARG`
 * instruction, as a Set — a LEXICAL HINT, deliberately not a claim about
 * consumption.
 *
 * Why it exists: `docker build --build-arg X=...` against a Dockerfile that
 * never declares `ARG X` is only a WARNING ("one or more build-args were not
 * consumed") — the value is silently dropped. A preview builds a RESOLVED SHA,
 * so an operator can legitimately point it at an older commit whose Dockerfile
 * predates one of these ARGs, and the lever would then do nothing with no signal
 * the operator is likely to read. Scanning the context lets the build say so.
 *
 * KNOWN LIMITS (#210 review, finding 4) — this is why the caller only ever emits
 * a NOTE, never a refusal, and why a MISSING declaration is the only thing it
 * reports. A name found here may still be inert: an `ARG` before the first
 * `FROM` is global and must be REDECLARED inside a stage to be usable there, an
 * `ARG` in an unrelated stage does not apply to the build stage, and a name
 * inside a heredoc is not an instruction at all. Deciding those needs a real
 * Dockerfile parser with stage/use analysis. So: absence of a note is NOT proof
 * the value was consumed — docker's own unconsumed-build-arg warning remains the
 * authority. A note is the high-confidence direction (nothing named the ARG at
 * all), which is the case worth catching; it is still phrased as "very likely",
 * because an exotic `# escape=` directive changes what continues a line.
 *
 * Best-effort by construction: an unreadable or unusually-named Dockerfile
 * yields `null`, which the caller treats as "cannot tell" and stays quiet rather
 * than crying wolf. It never blocks a build — an old SHA must still be
 * previewable, just honestly.
 */
export function dockerfileDeclaredBuildArgs(contextDir) {
  try {
    const text = readFileSync(path.join(contextDir, "Dockerfile"), "utf8");
    // Join backslash line-continuations first: `ARG \\\n  NODE_OPTIONS=...` is one
    // instruction, and splitting on raw newlines would miss it.
    const joined = text.replace(/\\[ \t]*\r?\n/g, " ");
    const declared = new Set();
    // Dockerfile instructions are CASE-INSENSITIVE (`arg` is as valid as `ARG`).
    for (const line of joined.split("\n")) {
      const m = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(line);
      if (m) declared.add(m[1]);
    }
    return declared;
  } catch {
    return null;
  }
}

/**
 * Build the preview image at `tag` from `contextDir` using the checkout's OWN
 * multi-stage Dockerfile (the same one build-image.yml uses: acquire-prod +
 * OAS-seed + presence-aware manifest regen + `next build` standalone + runtime
 * copy). Bounded by `resolveBuildTimeoutMs`; fails loudly on error/timeout.
 * AC7-ii is enforced here: the tag can never be a published production name.
 *
 * The budget is read from `deps.buildControlEnv ?? process.env` — deliberately
 * NOT from `deps.env` (cinatra-cli#194). `deps.env` is the CONTAINER env
 * contract, and the `install --mode preview` front door replaces it with a fresh
 * object composed from the install's own `.env.local` precisely so ambient shell
 * state cannot leak into the container (#188 AC3). Reading the budget from there
 * would make the documented override silently inert on that front door — which
 * is one of the two entrypoints #194 names. The build budget is a property of
 * the operator's INVOCATION, not of the container, so it is read from the
 * operator's environment and is immune to any future env composition; the
 * injectable `buildControlEnv` seam keeps the unit suite hermetic.
 */
export function buildPreviewImage({ tag, contextDir, deps, provenance, sha }) {
  assertNotProductionImageTag(tag);
  const buildEnv = deps.buildControlEnv ?? process.env;
  const timeoutMs = resolveBuildTimeoutMs(buildEnv);
  const overridden = timeoutMs !== PREVIEW_BUILD_TIMEOUT_DEFAULT_MS;
  const build = buildPreviewBuildArgs(buildEnv);
  deps.log?.(
    `  building ${tag} — budget ${formatBuildBudget(timeoutMs)}` +
      (overridden
        ? ` (${PREVIEW_BUILD_TIMEOUT_ENV} override).`
        : `; a slower/cold host can raise it with ${PREVIEW_BUILD_TIMEOUT_ENV} ` +
          `(up to ${formatBuildBudget(PREVIEW_BUILD_TIMEOUT_MAX_MS)}).`),
  );
  // cinatra-cli#210: the memory ceiling and the in-build-tsc decision are part of
  // the build's identity, so they are ALWAYS logged — an operator reading a
  // failed build's output must be able to see what it actually ran with, and the
  // lever must be discoverable from a build that has not been tuned yet.
  deps.log?.(
    (build.memoryMb === null
      ? `  build memory: the checkout's own Dockerfile ceiling (cinatra's bakes in ` +
        `--max-old-space-size=${PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB}); override the V8 old-space limit ` +
        `with ${PREVIEW_BUILD_MEMORY_ENV} (${PREVIEW_BUILD_MEMORY_MIN_MB}..${PREVIEW_BUILD_MEMORY_MAX_MB} MB) ` +
        `if the build dies out of memory.`
      : `  build memory: --max-old-space-size=${build.memoryMb} (MB, ${PREVIEW_BUILD_MEMORY_ENV} override).`) +
      ` In-build tsc ${build.typecheck ? `ON (${PREVIEW_BUILD_TYPECHECK_ENV})` : `skipped (CI=true, as the CI image build does)`}.`,
  );
  // Warn — never block — when THIS SHA's Dockerfile does not declare an ARG a
  // lever is being passed for: docker drops an unconsumed --build-arg with only a
  // warning, so the lever would look set and do nothing. Only the args actually
  // being PASSED are checked (`NODE_OPTIONS` is passed only on an override), and
  // only a MISSING declaration is reported — see `dockerfileDeclaredBuildArgs`
  // for why the converse is not something this scan can honestly claim.
  const declared = dockerfileDeclaredBuildArgs(contextDir);
  if (declared) {
    const passed = [PREVIEW_BUILD_CI_ARG, ...(build.memoryMb === null ? [] : [PREVIEW_BUILD_MEMORY_ARG])];
    const inert = passed.filter((n) => !declared.has(n));
    if (inert.length > 0) {
      deps.log?.(
        `  NOTE: no ${inert.map((n) => `ARG ${n}`).join(" / ")} declaration found in the Dockerfile at this SHA — ` +
          `docker drops an unconsumed --build-arg with only a warning, so ` +
          `${inert.length === 1 ? "that value is" : "those values are"} very likely ignored by THIS build. ` +
          `Preview a SHA whose Dockerfile declares ${inert.length === 1 ? "it" : "them"}, or add ` +
          `${inert.map((n) => `\`ARG ${n}\``).join(" / ")} to the checkout's Dockerfile.`,
      );
    }
  }
  const args = ["build", "-t", tag, ...build.args];
  if (provenance) args.push("--label", `cinatra.preview.provenance=${provenance}`);
  if (sha) args.push("--label", `cinatra.preview.sha=${sha}`);
  args.push(contextDir);
  const r = deps.runDocker(args, {
    timeoutMs,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.timedOut || r.error || r.status !== 0) {
    throw new Error(
      `docker build of ${tag} failed` +
        (r.timedOut ? ` (timed out after ${formatBuildBudget(timeoutMs)})` : "") +
        (r.stderr ? `: ${r.stderr.trim()}` : ".") +
        ` The build runs the checkout's own multi-stage Dockerfile (acquire-prod, required-OAS seed, ` +
        `manifest regen, next build); fix the underlying error and retry.` +
        // cinatra-cli#210: an out-of-memory build is the one failure the timeout
        // lever CANNOT fix, so name the memory lever on every non-timeout
        // failure rather than leaving the operator to re-read the help.
        (r.timedOut
          ? ""
          : ` If it died out of memory, that is a MEMORY failure and a larger build budget cannot fix it. ` +
            `"JavaScript heap out of memory" is the V8 old-space limit — raise it with ` +
            `${PREVIEW_BUILD_MEMORY_ENV} (${PREVIEW_BUILD_MEMORY_MIN_MB}..${PREVIEW_BUILD_MEMORY_MAX_MB} MB; ` +
            `this build used ${
              build.memoryMb === null ? `the Dockerfile's own ceiling` : `--max-old-space-size=${build.memoryMb}`
            }). ` +
            `A NATIVE "cannot allocate memory" is NOT that limit, and an exit-code-137 kill only tells you ` +
            `something sent SIGKILL — neither identifies the cause, and ${PREVIEW_BUILD_MEMORY_ENV} does not ` +
            `bound native allocation. Check Docker/host memory pressure first; more VM RAM MAY help, but ` +
            `cinatra-cli#210 measured a native wall that survived 4 GB to 14 GB, and clearing that needs the ` +
            `checkout-side build-concurrency / bundler-fallback control that issue tracks.`) +
        (r.timedOut
          ? ` If the build was still ADVANCING, this is a budget problem, not a hang: re-run with a larger ` +
            `${PREVIEW_BUILD_TIMEOUT_ENV} (milliseconds, max ${PREVIEW_BUILD_TIMEOUT_MAX_MS} = ` +
            `${formatBuildBudget(PREVIEW_BUILD_TIMEOUT_MAX_MS)}). A retry reuses every layer that COMPLETED, ` +
            `so it restarts at the interrupted step rather than from scratch — but that step itself starts ` +
            `over, so if ONE step is longer than the budget, raising the budget is required, not just retrying.`
          : ""),
    );
  }
  return tag;
}

/**
 * "absent" only when docker SAID the volume does not exist; "present" when it
 * inspected successfully; "unknown" when the probe was not answered. Callers
 * that would DESTROY on absence must treat unknown as presence.
 */
export function volumeAbsence({ ref, deps }) {
  const r = deps.runDocker(["volume", "inspect", ref], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
  if (r.status === 0) return "present";
  const said = `${r.stderr ?? ""}`;
  if (!r.timedOut && !r.error && /no such volume/i.test(said)) return "absent";
  return "unknown";
}

/** True iff a docker object (container/image/volume) with `ref` exists for `kind`. */
export function dockerObjectExists({ kind, ref, deps }) {
  const sub = { container: "container", image: "image", volume: "volume" }[kind];
  if (!sub) throw new Error(`dockerObjectExists: unknown kind ${JSON.stringify(kind)}.`);
  const r = deps.runDocker([sub, "inspect", ref], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
  return r.status === 0;
}

/**
 * What is known about a preview image tag: "present" (and stamped for THIS sha),
 * "absent" (docker said so), "unknown" (the probe was not answered), or
 * "mismatch" (a tag of that name exists but was NOT built from this sha).
 *
 * The label check matters because a docker tag is MUTABLE: `cinatra-preview:
 * local-<sha>` existing is not by itself proof that it holds the artifact for
 * that sha. `buildPreviewImage` stamps `cinatra.preview.sha` on everything it
 * builds, so an image that cannot show that stamp is not one this lifecycle
 * built and is rebuilt rather than trusted — reusing it would replace a healthy
 * container with a stranger's image and only discover it at the health gate.
 *
 * "unknown" is kept distinct from "absent" for the same reason it is for
 * containers: a timed-out or erroring probe observed nothing (cinatra-cli#220).
 */
export function previewImagePresence({ tag, sha, deps }) {
  const r = deps.runDocker(["image", "inspect", "-f", "{{index .Config.Labels \"cinatra.preview.sha\"}}", tag], {
    timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS,
  });
  if (r.status === 0) {
    const stamped = (r.stdout ?? "").trim();
    if (!sha) return { state: "present", sha: stamped };
    return stamped === sha ? { state: "present", sha: stamped } : { state: "mismatch", sha: stamped };
  }
  const said = `${r.stderr ?? ""}`;
  if (!r.timedOut && !r.error && /no such (image|object)/i.test(said)) return { state: "absent" };
  return { state: "unknown" };
}

/**
 * The three states a preview's container can be in, as a fact about docker
 * rather than about the registry row (cinatra-cli#220 AC5): "running" (up and
 * serving), "stopped" (present, holds its durable volume + published port
 * mapping, currently down) and "absent" (nothing to start).
 *
 * `docker container inspect` succeeds for a STOPPED container, so presence and
 * liveness are two different questions and both are asked here.
 */
export function containerState(name, deps) {
  const r = deps.runDocker(["container", "inspect", "-f", "{{.State.Running}}", name], {
    timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS,
  });
  if (r.status === 0) return (r.stdout ?? "").trim() === "true" ? "running" : "stopped";
  // A NON-ZERO exit is not proof of absence. Docker says a missing container in
  // so many words ("No such object/container"); a probe that TIMED OUT or hit a
  // busy/erroring daemon says nothing at all — and this was observed for real:
  // right after an aborted image build the daemon was slow enough that the probe
  // timed out, and reporting "absent" then would have (a) told the operator their
  // running preview was gone and (b) let `start` re-materialize ON TOP of a live
  // container. An unobserved fact is "unknown", never a claim.
  const said = `${r.stderr ?? ""}`;
  if (!r.timedOut && !r.error && /no such (object|container|image)/i.test(said)) return "absent";
  return "unknown";
}

/**
 * cinatra-cli#220 AC1/AC2 — build the image ONLY when it is not already here.
 *
 * `cinatra-preview:local-<sha>` is content-addressed by construction: the tag
 * names the SHA it was built from, so an existing tag IS the artifact for that
 * SHA and rebuilding it produces the same thing at the cost of a full
 * multi-stage build. That cost is not merely time: on a memory-constrained host
 * the build can be IMPOSSIBLE (cinatra-cli#210), and making a build a hard
 * dependency of a configuration change means a host that cannot build cannot
 * reconfigure.
 *
 * The mechanism this needs already existed — `dockerObjectExists` supports
 * image inspection and was only ever called for a volume. This is its caller.
 *
 * `rebuild` (the `--rebuild` / `--force-build` escape hatch) forces the build
 * back on, for a deliberately dirty rebuild of a tag whose SHA is unchanged.
 *
 * @returns {{ built: boolean, tag: string }}
 */
export function ensurePreviewImage({ tag, sha, checkoutDir, rebuild = false, provenance, deps }) {
  if (!rebuild) {
    const present = previewImagePresence({ tag, sha, deps });
    if (present.state === "present") {
      deps.log?.(
        `  reusing the image already present for this SHA: ${tag} — no docker build ` +
          `(pass --rebuild to force one).`,
      );
      return { built: false, tag };
    }
    // Anything short of a POSITIVE identification builds. Say which it was, so a
    // build nobody asked for is never a mystery — on a host where the build is
    // the expensive/impossible step, that reason is the whole story.
    if (present.state === "mismatch") {
      deps.log?.(
        `  the image tagged ${tag} was NOT built from this SHA ` +
          `(cinatra.preview.sha=${present.sha || "<unstamped>"}), so it is rebuilt rather than trusted.`,
      );
    } else if (present.state === "unknown") {
      deps.log?.(
        `  could not read whether ${tag} is present (docker did not answer the probe) — ` +
          `building rather than assuming either way.`,
      );
    }
  }
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
  return { built: true, tag };
}

/**
 * True iff a container is actually RUNNING (not merely present). `docker
 * container inspect <name>` succeeds even for a STOPPED/exited container, so a
 * bare existence check would misclassify a crash as a timeout. Mirrors
 * prod-boot-e2e's `docker inspect -f '{{.State.Running}}'` liveness signal.
 */
export function containerRunning(name, deps) {
  // A liveness probe that cannot be answered must NOT read as "crashed": the
  // health gate treats a false here as TERMINAL and tears the boot down, so a
  // momentarily unresponsive daemon would kill a perfectly healthy container.
  // "unknown" keeps polling; the gate's bounded budget still fails loudly
  // (cinatra-cli#220 — observed on a host whose daemon was saturated by a build).
  const state = containerState(name, deps);
  return state === "running" || state === "unknown";
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
 * Derive the FINAL container env once the preview's host port is known.
 *
 * The app's own base URLs (`NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` / …) can
 * only be correct after the host port is CLAIMED, and the claim happens under
 * the registry lock. A caller that pre-allocated a port outside the lock and
 * baked it into `deps.env` would race a concurrent create for the same port, so
 * callers that need port-dependent env supply `deps.composeRuntimeEnv` instead
 * and it is invoked HERE, against the port this operation actually claimed.
 *
 * Absent the hook the ambient/injected env is used unchanged, so every existing
 * caller is byte-identical. The materialize invariant is re-asserted on the
 * RESULT — a hook can never introduce the bypass flag.
 */
function resolveRuntimeEnv({ deps, env, hostPort }) {
  const composed =
    typeof deps.composeRuntimeEnv === "function" ? deps.composeRuntimeEnv({ hostPort, env }) : env;
  if (!composed || typeof composed !== "object") {
    throw new Error("preview: composeRuntimeEnv must return an environment object.");
  }
  assertMaterializeNotDisabled(composed);
  return composed;
}

/**
 * Boot a preview container: `docker run -d` the built local image with
 * production runtime env (AC2), the durable named volume mounted at the
 * extension-data root (AC4), and the host port published. NEVER a host `next
 * start` (AC7-i): the ONLY boot path is docker run of the built image.
 *
 * The run also maps CONTAINER_HOST_GATEWAY to the host gateway
 * (cinatra-cli#190) so the rewritten host-loopback endpoints in the boot env
 * resolve on a Linux engine too (Docker Desktop already provides the name).
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
    "--add-host", `${CONTAINER_HOST_GATEWAY}:host-gateway`,
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

/** True iff any of `flags` appears as a bare switch in `rest`. */
export function readFlag(rest, ...flags) {
  return rest.some((a) => flags.includes(a));
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

  // AC6: encryption-key gate BEFORE any build/boot (fail early, actionable). The
  // key the container actually boots with is re-derived from the resolved runtime
  // env below (a `composeRuntimeEnv` hook may supply it), so this stays purely a
  // fail-fast ordering gate.
  assertEncryptionKey(env);
  // AC7-iii: never route around the materialize safety invariant.
  assertMaterializeNotDisabled(env);
  // cinatra-cli#194: a malformed build-budget override is a hard error, and it
  // is raised HERE — before the slug claim, the port allocation and the volume
  // probe — so a typo costs nothing to recover from. `buildPreviewImage`
  // re-resolves the same value at the build itself (single source of truth).
  resolveBuildTimeoutMs(deps.buildControlEnv ?? process.env);
  // cinatra-cli#210: the two build levers get the same fail-fast treatment, for
  // the same reason — a typo'd ceiling must cost nothing, not surface an hour
  // into a build (or, worse, only after the slug/port/volume state was claimed).
  buildPreviewBuildArgs(deps.buildControlEnv ?? process.env);
  // cinatra-cli#219: the endpoint-ownership mode lever gets the SAME fail-fast
  // treatment — a typo'd value must be rejected before any state is claimed,
  // never silently downgrade the gate.
  resolveEndpointOwnershipMode(deps.ownershipControlEnv ?? deps.env ?? process.env);
  // AC9: refuse a genuine `--mode prod` checkout up front — before we even
  // resolve a SHA against or touch its `.git`. Checkout-derived, unconditional on
  // the env mode (never gated on a registry row).
  assertPreviewCheckoutAllowed({ envMode: readCheckoutEnvMode(checkoutDir) });

  const slug = deriveSlug({ rest, checkoutDir });
  const ref = readOption(rest, "--ref") ?? "main";
  const explicitPort = readOption(rest, "--port");
  // cinatra-cli#220: force a build even when this SHA's image is already here.
  const rebuild = readFlag(rest, "--rebuild", "--force-build");

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
  // FAIL-SAFE: only a probe that positively said "no such volume" licenses the
  // abort path to delete it. An unanswered probe (a timeout, a busy daemon) must
  // read as "it was already there" — deleting a durable volume this run did not
  // create is unrecoverable data loss, and there is no cost to keeping one.
  const volumePreexisted = volumeAbsence({ ref: volumeName, deps }) !== "absent";

  deps.log(`preview create: slug=${slug} ref=${ref} -> sha=${sha}`);
  deps.log(`  image tag: ${tag}   provenance: ${provenance}   runtime: CINATRA_RUNTIME_MODE=production`);

  // Release the claim + tear down partial docker state on ANY failure after the
  // claim, then re-throw. Image removal is SHA-global-safe (only removes the tag
  // when no OTHER slug references it); the volume is removed only if this create
  // created it.
  // cinatra-cli#220: an image this invocation REUSED is not this invocation's to
  // delete. Dropping a cached artifact because a boot failed for an unrelated
  // (configuration) reason would force the next attempt back through the build
  // this change exists to avoid — and on a constrained host that build may be
  // impossible (#210).
  let imageBuiltHere = false;
  const abort = async (err) => {
    removeContainer(previewContainerName(slug), deps);
    if (imageBuiltHere) {
      await removeImageIfUnreferenced(tag, { registryPath: deps.registryPath, keepSlug: slug, deps });
    }
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
    // Port-dependent env is derived AGAINST THE CLAIMED PORT (never a port a
    // caller pre-allocated outside the lock — that would race a concurrent
    // create), and it is resolved + VALIDATED HERE, before the build: an invalid
    // boot key, a materialize bypass, or a throwing hook must fail fast, not
    // after a multi-hour image build. A throw lands in the catch below, which
    // releases the claim and cleans up.
    const runtimeEnv = resolveRuntimeEnv({ deps, env, hostPort });
    const bootKey = assertEncryptionKey(runtimeEnv);
    // cinatra-cli#219: prove every container-dialed loopback endpoint belongs to
    // THIS instance before anything is built or booted. Run on the RESOLVED env
    // (what the container really boots with) rather than the pre-hook one, and
    // ahead of the build so a refusal costs nothing to recover from.
    assertContainerDialedEndpointsOwned({ env: runtimeEnv, checkoutDir, deps });

    // cinatra-cli#220: an image already present for this SHA is reused.
    imageBuiltHere = ensurePreviewImage({ tag, sha, checkoutDir, rebuild, provenance, deps }).built;

    const container = bootPreviewContainer({
      slug,
      tag,
      hostPort,
      encryptionKey: bootKey,
      provenance,
      sha,
      deps: { ...deps, env: runtimeEnv },
    });
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

  assertEncryptionKey(env); // AC6 — fail-fast gate; the boot key is re-derived below.
  assertMaterializeNotDisabled(env); // AC7-iii
  // cinatra-cli#194: validate the build-budget override HERE too, before the
  // registry claim and the container replacement — a typo'd override must not
  // surface only after the old preview has been put into `provisioning`.
  resolveBuildTimeoutMs(deps.buildControlEnv ?? process.env);
  buildPreviewBuildArgs(deps.buildControlEnv ?? process.env); // cinatra-cli#210 — same fail-fast for the build levers
  resolveEndpointOwnershipMode(deps.ownershipControlEnv ?? deps.env ?? process.env); // cinatra-cli#219

  // AC9: refuse a genuine `--mode prod` checkout up front — checkout-derived and
  // unconditional. Critically NOT gated on an existing registry row: refresh
  // requires an existing row to proceed, so gating the refusal on "a row exists"
  // would force it permanently satisfied and make the guard a no-op here.
  assertPreviewCheckoutAllowed({ envMode: readCheckoutEnvMode(checkoutDir) });

  const slug = deriveSlug({ rest, checkoutDir });
  const ref = readOption(rest, "--ref") ?? "main";
  const rebuild = readFlag(rest, "--rebuild", "--force-build"); // cinatra-cli#220
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
  let imageBuiltHere = false; // cinatra-cli#220 — see create's abort
  const abort = async (err) => {
    if (replaced) removeContainer(previewContainerName(slug), deps);
    if (newTag !== oldTag && imageBuiltHere) {
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
    // Same seam as create, resolved + VALIDATED FIRST: before the build and —
    // critically — before the healthy old container is torn down. A bad boot key,
    // a materialize bypass, or a throwing hook must never destroy a working
    // preview; failing here leaves `replaced` false, so abort restores the row to
    // `ready` and the running container is untouched.
    const runtimeEnv = resolveRuntimeEnv({ deps, env, hostPort });
    const bootKey = assertEncryptionKey(runtimeEnv);
    // cinatra-cli#219, same seam and the same ordering reason as create: a
    // foreign endpoint must be refused BEFORE the build and — critically —
    // before the healthy old container is torn down, so `replaced` stays false
    // and abort restores the row to `ready` with the running preview untouched.
    assertContainerDialedEndpointsOwned({ env: runtimeEnv, checkoutDir, deps });
    // Acquire the NEW image FIRST (a build failure leaves the running preview
    // untouched — we only replace the container after the image is in hand).
    // cinatra-cli#220 AC1: when that image is ALREADY here, no build runs at all
    // — which is what makes re-pointing a preview at changed configuration cheap
    // enough to be possible on a host that cannot build (#210).
    imageBuiltHere = ensurePreviewImage({ tag: newTag, sha: newSha, checkoutDir, rebuild, provenance, deps }).built;

    // Replace the running container (AC4: the replaced container is removed —
    // no orphan accumulation), REUSING the durable volume (never dropped).
    replaced = true;
    removeContainer(previewContainerName(slug), deps);
    const container = bootPreviewContainer({
      slug,
      tag: newTag,
      hostPort,
      encryptionKey: bootKey,
      provenance,
      sha: newSha,
      deps: { ...deps, env: runtimeEnv },
    });
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
 * `cinatra instance preview stop` (cinatra-cli#220 AC4).
 *
 * Stops the preview's container and NOTHING else: the durable volume, the
 * recorded host port, the image tag and the registry row are all untouched, so
 * `start` brings the SAME preview back. Reaching past the CLI to `docker stop`
 * was previously the only way to do this.
 *
 * The registry `state` deliberately does not change. It records what the
 * LIFECYCLE knows about the row (ready / provisioning / degraded); whether the
 * container is up is a fact about docker, which `status` now reads live (AC5).
 * Encoding "stopped" in the row would be a second, immediately-stale copy of a
 * truth docker already owns.
 */
export async function runPreviewStop(rest, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const slug = deriveSlug({ rest, checkoutDir });

  // CLAIM the row under the lock, exactly like every other mutating verb. A bare
  // read would race a concurrent refresh: refresh replaces the container and
  // health-gates it, and a `stop` that decided on the PRE-replacement reading
  // would stop the new container mid-gate and degrade that refresh.
  let row;
  await withRegistryLock(deps.registryPath, () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const existing = getPreview(reg, slug);
    if (!existing) {
      throw new Error(
        `No preview exists for slug "${slug}". Run \`cinatra instance preview list\` to see the registered previews.`,
      );
    }
    if (existing.state === "provisioning") {
      throw new Error(
        `An operation is already in-flight for preview "${slug}" (state=provisioning). Wait for it to finish.`,
      );
    }
    row = existing;
    const next = cloneRegistry(reg);
    next.previews[slug] = { ...existing, state: "provisioning" };
    writeRegistry(deps.registryPath, next);
  });

  const release = async (state) => {
    await withRegistryLock(deps.registryPath, () => {
      const reg = requireUsableRegistry(deps.registryPath);
      const cur = getPreview(reg, slug);
      if (cur && cur.state === "provisioning") {
        const next = cloneRegistry(reg);
        next.previews[slug] = { ...cur, state };
        writeRegistry(deps.registryPath, next);
      }
    });
  };

  const name = previewContainerName(slug);
  try {
    const before = containerState(name, deps);
    if (before === "unknown") {
      throw new Error(
        `Could not determine the state of ${name} — docker did not answer the probe (it neither reported ` +
          `the container nor said it does not exist). Nothing was changed. Check the docker daemon and retry.`,
      );
    }
    if (before === "absent") {
      deps.log(`preview "${slug}": no container ${name} to stop (image ${row.imageTag} is still recorded).`);
      return { slug, container: "absent", changed: false };
    }
    if (before === "stopped") {
      deps.log(`preview "${slug}": ${name} is already stopped.`);
      return { slug, container: "stopped", changed: false };
    }
    const r = deps.runDocker(["stop", name], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });
    if (r.error || r.status !== 0) {
      throw new Error(`docker stop of preview ${name} failed` + (r.stderr ? `: ${r.stderr.trim()}` : "."));
    }
    deps.log(
      `preview "${slug}" stopped: ${name} is down; the durable volume ${row.volumeName} and host port ` +
        `${row.hostPort ?? "-"} are kept. \`cinatra instance preview start --slug ${slug}\` brings it back.`,
    );
    return { slug, container: "stopped", changed: true };
  } finally {
    // `stop` never changes what the row RECORDS — the container's state is
    // docker's fact, which `status` reads live (AC5).
    await release(row.state);
  }
}

/**
 * `cinatra instance preview start` (cinatra-cli#220 AC3 + AC4).
 *
 * Three cases, one verb:
 *   - the container is RUNNING  → nothing to do (idempotent).
 *   - the container is STOPPED  → `docker start` it and health-gate. The
 *     container is not destroyed at any point, so this is the NARROWEST failure
 *     window of any path in this lifecycle.
 *   - the container is ABSENT   → RE-MATERIALIZE it from the image the row
 *     already records, with FRESHLY COMPOSED environment and no build.
 *
 * `--recreate` forces the re-materialization even when a container exists —
 * this is the answer to AC3's stale-endpoint case: re-banding an instance's
 * infra rewrites `.env.local`, and the running preview keeps the previous
 * band's addresses baked into its container env until something replaces the
 * container. Before this verb the only remedy was `refresh`, i.e. a full image
 * build for a change that never touched the image.
 *
 * AC6 (the failure window): a re-materialize must not widen the window a
 * refresh already has, and a cheap one is the opportunity to narrow it. So the
 * existing container is not destroyed to make room — it is RENAMED aside and
 * stopped, the new one is health-gated, and only then is the old one dropped. A
 * failed re-materialize RESTORES the old container instead of leaving the row
 * degraded with nothing running.
 */
export async function runPreviewStart(rest, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const checkoutDir = deps.checkoutDir ?? process.cwd();
  const env = deps.env ?? process.env;
  const slug = deriveSlug({ rest, checkoutDir });
  const recreate = readFlag(rest, "--recreate", "--re-materialize");

  // The same fail-fast gates the other mutating verbs apply, in the same order.
  assertMaterializeNotDisabled(env);
  resolveEndpointOwnershipMode(deps.ownershipControlEnv ?? deps.env ?? process.env);
  assertPreviewCheckoutAllowed({ envMode: readCheckoutEnvMode(checkoutDir) });

  let row;
  await withRegistryLock(deps.registryPath, () => {
    const reg = requireUsableRegistry(deps.registryPath);
    const existing = getPreview(reg, slug);
    if (!existing) {
      throw new Error(
        `No preview exists for slug "${slug}" to start. Run ` +
          `\`cinatra instance preview create --slug ${slug} --ref <ref>\` first.`,
      );
    }
    if (existing.state === "provisioning") {
      throw new Error(`An operation is already in-flight for preview "${slug}" (state=provisioning). Wait for it to finish.`);
    }
    row = existing;
    const next = cloneRegistry(reg);
    next.previews[slug] = { ...existing, state: "provisioning" };
    writeRegistry(deps.registryPath, next);
  });

  const name = previewContainerName(slug);
  const tag = row.imageTag;
  const hostPort = row.hostPort;
  const present = containerState(name, deps);
  if (present === "unknown") {
    await withRegistryLock(deps.registryPath, () => {
      const reg = requireUsableRegistry(deps.registryPath);
      const cur = getPreview(reg, slug);
      if (cur && cur.state === "provisioning") {
        const next = cloneRegistry(reg);
        next.previews[slug] = { ...cur, state: row.state };
        writeRegistry(deps.registryPath, next);
      }
    });
    throw new Error(
      `Could not determine the state of ${name} — docker did not answer the probe. Nothing was changed. ` +
        `Re-materializing on an UNKNOWN state could replace a container that is in fact still serving, ` +
        `so this stops instead. Check the docker daemon and retry.`,
    );
  }

  // Restore the row on ANY failure — `start` never leaves a claim behind.
  const release = async (state) => {
    await withRegistryLock(deps.registryPath, () => {
      const reg = requireUsableRegistry(deps.registryPath);
      const cur = getPreview(reg, slug);
      if (cur && cur.state === "provisioning") {
        const next = cloneRegistry(reg);
        next.previews[slug] = { ...cur, state };
        writeRegistry(deps.registryPath, next);
      }
    });
  };

  try {
    if (present === "running" && !recreate) {
      if (row.state !== "degraded") {
        deps.log(`preview "${slug}" is already running: ${tag} on http://localhost:${hostPort}`);
        await release(row.state);
        return { slug, container: "running", changed: false, rematerialized: false, hostPort };
      }
      // A DEGRADED row means the last run's health gate did not pass. "docker
      // says it is running" is not the same fact and must never clear it — the
      // container that failed the gate is typically still running. Re-probe, and
      // only a real healthy answer promotes the row.
      deps.log(`preview "${slug}" is running but its row is degraded; re-probing http://localhost:${hostPort}/api/health ...`);
      const probe = await pollHealthGate({
        url: `http://localhost:${hostPort}/api/health`,
        deps: { ...deps, isRunning: () => containerRunning(name, deps) },
      });
      if (probe.state !== "healthy") {
        await release("degraded");
        throw new Error(
          `preview "${slug}" is still degraded (terminal state: ${probe.state}` +
            (probe.status ? `, http ${probe.status}` : "") + `). ` +
            (probe.state === "crashed"
              ? `The container stopped running while it was being probed; nothing here removed it. `
              : `The container was left running and untouched. `) +
            `\`cinatra instance preview start --slug ${slug} --recreate\` re-materializes it with freshly ` +
            `composed environment (no build), which is the fix when the configuration is what changed.`,
        );
      }
      await release("ready");
      deps.log(`preview "${slug}" is healthy again: ${tag} on http://localhost:${hostPort}`);
      return { slug, container: "running", changed: false, rematerialized: false, hostPort };
    }

    if (present === "stopped" && !recreate) {
      const r = deps.runDocker(["start", name], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });
      if (r.error || r.status !== 0) {
        throw new Error(`docker start of preview ${name} failed` + (r.stderr ? `: ${r.stderr.trim()}` : "."));
      }
      deps.log(`  started ${name}; health-gating http://localhost:${hostPort}/api/health ...`);
      const result = await pollHealthGate({
        url: `http://localhost:${hostPort}/api/health`,
        deps: { ...deps, isRunning: () => containerRunning(name, deps) },
      });
      if (result.state !== "healthy") {
        const diag = dumpContainerLogs(name, deps);
        await release("degraded");
        throw new Error(
          `preview "${slug}" started but did not reach healthy (terminal state: ${result.state}` +
            (result.status ? `, http ${result.status}` : "") + `). The container was NOT destroyed and its ` +
            `durable volume is intact.\n--- container logs (tail) ---\n${diag.slice(-4000)}`,
        );
      }
      await release("ready");
      deps.log(`preview "${slug}" is healthy: ${tag} (sha ${row.sha}) on http://localhost:${hostPort}`);
      return { slug, container: "running", changed: true, rematerialized: false, hostPort };
    }

    // RE-MATERIALIZE: the container is absent, or `--recreate` was asked for.
    // The SAME stamped, three-way presence the build-skip uses. A boolean
    // existence check would boot whatever currently carries this (mutable) tag —
    // and `--recreate` would replace a healthy preview with a stranger's image —
    // and would report a timed-out probe as "not present".
    const image = previewImagePresence({ tag, sha: row.sha, deps });
    if (image.state !== "present") {
      await release(row.state);
      throw new Error(
        image.state === "mismatch"
          ? `Cannot re-materialize preview "${slug}": the image tagged ${tag} was NOT built from this ` +
            `preview's SHA (cinatra.preview.sha=${image.sha || "<unstamped>"}, expected ${row.sha}). ` +
            `Booting it would run a different artifact under this preview's name. Rebuild with ` +
            `\`cinatra instance preview refresh --slug ${slug} --ref ${row.ref} --rebuild\`.`
          : image.state === "unknown"
            ? `Could not determine whether the image ${tag} is present — docker did not answer the probe. ` +
              `Nothing was changed. Check the docker daemon and retry.`
            : `Cannot re-materialize preview "${slug}": its recorded image ${tag} is not present locally. ` +
              `Rebuild it with \`cinatra instance preview refresh --slug ${slug} --ref ${row.ref}\` ` +
              `(that path builds; this one deliberately never does).`,
      );
    }
    const runtimeEnv = resolveRuntimeEnv({ deps, env, hostPort });
    const bootKey = assertEncryptionKey(runtimeEnv);
    // cinatra-cli#219: a re-materialization boots a container that DIALS these
    // endpoints, so it is gated exactly like create and refresh.
    assertContainerDialedEndpointsOwned({ env: runtimeEnv, checkoutDir, deps });

    // AC6: keep the old container ASIDE (renamed + stopped) rather than
    // destroying it, so a failed re-materialize can put it back.
    let parked = null;
    if (present !== "absent") {
      parked = `${name}${SUPERSEDED_CONTAINER_SUFFIX}`;
      removeContainer(parked, deps); // clear any debris from an earlier attempt
      const rename = deps.runDocker(["rename", name, parked], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
      if (rename.error || rename.status !== 0) {
        await release(row.state);
        throw new Error(
          `Could not set the existing preview container aside (docker rename ${name})` +
            (rename.stderr ? `: ${rename.stderr.trim()}` : ".") + ` Nothing was changed.`,
        );
      }
      // It still holds the published host port until it is stopped.
      deps.runDocker(["stop", parked], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });
    }

    // Put the parked container back. Every step is CHECKED: a restore that
    // silently failed would leave the canonical container absent while the
    // message claimed it was back, and the row would say `ready`.
    const restore = () => {
      if (!parked) return { outcome: "none", parked: null };
      removeContainer(name, deps);
      const back = deps.runDocker(["rename", parked, name], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });
      if (back.error || back.status !== 0) return { outcome: "failed", parked };
      const up = deps.runDocker(["start", name], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });
      if (up.error || up.status !== 0) return { outcome: "failed", parked: name };
      // Both steps SUCCEEDED. The confirming probe may still go unanswered — and
      // that is "could not confirm", not "it is gone": claiming the preview is
      // DOWN when the container is in fact back would be the same over-claim the
      // absent/unknown split exists to prevent.
      const state = containerState(name, deps);
      return { outcome: state === "running" ? "restored" : state === "unknown" ? "unconfirmed" : "failed", parked: null };
    };
    /** The tail of a failure message: what the restore actually achieved. */
    const restoreNote = (r) => {
      if (r.outcome === "none") return `There was no previous container to restore. `;
      if (r.outcome === "restored") {
        return `The PREVIOUS container was restored and restarted — this run left the preview as it found it. `;
      }
      if (r.outcome === "unconfirmed") {
        return `The previous container was renamed back and started, but docker did not answer the ` +
          `confirming probe — its state is UNKNOWN, not known to be down. Check ` +
          `\`cinatra instance preview status --slug ${slug}\`. `;
      }
      return `The previous container could NOT be brought back and is left ` +
        `${r.parked ? `as ${r.parked}` : `removed`}; the preview is DOWN. ` +
        `\`cinatra instance preview start --slug ${slug} --recreate\` re-materializes it from ${tag} ` +
        `(no build)${r.parked ? `; remove ${r.parked} once you no longer need it` : ""}. `;
    };

    let container;
    try {
      container = bootPreviewContainer({
        slug,
        tag,
        hostPort,
        encryptionKey: bootKey,
        provenance: row.provenance,
        sha: row.sha,
        deps: { ...deps, env: runtimeEnv },
      });
    } catch (err) {
      const r = restore();
      await release(r.outcome === "failed" ? "degraded" : row.state);
      throw new Error(`${err?.message ?? err}\n  ${restoreNote(r).trim()}`);
    }
    deps.log(
      `  re-materialized ${container} from the image already present (${tag}) — no build; ` +
        `health-gating http://localhost:${hostPort}/api/health ...`,
    );
    const result = await pollHealthGate({
      url: `http://localhost:${hostPort}/api/health`,
      deps: { ...deps, isRunning: () => containerRunning(container, deps) },
    });
    if (result.state !== "healthy") {
      const diag = dumpContainerLogs(container, deps);
      const r = restore();
      await release(r.outcome === "failed" ? "degraded" : row.state);
      throw new Error(
        `preview "${slug}" did not reach healthy after re-materializing (terminal state: ${result.state}` +
          (result.status ? `, http ${result.status}` : "") + `). ` +
          restoreNote(r) +
          `The durable volume ${row.volumeName} was never touched.` +
          `\n--- container logs (tail) ---\n${diag.slice(-4000)}`,
      );
    }
    if (parked) removeContainer(parked, deps);
    await release("ready");
    deps.log(
      `preview "${slug}" re-materialized and healthy: ${tag} (sha ${row.sha}) on http://localhost:${hostPort} ` +
        `— container env recomposed, image untouched.`,
    );
    return { slug, container: "running", changed: true, rematerialized: true, hostPort };
  } catch (err) {
    await release(row.state);
    throw err;
  }
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
  // cinatra-cli#220 AC5: report what the CONTAINER is actually doing, not only
  // what the row says. "state=ready" answered the question "did the lifecycle
  // finish successfully", which a stopped (or manually removed) container does
  // not contradict — so the two facts are reported side by side, and the row is
  // never rewritten from a read.
  const out = [];
  for (const r of rows) {
    const container = containerState(previewContainerName(r.slug), deps);
    out.push({ ...r, container });
    deps.log(
      `preview ${r.slug}: state=${r.state} container=${container} sha=${r.sha} tag=${r.imageTag} ` +
        `provenance=${r.provenance} volume=${r.volumeName} port=${r.hostPort ?? "-"} ref=${r.ref}`,
    );
    if (r.state === "ready" && container === "unknown") {
      deps.log(`  the container's state could NOT be read (docker did not answer) — this is not a claim that it is gone.`);
    } else if (r.state === "ready" && container !== "running") {
      deps.log(
        container === "stopped"
          ? `  the row is ready but its container is STOPPED — \`cinatra instance preview start --slug ${r.slug}\` serves it again.`
          : `  the row is ready but NO container exists — \`cinatra instance preview start --slug ${r.slug}\` ` +
            `re-materializes it from ${r.imageTag} without a build.`,
      );
    }
    if (Array.isArray(r.history) && r.history.length > 1) {
      deps.log(`  history: ${r.history.map((h) => h.sha.slice(0, 12)).join(" -> ")}`);
    }
  }
  return out;
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
  CONTAINER_REWRITE_ENV_KEYS,
  CONTAINER_HOST_GATEWAY,
  PREVIEW_HOST_PORT_MIN,
  PREVIEW_HOST_PORT_MAX,
  PREVIEW_BUILD_TIMEOUT_DEFAULT_MS,
  PREVIEW_BUILD_TIMEOUT_ENV,
  PREVIEW_BUILD_TIMEOUT_MIN_MS,
  PREVIEW_BUILD_TIMEOUT_MAX_MS,
  PREVIEW_BUILD_MEMORY_ENV,
  PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB,
  PREVIEW_BUILD_MEMORY_MIN_MB,
  PREVIEW_BUILD_MEMORY_MAX_MB,
  PREVIEW_BUILD_TYPECHECK_ENV,
  PREVIEW_BUILD_MEMORY_ARG,
  PREVIEW_BUILD_CI_ARG,
  PREVIEW_STOP_TIMEOUT_MS,
  SUPERSEDED_CONTAINER_SUFFIX,
  // pure helpers
  resolveBuildTimeoutMs,
  formatBuildBudget,
  rewriteLoopbackUrlForContainer,
  containerDialedLoopbackEndpoints,
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
  resolveBuildMemoryMb,
  resolveBuildTypecheck,
  buildPreviewBuildArgs,
  dockerfileDeclaredBuildArgs,
  buildPreviewImage,
  bootPreviewContainer,
  dockerObjectExists,
  volumeAbsence,
  previewImagePresence,
  ensurePreviewImage,
  containerRunning,
  containerState,
  removeContainer,
  removeImage,
  removeImageIfUnreferenced,
  dumpContainerLogs,
  deriveSlug,
  // orchestration
  runPreviewCreate,
  runPreviewRefresh,
  runPreviewStop,
  runPreviewStart,
  runPreviewStatus,
  runPreviewList,
  readFlag,
  defaultDeps,
};
