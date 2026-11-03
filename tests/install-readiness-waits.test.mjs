// cinatra-cli#325: the readiness waits of the development install's stack
// start (`waitForCompose`, `waitForNango` in src/install.mjs) bound each probe
// from its spawn and pause through `pauseInstall`, which spawns no child: a
// `sleep` on PATH cannot end a pause early, and no pause bound can expire.
//
// The children here are real processes: small `docker`, `curl` and `sleep`
// stand-in scripts placed first on PATH of a harness node process. A stand-in
// that "hangs" execs a node child that writes its pid, ignores SIGTERM and
// never exits, so only a bound with SIGKILL ends it. A wait with no bound
// blocks its whole process (the wait is synchronous), so each case runs the
// helper in a harness process with its own guard: the guard stops a helper
// that waited past its bound, and the case fails on its own assertion. Every
// never-exiting child is killed after its case in either outcome, by the pid
// it wrote itself.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE = process.execPath;
const INSTALL_URL = new URL("../src/install.mjs", import.meta.url).href;
const HARNESS_GUARD_MS = 15_000;
const HARNESS_CASE_MS = 30_000;
const NEVER_EXITS_JS =
  "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

let sandbox;
const pidFiles = [];
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-readiness-waits-"));
});
afterEach(() => {
  while (pidFiles.length) killIfAlive(pidFiles.pop());
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

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

/** Cleanup in every outcome: a child a helper never stopped is killed here. */
function killIfAlive(pidFile) {
  const pid = readPid(pidFile);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** A new pid file path in the sandbox, killed after the case. */
function newPidFile(tag) {
  const file = path.join(mkdtempSync(path.join(sandbox, `pid-${tag}-`)), "child.pid");
  pidFiles.push(file);
  return file;
}

/** A shell line that becomes a node child which never exits (pid in `pidFile`). */
function hangs(pidFile) {
  return `exec "${NODE}" -e "${NEVER_EXITS_JS}" "${pidFile}"`;
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
    "const t0 = Date.now();\n" +
    `try { ${call}; } catch (err) { threw = String(err?.message ?? err); code = err?.code ?? null; }\n` +
    "return { ms: Date.now() - t0, lines, threw, code };"
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
  it("a probe that never exits is stopped at its bound and is a failed attempt, not a hang", { timeout: HARNESS_CASE_MS }, () => {
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

  for (const bound of ["0", "-1", "Infinity", "NaN", '"1500"', "null", "0.5", "1500.5"]) {
    it(`a probe bound of ${bound} is refused by name before any probe runs (0 would mean no bound)`, { timeout: HARNESS_CASE_MS }, () => {
      const countFile = path.join(mkdtempSync(path.join(sandbox, "count-")), "count");
      const env = standInsEnv({ docker: `echo x >> "${countFile}"; exit 0`, sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(compose(`{ probeTimeoutMs: ${bound} }`), { env }));
      expect(v.code).toBe("INSTALL_PROBE_BOUND_INVALID");
      expect(() => readFileSync(countFile, "utf8")).toThrow();
    });
  }
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

describe("waitForCompose: the 1 s pause spawns no child and never ends early (cinatra-cli#325)", () => {
  it("with a `sleep` on PATH that exits 0 at once, the pause still takes its full 1 s and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const sleep = markedSleep("exit 0");
    const env = standInsEnv({ docker: "exit 1", sleep: sleep.body });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.ms).toBeGreaterThanOrEqual(950);
    expectNoSleepChild(sleep.marker);
  });

  it("with a `sleep` on PATH that never exits, the pause takes its 1 s and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("sleep");
    const sleep = markedSleep(hangs(pidFile));
    const env = standInsEnv({ docker: "exit 1", sleep: sleep.body });
    const v = valueOf(inHarness(compose(), { env }));
    expect(v.threw).toMatch(/Postgres did not become ready/);
    expect(v.ms).toBeGreaterThanOrEqual(950);
    expect(v.ms).toBeLessThan(8_000);
    expectNoSleepChild(sleep.marker);
  });
});

describe("waitForNango: the curl probe is bounded with SIGKILL and the 2 s pause spawns no child (cinatra-cli#325)", () => {
  it("a curl probe that never exits (it ignores SIGTERM) is stopped at its bound; the wait warns and goes on", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("curl");
    const env = standInsEnv({ curl: hangs(pidFile), sleep: SLEEP_CLEAN });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.threw).toBe(null);
    expect(v.lines).toHaveLength(1);
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeLessThan(8_000);
    expectGone(pidFile);
  });

  for (const bound of ["0", "-1", "Infinity", "0.5", "1500.5"]) {
    it(`a curl probe bound of ${bound} is refused by name`, { timeout: HARNESS_CASE_MS }, () => {
      const env = standInsEnv({ curl: "exit 0", sleep: SLEEP_CLEAN });
      const v = valueOf(inHarness(nango(`{ probeTimeoutMs: ${bound} }`), { env }));
      expect(v.code).toBe("INSTALL_PROBE_BOUND_INVALID");
      expect(v.lines).toEqual([]);
    });
  }

  it("with a `sleep` on PATH that exits 0 at once, the pause still takes its full 2 s and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const sleep = markedSleep("exit 0");
    const env = standInsEnv({ curl: "exit 7", sleep: sleep.body });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeGreaterThanOrEqual(1_950);
    expectNoSleepChild(sleep.marker);
  });

  it("with a `sleep` on PATH that never exits, the pause takes its 2 s and no sleep child runs", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = newPidFile("sleep");
    const sleep = markedSleep(hangs(pidFile));
    const env = standInsEnv({ curl: "exit 7", sleep: sleep.body });
    const v = valueOf(inHarness(nango(), { env }));
    expect(v.lines[0]).toMatch(/Nango did not report healthy in time/);
    expect(v.ms).toBeGreaterThanOrEqual(1_950);
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
    expect(v.ms).toBeGreaterThanOrEqual(950);
    expectNoSleepChild(sleep.marker);
  });

  it("a length of 1.6 s is a pause of 2 s", { timeout: HARNESS_CASE_MS }, () => {
    const v = valueOf(inHarness(pause("1.6")));
    expect(v.threw).toBe(null);
    expect(v.ms).toBeGreaterThanOrEqual(1_950);
  });

  for (const [arg, ms] of [
    [1.6, 2_000],
    [0.2, 1_000],
    [0, 1_000],
    [-5, 1_000],
    [2, 2_000],
  ]) {
    it(`installPauseMs: a length of ${arg} s is a pause of ${ms} ms`, async () => {
      const install = await import("../src/install.mjs");
      expect(install.installPauseMs(arg)).toBe(ms);
    });
  }

  for (const arg of ["Infinity", "-Infinity", "NaN", '"1"', "undefined", "null"]) {
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
