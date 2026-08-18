// cinatra-cli#211 — WIRING coverage for the `NANGO_SECRET_KEY` reconcile.
//
// tests/nango-secret-key.test.mjs proves what the reconcile DOES. It cannot
// prove that a bring-up actually calls it, nor that it is called AFTER Nango is
// healthy — and getting either wrong silently restores the original bug:
//   - never called  → a fresh install still ships no key and every Nango-backed
//     connector save 401s;
//   - called too early → nango-server has not run its first-boot migrations yet,
//     `_nango_environments` is empty, and the reconcile finds nothing to adopt.
//
// So this file drives the REAL `bringUpInfra` with `node:child_process` mocked,
// and asserts on the ORDER of what it did and on the file it left behind.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SEEDED = "3f7a1c2e-9b4d-4a61-8c2f-0d5e6a7b8c9d";

const procControl = vi.hoisted(() => ({ calls: [], psqlStatus: 0, psqlStdout: "" }));

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("spawn is not expected in this test");
  },
  execFileSync: () => "",
  spawnSync: (command, args = [], options = {}) => {
    procControl.calls.push({ command, args, cwd: options?.cwd ?? null });
    if (command === "docker" && args.includes("psql")) {
      return { status: procControl.psqlStatus, stdout: procControl.psqlStdout, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

const { bringUpInfra } = await import("../src/install.mjs");

/** What each recorded call was, as a coarse step name, in order. */
function steps() {
  return procControl.calls.map(({ command, args }) => {
    if (command === "curl") return "nango-health";
    if (command === "sleep") return "sleep";
    if (command !== "docker") return command;
    if (args.includes("up")) return "compose-up";
    const execAt = args.indexOf("exec");
    if (execAt === -1) return "docker-other";
    return `exec:${args[execAt + 2]}`;
  });
}

describe("bringUpInfra reconciles NANGO_SECRET_KEY after Nango is healthy", () => {
  let dir;
  let envPath;
  let logged;
  const log = (line) => logged.push(String(line));
  const deps = { assertRecreateSafe: () => {} };

  beforeEach(() => {
    procControl.calls = [];
    procControl.psqlStatus = 0;
    procControl.psqlStdout = `${SEEDED}\n`;
    dir = mkdtempSync(path.join(os.tmpdir(), "cli211-wiring-"));
    envPath = path.join(dir, ".env.local");
    // cinatra#2654 D1: the bring-up refuses to start WayFlow unless the narrow
    // bridge-token env file the container reads actually carries a token — so
    // this checkout fixture holds the file a real bring-up has by this point.
    mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
    writeFileSync(path.join(dir, "docker", "wayflow", ".wayflow.env"), "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\n", {
      mode: 0o600,
    });
    logged = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints into the threaded env-file, using the caller's compose project/files", () => {
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\nNANGO_SERVER_URL=http://localhost:3013\n", { mode: 0o600 });

    bringUpInfra({
      slug: "demo",
      deps,
      targetDir: dir,
      log,
      composeFiles: ["docker-compose.yml", "cinatra.isolated.yml"],
      composeProject: "cinatra-demo",
      envFile: envPath,
      nangoHealthUrl: "http://127.0.0.1:3013/health",
    });

    const order = steps();
    expect(order).toContain("exec:nango-db");
    // The reconcile runs AFTER the Nango health gate, not before it.
    expect(order.indexOf("exec:nango-db")).toBeGreaterThan(order.indexOf("nango-health"));
    // …and after the stack is up.
    expect(order.indexOf("exec:nango-db")).toBeGreaterThan(order.indexOf("compose-up"));

    const psql = procControl.calls.find((c) => c.args.includes("psql"));
    expect(psql.cwd).toBe(dir);
    expect(psql.args.slice(0, 8)).toEqual([
      "compose",
      "--env-file",
      envPath,
      "-p",
      "cinatra-demo",
      "-f",
      "docker-compose.yml",
      "-f",
    ]);

    expect(readFileSync(envPath, "utf8")).toMatch(new RegExp(`^NANGO_SECRET_KEY=${SEEDED}$`, "m"));
    expect(logged.join("\n")).toContain("NANGO_SECRET_KEY");
  });

  it("falls back to the checkout's .env.local when no env-file is threaded", () => {
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });

    bringUpInfra({ deps, targetDir: dir, log });

    expect(readFileSync(envPath, "utf8")).toMatch(new RegExp(`^NANGO_SECRET_KEY=${SEEDED}$`, "m"));
  });

  it("completes the bring-up when the reconcile cannot read the key (non-fatal)", () => {
    procControl.psqlStatus = 1;
    procControl.psqlStdout = "";
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });

    expect(() => bringUpInfra({ deps, targetDir: dir, log, envFile: envPath })).not.toThrow();
    expect(readFileSync(envPath, "utf8")).not.toContain("NANGO_SECRET_KEY=");
    expect(logged.join("\n")).toContain("nango-db");
  });

  it("honors the deps.ensureNangoSecretKey seam", () => {
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });
    const seen = [];

    bringUpInfra({
      deps: { ...deps, ensureNangoSecretKey: (args) => seen.push(args) },
      targetDir: dir,
      log,
      envFile: envPath,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].envPath).toBe(envPath);
    expect(procControl.calls.some((c) => c.args.includes("psql"))).toBe(false);
  });

  it("contains an unexpected throw from the reconcile rather than failing the bring-up", () => {
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });

    expect(() =>
      bringUpInfra({
        deps: {
          ...deps,
          ensureNangoSecretKey: () => {
            throw new Error("nango-db exploded");
          },
        },
        targetDir: dir,
        log,
        envFile: envPath,
      }),
    ).not.toThrow();
    expect(logged.join("\n")).toContain("nango-db exploded");
  });
});
