// cinatra-cli#306: the status readings of two sites, with the result of the
// bounded spawn given by the test.
//
// - waitForService (src/index.mjs) spawns through node:child_process, which
//   this file mocks. The mock's spawnSync is not Node's own, so spawnBounded
//   gives it the plain bounded call (the bound in its options), and the row's
//   answer is the result.
// - restartWayflowService (src/wayflow-agent-mount.mjs) takes its spawnSync
//   as a dependency.
//
// A result that childResultRefused refuses (a spawn error, an expired bound,
// a signal) is never read as a status, also when it carries status 0. Through
// Node's own spawnSync the watchdog makes an expired bound a signal death with
// no status; a status 0 with an error or a signal comes from the plain bounded
// spawn (an injected or mocked spawn, and win32), so it is given here.
// The rows that main's code passes too (an exit 1, a signal death with no
// status, a clean exit 0) are in the last describe, without the issue's name.
import { describe, it, expect, vi, afterAll } from "vitest";

const probe = vi.hoisted(() => ({ answer: null, calls: [] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (command, args, options) => {
      if (probe.answer === null) return actual.spawnSync(command, args, options);
      probe.calls.push({ command, args: [...(args ?? [])], options: options ?? {} });
      return command === "sleep" ? { status: 0, signal: null, error: null, stdout: "", stderr: "" } : probe.answer();
    },
  };
});

afterAll(() => {
  probe.answer = null;
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

const spawnError = (code) => Object.assign(new Error(`spawnSync docker ${code}`), { code });
const RESULT = {
  zeroWithSignal: () => ({ status: 0, signal: "SIGTERM", error: null, stdout: "", stderr: "" }),
  zeroWithError: () => ({ status: 0, signal: null, error: spawnError("ENOBUFS"), stdout: "", stderr: "" }),
  zeroWithTimeout: () => ({ status: 0, signal: null, error: spawnError("ETIMEDOUT"), stdout: "", stderr: "" }),
  exit1: () => ({ status: 1, signal: null, error: null, stdout: "", stderr: "" }),
  signalDeath: () => ({ status: null, signal: "SIGKILL", error: null, stdout: "", stderr: "" }),
  clean: () => ({ status: 0, signal: null, error: null, stdout: "", stderr: "" }),
};

/** waitForService with `answer` as every probe's result: the thrown message
 *  (or "ready"), and the calls the mock saw. */
async function waitWith(answer, attempts) {
  const { waitForService } = await import("../src/index.mjs");
  probe.calls = [];
  probe.answer = answer;
  try {
    waitForService("/nonexistent-checkout", "postgres", ["pg_isready", "-U", "postgres"], [], "Postgres", attempts);
    return { outcome: "ready", calls: probe.calls };
  } catch (err) {
    return { outcome: err.message, calls: probe.calls };
  } finally {
    probe.answer = null;
  }
}

/** restartWayflowService with `answer` as the restart's result. */
async function restartWith(answer) {
  const { restartWayflowService } = await import("../src/wayflow-agent-mount.mjs");
  const calls = [];
  const spawnSync = (command, args, options) => (calls.push({ command, args: [...args], options }), answer());
  return { value: restartWayflowService({ targetDir: "/nonexistent-target", composeArgs: ["compose"], deps: { spawnSync } }), calls };
}

const NOT_READY = "Postgres did not become ready within 2 seconds.";
const PROBE = ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres"];

describe("cinatra-cli#306 status reading: waitForService reads no status of a refused probe result", () => {
  for (const [name, answer] of [
    ["a status 0 that came with a signal", RESULT.zeroWithSignal],
    ["a status 0 that came with a spawn error", RESULT.zeroWithError],
    ["a status 0 that came with an expired bound", RESULT.zeroWithTimeout],
  ]) {
    it(`${name} is a failed attempt, never ready`, async () => {
      const r = await waitWith(answer, 2);
      expect(r.outcome).toBe(NOT_READY);
      expect(r.calls.filter((c) => c.command === "docker").map((c) => c.args)).toEqual([PROBE, PROBE]);
      expect(r.calls.filter((c) => c.command === "sleep")).toHaveLength(2);
    });
  }

  it("each probe is spawned with the probe bound (15 s) and SIGKILL, and each pause with its own 6 s bound", async () => {
    const r = await waitWith(RESULT.exit1, 1);
    expect(r.outcome).toBe("Postgres did not become ready within 1 seconds.");
    const docker = r.calls.find((c) => c.command === "docker");
    const sleep = r.calls.find((c) => c.command === "sleep");
    expect({ timeout: docker?.options.timeout, killSignal: docker?.options.killSignal, stdio: docker?.options.stdio }).toEqual({
      timeout: 15_000,
      killSignal: "SIGKILL",
      stdio: "ignore",
    });
    expect({ args: sleep?.args, timeout: sleep?.options.timeout, killSignal: sleep?.options.killSignal }).toEqual({
      args: ["1"],
      timeout: 6_000,
      killSignal: "SIGKILL",
    });
  });
});

describe("cinatra-cli#306 status reading: restartWayflowService reads no status of a refused restart result", () => {
  for (const [name, answer] of [
    ["a status 0 that came with a signal", RESULT.zeroWithSignal],
    ["a status 0 that came with a spawn error", RESULT.zeroWithError],
  ]) {
    it(`${name} is restart-exit-null, never a restart`, async () => {
      const r = await restartWith(answer);
      expect(r.value).toEqual({ ok: false, reason: "restart-exit-null" });
      expect(r.calls.map((c) => c.args)).toEqual([["compose", "restart", "wayflow"]]);
    });
  }

  it("a status 0 that came with an expired bound is the named restart-timeout, never a restart", async () => {
    const r = await restartWith(RESULT.zeroWithTimeout);
    expect(r.value).toEqual({ ok: false, reason: "restart-timeout (`docker compose` did not finish within 2 min; it was stopped.)" });
  });

  it("the restart is spawned with the compose bound (2 min) and SIGKILL", async () => {
    const r = await restartWith(RESULT.clean);
    expect(r.calls).toHaveLength(1);
    expect({ command: r.calls[0].command, timeout: r.calls[0].options.timeout, killSignal: r.calls[0].options.killSignal }).toEqual({
      command: "docker",
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
  });
});

describe("status readings that main's code passes too: kept by the bounded reading", () => {
  it("waitForService: an exit 1 and a signal death with no status are failed attempts", async () => {
    expect((await waitWith(RESULT.exit1, 2)).outcome).toBe(NOT_READY);
    expect((await waitWith(RESULT.signalDeath, 2)).outcome).toBe(NOT_READY);
  });

  it("waitForService: a clean exit 0 is ready at the first probe, with no pause", async () => {
    const r = await waitWith(RESULT.clean, 2);
    expect(r.outcome).toBe("ready");
    expect(r.calls.map((c) => c.command)).toEqual(["docker"]);
  });

  it("restartWayflowService: an exit 1 is restart-exit-1", async () => {
    expect((await restartWith(RESULT.exit1)).value).toEqual({ ok: false, reason: "restart-exit-1" });
  });

  it("restartWayflowService: a signal death with no status is restart-exit-null", async () => {
    expect((await restartWith(RESULT.signalDeath)).value).toEqual({ ok: false, reason: "restart-exit-null" });
  });

  it("restartWayflowService: a clean exit 0 is a restart", async () => {
    expect((await restartWith(RESULT.clean)).value).toEqual({ ok: true, reason: null });
  });
});
