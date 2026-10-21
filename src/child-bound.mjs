// Shared child-wait helpers: every synchronous child wait is bounded from its
// spawn, and an expired bound is a named failure.
//
// - `boundedOptions` gives a spawnSync/execFileSync/execSync call its bound
//   AND `killSignal: "SIGKILL"`. spawnSync's default kill signal is SIGTERM,
//   so a bare `timeout` does not stop a child that ignores SIGTERM.
// - `childTimedOut` / `childTimeoutError` turn an expired bound into an error
//   whose `code` is "CHILD_TIMEOUT"; a wrapper that re-words it keeps the code.
// - `readChild` judges a child by its exit status first and reads its output
//   only after a zero status; every failure carries a reason.
// - `spawnGroupBoundedSync` runs a child that starts children of its own in
//   its own process group under a small supervisor, so an expired bound stops
//   the whole tree, not only the direct child.
// - `sleepSync` waits in-process; nothing is spawned.
//
// The first six helpers are the same text as the install road's own
// definitions in `install.mjs`; a test keeps them identical.
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

/** Tests only: make every `boundFor` return `ms` (null restores the classes).
 *  Reachable by import alone; no environment variable or flag sets it. */
export function __setChildBoundsForTest(ms) {
  boundOverrideMs = ms == null ? null : Number(ms);
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
 *  the named CHILD_TIMEOUT error) or "CHILD_FAILED", and `reason` names it:
 *  "<cmd> <sub> exited <N>", "killed by <SIG>", "could not run <cmd>: <msg>",
 *  or the timeout message.
 *
 *  With `parse`, output is read only after status 0: `value` is
 *  `parse(stdout)`, and a parse that throws or returns undefined is a failure
 *  ("<cmd> <sub> answered unreadable output"), never an empty answer. */
export function readChild(command, args, { timeoutMs, parse, ...options } = {}) {
  const ms = timeoutMs ?? boundFor("read");
  const argv = Array.isArray(args) ? args : [];
  const base = { ok: false, status: null, stdout: "", stderr: "", signal: null, error: null, timedOut: false, code: "CHILD_FAILED", reason: null, value: undefined };
  let r;
  try {
    r = spawnSync(command, argv, boundedOptions({ encoding: "utf8", ...options }, ms));
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

// ---------------------------------------------------------------------------
// Process-group supervision
// ---------------------------------------------------------------------------

/** The environment flag a supervised child (and everything it starts) carries. */
export const GROUP_SUPERVISED_ENV = "CINATRA_GROUP_SUPERVISED";
/** The supervisor's pid, which it gives the child it starts (and so everything
 *  that child starts). The flag alone is no proof: anyone can set it. */
export const GROUP_SUPERVISOR_PID_ENV = "CINATRA_GROUP_SUPERVISOR_PID";
/** How long past the child's bound the supervisor itself may take. */
export const GROUP_SUPERVISOR_GRACE_MS = 10_000;

const SUPERVISOR = fileURLToPath(new URL("./child-group-supervisor.mjs", import.meta.url));

function stdioTriple(stdio) {
  if (Array.isArray(stdio)) return [stdio[0] ?? "pipe", stdio[1] ?? "pipe", stdio[2] ?? "pipe"];
  const one = stdio ?? "pipe";
  return [one, one, one];
}

function supervisorReport(output) {
  const text = output == null ? "" : String(output);
  const report = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      Object.assign(report, JSON.parse(line));
    } catch {
      // not a report line
    }
  }
  return report;
}

/** Whether this process provably runs inside a supervised group: the flag is
 *  set, the pid in GROUP_SUPERVISOR_PID_ENV is a live supervisor
 *  (`child-group-supervisor.mjs` on its command line) and an ancestor of this
 *  process, and this process is in the process group of the supervisor's
 *  direct child, which is the group the supervisor stops. One bounded `ps`
 *  read gives the process table; a read that fails, or a table without one of
 *  these facts, is no proof, and the caller then supervises (fail closed). */
function insideProvenSupervisedGroup() {
  if (process.env[GROUP_SUPERVISED_ENV] !== "1") return false;
  const supervisor = Number(process.env[GROUP_SUPERVISOR_PID_ENV]);
  if (!Number.isInteger(supervisor) || supervisor <= 1 || supervisor === process.pid) return false;
  const r = spawnSync(
    "ps",
    ["-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "command="],
    boundedOptions({ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }, boundFor("probe")),
  );
  if (r.error || r.status !== 0) return false;
  const table = new Map();
  for (const line of String(r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  const self = table.get(process.pid);
  if (!self || !table.get(supervisor)?.command.includes("child-group-supervisor.mjs")) return false;
  // Walk up to the supervisor's direct child: the leader of its group.
  let pid = process.pid;
  for (let depth = 0; depth < 64; depth += 1) {
    const row = table.get(pid);
    if (!row) return false;
    if (row.ppid === supervisor) return row.pgid === pid && self.pgid === pid;
    if (row.ppid <= 1) return false;
    pid = row.ppid;
  }
  return false;
}

function killGroupQuietly(pid) {
  if (!(Number(pid) > 0)) return;
  try {
    process.kill(-Number(pid), "SIGKILL");
  } catch {
    // the group is already gone
  }
}

/** spawnSync for a child that starts children of its own (a package install,
 *  a generator, the setup child): the same signature and result shape, but
 *  the child runs in its own process group under a supervisor
 *  (`child-group-supervisor.mjs`), so its bound stops the whole tree.
 *
 *  spawnSync alone stops only the direct child: when that child is itself
 *  blocked in a synchronous wait, its grandchild outlives it. The supervisor
 *  starts the child with `detached` (its own process group) and:
 *  - at the bound, SIGKILLs the group and reports a timeout, which maps to
 *    spawnSync's own ETIMEDOUT error, so `childTimedOut` fires unchanged;
 *  - on any exit, a zero exit too, SIGKILLs what is left of the group (a
 *    long-lived service this starts is detached into a session of its own,
 *    so it is not in the group);
 *  - forwards SIGINT, SIGTERM and SIGHUP to the group, also one that arrives
 *    while the child is being started; from then on the
 *    group is stopped whatever the child's exit status: the supervisor ends
 *    when the group is empty, or SIGKILLs it `graceMs` after the signal;
 *  - SIGKILLs the group at once when this process (the caller) is gone: the
 *    report pipe's end, which the kernel closes when the caller dies, is read
 *    as that signal, and the caller's pid is checked before the child starts
 *    and at its exit.
 *
 *  The bound is `timeoutMs`, else spawnSync's own `timeout` option, else the
 *  step class. Inside a supervised run this is plain bounded spawnSync: the
 *  child stays in the outer group, where the outer bound's group kill reaches
 *  it; a group of its own would put it out of that reach. A supervised run
 *  counts only when it is proven (`insideProvenSupervisedGroup`): the flag
 *  GROUP_SUPERVISED_ENV alone can be set by hand, and trusting it would leave
 *  the child's grandchildren unbounded. Without that proof this supervises.
 *
 *  Residuals: the supervisor itself is bounded at the child's bound plus
 *  `graceMs`, and an idle supervisor misses its own deadline only under host
 *  starvation (the group is then killed from here when its pid is known). The
 *  child has no controlling terminal, so it must not prompt; the paths that
 *  use this run with prompts disabled. */
export function spawnGroupBoundedSync(command, args, options = {}) {
  const { timeoutMs, timeout, killSignal: _killSignal, graceMs = GROUP_SUPERVISOR_GRACE_MS, ...rest } = options ?? {};
  const ms = timeoutMs ?? timeout ?? boundFor("step");
  const argv = Array.isArray(args) ? args : [];
  if (insideProvenSupervisedGroup()) {
    return spawnSync(command, argv, boundedOptions(rest, ms));
  }
  const env = { ...(rest.env ?? process.env), [GROUP_SUPERVISED_ENV]: "1" };
  const payload = JSON.stringify({ cmd: String(command), args: argv, timeoutMs: ms, graceMs, callerPid: process.pid });
  const r = spawnSync(
    process.execPath,
    [SUPERVISOR, payload],
    boundedOptions({ ...rest, env, stdio: [...stdioTriple(rest.stdio), "pipe"] }, ms + graceMs),
  );
  const report = supervisorReport(r.output?.[3]);
  const output = [r.output?.[0] ?? null, r.output?.[1] ?? null, r.output?.[2] ?? null];
  const result = { pid: report.pid ?? r.pid, output, stdout: r.stdout, stderr: r.stderr };
  if (report.timedOut) {
    const error = Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: "ETIMEDOUT" });
    return { ...result, status: null, signal: "SIGKILL", error };
  }
  if (report.spawnError) {
    const code = report.spawnError.code;
    const error = Object.assign(new Error(code ? `spawnSync ${command} ${code}` : String(report.spawnError.message)), {
      code,
      errno: report.spawnError.errno,
      syscall: `spawnSync ${command}`,
      path: String(command),
    });
    return { ...result, status: null, signal: null, error };
  }
  if (Object.hasOwn(report, "status")) {
    return { ...result, status: report.status ?? null, signal: report.signal ?? null };
  }
  // The supervisor ended without a result: its own bound expired, it could not
  // be started, or it was killed. Stop the group from here when it is known.
  killGroupQuietly(report.pid);
  if (r.error) return { ...result, status: null, signal: r.signal ?? null, error: r.error };
  const how = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  const error = Object.assign(new Error(`could not supervise ${path.basename(String(command))}: the supervisor ended without a result (${how})`), {
    code: "CHILD_SUPERVISOR_FAILED",
  });
  return { ...result, status: null, signal: r.signal ?? null, error };
}
