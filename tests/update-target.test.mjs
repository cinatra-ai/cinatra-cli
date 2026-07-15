// Pure decision/parse logic for the two-choice `cinatra update` (cinatra-cli#60).
//
// These pin the contract that the orchestration in index.mjs relies on:
//   * flag parsing (mutual exclusion, instance-only flags imply --instance,
//     unknown flags fail loudly, --ref validation),
//   * path resolution from selection + TTY (the back-compat default for non-TTY
//     is the INSTANCE update so existing scripts never break and never hang),
//   * the instance-type → git-move target mapping (dev→origin/main, prod→release).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  parseUpdateArgs,
  resolveUpdatePath,
  resolveInstanceMoveTarget,
  CLI_INSTALL_SPEC,
} from "../src/update-target.mjs";
import { moveExistingCheckoutToRef } from "../src/install.mjs";

describe("parseUpdateArgs", () => {
  it("no flags → no explicit selection (target null), defaults filled", () => {
    expect(parseUpdateArgs([])).toEqual({
      target: null,
      ref: null,
      force: false,
      refreshArgs: [],
      dryRun: false,
    });
  });

  it("--cli selects the CLI path", () => {
    expect(parseUpdateArgs(["--cli"]).target).toBe("cli");
  });

  it("--instance selects the instance path", () => {
    expect(parseUpdateArgs(["--instance"]).target).toBe("instance");
  });

  it("an instance-only flag (--ref) implies the instance path", () => {
    const r = parseUpdateArgs(["--ref", "release-tag-1"]);
    expect(r.target).toBe("instance");
    expect(r.ref).toBe("release-tag-1");
  });

  it("--force implies the instance path", () => {
    expect(parseUpdateArgs(["--force"]).target).toBe("instance");
    expect(parseUpdateArgs(["--force"]).force).toBe(true);
  });

  it("docker flags pass through to refreshArgs and imply the instance path", () => {
    const r = parseUpdateArgs(["--docker=always", "--no-docker"]);
    expect(r.target).toBe("instance");
    expect(r.refreshArgs).toEqual(["--docker=always", "--no-docker"]);
  });

  it("--dry-run is captured and is path-agnostic", () => {
    expect(parseUpdateArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseUpdateArgs(["--dry-run"]).target).toBe(null);
    expect(parseUpdateArgs(["--cli", "--dry-run"])).toMatchObject({ target: "cli", dryRun: true });
  });

  it("--cli + --instance is a conflict", () => {
    expect(() => parseUpdateArgs(["--cli", "--instance"])).toThrow(/Conflicting flags/);
  });

  it("--cli + an instance-only flag is a conflict", () => {
    expect(() => parseUpdateArgs(["--cli", "--ref", "x"])).toThrow(/Conflicting flags/);
    expect(() => parseUpdateArgs(["--cli", "--force"])).toThrow(/Conflicting flags/);
    expect(() => parseUpdateArgs(["--cli", "--no-docker"])).toThrow(/Conflicting flags/);
  });

  it("unknown flags fail loudly", () => {
    expect(() => parseUpdateArgs(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("--ref requires a value", () => {
    expect(() => parseUpdateArgs(["--ref"])).toThrow(/--ref requires a value/);
    expect(() => parseUpdateArgs(["--ref", "--force"])).toThrow(/--ref requires a value/);
  });

  it("--ref rejects unsafe values (leading dash, .., whitespace)", () => {
    expect(() => parseUpdateArgs(["--ref", "../etc"])).toThrow(/Invalid --ref/);
    expect(() => parseUpdateArgs(["--ref", "a b"])).toThrow(/Invalid --ref/);
  });

  it("--ref accepts safe branch/tag/sha values", () => {
    expect(parseUpdateArgs(["--ref", "release-tag-1"]).ref).toBe("release-tag-1");
    expect(parseUpdateArgs(["--ref", "feature/foo-bar"]).ref).toBe("feature/foo-bar");
    expect(parseUpdateArgs(["--ref", "9f8e7d6"]).ref).toBe("9f8e7d6"); // a short sha
  });
});

describe("resolveUpdatePath — selection + TTY → effective path", () => {
  it("explicit --cli always wins, never interactive", () => {
    expect(resolveUpdatePath("cli", true)).toMatchObject({ path: "cli", interactive: false });
    expect(resolveUpdatePath("cli", false)).toMatchObject({ path: "cli", interactive: false });
  });

  it("explicit --instance always wins, never interactive", () => {
    expect(resolveUpdatePath("instance", true)).toMatchObject({ path: "instance", interactive: false });
    expect(resolveUpdatePath("instance", false)).toMatchObject({ path: "instance", interactive: false });
  });

  it("no selection + TTY → interactive picker, default = CLI", () => {
    const r = resolveUpdatePath(null, true);
    expect(r.interactive).toBe(true);
    expect(r.path).toBe("cli"); // the highlighted default before the user picks
  });

  it("no selection + NO TTY → instance (back-compat), never interactive (never hangs)", () => {
    const r = resolveUpdatePath(null, false);
    expect(r.interactive).toBe(false);
    expect(r.path).toBe("instance");
  });
});

describe("resolveInstanceMoveTarget — instance type → git-move target", () => {
  it("dev → fast-forward latest origin/main (kind ref, ref main)", () => {
    expect(resolveInstanceMoveTarget("development", null)).toMatchObject({ kind: "ref", ref: "main" });
  });

  it("prod → latest v* release tag (kind tag, ref resolved by caller = null)", () => {
    expect(resolveInstanceMoveTarget("production", null)).toMatchObject({ kind: "tag", ref: null });
  });

  it("an explicit --ref overrides the type default for a DEV instance", () => {
    expect(resolveInstanceMoveTarget("development", "release-tag-9")).toMatchObject({ kind: "ref", ref: "release-tag-9" });
  });

  it("rejects --ref for a PRODUCTION instance — image tag/digest, not a git ref (cinatra-cli#146)", () => {
    expect(() => resolveInstanceMoveTarget("production", "mybranch")).toThrow(/Refusing --ref "mybranch"/);
    expect(() => resolveInstanceMoveTarget("production", "v-anything")).toThrow(/published release image/);
    // The prod default (no --ref) is untouched: still the latest v* release.
    expect(resolveInstanceMoveTarget("production", null)).toMatchObject({ kind: "tag", ref: null });
  });
});

describe("CLI install spec", () => {
  it("targets @cinatra-ai/cinatra@latest", () => {
    expect(CLI_INSTALL_SPEC).toBe("@cinatra-ai/cinatra@latest");
  });
});

// End-to-end proof for the codex-converged concern: the dev instance target
// (`ref: "main"`, kind "ref") must land on the LATEST origin/main, not a stale
// local main. We build a bare origin + an instance clone, advance origin by a
// commit AFTER the clone, then run the REAL git-move helper exactly as
// runInstanceUpdate(dev) does and assert the instance reached the new upstream tip.
describe("dev instance move → fast-forwards to LATEST origin/main (real git)", () => {
  let work = "";
  const git = (cwd, args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).trim();

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-update-ff-"));
    const origin = path.join(work, "origin.git");
    const seed = path.join(work, "seed");
    const inst = path.join(work, "inst");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["clone", "-q", origin, seed]);
    git(seed, ["commit", "-q", "--allow-empty", "-m", "c1"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
    execFileSync("git", ["clone", "-q", origin, inst]);
    git(inst, ["checkout", "-q", "-B", "main", "origin/main"]);
    // Advance origin/main AFTER the instance was cloned (a new upstream commit).
    git(seed, ["commit", "-q", "--allow-empty", "-m", "c2"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("the dev target moves the instance to the new origin/main tip + stays on main", () => {
    const seed = path.join(work, "seed");
    const inst = path.join(work, "inst");
    const move = resolveInstanceMoveTarget("development", null);
    expect(move).toMatchObject({ kind: "ref", ref: "main" });

    const before = git(inst, ["rev-parse", "HEAD"]);
    const upstream = git(seed, ["rev-parse", "HEAD"]);
    expect(before).not.toBe(upstream); // the instance starts behind upstream

    const moved = moveExistingCheckoutToRef({
      targetDir: inst,
      ref: move.ref,
      kind: move.kind,
      force: false,
      log: () => {},
    });

    expect(moved).toBe(upstream); // landed exactly on the LATEST origin/main
    expect(git(inst, ["rev-parse", "HEAD"])).toBe(upstream);
    expect(git(inst, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main"); // stayed on the branch
  });
});
