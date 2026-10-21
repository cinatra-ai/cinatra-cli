// The process-group supervisor behind `spawnGroupBoundedSync`
// (`child-bound.mjs`). It is started as `node child-group-supervisor.mjs
// <json>` with the caller's stdio on fds 0-2 and a report pipe on fd 3, where
// <json> is `{ cmd, args, timeoutMs, graceMs }`.
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
// - A zero exit leaves the group as it is.
// - SIGINT, SIGTERM and SIGHUP are forwarded to the group; if the child is
//   still alive `graceMs` later, the group is SIGKILLed.
// - Once a second the parent is checked; when it is gone (the caller was
//   killed), the group is SIGKILLed at once.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

const { cmd, args, timeoutMs, graceMs } = JSON.parse(process.argv[2] ?? "{}");
const parentAtStart = process.ppid;

function report(event) {
  try {
    writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // the caller is gone; nothing to report to
  }
}

let child = null;
let finished = false;

function killGroup(signal) {
  if (!(child?.pid > 0)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // ESRCH: the group is already empty
  }
}

function finish(event, code = 0) {
  if (finished) return;
  finished = true;
  report(event);
  process.exit(code);
}

try {
  child = spawn(cmd, Array.isArray(args) ? args : [], { detached: true, stdio: "inherit" });
} catch (err) {
  finish({ spawnError: { message: String(err?.message ?? err), code: err?.code ?? null, errno: err?.errno ?? null } });
}

child.on("error", (err) => {
  finish({ spawnError: { message: String(err?.message ?? err), code: err?.code ?? null, errno: err?.errno ?? null } });
});

if (child.pid > 0) report({ pid: child.pid });

const deadline = setTimeout(() => {
  killGroup("SIGKILL");
  finish({ timedOut: true });
}, Math.max(1, Number(timeoutMs) || 1));

child.on("exit", (status, signal) => {
  clearTimeout(deadline);
  if (status !== 0) killGroup("SIGKILL");
  finish({ status: typeof status === "number" ? status : null, signal: signal ?? null });
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    killGroup(sig);
    setTimeout(() => killGroup("SIGKILL"), Math.max(0, Number(graceMs) || 0)).unref();
  });
}

setInterval(() => {
  if (process.ppid !== parentAtStart) {
    killGroup("SIGKILL");
    finish({ parentGone: true }, 1);
  }
}, 1000).unref();
