// cinatra-cli#143 — the LOCAL mirror of the app's prod required-env contract.
//
// These pin the two behaviours that must stay aligned with cinatra-ai/cinatra
// `src/lib/boot/required-env-preflight.ts`:
//   1. validateEncryptionKey accepts BOTH a 64-char hex string AND a base64
//      32-byte value (NOT the hex-only shape the `preview` lifecycle enforces).
//   2. checkProdEnv classifies the SAME hard/soft matrix, and tracks the WayFlow
//      attestation key as a DISTINCT soft signal (not folded into that matrix).

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ATTEST_KEY,
  checkProdEnv,
  formatHardFailureMessage,
  HARD_REQUIRED_ENV,
  SOFT_REQUIRED_ENV,
  validateEncryptionKey,
} from "../src/prod-env-validate.mjs";

describe("validateEncryptionKey (hex-or-base64 → 32 bytes)", () => {
  it("accepts a 64-char hex string", () => {
    expect(validateEncryptionKey(randomBytes(32).toString("hex"))).toBeNull();
  });

  it("accepts a base64 32-byte value", () => {
    expect(validateEncryptionKey(randomBytes(32).toString("base64"))).toBeNull();
  });

  it("rejects a value that decodes to the wrong length", () => {
    // 16 bytes hex (32 chars) is not 64 chars → treated as base64 → 24 bytes.
    expect(validateEncryptionKey(randomBytes(16).toString("hex"))).toMatch(/must decode to 32 bytes/);
    // A short junk string.
    expect(validateEncryptionKey("too-short")).toMatch(/must decode to 32 bytes/);
    // A 64-char hex is accepted; a 64-char NON-hex is base64 → 48 bytes → rejected.
    expect(validateEncryptionKey("z".repeat(64))).toMatch(/must decode to 32 bytes/);
  });
});

describe("checkProdEnv matrix", () => {
  const validKey = () => randomBytes(32).toString("hex");
  const fullEnv = () => ({
    SUPABASE_DB_URL: "set",
    BETTER_AUTH_SECRET: validKey(),
    CINATRA_ENCRYPTION_KEY: validKey(),
    CINATRA_BRIDGE_TOKEN: validKey(),
    CINATRA_CONTEXT_ATTEST_KEY: validKey(),
  });

  it("mirrors the app's hard/soft set membership", () => {
    expect(HARD_REQUIRED_ENV.map((v) => v.name)).toEqual([
      "SUPABASE_DB_URL",
      "BETTER_AUTH_SECRET",
      "CINATRA_ENCRYPTION_KEY",
    ]);
    expect(SOFT_REQUIRED_ENV.map((v) => v.name)).toEqual(["CINATRA_BRIDGE_TOKEN"]);
    // The attestation key is tracked SEPARATELY, not in either mirrored set.
    expect(HARD_REQUIRED_ENV.map((v) => v.name)).not.toContain(ATTEST_KEY.name);
    expect(SOFT_REQUIRED_ENV.map((v) => v.name)).not.toContain(ATTEST_KEY.name);
  });

  it("passes a complete env", () => {
    const r = checkProdEnv(fullEnv());
    expect(r.hardFailures).toEqual([]);
    expect(r.softMissing).toEqual([]);
    expect(r.attestMissing).toBe(false);
  });

  it("flags a missing hard var and a malformed encryption key", () => {
    const env = fullEnv();
    delete env.BETTER_AUTH_SECRET;
    env.CINATRA_ENCRYPTION_KEY = "not-a-valid-key";
    const r = checkProdEnv(env);
    const names = r.hardFailures.map((f) => f.name);
    expect(names).toContain("BETTER_AUTH_SECRET");
    expect(names).toContain("CINATRA_ENCRYPTION_KEY");
    expect(names).not.toContain("SUPABASE_DB_URL");
  });

  it("treats a whitespace-only value as missing", () => {
    const env = fullEnv();
    env.SUPABASE_DB_URL = "   ";
    const r = checkProdEnv(env);
    expect(r.hardFailures.map((f) => f.name)).toContain("SUPABASE_DB_URL");
  });

  it("warns (soft) on a missing bridge token and (separately) a missing attest key", () => {
    const env = fullEnv();
    delete env.CINATRA_BRIDGE_TOKEN;
    delete env.CINATRA_CONTEXT_ATTEST_KEY;
    const r = checkProdEnv(env);
    expect(r.hardFailures).toEqual([]);
    expect(r.softMissing.map((s) => s.name)).toEqual(["CINATRA_BRIDGE_TOKEN"]);
    expect(r.attestMissing).toBe(true);
  });

  it("formats an aggregated [required-env-preflight] hard-failure message", () => {
    const msg = formatHardFailureMessage([
      { name: "BETTER_AUTH_SECRET", reason: "missing — signs auth sessions" },
      { name: "CINATRA_ENCRYPTION_KEY", reason: "must decode to 32 bytes" },
    ]);
    expect(msg).toMatch(/^\[required-env-preflight\] 2 required environment variable/);
    expect(msg).toMatch(/- BETTER_AUTH_SECRET: missing/);
    expect(msg).toMatch(/- CINATRA_ENCRYPTION_KEY: must decode/);
  });
});
