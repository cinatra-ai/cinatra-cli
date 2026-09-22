// ---------------------------------------------------------------------------
// Per-instance `cinatra instance start` (cinatra-cli#261).
//
// WHY THIS MODULE EXISTS
// ----------------------
// `instance start` derived EVERYTHING from one hardcoded slug: the runtime
// directory, the pid file, the log and the runtime lock all lived under that
// single name, so a second checkout on the same machine had no start verb at
// all — its start either refused ("does not match the main checkout") or, worse,
// wrote over the first one's runtime state. The spawn also named no bind
// address, so an operator who wanted an instance reachable only over loopback
// could not say so, and the app took the dev server's own default.
//
// The per-slug machinery already existed next door, on the clone road
// (`clone-runtime.mjs`): a runtime directory, a pid path, a log path and a lock
// path, all keyed by slug. What was missing is the verb-side derivation — the
// one place that turns an operator's `--instance <slug>` plus the instance's own
// environment into the complete set of names, paths and ports that instance
// owns — and a way to know what the OTHER instances on this machine currently
// hold, so a start that would collide is refused by name instead of failing at
// `pnpm dev` with an address already in use.
//
// This module is that derivation. It is PURE (plus a small record file it reads
// and writes): no spawn, no docker, no network, no clone registry. `index.mjs`
// resolves a plan here and then does exactly what it did before — take the
// lock, check the pid, spawn — only now on the plan's paths and with the plan's
// argument list.
//
// THE DEFAULT IS UNCHANGED. With no flags the plan is the single-instance one:
// the same slug, the same pid/log/lock paths, the same spawned argument list
// (`["dev"]`) and an EMPTY environment overlay, so the spawn's environment is
// byte for byte what it was. Everything new is opt-in.
//
// Public surface:
//   - selector:   parseInstanceStartFlags, DEFAULT_INSTANCE_SLUG
//   - derivation: resolveInstanceStartPlan, instanceComposeProject,
//                 instanceRuntimeContainer, instanceQueueName,
//                 runtimePortFromEnv
//   - record:     instanceRecordPath, writeInstanceRecord, readInstanceRecord,
//                 clearInstanceRecord, listInstanceRecords
//   - refusal:    assertInstanceStartFree
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isValidSlug } from "./clone-registry.mjs";
import {
  cloneLockPath,
  cloneLogPath,
  clonePidPath,
  cloneRuntimeDir,
  isPidAlive,
} from "./clone-runtime.mjs";
import { DEV_MAIN_SLUG } from "./dev-tunnel-identity.mjs";
import { DEFAULT_APP_PORT, DEFAULT_WAYFLOW_PORT } from "./instance-alloc.mjs";
import { coUseQueueName } from "./install-couse.mjs";

// --- constants -------------------------------------------------------------

/** The slug a start with no `--instance` uses — the reserved single-instance
 *  name the verb has always used. ONE definition (imported), so the per-instance
 *  road and the dev-tunnel road can never disagree about which slug is "the"
 *  instance of a checkout that names none. */
export const DEFAULT_INSTANCE_SLUG = DEV_MAIN_SLUG;

/** The file, next to the pid file in the instance's own runtime directory, that
 *  records WHAT this instance holds (its ports, its names, its checkout). The
 *  pid file alone says only that something runs — it cannot answer "which port
 *  does the instance called `web-a` hold?", which is exactly what a second
 *  instance's start must ask before it binds anything. */
export const INSTANCE_RECORD_FILE = "instance.json";

/** The env keys the plan may overlay on the spawn — the product's own keys, so
 *  nothing here invents a second vocabulary for the app to learn. */
export const INSTANCE_PORT_KEY = "PORT";
export const INSTANCE_RUNTIME_URL_KEY = "WAYFLOW_BASE_URL";
export const INSTANCE_QUEUE_KEY = "BULLMQ_QUEUE_NAME";

// A bind address as it may appear in an argument list: a bare IPv4/IPv6/host
// token. Deliberately narrow — the value is forwarded to the spawned dev server
// as an argument, so anything carrying whitespace or a leading dash (i.e. a
// second flag smuggled through one value) is refused rather than passed on.
const BIND_ADDRESS_RE = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,62}|[0-9A-Fa-f:]{2,45}|\[[0-9A-Fa-f:]{2,45}\])$/;

// --- flag parsing ----------------------------------------------------------

/**
 * Read `--flag <value>` / `--flag=<value>` out of an argv. Mirrors the CLI's own
 * option reader (the `=` form first, so it is never silently ignored); kept
 * local so this module stays a leaf that `index.mjs` can import, never the
 * reverse.
 */
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

/** Validate the instance name. A slug names a directory, a container and a
 *  queue, so it must be a plain lower-case name — the SAME shape the rest of the
 *  CLI accepts for a slug (one definition, `isValidSlug`). */
function assertSlug(value) {
  if (!isValidSlug(value)) {
    throw new Error(
      `Invalid --instance "${value}". An instance name is a plain lower-case name ` +
        `(letters, digits and dashes, starting with a letter or digit, at most 30 characters).`,
    );
  }
  return value;
}

/** Validate an explicit port. Shape only — whether it is FREE is the refusal's
 *  job (assertInstanceStartFree), which needs the other instances in scope. */
function assertPort(flag, value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || String(n) !== String(value).trim() || n < 1024 || n > 65535) {
    throw new Error(`Invalid ${flag} "${value}". Must be an integer between 1024 and 65535.`);
  }
  return n;
}

/** Validate an explicit bind address. */
function assertBind(value) {
  if (typeof value !== "string" || !BIND_ADDRESS_RE.test(value)) {
    throw new Error(
      `Invalid --bind "${value}". Pass a bare address — \`--bind 127.0.0.1\` for a loopback-only instance.`,
    );
  }
  return value;
}

/**
 * The start/stop/restart selector and the explicit values, out of one argv.
 * Absent flags are null — "nothing was chosen" — so the plan can tell an
 * operator's choice apart from a value that merely matches a default.
 *
 * @param {string[]} argv
 * @returns {{ slug: string, port: number|null, runtimePort: number|null, bind: string|null }}
 */
export function parseInstanceStartFlags(argv = []) {
  const rawSlug = readFlag(argv, "--instance");
  const rawPort = readFlag(argv, "--port");
  const rawRuntimePort = readFlag(argv, "--runtime-port");
  const rawBind = readFlag(argv, "--bind");
  return {
    slug: rawSlug === null ? DEFAULT_INSTANCE_SLUG : assertSlug(rawSlug),
    port: rawPort === null ? null : assertPort("--port", rawPort),
    runtimePort: rawRuntimePort === null ? null : assertPort("--runtime-port", rawRuntimePort),
    bind: rawBind === null ? null : assertBind(rawBind),
  };
}

// --- derived names ---------------------------------------------------------

/** The compose project a per-instance agent runtime belongs to. Slug-keyed, so
 *  two instances never address one another's containers. */
export function instanceComposeProject(slug) {
  return `cinatra-instance-${assertSlug(slug)}`;
}

/** The container name that project's runtime service carries (Compose's own
 *  `<project>-<service>-<n>` shape), so the start verb and the runtime verb
 *  name the same container for the same instance. */
export function instanceRuntimeContainer(slug) {
  return `${instanceComposeProject(slug)}-wayflow-1`;
}

/** The instance's job-queue name. The SAME derivation a second instance sharing
 *  one cache already gets from `install` — one definition, so a slug that was
 *  installed beside another instance and a slug that is merely started beside
 *  one address the same queue. */
export function instanceQueueName(slug) {
  return coUseQueueName(assertSlug(slug));
}

/** The port the instance's recorded runtime endpoint publishes, or null when the
 *  environment records none/an unusable one. */
export function runtimePortFromEnv(env = {}) {
  const raw = typeof env[INSTANCE_RUNTIME_URL_KEY] === "string" ? env[INSTANCE_RUNTIME_URL_KEY].trim() : "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

// --- the plan --------------------------------------------------------------

/**
 * Everything one `instance start|stop|restart` needs about ONE instance:
 * its runtime paths, its names, its ports, the argument list to spawn and the
 * environment overlay to spawn it under.
 *
 * With no flags this is the single-instance plan, unchanged: the reserved slug,
 * its runtime paths, `["dev"]` and an EMPTY overlay.
 *
 * @param {object} args
 * @param {string[]} [args.argv]   the verb's argv (the selector + explicit values)
 * @param {object}   [args.flags]  already-parsed flags (argv is parsed when absent)
 * @param {Record<string,string>} [args.env]  the instance's own environment
 *        (`.env.local` overlaid by the process environment — collectEnvironment)
 * @param {string}   [args.home]   state-root override for hermetic tests
 */
export function resolveInstanceStartPlan({ argv = [], flags = null, env = {}, home } = {}) {
  const chosen = flags ?? parseInstanceStartFlags(argv);
  const slug = chosen.slug ?? DEFAULT_INSTANCE_SLUG;
  assertSlug(slug);
  const isDefault = slug === DEFAULT_INSTANCE_SLUG;
  const opts = home === undefined ? undefined : { home };

  const envPort = Number.parseInt(String(env?.[INSTANCE_PORT_KEY] ?? ""), 10);
  const port = chosen.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_APP_PORT);
  const runtimePort = chosen.runtimePort ?? runtimePortFromEnv(env) ?? DEFAULT_WAYFLOW_PORT;

  const envQueue = typeof env?.[INSTANCE_QUEUE_KEY] === "string" ? env[INSTANCE_QUEUE_KEY].trim() : "";
  // The instance's own recorded queue always wins — the app, its workers and
  // `doctor` all read that key, and a start is no place to rename a queue an
  // install authored. A NAMED instance whose environment records none gets the
  // per-slug queue, so two instances sharing one cache never drain each other's
  // jobs; the single-instance default keeps whatever it had (nothing to derive).
  const queueName = envQueue || (isDefault ? null : instanceQueueName(slug));

  // The environment overlay is EXACTLY the operator's explicit choices (plus the
  // derived queue a named instance had no value for). Empty for the untouched
  // default, so its spawn environment is byte for byte the historical one.
  const envOverrides = {};
  if (chosen.port != null) envOverrides[INSTANCE_PORT_KEY] = String(port);
  if (chosen.runtimePort != null) envOverrides[INSTANCE_RUNTIME_URL_KEY] = `http://localhost:${runtimePort}`;
  if (!envQueue && queueName) envOverrides[INSTANCE_QUEUE_KEY] = queueName;

  // The bind address travels as an ARGUMENT to the dev server (`--hostname`),
  // which is what makes an instance loopback-only. Unset keeps the argument list
  // the dev server's own default: `["dev"]`.
  const spawnArgs = chosen.bind ? ["dev", "--hostname", chosen.bind] : ["dev"];

  return {
    slug,
    isDefault,
    // What the verb calls this instance in its own output — `label` starts a
    // sentence, `target` sits inside one. The default keeps the wording it has
    // always printed.
    label: isDefault ? "Dev main" : `Instance "${slug}"`,
    target: isDefault ? "the dev main" : `instance "${slug}"`,
    runtimeDir: cloneRuntimeDir(slug, opts),
    pidPath: clonePidPath(slug, opts),
    logPath: cloneLogPath(slug, opts),
    lockPath: cloneLockPath(slug, opts),
    recordPath: instanceRecordPath(slug, opts),
    port,
    runtimePort,
    portExplicit: chosen.port != null,
    runtimePortExplicit: chosen.runtimePort != null,
    bind: chosen.bind ?? null,
    composeProject: instanceComposeProject(slug),
    runtimeContainer: instanceRuntimeContainer(slug),
    queueName,
    appUrl: `http://localhost:${port}`,
    healthUrl: `http://localhost:${port}/api/health`,
    spawnArgs,
    envOverrides,
  };
}

// --- the record ------------------------------------------------------------

/** Where an instance records what it holds. */
export function instanceRecordPath(slug, opts) {
  return path.join(cloneRuntimeDir(slug, opts), INSTANCE_RECORD_FILE);
}

/**
 * Record what this instance holds, next to its pid file. Written after the
 * spawn, so a record's presence plus a live pid is what "another running
 * instance" means to every other start on this machine. Atomic (temp+rename),
 * mode 0600 — the same discipline the registries use.
 */
export function writeInstanceRecord(plan, { pid, home } = {}) {
  const opts = home === undefined ? undefined : { home };
  const dir = cloneRuntimeDir(plan.slug, opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    slug: plan.slug,
    pid: Number.isInteger(pid) ? pid : null,
    repoRoot: plan.repoRoot ?? null,
    port: plan.port,
    runtimePort: plan.runtimePort,
    bind: plan.bind ?? null,
    composeProject: plan.composeProject,
    runtimeContainer: plan.runtimeContainer,
    queueName: plan.queueName ?? null,
    startedAt: new Date().toISOString(),
  };
  const target = instanceRecordPath(plan.slug, opts);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return record;
}

/** The recorded instance, or null when there is none / it is unreadable. A
 *  corrupt record is never fatal: the start road falls back to the pid file and
 *  the live port probe. */
export function readInstanceRecord(slug, opts) {
  try {
    const parsed = JSON.parse(readFileSync(instanceRecordPath(slug, opts), "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.slug !== slug) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the record — the instance no longer holds anything. */
export function clearInstanceRecord(slug, opts) {
  try {
    rmSync(instanceRecordPath(slug, opts), { force: true });
  } catch {
    /* best-effort: a record nobody can remove is still gated on a live pid */
  }
}

/**
 * Every instance on this machine that is still RUNNING: a record whose recorded
 * process is alive. A record whose process is gone is left out — a start facing
 * it repairs it rather than refusing.
 *
 * `isAlive` decides what "still running" means, and the answer matters: a
 * record outlives the machine, and pids are recycled, so a bare `kill -0` (this
 * module's dependency-free default) eventually calls an unrelated process a
 * running instance and refuses a start whose ports are free. The verb passes
 * the command-line probe (`isInstanceProcessRunning`) for exactly that reason;
 * the default stays the pure one so this module spawns nothing of its own.
 *
 * @param {object} [args]
 * @param {string} [args.home]     state-root override for hermetic tests
 * @param {(pid:number)=>boolean} [args.isAlive]  liveness probe (injectable)
 */
export function listInstanceRecords({ home, isAlive = isPidAlive } = {}) {
  const opts = home === undefined ? undefined : { home };
  // The state root is the parent of any instance's runtime directory.
  const root = path.dirname(cloneRuntimeDir(DEFAULT_INSTANCE_SLUG, opts));
  if (!existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSlug(entry.name)) continue;
    const record = readInstanceRecord(entry.name, opts);
    if (!record || !Number.isInteger(record.pid) || !isAlive(record.pid)) continue;
    out.push(record);
  }
  return out.sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
}

// --- the refusal -----------------------------------------------------------

/**
 * Refuse a start whose slug or whose ports another RUNNING instance of this
 * machine already holds. The message names the instance and the port and
 * nothing else — not the holder's checkout, not its environment.
 *
 * The instance's OWN record is never a refusal: a re-run of the same start on
 * the same checkout is the idempotent path the verb already handles.
 *
 * @param {object} plan     the plan being started (resolveInstanceStartPlan)
 * @param {object} args
 * @param {object[]} args.records  the running instances (listInstanceRecords)
 * @param {string} [args.repoRoot] the checkout this start belongs to
 */
export function assertInstanceStartFree(plan, { records = [], repoRoot = null } = {}) {
  for (const record of records) {
    if (!record || typeof record.slug !== "string") continue;

    if (record.slug === plan.slug) {
      // The same name, another checkout: the instance exists already and this
      // start would fight it for its runtime directory.
      if (repoRoot != null && record.repoRoot != null && record.repoRoot !== repoRoot) {
        throw new Error(
          `${plan.label} is already running from another checkout (pid ${record.pid}). ` +
            `Stop it (\`cinatra instance stop --instance ${plan.slug}\`) or start this one under ` +
            `another name (\`--instance <name>\`).`,
        );
      }
      continue;
    }

    for (const [kind, wanted, flag] of [
      ["app port", plan.port, "--port"],
      ["runtime port", plan.runtimePort, "--runtime-port"],
    ]) {
      if (!Number.isInteger(wanted)) continue;
      if (record.port === wanted || record.runtimePort === wanted) {
        throw new Error(
          `${plan.label}: ${kind} ${wanted} is already held by the running instance "${record.slug}". ` +
            `Start this one on another port (\`${flag} <n>\`) or stop that instance ` +
            `(\`cinatra instance stop --instance ${record.slug}\`).`,
        );
      }
    }
  }
  return plan;
}
