import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

// ---------------------------------------------------------------------------
// cinatra-cli#233 — mount the agent sources the WayFlow runtime was started
// before.
//
// The install brings the local stack up (Postgres + Redis + Nango + the WayFlow
// agent runtime) in step 4b/6, and clones the declared extension repos in step
// 7. The runtime bind-mounts the checkout's `extensions/` directory
// (`./extensions:/agents:ro`) and walks it ONCE, at boot, so on a FRESH install
// it walks an empty directory: the loader mounts 0 agents, every
// `/agents/<vendor>/<slug>/` route answers HTTP 404, and `/.health` still
// answers `{"status":"ok","agents":0,...}` — which the compose healthcheck and
// the doctor's health probe both accept. The instance is reported ready and
// cannot run a single agent (cinatra#2654 row 7).
//
// The loader already owns the repair: `POST /.internal/reload-agents` re-walks
// the bind-mounted directory and swaps the route table atomically. This module
// is the CLI half of that contract:
//
//   * discovery mirrors the loader's own rule — `extensions/<vendor>/<slug>/
//     cinatra/oas.json` — so the CLI and the runtime never disagree about what
//     "an agent source" is (agent_loader.py `_scan_agents_dir`);
//   * the reload is authenticated with the bridge token from the narrow
//     generated env file, which is read into memory and NEVER logged;
//   * a runtime whose image predates the reload route (404/405) or whose token
//     is unset (503) falls back to a compose RESTART of the one service, which
//     re-walks the directory on boot; and
//   * the outcome is VERIFIED against `/.health` + a real agent route rather
//     than assumed from the reload's exit status.
//
// Non-fatal by contract: this runs after the instance is provisioned, so it
// repairs and REPORTS. What it must never do is stay quiet — an unmounted
// runtime is now named here, and `cinatra doctor`'s agent-availability probe
// fails on the same state.
// ---------------------------------------------------------------------------

/** The loader's hot-reload route (agent_loader.py base_routes). POST-only. */
export const WAYFLOW_RELOAD_PATH = "/.internal/reload-agents";
/** The loader's health contract. */
export const WAYFLOW_HEALTH_PATH = "/.health";
/** The bridge-token header the reload route authenticates with. */
export const WAYFLOW_BRIDGE_TOKEN_HEADER = "X-Cinatra-Bridge-Token";
/** The compose service that runs the loader. */
export const WAYFLOW_SERVICE_NAME = "wayflow";
/** The checkout-relative directory bind-mounted at /agents. */
export const AGENT_SOURCES_DIRNAME = "extensions";
/** The checkout-relative narrow env file that carries CINATRA_BRIDGE_TOKEN. */
export const WAYFLOW_ENV_FILE_REL = path.join("docker", "wayflow", ".wayflow.env");
/** Default endpoint when `.env.local` records no WAYFLOW_BASE_URL. */
export const DEFAULT_WAYFLOW_ENDPOINT = "http://localhost:3010";

const RELOAD_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Every agent source on disk, discovered the way the loader discovers them:
 * a two-level walk of `<targetDir>/extensions/<vendor>/<slug>/cinatra/oas.json`.
 * Directories without that file are the loader's "probe pattern" and are
 * skipped here for the same reason — they are not mountable agents.
 *
 * Returns labels in `<vendor>/<slug>` form (the loader's own label), sorted, so
 * a count comparison against `/.health` `agents` is meaningful and a route
 * probe can address a REAL agent.
 *
 * Pure + total: a missing directory, an unreadable entry or a symlink that
 * escapes the checkout yields no label rather than an exception.
 */
export function discoverAgentSources({ targetDir, deps = {} } = {}) {
  const exists = deps.existsSync ?? existsSync;
  const readdir = deps.readdirSync ?? readdirSync;
  const stat = deps.statSync ?? statSync;
  const root = path.join(targetDir ?? ".", AGENT_SOURCES_DIRNAME);
  if (!targetDir || !exists(root)) return [];
  const isDir = (p) => {
    try {
      return stat(p).isDirectory();
    } catch {
      return false;
    }
  };
  const entries = (dir) => {
    try {
      return readdir(dir).filter((name) => !String(name).startsWith("."));
    } catch {
      return [];
    }
  };
  const labels = [];
  for (const vendor of entries(root)) {
    const vendorDir = path.join(root, vendor);
    if (!isDir(vendorDir)) continue;
    for (const slug of entries(vendorDir)) {
      const slugDir = path.join(vendorDir, slug);
      if (!isDir(slugDir)) continue;
      if (!exists(path.join(slugDir, "cinatra", "oas.json"))) continue;
      labels.push(`${vendor}/${slug}`);
    }
  }
  return labels.sort();
}

/** The HTTP route the loader mounts an agent at, for label `<vendor>/<slug>`. */
export function agentRoutePath(label) {
  return `/agents/${String(label).replace(/^\/+|\/+$/g, "")}/`;
}

/** Normalize a base URL (no trailing slash). Returns null when unusable. */
function normalizeEndpoint(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * The endpoint THIS instance publishes. An isolated instance remaps the WayFlow
 * host port and re-points `WAYFLOW_BASE_URL` in its own `.env.local`, so a
 * hardcoded :3010 would address the DEFAULT instance's runtime and reload
 * another stack. `env` (already-parsed keys) wins; otherwise `.env.local` is
 * read from the checkout. Falls back to the default endpoint.
 */
export function resolveWayflowEndpoint({ targetDir, env = null, deps = {} } = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  const fromEnv = env ? normalizeEndpoint(env.WAYFLOW_BASE_URL) : null;
  if (fromEnv) return fromEnv;
  if (targetDir) {
    try {
      const body = readFile(path.join(targetDir, ".env.local"), "utf8");
      const value = readEnvValue(body, "WAYFLOW_BASE_URL");
      const parsed = normalizeEndpoint(value);
      if (parsed) return parsed;
    } catch {
      // no .env.local (or unreadable) — the default endpoint is the honest guess
    }
  }
  return DEFAULT_WAYFLOW_ENDPOINT;
}

/** Read one KEY=value out of an env-file body. Strips matching quotes. */
function readEnvValue(body, key) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

/**
 * The bridge token the reload route authenticates with, read from the narrow
 * generated env file the runtime itself is configured from. SECRET BOUNDARY:
 * the value is returned for one in-memory use as a request header and is never
 * logged, never written and never included in any returned message.
 */
export function readWayflowBridgeToken({ targetDir, deps = {} } = {}) {
  const readFile = deps.readFileSync ?? readFileSync;
  if (!targetDir) return null;
  try {
    const body = readFile(path.join(targetDir, WAYFLOW_ENV_FILE_REL), "utf8");
    const token = readEnvValue(body, "CINATRA_BRIDGE_TOKEN");
    return token ? token : null;
  } catch {
    return null;
  }
}

/** GET `/.health`. Returns `{ reachable, status, agents, body }`. Never throws. */
export async function fetchWayflowHealth({ endpoint, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const out = { reachable: false, status: null, agents: null, body: null };
  if (typeof doFetch !== "function" || !endpoint) return out;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${endpoint}${WAYFLOW_HEALTH_PATH}`, { method: "GET", signal: controller.signal });
    out.reachable = true;
    out.status = response.status;
    if (response.status === 200) {
      try {
        out.body = await response.json();
      } catch {
        out.body = null;
      }
    }
    out.agents = typeof out.body?.agents === "number" ? out.body.agents : null;
  } catch {
    // transport error/timeout — `reachable` stays false
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Probe ONE mounted agent route. The evidence signal from cinatra#2654 row 7:
 * an unmounted agent answers **404**, a mounted one answers **405** (the route
 * exists, GET is not its method). So 404 — and only 404 — means "not mounted".
 *
 * Returns `{ reachable, status, mounted }`; an unreachable runtime reports
 * `mounted: null` (unknown) rather than a false negative.
 */
export async function probeAgentRoute({ endpoint, label, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const out = { reachable: false, status: null, mounted: null };
  if (typeof doFetch !== "function" || !endpoint || !label) return out;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${endpoint}${agentRoutePath(label)}`, { method: "GET", signal: controller.signal });
    out.reachable = true;
    out.status = response.status;
    out.mounted = response.status !== 404;
  } catch {
    // unreachable — `mounted` stays null (unknown), never a false "absent"
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * POST the loader's hot-reload route. Returns
 * `{ ok, status, agents, reason }`. `ok` is true only on a 200 whose report
 * parsed; every other outcome carries a `reason` naming what happened, so the
 * caller can decide between the restart fallback (route/auth unavailable) and
 * reporting (a real reload failure).
 *
 * The token is sent as a header and never appears in the returned values.
 */
export async function reloadWayflowAgents({ endpoint, token, fetchImpl, timeoutMs = RELOAD_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { ok: false, status: null, agents: null, reason: "no-fetch" };
  if (!endpoint) return { ok: false, status: null, agents: null, reason: "no-endpoint" };
  if (!token) return { ok: false, status: null, agents: null, reason: "no-bridge-token" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${endpoint}${WAYFLOW_RELOAD_PATH}`, {
      method: "POST",
      headers: { [WAYFLOW_BRIDGE_TOKEN_HEADER]: token },
      signal: controller.signal,
    });
    const status = response.status;
    if (status === 404 || status === 405) {
      return { ok: false, status, agents: null, reason: "reload-route-absent" };
    }
    if (status === 503) return { ok: false, status, agents: null, reason: "reload-disabled" };
    if (status === 403) return { ok: false, status, agents: null, reason: "reload-forbidden" };
    if (status !== 200) return { ok: false, status, agents: null, reason: `reload-http-${status}` };
    let report = null;
    try {
      report = await response.json();
    } catch {
      report = null;
    }
    const agents = typeof report?.agents === "number" ? report.agents : null;
    return { ok: true, status, agents, reason: null, report };
  } catch (err) {
    return { ok: false, status: null, agents: null, reason: `reload-unreachable (${err?.name ?? "error"})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Restart the ONE wayflow service through compose — the fallback for a runtime
 * whose image predates the reload route or whose token is unset. The loader
 * walks the bind-mounted directory at boot, so a restart mounts what is now on
 * disk. `composeArgs` is the caller's fully-resolved `["compose", "-f", …,
 * "-p", …]` prefix, so this module never re-derives a project.
 *
 * Returns `{ ok, reason }`; never throws.
 */
export function restartWayflowService({ targetDir, composeArgs = null, deps = {} } = {}) {
  const spawn = deps.spawnSync;
  if (typeof spawn !== "function") return { ok: false, reason: "no-spawn" };
  if (!Array.isArray(composeArgs) || composeArgs.length === 0) return { ok: false, reason: "no-compose-context" };
  try {
    const result = spawn("docker", [...composeArgs, "restart", WAYFLOW_SERVICE_NAME], {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result?.status === 0) return { ok: true, reason: null };
    return { ok: false, reason: `restart-exit-${result?.status ?? "null"}` };
  } catch (err) {
    return { ok: false, reason: `restart-failed (${err?.message ?? err})` };
  }
}

/**
 * Bounded poll of `/.health` until the runtime reports at least one mounted
 * agent. Used after the RESTART fallback: a restarted loader re-walks the
 * bind-mounted directory during boot, so the verification must not read the
 * health endpoint of a container that is still coming up (and must not report
 * "0 mounted" for a runtime that simply has not finished).
 *
 * Returns the last observed health. Never throws.
 */
export async function waitForAgentsMounted({ endpoint, attempts = 40, intervalMs = 3000, deps = {} } = {}) {
  const sleep = deps.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = { reachable: false, status: null, agents: null, body: null };
  for (let i = 0; i < attempts; i += 1) {
    last = await fetchWayflowHealth({ endpoint, fetchImpl: deps.fetchImpl });
    if (last.reachable && typeof last.agents === "number" && last.agents > 0) return last;
    await sleep(intervalMs);
  }
  return last;
}

/**
 * cinatra-cli#233 — make the running runtime mount the agent sources that
 * reached disk AFTER it started.
 *
 * Runs after the extension sync (dev clones) / prod acquisition, so the sources
 * it mounts exist by construction. Sequence:
 *
 *   1. discover the on-disk agent sources — none means nothing to mount, and
 *      the step states that rather than restarting a runtime pointlessly;
 *   2. read `/.health` — a runtime that already mounts them all (an idempotent
 *      re-run, a reconcile) is left alone;
 *   3. `POST /.internal/reload-agents`, else RESTART the service when the route
 *      or the token is unavailable;
 *   4. VERIFY: re-read `/.health` and probe a real agent route. The verdict is
 *      what the runtime answers, never what the reload returned.
 *
 * @returns {Promise<{status: string, sources: number, mounted: number|null, method: string|null, label: string|null, reason: string|null}>}
 *   status ∈ `no-sources` | `already-mounted` | `mounted` | `unreachable` | `failed`
 */
export async function mountAgentSourcesAfterSync({
  targetDir,
  env = null,
  composeArgs = null,
  log = console.log,
  deps = {},
} = {}) {
  const sources = discoverAgentSources({ targetDir, deps });
  const label = sources[0] ?? null;
  const base = { sources: sources.length, mounted: null, method: null, label, reason: null };
  if (sources.length === 0) {
    log("- WayFlow agent mount: no agent sources on disk (extensions/) — nothing to mount.");
    return { ...base, status: "no-sources" };
  }

  const endpoint = resolveWayflowEndpoint({ targetDir, env, deps });
  const health = await fetchWayflowHealth({ endpoint, fetchImpl: deps.fetchImpl });
  if (!health.reachable) {
    log(
      `  ⚠ WayFlow agent mount: ${endpoint}${WAYFLOW_HEALTH_PATH} is not answering, so the ${sources.length} agent ` +
        "source(s) on disk could not be mounted. The runtime mounts agents at boot; every `/agents/…` route " +
        "answers HTTP 404 until it re-reads the directory. Re-run `cinatra install` once the runtime is up " +
        "(it reloads the runtime after the extension clones), and check `cinatra doctor`.",
    );
    return { ...base, status: "unreachable", reason: "health-unreachable" };
  }
  if (typeof health.agents === "number" && health.agents >= sources.length) {
    log(`  WayFlow agent runtime already mounts ${health.agents} agent(s) — no reload needed.`);
    return { ...base, status: "already-mounted", mounted: health.agents };
  }

  log(
    `- Mounting agent sources into the WayFlow runtime (${sources.length} on disk, ` +
      `${health.agents ?? "unknown"} mounted) — it started before they were cloned…`,
  );
  const token = readWayflowBridgeToken({ targetDir, deps });
  const reload = await reloadWayflowAgents({ endpoint, token, fetchImpl: deps.fetchImpl });
  let method = "reload";
  if (!reload.ok) {
    // The route or the auth is unavailable on this runtime — a restart makes
    // the loader re-walk the directory at boot, which is the same repair.
    log(`  Hot-reload unavailable (${reload.reason}); restarting the ${WAYFLOW_SERVICE_NAME} service instead…`);
    const restart = restartWayflowService({ targetDir, composeArgs, deps });
    method = "restart";
    if (!restart.ok) {
      log(
        `  ⚠ WayFlow agent mount FAILED (reload: ${reload.reason}; restart: ${restart.reason}). The runtime is up ` +
          `but mounts ${health.agents ?? "no"} of the ${sources.length} agent source(s) on disk, so ` +
          `${agentRoutePath(label)} answers HTTP 404 and agent runs fail. Restart it by hand ` +
          "(`cinatra instance wayflow stop && cinatra instance wayflow start`), then re-run `cinatra doctor`.",
      );
      return { ...base, status: "failed", method, mounted: health.agents ?? null, reason: restart.reason };
    }
    // A restarted loader re-walks the directory while it boots; give it the
    // same bounded window the install's own health wait gives a cold start.
    await waitForAgentsMounted({ endpoint, deps });
  }

  // VERIFY against the runtime, never against the reload's own answer.
  const after = await fetchWayflowHealth({ endpoint, fetchImpl: deps.fetchImpl });
  const route = await probeAgentRoute({ endpoint, label, fetchImpl: deps.fetchImpl });
  const mounted = typeof after.agents === "number" ? after.agents : (reload.agents ?? null);
  if ((mounted !== null && mounted > 0) || route.mounted === true) {
    log(`  WayFlow agent runtime mounted ${mounted ?? "the"} agent(s) (${method}); ${agentRoutePath(label)} answers HTTP ${route.status ?? "n/a"}.`);
    return { ...base, status: "mounted", mounted, method };
  }
  log(
    `  ⚠ WayFlow agent mount did not take effect (${method}): ${sources.length} agent source(s) are on disk but the ` +
      `runtime reports ${mounted ?? "an unknown number of"} mounted and ${agentRoutePath(label)} answers HTTP ` +
      `${route.status ?? "no response"}. Agent runs will fail until it mounts them. Check the container logs, then ` +
      "re-run `cinatra install` (it reloads the runtime) and `cinatra doctor`.",
  );
  return { ...base, status: "failed", method, mounted, reason: "verify-empty" };
}

/**
 * The doctor's AVAILABILITY verdict, as a pure decision over what was already
 * measured: a runtime that answers `/.health` `ok` is not agent-ready if it
 * mounts nothing (cinatra#2654 row 7 — `{"agents":0}` and HTTP 404, health
 * still `ok`, doctor still PASS). Kept pure so the doctor owns the I/O.
 *
 * @param {{sources: string[], agents: number|null, routeStatus: number|null, routeReachable: boolean}} input
 * @returns {{verdict: "pass"|"fail", detail: string, remedy: string|null}}
 */
export function judgeAgentAvailability({ sources = [], agents = null, routeStatus = null, routeReachable = false } = {}) {
  const remedy =
    "Re-run `cinatra install` (it reloads the runtime after the extension sources are on disk), or restart the " +
    "runtime by hand (`cinatra instance wayflow stop && cinatra instance wayflow start`). " +
    "The runtime walks extensions/ at boot, so one started before the clones mounts nothing.";
  if (sources.length === 0) {
    if (agents !== null && agents > 0) {
      return { verdict: "pass", detail: `${agents} agent(s) mounted (no agent sources under extensions/ in this checkout)`, remedy: null };
    }
    return {
      verdict: "fail",
      detail:
        "0 agents mounted and no agent sources on disk (extensions/<vendor>/<slug>/cinatra/oas.json) — every " +
        "`/agents/…` route answers HTTP 404, so no agent can run",
      remedy:
        "Clone the declared extension repos and reload the runtime by re-running `cinatra install` " +
        "(dev), or acquire the prod extensions, then re-run `cinatra doctor`.",
    };
  }
  if (agents === 0) {
    return {
      verdict: "fail",
      detail:
        `0 agents mounted while ${sources.length} agent source(s) are on disk — the runtime was started before the ` +
        `extension sources existed, so ${agentRoutePath(sources[0])} answers HTTP 404 and every agent run fails`,
      remedy,
    };
  }
  if (routeReachable && routeStatus === 404) {
    return {
      verdict: "fail",
      detail:
        `${agents ?? "some"} agent(s) mounted, but ${agentRoutePath(sources[0])} answers HTTP 404 — the runtime's ` +
        "mount predates this agent source on disk",
      remedy,
    };
  }
  const routeNote = routeReachable
    ? `; ${agentRoutePath(sources[0])} answers HTTP ${routeStatus}`
    : `; ${agentRoutePath(sources[0])} not probed (no response)`;
  const countNote = agents === null ? `${sources.length} agent source(s) on disk` : `${agents} agent(s) mounted`;
  return { verdict: "pass", detail: `${countNote}${routeNote}`, remedy: null };
}
