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
export function wayflowStatusLines(mode, { endpoint = "http://localhost:3010" } = {}) {
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

/**
 * True iff `docker/wayflow/.wayflow.env` exists AND carries a non-empty
 * `CINATRA_BRIDGE_TOKEN`. This is the POSTCONDITION of the generator, checked
 * independently of it: the install may only promise a runtime once the token
 * actually reached the file the container reads.
 *
 * Parsing mirrors `scripts/gen-wayflow-env.mjs`'s own dotenv regex (same shape,
 * same quote stripping) so the two never disagree about what "supplied" means.
 * Never logs a value.
 */
export function wayflowEnvHasBridgeToken({ targetDir, readImpl = nodeReadFileSync } = {}) {
  try {
    const body = String(readImpl(path.join(targetDir, WAYFLOW_ENV_FILE), "utf8"));
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && match[1] === WAYFLOW_BRIDGE_TOKEN_KEY) {
        return match[2].replace(/^["']|["']$/g, "").trim() !== "";
      }
    }
    return false;
  } catch {
    return false; // absent / unreadable — the container would start tokenless
  }
}

/**
 * Regenerate the narrow WayFlow container env (`docker/wayflow/.wayflow.env`)
 * from `.env.local`, the same call `npm run services` and the setup script
 * make. It MUST run before the compose `up`: the runtime reads
 * `CINATRA_BRIDGE_TOKEN` from that file and crash-loops without it.
 *
 * HONESTY (cinatra#2654 D1). The result is judged by the FILE, not by the
 * generator's exit code: a `.wayflow.env` that does not exist, or that carries
 * no non-empty bridge token, is `ok: false` — the caller must abort rather than
 * start a runtime that cannot authenticate its callbacks and then report a ready
 * instance. That is the same loud, attributable shape the broken-image-build
 * path already has. A checkout without the generator (an older tree) is a WARN
 * only when a usable `.wayflow.env` is ALREADY on disk; without one there is no
 * route for the token into the container, so it is a failure too.
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
  const hasToken = () => wayflowEnvHasBridgeToken({ targetDir, readImpl });
  const generator = path.join(targetDir, "scripts", "gen-wayflow-env.mjs");
  if (!existsImpl(generator)) {
    if (!hasToken()) {
      return {
        ok: false,
        skipped: false,
        reason:
          `scripts/gen-wayflow-env.mjs is absent from this checkout and ${WAYFLOW_ENV_FILE} carries no ` +
          `non-empty ${WAYFLOW_BRIDGE_TOKEN_KEY}`,
      };
    }
    log(
      "  ⚠ scripts/gen-wayflow-env.mjs is absent from this checkout — starting WayFlow with the " +
        `${WAYFLOW_ENV_FILE} already on disk (it supplies ${WAYFLOW_BRIDGE_TOKEN_KEY}). Update the checkout to ` +
        "keep a rotated token propagating.",
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
  if (!hasToken()) {
    return {
      ok: false,
      skipped: false,
      reason:
        `gen-wayflow-env.mjs exited 0 but ${WAYFLOW_ENV_FILE} carries no non-empty ` +
        `${WAYFLOW_BRIDGE_TOKEN_KEY} (the file the container reads is the authority, not the exit code)`,
    };
  }
  return { ok: true, skipped: false, reason: null };
}

/** The error an unproducible bridge-token env raises. Names the file, the real
 *  reason, and BOTH recoveries — the same shape as a failed image build, because
 *  it is the same class of failure: a runtime that cannot start. */
export function wayflowEnvFailureMessage(reason) {
  return (
    `Refusing to start the WayFlow agent runtime — ${reason}. ` +
    "Without CINATRA_BRIDGE_TOKEN the runtime crash-loops and every agent run fails. " +
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
 * @returns {{ project: string, composeFiles: string[], source: "registry"|"fallback" }}
 */
export function resolveRecordedComposeContext({
  repoRoot,
  fallbackProject,
  readRegistry,
  findByInstallDir,
  baseComposeFiles = ["docker-compose.yml", "docker-compose.dev.yml"],
} = {}) {
  const fallback = {
    project: fallbackProject,
    composeFiles: baseComposeFiles,
    source: "fallback",
  };
  if (typeof readRegistry !== "function" || typeof findByInstallDir !== "function") return fallback;
  let row = null;
  try {
    row = findByInstallDir(readRegistry(), repoRoot) ?? null;
  } catch {
    return fallback; // a missing/malformed registry never breaks a lifecycle command
  }
  if (!row) return fallback;
  const project =
    typeof row.composeProject === "string" && row.composeProject.trim() !== ""
      ? row.composeProject.trim()
      : fallbackProject;
  const composeFiles =
    Array.isArray(row.composeFiles) && row.composeFiles.length > 0 ? row.composeFiles : baseComposeFiles;
  return { project, composeFiles, source: "registry" };
}
