// Pure, side-effect-free decision helpers for the CLI execution-plane lifecycle
// (cinatra-cli#160 — exec-plane S4; epic cinatra-ai/cinatra#1705, S1 #1706).
//
// The execution plane is the core-owned sandboxed executor every LLM invocation
// can reach (`sandbox_execute`). S1 shipped its runtime surface in the cinatra
// monorepo — the broker + local-dev worker, the hardened L0 run profile, the
// digest-pinned L0 base image (`docker/sandbox/Dockerfile`), and the attributing
// egress gateway (all in `@cinatra-ai/execution-plane`). S4 is the CLI LIFECYCLE
// layer over that surface: an install execution-mode picker, image acquisition
// as a first-class install step (digest-pinned — no `:latest`), update
// coordination, and the `sandbox` doctor/verbs.
//
// As with `update-target.mjs` / `dev-refresh.mjs` / `prod-runtime-guidance.mjs`,
// this module is PURE (no imports, no I/O): the flow orchestration (docker build,
// probes, `.env.local` writes) lives in `index.mjs` / `install.mjs` where the
// process/fs helpers are; the decision + argv-shape logic that is worth testing
// in isolation lives HERE so it unit-tests without a docker daemon.
//
// GROUNDING NOTE (S1 live surface vs app wiring). The execution-plane PACKAGE is
// live (broker/worker/L0-image/egress). The APP wiring S1 lists as later slices
// — the HTTP/mTLS broker service boundary, the durable jobs/audit DB tables, the
// platform-admin settings surface, the health-view boot phase, and a runtime
// protocol-version endpoint — is NOT yet live (see
// `packages/execution-plane/src/index.ts`). So every check that would depend on
// a not-yet-live app surface (a remote broker's health/version endpoint, a
// durable audit sink) is classified honestly as `degraded` with a manual-verify
// remediation rather than fabricated as `healthy`. The checks that ARE live —
// building the real L0 image, running the real hardened profile, inspecting the
// real internal egress network — are exercised for real.

// ---------------------------------------------------------------------------
// Contract constants — mirrored (not imported: this is a plain .mjs CLI with no
// TS path aliases into packages/**) from the S1 surface. Each cites its source.
// ---------------------------------------------------------------------------

/** The three install-time execution modes (cinatra-cli#160 scope). */
export const EXECUTION_MODES = Object.freeze(["remote", "local-dev", "disabled"]);

/** CLI-managed `.env.local` key recording the chosen execution mode. */
export const EXECUTION_MODE_ENV_KEY = "CINATRA_EXECUTION_MODE";

/** S1 rollout merge gate (packages/llm/src/execution-plane/policy.ts): only the
 *  exact string "on" enables capability injection; anything else stays dark. */
export const ROLLOUT_ENV_KEY = "CINATRA_EXECUTION_PLANE_ROLLOUT";
export const ROLLOUT_ON = "on";

/** S1 image override (packages/execution-plane/src/l0-profile.ts): production
 *  sets this to a DIGEST-PINNED reference; unset falls back to the local-dev tag. */
export const L0_IMAGE_ENV_KEY = "CINATRA_SANDBOX_L0_IMAGE";

/** CLI-recorded resolved digest of the acquired L0 image ("digest pins
 *  recorded", AC4) — the local-dev build has no registry RepoDigest, so the
 *  recorded pin is the immutable image ID, exactly what the S1 worker attributes. */
export const L0_IMAGE_DIGEST_ENV_KEY = "CINATRA_SANDBOX_L0_IMAGE_DIGEST";

/** Remote broker base URL (S4 CLI-managed; the S1 HTTP boundary is a later slice). */
export const BROKER_URL_ENV_KEY = "CINATRA_EXECUTION_BROKER_URL";

/** Configured egress tier (S1 EgressMode: default_internet | allowlist | none). */
export const EGRESS_MODE_ENV_KEY = "CINATRA_SANDBOX_EGRESS_MODE";
export const EGRESS_MODES = Object.freeze(["default_internet", "allowlist", "none"]);
export const DEFAULT_EGRESS_MODE = "default_internet";

/** S1 local-dev image tag (l0-profile.ts DEFAULT_L0_IMAGE_LOCAL_DEV). A dev tag,
 *  NOT `:latest` — the acquisition step records its resolved digest as the pin. */
export const DEFAULT_L0_IMAGE_LOCAL_DEV = "cinatra-sandbox-l0:dev";

/** S1 build recipe location (docker/sandbox/Dockerfile), relative to the checkout. */
export const L0_DOCKERFILE_REL = "docker/sandbox/Dockerfile";
export const L0_BUILD_CONTEXT_REL = "docker/sandbox";

/** The RETIRED openai-connector shell image (built as `:latest` by the old
 *  setup.sh / reset paths). The CLI-managed sandbox image path must never
 *  reference it again (AC4: "no `:latest` reference remains"). */
export const DEPRECATED_SHELL_IMAGE = "cinatra/skill-shell:latest";

/** S1 hardened runtime identity (l0-profile.ts SANDBOX_RUNTIME_UID/GID). */
export const SANDBOX_RUNTIME_UID = 10001;
export const SANDBOX_RUNTIME_GID = 10001;

/** S1 egress topology (egress.ts DEFAULT_SANDBOX_NETWORK; local-gateway.ts). */
export const SANDBOX_NETWORK_NAME = "cinatra-exec-internal";
export const GATEWAY_CONTAINER_NAME = "cinatra-exec-gateway";
export const GATEWAY_PROXY_PORT = 3128;
export const GATEWAY_ADMIN_PORT = 3129;
export const GATEWAY_HEALTH_PATH = "/__health";

/** S1 workspace volume prefix/label (workspace.ts) — for the `sandbox gc` verb. */
export const WORKSPACE_VOLUME_PREFIX = "cinatra-exec-l2-";
export const WORKSPACE_LABEL = "ai.cinatra.execution-plane";

/** The three CLI sandbox-doctor verdicts (AC3: "healthy / degraded / disabled"). */
export const SANDBOX_VERDICTS = Object.freeze(["healthy", "degraded", "disabled"]);

// ---------------------------------------------------------------------------
// Execution-mode parsing + resolution (mirrors update-target.mjs)
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
 * Normalize a raw execution-mode token to one of {@link EXECUTION_MODES}.
 * Accepts a small set of intuitive aliases; throws loudly on anything else so a
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
        `(remote = a broker URL + digest-pinned image; local-dev = build + run the ` +
        `sandbox on this dev machine; disabled = no sandbox, models stay usable).`,
    );
  }
  return canonical;
}

/**
 * The default execution mode implied by an INSTALL mode when the operator does
 * not pass `--execution-mode`:
 *   - dev / demo → `local-dev` (the sandbox runs on the dev machine).
 *   - prod       → `remote` (prod hands the execution stack to the deployment
 *                  layer + a broker; a prod host never runs the dev worker).
 *
 * @param {"dev"|"prod"|"demo"|string} installMode
 * @returns {"remote"|"local-dev"}
 */
export function defaultExecutionModeForInstall(installMode) {
  const m = typeof installMode === "string" ? installMode.trim().toLowerCase() : "";
  if (m === "prod" || m === "production") return "remote";
  return "local-dev";
}

// A broker/image value must not look like a flag (leading dash) or carry
// whitespace — both would smuggle option injection into a later docker/curl call.
function looksLikeFlagOrBlank(value) {
  return typeof value !== "string" || value.trim().length === 0 || value.trim().startsWith("-");
}

/**
 * Parse the execution-plane install flags out of an argv (order-independent;
 * only the execution flags are consumed, everything else is ignored so this can
 * run alongside the main install parser):
 *   --execution-mode=<remote|local-dev|disabled>   (also `--execution-mode v`)
 *   --sandbox-broker-url=<url>   (remote)
 *   --sandbox-image=<ref>        (remote: a digest-pinned L0 reference)
 *   --sandbox-egress=<default_internet|allowlist|none>
 * Returns nulls for anything absent; validates the egress enum eagerly.
 *
 * @param {string[]} argv
 * @returns {{ mode: string|null, brokerUrl: string|null, imageRef: string|null, egressMode: string|null }}
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

  const brokerUrl = read("--sandbox-broker-url");
  const imageRef = read("--sandbox-image");

  const rawEgress = read("--sandbox-egress");
  let egressMode = null;
  if (rawEgress != null) {
    const e = rawEgress.trim().toLowerCase();
    if (!EGRESS_MODES.includes(e)) {
      throw new Error(`Invalid --sandbox-egress "${rawEgress}". Use one of: ${EGRESS_MODES.join(", ")}.`);
    }
    egressMode = e;
  }

  return { mode, brokerUrl, imageRef, egressMode };
}

/**
 * Resolve the EFFECTIVE execution mode from an explicit flag + the install mode
 * + the TTY signal (mirrors resolveUpdatePath in update-target.mjs):
 *   - an explicit `--execution-mode` always wins (interactive: false);
 *   - no flag + a TTY → present the picker (interactive: true), defaulting the
 *     highlighted choice to the install-mode default;
 *   - no flag + NO TTY → take the install-mode default silently (interactive: false)
 *     so scripted / CI installs never hang on a prompt.
 *
 * @returns {{ mode: string, interactive: boolean, default: string, reason: string }}
 */
export function resolveExecutionModeForInstall({ installMode = "dev", flagMode = null, isTty = false } = {}) {
  const fallback = defaultExecutionModeForInstall(installMode);
  if (flagMode != null) {
    return { mode: normalizeExecutionMode(flagMode), interactive: false, default: fallback, reason: "--execution-mode flag" };
  }
  if (isTty) {
    return { mode: fallback, interactive: true, default: fallback, reason: `interactive picker (default: ${fallback})` };
  }
  return { mode: fallback, interactive: false, default: fallback, reason: `non-interactive default for --mode ${installMode}` };
}

// ---------------------------------------------------------------------------
// Image reference safety — kill `:latest`, require digest pins (AC4)
// ---------------------------------------------------------------------------

const SHA256_DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/**
 * S1's l0-profile.ts assertSafeImageRef, mirrored: reject an image reference
 * docker could parse as an OPTION (leading non-alphanumeric) or that carries
 * characters outside the image-ref charset. Deployment/dev-controlled, never
 * model-controlled — cheap defense-in-depth against option injection.
 *
 * @param {string} ref
 * @returns {string} the same ref (for chaining)
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

/** True when `ref` carries the mutable `:latest` tag (case-insensitive). */
export function hasLatestTag(ref) {
  if (typeof ref !== "string") return false;
  // Ignore any digest suffix; inspect the tag part after the final `:` that is
  // not inside the digest.
  const withoutDigest = ref.replace(SHA256_DIGEST_RE, "");
  return /:latest$/i.test(withoutDigest);
}

/**
 * Enforce the AC4 image contract for a reference the CLI-managed sandbox path
 * will USE at runtime (remote/prod): it must be `@sha256:`-pinned and must not
 * carry `:latest`. Throws an actionable error otherwise.
 *
 * @param {string} ref
 * @param {{ context?: string }} [opts]
 * @returns {string}
 */
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
      `Refusing ${context} reference "${ref}": it is not digest-pinned. ` +
        `A remote/prod L0 image must be pinned by digest (name@sha256:<64-hex>) so the running image is immutable + attributable.`,
    );
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Remote broker config validation
// ---------------------------------------------------------------------------

/**
 * Validate the config a `remote` execution mode needs: a broker base URL and a
 * digest-pinned L0 image reference. Returns the normalized values or throws with
 * an actionable message. Pure — no network (the health CHECK is a separate
 * orchestration step; this only validates SHAPE before any I/O).
 *
 * @param {{ brokerUrl?: string|null, imageRef?: string|null }} cfg
 * @returns {{ brokerUrl: string, imageRef: string }}
 */
export function validateRemoteConfig({ brokerUrl, imageRef } = {}) {
  if (looksLikeFlagOrBlank(brokerUrl)) {
    throw new Error(
      "remote execution mode requires a broker URL (--sandbox-broker-url=https://…): the URL of the execution " +
        "broker this instance dispatches sandbox jobs to.",
    );
  }
  let parsed;
  try {
    parsed = new URL(brokerUrl.trim());
  } catch {
    throw new Error(`Invalid --sandbox-broker-url "${brokerUrl}": not a URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Invalid --sandbox-broker-url "${brokerUrl}": use an http(s) URL.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`Invalid --sandbox-broker-url "${brokerUrl}": a broker BASE URL must not carry a query string or fragment.`);
  }
  if (looksLikeFlagOrBlank(imageRef)) {
    throw new Error(
      "remote execution mode requires a digest-pinned L0 image (--sandbox-image=name@sha256:…): a remote worker " +
        "runs commands over an immutable, attributable image, never a floating tag.",
    );
  }
  const image = assertDigestPinnedImage(imageRef.trim(), { context: "the remote sandbox L0 image" });
  return { brokerUrl: parsed.toString(), imageRef: image };
}

/** The broker health probe URL for a given base (mirrors the gateway `/__health`
 *  convention; the broker HTTP boundary itself is a later S1 slice, so a probe
 *  failure is reported honestly, not as a hard install error). */
export function brokerHealthUrl(brokerUrl) {
  const u = new URL(String(brokerUrl));
  u.search = "";
  u.hash = "";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/health`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Image acquisition plan + pure docker argv builders
// ---------------------------------------------------------------------------

/**
 * Decide how to acquire the L0 image for a given execution mode:
 *   - local-dev → BUILD from docker/sandbox/Dockerfile, tag `cinatra-sandbox-l0:dev`,
 *     then RECORD the resolved digest (the built image Id).
 *   - remote    → VERIFY the digest-pinned reference (pull it so the pin is
 *     present + resolvable locally for the doctor digest-match check).
 *   - disabled  → SKIP (no sandbox image on this host).
 *
 * @param {{ executionMode: string, imageRef?: string|null, dockerfileExists?: boolean }} args
 * @returns {{ action: "build"|"pull"|"skip", imageRef: string|null, reason: string }}
 */
export function planImageAcquisition({ executionMode, imageRef = null, dockerfileExists = true } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "disabled") {
    return { action: "skip", imageRef: null, reason: "execution mode is disabled — no sandbox image is acquired (models stay usable)." };
  }
  if (mode === "remote") {
    const ref = assertDigestPinnedImage(String(imageRef ?? ""), { context: "the remote sandbox L0 image" });
    return { action: "pull", imageRef: ref, reason: "remote mode: pull + verify the digest-pinned L0 image." };
  }
  // local-dev
  if (!dockerfileExists) {
    throw new Error(
      `Cannot acquire the local-dev sandbox image: ${L0_DOCKERFILE_REL} is missing from the checkout. ` +
        "Update the instance to a revision that ships the execution-plane L0 Dockerfile, then retry.",
    );
  }
  const ref = imageRef && imageRef.trim().length > 0 ? assertSafeImageRef(imageRef.trim()) : DEFAULT_L0_IMAGE_LOCAL_DEV;
  if (hasLatestTag(ref)) {
    throw new Error(`Refusing to build the local-dev sandbox image as "${ref}": the :latest tag is banned; use a dev tag + recorded digest.`);
  }
  return { action: "build", imageRef: ref, reason: "local-dev mode: build the L0 image from the checkout Dockerfile + record its digest." };
}

/** `docker build` argv (without the leading `docker`) for the local-dev L0 image.
 *  `-f <dockerfile>` + explicit context so it is unambiguous. */
export function l0BuildArgs({ imageRef, dockerfile, buildContext }) {
  assertSafeImageRef(imageRef);
  return ["build", "-t", imageRef, "-f", String(dockerfile), String(buildContext)];
}

/** `docker pull` argv for a digest-pinned remote L0 image. */
export function l0PullArgs(imageRef) {
  assertDigestPinnedImage(imageRef, { context: "the remote sandbox L0 image" });
  return ["pull", imageRef];
}

/** `docker image inspect` argv that prints the immutable image Id (the recorded
 *  digest for a local-dev build). */
export function l0DigestInspectArgs(imageRef) {
  assertSafeImageRef(imageRef);
  return ["image", "inspect", imageRef, "--format", "{{.Id}}"];
}

/**
 * Parse the `{{.Id}}` inspect output into a normalized `sha256:<hex>` digest, or
 * null when the image is absent / the output is unrecognizable.
 *
 * @param {string|null|undefined} stdout
 * @returns {string|null}
 */
export function parseInspectedDigest(stdout) {
  if (typeof stdout !== "string") return null;
  const first = stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = first.match(/sha256:[0-9a-f]{64}/);
  return m ? m[0] : null;
}

/**
 * The minimal hardened `docker run` argv the CLI doctor uses to EXERCISE the S1
 * hardened profile for one probe command. Mirrors the load-bearing flags of
 * l0-profile.ts buildHardenedRunArgs (non-root fixed UID, read-only rootfs,
 * cap-drop ALL, no-new-privileges, `--network none`, tmpfs /tmp, `--` argv
 * terminator). This is NOT a substitute for the worker's full profile — it is a
 * self-check that the image can run under the hardened contract at all.
 *
 * @param {{ imageRef: string, command: string, name?: string }} args
 * @returns {string[]}
 */
export function hardenedProbeRunArgs({ imageRef, command, name }) {
  assertSafeImageRef(imageRef);
  const args = [
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
    String(command),
  ];
  return args;
}

/** `docker network inspect` argv printing whether the sandbox network is internal. */
export function networkInternalInspectArgs(name = SANDBOX_NETWORK_NAME) {
  return ["network", "inspect", String(name), "--format", "{{.Internal}}"];
}

/** `docker ps` argv testing whether a named container is running (prints its name). */
export function containerRunningArgs(name) {
  return ["ps", "--filter", `name=^/${String(name)}$`, "--format", "{{.Names}}"];
}

/** `docker volume ls` argv listing the L2 workspace volumes (for `sandbox gc`). */
export function workspaceVolumeLsArgs() {
  return ["volume", "ls", "--filter", `label=${WORKSPACE_LABEL}=l2`, "--format", "{{.Name}}"];
}

// ---------------------------------------------------------------------------
// `.env.local` execution-plane configuration
// ---------------------------------------------------------------------------

/**
 * The ordered set of `.env.local` key/value upserts that persist a resolved
 * execution-plane configuration. The caller upserts each with its own
 * `upsertEnvKey`. Mode-specific:
 *   - local-dev → rollout ON; egress mode; recorded image digest (no
 *     CINATRA_SANDBOX_L0_IMAGE, so the worker falls back to the :dev tag).
 *   - remote    → rollout ON; egress mode; the digest-pinned CINATRA_SANDBOX_L0_IMAGE
 *     + the broker URL.
 *   - disabled  → mode only; rollout stays absent (dark → the capability is not
 *     injected → models stay usable). Any stale image/broker keys are CLEARED.
 *
 * A key with `value: null` means "remove this key if present".
 *
 * @param {{ executionMode: string, imageRef?: string|null, imageDigest?: string|null, brokerUrl?: string|null, egressMode?: string|null }} cfg
 * @returns {Array<{ key: string, value: string|null }>}
 */
export function executionEnvUpserts({ executionMode, imageRef = null, imageDigest = null, brokerUrl = null, egressMode = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const egress = egressMode ?? DEFAULT_EGRESS_MODE;
  const upserts = [{ key: EXECUTION_MODE_ENV_KEY, value: mode }];

  if (mode === "disabled") {
    // Fail-safe: leave the capability dark and clear any stale provisioning.
    upserts.push({ key: ROLLOUT_ENV_KEY, value: null });
    upserts.push({ key: L0_IMAGE_ENV_KEY, value: null });
    upserts.push({ key: L0_IMAGE_DIGEST_ENV_KEY, value: null });
    upserts.push({ key: BROKER_URL_ENV_KEY, value: null });
    upserts.push({ key: EGRESS_MODE_ENV_KEY, value: null });
    return upserts;
  }

  upserts.push({ key: ROLLOUT_ENV_KEY, value: ROLLOUT_ON });
  upserts.push({ key: EGRESS_MODE_ENV_KEY, value: egress });

  if (mode === "remote") {
    const image = assertDigestPinnedImage(String(imageRef ?? ""), { context: "the remote sandbox L0 image" });
    upserts.push({ key: L0_IMAGE_ENV_KEY, value: image });
    upserts.push({ key: BROKER_URL_ENV_KEY, value: String(brokerUrl ?? "") });
    // A remote instance does not run a local worker, so no locally-recorded digest.
    upserts.push({ key: L0_IMAGE_DIGEST_ENV_KEY, value: null });
    return upserts;
  }

  // local-dev
  if (imageDigest) {
    if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
      throw new Error(`Refusing to record a malformed L0 image digest "${imageDigest}" (expected sha256:<64-hex>).`);
    }
    upserts.push({ key: L0_IMAGE_DIGEST_ENV_KEY, value: imageDigest });
  }
  // local-dev uses the :dev tag via the worker's fallback — leave CINATRA_SANDBOX_L0_IMAGE
  // + the broker URL unset.
  upserts.push({ key: L0_IMAGE_ENV_KEY, value: null });
  upserts.push({ key: BROKER_URL_ENV_KEY, value: null });
  return upserts;
}

/**
 * Read the resolved execution configuration back out of a parsed `.env.local`
 * (or process env) map. `mode` falls back to `disabled` when unset (fail-safe:
 * an instance with no execution config exposes no sandbox). Pure.
 *
 * @param {Record<string,string>} env
 * @returns {{ mode: string, rolloutOn: boolean, imageRef: string|null, imageDigest: string|null, brokerUrl: string|null, egressMode: string }}
 */
export function readExecutionConfig(env = {}) {
  const rawMode = typeof env[EXECUTION_MODE_ENV_KEY] === "string" ? env[EXECUTION_MODE_ENV_KEY].trim() : "";
  let mode = "disabled";
  if (rawMode) {
    try {
      mode = normalizeExecutionMode(rawMode);
    } catch {
      mode = "disabled";
    }
  }
  const imageRef = typeof env[L0_IMAGE_ENV_KEY] === "string" && env[L0_IMAGE_ENV_KEY].trim() ? env[L0_IMAGE_ENV_KEY].trim() : null;
  const imageDigest =
    typeof env[L0_IMAGE_DIGEST_ENV_KEY] === "string" && env[L0_IMAGE_DIGEST_ENV_KEY].trim() ? env[L0_IMAGE_DIGEST_ENV_KEY].trim() : null;
  const brokerUrl = typeof env[BROKER_URL_ENV_KEY] === "string" && env[BROKER_URL_ENV_KEY].trim() ? env[BROKER_URL_ENV_KEY].trim() : null;
  const rawEgress = typeof env[EGRESS_MODE_ENV_KEY] === "string" ? env[EGRESS_MODE_ENV_KEY].trim().toLowerCase() : "";
  const egressMode = EGRESS_MODES.includes(rawEgress) ? rawEgress : DEFAULT_EGRESS_MODE;
  const rolloutOn = (typeof env[ROLLOUT_ENV_KEY] === "string" ? env[ROLLOUT_ENV_KEY].trim() : "") === ROLLOUT_ON;
  return { mode, rolloutOn, imageRef, imageDigest, brokerUrl, egressMode };
}

/**
 * The effective L0 image reference to inspect/run for a config (mirrors S1
 * resolveL0ImageRef): an explicit CINATRA_SANDBOX_L0_IMAGE wins, else the
 * local-dev :dev tag.
 *
 * @param {{ imageRef: string|null }} cfg
 * @returns {string}
 */
export function effectiveImageRef(cfg = {}) {
  return cfg.imageRef && String(cfg.imageRef).trim().length > 0 ? String(cfg.imageRef).trim() : DEFAULT_L0_IMAGE_LOCAL_DEV;
}

// ---------------------------------------------------------------------------
// Sandbox doctor classifiers (pure — take probe results, return a verdict)
// ---------------------------------------------------------------------------

function check(id, label, verdict, detail, remediation = null) {
  return { id, label, verdict, detail, remediation };
}

/**
 * Worker health. local-dev: the L0 image is present AND a hardened probe run
 * succeeds. remote: the broker health probe answered ok. disabled: reported as
 * `disabled`, never a failure.
 */
export function classifyWorkerHealth({ executionMode, imagePresent = false, probeOk = false, probeDetail = "", brokerReachable = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const id = "worker-health";
  const label = "Sandbox worker health";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no worker to check (models stay usable).");
  }
  if (mode === "remote") {
    if (brokerReachable === true) return check(id, label, "healthy", "remote broker answered its health probe.");
    return check(
      id,
      label,
      "degraded",
      brokerReachable === false
        ? "remote broker did not answer its health probe."
        : "remote broker health could not be probed (the broker HTTP surface is a later S1 slice).",
      "Verify the broker URL + that the broker service is reachable; the app's execution health surface is the authority once wired.",
    );
  }
  // local-dev
  if (!imagePresent) {
    return check(id, label, "degraded", "the local-dev L0 image is not built.", "Run `cinatra instance sandbox build` (or `cinatra instance refresh`) to build it.");
  }
  if (!probeOk) {
    return check(id, label, "degraded", `the L0 image did not run a hardened probe command${probeDetail ? ` (${probeDetail})` : ""}.`, "Check Docker is running and rebuild with `cinatra instance sandbox build`.");
  }
  return check(id, label, "healthy", "the L0 image runs a hardened probe command end-to-end.");
}

/** Image digest match: the resolved image digest matches the recorded pin. */
export function classifyImageDigestMatch({ executionMode, imageRef = null, recordedDigest = null, resolvedDigest = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const id = "image-digest";
  const label = "L0 image digest pin";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no image pin to verify.");
  }
  if (mode === "remote") {
    if (imageRef && !isDigestPinned(imageRef)) {
      return check(id, label, "degraded", `the configured L0 image "${imageRef}" is not digest-pinned.`, "Set CINATRA_SANDBOX_L0_IMAGE to a name@sha256:… reference (no :latest).");
    }
    if (!resolvedDigest) {
      return check(id, label, "degraded", "the digest-pinned image is not present locally to verify.", "Pull it with `cinatra instance sandbox build` (remote mode pulls the pin).");
    }
    return check(id, label, "healthy", `the pinned image is present and resolves to ${resolvedDigest.slice(0, 19)}….`);
  }
  // local-dev
  if (!resolvedDigest) {
    return check(id, label, "degraded", "the local-dev L0 image is not built, so no digest is resolvable.", "Run `cinatra instance sandbox build`.");
  }
  if (!recordedDigest) {
    return check(id, label, "degraded", "no image digest was recorded at install/build time.", "Rebuild with `cinatra instance sandbox build` to record the digest pin.");
  }
  if (recordedDigest !== resolvedDigest) {
    return check(
      id,
      label,
      "degraded",
      `the built image digest drifted from the recorded pin (recorded ${recordedDigest.slice(0, 19)}…, present ${resolvedDigest.slice(0, 19)}…).`,
      "Rebuild + re-record with `cinatra instance sandbox build`.",
    );
  }
  return check(id, label, "healthy", `the built image matches the recorded pin (${resolvedDigest.slice(0, 19)}…).`);
}

/** Egress enforcement: the internal (no-NAT) network exists + the gateway is
 *  live for a gateway mode; `none` is enforced at the kernel with no gateway. */
export function classifyEgressEnforcement({ executionMode, egressMode = DEFAULT_EGRESS_MODE, networkExists = false, networkInternal = false, gatewayRunning = null, gatewayHealthy = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const id = "egress-enforcement";
  const label = "Egress enforcement";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no egress surface.");
  }
  if (mode === "remote") {
    return check(id, label, "degraded", "egress is enforced in the remote deployment layer, not locally verifiable from the CLI.", "Verify egress policy on the remote broker/deployment; the app health surface is the authority once wired.");
  }
  // local-dev
  if (egressMode === "none") {
    return check(id, label, "healthy", "egress mode is `none` — the sandbox runs with `--network none` (kernel-level deny, no gateway needed).");
  }
  if (!networkExists) {
    return check(id, label, "degraded", "the internal sandbox network does not exist yet.", "It is created on first sandbox job / gateway bring-up; run a sandbox job or `cinatra instance sandbox build`.");
  }
  if (!networkInternal) {
    return check(id, label, "degraded", `the "${SANDBOX_NETWORK_NAME}" network exists but is NOT internal (it would grant a direct NAT route).`, "Remove the non-internal network so it is recreated `--internal`.");
  }
  if (gatewayRunning !== true) {
    return check(
      id,
      label,
      "degraded",
      gatewayRunning === false
        ? "the internal network is in place but the attributing egress gateway is not running."
        : "the internal network is in place but the egress gateway state was not verified.",
      "The gateway starts with the first gateway-mode sandbox job; a persistent gateway is a deployment concern.",
    );
  }
  if (gatewayHealthy !== true) {
    return check(
      id,
      label,
      "degraded",
      gatewayHealthy === false
        ? "the egress gateway is running but did not answer its health probe."
        : "the egress gateway is running but its health was not verified from the CLI.",
      "Confirm the gateway admin health endpoint is reachable.",
    );
  }
  return check(id, label, "healthy", `the internal no-NAT network is in place; the health-checked attributing gateway enforces egress (${egressMode}).`);
}

/** Isolation mode: the hardened profile is in effect (non-root fixed UID,
 *  read-only rootfs, no-new-privileges), proven by a probe run. */
export function classifyIsolationMode({ executionMode, uid = null, readOnlyRootfs = null, noNewPrivileges = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const id = "isolation-mode";
  const label = "Sandbox isolation (hardened container)";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no sandbox to isolate.");
  }
  if (mode === "remote") {
    return check(id, label, "degraded", "isolation is enforced by the remote worker placement, not locally verifiable from the CLI.", "The remote worker applies the same hardened run profile; verify on the deployment.");
  }
  if (uid === null && readOnlyRootfs === null && noNewPrivileges === null) {
    return check(id, label, "degraded", "the isolation probe could not run (Docker down or image missing).", "Ensure Docker is running and the L0 image is built.");
  }
  // Fail-honest: EVERY hardened property must be explicitly proven true. A null
  // (unverified) property degrades — never fails open to "healthy".
  const problems = [];
  if (uid !== SANDBOX_RUNTIME_UID) problems.push(uid === null ? "runtime uid not verified" : `runs as uid ${uid} (expected ${SANDBOX_RUNTIME_UID})`);
  if (readOnlyRootfs !== true) problems.push(readOnlyRootfs === null ? "read-only rootfs not verified" : "rootfs is writable (expected read-only)");
  if (noNewPrivileges !== true) problems.push(noNewPrivileges === null ? "no-new-privileges not verified" : "no-new-privileges is not in effect");
  if (problems.length > 0) {
    return check(id, label, "degraded", `the hardened profile is not fully proven: ${problems.join("; ")}.`, "Rebuild the L0 image; the worker applies --user/--read-only/--cap-drop/--no-new-privileges per dispatch.");
  }
  return check(id, label, "healthy", `the hardened profile holds: non-root uid ${SANDBOX_RUNTIME_UID}, read-only rootfs, no-new-privileges.`);
}

/** Audit sink reachability. The durable audit DB is a later S1 slice, so this is
 *  honest: local-dev uses the app-embedded in-process sink (reachable when the
 *  app is up); remote probes the broker; disabled has no sink. */
export function classifyAuditSink({ executionMode, appReachable = null, brokerReachable = null } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  const id = "audit-sink";
  const label = "Audit sink reachability";
  if (mode === "disabled") {
    return check(id, label, "disabled", "execution mode is disabled — no commands to audit.");
  }
  if (mode === "remote") {
    if (brokerReachable === true) return check(id, label, "healthy", "the remote broker (audit emitter) is reachable.");
    return check(id, label, "degraded", "the remote broker (audit emitter) is not reachable / not probeable.", "Verify the broker; the durable audit DB surface is a later S1 slice.");
  }
  // local-dev: the audit sink is the app-embedded host-injected sink.
  if (appReachable === true) return check(id, label, "healthy", "the app is up — the in-process audit sink receives every command record.");
  if (appReachable === false) return check(id, label, "degraded", "the app is not running, so the in-process audit sink cannot be exercised.", "Start the app (`cinatra instance start`), then re-run the sandbox doctor.");
  return check(id, label, "degraded", "the audit sink could not be probed.", "Start the app, then re-run the sandbox doctor.");
}

/** Roll up an array of sandbox-doctor checks into counts + an overall verdict.
 *  Overall is `degraded` if ANY check is degraded, else `disabled` if ALL are
 *  disabled, else `healthy`. */
export function summarizeSandboxDoctor(checks = []) {
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
// Update coordination (protocol compatibility + rolling order + rollback)
// ---------------------------------------------------------------------------

/** Extract the semver MAJOR of a version string, or null when unparseable. */
export function versionMajor(version) {
  if (typeof version !== "string") return null;
  const m = version.trim().replace(/^v/i, "").match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

/**
 * Protocol compatibility across app / broker / worker for an update. The
 * execution plane has no runtime protocol-version endpoint yet (a later S1
 * slice), so the CLI uses the deployed `@cinatra-ai/execution-plane` package
 * version's MAJOR as the protocol proxy: same major ⇒ wire-compatible. In
 * local-dev all three run from one checkout, so they are inherently locked and
 * this returns compatible. A missing/unparseable version is reported honestly
 * (not silently "compatible").
 *
 * @param {{ appVersion?: string|null, brokerVersion?: string|null, workerVersion?: string|null }} v
 * @returns {{ compatible: boolean, majors: (number|null)[], detail: string }}
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
        `cannot confirm compatibility — a component did not report a parseable execution-plane version ` +
        `(known majors ${known.join("/")} ${allSame ? "match" : "DIFFER"}); treating as INCOMPATIBLE (fail-honest) — follow the coordination order.`,
    };
  }
  return {
    compatible: allSame,
    majors,
    detail: allSame ? `all components on protocol major ${first}.` : `protocol majors DIFFER (app/broker/worker = ${majors.join("/")}).`,
  };
}

/**
 * The ordered rolling-update coordination for the execution plane. The invariant
 * (epic + AC2): DRAIN in-flight sandbox jobs, roll WORKERS before the APP, and
 * keep a reverse ROLLBACK path. local-dev collapses to a single-checkout restart
 * but still surfaces the ordering so the mental model transfers to prod.
 *
 * @param {{ executionMode: string }} args
 * @returns {{ steps: string[], rollback: string[], notes: string[] }}
 */
export function planUpdateCoordination({ executionMode } = {}) {
  const mode = normalizeExecutionMode(executionMode);
  if (mode === "disabled") {
    return { steps: [], rollback: [], notes: ["execution mode is disabled — no execution-plane coordination is needed for this update."] };
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
      notes: ["The broker/worker roll + drain is executed in the deployment layer; this CLI documents + checks the order (prod hands the stack to the deployment layer)."],
    };
  }
  // local-dev
  return {
    steps: [
      "Drain: stop the local app so no new sandbox jobs are admitted (in-flight containers are per-command and short-lived).",
      "Reconcile the checkout: `cinatra instance refresh` (rebuilds deps, dev DB, AND the L0 sandbox image so worker + app move together).",
      "Restart the app: `cinatra instance start` — app, broker, and worker all run from the one refreshed checkout, so they are protocol-locked by construction.",
    ],
    rollback: [
      "Stop the app.",
      "Move the checkout back (`cinatra update --instance --ref <previous>`), then `cinatra instance refresh` to rebuild the matching L0 image.",
      "Restart the app.",
    ],
    notes: ["local-dev runs app + broker + worker from one checkout, so a refresh keeps all three on the same execution-plane version automatically."],
  };
}

/**
 * Production execution-plane update guidance (extends the base production-runtime
 * guidance): the execution stack is handed to the deployment layer, updated by
 * moving to a release image, drained + rolled workers-before-app with a
 * digest-pinned L0 image. Returns printable lines (no surrounding blank lines).
 *
 * @param {{ indent?: string }} [opts]
 * @returns {string[]}
 */
export function prodExecutionUpdateGuidanceLines({ indent = "    " } = {}) {
  return [
    `${indent}Execution plane (sandboxed model execution) is part of the deployment layer, not this checkout:`,
    `${indent}  - Update the L0 sandbox image by DIGEST (CINATRA_SANDBOX_L0_IMAGE=name@sha256:… — never :latest).`,
    `${indent}  - Drain in-flight sandbox jobs, then roll the WORKERS before the APP (a worker must speak the new`,
    `${indent}    protocol before the app emits it); keep a reverse rollback path.`,
    `${indent}  - The broker/worker services are provisioned + rolled by the ops deployment lifecycle, not the CLI.`,
  ];
}

/**
 * Apply a set of {key,value} upserts to a raw `.env.local` body and return the
 * new body. Pure. For each key it REMOVES EVERY existing occurrence (guarding a
 * hand-edited file with duplicate keys — critical for the disabled/rollout-dark
 * guarantee) and, when value is non-null, appends ONE canonical entry. A
 * value of null just removes the key entirely.
 *
 * @param {string} body
 * @param {Array<{ key: string, value: string|null }>} upserts
 * @returns {string}
 */
export function applyEnvUpsertsToBody(body, upserts) {
  const esc = (k) => String(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = typeof body === "string" ? body : "";
  for (const { key, value } of upserts) {
    // Remove ALL existing lines for this key (global + multiline).
    out = out.replace(new RegExp(`^${esc(key)}=.*\r?\n?`, "mg"), "");
    if (value !== null) {
      if (out.length > 0 && !out.endsWith("\n")) out += "\n";
      out += `${key}=${value}\n`;
    }
  }
  return out;
}

export const __test = {
  MODE_ALIASES,
  looksLikeFlagOrBlank,
  check,
};
