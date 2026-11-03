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
// status, a clean exit 0) are in the last describe, without the issue's name;
// the pause control is in a describe of its own, also without it.
//
// The pauses (pauseBounded in src/child-bound.mjs, used by waitForService,
// waitForWayflowHealth and the nango backoff): a `sleep` child that does not
// exit 0 cleanly (a signal, a non-zero exit, a spawn error, an expired bound)
// ends no pause early; the time left is kept in-process. Each row measures the
// pause against its length; a clean exit 0 ends it at once (`sleep` exits 0
// only once its time is up).
import { describe, it, expect, vi, afterAll } from "vitest";

const probe = vi.hoisted(() => ({ answer: null, sleepAnswer: null, calls: [] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: (command, args, options) => {
      if (probe.answer === null) return actual.spawnSync(command, args, options);
      probe.calls.push({ command, args: [...(args ?? [])], options: options ?? {} });
      if (command === "sleep") return probe.sleepAnswer ? probe.sleepAnswer() : { status: 0, signal: null, error: null, stdout: "", stderr: "" };
      return probe.answer();
    },
  };
});

afterAll(() => {
  probe.answer = null;
  probe.sleepAnswer = null;
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
/** The answers of a `sleep` child that must not end a pause early. */
const SLEEP_UNCLEAN = [
  ["a signal death", RESULT.signalDeath],
  ["a status 0 that came with a signal", RESULT.zeroWithSignal],
  ["a non-zero exit", RESULT.exit1],
  ["a spawn error", () => ({ status: null, signal: null, error: spawnError("ENOENT"), stdout: "", stderr: "" })],
  ["an expired bound", RESULT.zeroWithTimeout],
];
/** A pause of 1 s is kept when it lasts at least this long (sleepSync waits at least its time). */
const ONE_PAUSE_MS = 950;

/** waitForService with `answer` as every probe's result (and `sleepAnswer`
 *  as every pause child's): the thrown message (or "ready"), the calls the
 *  mock saw, and how long the call took. */
async function waitWith(answer, attempts, sleepAnswer = null) {
  const { waitForService } = await import("../src/index.mjs");
  probe.calls = [];
  probe.answer = answer;
  probe.sleepAnswer = sleepAnswer;
  const t0 = performance.now();
  try {
    waitForService("/nonexistent-checkout", "postgres", ["pg_isready", "-U", "postgres"], [], "Postgres", attempts);
    return { outcome: "ready", calls: probe.calls, ms: performance.now() - t0 };
  } catch (err) {
    return { outcome: err.message, calls: probe.calls, ms: performance.now() - t0 };
  } finally {
    probe.answer = null;
    probe.sleepAnswer = null;
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

  it("each probe is spawned with the probe bound (15 s) and SIGKILL, and each pause with its length plus 1 s", async () => {
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
      timeout: 2_000,
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

describe("cinatra-cli#306 pauses: a `sleep` child that does not exit 0 cleanly ends no pause early", () => {
  for (const [name, answer] of SLEEP_UNCLEAN) {
    it(`pauseBounded: ${name} of the sleep child still keeps the whole pause`, async () => {
      const { pauseBounded } = await import("../src/child-bound.mjs");
      const calls = [];
      const t0 = performance.now();
      pauseBounded((command, args, options) => (calls.push({ command, args: [...args], options }), answer()), 1);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(ONE_PAUSE_MS);
      expect(calls.map((c) => [c.command, c.args, c.options.timeout, c.options.killSignal])).toEqual([["sleep", ["1"], 2_000, "SIGKILL"]]);
    });
  }

  it("waitForService: a pause whose sleep child dies by a signal still takes its 1 s", async () => {
    const r = await waitWith(RESULT.exit1, 1, RESULT.signalDeath);
    expect(r.outcome).toBe("Postgres did not become ready within 1 seconds.");
    expect(r.calls.map((c) => c.command)).toEqual(["docker", "sleep"]);
    expect(r.ms).toBeGreaterThanOrEqual(ONE_PAUSE_MS);
  });

  it("waitForWayflowHealth: a pause whose sleep child exits non-zero still takes its 1 s", async () => {
    const { waitForWayflowHealth } = await import("../src/wayflow-runtime.mjs");
    const seen = [];
    const spawnImpl = (command) => (seen.push(command), command === "sleep" ? RESULT.exit1() : RESULT.exit1());
    const t0 = performance.now();
    const res = waitForWayflowHealth({ project: "cinatra_probe", attempts: 1, intervalMs: 1_000, spawnImpl });
    expect(res).toEqual({ healthy: false, state: null });
    expect(seen).toEqual(["docker", "sleep"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(ONE_PAUSE_MS);
  });

  it("the nango backoff: a pause whose sleep child gives a spawn error still takes its 1 s", async () => {
    const { readSeededNangoSecretKey } = await import("../src/nango-secret-key.mjs");
    probe.calls = [];
    probe.answer = RESULT.clean; // no docker call is expected; the transport is the test's own
    probe.sleepAnswer = () => ({ status: null, signal: null, error: spawnError("ENOENT"), stdout: "", stderr: "" });
    const queries = [];
    const transport = { query: (sql) => (queries.push(sql), { status: 1, stdout: "", stderr: "" }) };
    const t0 = performance.now();
    try {
      const res = readSeededNangoSecretKey({ transport, environmentName: "dev", attempts: 2, intervalSeconds: 1, deadlineMs: 60_000 });
      expect(res).toEqual({ ok: false, secretKey: null });
      expect(performance.now() - t0).toBeGreaterThanOrEqual(ONE_PAUSE_MS);
      expect(probe.calls.map((c) => c.command)).toEqual(["sleep"]);
      expect(queries.length).toBeGreaterThan(2);
    } finally {
      probe.answer = null;
      probe.sleepAnswer = null;
    }
  });
});

// The control of the pause rows above: pauseBounded is new here, so main has
// no such row; it is outside the issue's name because it shows no defect.
describe("the pause control: a clean exit 0 of the sleep child", () => {
  it("pauseBounded: a clean exit 0 of the sleep child ends the pause there (sleep exits 0 only once its time is up)", async () => {
    const { pauseBounded } = await import("../src/child-bound.mjs");
    const t0 = performance.now();
    pauseBounded(() => RESULT.clean(), 1);
    expect(performance.now() - t0).toBeLessThan(ONE_PAUSE_MS);
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
