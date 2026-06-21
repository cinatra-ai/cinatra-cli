// vitest `setupFiles` entry (runs in EACH test worker before its tests).
//
// Points every repo-bound command at a synthetic cinatra checkout so the
// standalone test run does not require being executed from inside a real
// monorepo. In-process tests read `process.env.CINATRA_REPO_ROOT` via
// `getRepoRoot()`; child-process tests inherit it through `...process.env`.
//
// Tests that need to control resolution themselves (the standalone-resolution
// suite) spawn child processes with an explicit env that OVERRIDES this default,
// so a per-worker default here never fights them.

import { afterAll, beforeAll } from "vitest";

import { makeFakeCheckout } from "./fake-checkout.mjs";

let checkout;
const hadOverride = typeof process.env.CINATRA_REPO_ROOT === "string";

beforeAll(() => {
  if (hadOverride) return; // respect an externally-provided checkout
  // No SUPABASE_DB_URL: repo-bound commands resolve the root, then fail on the
  // missing DB url — the exact "reached the local path" signal several tests
  // assert (distinct from a "must run from inside a checkout" resolution error).
  checkout = makeFakeCheckout();
  process.env.CINATRA_REPO_ROOT = checkout.root;
});

afterAll(() => {
  if (hadOverride || !checkout) return;
  delete process.env.CINATRA_REPO_ROOT;
  checkout.cleanup();
});
