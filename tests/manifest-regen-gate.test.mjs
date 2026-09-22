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
//   2. a BLOCKED regeneration (failed sync / #41 link violation / failed
//      re-link) is loud: it names the blocker and the ordered recovery
//      commands — resolved for THIS host — and says a re-run repeats the step;
//   3. an unresolvable dev-CLI key says WHICH tree was scanned and what to run.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideManifestRegenGate,
  generatedMapsDriftLines,
  parseGeneratedMapDrift,
  regenerateExtensionManifestAfterSync,
  installAfterExtensionSync,
} from "../src/index.mjs";
import { SETUP_EXIT_GENERATED_MAPS_DRIFT } from "../src/install-byproducts.mjs";
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
    expect(blob).toContain("exit 1");
    // The re-run must be named as the thing that clears the state.
    expect(blob).toContain("cinatra instance setup dev");
  });

  it("says the command is not on PATH — never `(exit null)` — when it cannot run at all", () => {
    // The reported host: no package manager, so spawn returns status null with
    // an ENOENT error. "cannot run it" and "it ran and failed" want different
    // fixes, so the message must not conflate them.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn: () => ({ status: null, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
      exists: () => false, // neither corepack nor pnpm nor npm
    });
    expect(res).toEqual({ ok: false, label: "corepack pnpm install" });
    const blob = errors.mock.calls.flat().join("\n");
    expect(blob).toContain("`corepack` is not on PATH");
    expect(blob).not.toContain("exit null");
    expect(blob).toContain("npm install -g pnpm");
  });

  it("gives the prod (failHard) abort the same not-on-PATH guidance", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      installAfterExtensionSync("/repo", syncResult, {
        failHard: true,
        spawn: () => ({ status: null, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) }),
        exists: () => false,
      }),
    ).toThrow(/`corepack` is not on PATH[\s\S]*npm install -g pnpm/);
  });
});

// ---------------------------------------------------------------------------
// 2. The regeneration gate.
// ---------------------------------------------------------------------------
describe("decideManifestRegenGate", () => {
  it("blocks a FAILED re-link — the synced extensions' own dependencies are unproven", () => {
    // codex round 1 (adopted): a present `node_modules` does not prove the
    // dependency graph resolves, so a non-zero install stays a blocker. What
    // changes is that the block is now attributable and recoverable.
    const gate = decideManifestRegenGate({
      linkOk: true,
      installOk: false,
      installLabel: "pnpm install",
    });
    expect(gate.blocked).toBe(true);
    expect(gate.blockedBy).toContain("re-link failed");
    expect(gate.recovery).toEqual(["pnpm install", "cinatra instance setup dev"]);
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

  it("blocks a failed SYNC — the tree it would regenerate against is unknown", () => {
    const gate = decideManifestRegenGate({ syncFailed: true });
    expect(gate.blocked).toBe(true);
    expect(gate.recovery).toEqual(["cinatra instance setup dev"]);
  });

  it("does not block a reconciled, linked, installed tree", () => {
    expect(decideManifestRegenGate({ linkOk: true, installOk: true })).toEqual({
      blocked: false,
      blockedBy: null,
      recovery: [],
    });
  });

  // cinatra#2637 — the recovery command must be one THIS host can run: naming
  // `corepack pnpm install` on a Corepack-less host is what left the reporter
  // with no way forward.
  it("resolves the re-link label for the host when no install ran, lazily", () => {
    let probes = 0;
    const resolveInstallLabel = () => {
      probes += 1;
      return "npm exec -y -- pnpm@11.1.2 install";
    };
    const clean = decideManifestRegenGate({ linkOk: true, installOk: true, resolveInstallLabel });
    expect(clean.blocked).toBe(false);
    expect(probes).toBe(0); // never probed on the happy path

    const blocked = decideManifestRegenGate({
      linkOk: false,
      stillMissing: ["@cinatra-ai/tailscale-connector"],
      resolveInstallLabel,
    });
    expect(blocked.recovery[0]).toBe("npm exec -y -- pnpm@11.1.2 install");
    expect(probes).toBe(1);
  });

  it("degrades to `pnpm install` when the host probe itself throws", () => {
    const gate = decideManifestRegenGate({
      linkOk: false,
      resolveInstallLabel: () => {
        throw new Error("probe exploded");
      },
    });
    expect(gate.recovery).toEqual(["pnpm install", "cinatra instance setup dev"]);
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

  // codex round 2: this scan runs on a FAILURE path over repo-external data, so
  // it must never be the thing that hangs or explodes.
  it("stays bounded on a hostile tree: no symlinked dirs, no non-regular manifests, truncated keys", () => {
    const root = makeTree();
    const real = makeExtension(root, "tailscale-connector", {
      devCliModules: { ["k".repeat(200)]: "./src/x.mjs" },
    });
    // A symlinked package dir must not be walked into…
    symlinkSync(real, path.join(root, "extensions", "cinatra-ai", "linked-copy"), "dir");
    // …and a package.json that is a DIRECTORY (stand-in for any non-regular
    // file, e.g. a FIFO that would block a read forever) is skipped.
    mkdirSync(path.join(root, "extensions", "cinatra-ai", "weird", "package.json"), {
      recursive: true,
    });
    const scan = scanDevCliExtensionTree(path.join(root, "extensions"));
    expect(scan.treeExists).toBe(true);
    expect(scan.packages).toBe(1); // the real one only
    expect(scan.keys).toEqual(["k".repeat(64)]);
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

// ---------------------------------------------------------------------------
// 4. `--pinned-extensions`: the maps are CHECKED, never rewritten (cinatra-cli#270).
// ---------------------------------------------------------------------------
//
// The generated extension maps are one of the install's two declared working-
// tree byproducts (src/install-byproducts.mjs). `--frozen-lockfile` already
// keeps the other one — the lockfile — out of an unattended caller's checkout;
// nothing kept these, so a caller working in a checkout parked at an exact
// commit and required to hand it back byte-for-byte clean got a dirty tree from
// every run. With `--pinned-extensions` the fleet stands at the checkout's OWN
// committed lock, so the maps cannot legitimately move: the setup phase runs
// the generator in its CHECK mode and stops on a difference instead of
// rewriting tracked files.
//
// The generator below is the CHECKOUT's own script, spawned by relative path —
// so the fixture reproduces its CONTRACT rather than mocking our call: write
// mode rewrites the maps; `--check` writes nothing, prints
// `[extension-manifest] DRIFT <path>` for every differing file and exits 1.
const MAP_REL = "src/lib/generated/extensions.server.ts";
const MAP_CURRENT = 'export const EXTENSIONS = ["pinned"];\n';
const MAP_STALE = 'export const EXTENSIONS = ["stale"];\n';

const GENERATOR_STUB = [
  "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "const root = process.cwd();",
  "const files = JSON.parse(readFileSync(path.join(root, 'emission.json'), 'utf8'));",
  "const args = process.argv.slice(2);",
  "const tag = args.includes('--self') ? 'SELF-CHECK ' : '';",
  "if (args.includes('--check')) {",
  "  let drift = false;",
  "  for (const [rel, content] of Object.entries(files)) {",
  "    const file = path.join(root, rel);",
  "    if (!existsSync(file)) {",
  "      console.error('[extension-manifest] ' + tag + 'MISSING ' + rel + ' — regenerate: node scripts/extensions/generate-extension-manifest.mjs');",
  "      drift = true;",
  "      continue;",
  "    }",
  "    if (readFileSync(file, 'utf8') !== content) {",
  "      console.error('[extension-manifest] ' + tag + 'DRIFT ' + rel + ' — file differs from generator output (hand-edit or stale; regenerate, never hand-edit)');",
  "      drift = true;",
  "    }",
  "  }",
  "  if (drift) {",
  "    console.error('[extension-manifest] FAIL (canonical mode) — generated-tree drift and/or catalog parity break (see lines above).');",
  "    process.exit(1);",
  "  }",
  "  console.log('[extension-manifest] OK — generated files current + parity holds.');",
  "  process.exit(0);",
  "}",
  "for (const [rel, content] of Object.entries(files)) {",
  "  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });",
  "  writeFileSync(path.join(root, rel), content);",
  "}",
  "console.log('[extension-manifest] wrote ' + Object.keys(files).length + ' files');",
].join("\n");

/** A checkout whose generator emits MAP_CURRENT, with `onDisk` committed. */
function makeCheckout(onDisk) {
  const root = makeTree();
  mkdirSync(path.join(root, "scripts", "extensions"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts", "extensions", "generate-extension-manifest.mjs"),
    GENERATOR_STUB,
  );
  writeFileSync(path.join(root, "emission.json"), JSON.stringify({ [MAP_REL]: MAP_CURRENT }));
  mkdirSync(path.join(root, "src", "lib", "generated"), { recursive: true });
  writeFileSync(path.join(root, MAP_REL), onDisk);
  return root;
}
const mapDigest = (root) =>
  createHash("sha256").update(readFileSync(path.join(root, MAP_REL))).digest("hex");
const mapText = (root) => readFileSync(path.join(root, MAP_REL), "utf8");

describe("the generated maps under --pinned-extensions (cinatra-cli#270)", () => {
  const reconciled = { results: [{ action: "cloned", dest: "/repo/extensions/vendor/x" }] };

  it("maps already current: the run succeeds and the tracked bytes never move", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = makeCheckout(MAP_CURRENT);
    const before = mapDigest(root);

    regenerateExtensionManifestAfterSync(root, reconciled, { checkOnly: true });

    expect(mapDigest(root)).toBe(before);
    expect(process.exitCode).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    expect(logs.mock.calls.flat().join("\n")).toContain("not rewritten");
  });

  it("a stale map STOPS the run with the typed code, names the file, and rewrites nothing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = makeCheckout(MAP_STALE);
    const before = mapDigest(root);

    regenerateExtensionManifestAfterSync(root, reconciled, { checkOnly: true });

    // The whole point: the tracked file is exactly as the caller handed it over.
    expect(mapText(root)).toBe(MAP_STALE);
    expect(mapDigest(root)).toBe(before);
    expect(process.exitCode).toBe(SETUP_EXIT_GENERATED_MAPS_DRIFT);
    const blob = errors.mock.calls.flat().join("\n");
    expect(blob).toContain(MAP_REL);
    expect(blob).toContain("node scripts/extensions/generate-extension-manifest.mjs");
    expect(blob).toContain("commit");
    expect(blob).toContain(String(SETUP_EXIT_GENERATED_MAPS_DRIFT));
  });

  it("WITHOUT the opt-in a stale map is rewritten, exactly as today", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = makeCheckout(MAP_STALE);

    regenerateExtensionManifestAfterSync(root, reconciled, {});

    expect(mapText(root)).toBe(MAP_CURRENT);
    expect(process.exitCode).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });

  it("reads the generator's own DRIFT/MISSING lines, in the shape it prints them", () => {
    const output = [
      "[extension-manifest] DRIFT src/lib/generated/extensions.server.ts — file differs from generator output (hand-edit or stale; regenerate, never hand-edit)",
      "[extension-manifest] MISSING src/lib/generated/chat-views.ts — regenerate: node scripts/extensions/generate-extension-manifest.mjs",
      "[extension-manifest] SELF-CHECK DRIFT src/lib/generated/streams.server.ts — on-disk file differs from a fresh emission for THIS tree",
      "[extension-manifest] FAIL (canonical mode) — generated-tree drift and/or catalog parity break (see lines above).",
    ].join("\n");
    expect(parseGeneratedMapDrift(output)).toEqual([
      "src/lib/generated/chat-views.ts",
      "src/lib/generated/extensions.server.ts",
      "src/lib/generated/streams.server.ts",
    ]);
    expect(parseGeneratedMapDrift("")).toEqual([]);
    expect(parseGeneratedMapDrift(null)).toEqual([]);
  });

  it("says which files drifted, where, and what to run — never that it fixed them", () => {
    const lines = generatedMapsDriftLines("/checkout", [MAP_REL]).join("\n");
    expect(lines).toContain(MAP_REL);
    expect(lines).toContain("/checkout");
    expect(lines).toContain("--pinned-extensions");
    expect(lines).toContain("node scripts/extensions/generate-extension-manifest.mjs");
    expect(lines).toContain("commit");
    expect(lines).toContain(String(SETUP_EXIT_GENERATED_MAPS_DRIFT));
  });
});
