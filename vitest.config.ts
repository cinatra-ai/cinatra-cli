import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,mts,mjs}"],
    // Per-worker default: point repo-bound commands at a synthetic cinatra
    // checkout (this standalone repo is not itself a checkout). See
    // tests/helpers/setup-fake-checkout.mjs.
    setupFiles: ["tests/helpers/setup-fake-checkout.mjs"],
    // NOTE: tests whose SUBJECT is a real monorepo sibling absent from the
    // extracted standalone repo were intentionally NOT carried over (they belong
    // to the upstream monorepo suite, not the thin-CLI repo — codex-converged
    // boundary): the byte-identity drift guard vs ../../mcp-server src, the
    // cardinality assertions over the ROOT manifest's cinatra.devExtensions /
    // cinatra.devApps inventory, and the monorepo-LAYOUT-coupled repo-root test
    // (whose standalone-resolution CONTRACT is now covered by the dedicated
    // standalone-resolution.test.mjs against a synthetic fake-checkout).
    exclude: ["**/node_modules/**"],
    environment: "node",
    testTimeout: 10_000,
  },
});
