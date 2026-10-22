// The watchdog of `spawnBounded` (child-bound.mjs):
//   node <this> <caller pid> <bound ms> moved <command> [args...]
// spawnSync blocks its caller, so the caller cannot answer a signal while it
// waits. spawnSync starts this process in the caller's process group; this
// process starts the command detached (a process group of its own) and
// SIGKILLs that whole group at SIGTERM (spawnSync sends it at the bound) or
// SIGHUP, and when the caller is gone: its parent is not the caller pid it was
// given, checked before the command starts, every 100 ms after, and at the
// command's exit. A Ctrl-C or Ctrl-Z of the caller's job is passed on to the
// group as it is: SIGINT (after it, a caller that is gone ends nothing, and the
// command has the bound plus 1 s to end), and SIGTSTP, then SIGSTOP of the
// group and of this process 500 ms later; a SIGCONT is passed on too.
// A stdout or stderr that is a pipe is relayed through this process, so it
// leaves when the command has exited and those pipes are closed, as spawnSync
// waits: a descendant that holds them keeps it here, guarding the group, and
// one that holds none of them (a background worker) does not. When the
// caller's end is closed, the relay closes the command's end, as the caller's
// exit would. Any other stdio is passed on as it is. Fd 3 gets one JSON note:
// the command's pid, or why it did not start. When a stdio of this process is
// a terminal, the command stays in this process group instead, so a terminal
// read or mode change does not stop it as a background job, the terminal's
// signals reach it directly, and only the command's own pid is killed.
// "moved": the NODE_* variables of the command's env (given or inherited)
// reach the command, not this process: spawnBounded moved them into
// NODE_CHILD_BOUND_ENV, a JSON object of NODE_* names and string values. Any
// other mode, or a moved env that is not such an object, is refused.
import { spawn } from "node:child_process";
import { fstatSync, writeSync } from "node:fs";
import { isatty } from "node:tty";

const [callerArg, boundArg, envArg, command, ...args] = process.argv.slice(2);
const caller = Number(callerArg);
const bound = Number(boundArg);
const onTerminal = [0, 1, 2].some((fd) => isatty(fd));
let group = 0;
let interrupted = false;
let stopping = null;

const toGroup = (signal) => {
  try {
    if (group > 1) process.kill(onTerminal ? group : -group, signal);
  } catch {
    // ESRCH: no member of the group is left.
  }
};
const killGroup = () => toGroup("SIGKILL");
const note = (value) => {
  try {
    writeSync(3, JSON.stringify(value));
  } catch {
    // No fd 3: nobody reads the note.
  }
};
const refuse = (code) => (note({ error: { code } }), process.exit(1));
const leaveBy = (signal) => {
  process.removeAllListeners(signal);
  process.exitCode = 1;
  process.kill(process.pid, signal);
};
const endAll = () => (killGroup(), leaveBy("SIGKILL"));
const callerGone = () => process.ppid !== caller;

for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, endAll);
// On a terminal the command is in this group and gets the terminal's signals
// itself; this process only stops treating a gone caller as the end.
process.on("SIGINT", () => ((interrupted = true), onTerminal || toGroup("SIGINT")));
if (!onTerminal) {
  process.on("SIGTSTP", () => {
    toGroup("SIGTSTP");
    clearTimeout(stopping);
    stopping = setTimeout(() => (toGroup("SIGSTOP"), process.kill(process.pid, "SIGSTOP")), 500);
  });
  process.on("SIGCONT", () => (clearTimeout(stopping), toGroup("SIGCONT")));
}
const { NODE_CHILD_BOUND_ENV: movedText, ...ownEnv } = process.env;
let moved = null;
try {
  moved = JSON.parse(movedText ?? "");
} catch {
  // Not JSON: refused below.
}
const movedOk =
  moved !== null && typeof moved === "object" && !Array.isArray(moved) && Object.entries(moved).every(([k, v]) => k.startsWith("NODE_") && typeof v === "string");
if (!(Number.isInteger(caller) && caller > 1 && Number.isInteger(bound) && bound >= 1 && envArg === "moved" && movedOk)) refuse("EWATCHDOGARGS");
if (callerGone()) refuse("ECALLERGONE");
const deadline = performance.now() + bound + 1000;
// A gone caller ends the group one turn later, so that a SIGINT which ended
// the caller (a Ctrl-C) is read first.
const callerWatch = setInterval(() => {
  if (performance.now() >= deadline) endAll();
  else if (!interrupted && callerGone()) setImmediate(() => interrupted || endAll());
}, 100);

const piped = (fd) => {
  try {
    const s = fstatSync(fd);
    return s.isFIFO() || s.isSocket();
  } catch {
    return false;
  }
};
const relayed = [1, 2].filter(piped);
const env = { ...ownEnv, ...moved };
const child = spawn(command, args, {
  stdio: [0, relayed.includes(1) ? "pipe" : 1, relayed.includes(2) ? "pipe" : 2, "ignore"],
  detached: !onTerminal,
  env,
});
group = child.pid ?? 0;
if (group) note({ pid: group });
let open = relayed.length;
let exit = null;
const leave = () => {
  if (exit === null || open > 0) return;
  clearInterval(callerWatch);
  // The caller died since the last check: what the command left ends too.
  if (!onTerminal && callerGone()) killGroup();
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
      from.destroy(); // the caller's end is closed
    }
  });
  from.on("close", () => ((open -= 1), leave()));
}
child.on("error", ({ code, errno, path }) => (note({ error: { code, errno, path } }), process.exit(127)));
child.on("exit", (code, signal) => group && ((exit = { code, signal }), leave()));
