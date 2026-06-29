// cinatra-cli#62 — Consolidate `cinatra setup` into `cinatra install --mode
// dev|prod` (single idempotent bootstrap/reconcile). These spawn the REAL bin
// to pin the user-visible contract of the consolidation:
//
//   1. `cinatra install --mode dev|prod` is the SINGLE documented bootstrap AND
//      reconcile entrypoint, and it is idempotent (a --dry-run on a fresh dir
//      previews a from-zero plan; non-interactive, no hang, exit 0).
//   2. No documented top-level `setup` command — the in-repo provisioning phase
//      is DEMOTED to an internal phase. It still ROUTES (install runs it, the
//      `doctor --fix` self-heal re-runs it, the `pnpm setup:dev` hook calls it),
//      but its `--help` STEERS the operator to `cinatra install` and never
//      advertises the now-internal `instance setup` path.
//   3. The branch lifecycle is renamed to `cinatra instance branch setup` /
//      `cinatra instance branch teardown`; the old `instance setup branch` /
//      `instance teardown branch` (and the bare `setup branch` / `teardown
//      branch`) forms were REMOVED with no back-compat (cinatra-cli#81) and now
//      route to UNKNOWN.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMMAND_DESCRIPTORS,
  buildHelpIndex,
  matchDescriptor,
} from "../src/command-table.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

function run(args, { cwd, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd,
    env: { ...process.env, CI: "1", ...extraEnv },
  });
}

// ---------------------------------------------------------------------------
// 1. `install` is the single idempotent bootstrap/reconcile entrypoint.
// ---------------------------------------------------------------------------
describe("cinatra-cli#62 — `cinatra install` is the single idempotent entrypoint", () => {
  it("the install descriptor advertises bootstrap OR reconcile (idempotent)", () => {
    const install = COMMAND_DESCRIPTORS.find((d) => d.id === "install");
    expect(install).toBeTruthy();
    expect(install.summary).toMatch(/idempotent/i);
    expect(install.summary).toMatch(/reconcile/i);
  });

  it("`install --help` prints usage and runs NO install side effect", () => {
    const res = run(["install", "--help"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("cinatra install");
    expect(res.stdout).toMatch(/Usage:/i);
    expect(res.stdout).not.toContain("Checking requirements");
  });

  it("`install --mode dev --dry-run` previews a plan with no side effect, non-interactive, exit 0", () => {
    const work = mkdtempSync(path.join(os.tmpdir(), "cinatra-62-dryrun-"));
    const target = path.join(work, "cinatra");
    try {
      // Pipe an empty stdin so a non-TTY run can never hang on a prompt.
      const res = spawnSync(
        process.execPath,
        [BIN, "install", "--mode", "dev", "--dry-run", "--dir", target],
        { encoding: "utf8", timeout: 30_000, input: "", env: { ...process.env, CI: "1" } },
      );
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toMatch(/Dry run — no changes made/i);
      expect(res.stdout).toContain("Mode:          dev");
      // A dry-run must perform NO clone / env write.
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. No documented top-level `setup`; the phase is internal but still routes.
// ---------------------------------------------------------------------------
describe("cinatra-cli#62 — `setup` is demoted to an internal phase", () => {
  it("no visible help row advertises any `setup` command", () => {
    const help = buildHelpIndex(COMMAND_DESCRIPTORS);
    const setupRows = help.filter(
      (r) => r.command === "setup" || r.command.startsWith("instance setup"),
    );
    expect(setupRows).toEqual([]);
  });

  it("there is NO bare `setup nango` command (acceptance item 4)", () => {
    // The internal phase routes ONLY under the namespaced `instance setup nango`;
    // the bare `setup nango` was removed (Nango is provisioned by `cinatra install`).
    expect(matchDescriptor(COMMAND_DESCRIPTORS, ["setup", "nango"])).toBeNull();
    const res = run(["setup", "nango"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Unknown command/i);
  });

  it("the in-repo setup phase descriptors are hidden but STILL ROUTE", () => {
    for (const tokens of [
      ["instance", "setup"],
      ["instance", "setup", "dev"],
      ["instance", "setup", "prod"],
      ["instance", "setup", "nango"],
    ]) {
      const d = matchDescriptor(COMMAND_DESCRIPTORS, tokens);
      expect(d, `${tokens.join(" ")} must still route`).toBeTruthy();
      expect(d.hidden, `${tokens.join(" ")} must be hidden`).toBe(true);
    }
  });

  it.each([
    [["instance", "setup", "dev", "--help"]],
    [["instance", "setup", "prod", "--help"]],
    [["instance", "setup", "nango", "--help"]],
  ])("`%j` steers to `cinatra install`, never advertises the internal setup path", (args) => {
    const res = run(args);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("cinatra install --mode dev|prod");
    expect(res.stdout).toMatch(/folded into the single idempotent/i);
    expect(res.stdout).not.toMatch(/Usage: cinatra instance setup/i);
  });

  it("the top-level banner steers `setup` users to `cinatra install`, not a `setup` command", () => {
    const res = run(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("install");
    // The folded note appears in the install blurb.
    expect(res.stdout).toMatch(/single idempotent/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Branch lifecycle renamed to `instance branch setup|teardown`.
// ---------------------------------------------------------------------------
describe("cinatra-cli#62 — branch lifecycle renamed to `instance branch …`", () => {
  it("the new canonical `instance branch setup|teardown` are VISIBLE descriptors", () => {
    const help = buildHelpIndex(COMMAND_DESCRIPTORS).map((r) => r.command);
    expect(help).toContain("instance branch setup");
    expect(help).toContain("instance branch teardown");
  });

  it.each([
    [["instance", "branch", "setup"], "setup.branch"],
    [["instance", "branch", "teardown"], "teardown.branch"],
  ])("`%j` routes to %s as the canonical form", (tokens, id) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, tokens);
    expect(d.id).toBe(id);
    expect(d.hidden).toBeFalsy();
  });

  it.each([
    [["instance", "setup", "branch"]],
    [["instance", "teardown", "branch"]],
    [["setup", "branch"]],
    [["teardown", "branch"]],
  ])("cinatra-cli#81: the old form `%j` is REMOVED — routes to UNKNOWN", (tokens) => {
    expect(matchDescriptor(COMMAND_DESCRIPTORS, tokens)).toBeNull();
  });

  it("`instance branch setup --help` shows its synopsis with no side effect", () => {
    const res = run(["instance", "branch", "setup", "--help"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain("cinatra instance branch setup");
    expect(res.stdout).toMatch(/Usage:/i);
    expect(res.stdout).not.toMatch(/Provisioned|overwrite the source/i); // handler never ran
  });

  it("cinatra-cli#81: the old bare `teardown branch` is UNKNOWN — no command runs, no notice", () => {
    const work = mkdtempSync(path.join(os.tmpdir(), "cinatra-62-td-"));
    try {
      const res = run(["teardown", "branch"], { cwd: work });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/Unknown command: teardown branch/);
      // No back-compat "is now" notice and the destructive handler never ran.
      expect(`${res.stdout}${res.stderr}`).not.toMatch(/is now "cinatra/);
      expect(res.stderr).not.toMatch(/is destructive/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("the renamed banner never advertises the OLD `instance setup branch` / `instance teardown branch`", () => {
    const res = run(["instance", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(/cinatra instance setup branch/);
    expect(res.stdout).not.toMatch(/cinatra instance teardown branch/);
    expect(res.stdout).toContain("cinatra instance branch setup");
    expect(res.stdout).toContain("cinatra instance branch teardown");
  });
});
