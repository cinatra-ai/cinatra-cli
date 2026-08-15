// cinatra-cli#211 — unit coverage for the `NANGO_SECRET_KEY` mint/heal seam.
//
// The contract under test (see src/nango-secret-key.mjs for the why):
//   - the key is ADOPTED from the environment nango-server seeded into nango-db,
//     never generated — a self-minted UUID passes Nango's format gate and then
//     401s "does not match any account";
//   - absent → mint, malformed → heal, already-right → NOT rewritten;
//   - a VALID key is never rotated (only `reset --full`, which destroyed the
//     nango volume, may re-adopt);
//   - a hosted Nango target is never touched;
//   - nothing here ever throws, and nothing ever emits a key value.
//
// The REAL proof that the adopted key authenticates — a live nango-server
// answering 401 before and 200 after — is the container E2E recorded on the PR.
// These tests pin the contract; they do not stand in for it.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NANGO_DB_COMPOSE_SERVICE,
  NANGO_SECRET_KEY_VAR,
  counterpartNangoEnvironmentName,
  createComposeNangoDbTransport,
  ensureNangoSecretKey,
  isBundledNangoTarget,
  isUuidV4,
  nangoEnvironmentNameForRuntimeMode,
  nangoSecretKeyQueries,
  parseEnvValues,
  planNangoSecretKey,
  readSeededNangoSecretKey,
  upsertEnvValue,
} from "../src/nango-secret-key.mjs";
import { parseEnvBody, upsertEnvKey } from "../src/install.mjs";

// Two distinct, well-formed v4 keys: one standing in for what nango-db seeded,
// one for a value already sitting in .env.local.
const SEEDED = "3f7a1c2e-9b4d-4a61-8c2f-0d5e6a7b8c9d";
const OTHER = "11111111-2222-4333-8444-555555555555";
// The counterpart environment's seeded key: a DIFFERENT environment of the SAME
// bundled nango-db, so it authenticates just as well as SEEDED.
const SEEDED_COUNTERPART = "8c1d2e3f-4a5b-4c6d-9e7f-0a1b2c3d4e5f";

/** A transport that answers a scripted list of psql results, recording the SQL. */
function fakeTransport(script) {
  const queries = [];
  const queue = [...script];
  return {
    queries,
    query: (sql) => {
      queries.push(sql);
      return queue.length > 1 ? queue.shift() : (queue[0] ?? { status: 1, stdout: "", stderr: "" });
    },
  };
}

const ok = (value) => ({ status: 0, stdout: `${value}\n`, stderr: "" });
const emptyRow = { status: 0, stdout: "\n", stderr: "" };
const boom = { status: 1, stdout: "", stderr: 'ERROR:  column "deleted" does not exist' };

describe("isUuidV4 — Nango's own format gate", () => {
  it("accepts a v4 UUID in either case", () => {
    expect(isUuidV4(SEEDED)).toBe(true);
    expect(isUuidV4(SEEDED.toUpperCase())).toBe(true);
    expect(isUuidV4(`  ${SEEDED}  `)).toBe(true);
  });

  it("rejects everything that 401s with invalid_secret_key_format", () => {
    // The exact failure in the issue: an operator typed a phrase into the wizard.
    expect(isUuidV4("my-nango-key")).toBe(false);
    expect(isUuidV4("")).toBe(false);
    expect(isUuidV4(null)).toBe(false);
    // A v1 UUID is a UUID but NOT a v4 — Nango rejects it.
    expect(isUuidV4("3f7a1c2e-9b4d-1a61-8c2f-0d5e6a7b8c9d")).toBe(false);
    // Wrong variant nibble.
    expect(isUuidV4("3f7a1c2e-9b4d-4a61-2c2f-0d5e6a7b8c9d")).toBe(false);
    // Trailing junk on an otherwise valid key.
    expect(isUuidV4(`${SEEDED}x`)).toBe(false);
  });
});

describe("environment selection", () => {
  it("matches discoverBootstrapNangoSettings: production → prod, else dev", () => {
    expect(nangoEnvironmentNameForRuntimeMode("production")).toBe("prod");
    expect(nangoEnvironmentNameForRuntimeMode("PRODUCTION")).toBe("prod");
    expect(nangoEnvironmentNameForRuntimeMode("development")).toBe("dev");
    expect(nangoEnvironmentNameForRuntimeMode("")).toBe("dev");
    expect(nangoEnvironmentNameForRuntimeMode(undefined)).toBe("dev");
  });

  it("builds constant SQL for exactly that environment (nothing interpolated from input)", () => {
    const [primary, relaxed] = nangoSecretKeyQueries("prod");
    expect(primary).toContain("name = 'prod'");
    expect(primary).toContain("deleted = false");
    expect(relaxed).toContain("name = 'prod'");
    expect(relaxed).not.toContain("deleted");
    // An unrecognized name can never reach the SQL.
    expect(nangoSecretKeyQueries("'; drop table _nango_environments; --")[0]).toContain("name = 'dev'");
  });
});

describe("isBundledNangoTarget — a hosted Nango is never touched", () => {
  it("treats unset and every local spelling as the bundled server", () => {
    for (const url of [
      "",
      undefined,
      "http://localhost:3003",
      "http://127.0.0.1:3013",
      "http://nango-server:3003",
      "http://host.docker.internal:3003",
    ]) {
      expect(isBundledNangoTarget(url), String(url)).toBe(true);
    }
  });

  it("treats a hosted URL — and an unparseable one — as not ours", () => {
    expect(isBundledNangoTarget("https://api.nango.dev")).toBe(false);
    expect(isBundledNangoTarget("https://nango.example.com")).toBe(false);
    expect(isBundledNangoTarget("not a url")).toBe(false);
  });
});

describe("planNangoSecretKey — the lifecycle, as a pure decision", () => {
  it("mints when nothing is set", () => {
    expect(planNangoSecretKey({ current: "", seeded: SEEDED })).toMatchObject({ action: "mint", writes: true });
    expect(planNangoSecretKey({ current: "   ", seeded: SEEDED })).toMatchObject({ action: "mint" });
  });

  it("heals a malformed key — it can only ever 401", () => {
    expect(planNangoSecretKey({ current: "my-nango-key", seeded: SEEDED })).toMatchObject({
      action: "heal",
      writes: true,
    });
  });

  it("keeps — and never rewrites — the key that already matches", () => {
    expect(planNangoSecretKey({ current: SEEDED, seeded: SEEDED })).toMatchObject({
      action: "keep",
      reason: "matches-bundled",
      writes: false,
    });
  });

  // The divergence branch, split by what is KNOWN about the other environment.
  it("keeps a valid key that is the OTHER seeded environment's; it authenticates", () => {
    expect(
      planNangoSecretKey({
        current: SEEDED_COUNTERPART,
        seeded: SEEDED,
        alternates: [SEEDED_COUNTERPART],
        alternatesComplete: true,
      }),
    ).toMatchObject({ action: "keep", reason: "matches-other-environment", writes: false });
  });

  it("adopts over a STALE key that matches no environment of this nango-db", () => {
    expect(
      planNangoSecretKey({
        current: OTHER,
        seeded: SEEDED,
        alternates: [SEEDED_COUNTERPART],
        alternatesComplete: true,
      }),
    ).toMatchObject({ action: "adopt-stale", writes: true });
  });

  it("NEVER rotates on partial information: an unread counterpart falls back to reporting", () => {
    expect(planNangoSecretKey({ current: OTHER, seeded: SEEDED })).toMatchObject({
      action: "keep",
      reason: "diverges-from-bundled",
      writes: false,
    });
    expect(
      planNangoSecretKey({ current: OTHER, seeded: SEEDED, alternates: [], alternatesComplete: false }),
    ).toMatchObject({ action: "keep", reason: "diverges-from-bundled", writes: false });
    // A garbage counterpart read is not a counterpart: it can never make a key stale.
    expect(
      planNangoSecretKey({ current: OTHER, seeded: SEEDED, alternates: ["ERROR"], alternatesComplete: false }),
    ).toMatchObject({ action: "keep", reason: "diverges-from-bundled" });
  });

  it("names the two seeded environments as each other's counterpart", () => {
    expect(counterpartNangoEnvironmentName("dev")).toBe("prod");
    expect(counterpartNangoEnvironmentName("prod")).toBe("dev");
  });

  it("re-adopts a divergent key only for a caller that destroyed the environment", () => {
    expect(planNangoSecretKey({ current: OTHER, seeded: SEEDED, adoptDivergent: true })).toMatchObject({
      action: "readopt",
      writes: true,
    });
    // …and that exception never touches an already-correct key.
    expect(planNangoSecretKey({ current: SEEDED, seeded: SEEDED, adoptDivergent: true })).toMatchObject({
      action: "keep",
      reason: "matches-bundled",
    });
  });

  it("refuses a seeded value that is not itself a UUID v4 (a garbage read never becomes the key)", () => {
    expect(planNangoSecretKey({ current: "", seeded: "ERROR" })).toMatchObject({ action: "absent-unresolved", writes: false });
    expect(planNangoSecretKey({ current: "phrase", seeded: "" })).toMatchObject({
      action: "malformed-unresolved",
      writes: false,
    });
    expect(planNangoSecretKey({ current: SEEDED, seeded: null })).toMatchObject({ action: "keep", reason: "unverified" });
  });
});

describe("readSeededNangoSecretKey", () => {
  it("returns the seeded key from the primary query", () => {
    const transport = fakeTransport([ok(SEEDED)]);
    expect(readSeededNangoSecretKey({ transport, environmentName: "dev", sleep: () => {} })).toEqual({
      ok: true,
      secretKey: SEEDED,
    });
    expect(transport.queries).toHaveLength(1);
  });

  it("falls back to the relaxed query when the primary errors (older _nango_environments shape)", () => {
    const transport = fakeTransport([boom, ok(SEEDED)]);
    const result = readSeededNangoSecretKey({ transport, environmentName: "dev", sleep: () => {} });
    expect(result).toEqual({ ok: true, secretKey: SEEDED });
    expect(transport.queries[1]).not.toContain("deleted");
  });

  it("polls while the first-boot migrations are still seeding, then adopts", () => {
    const slept = [];
    const transport = fakeTransport([emptyRow, emptyRow, ok(SEEDED)]);
    const result = readSeededNangoSecretKey({
      transport,
      environmentName: "dev",
      attempts: 5,
      sleep: (s) => slept.push(s),
    });
    expect(result.ok).toBe(true);
    expect(slept.length).toBeGreaterThanOrEqual(2);
  });

  it("stops at the deadline — the attempt count alone does not bound the wall clock", () => {
    // Every query "times out": the attempt budget is 20, but the clock runs out first.
    let clock = 0;
    const transport = {
      queries: [],
      query: (sql) => {
        transport.queries.push(sql);
        clock += 20_000; // the per-query ceiling
        return boom;
      },
    };
    const result = readSeededNangoSecretKey({
      transport,
      environmentName: "dev",
      attempts: 20,
      deadlineMs: 60_000,
      sleep: () => {},
      now: () => clock,
    });
    expect(result.ok).toBe(false);
    // Without the deadline this would be 40 queries. The deadline is checked
    // before EVERY query, so the poll cannot overshoot by a whole attempt.
    expect(transport.queries.length).toBe(3);
  });

  it("always probes at least once, even with no time budget", () => {
    const transport = fakeTransport([ok(SEEDED)]);
    expect(
      readSeededNangoSecretKey({ transport, environmentName: "dev", deadlineMs: 0, sleep: () => {}, now: () => 0 }),
    ).toEqual({ ok: true, secretKey: SEEDED });
    expect(transport.queries).toHaveLength(1);
  });

  it("gives up cleanly — 'could not read', never 'there is none'", () => {
    const transport = fakeTransport([boom]);
    expect(readSeededNangoSecretKey({ transport, environmentName: "dev", attempts: 3, sleep: () => {} })).toEqual({
      ok: false,
      secretKey: null,
    });
    // Both query shapes were tried on every attempt.
    expect(transport.queries).toHaveLength(6);
  });
});

describe("ensureNangoSecretKey — against a real .env.local", () => {
  let dir;
  let envPath;
  let logged;
  const log = (line) => logged.push(String(line));

  const writeEnv = (lines) => writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const readEnv = () => parseEnvValues(readFileSync(envPath, "utf8"));

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cli211-"));
    envPath = path.join(dir, ".env.local");
    logged = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints the seeded key on a fresh install that has none", () => {
    // The shape .env.example ships: the key present only as a COMMENT.
    writeEnv(["CINATRA_RUNTIME_MODE=development", "NANGO_SERVER_URL=http://localhost:3003", "# NANGO_SECRET_KEY="]);
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([ok(SEEDED)]),
      log,
      sleep: () => {},
    });
    expect(result).toMatchObject({ action: "mint", changed: true, environmentName: "dev" });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
    expect(logged.join("\n")).toContain(NANGO_SECRET_KEY_VAR);
  });

  it("is idempotent — a re-run does not rotate the key or rewrite the file", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${SEEDED}`]);
    const before = readFileSync(envPath, "utf8");
    const beforeMtime = statSync(envPath).mtimeMs;

    const result = ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });

    expect(result).toMatchObject({ action: "keep", reason: "matches-bundled", changed: false });
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(statSync(envPath).mtimeMs).toBe(beforeMtime);
    expect(logged).toEqual([]);
  });

  it("heals a malformed pre-existing key and says why it was failing", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=my-nango-key`, "OPENAI_API_KEY=sk-keep-me"]);
    const result = ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });

    expect(result).toMatchObject({ action: "heal", changed: true });
    const env = readEnv();
    expect(env[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
    // Every other line survives.
    expect(env.OPENAI_API_KEY).toBe("sk-keep-me");
    const message = logged.join("\n");
    expect(message).toContain("invalid_secret_key_format");
    expect(message).toContain("UUID v4");
  });

  // The three divergence outcomes, end to end.
  it("keeps a key that belongs to the OTHER seeded environment of the same Nango", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${SEEDED_COUNTERPART}`]);
    // First read: the preferred (`dev`) environment. Second: the counterpart.
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([ok(SEEDED), ok(SEEDED_COUNTERPART)]),
      log,
      sleep: () => {},
    });

    expect(result).toMatchObject({ action: "keep", reason: "matches-other-environment", changed: false });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(SEEDED_COUNTERPART);
    // It authenticates, so nothing is reported.
    expect(logged.join("\n")).toBe("");
  });

  it("adopts over a STALE key from a previous nango-db, and says what happened", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${OTHER}`, "OPENAI_API_KEY=sk-keep-me"]);
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([ok(SEEDED), ok(SEEDED_COUNTERPART)]),
      log,
      sleep: () => {},
    });

    expect(result).toMatchObject({ action: "adopt-stale", changed: true });
    const env = readEnv();
    expect(env[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
    // Every other line survives.
    expect(env.OPENAI_API_KEY).toBe("sk-keep-me");
    const message = logged.join("\n");
    expect(message).toContain("401");
    expect(message).toContain("NO environment");
    // The key value is never echoed.
    expect(message).not.toContain(SEEDED);
    expect(message).not.toContain(OTHER);
  });

  it("reports instead of rotating when the counterpart environment cannot be read", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${OTHER}`]);
    // The preferred environment answers; every counterpart query fails.
    const transport = {
      queries: [],
      query: (sql) => {
        transport.queries.push(sql);
        return transport.queries.length === 1 ? ok(SEEDED) : boom;
      },
    };
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "keep", reason: "diverges-from-bundled", changed: false });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(OTHER);
    const message = logged.join("\n");
    expect(message).toContain("401");
    expect(message).toContain("Re-run");
  });

  it("reports instead of rotating when the counterpart query transport-succeeds with a malformed value", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${OTHER}`]);
    // The preferred environment answers cleanly. The counterpart query also
    // answers status 0, but the row it returns is not a UUID v4 (a garbage
    // read, not a real counterpart) — this must NOT enable adopt-stale.
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([ok(SEEDED), ok("ERROR")]),
      log,
      sleep: () => {},
    });

    expect(result).toMatchObject({ action: "keep", reason: "diverges-from-bundled", changed: false });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(OTHER);
    const message = logged.join("\n");
    expect(message).toContain("401");
    expect(message).toContain("Re-run");
  });

  it("re-adopts after a --full reset destroyed the environment the old key named", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=${OTHER}`]);
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([ok(SEEDED)]),
      log,
      sleep: () => {},
      adoptDivergent: true,
    });
    expect(result).toMatchObject({ action: "readopt", changed: true });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
  });

  it("reads the prod environment for a production instance", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=production"]);
    const transport = fakeTransport([ok(SEEDED)]);
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });
    expect(result).toMatchObject({ action: "mint", environmentName: "prod" });
    expect(transport.queries[0]).toContain("name = 'prod'");
  });

  it("stands down for a hosted Nango, and hints instead of minting", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", "NANGO_SERVER_URL=https://api.nango.dev"]);
    const transport = fakeTransport([ok(SEEDED)]);
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "skipped", reason: "hosted-target" });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBeUndefined();
    expect(transport.queries).toEqual([]); // never even asked the local DB
    expect(logged.join("\n")).toContain("hosted Nango");
  });

  it("stays quiet about a hosted target that already has its own key", () => {
    writeEnv(["NANGO_SERVER_URL=https://api.nango.dev", `${NANGO_SECRET_KEY_VAR}=${OTHER}`]);
    ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });
    expect(logged).toEqual([]);
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(OTHER);
  });

  it("warns (never throws) when the seeded key cannot be read", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    const result = ensureNangoSecretKey({
      envPath,
      transport: fakeTransport([boom]),
      log,
      sleep: () => {},
      attempts: 2,
    });
    expect(result).toMatchObject({ action: "absent-unresolved" });
    expect(logged.join("\n")).toContain(NANGO_DB_COMPOSE_SERVICE);
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBeUndefined();
  });

  it("spends no seed-poll budget verifying a key that is already well-formed", () => {
    writeEnv([`${NANGO_SECRET_KEY_VAR}=${SEEDED}`]);
    const slept = [];
    const transport = fakeTransport([boom]);
    ensureNangoSecretKey({ envPath, transport, log, sleep: (s) => slept.push(s), attempts: 20 });
    expect(slept).toEqual([]);
    expect(transport.queries).toHaveLength(2); // one attempt, both query shapes
  });

  it("returns cleanly when there is no .env.local at all", () => {
    const result = ensureNangoSecretKey({
      envPath: path.join(dir, "missing.env"),
      transport: fakeTransport([ok(SEEDED)]),
      log,
    });
    expect(result).toMatchObject({ action: "skipped", reason: "no-env-file" });
    expect(logged).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps the credential-bearing file owner-only", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("does not clobber an edit that landed while the seeded key was being read", () => {
    // The poll can take tens of seconds. Anything written to .env.local in that
    // window must survive — the plan is re-decided on the CURRENT bytes.
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    const transport = {
      queries: [],
      query: (sql) => {
        transport.queries.push(sql);
        // Someone else finishes the file while we are still polling.
        writeFileSync(envPath, `CINATRA_RUNTIME_MODE=development\nOPENAI_API_KEY=sk-added-later\n`, { mode: 0o600 });
        return ok(SEEDED);
      },
    };
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "mint", changed: true });
    const env = readEnv();
    expect(env.OPENAI_API_KEY).toBe("sk-added-later"); // the concurrent edit survived
    expect(env[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
  });

  it("stands down when the concurrent edit already supplied a valid key", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    const transport = {
      query: () => {
        writeFileSync(envPath, `CINATRA_RUNTIME_MODE=development\n${NANGO_SECRET_KEY_VAR}=${OTHER}\n`, { mode: 0o600 });
        return ok(SEEDED);
      },
    };
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "skipped", reason: "env-file-changed" });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBe(OTHER);
    expect(logged.join("\n")).toContain("changed while");
  });

  it("stands down when the instance switched Nango environments mid-read", () => {
    // The key in hand is the `dev` environment's. If the file became a
    // production instance while it was being read, writing it would install a
    // guaranteed 401 (that key belongs to the other environment).
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    const transport = {
      query: () => {
        writeFileSync(envPath, "CINATRA_RUNTIME_MODE=production\n", { mode: 0o600 });
        return ok(SEEDED);
      },
    };
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "skipped", reason: "runtime-mode-changed" });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBeUndefined();
    expect(logged.join("\n")).toContain("prod");
  });

  it("stands down when the concurrent edit re-pointed the instance at a hosted Nango", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development"]);
    const transport = {
      query: () => {
        writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\nNANGO_SERVER_URL=https://api.nango.dev\n", {
          mode: 0o600,
        });
        return ok(SEEDED);
      },
    };
    const result = ensureNangoSecretKey({ envPath, transport, log, sleep: () => {} });

    expect(result).toMatchObject({ action: "skipped", reason: "hosted-target" });
    expect(readEnv()[NANGO_SECRET_KEY_VAR]).toBeUndefined();
  });

  it("leaves no debris and does not truncate the file when the write fails", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", "OPENAI_API_KEY=sk-keep-me"]);
    const before = readFileSync(envPath, "utf8");
    // A directory where the temp file wants to be makes the write fail late.
    mkdirSync(`${envPath}.nango-secret-key.tmp`);

    const result = ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });

    expect(result).toMatchObject({ action: "write-failed", changed: false });
    expect(readFileSync(envPath, "utf8")).toBe(before); // untouched, not truncated
    rmSync(`${envPath}.nango-secret-key.tmp`, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("writes THROUGH a symlinked .env.local", () => {
    const realPath = path.join(dir, "real.env");
    writeFileSync(realPath, "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });
    const linkPath = path.join(dir, "linked.env");
    symlinkSync(realPath, linkPath);

    ensureNangoSecretKey({ envPath: linkPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true); // still a link
    expect(readFileSync(realPath, "utf8")).toContain(`${NANGO_SECRET_KEY_VAR}=${SEEDED}`);
  });

  it("never emits a key value — not in the log, not in the return", () => {
    writeEnv(["CINATRA_RUNTIME_MODE=development", `${NANGO_SECRET_KEY_VAR}=my-nango-key`]);
    const result = ensureNangoSecretKey({ envPath, transport: fakeTransport([ok(SEEDED)]), log, sleep: () => {} });
    const emitted = `${logged.join("\n")}\n${JSON.stringify(result)}`;
    expect(emitted).not.toContain(SEEDED);
    expect(emitted).not.toContain("my-nango-key");
  });
});

describe("createComposeNangoDbTransport", () => {
  it("runs psql inside the caller's own compose project/files", () => {
    const calls = [];
    const transport = createComposeNangoDbTransport({
      cwd: "/tmp/checkout",
      composeArgs: ["compose", "--env-file", "/tmp/checkout/.env.local", "-p", "cinatra-x", "-f", "docker-compose.yml"],
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: `${SEEDED}\n`, stderr: "" };
      },
    });
    const result = transport.query("select 1;");

    expect(result).toMatchObject({ status: 0 });
    expect(calls[0].command).toBe("docker");
    expect(calls[0].args.slice(0, 7)).toEqual([
      "compose",
      "--env-file",
      "/tmp/checkout/.env.local",
      "-p",
      "cinatra-x",
      "-f",
      "docker-compose.yml",
    ]);
    expect(calls[0].args).toContain(NANGO_DB_COMPOSE_SERVICE);
    expect(calls[0].args).toContain("psql");
    expect(calls[0].options.cwd).toBe("/tmp/checkout");
  });

  it("reports a spawn error as an unusable result instead of throwing", () => {
    const transport = createComposeNangoDbTransport({
      cwd: "/tmp/checkout",
      spawn: () => ({ error: new Error("docker: not found"), status: null }),
    });
    expect(transport.query("select 1;")).toMatchObject({ status: null });
  });
});

describe("env-file helpers stay in lockstep with src/install.mjs", () => {
  // src/nango-secret-key.mjs carries its own copies so install.mjs (deliberately
  // builtins-only) can import it. These pin the copies to the originals.
  const bodies = [
    "",
    "A=1\n",
    "A=1",
    "# NANGO_SECRET_KEY=\nB=2\n",
    `${NANGO_SECRET_KEY_VAR}=old\nB=2\n`,
    'A="quoted # not a comment"\nB=bare # comment\n',
    "export C=3\n",
  ];

  it("upsertEnvValue matches upsertEnvKey byte for byte", () => {
    for (const body of bodies) {
      expect(upsertEnvValue(body, NANGO_SECRET_KEY_VAR, SEEDED), JSON.stringify(body)).toBe(
        upsertEnvKey(body, NANGO_SECRET_KEY_VAR, SEEDED),
      );
    }
  });

  it("parseEnvValues matches parseEnvBody", () => {
    for (const body of bodies) {
      expect(parseEnvValues(body), JSON.stringify(body)).toEqual(parseEnvBody(body));
    }
  });

  it("is DELIBERATELY wider than install.mjs for the shapes the parser accepts", () => {
    // install.mjs's `^KEY=` regex matches neither of these, so it would append a
    // second assignment and leave the broken one behind. The reader accepts them,
    // so the writer must rewrite them.
    for (const body of [`export ${NANGO_SECRET_KEY_VAR}=phrase\nB=2\n`, `${NANGO_SECRET_KEY_VAR} = phrase\nB=2\n`]) {
      const written = upsertEnvValue(body, NANGO_SECRET_KEY_VAR, SEEDED);
      expect(parseEnvValues(written)[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
      expect(written).not.toContain("phrase");
      expect(written).toContain("B=2");
    }
  });

  it("collapses duplicate assignments of the key onto one live value", () => {
    const written = upsertEnvValue(
      `${NANGO_SECRET_KEY_VAR}=phrase\nB=2\n${NANGO_SECRET_KEY_VAR}=other\n`,
      NANGO_SECRET_KEY_VAR,
      SEEDED,
    );
    expect(written.match(new RegExp(`^${NANGO_SECRET_KEY_VAR}=`, "gm"))).toHaveLength(1);
    expect(parseEnvValues(written)[NANGO_SECRET_KEY_VAR]).toBe(SEEDED);
  });
});
