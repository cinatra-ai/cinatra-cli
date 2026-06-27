// End-to-end guard for the `dev …` → `instance …` namespace rename
// (cinatra-cli#61). These spawn the REAL bin to prove the user-visible contract,
// not just the matcher:
//
//   1. `cinatra instance --help` (and bare `cinatra instance`) render the Class-C
//      group banner that advertises the renamed subcommands.
//   2. `cinatra instance setup …` resolves and its `--help` short-circuits to a
//      synopsis with NO side effect (the cinatra#255 footgun guard still holds).
//   3. The OLD `cinatra dev …` namespace is FULLY GONE — no alias, no resolution.
//      Every former `dev …` form (and the bare `dev` head) exits non-zero with an
//      "Unknown command" error (cinatra-cli#61: remove `dev` entirely, per owner).
//   4. The pre-existing eng#232 bare-path aliases (`clone list`, `db migrate`, …)
//      still work and now steer users at the `instance …` canonical form.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

function run(args, { home, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      ...(home ? { HOME: home, USERPROFILE: home } : {}),
      ...extraEnv,
    },
  });
}

function tmpHome() {
  return mkdtempSync(path.join(os.tmpdir(), "cinatra-instance-rename-"));
}

describe("cinatra-cli#61 — `instance` namespace (the new Class-C head)", () => {
  it("`cinatra instance --help` renders the Class-C group banner with renamed commands", () => {
    const res = run(["instance", "--help"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("Cinatra instance — local host/monorepo bootstrap commands");
    expect(res.stdout).toContain("cinatra instance setup dev");
    expect(res.stdout).toContain("cinatra instance setup prod"); // the self-contradictory `dev setup prod` is gone
    expect(res.stdout).toContain("cinatra instance db migrate");
    expect(res.stdout).toContain("cinatra instance clone list");
    // The renamed banner must never advertise the old `cinatra dev …` head.
    expect(res.stdout).not.toMatch(/cinatra dev /);
  });

  it("bare `cinatra instance` prints the group banner and exits non-zero (no handler)", () => {
    const res = run(["instance"]);
    expect(res.status).not.toBe(0); // group head has no handler — exits 1
    expect(res.stdout).toContain("Cinatra instance — local host/monorepo bootstrap commands");
  });

  it("`cinatra instance setup prod --help` shows a synopsis, exits 0, no side effect", () => {
    // The footgun guard (cinatra#255): a help flag short-circuits BEFORE the
    // destructive setup handler runs. We assert on output, not a temp-dir scan,
    // because setup reads/writes the checkout root, not cwd.
    const res = run(["instance", "setup", "prod", "--help"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/Usage: cinatra instance setup dev\|prod/);
    expect(res.stdout).not.toMatch(/Prepar(ing|ed) Better Auth/); // never ran the handler
  });

  it("the top-level `cinatra --help` points at `cinatra instance …`, not `cinatra dev …`", () => {
    const res = run(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cinatra instance …");
    expect(res.stdout).toContain("cinatra instance --help");
    expect(res.stdout).not.toMatch(/cinatra dev /);
  });
});

describe("cinatra-cli#61 — the old `dev` namespace is fully removed", () => {
  // Every former `dev …` form must be UNKNOWN: no alias, no resolution.
  const goneForms = [
    ["dev"],
    ["dev", "setup"],
    ["dev", "setup", "dev"],
    ["dev", "setup", "prod"],
    ["dev", "db", "migrate"],
    ["dev", "clone", "list"],
    ["dev", "tunnel", "start"],
    ["dev", "reset"],
    ["dev", "backup", "create"],
  ];

  it.each(goneForms)("`cinatra %s` is an Unknown command (exit 1)", (...argv) => {
    const res = run(argv);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Unknown command/i);
  });

  it("`cinatra dev --help` falls back to the GLOBAL banner (dev is not special-cased)", () => {
    const res = run(["dev", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI"); // the top-level banner
    expect(res.stdout).not.toContain("Cinatra instance — local host/monorepo");
  });
});

describe("cinatra-cli#61 — eng#232 bare-path aliases now target `instance …`", () => {
  it("`cinatra clone list` still works and steers the user at `cinatra instance clone list`", () => {
    const home = tmpHome();
    try {
      const res = run(["clone", "list"], { home });
      // Read-only listing succeeds (empty registry).
      expect(res.status).toBe(0);
      // The deprecation notice (stderr) now names the `instance …` canonical form.
      expect(res.stderr).toMatch(
        /"cinatra clone list" is now "cinatra instance clone list" — the old form still works this release\./,
      );
      // Never the removed `dev …` form.
      expect(res.stderr).not.toMatch(/cinatra dev clone/);
      // And never on stdout (script-safe).
      expect(res.stdout).not.toMatch(/is now "cinatra/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
