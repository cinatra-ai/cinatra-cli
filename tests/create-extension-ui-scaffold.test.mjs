// `cinatra create-extension artifact --with-ui [--with-registry-items]` — the
// opt-in artifact renderer template (cinatra#1627 AC3).
//
// Asserts, through the SHARED authoring core the CLI drives, that the ui overlay:
//   - emits the RSC renderer stub + the vendored-primitives seed (+ registry seed),
//   - patches package.json with a well-formed `cinatra.artifact.ui` block, the
//     exports subpath(s), and the React toolchain delta (optional peers + devDeps),
//   - keeps the generated repo GATE-CLEAN (the same self-contained kind gate the
//     install pipeline mirrors — including the shape-screen of the ui block),
//   - keeps the README contract (one H1; only allowed H2s) intact,
//   - leaves NO unreplaced scaffold token and NO first-party dep leak,
//   - and is REJECTED for non-artifact kinds.
//
// Zero external dependencies; the SDK is never installed (the props type import
// is type-only and resolves only once @cinatra-ai/sdk-extensions ships the
// `./artifact-renderer-props` subpath — deferred publish, exactly as the docs
// sequence it).

import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it, beforeAll } from "vitest";

import { scaffold } from "../src/authoring/scaffold.mjs";
import { runGate, validateArtifactUiShape } from "../templates/_shared/extension-kind-gate.mjs";
import {
  ARTIFACT_UI_SDK_ABI_RANGE,
  ARTIFACT_UI_ABI_VERSION,
  ARTIFACT_RENDERER_PROPS_API_VERSION,
} from "../src/authoring/kinds.mjs";

const ALLOWED_H2 = ["Works with", "Capabilities"];

function validateReadme(readme) {
  const errors = [];
  const lines = readme.split("\n");
  const h1 = lines.filter((l) => /^# \S/.test(l));
  if (h1.length !== 1) errors.push(`README must have exactly one H1 (found ${h1.length})`);
  const h2 = lines.filter((l) => /^## /.test(l)).map((l) => l.replace(/^## /, "").trim());
  for (const h of h2) if (!ALLOWED_H2.includes(h)) errors.push(`README has disallowed H2 "## ${h}"`);
  if (lines.some((l) => /^#{3,} /.test(l))) errors.push("README must not contain H3+ headings");
  return errors;
}

const NON_DISTRIBUTABLE = [
  /^\.github\//,
  /(^|\/)\.env/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)renovate\.json$/,
  /(^|\/)extension-kind-gate\.mjs$/,
  /\.test\./,
  /(^|\/)__tests__\//,
];

function packlist(dir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

function firstPartyDeps(o) {
  return Object.keys(o || {}).filter((k) => k.startsWith("@cinatra-ai/") || k.startsWith("@cinatra/"));
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

let root;
let ui;
let uiReg;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cinatra-ui-ext-"));
  ui = scaffold({ kind: "artifact", name: "sample-thing", targetParent: root, force: true, withUi: true });
  uiReg = scaffold({
    kind: "artifact",
    name: "sample-widget",
    targetParent: root,
    force: true,
    withUi: true,
    withRegistryItems: true,
  });
});

describe("artifact --with-ui: renderer template", () => {
  it("emits the RSC renderer stub + vendored-primitives seed", () => {
    const dir = ui.targetDir;
    expect(existsSync(join(dir, "src/renderers/detail.tsx"))).toBe(true);
    expect(existsSync(join(dir, "src/ui/index.ts"))).toBe(true);
    // No registry seed unless --with-registry-items.
    expect(existsSync(join(dir, "src/registry/sample-tile.tsx"))).toBe(false);
  });

  it("the renderer stub imports the props type from the public SDK subpath (type-only, no host internal)", () => {
    const src = readFileSync(join(ui.targetDir, "src/renderers/detail.tsx"), "utf8");
    expect(src).toContain(
      'import type { ArtifactRendererProps } from "@cinatra-ai/sdk-extensions/artifact-renderer-props"',
    );
    expect(src).toContain("export default function"); // RSC default export
    expect(src).not.toMatch(/from ["']@\//); // no host-internal import
  });

  it("patches package.json with a well-formed cinatra.artifact.ui + exports + React toolchain", () => {
    const pkg = JSON.parse(readFileSync(join(ui.targetDir, "package.json"), "utf8"));
    expect(pkg.cinatra.artifact.ui).toEqual({
      abiVersion: ARTIFACT_UI_ABI_VERSION,
      sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
      renderers: {
        detail: { entry: "./src/renderers/detail.tsx", propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION },
      },
    });
    expect(pkg.exports["./renderers/detail"]).toBe("./src/renderers/detail.tsx");
    // React is an OPTIONAL peer (host-provided, external at bundle time) + a devDep.
    expect(pkg.peerDependencies.react).toBeTruthy();
    expect(pkg.peerDependenciesMeta.react).toEqual({ optional: true });
    expect(pkg.devDependencies.react).toBeTruthy();
    expect(pkg.devDependencies["@types/react"]).toBeTruthy();
    // The SDK peer stays pinned + optional.
    expect(pkg.peerDependencies["@cinatra-ai/sdk-extensions"]).toBe("^0.1.1");
    expect(pkg.peerDependenciesMeta["@cinatra-ai/sdk-extensions"]).toEqual({ optional: true });
  });

  it("the generated ui repo passes the shipped kind gate with no errors/warnings", () => {
    const gate = runGate(ui.targetDir);
    expect(gate.errors, gate.errors.join("\n")).toEqual([]);
    expect(gate.warnings, gate.warnings.join("\n")).toEqual([]);
  });

  it("keeps the README contract + leaks no first-party dep into deps/devDeps", () => {
    expect(validateReadme(readFileSync(join(ui.targetDir, "README.md"), "utf8"))).toEqual([]);
    const pkg = JSON.parse(readFileSync(join(ui.targetDir, "package.json"), "utf8"));
    expect(firstPartyDeps(pkg.dependencies)).toEqual([]);
    expect(firstPartyDeps(pkg.devDependencies)).toEqual([]); // react/@types are NOT @cinatra-ai
  });

  it("leaves no unreplaced scaffold token in any generated file", () => {
    for (const rel of listFiles(ui.targetDir)) {
      const body = readFileSync(join(ui.targetDir, rel), "utf8");
      expect(/\{\{\s*(?:pascalBase|displayName|base|camelBase|slug|packageName)\s*\}\}/.test(body), `unreplaced token in ${rel}`).toBe(false);
    }
  });

  it("npm pack packlist leaks no non-distributable path and includes the renderer", () => {
    const files = packlist(ui.targetDir);
    for (const f of files) {
      for (const re of NON_DISTRIBUTABLE) expect(re.test(f), `packlist leaks: ${f}`).toBe(false);
    }
    expect(files).toContain("src/renderers/detail.tsx");
    expect(files).toContain("src/ui/index.ts");
  });

  it("matches the golden generated file list", () => {
    expect(listFiles(ui.targetDir)).toEqual([
      ".gitattributes",
      ".github/workflows/actions-pinned-gate.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/gitignore-gate.yml",
      ".github/workflows/release.yml",
      ".github/workflows/source-leak-gate.yml",
      ".gitignore",
      ".npmrc",
      "LICENSE",
      "README.md",
      "extension-kind-gate.mjs",
      "package.json",
      "renovate.json",
      "skills/sample-thing-matcher/SKILL.md",
      "src/index.ts",
      "src/renderers/detail.tsx",
      "src/ui/index.ts",
      "tsconfig.json",
    ]);
  });
});

describe("artifact --with-registry-items: contributed registry item", () => {
  it("adds a valid registryItems entry + the registry-item seed + exports, gate-clean", () => {
    const dir = uiReg.targetDir;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(existsSync(join(dir, "src/registry/sample-tile.tsx"))).toBe(true);
    expect(pkg.cinatra.artifact.ui.registryItems).toEqual([
      {
        name: "sample-tile",
        entry: "./src/registry/sample-tile.tsx",
        type: "registry:ui",
        description: "A presentational sample tile — replace with your own primitive.",
      },
    ]);
    expect(pkg.exports["./registry/sample-tile"]).toBe("./src/registry/sample-tile.tsx");
    // renderers still present alongside registryItems.
    expect(pkg.cinatra.artifact.ui.renderers.detail).toBeTruthy();
    const gate = runGate(dir);
    expect(gate.errors, gate.errors.join("\n")).toEqual([]);
  });
});

describe("the ui overlay is artifact-only", () => {
  it("rejects --with-ui for a non-artifact kind", () => {
    expect(() =>
      scaffold({ kind: "agent", name: "sample", targetParent: root, force: true, withUi: true }),
    ).toThrow(/apply only to kind "artifact"/);
  });

  it("rejects --with-registry-items without --with-ui", () => {
    expect(() =>
      scaffold({
        kind: "artifact",
        name: "sample-orphan",
        targetParent: root,
        force: true,
        withRegistryItems: true,
        withUi: false,
      }),
    ).toThrow(/requires --with-ui/);
  });
});

describe("the shipped gate shape-screens cinatra.artifact.ui (S5 renderers+registryItems parity)", () => {
  const okBase = { abiVersion: 1, sdkAbiRange: "^2.4.0" };

  it("accepts a registryItems-only ui block (no renderers)", () => {
    const errors = validateArtifactUiShape({
      ...okBase,
      registryItems: [{ name: "stat-tile", entry: "./src/registry/stat-tile.tsx", type: "registry:ui", description: "x" }],
    });
    expect(errors).toEqual([]);
  });

  it("requires at least one of renderers/registryItems", () => {
    const errors = validateArtifactUiShape({ ...okBase });
    expect(errors.join("|")).toContain("at least one of");
  });

  it("rejects a registry item with an unknown type", () => {
    const errors = validateArtifactUiShape({
      ...okBase,
      registryItems: [{ name: "x", entry: "./src/r/x.tsx", type: "registry:page", description: "d" }],
    });
    expect(errors.join("|")).toContain("registry:ui | registry:lib");
  });

  it("rejects a non-kebab registry item name and a duplicate name", () => {
    const bad = validateArtifactUiShape({
      ...okBase,
      registryItems: [{ name: "StatTile", entry: "./src/r/a.tsx", type: "registry:ui", description: "d" }],
    });
    expect(bad.join("|")).toContain("lowercase-kebab");
    const dup = validateArtifactUiShape({
      ...okBase,
      registryItems: [
        { name: "tile", entry: "./src/r/a.tsx", type: "registry:ui", description: "d" },
        { name: "tile", entry: "./src/r/b.tsx", type: "registry:ui", description: "d" },
      ],
    });
    expect(dup.join("|")).toContain("duplicate registry item name");
  });

  it("rejects an uncontained registry item entry and a v1 renderer host-port request", () => {
    const esc = validateArtifactUiShape({
      ...okBase,
      registryItems: [{ name: "tile", entry: "../evil.tsx", type: "registry:ui", description: "d" }],
    });
    expect(esc.join("|")).toContain("path-contained subpath");
    const ports = validateArtifactUiShape({
      ...okBase,
      renderers: { detail: { entry: "./src/d.tsx", propsApiVersion: 1, ports: ["settings"] } },
    });
    expect(ports.join("|")).toContain("NO host ports");
  });
});
