// The install's OWN working-tree byproducts (cinatra-ai/cinatra-cli#198).
//
// A COMPLETED `cinatra install` leaves its checkout dirty with two files the
// installer itself wrote (`pnpm-lock.yaml` from the workspace re-link, the
// tracked generated extension barrel from the manifest regeneration). The
// clean-tree guard could only COUNT dirt, so it refused the documented
// `install → install` reconcile on 100% of post-completion re-runs and steered
// every operator to `--force` — whose stash-everything behaviour would one day
// stash the real operator work the guard exists to protect.
//
// The classification is pure; the guard is exercised against a REAL local git
// checkout (no network, no docker), which is the level the regression lives at.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  INSTALL_BYPRODUCT_RULES,
  INSTALL_BYPRODUCT_STATUS_CODES,
  byproductBoundaryLines,
  byproductExemptionLines,
  classifyWorkingTreeDirt,
  installByproductDriftLines,
  isInstallByproductPath,
  parseGitPorcelainZ,
} from "../src/install-byproducts.mjs";
import { moveExistingCheckoutToRef } from "../src/install.mjs";

// `git status --porcelain -z` emits NUL-terminated records.
const z = (...records) => records.map((r) => `${r}\0`).join("");

// The exact dirt a completed install leaves (reproduced in the issue).
const COMPLETED_INSTALL_DIRT = z(" M pnpm-lock.yaml", " M src/lib/generated/extensions.server.ts");

describe("install byproducts — porcelain parsing (#198)", () => {
  it("parses the NUL-separated records git actually emits", () => {
    const entries = parseGitPorcelainZ(COMPLETED_INSTALL_DIRT);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ code: " M", path: "pnpm-lock.yaml", untracked: false });
    expect(entries[1].path).toBe("src/lib/generated/extensions.server.ts");
  });

  it("keeps a path containing a space intact (the reason for -z over the quoted form)", () => {
    const entries = parseGitPorcelainZ(z(" M src/my notes.md"));
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("src/my notes.md");
  });

  it("carries a rename's ORIGINAL path from EITHER status column", () => {
    const staged = parseGitPorcelainZ(z("R  src/new.ts", "src/old.ts"));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ code: "R ", path: "src/new.ts", from: "src/old.ts" });
    // Git reports a WORK-TREE-side rename/copy in the second column. Consuming
    // only the first would leave "src/old.ts" standing as a bogus record — and
    // a short one, so it would be silently dropped rather than refused.
    const worktree = parseGitPorcelainZ(z(" R src/lib/generated/new.ts", "a"));
    expect(worktree).toHaveLength(1);
    expect(worktree[0]).toMatchObject({ code: " R", path: "src/lib/generated/new.ts", from: "a" });
    const copied = parseGitPorcelainZ(z(" C src/lib/generated/new.ts", "src/app/page.tsx"));
    expect(copied[0].from).toBe("src/app/page.tsx");
  });

  it("flags untracked entries and tolerates empty/garbage input", () => {
    expect(parseGitPorcelainZ(z("?? dev/a2a-peers/"))[0].untracked).toBe(true);
    expect(parseGitPorcelainZ("")).toEqual([]);
    expect(parseGitPorcelainZ(null)).toEqual([]);
    expect(parseGitPorcelainZ(z("x"))).toEqual([]);
  });
});

describe("install byproducts — the declared boundary (#198 AC2, AC3)", () => {
  it("recognises exactly the paths the install's own phases regenerate", () => {
    expect(isInstallByproductPath("pnpm-lock.yaml")).toBe(true);
    expect(isInstallByproductPath("src/lib/generated/extensions.server.ts")).toBe(true);
    expect(isInstallByproductPath("src/lib/generated/nested/other.ts")).toBe(true);
  });

  it("recognises NOTHING else — a near-miss is operator work", () => {
    expect(isInstallByproductPath("package.json")).toBe(false);
    expect(isInstallByproductPath("pnpm-workspace.yaml")).toBe(false);
    expect(isInstallByproductPath("src/lib/generated.ts")).toBe(false);
    expect(isInstallByproductPath("src/lib/generatedX/thing.ts")).toBe(false);
    expect(isInstallByproductPath("packages/x/pnpm-lock.yaml")).toBe(false);
    expect(isInstallByproductPath("")).toBe(false);
    expect(isInstallByproductPath(null)).toBe(false);
  });

  it("never NORMALISES the path git already gave it verbatim", () => {
    // A backslash is a legal character in a POSIX filename and `-z` reports it
    // raw. Folding it to "/" would make this real, tracked OPERATOR file match
    // the `src/lib/generated/` rule — skipping its refusal and then feeding it
    // to `git checkout HEAD --`.
    expect(isInstallByproductPath(String.raw`src\lib\generated\notes.ts`)).toBe(false);
    expect(isInstallByproductPath("./pnpm-lock.yaml")).toBe(false);
  });

  it("AC3: every exempted path is stated, with the phase that writes it", () => {
    const lines = byproductBoundaryLines().join("\n");
    for (const rule of INSTALL_BYPRODUCT_RULES) {
      expect(lines).toContain(rule.path);
      expect(lines).toContain(rule.why);
    }
  });
});

describe("install byproducts — classification (#198 AC1, AC2)", () => {
  it("classifies a completed install's dirt as the INSTALL's own", () => {
    const dirt = classifyWorkingTreeDirt(COMPLETED_INSTALL_DIRT);
    expect(dirt.operator).toEqual([]);
    expect(dirt.byproducts.map((e) => e.path)).toEqual([
      "pnpm-lock.yaml",
      "src/lib/generated/extensions.server.ts",
    ]);
    expect(dirt.resettable).toEqual(["pnpm-lock.yaml", "src/lib/generated/extensions.server.ts"]);
  });

  it("classifies an operator edit as the OPERATOR's, even alongside byproducts", () => {
    const dirt = classifyWorkingTreeDirt(z(" M pnpm-lock.yaml", " M src/app/page.tsx"));
    expect(dirt.operator.map((e) => e.path)).toEqual(["src/app/page.tsx"]);
    expect(dirt.byproducts.map((e) => e.path)).toEqual(["pnpm-lock.yaml"]);
  });

  it("a rename/copy is NEVER ours — setup rewrites in place, it never moves files", () => {
    // Onto a byproduct path…
    expect(classifyWorkingTreeDirt(z("R  pnpm-lock.yaml", "src/app/page.tsx")).operator).toHaveLength(1);
    // …out of one…
    expect(classifyWorkingTreeDirt(z("R  src/app/page.tsx", "pnpm-lock.yaml")).operator).toHaveLength(1);
    // …and even BETWEEN two install-owned paths: a move is operator work.
    const between = classifyWorkingTreeDirt(
      z("R  src/lib/generated/b.ts", "src/lib/generated/a.ts"),
    );
    expect(between.operator).toHaveLength(1);
    expect(between.byproducts).toEqual([]);
  });

  it("FAILS CLOSED on any status shape setup does not produce", () => {
    // Each of these sits at an install-owned PATH, and each must still refuse:
    // an unmerged conflict cannot be restored from HEAD, and a staged
    // addition/deletion is not an in-place regeneration.
    for (const code of ["UU", "AA", "DD", "A ", "D ", " D", "AM", "!!"]) {
      const dirt = classifyWorkingTreeDirt(z(`${code} pnpm-lock.yaml`));
      expect(dirt.byproducts, `code ${code} must not be exempt`).toEqual([]);
      expect(dirt.operator).toHaveLength(1);
    }
    // …while the shapes it DOES produce are exempt.
    for (const code of INSTALL_BYPRODUCT_STATUS_CODES) {
      expect(classifyWorkingTreeDirt(z(`${code} pnpm-lock.yaml`)).byproducts).toHaveLength(1);
    }
  });

  it("an UNTRACKED byproduct is exempt from the refusal but never reset (nothing in HEAD)", () => {
    const dirt = classifyWorkingTreeDirt(z("?? src/lib/generated/new-barrel.ts"));
    expect(dirt.operator).toEqual([]);
    expect(dirt.byproducts).toHaveLength(1);
    expect(dirt.resettable).toEqual([]);
  });

  it("a clean tree is clean", () => {
    const dirt = classifyWorkingTreeDirt("");
    expect(dirt.clean).toBe(true);
    expect(dirt.operator).toEqual([]);
    expect(dirt.byproducts).toEqual([]);
  });

  it("the exemption report names the paths AND the boundary (AC3)", () => {
    const dirt = classifyWorkingTreeDirt(COMPLETED_INSTALL_DIRT);
    const text = byproductExemptionLines(dirt.byproducts).join("\n");
    expect(text).toContain("pnpm-lock.yaml");
    expect(text).toContain("Every other uncommitted change still refuses");
    expect(byproductExemptionLines([])).toEqual([]);
  });

  it("the drift note fires ONLY for dirt outside the declared set (AC3)", () => {
    expect(installByproductDriftLines(classifyWorkingTreeDirt(COMPLETED_INSTALL_DIRT))).toEqual([]);
    const drifted = installByproductDriftLines(classifyWorkingTreeDirt(z(" M src/app/page.tsx")));
    expect(drifted.join("\n")).toContain("src/app/page.tsx");
    expect(drifted.join("\n")).toContain("will REFUSE");
  });
});

// ---------------------------------------------------------------------------
// The guard itself, against a REAL local checkout — the regression that let
// this ship (AC1, AC2, AC4, AC5).
// ---------------------------------------------------------------------------

describe("moveExistingCheckoutToRef — install → install on a completed checkout (#198)", () => {
  let sandbox;
  let originRepo;
  let checkout;
  let secondSha;

  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "ignore",
    });
  const Gout = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      encoding: "utf8",
    }).trim();

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-byproducts-"));
    const src = path.join(sandbox, "src-repo");
    mkdirSync(path.join(src, "src", "lib", "generated"), { recursive: true });
    mkdirSync(path.join(src, "src", "app"), { recursive: true });
    writeFileSync(path.join(src, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(path.join(src, "src/lib/generated/extensions.server.ts"), "export const EXTENSIONS = [];\n");
    writeFileSync(path.join(src, "src/app/page.tsx"), "export default function Page() {}\n");
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "checkout at the installed ref"], src);
    // A second commit so the reconcile has somewhere to fast-forward TO.
    writeFileSync(path.join(src, "README.md"), "second\n");
    G(["add", "-A"], src);
    G(["commit", "-m", "second"], src);
    secondSha = Gout(["rev-parse", "HEAD"], src);

    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);
  });

  afterAll(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  beforeEach(() => {
    // A fresh checkout parked one commit BEHIND origin/main — i.e. exactly the
    // state a reconcile has to move.
    checkout = mkdtempSync(path.join(sandbox, "checkout-"));
    rmSync(checkout, { recursive: true, force: true });
    G(["clone", originRepo, checkout], sandbox);
    G(["checkout", "HEAD~1"], checkout);
    G(["checkout", "-B", "main"], checkout);
  });

  /** Reproduce EXACTLY what a completed install leaves behind. */
  const dirtyWithInstallByproducts = () => {
    writeFileSync(path.join(checkout, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# workspace re-link\n");
    writeFileSync(
      path.join(checkout, "src/lib/generated/extensions.server.ts"),
      "export const EXTENSIONS = ['acquired'];\n",
    );
  };

  it("AC1: the identical re-run now RECONCILES instead of refusing (no --force)", () => {
    dirtyWithInstallByproducts();
    expect(Gout(["status", "--porcelain"], checkout)).not.toBe("");

    const logs = [];
    const sha = moveExistingCheckoutToRef({
      targetDir: checkout,
      ref: "main",
      log: (m) => logs.push(String(m)),
    });
    expect(sha).toBe(secondSha);
    // The byproducts were restored from HEAD so the fast-forward was not blocked
    // — setup regenerates them later in the same run.
    expect(Gout(["status", "--porcelain"], checkout)).toBe("");
    // AC3: the exemption is REPORTED, never silent.
    const text = logs.join("\n");
    expect(text).toContain("pnpm-lock.yaml");
    expect(text).toContain("Every other uncommitted change still refuses");
  });

  it("AC4: identical for a plain dev checkout — the byproducts are the shared setup phase's", () => {
    // Nothing here is preview-specific: the same two paths, the same guard.
    dirtyWithInstallByproducts();
    expect(() => moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", log: () => {} })).not.toThrow();
  });

  it("AC2: a genuine operator edit still REFUSES, with the same actionable remedy", () => {
    writeFileSync(path.join(checkout, "src/app/page.tsx"), "export default function Page() { /* mine */ }\n");
    let err;
    try {
      moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", log: () => {} });
    } catch (e) {
      err = e.message;
    }
    expect(err).toMatch(/Refusing to move/);
    expect(err).toMatch(/re-run with --force/);
    // It now NAMES the offending path, and states what it does not protect.
    expect(err).toContain("src/app/page.tsx");
    expect(err).toContain("pnpm-lock.yaml");
    // And it did not touch the operator's work.
    expect(readFileSync(path.join(checkout, "src/app/page.tsx"), "utf8")).toContain("mine");
  });

  it("AC2: operator dirt ALONGSIDE the install's own byproducts still refuses", () => {
    dirtyWithInstallByproducts();
    writeFileSync(path.join(checkout, "src/app/page.tsx"), "export default function Page() { /* mine */ }\n");
    expect(() => moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", log: () => {} })).toThrow(
      /Refusing to move/,
    );
    // The byproducts must NOT have been reset on the refusing path — the guard
    // aborts before any side effect, exactly as it always has.
    expect(readFileSync(path.join(checkout, "pnpm-lock.yaml"), "utf8")).toContain("workspace re-link");
  });

  it("--force still stashes everything (its semantics are untouched)", () => {
    writeFileSync(path.join(checkout, "src/app/page.tsx"), "export default function Page() { /* mine */ }\n");
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", force: true, log: () => {} });
    expect(sha).toBe(secondSha);
    expect(Gout(["stash", "list"], checkout)).toMatch(/cinatra move main/);
  });

  it("a clean tree moves exactly as before", () => {
    expect(Gout(["status", "--porcelain"], checkout)).toBe("");
    expect(moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", log: () => {} })).toBe(secondSha);
  });

  it("the injected `workingTreeIsDirty` seam still forces the pre-#198 refusal", () => {
    expect(() =>
      moveExistingCheckoutToRef({
        targetDir: checkout,
        ref: "main",
        log: () => {},
        deps: { workingTreeIsDirty: () => true },
      }),
    ).toThrow(/Refusing to move/);
  });
});
