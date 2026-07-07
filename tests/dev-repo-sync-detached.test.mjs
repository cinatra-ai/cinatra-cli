// Regression for cinatra#835: `cinatra instance refresh` / `instance setup dev`
// run the dev-extension sync in NON-PINNED mode against companions that a pinned
// `make setup` (scripts/ci/sync-dev-extensions.mjs --pinned, cinatra#489) left
// checked out DETACHED at the committed lock SHA. Before the fix, syncOneRepo's
// non-pinned branch-name assertion treated the detached "HEAD" as a wrong branch
// and THREW ("tracks ... on branch \"HEAD\", but ... on \"main\" is expected"),
// exiting the documented update path non-zero with a confusing error even though
// the checkout sat at exactly the lock the tree was built against.
//
// The fix: a detached, origin-matching companion in non-pinned mode is the
// committed-lock state — leave it AS-IS (skipped-detached), never throw, never
// drag it to the branch tip. A wrong origin, or a NON-detached wrong branch,
// still hard-fails. Pinned mode is unchanged.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { syncOneRepo, defaultRepoSyncDeps } from "../src/dev-repo-sync.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

// A fresh "companion origin" bare repo + a clone of it, matching what
// `make setup` produces for extensions/<scope>/<name>. Returns { origin, dest,
// lockSha, tipSha }. `dest` is left DETACHED at lockSha (the pinned state).
function makeDetachedCompanion(work, name) {
  const origin = path.join(work, `${name}-origin.git`);
  const seed = path.join(work, `${name}-seed`);
  const dest = path.join(work, `${name}-checkout`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, seed]);
  git(seed, ["config", "user.email", "t@t"]);
  git(seed, ["config", "user.name", "t"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "c1"]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", origin, dest]);
  const lockSha = git(dest, ["rev-parse", "HEAD"]);
  // Advance origin AFTER the clone so "tip" differs from the pinned "lock".
  git(seed, ["commit", "-q", "--allow-empty", "-m", "c2"]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);
  const tipSha = git(seed, ["rev-parse", "HEAD"]);
  git(dest, ["checkout", "-q", "--detach", lockSha]); // pinned fresh-clone state
  return { origin, seed, dest, lockSha, tipSha };
}

const base = (origin, dest) => ({
  pkgName: "@cinatra-ai/a2a-server-connector",
  url: origin,
  branch: "main",
  dest,
  force: false,
  deps: defaultRepoSyncDeps(),
  log: () => {},
});

describe("syncOneRepo — detached companion in non-pinned mode (cinatra#835)", () => {
  let work;
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-835-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("non-pinned + detached + matching origin → skipped-detached, HEAD unchanged, no throw", () => {
    const { origin, dest, lockSha } = makeDetachedCompanion(work, "ok");
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD"); // detached precondition
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined });
    expect(r).toMatchObject({ action: "skipped-detached", changed: false });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(lockSha); // left AT the pin
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD"); // still detached
  });

  it("non-pinned + detached + WRONG origin → still hard-fails", () => {
    const { dest } = makeDetachedCompanion(work, "wrongorigin");
    const bogusOrigin = path.join(work, "some-other-origin.git"); // absolute → allowed remote, but != dest origin
    expect(() => syncOneRepo({ ...base(bogusOrigin, dest), sha: undefined })).toThrow(
      /tracks .* on branch "HEAD"/,
    );
  });

  it("non-pinned + NON-detached wrong branch → still hard-fails", () => {
    const { origin, dest } = makeDetachedCompanion(work, "wrongbranch");
    git(dest, ["checkout", "-q", "-B", "feature"]); // real branch, not "main"
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
    expect(() => syncOneRepo({ ...base(origin, dest), sha: undefined })).toThrow(
      /on branch "feature", but .* on "main" is expected/,
    );
  });

  it("PINNED + detached at the pin is unchanged (action: pinned, still detached)", () => {
    const { origin, dest, lockSha } = makeDetachedCompanion(work, "pinned");
    const r = syncOneRepo({ ...base(origin, dest), sha: lockSha });
    expect(r).toMatchObject({ action: "pinned", changed: false, pinnedSha: lockSha });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(lockSha);
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  it("non-pinned + on the branch (not detached) still fast-forwards to origin tip", () => {
    const { origin, seed, dest, tipSha } = makeDetachedCompanion(work, "onbranch");
    git(dest, ["checkout", "-q", "-B", "main", "origin/main"]); // reattach to the (behind) local main
    const before = git(dest, ["rev-parse", "HEAD"]);
    expect(before).not.toBe(tipSha); // behind the advanced origin
    const r = syncOneRepo({ ...base(origin, dest), sha: undefined });
    expect(r).toMatchObject({ action: "updated", changed: true });
    expect(git(dest, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"])); // ff'd to tip
    expect(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});
