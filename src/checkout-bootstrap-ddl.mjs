// Checkout schema-bootstrap DDL application (cinatra#1136).
//
// WHY THIS EXISTS
// ---------------
// `cinatra instance refresh` / `instance setup` run the versioned core
// migration chain (migrations/core/, resolved FROM THE CHECKOUT via
// `loadMigrations`) right after the CLI's own bundled `ensureStoreSchema`
// baseline. The chain EXECUTES on existing schemas (the upgrade path), and its
// migrations may reference tables/columns that only the CHECKOUT's schema
// bootstrap creates — the boot path runs `ensurePostgresSchema()`
// (src/lib/core-migrations.ts in the checkout: "Bootstrap DDL first … the
// baseline the versioned chain assumes") BEFORE the chain, which is why a
// plain `pnpm dev` boot self-heals a database the refresh just failed on.
// The CLI's bundled DDL is necessarily a snapshot: net-new tables (e.g. the
// connection-identity table the identity-backfill migration LOCKs) ship in
// the checkout's `buildCreateStoreSchemaQueries` (src/lib/drizzle-store.ts),
// not in the published CLI. So setup/refresh must apply the CHECKOUT's own
// bootstrap DDL between the bundled baseline and the migration chain — the
// exact order the boot path uses.
//
// HOW
// ---
// The DDL builder is TypeScript inside the checkout, so it cannot be imported
// by this plain-Node CLI directly. We spawn a REAL on-disk entry module
// (checkout-bootstrap-ddl-entry.mjs, shipped with the CLI) via the CHECKOUT's
// own `tsx` loader, cwd-anchored at the checkout root:
//
//   node --import tsx <cli>/src/checkout-bootstrap-ddl-entry.mjs
//
// A real entry file (not `--eval`) is required: the inline-eval form cannot
// resolve a NAMED export from a tsx-transformed .ts module on Node 22 (the
// importer is a virtual eval module) — the same reason the checkout's own
// upgrade-proof harness uses an on-disk entry for this exact DDL pass.
//
// POLICY
// ------
//   - drizzle-store.ts absent (a baked standalone runtime image ships no TS
//     source) BUT the image bakes its self-contained schema-bootstrap bundle
//     (scripts/schema-bootstrap.bundle.mjs, built by the image from the SAME
//     buildCreateStoreSchemaQueries) → run the BUNDLE. "Boot applies it" is
//     NOT sufficient on the prod deploy path: the deploy runs `setup prod`
//     (the versioned chain) BEFORE the new image ever boots, so an EXISTING
//     database at the previous release's ledger hits chain migrations that
//     reference tables only the new bootstrap creates (observed on a release
//     deploy: `LOCK TABLE nango_connection` → relation does not exist).
//   - drizzle-store.ts absent AND no baked bundle (images predating it) →
//     skip QUIETLY: boot remains the bootstrap authority there.
//   - `tsx` unresolvable from the checkout WITH the source present:
//       - `required: true` (dev setup/refresh — the checkout must be able to
//         run its own DDL; tsx is a devDependency of every dev checkout) →
//         THROW with the install remediation, BEFORE the migration chain can
//         abort mid-flight with a far more confusing error (codex review).
//       - `required: false` (prod checkout installed without devDependencies)
//         → skip with a WARNING; prod boot applies the same DDL first anyway.
//   - the spawned DDL run FAILS → THROW. Continuing would hand the migration
//     chain a half-bootstrapped schema.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_BASENAME = "checkout-bootstrap-ddl-entry.mjs";

/** `<repoRoot>/src/lib/drizzle-store.ts`, or null when the checkout does not
 *  carry the TS source (baked standalone runtime image). */
export function resolveCheckoutDdlSource(repoRoot, { exists = existsSync } = {}) {
  const source = path.join(repoRoot, "src", "lib", "drizzle-store.ts");
  return exists(source) ? source : null;
}

/** `<repoRoot>/scripts/schema-bootstrap.bundle.mjs` — the self-contained
 *  schema-bootstrap DDL runner a baked runtime image builds from its own
 *  buildCreateStoreSchemaQueries (the checkout's Dockerfile bakes it; the
 *  deploy-compat bin applies it too, so a double-apply stays idempotent) —
 *  or null when the image/checkout predates the bundle. */
export function resolveBakedBootstrapBundle(repoRoot, { exists = existsSync } = {}) {
  const bundle = path.join(repoRoot, "scripts", "schema-bootstrap.bundle.mjs");
  return exists(bundle) ? bundle : null;
}

/** True when the checkout's own dependency tree resolves `tsx` (the loader the
 *  spawned entry runs under). Resolution is anchored at the CHECKOUT, never at
 *  this CLI's install location — the checkout's tsx transforms the checkout's
 *  TS the same way its own scripts do. */
export function checkoutResolvesTsx(repoRoot, { resolve } = {}) {
  try {
    const req = createRequire(path.join(repoRoot, "package.json"));
    (resolve ?? ((spec) => req.resolve(spec)))("tsx");
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the checkout's schema-bootstrap DDL (buildCreateStoreSchemaQueries)
 * to the target database — via a spawned `node --import tsx` subprocess for a
 * checkout carrying the TS source, or via the image's baked self-contained
 * bundle for a standalone runtime image. Returns:
 *   { status: "applied" }                 (checkout TS source via tsx)
 *   { status: "applied", via: "baked-bundle" }
 *   { status: "skipped", reason: "no-ddl-source" | "no-tsx" }
 * Throws when the spawned DDL run itself fails.
 */
export function applyCheckoutBootstrapDdl({
  repoRoot,
  connectionString,
  schemaName,
  required = false,
  log = console.log,
  warn = console.warn,
  deps = {},
}) {
  const run =
    deps.run ??
    ((cmd, args, options) => {
      execFileSync(cmd, args, options);
    });
  const ddlEnv = {
    ...process.env,
    SUPABASE_DB_URL: connectionString,
    SUPABASE_SCHEMA: schemaName,
  };
  const rethrow = (err) => {
    throw new Error(
      `Checkout bootstrap DDL failed — the versioned core migration chain assumes this baseline, so setup ` +
        `stops here instead of aborting mid-chain. Underlying error: ${err && err.message ? err.message : err}`,
    );
  };

  const source = resolveCheckoutDdlSource(repoRoot, deps);
  if (!source) {
    // Baked standalone runtime image: no TS source. Prefer the image's own
    // self-contained schema-bootstrap bundle — on the prod deploy path the
    // versioned chain runs BEFORE the new image ever boots, so "boot applies
    // it" is not a baseline here (see the POLICY header).
    const bundle = resolveBakedBootstrapBundle(repoRoot, deps);
    if (bundle) {
      try {
        run(process.execPath, [bundle], {
          cwd: repoRoot,
          stdio: ["ignore", "inherit", "inherit"],
          env: ddlEnv,
        });
      } catch (err) {
        rethrow(err);
      }
      return { status: "applied", via: "baked-bundle" };
    }
    // Normal state for a baked runtime image predating the bundle — not a warning.
    log("  Checkout bootstrap DDL: skipped (no src/lib/drizzle-store.ts in this checkout — boot applies it).");
    return { status: "skipped", reason: "no-ddl-source" };
  }
  if (!checkoutResolvesTsx(repoRoot, deps)) {
    const remediation =
      "the checkout does not resolve `tsx`. Install dependencies (corepack pnpm install) so setup can " +
      "apply the checkout's schema bootstrap before the versioned migration chain.";
    if (required) {
      throw new Error(`Checkout bootstrap DDL cannot run — ${remediation}`);
    }
    warn(`⚠ Checkout bootstrap DDL: skipped — ${remediation}`);
    return { status: "skipped", reason: "no-tsx" };
  }

  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), ENTRY_BASENAME);
  try {
    run(process.execPath, ["--import", "tsx", entry], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...ddlEnv,
        CINATRA_CHECKOUT_DDL_SOURCE: source,
      },
    });
  } catch (err) {
    rethrow(err);
  }
  return { status: "applied" };
}
