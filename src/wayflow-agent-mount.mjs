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
// No ROLLBACK, but no clean exit either: this runs after the instance is
// provisioned, so it repairs and REPORTS rather than tearing a working install
// down — and every outcome that leaves the runtime unable to serve its agents
// (including having NO sources to serve) makes the install claim the typed exit
// code instead of printing success. `cinatra doctor`'s agent-availability probe
// fails on the same states.
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
/**
 * The port the loader listens on INSIDE the container. Compose publishes it on
 * whatever HOST port this instance chose (3010 for the default stack, remapped
 * for an isolated one), so asking compose which host port it published is what
 * makes an endpoint THIS instance's rather than the default stack's.
 */
export const WAYFLOW_CONTAINER_PORT = 3010;

const RELOAD_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * The typed exit code for an install that COMPLETED but left a runtime which
 * cannot serve its agents. Mirrors `SETUP_EXIT_REGISTRY_SKEW` (20): the install
 * really did provision the instance, so a bare "failed" would be false — but it
 * must NOT exit 0 either, because the whole point of cinatra-cli#233 is that
 * "exited 0 and recorded ready" hid a runtime that could not run an agent.
 */
export const INSTALL_EXIT_AGENTS_UNAVAILABLE = 21;

/** Claim the typed code ONLY over a provably clean exit — never downgrade or
 *  mask a non-zero a real failure already set (same rule as the skew code). */
export function claimAgentsUnavailableExitCode(currentExitCode) {
  const clean = currentExitCode === undefined || currentExitCode === null || currentExitCode === 0;
  return clean ? INSTALL_EXIT_AGENTS_UNAVAILABLE : currentExitCode;
}

/**
 * Is this endpoint the LOCAL runtime this install owns?
 *
 * SECURITY BOUNDARY (codex round 1, must-fix 4). The reload request carries
 * `CINATRA_BRIDGE_TOKEN`, and the endpoint comes from `WAYFLOW_BASE_URL` in the
 * checkout's `.env.local` — a value an install can inherit, a stale instance
 * can leave behind, and a hostile checkout can set. Sending the token to an
 * arbitrary origin would exfiltrate it. An install-owned runtime is a container
 * publishing on THIS host's loopback interface, so the token is sent only
 * there; any other endpoint keeps the token and takes the restart route (which
 * needs no secret) instead.
 */
export function isLoopbackEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

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
 * The `http://host:port` compose published the runtime on, parsed from one
 * `docker compose … port wayflow 3010` line: `127.0.0.1:13010`, `0.0.0.0:13010`
 * or `[::]:13010`. A WILDCARD bind is addressed on loopback — that is where this
 * host reaches its own published container, and it keeps the bridge token on the
 * loopback path the secret boundary requires. Returns null when unparseable.
 */
export function endpointFromPublishedAddress(raw) {
  const line = String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0] ?? "";
  const match = /^(?:(\[[^\]]*\]|[^:]*):)?(\d{1,5})$/.exec(line);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const host = (match[1] ?? "").replace(/^\[|\]$/g, "");
  if (host === "" || host === "0.0.0.0" || host === "::" || host === "*") return `http://127.0.0.1:${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * Ask COMPOSE which host address it published this project's runtime on.
 * `composeArgs` is the caller's fully-resolved `["compose", "-f", …, "-p", …]`
 * prefix, so this module never re-derives a project. Never throws; null when
 * there is no compose context, no daemon answer, or nothing published.
 */
export function publishedWayflowEndpoint({ targetDir, composeArgs = null, deps = {} } = {}) {
  const spawn = deps.spawnSync;
  if (typeof spawn !== "function") return null;
  if (!Array.isArray(composeArgs) || composeArgs.length === 0) return null;
  try {
    const result = spawn("docker", [...composeArgs, "port", WAYFLOW_SERVICE_NAME, String(WAYFLOW_CONTAINER_PORT)], {
      cwd: targetDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result?.status !== 0) return null;
    return endpointFromPublishedAddress(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The endpoint THIS instance publishes — or `null`, which the caller must treat
 * as a refusal to act.
 *
 * A hardcoded `:3010` fallback is not a guess, it is a WRONG ANSWER. An isolated
 * or attached instance remaps the WayFlow host port, and one whose `.env.local`
 * was never re-pointed still carries the donor's value — so defaulting addresses
 * the DEFAULT stack: the reload and BOTH verifications talk to another
 * instance's runtime, and when that one already serves the same labels the
 * install reports `already-mounted` and exits 0 while THIS instance stays empty.
 *
 * So the order is evidence first, record second, refusal last:
 *
 *   1. what COMPOSE published for this project — measured, and unambiguously
 *      this instance (the same project the bring-up used);
 *   2. the recorded `WAYFLOW_BASE_URL` (`env`'s parsed keys, else `.env.local`)
 *      — a record, and a stale one names another stack, so it never outranks
 *      the measurement;
 *   3. REFUSE. An unknown endpoint is not the default endpoint.
 */
export function resolveWayflowEndpoint({ targetDir, env = null, composeArgs = null, deps = {} } = {}) {
  const published = publishedWayflowEndpoint({ targetDir, composeArgs, deps });
  if (published) return published;
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
      // no .env.local (or unreadable) — fall through to the refusal
    }
  }
  return null;
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

/**
 * GET `/.health`. Returns `{ reachable, healthy, status, agents, body }`.
 *
 * `reachable` is TRANSPORT only — the runtime answered something. `healthy` is
 * the loader's own contract: HTTP 200 with `status` in {ok, degraded} (the same
 * rule the compose healthcheck and the doctor apply). Availability is judged on
 * `healthy`, never on `reachable`: a runtime answering 500 has answered, and
 * proves nothing about what it serves (codex round 2).
 *
 * Never throws.
 */
export async function fetchWayflowHealth({ endpoint, fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const out = { reachable: false, healthy: false, status: null, agents: null, body: null };
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
    const reported = typeof out.body?.status === "string" ? out.body.status : null;
    out.healthy = out.status === 200 && (reported === "ok" || reported === "degraded");
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
 * Is EVERY agent source on disk actually served by the runtime?
 *
 * codex round 1, must-fixes 2 + 3: a positive aggregate count proves nothing
 * about the agent that was just cloned — a runtime holding two OLD agents
 * reports `agents: 2` while the new source 404s. So availability is decided per
 * source, by its own route, and the count is only a corroborating signal.
 *
 * Each source lands in exactly one bucket:
 *   * `missing`       — HTTP 404: the route does not exist, the agent is not mounted;
 *   * `errored`       — HTTP >= 500: mounted but not serving;
 *   * `indeterminate` — no response at all: UNKNOWN, never read as either.
 *
 * `ok` requires health reachable, all three buckets empty, and a mounted count
 * (when the loader reports one) that covers the sources.
 */
export async function verifyAgentsAvailable({ endpoint, sources = [], fetchImpl, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const health = await fetchWayflowHealth({ endpoint, fetchImpl, timeoutMs });
  const probes = [];
  const missing = [];
  const errored = [];
  const indeterminate = [];
  for (const label of sources) {
    const probe = await probeAgentRoute({ endpoint, label, fetchImpl, timeoutMs });
    probes.push({ label, status: probe.status, reachable: probe.reachable });
    if (!probe.reachable) indeterminate.push(label);
    else if (probe.status === 404) missing.push(label);
    else if (typeof probe.status === "number" && probe.status >= 500) errored.push(label);
  }
  const mounted = typeof health.agents === "number" ? health.agents : null;
  // An ABSENT count is not coverage (codex round 2): only a number that covers
  // the sources proves the runtime holds them. Fail closed on an unknown.
  const countCovers = mounted !== null && mounted >= sources.length;
  const ok =
    health.healthy && missing.length === 0 && errored.length === 0 && indeterminate.length === 0 && countCovers;
  return { ok, health, mounted, probes, missing, errored, indeterminate, countCovers };
}

/** One operator-facing phrase naming exactly what is not available. */
function unavailabilityReason({ missing, errored, indeterminate, mounted, sources, countCovers, health = null }) {
  // Name the ROUTES, not the labels: that is what an operator curls to confirm.
  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} agent route(s) answer HTTP 404 (${missing.map(agentRoutePath).join(", ")})`);
  if (errored.length > 0) parts.push(`${errored.length} agent route(s) answer 5xx (${errored.map(agentRoutePath).join(", ")})`);
  if (indeterminate.length > 0) {
    parts.push(`${indeterminate.length} agent route(s) gave no response (${indeterminate.map(agentRoutePath).join(", ")})`);
  }
  if (health && !health.healthy) {
    parts.push(
      health.reachable
        ? `/.health answered HTTP ${health.status ?? "?"} (status=${health.body?.status ?? "unparseable"})`
        : "/.health is not answering",
    );
  } else if (mounted === null) {
    parts.push("/.health reported no agent count, so coverage cannot be proven");
  } else if (!countCovers) {
    parts.push(`the runtime reports ${mounted} mounted for ${sources.length} source(s) on disk`);
  }
  return parts.join("; ") || "the runtime is not serving its agents";
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
    if (last.healthy && typeof last.agents === "number" && last.agents > 0) return last;
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
    // FAIL CLOSED. This step runs ONLY for an install that owns a local runtime,
    // so "no agent sources on disk" is not a benign nothing-to-do: the runtime
    // this install just started serves ZERO agents, every `/agents/…` route
    // answers HTTP 404, and `judgeAgentAvailability` calls that identical state
    // a doctor FAIL. Both real paths land here — the dev sync reporting
    // `skipped`, and a prod acquisition that placed nothing — and both used to
    // exit 0 over an instance that cannot run a single agent, which is the very
    // lie this issue exists to remove.
    log(
      "  ⚠ WayFlow agent mount: NO agent sources on disk (extensions/<vendor>/<slug>/cinatra/oas.json), so the " +
        "runtime this install started can serve no agents — every `/agents/…` route answers HTTP 404.",
    );
    return {
      ...base,
      status: "no-sources",
      reason:
        "no agent sources are on disk (extensions/<vendor>/<slug>/cinatra/oas.json), so the runtime has nothing " +
        "to serve — the declared extension sync was skipped, or the acquisition placed nothing",
    };
  }

  // Address THIS instance or nothing at all: an unresolvable endpoint is a
  // failure, never the default stack (which a reload would repair instead,
  // reporting THIS instance mounted).
  const endpoint = resolveWayflowEndpoint({ targetDir, env, composeArgs, deps });
  if (!endpoint) {
    log(
      `  ⚠ WayFlow agent mount: this instance's WayFlow endpoint could not be determined — compose published no ` +
        `host port for the ${WAYFLOW_SERVICE_NAME} service and no usable WAYFLOW_BASE_URL is recorded. Refusing to ` +
        `address the default stack: a reload sent there repairs ANOTHER instance's runtime and would report this ` +
        `one mounted. The ${sources.length} agent source(s) on disk are not mounted.`,
    );
    return {
      ...base,
      status: "failed",
      reason:
        `this instance's WayFlow endpoint could not be determined (compose published no host port for the ` +
        `${WAYFLOW_SERVICE_NAME} service and no usable WAYFLOW_BASE_URL is recorded), so the ${sources.length} ` +
        "agent source(s) on disk could not be mounted",
    };
  }

  // Is it ALREADY serving every source? Decided per agent route, never by the
  // aggregate count alone (codex round 1, must-fix 2): a runtime holding two
  // OLD agents reports `agents: 2` while the source just cloned still 404s.
  const before = await verifyAgentsAvailable({ endpoint, sources, fetchImpl: deps.fetchImpl });
  if (before.ok) {
    log(`  WayFlow agent runtime already serves all ${sources.length} agent source(s) — no reload needed.`);
    return { ...base, status: "already-mounted", mounted: before.mounted };
  }
  if (!before.health.reachable) {
    log(
      `  ⚠ WayFlow agent mount: ${endpoint}${WAYFLOW_HEALTH_PATH} is not answering, so the ${sources.length} agent ` +
        "source(s) on disk could not be mounted. The runtime mounts agents at boot; every `/agents/…` route " +
        "answers HTTP 404 until it re-reads the directory. Re-run `cinatra install` once the runtime is up " +
        "(it reloads the runtime after the extension clones), and check `cinatra doctor`.",
    );
    return { ...base, status: "unreachable", reason: "health-unreachable" };
  }

  log(
    `- Mounting agent sources into the WayFlow runtime (${sources.length} on disk, ` +
      `${before.mounted ?? "unknown"} mounted) — it started before they were cloned…`,
  );
  // SECRET BOUNDARY: the token goes to the loopback runtime this install owns,
  // and nowhere else. A non-loopback endpoint takes the restart route, which
  // needs no secret.
  const local = isLoopbackEndpoint(endpoint);
  const token = local ? readWayflowBridgeToken({ targetDir, deps }) : null;
  const reload = local
    ? await reloadWayflowAgents({ endpoint, token, fetchImpl: deps.fetchImpl })
    : { ok: false, status: null, agents: null, reason: "endpoint-not-loopback" };
  let method = "reload";
  if (!reload.ok) {
    // The route, the auth or the endpoint's locality rules the reload out — a
    // restart makes the loader re-walk the directory at boot: the same repair,
    // without a secret.
    log(`  Hot-reload not used (${reload.reason}); restarting the ${WAYFLOW_SERVICE_NAME} service instead…`);
    const restart = restartWayflowService({ targetDir, composeArgs, deps });
    method = "restart";
    if (!restart.ok) {
      log(
        `  ⚠ WayFlow agent mount FAILED (reload: ${reload.reason}; restart: ${restart.reason}). ` +
          `${unavailabilityReason({ ...before, sources })}, so agent runs fail. Restart the runtime by hand ` +
          "(`cinatra instance wayflow stop && cinatra instance wayflow start`), then re-run `cinatra doctor`.",
      );
      return { ...base, status: "failed", method, mounted: before.mounted, reason: restart.reason };
    }
    // A restarted loader re-walks the directory while it boots; give it the
    // same bounded window the install's own health wait gives a cold start.
    await waitForAgentsMounted({ endpoint, deps });
  }

  // VERIFY against the runtime, per agent — never against the reload's own
  // answer, and never on an aggregate count (codex round 1, must-fix 2).
  const after = await verifyAgentsAvailable({ endpoint, sources, fetchImpl: deps.fetchImpl });
  if (after.ok) {
    log(`  WayFlow agent runtime serves all ${sources.length} agent source(s) (${method}); ${after.mounted ?? "n/a"} mounted.`);
    return { ...base, status: "mounted", mounted: after.mounted, method };
  }
  log(
    `  ⚠ WayFlow agent mount did not take effect (${method}): ${unavailabilityReason({ ...after, sources })}. ` +
      "Agent runs will fail until the runtime serves them. Check the container logs, then re-run " +
      "`cinatra install` (it reloads the runtime) and `cinatra doctor`.",
  );
  return {
    ...base,
    status: "failed",
    method,
    mounted: after.mounted,
    reason: unavailabilityReason({ ...after, sources }),
  };
}

/**
 * The mount statuses that mean "this install owns a runtime that cannot serve
 * agents", i.e. the ones that must claim the typed exit code rather than exit 0.
 *
 * `no-sources` is one of them. It reads like a benign nothing-to-do and is not:
 * the step only runs for an install that OWNS a local runtime, so it describes a
 * runtime serving zero agents with every `/agents/…` route answering 404 — the
 * identical state `judgeAgentAvailability` calls a doctor FAIL. Leaving it
 * non-failing let an install exit 0 over exactly that whenever the dev sync
 * reported `skipped` or prod acquisition placed nothing.
 */
export const AGENT_MOUNT_FAILING_STATUSES = Object.freeze(["failed", "unreachable", "no-sources"]);

/** Does this mount result mean the install must not report a clean success? */
export function agentMountFailedClosed(result) {
  return Boolean(result) && AGENT_MOUNT_FAILING_STATUSES.includes(result.status);
}

/**
 * The operator-facing verdict for an install that provisioned an instance whose
 * runtime cannot serve its agents. Stated at the install tail (where the
 * operator reads it) and paired with the typed exit code, so
 * "exited 0 and recorded ready" can no longer describe this state.
 */
export function agentsUnavailableVerdictLines(result) {
  if (!agentMountFailedClosed(result)) return [];
  // The recovery differs by cause: an unmounted runtime is reloaded, but a
  // runtime with nothing on disk to mount needs the SOURCES first — telling that
  // operator to restart the runtime would send them in a circle.
  const evidence =
    result.status === "no-sources"
      ? [
          "    No agent source reached disk, so the runtime has nothing to serve: every `/agents/…` route answers HTTP 404.",
          "    Recover: clone the declared extension repos (dev: `cinatra.devExtensions` — the sync's skip reason is above)",
          "    or acquire the prod extensions, then re-run `cinatra install` (it reloads the runtime once they are on disk).",
        ]
      : [
          `    ${result.sources} agent source(s) are on disk; every unmounted \`/agents/…\` route answers HTTP 404, so agent runs fail.`,
          "    Recover: re-run `cinatra install` (it reloads the runtime after the extension sources are on disk),",
          "    or restart it by hand (`cinatra instance wayflow stop && cinatra instance wayflow start`).",
        ];
  return [
    "",
    "  ⚠ This instance is provisioned, but its WayFlow agent runtime cannot serve its agents:",
    `    ${result.reason ?? "the runtime did not mount the agent sources on disk"}.`,
    ...evidence,
    "    Then confirm with `cinatra doctor` — its WayFlow probe checks agent availability, not only health.",
    `    (Exit code ${INSTALL_EXIT_AGENTS_UNAVAILABLE}: the install completed; the agent runtime did not.)`,
  ];
}

/**
 * The doctor's AVAILABILITY verdict, as a pure decision over what was already
 * measured: a runtime that answers `/.health` `ok` is not agent-ready if it
 * mounts nothing (cinatra#2654 row 7 — `{"agents":0}` and HTTP 404, health
 * still `ok`, doctor still PASS). Kept pure so the doctor owns the I/O.
 *
 * EVERY discovered source is judged by its OWN route (codex round 1, must-fix
 * 3): probing only the first would pass a runtime that serves that one and none
 * of the rest, and an aggregate count says nothing about identity. The three
 * non-passing shapes are distinguished rather than merged:
 *
 *   * 404 on any source → FAIL (not mounted — the defect);
 *   * >= 500 on any source → FAIL (mounted, not serving);
 *   * no response → SKIP, never PASS (indeterminate; the same rule the health
 *     probe already applies to a booting loader).
 *
 * @param {{sources: string[], agents: number|null, probes: {label: string, status: number|null, reachable: boolean}[]}} input
 * @returns {{verdict: "pass"|"fail"|"skip", detail: string, remedy: string|null}}
 */
export function judgeAgentAvailability({ sources = [], agents = null, probes = [] } = {}) {
  const remedy =
    "Re-run `cinatra install` (it reloads the runtime after the extension sources are on disk), or restart the " +
    "runtime by hand (`cinatra instance wayflow stop && cinatra instance wayflow start`). " +
    "The runtime walks extensions/ at boot, so one started before the clones mounts nothing.";
  if (sources.length === 0) {
    if (agents !== null && agents > 0) {
      return { verdict: "pass", detail: `${agents} agent(s) mounted (no agent sources under extensions/ in this checkout)`, remedy: null };
    }
    if (agents === null) {
      return {
        verdict: "skip",
        detail:
          "/.health reported no agent count and this checkout has no agent sources on disk — availability could " +
          "not be determined",
        remedy: "Check the runtime's /.health contract (`agents` is expected), then re-run `cinatra doctor`.",
      };
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
  const missing = probes.filter((p) => p.reachable && p.status === 404).map((p) => p.label);
  const errored = probes.filter((p) => p.reachable && typeof p.status === "number" && p.status >= 500).map((p) => p.label);
  const indeterminate = probes.filter((p) => !p.reachable).map((p) => p.label);
  const countNote = agents === null ? `${sources.length} agent source(s) on disk` : `${agents} agent(s) mounted`;
  if (missing.length > 0) {
    const cause =
      agents === 0
        ? "the runtime was started before the extension sources existed"
        : "the runtime's mount predates these agent sources on disk";
    return {
      verdict: "fail",
      detail:
        `${countNote}, but ${missing.length} of ${sources.length} agent source(s) answer HTTP 404 ` +
        `(${missing.map(agentRoutePath).join(", ")}) — ${cause}, so those agent runs fail`,
      remedy,
    };
  }
  if (errored.length > 0) {
    return {
      verdict: "fail",
      detail: `${countNote}, but ${errored.map(agentRoutePath).join(", ")} answer HTTP 5xx — mounted, not serving`,
      remedy: "Check the runtime's container logs for the per-agent error, then re-run `cinatra doctor`.",
    };
  }
  if (indeterminate.length > 0) {
    return {
      verdict: "skip",
      detail:
        `${countNote}, but ${indeterminate.map(agentRoutePath).join(", ")} gave no response — availability could ` +
        "not be determined (loader still mounting?)",
      remedy: "Wait for the loader to finish mounting agents, then re-run `cinatra doctor`.",
    };
  }
  if (agents === null) {
    // An absent count is not coverage: every route answering says those routes
    // exist, not that the runtime holds all the sources. Unknown, so SKIP.
    return {
      verdict: "skip",
      detail:
        `every probed agent route answers, but /.health reported no agent count for the ${sources.length} source(s) ` +
        "on disk — coverage could not be proven",
      remedy: "Check the runtime's /.health contract (`agents` is expected), then re-run `cinatra doctor`.",
    };
  }
  if (agents < sources.length) {
    return {
      verdict: "fail",
      detail:
        `every probed agent route answers, but the runtime reports ${agents} mounted for ${sources.length} agent ` +
        "source(s) on disk — it is not serving all of them",
      remedy,
    };
  }
  const statuses = probes.map((p) => `${agentRoutePath(p.label)} HTTP ${p.status}`).join(", ");
  return { verdict: "pass", detail: `${countNote}; all ${sources.length} agent source(s) answer (${statuses})`, remedy: null };
}
