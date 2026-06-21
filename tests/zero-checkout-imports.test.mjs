// CONTRACT: the published thin CLI carries ZERO `@cinatra-ai/*` module imports.
//
// The whole point of the extracted `cinatra` CLI (cinatra#402) is to be a
// dependency-light driver that resolves the heavy internal workspace packages
// (`@cinatra-ai/migrations`, `@cinatra-ai/connectors-catalog`, `@cinatra-ai/skills`)
// from the operator's CHECKOUT at runtime — never bundling them. This guard
// fails the build if any `@cinatra-ai/*` ever creeps back in as a STATIC import,
// a dynamic `import()`, or a `require()` in the shipped `src/*.mjs` + `bin/`.
//
// It also pins two positive invariants:
//   - package.json declares NO `@cinatra-ai/*` dependency (deps/devDeps/peer/opt).
//   - the ONLY way the sources touch `@cinatra-ai/*` packages is through
//     `importFromCheckout()` (checkout-resolve.mjs), whose specifier ARGUMENTS
//     are string literals — not import-statement specifiers — so they are
//     resolved from the checkout, not from the CLI's own node_modules.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(HERE, "..");
const SRC_DIR = path.join(PKG_DIR, "src");
const BIN_DIR = path.join(PKG_DIR, "bin");

function listMjs(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => path.join(dir, f));
}

const shippedFiles = [...listMjs(SRC_DIR), ...listMjs(BIN_DIR)];

// Matches an ACTUAL module-loading construct whose specifier is `@cinatra-ai/…`:
//   - static:  `import ... from "@cinatra-ai/x"` (single- or multi-line binding)
//   - dynamic: `import("@cinatra-ai/x")`
//   - cjs:     `require("@cinatra-ai/x")`
// It does NOT match comments or string literals that merely contain the scope
// (e.g. `=== "@cinatra-ai/migrations"`, `CINATRA_SCOPE = "@cinatra-ai/"`, or the
// specifier ARGUMENT passed to `importFromCheckout(repoRoot, "@cinatra-ai/…")`).
const STATIC_IMPORT = /(^|\n)\s*import\b[^;]*?from\s*["']@cinatra-ai\//;
const DYNAMIC_IMPORT = /(^|[^.\w])import\s*\(\s*["']@cinatra-ai\//;
const CJS_REQUIRE = /\brequire\s*\(\s*["']@cinatra-ai\//;

describe("thin-CLI contract — zero @cinatra-ai/* imports in shipped sources", () => {
  it("there is at least one shipped .mjs file to scan", () => {
    expect(shippedFiles.length).toBeGreaterThan(0);
  });

  it.each(shippedFiles.map((f) => [path.relative(PKG_DIR, f), f]))(
    "%s has no static @cinatra-ai/* import",
    (_rel, file) => {
      const src = readFileSync(file, "utf8");
      expect(STATIC_IMPORT.test(src)).toBe(false);
    },
  );

  it.each(shippedFiles.map((f) => [path.relative(PKG_DIR, f), f]))(
    "%s has no dynamic import() of @cinatra-ai/*",
    (_rel, file) => {
      const src = readFileSync(file, "utf8");
      expect(DYNAMIC_IMPORT.test(src)).toBe(false);
    },
  );

  it.each(shippedFiles.map((f) => [path.relative(PKG_DIR, f), f]))(
    "%s has no require() of @cinatra-ai/*",
    (_rel, file) => {
      const src = readFileSync(file, "utf8");
      expect(CJS_REQUIRE.test(src)).toBe(false);
    },
  );

  it("regex shape: catches each loading form, ignores string literals", () => {
    expect(STATIC_IMPORT.test(`import { x } from "@cinatra-ai/migrations";`)).toBe(true);
    expect(
      STATIC_IMPORT.test(`import {\n  x,\n} from "@cinatra-ai/skills/cli";`),
    ).toBe(true);
    expect(DYNAMIC_IMPORT.test(`await import("@cinatra-ai/skills/cli")`)).toBe(true);
    expect(CJS_REQUIRE.test(`const m = require("@cinatra-ai/migrations")`)).toBe(true);
    // NOT a loading construct: string-literal / comparison / helper argument.
    expect(STATIC_IMPORT.test(`name === "@cinatra-ai/migrations"`)).toBe(false);
    expect(DYNAMIC_IMPORT.test(`importFromCheckout(repoRoot, "@cinatra-ai/migrations")`)).toBe(false);
    expect(STATIC_IMPORT.test(`const CINATRA_SCOPE = "@cinatra-ai/";`)).toBe(false);
  });
});

describe("thin-CLI contract — package.json declares no @cinatra-ai/* dependency", () => {
  const pkg = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));

  it.each([
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])("%s contains no @cinatra-ai/* entry", (field) => {
    const names = Object.keys(pkg[field] ?? {});
    const offending = names.filter((n) => n.startsWith("@cinatra-ai/"));
    expect(offending).toEqual([]);
  });

  it("the package name is the unscoped `cinatra` and bin is `cinatra`", () => {
    expect(pkg.name).toBe("cinatra");
    expect(Object.keys(pkg.bin ?? {})).toEqual(["cinatra"]);
  });
});
