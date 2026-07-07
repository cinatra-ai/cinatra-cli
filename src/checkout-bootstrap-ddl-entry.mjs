// Spawned entry for the checkout schema-bootstrap DDL pass (cinatra#1136).
// See checkout-bootstrap-ddl.mjs for the WHY + policy. Runs under
// `node --import tsx` with cwd at the CHECKOUT root, so the dynamic import of
// the checkout's TypeScript DDL builder is transformed by the checkout's own
// tsx. A REAL on-disk module (not --eval) is required for the named export to
// resolve on Node 22.
//
// Env:
//   CINATRA_CHECKOUT_DDL_SOURCE  (required) absolute path to the checkout's
//                                src/lib/drizzle-store.ts
//   SUPABASE_DB_URL              (required) target database
//   SUPABASE_SCHEMA              app schema (default cinatra)
//
// Exit: 0 = every statement applied; 1 = a statement failed; 2 = misconfig.

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const source = process.env.CINATRA_CHECKOUT_DDL_SOURCE;
const connectionString = process.env.SUPABASE_DB_URL;
const schemaName = process.env.SUPABASE_SCHEMA || "cinatra";

if (!source || !connectionString) {
  console.error(
    "checkout-bootstrap-ddl-entry: CINATRA_CHECKOUT_DDL_SOURCE and SUPABASE_DB_URL are required.",
  );
  process.exit(2);
}

let buildCreateStoreSchemaQueries;
try {
  ({ buildCreateStoreSchemaQueries } = await import(pathToFileURL(source).href));
} catch (e) {
  console.error(`checkout-bootstrap-ddl-entry: cannot import ${source}: ${e?.message ?? e}`);
  process.exit(2);
}
if (typeof buildCreateStoreSchemaQueries !== "function") {
  console.error(
    "checkout-bootstrap-ddl-entry: buildCreateStoreSchemaQueries export not found in the checkout DDL source.",
  );
  process.exit(2);
}

// `pg` resolves from THIS module's location — the CLI package's own
// dependency (never the checkout's), so the entry works regardless of the
// checkout's hoisting layout.
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const client = new Client({ connectionString });
await client.connect();
let applied = 0;
let queries = [];
try {
  // Same database-global advisory lock the boot-side bootstrap takes
  // (session-scoped; released when this short-lived session ends), so a
  // concurrently booting dev server and this pass serialize instead of racing
  // on shared catalog objects.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", ["cinatra-schema-init"]);
  queries = buildCreateStoreSchemaQueries(schemaName);
  for (const q of queries) {
    try {
      await client.query(q.text, q.values);
      applied++;
    } catch (e) {
      console.error(
        `checkout-bootstrap-ddl-entry: statement ${applied + 1}/${queries.length} failed: ` +
          `${String(q.text).slice(0, 160)}\n  ${e?.message ?? e}`,
      );
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
if (process.exitCode !== 1) {
  console.log(`  Checkout bootstrap DDL: applied ${applied}/${queries.length} statements (${schemaName}).`);
}
