// cinatra-cli#143 — a LOCAL mirror of the app's production required-env contract
// (cinatra-ai/cinatra `src/lib/boot/required-env-preflight.ts`) so that
// `install --mode prod` can validate the generated `.env.local` against the SAME
// hard/soft matrix the app enforces at first prod boot. A missing or malformed
// hard var must fail the INSTALL here — naming the var — rather than letting the
// installer report success on an instance that aborts on first boot with
// `[required-env-preflight] … missing`.
//
// This is a deliberate cross-repo mirror (not an import): the CLI ships
// independently of the app checkout it installs, so it cannot import the app's
// TypeScript preflight. The two must stay behaviourally aligned — notably the
// encryption-key validator accepts BOTH a 64-char hex string AND a base64
// 32-byte value (matching the app's `validateEncryptionKey`), NOT the narrower
// hex-only shape a separate lifecycle (`preview`) enforces for its own boot.

import { Buffer } from "node:buffer";

const KEY_BYTES = 32;

/**
 * Validate a `CINATRA_ENCRYPTION_KEY` value decodes to exactly 32 bytes, mirroring
 * the app's `validateEncryptionKey` / `instance-secrets.ts getKey()`: a 64-char
 * all-hex string is treated as hex, otherwise as base64. Returns an error string
 * when the value is malformed, or `null` when it is valid.
 */
export function validateEncryptionKey(raw) {
  const buf = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    return `must decode to ${KEY_BYTES} bytes (got ${buf.length}) — a 64-char hex string or a base64 32-byte value`;
  }
  return null;
}

/** Hard-required vars whose absence (or malformed value) must FAIL the install. */
export const HARD_REQUIRED_ENV = [
  {
    name: "SUPABASE_DB_URL",
    why: "the Postgres connection string; without it the app cannot run migrations or serve any data",
  },
  {
    name: "BETTER_AUTH_SECRET",
    why: "signs auth sessions; without it every authenticated request fails",
  },
  {
    name: "CINATRA_ENCRYPTION_KEY",
    why: "encrypts instance/connector secrets (AES-256-GCM); without it secret storage cannot operate",
    validate: validateEncryptionKey,
  },
];

/** Soft-required vars (mirror of the app's SOFT set) whose absence WARNS only. */
export const SOFT_REQUIRED_ENV = [
  {
    name: "CINATRA_BRIDGE_TOKEN",
    why: "authenticates WayFlow bridge callbacks (fail-closed 403 when unset); required for a deploy that runs the WayFlow agent runtime",
  },
];

// The WayFlow attestation key is a DISTINCT soft contract, tracked SEPARATELY
// from the app's hard/soft matrix (it is not part of `checkRequiredEnv`). Its
// absence degrades the WayFlow agent runtime; a deploy without WayFlow boots fine.
export const ATTEST_KEY = {
  name: "CINATRA_CONTEXT_ATTEST_KEY",
  why: "signs WayFlow context attestations; the WayFlow agent runtime treats its absence as degraded (a deploy without WayFlow is unaffected)",
};

/** Trim a raw env value, treating a missing/whitespace-only value as empty. */
function trimmed(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * PURE classification of an env bag against the prod required-env matrix. No I/O,
 * no throw. Returns the hard failures (missing or malformed), the soft-missing
 * vars, and — kept independent per #143 — whether the WayFlow attestation key is
 * missing. Exported for unit testing.
 *
 * @param {Record<string, string | undefined>} env
 */
export function checkProdEnv(env) {
  const hardFailures = [];
  for (const v of HARD_REQUIRED_ENV) {
    const value = trimmed(env[v.name]);
    if (!value) {
      hardFailures.push({ name: v.name, reason: `missing — ${v.why}` });
      continue;
    }
    if (v.validate) {
      const err = v.validate(value);
      if (err) hardFailures.push({ name: v.name, reason: `${err} — ${v.why}` });
    }
  }

  const softMissing = [];
  for (const v of SOFT_REQUIRED_ENV) {
    if (!trimmed(env[v.name])) softMissing.push({ name: v.name, why: v.why });
  }

  const attestMissing = !trimmed(env[ATTEST_KEY.name]);

  return { hardFailures, softMissing, attestMissing };
}

/**
 * Build the loud, aggregated abort message for the hard failures — mirroring the
 * app's `[required-env-preflight]` style so the installer and the app's own
 * boot-time preflight read consistently.
 */
export function formatHardFailureMessage(hardFailures) {
  const lines = hardFailures.map((f) => `  - ${f.name}: ${f.reason}`);
  return (
    `[required-env-preflight] ${hardFailures.length} required environment variable(s) are missing or ` +
    `invalid — refusing to report a successful install (a prod deploy must provision these or it aborts ` +
    `on first boot):\n${lines.join("\n")}`
  );
}
