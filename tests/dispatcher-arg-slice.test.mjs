// Dispatcher arg-slice contract (the command-routing contract).
//
// The dispatcher computes, for the matched descriptor:
//   routedTokens = argv.slice(0, descriptor.path.length)
//   rest         = argv.slice(descriptor.path.length)
// so a handler reads its routed mode token from `routedTokens` and its trailing
// flags/positionals from `rest`.
//
// Part 1 asserts that contract directly against the matcher (pure, no handler
// side effects). Part 2 spawns the real bin to assert that the old bare forms
// (removed in cinatra-cli#81) route to UNKNOWN with no back-compat notice, and
// that only the canonical `instance …` forms resolve.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMAND_DESCRIPTORS, matchDescriptor } from "../src/command-table.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// Mirror the runCli slicing exactly.
function dispatchSlice(argv) {
  const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
  if (!d) return null;
  return {
    id: d.id,
    routedTokens: argv.slice(0, d.path.length),
    rest: argv.slice(d.path.length),
  };
}

describe("dispatcher arg-slice contract", () => {
  it("`instance db migrate --down` delivers rest === ['--down']", () => {
    const s = dispatchSlice(["instance", "db", "migrate", "--down"]);
    expect(s.id).toBe("db.migrate");
    expect(s.routedTokens).toEqual(["instance", "db", "migrate"]);
    expect(s.rest).toEqual(["--down"]);
  });

  it("cinatra-cli#81: the old bare form `db migrate --down` routes to UNKNOWN", () => {
    expect(dispatchSlice(["db", "migrate", "--down"])).toBeNull();
  });

  it("`instance setup prod --foo` routes the mode in routedTokens, flags in rest", () => {
    const s = dispatchSlice(["instance", "setup", "prod", "--foo"]);
    expect(s.id).toBe("setup.dev|prod");
    expect(s.routedTokens).toEqual(["instance", "setup", "prod"]);
    expect(s.routedTokens[s.routedTokens.length - 1]).toBe("prod");
    expect(s.rest).toEqual(["--foo"]);
  });

  it("cinatra-cli#81: the old bare form `setup prod --foo` routes to UNKNOWN", () => {
    expect(dispatchSlice(["setup", "prod", "--foo"])).toBeNull();
  });

  it("`instance clone refresh-seed --source-env x` delivers rest === ['--source-env','x']", () => {
    const s = dispatchSlice(["instance", "clone", "refresh-seed", "--source-env", "x"]);
    expect(s.id).toBe("clone.refresh-seed");
    expect(s.rest).toEqual(["--source-env", "x"]);
  });

  it("a command-only descriptor (`install`) delivers all trailing tokens in rest", () => {
    const s = dispatchSlice(["install", "--dir", "/tmp/x", "--yes"]);
    expect(s.id).toBe("install");
    expect(s.routedTokens).toEqual(["install"]);
    expect(s.rest).toEqual(["--dir", "/tmp/x", "--yes"]);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the old bare forms are gone (no back-compat, no notice).
// ---------------------------------------------------------------------------
function run(args, { home, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
}

describe("cinatra-cli#81 — old bare forms route to UNKNOWN (no back-compat)", () => {
  function tmpHome() {
    return mkdtempSync(path.join(os.tmpdir(), "cinatra-dep-home-"));
  }

  it("the old bare form `clone list` is UNKNOWN — no command runs, no notice", () => {
    const home = tmpHome();
    try {
      const res = run(["clone", "list"], { home });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/Unknown command: clone list/);
      // No back-compat "is now" notice anywhere.
      expect(`${res.stdout}${res.stderr}`).not.toMatch(/is now "cinatra/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the canonical `instance clone list` form still resolves (runs, no UNKNOWN)", () => {
    const home = tmpHome();
    try {
      const res = run(["instance", "clone", "list"], { home });
      expect(res.stderr).not.toMatch(/Unknown command/);
      expect(`${res.stdout}${res.stderr}`).not.toMatch(/is now "cinatra/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
