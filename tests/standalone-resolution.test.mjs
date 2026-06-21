// Standalone resolution contract for the extracted thin CLI.
//
// Replaces the monorepo-LAYOUT-coupled standalone-repo-root.test.mjs (which
// pointed at the surrounding monorepo). Here we synthesize a fake cinatra
// checkout in a tmpdir and assert:
//
//   1. `getRepoRoot()` (via the child CLI) RESOLVES a synthetic checkout passed
//      through CINATRA_REPO_ROOT — a repo-bound command then proceeds past root
//      resolution and fails on the missing DB url, NOT on a "must run from
//      inside a checkout" resolution error.
//   2. CINATRA_REPO_ROOT at a NON-checkout dir → a clear error naming the bad
//      path (fail-loud, never a silent wrong-path).
//   3. checkout-resolve.mjs unit behavior: it refuses non-@cinatra-ai
//      specifiers, asserts the checkout sentinel, derives the package name from
//      the specifier, and (positively) resolves + imports a synthetic
//      @cinatra-ai/migrations planted in the fake checkout's node_modules.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeFakeCheckout } from "./helpers/fake-checkout.mjs";
import { __test, importFromCheckout } from "../src/checkout-resolve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

/** Run the real CLI bin in a child process with an explicit env (no inherited
 *  CINATRA_REPO_ROOT from the per-worker setup — we set it ourselves). */
function runBin(args, env = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: os.tmpdir(), // outside any checkout, so resolution depends only on env
    env: {
      ...process.env,
      CINATRA_REPO_ROOT: "", // clear the per-worker default; cases set it
      SUPABASE_DB_URL: "",
      ...env,
    },
  });
  return `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

describe("standalone getRepoRoot — synthetic checkout via CINATRA_REPO_ROOT", () => {
  let checkout;
  beforeAll(() => {
    checkout = makeFakeCheckout();
  });
  afterAll(() => checkout?.cleanup());

  it("resolves a synthetic checkout → proceeds to the missing-DB-url error", () => {
    // `status` (no target) is a repo-bound local command: it resolves the root,
    // reads .env.local, and errors on the missing SUPABASE_DB_URL — proving it
    // found the checkout (NOT a "must run from inside a checkout" error).
    const out = runBin(["status"], { CINATRA_REPO_ROOT: checkout.root });
    expect(out).not.toMatch(/must run from inside a cinatra checkout/);
    expect(out).toMatch(/SUPABASE_DB_URL/);
  });

  it("CINATRA_REPO_ROOT at a NON-checkout dir → a clear error naming the bad path", () => {
    const bogus = mkdtempSync(path.join(os.tmpdir(), "not-a-checkout-"));
    try {
      const out = runBin(["status"], { CINATRA_REPO_ROOT: bogus });
      expect(out).toMatch(/not a cinatra checkout|pnpm-workspace\.yaml|packages\/migrations/);
      expect(out).toContain(bogus);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});

describe("checkout-resolve.mjs — specifier + sentinel validation", () => {
  it("derives the owning package name from a specifier (incl. subpaths)", () => {
    expect(__test.packageNameFromSpecifier("@cinatra-ai/migrations")).toBe(
      "@cinatra-ai/migrations",
    );
    expect(__test.packageNameFromSpecifier("@cinatra-ai/skills/cli")).toBe(
      "@cinatra-ai/skills",
    );
    expect(
      __test.packageNameFromSpecifier("@cinatra-ai/connectors-catalog/descriptors.mjs"),
    ).toBe("@cinatra-ai/connectors-catalog");
  });

  it("refuses a non-@cinatra-ai specifier", () => {
    expect(() => __test.packageNameFromSpecifier("pg")).toThrow(/non-@cinatra-ai/);
    expect(() => __test.packageNameFromSpecifier("node:fs")).toThrow(/non-@cinatra-ai/);
  });

  it("asserts the cinatra checkout sentinel", () => {
    const bogus = mkdtempSync(path.join(os.tmpdir(), "not-a-checkout-"));
    try {
      expect(() => __test.assertCinatraCheckout(bogus)).toThrow(/not a cinatra checkout/);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });

  it("importFromCheckout refuses a non-@cinatra-ai specifier before any I/O", async () => {
    const checkout = makeFakeCheckout();
    try {
      await expect(importFromCheckout(checkout.root, "pg")).rejects.toThrow(
        /non-@cinatra-ai/,
      );
    } finally {
      checkout.cleanup();
    }
  });

  it("resolves + imports a checkout-local @cinatra-ai/migrations (containment + name ok)", async () => {
    const checkout = makeFakeCheckout();
    try {
      // Plant a synthetic installed copy in the checkout's node_modules with a
      // real entrypoint exporting the migration runner surface.
      const pkgDir = path.join(checkout.root, "node_modules", "@cinatra-ai", "migrations");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@cinatra-ai/migrations",
          version: "0.0.0",
          type: "module",
          main: "index.mjs",
        }),
      );
      writeFileSync(
        path.join(pkgDir, "index.mjs"),
        "export const runCoreMigrations = () => 'ok';\n" +
          "export const runNamespacedMigrations = () => 'ok';\n" +
          "export const isFreshCoreSchema = () => true;\n",
      );
      const mod = await importFromCheckout(checkout.root, "@cinatra-ai/migrations");
      expect(typeof mod.runCoreMigrations).toBe("function");
      expect(mod.runCoreMigrations()).toBe("ok");
      expect(mod.isFreshCoreSchema()).toBe(true);
    } finally {
      checkout.cleanup();
    }
  });

  it("migrations falls back to the guaranteed in-checkout SOURCE when node_modules lacks the package (prod-image shape)", async () => {
    // No node_modules/@cinatra-ai/migrations (primary resolution fails) — only
    // the source at packages/migrations is present, as in the baked prod image.
    // The fallback must self-resolve from packages/migrations and import it.
    const checkout = makeFakeCheckout();
    try {
      const srcDir = path.join(checkout.root, "packages", "migrations");
      // Mirror the REAL @cinatra-ai/migrations manifest shape: an `exports` map.
      // Node SELF-REFERENCING (resolving a package's own name from inside it,
      // which the fallback relies on) is gated on `exports` — a `main`-only
      // package cannot self-reference. The real package ships `exports`.
      writeFileSync(
        path.join(srcDir, "package.json"),
        JSON.stringify({
          name: "@cinatra-ai/migrations",
          version: "0.0.0",
          type: "module",
          main: "./index.mjs",
          exports: { ".": "./index.mjs" },
        }),
      );
      writeFileSync(
        path.join(srcDir, "index.mjs"),
        "export const runCoreMigrations = () => 'from-source';\n" +
          "export const runNamespacedMigrations = () => 'from-source';\n" +
          "export const isFreshCoreSchema = () => false;\n",
      );
      const mod = await importFromCheckout(checkout.root, "@cinatra-ai/migrations");
      expect(mod.runCoreMigrations()).toBe("from-source");
      expect(mod.isFreshCoreSchema()).toBe(false);
    } finally {
      checkout.cleanup();
    }
  });
});
