// Regression for cinatra#735: the marker-hit re-verify walk
// (`computeTreeSha256FromDir`) must skip the pnpm-managed `node_modules`
// subtree whether it lands as a real directory OR as a symlink, BUT must still
// hard-fail on any symlink OUTSIDE `node_modules`.
//
// The bug: `pnpm setup:prod` re-verifies each already-acquired extension after
// `pnpm install` linked the in-repo `@cinatra-ai/sdk-extensions` workspace
// package into its `node_modules`. pnpm's nested/hoisted layout can land the
// `node_modules` install root itself AS A SYMLINK — `isDirectory()` is false,
// so a name-check nested under an `isDirectory()` branch was bypassed and the
// walk fell through to the non-regular-entry `throw`, failing closed with:
//   [prod-extension-acquisition] unexpected non-regular entry in acquired tree:
//   node_modules/@cinatra-ai/sdk-extensions
// The published `@cinatra-ai/cinatra` CLI (what `setup:prod` actually runs) is
// built from THIS repo, so the fix has to live here, not only in cinatra's
// private in-repo helper copy.

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeTreeSha256FromDir } from "../src/prod-extension-acquisition.mjs";

describe("computeTreeSha256FromDir node_modules handling (cinatra#735)", () => {
  let root;
  let storeOutside;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cinatra-acq-735-"));
    // The pnpm store lives OUTSIDE the acquired tree (as in a real install),
    // so the only way the walk could reach it is via the node_modules symlink.
    storeOutside = mkdtempSync(path.join(tmpdir(), "cinatra-acq-735-store-"));
    // A minimal acquired-extension payload (the real upstream tree).
    writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n');
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "index.mjs"), "export default 1;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(storeOutside, { recursive: true, force: true });
  });

  it("skips a node_modules DIRECTORY that contains symlinks", () => {
    const nm = path.join(root, "node_modules", "@cinatra-ai");
    mkdirSync(nm, { recursive: true });
    // A real pnpm-style workspace symlink inside node_modules.
    symlinkSync(
      path.join(root, "src"),
      path.join(nm, "sdk-extensions"),
      "dir",
    );
    expect(() => computeTreeSha256FromDir(root)).not.toThrow();
  });

  it("skips a node_modules install root that is ITSELF a SYMLINK (the #735 shape)", () => {
    // Simulate pnpm landing the node_modules root as a symlink to a store dir
    // that sits OUTSIDE the acquired extension tree.
    mkdirSync(path.join(storeOutside, "@cinatra-ai", "x"), { recursive: true });
    symlinkSync(
      path.join(storeOutside, "@cinatra-ai", "x"),
      path.join(storeOutside, "@cinatra-ai", "sdk-extensions"),
      "dir",
    );
    symlinkSync(storeOutside, path.join(root, "node_modules"), "dir");
    // Before the fix this threw "unexpected non-regular entry ... node_modules".
    expect(() => computeTreeSha256FromDir(root)).not.toThrow();
  });

  it("STILL hard-fails on a symlink OUTSIDE node_modules", () => {
    symlinkSync(
      path.join(root, "src", "index.mjs"),
      path.join(root, "evil-link.mjs"),
      "file",
    );
    expect(() => computeTreeSha256FromDir(root)).toThrow(
      /unexpected non-regular entry/,
    );
  });

  it("produces a stable hash regardless of a skipped node_modules", () => {
    const before = computeTreeSha256FromDir(root);
    const nm = path.join(root, "node_modules", "@cinatra-ai");
    mkdirSync(nm, { recursive: true });
    symlinkSync(path.join(root, "src"), path.join(nm, "sdk-extensions"), "dir");
    const after = computeTreeSha256FromDir(root);
    expect(after).toBe(before);
  });
});
