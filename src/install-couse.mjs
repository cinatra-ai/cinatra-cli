// Shared-infra "co-use" install path (cinatra-cli#40, #17 option B).
//
// Co-use runs a SECOND app instance (its OWN checkout, OWN app port, OWN Postgres
// database) against the FIRST ("donor") instance's already-RUNNING infra — one
// Postgres server, one Redis, one Nango, one Graphiti — with NO second Docker
// stack. It is the cheapest way to run two dev instances on one host (vs. the
// ~9-container isolated stack).
//
// THE HARD SAFETY GATE (the reason this was refused, not the reason it can be
// enabled blindly): Better-Auth derives its session-cookie name from the app
// name, and localhost cookies are PORT-BLIND (the cookie Domain is the host-only
// `localhost`, ignoring the port). Two instances on `localhost:<a>` /
// `localhost:<b>` therefore SHARE the cookie jar — an authenticated session on
// one silently authenticates (and a logout clobbers) the other. The ONLY clean
// fix is a per-instance cookie PREFIX, which the app must honour via
// `advanced.cookiePrefix` reading `BETTER_AUTH_COOKIE_PREFIX`. Until a donor app
// build advertises that support, co-use MUST fail CLOSED — this module's
// capability probe (`parseAuthCookiePrefixSupport` + `assertCoUsePrereqs`) is
// that gate. Everything else (separate DB, BullMQ queue namespace) is already
// proven by the clone system; the cookie-prefix is the one missing piece.
//
// This module is HERMETIC-PURE (no I/O) so the derivations + env builder + the
// capability gate are unit-testable in isolation, mirroring install-isolation.mjs.
// The executor (install.mjs `executeCoUse`) does the I/O (read donor source/env,
// create/drop the DB, write .env.local) using these helpers.

import { isValidSlug } from "./clone-registry.mjs";

/** The single forward-compat env keys a co-use install writes. Exported so the
 *  executor + tests reference the same canonical names. */
export const COUSE_COOKIE_PREFIX_ENV = "BETTER_AUTH_COOKIE_PREFIX";
export const COUSE_REDIS_PREFIX_ENV = "CINATRA_REDIS_PREFIX";

/** Derive the co-use instance slug: an explicit `--instance`, else the sanitised
 *  install-dir basename (same rules as the isolated path's deriveInstanceSlug, so
 *  a checkout gets ONE stable slug whichever path it takes). Pure. */
export function deriveCoUseSlug(targetDir, opts = {}) {
  if (opts?.instance) return opts.instance;
  const base = String(targetDir ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/** The separate Postgres database name for a co-use instance. Matches the
 *  `cinatra_inst_*` shape (NOT `cinatra_clone_*` — co-use is distinct from the
 *  clone system) so install-owned drop logic can recognise it. Pure. */
export function coUseDbName(slug) {
  return `cinatra_inst_${String(slug).replace(/-/g, "_")}`;
}

/** EXACT-shape guard for a co-use DB name — the last line of defence before a
 *  rollback `DROP DATABASE`. Mirrors clone-registry's CLONE_DB_NAME_RE rigour:
 *  only `cinatra_inst_<slug-shaped>` is droppable; anything else fails closed.
 *  Pure. */
const COUSE_DB_NAME_RE = /^cinatra_inst_[a-z0-9][a-z0-9_]{0,29}$/;
export function isCoUseDbNameShape(name) {
  return typeof name === "string" && COUSE_DB_NAME_RE.test(name);
}

/** The BullMQ queue name for a co-use instance (BullMQ isolates job sets by queue
 *  name on a shared Redis — `bull:<queueName>:*`). Parallels the clone branch's
 *  `cinatra-bg-<slug>`. Pure. */
export function coUseQueueName(slug) {
  return `cinatra-inst-${slug}`;
}

/** The Redis key prefix for a co-use instance. FORWARD-COMPAT ONLY: the app does
 *  NOT yet apply a `keyPrefix` from this env, so it provides NO isolation today
 *  (Redis safety rests on the BullMQ queue-name isolation + the UUID-keyed
 *  pub/sub event-logs). It is written so the value is ready the moment the app
 *  honours it. Pure. */
export function coUseRedisPrefix(slug) {
  return `cinatra:${slug}`;
}

/** The Better-Auth cookie prefix for a co-use instance — the ONE value that
 *  makes co-use safe on a single localhost host (distinct cookie names per
 *  instance, so a session on one does not authenticate the other). Only EFFECTIVE
 *  once the donor app honours `BETTER_AUTH_COOKIE_PREFIX` via
 *  `advanced.cookiePrefix` (the capability the probe verifies). Pure. */
export function coUseCookiePrefix(slug) {
  return `cinatra-${slug}`;
}

/**
 * The capability probe's PURE core: does the donor app build honour a per-
 * instance cookie prefix? Returns true iff the donor's checked-out
 * `src/lib/auth.ts` source wires `advanced.cookiePrefix` to an environment
 * variable (i.e. `cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX...`).
 *
 * This is deliberately conservative — it requires BOTH the `cookiePrefix` key AND
 * an env read in the auth config, so a stale donor (no per-instance cookie
 * isolation) is recognised and co-use fails CLOSED. A first-class app-advertised
 * capability marker would be more durable; until the app exposes one, source
 * inspection is the honest gate (fail closed on any uncertainty / unreadable
 * source → the executor treats a null/empty source as unsupported). Pure.
 *
 * @param {string|null} authSourceText  contents of the donor's src/lib/auth.ts
 * @returns {boolean}
 */
export function parseAuthCookiePrefixSupport(authSourceText) {
  if (typeof authSourceText !== "string" || authSourceText.length === 0) return false;
  // Strip comments so a commented-out example does not false-positive.
  const code = authSourceText.replace(/\/\/[^\n]*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // Require the `cookiePrefix` KEY to be ASSIGNED FROM the env var directly —
  // `cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX…` (dot or bracket
  // access). Codex Q1 refinement: a mere co-location of `cookiePrefix` and the
  // env name elsewhere in the file is NOT proof the prefix is env-driven, so we
  // bind the two within one assignment expression (whitespace-tolerant; allows
  // a trailing `?.trim()` / `|| "cinatra"`). Fails closed on any other shape.
  const envDot = `process\\.env\\.${COUSE_COOKIE_PREFIX_ENV}\\b`;
  const envBracket = `process\\.env\\[\\s*["']${COUSE_COOKIE_PREFIX_ENV}["']\\s*\\]`;
  const assigned = new RegExp(
    `\\bcookiePrefix\\b\\s*:\\s*[^,;}\\n]*(?:${envDot}|${envBracket})`,
  );
  return assigned.test(code);
}

/**
 * Pure prerequisite gate. Throws a precise, actionable error when a HARD co-use
 * prerequisite is unmet; returns silently when all are satisfied.
 *
 *  - cookiePrefixSupported === false → the upstream blocker. The headline co-use
 *    safety guarantee (no session cross-clobber on one host) is NOT deliverable
 *    against this donor app build. Fail closed with the exact app change needed.
 *  - graphitiShared && !allowSharedGraphiti → Graphiti/Neo4j episodes are
 *    org-scoped, NOT instance-scoped (no per-instance group prefix), so sharing
 *    one Graphiti across two instances can collide on overlapping org ids. Refuse
 *    by default; require an eyes-open `--allow-shared-graphiti` to share it.
 *
 * @param {object} caps
 * @param {boolean} caps.cookiePrefixSupported
 * @param {boolean} [caps.graphitiShared]
 * @param {boolean} [caps.allowSharedGraphiti]
 */
export function assertCoUsePrereqs({ cookiePrefixSupported, graphitiShared = false, allowSharedGraphiti = false } = {}) {
  if (!cookiePrefixSupported) {
    throw new Error(
      "Co-use is refused: the donor Cinatra app build does NOT isolate auth cookies per instance.\n" +
        "  Two app instances on one host share localhost cookies (the cookie Domain is port-blind), so a\n" +
        "  session on one would silently authenticate — and a logout would clobber — the other.\n" +
        "  Co-use needs the app to honour a per-instance cookie prefix:\n" +
        `    src/lib/auth.ts → betterAuth({ advanced: { cookiePrefix: process.env.${COUSE_COOKIE_PREFIX_ENV}?.trim() || \"cinatra\" }, … })\n` +
        "  Once a donor checkout carries that, co-use enables automatically (the CLI re-probes the donor source).\n" +
        "  Until then, use --on-conflict=isolated for a fully-separate second stack.",
    );
  }
  if (graphitiShared && !allowSharedGraphiti) {
    throw new Error(
      "Co-use is refused: the donor sets GRAPHITI_URL and Graphiti/Neo4j is NOT instance-namespaced.\n" +
        "  Episodes are written under an ORG-scoped group id (cinatra-org-<orgId>), not a per-instance group,\n" +
        "  so two instances sharing one Graphiti can collide on overlapping org ids.\n" +
        "  Re-run with --allow-shared-graphiti to accept org-scoped sharing (eyes-open), or point the second\n" +
        "  instance at a separate Graphiti.",
    );
  }
}

/**
 * Pure env-map builder for a co-use `.env.local`. Returns a flat
 * `{ KEY: value }` object the executor upserts into the donor-derived env body.
 *
 * Isolation choices (grounded against the cinatra app + the clone system):
 *  - SUPABASE_DB_URL → the SEPARATE `cinatra_inst_<slug>` database on the donor's
 *    Postgres SERVER (strongest boundary — the clone system's proven path), via
 *    `connStringForDatabase`. SUPABASE_SCHEMA stays "cinatra" (separate DB, not
 *    schema-in-shared-DB).
 *  - PORT / BETTER_AUTH_URL / NEXT_PUBLIC_BETTER_AUTH_URL → the co-use app port.
 *  - BULLMQ_QUEUE_NAME → distinct queue (BullMQ isolates by queue name on the
 *    SHARED Redis).
 *  - BETTER_AUTH_COOKIE_PREFIX → per-instance cookie prefix (the safety value).
 *  - CINATRA_REDIS_PREFIX → forward-compat (NOT yet honoured by the app).
 *  - REDIS_URL / NANGO_* / GRAPHITI_URL → INHERITED from the donor (shared infra
 *    is the whole point of co-use; Nango isolation, if wanted, is operator-
 *    supplied; Graphiti sharing is gated by assertCoUsePrereqs).
 *  - BETTER_AUTH_SECRET / CINATRA_ENCRYPTION_KEY → INHERITED from the donor
 *    (clone-parity: the co-use DB is TEMPLATE'd from the donor's seed, so it must
 *    decrypt with the same keys; a session scrub removes stale auth rows).
 *
 * @param {object} a
 * @param {object} a.sourceEnv      parsed donor .env.local (KEY→value)
 * @param {string} a.slug
 * @param {number} a.appPort
 * @param {string} a.dbUrl          the connStringForDatabase(adminUrl, dbName) result
 * @param {function} [a.connStringForDatabase]  injected (executor passes the real one)
 * @returns {Record<string,string>}
 */
export function buildCoUseEnv({ sourceEnv = {}, slug, appPort, dbUrl }) {
  if (!isValidSlug(slug)) {
    throw new Error(`buildCoUseEnv requires a valid slug (got ${JSON.stringify(slug)}).`);
  }
  if (!Number.isInteger(appPort) || appPort <= 0 || appPort > 65535) {
    throw new Error(`buildCoUseEnv requires a valid appPort (got ${JSON.stringify(appPort)}).`);
  }
  if (typeof dbUrl !== "string" || dbUrl.length === 0) {
    throw new Error("buildCoUseEnv requires a non-empty dbUrl (the separate co-use database URL).");
  }
  const baseUrl = `http://localhost:${appPort}`;
  const out = {
    // Separate DB (the strong isolation boundary), schema stays the app default.
    SUPABASE_DB_URL: dbUrl,
    SUPABASE_SCHEMA: "cinatra",
    // App-port + auth base URLs.
    PORT: String(appPort),
    BETTER_AUTH_URL: baseUrl,
    NEXT_PUBLIC_BETTER_AUTH_URL: baseUrl,
    // BullMQ queue namespace (real isolation on the shared Redis).
    BULLMQ_QUEUE_NAME: coUseQueueName(slug),
    // The safety value (effective once the app honours it — gated by the probe).
    [COUSE_COOKIE_PREFIX_ENV]: coUseCookiePrefix(slug),
    // Forward-compat (NOT yet honoured — documented, never claimed as isolation).
    [COUSE_REDIS_PREFIX_ENV]: coUseRedisPrefix(slug),
  };

  // Inherit the SHARED-infra endpoints from the donor (co-use shares them).
  for (const k of ["REDIS_URL", "NANGO_SERVER_URL", "NANGO_DATABASE_URL", "NANGO_DB_URL", "GRAPHITI_URL"]) {
    if (typeof sourceEnv[k] === "string" && sourceEnv[k].length > 0) out[k] = sourceEnv[k];
  }
  // Inherit the crypto secrets (clone-parity — the TEMPLATE'd DB must decrypt
  // with the same keys; sessions are scrubbed regardless).
  for (const k of ["BETTER_AUTH_SECRET", "CINATRA_ENCRYPTION_KEY"]) {
    if (typeof sourceEnv[k] === "string" && sourceEnv[k].length > 0) out[k] = sourceEnv[k];
  }
  return out;
}

/**
 * Ordered teardown plan for a FAILED co-use provisioning. Returns the steps the
 * executor runs (in order) on rollback. Pure — the executor performs the I/O.
 * The DROP step is intentionally LAST-resort and only included when the DB was
 * created THIS run (so a pre-existing instance DB is never dropped).
 *
 * @param {object} a
 * @param {boolean} a.createdDb       did THIS run create the database?
 * @param {string}  a.dbName
 * @param {string|null} [a.runtimeDir]
 * @returns {Array<{step:string, [k:string]:any}>}
 */
export function coUseRollbackPlan({ createdDb, dbName, runtimeDir = null }) {
  const plan = [];
  if (createdDb) {
    if (!isCoUseDbNameShape(dbName)) {
      // Defence-in-depth: a malformed name must NEVER produce a DROP step.
      throw new Error(
        `coUseRollbackPlan refuses to plan a DROP of a non-co-use-shaped database name ${JSON.stringify(dbName)}.`,
      );
    }
    plan.push({ step: "dropDatabase", dbName, createdThisRun: true });
  }
  if (runtimeDir) plan.push({ step: "removeRuntimeDir", runtimeDir });
  plan.push({ step: "releaseInstanceSlot" });
  return plan;
}

export const __test = {
  COUSE_DB_NAME_RE,
};
