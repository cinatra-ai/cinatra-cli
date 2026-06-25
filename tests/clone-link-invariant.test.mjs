// cinatra-cli#41 — `setup clone` 500s because the regenerated extension
// manifest emits a literal `import()` for every on-disk connector under
// `extensions/`, but pnpm only symlinks a workspace member a dependant declares
// — so the synced devExtension connectors land on disk yet UNLINKED, and the
// manifest references modules Turbopack can't resolve at compile time.
//
// The unit-level invariant: AFTER the link step, the set of emitted-but-unlinked
// packages must be EMPTY. `linkedSetMatchesEmittedSet(worktree, fs)` is the pure
// seam (inject a fake fs); `repairWorkspaceConnectorLinks` /
// `ensureClonedExtensionsLinked` are exercised against a real temp worktree so
// the symlink repair (and its durability/idempotence) is proven on real fs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  linkedSetMatchesEmittedSet,
  enumerateEmittedExtensionPackages,
  repairWorkspaceConnectorLinks,
  ensureClonedExtensionsLinked,
} from "../src/index.mjs";

// ---------------------------------------------------------------------------
// Fake fs builder — models extensions/<scope>/<name>/package.json + a
// node_modules link set, for the PURE helper (no real disk).
// ---------------------------------------------------------------------------
function makeFakeFs({ extensions = {}, linked = {} } = {}) {
  // `extensions`: { "<scope>/<name>": { name?: "<pkgName>", badJson?: true, noPkg?: true } }
  // `linked`: { "<pkgName>": { hasPkgJson?: true } }  (a linked node_modules entry)
  const dirs = new Set();
  const files = new Map(); // absolute path -> content
  const SEP = path.sep;

  function addDir(p) {
    dirs.add(p);
  }
  function addFile(p, content) {
    files.set(p, content);
    addDir(path.dirname(p));
  }

  // The worktree root marker — we don't know it yet; helpers always join from
  // the worktree the caller passes. We register entries relative to a fixed root.
  const root = path.join(SEP, "wt");
  addDir(root);
  addDir(path.join(root, "extensions"));
  addDir(path.join(root, "node_modules"));

  for (const [rel, spec] of Object.entries(extensions)) {
    const [scope, name] = rel.split("/");
    const dir = path.join(root, "extensions", scope, name);
    addDir(dir);
    if (!spec.noPkg) {
      const pkgPath = path.join(dir, "package.json");
      if (spec.badJson) addFile(pkgPath, "{ not json");
      else addFile(pkgPath, JSON.stringify({ name: spec.name }));
    }
  }
  for (const [pkgName, spec] of Object.entries(linked)) {
    const linkDir = path.join(root, "node_modules", pkgName);
    addDir(linkDir);
    if (spec.hasPkgJson !== false) addFile(path.join(linkDir, "package.json"), JSON.stringify({ name: pkgName }));
  }

  const fs = {
    existsSync: (p) => dirs.has(p) || files.has(p),
    readdirSync: (p, _opts) => {
      const children = new Map();
      const prefix = p.endsWith(SEP) ? p : p + SEP;
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.slice(prefix.length);
          const seg = rest.split(SEP)[0];
          if (seg) children.set(seg, true);
        }
      }
      for (const f of files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length);
          const seg = rest.split(SEP)[0];
          if (seg && !children.has(seg)) children.set(seg, false);
        }
      }
      return [...children.entries()].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
      }));
    },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    lstatSync: (p) => {
      if (!dirs.has(p) && !files.has(p)) throw new Error(`ENOENT: ${p}`);
      return { isDirectory: () => dirs.has(p) };
    },
    mkdirSync: (p) => addDir(p),
    symlinkSync: () => {
      throw new Error("symlink not supported by fake fs");
    },
  };
  return { fs, root };
}

describe("cinatra-cli#41 — linkedSetMatchesEmittedSet (pure)", () => {
  it("returns the emitted-but-unlinked package set (the bug condition)", () => {
    const { fs, root } = makeFakeFs({
      extensions: {
        "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" },
        "cinatra-ai/slack-connector": { name: "@cinatra-ai/slack-connector" },
      },
      linked: {
        // only slack is linked; youtube is on disk but not in node_modules
        "@cinatra-ai/slack-connector": {},
      },
    });
    expect(linkedSetMatchesEmittedSet(root, fs)).toEqual(["@cinatra-ai/youtube-connector"]);
  });

  it("is EMPTY when every emitted connector is linked (post-link invariant)", () => {
    const { fs, root } = makeFakeFs({
      extensions: {
        "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" },
        "cinatra-ai/slack-connector": { name: "@cinatra-ai/slack-connector" },
      },
      linked: {
        "@cinatra-ai/youtube-connector": {},
        "@cinatra-ai/slack-connector": {},
      },
    });
    expect(linkedSetMatchesEmittedSet(root, fs)).toEqual([]);
  });

  it("treats a node_modules entry WITHOUT a package.json as unlinked", () => {
    const { fs, root } = makeFakeFs({
      extensions: { "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" } },
      linked: { "@cinatra-ai/youtube-connector": { hasPkgJson: false } },
    });
    expect(linkedSetMatchesEmittedSet(root, fs)).toEqual(["@cinatra-ai/youtube-connector"]);
  });

  it("skips on-disk dirs with no/unparseable package.json (generator wouldn't emit them)", () => {
    const { fs, root } = makeFakeFs({
      extensions: {
        "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" },
        "cinatra-ai/no-manifest": { noPkg: true },
        "cinatra-ai/bad-manifest": { badJson: true },
      },
      linked: {},
    });
    expect(linkedSetMatchesEmittedSet(root, fs)).toEqual(["@cinatra-ai/youtube-connector"]);
  });

  it("enumerateEmittedExtensionPackages reports name + on-disk dir for each emitted package", () => {
    const { fs, root } = makeFakeFs({
      extensions: { "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" } },
    });
    const pkgs = enumerateEmittedExtensionPackages(root, fs);
    expect(pkgs).toHaveLength(1);
    expect(pkgs[0].name).toBe("@cinatra-ai/youtube-connector");
    expect(pkgs[0].dir).toBe(path.join(root, "extensions", "cinatra-ai", "youtube-connector"));
  });

  it("fails closed on a connector whose package.json name is a path-traversal string", () => {
    const { fs, root } = makeFakeFs({
      extensions: {
        "cinatra-ai/evil": { name: "../../../../etc/passwd" },
        "cinatra-ai/youtube-connector": { name: "@cinatra-ai/youtube-connector" },
      },
      linked: {},
    });
    // The generator WOULD emit the traversal name, so the invariant must report
    // it as unlinked (fail closed) — never silently treat it as not-emitted.
    expect(linkedSetMatchesEmittedSet(root, fs)).toEqual([
      "../../../../etc/passwd",
      "@cinatra-ai/youtube-connector",
    ]);
    // It is carried in the emission universe with an `unsafe` flag.
    const evil = enumerateEmittedExtensionPackages(root, fs).find((p) => p.name === "../../../../etc/passwd");
    expect(evil.unsafe).toBe(true);
  });

  it("returns [] for a worktree with no extensions/ dir", () => {
    const fs = {
      existsSync: () => false,
      readdirSync: () => [],
      readFileSync: () => "{}",
      lstatSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      symlinkSync: () => {},
    };
    expect(linkedSetMatchesEmittedSet("/nowhere", fs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real-fs repair: prove the symlink repair makes the invariant hold and is
// idempotent / durable (re-running after a simulated `pnpm install` keeps it).
// ---------------------------------------------------------------------------
describe("cinatra-cli#41 — repairWorkspaceConnectorLinks / ensureClonedExtensionsLinked (real fs)", () => {
  let wt;
  beforeEach(() => {
    wt = mkdtempSync(path.join(os.tmpdir(), "cli41-"));
  });
  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
  });

  function writeConnector(scope, name, pkgName) {
    const dir = path.join(wt, "extensions", scope, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkgName, exports: { "./register": "./src/register.ts" } }));
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "register.ts"), "export function register() {}\n");
    return dir;
  }

  it("links an unlinked emitted connector and closes the invariant", () => {
    writeConnector("cinatra-ai", "youtube-connector", "@cinatra-ai/youtube-connector");
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });

    // Pre: emitted but unlinked.
    expect(linkedSetMatchesEmittedSet(wt)).toEqual(["@cinatra-ai/youtube-connector"]);

    const res = repairWorkspaceConnectorLinks(wt, { log: () => {} });
    expect(res.repaired).toEqual(["@cinatra-ai/youtube-connector"]);
    expect(res.stillMissing).toEqual([]);

    // Post: invariant holds — empty unlinked set.
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);

    // The created entry is a symlink resolving to the workspace member dir.
    const linkPath = path.join(wt, "node_modules", "@cinatra-ai", "youtube-connector");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(linkPath, "package.json"))).toBe(true);
    // And the /register source resolves THROUGH the link (the failing import path).
    expect(existsSync(path.join(linkPath, "src", "register.ts"))).toBe(true);
  });

  it("ensureClonedExtensionsLinked verifies+repairs and reports ok with no residual", () => {
    writeConnector("cinatra-ai", "youtube-connector", "@cinatra-ai/youtube-connector");
    writeConnector("cinatra-ai", "slack-connector", "@cinatra-ai/slack-connector");
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });

    const state = ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(state.ok).toBe(true);
    expect(state.repaired.sort()).toEqual(["@cinatra-ai/slack-connector", "@cinatra-ai/youtube-connector"]);
    expect(state.stillMissing).toEqual([]);
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);
  });

  it("fails closed (ok:false, refuses repair) when an emitted name is unsafe", () => {
    // A well-formed connector that CAN be linked, plus a malformed-name one.
    writeConnector("cinatra-ai", "youtube-connector", "@cinatra-ai/youtube-connector");
    const evilDir = path.join(wt, "extensions", "cinatra-ai", "evil");
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(path.join(evilDir, "package.json"), JSON.stringify({ name: "../../../../etc/escaped" }));
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });

    const state = ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(state.ok).toBe(false);
    // The safe connector still gets linked…
    expect(state.repaired).toContain("@cinatra-ai/youtube-connector");
    // …but the unsafe one is refused and keeps the gate closed.
    expect(state.stillMissing).toContain("../../../../etc/escaped");
    // No path escape occurred outside node_modules.
    expect(existsSync(path.join(wt, "..", "..", "..", "..", "etc", "escaped"))).toBe(false);
  });

  it("is idempotent: a second run is a no-op and keeps the invariant (durable)", () => {
    writeConnector("cinatra-ai", "youtube-connector", "@cinatra-ai/youtube-connector");
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });

    ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);

    // Second run finds nothing to repair (already linked → empty set → no-op).
    const second = ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(second.ok).toBe(true);
    expect(second.repaired).toEqual([]);
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);
  });

  it("re-links after a simulated `pnpm install` removed the link (survives a later install)", () => {
    const srcDir = writeConnector("cinatra-ai", "youtube-connector", "@cinatra-ai/youtube-connector");
    mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);

    // Simulate a later `pnpm install` wiping the link.
    rmSync(path.join(wt, "node_modules", "@cinatra-ai", "youtube-connector"), { recursive: true, force: true });
    expect(linkedSetMatchesEmittedSet(wt)).toEqual(["@cinatra-ai/youtube-connector"]);

    // Re-running the guard restores it (durability via re-run, not in-place).
    const again = ensureClonedExtensionsLinked(wt, { log: () => {} });
    expect(again.ok).toBe(true);
    expect(linkedSetMatchesEmittedSet(wt)).toEqual([]);
    expect(existsSync(path.join(srcDir, "src", "register.ts"))).toBe(true);
  });
});
