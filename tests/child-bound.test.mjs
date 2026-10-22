// The shared child-wait leaf (`src/child-bound.mjs`) and a real expiry run
// for every call site that this change bounds.
//
// The children here are real processes: the running node binary, or a small
// stand-in script. A never-exiting stand-in writes its pid and ignores SIGTERM,
// so only a SIGKILL stops it; every case that starts one checks that it is
// gone afterwards, and kills any survivor.
//
// The leaf is loaded per case (a dynamic import), so each case reports its own
// failure.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const NODE = process.execPath;
const LEAF_URL = new URL("../src/child-bound.mjs", import.meta.url).href;
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const loadLeaf = () => import(LEAF_URL);

/** A child that writes its pid, ignores SIGTERM and never exits. */
const NEVER_EXITS =
  "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

/** A child that appends its pid to the file argv[1] and exits 0. */
const LOGS_ITS_PID = "require('fs').appendFileSync(process.argv[1], process.pid + '\\n')";

let sandbox;
const started = [];
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-child-bound-"));
});
afterAll(() => {
  for (const pidFile of started) killIfAlive(pidFile);
  rmSync(sandbox, { recursive: true, force: true });
});

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidPath(name) {
  const p = path.join(sandbox, `${name}-${process.hrtime.bigint()}.pid`);
  started.push(p);
  return p;
}

function readPid(pidFile) {
  try {
    return Number(readFileSync(pidFile, "utf8").trim().split(/\s+/)[0]);
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

/** The process named by `pidFile` was started, and is gone. A killed process
 *  is reaped by its new parent shortly after, so this waits a little. */
function expectGone(pidFile, waitMs = 3000) {
  const pid = readPid(pidFile);
  expect(pid, `${path.basename(pidFile)} names a started process`).toBeGreaterThan(0);
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < waitMs) pause(50);
  expect(isAlive(pid), `${path.basename(pidFile)} (pid ${pid}) is gone`).toBe(false);
}

function script(name, body, { executable = false } = {}) {
  const p = path.join(sandbox, name);
  writeFileSync(p, body);
  chmodSync(p, executable ? 0o755 : 0o644);
  return p;
}

/** Run `code` (an ES module body) in a fresh node process; its last stdout
 *  line is parsed as JSON. The run itself is stopped by SIGKILL at `timeout`. */
function harness(code, { env = process.env, timeout = 30_000 } = {}) {
  const r = spawnSync(NODE, ["--input-type=module", "-e", code], { encoding: "utf8", env, timeout, killSignal: "SIGKILL" });
  const lines = String(r.stdout ?? "").trim().split("\n");
  let value = null;
  try {
    value = JSON.parse(lines[lines.length - 1]);
  } catch {
    value = null;
  }
  return { status: r.status, signal: r.signal, value, stderr: r.stderr };
}

function fileLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function functionText(src, name) {
  const m = new RegExp(`\\n(?:export )?(function ${name}\\([\\s\\S]*?\\n\\})\\n`).exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// The leaf's API
// ---------------------------------------------------------------------------

describe("child-bound: the helpers are the install road's own text", () => {
  const SHARED = ["boundedOptions", "describeBound", "childTimedOut", "childSubcommand", "childTimeoutError", "advisoryRead"];

  it("each shared helper is byte-identical to its install.mjs definition", async () => {
    await loadLeaf();
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const install = readFileSync(path.join(SRC_DIR, "install.mjs"), "utf8");
    for (const name of SHARED) {
      const mine = functionText(leaf, name);
      expect(mine, `child-bound.mjs defines ${name}`).not.toBeNull();
      expect(mine, `${name} matches install.mjs`).toBe(functionText(install, name));
    }
  });

  it("childTimeoutError says exactly what install.mjs says, for 1.5 s, 60 s and 15 min", async () => {
    const cb = await loadLeaf();
    const install = readFileSync(path.join(SRC_DIR, "install.mjs"), "utf8");
    const body = ["describeBound", "childSubcommand", "childTimeoutError"].map((n) => functionText(install, n)).join("\n");
    const installTimeoutError = new Function("path", `${body}\nreturn childTimeoutError;`)(path);
    const cases = [
      ["git", ["-C", "/x", "fetch", "origin"], 1_500, "`git fetch` did not finish within 1.5 s; it was stopped."],
      ["/usr/bin/docker", ["ps", "-a"], 60_000, "`docker ps` did not finish within 1 min; it was stopped."],
      ["git", ["clone", "-q", "u"], 15 * 60_000, "`git clone` did not finish within 15 min; it was stopped."],
    ];
    for (const [cmd, args, ms, text] of cases) {
      const mine = cb.childTimeoutError(cmd, args, ms);
      expect(mine.message).toBe(text);
      expect(mine.code).toBe("CHILD_TIMEOUT");
      expect(mine.message).toBe(installTimeoutError(cmd, args, ms).message);
    }
  });

  it("boundedOptions adds the bound and SIGKILL; advisoryRead degrades a timeout only", async () => {
    const cb = await loadLeaf();
    expect(cb.boundedOptions({ stdio: "inherit", timeout: 5 }, 1500)).toEqual({ stdio: "inherit", timeout: 1500, killSignal: "SIGKILL" });
    const seen = [];
    const timeout = Object.assign(new Error("t"), { code: "CHILD_TIMEOUT" });
    expect(cb.advisoryRead(() => { throw timeout; }, (e) => seen.push(e))).toBeNull();
    expect(seen).toEqual([timeout]);
    expect(() => cb.advisoryRead(() => { throw new Error("other"); })).toThrow("other");
    expect(cb.advisoryRead(() => "v")).toBe("v");
  });

  it("imports only node built-ins, each one of node:path, node:child_process and node:url", async () => {
    await loadLeaf();
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const specifiers = [...leaf.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(["node:path", "node:child_process", "node:url"]).toContain(s);
    expect(leaf).not.toMatch(/\bimport\s*\(/);
  });
});

describe("child-bound: readChild judges the exit status, then the output", () => {
  let fake;
  beforeAll(() => {
    // An executable stand-in: `fake <mode>`; its name is what the reasons show.
    fake = script(
      "fake",
      `#!${NODE}
const mode = process.argv[2];
if (mode === "says-ok-exits-3") { console.log("ok: done, success"); process.exit(3); }
if (mode === "says-error-exits-0") { console.error("fatal: error"); console.log("the-answer"); process.exit(0); }
if (mode === "garbage") { console.log("<<not json>>"); process.exit(0); }
if (mode === "json") { console.log(JSON.stringify({ a: 1 })); process.exit(0); }
if (mode === "kills-itself") { process.kill(process.pid, "SIGKILL"); }
`,
      { executable: true },
    );
  });

  it("N: a non-zero exit that prints success is a failure with a named reason", async () => {
    const cb = await loadLeaf();
    const r = cb.readChild(fake, ["says-ok-exits-3"], { timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(3);
    expect(r.code).toBe("CHILD_FAILED");
    expect(r.reason).toBe("fake says-ok-exits-3 exited 3");
    expect(r.timedOut).toBe(false);
  });

  it("status 0 is success whatever stderr says", async () => {
    const cb = await loadLeaf();
    const r = cb.readChild(fake, ["says-error-exits-0"], { timeoutMs: 15_000 });
    expect(r).toMatchObject({ ok: true, status: 0, code: null, reason: null, timedOut: false });
    expect(r.stdout.trim()).toBe("the-answer");
  });

  it("E: a child that cannot be run is a failure naming why", async () => {
    const cb = await loadLeaf();
    const notExecutable = script("not-executable", "#!/bin/sh\necho hi\n");
    const r = cb.readChild(notExecutable, ["status"], { timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.code).toBe("CHILD_FAILED");
    expect(r.error).toBeTruthy();
    expect(r.reason).toMatch(/^could not run not-executable: .*(EACCES|ENOENT)/);
  });

  it("a signal death is a failure: killed by <SIG>", async () => {
    const cb = await loadLeaf();
    const r = cb.readChild(fake, ["kills-itself"], { timeoutMs: 15_000 });
    expect(r).toMatchObject({ ok: false, status: null, signal: "SIGKILL", code: "CHILD_FAILED", reason: "killed by SIGKILL" });
  });

  it("T: a child that never exits is stopped at its bound, named, and gone", async () => {
    const cb = await loadLeaf();
    const pidFile = pidPath("readchild-t");
    const hangs = script("hangs", `#!/bin/sh\nexec "${NODE}" -e "${NEVER_EXITS}" "${pidFile}"\n`, { executable: true });
    const t0 = Date.now();
    const r = cb.readChild(hangs, ["status"], { timeoutMs: 1_500 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe("CHILD_TIMEOUT");
    expect(r.reason).toBe("`hangs status` did not finish within 1.5 s; it was stopped.");
    expect(r.error?.code).toBe("CHILD_TIMEOUT");
    expect(r.error?.message).toBe(r.reason);
    expectGone(pidFile);
  });

  it("M: status 0 with output the caller cannot read is a failure, never an empty answer", async () => {
    const cb = await loadLeaf();
    const bad = cb.readChild(fake, ["garbage"], { timeoutMs: 15_000, parse: (s) => JSON.parse(s) });
    expect(bad).toMatchObject({ ok: false, status: 0, code: "CHILD_FAILED", reason: "fake garbage answered unreadable output" });
    const none = cb.readChild(fake, ["garbage"], { timeoutMs: 15_000, parse: () => undefined });
    expect(none).toMatchObject({ ok: false, status: 0, reason: "fake garbage answered unreadable output" });
    const good = cb.readChild(fake, ["json"], { timeoutMs: 15_000, parse: (s) => JSON.parse(s) });
    expect(good).toMatchObject({ ok: true, status: 0, value: { a: 1 } });
  });

  it("kill-at-bound: a SIGTERM-ignoring child is ended by SIGKILL within a 300 ms bound plus 2 s, named by its bound", async () => {
    const cb = await loadLeaf();
    const pidFile = pidPath("readchild-t1");
    const ignores = script("ignores-term", `#!/bin/sh\nexec "${NODE}" -e "${NEVER_EXITS}" "${pidFile}"\n`, { executable: true });
    const t0 = Date.now();
    const r = cb.readChild(ignores, ["status"], { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2_300);
    expect(r).toMatchObject({ ok: false, timedOut: true, code: "CHILD_TIMEOUT", signal: "SIGKILL" });
    expect(r.reason).toBe("`ignores-term status` did not finish within 0.3 s; it was stopped.");
    expectGone(pidFile);
  });

  it("spawn-throw: a synchronous throw from the spawn becomes a named failure, never a throw", async () => {
    const cb = await loadLeaf();
    const log = path.join(sandbox, `t5-${process.hrtime.bigint()}.log`);
    let r;
    expect(() => {
      r = cb.readChild(NODE, ["-e", LOGS_ITS_PID, log, "nul\0byte"], { timeoutMs: 15_000 });
    }).not.toThrow();
    expect(r).toMatchObject({ ok: false, status: null, code: "CHILD_FAILED", timedOut: false });
    expect(r.error?.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(r.reason).toMatch(new RegExp(`^could not run ${path.basename(NODE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
    expect(fileLines(log)).toEqual([]);
  });
});

describe("child-bound: bound-refused readChild refuses a bound that is not a whole number of milliseconds", () => {
  const INVALID = [
    ["0", 0],
    ["-1", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["1e999", 1e999],
    ['"60"', "60"],
    ["null", null],
    ["0.5", 0.5],
  ];

  for (const [label, value] of INVALID) {
    it(`timeoutMs ${label} is CHILD_BOUND_INVALID and starts nothing`, async () => {
      const cb = await loadLeaf();
      const log = path.join(sandbox, `t3-${process.hrtime.bigint()}.log`);
      const r = cb.readChild(NODE, ["-e", LOGS_ITS_PID, log], { timeoutMs: value });
      expect(r.code, `timeoutMs ${label}`).toBe("CHILD_BOUND_INVALID");
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("CHILD_BOUND_INVALID");
      expect(r.reason).toMatch(/is not a whole number of milliseconds of at least 1$/);
      expect(fileLines(log), "no process was started").toEqual([]);
    });
  }

  it("timeoutMs undefined, or no timeoutMs at all, runs under the read class", async () => {
    const cb = await loadLeaf();
    for (const opts of [{ timeoutMs: undefined }, {}]) {
      const log = path.join(sandbox, `t3-ok-${process.hrtime.bigint()}.log`);
      const r = cb.readChild(NODE, ["-e", LOGS_ITS_PID, log], opts);
      expect(r).toMatchObject({ ok: true, status: 0, code: null });
      expect(fileLines(log)).toHaveLength(1);
    }
    cb.__setChildBoundsForTest(300);
    try {
      const pidFile = pidPath("t3-read-class");
      const r = cb.readChild(NODE, ["-e", NEVER_EXITS, pidFile]);
      expect(r.reason).toMatch(/did not finish within 0\.3 s; it was stopped\.$/);
      expectGone(pidFile);
    } finally {
      cb.__setChildBoundsForTest(null);
    }
  });
});

describe("child-bound: a site's bound is validated when the call is made", () => {
  const INVALID = [
    ["0", 0],
    ["-1", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["1e999", 1e999],
    ['"60"', "60"],
    ["null", null],
    ["0.5", 0.5],
  ];

  it("siteBound throws CHILD_BOUND_INVALID for every value that is not a usable bound", async () => {
    const cb = await loadLeaf();
    for (const [label, value] of INVALID) {
      let err = null;
      try {
        cb.siteBound(value);
      } catch (e) {
        err = e;
      }
      expect(err?.code, `siteBound(${label})`).toBe("CHILD_BOUND_INVALID");
      expect(err?.message, `siteBound(${label})`).toMatch(/is not a whole number of milliseconds of at least 1$/);
    }
    expect(cb.siteBound(1)).toBe(1);
    expect(cb.siteBound(15_000)).toBe(15_000);
  });

  it("checkedBound returns a usable bound and throws CHILD_BOUND_INVALID for any other value", async () => {
    const cb = await loadLeaf();
    expect(cb.checkedBound(1)).toBe(1);
    expect(cb.checkedBound(60_000)).toBe(60_000);
    for (const [label, value] of [...INVALID, ["undefined", undefined]]) {
      expect(() => cb.checkedBound(value), `checkedBound(${label})`).toThrow(/is not a whole number of milliseconds of at least 1$/);
    }
  });

  it("the test override refuses a value that is not a usable bound and keeps the one it had", async () => {
    const cb = await loadLeaf();
    try {
      cb.__setChildBoundsForTest(300);
      for (const [label, value] of INVALID.filter(([, v]) => v !== null)) {
        let err = null;
        try {
          cb.__setChildBoundsForTest(value);
        } catch (e) {
          err = e;
        }
        expect(err?.code, `__setChildBoundsForTest(${label})`).toBe("CHILD_BOUND_INVALID");
        expect(cb.siteBound(15_000), `after __setChildBoundsForTest(${label})`).toBe(300);
      }
      // Under the override a site's own value is still checked.
      for (const [label, value] of INVALID) {
        expect(() => cb.siteBound(value), `siteBound(${label}) under the override`).toThrow(/is not a whole number of milliseconds of at least 1$/);
      }
    } finally {
      cb.__setChildBoundsForTest(null);
    }
    expect(cb.siteBound(15_000)).toBe(15_000);
  });

  // preview.mjs runSpawn, through its exported `defaultDeps().runDocker`: a
  // caller's timeoutMs that is not a usable bound is refused before the
  // spawn. PATH holds only the stand-in's folder, so no other program of that
  // name can be reached; at the base the stand-in starts and hangs, and the
  // harness bound (SIGKILL) ends the run.
  for (const [label, value] of [["0", "0"], ["null", "null"], ["-1", "-1"], ["NaN", "NaN"], ['"60"', '"60"']]) {
    it(`preview runSpawn: timeoutMs ${label} is CHILD_BOUND_INVALID and starts nothing`, () => {
      const pidFile = pidPath("runspawn-invalid");
      const callLog = path.join(sandbox, `calls-invalid-${process.hrtime.bigint()}.log`);
      const bin = standInBin({ answers: [], hang: "^ps$" }, pidFile, callLog);
      const work = path.join(sandbox, `work-${process.hrtime.bigint()}`);
      mkdirSync(work);
      const moduleUrl = new URL("../src/preview.mjs", import.meta.url).href;
      const r = harness(
        `const m = await import(${JSON.stringify(moduleUrl)});
let out;
try {
  const res = m.defaultDeps({ registryPath: ${JSON.stringify(work)} + "/previews.json" }).runDocker(["ps"], { timeoutMs: ${value} });
  out = { returned: { status: res.status, timedOut: res.timedOut } };
} catch (err) {
  out = { code: err?.code ?? null };
}
console.log(JSON.stringify(out));`,
        { env: { PATH: bin }, timeout: 5_000 },
      );
      expect(r.value, `timeoutMs ${label} (harness ${r.signal ?? r.status}): ${r.stderr}`).toEqual({ code: "CHILD_BOUND_INVALID" });
      expect(fileLines(callLog), "no process was started").toEqual([]);
    }, 20_000);
  }
});

describe("child-bound: bounds and the in-process sleep", () => {
  it("boundFor returns each class constant, and the test override reaches every class", async () => {
    const cb = await loadLeaf();
    expect(cb.boundFor("probe")).toBe(15_000);
    expect(cb.boundFor("read")).toBe(60_000);
    expect(cb.boundFor("compose")).toBe(2 * 60_000);
    expect(cb.boundFor("git")).toBe(15 * 60_000);
    expect(cb.boundFor("step")).toBe(60 * 60_000);
    expect(() => cb.boundFor("nonsense")).toThrow(/unknown bound class/);
    cb.__setChildBoundsForTest(1_500);
    try {
      for (const cls of ["probe", "read", "compose", "git", "step"]) expect(cb.boundFor(cls)).toBe(1_500);
      expect(cb.siteBound(15_000)).toBe(1_500);
      // readChild's default bound comes from boundFor too.
      const pidFile = pidPath("override");
      const r = cb.readChild(NODE, ["-e", NEVER_EXITS, pidFile]);
      expect(r.timedOut).toBe(true);
      expect(r.reason).toMatch(/did not finish within 1\.5 s; it was stopped\.$/);
      expectGone(pidFile);
    } finally {
      cb.__setChildBoundsForTest(null);
    }
    expect(cb.boundFor("read")).toBe(60_000);
    expect(cb.siteBound(15_000)).toBe(15_000);
    expect(cb.siteBound(30_000)).toBe(30_000);
  });

  it("no-env-bound: no environment value reaches a bound; siteBound and boundFor read no process.env", async () => {
    const r = harness(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
console.log(JSON.stringify({ site: cb.siteBound(15000), read: cb.boundFor("read"), probe: cb.boundFor("probe") }));`,
      {
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          CINATRA_CHILD_BOUND_MS: "300",
          CINATRA_CHILD_BOUNDS_FOR_TEST: "300",
          CINATRA_TEST_BOUND: "1",
          VITEST: "true",
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.value).toEqual({ site: 15_000, read: 60_000, probe: 15_000 });
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    for (const name of ["siteBound", "boundFor", "__setChildBoundsForTest", "readChild"]) {
      const text = functionText(leaf, name);
      expect(text, `child-bound.mjs defines ${name}`).not.toBeNull();
      expect(text, `${name} reads no environment`).not.toMatch(/process\s*\.\s*(env|argv)|process\s*\[/);
    }
    expect(leaf).not.toMatch(/process\s*\.\s*env/);
  });

  it("sleepSync waits in-process: no child, and it works with an empty PATH", async () => {
    const cb = await loadLeaf();
    const before = process.getActiveResourcesInfo().slice().sort();
    const t0 = performance.now();
    cb.sleepSync(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
    expect(process.getActiveResourcesInfo().slice().sort()).toEqual(before);
    const r = harness(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
const t0 = performance.now(); cb.sleepSync(200);
console.log(JSON.stringify({ ms: performance.now() - t0 }));`,
      { env: { PATH: "" } },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.value.ms).toBeGreaterThanOrEqual(190);
  });
});

// ---------------------------------------------------------------------------
// site-expiry: a real expiry run for every call site this change bounds
// ---------------------------------------------------------------------------
//
// Each row drives the site through an exported entry, in a fresh node process
// whose leaf bound override is 300 ms (set by import, as a test does). A
// stand-in `docker` is first on PATH: it answers the earlier calls of the
// entry by argv pattern, and on the target call writes its pid, ignores
// SIGTERM and never exits. The call must end within 300 ms plus 2 s with the
// site's own failure value, and the stand-in must be gone. A site bound only
// by `timeout` sends SIGTERM, so the stand-in outlives it, the call blocks,
// and the row's harness bound (SIGKILL) ends the run instead.

const PG_CONFIG = JSON.stringify({
  services: {
    postgres: {
      image: "postgres:17",
      volumes: [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql/data" }],
    },
  },
  volumes: { pgdata: { name: "cinatra_pgdata" } },
});
const PG_VOLUME = JSON.stringify([{ Name: "cinatra_pgdata", CreatedAt: "2026-01-01T00:00:00Z" }]);

const SITE_ROWS = [
  {
    site: "src/upgrade-ledger-hook.mjs defaultDockerRun",
    module: "upgrade-ledger-hook.mjs",
    entry: `return m.dockerVolumeIdentity("cinatra_pgdata");`,
    answers: [],
    hang: "^volume inspect ",
    expected: null,
  },
  {
    site: "src/version-ledger-capture.mjs defaultCapture",
    module: "version-ledger-capture.mjs",
    entry: `return m.defaultCapture("docker", ["compose", "ps", "--format", "json"], { cwd: dir });`,
    answers: [],
    hang: "^compose ps ",
    expected: null,
  },
  {
    site: "src/preview.mjs runSpawn",
    module: "preview.mjs",
    entry: `const r = m.defaultDeps({ registryPath: dir + "/previews.json" }).runDocker(["ps", "-a"]);
return { status: r.status, timedOut: r.timedOut };`,
    answers: [],
    hang: "^ps -a$",
    expected: { status: null, timedOut: true },
  },
  {
    site: "src/nango-secret-key.mjs createComposeNangoDbTransport query",
    module: "nango-secret-key.mjs",
    entry: `const r = m.createComposeNangoDbTransport({ cwd: dir }).query("select 1;");
return { status: r.status, stdout: r.stdout };`,
    answers: [],
    hang: "^compose exec -T ",
    expected: { status: null, stdout: "" },
  },
  {
    site: "src/recreate-preflight.mjs makeDockerCapture (probe bound)",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
const specs = p.discover();
return { specs: specs.length, configResolved: p.state.configResolved };`,
    answers: [],
    hang: " config --format json$",
    expected: { specs: 0, configResolved: false },
  },
  {
    site: "src/recreate-preflight.mjs makeInspectVolumeThreeWay",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
return p.transport.inspectVolumeStatus("cinatra_pgdata");`,
    answers: [],
    hang: "^volume inspect ",
    expected: { status: "error", row: null },
  },
  {
    site: "src/recreate-preflight.mjs buildDeploymentPreflight volumeState (volume-read bound)",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
p.discover();
return p.transport.volumeState("cinatra_pgdata");`,
    answers: [
      [" config --format json$", PG_CONFIG],
      ["^volume inspect cinatra_pgdata$", PG_VOLUME],
    ],
    hang: "^run --rm ",
    expected: "present",
  },
  {
    site: "src/recreate-preflight.mjs buildDeploymentPreflight dockerReadVolume (volume-read bound)",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
p.discover();
return p.transport.readMarker("postgres", "PG_VERSION");`,
    answers: [
      [" config --format json$", PG_CONFIG],
      ["^volume inspect cinatra_pgdata$", PG_VOLUME],
    ],
    hang: "^run --rm ",
    expected: null,
  },
];

/** A bin dir holding a stand-in `docker` for one row. */
function standInBin(row, pidFile, callLog) {
  const dir = mkdtempSync(path.join(sandbox, "bin-"));
  const body = `#!${NODE}
const fs = require("fs");
const line = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(callLog)}, line + "\\n");
for (const [re, out] of ${JSON.stringify(row.answers)}) {
  if (new RegExp(re).test(line)) { process.stdout.write(out); process.exit(0); }
}
if (new RegExp(${JSON.stringify(row.hang)}).test(line)) {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write("stand-in: unexpected call: " + line + "\\n");
  process.exit(97);
}
`;
  const p = path.join(dir, "docker");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return dir;
}

describe("child-bound: site-expiry every bounded site ends a SIGTERM-ignoring child at its bound", () => {
  for (const row of SITE_ROWS) {
    it(`${row.site}: ends within 300 ms + 2 s with its named failure, and the stand-in is gone`, async () => {
      const pidFile = pidPath("site");
      const callLog = path.join(sandbox, `calls-${process.hrtime.bigint()}.log`);
      const bin = standInBin(row, pidFile, callLog);
      const work = path.join(sandbox, `work-${process.hrtime.bigint()}`);
      mkdirSync(work);
      const moduleUrl = new URL(`../src/${row.module}`, import.meta.url).href;
      const r = harness(
        `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
const dir = ${JSON.stringify(work)};
cb.__setChildBoundsForTest(300);
const t0 = performance.now();
const v = await (async () => { ${row.entry} })();
console.log(JSON.stringify({ ms: performance.now() - t0, v: v === undefined ? "(undefined)" : v }));`,
        { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, timeout: 8_000 },
      );
      expect(r.value?.ms ?? Infinity, `the call ends within the bound plus 2 s (harness ${r.signal ?? r.status}): ${r.stderr}`).toBeLessThan(2_300);
      expect(r.status, r.stderr).toBe(0);
      expect(r.value.v).toEqual(row.expected);
      expect(fileLines(callLog).some((l) => new RegExp(row.hang).test(l)), "the stand-in saw the target call").toBe(true);
      expectGone(pidFile);
    }, 20_000);
  }
});
