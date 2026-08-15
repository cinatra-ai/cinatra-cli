// ---------------------------------------------------------------------------
// Auto-declare the reserved dev-main tunnel identity for a CANONICAL install.
//
// THE REGRESSION THIS CLOSES
// The tunnel-identity classifier is fail-closed: it never falls through to the
// reserved main hostname. That is correct for a MULTI-instance host, where the
// retired fallthrough let any unregistered checkout squat the reserved node.
// It left one population stranded, though: the plain single-instance dev
// install. Such an install runs the default database on the default schema and
// declares nothing, so it classifies `unregistered` — no auto-derived Funnel
// URL, and remediation copy ("run as a clone or a worktree") that does not
// describe a canonical install at all.
//
// The installer already knows the one value that resolves it: this instance's
// own database ENDPOINT. Declaring it restores the previous auto-derivation
// WITHOUT reopening the squat, because the declaration is endpoint-scoped — a
// configuration copied to another host or another Postgres no longer matches,
// so it cannot claim the reserved identity there.
//
// WHAT THIS MODULE IS
// The pure DECISION half, so every branch is unit-testable with no filesystem,
// no database and no extensions tree. The caller supplies the already-parsed
// endpoint fingerprint (the connector's `parseDatabaseEndpoint` is the single
// source of truth for that shape; nothing is re-implemented here) and applies
// the result through the existing env-file machinery.
//
// THE GATES, and why each one exists
//   1. An EXISTING declaration is never touched. Idempotence is the strongest
//      rule here: the operator (or a previous run) may have declared a value
//      deliberately, and silently rewriting it would move the reserved identity
//      under a running tunnel.
//   2. Development runtime mode only. A production main keeps the
//      operator-supplied public URL model; it has no dev tunnel identity.
//   3. The endpoint must resolve. An unfingerprintable connection string fails
//      the classifier closed by design, and a declaration it cannot match would
//      be dead weight in the env file.
//   4. A registered clone (a `cinatra_clone_<slug>` database) is skipped. It
//      already HAS a sanctioned identity, and a main declaration alongside it
//      is an outright classifier conflict.
//   5. A schema-isolated worktree (a non-default `SUPABASE_SCHEMA`) is skipped,
//      for the same two reasons.
//
// Gates 4 and 5 are what keep the fail-closed multi-instance protection
// intact: the only install that auto-declares is the one that matches NEITHER
// isolation model, which is precisely the canonical single-instance main.
// ---------------------------------------------------------------------------

/** The env var carrying the explicit reserved-main declaration. */
export const DEV_MAIN_DECLARATION_VAR = "CINATRA_DEV_MAIN_DATABASE";

/** Database-name prefix a registered clone runs on. */
export const CLONE_DATABASE_PREFIX = "cinatra_clone_";

/** The plain default schema a canonical main install reads through. */
export const DEFAULT_DEV_SCHEMA = "cinatra";

/**
 * @typedef {{
 *   declare: boolean,
 *   key: string,
 *   value: string | null,
 *   code: "canonical-main" | "already-declared" | "not-development"
 *       | "endpoint-unresolved" | "registered-clone" | "schema-isolated",
 *   reason: string,
 * }} DevMainDeclarationPlan
 */

/**
 * Decide whether this install should auto-declare the reserved main identity.
 *
 * PURE and total — it never throws, never reads the filesystem, and never
 * mutates its input.
 *
 * @param {object} [args]
 * @param {string | null | undefined} [args.runtimeMode]  the configured runtime
 *   mode ("development" / "production").
 * @param {string | null | undefined} [args.endpoint]  this instance's own
 *   `host:port/database` fingerprint, as produced by the connector's
 *   `parseDatabaseEndpoint`. Empty when the URL could not be fingerprinted.
 * @param {string | null | undefined} [args.schema]  the configured
 *   `SUPABASE_SCHEMA`; empty/absent means the plain default.
 * @param {string | null | undefined} [args.existingDeclaration]  whatever the
 *   env already carries for {@link DEV_MAIN_DECLARATION_VAR}.
 * @returns {DevMainDeclarationPlan}
 */
export function planDevMainDeclaration({
  runtimeMode,
  endpoint,
  schema,
  existingDeclaration,
} = {}) {
  // GATE 1 — never clobber an existing declaration, whatever it says. A value
  // that does NOT match this endpoint is still the operator's, and the
  // classifier already reports that mismatch in its own refusal text.
  if (String(existingDeclaration ?? "").trim() !== "") {
    return skip(
      "already-declared",
      `${DEV_MAIN_DECLARATION_VAR} is already set — leaving it exactly as it is.`,
    );
  }

  // GATE 2 — development only.
  if (String(runtimeMode ?? "").trim() !== "development") {
    return skip(
      "not-development",
      "The dev tunnel identity applies to a development instance only.",
    );
  }

  // GATE 3 — the endpoint must fingerprint.
  const fingerprint = String(endpoint ?? "").trim();
  if (!fingerprint) {
    return skip(
      "endpoint-unresolved",
      "This instance's database URL does not resolve to an unambiguous " +
        "endpoint, so there is no value to declare.",
    );
  }

  // The database name is the fingerprint's last segment by construction
  // (`host:port/database`), so no second parser is needed — and a bracketed
  // IPv6 host cannot disturb it.
  const database = fingerprint.slice(fingerprint.lastIndexOf("/") + 1);

  // GATE 4 — a registered clone owns its own identity already.
  if (database.startsWith(CLONE_DATABASE_PREFIX)) {
    return skip(
      "registered-clone",
      `This instance runs on the clone database "${database}", which already ` +
        "carries its own sanctioned tunnel identity.",
    );
  }

  // GATE 5 — a schema-isolated worktree likewise.
  const schemaName = String(schema ?? "").trim();
  if (schemaName !== "" && schemaName !== DEFAULT_DEV_SCHEMA) {
    return skip(
      "schema-isolated",
      `This instance is schema-isolated (schema "${schemaName}"), which ` +
        "already carries its own sanctioned tunnel identity.",
    );
  }

  return {
    declare: true,
    key: DEV_MAIN_DECLARATION_VAR,
    value: fingerprint,
    code: "canonical-main",
    reason:
      "This is a canonical single-instance main install (default database, " +
      "default schema, no other identity), so it declares its own endpoint " +
      "as the reserved main identity.",
  };
}

/**
 * @param {DevMainDeclarationPlan["code"]} code
 * @param {string} reason
 * @returns {DevMainDeclarationPlan}
 */
function skip(code, reason) {
  return { declare: false, key: DEV_MAIN_DECLARATION_VAR, value: null, code, reason };
}
