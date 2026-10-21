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
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

  it("a status-0 exit passes its status and output through and leaves the group as it is", async () => {
    const cb = await loadLeaf();
    const ok = cb.spawnGroupBoundedSync(NODE, ["-e", "console.log('hello'); console.error('note')"], { timeoutMs: 15_000, encoding: "utf8" });
    expect(ok.error).toBeFalsy();
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe("hello");
    expect(ok.stderr.trim()).toBe("note");
    const tree = treeScript();
    const [gc, blocker, self] = [pidPath("exit0-gc"), pidPath("exit0-blocker"), pidPath("exit0-self")];
    const r = cb.spawnGroupBoundedSync(NODE, [tree, gc, blocker, self, "exit0"], { timeoutMs: 15_000, stdio: "ignore" });
    expect(r.status).toBe(0);
    expect(isAlive(readPid(gc))).toBe(true);
    killIfAlive(gc);
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
    const proc = spawnAsync(NODE, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    const exited = new Promise((resolve) => proc.on("exit", resolve));
    const t0 = Date.now();
    while (!existsSync(pidFile) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50));
    const [, supervisorPid] = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
    expect(supervisorPid).not.toBe(proc.pid);
    process.kill(supervisorPid, "SIGTERM");
    await exited;
    expect(readFileSync(mark, "utf8")).toBe("term");
    expect(JSON.parse(out.trim().split("\n").pop())).toEqual({ status: 7, signal: null, error: null });
    expectGone(pidFile);
  }, 30_000);

  it("nested inside a supervised run it is plain bounded spawnSync (the outer group already holds it)", async () => {
    const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const r = cb.spawnGroupBoundedSync(${JSON.stringify(NODE)}, ["-e", "console.log(process.ppid)"], { timeoutMs: 15000, encoding: "utf8" });
console.log(JSON.stringify({ self: process.pid, parentOfChild: Number(r.stdout.trim()), status: r.status }));`;
    const nested = harness(code, { env: { ...process.env, CINATRA_GROUP_SUPERVISED: "1" } });
    expect(nested.status, nested.stderr).toBe(0);
    expect(nested.value.status).toBe(0);
    expect(nested.value.parentOfChild).toBe(nested.value.self);
    const env = { ...process.env };
    delete env.CINATRA_GROUP_SUPERVISED;
    const outer = harness(code, { env });
    expect(outer.status, outer.stderr).toBe(0);
    expect(outer.value.status).toBe(0);
    expect(outer.value.parentOfChild).not.toBe(outer.value.self);
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
