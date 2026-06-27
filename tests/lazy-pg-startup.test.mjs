// Lazy-`pg` / lean-STARTUP guard (the command-routing contract).
//
// `pg` is the one genuinely heavy native runtime dependency in the published
// tarball. Before this change `src/index.mjs` did a top-level `import pg`, so
// importing the CLI entry (which `bin/cinatra.mjs` does for EVERY command) paid
// the native pg load even for `--help` / `--version` / `login` /
// `create-extension` / `dev --help`. The command-routing change moves pg behind the single
// `createClient` chokepoint via a memoized `getPgClientCtor()`.
//
// These tests drive the REAL `bin/cinatra.mjs` (not just `import("../src/...")`)
// through a resolve-hook probe and assert:
//   1. NONE of the lean commands resolve `pg` (or node-pg-migrate /
//      @cinatra-ai/migrations / connectors-catalog / skills).
//   2. The CLI's own `createClient` DOES resolve `pg` when called — proving the
//      lazy chokepoint actually loads it on demand (a deterministic unit-level
//      proof that avoids handler side effects, per the plan's positive-proof
//      note).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeFakeCheckout } from "./helpers/fake-checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");
const PROBE = pathToFileURL(path.join(HERE, "fixtures", "record-pg-resolve.mjs")).href;
const INDEX = pathToFileURL(path.join(HERE, "..", "src", "index.mjs")).href;

const MARKER = /__HEAVY_DEP_LOADED__:pg\b/;
const ANY_HEAVY = /__HEAVY_DEP_LOADED__:/;

function runProbed(args, extraArgs = []) {
  return spawnSync(
    process.execPath,
    ["--import", PROBE, ...extraArgs, BIN, ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
}

describe("lazy-pg — lean startup for non-DB commands", () => {
  const leanCommands = [
    ["--help"],
    ["--version"],
    ["login", "--help"],
    ["create-extension", "--help"],
    ["dev", "--help"],
  ];

  it.each(leanCommands)("`cinatra %j` does not load pg (or any heavy Class-C dep) at startup", (...args) => {
    const res = runProbed(args);
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out, `unexpected heavy-dep load: ${out.match(ANY_HEAVY)?.[0]}`).not.toMatch(ANY_HEAVY);
    // The command itself succeeded (these are all exit-0 help/version paths).
    expect(res.status).toBe(0);
  });
});

describe("lazy-pg — the createClient chokepoint loads pg on demand", () => {
  /** @type {Array<() => void>} */
  const cleanups = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()();
  });

  it("importing the entry module alone does NOT load pg", () => {
    const res = spawnSync(
      process.execPath,
      ["--import", PROBE, "-e", `await import(${JSON.stringify(INDEX)});`],
      { encoding: "utf8", timeout: 30_000 },
    );
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).not.toMatch(MARKER);
  });

  it("the probe DOES detect a pg load (guards against a false-negative probe)", () => {
    const res = spawnSync(
      process.execPath,
      ["--import", PROBE, "-e", `await import("pg");`],
      { encoding: "utf8", timeout: 30_000 },
    );
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    expect(out).toMatch(MARKER);
  });

  it("a DB-touching command (`status`) loads pg via the createClient chokepoint", () => {
    // `status` reads SUPABASE_DB_URL from the checkout and opens a client via the
    // CLI's own createClient — so running it against a fake checkout with an
    // unreachable DB must trigger the lazy `pg` load (then fail on connection).
    const checkout = makeFakeCheckout({
      env: {
        SUPABASE_DB_URL: "postgres://nope:nope@127.0.0.1:5999/cinatra_lazypg",
        SUPABASE_SCHEMA: "cinatra",
      },
    });
    cleanups.push(checkout.cleanup);
    // Pin CINATRA_REPO_ROOT to the fake checkout so `status` resolves there.
    const pinned = spawnSync(
      process.execPath,
      ["--import", PROBE, BIN, "status"],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, CINATRA_REPO_ROOT: checkout.root },
      },
    );
    const pinnedOut = `${pinned.stdout ?? ""}${pinned.stderr ?? ""}`;
    expect(pinnedOut, "status should have loaded pg via createClient").toMatch(MARKER);
  });
});
