// cinatra-cli#306: the remaining child waits of the sweep, each bounded from
// its spawn and judged by its exit status first.
//
// Every row drives one site through an exported entry, in a fresh node
// process whose child-bound override is 2 s (set by import, as a test
// does). A stand-in for the site's command is first on PATH. On its target
// call it writes its pid, starts a grandchild on its own pipes, ignores
// SIGTERM and never exits ("hang"), or answers and exits while the grandchild
// keeps its pipes open ("answer", optionally with `leave`). The other calls of
// the entry are answered by argv pattern.
//
// - bound: a hanging target ends within the bound plus a margin with the
//   site's own failure value, and the stand-in and its grandchild are gone.
//   An unbounded site blocks, and the harness bound (SIGKILL) ends the run.
// - status-first: an answer the site must not read (a non-zero exit, or a
//   status 0 that came with an expired bound) gives the site's failure value,
//   never the printed text.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE = process.execPath;
const LEAF_URL = new URL("../src/child-bound.mjs", import.meta.url).href;
// The override is the site's whole bound, and it starts at the spawn: the
// watchdog, the stand-in and its grandchild are node processes that must all
// start inside it, also on a loaded runner (300 ms was too short at a 1-min
// load of 12). The expected failure texts below name it: "within 2 s".
const BOUND_MS = 2_000;
const MARGIN_MS = 3_000;
/** The longest a "leave" stand-in waits for its grandchild's pid; well inside
 *  BOUND_MS, so a slow grandchild fails the row on its own check, not a bound. */
const GRANDCHILD_PID_WAIT_MS = 1_500;

let sandbox;
const started = [];
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-child-bound-sites-"));
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
    return Number(readFileSync(pidFile, "utf8").trim());
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

function expectGone(pidFile, what) {
  const pid = readPid(pidFile);
  expect(pid, `${what} was started`).toBeGreaterThan(0);
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < 3_000) pause(50);
  expect(isAlive(pid), `${what} (pid ${pid}) is gone`).toBe(false);
}

function fileLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** A child that writes its pid to argv[1], ignores SIGTERM and never exits. */
const NEVER_EXITS =
  "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";

/** A bin dir holding a stand-in `command`: the earlier calls are answered by
 *  argv pattern (`answers`: [regex, stdout]); the target call (`target.re`)
 *  writes its pid and starts the never-exiting grandchild on its stdout and
 *  stderr, then
 *  - mode "hang": ignores SIGTERM and never exits;
 *  - mode "answer": writes `out` to stdout and exits `exit`; with `leave` the
 *    grandchild keeps the pipes open after that exit, else it is ended first.
 *    With `leave` it answers only once the grandchild has written its pid, so
 *    the pipes are held when it exits; a grandchild with no pid within
 *    GRANDCHILD_PID_WAIT_MS is the stand-in's exit 99, and the row fails on
 *    its "was started" check before it reads the site's answer. With
 *    `signal` it ends by that signal instead of its exit. */
function standIn(command, { answers = [], target }, { pidFile, gpidFile, callLog }) {
  const dir = mkdtempSync(path.join(sandbox, "bin-"));
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
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const g = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(gpidFile)}], { stdio: ["ignore", "inherit", "inherit"] });
if (t.mode === "hang") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  if (t.leave) {
    const gpid = () => { try { return Number(fs.readFileSync(${JSON.stringify(gpidFile)}, "utf8").trim()); } catch { return 0; } };
    for (const t0 = Date.now(); !(gpid() > 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)) {
      if (Date.now() - t0 >= ${GRANDCHILD_PID_WAIT_MS}) { fs.writeSync(2, "stand-in: the grandchild wrote no pid\\n"); process.exit(99); }
    }
  }
  if (t.out) fs.writeSync(1, t.out);
  if (!t.leave) g.kill("SIGKILL");
  if (t.signal) process.kill(process.pid, t.signal);
  process.exit(t.exit ?? 0);
}
`;
  const p = path.join(dir, command);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  // The first start of a newly written executable can be slow; warm it once.
  const w = spawnSync(p, ["--warm"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  expect(w.status, `warming the stand-in ${command}: ${w.stderr}`).toBe(0);
  return dir;
}

/** Run `entry` (an async function body that sees `m` and `dir`) of
 *  src/<module> in a fresh node process under the leaf bound override, with
 *  `bin` first on PATH. The run itself is stopped by SIGKILL at 20 s. */
function drive(module, entry, bin) {
  const work = path.join(sandbox, `work-${process.hrtime.bigint()}`);
  mkdirSync(work);
  const moduleUrl = new URL(`../src/${module}`, import.meta.url).href;
  const code = `const cb = await import(${JSON.stringify(LEAF_URL)});
const m = await import(${JSON.stringify(moduleUrl)});
const dir = ${JSON.stringify(work)};
cb.__setChildBoundsForTest(${BOUND_MS});
const t0 = performance.now();
const v = await (async () => { ${entry} })();
console.log(JSON.stringify({ ms: performance.now() - t0, v: v === undefined ? "(undefined)" : v }));`;
  const r = spawnSync(NODE, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const lines = String(r.stdout ?? "").trim().split("\n");
  let value = null;
  try {
    value = JSON.parse(lines[lines.length - 1]);
  } catch {
    value = null;
  }
  return { status: r.status, signal: r.signal, value, stderr: r.stderr };
}

/** A caught throw as a plain value. */
const CAUGHT = (call) => `try { ${call}; return "no throw"; } catch (e) { return { code: e.code ?? null, message: e.message }; }`;

const TWENTY_CHECKOUT = `const fs = await import("node:fs");
fs.writeFileSync(dir + "/docker-compose.yml", "services:\\n" + m.DEV_TWENTY_CONTAINERS.map((n) => "  # " + n).join("\\n") + "\\n");`;

// ---------------------------------------------------------------------------
// bound: every site ends a hanging child (and its grandchild) at its bound
// ---------------------------------------------------------------------------

const BOUND_ROWS = [
  {
    site: "src/dev-twenty.mjs defaultDocker (the stack reading)",
    module: "dev-twenty.mjs",
    command: "docker",
    entry: `${TWENTY_CHECKOUT}
return await m.ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps: { home: dir } });`,
    hang: "^ps -a ",
    expected: { action: "skipped", reason: "docker-unavailable", healthy: false },
  },
  {
    site: "src/index.mjs runCommandOrThrow (inherited output)",
    module: "index.mjs",
    command: "docker",
    entry: CAUGHT(`m.runCommandOrThrow("docker", ["compose", "up", "-d"], "Failed to start Docker containers.", { cwd: dir })`),
    hang: "^compose up -d$",
    expected: { code: "CHILD_TIMEOUT", message: "Failed to start Docker containers. (`docker compose` did not finish within 2 s; it was stopped.)" },
  },
  {
    site: "src/index.mjs commandExists",
    module: "index.mjs",
    command: "docker",
    entry: CAUGHT(`m.commandExists("docker")`),
    hang: "^--version$",
    expected: { code: "CHILD_TIMEOUT", message: "`docker` did not finish within 2 s; it was stopped." },
  },
  {
    site: "src/index.mjs waitForService (one attempt, then the in-process pause)",
    module: "index.mjs",
    command: "docker",
    entry: CAUGHT(`m.waitForService(dir, "postgres", ["pg_isready", "-U", "postgres"], [], "Postgres", 1)`),
    hang: "^compose exec -T postgres pg_isready -U postgres$",
    expected: { code: null, message: "Postgres did not become ready within 1 seconds." },
    limitMs: BOUND_MS + 1_000 + MARGIN_MS,
  },
  {
    site: "src/index.mjs readInstalledCliVersion (the update command's read-back)",
    module: "index.mjs",
    command: "npm",
    entry: `return m.readInstalledCliVersion();`,
    hang: "^ls -g ",
    expected: null,
  },
  {
    site: "src/wayflow-runtime.mjs waitForWayflowHealth",
    module: "wayflow-runtime.mjs",
    command: "docker",
    entry: `return m.waitForWayflowHealth({ project: "cinatra_probe", attempts: 1, sleepImpl: () => {} });`,
    hang: "^ps --filter ",
    expected: { healthy: false, state: null },
  },
  {
    site: "src/wayflow-runtime.mjs buildWayflowImage",
    module: "wayflow-runtime.mjs",
    command: "docker",
    entry: `const r = m.buildWayflowImage({ targetDir: dir, composeArgs: ["compose"], log: () => {} });
return { ok: r.ok, status: r.status, named: r.stderr.includes("\`docker compose\` did not finish within 2 s; it was stopped.") };`,
    hang: "^compose build wayflow$",
    expected: { ok: false, status: 1, named: true },
  },
  {
    site: "src/wayflow-runtime.mjs generateWayflowEnv (the bridge-token generator)",
    module: "wayflow-runtime.mjs",
    command: "fake-node",
    entry: `const r = m.generateWayflowEnv({ targetDir: dir, log: () => {}, existsImpl: () => true, execPath: "fake-node" });
return { ok: r.ok, named: /did not finish within 2 s; it was stopped/.test(r.reason) };`,
    hang: "gen-wayflow-env\\.mjs --require-bridge-token$",
    expected: { ok: false, named: true },
  },
  {
    site: "src/wayflow-agent-mount.mjs publishedWayflowEndpoint",
    module: "wayflow-agent-mount.mjs",
    command: "docker",
    entry: `const cp = await import("node:child_process");
return m.publishedWayflowEndpoint({ targetDir: dir, composeArgs: ["compose"], deps: { spawnSync: cp.spawnSync } });`,
    hang: "^compose port wayflow ",
    expected: null,
  },
  {
    site: "src/wayflow-agent-mount.mjs restartWayflowService",
    module: "wayflow-agent-mount.mjs",
    command: "docker",
    entry: `const cp = await import("node:child_process");
return m.restartWayflowService({ targetDir: dir, composeArgs: ["compose"], deps: { spawnSync: cp.spawnSync } });`,
    hang: "^compose restart wayflow$",
    expected: { ok: false, reason: "restart-timeout (`docker compose` did not finish within 2 s; it was stopped.)" },
  },
  {
    site: "src/purge-registry-users.mjs createComposeRegistryTransport",
    module: "purge-registry-users.mjs",
    command: "docker",
    entry: `return m.createComposeRegistryTransport(dir).restart().status;`,
    hang: "^compose restart ",
    expected: null,
  },
  {
    site: "src/worktree-collision-guard.mjs makeDefaultGitImpl listWorktrees",
    module: "worktree-collision-guard.mjs",
    command: "git",
    entry: CAUGHT(`m.makeDefaultGitImpl(dir).listWorktrees()`),
    hang: " worktree list --porcelain$",
    expected: { code: "CHILD_TIMEOUT", message: "`git worktree` did not finish within 2 s; it was stopped." },
  },
  {
    site: "src/worktree-collision-guard.mjs makeDefaultGitImpl listBranches",
    module: "worktree-collision-guard.mjs",
    command: "git",
    entry: CAUGHT(`m.makeDefaultGitImpl(dir).listBranches()`),
    hang: " for-each-ref ",
    expected: { code: "CHILD_TIMEOUT", message: "`git for-each-ref` did not finish within 2 s; it was stopped." },
  },
  {
    site: "src/clone-runtime.mjs processCommandLineMatches (the ps lookup)",
    module: "clone-runtime.mjs",
    command: "ps",
    entry: `const r = m.processCommandLineMatches(process.pid);
return { indeterminate: r.indeterminate === true, ours: r.ours, named: /^ps failed \\(.* did not finish within 2 s; it was stopped\\.\\)$/.test(r.why) };`,
    hang: "^-p \\d+ -o command=$",
    expected: { indeterminate: true, ours: false, named: true },
  },
  {
    site: "src/instance-endpoints.mjs capture (composePublishedPortsForTarget)",
    module: "instance-endpoints.mjs",
    command: "docker",
    entry: `return m.composePublishedPortsForTarget(dir);`,
    hang: " config --format json$",
    expected: null,
  },
];

describe("cinatra-cli#306 bound: each site ends a hanging child and its grandchild at the bound, with its own failure", () => {
  for (const row of BOUND_ROWS) {
    it(row.site, () => {
      const pidFile = pidPath("child");
      const gpidFile = pidPath("grandchild");
      const callLog = path.join(sandbox, `calls-${process.hrtime.bigint()}.log`);
      const bin = standIn(row.command, { answers: row.answers, target: { re: row.hang, mode: "hang" } }, { pidFile, gpidFile, callLog });
      try {
        const r = drive(row.module, row.entry, bin);
        const limit = row.limitMs ?? BOUND_MS + MARGIN_MS;
        expect(r.value?.ms ?? Infinity, `the call ends within ${limit} ms (harness ${r.signal ?? r.status}): ${r.stderr}`).toBeLessThan(limit);
        expect(r.status, r.stderr).toBe(0);
        expect(r.value.v).toEqual(row.expected);
        expect(fileLines(callLog).some((l) => new RegExp(row.hang).test(l)), "the stand-in saw the target call").toBe(true);
        expectGone(pidFile, "the stand-in");
        expectGone(gpidFile, "the stand-in's grandchild");
      } finally {
        killIfAlive(pidFile);
        killIfAlive(gpidFile);
      }
    }, 30_000);
  }
});

describe("cinatra-cli#306 bound: the checkout bootstrap DDL run", () => {
  it("src/checkout-bootstrap-ddl.mjs: a DDL run that never exits ends at the bound, named, and its group is gone", () => {
    // The run is `node <bundle>`: the bundle itself is the child that writes
    // its pid, starts a grandchild on its pipes, ignores SIGTERM and never exits.
    const pidFile = pidPath("ddl");
    const gpidFile = pidPath("ddl-grandchild");
    const bin = mkdtempSync(path.join(sandbox, "bin-empty-"));
    const bundleBody = `import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
spawn(process.execPath, ["-e", ${JSON.stringify(NEVER_EXITS)}, ${JSON.stringify(gpidFile)}], { stdio: ["ignore", "inherit", "inherit"] });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;
    try {
      const r = drive(
        "checkout-bootstrap-ddl.mjs",
        `const fs = await import("node:fs");
fs.mkdirSync(dir + "/scripts");
fs.writeFileSync(dir + "/scripts/schema-bootstrap.bundle.mjs", ${JSON.stringify(bundleBody)});
${CAUGHT(`m.applyCheckoutBootstrapDdl({
  repoRoot: dir,
  connectionString: "postgres://stand-in",
  schemaName: "public",
  log: () => {},
  warn: () => {},
  deps: { exists: (p) => p.endsWith("schema-bootstrap.bundle.mjs") },
})`)}`,
        bin,
      );
      expect(r.value?.ms ?? Infinity, `the call ends within the bound plus ${MARGIN_MS} ms (harness ${r.signal ?? r.status}): ${r.stderr}`).toBeLessThan(BOUND_MS + MARGIN_MS);
      expect(r.status, r.stderr).toBe(0);
      expect(r.value.v.code).toBeNull();
      expect(r.value.v.message).toMatch(/^Checkout bootstrap DDL failed .* did not finish within 2 s; it was stopped\.$/);
      expectGone(pidFile, "the DDL run");
      expectGone(gpidFile, "the DDL run's grandchild");
    } finally {
      killIfAlive(pidFile);
      killIfAlive(gpidFile);
    }
  }, 30_000);

  it("src/checkout-bootstrap-ddl.mjs runCheckoutDdlChild: a non-zero exit and a signal are failures, exit 0 is not", async () => {
    const { runCheckoutDdlChild } = await import(new URL("../src/checkout-bootstrap-ddl.mjs", import.meta.url).href);
    expect(() => runCheckoutDdlChild(NODE, ["-e", "process.exit(3)"], { stdio: "ignore" })).toThrow(/exited 3$/);
    expect(() => runCheckoutDdlChild(NODE, ["-e", "process.kill(process.pid, 'SIGKILL')"], { stdio: "ignore" })).toThrow(/killed by SIGKILL$/);
    expect(runCheckoutDdlChild(NODE, ["-e", "process.exit(0)"], { stdio: "ignore" })).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// status-first: a site reads no text of a failed or unread answer
// ---------------------------------------------------------------------------

const STATUS_ROWS = [
  {
    site: "src/wayflow-runtime.mjs waitForWayflowHealth: '(healthy)' printed by a failed `docker ps` is no health",
    module: "wayflow-runtime.mjs",
    command: "docker",
    entry: `return m.waitForWayflowHealth({ project: "cinatra_probe", attempts: 1, sleepImpl: () => {} });`,
    target: { re: "^ps --filter ", mode: "answer", out: "Up 1 minute (healthy)\n", exit: 1 },
    expected: { healthy: false, state: null },
  },
  {
    site: "src/wayflow-runtime.mjs waitForWayflowHealth: '(healthy)' from a `docker ps` whose bound expired is no health",
    module: "wayflow-runtime.mjs",
    command: "docker",
    entry: `return m.waitForWayflowHealth({ project: "cinatra_probe", attempts: 1, sleepImpl: () => {} });`,
    target: { re: "^ps --filter ", mode: "answer", out: "Up 1 minute (healthy)\n", exit: 0, leave: true },
    expected: { healthy: false, state: null },
  },
  {
    site: "src/preview.mjs deriveSlug: a branch printed by a failed `git rev-parse` names no slug",
    module: "preview.mjs",
    command: "git",
    entry: `return m.deriveSlug({ rest: [], checkoutDir: dir });`,
    target: { re: " rev-parse --abbrev-ref HEAD$", mode: "answer", out: "feature-x\n", exit: 128 },
    expected: "main",
  },
  {
    site: "src/preview.mjs deriveSlug: a branch from a `git rev-parse` whose bound expired names no slug",
    module: "preview.mjs",
    command: "git",
    entry: `return m.deriveSlug({ rest: [], checkoutDir: dir });`,
    target: { re: " rev-parse --abbrev-ref HEAD$", mode: "answer", out: "feature-x\n", exit: 0, leave: true },
    expected: "main",
  },
  {
    site: "src/preview.mjs deriveSlug: a clean `git rev-parse` still names the slug",
    module: "preview.mjs",
    command: "git",
    entry: `return m.deriveSlug({ rest: [], checkoutDir: dir });`,
    target: { re: " rev-parse --abbrev-ref HEAD$", mode: "answer", out: "feature-x\n", exit: 0 },
    expected: "feature-x",
  },
  {
    site: "src/index.mjs readInstalledCliVersion: a version listed by a failed `npm ls` is not read",
    module: "index.mjs",
    command: "npm",
    entry: `return m.readInstalledCliVersion();`,
    target: { re: "^ls -g ", mode: "answer", out: "/usr/lib\n└── @cinatra-ai/cinatra@9.9.9\n", exit: 1 },
    expected: null,
  },
  {
    site: "src/index.mjs readInstalledCliVersion: a clean `npm ls` names the version",
    module: "index.mjs",
    command: "npm",
    entry: `return m.readInstalledCliVersion();`,
    target: { re: "^ls -g ", mode: "answer", out: "/usr/lib\n└── @cinatra-ai/cinatra@9.9.9\n", exit: 0 },
    expected: "9.9.9",
  },
  {
    site: "src/wayflow-agent-mount.mjs publishedWayflowEndpoint: an address from a `docker compose port` whose bound expired is no endpoint",
    module: "wayflow-agent-mount.mjs",
    command: "docker",
    entry: `const cp = await import("node:child_process");
return m.publishedWayflowEndpoint({ targetDir: dir, composeArgs: ["compose"], deps: { spawnSync: cp.spawnSync } });`,
    target: { re: "^compose port wayflow ", mode: "answer", out: "[::1]:13010\n", exit: 0, leave: true },
    expected: null,
  },
  {
    site: "src/purge-registry-users.mjs createComposeRegistryTransport: a status 0 whose bound expired is no status",
    module: "purge-registry-users.mjs",
    command: "docker",
    entry: `return m.createComposeRegistryTransport(dir).exec({ command: "true" }).status;`,
    target: { re: "^compose exec -T ", mode: "answer", out: "ok\n", exit: 0, leave: true },
    expected: null,
  },
  {
    site: "src/instance-endpoints.mjs capture: a compose config whose bound expired is no band",
    module: "instance-endpoints.mjs",
    command: "docker",
    entry: `return m.composePublishedPortsForTarget(dir);`,
    target: {
      re: " config --format json$",
      mode: "answer",
      out: JSON.stringify({ services: { app: { ports: [{ published: "3000", target: 3000, protocol: "tcp" }] } } }),
      exit: 0,
      leave: true,
    },
    expected: null,
  },
];

describe("cinatra-cli#306 status-first: a site reads no text of a non-zero exit or of an expired bound", () => {
  for (const row of STATUS_ROWS) {
    it(row.site, () => {
      const pidFile = pidPath("child");
      const gpidFile = pidPath("grandchild");
      const callLog = path.join(sandbox, `calls-${process.hrtime.bigint()}.log`);
      const bin = standIn(row.command, { answers: row.answers, target: row.target }, { pidFile, gpidFile, callLog });
      try {
        const r = drive(row.module, row.entry, bin);
        expect(r.status, `harness ${r.signal ?? r.status}: ${r.stderr}`).toBe(0);
        expect(fileLines(callLog).some((l) => new RegExp(row.target.re).test(l)), "the stand-in saw the target call").toBe(true);
        // A "leave" row proves nothing unless its grandchild held the pipes: read that first.
        if (row.target.leave) expect(readPid(gpidFile), "the grandchild that held the pipes was started").toBeGreaterThan(0);
        expect(r.value.v).toEqual(row.expected);
        if (row.target.leave) expectGone(gpidFile, "the grandchild that held the pipes");
      } finally {
        killIfAlive(pidFile);
        killIfAlive(gpidFile);
      }
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// Through the watchdog, the restart's own failures keep their reasons (main's
// code gives the same reasons; tests/child-bound-status.test.mjs has the rows
// with a refused status 0)
// ---------------------------------------------------------------------------

describe("restartWayflowService through the watchdog: an exit 1 and a signal death keep their reasons", () => {
  const RESTART = `const cp = await import("node:child_process");
return m.restartWayflowService({ targetDir: dir, composeArgs: ["compose"], deps: { spawnSync: cp.spawnSync } });`;
  for (const [name, target, expected] of [
    ["an exit 1 is restart-exit-1", { re: "^compose restart wayflow$", mode: "answer", exit: 1 }, { ok: false, reason: "restart-exit-1" }],
    ["a SIGKILL death is restart-exit-null", { re: "^compose restart wayflow$", mode: "answer", signal: "SIGKILL" }, { ok: false, reason: "restart-exit-null" }],
  ]) {
    it(name, () => {
      const pidFile = pidPath("child");
      const gpidFile = pidPath("grandchild");
      const callLog = path.join(sandbox, `calls-${process.hrtime.bigint()}.log`);
      const bin = standIn("docker", { target }, { pidFile, gpidFile, callLog });
      try {
        const r = drive("wayflow-agent-mount.mjs", RESTART, bin);
        expect(r.status, `harness ${r.signal ?? r.status}: ${r.stderr}`).toBe(0);
        expect(fileLines(callLog).some((l) => new RegExp(target.re).test(l)), "the stand-in saw the target call").toBe(true);
        expect(r.value.v).toEqual(expected);
      } finally {
        killIfAlive(pidFile);
        killIfAlive(gpidFile);
      }
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// The upgrade command's volume reading is the recreate preflight's own
// ---------------------------------------------------------------------------

describe("cinatra-cli#306: `instance db upgrade-preflight` reads volumes with the recreate preflight's readers", () => {
  const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const start = src.indexOf("async function runDbUpgradePreflight(rest) {");
  const end = src.indexOf("async function runDbUpgradeMajor(rest) {");
  const body = start >= 0 && end > start ? src.slice(start, end) : "";

  it("the command builds its capture and its three-way volume reader from recreate-preflight.mjs, with no copy of its own", () => {
    expect(body, "runDbUpgradePreflight is found").not.toBe("");
    expect(body).toMatch(/const \{ makeDockerCapture, makeInspectVolumeThreeWay \} = await import\("\.\/recreate-preflight\.mjs"\);/);
    expect(body).toMatch(/const dockerCapture = makeDockerCapture\(spawnSync\);/);
    expect(body).toMatch(/const inspectVolumeThreeWay = makeInspectVolumeThreeWay\(spawnSync\);/);
    // No reading of docker's text of its own: "no such volume" is decided only
    // by the shared reader, on docker's exit 1.
    expect(body).not.toMatch(/no such volume\/i/);
    expect(body).not.toMatch(/spawnSync\("docker"/);
  });

  it("the shared reader is absent only on docker's own exit 1, and the capture refuses a timeout", async () => {
    const m = await import(new URL("../src/recreate-preflight.mjs", import.meta.url).href);
    const answer = (r) => () => ({ signal: null, error: null, stdout: "", stderr: "Error: No such volume: v\n", ...r });
    expect(m.makeInspectVolumeThreeWay(answer({ status: 1 }))("v")).toEqual({ status: "absent", row: null });
    expect(m.makeInspectVolumeThreeWay(answer({ status: 2 }))("v")).toEqual({ status: "error", row: null });
    expect(m.makeInspectVolumeThreeWay(answer({ status: null, signal: "SIGKILL" }))("v")).toEqual({ status: "error", row: null });
    const timedOut = { status: 0, signal: null, stdout: "out\n", stderr: "", error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    expect(m.makeDockerCapture(() => timedOut)(["ps"])).toBeNull();
    expect(m.makeDockerCapture(() => ({ status: 0, signal: null, error: null, stdout: "out\n", stderr: "" }))(["ps"])).toBe("out");
  });
});
