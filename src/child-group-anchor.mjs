// The group anchor behind `child-group-supervisor.mjs`. The supervisor starts
// it `detached` (setsid: a new session and process group whose id is this
// process's pid, which the supervisor knows as soon as it has started it,
// before any child exists) as `node child-group-anchor.mjs <json>` with the
// supervisor's stdio on fds 0-2 and a pipe to the supervisor on fd 3, where
// <json> is `{ cmd, args, supervisorPid }`.
//
// It starts the real child in its own process group (not detached), on the
// inherited stdio, so the child and every descendant that is not detached are
// born into the group the supervisor already knows. It tells the supervisor
// one JSON line per event on fd 3, and exits once it has told the child's end:
//   {"pid":N}                       the child was started
//   {"status":N,"signal":S}         the child exited
//   {"spawnError":{message,code}}   the child could not be started
//
// - SIGINT, SIGTERM and SIGHUP do nothing here: the supervisor forwards them
//   to the whole group, this process included, and they are meant for the
//   child. Their handlers come first.
// - A dead supervisor is noticed at once: fd 3 is one end of a socket pair
//   whose other end only the supervisor holds, so the kernel closes it when
//   the supervisor dies and a read here sees its end. The supervisor's pid
//   (`supervisorPid`) is checked too: before the child is started, and once a
//   second. When the supervisor is gone, the whole group, this process
//   included, is SIGKILLed, so nothing it started outlives the supervisor,
//   also when the supervisor was killed before it could tell its caller the
//   group's id.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import net from "node:net";

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => {});

const { cmd, args, supervisorPid } = JSON.parse(process.argv[2] ?? "{}");
const supervisor = Number(supervisorPid) > 0 ? Number(supervisorPid) : process.ppid;

function tell(event) {
  try {
    writeSync(3, `${JSON.stringify(event)}\n`);
  } catch {
    // the supervisor is gone; nothing to tell
  }
}

function onSupervisorGone() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // this process leads no group (it was not started detached)
  }
  process.exit(1);
}

function spawnError(err) {
  return { spawnError: { message: String(err?.message ?? err), code: err?.code ?? null, errno: err?.errno ?? null } };
}

// The supervisor died before this ran: start nothing.
if (process.ppid !== supervisor) onSupervisorGone();

let child;
try {
  child = spawn(cmd, Array.isArray(args) ? args : [], { stdio: "inherit", env: process.env });
} catch (err) {
  tell(spawnError(err));
  process.exit(0);
}

child.on("error", (err) => {
  tell(spawnError(err));
  process.exit(0);
});

if (child.pid > 0) tell({ pid: child.pid });

child.on("exit", (status, signal) => {
  tell({ status: typeof status === "number" ? status : null, signal: signal ?? null });
  process.exit(0);
});

// The pipe's end is the supervisor's death signal. The supervisor never writes
// to it, so the only thing a read can see is its end.
try {
  const channel = new net.Socket({ fd: 3, readable: true, writable: false });
  channel.on("data", () => {});
  channel.on("end", onSupervisorGone);
  channel.on("error", onSupervisorGone);
  channel.unref();
} catch {
  // fd 3 is not a socket here; the pid check still applies
}

setInterval(() => {
  if (process.ppid !== supervisor) onSupervisorGone();
}, 1000).unref();
