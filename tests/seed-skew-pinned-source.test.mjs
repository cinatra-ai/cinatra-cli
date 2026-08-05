// Regression for cinatra#1136 (update-path exit code): after an upgrade the
// local Verdaccio still carries tarballs seeded from the PREVIOUS release's
// companion pins, while the on-disk source legitimately moved to the CURRENT
// committed lock — usually with the SAME package version. The seed's
// version-skew guard treated that exactly like ad-hoc local edits and flipped
// `process.exitCode = 1`, turning an otherwise fully successful
// `cinatra instance refresh` reconcile into a non-zero exit. For sources the
// extension sync verified AT a committed lock pin (`pinnedSourceDirs`), the
// skew must stay a WARNING (the registry keeps serving the previously seeded
// content for that version until a bump/purge) without flipping the exit
// code. Non-pinned skew (local edits without a version bump) stays MEANINGFUL.
//
// cinatra-cli#200 amends WHERE that meaningful skew becomes an exit code: the
// seed no longer sets `process.exitCode` for a skew at all (its "loud-but-
// non-fatal" contract was being defeated by its own signaling channel at the
// process boundary). It records the unattributed ids in `summary.unexemptedSkew`
// and the CALLER classifies them via `classifySetupExitCode` — asserted below,
// so the "non-pinned skew still surfaces as a non-zero setup exit" guarantee
// this file was written for is still pinned end-to-end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  SETUP_EXIT_REGISTRY_SKEW,
  classifySetupExitCode,
  seedLocalRegistryExtensions,
} from "../src/seed-local-registry.mjs";

const PKG = "@cinatra-ai/apollo-prospecting-agent";
const VERSION = "0.1.0";

/** Where the enumerator finds the fixture extension — the exemption is keyed by
 *  this resolved DIRECTORY, not by the package name (cinatra-cli#200). */
const extensionDir = (root) =>
  path.resolve(root, "extensions", "cinatra-ai", "apollo-prospecting-agent");

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

// A minimal on-disk extension the enumerator accepts and `npm pack` can pack
// offline (name + version + one file). It is a REAL git checkout so the seed's
// second-stage provenance check (cinatra-cli#200 — "does git vouch for the
// packed file set?") runs for real rather than being stubbed out.
function makeRepoWithExtension() {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-1136-seed-"));
  const dir = extensionDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PKG, version: VERSION, main: "index.js" }),
  );
  writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "c1"]);
  return root;
}

// fetch double: registry reachable, seed user provisioned, packument already
// carries VERSION with an integrity that can never match the local pack →
// the SKEW branch is taken deterministically.
function mockRegistryFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    if (init.method === "PUT" && url.includes("/-/user/")) {
      return new Response(JSON.stringify({ token: "seed-token" }), { status: 201 });
    }
    if (url.includes(encodeURIComponent(PKG)) || url.includes("apollo-prospecting-agent")) {
      return new Response(
        JSON.stringify({
          name: PKG,
          versions: {
            [VERSION]: { dist: { integrity: "sha512-previous-release-content-never-matches" } },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  });
}

describe("seedLocalRegistryExtensions — skew vs committed-lock pinned sources (cinatra#1136)", () => {
  let fetchSpy;
  let root;

  beforeEach(() => {
    process.exitCode = 0;
    fetchSpy = mockRegistryFetch();
    root = makeRepoWithExtension();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("skew on a PINNED (committed-lock) source warns but does NOT flip the exit code", async () => {
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
      pinnedSourceDirs: new Set([extensionDir(root)]),
    });
    expect(summary.status).toBe("ok");
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]); // still recorded + warned
    expect(summary.unexemptedSkew).toEqual([]); // attributed to the committed pin
    expect(process.exitCode).toBe(0); // but a successful reconcile stays exit 0
    // …and the caller's classification agrees: nothing to report.
    expect(classifySetupExitCode(process.exitCode, summary.unexemptedSkew)).toBe(0);
  });

  it("skew on a NON-pinned source (local edits) still surfaces as a non-zero setup exit", async () => {
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
    });
    expect(summary.status).toBe("ok");
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    // cinatra-cli#200: recorded as unattributed, and the SEED itself leaves the
    // exit code alone — the decision moved to the caller…
    expect(summary.unexemptedSkew).toEqual([`${PKG}@${VERSION}`]);
    expect(process.exitCode).toBe(0);
    // …which still exits non-zero, now with the TYPED skew code instead of a
    // bare 1 that the install boundary could only read as "setup failed".
    expect(classifySetupExitCode(process.exitCode, summary.unexemptedSkew)).toBe(
      SETUP_EXIT_REGISTRY_SKEW,
    );
    expect(SETUP_EXIT_REGISTRY_SKEW).not.toBe(0);
  });

  it("an exempt checkout whose packed set git cannot vouch for is NOT exempt", async () => {
    // cinatra-cli#200 (codex review): the checkout is at the attested commit
    // with a clean status, but a tracked file was hidden from git with
    // `assume-unchanged` and then edited — so the packed bytes are not the
    // sync's. The second-stage check catches what status cannot see.
    const dir = extensionDir(root);
    git(dir, ["update-index", "--assume-unchanged", "index.js"]);
    writeFileSync(path.join(dir, "index.js"), "module.exports = 'HIDDEN LOCAL EDIT';\n");
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
      pinnedSourceDirs: new Set([dir]),
    });
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    expect(summary.unexemptedSkew).toEqual([`${PKG}@${VERSION}`]);
  });

  it("an exempt checkout packing an UNTRACKED file is NOT exempt", async () => {
    // Ignored-but-packed content (build output a `files` field ships) is
    // invisible to `git status` yet lands in the tarball.
    const dir = extensionDir(root);
    writeFileSync(path.join(dir, ".gitignore"), "generated.js\n");
    writeFileSync(path.join(dir, "generated.js"), "module.exports = 'BUILT LOCALLY';\n");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: PKG, version: VERSION, main: "index.js", files: ["index.js", "generated.js"] }),
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "ship generated.js"]);
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
      syncedSourceDirs: new Set([dir]),
    });
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    expect(summary.unexemptedSkew).toEqual([`${PKG}@${VERSION}`]);
  });

  it("an untracked file packed as a HARD LINK is not exempt either", async () => {
    // codex review: node-tar writes the second and later members sharing an
    // inode as `Link` entries, so an untracked hard link to a tracked file
    // would slip past a File-only member list.
    const dir = extensionDir(root);
    linkSync(path.join(dir, "index.js"), path.join(dir, "linked.js"));
    writeFileSync(path.join(dir, ".gitignore"), "linked.js\n");
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: PKG, version: VERSION, main: "index.js", files: ["index.js", "linked.js"] }),
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "ship a hard-linked file"]);
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
      syncedSourceDirs: new Set([dir]),
    });
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    expect(summary.unexemptedSkew).toEqual([`${PKG}@${VERSION}`]);
  });

  it("an exemption for a DIFFERENT directory never covers this checkout", async () => {
    // cinatra-cli#200 (codex review): the exemption names the exact checkout the
    // sync verified. An attestation for some other directory — even one whose
    // manifest declares the same package name — attests nothing about this one.
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
      pinnedSourceDirs: new Set([path.resolve(root, "somewhere-else")]),
      syncedSourceDirs: new Set([path.resolve(root, "another-place")]),
    });
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    expect(summary.unexemptedSkew).toEqual([`${PKG}@${VERSION}`]);
  });
});
