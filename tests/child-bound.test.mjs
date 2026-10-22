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
import { spawn, spawnSync } from "node:child_process";
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

/** The whole top-level declaration of `name`, `export ` included when the
 *  source has it: from the start of its line to its closing brace. */
function declarationText(src, name) {
  const m = new RegExp(`\\n((?:export )?function ${name}\\([\\s\\S]*?\\n\\})\\n`).exec(src);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// The leaf's API
// ---------------------------------------------------------------------------

describe("child-bound: the helpers are the install road's own text", () => {
  const SHARED = ["boundedOptions", "describeBound", "childTimedOut", "childSubcommand", "childTimeoutError", "advisoryRead"];

  it("each shared helper's raw declaration is install.mjs's raw declaration with `export ` put before it", async () => {
    await loadLeaf();
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const install = readFileSync(path.join(SRC_DIR, "install.mjs"), "utf8");
    for (const name of SHARED) {
      const mine = declarationText(leaf, name);
      const theirs = declarationText(install, name);
      expect(mine, `child-bound.mjs declares ${name}`).not.toBeNull();
      expect(theirs, `install.mjs declares ${name}`).not.toBeNull();
      expect(theirs.startsWith("export "), `install.mjs's ${name} is not exported`).toBe(false);
      expect(mine, `child-bound.mjs's ${name} is "export " + install.mjs's text`).toBe(`export ${theirs}`);
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

  it("imports only the node built-ins listed here, and nothing else", async () => {
    await loadLeaf();
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const specifiers = [...leaf.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(specifiers.slice().sort()).toEqual(["node:child_process", "node:path", "node:url"]);
    expect(leaf.match(/^\s*import\b/gm) ?? []).toHaveLength(specifiers.length);
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

// ---------------------------------------------------------------------------
// Stand-ins with a grandchild on the pipes
// ---------------------------------------------------------------------------
//
// A stand-in here can start a grandchild that writes its pid, ignores
// SIGTERM, never exits and holds the child's stdout and stderr. The bound is
// 2 s, and each fresh stand-in is run once (`--warm`) before the case: the
// first start of a newly written executable can take longer than a short
// bound. A grandchild left running is killed when the file ends.

const GROUP_BOUND_MS = 2_000;

/** Run a fresh stand-in once, so the case's own start is not its first. */
function warm(executable) {
  const r = spawnSync(executable, ["--warm"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  expect(r.status, `warming ${path.basename(executable)}: ${r.stderr}`).toBe(0);
}

/** Body (node, CommonJS) that starts the never-exiting grandchild on the
 *  inherited pipes; `gpidFile` receives the grandchild's pid. */
function startGrandchild(gpidFile, stdio = ["ignore", "inherit", "inherit"]) {
  return `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(gpidFile)}], { stdio: ${JSON.stringify(stdio)} });`;
}

/** The longest a stand-in waits for its worker's pid. It is well inside the
 *  bounds of the case that uses it (an answer within 2.5 s under a 3 s bound),
 *  so a worker that is slow to start fails the case on the stand-in's exit 99
 *  and never on either bound. */
const WORKER_PID_WAIT_MS = 1_500;

/** Body (node, CommonJS, `fs` in scope) that waits until `gpidFile` names a
 *  pid, at most WORKER_PID_WAIT_MS; past that it writes why and exits 99. */
function awaitWorkerPid(gpidFile) {
  return `const workerPidFile = ${JSON.stringify(gpidFile)};
    const workerPid = () => { try { return Number(fs.readFileSync(workerPidFile, "utf8").trim()); } catch { return 0; } };
    for (const t0 = Date.now(); !(workerPid() > 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)) {
      if (Date.now() - t0 >= ${WORKER_PID_WAIT_MS}) { fs.writeSync(2, "stand-in: the worker wrote no pid within ${WORKER_PID_WAIT_MS} ms\\n"); process.exit(99); }
    }`;
}

/** A bin dir holding a stand-in `docker`: the earlier calls are answered by
 *  argv pattern; the first target call (`target.re`) writes its own pid
 *  (a repeated one exits 98 and starts nothing), then
 *  - mode "hang": starts the grandchild, ignores SIGTERM and never exits;
 *  - mode "answer-and-leave": writes `out`/`err`, starts the grandchild and
 *    exits `exit` (the grandchild keeps the pipes open);
 *  - mode "answer-and-die": writes `out`/`err`, then SIGKILLs itself;
 *  - mode "answer-with-worker": writes `out`, starts the grandchild with all
 *    its stdio ignored (a background worker that holds no pipe), waits until
 *    the worker has written its pid (exit 99 when it has not within
 *    WORKER_PID_WAIT_MS) and exits. */
function groupStandInBin({ answers = [], target }, { pidFile, gpidFile, callLog }) {
  const dir = mkdtempSync(path.join(sandbox, "gbin-"));
  const body = `#!${NODE}
if (process.argv[2] === "--warm") process.exit(0);
const fs = require("fs");
const line = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(callLog)}, line + "\\n");
for (const [re, out] of ${JSON.stringify(answers)}) {
  if (new RegExp(re).test(line)) { fs.writeSync(1, out); process.exit(0); }
}
const t = ${JSON.stringify(target)};
if (!new RegExp(t.re).test(line)) {
  fs.writeSync(2, "stand-in: unexpected call: " + line + "\\n");
  process.exit(97);
}
if (fs.existsSync(${JSON.stringify(pidFile)})) {
  // The target acts once: a repeated call starts no second grandchild.
  fs.writeSync(2, "stand-in: target called again: " + line + "\\n");
  process.exit(98);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
if (t.mode === "hang") {
  ${gpidFile ? startGrandchild(gpidFile) : ""}
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  if (t.out) fs.writeSync(1, t.out);
  if (t.err) fs.writeSync(2, t.err);
  if (t.mode === "answer-and-die") process.kill(process.pid, "SIGKILL");
  if (t.mode === "answer-with-worker") {
    ${gpidFile ? startGrandchild(gpidFile, "ignore") + awaitWorkerPid(gpidFile) : ""}
  } else {
    ${gpidFile ? startGrandchild(gpidFile) : ""}
  }
  process.exit(t.exit ?? 0);
}
`;
  const p = path.join(dir, "docker");
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  warm(p);
  return dir;
}

/** Drive `entry` (an async function body that sees `m` and `dir`) of
 *  src/<module> in a fresh node process under the leaf bound override `ms`,
 *  with the stand-in `docker` of `bin` first on PATH. */
function runEntry(module, entry, bin, ms = GROUP_BOUND_MS) {
  const work = path.join(sandbox, `gwork-${process.hrtime.bigint()}`);
  mkdirSync(work);
  const moduleUrl = new URL(`../src/${module}`, import.meta.url).href;
  return harness(
    `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
const dir = ${JSON.stringify(work)};
cb.__setChildBoundsForTest(${ms});
const t0 = performance.now();
const v = await (async () => { ${entry} })();
console.log(JSON.stringify({ ms: performance.now() - t0, v: v === undefined ? "(undefined)" : v }));`,
    { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, timeout: 20_000 },
  );
}

// ---------------------------------------------------------------------------
// result-refused: a status reader refuses a timeout, a signal or an error
// before it reads the status
// ---------------------------------------------------------------------------
//
// A child that answers, leaves a grandchild on its pipes and exits 0 comes
// back from spawnSync as status 0 together with a timeout error. A child that
// prints docker's "no such volume" and then dies by a signal has no status.
// Neither may be read as an answer, nor as an absent volume.

const PG_VOLUME_ID = "cinatra_pgdata\t2026-01-01T00:00:00Z\n";

const REFUSE_ROWS = [
  {
    site: "src/recreate-preflight.mjs makeDockerCapture: status 0 with a timeout is no compose config",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
const specs = p.discover();
return { specs: specs.length, configResolved: p.state.configResolved };`,
    target: { re: " config --format json$", mode: "answer-and-leave", out: PG_CONFIG, exit: 0 },
    grandchild: true,
    expected: { specs: 0, configResolved: false },
  },
  {
    site: "src/recreate-preflight.mjs makeInspectVolumeThreeWay: status 0 with a timeout is an error, never ok",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
return p.transport.inspectVolumeStatus("cinatra_pgdata");`,
    target: { re: "^volume inspect cinatra_pgdata$", mode: "answer-and-leave", out: PG_VOLUME, exit: 0 },
    grandchild: true,
    expected: { status: "error", row: null },
  },
  {
    site: "src/recreate-preflight.mjs makeInspectVolumeThreeWay: 'no such volume' from a timed-out exit 1 is an error, never absent",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
return p.transport.inspectVolumeStatus("cinatra_pgdata");`,
    target: { re: "^volume inspect cinatra_pgdata$", mode: "answer-and-leave", err: "Error: No such volume: cinatra_pgdata\n", exit: 1 },
    grandchild: true,
    expected: { status: "error", row: null },
  },
  {
    site: "src/recreate-preflight.mjs makeInspectVolumeThreeWay: 'no such volume' from a signal death is an error, never absent",
    module: "recreate-preflight.mjs",
    entry: `const p = m.buildDeploymentPreflight({ slug: null, targetDir: dir });
return p.transport.inspectVolumeStatus("cinatra_pgdata");`,
    target: { re: "^volume inspect cinatra_pgdata$", mode: "answer-and-die", err: "Error: No such volume: cinatra_pgdata\n" },
    grandchild: false,
    expected: { status: "error", row: null },
  },
  {
    site: "src/upgrade-ledger-hook.mjs defaultDockerRun: status 0 with a timeout is no volume identity",
    module: "upgrade-ledger-hook.mjs",
    entry: `return m.dockerVolumeIdentity("cinatra_pgdata");`,
    target: { re: "^volume inspect ", mode: "answer-and-leave", out: PG_VOLUME_ID, exit: 0 },
    grandchild: true,
    expected: null,
  },
  {
    site: "src/version-ledger-capture.mjs defaultCapture: status 0 with a timeout is no capture",
    module: "version-ledger-capture.mjs",
    entry: `return m.defaultCapture("docker", ["compose", "ps", "--format", "json"], { cwd: dir });`,
    target: { re: "^compose ps ", mode: "answer-and-leave", out: "[]\n", exit: 0 },
    grandchild: true,
    expected: null,
  },
];

describe("child-bound: result-refused every status reader refuses an error, a timeout or a signal first", () => {
  for (const row of REFUSE_ROWS) {
    it(row.site, () => {
      const pidFile = pidPath("rsite");
      const gpidFile = row.grandchild ? pidPath("rsite-grandchild") : null;
      const callLog = path.join(sandbox, `rcalls-${process.hrtime.bigint()}.log`);
      const bin = groupStandInBin({ target: row.target }, { pidFile, gpidFile, callLog });
      const r = runEntry(row.module, row.entry, bin);
      expect(r.status, r.stderr).toBe(0);
      expect(fileLines(callLog).some((l) => new RegExp(row.target.re).test(l)), "the stand-in saw the target call").toBe(true);
      expect(r.value.v).toEqual(row.expected);
      expectGone(pidFile);
    }, 30_000);
  }

  it("src/nango-secret-key.mjs createComposeNangoDbTransport: a signal is no exit status, whatever status the spawn reports", async () => {
    const { createComposeNangoDbTransport } = await import(new URL("../src/nango-secret-key.mjs", import.meta.url).href);
    const results = [
      { status: 0, signal: "SIGKILL", stdout: "the-key\n", stderr: "" },
      { status: 0, signal: null, error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "the-key\n", stderr: "" },
      { status: 0, signal: null, error: Object.assign(new Error("spawn docker EACCES"), { code: "EACCES" }), stdout: "the-key\n", stderr: "" },
    ];
    for (const result of results) {
      const transport = createComposeNangoDbTransport({ cwd: sandbox, spawn: () => result });
      expect(transport.query("select 1;").status, JSON.stringify({ signal: result.signal, error: result.error?.code })).toBeNull();
    }
    const ok = createComposeNangoDbTransport({ cwd: sandbox, spawn: () => ({ status: 0, signal: null, stdout: "k\n", stderr: "" }) });
    expect(ok.query("select 1;")).toEqual({ status: 0, stdout: "k\n", stderr: "" });
  });
});

// ---------------------------------------------------------------------------
// The review classes of this change, one block each (see the commit message)
// ---------------------------------------------------------------------------

describe("child-bound: class wait-ends a descendant on the pipes does not hold the caller past the bound", () => {
  // At the base the site has no bound, or one that sends SIGTERM to a child
  // that ignores it: the call blocks and the harness bound ends the run.
  for (const row of SITE_ROWS) {
    it(`${row.site}: a hanging child with a grandchild on its pipes ends at the bound, refused, and the child is gone`, () => {
      const pidFile = pidPath("wait-ends");
      const gpidFile = pidPath("wait-ends-grandchild");
      const callLog = path.join(sandbox, `wcalls-${process.hrtime.bigint()}.log`);
      const bin = groupStandInBin({ answers: row.answers, target: { re: row.hang, mode: "hang" } }, { pidFile, gpidFile, callLog });
      const r = runEntry(row.module, row.entry, bin);
      expect(r.value?.ms ?? Infinity, `the call ends within the bound plus 3 s (harness ${r.signal ?? r.status}): ${r.stderr}`).toBeLessThan(GROUP_BOUND_MS + 3_000);
      expect(r.status, r.stderr).toBe(0);
      expect(r.value.v).toEqual(row.expected);
      expect(readPid(gpidFile), "the grandchild was started").toBeGreaterThan(0);
      expectGone(pidFile);
      killIfAlive(gpidFile);
    }, 30_000);
  }
});

describe("child-bound: class platform-and-interrupt no POSIX-only machinery on win32; Ctrl-C reaches the bounded child", () => {
  it("with process.platform win32 a swept site's child is the caller's own child: no POSIX-only wrapper or group", () => {
    const moduleUrl = new URL("../src/version-ledger-capture.mjs", import.meta.url).href;
    const r = harness(
      `Object.defineProperty(process, "platform", { value: "win32" });
const m = await import(${JSON.stringify(moduleUrl)});
const said = m.defaultCapture(${JSON.stringify(NODE)}, ["-e", "console.log(process.ppid)"]);
console.log(JSON.stringify({ said, me: String(process.pid) }));`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.value.said).toBe(r.value.me);
  }, 20_000);

  it("Ctrl-C (SIGINT to the caller's process group) ends the waiting caller, the bounded child and its grandchild", async () => {
    const pidFile = pidPath("ctrlc-child");
    const gpidFile = pidPath("ctrlc-grandchild");
    const callLog = path.join(sandbox, `ctrlc-calls-${process.hrtime.bigint()}.log`);
    const bin = groupStandInBin({ target: { re: "^compose ps ", mode: "hang" } }, { pidFile, gpidFile, callLog });
    const moduleUrl = new URL("../src/version-ledger-capture.mjs", import.meta.url).href;
    const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
cb.__setChildBoundsForTest(20000);
m.defaultCapture("docker", ["compose", "ps", "--format", "json"], { cwd: ${JSON.stringify(sandbox)} });
process.exit(0);`;
    // detached: the caller leads a process group of its own, as a terminal job does.
    const caller = spawn(NODE, ["--input-type=module", "-e", code], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      stdio: "ignore",
      detached: true,
    });
    const exited = new Promise((resolve) => caller.on("exit", (c, sig) => resolve(sig ?? c)));
    try {
      const t0 = Date.now();
      while (!(readPid(pidFile) > 0 && readPid(gpidFile) > 0) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
      expect(readPid(gpidFile), "the child and grandchild started").toBeGreaterThan(0);
      process.kill(-caller.pid, "SIGINT");
      expect(await exited, "the caller ended by the signal").toBe("SIGINT");
      expectGone(pidFile);
      expectGone(gpidFile);
    } finally {
      killIfAlive(pidFile);
      killIfAlive(gpidFile);
      if (caller.exitCode === null && caller.signalCode === null) process.kill(caller.pid, "SIGKILL");
    }
  }, 30_000);
});

describe("child-bound: class exit-answers the call ends when the child exits; a worker that holds no pipe is left alone", () => {
  it("src/preview.mjs runSpawn: a child that starts a background worker and exits 0 answers at once, untimed-out", () => {
    const pidFile = pidPath("worker-child");
    const gpidFile = pidPath("worker");
    const callLog = path.join(sandbox, `worker-calls-${process.hrtime.bigint()}.log`);
    const bin = groupStandInBin({ target: { re: "^ps$", mode: "answer-with-worker", out: "ok\n", exit: 0 } }, { pidFile, gpidFile, callLog });
    try {
      const r = runEntry(
        "preview.mjs",
        `const r = m.defaultDeps({ registryPath: dir + "/previews.json" }).runDocker(["ps"]);
return { status: r.status, timedOut: r.timedOut, error: r.error ? String(r.error.code ?? r.error.message) : null, stdout: r.stdout };`,
        bin,
        3_000,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.value.v).toEqual({ status: 0, timedOut: false, error: null, stdout: "ok\n" });
      expect(r.value.ms, "answered at the child's exit, not at the 3 s bound").toBeLessThan(2_500);
      expect(readPid(gpidFile), "the worker wrote its pid").toBeGreaterThan(0);
      expect(isAlive(readPid(gpidFile)), "the worker is left running, as before").toBe(true);
    } finally {
      killIfAlive(gpidFile);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Only a whole exit status is read; the command's result and its terminal
// signals are its own
// ---------------------------------------------------------------------------

describe("child-bound: class exit-status only a whole, non-negative exit status is read", () => {
  const result = (status) => ({ status, signal: null, error: null, stdout: "", stderr: "" });

  it("childResultRefused refuses NaN, a fraction, an infinity and a negative status, and reads a whole one", async () => {
    const { childResultRefused } = await loadLeaf();
    for (const status of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "0", null, undefined]) {
      expect(childResultRefused(result(status)), `status ${String(status)} is refused`).toBe(true);
    }
    for (const status of [0, 1, 255]) {
      expect(childResultRefused(result(status)), `status ${status} is read`).toBe(false);
    }
  });

  it("src/recreate-preflight.mjs makeInspectVolumeThreeWay: 'no such volume' is absent only from docker's own exit 1", async () => {
    const m = await import(new URL("../src/recreate-preflight.mjs", import.meta.url).href);
    const inspect = (status) =>
      m
        .buildDeploymentPreflight({
          slug: null,
          targetDir: sandbox,
          spawn: () => ({ ...result(status), stderr: "Error: No such volume: cinatra_pgdata\n" }),
        })
        .transport.inspectVolumeStatus("cinatra_pgdata");
    for (const status of [Number.NaN, 1.5, 23, 0]) {
      expect(inspect(status), `status ${String(status)} with "no such volume"`).toEqual({ status: "error", row: null });
    }
    expect(inspect(1)).toEqual({ status: "absent", row: null });
  });
});

describe("child-bound: class own-result the result is the command's own, whatever Node startup options reach the call", () => {
  it("readChild of a command that exits 3 reads exit 3 when NODE_OPTIONS preloads a module that exits 0", () => {
    const preload = script(`preload-exits-0-${process.hrtime.bigint()}.cjs`, "process.exit(0);\n");
    const r = harness(`const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.readChild("/bin/sh", ["-c", "exit 3"], { env: { ...process.env, NODE_OPTIONS: "--require " + ${JSON.stringify(preload)} } });
console.log(JSON.stringify({ ok: r.ok, status: r.status, reason: r.reason }));`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.value).toEqual({ ok: false, status: 3, reason: "sh exited 3" });
  }, 20_000);
});

describe("child-bound: class job-control a Ctrl-C or a Ctrl-Z of the caller's process group reaches the bounded command itself", () => {
  /** A bin dir holding a stand-in `docker` that writes its pid and appends the
   *  name of each SIGINT or SIGTSTP it receives to `markFile`; at a SIGINT it
   *  then exits 130, as a command that cancels its work does. */
  function signalStandInBin(pidFile, markFile) {
    const dir = mkdtempSync(path.join(sandbox, "sbin-"));
    const body = `#!${NODE}
if (process.argv[2] === "--warm") process.exit(0);
const fs = require("fs");
const mark = (signal) => fs.appendFileSync(${JSON.stringify(markFile)}, signal + "\\n");
process.on("SIGINT", () => { mark("SIGINT"); process.exit(130); });
process.on("SIGTSTP", () => mark("SIGTSTP"));
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`;
    const p = path.join(dir, "docker");
    writeFileSync(p, body);
    chmodSync(p, 0o755);
    warm(p);
    return dir;
  }

  for (const [signal, what] of [
    ["SIGINT", "Ctrl-C: the command's own SIGINT handler runs, so a long build can cancel its work"],
    ["SIGTSTP", "Ctrl-Z: the command receives the stop signal of the job, as the caller does"],
  ]) {
    it(`${signal} to the caller's process group reaches the bounded command (${what})`, async () => {
      const pidFile = pidPath(`job-${signal}`);
      const markFile = path.join(sandbox, `job-${signal}-${process.hrtime.bigint()}.mark`);
      const bin = signalStandInBin(pidFile, markFile);
      const moduleUrl = new URL("../src/version-ledger-capture.mjs", import.meta.url).href;
      const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
cb.__setChildBoundsForTest(20000);
m.defaultCapture("docker", ["compose", "ps", "--format", "json"], { cwd: ${JSON.stringify(sandbox)} });
process.exit(0);`;
      // detached: the caller leads a process group of its own, as a terminal job does.
      const caller = spawn(NODE, ["--input-type=module", "-e", code], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: "ignore",
        detached: true,
      });
      try {
        const t0 = Date.now();
        while (!(readPid(pidFile) > 0) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
        expect(readPid(pidFile), "the command started").toBeGreaterThan(0);
        process.kill(-caller.pid, signal);
        const t1 = Date.now();
        while (!fileLines(markFile).includes(signal) && Date.now() - t1 < 3_000) await new Promise((r) => setTimeout(r, 50));
        expect(fileLines(markFile), `the command received ${signal}`).toContain(signal);
        if (signal === "SIGINT") expectGone(pidFile);
      } finally {
        killIfAlive(pidFile);
        try {
          process.kill(-caller.pid, "SIGKILL");
        } catch {
          // the caller's group is gone
        }
      }
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// The command's whole process group ends with the wait (POSIX, Node's spawnSync)
// ---------------------------------------------------------------------------
//
// Off win32, spawnBounded runs the command below src/child-bound-watchdog.mjs,
// in a process group of its own. The watchdog SIGKILLs that group at the bound,
// at SIGINT, SIGTERM or SIGHUP, and when the caller it was given is no longer
// its parent. It refuses to start the command when that is so from the start.

const WATCHDOG = fileURLToPath(new URL("../src/child-bound-watchdog.mjs", import.meta.url));

/** The watchdog's fd-3 note in a spawnSync result, or null. */
function noteOf(r) {
  try {
    return JSON.parse(String(r.output?.[3] ?? ""));
  } catch {
    return null;
  }
}

describe("child-bound: class tree-ends the command's whole process group ends at the bound", () => {
  for (const row of SITE_ROWS) {
    it(`${row.site}: a grandchild on the pipes is gone with the child when the bound ends the call`, () => {
      const pidFile = pidPath("tree-ends");
      const gpidFile = pidPath("tree-ends-grandchild");
      const callLog = path.join(sandbox, `tcalls-${process.hrtime.bigint()}.log`);
      const bin = groupStandInBin({ answers: row.answers, target: { re: row.hang, mode: "hang" } }, { pidFile, gpidFile, callLog });
      const r = runEntry(row.module, row.entry, bin);
      expect(r.value?.ms ?? Infinity, `the call ends within the bound plus 3 s (harness ${r.signal ?? r.status}): ${r.stderr}`).toBeLessThan(GROUP_BOUND_MS + 3_000);
      expect(r.status, r.stderr).toBe(0);
      expect(r.value.v).toEqual(row.expected);
      expectGone(pidFile);
      expectGone(gpidFile);
    }, 30_000);
  }
});

describe("child-bound: class caller-gone the command's group ends when the waiting caller dies", () => {
  for (const signal of ["SIGKILL", "SIGTERM"]) {
    it(`${signal} to the caller's pid alone ends the bounded child and its grandchild`, async () => {
      const pidFile = pidPath(`gone-${signal}`);
      const gpidFile = pidPath(`gone-${signal}-grandchild`);
      const callLog = path.join(sandbox, `gone-calls-${process.hrtime.bigint()}.log`);
      const bin = groupStandInBin({ target: { re: "^compose ps ", mode: "hang" } }, { pidFile, gpidFile, callLog });
      const moduleUrl = new URL("../src/version-ledger-capture.mjs", import.meta.url).href;
      const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
cb.__setChildBoundsForTest(20000);
m.defaultCapture("docker", ["compose", "ps", "--format", "json"], { cwd: ${JSON.stringify(sandbox)} });
process.exit(0);`;
      const caller = spawn(NODE, ["--input-type=module", "-e", code], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
        stdio: "ignore",
        detached: true,
      });
      const exited = new Promise((resolve) => caller.on("exit", (c, sig) => resolve(sig ?? c)));
      try {
        const t0 = Date.now();
        while (!(readPid(pidFile) > 0 && readPid(gpidFile) > 0) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
        expect(readPid(gpidFile), "the child and grandchild started").toBeGreaterThan(0);
        process.kill(caller.pid, signal);
        expect(await exited, "the caller ended by the signal").toBe(signal);
        expectGone(pidFile);
        expectGone(gpidFile);
      } finally {
        killIfAlive(pidFile);
        killIfAlive(gpidFile);
        if (caller.exitCode === null && caller.signalCode === null) process.kill(caller.pid, "SIGKILL");
      }
    }, 30_000);
  }

  it("the watchdog starts nothing when its parent is not the caller it was given, and starts the command when it is", () => {
    const refusedFile = pidPath("watchdog-refused");
    const startedFile = pidPath("watchdog-started");
    const writePid = "require('fs').writeFileSync(process.argv[1], String(process.pid))";
    const opts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 15_000, killSignal: "SIGKILL" };
    const refused = spawnSync(NODE, [WATCHDOG, String(process.ppid), NODE, "-e", writePid, refusedFile], opts);
    expect(noteOf(refused), refused.stderr).toEqual({ error: { code: "ECALLERGONE" } });
    expect(refused.status).toBe(1);
    pause(300);
    expect(readPid(refusedFile), "the command was never started").toBe(0);
    const ran = spawnSync(NODE, [WATCHDOG, String(process.pid), NODE, "-e", writePid, startedFile], opts);
    expect(ran.status, ran.stderr).toBe(0);
    expect(noteOf(ran)).toEqual({ pid: readPid(startedFile) });
  }, 30_000);
});

describe("child-bound: class result-is-the-command's the result under the watchdog reads as the command's own", () => {
  it("stdout, stderr, the exit status and the pid are the command's", async () => {
    const cb = await loadLeaf();
    const body = "process.stdout.write(process.pid + '\\n' + 'x'.repeat(300000)); process.stderr.write('e'); process.exitCode = 3";
    const r = cb.spawnBounded(spawnSync, NODE, ["-e", body], { encoding: "utf8" }, 15_000);
    const [pidLine, rest] = r.stdout.split("\n");
    expect({ status: r.status, signal: r.signal, error: r.error ?? null, stderr: r.stderr, rest: rest.length, outputs: r.output.length }).toEqual({
      status: 3,
      signal: null,
      error: null,
      stderr: "e",
      rest: 300000,
      outputs: 3,
    });
    expect(r.pid).toBe(Number(pidLine));
  }, 30_000);

  it("output a grandchild writes to the pipes after the command's exit is in the result, as spawnSync waits for them", async () => {
    const cb = await loadLeaf();
    const late = "setTimeout(() => process.stdout.write('late\\n'), 300)";
    // unref: the command exits right after "first", while the grandchild still
    // holds the pipes it inherited; only a wait for those pipes keeps "late".
    const body = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(late)}], { stdio: ['ignore', 'inherit', 'inherit'] }).unref(); process.stdout.write('first\\n')`;
    const r = cb.spawnBounded(spawnSync, NODE, ["-e", body], { encoding: "utf8" }, 15_000);
    expect({ status: r.status, error: r.error ?? null, stdout: r.stdout }).toEqual({ status: 0, error: null, stdout: "first\nlate\n" });
  }, 30_000);

  it("a command that cannot be started is a spawn error with its code and no status", async () => {
    const cb = await loadLeaf();
    const missing = path.join(sandbox, "no-such-command");
    const r = cb.spawnBounded(spawnSync, missing, ["x"], { encoding: "utf8" }, 15_000);
    expect({ status: r.status, code: r.error?.code ?? null, path: r.error?.path ?? null }).toEqual({ status: null, code: "ENOENT", path: missing });
  }, 30_000);
});
