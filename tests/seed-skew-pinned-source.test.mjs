// Regression for cinatra#1136 (update-path exit code): after an upgrade the
// local Verdaccio still carries tarballs seeded from the PREVIOUS release's
// companion pins, while the on-disk source legitimately moved to the CURRENT
// committed lock — usually with the SAME package version. The seed's
// version-skew guard treated that exactly like ad-hoc local edits and flipped
// `process.exitCode = 1`, turning an otherwise fully successful
// `cinatra instance refresh` reconcile into a non-zero exit. For sources the
// extension sync verified AT a committed lock pin (`pinnedSourceNames`), the
// skew must stay a WARNING (the registry keeps serving the previously seeded
// content for that version until a bump/purge) without flipping the exit
// code. Non-pinned skew (local edits without a version bump) keeps flipping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { seedLocalRegistryExtensions } from "../src/seed-local-registry.mjs";

const PKG = "@cinatra-ai/apollo-prospecting-agent";
const VERSION = "0.1.0";

// A minimal on-disk extension the enumerator accepts and `npm pack` can pack
// offline (name + version + one file).
function makeRepoWithExtension() {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-1136-seed-"));
  const dir = path.join(root, "extensions", "cinatra-ai", "apollo-prospecting-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PKG, version: VERSION, main: "index.js" }),
  );
  writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
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
      pinnedSourceNames: new Set([PKG]),
    });
    expect(summary.status).toBe("ok");
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]); // still recorded + warned
    expect(process.exitCode).toBe(0); // but a successful reconcile stays exit 0
  });

  it("skew on a NON-pinned source (local edits) still flips the exit code", async () => {
    const summary = await seedLocalRegistryExtensions({
      repoRoot: root,
      registryUrl: "http://127.0.0.1:14875",
    });
    expect(summary.status).toBe("ok");
    expect(summary.skew).toEqual([`${PKG}@${VERSION}`]);
    expect(process.exitCode).toBe(1);
  });
});
