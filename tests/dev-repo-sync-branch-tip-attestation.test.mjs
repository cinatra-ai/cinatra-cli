// cinatra-cli#200 — BRANCH-TIP SYNC ATTESTATION (`syncedSha`).
//
// Dev-mode companion checkouts track branch TIPS and never carry a lock pin, so
// they could never join the committed-lock skew exemption (cinatra#1136) — yet
// their upstream advancing without a version bump is routine, and the sync
// itself is what moves them there. `syncOneRepo` therefore emits a POSITIVE,
// re-verified attestation on the branch-mode paths: HEAD is exactly the
// freshly-fetched `origin/<branch>` tip AND the tree carries no local work.
//
// It is deliberately a VERIFIED STATE, not an action: an install syncs the
// extensions twice and only the second (setup-phase) run's results are read, so
// a warm no-op pull must attest just as a real fast-forward does. Everything
// unverifiable is fail-closed — no attestation, and the downstream seed keeps
// treating that content as unattributed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  PUBLISHED_MARKER_BASENAME,
  attestationStillHolds,
  defaultRepoSyncDeps,
  packedPathsAreTrackedAndUnhidden,
  syncOneRepo,
} from "../src/dev-repo-sync.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

/** An upstream repo with one commit on `main`, plus a seed clone to advance it. */
function makeUpstream(work, name) {
  const origin = path.join(work, `${name}-origin.git`);
  const seed = path.join(work, `${name}-seed`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, seed]);
  git(seed, ["config", "user.email", "t@t"]);
  git(seed, ["config", "user.name", "t"]);
  writeFileSync(path.join(seed, "package.json"), `{"name":"@cinatra-ai/${name}","version":"0.1.0"}\n`);
  writeFileSync(path.join(seed, "index.js"), "module.exports = 1;\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-q", "-m", "c1"]);
  git(seed, ["push", "-q", "origin", "HEAD:main"]);
  return { origin, seed, tip: () => git(seed, ["rev-parse", "HEAD"]) };
}

/** Move the upstream forward WITHOUT a version bump (the routine drift shape). */
function advance(up, body) {
  writeFileSync(path.join(up.seed, "index.js"), body);
  git(up.seed, ["add", "."]);
  git(up.seed, ["commit", "-q", "-m", "upstream moves"]);
  git(up.seed, ["push", "-q", "origin", "HEAD:main"]);
  return up.tip();
}

const base = (origin, dest, extra = {}) => ({
  pkgName: "@cinatra-ai/drift-connector",
  url: origin,
  branch: "main",
  dest,
  force: false,
  deps: defaultRepoSyncDeps(),
  log: () => {},
  ...extra,
});

describe("syncOneRepo — branch-tip sync attestation (cinatra-cli#200)", () => {
  let work;
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-attest-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("a fresh branch-mode CLONE attests the tip it just cloned", () => {
    const up = makeUpstream(work, "clone-case");
    const dest = path.join(work, "clone-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "cloned", syncedSha: up.tip() });
  });

  it("a WARM no-op pull still attests — the state is what matters, not the action", () => {
    // The exact case the reported bug turns on: an in-place update syncs twice,
    // and the setup-phase run finds nothing to do. It must still attest.
    const up = makeUpstream(work, "warm-case");
    const dest = path.join(work, "warm-case-checkout");
    syncOneRepo(base(up.origin, dest));
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "updated", changed: false, syncedSha: up.tip() });
  });

  it("a fast-forward to a MOVED upstream attests the NEW tip", () => {
    const up = makeUpstream(work, "ff-case");
    const dest = path.join(work, "ff-case-checkout");
    const first = syncOneRepo(base(up.origin, dest));
    const moved = advance(up, "module.exports = 2;\n");
    expect(moved).not.toBe(first.syncedSha);
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "updated", changed: true, syncedSha: moved });
  });

  it("a DIRTY worktree is skipped and attests NOTHING (real local edits)", () => {
    const up = makeUpstream(work, "dirty-case");
    const dest = path.join(work, "dirty-case-checkout");
    syncOneRepo(base(up.origin, dest));
    writeFileSync(path.join(dest, "index.js"), "module.exports = 'LOCAL EDIT';\n");
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "skipped-dirty" });
    expect(r.syncedSha).toBeUndefined();
  });

  it("a CLEAN tree carrying local COMMITS ahead of upstream attests nothing (fail-closed)", () => {
    // `git merge --ff-only` reports "Already up to date" when HEAD is AHEAD, so
    // a committed-but-unpushed local change would sail through the action check.
    // The attestation re-reads HEAD against the remote-tracking tip instead.
    const up = makeUpstream(work, "ahead-case");
    const dest = path.join(work, "ahead-case-checkout");
    syncOneRepo(base(up.origin, dest));
    git(dest, ["config", "user.email", "t@t"]);
    git(dest, ["config", "user.name", "t"]);
    writeFileSync(path.join(dest, "index.js"), "module.exports = 'LOCAL COMMIT';\n");
    git(dest, ["add", "."]);
    git(dest, ["commit", "-q", "-m", "local work"]);
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "updated" });
    expect(r.syncedSha).toBeUndefined();
  });

  it("--force (stash + hard reset to the tip) attests the reset tip", () => {
    const up = makeUpstream(work, "force-case");
    const dest = path.join(work, "force-case-checkout");
    syncOneRepo(base(up.origin, dest));
    writeFileSync(path.join(dest, "index.js"), "module.exports = 'LOCAL EDIT';\n");
    const r = syncOneRepo(base(up.origin, dest, { force: true }));
    expect(r).toMatchObject({ action: "force-reset", syncedSha: up.tip() });
  });

  it("untracked published-marker debris does not block the attestation", () => {
    // Module-wide invariant (cinatra#1136): the runtime-written marker is tool
    // output, not local work — it does not make the tree `dirty` and must not
    // silently withdraw the attestation either.
    const up = makeUpstream(work, "marker-case");
    const dest = path.join(work, "marker-case-checkout");
    syncOneRepo(base(up.origin, dest));
    writeFileSync(path.join(dest, PUBLISHED_MARKER_BASENAME), `{"oasSha256":"deadbeef"}\n`);
    const r = syncOneRepo(base(up.origin, dest));
    expect(r).toMatchObject({ action: "updated", syncedSha: up.tip() });
  });

  it("PINNED mode is untouched — it attests `pinnedSha`, never `syncedSha`", () => {
    const up = makeUpstream(work, "pinned-case");
    const dest = path.join(work, "pinned-case-checkout");
    const pin = up.tip();
    const r = syncOneRepo(base(up.origin, dest, { sha: pin }));
    expect(r).toMatchObject({ action: "cloned", pinnedSha: pin });
    expect(r.syncedSha).toBeUndefined();
  });
});

describe("attestationStillHolds — re-verification at the point of use (cinatra-cli#200)", () => {
  // An attestation is a statement about an instant; setup does real work
  // between the sync and the consumers that read it, so consumers re-ask.
  let work;
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-reverify-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("holds for the checkout the sync just attested", () => {
    const up = makeUpstream(work, "holds-case");
    const dest = path.join(work, "holds-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    expect(attestationStillHolds({ dest, sha: r.syncedSha })).toBe(true);
  });

  it("is WITHDRAWN once the tree is edited after the sync", () => {
    const up = makeUpstream(work, "mutated-case");
    const dest = path.join(work, "mutated-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    writeFileSync(path.join(dest, "index.js"), "module.exports = 'EDITED AFTER SYNC';\n");
    expect(attestationStillHolds({ dest, sha: r.syncedSha })).toBe(false);
  });

  it("is WITHDRAWN once HEAD moves away from the attested sha", () => {
    const up = makeUpstream(work, "moved-case");
    const dest = path.join(work, "moved-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    advance(up, "module.exports = 2;\n");
    git(dest, ["fetch", "-q", "origin", "main"]);
    git(dest, ["merge", "--ff-only", "-q", "origin/main"]);
    expect(attestationStillHolds({ dest, sha: r.syncedSha })).toBe(false);
  });

  it("survives stray published-marker debris (not local work)", () => {
    const up = makeUpstream(work, "marker-reverify-case");
    const dest = path.join(work, "marker-reverify-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    writeFileSync(path.join(dest, PUBLISHED_MARKER_BASENAME), `{"oasSha256":"deadbeef"}\n`);
    expect(attestationStillHolds({ dest, sha: r.syncedSha })).toBe(true);
  });

  it("sees untracked work even when the repo config hides it from `git status`", () => {
    // `status.showUntrackedFiles=no` is a display preference; dirtiness (and
    // therefore an attestation) must not depend on it.
    const up = makeUpstream(work, "hidden-untracked-case");
    const dest = path.join(work, "hidden-untracked-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    git(dest, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(path.join(dest, "sneaky.js"), "module.exports = 'UNTRACKED WORK';\n");
    expect(attestationStillHolds({ dest, sha: r.syncedSha })).toBe(false);
  });

  it("fails closed on a missing dir, a non-git dir, or a malformed sha", () => {
    const up = makeUpstream(work, "failclosed-case");
    const dest = path.join(work, "failclosed-case-checkout");
    const r = syncOneRepo(base(up.origin, dest));
    expect(attestationStillHolds({ dest: path.join(work, "nope"), sha: r.syncedSha })).toBe(false);
    expect(attestationStillHolds({ dest: work, sha: r.syncedSha })).toBe(false);
    expect(attestationStillHolds({ dest, sha: "not-a-sha" })).toBe(false);
    expect(attestationStillHolds({ dest, sha: undefined })).toBe(false);
    expect(attestationStillHolds({})).toBe(false);
    expect(attestationStillHolds()).toBe(false);
  });
});

describe("packedPathsAreTrackedAndUnhidden — second-stage packed provenance (cinatra-cli#200)", () => {
  // `git status` cannot see two classes of packable content: files hidden from
  // the index (assume-unchanged / skip-worktree) and ignored files a package's
  // `files` field nevertheless packs. Whatever `npm pack` produced must be a
  // file set git actually vouches for.
  let work;
  let dest;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-packed-"));
    const up = makeUpstream(work, "packed-case");
    dest = path.join(work, "packed-case-checkout");
    syncOneRepo(base(up.origin, dest));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("vouches for a packed set that is entirely tracked", () => {
    expect(packedPathsAreTrackedAndUnhidden({ dir: dest, files: ["package.json", "index.js"] })).toBe(true);
  });

  it("refuses a packed file git does not track (ignored build output)", () => {
    expect(
      packedPathsAreTrackedAndUnhidden({ dir: dest, files: ["package.json", "generated.js"] }),
    ).toBe(false);
  });

  it("refuses a packed file hidden with assume-unchanged", () => {
    git(dest, ["update-index", "--assume-unchanged", "index.js"]);
    try {
      expect(packedPathsAreTrackedAndUnhidden({ dir: dest, files: ["index.js"] })).toBe(false);
    } finally {
      git(dest, ["update-index", "--no-assume-unchanged", "index.js"]);
    }
  });

  it("refuses a packed file hidden with skip-worktree", () => {
    git(dest, ["update-index", "--skip-worktree", "index.js"]);
    try {
      expect(packedPathsAreTrackedAndUnhidden({ dir: dest, files: ["index.js"] })).toBe(false);
    } finally {
      git(dest, ["update-index", "--no-skip-worktree", "index.js"]);
    }
  });

  it("allows the runtime-written published marker (tool debris, never local work)", () => {
    expect(
      packedPathsAreTrackedAndUnhidden({
        dir: dest,
        files: ["package.json", PUBLISHED_MARKER_BASENAME],
      }),
    ).toBe(true);
  });

  it("the marker allowance is UNTRACKED-only — a tracked, hidden marker is real divergence", () => {
    // Otherwise the allowance would become a hole: commit the marker, hide it
    // from the index, and its content rides along unattested.
    writeFileSync(path.join(dest, PUBLISHED_MARKER_BASENAME), `{"oasSha256":"deadbeef"}\n`);
    git(dest, ["add", PUBLISHED_MARKER_BASENAME]);
    git(dest, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "track the marker"]);
    git(dest, ["update-index", "--skip-worktree", PUBLISHED_MARKER_BASENAME]);
    try {
      expect(packedPathsAreTrackedAndUnhidden({ dir: dest, files: [PUBLISHED_MARKER_BASENAME] })).toBe(
        false,
      );
    } finally {
      git(dest, ["update-index", "--no-skip-worktree", PUBLISHED_MARKER_BASENAME]);
      git(dest, ["rm", "-q", "--cached", PUBLISHED_MARKER_BASENAME]);
      git(dest, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "untrack the marker"]);
      rmSync(path.join(dest, PUBLISHED_MARKER_BASENAME), { force: true });
    }
  });

  it("fails closed on an empty list, a missing dir, or a non-git dir", () => {
    expect(packedPathsAreTrackedAndUnhidden({ dir: dest, files: [] })).toBe(false);
    expect(packedPathsAreTrackedAndUnhidden({ dir: dest })).toBe(false);
    expect(packedPathsAreTrackedAndUnhidden({ dir: path.join(work, "nope"), files: ["index.js"] })).toBe(false);
    expect(packedPathsAreTrackedAndUnhidden({})).toBe(false);
    expect(packedPathsAreTrackedAndUnhidden()).toBe(false);
  });
});
