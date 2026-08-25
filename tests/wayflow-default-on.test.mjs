// cinatra#2654 — the WayFlow agent runtime starts with every install-owned
// local compose stack.
//
// The defect this locks shut: `wayflow` is profile-gated, the install `up`
// activated no profile, so a fresh install had nothing on :3010 and EVERY agent
// run died with ECONNREFUSED. Proving the fix needs four separate things, and
// each one silently restores the bug on its own:
//   1. the decision (which plans own a local runtime, and what --no-wayflow does),
//   2. the `up` argv actually carrying `--profile wayflow`,
//   3. the two pre-`up` steps (bridge-token env, image build) running BEFORE it
//      and failing LOUDLY, and
//   4. the recorded decision that lets `cinatra doctor` tell a lean install
//      apart from a broken one.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WAYFLOW_RUNTIME_EXTERNAL,
  WAYFLOW_RUNTIME_KEY,
  WAYFLOW_RUNTIME_LOCAL,
  WAYFLOW_RUNTIME_OFF,
  buildWayflowImage,
  generateWayflowEnv,
  normalizeWayflowRuntimeMode,
  resolveRecordedComposeContext,
  resolveWayflowRuntimeMode,
  waitForWayflowHealth,
  wayflowBuildFailureMessage,
  wayflowStatusLines,
} from "../src/wayflow-runtime.mjs";

const procControl = vi.hoisted(() => ({ calls: [], failBuild: false }));

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("spawn is not expected in this test");
  },
  execFileSync: () => "",
  spawnSync: (command, args = [], options = {}) => {
    procControl.calls.push({ command, args, cwd: options?.cwd ?? null });
    if (procControl.failBuild && command === "docker" && args.includes("build")) {
      return { status: 7, stdout: "", stderr: "failed to solve: dockerfile parse error" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

const { bringUpInfra, parseInstallArgs, recordWayflowRuntimeMode } = await import("../src/install.mjs");

// ---------------------------------------------------------------------------
// 1. The decision.
// ---------------------------------------------------------------------------

describe("resolveWayflowRuntimeMode — who owns a local runtime", () => {
  it("every install-owned local-stack plan defaults to starting the runtime", () => {
    for (const infraPlan of ["default", "isolated", "attach"]) {
      expect(resolveWayflowRuntimeMode({ infraPlan })).toBe(WAYFLOW_RUNTIME_LOCAL);
      expect(resolveWayflowRuntimeMode({ infraPlan, wayflow: true })).toBe(WAYFLOW_RUNTIME_LOCAL);
    }
  });

  it("--no-wayflow turns an install-owned stack into a recorded opt-out", () => {
    for (const infraPlan of ["default", "isolated", "attach"]) {
      expect(resolveWayflowRuntimeMode({ infraPlan, wayflow: false })).toBe(WAYFLOW_RUNTIME_OFF);
    }
  });

  it("a plan that owns no local stack never claims a runtime, with or without the flag", () => {
    for (const infraPlan of ["external", "co-use"]) {
      expect(resolveWayflowRuntimeMode({ infraPlan })).toBe(WAYFLOW_RUNTIME_EXTERNAL);
      expect(resolveWayflowRuntimeMode({ infraPlan, wayflow: false })).toBe(WAYFLOW_RUNTIME_EXTERNAL);
    }
  });

  it("an absent or unrecognised recorded value reads as `local` — default-on is the contract", () => {
    expect(normalizeWayflowRuntimeMode(undefined)).toBe(WAYFLOW_RUNTIME_LOCAL);
    expect(normalizeWayflowRuntimeMode("")).toBe(WAYFLOW_RUNTIME_LOCAL);
    expect(normalizeWayflowRuntimeMode("banana")).toBe(WAYFLOW_RUNTIME_LOCAL);
    expect(normalizeWayflowRuntimeMode(" OFF ")).toBe(WAYFLOW_RUNTIME_OFF);
    expect(normalizeWayflowRuntimeMode("external")).toBe(WAYFLOW_RUNTIME_EXTERNAL);
  });
});

describe("parseInstallArgs — the --no-wayflow surface", () => {
  it("defaults to starting the runtime", () => {
    expect(parseInstallArgs(["--mode", "dev", "--dir", "/tmp/x"]).wayflow).toBe(true);
    expect(parseInstallArgs(["--mode", "demo", "--dir", "/tmp/x"]).wayflow).toBe(true);
    expect(parseInstallArgs(["--mode", "prod", "--dir", "/tmp/x"]).wayflow).toBe(true);
  });

  it("accepts --no-wayflow as the opt-out on every mode, preview included", () => {
    for (const mode of ["dev", "prod", "demo", "preview"]) {
      expect(parseInstallArgs(["--mode", mode, "--dir", "/tmp/x", "--no-wayflow"]).wayflow).toBe(false);
    }
  });
});

describe("wayflowStatusLines — every mode says something explicit", () => {
  it("names the endpoint when the runtime was started", () => {
    expect(wayflowStatusLines(WAYFLOW_RUNTIME_LOCAL).join(" ")).toContain("http://localhost:3010");
  });

  it("names the opt-out, not silence, on a lean install", () => {
    const text = wayflowStatusLines(WAYFLOW_RUNTIME_OFF).join(" ");
    expect(text).toContain("--no-wayflow");
    expect(text).toContain("cinatra instance wayflow start");
  });

  it("states non-ownership on an install with no local stack", () => {
    const text = wayflowStatusLines(WAYFLOW_RUNTIME_EXTERNAL).join(" ");
    expect(text).toContain("NOT owned by this install");
    expect(text).toContain("WAYFLOW_BASE_URL");
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. The bring-up: profile on the `up`, and the two pre-`up` steps.
// ---------------------------------------------------------------------------

describe("bringUpInfra — WayFlow rides every install-owned bring-up", () => {
  let dir;
  let logged;
  const log = (line) => logged.push(String(line));

  beforeEach(() => {
    procControl.calls = [];
    procControl.failBuild = false;
    dir = mkdtempSync(path.join(os.tmpdir(), "wayflow-default-"));
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });
    logged = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const baseDeps = () => ({
    assertRecreateSafe: () => {},
    ensureNangoSecretKey: () => null,
    waitForWayflowHealth: () => ({ healthy: true, state: "Up (healthy)" }),
  });

  const dockerCalls = () => procControl.calls.filter((c) => c.command === "docker");
  const upCall = () => dockerCalls().find((c) => c.args.includes("up"));
  const buildCall = () => dockerCalls().find((c) => c.args.includes("build"));

  it("the `up` carries --profile wayflow, scoped to the caller's project + files", () => {
    bringUpInfra({
      slug: "demo",
      deps: { ...baseDeps(), generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }) },
      targetDir: dir,
      log,
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      composeProject: "cinatra_demo",
      envFile: path.join(dir, ".env.local"),
    });
    const up = upCall();
    expect(up).toBeTruthy();
    const profileAt = up.args.indexOf("--profile");
    expect(profileAt).toBeGreaterThan(-1);
    expect(up.args[profileAt + 1]).toBe("wayflow");
    // The profile is a TOP-LEVEL flag: it must sit before the subcommand, or
    // compose rejects it.
    expect(profileAt).toBeLessThan(up.args.indexOf("up"));
    expect(up.args).toContain("cinatra_demo");
  });

  it("--no-wayflow leaves the `up` byte-identical to the pre-default-on invocation", () => {
    bringUpInfra({
      slug: "demo",
      deps: baseDeps(),
      targetDir: dir,
      log,
      composeProject: "cinatra_demo",
      wayflow: false,
    });
    const up = upCall();
    expect(up.args).not.toContain("--profile");
    expect(buildCall()).toBeUndefined();
    expect(logged.join("\n")).toContain("--no-wayflow");
  });

  it("the bridge-token env and the image build BOTH run before the `up`", () => {
    const order = [];
    bringUpInfra({
      slug: "demo",
      deps: {
        ...baseDeps(),
        generateWayflowEnv: () => {
          order.push("gen-env");
          return { ok: true, skipped: false, reason: null };
        },
        buildWayflowImage: () => {
          order.push("build");
          return { ok: true, stderr: "", status: 0 };
        },
      },
      targetDir: dir,
      log,
      composeProject: "cinatra_demo",
    });
    order.push("up");
    expect(order).toEqual(["gen-env", "build", "up"]);
  });

  it("a failed bridge-token generation ABORTS — never a container that cannot authenticate", () => {
    expect(() =>
      bringUpInfra({
        slug: "demo",
        deps: {
          ...baseDeps(),
          generateWayflowEnv: () => ({ ok: false, skipped: false, reason: "gen-wayflow-env.mjs failed (exit 1)" }),
        },
        targetDir: dir,
        log,
        composeProject: "cinatra_demo",
      }),
    ).toThrow(/CINATRA_BRIDGE_TOKEN|gen-wayflow-env/);
    expect(upCall()).toBeUndefined();
  });

  it("a failed image build fails the install LOUDLY, names the retry, and starts nothing", () => {
    procControl.failBuild = true;
    let thrown = null;
    try {
      bringUpInfra({
        slug: "demo",
        deps: { ...baseDeps(), generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }) },
        targetDir: dir,
        log,
        composeProject: "cinatra_demo",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.message).toContain("WayFlow agent-runtime image failed to build");
    expect(thrown.message).toContain("dockerfile parse error");
    // Safely rerunnable: the message names BOTH recoveries.
    expect(thrown.message).toContain("cinatra install");
    expect(thrown.message).toContain("--no-wayflow");
    // The stack never came up behind a broken runtime.
    expect(upCall()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The two side-effecting steps, in isolation.
// ---------------------------------------------------------------------------

describe("generateWayflowEnv", () => {
  // The generated file the container actually reads. cinatra#2654 D1: the
  // result is judged by THIS file, not by the generator's exit code.
  // cinatra#2654 D1: the postcondition is the REQUIRED key set, not the token
  // alone — a file missing CINATRA_CONTEXT_ATTEST_KEY yields a runtime that
  // starts and then fails closed on every context callback.
  const wroteToken = () =>
    "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\nCINATRA_CONTEXT_ATTEST_KEY=fixture-attest-key\n" +
    "WAYFLOW_BASE_URL=http://localhost:3010\n";
  const wroteNothing = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };

  it("runs the checkout's own generator with --require-bridge-token", () => {
    const seen = [];
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: wroteToken,
      spawnImpl: (cmd, args, opts) => {
        seen.push({ cmd, args, cwd: opts?.cwd });
        return { status: 0 };
      },
      execPath: "/usr/bin/node",
    });
    expect(res.ok).toBe(true);
    expect(seen[0].args[0]).toBe(path.join("/repo", "scripts", "gen-wayflow-env.mjs"));
    expect(seen[0].args).toContain("--require-bridge-token");
    expect(seen[0].cwd).toBe("/repo");
  });

  it("a generator that exists and FAILS is not ok (the caller must abort)", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: wroteToken,
      spawnImpl: () => ({ status: 3 }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("exit 3");
  });

  it("cinatra#2654: a generator that exits 0 without writing the token is NOT ok", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: wroteNothing,
      spawnImpl: () => ({ status: 0 }),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain(".wayflow.env");
    expect(res.reason).toContain("CINATRA_BRIDGE_TOKEN");
  });

  it("cinatra#2654: an EMPTY bridge token in the written file is NOT ok", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: () => "CINATRA_BRIDGE_TOKEN=\nWAYFLOW_BASE_URL=http://localhost:3010\n",
      spawnImpl: () => ({ status: 0 }),
    });
    expect(res.ok).toBe(false);
  });

  it("an older checkout without the generator warns and proceeds — IF the env file already supplies the token", () => {
    const lines = [];
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: (l) => lines.push(String(l)),
      existsImpl: () => false,
      readImpl: wroteToken,
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
    });
    expect(res).toEqual({ ok: true, skipped: true, reason: "generator-absent" });
    expect(lines.join("\n")).toContain("gen-wayflow-env.mjs");
  });

  it("cinatra#2654: a PARTIAL file (bridge token only) is NOT ok — the required set is checked", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: () => "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\n",
      spawnImpl: () => ({ status: 0 }),
    });
    expect(res.ok).toBe(false);
    // Named, so the operator knows WHICH key the generator failed to write.
    expect(res.reason).toContain("CINATRA_CONTEXT_ATTEST_KEY");
    expect(res.reason).not.toContain("CINATRA_BRIDGE_TOKEN");
  });

  it("cinatra#2654: a missing EXPECTED key (WAYFLOW_BASE_URL) WARNS by name and still succeeds", () => {
    const lines = [];
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: (l) => lines.push(String(l)),
      existsImpl: () => true,
      readImpl: () => "CINATRA_BRIDGE_TOKEN=t\nCINATRA_CONTEXT_ATTEST_KEY=k\n",
      spawnImpl: () => ({ status: 0 }),
    });
    expect(res.ok).toBe(true);
    expect(lines.join("\n")).toContain("WAYFLOW_BASE_URL");
  });

  it("cinatra#2654: an unset OPENAI_API_KEY is never a reason to fail (legitimately absent)", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => true,
      readImpl: wroteToken,
      spawnImpl: () => ({ status: 0 }),
    });
    expect(res.ok).toBe(true);
  });

  it("cinatra#2654: no generator AND no usable env file is a FAILURE, not a warning", () => {
    const res = generateWayflowEnv({
      targetDir: "/repo",
      log: () => {},
      existsImpl: () => false,
      readImpl: wroteNothing,
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("absent");
  });
});

describe("buildWayflowImage", () => {
  it("builds only the wayflow service, under the caller's compose args", () => {
    const seen = [];
    const res = buildWayflowImage({
      targetDir: "/repo",
      composeArgs: ["compose", "-p", "cinatra_demo", "--profile", "wayflow", "-f", "docker-compose.yml"],
      log: () => {},
      spawnImpl: (cmd, args) => {
        seen.push({ cmd, args });
        return { status: 0, stderr: "" };
      },
    });
    expect(res.ok).toBe(true);
    expect(seen[0].cmd).toBe("docker");
    expect(seen[0].args.slice(-2)).toEqual(["build", "wayflow"]);
    expect(seen[0].args).toContain("cinatra_demo");
  });

  it("the failure message keeps the real build stderr", () => {
    const msg = wayflowBuildFailureMessage({ status: 7, stderr: "ERROR: no such file" });
    expect(msg).toContain("exit 7");
    expect(msg).toContain("ERROR: no such file");
  });
});

describe("waitForWayflowHealth", () => {
  it("returns healthy as soon as docker reports (healthy)", () => {
    let n = 0;
    const res = waitForWayflowHealth({
      project: "cinatra_demo",
      attempts: 5,
      sleepImpl: () => {},
      spawnImpl: () => {
        n += 1;
        return { stdout: n < 3 ? "Up 2 seconds (health: starting)" : "Up 30 seconds (healthy)" };
      },
    });
    expect(res.healthy).toBe(true);
    expect(n).toBe(3);
  });

  it("gives up after the bounded attempts and reports the last state", () => {
    const res = waitForWayflowHealth({
      project: "cinatra_demo",
      attempts: 2,
      sleepImpl: () => {},
      spawnImpl: () => ({ stdout: "Up 5 seconds (health: starting)" }),
    });
    expect(res.healthy).toBe(false);
    expect(res.state).toContain("health: starting");
  });

  it("without a known project there is nothing to wait on", () => {
    expect(
      waitForWayflowHealth({
        project: null,
        spawnImpl: () => {
          throw new Error("must not probe");
        },
      }),
    ).toEqual({ healthy: false, state: null });
  });
});

// ---------------------------------------------------------------------------
// 4. The recorded decision + the recorded compose project.
// ---------------------------------------------------------------------------

describe("recordWayflowRuntimeMode", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wayflow-record-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts the decision into .env.local", () => {
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });
    recordWayflowRuntimeMode({ targetDir: dir, mode: WAYFLOW_RUNTIME_OFF, log: () => {} });
    let body = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(body).toMatch(new RegExp(`^${WAYFLOW_RUNTIME_KEY}=off$`, "m"));
    // A later run reconciles the SAME key rather than appending a second line.
    recordWayflowRuntimeMode({ targetDir: dir, mode: WAYFLOW_RUNTIME_LOCAL, log: () => {} });
    body = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(body.match(new RegExp(`^${WAYFLOW_RUNTIME_KEY}=`, "gm"))).toHaveLength(1);
    expect(body).toMatch(new RegExp(`^${WAYFLOW_RUNTIME_KEY}=local$`, "m"));
  });

  it("is a no-op without an .env.local (dry-run / checkout-only install)", () => {
    expect(recordWayflowRuntimeMode({ targetDir: dir, mode: WAYFLOW_RUNTIME_LOCAL, log: () => {} })).toEqual({
      recorded: false,
      mode: WAYFLOW_RUNTIME_LOCAL,
    });
  });
});

describe("resolveRecordedComposeContext — never the checkout basename by accident", () => {
  const registry = {
    instances: {
      demo: {
        slug: "demo",
        installDir: "/home/dev/cinatra",
        composeProject: "cinatra_demo",
        composeFiles: ["docker-compose.yml", "docker-compose.dev.yml", "docker-compose.isolated.yml"],
      },
    },
  };
  const readRegistry = () => registry;
  const findByInstallDir = (reg, dir) =>
    Object.values(reg.instances).find((r) => path.resolve(r.installDir) === path.resolve(dir)) ?? null;

  it("uses the RECORDED project and compose files when the checkout has an install row", () => {
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/home/dev/cinatra",
      fallbackProject: "cinatra",
      readRegistry,
      findByInstallDir,
    });
    expect(ctx.project).toBe("cinatra_demo");
    expect(ctx.composeFiles).toContain("docker-compose.isolated.yml");
    expect(ctx.source).toBe("registry");
  });

  it("falls back to the basename-derived project when nothing is recorded", () => {
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/somewhere/else",
      fallbackProject: "cinatra",
      readRegistry,
      findByInstallDir,
    });
    expect(ctx).toEqual({
      project: "cinatra",
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      source: "fallback",
      // cinatra-cli#230: no row found, so there is no instance to name.
      slug: null,
      // cinatra-cli#230 review: the registry WAS read and holds no row for this
      // checkout — a settled fact, distinct from having failed to read it.
      reason: "no-record",
    });
  });

  it("a broken registry never breaks the lifecycle command — and says it was unreadable", () => {
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/home/dev/cinatra",
      fallbackProject: "cinatra",
      readRegistry: () => {
        throw new Error("malformed registry");
      },
      findByInstallDir,
    });
    expect(ctx.source).toBe("fallback");
    expect(ctx.project).toBe("cinatra");
    // cinatra-cli#230 review: NOT "no-record". Whether a row exists is unknown,
    // and a caller that conflates the two states it as fact that this checkout
    // is unmanaged.
    expect(ctx.reason).toBe("registry-unreadable");
  });

  it("a registry that reads back as null is unreadable, not an empty registry", () => {
    // The production reader returns `registry: null` for a malformed FILE
    // (rather than throwing), so this is the shape the doctor actually sees.
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/home/dev/cinatra",
      fallbackProject: "cinatra",
      readRegistry: () => null,
      findByInstallDir,
    });
    expect(ctx.source).toBe("fallback");
    expect(ctx.reason).toBe("registry-unreadable");
  });

  it("a row that records no project reports its own distinct reason", () => {
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/home/dev/cinatra",
      fallbackProject: "cinatra",
      readRegistry: () => ({ instances: { demo: { slug: "demo", installDir: "/home/dev/cinatra" } } }),
      findByInstallDir,
    });
    expect(ctx.source).toBe("fallback");
    // A record EXISTS — reporting "no-record" here would be false too.
    expect(ctx.reason).toBe("row-without-project");
    expect(ctx.slug).toBe("demo");
  });

  it("reason is null when the project really came from the registry", () => {
    const ctx = resolveRecordedComposeContext({
      repoRoot: "/home/dev/cinatra",
      fallbackProject: "cinatra",
      readRegistry,
      findByInstallDir,
    });
    expect(ctx.source).toBe("registry");
    expect(ctx.reason).toBe(null);
  });
});
