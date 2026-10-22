// The process-group supervisor behind `spawnGroupBoundedSync`
// (`child-bound.mjs`). It is started as `node child-group-supervisor.mjs
// <json>` with the caller's stdio on fds 0-2 and a report pipe on fd 3, where
// <json> is `{ cmd, args, timeoutMs, graceMs, callerPid }`.
//
// It runs in its caller's process group, so a signal sent to that group (a
// Ctrl-C at a terminal, a kill of the group) reaches it as it reaches the
// caller, and it forwards the signal to the child's group.
//
// The child's group is not this one, and its id is known before the child
// exists: this starts a small anchor (`child-group-anchor.mjs`) `detached`
// (setsid: a process group of its own, whose id is the anchor's pid), and the
// anchor starts the real child in that group, on the inherited stdio. The
// anchor SIGKILLs the group when this process is gone, so a kill of this
// process at any moment, also before it has reported anything, leaves nothing
// running. It reports one JSON line per event on fd 3:
//   {"group":N}                     the group's id (the anchor was started)
//   {"pid":N}                       the child was started
//   {"timedOut":true}               the bound expired; the group was SIGKILLed
//   {"status":N,"signal":S}         the child exited
//   {"spawnError":{message,code}}   the child could not be started
//   {"anchorLost":true}             the anchor could not be started, or was
//                                   killed before the child's end; the group
//                                   was SIGKILLed
//
// - At `timeoutMs` the whole group is SIGKILLed.
// - Any exit SIGKILLs what is left of the group, a zero exit too: a service
//   meant to outlive the child is started detached, in a session of its own,
//   so it is not in this group.
// - SIGINT, SIGTERM and SIGHUP are forwarded to the group, each time one
//   arrives. Their handlers are installed before the anchor is started, so a
//   signal that arrives while it starts is forwarded too, and never ends this
//   supervisor with the child left running. From then on the group's kill
//   road completes whatever the child's exit status: the supervisor exits only
//   when the group is empty, or after it SIGKILLed the group `graceMs` after
//   the first forwarded signal.
// - A dead caller is noticed at once: the report pipe is one end of a socket
//   pair whose other end only the caller holds, so the kernel closes it when
//   the caller dies and a read here sees its end. The caller's pid (`callerPid`)
//   is checked too: before the anchor is started (a caller that died before
//   this ran), at the child's exit, and once a second. When the caller is
//   gone, the group is SIGKILLed at once.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ANCHOR = fileURLToPath(new URL("./child-group-anchor.mjs", import.meta.url));
const { cmd, args, timeoutMs, graceMs, callerPid } = JSON.parse(process.argv[2] ?? "{}");
const caller = Number(callerPid) > 0 ? Number(callerPid) : process.ppid;

function report(event) {
  try {
    writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // the caller is gone; nothing to report to
  }
}

let anchor = null;
let finished = false;
let callerGone = false;
let forwarded = false;
let childEnded = false;
let exitEvent = null;

function killGroup(signal) {
  if (!(anchor?.pid > 0)) return;
  try {
    process.kill(-anchor.pid, signal);
  } catch {
    // ESRCH: the group is already empty
  }
}

function groupAlive() {
  if (!(anchor?.pid > 0)) return false;
  try {
    process.kill(-anchor.pid, 0);
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

// The signal handlers come first: a signal that reaches this process before
// they are installed ends it by default, and once the anchor is started that
// would leave the child to the anchor's own check. A handler runs only after
// the synchronous start below, so it always finds the anchor.
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

// The caller died before this ran: start nothing.
if (parentGone()) onCallerGone();

try {
  anchor = spawn(process.execPath, [ANCHOR, JSON.stringify({ cmd, args: Array.isArray(args) ? args : [], supervisorPid: process.pid })], {
    detached: true,
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    env: process.env,
  });
} catch {
  finish({ anchorLost: true }, 1);
}

anchor.on("error", () => {
  killGroup("SIGKILL");
  finish({ anchorLost: true }, 1);
});

if (anchor.pid > 0) report({ group: anchor.pid });

function onChildExit(status, signal) {
  childEnded = true;
  const event = { status: typeof status === "number" ? status : null, signal: signal ?? null };
  if (parentGone()) {
    onCallerGone();
    return;
  }
  if (event.status !== 0) {
    killGroup("SIGKILL");
    finish(event);
    return;
  }
  // A zero exit with no forwarded signal: what the child left in its group
  // goes with it.
  if (!forwarded || !groupAlive()) {
    killGroup("SIGKILL");
    clearTimeout(deadline);
    finish(event);
    return;
  }
  // A signal was forwarded: wait for the group to empty (the anchor leaves it
  // as it exits); the grace timer SIGKILLs it otherwise.
  exitEvent = event;
  setInterval(() => {
    if (!groupAlive()) finish(event);
  }, 50);
}

function onAnchorEvent(event) {
  if (event == null || typeof event !== "object") return;
  if (Number(event.pid) > 0) {
    report({ pid: Number(event.pid) });
  } else if (event.spawnError) {
    childEnded = true;
    killGroup("SIGKILL");
    finish({ spawnError: event.spawnError });
  } else if (Object.hasOwn(event, "status")) {
    onChildExit(event.status, event.signal);
  }
}

// The anchor's events, one JSON line each.
let pending = "";
const events = anchor.stdio[3];
events?.setEncoding("utf8");
events?.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    try {
      onAnchorEvent(JSON.parse(line));
    } catch {
      // not an event line
    }
  }
});
events?.on("error", () => {});

// The anchor ended without telling the child's end: it was killed, and the
// child may still run in its group. Every event it sent is read before this
// ("close" waits for the pipe).
anchor.on("close", (_code, signal) => {
  if (childEnded || finished) return;
  killGroup("SIGKILL");
  if (forwarded) finish({ status: null, signal: signal ?? "SIGKILL" });
  else finish({ anchorLost: true }, 1);
});

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

setInterval(() => {
  if (process.ppid !== caller) onCallerGone();
}, 1000).unref();
