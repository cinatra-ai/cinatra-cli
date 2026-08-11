// `cinatra instance wayflow start|stop` — unit tests for the pure/injectable
// seams: the compose invocation shape and the bridge-token env-generation gate.
//
// The compose-args contract mirrors the CMS commands' CRITICAL SCOPING rule:
//   - start ENABLES the profile-gated service (`--profile wayflow`) and scopes
//     `up` to ONLY that service, with `--build` (the image builds from
//     ./docker/wayflow — there is no registry image to pull).
//   - stop is `rm -sf wayflow` — never `down`, never profile-wide (an unscoped
//     `--profile wayflow down` would also tear down the always-on dev infra).
//
// The env gate: without docker/wayflow/.wayflow.env the runtime crash-loops on
// a missing CINATRA_BRIDGE_TOKEN, so `start` runs the checkout's generator
// first and must ABORT when the generator exists and fails.

import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  composeWayflowArgs,
  ensureWayflowBridgeEnv,
  effectiveComposeProjectName,
} from "../src/index.mjs";

describe("composeWayflowArgs", () => {
  it("start: profile-enabled, scoped to the single wayflow service, with --build", () => {
    expect(composeWayflowArgs("start")).toEqual([
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.dev.yml",
      "--profile",
      "wayflow",
      "up",
      "-d",
      "--build",
      "wayflow",
    ]);
  });

  it("stop: rm -sf on the single service — never `down`, never profile-wide", () => {
    const args = composeWayflowArgs("stop");
    expect(args).toEqual([
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.dev.yml",
      "rm",
      "-sf",
      "wayflow",
    ]);
    expect(args).not.toContain("down");
    expect(args).not.toContain("--profile");
  });
});

describe("ensureWayflowBridgeEnv", () => {
  const REPO = "/fake/checkout";
  const GENERATOR = path.join(REPO, "scripts", "gen-wayflow-env.mjs");

  it("runs the checkout's generator with --require-bridge-token and proceeds on success", () => {
    const calls = [];
    const ok = ensureWayflowBridgeEnv(REPO, {
      existsImpl: (p) => p === GENERATOR,
      spawnImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts.cwd });
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual([GENERATOR, "--require-bridge-token"]);
    expect(calls[0].cwd).toBe(REPO);
  });

  it("generator exists and fails → false (the start must abort, not crash-loop the runtime)", () => {
    const ok = ensureWayflowBridgeEnv(REPO, {
      existsImpl: () => true,
      spawnImpl: () => ({ status: 1 }),
    });
    expect(ok).toBe(false);
  });

  it("generator exists but spawn errors (ENOENT-style) → false", () => {
    const ok = ensureWayflowBridgeEnv(REPO, {
      existsImpl: () => true,
      spawnImpl: () => ({ error: new Error("spawn node ENOENT"), status: null }),
    });
    expect(ok).toBe(false);
  });

  it("generator absent (older checkout) → warn-and-proceed true, without spawning", () => {
    let spawned = false;
    const ok = ensureWayflowBridgeEnv(REPO, {
      existsImpl: () => false,
      spawnImpl: () => {
        spawned = true;
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(spawned).toBe(false);
  });
});

describe("effectiveComposeProjectName", () => {
  it("an explicit COMPOSE_PROJECT_NAME wins over the checkout basename", () => {
    expect(
      effectiveComposeProjectName("/home/dev/cinatra", { COMPOSE_PROJECT_NAME: "my-stack" }),
    ).toBe("my-stack");
  });

  it("falls back to the checkout directory basename when the env var is absent or blank", () => {
    expect(effectiveComposeProjectName("/home/dev/cinatra", {})).toBe("cinatra");
    expect(effectiveComposeProjectName("/home/dev/cinatra", { COMPOSE_PROJECT_NAME: "   " })).toBe(
      "cinatra",
    );
  });

  it("normalizes like Compose: lowercase, invalid chars dropped, leading separators trimmed", () => {
    expect(effectiveComposeProjectName("/home/dev/My Repo.Fork", {})).toBe("myrepofork");
    expect(effectiveComposeProjectName("/home/dev/_hidden-repo", {})).toBe("hidden-repo");
    expect(
      effectiveComposeProjectName("/ignored", { COMPOSE_PROJECT_NAME: "Cinatra Fix#42" }),
    ).toBe("cinatrafix42");
  });
});
