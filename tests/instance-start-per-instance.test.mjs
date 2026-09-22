// cinatra-cli#261 — `instance start` is per-instance: the slug, the runtime
// paths, the ports and the bind address are chosen, not fixed.
//
// `instance start` derived everything from ONE hardcoded slug, so a second
// checkout on the same machine had no start verb at all: its pid file, log and
// lock were the first one's, and the second start refused by design. The spawn
// also named no bind address, so an operator who wanted an instance reachable
// only over loopback could not say so.
//
// These tests cover the PURE seams behind the verb (no spawn, no docker, no
// network), mirroring the repo's testable-decision-helper convention
// (evaluateHostDevStartMode, parseNextCleanDirective, resolveInstanceMoveTarget):
//
//   - parseInstanceStartFlags   — the selector + the explicit port/bind flags
//   - resolveInstanceStartPlan  — the derivation table (paths, names, ports)
//   - assertInstanceStartFree   — the refusal when another running instance
//                                 already holds this slug or one of its ports
//   - the instance record       — what makes "another running instance" knowable
//
// The DEFAULT (no flags) is pinned byte-for-byte: same slug, same pid/log/lock
// paths, same spawned argument list, no environment override at all.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_INSTANCE_SLUG,
  INSTANCE_RECORD_FILE,
  assertInstanceStartFree,
  clearInstanceRecord,
  instanceComposeProject,
  instanceQueueName,
  instanceRecordPath,
  instanceRuntimeContainer,
  listInstanceRecords,
  parseInstanceStartFlags,
  readInstanceRecord,
  resolveInstanceStartPlan,
  writeInstanceRecord,
} from "../src/instance-start.mjs";
import {
  clonePidPath,
  cloneLogPath,
  cloneLockPath,
  cloneRuntimeDir,
  isInstanceProcessRunning,
  isPidAlive,
} from "../src/clone-runtime.mjs";
import { DEV_MAIN_SLUG } from "../src/dev-tunnel-identity.mjs";
import { coUseQueueName } from "../src/install-couse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

const tmpDirs = [];
function mkHome() {
  const d = mkdtempSync(path.join(os.tmpdir(), "cli261-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// A pid that is alive for the whole test run (this process) vs. one that is not.
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_600;

function record(fields) {
  return {
    slug: "other",
    pid: LIVE_PID,
    repoRoot: "/checkout/other",
    port: 3301,
    runtimePort: 3311,
    ...fields,
  };
}

// =========================================================================
describe("parseInstanceStartFlags — the selector and the explicit values", () => {
  it("defaults to the single-instance slug with nothing chosen", () => {
    expect(parseInstanceStartFlags([])).toEqual({
      slug: DEFAULT_INSTANCE_SLUG,
      port: null,
      runtimePort: null,
      bind: null,
    });
    expect(DEFAULT_INSTANCE_SLUG).toBe(DEV_MAIN_SLUG);
  });

  it("reads the space-separated and the `=` form of every flag", () => {
    expect(parseInstanceStartFlags(["--instance", "web-2", "--port", "3301", "--runtime-port", "3311", "--bind", "127.0.0.1"])).toEqual({
      slug: "web-2",
      port: 3301,
      runtimePort: 3311,
      bind: "127.0.0.1",
    });
    expect(parseInstanceStartFlags(["--instance=web-2", "--port=3301", "--runtime-port=3311", "--bind=127.0.0.1"])).toEqual({
      slug: "web-2",
      port: 3301,
      runtimePort: 3311,
      bind: "127.0.0.1",
    });
  });

  it("leaves the unrelated start flags alone", () => {
    expect(parseInstanceStartFlags(["--clean", "--instance", "web-2"]).slug).toBe("web-2");
    expect(parseInstanceStartFlags(["--no-clean"]).slug).toBe(DEFAULT_INSTANCE_SLUG);
  });

  it("refuses a name that is not a plain lower-case slug", () => {
    for (const bad of ["Web2", "web 2", "web/2", "../evil", "-lead", "", "x".repeat(31)]) {
      expect(() => parseInstanceStartFlags(["--instance", bad])).toThrow(/--instance/);
    }
  });

  it("refuses a port that is not a usable number", () => {
    for (const bad of ["0", "80", "70000", "abc", "-1"]) {
      expect(() => parseInstanceStartFlags(["--port", bad])).toThrow(/--port/);
      expect(() => parseInstanceStartFlags(["--runtime-port", bad])).toThrow(/--runtime-port/);
    }
  });

  it("refuses a bind address that is not a bare address token", () => {
    for (const bad of ["127.0.0.1 --evil", "--flag", "", "host name"]) {
      expect(() => parseInstanceStartFlags(["--bind", bad])).toThrow(/--bind/);
    }
    expect(parseInstanceStartFlags(["--bind", "0.0.0.0"]).bind).toBe("0.0.0.0");
    expect(parseInstanceStartFlags(["--bind", "::1"]).bind).toBe("::1");
  });
});

// =========================================================================
describe("resolveInstanceStartPlan — the default is unchanged", () => {
  it("derives the single-instance paths, port and spawn with no flags and no env", () => {
    const home = mkHome();
    const plan = resolveInstanceStartPlan({ argv: [], env: {}, home });

    expect(plan.slug).toBe(DEV_MAIN_SLUG);
    expect(plan.isDefault).toBe(true);
    expect(plan.pidPath).toBe(clonePidPath(DEV_MAIN_SLUG, { home }));
    expect(plan.logPath).toBe(cloneLogPath(DEV_MAIN_SLUG, { home }));
    expect(plan.lockPath).toBe(cloneLockPath(DEV_MAIN_SLUG, { home }));
    expect(plan.runtimeDir).toBe(cloneRuntimeDir(DEV_MAIN_SLUG, { home }));
    expect(plan.port).toBe(3000);
    expect(plan.runtimePort).toBe(3010);
    expect(plan.bind).toBeNull();
    // The spawned argument list and the environment overlay are what the old
    // single-instance start passed — byte for byte.
    expect(plan.spawnArgs).toEqual(["dev"]);
    expect(plan.envOverrides).toEqual({});
    expect(plan.healthUrl).toBe("http://localhost:3000/api/health");
    expect(plan.label).toBe("Dev main");
  });

  it("still takes the app port and the runtime endpoint from the instance's own environment", () => {
    const home = mkHome();
    const plan = resolveInstanceStartPlan({
      argv: [],
      env: { PORT: "3456", WAYFLOW_BASE_URL: "http://localhost:3456/", BULLMQ_QUEUE_NAME: "cinatra-bg" },
      home,
    });
    expect(plan.port).toBe(3456);
    expect(plan.runtimePort).toBe(3456);
    expect(plan.queueName).toBe("cinatra-bg");
    expect(plan.spawnArgs).toEqual(["dev"]);
    expect(plan.envOverrides).toEqual({});
  });

  it("the source keeps the spawn on the resolved plan, not a fixed argument list", () => {
    // The default-unchanged promise is only worth what the call site does with
    // it: the dev-start spawn must hand the plan's argument list through.
    expect(INDEX_SRC).toMatch(/spawn\("pnpm",\s*plan\.spawnArgs,/);
    // …and no lifecycle path keys its runtime state on the fixed slug any more.
    expect(INDEX_SRC).not.toMatch(/acquireRuntimeLock\(DEV_MAIN_SLUG\)/);
    expect(INDEX_SRC).not.toMatch(/clonePidPath\(DEV_MAIN_SLUG\)/);
  });
});

// =========================================================================
describe("resolveInstanceStartPlan — one instance per slug", () => {
  it("derives every runtime path, name and port from the slug", () => {
    const home = mkHome();
    const plan = resolveInstanceStartPlan({
      argv: ["--instance", "web-2", "--port", "3301", "--runtime-port", "3311"],
      env: {},
      home,
    });

    expect(plan.slug).toBe("web-2");
    expect(plan.isDefault).toBe(false);
    expect(plan.runtimeDir).toBe(path.join(home, ".cinatra", "clones", "web-2"));
    expect(plan.pidPath).toBe(path.join(plan.runtimeDir, "nextjs.pid"));
    expect(plan.logPath).toBe(path.join(plan.runtimeDir, "nextjs.log"));
    expect(plan.lockPath).toBe(path.join(plan.runtimeDir, "clone.lock"));
    expect(plan.recordPath).toBe(path.join(plan.runtimeDir, INSTANCE_RECORD_FILE));
    expect(plan.port).toBe(3301);
    expect(plan.runtimePort).toBe(3311);
    expect(plan.composeProject).toBe(instanceComposeProject("web-2"));
    expect(plan.runtimeContainer).toBe(instanceRuntimeContainer("web-2"));
    expect(plan.queueName).toBe(instanceQueueName("web-2"));
    expect(plan.queueName).toBe(coUseQueueName("web-2"));
    expect(plan.label).toBe('Instance "web-2"');
    // The named instance points the app at its OWN port, its OWN runtime and
    // its OWN queue — through the product's own keys.
    expect(plan.envOverrides).toEqual({
      PORT: "3301",
      WAYFLOW_BASE_URL: "http://localhost:3311",
      BULLMQ_QUEUE_NAME: instanceQueueName("web-2"),
    });
  });

  it("two slugs share no path, no container name, no queue and no port", () => {
    const home = mkHome();
    const a = resolveInstanceStartPlan({ argv: ["--instance", "web-a", "--port", "3301", "--runtime-port", "3311"], env: {}, home });
    const b = resolveInstanceStartPlan({ argv: ["--instance", "web-b", "--port", "3302", "--runtime-port", "3312"], env: {}, home });

    for (const key of ["runtimeDir", "pidPath", "logPath", "lockPath", "recordPath", "composeProject", "runtimeContainer", "queueName"]) {
      expect(a[key]).not.toBe(b[key]);
    }
    expect(a.port).not.toBe(b.port);
    expect(a.runtimePort).not.toBe(b.runtimePort);
    // …and neither shares anything with the single-instance default.
    const main = resolveInstanceStartPlan({ argv: [], env: {}, home });
    expect(main.runtimeDir).not.toBe(a.runtimeDir);
    expect(main.port).not.toBe(a.port);
  });

  it("an explicit port wins over the instance's environment; an absent one falls back to it", () => {
    const home = mkHome();
    const env = { PORT: "3456", WAYFLOW_BASE_URL: "http://localhost:3466" };
    const explicit = resolveInstanceStartPlan({ argv: ["--instance", "web-2", "--port", "3301", "--runtime-port", "3311"], env, home });
    expect(explicit.port).toBe(3301);
    expect(explicit.runtimePort).toBe(3311);

    const inherited = resolveInstanceStartPlan({ argv: ["--instance", "web-2"], env, home });
    expect(inherited.port).toBe(3456);
    expect(inherited.runtimePort).toBe(3466);
    // Nothing the environment already says is rewritten.
    expect(inherited.envOverrides.PORT).toBeUndefined();
    expect(inherited.envOverrides.WAYFLOW_BASE_URL).toBeUndefined();
  });

  it("keeps the queue the instance's own environment names", () => {
    const home = mkHome();
    const plan = resolveInstanceStartPlan({
      argv: ["--instance", "web-2"],
      env: { BULLMQ_QUEUE_NAME: "operator-named" },
      home,
    });
    expect(plan.queueName).toBe("operator-named");
    expect(plan.envOverrides.BULLMQ_QUEUE_NAME).toBeUndefined();
  });

  it("puts the chosen bind address in the spawned argument list", () => {
    const home = mkHome();
    const plan = resolveInstanceStartPlan({ argv: ["--instance", "web-2", "--bind", "127.0.0.1"], env: {}, home });
    expect(plan.bind).toBe("127.0.0.1");
    expect(plan.spawnArgs).toEqual(["dev", "--hostname", "127.0.0.1"]);
    // The default instance can be bound too, and only then does its argument
    // list grow.
    expect(resolveInstanceStartPlan({ argv: ["--bind", "127.0.0.1"], env: {}, home }).spawnArgs)
      .toEqual(["dev", "--hostname", "127.0.0.1"]);
  });
});

// =========================================================================
describe("assertInstanceStartFree — a slug or a port another instance holds", () => {
  const plan = (argv, home) => resolveInstanceStartPlan({ argv, env: {}, home });

  it("refuses an app port a running instance already holds, naming the slug and the port", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-b", "--port", "3301", "--runtime-port", "3312"], home);
    let thrown;
    try {
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/b",
        records: [record({ slug: "web-a", port: 3301, runtimePort: 3311 })],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toContain("web-a");
    expect(thrown.message).toContain("3301");
    // The refusal says who holds it and what to do — never the holder's
    // checkout path or anything else out of its record.
    expect(thrown.message).not.toContain("/checkout/other");
    expect(thrown.message).not.toContain("/checkout/b");
  });

  it("refuses a runtime port a running instance already holds", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-b", "--port", "3302", "--runtime-port", "3311"], home);
    expect(() =>
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/b",
        records: [record({ slug: "web-a", port: 3301, runtimePort: 3311 })],
      }),
    ).toThrow(/web-a[\s\S]*3311|3311[\s\S]*web-a/);
  });

  it("refuses a port held as the OTHER kind of port by a running instance", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-b", "--port", "3311", "--runtime-port", "3399"], home);
    expect(() =>
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/b",
        records: [record({ slug: "web-a", port: 3301, runtimePort: 3311 })],
      }),
    ).toThrow(/3311/);
  });

  it("refuses the same slug running from another checkout, naming the slug", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-a", "--port", "3399", "--runtime-port", "3398"], home);
    expect(() =>
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/b",
        records: [record({ slug: "web-a", port: 3301, runtimePort: 3311, repoRoot: "/checkout/a" })],
      }),
    ).toThrow(/web-a/);
  });

  it("lets an instance start beside others that hold different slugs and ports", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-b", "--port", "3302", "--runtime-port", "3312"], home);
    expect(() =>
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/b",
        records: [
          record({ slug: "web-a", port: 3301, runtimePort: 3311 }),
          record({ slug: "web-c", port: 3303, runtimePort: 3313 }),
        ],
      }),
    ).not.toThrow();
  });

  it("never refuses an instance because of its OWN record (a re-run of the same start)", () => {
    const home = mkHome();
    const target = plan(["--instance", "web-a", "--port", "3301", "--runtime-port", "3311"], home);
    expect(() =>
      assertInstanceStartFree(target, {
        repoRoot: "/checkout/a",
        records: [record({ slug: "web-a", port: 3301, runtimePort: 3311, repoRoot: "/checkout/a" })],
      }),
    ).not.toThrow();
  });
});

// =========================================================================
describe("the instance record — what makes a running instance knowable", () => {
  it("writes a record under the instance's own runtime directory and reads it back", () => {
    const home = mkHome();
    const target = resolveInstanceStartPlan({ argv: ["--instance", "web-2", "--port", "3301", "--runtime-port", "3311"], env: {}, home });
    writeInstanceRecord(target, { pid: LIVE_PID, home });

    expect(instanceRecordPath("web-2", { home })).toBe(target.recordPath);
    const read = readInstanceRecord("web-2", { home });
    expect(read).toMatchObject({
      slug: "web-2",
      pid: LIVE_PID,
      port: 3301,
      runtimePort: 3311,
      composeProject: instanceComposeProject("web-2"),
      runtimeContainer: instanceRuntimeContainer("web-2"),
      queueName: instanceQueueName("web-2"),
    });

    clearInstanceRecord("web-2", { home });
    expect(readInstanceRecord("web-2", { home })).toBeNull();
  });

  it("lists only the instances whose process is still alive", () => {
    const home = mkHome();
    const live = resolveInstanceStartPlan({ argv: ["--instance", "web-live", "--port", "3301", "--runtime-port", "3311"], env: {}, home });
    const dead = resolveInstanceStartPlan({ argv: ["--instance", "web-dead", "--port", "3302", "--runtime-port", "3312"], env: {}, home });
    writeInstanceRecord(live, { pid: LIVE_PID, home });
    writeInstanceRecord(dead, { pid: DEAD_PID, home });

    const listed = listInstanceRecords({ home });
    expect(listed.map((r) => r.slug)).toEqual(["web-live"]);

    // A dead record is never a refusal — the start repairs it.
    const target = resolveInstanceStartPlan({ argv: ["--instance", "web-new", "--port", "3302", "--runtime-port", "3312"], env: {}, home });
    expect(() => assertInstanceStartFree(target, { repoRoot: "/checkout/new", records: listed })).not.toThrow();
  });

  // A record outlives the machine: a crash or a reboot leaves it behind, and the
  // pid it names is eventually handed to something else entirely. `kill -0`
  // answers "alive" for that stranger, so the start verb asks the command-line
  // probe instead — otherwise a start whose ports are free is refused in the
  // name of an instance that stopped running days ago.
  it("a recycled pid is not a running instance: the command-line probe says so", async () => {
    // A live process that is certainly NOT a dev server, standing in for the
    // unrelated process a recycled pid now belongs to.
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      expect(stranger.pid).toBeGreaterThan(0);
      // The bare liveness answer — the one that would refuse the start.
      expect(isPidAlive(stranger.pid)).toBe(true);
      // The probe the verb actually uses.
      expect(isInstanceProcessRunning(stranger.pid)).toBe(false);
      expect(isInstanceProcessRunning(DEAD_PID)).toBe(false);

      const home = mkHome();
      const held = resolveInstanceStartPlan({
        argv: ["--instance", "web-gone", "--port", "3301", "--runtime-port", "3311"],
        env: {},
        home,
      });
      writeInstanceRecord(held, { pid: stranger.pid, home });

      // With the bare probe the record still counts (today's refusal)…
      expect(listInstanceRecords({ home }).map((r) => r.slug)).toEqual(["web-gone"]);
      // …and with the verb's probe it does not, so the port is free again.
      const listed = listInstanceRecords({ home, isAlive: isInstanceProcessRunning });
      expect(listed).toEqual([]);
      const target = resolveInstanceStartPlan({
        argv: ["--instance", "web-new", "--port", "3301", "--runtime-port", "3311"],
        env: {},
        home,
      });
      expect(() => assertInstanceStartFree(target, { repoRoot: "/checkout/new", records: listed })).not.toThrow();
    } finally {
      try { stranger.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("the start verb passes the command-line probe, not bare liveness", () => {
    expect(INDEX_SRC).toMatch(/listInstanceRecords\(\{\s*isAlive: isInstanceProcessRunning\s*,?\s*\}\)/);
  });

  it("ignores unreadable and foreign files in the state root", () => {
    const home = mkHome();
    const dir = path.join(home, ".cinatra", "clones", "web-junk");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, INSTANCE_RECORD_FILE), "{not json", "utf8");
    mkdirSync(path.join(home, ".cinatra", "clones", "web-none"), { recursive: true });
    expect(listInstanceRecords({ home })).toEqual([]);
  });

  it("has nothing to list when no instance was ever started", () => {
    expect(listInstanceRecords({ home: mkHome() })).toEqual([]);
  });
});

// =========================================================================
describe("stop and restart select the same instance", () => {
  it("resolves the selected instance's pid file, log and lock", () => {
    const home = mkHome();
    const stopPlan = resolveInstanceStartPlan({ argv: ["--instance", "web-2"], env: {}, home });
    expect(stopPlan.pidPath).toBe(clonePidPath("web-2", { home }));
    expect(stopPlan.lockPath).toBe(cloneLockPath("web-2", { home }));
    expect(stopPlan.logPath).toBe(cloneLogPath("web-2", { home }));
  });

  it("the source resolves stop and restart through the same selector", () => {
    expect(INDEX_SRC).toMatch(/async function runDevStop\(argv[\s\S]{0,400}resolveInstanceTarget\(argv\)/);
    expect(INDEX_SRC).toMatch(/async function runDevRestart\(argv[\s\S]{0,900}resolveInstanceTarget\(argv\)/);
  });
});
