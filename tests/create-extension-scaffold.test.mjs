// `cinatra create-extension <kind>` scaffold parity + correctness (cinatra#402).
//
// This is the folded-in equivalent of create-cinatra-extension's
// `test/scaffold-all-kinds.test.mjs`: scaffold each of the five kinds via the
// SHARED authoring core (the same code path the `cinatra create-extension`
// command drives) and assert the SDK-P1-equivalent local invariants per kind —
//   - manifest shape (cinatra.apiVersion/kind, license, semver),
//   - first-party dep shape (no leaked @cinatra-ai deps; SDK is an optional peer),
//   - README gate shape (one H1; allowed/ordered H2; no H3+),
//   - the self-contained kind gate (agent/workflow) returns clean,
//   - the npm pack packlist of the GENERATED repo leaks no non-distributable path.
//
// Plus two fold-specific guards Codex asked for:
//   - a GOLDEN file-list snapshot per kind (catches a template add/drop/rename),
//   - NO unreplaced `{{token}}` survives in any generated file or filename
//     (catches a vars-map gap introduced by the move into src/authoring/).
//
// Zero external dependencies; the SDK is never installed (deferred publish).

import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { describe, expect, it, beforeAll } from "vitest";

import { scaffold, REPO_ROOT } from "../src/authoring/scaffold.mjs";
import { runGate } from "../templates/_shared/extension-kind-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KINDS = ["agent", "connector", "artifact", "skill", "workflow"];

// README gate: exactly one H1; optional "## Works with" must precede the
// required "## Capabilities"; no other H2; no H3+.
const ALLOWED_H2 = ["Works with", "Capabilities"];
const REQUIRED_H2 = ["Capabilities"];

function validateReadme(readme) {
  const errors = [];
  const lines = readme.split("\n");
  const h1 = lines.filter((l) => /^# \S/.test(l));
  if (h1.length !== 1) errors.push(`README must have exactly one H1 (found ${h1.length})`);
  const h2 = lines.filter((l) => /^## /.test(l)).map((l) => l.replace(/^## /, "").trim());
  for (const h of h2) if (!ALLOWED_H2.includes(h)) errors.push(`README has disallowed H2 "## ${h}"`);
  for (const r of REQUIRED_H2) if (!h2.includes(r)) errors.push(`README missing required H2 "## ${r}"`);
  if (h2.includes("Works with") && h2.includes("Capabilities")) {
    if (h2.indexOf("Works with") > h2.indexOf("Capabilities")) {
      errors.push('README "## Works with" must precede "## Capabilities"');
    }
  }
  if (lines.some((l) => /^#{3,} /.test(l))) errors.push("README must not contain H3+ headings");
  return errors;
}

// Non-distributable paths that must NOT appear in the generated repo's packlist.
const NON_DISTRIBUTABLE = [
  /^\.github\//,
  /(^|\/)\.planning(\/|$)/,
  /(^|\/)\.env/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)renovate\.json$/,
  /(^|\/)extension-kind-gate\.mjs$/,
  /\.test\./,
  /\.spec\./,
  /(^|\/)__tests__\//,
];

function packlist(dir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  const json = JSON.parse(out);
  return json[0].files.map((f) => f.path);
}

function validateDepShape(pkg) {
  const errors = [];
  const fp = (o) => Object.keys(o || {}).filter((k) => k.startsWith("@cinatra-ai/") || k.startsWith("@cinatra/"));
  const leaked = [...fp(pkg.dependencies), ...fp(pkg.devDependencies), ...fp(pkg.optionalDependencies)];
  if (leaked.length) errors.push(`first-party packages must be OPTIONAL peers, not deps/devDeps: ${leaked.join(", ")}`);
  const peers = fp(pkg.peerDependencies);
  const meta = pkg.peerDependenciesMeta || {};
  for (const p of peers) {
    if (!(meta[p] && meta[p].optional === true)) errors.push(`first-party peer ${p} must be peerDependenciesMeta.optional`);
    if (p === "@cinatra-ai/sdk-extensions" && pkg.peerDependencies[p] !== "^0.1.1") {
      errors.push(`@cinatra-ai/sdk-extensions peer must be pinned to ^0.1.1 (got ${pkg.peerDependencies[p]})`);
    }
  }
  return errors;
}

function validateManifest(pkg, kind) {
  const errors = [];
  const c = pkg.cinatra || {};
  if (c.apiVersion !== "cinatra.ai/v1") errors.push(`cinatra.apiVersion must be "cinatra.ai/v1" (got ${JSON.stringify(c.apiVersion)})`);
  if (c.kind !== kind) errors.push(`cinatra.kind must be "${kind}" (got ${JSON.stringify(c.kind)})`);
  if (pkg.license !== "Apache-2.0") errors.push(`license must be "Apache-2.0" (got ${JSON.stringify(pkg.license)})`);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version || "")) errors.push(`version must be strict semver (got ${JSON.stringify(pkg.version)})`);
  return errors;
}

// Recursively list every file under `dir`, relative + sorted (the golden list).
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

// Scaffold all kinds once into a shared temp parent (stable inputs match cce's
// own harness so reviewers can cross-read the two suites).
const results = {};
let root;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cinatra-create-ext-"));
  for (const kind of KINDS) {
    const res = scaffold({
      kind,
      name: `sample-${kind === "skill" ? "tools" : "thing"}`,
      scope: undefined,
      displayName: undefined,
      description: undefined,
      targetParent: root,
      force: true,
    });
    results[kind] = res;
  }
});

describe("create-extension authoring core — templates resolve from src/authoring/", () => {
  it("REPO_ROOT points at the cinatra-cli repo root and templates/ exists there", () => {
    // The locator moved one level deeper (src/authoring/ vs the standalone's
    // src/); this asserts the two-levels-up fix is correct.
    expect(existsSync(join(REPO_ROOT, "templates"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, "templates", "_shared", "extension-kind-gate.mjs"))).toBe(true);
    for (const kind of KINDS) {
      expect(existsSync(join(REPO_ROOT, "templates", kind))).toBe(true);
    }
  });
});

describe.each(KINDS)("create-extension scaffolds a valid %s", (kind) => {
  it("passes manifest + dep-shape + README + kind-gate invariants", () => {
    const dir = results[kind].targetDir;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    const errors = [];
    errors.push(...validateManifest(pkg, kind));
    errors.push(...validateDepShape(pkg));
    errors.push(...validateReadme(readFileSync(join(dir, "README.md"), "utf8")));

    if (kind === "agent" || kind === "workflow") {
      expect(existsSync(join(dir, "extension-kind-gate.mjs")), `${kind} must ship extension-kind-gate.mjs`).toBe(true);
    }
    const gate = runGate(dir);
    for (const e of gate.errors) errors.push(`kind-gate: ${e}`);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("npm pack packlist of the generated repo leaks no non-distributable path", () => {
    const files = packlist(results[kind].targetDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const re of NON_DISTRIBUTABLE) {
        expect(re.test(f), `packlist leaks non-distributable path: ${f}`).toBe(false);
      }
    }
  });

  it("restores the npm-hostile dotfiles (.gitignore + .npmrc) in the output", () => {
    // The publish trap: templates store these as `gitignore`/`npmrc` sentinels
    // (so they survive `npm pack` of the cinatra package) and the renderer
    // restores the leading dot. The generated repo MUST carry the dotted form
    // and MUST NOT carry the sentinel.
    const dir = results[kind].targetDir;
    expect(existsSync(join(dir, ".gitignore")), ".gitignore must be restored").toBe(true);
    expect(existsSync(join(dir, ".npmrc")), ".npmrc must be restored").toBe(true);
    expect(existsSync(join(dir, "gitignore")), "the gitignore sentinel must not leak into output").toBe(false);
    expect(existsSync(join(dir, "npmrc")), "the npmrc sentinel must not leak into output").toBe(false);
  });

  it("leaves no unreplaced {{token}} in any generated file or filename", () => {
    // INTENTIONAL runtime placeholders that the HOST (not the scaffolder)
    // substitutes at agent-load / agent-run time — these are NOT scaffold vars
    // and correctly survive `substitute()` (which leaves unknown tokens intact).
    // Restricting the leak check to these excepted names is what makes it a real
    // "no scaffold-var gap" guard rather than a tautology.
    const RUNTIME_PLACEHOLDERS = new Set(["CINATRA_BASE_URL", "input"]);
    const dir = results[kind].targetDir;
    const files = listFiles(dir);
    const tokenRe = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
    for (const rel of files) {
      // Filenames never carry a runtime placeholder, so any token there is a gap.
      expect(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(rel), `unreplaced token in FILENAME: ${rel}`).toBe(false);
      const body = readFileSync(join(dir, rel), "utf8");
      for (const m of body.matchAll(tokenRe)) {
        expect(
          RUNTIME_PLACEHOLDERS.has(m[1]),
          `unexpected unreplaced scaffold token ${m[0]} in ${rel}`,
        ).toBe(true);
      }
    }
  });

  it("matches the golden generated file list", () => {
    expect(listFiles(results[kind].targetDir)).toMatchSnapshot();
  });
});
