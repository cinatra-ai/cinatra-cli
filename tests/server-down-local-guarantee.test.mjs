// Server-down LOCAL guarantee (the command-routing contract).
//
// Class C exists precisely BECAUSE `dev db migrate` / `dev setup` must work when
// the app server is down (a migrate that needed the app up could never repair a
// broken-schema instance — the app would not boot). So these commands must talk
// to Postgres + local subprocesses directly and NEVER take a HARD dependency on
// reaching the running instance over the network.
//
// The scope is deliberately tight (per the plan): protect the two
// server-down-safe commands `dev db migrate` and `dev setup`, not a broad
// "no fetch anywhere" scan that false-positives on bounded probe/hint code.
//
//   1. STATIC boundary — `index.mjs` (which owns runDbMigrate / runSetup) must
//      NOT statically import the Class-A MCP/login client nor a raw network
//      module as a REQUIRED top-level import. (The login/MCP client is lazy-
//      imported only inside the `login` / `status` handlers.)
//   2. RUNTIME fetch-poison — with `global.fetch` replaced by a thrower, running
//      `dev db migrate` against a fake checkout + unreachable DB must fail on a
//      DB/checkout reason, NEVER surfacing the fetch-poison marker (proving no
//      required network step on the server-down path).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeFakeCheckout } from "./helpers/fake-checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");
const POISON = path.join(HERE, "fixtures", "poison-fetch.mjs");
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

const POISON_MARKER = /__FETCH_POISON_REACHED__/;

describe("server-down guarantee — static boundary on the db/setup path", () => {
  // The top-level import block ends at the first non-import construct. Scan only
  // the static (top-level) imports of index.mjs.
  const topLevelImports = INDEX_SRC.split("\n")
    .filter((l) => /^import\b/.test(l))
    .join("\n");

  it("index.mjs does NOT statically import the Class-A MCP client", () => {
    // The MCP/OAuth client (`@modelcontextprotocol/sdk`) lives in login.mjs and
    // is lazy-imported only inside the login/status handlers.
    expect(topLevelImports).not.toMatch(/@modelcontextprotocol\/sdk/);
  });

  it("index.mjs does NOT statically import login.mjs (the network client module)", () => {
    expect(topLevelImports).not.toMatch(/from\s+["']\.\/login\.mjs["']/);
  });

  it("index.mjs does NOT statically import a raw network module", () => {
    // No required top-level http/https/undici on the db/setup path. (The CLI
    // uses node builtins + pg + checkout-resolve + local subprocesses.)
    expect(topLevelImports).not.toMatch(/from\s+["']node:https?["']/);
    expect(topLevelImports).not.toMatch(/from\s+["']undici["']/);
  });
});

describe("server-down guarantee — runtime fetch-poison on `instance db migrate`", () => {
  it("`instance db migrate` fails on a DB/checkout reason, never on a required network step", () => {
    const checkout = makeFakeCheckout({
      env: {
        SUPABASE_DB_URL: "postgres://nope:nope@127.0.0.1:5999/cinatra_serverdown",
        SUPABASE_SCHEMA: "cinatra",
      },
    });
    try {
      const res = spawnSync(
        process.execPath,
        ["--import", POISON, BIN, "instance", "db", "migrate"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, CINATRA_REPO_ROOT: checkout.root },
        },
      );
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      // It FAILED (no real runner / unreachable DB) …
      expect(res.status).not.toBe(0);
      // … but NEVER because it tried to reach the network as a required step.
      expect(out, "db migrate must not depend on fetch").not.toMatch(POISON_MARKER);
      // It failed on the expected local reason (checkout-resolve of the runner,
      // or a DB connection error) — proving it stayed on the direct-pg /
      // checkout path.
      expect(out).toMatch(/@cinatra-ai\/migrations|cannot resolve|database|ECONNREFUSED|connect/i);
    } finally {
      checkout.cleanup();
    }
  });

  it("the same alias `db migrate` also stays local under fetch-poison", () => {
    const checkout = makeFakeCheckout({
      env: {
        SUPABASE_DB_URL: "postgres://nope:nope@127.0.0.1:5999/cinatra_serverdown2",
        SUPABASE_SCHEMA: "cinatra",
      },
    });
    try {
      const res = spawnSync(
        process.execPath,
        ["--import", POISON, BIN, "db", "migrate"],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...process.env,
            CINATRA_REPO_ROOT: checkout.root,
            CINATRA_SUPPRESS_DEPRECATION: "1",
          },
        },
      );
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(res.status).not.toBe(0);
      expect(out).not.toMatch(POISON_MARKER);
    } finally {
      checkout.cleanup();
    }
  });
});
