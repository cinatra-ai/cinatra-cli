// The process-group supervisor behind `spawnGroupBoundedSync`
// (`child-bound.mjs`). It is started as `node child-group-supervisor.mjs
// <json>` with the caller's stdio on fds 0-2 and a report pipe on fd 3, where
// <json> is `{ cmd, args, timeoutMs, graceMs, callerPid }`.
//
// It starts the real child `detached` (setsid: a process group of its own,
// which every non-detached descendant joins) on the inherited stdio, and
// reports one JSON line per event on fd 3:
//   {"pid":N}                       the child was started
//   {"timedOut":true}               the bound expired; the group was SIGKILLed
//   {"status":N,"signal":S}         the child exited
//   {"spawnError":{message,code}}   the child could not be started
//
// - At `timeoutMs` the whole group is SIGKILLed.
// - A non-zero exit or a signal death SIGKILLs what is left of the group.
// - A zero exit leaves the group as it is, unless a signal was forwarded or
//   the caller is gone (below).
// - SIGINT, SIGTERM and SIGHUP are forwarded to the group. From then on the
//   group's kill road completes whatever the child's exit status: the
//   supervisor exits only when the group is empty, or after it SIGKILLed the
//   group `graceMs` after the first forwarded signal.
// - A dead caller is noticed at once: the report pipe is one end of a socket
//   pair whose other end only the caller holds, so the kernel closes it when
//   the caller dies and a read here sees its end. The caller's pid (`callerPid`)
//   is checked too: before the child is started (a caller that died before
//   this ran), at the child's exit, and once a second. When the caller is
//   gone, the group is SIGKILLed at once.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import net from "node:net";

const { cmd, args, timeoutMs, graceMs, callerPid } = JSON.parse(process.argv[2] ?? "{}");
const caller = Number(callerPid) > 0 ? Number(callerPid) : process.ppid;

function report(event) {
  try {
    writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // the caller is gone; nothing to report to
  }
}

let child = null;
let finished = false;
let callerGone = false;
let forwarded = false;
let exitEvent = null;

function killGroup(signal) {
  if (!(child?.pid > 0)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already empty
  }
}

function groupAlive() {
  if (!(child?.pid > 0)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function finish(event, code = 0) {
  if (finished) return;
  finished = true;
  report(event);
  process.exit(code);
}

function parentGone() {
  return callerGone || process.ppid !== caller;
}

function onCallerGone() {
  callerGone = true;
  killGroup("SIGKILL");
  finish({ parentGone: true }, 1);
}

// The caller died before this ran: start nothing.
if (parentGone()) onCallerGone();

try {
  child = spawn(cmd, Array.isArray(args) ? args : [], { detached: true, stdio: "inherit" });
} catch (err) {
  finish({ spawnError: { message: String(err?.message ?? err), code: err?.code ?? null, errno: err?.errno ?? null } });
}

child.on("error", (err) => {
  finish({ spawnError: { message: String(err?.message ?? err), code: err?.code ?? null, errno: err?.errno ?? null } });
});

if (child.pid > 0) report({ pid: child.pid });

// The report pipe's end is the caller's death signal. The caller never writes
// to it, so the only thing a read can see is its end.
try {
  const channel = new net.Socket({ fd: 3, readable: true, writable: false });
  channel.on("data", () => {});
  channel.on("end", onCallerGone);
  channel.on("error", onCallerGone);
  channel.unref();
} catch {
  // fd 3 is not a socket here; the pid checks still apply
}

const deadline = setTimeout(() => {
  killGroup("SIGKILL");
  finish(exitEvent ?? { timedOut: true });
}, Math.max(1, Number(timeoutMs) || 1));

child.on("exit", (status, signal) => {
  const event = { status: typeof status === "number" ? status : null, signal: signal ?? null };
  if (parentGone()) {
    onCallerGone();
    return;
  }
  if (status !== 0) {
    killGroup("SIGKILL");
    finish(event);
    return;
  }
  // A zero exit with no forwarded signal leaves the group as it is.
  if (!forwarded || !groupAlive()) {
    clearTimeout(deadline);
    finish(event);
    return;
  }
  // A signal was forwarded: wait for the group to empty; the grace timer
  // SIGKILLs it otherwise.
  exitEvent = event;
  setInterval(() => {
    if (!groupAlive()) finish(event);
  }, 50);
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killGroup(sig);
    if (forwarded) return;
    forwarded = true;
    setTimeout(() => {
      killGroup("SIGKILL");
      if (exitEvent) finish(exitEvent);
    }, Math.max(0, Number(graceMs) || 0)).unref();
  });
}

setInterval(() => {
  if (process.ppid !== caller) onCallerGone();
}, 1000).unref();
