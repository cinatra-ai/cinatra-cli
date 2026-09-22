// ---------------------------------------------------------------------------
// Per-instance agent runtime (cinatra-cli#260).
//
// WHY THIS MODULE EXISTS
// ----------------------
// An install told that the database, the cache and the connection service are
// somebody else's problem (`--infra=external`) starts no agent runtime, and says
// so plainly. That is honest, but it left the operator with no way to start one:
// the two roads that DO start a runtime either own a whole local Docker stack
// (so they start the one shared container of a checkout), or belong to the clone
// registry, whose ports come from a fixed range. An operator running several
// isolated instances side by side on one machine needs ONE runtime container per
// instance, on a port they choose, under a name that cannot collide with the
// instance next to it, calling back to that instance's own app address.
//
// This module is the derivation behind that verb. It is PURE: no spawn, no
// Docker, no network, no registry read. `index.mjs` resolves a plan here and
// then does what the clone road already does — render the checkout's compose
// template, bring up the single runtime service, and gate on health.
//
// THE NAMES ARE SHARED, NOT INVENTED. `cinatra instance start --instance <name>`
// records the runtime container it expects for an instance as
// `cinatra-instance-<name>-wayflow-1` under compose project
// `cinatra-instance-<name>` (cinatra-cli#261's `instanceComposeProject` /
// `instanceRuntimeContainer`). The two one-line derivations are duplicated here
// so this module stays a leaf — and a test pins both spellings, so the verb that
// starts an instance and the verb that starts its runtime can never name two
// different containers for one instance.
//
// THE CALLBACK ADDRESS. The runtime calls the app back on the address the
// rendered compose gives it, and inside a container the host's own loopback
// means the container itself. So the operator names the address on THIS machine
// (`--app-url http://127.0.0.1:<port>`, or the instance's own environment) and
// the rendered document dials it through the container's host gateway. That is
// also what makes the verb work on a rootless engine, where a container cannot
// otherwise reach a loopback-bound app.
//
// Public surface:
//   - selector:   parseInstanceRuntimeFlags, instanceRuntimeRequested
//   - derivation: instanceComposeProject, instanceRuntimeContainer,
//                 instanceRuntimeComposePath, appUrlFromEnv,
//                 resolveInstanceRuntimePlan, instanceRuntimeTemplateVars
//   - invocation: composeInstanceRuntimeUpArgs, dockerRuntimeInspectArgs,
//                 dockerRuntimeStopArgs, dockerRuntimeRemoveArgs,
//                 containerCallbackProbeArgs, callbackProbeScript
//   - reading:    parseRuntimeContainerState, callbackProbeVerdict
//   - refusal:    unreachableAppMessage, callbackProbeFailureMessage
// ---------------------------------------------------------------------------

import path from "node:path";

import { isValidSlug } from "./clone-registry.mjs";
import { PORT_BAND_SOURCE_OPERATOR, assertPortBandOk, cloneRuntimeDir } from "./clone-runtime.mjs";
import { DEFAULT_APP_PORT } from "./instance-alloc.mjs";

// --- constants -------------------------------------------------------------

/** The compose service the checkout's runtime template declares. The container
 *  name is that service inside the instance's own project, so this name is
 *  load-bearing in two places and defined in one. */
export const INSTANCE_RUNTIME_SERVICE = "wayflow";

/** The rendered compose document, in the instance's own runtime directory.
 *  Deliberately NOT `compose.yml`: that name belongs to the clone road's own
 *  document, and an instance and a clone may carry the same name. */
export const INSTANCE_RUNTIME_COMPOSE_FILE = "wayflow-compose.yml";

/** The credential the runtime presents on its callbacks to the app. It is read
 *  from the instance's own environment file and handed to the launch through
 *  the launch environment — never through an argument list, never printed, and
 *  never written into a file this verb creates. */
export const INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY = "CINATRA_BRIDGE_TOKEN";

/** The container-side name for "the machine I am running on". The rendered
 *  document maps it to the host gateway, so a container reaches an app bound to
 *  this machine's loopback — including on a rootless engine. */
export const INSTANCE_RUNTIME_GATEWAY_HOST = "host.docker.internal";

/** What the runtime answers on, and what the app answers on. */
export const INSTANCE_RUNTIME_HEALTH_PATH = "/.health";
export const INSTANCE_APP_HEALTH_PATH = "/api/health";

/** How long a graceful stop is given before the container is removed. */
export const INSTANCE_RUNTIME_STOP_TIMEOUT_SECONDS = 10;

/** How long the in-container callback probe waits for the app to answer. A
 *  bound belongs INSIDE the probe: an address that is refused fails at once,
 *  but one that is merely black-holed leaves `fetch` waiting on the runtime's
 *  own header timeout (minutes), and `docker exec` waits with it. */
export const INSTANCE_RUNTIME_CALLBACK_PROBE_TIMEOUT_MS = 5_000;

/** The addresses that mean "the app on THIS machine". Anything else is refused:
 *  the rendered document reaches the app through the host gateway, so an address
 *  naming another machine would be accepted and then silently not used. */
const APP_URL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  INSTANCE_RUNTIME_GATEWAY_HOST,
]);

/** The flags this verb accepts, each taking one value. */
const VALUE_FLAGS = ["--instance", "--runtime-port", "--app-url"];

// --- flag parsing ----------------------------------------------------------

/** Read `--flag <value>` / `--flag=<value>` out of an argv. Mirrors the CLI's
 *  own option reader (the `=` form first, so it is never silently ignored);
 *  kept local so this module stays a leaf. */
function readFlag(argv, flag) {
  const list = Array.isArray(argv) ? argv : [];
  const eqPrefix = `${flag}=`;
  const eqArg = list.find((a) => typeof a === "string" && a.startsWith(eqPrefix));
  if (eqArg !== undefined) return eqArg.slice(eqPrefix.length);
  const index = list.indexOf(flag);
  if (index === -1) return null;
  const value = list[index + 1];
  return typeof value === "string" ? value : "";
}

/** Everything in `argv` that is neither one of this verb's flags nor one of
 *  their values. A malformed invocation fails fast rather than quietly
 *  performing a container action on values it did not read. */
export function instanceRuntimeExtraTokens(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const extra = [];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i] ?? "").trim();
    if (token === "") continue;
    if (VALUE_FLAGS.includes(token)) {
      i += 1; // its value
      continue;
    }
    if (VALUE_FLAGS.some((flag) => token.startsWith(`${flag}=`))) continue;
    extra.push(token);
  }
  return extra;
}

/** True when the operator addressed ONE instance's own runtime. False keeps the
 *  shared-service road exactly as it was. */
export function instanceRuntimeRequested(argv = []) {
  return readFlag(argv, "--instance") !== null;
}

/** Validate the instance name. It names a directory, a compose project and a
 *  container, so it is the same plain lower-case name the rest of the CLI
 *  accepts for an instance. */
function assertSlug(value) {
  if (!isValidSlug(value)) {
    throw new Error(
      `Invalid --instance "${value}". An instance name is a plain lower-case name ` +
        `(letters, digits and dashes, starting with a letter or digit, at most 30 characters).`,
    );
  }
  return value;
}

/** Validate an explicit port. Shape only — the clone registry's port bands are
 *  its own rows' business (see `resolveInstanceRuntimePlan`). */
function assertPort(flag, value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || String(n) !== String(value).trim() || n < 1024 || n > 65535) {
    throw new Error(`Invalid ${flag} "${value}". Must be an integer between 1024 and 65535.`);
  }
  return n;
}

/**
 * An `--app-url` as it may be REPEATED BACK to the operator. Every refusal
 * below quotes what was passed, and an operator may well paste an address that
 * carries a credential in its userinfo — so the userinfo is dropped first. The
 * match runs to the LAST `@` of the authority, which is where `new URL` puts
 * that boundary, and it works on a string `new URL` could not parse at all.
 */
function quotableAppUrl(value) {
  return String(value ?? "").replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, "$1");
}

/** Validate the callback address and reduce it to its origin. */
function assertAppUrl(value) {
  const raw = String(value ?? "").trim();
  const shown = quotableAppUrl(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid --app-url "${shown}". Pass the address this machine serves the instance's app ` +
        `on, e.g. \`--app-url http://127.0.0.1:3000\`.`,
    );
  }
  // http ONLY. The rendered document dials the app at
  // `http://host.docker.internal:<port>` — the template writes that scheme and
  // this verb has no other one to give it — so an https address would be taken
  // and then not used, which is exactly what the host check below refuses an
  // address for.
  if (parsed.protocol !== "http:") {
    throw new Error(
      `Invalid --app-url "${shown}". The agent runtime dials the app over http through this ` +
        `machine's gateway (http://${INSTANCE_RUNTIME_GATEWAY_HOST}:<port>), so any other scheme ` +
        `would be accepted here and then not used. Name the http address the app listens on, ` +
        `e.g. \`--app-url http://127.0.0.1:3000\`.`,
    );
  }
  if (!APP_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Invalid --app-url "${shown}". The agent runtime reaches the app through this machine's own ` +
        `gateway, so the address must name THIS machine (${[...APP_URL_HOSTS].join(", ")}); the ` +
        `runtime dials it as http://${INSTANCE_RUNTIME_GATEWAY_HOST}:<port>.`,
    );
  }
  if (!parsed.port) {
    throw new Error(
      `Invalid --app-url "${shown}". Name the port the app listens on, ` +
        `e.g. \`--app-url http://127.0.0.1:3000\`.`,
    );
  }
  // The origin ALONE: a path, a query or a fragment is dropped here rather than
  // carried into the rendered document, which takes a port and nothing else.
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
}

/**
 * The operator's explicit choices out of one argv. Absent flags are null —
 * "nothing was chosen" — so the plan can tell a choice apart from a default.
 *
 * @param {string[]} argv
 * @returns {{ slug: string|null, runtimePort: number|null, appUrl: string|null }}
 */
export function parseInstanceRuntimeFlags(argv = []) {
  const extra = instanceRuntimeExtraTokens(argv);
  if (extra.length > 0) {
    throw new Error(
      `Unexpected argument(s) for 'cinatra instance wayflow': ${extra.join(" ")}. ` +
        `Expected: cinatra instance wayflow start --instance <name> --runtime-port <port> ` +
        `[--app-url <url>], or cinatra instance wayflow stop --instance <name>.`,
    );
  }
  const rawSlug = readFlag(argv, "--instance");
  const rawPort = readFlag(argv, "--runtime-port");
  const rawAppUrl = readFlag(argv, "--app-url");
  return {
    slug: rawSlug === null ? null : assertSlug(rawSlug),
    runtimePort: rawPort === null ? null : assertPort("--runtime-port", rawPort),
    appUrl: rawAppUrl === null ? null : assertAppUrl(rawAppUrl),
  };
}

// --- derived names ---------------------------------------------------------

/** The compose project an instance's agent runtime belongs to. Name-keyed, so
 *  two instances never address one another's containers.
 *
 *  ONE SPELLING, TWO VERBS: `instance start --instance <name>` (cinatra-cli#261)
 *  derives the identical value for the identical name, and a test pins it. */
export function instanceComposeProject(slug) {
  return `cinatra-instance-${assertSlug(slug)}`;
}

/** The container name that project's runtime service carries (compose's own
 *  `<project>-<service>-<n>` shape), so the verb that starts an instance and the
 *  verb that starts its runtime name the same container. Pinned against
 *  cinatra-cli#261's own derivation by a test. */
export function instanceRuntimeContainer(slug) {
  return `${instanceComposeProject(slug)}-${INSTANCE_RUNTIME_SERVICE}-1`;
}

/** Where this instance's rendered runtime compose lives. */
export function instanceRuntimeComposePath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), INSTANCE_RUNTIME_COMPOSE_FILE);
}

/**
 * The address on THIS machine the instance's own environment says its app
 * answers on, or null. `PORT` is read first — it is the key the instance's start
 * sets and the app binds — and an app URL is read for its PORT only, because the
 * runtime reaches the app through the host gateway whatever hostname the app
 * publishes itself under.
 */
export function appUrlFromEnv(env = {}) {
  const port = Number.parseInt(String(env?.PORT ?? ""), 10);
  if (Number.isInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
  for (const key of ["NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
    const raw = typeof env?.[key] === "string" ? env[key].trim() : "";
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return `http://127.0.0.1:${parsedPort}`;
    } catch {
      /* not an address — keep looking */
    }
  }
  return null;
}

// --- the plan --------------------------------------------------------------

/**
 * Everything one `instance wayflow start|stop --instance <name>` needs about ONE
 * instance's runtime: its names, its paths, its ports and the two addresses that
 * decide whether it works — the one the operator reaches the runtime on, and the
 * one the runtime reaches the app on.
 *
 * @param {object} args
 * @param {"start"|"stop"} [args.verb]
 * @param {string[]} [args.argv]      the verb's argv (its flags)
 * @param {object}   [args.flags]     already-parsed flags (argv is parsed when absent)
 * @param {Record<string,string>} [args.env]  the instance's own environment file
 * @param {string}   [args.repoRoot]  the checkout whose extensions the runtime serves
 * @param {string}   [args.home]      state-root override for hermetic tests
 */
export function resolveInstanceRuntimePlan({
  verb = "start",
  argv = [],
  flags = null,
  env = {},
  repoRoot = null,
  home,
} = {}) {
  const chosen = flags ?? parseInstanceRuntimeFlags(argv);
  const slug = chosen.slug;
  if (!slug) {
    throw new Error(
      `\`cinatra instance wayflow ${verb}\` needs \`--instance <name>\` to address one ` +
        `instance's own agent runtime.`,
    );
  }
  const opts = home === undefined ? undefined : { home };
  const stateDir = cloneRuntimeDir(slug, opts);
  const plan = {
    slug,
    verb,
    repoRoot,
    service: INSTANCE_RUNTIME_SERVICE,
    composeProject: instanceComposeProject(slug),
    container: instanceRuntimeContainer(slug),
    composePath: instanceRuntimeComposePath(slug, opts),
    stateDir,
    // Inert: this verb brings up the runtime service alone and never the
    // template's tunnel sidecar, so the value only satisfies the substitution.
    tunnelHostname: `cinatra-instance-${slug}`,
    runtimePort: chosen.runtimePort ?? null,
    runtimeUrl: null,
    runtimeHealthUrl: null,
    appUrl: null,
    appPort: null,
    callbackUrl: null,
  };
  if (verb !== "start") {
    // A flag this verb READS must be a flag this verb HONOURS. A stop removes
    // the container the instance already has; a port or an address named here
    // would be validated and then dropped on the floor, so it is refused
    // instead of silently ignored.
    if (chosen.runtimePort != null || chosen.appUrl != null) {
      throw new Error(
        `\`cinatra instance wayflow ${verb} --instance ${slug}\` takes no \`--runtime-port\` or ` +
          `\`--app-url\`: it removes the agent runtime container this instance already has, so ` +
          `neither value would be used. Drop them — \`start\` is the verb that takes them.`,
      );
    }
    return plan;
  }

  if (chosen.runtimePort == null) {
    throw new Error(
      `\`cinatra instance wayflow start --instance ${slug}\` needs \`--runtime-port <port>\`: ` +
        `the host port THIS instance publishes its agent runtime on. Two instances on one ` +
        `machine must not share it.`,
    );
  }
  // The clone registry's port bands guard ITS OWN rows against corruption. A
  // port the operator names on the flag is taken as given — that is the whole
  // point of this verb — so the assertion is called for its shape alone.
  assertPortBandOk(chosen.runtimePort, INSTANCE_RUNTIME_SERVICE, {
    source: PORT_BAND_SOURCE_OPERATOR,
  });
  plan.runtimePort = chosen.runtimePort;
  plan.runtimeUrl = `http://localhost:${plan.runtimePort}`;
  plan.runtimeHealthUrl = `${plan.runtimeUrl}${INSTANCE_RUNTIME_HEALTH_PATH}`;

  plan.appUrl = chosen.appUrl ?? appUrlFromEnv(env) ?? `http://127.0.0.1:${DEFAULT_APP_PORT}`;
  plan.appPort = Number.parseInt(new URL(plan.appUrl).port, 10);
  plan.callbackUrl = `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:${plan.appPort}`;
  return plan;
}

/** The values the checkout's runtime compose template is rendered with. The
 *  template's own documented placeholders — this verb invents none. */
export function instanceRuntimeTemplateVars(plan) {
  return {
    NEXTJS_PORT: plan.appPort,
    WAYFLOW_PORT: plan.runtimePort,
    WORKTREE_PATH: plan.repoRoot,
    TS_HOSTNAME: plan.tunnelHostname,
    CLONE_STATE_DIR: plan.stateDir,
    TAILSCALE_NETWORK_MODE: "bridge",
  };
}

// --- the invocations -------------------------------------------------------

/** Bring up THE ONE runtime service of THIS instance's project. Scoped exactly
 *  as every other single-service start in this CLI is: never `down`, never a
 *  whole profile, never another project. */
export function composeInstanceRuntimeUpArgs(plan) {
  return [
    "compose",
    "-p",
    plan.composeProject,
    "-f",
    plan.composePath,
    "up",
    "-d",
    INSTANCE_RUNTIME_SERVICE,
  ];
}

/** Read one container's state. A container that is not there answers non-zero,
 *  which `parseRuntimeContainerState` reads as absent. */
export function dockerRuntimeInspectArgs(plan) {
  return ["inspect", "--format", "{{.State.Status}}", plan.container];
}

/** Stop THAT ONE container, gracefully. */
export function dockerRuntimeStopArgs(plan) {
  return ["stop", "-t", String(INSTANCE_RUNTIME_STOP_TIMEOUT_SECONDS), plan.container];
}

/** Remove THAT ONE container, and nothing else on the machine. */
export function dockerRuntimeRemoveArgs(plan) {
  return ["rm", "-f", plan.container];
}

/** The question asked INSIDE the container: can it reach the app at the address
 *  the rendered document gave it? Asked there because that is the only place the
 *  answer is true — a host-side probe of the same app says nothing about what a
 *  container on a rootless engine can reach. */
export function callbackProbeScript(callbackUrl) {
  const target = JSON.stringify(`${callbackUrl}${INSTANCE_APP_HEALTH_PATH}`);
  return (
    `fetch(${target}, ` +
    `{ signal: AbortSignal.timeout(${INSTANCE_RUNTIME_CALLBACK_PROBE_TIMEOUT_MS}) })` +
    `.then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`
  );
}

/** The probe, as an ARGUMENT VECTOR: the script is one argv element, so it is
 *  handed to `node -e` by the kernel and never to a shell — no quoting of the
 *  callback address, and nothing in it for a shell to interpret. */
export function containerCallbackProbeArgs(plan) {
  return ["exec", plan.container, "node", "-e", callbackProbeScript(plan.callbackUrl)];
}

// --- reading ---------------------------------------------------------------

/** What a container-state read said. Absent, present-but-stopped and running
 *  are three different answers and the verb does three different things with
 *  them, so they are read here rather than guessed at the call site. */
export function parseRuntimeContainerState(result = {}) {
  const code = result?.error ? 1 : (result?.status ?? 1);
  if (code !== 0) return { present: false, running: false, status: null };
  const status = String(result?.stdout ?? "").trim().toLowerCase() || null;
  return { present: true, running: status === "running", status };
}

/**
 * What the in-container probe ANSWERED. "The app is unreachable" is only one of
 * the things a non-zero `docker exec` means: an image without `node` on its
 * PATH answers 127 (and a non-executable one 126), and a docker CLI that never
 * ran at all answers with a spawn error. Reading all three as "cannot reach the
 * app" would send the operator to fix an address that is fine, so they are told
 * apart here.
 *
 * @returns {"ok"|"unreachable"|"no-interpreter"|"probe-failed"}
 */
export function callbackProbeVerdict(result = {}) {
  if (result?.error) return "probe-failed";
  const status = result?.status;
  if (status === 0) return "ok";
  if (status === 126 || status === 127) return "no-interpreter";
  if (typeof status !== "number") return "probe-failed";
  return "unreachable";
}

// --- the refusal -----------------------------------------------------------

/** The refusal when the container cannot reach the app. It NAMES THE CALLBACK
 *  ADDRESS, because that address is the thing that is wrong and the operator
 *  cannot see it from outside the container. */
export function unreachableAppMessage(plan) {
  return (
    `Instance "${plan.slug}": the agent runtime container ${plan.container} cannot reach this ` +
    `instance's app at ${plan.callbackUrl}. That is the address the runtime calls back on, and ` +
    `every agent run fails until it answers. Start this instance's app on port ${plan.appPort} ` +
    `first, or name the port it listens on (\`--app-url http://127.0.0.1:<port>\`), then re-run ` +
    `this command.`
  );
}

/** The refusal for a callback probe that did not answer "ok" — the address when
 *  the address is the thing that is wrong, and the probe itself when it is. */
export function callbackProbeFailureMessage(plan, result = {}) {
  const verdict = callbackProbeVerdict(result);
  if (verdict === "unreachable") return unreachableAppMessage(plan);
  const why =
    verdict === "no-interpreter"
      ? `\`node\` could not be run inside it`
      : `the probe could not be run at all (${result?.error?.message ?? "docker exec failed"})`;
  return (
    `Instance "${plan.slug}": the agent runtime container ${plan.container} answered on ` +
    `${plan.runtimeUrl}, but ${why}, so whether it can reach this instance's app at ` +
    `${plan.callbackUrl} is not known — and a runtime that cannot reach the app fails every agent ` +
    `run at its first call. Read the container's own words with \`docker logs ${plan.container}\`, ` +
    `rebuild the \`cinatra-wayflow:local\` image if it carries no node, then re-run this command.`
  );
}
