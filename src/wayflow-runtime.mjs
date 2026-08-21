// WayFlow agent-runtime provisioning for `cinatra install` (cinatra#2654).
//
// WHY THIS MODULE EXISTS
// ----------------------
// The `wayflow` compose service is profile-gated (`profiles: [wayflow, drupal,
// wordpress]`) and the install bring-up activated NO profile. A fresh install
// therefore had nothing on :3010 and EVERY agent run died with ECONNREFUSED.
// The owner ruling is: every install mode that OWNS a local compose stack
// starts WayFlow by default, with `--no-wayflow` as the opt-out; an install
// that does NOT own a local stack (external infra, co-use, --no-infra) says so
// explicitly instead of implying a runtime it never started.
//
// The profile stays in `docker-compose.yml`. It IS the opt-out mechanism: the
// orchestration decides whether to activate it. Nothing here removes or
// rewrites a compose file.
//
// The pure decision + text helpers live here (hermetically testable), together
// with the two side-effecting steps that must run BEFORE the compose `up`:
//   1. the narrow bridge-token env file (`gen-wayflow-env.mjs`), and
//   2. the local image build (the service has no registry image).

import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from "node:fs";

/** The compose service name AND the compose profile that gates it. */
export const WAYFLOW_SERVICE = "wayflow";
export const WAYFLOW_PROFILE = "wayflow";

/** WayFlow's DEFAULT published host port — where an install that allocated no
 *  band (the default plan) reaches its runtime. Mirrors instance-alloc.mjs
 *  DEFAULT_WAYFLOW_PORT; this module stays import-light (node builtins only) by
 *  design, so the value is restated rather than imported. */
export const DEFAULT_WAYFLOW_PORT = 3010;

/** The `.env.local` key that records what THIS install decided about the
 *  WayFlow runtime, so `cinatra doctor` can tell an intentional opt-out apart
 *  from a runtime that should be up and is not. */
export const WAYFLOW_RUNTIME_KEY = "CINATRA_WAYFLOW_RUNTIME";

/** local    — this install owns a local stack and starts WayFlow in it.
 *  off      — deliberately lean install; the operator passed --no-wayflow.
 *  external — this install owns no local stack (external/co-use/--no-infra),
 *             so it neither owns nor starts a local WayFlow runtime. */
export const WAYFLOW_RUNTIME_LOCAL = "local";
export const WAYFLOW_RUNTIME_OFF = "off";
export const WAYFLOW_RUNTIME_EXTERNAL = "external";

const VALID_RUNTIME_MODES = new Set([
  WAYFLOW_RUNTIME_LOCAL,
  WAYFLOW_RUNTIME_OFF,
  WAYFLOW_RUNTIME_EXTERNAL,
]);

/** The infra plans whose install OWNS the local compose stack it started. Only
 *  those can truthfully promise a local WayFlow container. */
const LOCAL_STACK_PLANS = new Set(["default", "isolated", "attach"]);

/**
 * Decide the runtime mode this install run must record and act on.
 *
 * @param {{ infraPlan: string, wayflow?: boolean }} args
 *   `infraPlan` is the resolved plan (`default` | `isolated` | `attach` |
 *   `external` | `co-use`); `wayflow` is false when `--no-wayflow` was passed.
 * @returns {"local"|"off"|"external"}
 */
export function resolveWayflowRuntimeMode({ infraPlan, wayflow = true } = {}) {
  if (!LOCAL_STACK_PLANS.has(infraPlan)) return WAYFLOW_RUNTIME_EXTERNAL;
  return wayflow === false ? WAYFLOW_RUNTIME_OFF : WAYFLOW_RUNTIME_LOCAL;
}

/** Normalize a recorded `.env.local` value; an unknown/absent value falls back
 *  to `local` — default-on is the contract, so an install predating this key is
 *  read as "should have a runtime" rather than silently excused. */
export function normalizeWayflowRuntimeMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  return VALID_RUNTIME_MODES.has(value) ? value : WAYFLOW_RUNTIME_LOCAL;
}

/**
 * The operator-facing status lines for the WayFlow runtime, printed by the
 * install tail. Every mode says something explicit — the ruling forbids a
 * silent "nothing happened" on the paths that own no local runtime.
 *
 * @returns {string[]}
 */
export function wayflowStatusLines(mode, { endpoint = `http://localhost:${DEFAULT_WAYFLOW_PORT}` } = {}) {
  if (mode === WAYFLOW_RUNTIME_OFF) {
    return [
      "  Agent runtime: NOT started — intentional opt-out (--no-wayflow).",
      "                 Agent runs fail with ECONNREFUSED until you start it:",
      "                 `cinatra instance wayflow start`.",
    ];
  }
  if (mode === WAYFLOW_RUNTIME_EXTERNAL) {
    return [
      "  Agent runtime: NOT owned by this install — it starts no local WayFlow container.",
      "                 Point WAYFLOW_BASE_URL at the runtime you operate, or install",
      "                 with an install-owned local stack to get one.",
    ];
  }
  return [`  Agent runtime: WayFlow started with the stack (${endpoint}).`];
}

/** The narrow, generated container env the `wayflow` service reads through its
 *  compose `env_file` (`required: false`). Path is repo-relative — it lives
 *  INSIDE the checkout the install owns, next to the compose file that
 *  references it. */
export const WAYFLOW_ENV_FILE = path.join("docker", "wayflow", ".wayflow.env");

/** The one key whose absence crash-loops the runtime ("[agent_loader] FATAL:
 *  CINATRA_BRIDGE_TOKEN is unset or empty … Refusing to start."). */
export const WAYFLOW_BRIDGE_TOKEN_KEY = "CINATRA_BRIDGE_TOKEN";

// cinatra#2654 D1 — the generator postcondition is graded, and each tier says
// why it is the tier it is. `gen-wayflow-env.mjs` derives this file from
// `.env.local`; a file that is missing keys is a BROKEN GENERATOR RUN, not an
// operator choice, so the check is on the file rather than on the exit code.
//
//   REQUIRED  — the install must not proceed without these. Both are minted
//               unconditionally into `.env.local` for EVERY mode by
//               ensureEnvLocal, so a generated file lacking one cannot be a
//               legitimate configuration; and each disables the runtime:
//               CINATRA_BRIDGE_TOKEN makes the loader refuse to start at all,
//               CINATRA_CONTEXT_ATTEST_KEY makes the app fail CLOSED on the
//               composed-child context path (a runtime that starts and then
//               rejects every context callback).
//   EXPECTED  — warn, do not block. WAYFLOW_BASE_URL is the runtime's own
//               self-URL; the container has a compose-level default and an
//               instance whose file predates the key still runs, so an install
//               that would otherwise succeed is not worth failing. Naming it is
//               what makes a stale generator visible.
//   OPTIONAL  — never checked. OPENAI_API_KEY is legitimately unset on a fresh
//               install (it is carried empty from `.env.example`).

/** Keys whose absence from the generated file ABORTS the install. */
export const WAYFLOW_ENV_REQUIRED_KEYS = ["CINATRA_BRIDGE_TOKEN", "CINATRA_CONTEXT_ATTEST_KEY"];
/** Keys whose absence is reported but not fatal. */
export const WAYFLOW_ENV_EXPECTED_KEYS = ["WAYFLOW_BASE_URL"];

/**
 * The NON-EMPTY keys ANY narrow env file supplies, or null when it is absent /
 * unreadable. Key NAMES only — never a value, and nothing here is logged.
 *
 * cinatra#2654 D1 (round 3). This is the generic form of the wayflow-only reader
 * below, and it is what lets the PRODUCTION wiring invariant reason about the
 * checkout's OTHER narrow env files (`docker/nango/.nango.env`,
 * `docker/graphiti/.graphiti.env`, `docker/plane-mcp/.plane-mcp.env`) instead of
 * only wayflow's. The parse is `scripts/gen-wayflow-env.mjs`'s own dotenv shape,
 * which every one of those generators writes.
 *
 * @returns {Set<string>|null}
 */
export function envFileSuppliedKeys(absPath, { readImpl = nodeReadFileSync } = {}) {
  let body;
  try {
    body = String(readImpl(absPath, "utf8"));
  } catch {
    return null;
  }
  const supplied = new Set();
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    if (match[2].replace(/^["']|["']$/g, "").trim() !== "") supplied.add(match[1]);
  }
  return supplied;
}

/**
 * Parse the narrow generated env file and report WHICH of the keys the runtime
 * needs it actually supplies with a non-empty value. This is the POSTCONDITION
 * of the generator, checked independently of it: the install may only promise a
 * runtime once the wiring actually reached the file the container reads.
 *
 * Parsing mirrors `scripts/gen-wayflow-env.mjs`'s own dotenv regex (same shape,
 * same quote stripping) so the two never disagree about what "supplied" means.
 * Returns key NAMES only — never a value, and nothing here is logged.
 *
 * @returns {{ exists: boolean, supplied: Set<string>, missingRequired: string[], missingExpected: string[] }}
 */
export function inspectWayflowEnvFile({ targetDir, readImpl = nodeReadFileSync } = {}) {
  const read = envFileSuppliedKeys(path.join(targetDir, WAYFLOW_ENV_FILE), { readImpl });
  // absent / unreadable — the container would start tokenless
  const exists = read !== null;
  const supplied = read ?? new Set();
  return {
    exists,
    supplied,
    missingRequired: WAYFLOW_ENV_REQUIRED_KEYS.filter((k) => !supplied.has(k)),
    missingExpected: WAYFLOW_ENV_EXPECTED_KEYS.filter((k) => !supplied.has(k)),
  };
}

/** The NON-EMPTY keys the generated env file supplies, or null when it is absent
 *  / unreadable. Feeds the generated-compose precedence invariant (an
 *  `environment:` key set EMPTY overrides the file's value on the same key). */
export function wayflowEnvSuppliedKeys({ targetDir, readImpl = nodeReadFileSync } = {}) {
  const seen = inspectWayflowEnvFile({ targetDir, readImpl });
  return seen.exists ? seen.supplied : null;
}

/**
 * The WayFlow endpoint THIS install's operator must actually open, derived from
 * the SAME per-instance port allocation that `.env.local`'s `WAYFLOW_BASE_URL` is
 * written from: `ports.wayflow[0]`, the generated isolated compose's remapped
 * published host port (install.mjs `writeIsolatedAppEnv` reads the identical
 * expression). An install that allocated no band passes no map and gets the
 * default port.
 *
 * cinatra-cli#231: the success line used to state the hardcoded default while the
 * instance ran on the offset port — pointing the operator at a dead port, or at
 * the MAIN instance's runtime when one held the default.
 *
 * @param {Record<string, number[]>} [ports] the per-service remapped host-port map
 * @returns {string}
 */
export function wayflowEndpointForPorts(ports) {
  const list = ports?.[WAYFLOW_SERVICE];
  const raw = Array.isArray(list) && list.length > 0 ? list[0] : null;
  const port = Number.parseInt(String(raw ?? ""), 10);
  const resolved = Number.isInteger(port) && port > 0 ? port : DEFAULT_WAYFLOW_PORT;
  return `http://localhost:${resolved}`;
}

/**
 * Regenerate the narrow WayFlow container env (`docker/wayflow/.wayflow.env`)
 * from `.env.local`, the same call `npm run services` and the setup script
 * make. It MUST run before the compose `up`: the runtime reads
 * `CINATRA_BRIDGE_TOKEN` from that file and crash-loops without it.
 *
 * HONESTY (cinatra#2654 D1). The result is judged by the FILE, not by the
 * generator's exit code: a `.wayflow.env` that does not exist, or that does not
 * supply the full REQUIRED key set (WAYFLOW_ENV_REQUIRED_KEYS), is `ok: false` —
 * the caller must abort rather than start a runtime that cannot authenticate its
 * callbacks and then report a ready instance. That is the same loud, attributable
 * shape the broken-image-build path already has. A missing EXPECTED key warns by
 * name (see the tier rationale above). A checkout without the generator (an older
 * tree) is a WARN only when an already-usable `.wayflow.env` is on disk; without
 * one there is no route for the wiring into the container, so it is a failure too.
 *
 * @returns {{ ok: boolean, skipped: boolean, reason: string|null }}
 */
export function generateWayflowEnv({
  targetDir,
  log = console.log,
  spawnImpl = nodeSpawnSync,
  existsImpl = nodeExistsSync,
  readImpl = nodeReadFileSync,
  execPath = process.execPath,
} = {}) {
  const inspect = () => inspectWayflowEnvFile({ targetDir, readImpl });
  /** The one place that turns a file inspection into a verdict, so the
   *  generator-absent and generator-ran paths can never disagree about what
   *  "produced" means. Reports the EXPECTED-but-missing keys as a warning. */
  const judge = (context) => {
    const seen = inspect();
    if (seen.missingRequired.length > 0) {
      return {
        ok: false,
        skipped: false,
        reason:
          `${context} and ${WAYFLOW_ENV_FILE} does not supply ${seen.missingRequired.join(", ")} ` +
          "(the file the container reads is the authority, not the exit code)",
      };
    }
    if (seen.missingExpected.length > 0) {
      log(
        `  ⚠ ${WAYFLOW_ENV_FILE} does not supply ${seen.missingExpected.join(", ")}. The runtime starts ` +
          "(the bridge token and the attest key are present) but falls back to the compose default for it; " +
          "update the checkout so `scripts/gen-wayflow-env.mjs` writes the full key set.",
      );
    }
    return null;
  };

  const generator = path.join(targetDir, "scripts", "gen-wayflow-env.mjs");
  if (!existsImpl(generator)) {
    const bad = judge("scripts/gen-wayflow-env.mjs is absent from this checkout");
    if (bad) return bad;
    log(
      "  ⚠ scripts/gen-wayflow-env.mjs is absent from this checkout — starting WayFlow with the " +
        `${WAYFLOW_ENV_FILE} already on disk (it supplies ${WAYFLOW_ENV_REQUIRED_KEYS.join(", ")}). ` +
        "Update the checkout to keep a rotated token propagating.",
    );
    return { ok: true, skipped: true, reason: "generator-absent" };
  }
  log("  Provisioning the WayFlow bridge-token env (docker/wayflow/.wayflow.env)…");
  const result = spawnImpl(execPath, [generator, "--require-bridge-token"], {
    cwd: targetDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const status = result?.error ? 1 : (result?.status ?? 1);
  if (status !== 0) {
    return {
      ok: false,
      skipped: false,
      reason: `gen-wayflow-env.mjs failed (exit ${status})${result?.error ? `: ${result.error.message}` : ""}`,
    };
  }
  const bad = judge("gen-wayflow-env.mjs exited 0");
  if (bad) return bad;
  return { ok: true, skipped: false, reason: null };
}

/** The error an unproducible bridge-token env raises. Names the file, the real
 *  reason, and BOTH recoveries — the same shape as a failed image build, because
 *  it is the same class of failure: a runtime that cannot start. */
export function wayflowEnvFailureMessage(reason) {
  return (
    `Refusing to start the WayFlow agent runtime — ${reason}. ` +
    "Without CINATRA_BRIDGE_TOKEN the runtime crash-loops and every agent run fails; without " +
    "CINATRA_CONTEXT_ATTEST_KEY it starts and then rejects every context callback. " +
    "Fix .env.local (re-run `cinatra install --reset-env` to mint the secrets), " +
    "or re-run with `--no-wayflow` to install without the agent runtime."
  );
}

/**
 * Build the WayFlow image for this stack. The service builds from
 * `./docker/wayflow` and has NO registry image, so a broken build must be a
 * loud, named install failure instead of a compose `up` that half-succeeds.
 * Running it as its OWN step (rather than letting `up` build implicitly) is
 * what makes the failure attributable and the retry cheap: the docker layer
 * cache makes a no-change rebuild close to free.
 *
 * @returns {{ ok: boolean, stderr: string, status: number }}
 */
export function buildWayflowImage({
  targetDir,
  composeArgs,
  log = console.log,
  spawnImpl = nodeSpawnSync,
} = {}) {
  const args = [...composeArgs, "build", WAYFLOW_SERVICE];
  log("  Building the WayFlow agent-runtime image (first build is slow; later runs hit the layer cache)…");
  const result = spawnImpl("docker", args, {
    cwd: targetDir,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "pipe"],
  });
  const stderr = String(result?.stderr ?? "").trim();
  const status = result?.error ? 1 : (result?.status ?? 1);
  if (status !== 0 && stderr) process.stderr.write(`${stderr}\n`);
  return { ok: status === 0, stderr, status };
}

/** The error a failed WayFlow build raises. Names the service, keeps the real
 *  build stderr, and states BOTH recoveries: fix the build and re-run (the
 *  install is idempotent), or install lean with --no-wayflow. */
export function wayflowBuildFailureMessage({ status, stderr }) {
  const detail = stderr ? `\n${stderr}` : "";
  return (
    `The WayFlow agent-runtime image failed to build (exit ${status}).${detail}\n` +
    "  The install stopped here rather than reporting a ready instance whose agent runs would all fail.\n" +
    "  Fix the build error and re-run `cinatra install` (it reconciles in place), or re-run with " +
    "`--no-wayflow` to install without the agent runtime."
  );
}

/**
 * Bounded wait for the WayFlow container to report Docker-healthy. The compose
 * healthcheck allows the loader ~2 minutes to mount every agent on a cold
 * start, so this polls the container's own health state rather than a port.
 *
 * Non-fatal by contract: a runtime that is up but still mounting agents is not
 * an install failure, it is a "re-run doctor in a minute". Returns the last
 * observed state so the caller can say which it was.
 *
 * @returns {{ healthy: boolean, state: string|null }}
 */
export function waitForWayflowHealth({
  project,
  attempts = 60,
  intervalMs = 3000,
  spawnImpl = nodeSpawnSync,
  sleepImpl = null,
} = {}) {
  if (!project) return { healthy: false, state: null };
  const sleep = sleepImpl ?? ((ms) => spawnImpl("sleep", [String(Math.max(1, Math.round(ms / 1000)))]));
  let state = null;
  for (let i = 0; i < attempts; i += 1) {
    const result = spawnImpl(
      "docker",
      [
        "ps",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        `label=com.docker.compose.service=${WAYFLOW_SERVICE}`,
        "--format",
        "{{.Status}}",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const status = String(result?.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
    if (status) state = status;
    if (/\(healthy\)/i.test(status)) return { healthy: true, state: status };
    sleep(intervalMs);
  }
  return { healthy: false, state };
}

/**
 * Unwrap whatever a registry finder hands back into the flat instance slot.
 *
 * cinatra-cli#230: `findInstanceByInstallDir` returns the `{ slug, slot }`
 * ENVELOPE, not the row. Reading `.composeProject` straight off the envelope
 * yields `undefined`, so the resolution below silently degraded to the
 * basename WHILE REPORTING `source: "registry"` — a healthy isolated runtime
 * recorded as `cinatra_x2654_row1` was diagnosed against `row1-dev`. The
 * envelope is the production shape, so accept both here rather than trust
 * every call site to unwrap; a shape mismatch must never resolve silently.
 *
 * @returns {{ slot: object, slug: string|null }|null}
 */
function unwrapRegistryRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const isEnvelope = row.slot && typeof row.slot === "object" && !Array.isArray(row.slot);
  const slot = isEnvelope ? row.slot : row;
  const slug =
    typeof slot.slug === "string" && slot.slug.trim() !== ""
      ? slot.slug.trim()
      : typeof row.slug === "string" && row.slug.trim() !== ""
        ? row.slug.trim()
        : null;
  return { slot, slug };
}

/**
 * Resolve the compose project + files a checkout's RECORDED install actually
 * uses, so a lifecycle command never assumes the checkout basename. A default
 * install now records an explicit instance-scoped project, and an isolated
 * install records its own generated compose file — a basename-derived `-p`
 * would address a DIFFERENT (often non-existent) project and report "no
 * container" for a runtime that is up.
 *
 * `readRegistry` / `findByInstallDir` are injected so this stays hermetic in
 * tests and free of a hard import cycle. Falls back to the caller-supplied
 * `fallbackProject` and the base compose pair when nothing is recorded.
 *
 * `source` describes where the returned PROJECT came from, and nothing else:
 * it is `"registry"` only when the recorded row actually supplied the name.
 * A found-but-unusable row reports `"fallback"`, because that is what the
 * caller is about to address. `slug` names the instance when one was found,
 * so a caller can say WHICH install it is talking about (cinatra-cli#230).
 *
 * `reason` says WHY the fallback was taken, because the three ways of getting
 * there are NOT the same claim (cinatra-cli#230 review):
 *
 *   * `"no-record"`           — the registry was read and holds no row for this
 *                               checkout. The basename is the right answer;
 *                               this is an unmanaged checkout.
 *   * `"registry-unreadable"` — the registry could not be read or parsed, so
 *                               whether a row exists is UNKNOWN. The basename
 *                               is a guess, and a container found under it may
 *                               belong to an entirely different instance. A
 *                               caller must not report this as "no record".
 *   * `"row-without-project"` — a row for this checkout exists but records no
 *                               compose project.
 *
 * `reason` is null when `source` is `"registry"`.
 *
 * @returns {{ project: string, composeFiles: string[], source: "registry"|"fallback",
 *             slug: string|null,
 *             reason: null|"no-record"|"registry-unreadable"|"row-without-project" }}
 */
export function resolveRecordedComposeContext({
  repoRoot,
  fallbackProject,
  readRegistry,
  findByInstallDir,
  baseComposeFiles = ["docker-compose.yml", "docker-compose.dev.yml"],
} = {}) {
  const fallbackWith = (reason, composeFiles = baseComposeFiles, slug = null) => ({
    project: fallbackProject,
    composeFiles,
    source: "fallback",
    slug,
    reason,
  });
  // No usable seam at all: the caller cannot consult a registry, so it cannot
  // know whether one records this checkout — same epistemic state as a
  // registry it failed to read.
  if (typeof readRegistry !== "function" || typeof findByInstallDir !== "function") {
    return fallbackWith("registry-unreadable");
  }
  let row = null;
  try {
    // A registry that is present-but-broken reads back as a NON-object here
    // (the reader returns `registry: null` for a malformed file). Distinguish
    // that from a readable registry with no matching row: only the latter
    // licenses "there is no record for this checkout".
    const registry = readRegistry();
    if (!registry || typeof registry !== "object") return fallbackWith("registry-unreadable");
    row = findByInstallDir(registry, repoRoot) ?? null;
  } catch {
    // a missing/malformed registry never breaks a lifecycle command
    return fallbackWith("registry-unreadable");
  }
  const found = unwrapRegistryRow(row);
  if (!found) return fallbackWith("no-record");
  const { slot, slug } = found;
  const recordedProject =
    typeof slot.composeProject === "string" && slot.composeProject.trim() !== ""
      ? slot.composeProject.trim()
      : null;
  const composeFiles =
    Array.isArray(slot.composeFiles) && slot.composeFiles.length > 0 ? slot.composeFiles : baseComposeFiles;
  if (recordedProject === null) {
    // The row exists but records no project. Say "fallback" — claiming
    // "registry" here is exactly the lie that hid cinatra-cli#230 — and name
    // the distinct reason, so a caller does not report this as "no record"
    // either: a record DOES exist, it just carries no project.
    return fallbackWith("row-without-project", composeFiles, slug);
  }
  return { project: recordedProject, composeFiles, source: "registry", slug, reason: null };
}
