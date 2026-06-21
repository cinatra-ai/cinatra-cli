// Synthetic cinatra-checkout factory for the standalone CLI test suite.
//
// The extracted `cinatra` CLI is dependency-light and operates on an OPERATOR'S
// CHECKOUT (a cloned monorepo) resolved at runtime via `getRepoRoot()` (env
// override `CINATRA_REPO_ROOT`, else an upward cwd-walk). The standalone repo is
// NOT itself a cinatra checkout, so repo-bound command tests need a minimal
// SYNTHETIC checkout: just the two sentinel files `getRepoRoot()` /
// `isCinatraRepoRoot()` anchor on — `pnpm-workspace.yaml` and
// `packages/migrations/package.json` named `@cinatra-ai/migrations` — plus an
// optional `.env.local`.
//
// This is the codex-converged boundary: tests whose subject is real CLI
// behavior (repo-root resolution, the dev-tunnel dev gate, the `status` local
// fallback) are made to pass against this synthetic checkout; tests that need a
// real sibling package (`../../mcp-server`), the root `cinatra.devExtensions`
// inventory, or the gitignored `extensions/cinatra-ai/*` clone are excluded from
// the default standalone run (they belong to the upstream monorepo suite).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a minimal synthetic cinatra checkout in a fresh tmpdir.
 *
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env]  Lines to write into `.env.local`.
 * @returns {{ root: string, cleanup: () => void }}
 */
export function makeFakeCheckout({ env } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cinatra-fake-checkout-"));
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  );
  const migDir = path.join(root, "packages", "migrations");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(
    path.join(migDir, "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }, null, 2),
  );
  if (env && Object.keys(env).length > 0) {
    const body = Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    writeFileSync(path.join(root, ".env.local"), body + "\n");
  }
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
