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
// THE CALLBACK ADDRESS, AND WHO OWNS IT. The runtime calls the app back on the
// address the rendered compose gives it, and inside a container this machine's
// own loopback means the container itself. So there are two roads, and they are
// deliberately different:
//
//   * NOBODY NAMED ONE. The address is derived from the instance's own
//     environment, which publishes the app under this machine's loopback — and
//     a container cannot dial that. It is therefore dialled through the
//     container's gateway to the host, which is also what makes the verb work
//     on an engine running containers without root.
//   * THE OPERATOR NAMED ONE (`--app-url`). It is honoured EXACTLY as written.
//     An operator who puts a relay address on this machine's loopback interface
//     and forwards the app port to it has an address the container can dial,
//     and second-guessing it would hand the container an address the operator
//     has already found does not work. What a string check cannot settle the
//     verb settles for real: it probes that address FROM INSIDE the container
//     it started, and refuses the start when it cannot be reached.
//
// Public surface:
//   - selector:   parseInstanceRuntimeFlags, instanceRuntimeRequested
//   - derivation: instanceComposeProject, instanceRuntimeContainer,
//                 containerNameIsChosen, instanceRuntimeComposePath,
//                 appUrlFromEnv, resolveInstanceRuntimePlan,
//                 instanceRuntimeTemplateVars
//   - document:   instanceRuntimeComposeDocument, recordedContainerName
//   - invocation: composeInstanceRuntimeUpArgs, dockerRuntimeInspectArgs,
//                 dockerContainerProjectArgs, dockerRuntimeStopArgs,
//                 dockerRuntimeRemoveArgs, dockerImageInspectArgs,
//                 imageRevisionLabelArgs, containerCallbackProbeArgs,
//                 callbackProbeScript
//   - reading:    parseRuntimeContainerState, containerBelongsToInstance,
//                 callbackProbeVerdict
//   - refusal:    unreachableAppMessage, callbackProbeFailureMessage,
//                 missingNamedImageMessage, foreignContainerMessage
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

/** The name this machine answers to on its own loopback interface. Used where a
 *  loopback address is MEANT — the derivation below, and the examples in the
 *  refusals — so no literal address is written into this tool. */
export const INSTANCE_LOOPBACK_HOST = "localhost";

/** The image this checkout builds for its own agent runtime, and the only image
 *  this verb ever builds. An image named with `--image` is the operator's, and
 *  is never built and never pulled. */
export const INSTANCE_RUNTIME_DEFAULT_IMAGE = "cinatra-wayflow:local";

/** The label a built image carries so a caller can read a running container's
 *  image and know which commit of the checkout it was built from. The OCI
 *  annotation, under its standard name — nothing invented. */
export const INSTANCE_RUNTIME_IMAGE_REVISION_LABEL = "org.opencontainers.image.revision";

/** What docker accepts as a container name, and how long. Pinned here because
 *  `--container` hands the value to the engine, and a name the engine refuses
 *  must fail on the flag rather than halfway through a launch. */
const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const CONTAINER_NAME_MAX_LENGTH = 63;

/** The flags this verb accepts, each taking one value. */
const VALUE_FLAGS = ["--instance", "--runtime-port", "--app-url", "--image", "--container"];

/** The flags this verb accepts that take no value. */
const BOOLEAN_FLAGS = ["--rebuild"];

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
    if (BOOLEAN_FLAGS.includes(token)) continue;
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

/** Is this a name for the machine speaking it? Every address in the loopback
 *  block counts, not only the first, and so do both spellings of the v6 one.
 *  Inside a container these mean the CONTAINER, which is why a DERIVED address
 *  naming one is dialled through the container's gateway to the host instead. */
function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  if (host === INSTANCE_LOOPBACK_HOST || host === "::1" || host === "[::1]") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** The port the operator actually TYPED. `new URL` ELIDES a scheme's own
 *  default port, and this verb renders that number into the document and dials
 *  it from inside the container, so an address written with the default port
 *  spelled out must not read as an address with no port at all. */
function typedPort(raw, parsed) {
  if (parsed.port) return parsed.port;
  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/)[0];
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const match = /:(\d+)$/.exec(host);
  return match ? match[1] : "";
}

/** The port an origin NAMES, read the same way on both roads — so an app on a
 *  scheme's own default port renders as that number and not as nothing at all. */
function originPort(origin) {
  return Number.parseInt(typedPort(origin, new URL(origin)), 10);
}

/**
 * Validate the callback address and reduce it to its origin.
 *
 * WHAT IS REFUSED is what the CONTAINER could not dial, or could not dial as
 * written: a scheme the runtime has no client for, a missing or out-of-range
 * port, and anything besides scheme, host and port — the address is handed
 * over as an ORIGIN the runtime appends its own paths to, so a user name or a
 * password before the host, or a path, a query or a fragment after it, would be
 * accepted here and then not used.
 *
 * WHAT IS NOT REFUSED is the HOST. The address is honoured exactly as written,
 * so any host the operator names is theirs to name: a relay address on this
 * machine's loopback interface, a dotted address, a hostname, or the container's
 * own gateway to the host. Whether it answers is not a question a string check
 * can settle — the verb settles it by probing the address from INSIDE the
 * container it started.
 */
function assertAppUrl(value) {
  const raw = String(value ?? "").trim();
  const shown = quotableAppUrl(value);
  const example = `\`--app-url http://${INSTANCE_LOOPBACK_HOST}:3000\``;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid --app-url "${shown}". Pass the address the agent runtime container reaches this ` +
        `instance's app on — scheme, host and port — e.g. ${example}.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Invalid --app-url "${shown}". The agent runtime dials the app over http or https and has ` +
        `no client for "${parsed.protocol.replace(/:$/, "")}", so this address would be accepted ` +
        `here and then not used. Name the address the app listens on, e.g. ${example}.`,
    );
  }
  // A CREDENTIAL is refused rather than dropped. Only an origin reaches the
  // container, and this address is also written into the document this command
  // writes and named in its refusals — no place for a password. The message
  // quotes the address without it.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      `Invalid --app-url "${shown}". It carries a user name or a password before the host, and ` +
        `the runtime is handed an ORIGIN — scheme, host and port — so they would be taken here ` +
        `and then not used. Drop them, e.g. ${example}.`,
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `Invalid --app-url "${shown}". This is an ORIGIN — scheme, host and port — because the ` +
        `runtime appends its own paths to it, so a path, a query or a fragment here would be ` +
        `taken and then not used. Drop everything after the port, e.g. ${example}.`,
    );
  }
  const port = Number.parseInt(typedPort(raw, parsed), 10);
  if (!Number.isInteger(port)) {
    throw new Error(
      `Invalid --app-url "${shown}". Name the port the app listens on, e.g. ${example}.`,
    );
  }
  if (port < 1 || port > 65535) {
    throw new Error(
      `Invalid --app-url "${shown}". The port must be between 1 and 65535, and ${port} is not.`,
    );
  }
  // The ORIGIN, as written: this is the address the container is handed, so the
  // scheme and the host the operator named are both carried through.
  return `${parsed.protocol}//${parsed.hostname}:${port}`;
}

/** Validate an image reference. It reaches a docker argument list and a
 *  double-quoted scalar in a compose document, so whitespace, quotes, a
 *  backslash, a `$` — which compose would read as a variable to substitute —
 *  and a leading dash — which the engine would read as a flag — are refused
 *  rather than passed on. None of them belongs in an image reference. */
function assertImageRef(value) {
  const ref = String(value ?? "").trim();
  if (ref === "" || ref.startsWith("-") || /[\s"'`\\$]/.test(ref)) {
    throw new Error(
      `Invalid --image "${String(value ?? "")}". Pass the image the container should run, as ` +
        `docker names one — a repository and a tag, e.g. ` +
        `\`--image ${INSTANCE_RUNTIME_DEFAULT_IMAGE}\`.`,
    );
  }
  return ref;
}

/** Validate a container name the way the engine does, so a name it would refuse
 *  fails on the flag rather than halfway through a launch. */
function assertContainerName(value) {
  const name = String(value ?? "").trim();
  if (!CONTAINER_NAME_PATTERN.test(name) || name.length > CONTAINER_NAME_MAX_LENGTH) {
    throw new Error(
      `Invalid --container "${String(value ?? "")}". A container name is what the engine accepts ` +
        `as one: it starts with a letter or a digit and carries letters, digits, \`_\`, \`.\` and ` +
        `\`-\` after that, at most ${CONTAINER_NAME_MAX_LENGTH} characters. Leave the flag out and ` +
        `this instance's runtime is named cinatra-instance-<name>-wayflow-1.`,
    );
  }
  return name;
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
        `[--app-url <url>] [--image <tag>|--rebuild] [--container <name>], or ` +
        `cinatra instance wayflow stop --instance <name>.`,
    );
  }
  const rawSlug = readFlag(argv, "--instance");
  const rawPort = readFlag(argv, "--runtime-port");
  const rawAppUrl = readFlag(argv, "--app-url");
  const rawImage = readFlag(argv, "--image");
  const rawContainer = readFlag(argv, "--container");
  const image = rawImage === null ? null : assertImageRef(rawImage);
  const rebuild = (Array.isArray(argv) ? argv : []).includes("--rebuild");
  // TWO DIFFERENT IMAGES. `--rebuild` builds THIS CHECKOUT's own image again;
  // `--image` runs one the operator built or pulled themselves, which this verb
  // never builds. Asked for together they name two images to run, so both are
  // named back rather than one of them silently winning.
  if (rebuild && image !== null) {
    throw new Error(
      `\`--rebuild\` and \`--image ${image}\` cannot be used together: --rebuild builds this ` +
        `checkout's own ${INSTANCE_RUNTIME_DEFAULT_IMAGE} again and runs that, while --image runs ` +
        `an image you built or pulled yourself and is never built here. Pass one or the other.`,
    );
  }
  return {
    slug: rawSlug === null ? null : assertSlug(rawSlug),
    runtimePort: rawPort === null ? null : assertPort("--runtime-port", rawPort),
    appUrl: rawAppUrl === null ? null : assertAppUrl(rawAppUrl),
    image,
    container: rawContainer === null ? null : assertContainerName(rawContainer),
    rebuild,
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

/** Must a container found under this plan's name PROVE it is this instance's
 *  before this verb stops or removes it? The derived name is this instance's
 *  by construction. A name the operator chose could be any container's on the
 *  machine. */
export function containerNameIsChosen(plan) {
  return plan.container !== instanceRuntimeContainer(plan.slug);
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
  if (Number.isInteger(port) && port > 0) return `http://${INSTANCE_LOOPBACK_HOST}:${port}`;
  for (const key of ["NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL"]) {
    const raw = typeof env?.[key] === "string" ? env[key].trim() : "";
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      const parsedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return `http://${INSTANCE_LOOPBACK_HOST}:${parsedPort}`;
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
    // Without `--container` the name is compose's own for the project's one
    // service, and the document says nothing about it; with it, the document
    // records it and a `stop` reads it back.
    container: chosen.container ?? instanceRuntimeContainer(slug),
    containerNamed: chosen.container != null,
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
    image: chosen.image ?? INSTANCE_RUNTIME_DEFAULT_IMAGE,
    // The operator NAMED the image, so it is theirs: never built, never pulled.
    imageNamed: chosen.image != null,
    rebuild: chosen.rebuild === true,
  };
  if (verb !== "start") {
    // A flag this verb READS must be a flag this verb HONOURS. A stop removes
    // the container the instance already has — under the name its START
    // recorded — so a port, an address, an image or a name given here would be
    // validated and then dropped on the floor. It is refused instead of
    // silently ignored.
    if (
      chosen.runtimePort != null ||
      chosen.appUrl != null ||
      chosen.image != null ||
      chosen.container != null ||
      chosen.rebuild
    ) {
      throw new Error(
        `\`cinatra instance wayflow ${verb} --instance ${slug}\` takes no \`--runtime-port\`, ` +
          `\`--app-url\`, \`--image\`, \`--container\` or \`--rebuild\`: it removes the agent ` +
          `runtime container this instance already has, under the name its start recorded, so ` +
          `none of these values would be used. Drop them — \`start\` is the verb that takes them.`,
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

  plan.appUrl =
    chosen.appUrl ?? appUrlFromEnv(env) ?? `http://${INSTANCE_LOOPBACK_HOST}:${DEFAULT_APP_PORT}`;
  const app = new URL(plan.appUrl);
  plan.appPort = originPort(plan.appUrl);
  // THE TWO ROADS. An address the operator NAMED is the address the container
  // is given, character for character: they named it because they know what the
  // container can reach, and rewriting it would undo the only thing the flag is
  // for. A DERIVED address comes from the instance's own environment, which
  // publishes the app under this machine's loopback — which inside a container
  // means the container — so that one is dialled through the container's
  // gateway to the host, exactly as it always was.
  plan.callbackUrl =
    chosen.appUrl == null && isLoopbackHost(app.hostname)
      ? `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:${plan.appPort}`
      : plan.appUrl;
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

// --- the document this verb writes -----------------------------------------

/** Neither a key nor a value: a blank line, or a comment at any indentation. */
function isInertLine(line) {
  return /^\s*(?:#.*)?$/.test(line);
}

/**
 * The runtime service's own block inside a rendered compose document, or null.
 * Line-oriented on purpose: this module substitutes into a template rather than
 * serializing YAML, and the same discipline holds here. The service is found by
 * its key AT THE INDENTATION OF A SERVICE, so a `wayflow:` nested inside another
 * service (under its `depends_on:`, say) is never taken for it; its block runs
 * to the next line indented no deeper than that key; comments decide nothing;
 * and nothing outside the block is ever touched.
 *
 * @returns {{ at: number, end: number, childIndent: string }|null}
 */
function runtimeServiceBlock(lines) {
  const servicesAt = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
  if (servicesAt === -1) return null;
  const indentOf = (line) => /^\s*/.exec(line)[0];
  let serviceIndent = null;
  for (let i = servicesAt + 1; i < lines.length; i += 1) {
    if (isInertLine(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent === "") return null; // the next top-level key ends `services:`
    serviceIndent ??= indent;
    if (indent !== serviceIndent) continue; // a key of some service, not a service
    const key = lines[i].slice(indent.length).replace(/\s*(?:#.*)?$/, "");
    if (key !== `${INSTANCE_RUNTIME_SERVICE}:`) continue;
    let end = i + 1;
    while (
      end < lines.length &&
      (isInertLine(lines[end]) || indentOf(lines[end]).length > indent.length)
    ) {
      end += 1;
    }
    // Blank and comment lines trailing the block introduce whatever follows it.
    while (end > i + 1 && isInertLine(lines[end - 1])) end -= 1;
    const child = lines.slice(i + 1, end).find((line) => !isInertLine(line));
    return { at: i, end, childIndent: child ? indentOf(child) : `${indent}  ` };
  }
  return null;
}

/** The line of a key set directly on the runtime service, or -1. */
function serviceKeyLine(lines, block, key) {
  for (let i = block.at + 1; i < block.end; i += 1) {
    if (lines[i].startsWith(`${block.childIndent}${key}:`)) return i;
  }
  return -1;
}

/** A literal string, as a regular expression matches it. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The document this verb WRITES, from the document the template rendered.
 *
 * A start that names nothing writes exactly what the checkout's template
 * renders, as it always has. What an operator NAMES is this start's choice
 * rather than the checkout's, so it is said here, on the runtime service alone:
 *
 *   * THE CALLBACK. The template dials the app through the container's gateway
 *     to the host, which is right when nobody named an address and wrong when
 *     somebody did — so an address the operator named replaces it.
 *   * THE IMAGE. The tag is theirs; the template's own is this checkout's.
 *   * THE CONTAINER'S NAME. Written as the service's `container_name`, which is
 *     what makes the engine use it — and what a later `stop` reads back,
 *     instead of re-deriving a name this start did not use.
 *
 * Pure: text in, text out. The caller writes it, or compares it with what is
 * already on disk to answer "is there anything to do?".
 */
export function instanceRuntimeComposeDocument(rendered, plan) {
  const document = String(rendered);
  const templateCallback = `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:${plan.appPort}`;
  const callbackNamed = plan.callbackUrl !== templateCallback;
  if (!callbackNamed && !plan.imageNamed && !plan.containerNamed) return document;

  const lines = document.split("\n");
  const block = runtimeServiceBlock(lines);
  if (!block) {
    throw new Error(
      `Instance "${plan.slug}": this checkout's runtime compose template declares no ` +
        `\`${INSTANCE_RUNTIME_SERVICE}\` service, so what you named could not be written into it. ` +
        `Update the checkout, then re-run this command.`,
    );
  }

  if (callbackNamed) {
    // The full port only: the callback on 3301 must never match the front of an
    // address on 33010.
    const pattern = new RegExp(`${escapeRegExp(templateCallback)}(?![0-9])`, "g");
    let replaced = 0;
    for (let i = block.at + 1; i < block.end; i += 1) {
      lines[i] = lines[i].replace(pattern, () => {
        replaced += 1;
        return plan.callbackUrl;
      });
    }
    // Said out loud rather than written silently: an address that could not be
    // put in place is an address the container would not be given, and the
    // operator would find that out at the probe with no idea why.
    if (replaced === 0) {
      throw new Error(
        `Instance "${plan.slug}": this checkout's runtime compose template does not dial the app ` +
          `at ${templateCallback}, so the address you named (${plan.callbackUrl}) could not be put ` +
          `in its place and the container would not have been given it. Update the checkout, or ` +
          `drop \`--app-url\` to use the address the template names.`,
      );
    }
  }

  /** Set one key on the service: in place when the template has it, else added. */
  const setServiceKey = (key, value) => {
    const line = `${block.childIndent}${key}: "${value}"`;
    const at = serviceKeyLine(lines, block, key);
    if (at !== -1) {
      lines[at] = line;
      return;
    }
    lines.splice(block.at + 1, 0, line);
    block.end += 1;
  };
  if (plan.imageNamed) setServiceKey("image", plan.image);
  if (plan.containerNamed) setServiceKey("container_name", plan.container);
  return lines.join("\n");
}

/** The container name a written document RECORDS on the runtime service, or
 *  `fallback`. A `stop` reads this instead of re-deriving a name: a start given
 *  `--container <name>` wrote that name here, and the derivation would then
 *  stop nothing at all. A document that is not there, or that names no
 *  container, falls back to what the caller derived — the name compose itself
 *  gives the service. */
export function recordedContainerName(document, fallback = null) {
  const lines = String(document ?? "").split("\n");
  const block = runtimeServiceBlock(lines);
  if (!block) return fallback;
  const at = serviceKeyLine(lines, block, "container_name");
  if (at === -1) return fallback;
  const match = /^\s*container_name:\s*(["']?)([A-Za-z0-9][A-Za-z0-9_.-]*)\1\s*(?:#.*)?$/.exec(
    lines[at],
  );
  return match ? match[2] : fallback;
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

/** Is that image on this machine? Asked of a NAMED image before anything is
 *  started, because an image the operator named is one this verb never pulls
 *  and never builds — so its absence is a refusal, not a build. */
export function dockerImageInspectArgs(image) {
  return ["image", "inspect", image];
}

/** The label that ties a built image to the commit it was built from, so a
 *  caller can read a running container's image and know which checkout it
 *  carries. Outside a checkout there is no commit to name, and no label. */
export function imageRevisionLabelArgs(revision) {
  const sha = String(revision ?? "").trim();
  return sha ? ["--label", `${INSTANCE_RUNTIME_IMAGE_REVISION_LABEL}=${sha}`] : [];
}

/** Read one container's state. A container that is not there answers non-zero,
 *  which `parseRuntimeContainerState` reads as absent. */
export function dockerRuntimeInspectArgs(plan) {
  return ["inspect", "--format", "{{.State.Status}}", plan.container];
}

/** Read the compose project off a container's own labels — asked of one found
 *  under a name the operator chose, before it is stopped or removed. */
export function dockerContainerProjectArgs(plan) {
  return [
    "inspect",
    "--format",
    '{{index .Config.Labels "com.docker.compose.project"}}',
    plan.container,
  ];
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

/** Is the container that label read was asked of THIS instance's own? Only a
 *  label naming this instance's compose project says yes. One that could not
 *  be read is not taken on trust. */
export function containerBelongsToInstance(plan, result = {}) {
  if (result?.error || (result?.status ?? 1) !== 0) return false;
  return String(result?.stdout ?? "").trim() === plan.composeProject;
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
 *  ADDRESS — whatever that address turned out to be — because that address is
 *  the thing that is wrong and the operator cannot see it from outside the
 *  container. It carries no credential: it is an origin and nothing more. */
export function unreachableAppMessage(plan) {
  return (
    `Instance "${plan.slug}": the agent runtime container ${plan.container} cannot reach this ` +
    `instance's app at ${plan.callbackUrl}. That is the address the runtime calls back on, and ` +
    `every agent run fails until it answers. Start this instance's app on port ${plan.appPort} ` +
    `first, or name an address the CONTAINER can reach it on — \`--app-url\` is honoured exactly ` +
    `as you write it, and inside a container this machine's own loopback means the container ` +
    `itself. Then re-run this command.`
  );
}

/** The refusal when a container found under a name the operator chose is not
 *  this instance's. This command stops and removes only its own container, and
 *  a chosen name can belong to anything on the machine. */
export function foreignContainerMessage(plan) {
  return (
    `Instance "${plan.slug}": the container named ${plan.container} on this machine is not this ` +
    `instance's agent runtime — it does not belong to compose project ${plan.composeProject} — so ` +
    `this command has neither stopped nor removed it. It touches only its own container: remove ` +
    `that one yourself if it is yours to remove, or start this instance's runtime under another ` +
    `name with \`--container\`.`
  );
}

/** The refusal when the image the operator NAMED is not on this machine. The
 *  tag is theirs, so what belongs under it is their answer and not this verb's
 *  guess — it neither pulls it nor builds it, and says so. */
export function missingNamedImageMessage(plan) {
  return (
    `Instance "${plan.slug}": there is no image named ${plan.image} on this machine. An image you ` +
    `name with \`--image\` is yours: this verb never pulls it and never builds it, because what ` +
    `belongs under your own tag is your answer and not its guess. Put it there, then re-run this ` +
    `command — or drop \`--image\` to run this checkout's own ${INSTANCE_RUNTIME_DEFAULT_IMAGE}, ` +
    `which \`--rebuild\` builds again from the checkout you are in.`
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
    `and build the image again (\`--rebuild\` for this checkout's own ` +
    `${INSTANCE_RUNTIME_DEFAULT_IMAGE}) if it carries no node, then re-run this command.`
  );
}
