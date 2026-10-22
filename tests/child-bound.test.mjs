// The shared child-wait leaf (`src/child-bound.mjs`) and its process-group
// supervisor, plus a source scan that holds every child wait in `src/` to a
// hard bound.
//
// The children here are real processes: the running node binary, or a small
// stand-in script. A never-exiting stand-in writes its pid and ignores SIGTERM,
// so only a SIGKILL stops it; every case that starts one checks that it, and
// everything it started, is gone afterwards, and kills any survivor.
//
// The leaf is loaded per case (a dynamic import), so each case reports its own
// failure on a tree that does not have it yet.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE = process.execPath;
const LEAF_URL = new URL("../src/child-bound.mjs", import.meta.url).href;
const INSTALL_URL = new URL("../src/install.mjs", import.meta.url).href;
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const loadLeaf = () => import(LEAF_URL);

/** A child that writes its pid, ignores SIGTERM and never exits. Passed with
 *  `-e` so its command line names it (the stray-process check reads that). */
const NEVER_EXITS =
  "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

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

/** A stand-in that starts a never-exiting grandchild (pid file argv[2]), waits
 *  until it is up, writes its own pid (argv[4]) and then, by mode (argv[5]):
 *  blocks in its own spawnSync of a second never-exiting child (argv[3]),
 *  exits 3, or exits 0. */
function treeScript() {
  return script(
    "tree.cjs",
    `const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const [gcPid, blockPid, selfPid, mode] = process.argv.slice(2);
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, gcPid], { stdio: "ignore" });
const t0 = Date.now();
while (!fs.existsSync(gcPid) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(selfPid, String(process.pid));
if (mode === "exit3") process.exit(3);
if (mode === "exit0") process.exit(0);
spawnSync(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, blockPid], { stdio: "ignore" });
`,
  );
}

/** Run `code` (an ES module body) in a fresh node process; its last stdout
 *  line is parsed as JSON. */
function harness(code, { env = process.env, timeout = 30_000 } = {}) {
  const r = spawnSync(NODE, ["--input-type=module", "-e", code], { encoding: "utf8", env, timeout, killSignal: "SIGKILL" });
  const lines = String(r.stdout ?? "").trim().split("\n");
  let value = null;
  try {
    value = JSON.parse(lines[lines.length - 1]);
  } catch {
    value = null;
  }
  return { status: r.status, value, stderr: r.stderr };
}

/** `base` with `preload` added to NODE_OPTIONS, so every node process of the
 *  run loads it first. */
function withPreload(preload, base = process.env) {
  return { ...base, NODE_OPTIONS: `${base.NODE_OPTIONS ? `${base.NODE_OPTIONS} ` : ""}--import=${pathToFileURL(preload).href}` };
}

/** An environment whose supervisor writes its own pid to `file` before its
 *  code runs (a preload that acts only in the supervisor). */
function supervisorPidEnv(file, base = process.env) {
  const preload = script(
    `supervisor-pid-${process.hrtime.bigint()}.mjs`,
    `import { writeFileSync } from "node:fs";
if (String(process.argv[1] ?? "").endsWith("/child-group-supervisor.mjs")) writeFileSync(${JSON.stringify(file)}, String(process.pid));
`,
  );
  return withPreload(preload, base);
}

/** An environment in which every node process of the run appends its pid to
 *  `file` before its code runs. */
function pidLogEnv(file, base = process.env) {
  const preload = script(
    `pid-log-${process.hrtime.bigint()}.mjs`,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(file)}, process.pid + "\\n");
`,
  );
  return withPreload(preload, base);
}

function fileLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The leaf's API
// ---------------------------------------------------------------------------

describe("child-bound: the helpers are the install road's own text", () => {
  const SHARED = ["boundedOptions", "describeBound", "childTimedOut", "childSubcommand", "childTimeoutError", "advisoryRead"];

  function functionText(src, name) {
    const m = new RegExp(`\\n(?:export )?(function ${name}\\([\\s\\S]*?\\n\\})\\n`).exec(src);
    return m ? m[1] : null;
  }

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

  it("imports only node:path, node:child_process and node:url", async () => {
    await loadLeaf();
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const specifiers = [...leaf.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(specifiers).toEqual(["node:child_process", "node:path", "node:url"]);
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
// Process-group supervision
// ---------------------------------------------------------------------------

describe("spawnGroupBoundedSync: an expired bound stops the whole tree", () => {
  it("plain spawnSync with boundedOptions leaves the grandchildren behind (why the supervisor exists)", async () => {
    const cb = await loadLeaf();
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("plain-gc"), pidPath("plain-blocker"), pidPath("plain-self")];
    const r = spawnSync(NODE, [tree, gc, blocker, self, "block"], cb.boundedOptions({ stdio: "ignore" }, 1_500));
    expect(cb.childTimedOut(r)).toBe(true);
    expectGone(self);
    expect(isAlive(readPid(gc))).toBe(true);
    killIfAlive(gc);
    killIfAlive(blocker);
  });

  it("orphan case: the child, its grandchild and the child it blocks on are all gone at the bound", async () => {
    const cb = await loadLeaf();
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("group-gc"), pidPath("group-blocker"), pidPath("group-self")];
    const t0 = Date.now();
    const r = cb.spawnGroupBoundedSync(NODE, [tree, gc, blocker, self, "block"], { timeoutMs: 1_500, stdio: "ignore" });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.error?.code).toBe("ETIMEDOUT");
    expect(cb.childTimedOut(r)).toBe(true);
    expect(r.status).toBeNull();
    expect(r.signal).toBe("SIGKILL");
    expectGone(self);
    expectGone(gc);
    expectGone(blocker);
  });

  it("a non-zero exit takes the members it left behind with it", async () => {
    const cb = await loadLeaf();
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("exit3-gc"), pidPath("exit3-blocker"), pidPath("exit3-self")];
    const r = cb.spawnGroupBoundedSync(NODE, [tree, gc, blocker, self, "exit3"], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.error).toBeFalsy();
    expect(r.status).toBe(3);
    expect(r.signal).toBeNull();
    expectGone(self);
    expectGone(gc);
  });

  it("a status-0 exit passes its status and output through and takes the members it left behind with it", async () => {
    const cb = await loadLeaf();
    const ok = cb.spawnGroupBoundedSync(NODE, ["-e", "console.log('hello'); console.error('note')"], { timeoutMs: 15_000, encoding: "utf8" });
    expect(ok.error).toBeFalsy();
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe("hello");
    expect(ok.stderr.trim()).toBe("note");
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("exit0-gc"), pidPath("exit0-blocker"), pidPath("exit0-self")];
    const r = cb.spawnGroupBoundedSync(NODE, [tree, gc, blocker, self, "exit0"], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.error).toBeFalsy();
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
    expectGone(self);
    expectGone(gc);
  });

  it("a status-0 exit leaves a child started detached, in a session of its own, running", async () => {
    const cb = await loadLeaf();
    const [own, member, self] = [pidPath("exit0-own-session"), pidPath("exit0-member"), pidPath("exit0-starter")];
    const starter = script(
      "exit0-detached.cjs",
      `const { spawn } = require("child_process");
const fs = require("fs");
const [ownPid, memberPid, selfPid] = process.argv.slice(2);
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ownPid], { detached: true, stdio: "ignore" }).unref();
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, memberPid], { stdio: "ignore" });
const t0 = Date.now();
while (!(fs.existsSync(ownPid) && fs.existsSync(memberPid)) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(selfPid, String(process.pid));
process.exit(0);
`,
    );
    const r = cb.spawnGroupBoundedSync(NODE, [starter, own, member, self], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.error).toBeFalsy();
    expect(r.status).toBe(0);
    expectGone(self);
    expectGone(member);
    pause(300);
    expect(isAlive(readPid(own)), "the own-session child is still running").toBe(true);
    killIfAlive(own);
  });

  it("a child that cannot be spawned is a spawn error, not a status", async () => {
    const cb = await loadLeaf();
    const r = cb.spawnGroupBoundedSync(path.join(sandbox, "does-not-exist"), ["x"], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.status).toBeNull();
    expect(r.error?.code).toBe("ENOENT");
  });

  it("takes spawnSync's own `timeout` option as its bound", async () => {
    const cb = await loadLeaf();
    const pidFile = pidPath("timeout-option");
    const r = cb.spawnGroupBoundedSync(NODE, ["-e", NEVER_EXITS, pidFile], cb.boundedOptions({ stdio: "ignore" }, 1_500));
    expect(cb.childTimedOut(r)).toBe(true);
    expectGone(pidFile);
  });

  it("SIGTERM sent to the supervisor reaches the child", async () => {
    const pidFile = pidPath("forward-child");
    const sup = pidPath("forward-sup");
    const mark = path.join(sandbox, `forward-mark-${process.hrtime.bigint()}`);
    const child = script(
      "forward.cjs",
      `const fs = require("fs");
fs.writeFileSync(process.argv[2], process.pid + " " + process.ppid);
process.on("SIGTERM", () => { fs.writeFileSync(process.argv[3], "term"); process.exit(7); });
setInterval(() => {}, 1000);
`,
    );
    const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(pidFile)}, ${JSON.stringify(mark)}], { timeoutMs: 20000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }));`;
    const proc = spawnAsync(NODE, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], env: supervisorPidEnv(sup) });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => proc.on("exit", resolve));
    const t0 = Date.now();
    while (!existsSync(pidFile) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const supervisorPid = readPid(sup);
    expect(supervisorPid).toBeGreaterThan(0);
    expect(supervisorPid).not.toBe(proc.pid);
    process.kill(supervisorPid, "SIGTERM");
    await exited;
    expect(readFileSync(mark, "utf8")).toBe("term");
    expect(JSON.parse(out.trim().split("\n").pop())).toEqual({ status: 7, signal: null, error: null });
    expectGone(pidFile);
  }, 30_000);

  it("a SIGTERM that reaches the supervisor while it starts the child still stops the group after the grace: no orphan", async () => {
    const [spawned, gc, blocker, self] = [pidPath("window-child"), pidPath("window-gc"), pidPath("window-blocker"), pidPath("window-self")];
    // Preloaded into every node process of the run, it acts only in the
    // supervisor: inside the supervisor's own start of the child, once the
    // child is up (it ignores SIGTERM and has started its grandchild), it
    // sends the supervisor SIGTERM, before the supervisor's start returns.
    const preload = script(
      "signal-in-start.mjs",
      `import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
if (String(process.argv[1] ?? "").endsWith("/child-group-supervisor.mjs")) {
  const cp = createRequire(import.meta.url)("node:child_process");
  const real = cp.spawn;
  cp.spawn = function (...a) {
    const c = real.apply(this, a);
    writeFileSync(${JSON.stringify(spawned)}, String(c.pid));
    const t0 = Date.now();
    while (!existsSync(${JSON.stringify(self)}) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    process.kill(process.pid, "SIGTERM");
    return c;
  };
  syncBuiltinESMExports();
}
`,
    );
    const tree = treeScript();
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import=${pathToFileURL(preload).href}` };
    delete env.CINATRA_GROUP_SUPERVISED;
    delete env.CINATRA_GROUP_SUPERVISOR_PID;
    const t0 = Date.now();
    const r = harness(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(tree)}, ${JSON.stringify(gc)}, ${JSON.stringify(blocker)}, ${JSON.stringify(self)}, "block"], { timeoutMs: 20000, graceMs: 2000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }));`,
      { env },
    );
    expect(r.status, r.stderr).toBe(0);
    expectGone(spawned);
    expectGone(gc);
    // The child it blocks on may die of the forwarded SIGTERM before it is up;
    // either way it is not running.
    expect(isAlive(readPid(blocker)), "the child it blocks on is not running").toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.value).toEqual({ status: null, signal: "SIGKILL", error: null });
  }, 30_000);

  /** Start `code` (an ES module body) as a caller process of its own, which a
   *  case can kill; `exited` settles when it is gone. */
  function startCaller(code, env = process.env, { detached = false } = {}) {
    const proc = spawnAsync(NODE, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"], env, detached });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => proc.on("exit", resolve));
    return { proc, exited, out: () => out };
  }

  async function waitForFile(file, ms = 10_000) {
    const t0 = Date.now();
    while (!existsSync(file) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(file), `${path.basename(file)} was written`).toBe(true);
  }

  it("a child that traps the forwarded SIGTERM and exits 0 still loses its SIGTERM-ignoring descendant at the grace", async () => {
    const [desc, self, sup] = [pidPath("trap0-desc"), pidPath("trap0-self"), pidPath("trap0-sup")];
    const child = script(
      "trap0.cjs",
      `const { spawn } = require("child_process");
const fs = require("fs");
const [descPid, selfPid] = process.argv.slice(2);
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, descPid], { stdio: "ignore" });
const t0 = Date.now();
while (!fs.existsSync(descPid) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
process.on("SIGTERM", () => process.exit(0));
fs.writeFileSync(selfPid, process.pid + " " + process.ppid);
setInterval(() => {}, 1000);
`,
    );
    const caller = startCaller(`const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(desc)}, ${JSON.stringify(self)}], { timeoutMs: 20000, graceMs: 1500, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }));`, supervisorPidEnv(sup));
    await waitForFile(self);
    const supervisorPid = readPid(sup);
    expect(supervisorPid).toBeGreaterThan(0);
    expect(supervisorPid).not.toBe(caller.proc.pid);
    process.kill(supervisorPid, "SIGTERM");
    await caller.exited;
    expect(JSON.parse(caller.out().trim().split("\n").pop())).toEqual({ status: 0, signal: null, error: null });
    expectGone(self);
    expectGone(desc);
  }, 30_000);

  it("a child that traps the forwarded SIGTERM and exits 0 with nothing left in its group ends the run at once, before the grace", async () => {
    const [self, sup] = [pidPath("trapclean-self"), pidPath("trapclean-sup")];
    const child = script(
      "trap-clean.cjs",
      `const fs = require("fs");
process.on("SIGTERM", () => process.exit(0));
fs.writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
    );
    const caller = startCaller(`const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(self)}], { timeoutMs: 30000, graceMs: 20000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }));`, supervisorPidEnv(sup));
    await waitForFile(self);
    const t0 = Date.now();
    process.kill(readPid(sup), "SIGTERM");
    await caller.exited;
    expect(Date.now() - t0, "ended well before the 20 s grace").toBeLessThan(5_000);
    expect(JSON.parse(caller.out().trim().split("\n").pop())).toEqual({ status: 0, signal: null, error: null });
    expectGone(self);
  }, 40_000);

  // The group-signal probe: the caller runs as a process group of its own and
  // traps the signal (as a CLI with its own cleanup does), so only a
  // supervisor that shares the caller's group can pass the signal on while the
  // caller is blocked in its synchronous wait.
  for (const [sig, times] of [
    ["SIGTERM", 1],
    ["SIGINT", 1],
    ["SIGHUP", 1],
    ["SIGTERM", 2],
  ]) {
    it(`${sig}${times > 1 ? `, sent ${times} times,` : ""} sent to the caller's process group reaches the child each time, also while the caller traps it`, async () => {
      const self = pidPath(`group-${sig}-${times}-self`);
      const mark = path.join(sandbox, `group-${sig}-${times}-mark-${process.hrtime.bigint()}`);
      const child = script(
        "group-signal.cjs",
        `const fs = require("fs");
const [selfPid, markFile, sig, times] = process.argv.slice(2);
let n = 0;
process.on(sig, () => {
  n += 1;
  fs.appendFileSync(markFile, sig + " " + n + "\\n");
  if (n >= Number(times)) process.exit(7);
});
fs.writeFileSync(selfPid, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const caller = startCaller(
        `process.on(${JSON.stringify(sig)}, () => {});
const cb = await import(${JSON.stringify(LEAF_URL)});
const t0 = Date.now();
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(self)}, ${JSON.stringify(mark)}, ${JSON.stringify(sig)}, "${times}"], { timeoutMs: 10000, graceMs: 5000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null, ms: Date.now() - t0 }));
process.exit(0);`,
        process.env,
        { detached: true },
      );
      try {
        await waitForFile(self);
        for (let i = 1; i <= times; i += 1) {
          process.kill(-caller.proc.pid, sig);
          const t0 = Date.now();
          while (fileLines(mark).length < i && Date.now() - t0 < 4_000) await new Promise((r) => setTimeout(r, 20));
          expect(fileLines(mark), `the child saw ${sig} number ${i}`).toEqual(Array.from({ length: i }, (_, k) => `${sig} ${k + 1}`));
        }
        await caller.exited;
        const out = JSON.parse(caller.out().trim().split("\n").pop());
        expect({ status: out.status, signal: out.signal, error: out.error }).toEqual({ status: 7, signal: null, error: null });
        expect(out.ms, "ended by the signal, not by the bound").toBeLessThan(8_000);
        expectGone(self);
      } finally {
        killIfAlive(self);
        try {
          process.kill(-caller.proc.pid, "SIGKILL");
        } catch {
          // the caller's group is gone
        }
      }
    }, 30_000);
  }

  // The kill window: a deterministic SIGKILL right after a spawn, before the
  // spawning process can report what it started. "supervisor" kills the
  // supervisor right after its own spawn; "starter" kills whichever process
  // starts the real child, right after that spawn. Every node process of the
  // run logs its pid, so the case sees anything left running.
  for (const [where, label] of [
    ["supervisor", "the supervisor right after its spawn, before it reports"],
    ["starter", "the starter right after its spawn, before it reports"],
    ["reported", "the supervisor right after it reported the group"],
  ]) {
    it(`a SIGKILL of ${label}, leaves no process of the run behind`, async () => {
      const tree = treeScript();
      const [gc, blocker, self] = [pidPath(`kill-${where}-gc`), pidPath(`kill-${where}-blocker`), pidPath(`kill-${where}-self`)];
      const log = path.join(sandbox, `kill-${where}-pids-${process.hrtime.bigint()}`);
      const preload = script(
        `kill-after-spawn-${where}.mjs`,
        `import { createRequire, syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
const where = ${JSON.stringify(where)};
const inSupervisor = String(process.argv[1] ?? "").endsWith("/child-group-supervisor.mjs");
const waitThenDie = () => {
  const t0 = Date.now();
  while (!existsSync(${JSON.stringify(self)}) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  process.kill(process.pid, "SIGKILL");
};
if (where === "reported" && inSupervisor) {
  const fs = createRequire(import.meta.url)("node:fs");
  const realWrite = fs.writeSync;
  fs.writeSync = function (...a) {
    const r = realWrite.apply(this, a);
    if (a[0] === 3 && String(a[1]).includes('"group"')) waitThenDie();
    return r;
  };
  syncBuiltinESMExports();
} else if (where === "starter" || inSupervisor) {
  const cp = createRequire(import.meta.url)("node:child_process");
  const real = cp.spawn;
  let first = true;
  cp.spawn = function (...a) {
    const c = real.apply(this, a);
    const startsTree = Array.isArray(a[1]) && a[1][0] === ${JSON.stringify(tree)};
    const act = where === "supervisor" ? first : startsTree;
    first = false;
    if (act) waitThenDie();
    return c;
  };
  syncBuiltinESMExports();
}
`,
      );
      const env = pidLogEnv(log, withPreload(preload));
      try {
        const r = harness(
          `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(tree)}, ${JSON.stringify(gc)}, ${JSON.stringify(blocker)}, ${JSON.stringify(self)}, "block"], { timeoutMs: 20000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, error: r.error ? r.error.code : null }));`,
          { env, timeout: 40_000 },
        );
        expect(r.status, r.stderr).toBe(0);
        expect(r.value).toEqual({ status: null, error: "CHILD_SUPERVISOR_FAILED" });
        expectGone(self, 5000);
        expectGone(gc, 5000);
        pause(500);
        expect(isAlive(readPid(blocker)), "the child it blocks on is not running").toBe(false);
        const left = fileLines(log).map(Number).filter((pid) => isAlive(pid));
        expect(left, "no node process of the run is left").toEqual([]);
      } finally {
        for (const f of [self, gc, blocker]) killIfAlive(f);
        for (const pid of fileLines(log).map(Number)) {
          if (isAlive(pid)) process.kill(pid, "SIGKILL");
        }
      }
    }, 60_000);
  }

  it("a caller killed while the child runs takes the whole group with it, even when the child then exits 0", async () => {
    const [desc, self, sup, parent] = [pidPath("callerdeath-desc"), pidPath("callerdeath-self"), pidPath("callerdeath-sup"), pidPath("callerdeath-parent")];
    const go = path.join(sandbox, `callerdeath-go-${process.hrtime.bigint()}`);
    const child = script(
      "exit0-on-go.cjs",
      `const { spawn } = require("child_process");
const fs = require("fs");
const [descPid, selfPid, goFile] = process.argv.slice(2);
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, descPid], { stdio: "ignore" });
const t0 = Date.now();
while (!fs.existsSync(descPid) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.writeFileSync(selfPid, process.pid + " " + process.ppid);
setInterval(() => { if (fs.existsSync(goFile)) process.exit(0); }, 5);
`,
    );
    const caller = startCaller(`const cb = await import(${JSON.stringify(LEAF_URL)});
cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(desc)}, ${JSON.stringify(self)}, ${JSON.stringify(go)}], { timeoutMs: 20000, stdio: "ignore" });`, supervisorPidEnv(sup));
    await waitForFile(self);
    const supervisorPid = readPid(sup);
    expect(supervisorPid).toBeGreaterThan(0);
    expect(supervisorPid).not.toBe(caller.proc.pid);
    // The child's own parent (the supervisor, or a process it started).
    const [, childParent] = readFileSync(self, "utf8").trim().split(" ").map(Number);
    writeFileSync(parent, String(childParent));
    process.kill(caller.proc.pid, "SIGKILL");
    await caller.exited;
    // The child exits 0 at once, well before any once-a-second check.
    writeFileSync(go, "go");
    expectGone(desc);
    expectGone(self);
    expectGone(sup);
    expectGone(parent);
  }, 30_000);

  it("a caller that dies before the supervisor is up is still noticed: nothing the supervisor would start survives", async () => {
    const [sup, gc, blocker, self] = [pidPath("early-sup"), pidPath("early-gc"), pidPath("early-blocker"), pidPath("early-self")];
    const go = path.join(sandbox, `early-go-${process.hrtime.bigint()}`);
    // Preloaded into every node process of the run, it acts only in the
    // supervisor: it holds the supervisor before its own code runs until the
    // case has killed the caller.
    const preload = script(
      "hold-supervisor.mjs",
      `import { existsSync, writeFileSync } from "node:fs";
if (String(process.argv[1] ?? "").endsWith("/child-group-supervisor.mjs")) {
  writeFileSync(${JSON.stringify(sup)}, process.pid + " " + process.ppid);
  const t0 = Date.now();
  while (!existsSync(${JSON.stringify(go)}) && Date.now() - t0 < 10000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`,
    );
    const tree = treeScript();
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import=${pathToFileURL(preload).href}` };
    delete env.CINATRA_GROUP_SUPERVISED;
    const caller = startCaller(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(tree)}, ${JSON.stringify(gc)}, ${JSON.stringify(blocker)}, ${JSON.stringify(self)}, "block"], { timeoutMs: 20000, stdio: "ignore" });`,
      env,
    );
    await waitForFile(sup);
    const [, supervisorParent] = readFileSync(sup, "utf8").trim().split(" ").map(Number);
    expect(supervisorParent).toBe(caller.proc.pid);
    process.kill(caller.proc.pid, "SIGKILL");
    await caller.exited;
    writeFileSync(go, "go");
    expectGone(sup, 5000);
    pause(1500);
    for (const f of [self, gc, blocker]) expect(isAlive(readPid(f)), `${path.basename(f)} is not running`).toBe(false);
  }, 30_000);

  /** The inner call: `prefix` runs first, then a spawnGroupBoundedSync of a
   *  child that prints its parent pid. Supervision gives the child a
   *  supervisor as its parent, never this process. */
  function nestedProbe(prefix = "") {
    return `const cb = await import(${JSON.stringify(LEAF_URL)});
${prefix}
const t0 = Date.now();
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, ["-e", "console.log(process.ppid)"], { timeoutMs: 15000, encoding: "utf8" });
console.log(JSON.stringify({ self: process.pid, parentOfChild: Number(r.stdout.trim()), status: r.status, ms: Date.now() - t0 }));`;
  }

  /** A directory holding one stand-in `ps` with the given shell body. */
  function psStandIn(name, body) {
    const dir = mkdtempSync(path.join(sandbox, `${name}-`));
    writeFileSync(path.join(dir, "ps"), `#!/bin/sh\n${body}\n`);
    chmodSync(path.join(dir, "ps"), 0o755);
    return dir;
  }

  /** Run `code` as the child of a real supervisor (a real outer supervised
   *  run) and return its last stdout line, parsed. */
  async function underRealSupervisor(code, envChanges = {}) {
    const cb = await loadLeaf();
    const env = { ...process.env, ...envChanges };
    delete env.CINATRA_GROUP_SUPERVISED;
    delete env.CINATRA_GROUP_SUPERVISOR_PID;
    const r = cb.spawnGroupBoundedSync(NODE, ["--input-type=module", "-e", code], { timeoutMs: 25_000, encoding: "utf8", env });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  }

  /** The caller code of a timeout case: a spawnGroupBoundedSync of the tree
   *  that blocks, bounded at 1.5 s. */
  function blockingCall(tree, gc, blocker, self) {
    return `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(tree)}, ${JSON.stringify(gc)}, ${JSON.stringify(blocker)}, ${JSON.stringify(self)}, "block"], { timeoutMs: 1500, stdio: "ignore" });
console.log(JSON.stringify({ timedOut: cb.childTimedOut(r), status: r.status }));`;
  }

  it("nested one and two levels down inside a real supervised run, the inner call is supervised on its own and ends within its bound", async () => {
    // One level down: the supervised child itself.
    const inner = await underRealSupervisor(nestedProbe());
    expect(inner.status).toBe(0);
    expect(inner.parentOfChild, "one level down: supervised").not.toBe(inner.self);
    expect(inner.ms).toBeLessThan(10_000);
    // Two levels down: a child of the supervised child, still in its group.
    const viaChild = `const r = (await import("node:child_process")).spawnSync(${JSON.stringify(NODE)}, ["--input-type=module", "-e", ${JSON.stringify(nestedProbe())}], { encoding: "utf8" });
process.stdout.write(r.stdout); process.exit(r.status ?? 1);`;
    const innermost = await underRealSupervisor(viaChild);
    expect(innermost.status).toBe(0);
    expect(innermost.parentOfChild, "two levels down: supervised").not.toBe(innermost.self);
    expect(innermost.ms).toBeLessThan(10_000);
    // Not nested at all: a supervisor of its own.
    const env = { ...process.env };
    delete env.CINATRA_GROUP_SUPERVISED;
    delete env.CINATRA_GROUP_SUPERVISOR_PID;
    const outer = harness(nestedProbe(), { env });
    expect(outer.status, outer.stderr).toBe(0);
    expect(outer.value.status).toBe(0);
    expect(outer.value.parentOfChild).not.toBe(outer.value.self);
  }, 60_000);

  for (const [label, extra] of [
    ["the flag alone", () => ({})],
    ["the flag and a supervisor pid that is a live ancestor", () => ({ CINATRA_GROUP_SUPERVISOR_PID: String(process.pid) })],
  ]) {
    it(`${label}: an environment that claims supervision changes nothing: it supervises, and a timeout leaves no grandchild`, async () => {
      const tree = treeScript();
      const [gc, blocker, self] = [pidPath("spoof-gc"), pidPath("spoof-blocker"), pidPath("spoof-self")];
      const env = { ...process.env, CINATRA_GROUP_SUPERVISED: "1" };
      delete env.CINATRA_GROUP_SUPERVISOR_PID;
      const spoofed = harness(blockingCall(tree, gc, blocker, self), { env: { ...env, ...extra() } });
      expect(spoofed.status, spoofed.stderr).toBe(0);
      expect(spoofed.value).toEqual({ timedOut: true, status: null });
      expectGone(self);
      expectGone(gc);
      expectGone(blocker);
    }, 30_000);
  }

  it("a forged process listing changes nothing: no process table is read, it supervises, and a timeout leaves no grandchild", async () => {
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("forged-gc"), pidPath("forged-blocker"), pidPath("forged-self")];
    const marker = path.join(sandbox, `forged-ps-ran-${process.hrtime.bigint()}`);
    // The listing claims the caller (the stand-in's parent) leads a group whose
    // parent is this test process, and that this test process is a supervisor.
    const forged = psStandIn(
      "ps-forged",
      `: > ${JSON.stringify(marker)}
echo "$PPID ${process.pid} $PPID node child-group-supervisor.mjs"
echo "${process.pid} 1 ${process.pid} node child-group-supervisor.mjs"`,
    );
    const env = {
      ...process.env,
      CINATRA_GROUP_SUPERVISED: "1",
      CINATRA_GROUP_SUPERVISOR_PID: String(process.pid),
      PATH: `${forged}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    const r = harness(blockingCall(tree, gc, blocker, self), { env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.value).toEqual({ timedOut: true, status: null });
    expectGone(self);
    expectGone(gc);
    expectGone(blocker);
    expect(existsSync(marker), "no process listing was read").toBe(false);
  }, 30_000);

  it("a wrapper that looks like a supervisor and starts the caller as a group leader changes nothing: it supervises, and a timeout leaves no grandchild", async () => {
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("wrapper-gc"), pidPath("wrapper-blocker"), pidPath("wrapper-self")];
    // Its command line carries the supervisor's file name, and it starts the
    // caller detached (a group leader) with its own pid as the supervisor pid.
    const wrapper = script(
      "wrapper.cjs",
      `const { spawnSync } = require("child_process");
const r = spawnSync(process.execPath, ["--input-type=module", "-e", process.argv[3]], {
  detached: true,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, CINATRA_GROUP_SUPERVISED: "1", CINATRA_GROUP_SUPERVISOR_PID: String(process.pid) },
  timeout: 20000,
  killSignal: "SIGKILL",
});
process.stdout.write(r.stdout ?? "");
process.exit(r.status ?? 1);
`,
    );
    const env = { ...process.env };
    delete env.CINATRA_GROUP_SUPERVISED;
    delete env.CINATRA_GROUP_SUPERVISOR_PID;
    const r = spawnSync(NODE, [wrapper, "child-group-supervisor.mjs", blockingCall(tree, gc, blocker, self)], {
      encoding: "utf8",
      env,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(String(r.stdout).trim().split("\n").pop())).toEqual({ timedOut: true, status: null });
    expectGone(self);
    expectGone(gc);
    expectGone(blocker);
  }, 30_000);

  for (const [label, innerPrefix, supervisorRequired] of [
    ["the inner caller has no ps on its PATH", (noPs) => `process.env.PATH = ${JSON.stringify(noPs)};`, true],
    ["the inner caller's environment is stripped of the supervision variables", () => "delete process.env.CINATRA_GROUP_SUPERVISED; delete process.env.CINATRA_GROUP_SUPERVISOR_PID;", true],
    ["honest nesting, nothing stripped", () => "", false],
  ]) {
    it(`an outer timeout with a long-lived inner child leaves no process behind (${label})`, async () => {
      const cb = await loadLeaf();
      const tree = treeScript();
      const [gc, blocker, self, innerSup] = [pidPath("outer-gc"), pidPath("outer-blocker"), pidPath("outer-self"), pidPath("outer-inner-sup")];
      const noPs = mkdtempSync(path.join(sandbox, "outer-no-ps-"));
      // Preloaded into every node process of the run, it acts only in the
      // inner supervisor (the one whose child is the tree): it writes its pid.
      const preload = script(
        "inner-supervisor-pid.mjs",
        `import { writeFileSync } from "node:fs";
if (String(process.argv[1] ?? "").endsWith("/child-group-supervisor.mjs")) {
  let payload = {};
  try { payload = JSON.parse(process.argv[2] ?? "{}"); } catch {}
  if (Array.isArray(payload.args) && payload.args[0] === ${JSON.stringify(tree)}) writeFileSync(${JSON.stringify(innerSup)}, String(process.pid));
}
`,
      );
      const inner = `${innerPrefix(noPs)}
const cb = await import(${JSON.stringify(LEAF_URL)});
cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(tree)}, ${JSON.stringify(gc)}, ${JSON.stringify(blocker)}, ${JSON.stringify(self)}, "block"], { timeoutMs: 20000, stdio: "ignore" });`;
      const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ""}--import=${pathToFileURL(preload).href}` };
      delete env.CINATRA_GROUP_SUPERVISED;
      delete env.CINATRA_GROUP_SUPERVISOR_PID;
      const r = cb.spawnGroupBoundedSync(NODE, ["--input-type=module", "-e", inner], { timeoutMs: 2_000, stdio: "ignore", env });
      expect(cb.childTimedOut(r)).toBe(true);
      expectGone(self, 5000);
      expectGone(gc, 5000);
      expectGone(blocker, 5000);
      if (supervisorRequired || readPid(innerSup) > 0) expectGone(innerSup, 5000);
    }, 30_000);
  }

  it("the supervisor stays in its caller's process group, and the child runs in a group that another process leads", async () => {
    const [self, sup] = [pidPath("own-group-self"), pidPath("own-group-sup")];
    const go = path.join(sandbox, `own-group-go-${process.hrtime.bigint()}`);
    const child = script(
      "own-group.cjs",
      `const fs = require("fs");
const [selfPid, goFile] = process.argv.slice(2);
fs.writeFileSync(selfPid, process.pid + " " + process.ppid);
setInterval(() => { if (fs.existsSync(goFile)) process.exit(0); }, 5);
`,
    );
    const leadsGroup = (pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (err) {
        return err.code === "EPERM";
      }
    };
    const caller = startCaller(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, [${JSON.stringify(child)}, ${JSON.stringify(self)}, ${JSON.stringify(go)}], { timeoutMs: 20000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status }));`,
      supervisorPidEnv(sup),
      { detached: true },
    );
    await waitForFile(self);
    const supervisorPid = readPid(sup);
    const [childPid, childParent] = readFileSync(self, "utf8").trim().split(" ").map(Number);
    const seen = { supervisor: leadsGroup(supervisorPid), parent: leadsGroup(childParent), child: leadsGroup(childPid), caller: leadsGroup(caller.proc.pid) };
    writeFileSync(go, "go");
    await caller.exited;
    expect(supervisorPid).toBeGreaterThan(0);
    expect(supervisorPid).not.toBe(caller.proc.pid);
    expect(seen.caller, "the caller leads its own group here").toBe(true);
    expect(seen.supervisor, "no process group has the supervisor's id").toBe(false);
    expect(childParent, "the child's parent is not the supervisor").not.toBe(supervisorPid);
    expect(seen.parent, "the child's parent leads a process group").toBe(true);
    expect(seen.child, "the child leads no process group of its own").toBe(false);
    expect(JSON.parse(caller.out().trim().split("\n").pop())).toEqual({ status: 0 });
    expectGone(self);
  }, 30_000);

  /** A stand-in parent: it starts `entry` (the supervisor or the anchor) with
   *  a payload naming itself as the parent and a plain file on fd 3, writes
   *  its pid and waits. */
  function standInParent() {
    return script(
      "stand-in-parent.cjs",
      `const { spawn } = require("child_process");
const fs = require("fs");
const [entry, payloadJson, parentKey, reportFile, selfPid, detached] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);
payload[parentKey] = process.pid;
const fd = fs.openSync(reportFile, "a");
spawn(process.execPath, [entry, JSON.stringify(payload)], { stdio: ["ignore", "ignore", "ignore", fd], detached: detached === "1" });
fs.writeFileSync(selfPid, String(process.pid));
setInterval(() => {}, 1000);
`,
    );
  }

  it("the supervisor reports on fd 3 when it is not a socket: a plain file gets each event and the exit status", () => {
    const reportFile = path.join(sandbox, `plain-report-${process.hrtime.bigint()}`);
    const fd = openSync(reportFile, "w");
    let r;
    try {
      const payload = JSON.stringify({ cmd: NODE, args: ["-e", "process.exit(5)"], timeoutMs: 15000, graceMs: 2000, callerPid: process.pid });
      r = spawnSync(NODE, [path.join(SRC_DIR, "child-group-supervisor.mjs"), payload], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    } finally {
      closeSync(fd);
    }
    expect(r.status, r.stderr).toBe(0);
    const events = fileLines(reportFile).map((line) => JSON.parse(line));
    expect(events.some((e) => Number(e.pid) > 0), "the child's pid was reported").toBe(true);
    expect(events[events.length - 1]).toEqual({ status: 5, signal: null });
  });

  for (const [label, entry, parentKey, detached, extra] of [
    ["the supervisor", "child-group-supervisor.mjs", "callerPid", "0", { timeoutMs: 20000, graceMs: 2000 }],
    ["the group anchor", "child-group-anchor.mjs", "supervisorPid", "1", {}],
  ]) {
    it(`${label} with a plain file on fd 3 still notices its parent's death once a second and stops the whole group`, async () => {
      const tree = treeScript();
      const [gc, blocker, self, parent] = [pidPath(`plainfd-${parentKey}-gc`), pidPath(`plainfd-${parentKey}-blocker`), pidPath(`plainfd-${parentKey}-self`), pidPath(`plainfd-${parentKey}-parent`)];
      const reportFile = path.join(sandbox, `plainfd-${parentKey}-report-${process.hrtime.bigint()}`);
      const payload = JSON.stringify({ cmd: NODE, args: [tree, gc, blocker, self, "block"], ...extra });
      const proc = spawnAsync(NODE, [standInParent(), path.join(SRC_DIR, entry), payload, parentKey, reportFile, parent, detached], { stdio: "ignore" });
      const exited = new Promise((resolve) => proc.on("exit", resolve));
      try {
        await waitForFile(self);
        await waitForFile(gc);
        expect(isAlive(readPid(gc)), "the grandchild runs").toBe(true);
        process.kill(readPid(parent), "SIGKILL");
        await exited;
        expectGone(self, 5000);
        expectGone(gc, 5000);
        pause(500);
        expect(isAlive(readPid(blocker)), "the child it blocks on is not running").toBe(false);
      } finally {
        for (const f of [self, gc, blocker, parent]) killIfAlive(f);
      }
    }, 30_000);
  }

  it("the group anchor started by a process other than the supervisor it names starts nothing", () => {
    const pidFile = pidPath("anchor-wrong-parent");
    const reportFile = path.join(sandbox, `anchor-wrong-parent-report-${process.hrtime.bigint()}`);
    const fd = openSync(reportFile, "w");
    let r;
    try {
      // It names this test's own parent, not this test, as its supervisor.
      const payload = JSON.stringify({ cmd: NODE, args: ["-e", NEVER_EXITS, pidFile], supervisorPid: process.ppid });
      r = spawnSync(NODE, [path.join(SRC_DIR, "child-group-anchor.mjs"), payload], { stdio: ["ignore", "ignore", "pipe", fd], detached: true, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    } finally {
      closeSync(fd);
    }
    pause(500);
    expect(r.error, "it ended on its own, well before the bound").toBeFalsy();
    expect(r.status === 0, "it did not end as a success").toBe(false);
    expect(existsSync(pidFile), "no child was started").toBe(false);
    expect(fileLines(reportFile)).toEqual([]);
  });

  it("the group anchor reports a child it cannot start, also from a payload without a command, as a spawn error", () => {
    const reportFile = path.join(sandbox, `anchor-no-cmd-report-${process.hrtime.bigint()}`);
    const fd = openSync(reportFile, "w");
    let r;
    try {
      r = spawnSync(NODE, [path.join(SRC_DIR, "child-group-anchor.mjs"), JSON.stringify({ args: ["x"] })], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
    } finally {
      closeSync(fd);
    }
    expect(r.status, r.stderr).toBe(0);
    const events = fileLines(reportFile).map((line) => JSON.parse(line));
    expect(events.length).toBe(1);
    expect(events[0].spawnError?.code).toBe("ERR_INVALID_ARG_TYPE");
  });

  it("a forwarded signal that ends the group anchor before its handlers are in place ends the run as killed by that signal, and no child is started", () => {
    const pidFile = pidPath("anchor-early-signal-child");
    // Preloaded into every node process of the run, it acts only in the
    // anchor, before the anchor's own code: it sends the supervisor SIGTERM
    // and waits, so the forwarded SIGTERM meets an anchor without handlers.
    const preload = script(
      "anchor-early-signal.mjs",
      `if (String(process.argv[1] ?? "").endsWith("/child-group-anchor.mjs")) {
  process.kill(process.ppid, "SIGTERM");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
`,
    );
    const t0 = Date.now();
    const r = harness(
      `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(pidFile)}], { timeoutMs: 20000, graceMs: 15000, stdio: "ignore" });
console.log(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }));`,
      { env: withPreload(preload) },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.value).toEqual({ status: null, signal: "SIGTERM", error: null });
    expect(Date.now() - t0, "ended before the grace").toBeLessThan(10_000);
    pause(300);
    expect(existsSync(pidFile), "no child was started").toBe(false);
  }, 30_000);

  it("the child cannot forge a report: a result line written to every socket it holds beyond its stdio changes nothing", async () => {
    const cb = await loadLeaf();
    const forger = `const fs = require("fs");
for (let fd = 3; fd < 64; fd += 1) {
  try {
    if (fs.fstatSync(fd).isSocket()) fs.writeSync(fd, '{"status":0,"signal":null}\\n{"timedOut":true}\\n');
  } catch {}
}
process.exit(9);`;
    const r = cb.spawnGroupBoundedSync(NODE, ["-e", forger], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.error).toBeFalsy();
    expect(r.status).toBe(9);
    expect(r.signal).toBeNull();
  });

  it("source scan: no process-table read and no supervision variable is left", () => {
    const leaf = readFileSync(path.join(SRC_DIR, "child-bound.mjs"), "utf8");
    const supervisor = readFileSync(path.join(SRC_DIR, "child-group-supervisor.mjs"), "utf8");
    const anchor = readFileSync(path.join(SRC_DIR, "child-group-anchor.mjs"), "utf8");
    expect(leaf).not.toMatch(/["'`]ps["'`]/);
    expect(leaf).not.toMatch(/GROUP_SUPERVIS(ED|OR_PID)/);
    expect(leaf).not.toMatch(/CINATRA_GROUP_/);
    expect(supervisor).not.toMatch(/CINATRA_GROUP_/);
    expect(anchor).not.toMatch(/CINATRA_GROUP_/);
  });
});

describe("runSetupInTarget: the setup child runs under group supervision by default", () => {
  it("a setup child that hangs with a grandchild is stopped as CHILD_TIMEOUT and nothing it started survives", async () => {
    const install = await import(INSTALL_URL);
    const dir = mkdtempSync(path.join(sandbox, "setup-"));
    const [self, gc, blocker] = [pidPath("setup-self"), pidPath("setup-gc"), pidPath("setup-blocker")];
    // A stand-in for the published CLI: preloaded into every node process of
    // the run, it acts only in the setup child (argv[1] is the CLI's bin).
    const preload = script(
      "standin-setup.mjs",
      `import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
if (String(process.argv[1] ?? "").endsWith("/bin/cinatra.mjs")) {
  writeFileSync(${JSON.stringify(self)}, String(process.pid));
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(gc)}], { stdio: "ignore" });
  const t0 = Date.now();
  while (!existsSync(${JSON.stringify(gc)}) && Date.now() - t0 < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  spawnSync(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(blocker)}], { stdio: "ignore" });
}
`,
    );
    const saved = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${saved ? `${saved} ` : ""}--import=${pathToFileURL(preload).href}`;
    let caught = null;
    try {
      install.runSetupInTarget({ targetDir: dir, mode: "dev", skipDevApps: true, log: () => {}, timeoutMs: 1_500 });
    } catch (err) {
      caught = err;
    } finally {
      if (saved === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved;
    }
    expect(caught?.code).toBe("CHILD_TIMEOUT");
    expect(caught?.message).toMatch(/did not finish within 1\.5 s; it was stopped\./);
    expectGone(self);
    expectGone(gc);
    expectGone(blocker);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The source scan: every child wait in src/ has a hard bound from its spawn
// ---------------------------------------------------------------------------

/** The source with every comment blanked out (strings kept, line breaks kept). */
function stripComments(src) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote === null) {
      if (src.startsWith("//", i)) {
        let j = src.indexOf("\n", i);
        if (j < 0) j = src.length;
        out += " ".repeat(j - i);
        i = j;
        continue;
      }
      if (src.startsWith("/*", i)) {
        let j = src.indexOf("*/", i + 2);
        j = j < 0 ? src.length : j + 2;
        out += src.slice(i, j).replace(/[^\n]/g, " ");
        i = j;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === quote) quote = null;
    out += c;
    i += 1;
  }
  return out;
}

function sourceFiles() {
  const top = readdirSync(SRC_DIR).filter((f) => f.endsWith(".mjs")).map((f) => f);
  const authoring = readdirSync(path.join(SRC_DIR, "authoring"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `authoring/${f}`);
  return [...top, ...authoring].sort();
}

function lineOf(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

/** The text between the bracket at `open` and its partner. */
function balanced(text, open, openCh, closeCh) {
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < text.length) {
    if (text[i] === openCh) depth += 1;
    else if (text[i] === closeCh) depth -= 1;
    i += 1;
  }
  return text.slice(open + 1, i - 1);
}

const SIGKILL_RE = /killSignal\s*:\s*"SIGKILL"/;

/** Every direct spawnSync/execFileSync/execSync call in src/ that neither goes
 *  through `boundedOptions` nor sets SIGKILL itself, keyed by file, enclosing
 *  top-level function and the call's first source line. */
function unboundedDirectCalls() {
  const found = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(path.join(SRC_DIR, file), "utf8");
    const text = stripComments(src);
    const lines = src.split("\n");
    const fns = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)].map((m) => [m.index, m[1]]);
    for (const m of text.matchAll(/(?<![\w.$])(spawnSync|execFileSync|execSync)\(/g)) {
      const args = balanced(text, m.index + m[0].length - 1, "(", ")");
      if (args.includes("boundedOptions(") || SIGKILL_RE.test(args)) continue;
      const fn = fns.filter(([at]) => at < m.index).pop()?.[1] ?? "(top level)";
      found.push(`${file} ${fn}: ${lines[lineOf(text, m.index) - 1].trim()}`);
    }
  }
  return found.sort();
}

/** Every `timeout:` option in src/ whose object does not also set SIGKILL. */
function timeoutsWithoutSigkill() {
  const found = [];
  for (const file of sourceFiles()) {
    const text = stripComments(readFileSync(path.join(SRC_DIR, file), "utf8"));
    for (const m of text.matchAll(/(?<![\w$])timeout\s*:/g)) {
      // The object literal that holds this key.
      let depth = 0;
      let open = -1;
      for (let i = m.index - 1; i >= 0; i -= 1) {
        const c = text[i];
        if (c === "}") depth += 1;
        else if (c === "{") {
          if (depth === 0) {
            open = i;
            break;
          }
          depth -= 1;
        }
      }
      const object = open >= 0 ? balanced(text, open, "{", "}") : "";
      if (!SIGKILL_RE.test(object)) found.push(`${file}:${lineOf(text, m.index)}`);
    }
  }
  return found;
}

/** Inherited, user-facing child waits that stay unbounded on purpose. */
const UNBOUNDED_ALLOWED = [
  {
    site: 'index.mjs runDbUpgradeMajor: const r = spawnSync("bash", args, {',
    reason:
      "the guarded major-upgrade frame: inherited and user-facing, its length depends on the data size, and killing bash would orphan its restore children mid-restore",
  },
  {
    site: 'index.mjs followFileTail: const result = spawnSync("tail", ["-n", String(maxLines), "-f", logPath], {',
    reason: "an inherited `tail -f` the user follows and ends with Ctrl-C",
  },
  {
    site: 'index.mjs runComposeLogs: const result = spawnSync("docker", args, {',
    reason: "an inherited `docker compose logs --follow` the user follows and ends with Ctrl-C",
  },
];

/** Direct child waits that are not bounded yet. Each one is a later change's
 *  site; the list only shrinks, and a new unbounded wait fails this scan. */
const UNBOUNDED_PENDING = [
  "checkout-bootstrap-ddl.mjs applyCheckoutBootstrapDdl: execFileSync(cmd, args, options);",
  "clone-runtime.mjs processCommandLineMatches: cmd = execFileSync(\"ps\", [\"-p\", String(pid), \"-o\", \"command=\"], {",
  "clone-runtime.mjs processCommandLineMatches: const out = execFileSync(\"lsof\", [\"-a\", \"-p\", String(pid), \"-d\", \"cwd\", \"-Fn\"], {",
  "dev-twenty.mjs defaultDocker: const r = spawnSync(\"docker\", args, {",
  "index.mjs runCommandOrThrow: const result = spawnSync(command, args, {",
  "index.mjs commandExists: const result = spawnSync(command, args, {",
  "index.mjs waitForService: const result = spawnSync(\"docker\", [\"compose\", \"exec\", \"-T\", service, ...readyCommand, ...readyArgs], {",
  "index.mjs waitForService: spawnSync(\"sleep\", [\"1\"]);",
  "index.mjs waitForNango: spawnSync(\"sleep\", [\"2\"]);",
  "index.mjs flushRedis: const result = spawnSync(\"docker\", [\"compose\", \"exec\", \"-T\", \"redis\", \"redis-cli\", \"FLUSHALL\"], {",
  "index.mjs readCheckoutHeadSha: const res = spawnSync(\"git\", [\"-C\", repoRoot, \"rev-parse\", \"HEAD\"], {",
  "index.mjs regenerateExtensionManifest: const regen = spawnSync(process.execPath, [generator], {",
  "index.mjs regenerateExtensionManifest: const check = spawnSync(process.execPath, [generator, \"--check\", \"--self\"], {",
  "index.mjs checkExtensionManifest: const check = spawnSync(process.execPath, [generator, \"--check\"], {",
  "index.mjs runCliUpdate: const out = spawnSync(\"npm\", [\"ls\", \"-g\", CLI_INSTALL_SPEC.split(\"@latest\")[0], \"--depth=0\"], {",
  "index.mjs runInstanceUpdate: return execFileSync(\"git\", [\"-C\", repoRoot, \"rev-parse\", \"--short\", \"HEAD\"], {",
  "index.mjs resolveRealBranchName: const out = execFileSync(",
  "index.mjs resolveRealBranchName: const gitDir = execFileSync(",
  "index.mjs runSetupBranch: const commonDir = execFileSync(",
  "index.mjs runSetupBranch: const commonDir = execFileSync(",
  "index.mjs runSetupBranch: selfBranch = execFileSync(",
  "index.mjs runTeardownBranch: branch = execFileSync(",
  "index.mjs runTeardownBranch: const commonDir = execFileSync(",
  "index.mjs readRedisUrl: const commonDir = execFileSync(",
  "index.mjs resolveRedisCliRunner: const hostProbe = spawnSync(\"redis-cli\", [\"--version\"], { encoding: \"utf8\" });",
  "index.mjs resolveRedisCliRunner: run: (args) => spawnSync(\"redis-cli\", [...urlArgs, ...args], { encoding: \"utf8\" }),",
  "index.mjs resolveRedisCliRunner: const psProbe = spawnSync(",
  "index.mjs resolveRedisCliRunner: const execProbe = spawnSync(",
  "index.mjs resolveRedisCliRunner: spawnSync(\"docker\", [\"exec\", \"-i\", container, \"redis-cli\", ...args], {",
  "index.mjs resolveMainEnvPath: const commonDir = execFileSync(",
  "index.mjs runRefreshSeed: execFileSync(\"git\", [\"-C\", repoRoot, \"rev-parse\", \"HEAD\"], { encoding: \"utf8\" })",
  "index.mjs resolveMainRepoRoot: const commonDir = execFileSync(",
  "index.mjs runSetupClone: worktreeListed = execFileSync(",
  "index.mjs runSetupClone: const addNewBranch = spawnSync(",
  "index.mjs runSetupClone: const install = spawnSync(depsInvocation.command, depsInvocation.args, {",
  "index.mjs pruneCliOwnedWorktree: listed = execFileSync(",
  "index.mjs pruneCliOwnedWorktree: const remove = spawnSync(",
  "index.mjs pruneCliOwnedWorktree: const forced = spawnSync(",
  "index.mjs pruneCliOwnedWorktree: const delBranch = spawnSync(",
  "index.mjs runClonePrune: const downResult = spawnSync(",
  "index.mjs findRepoRootFromWorktree: const out = execFileSync(",
  "index.mjs runCloneStart: const upResult = spawnSync(\"docker\", upArgs, {",
  "index.mjs runCloneStart: spawnSync(\"docker\", [\"compose\", \"-p\", projectName, \"-f\", composePath, \"down\"], {",
  "index.mjs runDevCms: const result = spawnSync(\"docker\", args, {",
  "index.mjs followFileTail: const probe = spawnSync(\"tail\", [\"--version\"], { stdio: \"ignore\" });",
  "index.mjs stopCloneRuntime: const downResult = spawnSync(",
  "install.mjs checkTargetWritable: spawnSync(\"rm\", [\"-f\", probePath]); // best-effort cleanup of the probe file.",
  "install.mjs composeUpOrThrow: const result = spawnSync(\"docker\", args, {",
  "install.mjs waitForCompose: const r = spawnSync(\"docker\", [...composeBase, \"exec\", \"-T\", service, ...readyCmd], {",
  "install.mjs waitForCompose: spawnSync(\"sleep\", [\"1\"]);",
  "install.mjs waitForNango: spawnSync(\"sleep\", [\"2\"]);",
  "install.mjs writeCoUseEnv: spawnSync(\"chmod\", [\"600\", envPath]);",
  "install.mjs restoreEnvLocal: spawnSync(\"rm\", [\"-f\", envPath]);",
  "install.mjs rollbackIsolatedInstance: if (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
  "install.mjs rollbackIsolatedInstance: if (existsSync(p) && f === ISOLATED_COMPOSE_FILENAME) spawnSync(\"rm\", [\"-f\", p]);",
  "install.mjs composeDown: const result = spawnSync(\"docker\", args, { cwd: targetDir, env: process.env, encoding: \"utf8\", stdio: [\"inherit\", \"inherit\", \"pipe\"] });",
  "install.mjs teardownInstance: if (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
  "install.mjs teardownInstance: if (f === ISOLATED_COMPOSE_FILENAME && existsSync(generated)) spawnSync(\"rm\", [\"-f\", generated]);",
  "install.mjs runIsolatedA2aPeers: deps.runCompose ?? ((a, opts) => spawnSync(\"docker\", a, { stdio: [\"ignore\", \"inherit\", \"inherit\"], ...opts }));",
  "install.mjs executeStopExisting: if (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
  "instance-endpoints.mjs capture: const r = spawnSync(command, args, {",
  "nango-secret-key.mjs sleepSeconds: spawnSync(\"sleep\", [String(seconds)]);",
  "worktree-collision-guard.mjs makeDefaultGitImpl: const out = execFileSync(\"git\", [\"-C\", repoRoot, \"worktree\", \"list\", \"--porcelain\"], {",
  "worktree-collision-guard.mjs makeDefaultGitImpl: const out = execFileSync(",
];

describe("source scan: every child wait in src/ is bounded from its spawn", () => {
  it("every `timeout:` child option also sets SIGKILL", () => {
    expect(timeoutsWithoutSigkill()).toEqual([]);
  });

  it("every direct child wait goes through boundedOptions, sets SIGKILL, or is recorded", () => {
    for (const { reason } of UNBOUNDED_ALLOWED) expect(reason.length).toBeGreaterThan(20);
    const expected = [...UNBOUNDED_ALLOWED.map((a) => a.site), ...UNBOUNDED_PENDING].sort();
    expect(unboundedDirectCalls()).toEqual(expected);
  });
});
