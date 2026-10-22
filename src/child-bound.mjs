// Shared child-wait helpers: every synchronous child wait is bounded from its
// spawn, and an expired bound is a named failure.
//
// - `boundedOptions` gives a spawnSync/execFileSync/execSync call its bound
//   AND `killSignal: "SIGKILL"`. spawnSync's default kill signal is SIGTERM,
//   so a bare `timeout` does not stop a child that ignores SIGTERM.
// - `childTimedOut` / `childTimeoutError` turn an expired bound into an error
//   whose `code` is "CHILD_TIMEOUT"; a wrapper that re-words it keeps the code.
// - `readChild` judges a child by its exit status first and reads its output
//   only after a zero status; every failure carries a reason. A bound that is
//   not a whole number of milliseconds of at least 1 (`isValidBound`) is
//   refused before anything starts.
// - `checkedBound` returns a valid bound and throws CHILD_BOUND_INVALID for
//   any other value, so a bound computed at run time (`0`, `null`, `NaN`)
//   stops the call before its child is started.
// - `siteBound` passes a call site's own bound through `checkedBound`, so a
//   test can shorten it through an import of `__setChildBoundsForTest`;
//   production keeps the constant.
// - `spawnBounded` is the one bounded spawn of every swept site: the bound
//   goes through `checkedBound`, then `boundedOptions`. With Node's spawnSync
//   on a POSIX platform the command runs below `child-bound-watchdog.mjs`,
//   which SIGKILLs the command's whole process group at the bound, at a
//   SIGTERM or SIGHUP, and when the waiting caller is gone; a Ctrl-C or a
//   Ctrl-Z of the caller's job reaches the command. A
//   descendant that leaves that group (setsid, a detached spawn) is not
//   reached. On win32, or with any other spawn, the call is the plain
//   bounded spawn: spawnSync SIGKILLs the child and closes its pipes.
// - `childResultRefused` is the first question of every status reader: a
//   result with a spawn error, a timeout, a signal or no whole exit status is
//   refused before its status or output is read.
// - `sleepSync` waits in-process; nothing is spawned.
//
// Each of the first six helpers is the install road's own declaration in
// `install.mjs` with `export ` put before it; a test compares the two texts.
//
// This module imports only node built-ins, so any module can import it
// without an import cycle.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function boundedOptions(options, timeoutMs) {
  return { ...options, timeout: timeoutMs, killSignal: "SIGKILL" };
}

export function describeBound(timeoutMs) {
  return timeoutMs >= 60_000 && timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} min` : `${timeoutMs / 1000} s`;
}

/** True when spawnSync stopped the child because its bound expired. */
export function childTimedOut(result) {
  return result?.error?.code === "ETIMEDOUT";
}

/** The word that names a child in a timeout message: the first argument that
 *  is neither a flag nor the value of git's `-C` / `-c` option, so
 *  `git -C <dir> status` is named `git status` and `docker ps -a` `docker ps`. */
export function childSubcommand(args) {
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (typeof a !== "string") continue;
    if (a === "-C" || a === "-c") {
      i += 1;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return null;
}

/** The named failure of an expired bound. */
export function childTimeoutError(command, args, timeoutMs) {
  const word = childSubcommand(args);
  const sub = word ? ` ${word}` : "";
  const err = new Error(
    `\`${path.basename(String(command))}${sub}\` did not finish within ${describeBound(timeoutMs)}; it was stopped.`,
  );
  err.code = "CHILD_TIMEOUT";
  return err;
}

/** An advisory read: one whose answer only shapes a message or an optional
 *  note and whose existing contract already degrades a failed read to "no
 *  answer". An expired bound degrades it the same way, and `onTimeout`
 *  receives the named failure so a caller with a log can say so. Every other
 *  throw propagates. A read whose answer decides an action is never advisory. */
export function advisoryRead(read, onTimeout) {
  try {
    return read();
  } catch (err) {
    if (err?.code !== "CHILD_TIMEOUT") throw err;
    if (typeof onTimeout === "function") onTimeout(err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bound classes
// ---------------------------------------------------------------------------

const BOUND_CLASSES = Object.freeze({
  /** A docker CLI probe (`docker ps`, `docker compose version`). */
  probe: 15_000,
  /** A short read (git rev-parse, a status listing, `--version`). */
  read: 60_000,
  /** A compose stop or restart. */
  compose: 2 * 60_000,
  /** A git transfer (clone, fetch, worktree add). */
  git: 15 * 60_000,
  /** A long step with inherited output (a dependency install, a build). */
  step: 60 * 60_000,
});

let boundOverrideMs = null;

/** The bound of a class of child wait: `probe`, `read`, `compose`, `git` or
 *  `step`. Under `__setChildBoundsForTest` every class returns the override. */
export function boundFor(cls) {
  if (!Object.hasOwn(BOUND_CLASSES, cls)) throw new Error(`unknown bound class: ${cls}`);
  return boundOverrideMs ?? BOUND_CLASSES[cls];
}

/** The bound of one call site: its own `ms`, or the test override when one
 *  is set. `ms` goes through `checkedBound` first, also under an override, so
 *  a value that is not a usable bound throws CHILD_BOUND_INVALID before the
 *  site's child is started; production behaviour is `ms` itself. */
export function siteBound(ms) {
  const bound = checkedBound(ms);
  return boundOverrideMs ?? bound;
}

/** True only for a usable spawn bound: a whole number of milliseconds of at
 *  least 1. `0` (which spawnSync reads as no bound), negative numbers, NaN,
 *  infinities, fractions, strings and null are all refused. */
export function isValidBound(ms) {
  return Number.isInteger(ms) && ms >= 1;
}

function describeInvalidBound(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** `ms` when it is a usable bound (`isValidBound`); any other value throws an
 *  error whose `code` is "CHILD_BOUND_INVALID". A call site that passes it as
 *  its bound argument throws before its child is started. */
export function checkedBound(ms) {
  if (isValidBound(ms)) return ms;
  const err = new Error(`the bound ${describeInvalidBound(ms)} is not a whole number of milliseconds of at least 1`);
  err.code = "CHILD_BOUND_INVALID";
  throw err;
}

/** Tests only: make every `boundFor` and `siteBound` return `ms` (null
 *  restores the classes and the sites' constants). A value that is not a
 *  usable bound throws CHILD_BOUND_INVALID and keeps the override as it was.
 *  Reachable by import alone; no environment variable or flag sets it. */
export function __setChildBoundsForTest(ms) {
  boundOverrideMs = ms == null ? null : checkedBound(ms);
}

// ---------------------------------------------------------------------------
// The bounded spawn, and the refusal of an unreadable result
// ---------------------------------------------------------------------------

const WATCHDOG = fileURLToPath(new URL("./child-bound-watchdog.mjs", import.meta.url));
// Node's own spawnSync, read past any module mock: only that one is watched.
const NODE_SPAWN_SYNC = process.getBuiltinModule("node:child_process").spawnSync;

/** One bounded `spawn(command, args, options)`: `timeoutMs` goes through
 *  `checkedBound` (CHILD_BOUND_INVALID before anything starts). With Node's
 *  spawnSync off win32 the command runs below the watchdog, in a group of its
 *  own; spawnSync stops the watchdog by SIGTERM at `timeoutMs`, and the
 *  watchdog SIGKILLs the group. Its fd-3 note gives back the command's pid
 *  and start error, so the result reads as the command's own; a result with
 *  no note is the error ENOWATCHDOGNOTE, never a status. Any other
 *  `spawn` (a stand-in or a module mock), and win32, get the command itself
 *  under `boundedOptions`. */
export function spawnBounded(spawn, command, args, options, timeoutMs) {
  const bound = checkedBound(timeoutMs);
  if (spawn !== NODE_SPAWN_SYNC || process.platform === "win32") return spawn(command, [...args], boundedOptions(options, bound));
  const io = options?.stdio ?? "pipe";
  const stdio = Array.isArray(io) ? [io[0] ?? "pipe", io[1] ?? "pipe", io[2] ?? "pipe", "pipe"] : [io, io, io, "pipe"];
  // Node's own startup variables (NODE_*) of a given env reach the command,
  // not the watchdog: a NODE_OPTIONS preload must not run (or end) the
  // watchdog in the command's place. An inherited env is the caller's own.
  const watched = { ...boundedOptions(options, bound), killSignal: "SIGTERM", stdio };
  if (options?.env != null) {
    const nodeVars = {};
    watched.env = {};
    for (const [k, v] of Object.entries(options.env)) (k.startsWith("NODE_") ? nodeVars : watched.env)[k] = v;
    watched.env.NODE_CHILD_BOUND_ENV = JSON.stringify(nodeVars);
  }
  const envArg = options?.env != null ? "moved" : "own";
  const r = spawn(process.execPath, [WATCHDOG, String(process.pid), String(bound), envArg, String(command), ...args], watched);
  let note = null;
  try {
    note = JSON.parse(String(r.output?.[3] ?? ""));
  } catch {
    // No note: the watchdog itself did not start (r.error says why).
  }
  if (Array.isArray(r.output)) r.output = r.output.slice(0, 3);
  if (Number.isInteger(note?.pid)) r.pid = note.pid;
  if (r.error == null && !Number.isInteger(note?.pid)) {
    // No pid: the note's own error, or, with no readable note, the watchdog
    // ended before it said anything (its status is not the command's).
    const code = typeof note?.error?.code === "string" ? note.error.code : "ENOWATCHDOGNOTE";
    r.error = Object.assign(new Error(`spawnSync ${command} ${code}`), note?.error, { code, syscall: `spawnSync ${command}`, spawnargs: [...args] });
    r.status = null;
  }
  return r;
}

/** True when a spawnSync result must not be read as an exit status: no
 *  result, a spawn error (an expired bound is one), a signal death, or a
 *  status that is not a whole number of at least 0 (NaN, a fraction, an
 *  infinity, a negative number, a string, null). A child whose descendant
 *  holds the pipes after it exits 0 comes back as status 0 WITH a timeout
 *  error; this refuses it. Every status reader asks this first. */
export function childResultRefused(r) {
  if (r === null || typeof r !== "object") return true;
  if (r.error != null || childTimedOut(r)) return true;
  if (r.signal != null) return true;
  return !(Number.isInteger(r.status) && r.status >= 0);
}

// ---------------------------------------------------------------------------
// readChild
// ---------------------------------------------------------------------------

function childLabel(command, args) {
  const word = childSubcommand(args);
  return `${path.basename(String(command))}${word ? ` ${word}` : ""}`;
}

/** One bounded child wait, judged by its exit status first.
 *
 *  Returns `{ ok, status, stdout, stderr, signal, error, timedOut, code,
 *  reason, value }`. `ok` is true only for exit status 0 with no spawn error.
 *  On failure `code` is "CHILD_TIMEOUT" (the bound expired; `error` is then
 *  the named CHILD_TIMEOUT error), "CHILD_BOUND_INVALID" (`timeoutMs` is not
 *  a whole number of milliseconds of at least 1; nothing was started) or
 *  "CHILD_FAILED", and `reason` names it:
 *  "<cmd> <sub> exited <N>", "killed by <SIG>", "could not run <cmd>: <msg>",
 *  or the timeout message.
 *
 *  With `parse`, output is read only after status 0: `value` is
 *  `parse(stdout)`, and a parse that throws or returns undefined is a failure
 *  ("<cmd> <sub> answered unreadable output"), never an empty answer. */
export function readChild(command, args, { timeoutMs, parse, ...options } = {}) {
  const ms = timeoutMs === undefined ? boundFor("read") : timeoutMs;
  const argv = Array.isArray(args) ? args : [];
  const base = { ok: false, status: null, stdout: "", stderr: "", signal: null, error: null, timedOut: false, code: "CHILD_FAILED", reason: null, value: undefined };
  if (!isValidBound(ms)) {
    // Refused before anything is started: only `undefined` falls back to the
    // read class, so a null or a computed NaN never runs unbounded.
    const err = new Error(`the bound ${describeInvalidBound(ms)} is not a whole number of milliseconds of at least 1`);
    err.code = "CHILD_BOUND_INVALID";
    return { ...base, error: err, code: "CHILD_BOUND_INVALID", reason: err.message };
  }
  let r;
  try {
    r = spawnBounded(spawnSync, command, argv, { encoding: "utf8", ...options }, checkedBound(ms));
  } catch (err) {
    return { ...base, error: err, reason: `could not run ${path.basename(String(command))}: ${err?.message ?? err}` };
  }
  const out = {
    ...base,
    status: typeof r.status === "number" ? r.status : null,
    stdout: r.stdout == null ? "" : String(r.stdout),
    stderr: r.stderr == null ? "" : String(r.stderr),
    signal: r.signal ?? null,
  };
  if (childTimedOut(r)) {
    const err = childTimeoutError(command, argv, ms);
    return { ...out, status: null, timedOut: true, error: err, code: "CHILD_TIMEOUT", reason: err.message };
  }
  if (r.error) {
    return { ...out, error: r.error, reason: `could not run ${path.basename(String(command))}: ${r.error.message}` };
  }
  if (out.status === null) {
    return { ...out, reason: `killed by ${out.signal ?? "a signal"}` };
  }
  if (out.status !== 0) {
    return { ...out, reason: `${childLabel(command, argv)} exited ${out.status}` };
  }
  if (typeof parse === "function") {
    let value;
    try {
      value = parse(out.stdout);
    } catch {
      value = undefined;
    }
    if (value === undefined) return { ...out, reason: `${childLabel(command, argv)} answered unreadable output` };
    return { ...out, ok: true, code: null, value };
  }
  return { ...out, ok: true, code: null };
}

// ---------------------------------------------------------------------------
// sleepSync
// ---------------------------------------------------------------------------

/** Block this thread for `ms` milliseconds without spawning anything. */
export function sleepSync(ms) {
  const n = Number(ms);
  if (!(n > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
}
