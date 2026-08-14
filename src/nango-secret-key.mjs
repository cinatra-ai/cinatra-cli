// -----------------------------------------------------------------------------
// `NANGO_SECRET_KEY` reconcile for every local bring-up (cinatra-cli#211).
//
// THE GAP: a local install never provisioned `NANGO_SECRET_KEY`. `ensureEnvLocal`
// mints `NANGO_ENCRYPTION_KEY` and `CINATRA_BRIDGE_TOKEN` (cinatra-cli#18) and the
// prod-only secrets (cinatra-cli#143), but not this one — so the app fell back to
// whatever the operator typed at `/setup/connections`, which is stored as
// `connector_config:nango` and is almost never a UUID. nango-server then refuses
// it with `invalid_secret_key_format` (HTTP 401) and EVERY Nango-backed connector
// save fails (Google OAuth/Calendar, Gmail, …) on a supposedly fresh install.
//
// WHY ADOPTING IS THE FIX, AND MINTING A FRESH UUID IS NOT (this is the whole
// point — read it before "simplifying" this module into a `randomUUID()` call):
// `FLAG_AUTH_ENABLED=false` on the bundled nango-server disables its DASHBOARD
// auth, NOT its API secret-key auth. A random UUID passes the FORMAT gate and
// then fails the very next check — `connectSessionOrSecretKeyAuth` looks the key
// up as an ENVIRONMENT and answers 401 "does not match any account". The key is
// not a value we get to choose: nango-server seeds its own environments
// (`prod` and `dev`) into nango-db at first boot, each with a plaintext
// `secret_key` (the `secret_key_hashed` column is the auth match target). The
// host and the container must carry THE SAME value.
//
// THE TWO READERS, and why the reconcile lands in exactly one place:
//   1. the APP reads `NANGO_SECRET_KEY` from the instance's `.env.local`
//      (process env wins over the UI-stored `secrets:secretKey` — the
//      nango-connector's declared `envOverrides`);
//   2. NANGO-SERVER reads its own `_nango_environments` rows out of nango-db.
// Reader 2 is authoritative and self-seeding, so this module makes reader 1
// agree with it: read the seeded environment key out of nango-db, write THAT
// into `.env.local`. Both sides then hold one value by construction — a mint of
// our own would only create a second, differently-broken mismatch.
//
// (The rejected alternative — generate a UUID and SEED it into nango-db — has to
// reproduce nango's own `secret_key_hashed` derivation. That is an internal
// detail of a digest-pinned upstream image; getting it wrong, or having it move
// under a pin bump, wedges auth in a way the operator cannot diagnose. Adopting
// reads a value nango itself wrote and can never disagree with it.)
//
// LIFECYCLE: mint, heal, adopt a stale key, and never rotate a working one:
//   - ABSENT  → adopt the seeded key ("mint" from the operator's point of view).
//   - MALFORMED (not a UUID v4) → heal: that value cannot authenticate under any
//     circumstance, it is the exact `invalid_secret_key_format` 401 in the issue,
//     and there is nothing to preserve. The replacement is announced.
//   - A VALID (UUID v4) KEY THAT AUTHENTICATES IS NEVER OVERWRITTEN. Not when it
//     matches the environment this instance prefers (nothing to do), and not
//     when it is the OTHER environment nango-server seeded either: both keys
//     authenticate against the same bundled server, so holding the other one is
//     a deliberate operator value, and silently rotating credentials out from
//     under an operator is the failure class the sibling
//     `CINATRA_ENCRYPTION_KEY` guard exists to prevent.
//   - STALE (a valid UUID v4 that matches NO environment of this nango-db) →
//     adopt. The hosted target is already excluded, so such a key can never
//     authenticate against the only Nango in play: it is the same guaranteed
//     401 as a malformed key, with nothing to preserve, and
//     it is exactly what a fresh install or a nango-db wipe leaves behind when
//     `.env.local` survives. Only ever decided after EVERY environment was read;
//     a failed counterpart read falls back to reporting, never to rotating.
//   Re-running any bring-up is therefore a no-op once the key is right: the file
//   is not rewritten, so `.env.local` keeps its mtime and its bytes.
//
// TARGET AWARENESS: this only ever speaks for the BUNDLED local Nango. A hosted
// `NANGO_SERVER_URL` has a real secret key issued by the operator's own Nango
// account — the installer must never generate, adopt or overwrite one. A hosted
// target is skipped, with a hint when no key is set at all (the "onboarding
// gives no hint" half of the issue).
//
// FAILURE DISCIPLINE: loud-but-non-fatal, like `waitForNango` above it. A
// nango-db that will not answer, a psql that is missing from the image, a schema
// that moved — none of these are worth aborting an otherwise-good install for.
// The app degrades gracefully around a missing key (cinatra#2545/#2552); this
// module exists to make that degradation UNNECESSARY, not to become a new abort
// class. Every failure path warns and names the manual command.
//
// SECRECY (precisely): `ensureNangoSecretKey` — the entry point every caller
// uses — never logs a key value and never returns one. Its result is an action
// name plus booleans, so no caller can print a secret by accident (pinned by a
// test). The internal read helpers below (`readSeededNangoSecretKey` and the
// transport) obviously carry the value; they are exported only so the unit
// tests can drive them, and callers must not route their output to a log.
//
// WRITE SAFETY: the file is re-read and re-planned immediately before the write
// (the seed poll can take tens of seconds, and the plan must not be applied to a
// stale snapshot), and the new bytes land through a same-directory temp file +
// `rename`, so an interrupted or out-of-space write can never leave `.env.local`
// truncated — every other secret in it would be lost.
//
// SHELL SAFETY: no value is ever interpolated into a command. The SQL strings are
// module constants selected by a two-valued environment name; the psql
// invocation is a constant argv.
//
// Dependency-light on purpose (node builtins + the `docker` binary every other
// bring-up step already shells out to), so `install.mjs` — which is deliberately
// self-contained — can import it.
// -----------------------------------------------------------------------------

import process from "node:process";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** The env var the app reads, and the only key this module ever writes. */
export const NANGO_SECRET_KEY_VAR = "NANGO_SECRET_KEY";

/** Compose service that runs the Nango database (docker-compose.yml). */
export const NANGO_DB_COMPOSE_SERVICE = "nango-db";

/** Database/role the bundled nango-db is initialized with (compose literals). */
export const NANGO_DB_USER = "nango";
export const NANGO_DB_NAME = "nango";

/** Seed poll budget when a key is genuinely MISSING/MALFORMED: nango-server runs
 *  its first-boot migrations after `/health` starts answering, so the
 *  `_nango_environments` rows can lag the health probe by a few seconds. Same
 *  shape as the works-after nango smoke in the app repo (20 × 2s). */
export const NANGO_ENVIRONMENT_SEED_ATTEMPTS = 20;
export const NANGO_ENVIRONMENT_SEED_INTERVAL_SECONDS = 2;

/** Per-query ceiling. A wedged `docker compose exec` would otherwise block the
 *  install forever — spawnSync with no timeout waits indefinitely. */
export const NANGO_DB_QUERY_TIMEOUT_MS = 20_000;

/** Whole-read ceiling. The attempt count alone does NOT bound the wall clock
 *  (each attempt can burn the query timeout twice), so the poll also stops at a
 *  deadline: a broken container can cost the bring-up a bounded minute, never an
 *  open-ended hang. */
export const NANGO_ENVIRONMENT_SEED_DEADLINE_MS = 60_000;

/** RFC 4122 UUID v4 — the format nango-server's own gate enforces before it even
 *  looks the key up (`invalid_secret_key_format`). Version nibble 4, variant
 *  nibble 8/9/a/b. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True iff `value` is a UUID v4 — i.e. iff nango-server's format gate accepts
 *  it. Everything else 401s with `invalid_secret_key_format`. */
export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_RE.test(value.trim());
}

/**
 * Which seeded Nango environment this instance authenticates as.
 *
 * IDENTICAL to `discoverBootstrapNangoSettings` in src/index.mjs (`production` →
 * `prod`, everything else → `dev`). Load-bearing: that function is the CLI's own
 * runtime discovery of the same key, so if the two disagreed the CLI would
 * bootstrap against one environment while the app authenticated as another.
 */
export function nangoEnvironmentNameForRuntimeMode(runtimeMode) {
  return String(runtimeMode ?? "").trim().toLowerCase() === "production" ? "prod" : "dev";
}

/** Every environment nango-server seeds into a fresh nango-db. */
export const NANGO_ENVIRONMENT_NAMES = ["prod", "dev"];

/** The other seeded environment. EITHER key authenticates against the same
 *  bundled server, so "which one" is a preference, while "neither" is a fault. */
export function counterpartNangoEnvironmentName(environmentName) {
  return environmentName === "prod" ? "dev" : "prod";
}

/** Hosts that can only mean "the Nango this install just brought up". */
const BUNDLED_NANGO_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "nango-server", // compose-internal service name
  "nango",
  "host.docker.internal",
]);

/**
 * True iff `serverUrl` is the bundled local nango-server (or is unset, which
 * resolves to the local default). A hosted URL returns false and the reconcile
 * stands down — an operator's hosted environment key is theirs to supply.
 *
 * Unparseable input is treated as NOT bundled (fail closed: never touch a key
 * for a target we could not identify).
 */
export function isBundledNangoTarget(serverUrl) {
  const raw = String(serverUrl ?? "").trim();
  if (raw === "") return true; // unset ⇒ the local default (http://localhost:3003)
  let host;
  try {
    host = new URL(raw).hostname;
  } catch {
    return false;
  }
  return BUNDLED_NANGO_HOSTS.has(host.toLowerCase());
}

/**
 * The read of the seeded environment key, in the shape the CLI already uses.
 *
 * `primary` mirrors `discoverBootstrapNangoSettings` (src/index.mjs) exactly —
 * same predicate, same deterministic ordering — so both resolve the SAME row.
 * `relaxed` is the fallback for an image whose `_nango_environments` carries no
 * `deleted` column (the shape the app repo's works-after smoke reads); it runs
 * only after the primary errors, never instead of it.
 *
 * Constant strings selected by a two-valued name — nothing is interpolated.
 */
export function nangoSecretKeyQueries(environmentName) {
  const name = environmentName === "prod" ? "prod" : "dev";
  return [
    `select secret_key from _nango_environments where deleted = false and name = '${name}' order by account_id asc, id asc limit 1;`,
    `select secret_key from _nango_environments where name = '${name}' limit 1;`,
  ];
}

/** Bounded sync backoff, matching how the sibling bring-up waits do it. */
function sleepSeconds(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

/**
 * Default transport: one `psql` inside the compose `nango-db` service. Mirrors
 * how every other bring-up step reaches its containers (`docker compose exec -T
 * <service> …`), and takes the SAME `composeArgs` prefix the caller upped with,
 * so it resolves the caller's compose files/project/env-file rather than
 * guessing.
 *
 * Returns a plain record instead of throwing — the caller decides (nothing here
 * is fatal).
 */
export function createComposeNangoDbTransport({
  cwd,
  composeArgs = ["compose"],
  service = NANGO_DB_COMPOSE_SERVICE,
  spawn = spawnSync,
} = {}) {
  return {
    query: (sql) => {
      const result = spawn(
        "docker",
        [...composeArgs, "exec", "-T", service, "psql", "-U", NANGO_DB_USER, "-d", NANGO_DB_NAME, "-tAc", sql],
        {
          cwd,
          encoding: "utf8",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          // Bounded: a hung daemon/container must not stall the bring-up.
          timeout: NANGO_DB_QUERY_TIMEOUT_MS,
        },
      );
      return {
        status: result?.error ? null : (result?.status ?? null),
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
      };
    },
  };
}

/**
 * Read the seeded `secret_key` for `environmentName` out of nango-db. Polls
 * because the rows are written by nango-server's first-boot migrations, which
 * can land after `/health` starts answering.
 *
 * Returns `{ ok, secretKey }`; `ok:false` means "could not read one", never
 * "there is none" — the caller reports it as unresolved rather than acting.
 */
export function readSeededNangoSecretKey({
  transport,
  environmentName = "dev",
  attempts = NANGO_ENVIRONMENT_SEED_ATTEMPTS,
  intervalSeconds = NANGO_ENVIRONMENT_SEED_INTERVAL_SECONDS,
  deadlineMs = NANGO_ENVIRONMENT_SEED_DEADLINE_MS,
  sleep = sleepSeconds,
  now = Date.now,
} = {}) {
  const queries = nangoSecretKeyQueries(environmentName);
  const budget = Math.max(1, Number(attempts) || 1);
  const deadline = now() + Math.max(0, Number(deadlineMs) || 0);
  // The attempt COUNT does not bound the wall clock — a timing-out query burns
  // seconds per try — so the deadline is what actually caps the poll. It is
  // checked before EVERY query and before every backoff (checking only between
  // attempts would let a late attempt overshoot by two query timeouts plus a
  // sleep). The first query always runs, so a zero budget still probes once.
  let ran = 0;
  for (let attempt = 0; attempt < budget; attempt += 1) {
    for (const sql of queries) {
      if (ran > 0 && now() >= deadline) return { ok: false, secretKey: null };
      ran += 1;
      const result = transport.query(sql);
      if (result?.status !== 0) continue;
      // `-tA` yields one bare value per row; take the first non-empty line.
      const value = String(result.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "");
      if (value) return { ok: true, secretKey: value };
      break; // the primary answered cleanly with no row — the relaxed form adds nothing
    }
    if (attempt < budget - 1 && now() < deadline) sleep(intervalSeconds);
  }
  return { ok: false, secretKey: null };
}

/**
 * The DECISION, as a pure function of the two values — the whole lifecycle in
 * one testable place.
 *
 *   mint                    – nothing set, adopt the seeded key
 *   heal                    – set but not a UUID v4 (it can only ever 401), replace
 *   keep/matches-bundled    – already the bundled environment key: no write
 *   keep/matches-other-env  – a VALID key that is the OTHER seeded environment's:
 *                             it authenticates, so it is a deliberate operator
 *                             choice and is kept silently
 *   keep/diverges           – a VALID key that matches the preferred environment
 *                             and could not be checked against the other one:
 *                             never overwritten on partial information, reported
 *   keep/unverified         – a valid key, and the seed could not be read: no write
 *   adopt-stale             – a VALID key that matches NO environment this
 *                             nango-db seeded, with every environment read: it
 *                             can never authenticate, so it is replaced
 *   readopt                 – a valid key that diverges, on a caller that JUST
 *                             destroyed and re-seeded the Nango environment
 *   absent-unresolved       – nothing set and no seed to adopt
 *   malformed-unresolved    – broken key and no seed to heal it with
 *
 * WHY `adopt-stale` EXISTS (and why it does NOT weaken the
 * never-rotate rule): the rule protects a key the operator MEANT to set. The
 * hosted target is already excluded above, so the only Nango in play is the
 * bundled one, and a key that matches NEITHER of its seeded environments cannot
 * authenticate against it under any circumstance. It is exactly the same class
 * as a malformed key, which this module has always healed: a guaranteed 401 with
 * nothing to preserve. That is the state a fresh install or a nango-db wipe
 * leaves behind when `.env.local` survives, and reporting it (the old behaviour)
 * left the operator to hand-edit the file. The key is replaced ONLY when every
 * environment was actually read; a failed counterpart read falls back to
 * reporting, because a rotation must never rest on partial information.
 *
 * `adoptDivergent` remains the exception for a caller that KNOWS the environment
 * is gone: only `cinatra instance reset --full` passes it. That command runs
 * `docker compose down -v`, which DESTROYS the nango volume, so it may re-adopt
 * without waiting to prove the old key matches nothing.
 *
 * A seeded value that is NOT itself a UUID v4 is refused (treated as no seed):
 * a garbage read must never become the host's key.
 */
export function planNangoSecretKey({
  current,
  seeded,
  alternates = [],
  alternatesComplete = false,
  adoptDivergent = false,
} = {}) {
  const cur = String(current ?? "").trim();
  const seed = String(seeded ?? "").trim();
  const adoptable = seed !== "" && isUuidV4(seed);

  if (cur === "") return { action: adoptable ? "mint" : "absent-unresolved", writes: adoptable };
  if (!isUuidV4(cur)) return { action: adoptable ? "heal" : "malformed-unresolved", writes: adoptable };
  if (!adoptable) return { action: "keep", reason: "unverified", writes: false };
  if (seed === cur) return { action: "keep", reason: "matches-bundled", writes: false };
  if (adoptDivergent) return { action: "readopt", writes: true };

  const otherSeeded = (Array.isArray(alternates) ? alternates : [])
    .map((value) => String(value ?? "").trim())
    .filter((value) => value !== "" && isUuidV4(value));
  if (otherSeeded.includes(cur)) return { action: "keep", reason: "matches-other-environment", writes: false };

  return alternatesComplete
    ? { action: "adopt-stale", writes: true }
    : { action: "keep", reason: "diverges-from-bundled", writes: false };
}

/**
 * Minimal `.env` body → { KEY: value } map. Deliberately a LOCAL copy (this
 * module stays node-builtins-only and importable from the self-contained
 * `install.mjs`); `tests/nango-secret-key.test.mjs` pins it against
 * `parseEnvBody`/`upsertEnvKey` in src/install.mjs so the two cannot drift.
 */
export function parseEnvValues(body) {
  const out = {};
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0];
      const close = v.indexOf(quote, 1);
      if (close !== -1) v = v.slice(1, close);
    } else {
      const commentAt = v.search(/\s#/);
      if (commentAt !== -1) v = v.slice(0, commentAt).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Replace `KEY=` in place when an assignment exists, else append.
 *
 * Byte-identical to `upsertEnvKey` in src/install.mjs for the plain `KEY=value`
 * shape (pinned by a parity test) and deliberately WIDER for the other shapes
 * `parseEnvValues` accepts — `export KEY=…` and `KEY = …`. install.mjs's regex
 * matches neither, so healing a key written that way would append a second
 * assignment and leave the broken one in the file. Here the first assignment in
 * any accepted shape is rewritten and any later duplicate of the same key is
 * dropped, so the reader and the writer can never disagree about which value is
 * live.
 */
export function upsertEnvValue(body, key, value) {
  const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`);
  if (!body.split("\n").some((line) => assignment.test(line))) {
    const sep = body.endsWith("\n") || body.length === 0 ? "" : "\n";
    return `${body}${sep}${key}=${value}\n`;
  }
  let replaced = false;
  const kept = [];
  for (const line of body.split("\n")) {
    if (!assignment.test(line)) {
      kept.push(line);
      continue;
    }
    if (replaced) continue; // a later duplicate of the same key — drop it
    kept.push(`${key}=${value}`);
    replaced = true;
  }
  return kept.join("\n");
}

const MANUAL_READ_HINT =
  "read it with `docker compose exec -T nango-db psql -U nango -d nango -tAc " +
  '"select secret_key from _nango_environments where name=\'dev\' limit 1;"` ' +
  "and set NANGO_SECRET_KEY in .env.local";

/**
 * Reconcile `NANGO_SECRET_KEY` in `envPath` against the bundled Nango's seeded
 * environment key. Synchronous (every caller is a sync bring-up step) and
 * non-throwing by contract.
 *
 * Returns `{ action, reason, changed, environmentName, envPath }` — never a key
 * value.
 */
export function ensureNangoSecretKey({
  envPath,
  transport,
  log = console.log,
  sleep = sleepSeconds,
  attempts = NANGO_ENVIRONMENT_SEED_ATTEMPTS,
  adoptDivergent = false,
} = {}) {
  const result = (action, { reason = null, changed = false, environmentName = null } = {}) => ({
    action,
    reason,
    changed,
    environmentName,
    envPath: envPath ?? null,
  });

  if (!envPath || !existsSync(envPath)) return result("skipped", { reason: "no-env-file" });

  let body;
  try {
    body = readFileSync(envPath, "utf8");
  } catch (err) {
    log(`  ⚠ Could not read ${envPath} to reconcile ${NANGO_SECRET_KEY_VAR} (${err?.message ?? err}).`);
    return result("skipped", { reason: "unreadable-env-file" });
  }

  const values = parseEnvValues(body);
  const current = values[NANGO_SECRET_KEY_VAR] ?? "";

  if (!isBundledNangoTarget(values.NANGO_SERVER_URL)) {
    // Hosted Nango: never generate, adopt or overwrite. Only speak up when there
    // is no key at all — that install cannot reach any connector, and nothing
    // else tells the operator why.
    if (String(current).trim() === "") {
      log(
        `  ⚠ ${NANGO_SECRET_KEY_VAR} is not set and NANGO_SERVER_URL points at a hosted Nango — ` +
          "this installer never generates a hosted secret key. Copy it from your Nango " +
          "Environment Settings → Secret Key into .env.local, or Nango-backed connectors will fail with HTTP 401.",
      );
    }
    return result("skipped", { reason: "hosted-target" });
  }

  const environmentName = nangoEnvironmentNameForRuntimeMode(values.CINATRA_RUNTIME_MODE);
  // A key that is already well-formed needs at most a VERIFICATION read: give it
  // one attempt so a bring-up whose nango-db is slow/unreachable is not stalled
  // by the full seed-poll budget for a file that is very likely already right.
  // (A caller that just recreated the Nango volume always needs the full budget:
  // the environment it is adopting was seeded seconds ago.)
  const needsKey = adoptDivergent || String(current).trim() === "" || !isUuidV4(current);
  const seeded = readSeededNangoSecretKey({
    transport,
    environmentName,
    attempts: needsKey ? attempts : 1,
    sleep,
  });

  // A well-formed key that is not the PREFERRED environment's is not yet a
  // fault: the other seeded environment authenticates just as well, and an
  // operator (or the app repo's own `npm run services` reconcile, which prefers
  // `prod`) may deliberately hold that one. So before treating a divergence as
  // stale, read the counterpart environment and find out whether the key matches
  // ANY environment this nango-db seeded. One attempt is enough: by the time the
  // preferred environment answered, every environment is seeded (one migration
  // writes them all).
  let alternates = [];
  let alternatesComplete = false;
  const currentDiverges =
    !adoptDivergent && seeded.ok && isUuidV4(current) && String(current).trim() !== seeded.secretKey;
  if (currentDiverges) {
    const counterpart = readSeededNangoSecretKey({
      transport,
      environmentName: counterpartNangoEnvironmentName(environmentName),
      attempts: 1,
      sleep,
    });
    alternatesComplete = counterpart.ok;
    if (counterpart.ok) alternates = [counterpart.secretKey];
  }

  let plan = planNangoSecretKey({
    current,
    seeded: seeded.secretKey,
    alternates,
    alternatesComplete,
    adoptDivergent,
  });

  if (plan.action === "keep") {
    if (plan.reason === "diverges-from-bundled") {
      log(
        `  ⚠ ${NANGO_SECRET_KEY_VAR} in .env.local is a well-formed key, but it is NOT this instance's ` +
          `bundled Nango \`${environmentName}\` environment key, and the other seeded environment could ` +
          `not be read from ${NANGO_DB_COMPOSE_SERVICE} to tell whether it matches THAT one. If it matches ` +
          'neither, Nango answers HTTP 401 ("does not match any account") for every connector save. Left ' +
          "untouched (this installer never rotates a valid key on partial information). Re-run this command " +
          `once the stack is up, or delete the ${NANGO_SECRET_KEY_VAR} line from .env.local to adopt the ` +
          "bundled key.",
      );
    }
    return result("keep", { reason: plan.reason, environmentName });
  }

  if (plan.action === "absent-unresolved") {
    log(
      `  ⚠ ${NANGO_SECRET_KEY_VAR} is not set and this instance's Nango environment key could not be read ` +
        `from ${NANGO_DB_COMPOSE_SERVICE} — Nango-backed connectors will fail with HTTP 401 until it is. ` +
        `Once the stack is up, ${MANUAL_READ_HINT} (or just re-run this command).`,
    );
    return result("absent-unresolved", { environmentName });
  }

  if (plan.action === "malformed-unresolved") {
    log(
      `  ⚠ ${NANGO_SECRET_KEY_VAR} in .env.local is not a UUID v4, so Nango rejects it with ` +
        "`invalid_secret_key_format` (HTTP 401) on every connector save — and the bundled Nango's own key " +
        `could not be read from ${NANGO_DB_COMPOSE_SERVICE} to replace it. Once the stack is up, ` +
        `${MANUAL_READ_HINT} (or just re-run this command).`,
    );
    return result("malformed-unresolved", { environmentName });
  }

  // mint / heal / adopt-stale / readopt — the only paths that write.
  //
  // RE-READ FIRST. The seed poll above can take tens of seconds, and applying the
  // plan to the snapshot taken before it would silently discard anything written
  // to `.env.local` in that window (the setup wizard, a second command, the
  // operator's editor). Re-read, re-decide on the CURRENT bytes, and stand down
  // if the file no longer wants what was planned.
  let live;
  try {
    live = readFileSync(envPath, "utf8");
  } catch (err) {
    log(`  ⚠ Could not re-read ${envPath} before writing ${NANGO_SECRET_KEY_VAR} (${err?.message ?? err}).`);
    return result("write-failed", { environmentName });
  }
  if (live !== body) {
    const liveValues = parseEnvValues(live);
    if (!isBundledNangoTarget(liveValues.NANGO_SERVER_URL)) {
      log(
        `  ⚠ .env.local was re-pointed at a hosted Nango while this instance's key was being read — ` +
          `leaving ${NANGO_SECRET_KEY_VAR} alone.`,
      );
      return result("skipped", { reason: "hosted-target", environmentName });
    }
    // The key in hand belongs to ONE Nango environment. If the instance's
    // runtime mode moved while it was being read, that key is for the wrong
    // environment — writing it would install a guaranteed 401. Stand down; the
    // next run reads the right one.
    const liveEnvironmentName = nangoEnvironmentNameForRuntimeMode(liveValues.CINATRA_RUNTIME_MODE);
    if (liveEnvironmentName !== environmentName) {
      log(
        `  ⚠ .env.local switched to the \`${liveEnvironmentName}\` Nango environment while the ` +
          `\`${environmentName}\` key was being read — left ${NANGO_SECRET_KEY_VAR} alone. Re-run this command.`,
      );
      return result("skipped", { reason: "runtime-mode-changed", environmentName });
    }
    const livePlan = planNangoSecretKey({
      current: liveValues[NANGO_SECRET_KEY_VAR] ?? "",
      seeded: seeded.secretKey,
      alternates,
      alternatesComplete,
      adoptDivergent,
    });
    if (!livePlan.writes) {
      log(
        `  ⚠ .env.local changed while this instance's Nango key was being read — left ` +
          `${NANGO_SECRET_KEY_VAR} as the file now has it. Re-run this command if connectors still fail.`,
      );
      return result("skipped", { reason: "env-file-changed", environmentName });
    }
    plan = livePlan;
    body = live;
  }

  const next = upsertEnvValue(body, NANGO_SECRET_KEY_VAR, seeded.secretKey);
  if (next === body) return result("keep", { reason: "matches-bundled", environmentName });

  // Write through a same-directory temp file + rename: a truncating in-place
  // write that fails halfway (ENOSPC, a killed install) would destroy every
  // other secret in `.env.local`, and this step is explicitly non-fatal — it
  // must never be able to break the file it is helping. `realpathSync` keeps a
  // symlinked `.env.local` a symlink (the rename replaces its TARGET).
  let target = envPath;
  try {
    target = realpathSync(envPath);
  } catch {
    /* not resolvable (broken symlink / permissions) — write the path as given */
  }
  const tmpPath = `${target}.nango-secret-key.tmp`;
  try {
    writeFileSync(tmpPath, next, { mode: 0o600 });
    chmodSync(tmpPath, 0o600); // umask must not widen a credential-bearing file
    renameSync(tmpPath, target);
  } catch (err) {
    // Best-effort cleanup: `force` does not swallow every failure (a DIRECTORY
    // sitting on the temp path raises EISDIR), and this module must not throw.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* leave the debris rather than fail the bring-up over it */
    }
    log(`  ⚠ Could not write ${NANGO_SECRET_KEY_VAR} to ${envPath} (${err?.message ?? err}).`);
    return result("write-failed", { environmentName });
  }

  if (plan.action === "heal") {
    log(
      `  ⚠ ${NANGO_SECRET_KEY_VAR} in .env.local was not a UUID v4 — Nango rejects that with ` +
        "`invalid_secret_key_format` (HTTP 401), which is why Nango-backed connectors could not save. " +
        `Replaced it with this instance's bundled Nango \`${environmentName}\` environment key.`,
    );
  } else if (plan.action === "adopt-stale") {
    log(
      `  ⚠ ${NANGO_SECRET_KEY_VAR} in .env.local was a well-formed key that matched NO environment of this ` +
        'instance\'s Nango: a key from a previous nango-db, which answers HTTP 401 ("does not match any ' +
        'account") on every connector save. That is what a fresh install or a nango-db wipe leaves behind ' +
        `when .env.local survives. Replaced it with this instance's bundled Nango \`${environmentName}\` ` +
        "environment key.",
    );
  } else if (plan.action === "readopt") {
    log(
      `  ${NANGO_SECRET_KEY_VAR} in .env.local pointed at the Nango environment this reset destroyed — ` +
        `re-pointed it at the rebuilt stack's \`${environmentName}\` environment key.`,
    );
  } else {
    log(
      `  ${NANGO_SECRET_KEY_VAR} set in .env.local from this instance's bundled Nango ` +
        `\`${environmentName}\` environment — Nango-backed connectors (Google, Gmail, …) can authenticate.`,
    );
  }
  return result(plan.action, { changed: true, environmentName });
}
