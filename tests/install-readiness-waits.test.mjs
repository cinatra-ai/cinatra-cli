// cinatra-cli#325: the readiness waits of the development install's stack
// start (`waitForCompose`, `waitForNango` in src/install.mjs) bound each probe
// from its spawn and pause through `pauseInstall`, which spawns no child: a
// `sleep` on PATH cannot end a pause early, and no pause bound can expire.
//
// The children here are real processes: small `docker`, `curl` and `sleep`
// stand-in scripts placed first on PATH of a harness node process. A stand-in
// that "hangs" execs a node child that writes its pid and ignores SIGTERM, so
// only a bound with SIGKILL ends it before its case is over. A wait with no
// bound blocks its whole process (the wait is synchronous), so each case runs
// the helper in a harness process with its own guard: the guard stops a helper
// that waited past its bound, and the case fails on its own assertion.
//
// The cleanup signals no pid (it only probes one with signal 0, which delivers
// nothing): a pid read from a file can belong to another process by the time
// it is read. After its case, a hanging child is asked to stop through a
// marker file next to its pid file; it reads the marker at its start and every
// 100 ms. The cleanup then waits up to 5 s for the child to be gone and fails
// the case if it is not. A child can miss its marker: one that starts after its
// cleanup and is held before its first read while the marker is removed. So
// each hanging child also holds a lifeline: at its start it connects to a Unix
// socket that this file listens on, and it exits when that connection ends or
// fails. afterAll ends the lifeline and waits up to 5 s for every connection
// that it has taken to close, then removes the sandbox. A child that tries to
// connect only after that fails to connect, and exits. A child also exits by
// itself after 60 s.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const NODE = process.execPath;
const INSTALL_URL = new URL("../src/install.mjs", import.meta.url).href;
const HARNESS_GUARD_MS = 15_000;
const HARNESS_CASE_MS = 30_000;
const STOP_WAIT_MS = 5_000;
// The pause rows read the time on the clock that the pause itself reads; the
// slack covers floating-point rounding only.
const FLOAT_SLACK_MS = 0.001;
// The hanging child: argv[2] is its pid file; the marker `stop` next to it asks
// it to exit, and it notes its own exit in `exited` there. argv[3] is the
// lifeline socket: the child connects to it before anything else and exits
// when that connection ends, closes or fails.
const HANGING_CHILD_JS = [
  "const fs = require('fs');",
  "const net = require('net');",
  "const path = require('path');",
  "const pidFile = process.argv[2];",
  "const dir = path.dirname(pidFile);",
  "const lifetimeEnd = Date.now() + 60000;",
  "const lifeline = net.connect(process.argv[3]);",
  "for (const e of ['end', 'close', 'error']) lifeline.on(e, () => process.exit(0));",
  "fs.writeFileSync(pidFile, String(process.pid));",
  "process.on('exit', () => { try { fs.writeFileSync(path.join(dir, 'exited'), String(process.pid)); } catch {} });",
  "process.on('SIGTERM', () => {});",
  "const stopAsked = () => fs.existsSync(path.join(dir, 'stop'));",
  "const check = () => { if (stopAsked() || Date.now() >= lifetimeEnd) process.exit(0); };",
  "check();",
  "setInterval(check, 100);",
  "",
].join("\n");
// Loaded with -r into a hanging child by a control of the cleanup: right after
// its first file write (the pid write), before its first read of the stop
// marker, it holds the child, as a child that is descheduled there, until the
// marker next to the pid file is gone (at most 10 s). Then it writes to the
// file named by HOLD_NOTE whether the marker was gone when it let the child go.
const HOLD_AFTER_PID_JS = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const write = fs.writeFileSync;",
  "fs.writeFileSync = function (file, ...rest) {",
  "  fs.writeFileSync = write;",
  "  const out = write.call(this, file, ...rest);",
  "  const marker = path.join(path.dirname(String(file)), 'stop');",
  "  const end = Date.now() + 10000;",
  "  while (fs.existsSync(marker) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);",
  "  if (process.env.HOLD_NOTE) write(process.env.HOLD_NOTE, fs.existsSync(marker) ? 'marker still there' : 'marker gone');",
  "  return out;",
  "};",
  "",
].join("\n");

let sandbox;
let hangingChildFile;
let holdAfterPidFile;
let lifeline;
const pidFiles = [];
beforeAll(async () => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-readiness-waits-"));
  hangingChildFile = path.join(sandbox, "hanging-child.cjs");
  writeFileSync(hangingChildFile, HANGING_CHILD_JS);
  holdAfterPidFile = path.join(sandbox, "hold-after-pid.cjs");
  writeFileSync(holdAfterPidFile, HOLD_AFTER_PID_JS);
  lifeline = await openLifeline(sandbox);
});
afterEach(() => {
  const left = [];
  while (pidFiles.length) {
    try {
      stopChild(pidFiles.pop());
    } catch (err) {
      left.push(err.message);
    }
  }
  if (left.length) throw new Error(left.join("; "));
});
afterAll(async () => {
  await endOfFile(lifeline, sandbox);
});

/** The lifeline in `dir`: a Unix socket server. Each connection to it is one
 *  hanging child, which exits when its connection ends. */
function openLifeline(dir) {
  const file = path.join(dir, "l.sock");
  if (Buffer.byteLength(file) > 100) {
    throw new Error(`the lifeline socket path is too long for a Unix socket (${file}); use a shorter TMPDIR`);
  }
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.resume();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => resolve({ file, server, sockets }));
  });
}

/** What `promise` resolves to, or false after `ms`. */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Ends the lifeline: it takes no new connection, ends each one it holds, and
 *  waits up to `waitMs` for all of them to close (a child closes its own only
 *  by exiting). Throws if one is still open then. It signals no process. */
async function endLifeline(life, { waitMs = STOP_WAIT_MS } = {}) {
  const closed = new Promise((resolve) => life.server.close(() => resolve(true)));
  for (const socket of life.sockets) socket.end();
  if (!(await within(closed, waitMs))) {
    throw new Error(`${life.sockets.size} hanging child(ren) still held the lifeline ${waitMs} ms after it was ended; none was signalled`);
  }
}

/** The end of a test file: its lifeline ended, then its sandbox removed. */
async function endOfFile(life, dir) {
  try {
    if (life) await endLifeline(life);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readPid(pidFile) {
  try {
    return Number(readFileSync(pidFile, "utf8"));
  } catch {
    return 0;
  }
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function expectGone(pidFile) {
  const pid = readPid(pidFile);
  expect(pid, "the hanging child wrote its pid").toBeGreaterThan(0);
  expect(isAlive(pid), "the hanging child is gone after the wait").toBe(false);
}

/** Cleanup in every outcome. It signals no pid: it writes the `stop` marker
 *  next to `pidFile`, then waits up to `waitMs` for the child to be gone (its
 *  `exited` note, or no live process with its pid), and throws if it is not.
 *  A child that has not started yet sees the marker when it starts. */
function stopChild(pidFile, { waitMs = STOP_WAIT_MS } = {}) {
  const dir = path.dirname(pidFile);
  writeFileSync(path.join(dir, "stop"), "");
  const end = performance.now() + waitMs;
  for (;;) {
    const pid = readPid(pidFile);
    if (existsSync(path.join(dir, "exited")) || !isAlive(pid)) return;
    if (performance.now() >= end) {
      throw new Error(`a stand-in child (pid ${pid}) did not stop within ${waitMs} ms after its stop marker; it was not signalled`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** A new pid file path in the sandbox, its child stopped after the case. */
function newPidFile(tag) {
  const file = path.join(mkdtempSync(path.join(sandbox, `pid-${tag}-`)), "child.pid");
  pidFiles.push(file);
  return file;
}

/** A shell line that becomes the hanging node child (pid in `pidFile`), on the
 *  lifeline of this file. */
function hangs(pidFile) {
  return `exec "${NODE}" "${hangingChildFile}" "${pidFile}" "${lifeline.file}"`;
}

/** Stand-in scripts (`{ name: shell body }`) in one new directory. With
 *  `onlyThese`, PATH is that directory alone (a missing name cannot spawn);
 *  else the directory goes first on PATH. Returns the env that carries it. */
function standInsEnv(scripts, { onlyThese = false } = {}) {
  const dir = mkdtempSync(path.join(sandbox, "bin-"));
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  const before = process.env.PATH;
  const PATH = onlyThese || before === undefined ? dir : `${dir}${path.delimiter}${before}`;
  return { ...process.env, PATH };
}

/** Run `body` (an async function body that may use `m`, the imported module)
 *  in a harness node process bounded by its own guard. Returns
 *  `{ guardExpired: true }` when the helper never returned, else what the
 *  body returned or threw (`code`, `message`). */
function inHarness(body, { env = process.env } = {}) {
  const script =
    `const m = await import(${JSON.stringify(INSTALL_URL)});\n` +
    "let out;\n" +
    `try { const value = await (async () => { ${body} })(); out = { threw: false, value: value ?? null }; }\n` +
    "catch (err) { out = { threw: true, code: err?.code ?? null, message: String(err?.message ?? err) }; }\n" +
    "process.stdout.write(JSON.stringify(out), () => process.exit(0));\n";
  const r = spawnSync(NODE, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
    timeout: HARNESS_GUARD_MS,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT") return { guardExpired: true };
  let parsed = {};
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    parsed = { unparsed: r.stdout, stderr: r.stderr };
  }
  return { guardExpired: false, status: r.status, ...parsed };
}

/** A harness body that times one call and keeps its log lines and its throw. */
function timed(call) {
  return (
    "const lines = []; const log = (l) => lines.push(l); let threw = null; let code = null;\n" +
    "const t0 = performance.now();\n" +
    `try { ${call}; } catch (err) { threw = String(err?.message ?? err); code = err?.code ?? null; }\n` +
    "return { ms: performance.now() - t0, lines, threw, code };"
  );
}

/** The harness result's timed value, after checking that the helper returned. */
function valueOf(result) {
  expect(result.guardExpired, "the helper waited past its bound (the harness guard stopped it)").toBe(false);
  expect(result.threw, `harness body threw: ${result.message}`).toBe(false);
  return result.value;
}

const compose = (opts = "{ probeTimeoutMs: 1500 }", attempts = 1) =>
  timed(`m.waitForInstallCompose(".", "db", ["pg_isready"], "Postgres", log, ${attempts}, ["compose"], ${opts})`);
const nango = (opts = "{ probeTimeoutMs: 1500 }", attempts = 1) =>
  timed(`m.waitForInstallNango(log, ${attempts}, "http://localhost:9/health", ${opts})`);
const pause = (arg) => timed(`m.pauseInstall(${arg})`);

const SLEEP_FAILS = "exit 1";
const SLEEP_CLEAN = "exit 0";

/** A `sleep` stand-in that notes each run in a marker file, then runs `rest`.
 *  The pause spawns no child, so the marker must stay absent. */
function markedSleep(rest) {
  const marker = path.join(mkdtempSync(path.join(sandbox, "sleep-")), "ran");
  return { marker, body: `echo ran >> "${marker}"\n${rest}` };
}

function expectNoSleepChild(marker) {
  expect(() => readFileSync(marker, "utf8"), "a sleep child ran").toThrow();
}

describe("waitForCompose: the docker compose exec probe is bounded from its spawn (cinatra-cli#325)", () => {
  it("a probe that hangs is stopped at its bound and is a failed attempt, not a hang", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("docker");
    const env = standInsEnv({ docker: hangs(pidFile), sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready within 1 seconds/);
    expect(v.lines).toEqual([]);
    expect(v.ms).toBeGreaterThanOrEqual(1_400);
    expect(v.ms).toBeLessThan(8_000);
    expectGone(pidFile);
  });

  it("a timed-out probe is never ready: the loop goes on and a later clean probe is ready", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("docker");
    const countFile = path.join(path.dirname(pidFile), "count");
    const docker = [
      `n=$(cat "${countFile}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${countFile}"`,
      `if [ "$n" -eq 1 ]; then ${hangs(pidFile)}; fi`,
      "exit 0",
    ].join("\n");
    const env = standInsEnv({ docker, sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(compose("{ probeTimeoutMs: 1500 }", 2), { env }));
    expect(v.threw).toBe(null);
    expect(v.lines).toEqual(["  Postgres is ready."]);
    expect(readFileSync(countFile, "utf8").trim()).toBe("2");
    expectGone(pidFile);
  });

  it("the default probe bound is 15 s, named as INSTALL_PROBE_TIMEOUT_MS", { timeout: HARNESS_CASE_MS }, async () => {
    const install = await import("../src/install.mjs");
    expect(install.INSTALL_PROBE_TIMEOUT_MS).toBe(15_000);
    expect(install.INSTALL_NANGO_PROBE_TIMEOUT_MS).toBe(3_000);
  });

  for (const bound of ["0", "-1", "Infinity", "NaN", '"1500"', "null", "0.5", "1500.5", "Object.create(null)"]) {
    it(`a probe bound of ${bound} is refused by name before any probe runs (0 would mean no bound)`, { timeout: HARNESS_CASE_MS }, () => {
      const countFile = path.join(mkdtempSync(path.join(sandbox, "count-")), "count");
      const env = standInsEnv({ docker: `echo x >> "${countFile}"; exit 0`, sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(compose(`{ probeTimeoutMs: ${bound} }`), { env }));
      expect(v.code).toBe("INSTALL_PROBE_BOUND_INVALID");
      expect(() => readFileSync(countFile, "utf8")).toThrow();
    });
  }

  for (const [bound, shown] of [["Object.create(null)", "an object"], ["() => 1500", "a function"], ["Symbol(\"x\")", "Symbol(x)"], ["null", "null"]]) {
    it(`a refused probe bound of ${bound} is named in the message as ${shown}`, { timeout: HARNESS_CASE_MS }, () => {
      const env = standInsEnv({ docker: "exit 0", sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(compose(`{ probeTimeoutMs: ${bound} }`), { env }));
      expect(v.code).toBe("INSTALL_PROBE_BOUND_INVALID");
      expect(v.threw).toContain(`(got ${shown})`);
    });
  }

  it("a probe bound of 1 (the smallest whole number of ms) is taken and passed to the probe", { timeout: HARNESS_CASE_MS }, () => {
    const fake = "(cmd, args, options) => { globalThis.seen = { cmd, timeout: options?.timeout, killSignal: options?.killSignal }; return { status: 0, signal: null, error: undefined }; }";
    const v = valueOf(inHarness(withFakeSpawn(fake, `m.waitForInstallCompose(".", "db", ["pg_isready"], "Postgres", log, 1, ["compose"], { probeTimeoutMs: 1 }); lines.push(JSON.stringify(globalThis.seen))`)));
    expect(v.threw).toBe(null);
    expect(v.code).toBe(null);
    expect(JSON.parse(v.lines[1])).toEqual({ cmd: "docker", timeout: 1, killSignal: "SIGKILL" });
  });
});

describe("waitForCompose: probe readings that main's code reads the same way (controls)", () => {
  it("a probe that exits 0 is ready at once", { timeout: HARNESS_CASE_MS }, () => {
    const env = standInsEnv({ docker: "exit 0", sleep: SLEEP_FAILS });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toBe(null);
    expect(v.lines).toEqual(["  Postgres is ready."]);
    expect(v.ms).toBeLessThan(900);
  });

  it("a probe that dies by a signal is a failed attempt, never ready", { timeout: HARNESS_CASE_MS }, () => {
    const env = standInsEnv({ docker: "kill -KILL $$", sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.lines).toEqual([]);
  });

  it("a probe that cannot be spawned (no docker on PATH) is a failed attempt, never ready", { timeout: HARNESS_CASE_MS }, () => {
    const env = standInsEnv({ sleep: SLEEP_CLEAN }, { onlyThese: true });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.lines).toEqual([]);
  });
});

/** A harness body that puts `fake` (the source of a function) in place of
 *  `spawnSync` of `node:child_process` (the binding src/install.mjs imports)
 *  before `call` runs, and counts its calls. */
function withFakeSpawn(fake, call) {
  return (
    "const cp = (await import('node:child_process')).default;\n" +
    "let calls = 0; const fake = " + fake + ";\n" +
    "cp.spawnSync = (...args) => { calls += 1; return fake(...args); };\n" +
    "(await import('node:module')).syncBuiltinESMExports();\n" +
    "const timedCall = async () => { " + timed(call) + " };\n" +
    "return { ...(await timedCall()), calls };"
  );
}

// Probe results that no real child gives: status 0 together with a signal, a
// spawn error or an expired bound; and a spawnSync that throws.
const FAKE_RESULTS = [
  ["status 0 with a signal", '() => ({ status: 0, signal: "SIGKILL", error: undefined })'],
  ["status 0 with a spawn error", '() => ({ status: 0, signal: null, error: new Error("spawn failed") })'],
  ["status 0 with an expired bound", '() => ({ status: 0, signal: null, error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) })'],
  ["a spawnSync that throws", '() => { throw new TypeError("bad argument"); }'],
];

describe("both loops: only a clean exit 0 is ready, and a throw of spawnSync is a failed attempt (cinatra-cli#325)", () => {
  for (const [what, fake] of FAKE_RESULTS) {
    it(`waitForCompose: a probe of ${what} is a failed attempt, never ready`, { timeout: HARNESS_CASE_MS }, () => {
      const env = standInsEnv({ docker: "exit 0", sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(withFakeSpawn(fake, `m.waitForInstallCompose(".", "db", ["pg_isready"], "Postgres", log, 1, ["compose"], { probeTimeoutMs: 1500 })`), { env }));
      expect(v.calls).toBe(1);
      expect(v.threw).toMatch(/Postgres did not become ready within 1 seconds/);
      expect(v.lines).toEqual([]);
    });

    it(`waitForNango: a probe of ${what} is a failed attempt, never ready`, { timeout: HARNESS_CASE_MS }, () => {
      const env = standInsEnv({ curl: "exit 0", sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(withFakeSpawn(fake, `m.waitForInstallNango(log, 1, "http://localhost:9/health", { probeTimeoutMs: 1500 })`), { env }));
      expect(v.calls).toBe(1);
      expect(v.threw).toBe(null);
      expect(v.lines).toHaveLength(1);
      expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    });
  }

  it("with no options, the compose probe is spawned with the 15 s default bound and SIGKILL", { timeout: HARNESS_CASE_MS }, () => {
    const fake = "(cmd, args, options) => { globalThis.seen = { cmd, timeout: options?.timeout, killSignal: options?.killSignal }; return { status: 0, signal: null, error: undefined }; }";
    const v = valueOf(inHarness(withFakeSpawn(fake, `m.waitForInstallCompose(".", "db", ["pg_isready"], "Postgres", log, 1, ["compose"]); lines.push(JSON.stringify(globalThis.seen))`)));
    expect(v.threw).toBe(null);
    expect(v.lines[0]).toBe("  Postgres is ready.");
    expect(JSON.parse(v.lines[1])).toEqual({ cmd: "docker", timeout: 15_000, killSignal: "SIGKILL" });
  });

  it("with no options, the curl probe is spawned with the 3 s default bound and SIGKILL", { timeout: HARNESS_CASE_MS }, () => {
    const fake = "(cmd, args, options) => { globalThis.seen = { cmd, timeout: options?.timeout, killSignal: options?.killSignal }; return { status: 0, signal: null, error: undefined }; }";
    const v = valueOf(inHarness(withFakeSpawn(fake, `m.waitForInstallNango(log, 1, "http://localhost:9/health"); lines.push(JSON.stringify(globalThis.seen))`)));
    expect(v.threw).toBe(null);
    expect(v.lines[0]).toBe("  Nango is ready.");
    expect(JSON.parse(v.lines[1])).toEqual({ cmd: "curl", timeout: 3_000, killSignal: "SIGKILL" });
  });

  it("control: a fake probe of a clean exit 0 is ready (the fake is the probe the loop reads)", { timeout: HARNESS_CASE_MS }, () => {
    const env = standInsEnv({ docker: "exit 1", sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(withFakeSpawn("() => ({ status: 0, signal: null, error: undefined })", `m.waitForInstallCompose(".", "db", ["pg_isready"], "Postgres", log, 1, ["compose"], { probeTimeoutMs: 1500 })`), { env }));
    expect(v.calls).toBe(1);
    expect(v.threw).toBe(null);
    expect(v.lines).toEqual(["  Postgres is ready."]);
  });
});

describe("waitForCompose: the 1 s pause spawns no child and is not skipped (cinatra-cli#325)", () => {
  it("with a `sleep` on PATH that exits 0 at once, the wait takes at least its 1 s pause and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const sleep = markedSleep("exit 0");
    const env = standInsEnv({ docker: "exit 1", sleep: sleep.body });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.ms).toBeGreaterThanOrEqual(1_000 - FLOAT_SLACK_MS);
    expectNoSleepChild(sleep.marker);
  });

  it("with a `sleep` on PATH that hangs, the wait takes at least its 1 s pause and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("sleep");
    const sleep = markedSleep(hangs(pidFile));
    const env = standInsEnv({ docker: "exit 1", sleep: sleep.body });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.ms).toBeGreaterThanOrEqual(1_000 - FLOAT_SLACK_MS);
    expect(v.ms).toBeLessThan(8_000);
    expectNoSleepChild(sleep.marker);
  });
});

describe("waitForNango: the curl probe is bounded with SIGKILL and the 2 s pause spawns no child (cinatra-cli#325)", () => {
  it("a curl probe that hangs (it ignores SIGTERM) is stopped at its bound; the wait warns and goes on", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("curl");
    const env = standInsEnv({ curl: hangs(pidFile), sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.threw).toBe(null);
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeLessThan(8_000);
    expectGone(pidFile);
  });

  it("a timed-out curl probe is never ready: the loop goes on and a later clean probe is ready", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("curl");
    const countFile = path.join(path.dirname(pidFile), "count");
    const curl = [
      `n=$(cat "${countFile}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${countFile}"`,
      `if [ "$n" -eq 1 ]; then ${hangs(pidFile)}; fi`,
      "exit 0",
    ].join("\n");
    const env = standInsEnv({ curl, sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(nango("{ probeTimeoutMs: 1500 }", 2), { env }));
    expect(v.threw).toBe(null);
    expect(v.lines).toEqual(["  Nango is ready."]);
    expect(readFileSync(countFile, "utf8").trim()).toBe("2");
    expectGone(pidFile);
  });

  for (const bound of ["0", "-1", "Infinity", "0.5", "1500.5", "Object.create(null)"]) {
    it(`a curl probe bound of ${bound} is refused by name`, { timeout: HARNESS_CASE_MS }, () => {
      const env = standInsEnv({ curl: "exit 0", sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(nango(`{ probeTimeoutMs: ${bound} }`), { env }));
      expect(v.code).toBe("INSTALL_PROBE_BOUND_INVALID");
      expect(v.lines).toEqual([]);
    });
  }

  it("with a `sleep` on PATH that exits 0 at once, the wait takes at least its 2 s pause and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const sleep = markedSleep("exit 0");
    const env = standInsEnv({ curl: "exit 7", sleep: sleep.body });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeGreaterThanOrEqual(2_000 - FLOAT_SLACK_MS);
    expectNoSleepChild(sleep.marker);
  });

  it("with a `sleep` on PATH that hangs, the wait takes at least its 2 s pause and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("sleep");
    const sleep = markedSleep(hangs(pidFile));
    const env = standInsEnv({ curl: "exit 7", sleep: sleep.body });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeGreaterThanOrEqual(2_000 - FLOAT_SLACK_MS);
    expect(v.ms).toBeLessThan(9_000);
    expectNoSleepChild(sleep.marker);
  });

  it("control: a curl probe that exits 0 is ready at once", { timeout: HARNESS_CASE_MS }, () => {
    const env = standInsEnv({ curl: "exit 0", sleep: SLEEP_FAILS });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.lines).toEqual(["  Nango is ready."]);
    expect(v.ms).toBeLessThan(900);
  });
});

describe("pauseInstall: no child, the whole length, rounding and refused lengths (cinatra-cli#325)", () => {
  it("with a `sleep` on PATH that exits 0 at once, a 1 s pause takes its 1 s and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const sleep = markedSleep("exit 0");
    const env = standInsEnv({ sleep: sleep.body });
    const v = valueOf(inHarness(pause("1"), { env }));
    expect(v.threw).toBe(null);
    expect(v.ms).toBeGreaterThanOrEqual(1_000 - FLOAT_SLACK_MS);
    expectNoSleepChild(sleep.marker);
  });

  it("a length of 1.6 s is a pause of 2 s", { timeout: HARNESS_CASE_MS }, () => {
    const v = valueOf(inHarness(pause("1.6")));
    expect(v.threw).toBe(null);
    expect(v.ms).toBeGreaterThanOrEqual(2_000 - FLOAT_SLACK_MS);
  });

  for (const [arg, ms] of [
    [1.6, 2_000],
    [0.2, 1_000],
    [0, 1_000],
    [-5, 1_000],
    [2, 2_000],
    [0.5, 1_000],
    [1.5, 2_000],
    [2.5, 3_000],
  ]) {
    it(`installPauseMs: a length of ${arg} s is a pause of ${ms} ms`, async () => {
      const install = await import("../src/install.mjs");
      expect(install.installPauseMs(arg)).toBe(ms);
    });
  }

  for (const [arg, shown] of [["Object.create(null)", "an object"], ["() => 1", "a function"], ["null", "null"]]) {
    it(`a refused length of ${arg} is named in the message as ${shown}`, { timeout: HARNESS_CASE_MS }, () => {
      const v = valueOf(inHarness(pause(arg)));
      expect(v.code).toBe("INSTALL_PAUSE_INVALID");
      expect(v.threw).toContain(`(got ${shown})`);
    });
  }

  for (const arg of ["Infinity", "-Infinity", "NaN", '"1"', "undefined", "null", "Object.create(null)"]) {
    it(`a length of ${arg} is refused by name at once`, { timeout: HARNESS_CASE_MS }, () => {
      const sleep = markedSleep("exit 0");
      const env = standInsEnv({ sleep: sleep.body });
      const v = valueOf(inHarness(pause(arg), { env }));
      expect(v.code).toBe("INSTALL_PAUSE_INVALID");
      expect(v.ms).toBeLessThan(900);
      expectNoSleepChild(sleep.marker);
    });
  }
});

describe("this file's cleanup: it signals no pid, and a late child stops by itself (controls of the test)", () => {
  it("a pid file that names a process the cleanup did not start leaves that process running, and the cleanup reports it", { timeout: HARNESS_CASE_MS }, async () => {
    const other = spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await once(other, "spawn");
      const pidFile = path.join(mkdtempSync(path.join(sandbox, "pid-other-")), "child.pid");
      writeFileSync(pidFile, String(other.pid));
      expect(() => stopChild(pidFile, { waitMs: 300 })).toThrow(/did not stop within 300 ms/);
      const ended = await Promise.race([once(other, "exit").then(() => true), delay(500).then(() => false)]);
      expect(ended, "the process named in the pid file was ended by the cleanup").toBe(false);
    } finally {
      // Ended through its own handle, which sends nothing once the process has exited.
      other.kill("SIGKILL");
    }
  });

  it("a hanging child that starts only after its cleanup ran exits by itself at once", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("late");
    stopChild(pidFile);
    const r = spawnSync("sh", ["-c", hangs(pidFile)], { stdio: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
    expect(r.error?.code ?? null, "the late child ran until its guard").toBe(null);
    expect(r.status).toBe(0);
    expect(readPid(pidFile)).toBeGreaterThan(0);
  });

  it("a late child whose stop marker is removed between its pid write and its first read of it is gone once its file has ended", { timeout: HARNESS_CASE_MS }, async () => {
    // A test file of its own: a sandbox and a lifeline that this row ends as afterAll ends the file's.
    const box = mkdtempSync(path.join(sandbox, "lf-"));
    const life = await openLifeline(box);
    const pidFile = path.join(mkdtempSync(path.join(box, "pid-")), "child.pid");
    // The harness guard stopped the harness before its child started: the cleanup finds no pid,
    // writes the stop marker and returns.
    stopChild(pidFile);
    // The note is outside the row's own sandbox, so that it is still there after that sandbox is removed.
    const note = path.join(mkdtempSync(path.join(sandbox, "hold-")), "note");
    const child = spawn(NODE, ["-r", holdAfterPidFile, hangingChildFile, pidFile, life.file], {
      stdio: "ignore",
      env: { ...process.env, HOLD_NOTE: note },
    });
    const exited = once(child, "exit").then(() => true, () => false);
    try {
      const start = performance.now();
      while (readPid(pidFile) === 0 && performance.now() - start < STOP_WAIT_MS) await delay(10);
      expect(readPid(pidFile), "the late child wrote its pid").toBeGreaterThan(0);
      // The child is held after its pid write until its marker is gone, so its first read finds none.
      rmSync(path.join(path.dirname(pidFile), "stop"), { force: true });
      await endOfFile(life, box);
      expect(await within(exited, 3_000), "the late child was still running 3 s after its file ended").toBe(true);
      expect(readFileSync(note, "utf8"), "the child was held after its pid write until its stop marker was gone").toBe("marker gone");
    } finally {
      // Ended through its own handle, which sends nothing once the process has exited.
      child.kill("SIGKILL");
      for (const socket of life.sockets) socket.destroy();
      life.server.close();
    }
  });
});
