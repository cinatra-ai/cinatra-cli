// Pure, side-effect-free decision helpers for the CLI execution-plane lifecycle
// (cinatra-cli#174 — exec-plane S4; epic cinatra-ai/cinatra#1705).
//
// WHAT CHANGED vs cinatra-cli#164 (and why this module was re-authored)
// --------------------------------------------------------------------
// #164 shipped this lifecycle BEFORE the core activation existed, so its env
// contract was necessarily invented: it wrote `CINATRA_EXECUTION_MODE`,
// `CINATRA_EXECUTION_BROKER_URL`, `CINATRA_SANDBOX_L0_IMAGE_DIGEST` and
// `CINATRA_SANDBOX_EGRESS_MODE` — NOT ONE of which the merged activation reads.
// A `local-dev` install therefore produced an instance whose boot phase wired
// nothing, forever, with no diagnostic saying so.
//
// The activation has since MERGED (cinatra-ai/cinatra#2144 "S1b activation",
// plus #2143 slice B), so every constant below is now GROUNDED in a real reader
// on cinatra `origin/main` and cites it by path. Nothing here is guessed.
//
// THE ACTUAL CONTRACT THE MERGED ACTIVATION READS
// -----------------------------------------------
//   env  CINATRA_EXECUTION_PLANE_ROLLOUT       packages/llm/src/execution-plane/policy.ts
//        └─ `isExecutionPlaneRolloutEnabled()`; ONLY the exact string "on".
//           Off ⇒ `executionBrokerPhases()` returns an EMPTY phase list — no
//           phase at all, nothing can ever wire (boot/phases/execution-broker.ts).
//   env  EXECUTION_BROKER_URL                  src/lib/boot/phases/execution-plane-health.ts
//   env  EXECUTION_BROKER_SECRET               packages/llm/src/execution-plane/session.ts
//        └─ BOTH: `evaluateExecutionPlaneReadiness()` treats *both empty* as
//           "not-configured" (⇒ the instance has NOT opted in ⇒
//           `resolveExecutionEnvironmentReadiness()` answers `disabled`), and
//           *one empty* as "misconfigured" (a degraded boot phase). The secret
//           is what `sealExecutionSession()` signs the job carrier with — absent
//           ⇒ `ExecutionBrokerSecretMissingError`, fail-closed.
//   env  EXECUTION_ENVIRONMENT_PROVENANCE_KEY  src/lib/execution/environment-execution-service.ts
//        └─ `PROVENANCE_KEY_ENV`; empty ⇒ readiness `unavailable`, declared-
//           environment runs refuse (slice B, cinatra#2143).
//   env  EXECUTION_BROKER_SERVICE_TOKEN        packages/execution-plane/src/broker.ts
//        └─ `verifyServiceToken()` — the broker's own service boundary,
//           independently scoped from the carrier secret by design.
//   env  CINATRA_SANDBOX_L0_IMAGE              packages/execution-plane/src/l0-profile.ts
//        └─ `resolveL0ImageRef()`; unset falls back to DEFAULT_L0_IMAGE_LOCAL_DEV.
//   env  EXECUTION_SANDBOX_NETWORK             src/lib/execution/execution-broker-construct.ts
//   env  EXECUTION_GATEWAY_SCRIPT_PATH         src/lib/execution/execution-broker-construct.ts
//   env  EXECUTION_PLANE_REQUIRED              src/lib/boot/phases/execution-plane-health.ts
//
//   ★ THE MODE IS NOT AN ENV VAR. `readExecutionPlaneSettings()`
//     (src/lib/execution/execution-plane-settings.ts) reads it from the platform
//     key/value metadata store under `connector_config:execution_plane`, shaped
//     `{ mode, egressMode, egressAllowlist }`. An instance whose env is perfect
//     but whose settings row is absent boots with the DEFAULT mode `disabled`
//     and wires NOTHING. That is why `install --execution-mode local-dev` must
//     seed the settings row as well as the env — "no manual edits" is otherwise
//     unreachable.
//
// This module stays PURE (no imports, no I/O) exactly as `update-target.mjs` /
// `prod-runtime-guidance.mjs` do: docker/HTTP/pg orchestration lives in
// `index.mjs` + `install.mjs`; the decision logic that is worth testing without
// a docker daemon lives here.
//
// SECRET DISCIPLINE: nothing in this module ever RETURNS or FORMATS a secret
// value. Readers answer `…Present: boolean`; the only place a minted secret
// exists is inside the upsert list handed straight to the `.env.local` writer.

// ---------------------------------------------------------------------------
// Grounded contract constants
// ---------------------------------------------------------------------------

/** The persisted placement vocabulary. Mirrors `EXECUTION_PLANE_MODES`
 *  (cinatra src/lib/execution/execution-plane-settings.ts), in render order. */
export const EXECUTION_MODES = Object.freeze(["remote", "local-dev", "disabled"]);

/** `DEFAULT_EXECUTION_PLANE_MODE` — the fail-closed default, both there and here. */
export const DEFAULT_EXECUTION_MODE = "disabled";

/** The rollout merge gate. ONLY the exact string "on" (policy.ts). */
export const ROLLOUT_ENV_KEY = "CINATRA_EXECUTION_PLANE_ROLLOUT";
export const ROLLOUT_ON = "on";

/** Execution-plane CLIENT config the health boot phase validates. */
export const BROKER_URL_ENV_KEY = "EXECUTION_BROKER_URL";
/** Carrier signing secret (`sealExecutionSession`). Fail-closed when absent. */
export const BROKER_SECRET_ENV_KEY = "EXECUTION_BROKER_SECRET";
/** The broker's own service-boundary token (`verifyServiceToken`). */
export const BROKER_SERVICE_TOKEN_ENV_KEY = "EXECUTION_BROKER_SERVICE_TOKEN";
/** L1 environment provenance HMAC key (`PROVENANCE_KEY_ENV`, slice B). */
export const PROVENANCE_KEY_ENV_KEY = "EXECUTION_ENVIRONMENT_PROVENANCE_KEY";
/** L0 image override (`resolveL0ImageRef`). */
export const L0_IMAGE_ENV_KEY = "CINATRA_SANDBOX_L0_IMAGE";
/** Internal sandbox network override (`constructLocalDevExecutionBroker`). */
export const SANDBOX_NETWORK_ENV_KEY = "EXECUTION_SANDBOX_NETWORK";
/** Gateway script path override (packaged deployments). */
export const GATEWAY_SCRIPT_PATH_ENV_KEY = "EXECUTION_GATEWAY_SCRIPT_PATH";
/** Instance CLASS declaring the plane deploy-blocking (`executionPlaneRequired`). */
export const EXECUTION_PLANE_REQUIRED_ENV_KEY = "EXECUTION_PLANE_REQUIRED";

/**
 * The keys the CLI OWNS in `.env.local`. Selecting `disabled` removes exactly
 * this set and nothing else — `EXECUTION_PLANE_REQUIRED` and
 * `EXECUTION_GATEWAY_SCRIPT_PATH` are deployment-class decisions the CLI never
 * writes and therefore must never silently delete.
 */
export const CLI_MANAGED_EXECUTION_ENV_KEYS = Object.freeze([
  ROLLOUT_ENV_KEY,
  BROKER_URL_ENV_KEY,
  BROKER_SECRET_ENV_KEY,
  BROKER_SERVICE_TOKEN_ENV_KEY,
  PROVENANCE_KEY_ENV_KEY,
  L0_IMAGE_ENV_KEY,
  SANDBOX_NETWORK_ENV_KEY,
]);

/** The env keys whose VALUE is a secret — never rendered, never logged. */
export const SECRET_EXECUTION_ENV_KEYS = Object.freeze([
  BROKER_SECRET_ENV_KEY,
  BROKER_SERVICE_TOKEN_ENV_KEY,
  PROVENANCE_KEY_ENV_KEY,
]);

/** Platform key/value metadata key holding the settings row
 *  (`EXECUTION_PLANE_SETTINGS_KEY` prefixed with the connector-config namespace,
 *  cinatra src/lib/database.ts `readConnectorConfigFromDatabase`). */
export const EXECUTION_SETTINGS_METADATA_KEY = "connector_config:execution_plane";

/** Egress tier vocabulary — `EXECUTION_EGRESS_MODES`. */
export const EGRESS_MODES = Object.freeze(["default_internet", "allowlist", "none"]);
/** `DEFAULT_EXECUTION_PLANE_SETTINGS.egressMode`. */
export const DEFAULT_EGRESS_MODE = "default_internet";

/** `DEFAULT_L0_IMAGE_LOCAL_DEV` (l0-profile.ts). A dev tag, never `:latest`. */
export const DEFAULT_L0_IMAGE_LOCAL_DEV = "cinatra-sandbox-l0:dev";
/** The image NAME (no tag) the prune verb scopes itself to. */
export const L0_IMAGE_REPO = "cinatra-sandbox-l0";

/** L0 build recipe location in the checkout. */
export const L0_DOCKERFILE_REL = "docker/sandbox/Dockerfile";
export const L0_BUILD_CONTEXT_REL = "docker/sandbox";

/** `DEFAULT_SANDBOX_NETWORK` (packages/execution-plane/src/egress.ts). */
export const SANDBOX_NETWORK_NAME = "cinatra-exec-internal";

/** Gateway topology (packages/execution-plane/src/local-gateway.ts). */
export const GATEWAY_CONTAINER_NAME = "cinatra-exec-gateway";
export const GATEWAY_PROXY_PORT = 3128;
export const GATEWAY_ADMIN_PORT = 3129;
export const GATEWAY_HEALTH_PATH = "/__health";

/**
 * The BOOT HANDSHAKE probe, verbatim from
 * `src/lib/execution/execution-broker-construct.ts`:
 *
 *   const HANDSHAKE_COMMAND         = "printf cinatra-exec-handshake";
 *   const HANDSHAKE_EXPECTED_STDOUT = "cinatra-exec-handshake";
 *
 * and its acceptance predicate — `termination === "exited" && exitCode === 0 &&
 * stdout.trim() === HANDSHAKE_EXPECTED_STDOUT`. The CLI mirrors ALL THREE so a
 * green `doctor` handshake check means the same thing the boot phase means when
 * it registers the executor factory.
 */
export const HANDSHAKE_COMMAND = "printf cinatra-exec-handshake";
export const HANDSHAKE_EXPECTED_STDOUT = "cinatra-exec-handshake";

/** Hardened runtime identity (`SANDBOX_RUNTIME_UID` / `_GID`, l0-profile.ts). */
export const SANDBOX_RUNTIME_UID = 10001;
export const SANDBOX_RUNTIME_GID = 10001;

/** L2 workspace volume label (workspace.ts) — the `sandbox gc` filter. */
export const WORKSPACE_LABEL = "ai.cinatra.execution-plane";

/** CLI-owned sidecar recording the acquired image pin. NOT read by the app —
 *  the env contract stays exactly what the activation reads; this file only
 *  lets `doctor` detect image drift since acquisition. */
export const PIN_RECORD_REL = ".cinatra/execution-plane.json";

/** The three doctor verdicts. */
export const EXECUTION_VERDICTS = Object.freeze(["healthy", "degraded", "disabled"]);

/** The RETIRED `:latest` shell image the CLI-managed path must never name again. */
export const DEPRECATED_SHELL_IMAGE = "cinatra/skill-shell:latest";

// ---------------------------------------------------------------------------
// Mode parsing + install-time resolution
// ---------------------------------------------------------------------------

const MODE_ALIASES = new Map([
  ["remote", "remote"],
  ["local-dev", "local-dev"],
  ["localdev", "local-dev"],
  ["local", "local-dev"],
  ["dev", "local-dev"],
  ["disabled", "disabled"],
  ["disable", "disabled"],
  ["off", "disabled"],
  ["none", "disabled"],
]);

/**
 * Normalize a raw execution-mode token. Throws loudly on anything unknown so a
 * typo never silently degrades to a default.
 *
 * @param {unknown} raw
 * @returns {"remote"|"local-dev"|"disabled"}
 */
export function normalizeExecutionMode(raw) {
  const token = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const canonical = MODE_ALIASES.get(token);
  if (!canonical) {
    throw new Error(
      `Invalid execution mode "${raw}". Use one of: ${EXECUTION_MODES.join(", ")} ` +
        `(remote = an out-of-process broker URL + shared secret; local-dev = run the ` +
        `sandbox on this machine; disabled = nothing is provisioned and models stay usable).`,
    );
  }
  return canonical;
}

/**
 * The default execution mode when the operator passes no `--execution-mode`.
 *
 * ALWAYS `disabled`, for every install mode — the issue's stated default and
 * the core's own `DEFAULT_EXECUTION_PLANE_MODE`. A sandbox that can run model-
 * authored commands is never provisioned by omission; it is always an explicit
 * choice. (#164 defaulted dev installs to `local-dev`; that silently provisioned
 * a container runtime on every dev machine.)
 *
 * @returns {"disabled"}
 */
export function defaultExecutionModeForInstall() {
  return DEFAULT_EXECUTION_MODE;
}

/**
 * Resolve the EFFECTIVE mode from the flag + TTY:
 *   - explicit `--execution-mode` always wins (interactive: false);
 *   - no flag + TTY → offer the picker, highlighting `disabled`;
 *   - no flag + no TTY → `disabled` silently, so scripted installs never hang.
 *
 * @returns {{ mode: string, interactive: boolean, default: string, reason: string }}
 */
export function resolveExecutionModeForInstall({ flagMode = null, isTty = false } = {}) {
  const fallback = defaultExecutionModeForInstall();
  if (flagMode != null) {
    return {
      mode: normalizeExecutionMode(flagMode),
      interactive: false,
      default: fallback,
      reason: "--execution-mode flag",
    };
  }
  if (isTty) {
    return { mode: fallback, interactive: true, default: fallback, reason: `interactive picker (default: ${fallback})` };
  }
  return { mode: fallback, interactive: false, default: fallback, reason: "non-interactive default (disabled)" };
}

/**
 * Blank-or-flag-like. Used for values that end up as an argv token to docker /
 * curl (a URL, an image ref), where a leading dash really could be read as an
 * option.
 */
function blankOrFlagLike(value) {
  return typeof value !== "string" || value.trim().length === 0 || value.trim().startsWith("-");
}

/**
 * Blank ONLY. Used for opaque SECRET material (round-2 finding): a broker
 * secret or service token is never an argv token, and a perfectly valid
 * base64/base64url value can begin with `-`. Treating it as "not supplied"
 * would silently clear it — or, worse, mint a replacement.
 */
function blankOnly(value) {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * Refuse an env VALUE that could not survive a `.env.local` round-trip intact
 * (Codex convergence finding 4). A newline in an operator-supplied secret would
 * append a SECOND, attacker-chosen key to the file — and the provisioning step
 * would report success. A NUL or other control character truncates or corrupts
 * the value silently. Neither can ever be a legitimate secret/URL/image-ref.
 */
export function assertEnvValueSafe(key, value) {
  const raw = String(value);
  if (/[\r\n]/.test(raw)) {
    throw new Error(
      `Refusing to write ${key}: the value contains a line break, which would inject an additional ` +
        "key into .env.local. Supply a single-line value.",
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(raw)) {
    throw new Error(`Refusing to write ${key}: the value contains a control character.`);
  }
  return raw;
}

/**
 * Parse the execution-plane flags out of an argv (order-independent; unrelated
 * args are ignored so this runs alongside the main install parser).
 *
 *   --execution-mode=<remote|local-dev|disabled>
 *   --sandbox-broker-url=<url>            → EXECUTION_BROKER_URL
 *   --sandbox-broker-secret=<secret>      → EXECUTION_BROKER_SECRET
 *   --sandbox-broker-token=<token>        → EXECUTION_BROKER_SERVICE_TOKEN
 *   --sandbox-provenance-key=<key>        → EXECUTION_ENVIRONMENT_PROVENANCE_KEY
 *   --sandbox-image=<ref>                 → CINATRA_SANDBOX_L0_IMAGE
 *   --sandbox-network=<name>              → EXECUTION_SANDBOX_NETWORK
 *   --sandbox-egress=<default_internet|allowlist|none>   (settings row)
 *   --sandbox-egress-allow=<host,host>                   (settings row)
 *
 * @param {string[]} argv
 */
export function parseExecutionModeFlags(argv = []) {
  const read = (name) => {
    const eq = `${name}=`;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (typeof arg !== "string") continue;
      if (arg.startsWith(eq)) return arg.slice(eq.length);
      if (arg === name) {
        const next = argv[i + 1];
        if (next === undefined || (typeof next === "string" && next.startsWith("--"))) {
          throw new Error(`${name} requires a value.`);
        }
        return next;
      }
    }
    return null;
  };

  const rawMode = read("--execution-mode");
  const mode = rawMode == null ? null : normalizeExecutionMode(rawMode);

  const rawEgress = read("--sandbox-egress");
  let egressMode = null;
  if (rawEgress != null) {
    const e = rawEgress.trim().toLowerCase();
    if (!EGRESS_MODES.includes(e)) {
      throw new Error(`Invalid --sandbox-egress "${rawEgress}". Use one of: ${EGRESS_MODES.join(", ")}.`);
    }
    egressMode = e;
  }

  const rawAllow = read("--sandbox-egress-allow");

  return {
    mode,
    brokerUrl: read("--sandbox-broker-url"),
    brokerSecret: read("--sandbox-broker-secret"),
    serviceToken: read("--sandbox-broker-token"),
    provenanceKey: read("--sandbox-provenance-key"),
    imageRef: read("--sandbox-image"),
    sandboxNetwork: read("--sandbox-network"),
    egressMode,
    egressAllowlist: rawAllow == null ? null : normalizeEgressAllowlist(rawAllow),
  };
}

// ---------------------------------------------------------------------------
// Image reference safety — digest pins, never `:latest`
// ---------------------------------------------------------------------------

const SHA256_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;
const BARE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * `assertSafeImageRef` from l0-profile.ts, mirrored: refuse a reference docker
 * could parse as an OPTION, or one carrying characters outside the image-ref
 * charset.
 */
export function assertSafeImageRef(ref) {
  if (typeof ref !== "string" || !/^[A-Za-z0-9]/.test(ref)) {
    throw new Error(`Refusing an L0 image reference that does not start alphanumerically (option injection): "${ref}".`);
  }
  if (!/^[A-Za-z0-9._:/@-]+$/.test(ref)) {
    throw new Error(`Refusing an L0 image reference with characters outside the image-ref charset: "${ref}".`);
  }
  return ref;
}

/** True when `ref` is pinned to an immutable `@sha256:<64-hex>` digest. */
export function isDigestPinned(ref) {
  return typeof ref === "string" && SHA256_DIGEST_RE.test(ref);
}

/** True when `ref` carries the mutable `:latest` tag. */
export function hasLatestTag(ref) {
  if (typeof ref !== "string") return false;
  return /:latest$/i.test(ref.replace(SHA256_DIGEST_RE, ""));
}

/** Enforce the digest-pin contract for a reference the runtime will USE. */
export function assertDigestPinnedImage(ref, { context = "the sandbox L0 image" } = {}) {
  assertSafeImageRef(ref);
  if (hasLatestTag(ref)) {
    throw new Error(
      `Refusing ${context} reference "${ref}": the mutable :latest tag is banned for the execution plane. ` +
        `Pin an immutable digest instead (name@sha256:<64-hex>).`,
    );
  }
  if (!isDigestPinned(ref)) {
    throw new Error(
      `Refusing ${context} reference "${ref}": it is not digest-pinned. A remote worker must run an ` +
        `immutable, attributable image (name@sha256:<64-hex>) — the worker records the resolved digest on every audit row.`,
    );
  }
  return ref;
}

// ---------------------------------------------------------------------------
// The settings row (`connector_config:execution_plane`)
// ---------------------------------------------------------------------------

/** `normalizeEgressAllowlist` from execution-plane-settings.ts, mirrored. */
export function normalizeEgressAllowlist(raw) {
  const source = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out = [];
  const seen = new Set();
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const host = entry.trim().toLowerCase().replace(/\.$/, "");
    if (host.length === 0 || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

/**
 * Normalize a raw settings row exactly as `readExecutionPlaneSettings()` does
 * (unknown mode / egress coerce to the fail-closed defaults), so the CLI's view
 * of an instance is byte-for-byte the boot phase's view.
 */
export function normalizeExecutionSettings(raw) {
  const fallback = { mode: DEFAULT_EXECUTION_MODE, egressMode: DEFAULT_EGRESS_MODE, egressAllowlist: [] };
  if (!raw || typeof raw !== "object") return fallback;
  return {
    mode: EXECUTION_MODES.includes(raw.mode) ? raw.mode : DEFAULT_EXECUTION_MODE,
    egressMode: EGRESS_MODES.includes(raw.egressMode) ? raw.egressMode : DEFAULT_EGRESS_MODE,
    egressAllowlist: normalizeEgressAllowlist(raw.egressAllowlist),
  };
}

/** Build the settings row for a chosen mode. */
export function executionSettingsRow({ mode, egressMode = null, egressAllowlist = null } = {}) {
  return normalizeExecutionSettings({
    mode: normalizeExecutionMode(mode),
    egressMode: egressMode ?? DEFAULT_EGRESS_MODE,
    egressAllowlist: egressAllowlist ?? [],
  });
}

// ---------------------------------------------------------------------------
// The env plan — EXACTLY the contract the merged activation reads
// ---------------------------------------------------------------------------

/**
 * Compute the `.env.local` upserts + the settings row for a chosen execution
 * mode. `value: null` means "remove this key if present".
 *
 * `local-dev`
 *   ROLLOUT=on, a loopback BROKER_URL, a minted BROKER_SECRET / SERVICE_TOKEN /
 *   PROVENANCE_KEY, and the L0 image ref. The URL is required even though the
 *   local-dev broker is IN-PROCESS: `evaluateExecutionPlaneReadiness()` treats
 *   url+secret both-empty as "the instance never opted into the plane", which
 *   makes `resolveExecutionEnvironmentReadiness()` answer `disabled` and every
 *   declared-environment run refuse. So the loopback origin is written as the
 *   placement endpoint the health phase validates — no separate service is
 *   contacted in this mode.
 *
 * `remote`
 *   The same keys, but the URL + secret + token are the OPERATOR's (they must
 *   match the broker's), and the image must be digest-pinned.
 *
 * `disabled`
 *   Removes every CLI-managed key and sets the settings row to `disabled`. On a
 *   FRESH install nothing was ever written, `seedSettings` is false, and the
 *   result is literally zero writes — the core's own default is already
 *   `disabled` + rollout-unset, which makes `executionBrokerPhases()` return an
 *   empty phase list (byte-equivalent inert).
 *
 * @param {{
 *   mode: string, appOrigin?: string|null, brokerUrl?: string|null,
 *   brokerSecret?: string|null, serviceToken?: string|null, provenanceKey?: string|null,
 *   imageRef?: string|null, sandboxNetwork?: string|null, egressMode?: string|null,
 *   egressAllowlist?: string[]|null, alreadyProvisioned?: boolean,
 *   mintSecret?: () => string,
 * }} input
 * @returns {{ mode: string, upserts: Array<{key:string,value:string|null}>,
 *            settings: object|null, minted: string[], notes: string[] }}
 */
export function planExecutionEnv({
  mode,
  appOrigin = null,
  brokerUrl = null,
  brokerSecret = null,
  serviceToken = null,
  provenanceKey = null,
  imageRef = null,
  sandboxNetwork = null,
  egressMode = null,
  egressAllowlist = null,
  alreadyProvisioned = false,
  mintSecret = null,
} = {}) {
  const resolved = normalizeExecutionMode(mode);
  const notes = [];
  const minted = [];

  if (resolved === "disabled") {
    // AC: `disabled` writes NOTHING on a fresh install. On an instance that WAS
    // provisioned, removing the keys is the whole point of switching to
    // disabled — a stale ROLLOUT=on would keep the boot phase alive.
    if (!alreadyProvisioned) {
      return {
        mode: resolved,
        upserts: [],
        settings: null,
        minted,
        notes: [
          "Execution plane disabled: nothing written. The core default is already `disabled` with the rollout " +
            "flag unset, so `executionBrokerPhases()` contributes no boot phase at all — the instance stays inert.",
        ],
      };
    }
    return {
      mode: resolved,
      upserts: CLI_MANAGED_EXECUTION_ENV_KEYS.map((key) => ({ key, value: null })),
      settings: executionSettingsRow({ mode: "disabled" }),
      minted,
      notes: [
        "Execution plane disabled: the CLI-managed keys were removed and the settings row set to `disabled`, " +
          "so the boot phase clears any registered executor factory and reports `inert`.",
      ],
    };
  }

  const mint = typeof mintSecret === "function" ? mintSecret : null;
  const need = (supplied, keyName) => {
    if (typeof supplied === "string" && supplied.trim().length > 0) return supplied.trim();
    if (!mint) {
      throw new Error(
        `Execution mode "${resolved}" needs ${keyName} and no value was supplied (and no minter is available).`,
      );
    }
    minted.push(keyName);
    return mint();
  };

  const upserts = [{ key: ROLLOUT_ENV_KEY, value: ROLLOUT_ON }];

  let url;
  if (resolved === "remote") {
    url = validateBrokerUrl(brokerUrl, { required: true });
    if (blankOnly(brokerSecret)) {
      throw new Error(
        `remote execution mode requires the broker's shared carrier secret (--sandbox-broker-secret=…): the app ` +
          `SIGNS every job carrier with ${BROKER_SECRET_ENV_KEY} and the remote broker verifies that signature. ` +
          `A minted-but-mismatched secret would fail closed on every command with no diagnostic.`,
      );
    }
    upserts.push({ key: BROKER_URL_ENV_KEY, value: url });
    upserts.push({ key: BROKER_SECRET_ENV_KEY, value: String(brokerSecret).trim() });
    const image = assertDigestPinnedImage(String(imageRef ?? "").trim() || "", {
      context: "the remote sandbox L0 image",
    });
    upserts.push({ key: L0_IMAGE_ENV_KEY, value: image });
    notes.push(
      "Recorded `remote`. NOTE, from the merged boot phase itself: the remote placement is persisted vocabulary " +
        "but is NOT operable on the instance yet — `executionBrokerPhases()` wires nothing for `remote` and reports " +
        "`unavailable` with that reason. The configuration is correct and inert; it activates when the core's remote " +
        "broker service boundary lands.",
    );
  } else {
    // local-dev
    const origin = typeof appOrigin === "string" && appOrigin.trim() ? appOrigin.trim() : "http://localhost:3000";
    url = validateBrokerUrl(brokerUrl ?? origin, { required: true });
    upserts.push({ key: BROKER_URL_ENV_KEY, value: url });
    upserts.push({ key: BROKER_SECRET_ENV_KEY, value: need(brokerSecret, BROKER_SECRET_ENV_KEY) });
    const image = String(imageRef ?? "").trim() || DEFAULT_L0_IMAGE_LOCAL_DEV;
    assertSafeImageRef(image);
    if (hasLatestTag(image)) {
      throw new Error(
        `Refusing the local-dev sandbox image "${image}": the :latest tag is banned for the execution plane.`,
      );
    }
    upserts.push({ key: L0_IMAGE_ENV_KEY, value: image });
    notes.push(
      "local-dev runs model-authored commands in containers ON THIS MACHINE, under the hardened L0 profile " +
        "(non-root uid 10001, read-only rootfs, cap-drop ALL, no-new-privileges) with egress through the " +
        "attributing gateway.",
    );
  }

  // The SERVICE TOKEN guards the broker's own inbound boundary, so in `remote`
  // it must MATCH the broker's configured value. Minting one locally would
  // produce a token that can never verify — worse than leaving it unset, which
  // at least fails loudly and visibly (Codex convergence finding 3). In
  // `local-dev` the boundary collapses in-process, so a minted token is correct.
  if (resolved === "remote") {
    if (blankOnly(serviceToken)) {
      upserts.push({ key: BROKER_SERVICE_TOKEN_ENV_KEY, value: null });
      notes.push(
        `No ${BROKER_SERVICE_TOKEN_ENV_KEY} was supplied, so none was written: it guards the REMOTE broker's own ` +
          "service boundary and must match that broker's configured value — a locally minted one could never " +
          "verify. Pass --sandbox-broker-token=<the broker's token> when you have it.",
      );
    } else {
      upserts.push({ key: BROKER_SERVICE_TOKEN_ENV_KEY, value: String(serviceToken).trim() });
    }
  } else {
    upserts.push({ key: BROKER_SERVICE_TOKEN_ENV_KEY, value: need(serviceToken, BROKER_SERVICE_TOKEN_ENV_KEY) });
  }
  // The provenance key is a HOST-HELD HMAC key that never leaves this machine
  // (it signs L1 environment-layer provenance), so minting it locally is correct
  // in BOTH placements.
  upserts.push({ key: PROVENANCE_KEY_ENV_KEY, value: need(provenanceKey, PROVENANCE_KEY_ENV_KEY) });
  upserts.push({
    key: SANDBOX_NETWORK_ENV_KEY,
    value: typeof sandboxNetwork === "string" && sandboxNetwork.trim() ? sandboxNetwork.trim() : null,
  });

  for (const u of upserts) if (u.value !== null) assertEnvValueSafe(u.key, u.value);

  return {
    mode: resolved,
    upserts,
    settings: executionSettingsRow({ mode: resolved, egressMode, egressAllowlist }),
    minted,
    notes,
  };
}

/**
 * Redact the userinfo segment from a URL-ish string so a validation
 * error can quote the input without ever printing a credential. Applied to the
 * RAW string (not the parsed URL) because the malformed-input path never gets a
 * parsed URL to read `.password` from.
 */
export function redactUrlCredentials(raw) {
  return String(raw).replace(/(\/\/)[^/@\s]*@/g, "$1***@");
}

/**
 * Validate a broker base URL exactly as `evaluateExecutionPlaneReadiness()`
 * does (parseable + http(s)), plus the CLI's own "a BASE url carries no query
 * or fragment" refinement.
 */
export function validateBrokerUrl(raw, { required = false } = {}) {
  if (blankOrFlagLike(raw)) {
    if (!required) return null;
    throw new Error(
      `A broker URL is required (--sandbox-broker-url=https://…): ${BROKER_URL_ENV_KEY} + ${BROKER_SECRET_ENV_KEY} ` +
        `are what the instance's execution-plane health phase validates, and both-empty means "never opted in".`,
    );
  }
  // A MALFORMED url never reaches the parser's userinfo accessors, so redact
  // any userinfo segment BEFORE echoing it (round-3 finding): an input whose
  // authority ends at the `@` (no host) fails to parse and would otherwise
  // print the password verbatim in the "not a URL" message.
  const shown = redactUrlCredentials(raw);
  let parsed;
  try {
    parsed = new URL(String(raw).trim());
  } catch {
    throw new Error(`Invalid broker URL "${shown}": not a URL.`);
  }
  // Codex convergence finding 6: userinfo in the URL is a credential that would
  // then be echoed verbatim by every reachability diagnostic. The broker's
  // credential is EXECUTION_BROKER_SECRET, never the URL.
  //
  // Checked FIRST, and the URL is NEVER echoed once credentials are present:
  // a later "bad scheme" / "has a query string" error on the same input would
  // otherwise print the password itself (round-2 finding).
  if (parsed.username || parsed.password) {
    throw new Error(
      "Invalid broker URL: a broker BASE url must not embed credentials (user:password@host) — they would be " +
        `printed by the reachability diagnostics. Supply the credential via ${BROKER_SECRET_ENV_KEY} instead.`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid broker URL "${shown}": ${BROKER_URL_ENV_KEY} must be http(s) (got ${parsed.protocol}).`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Invalid broker URL "${shown}": a broker BASE url must not carry a query string or fragment.`);
  }
  return parsed.toString();
}

/**
 * Read the execution-plane ENV posture back out of a parsed `.env.local`.
 * Secrets are reported as booleans ONLY — a value never leaves this function.
 *
 * @param {Record<string,string>} env
 */
export function readExecutionEnv(env = {}) {
  const str = (key) => (typeof env[key] === "string" ? env[key].trim() : "");
  const brokerUrlRaw = str(BROKER_URL_ENV_KEY);
  const secretPresent = str(BROKER_SECRET_ENV_KEY).length > 0;
  return {
    rolloutOn: str(ROLLOUT_ENV_KEY) === ROLLOUT_ON,
    rolloutRaw: str(ROLLOUT_ENV_KEY),
    brokerUrl: brokerUrlRaw || null,
    brokerSecretPresent: secretPresent,
    serviceTokenPresent: str(BROKER_SERVICE_TOKEN_ENV_KEY).length > 0,
    provenanceKeyPresent: str(PROVENANCE_KEY_ENV_KEY).length > 0,
    imageRef: str(L0_IMAGE_ENV_KEY) || null,
    sandboxNetwork: str(SANDBOX_NETWORK_ENV_KEY) || SANDBOX_NETWORK_NAME,
    required: str(EXECUTION_PLANE_REQUIRED_ENV_KEY) === "1",
    // The health phase's own tri-state, mirrored so `doctor` can name the exact
    // state the boot phase will land in.
    clientReadiness: evaluateClientReadiness(brokerUrlRaw, secretPresent ? "set" : ""),
  };
}

/** `evaluateExecutionPlaneReadiness()` mirrored (url + secret-presence only). */
export function evaluateClientReadiness(url, secret) {
  const u = typeof url === "string" ? url.trim() : "";
  const s = typeof secret === "string" ? secret.trim() : "";
  if (u === "" && s === "") return { state: "not-configured" };
  const missing = [];
  if (u === "") missing.push(BROKER_URL_ENV_KEY);
  if (s === "") missing.push(BROKER_SECRET_ENV_KEY);
  if (missing.length > 0) return { state: "misconfigured", reason: `missing ${missing.join(", ")}` };
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return { state: "misconfigured", reason: `${BROKER_URL_ENV_KEY} is not a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { state: "misconfigured", reason: `${BROKER_URL_ENV_KEY} must be http(s) (got ${parsed.protocol})` };
  }
  return { state: "ready" };
}

/** The effective L0 image ref (`resolveL0ImageRef` mirrored). */
export function effectiveImageRef(imageRef) {
  return typeof imageRef === "string" && imageRef.trim().length > 0 ? imageRef.trim() : DEFAULT_L0_IMAGE_LOCAL_DEV;
}

/**
 * Apply `{key,value}` upserts to a raw `.env.local` body. For each key it
 * removes EVERY existing occurrence (a hand-edited duplicate would otherwise
 * survive the disabled purge) and appends one canonical entry when non-null.
 */
export function applyEnvUpsertsToBody(body, upserts) {
  const esc = (k) => String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = typeof body === "string" ? body : "";
  for (const { key, value } of upserts) {
    // Remove EVERY assignment of this key in any dotenv-valid shape a
    // hand-edited file may carry — leading whitespace and the `export ` prefix
    // included (Codex convergence finding 5). Missing one on the `disabled`
    // purge would leave a live secret, or a live ROLLOUT=on, behind.
    out = out.replace(new RegExp(`^[ \t]*(?:export[ \t]+)?${esc(key)}[ \t]*=.*\r?\n?`, "mg"), "");
    if (value !== null && value !== undefined) {
      assertEnvValueSafe(key, value);
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      out += `${key}=${value}\n`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// L0 image lifecycle — acquire / verify / prune
// ---------------------------------------------------------------------------

/**
 * How to acquire the L0 image for a mode:
 *   local-dev → BUILD from the checkout Dockerfile (no registry publishes it).
 *   remote    → PULL the digest-pinned reference so the pin is locally
 *               verifiable (and so `doctor` can compare digests).
 *   disabled  → SKIP.
 */
export function planImageAcquisition({ executionMode, imageRef = null, dockerfileExists = true } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "disabled") {
    return { action: "skip", imageRef: null, reason: "execution mode is disabled — no sandbox image is acquired." };
  }
  if (mode === "remote") {
    const ref = assertDigestPinnedImage(String(imageRef ?? ""), { context: "the remote sandbox L0 image" });
    return { action: "pull", imageRef: ref, reason: "remote mode: pull + verify the digest-pinned L0 image." };
  }
  if (!dockerfileExists) {
    throw new Error(
      `Cannot acquire the local-dev sandbox image: ${L0_DOCKERFILE_REL} is missing from the checkout. ` +
        "Update the instance to a revision that ships the execution-plane L0 Dockerfile, then retry.",
    );
  }
  const ref = imageRef && String(imageRef).trim() ? assertSafeImageRef(String(imageRef).trim()) : DEFAULT_L0_IMAGE_LOCAL_DEV;
  if (hasLatestTag(ref)) {
    throw new Error(`Refusing to build the local-dev sandbox image as "${ref}": the :latest tag is banned.`);
  }
  return { action: "build", imageRef: ref, reason: "local-dev mode: build the L0 image + record its digest pin." };
}

/** `docker build` argv for the local-dev L0 image. */
export function l0BuildArgs({ imageRef, dockerfile, buildContext }) {
  assertSafeImageRef(imageRef);
  return ["build", "-t", imageRef, "-f", String(dockerfile), String(buildContext)];
}

/** `docker pull` argv for a digest-pinned L0 image. */
export function l0PullArgs(imageRef) {
  assertDigestPinnedImage(imageRef, { context: "the sandbox L0 image" });
  return ["pull", imageRef];
}

/** `docker image inspect` argv printing the immutable image Id. */
export function l0DigestInspectArgs(imageRef) {
  assertSafeImageRef(imageRef);
  return ["image", "inspect", imageRef, "--format", "{{.Id}}"];
}

/** `docker image inspect` argv printing the registry RepoDigests (one per line). */
export function l0RepoDigestsInspectArgs(imageRef) {
  assertSafeImageRef(imageRef);
  return ["image", "inspect", imageRef, "--format", "{{range .RepoDigests}}{{println .}}{{end}}"];
}

/** `docker images` argv listing every L0 image (`<id>\t<ref>\t<created-unix>`). */
export function l0ImageListArgs(repo = L0_IMAGE_REPO) {
  assertSafeImageRef(String(repo));
  return ["images", String(repo), "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}", "--no-trunc"];
}

/** `docker image rm` argv. Never `-f`: an image backing a live sandbox must win. */
export function l0RemoveArgs(id) {
  assertSafeImageRef(String(id));
  return ["image", "rm", String(id)];
}

/** Parse a `{{.Id}}` inspect output into `sha256:<hex>`, or null. */
export function parseInspectedDigest(stdout) {
  if (typeof stdout !== "string") return null;
  const first = stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = first.match(/sha256:[0-9a-f]{64}/);
  return m ? m[0] : null;
}

/** Parse a RepoDigests inspect output into an array of `name@sha256:…` refs. */
export function parseRepoDigests(stdout) {
  if (typeof stdout !== "string") return [];
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => SHA256_DIGEST_RE.test(l));
}

/** Parse `docker images --format "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}"`. */
export function parseImageList(stdout) {
  if (typeof stdout !== "string") return [];
  const out = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, ref, createdAt] = trimmed.split("\t");
    if (!id) continue;
    out.push({ id: id.trim(), ref: (ref ?? "").trim(), createdAt: (createdAt ?? "").trim() });
  }
  return out;
}

/**
 * Decide which L0 images are SUPERSEDED and may be pruned.
 *
 * KEEP, always: the image the current configuration resolves to (by id AND by
 * ref), anything dangling that a running container still uses (docker refuses
 * those anyway, but we never even ask), and — fail-closed — everything when the
 * keep target is unknown, since pruning "all but nothing" would delete the very
 * image an in-flight sandbox is running.
 *
 * @param {{ images: Array<{id:string,ref:string}>, keepDigest?: string|null,
 *           keepRef?: string|null, inUseIds?: string[] }} input
 * @returns {{ remove: Array<{id:string,ref:string}>, keep: Array<{id:string,ref:string}>, reason: string }}
 */
export function planImagePrune({ images = [], keepDigest = null, keepRef = null, inUseIds = [] } = {}) {
  const list = Array.isArray(images) ? images.filter((i) => i && typeof i.id === "string") : [];
  if (!keepDigest && !keepRef) {
    return {
      remove: [],
      keep: list,
      reason:
        "no current L0 image could be resolved, so nothing is pruned (fail-closed: pruning without a keep target " +
        "could remove the image an in-flight sandbox is running).",
    };
  }
  const inUse = new Set((inUseIds ?? []).map((i) => String(i)));
  const keep = [];
  const remove = [];
  for (const img of list) {
    const isKeep =
      (keepDigest && img.id === keepDigest) ||
      (keepRef && img.ref === keepRef) ||
      inUse.has(img.id);
    (isKeep ? keep : remove).push(img);
  }
  return {
    remove,
    keep,
    reason:
      remove.length === 0
        ? "no superseded L0 images — the only image present is the one this instance is configured to run."
        : `${remove.length} superseded L0 image(s) can be reaped; the configured image (and any image backing a running container) is kept.`,
  };
}

/**
 * The `docker run` argv that mirrors the BOOT HANDSHAKE.
 *
 * The boot phase's handshake opens a real broker job and dispatches
 * `HANDSHAKE_COMMAND` through `LocalDevSandboxWorker`, which builds its argv
 * with `buildHardenedRunArgs` (l0-profile.ts). The CLI cannot open a broker job
 * (that needs the app's process + DB), so it reproduces the load-bearing half:
 * the same image, the same hardened flags, the same command, the same expected
 * stdout. `--network none` is used deliberately — the handshake command performs
 * no network I/O, so a gateway-less probe still answers the question the boot
 * handshake asks ("can this worker run a command on this image at all").
 */
export function handshakeProbeRunArgs({ imageRef, name = null } = {}) {
  assertSafeImageRef(imageRef);
  return [
    "run",
    "--rm",
    "--init",
    ...(name ? ["--name", String(name)] : []),
    "--user",
    `${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    "none",
    "--tmpfs",
    "/tmp:rw,size=16m",
    "--",
    imageRef,
    "bash",
    "-c",
    HANDSHAKE_COMMAND,
  ];
}

/**
 * The boot handshake's ACCEPTANCE predicate, mirrored verbatim:
 * `termination === "exited" && exitCode === 0 && stdout.trim() === expected`.
 *
 * @param {{ ran?: boolean, exitCode?: number|null, stdout?: string, timedOut?: boolean }} probe
 * @returns {{ ok: boolean, reason: string }}
 */
export function evaluateHandshakeProbe({ ran = false, exitCode = null, stdout = "", timedOut = false } = {}) {
  if (timedOut) {
    return { ok: false, reason: "the handshake command did not complete on a live worker (termination=timeout)" };
  }
  if (!ran) {
    return { ok: false, reason: "the handshake command could not be dispatched (docker unavailable or image missing)" };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      reason: `the handshake command did not complete on a live worker (termination=exited, exit=${String(exitCode)})`,
    };
  }
  if (String(stdout ?? "").trim() !== HANDSHAKE_EXPECTED_STDOUT) {
    return {
      ok: false,
      reason: "the handshake command produced unexpected output — the worker is not running the expected sandbox",
    };
  }
  return { ok: true, reason: "handshake completed: the probe container ran on the L0 image and returned the expected output" };
}

/** `docker network inspect` argv printing whether the sandbox network is internal. */
export function networkInternalInspectArgs(name = SANDBOX_NETWORK_NAME) {
  return ["network", "inspect", String(name), "--format", "{{.Internal}}"];
}

/** `docker ps` argv testing whether a named container is running. */
export function containerRunningArgs(name) {
  return ["ps", "--filter", `name=^/${String(name)}$`, "--format", "{{.Names}}"];
}

/** `docker volume ls` argv listing the L2 workspace volumes. */
export function workspaceVolumeLsArgs() {
  return ["volume", "ls", "--filter", `label=${WORKSPACE_LABEL}=l2`, "--format", "{{.Name}}"];
}

// ---------------------------------------------------------------------------
// Doctor classifiers — the five execution checks, each with an ACTIONABLE message
// ---------------------------------------------------------------------------

function check(id, label, verdict, detail, remediation = null) {
  return { id, label, verdict, detail, remediation };
}

/**
 * CHECK 1 — MODE DETECTION.
 *
 * The mode lives in the settings row, the rollout flag lives in env, and the
 * boot phase needs BOTH. Every way that pair can be wrong gets its own message,
 * because "nothing happens" is the failure signature of all of them.
 */
export function classifyExecutionModeCheck({
  mode = DEFAULT_EXECUTION_MODE,
  rolloutOn = false,
  rolloutRaw = "",
  settingsReadable = true,
  clientReadiness = { state: "not-configured" },
  provenanceKeyPresent = false,
  required = false,
} = {}) {
  const id = "execution-mode";
  const label = "Execution mode";

  if (!settingsReadable) {
    return check(
      id,
      label,
      "degraded",
      "the instance's execution-plane settings row could not be read, so the mode the boot phase will see is unknown.",
      "Start the database (`cinatra instance start`) and re-run; the row lives in the platform metadata store under " +
        `\`${EXECUTION_SETTINGS_METADATA_KEY}\`.`,
    );
  }

  if (mode === "disabled") {
    if (rolloutOn) {
      return check(
        id,
        label,
        "degraded",
        "the rollout flag is ON but the persisted mode is `disabled` — the boot phase runs, wires nothing, and " +
          "reports `inert`. Nothing will ever execute.",
        `Run \`cinatra instance execution set-mode local-dev\` (or \`remote\`), or clear ${ROLLOUT_ENV_KEY} from ` +
          ".env.local to make the instance fully inert.",
      );
    }
    return check(
      id,
      label,
      "disabled",
      "the execution plane is disabled: the mode is `disabled` and the rollout flag is unset, so the boot " +
        "orchestrator contributes no execution phase at all. Models stay fully usable.",
    );
  }

  if (!rolloutOn) {
    return check(
      id,
      label,
      "degraded",
      `mode \`${mode}\` is persisted but ${ROLLOUT_ENV_KEY} is ${rolloutRaw ? `"${rolloutRaw}"` : "unset"} — only the ` +
        'exact string "on" enables the plane, so the boot orchestrator contributes NO execution phase and the mode ' +
        "is never read.",
      `Set ${ROLLOUT_ENV_KEY}=on in .env.local (\`cinatra instance execution set-mode ${mode}\` writes it for you), then restart.`,
    );
  }

  // `not-configured` (BOTH url and secret empty) is the state the core reads as
  // "this instance never opted into the execution plane": readiness resolves
  // `disabled` and every declared-environment run refuses — no matter what the
  // settings row says (Codex convergence finding 8).
  if (clientReadiness.state === "not-configured" && !required) {
    return check(
      id,
      label,
      "degraded",
      `mode \`${mode}\` is persisted with the rollout on, but neither ${BROKER_URL_ENV_KEY} nor ` +
        `${BROKER_SECRET_ENV_KEY} is set — the instance reads as "never opted into the execution plane", so ` +
        "readiness resolves `disabled` and every declared-environment run refuses.",
      `Run \`cinatra instance execution set-mode ${mode}\` to write both.`,
    );
  }

  if (clientReadiness.state === "misconfigured" || clientReadiness.state === "not-configured") {
    const reason = clientReadiness.reason ?? `missing ${BROKER_URL_ENV_KEY}, ${BROKER_SECRET_ENV_KEY}`;
    return check(
      id,
      label,
      "degraded",
      `mode \`${mode}\` with the rollout on, but the execution-plane client config is incomplete: ${reason}. ` +
        `The health boot phase fails${required ? " and this instance class declares the plane REQUIRED, so the boot is deploy-blocked" : ""}.`,
      `Set both ${BROKER_URL_ENV_KEY} and ${BROKER_SECRET_ENV_KEY} — re-run \`cinatra instance execution set-mode ${mode}\`.`,
    );
  }

  // The provenance key is the OTHER hard precondition for a `ready` plane:
  // absent, readiness is `unavailable` and every declared-environment run
  // refuses, even with a perfect broker config and a completed handshake
  // (Codex convergence finding 1).
  if (!provenanceKeyPresent) {
    return check(
      id,
      label,
      "degraded",
      `mode \`${mode}\` is configured, but ${PROVENANCE_KEY_ENV_KEY} is not set. Environment readiness resolves ` +
        "`unavailable` on that alone, so every declared-environment run refuses no matter how healthy the rest looks.",
      `Run \`cinatra instance execution set-mode ${mode}\` — it mints and writes the key (a host-held HMAC key that ` +
        "never enters a container).",
    );
  }

  if (mode === "remote") {
    return check(
      id,
      label,
      "degraded",
      "mode `remote` is persisted and configured, but the instance's own boot phase reports remote as NOT OPERABLE " +
        "yet — it wires nothing and reports `unavailable` with that reason. This is the core's stated state, not a " +
        "misconfiguration on this host.",
      "Nothing to fix here: the configuration activates when the core's remote broker service boundary ships. Use " +
        "`local-dev` if you need sandbox execution on this instance today.",
    );
  }

  return check(
    id,
    label,
    "healthy",
    "mode `local-dev` with the rollout flag on and the client config complete — the boot phase will attempt the " +
      "broker↔worker handshake.",
  );
}

/**
 * CHECK 2 — BROKER REACHABILITY.
 *
 * `remote`: a live probe of the configured URL. `local-dev`: the broker is
 * in-process, so the reachability question is "is the app process up" — the
 * same process that owns the broker.
 */
export function classifyBrokerReachability({
  mode = DEFAULT_EXECUTION_MODE,
  brokerUrl = null,
  brokerSecretPresent = false,
  reachable = null,
} = {}) {
  const id = "broker-reachability";
  const label = "Broker reachability";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — there is no broker to reach.");
  }
  if (!brokerUrl) {
    return check(
      id,
      label,
      "degraded",
      `${BROKER_URL_ENV_KEY} is not set, so the instance reads as "never opted into the execution plane" and every ` +
        "declared-environment run refuses.",
      `Run \`cinatra instance execution set-mode ${mode}\` to write ${BROKER_URL_ENV_KEY} + ${BROKER_SECRET_ENV_KEY}.`,
    );
  }
  if (!brokerSecretPresent) {
    return check(
      id,
      label,
      "degraded",
      `${BROKER_SECRET_ENV_KEY} is not set: the app cannot SEAL a job carrier, so the plane reports itself ` +
        "unavailable before any command is dispatched.",
      `Run \`cinatra instance execution set-mode ${mode}\`; for \`remote\` supply the broker's own shared secret with ` +
        "--sandbox-broker-secret (a mismatched secret fails closed on every command).",
    );
  }
  if (mode === "remote") {
    // The write path refuses a credential-bearing URL, but `.env.local` can be
    // hand-edited — so redact on DISPLAY too rather than trusting the writer.
    const shownUrl = redactUrlCredentials(brokerUrl);
    if (reachable === true) {
      return check(id, label, "healthy", `the configured broker at ${shownUrl} answered a health request.`);
    }
    return check(
      id,
      label,
      "degraded",
      reachable === false
        ? `the configured broker at ${shownUrl} did not answer (connection refused, DNS failure, or a non-2xx status).`
        : `the configured broker at ${shownUrl} could not be probed.`,
      "Confirm the broker service is up and the URL/port are reachable from this host, then re-run. Until it " +
        "answers, no sandbox command can be dispatched.",
    );
  }
  // local-dev: the broker is constructed inside the app process.
  if (reachable === true) {
    return check(
      id,
      label,
      "healthy",
      "the local-dev broker is in-process and its host app is up — the boot phase constructed it during this run.",
    );
  }
  return check(
    id,
    label,
    "degraded",
    reachable === false
      ? "the app is not running, so the in-process local-dev broker does not exist right now."
      : "the app could not be probed, so the in-process local-dev broker's state is unknown.",
    "Start the instance (`cinatra instance start`) and re-run; the broker is constructed by the app's boot phase, " +
      "not by a separate service.",
  );
}

/**
 * CHECK 3 — HANDSHAKE STATUS, mirroring the boot probe's semantics.
 *
 * The boot phase registers the executor factory ONLY when a real container ran
 * `printf cinatra-exec-handshake` over the L0 image and returned exit 0 with
 * `termination: "exited"` and exactly that stdout. This check runs the same
 * probe and applies the same predicate, so a green here is the same claim.
 */
export function classifyHandshakeStatus({
  mode = DEFAULT_EXECUTION_MODE,
  imagePresent = false,
  probe = null,
  imageDigest = null,
  wallMs = null,
} = {}) {
  const id = "handshake";
  const label = "Broker↔worker handshake";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — the boot phase runs no handshake.");
  }
  if (mode === "remote") {
    return check(
      id,
      label,
      "degraded",
      "the handshake is run by the remote worker placement and is not reproducible from this host (and the core's " +
        "boot phase does not run one for `remote` at all — it wires nothing in that mode today).",
      "Verify the handshake on the broker deployment. `local-dev` is the placement whose handshake this CLI can prove.",
    );
  }
  if (!imagePresent) {
    return check(
      id,
      label,
      "degraded",
      "the L0 image is not present, so the handshake cannot run: the boot phase would report the plane " +
        "`unavailable` and register no executor.",
      "Acquire the image with `cinatra instance execution image pull`, then re-run.",
    );
  }
  const verdict = probe && probe.ok === true;
  if (!verdict) {
    return check(
      id,
      label,
      "degraded",
      `the handshake probe FAILED — ${probe && probe.reason ? probe.reason : "no probe result"}. This is exactly the ` +
        "condition under which the boot phase registers nothing and every execution keeps refusing (fail-closed).",
      "Confirm Docker is running and the L0 image is intact (`cinatra instance execution image verify`); rebuild " +
        "with `cinatra instance execution image pull --rebuild` if the probe still fails.",
    );
  }
  const digestNote = imageDigest ? ` over image ${imageDigest.slice(0, 19)}…` : "";
  const timing = typeof wallMs === "number" ? ` in ${wallMs} ms` : "";
  // HONEST SCOPE (Codex convergence finding 2). The CLI cannot open a real
  // broker job — that needs the app process, a sealed session carrier and the
  // run store. What it CAN do, and does, is dispatch the boot phase's exact
  // probe command over the same image under the same hardened profile and judge
  // it by the boot phase's exact predicate. So a green here proves the WORKER
  // half; it does not prove the gateway bring-up, the service-token boundary or
  // that a factory was actually registered. The instance's own health surface
  // remains the authority on that, and the other checks cover those inputs.
  return check(
    id,
    label,
    "healthy",
    `the probe completed${timing}${digestNote} and returned the expected output, judged by the boot phase's own ` +
      "predicate (exited, exit 0, exact stdout). This proves the WORKER half of the handshake — the image runs " +
      "commands under the hardened profile. Whether the boot phase then registered an executor also depends on the " +
      "gateway + config checks above; the instance's health surface is the authority once it is running.",
  );
}

/**
 * CHECK 4 — L0 IMAGE PRESENCE, BY DIGEST (as boot logs it).
 *
 * Boot logs `handshake.imageDigest`, the digest the worker RESOLVED for the
 * image it actually ran. This check resolves the same digest locally and, when
 * the CLI recorded a pin at acquisition time, reports drift from it.
 */
export function classifyL0Image({
  mode = DEFAULT_EXECUTION_MODE,
  imageRef = null,
  resolvedDigest = null,
  recordedDigest = null,
  repoDigests = [],
} = {}) {
  const id = "l0-image";
  const label = "L0 sandbox image";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no sandbox image is provisioned on this host.");
  }
  const ref = effectiveImageRef(imageRef);
  if (hasLatestTag(ref)) {
    return check(
      id,
      label,
      "degraded",
      `the configured L0 image "${ref}" carries the mutable :latest tag, which the execution plane bans — a run's ` +
        "recorded digest would not identify a reproducible image.",
      `Set ${L0_IMAGE_ENV_KEY} to an immutable reference (name@sha256:<64-hex> for remote; a dev tag for local-dev).`,
    );
  }
  if (mode === "remote" && !isDigestPinned(ref)) {
    return check(
      id,
      label,
      "degraded",
      `remote mode requires a digest-pinned L0 image; "${ref}" is a floating reference.`,
      `Set ${L0_IMAGE_ENV_KEY}=name@sha256:<64-hex> (\`cinatra instance execution set-mode remote --sandbox-image=…\`).`,
    );
  }
  if (!resolvedDigest) {
    return check(
      id,
      label,
      "degraded",
      `the L0 image "${ref}" is NOT present on this host — \`docker image inspect\` resolves no digest for it.`,
      mode === "remote"
        ? "Pull it with `cinatra instance execution image pull` so the pin is locally verifiable."
        : "Build it with `cinatra instance execution image pull` (local-dev builds from the checkout's docker/sandbox/Dockerfile).",
    );
  }
  if (recordedDigest && recordedDigest !== resolvedDigest) {
    return check(
      id,
      label,
      "degraded",
      `the present image digest DRIFTED from the pin recorded at acquisition (recorded ${recordedDigest.slice(0, 19)}…, ` +
        `present ${resolvedDigest.slice(0, 19)}…) — the sandbox would run different code than was verified.`,
      "Re-acquire + re-record with `cinatra instance execution image pull --rebuild`, or `image verify` to inspect.",
    );
  }
  const pinNote = isDigestPinned(ref)
    ? ""
    : repoDigests.length > 0
      ? ` (registry digest ${repoDigests[0].replace(/^.*@/, "").slice(0, 19)}…)`
      : " (locally built — no registry digest)";
  return check(
    id,
    label,
    "healthy",
    `"${ref}" is present and resolves to ${resolvedDigest.slice(0, 19)}…${pinNote}${
      recordedDigest ? ", matching the recorded pin" : ""
    }.`,
  );
}

/**
 * CHECK 5 — GATEWAY CONTAINER STATE.
 *
 * `constructLocalDevExecutionBroker` starts the attributing gateway BEFORE the
 * broker for every egress tier except `none`, and returns `ok:false` ("egress
 * gateway did not start") when it cannot — so a missing gateway is precisely a
 * plane that never wires.
 */
export function classifyGatewayContainer({
  mode = DEFAULT_EXECUTION_MODE,
  egressMode = DEFAULT_EGRESS_MODE,
  networkExists = false,
  networkInternal = false,
  gatewayRunning = null,
  gatewayHealthy = null,
  appRunning = null,
  sandboxNetwork = SANDBOX_NETWORK_NAME,
} = {}) {
  const id = "gateway-container";
  // Name the network the doctor ACTUALLY inspected, not the default — an
  // instance may set EXECUTION_SANDBOX_NETWORK (round-2 finding).
  const network = typeof sandboxNetwork === "string" && sandboxNetwork.trim() ? sandboxNetwork.trim() : SANDBOX_NETWORK_NAME;
  const label = "Egress gateway container";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no gateway is provisioned.");
  }
  if (mode === "remote") {
    return check(
      id,
      label,
      "degraded",
      "the attributing gateway runs beside the remote worker, not on this host, so its state is not observable from here.",
      "Verify the gateway on the broker deployment; the CLI can only prove the `local-dev` gateway.",
    );
  }
  if (egressMode === "none") {
    return check(
      id,
      label,
      "healthy",
      "egress tier `none` — sandboxes run with `--network none` (kernel-level deny), so no gateway is started by design.",
    );
  }
  if (gatewayRunning === true) {
    if (gatewayHealthy === true) {
      // A running gateway with NO internal network is not a working placement:
      // the broker attaches every sandbox to that network, so its absence means
      // the next job cannot start (Codex convergence finding 7). A leftover
      // healthy gateway must not mask it.
      if (!networkExists) {
        return check(
          id,
          label,
          "degraded",
          `\`${GATEWAY_CONTAINER_NAME}\` is running and healthy, but the internal sandbox network ` +
            `"${network}" does not exist — every sandbox job attaches to that network, so the ` +
            "placement cannot actually run a command (this is typically a gateway left over from an earlier run).",
          "Restart the instance so the boot phase recreates the network and re-attaches the gateway.",
        );
      }
      const netNote = networkInternal
        ? "; the internal no-NAT network is in place"
        : "; WARNING: the sandbox network is present but NOT internal";
      if (networkExists && !networkInternal) {
        return check(
          id,
          label,
          "degraded",
          `the gateway container \`${GATEWAY_CONTAINER_NAME}\` is running and healthy, but the "${network}" ` +
            "network is NOT internal — a sandbox on it would hold a direct NAT route around the gateway.",
          `Remove the network (\`docker network rm ${network}\`) so the next bring-up recreates it \`--internal\`.`,
        );
      }
      return check(
        id,
        label,
        "healthy",
        `\`${GATEWAY_CONTAINER_NAME}\` is running and answered ${GATEWAY_HEALTH_PATH}${netNote} — egress tier \`${egressMode}\` is attributed.`,
      );
    }
    return check(
      id,
      label,
      "degraded",
      `\`${GATEWAY_CONTAINER_NAME}\` is running but ${
        gatewayHealthy === false ? `did not answer ${GATEWAY_HEALTH_PATH}` : "its health could not be probed"
      } — the boot phase treats a gateway that does not become healthy as a failure to start and wires nothing.`,
      `Inspect it with \`docker logs ${GATEWAY_CONTAINER_NAME}\`, then restart the instance to re-run the bring-up.`,
    );
  }
  // Not running.
  if (appRunning === false) {
    return check(
      id,
      label,
      "degraded",
      `\`${GATEWAY_CONTAINER_NAME}\` is not running because the instance is not running — the gateway is brought up by ` +
        "the app's boot phase, not as a standalone service.",
      "Start the instance (`cinatra instance start`); the gateway comes up with it for any egress tier other than `none`.",
    );
  }
  return check(
    id,
    label,
    "degraded",
    `\`${GATEWAY_CONTAINER_NAME}\` is NOT running while the instance is up and the egress tier is \`${egressMode}\`. The ` +
      "boot phase returns `egress gateway did not start` in that case, so nothing was wired and every execution refuses.",
    `Check \`docker logs ${GATEWAY_CONTAINER_NAME}\` (it may have exited) and the instance's boot log for the ` +
      "`execution-broker` phase reason, then restart the instance.",
  );
}

/** Roll up checks into counts + an overall verdict. */
export function summarizeExecutionDoctor(checks = []) {
  const counts = { healthy: 0, degraded: 0, disabled: 0 };
  for (const c of checks) {
    if (counts[c.verdict] === undefined) counts[c.verdict] = 0;
    counts[c.verdict] += 1;
  }
  let overall;
  if (counts.degraded > 0) overall = "degraded";
  else if (counts.healthy === 0 && counts.disabled > 0) overall = "disabled";
  else overall = "healthy";
  return { counts, overall };
}

// ---------------------------------------------------------------------------
// Update coordination
// ---------------------------------------------------------------------------

/** Extract the semver MAJOR of a version string, or null. */
export function versionMajor(version) {
  if (typeof version !== "string") return null;
  const m = version.trim().replace(/^v/i, "").match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * Protocol compatibility across app / broker / worker. In `local-dev` all three
 * run from one checkout and are locked by construction; `remote` uses the
 * deployed `@cinatra-ai/execution-plane` major as the protocol proxy. A missing
 * version is reported as INCOMPATIBLE (fail-honest), never silently compatible.
 */
export function checkProtocolCompatibility({ appVersion = null, brokerVersion = null, workerVersion = null } = {}) {
  const majors = [versionMajor(appVersion), versionMajor(brokerVersion), versionMajor(workerVersion)];
  const known = majors.filter((m) => m !== null);
  if (known.length === 0) {
    return { compatible: false, majors, detail: "no component reported a parseable execution-plane version." };
  }
  const first = known[0];
  const allSame = known.every((m) => m === first);
  if (majors.some((m) => m === null)) {
    return {
      compatible: false,
      majors,
      detail:
        "cannot confirm compatibility — a component did not report a parseable execution-plane version " +
        `(known majors ${known.join("/")} ${allSame ? "match" : "DIFFER"}); treating as INCOMPATIBLE (fail-honest).`,
    };
  }
  return {
    compatible: allSame,
    majors,
    detail: allSame ? `all components on protocol major ${first}.` : `protocol majors DIFFER (app/broker/worker = ${majors.join("/")}).`,
  };
}

/** The ordered rolling-update coordination for the execution plane. */
export function planUpdateCoordination({ executionMode } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "disabled") {
    return { steps: [], rollback: [], notes: ["execution mode is disabled — no execution-plane coordination is needed."] };
  }
  if (mode === "remote") {
    return {
      steps: [
        "Confirm protocol compatibility (same execution-plane major across app / broker / worker) before starting.",
        "Drain: stop admitting new sandbox jobs on the broker; let open jobs finish or hit their per-command timeout.",
        "Roll the WORKERS to the new digest-pinned L0 image FIRST (a worker speaks the new protocol before the app emits it).",
        "Roll the BROKER.",
        "Roll the APP LAST, then resume admitting jobs.",
      ],
      rollback: [
        "Re-drain the broker.",
        "Roll the APP back to the previous release.",
        "Roll the BROKER + WORKERS back to the previous digest-pinned image.",
        "Resume admitting jobs.",
      ],
      notes: ["The broker/worker roll + drain is executed in the deployment layer; this CLI documents + checks the order."],
    };
  }
  return {
    steps: [
      "Drain: stop the local app so no new sandbox jobs are admitted (in-flight containers are per-command and short-lived).",
      "Reconcile the checkout: `cinatra instance refresh` (rebuilds deps, dev DB, AND the L0 sandbox image so worker + app move together).",
      "Restart the app: `cinatra instance start` — the boot phase re-runs the broker↔worker handshake before wiring anything.",
    ],
    rollback: [
      "Stop the app.",
      "Move the checkout back (`cinatra update --instance --ref <previous>`), then `cinatra instance refresh` to rebuild the matching L0 image.",
      "Restart the app.",
    ],
    notes: ["local-dev runs app + broker + worker from one checkout, so a refresh keeps all three on the same version."],
  };
}

/** Production execution-plane update guidance lines. */
export function prodExecutionUpdateGuidanceLines({ indent = "    " } = {}) {
  return [
    `${indent}Execution plane (sandboxed model execution) is part of the deployment layer, not this checkout:`,
    `${indent}  - Update the L0 sandbox image by DIGEST (${L0_IMAGE_ENV_KEY}=name@sha256:… — never :latest).`,
    `${indent}  - Drain in-flight sandbox jobs, then roll the WORKERS before the APP (a worker must speak the new`,
    `${indent}    protocol before the app emits it); keep a reverse rollback path.`,
    `${indent}  - The broker/worker services are provisioned + rolled by the ops deployment lifecycle, not the CLI.`,
  ];
}

export const __test = {
  MODE_ALIASES,
  blankOrFlagLike,
  check,
  BARE_DIGEST_RE,
};
