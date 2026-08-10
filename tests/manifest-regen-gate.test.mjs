// cinatra#2637 — a fresh `cinatra install --mode dev` could not establish the
// public MCP URL, and the run said almost nothing about why.
//
// The reported chain: the workspace re-link ran a hard-coded `corepack pnpm
// install`, which on a host without Corepack exits 127; the extension-manifest
// regeneration was gated on that command's EXIT STATUS, so it was skipped with a
// single quiet line and the generated maps never described the checkout's own
// cloned extensions. The three seams this file pins:
//
//   1. the install invocation is CHOSEN, never assumed (three-tier selection,
//      cinatra-cli#205/#207) and the chosen label travels with the verdict, so
//      the recovery text names the command that actually ran;
//   2. the regeneration gate blocks on the TREE's state (sync reconciled, #41
//      link invariant, and — only when an install ran and failed — hydration),
//      never on the install command's exit status alone; a blocked regeneration
//      is LOUD and names the exact recovery, and a re-run repeats the step;
//   3. an unresolvable dev-CLI key says WHICH tree was scanned and what to run.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideManifestRegenGate,
  unhydratedSyncedExtensions,
  regenerateExtensionManifestAfterSync,
  installAfterExtensionSync,
} from "../src/index.mjs";
import {
  describeDevCliDeclarerMissing,
  scanDevCliExtensionTree,
  loadDevCliModule,
} from "../src/dev-cli-modules.mjs";

const present =
  (...cmds) =>
  (cmd) =>
    cmds.includes(cmd);

const tmpDirs = [];
function makeTree() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-2637-"));
  tmpDirs.push(dir);
  return dir;
}
/** Materialize `extensions/<scope>/<name>` with an optional deps declaration
 *  and an optional per-package node_modules (the "hydrated" marker). */
function makeExtension(root, name, { deps = true, hydrated = true, devCliModules = null } = {}) {
  const dir = path.join(root, "extensions", "cinatra-ai", name);
  mkdirSync(dir, { recursive: true });
  const pkg = { name: `@cinatra-ai/${name}`, version: "0.0.0" };
  if (deps) pkg.dependencies = { "node-fetch": "^3.0.0" };
  if (devCliModules) pkg.cinatra = { devCliModules };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  if (hydrated) mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. The fallback decision travels to the recovery text.
// ---------------------------------------------------------------------------
describe("the re-link verdict names the invocation that ran (cinatra#2637)", () => {
  const syncResult = { results: [{ action: "cloned", dest: "/repo/extensions/cinatra-ai/x" }] };

  it("reports the bare-pnpm label when Corepack is absent — the reported host shape", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn: () => ({ status: 0 }),
      exists: present("pnpm"),
    });
    // NOT "corepack pnpm install": the run must say which one it used.
    expect(res).toEqual({ ok: true, label: "pnpm install" });
  });

  it("carries the label into the FAILED verdict too, so the caller can quote it", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn: () => ({ status: 1 }),
      exists: present("pnpm"),
    });
    expect(res).toEqual({ ok: false, label: "pnpm install" });
    const blob = errors.mock.calls.flat().join("\n");
    // The re-run must be named as the thing that clears the state.
    expect(blob).toContain("cinatra instance setup dev");
  });
});

// ---------------------------------------------------------------------------
// 2. The regeneration gate.
// ---------------------------------------------------------------------------
describe("decideManifestRegenGate", () => {
  it("does NOT block on a failed install when the tree is linked and hydrated (the cinatra#2637 fix)", () => {
    const gate = decideManifestRegenGate({
      syncFailed: false,
      linkOk: true,
      installOk: false, // e.g. the install command does not exist on this host
      installLabel: "pnpm install",
      unhydrated: [],
    });
    expect(gate.blocked).toBe(false);
    // …and the run is expected to SAY it regenerated anyway.
    expect(gate.regeneratedDespiteInstallFailure).toBe(true);
  });

  it("blocks when the #41 link invariant is violated, naming the packages and the recovery", () => {
    const gate = decideManifestRegenGate({
      linkOk: false,
      stillMissing: ["@cinatra-ai/tailscale-connector"],
      installOk: true,
      installLabel: "pnpm install",
    });
    expect(gate.blocked).toBe(true);
    expect(gate.blockedBy).toContain("@cinatra-ai/tailscale-connector");
    expect(gate.recovery).toEqual(["pnpm install", "cinatra instance setup dev"]);
  });

  it("blocks when a FAILED install left synced extensions without node_modules", () => {
    const gate = decideManifestRegenGate({
      linkOk: true,
      installOk: false,
      installLabel: "npm exec -y -- pnpm@11.1.2 install",
      unhydrated: ["/repo/extensions/cinatra-ai/tailscale-connector"],
    });
    expect(gate.blocked).toBe(true);
    expect(gate.blockedBy).toContain("tailscale-connector");
    expect(gate.recovery[0]).toBe("npm exec -y -- pnpm@11.1.2 install");
  });

  it("does not treat unhydrated extensions as a blocker when no install ran (branch-isolation path)", () => {
    const gate = decideManifestRegenGate({
      linkOk: true,
      installOk: true, // no install verdict on that path
      unhydrated: ["/repo/extensions/cinatra-ai/tailscale-connector"],
    });
    expect(gate.blocked).toBe(false);
    expect(gate.regeneratedDespiteInstallFailure).toBe(false);
  });

  it("blocks a failed SYNC — the tree it would regenerate against is unknown", () => {
    const gate = decideManifestRegenGate({ syncFailed: true });
    expect(gate.blocked).toBe(true);
    expect(gate.recovery).toEqual(["cinatra instance setup dev"]);
  });
});

describe("unhydratedSyncedExtensions", () => {
  it("lists only synced extensions that declare deps and have no node_modules", () => {
    const root = makeTree();
    const dry = makeExtension(root, "tailscale-connector", { deps: true, hydrated: false });
    const wet = makeExtension(root, "github-connector", { deps: true, hydrated: true });
    const depless = makeExtension(root, "text-artifact", { deps: false, hydrated: false });
    const gone = path.join(root, "extensions", "cinatra-ai", "not-cloned");
    const syncResult = {
      results: [{ dest: dry }, { dest: wet }, { dest: depless }, { dest: gone }],
    };
    expect(unhydratedSyncedExtensions(syncResult)).toEqual([dry]);
  });

  it("is empty for a sync that produced nothing", () => {
    expect(unhydratedSyncedExtensions(undefined)).toEqual([]);
    expect(unhydratedSyncedExtensions({ skipped: true })).toEqual([]);
  });
});

describe("regenerateExtensionManifestAfterSync messaging", () => {
  const reconciled = { results: [{ action: "cloned", dest: "/repo/extensions/cinatra-ai/x" }] };

  it("is LOUD, names the blocker, the exact recovery commands, and that a re-run repeats it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    regenerateExtensionManifestAfterSync("/repo", reconciled, {
      failed: true,
      blockedBy: "3 synced extension(s) are not linked into node_modules",
      recovery: ["pnpm install", "cinatra instance setup dev"],
    });
    const blob = errors.mock.calls.flat().join("\n");
    expect(blob).toContain("3 synced extension(s) are not linked into node_modules");
    expect(blob).toContain("1. pnpm install");
    expect(blob).toContain("2. cinatra instance setup dev");
    expect(blob).toContain("node scripts/extensions/generate-extension-manifest.mjs");
    expect(blob).toContain("re-run");
    // Loud means visible in the exit status too.
    expect(process.exitCode).toBe(1);
  });

  it("stays a quiet informational line for a BENIGN skip (nothing to regenerate against)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    regenerateExtensionManifestAfterSync("/repo", { skipped: true, reason: "no-config" }, {});
    expect(errors).not.toHaveBeenCalled();
    expect(logs.mock.calls.flat().join("\n")).toContain(
      "Skipping extension-manifest regeneration",
    );
    expect(process.exitCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. The unresolvable dev-CLI key gets a recovery hint.
// ---------------------------------------------------------------------------
describe("unresolvable dev-CLI key (cinatra#2637)", () => {
  it("names the scanned tree, what was in it, and the two recovery steps", () => {
    const msg = describeDevCliDeclarerMissing("tailscale-hostname", "/checkout/extensions", {
      treeExists: true,
      packages: 212,
      keys: ["tailscale-api"],
    });
    expect(msg).toContain('dev-CLI key "tailscale-hostname"');
    expect(msg).toContain("/checkout/extensions");
    expect(msg).toContain("212 extension package(s) scanned");
    expect(msg).toContain("tailscale-api");
    expect(msg).toContain("cinatra instance setup dev");
    expect(msg).toContain("CINATRA_REPO_ROOT=");
  });

  it("says the tree does not exist yet when nothing has been cloned", () => {
    const msg = describeDevCliDeclarerMissing("tailscale-hostname", "/checkout/extensions", {
      treeExists: false,
      packages: 0,
      keys: [],
    });
    expect(msg).toContain("does not exist yet");
  });

  it("scans a real tree and reports the declared keys it did find", () => {
    const root = makeTree();
    makeExtension(root, "tailscale-connector", {
      devCliModules: { "tailscale-api": "./src/api.mjs" },
    });
    makeExtension(root, "github-connector", {});
    const scan = scanDevCliExtensionTree(path.join(root, "extensions"));
    expect(scan).toEqual({ treeExists: true, packages: 2, keys: ["tailscale-api"] });
  });

  it("throws the hinted message — still ERR_MODULE_NOT_FOUND + the declarer-missing marker", async () => {
    const root = makeTree();
    makeExtension(root, "github-connector", {});
    await expect(loadDevCliModule("tailscale-hostname", root)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
      cinatraDevCliDeclarerMissing: true,
    });
    await expect(loadDevCliModule("tailscale-hostname", root)).rejects.toThrow(
      /Recover:[\s\S]*cinatra instance setup dev/,
    );
  });
});
