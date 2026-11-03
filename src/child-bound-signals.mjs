// The signals that the watchdog of `spawnBounded` (child-bound-watchdog.mjs)
// handles from one table, and why each other signal is left out.
//
// Off a terminal the command runs in a process group of its own, so a signal
// sent to the caller's job reaches the caller and the watchdog, never the
// command. A signal whose default action ends the watchdog would therefore
// leave the command running with nothing that enforces its bound. Every
// catchable signal whose default action ends a process is in WATCHDOG_SIGNALS
// or in WATCHDOG_SIGNAL_EXCLUSIONS with its reason; tests/child-bound.test.mjs
// checks this against os.constants.signals, and runs each row of the table.
//
// The two kinds:
//   "end"  SIGKILL the command's group, then leave by SIGKILL.
//   "pass" pass the signal on to the command's group as it is (on a terminal
//          the command is in this group and gets it itself). After it, a gone
//          caller ends nothing: the command handles the signal to its own end,
//          and the watchdog still ends the group at the bound plus 1 s.
export const WATCHDOG_SIGNALS = Object.freeze({
  // spawnSync sends it at the bound; a shutdown sends it to every process.
  SIGTERM: "end",
  // The caller's terminal or session is gone.
  SIGHUP: "end",
  // Ctrl-C: the command's own handler runs, as when it is the caller's child.
  SIGINT: "pass",
  // Ctrl-\: as Ctrl-C. Its default action ends the watchdog, so without this
  // row a Ctrl-\ of the job on a pipe leaves the command running.
  SIGQUIT: "pass",
  // Neither Node nor a terminal sends it, and Node gives it no handler, so its
  // default action ends the watchdog. A SIGUSR2 sent to the caller's job would
  // reach a command in that group; passed on, it reaches this one too, and
  // the watchdog stays to enforce the bound.
  SIGUSR2: "pass",
});

// Each signal left out of the table, with its reason. A signal named here
// whose default action ends a process ends the watchdog when someone sends it
// to the caller's job by hand (kill(2)), as a SIGKILL of the watchdog does.
export const WATCHDOG_SIGNAL_EXCLUSIONS = Object.freeze({
  SIGKILL: "cannot be caught; a SIGKILL of the watchdog itself is a disclosed limit",
  SIGSTOP: "cannot be caught; it stops the process and does not end it",
  SIGTSTP: "stops, does not end; off a terminal the watchdog's own stop-and-continue handler passes it on and stops the group and itself 500 ms later",
  SIGCONT: "continues, does not end; off a terminal the stop-and-continue handler passes it on and cancels a pending stop",
  SIGTTIN: "stops, does not end; sent to a background job that reads the terminal, and on a terminal the command is in the watchdog's group",
  SIGTTOU: "stops, does not end; sent to a background job that writes to or sets the terminal, and on a terminal the command is in the watchdog's group",
  SIGCHLD: "ignored by default; the watchdog reads the command's exit from Node",
  SIGURG: "ignored by default",
  SIGWINCH: "ignored by default; on a terminal the command is in the watchdog's group and gets it itself",
  SIGINFO: "ignored by default (Ctrl-T on macOS)",
  SIGPIPE: "Node ignores it from its start, so it never ends the watchdog; a closed caller end is an EPIPE write error, and the relay then closes the command's end",
  SIGUSR1: "Node keeps it for itself: it starts the inspector and does not end the process, so it never ends the watchdog, and a listener would interfere with Node's own use",
  SIGILL: "a fault of the watchdog's own code; Node documents that a JavaScript listener is not safe to run after one",
  SIGBUS: "a fault of the watchdog's own code; Node documents that a JavaScript listener is not safe to run after one",
  SIGFPE: "a fault of the watchdog's own code; Node documents that a JavaScript listener is not safe to run after one",
  SIGSEGV: "a fault of the watchdog's own code; Node documents that a JavaScript listener is not safe to run after one",
  SIGABRT: "abort(), Node's own fatal-error road; a listener cannot keep a failed process running",
  SIGIOT: "another name of SIGABRT",
  SIGTRAP: "a debugger's trap, sent to the process under the debugger only",
  SIGSYS: "a bad system call of the watchdog itself; synchronous, as a fault",
  SIGUNUSED: "another name of SIGSYS",
  SIGEMT: "an emulator trap of the watchdog itself; synchronous, as a fault",
  SIGXCPU: "the kernel sends it only to a process past its own CPU-time limit; the command has its own limit and gets its own signal",
  SIGXFSZ: "the kernel sends it only to a process that passes its own file-size limit; the command has its own limit and gets its own signal",
  SIGALRM: "sent only by a timer that the process set itself (alarm, setitimer); the watchdog sets none",
  SIGVTALRM: "sent only by a timer that the process set itself (setitimer); the watchdog sets none",
  SIGPROF: "sent only by a profiling timer that the process set itself; the watchdog sets none, and V8's profiler uses it",
  SIGIO: "sent only to a process that asked for signal-driven I/O (F_SETOWN, O_ASYNC); the watchdog does not",
  SIGPOLL: "another name of SIGIO",
  SIGPWR: "a power failure; init receives it",
  SIGSTKFLT: "not sent by Linux",
  SIGLOST: "a lost file lock of the process itself",
  SIGBREAK: "win32 only; the watchdog does not run on win32",
});
