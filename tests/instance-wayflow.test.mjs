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
  wayflowComposeContext,
  wayflowHealthUrlFromEnv,
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

// cinatra#2654 — the command must address the install's RECORDED compose
// project. A `-p`-less invocation makes Docker derive the project from the
// checkout BASENAME; a default install now records an explicit instance-scoped
// project and an isolated install records its own generated compose file, so the
// basename forks a SECOND, empty project — `start` would build a container the
// app never reaches, and `stop` would find nothing to remove.
describe("composeWayflowArgs — recorded project + compose files", () => {
  it("start pins -p to the recorded project and uses the recorded files", () => {
    const args = composeWayflowArgs("start", {
      project: "cinatra_demo",
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml", "docker-compose.isolated.yml"],
    });
    expect(args.slice(0, 3)).toEqual(["compose", "-p", "cinatra_demo"]);
    expect(args).toContain("docker-compose.isolated.yml");
    // -p is a TOP-LEVEL flag: before the subcommand, or compose rejects it.
    expect(args.indexOf("-p")).toBeLessThan(args.indexOf("up"));
  });

  it("stop pins the same project, and still never uses `down` or the bare profile", () => {
    const args = composeWayflowArgs("stop", { project: "cinatra_demo" });
    expect(args.slice(0, 3)).toEqual(["compose", "-p", "cinatra_demo"]);
    expect(args.slice(-3)).toEqual(["rm", "-sf", "wayflow"]);
    expect(args).not.toContain("down");
    expect(args).not.toContain("--profile");
  });
});

describe("wayflowComposeContext", () => {
  const ROW = {
    slug: "demo",
    installDir: "/home/dev/cinatra",
    composeProject: "cinatra_demo",
    composeFiles: ["docker-compose.yml", "docker-compose.isolated.yml"],
  };

  it("prefers the recorded install row over the checkout basename", () => {
    const ctx = wayflowComposeContext("/home/dev/cinatra", {
      readRegistry: () => ({ instances: { demo: ROW } }),
      findByInstallDir: () => ROW,
    });
    expect(ctx.project).toBe("cinatra_demo");
    expect(ctx.composeFiles).toEqual(ROW.composeFiles);
  });

  it("falls back to the basename-derived project for a checkout with no recorded install", () => {
    const ctx = wayflowComposeContext("/tmp/my-checkout", {
      readRegistry: () => ({ instances: {} }),
      findByInstallDir: () => null,
    });
    expect(ctx.project).toBe(effectiveComposeProjectName("/tmp/my-checkout"));
    expect(ctx.source).toBe("fallback");
  });
});

describe("wayflowHealthUrlFromEnv", () => {
  it("follows this instance's WAYFLOW_BASE_URL (an isolated stack remaps the port)", () => {
    expect(wayflowHealthUrlFromEnv({ WAYFLOW_BASE_URL: "http://localhost:13010" })).toBe(
      "http://localhost:13010/.health",
    );
    expect(wayflowHealthUrlFromEnv({ WAYFLOW_BASE_URL: "https://wayflow.example.test/agents" })).toBe(
      "https://wayflow.example.test/.health",
    );
  });

  it("REFUSES rather than defaulting when the variable is absent or unusable (cinatra-cli#233)", () => {
    // A hardcoded :3010 fallback is not a guess, it is a wrong answer: on an
    // isolated/attached instance it names the DEFAULT stack's runtime, so the
    // caller would report another instance's readiness as this one's. Null lets
    // the caller derive the endpoint from what this instance PUBLISHED, and
    // report it as undetermined when it cannot.
    expect(wayflowHealthUrlFromEnv({})).toBeNull();
    expect(wayflowHealthUrlFromEnv({ WAYFLOW_BASE_URL: "   " })).toBeNull();
    expect(wayflowHealthUrlFromEnv({ WAYFLOW_BASE_URL: "not a url" })).toBeNull();
    expect(wayflowHealthUrlFromEnv({ WAYFLOW_BASE_URL: "ftp://host/x" })).toBeNull();
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
