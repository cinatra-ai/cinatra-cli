// The watchdog of `spawnBounded` (child-bound.mjs):
//   node <this> <caller pid> <command> [args...]
// spawnSync blocks its caller, so the caller cannot answer a signal while it
// waits. spawnSync starts this process in the caller's process group; this
// process starts the command detached (a process group of its own) and
// SIGKILLs that whole group when it receives SIGINT, SIGTERM or SIGHUP (a
// Ctrl-C reaches it with the caller; spawnSync sends SIGTERM at the bound),
// or when the caller is gone: its parent is not the caller pid it was given,
// checked before the command starts and every 100 ms after.
// A stdout or stderr that is a pipe is relayed through this process, so it
// leaves when the command has exited and those pipes are closed, as spawnSync
// waits: a descendant that holds them keeps it here, guarding the group, and
// one that holds none of them (a background worker) does not. Any other
// stdio is passed on as it is. Fd 3 gets one JSON note: the command's pid, or
// why it did not start. When a stdio of this process is a terminal, the
// command stays in this process group instead, so a terminal read or mode
// change does not stop it as a background job, and only the command's own pid
// is killed.
import { spawn } from "node:child_process";
import { fstatSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

const [callerArg, command, ...args] = process.argv.slice(2);
const caller = Number(callerArg);
const onTerminal = [0, 1, 2].some((fd) => isatty(fd));
let group = 0;

const killGroup = () => {
  try {
    if (group > 1) process.kill(onTerminal ? group : -group, "SIGKILL");
  } catch {
    // ESRCH: no member of the group is left.
  }
};
const note = (value) => {
  try {
    writeSync(3, JSON.stringify(value));
  } catch {
    // No fd 3: nobody reads the note.
  }
};
const leaveBy = (signal) => {
  process.removeAllListeners(signal);
  process.exitCode = 1;
  process.kill(process.pid, signal);
};
const endAll = () => (killGroup(), leaveBy("SIGKILL"));
const callerGone = () => process.ppid !== caller;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, endAll);
if (!Number.isInteger(caller) || caller <= 1 || callerGone()) {
  note({ error: { code: "ECALLERGONE" } });
  process.exit(1);
}
const callerWatch = setInterval(() => callerGone() && endAll(), 100);

const piped = (fd) => {
  try {
    const s = fstatSync(fd);
    return s.isFIFO() || s.isSocket();
  } catch {
    return false;
  }
};
const relayed = [1, 2].filter(piped);
const child = spawn(command, args, {
  stdio: [0, relayed.includes(1) ? "pipe" : 1, relayed.includes(2) ? "pipe" : 2, "ignore"],
  detached: !onTerminal,
});
group = child.pid ?? 0;
if (group) note({ pid: group });
let open = relayed.length;
let exit = null;
const leave = () => {
  if (exit === null || open > 0) return;
  clearInterval(callerWatch);
  if (exit.signal) leaveBy(exit.signal);
  else process.exit(exit.code ?? 1);
};
for (const fd of relayed) {
  const from = child.stdio[fd];
  from.on("data", (chunk) => {
    try {
      for (let at = 0; at < chunk.length; ) {
        try {
          at += writeSync(fd, chunk, at);
        } catch (err) {
          if (err?.code !== "EAGAIN") throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
    } catch {
      endAll(); // the caller's end is closed
    }
  });
  from.on("close", () => ((open -= 1), leave()));
}
child.on("error", ({ code, errno, path }) => (note({ error: { code, errno, path } }), process.exit(127)));
child.on("exit", (code, signal) => group && ((exit = { code, signal }), leave()));
