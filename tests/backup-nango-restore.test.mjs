// cinatra-cli#68 — `cinatra instance backup import` must restore the Nango DB.
//
// The app-DB restore half pre-cleans its schemas (DROP SCHEMA ... CASCADE) before
// replaying the `pg_dump --clean --if-exists` dump. The Nango half historically
// did NOT — it replayed the `--clean` dump directly over the LIVE Nango DB. Nango
// uses declarative range partitioning (`nango_records.records_seen` with per-day
// children like `records_seen_20260628`), and `pg_dump --clean` emits, per child:
//
//   ALTER TABLE IF EXISTS ONLY nango_records.records_seen_20260628
//     DROP CONSTRAINT IF EXISTS records_seen_20260628_pkey;
//
// Postgres refuses ("cannot drop inherited constraint" — the pkey is inherited
// from the parent partitioned table), so `psql -v ON_ERROR_STOP=1` exits non-zero
// and the import aborts AFTER the cinatra DB was already mutated.
//
// The fix: derive the Nango schemas FROM THE DUMP itself (the restore contract,
// not a live query) and `preCleanSchemas` them before the Nango restore, mirroring
// the app side. This file proves it two ways:
//   1. Hermetic unit tests for `extractSchemasFromDump` (the dump-parsing seam).
//   2. A DOCKER-GATED real round-trip: real `pg_dump` of a real partitioned Nango
//      DB into a bundle, then real `importBackupBundle` back into the LIVE DB,
//      asserting it does NOT throw and the data survives. Auto-SKIPS without
//      Docker so it never flakes the hermetic suite.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  extractSchemasFromDump,
  createBackupBundle,
  importBackupBundle,
} from "../src/index.mjs";

// --------------------------------------------------------------------------
// Unit: extractSchemasFromDump — the dump-parsing seam (hermetic, no DB).
// --------------------------------------------------------------------------

describe("cinatra-cli#68 — extractSchemasFromDump (dump-derived pre-clean set)", () => {
  function writeDump(body) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli68-dump-"));
    const file = path.join(dir, "nango.sql");
    writeFileSync(file, body);
    return file;
  }

  it("always includes `public` even when the dump emits no CREATE SCHEMA public", () => {
    // Real pg_dump output for a full DB: `public` pre-exists so it is NOT emitted,
    // yet it may hold tables (Nango keeps knex_migrations there) → must be cleaned.
    const file = writeDump(
      "DROP SCHEMA IF EXISTS nango;\nCREATE SCHEMA nango;\nCREATE TABLE public.knex_migrations (id int);\n",
    );
    expect(extractSchemasFromDump(file).sort()).toEqual(["nango", "public"]);
  });

  it("parses the real unquoted form `CREATE SCHEMA nango;`", () => {
    const file = writeDump(
      "CREATE SCHEMA nango;\nCREATE SCHEMA nango_records;\nCREATE SCHEMA nango_runners;\n",
    );
    expect(extractSchemasFromDump(file).sort()).toEqual([
      "nango",
      "nango_records",
      "nango_runners",
      "public",
    ]);
  });

  it("parses the quoted form with doubled-quote escaping", () => {
    // pg_dump quotes identifiers that need it and escapes a literal `"` as `""`.
    const file = writeDump('CREATE SCHEMA "weird""schema";\nCREATE SCHEMA "Mixed Case";\n');
    expect(extractSchemasFromDump(file).sort()).toEqual([
      'Mixed Case',
      'public',
      'weird"schema',
    ]);
  });

  it("honours `CREATE SCHEMA IF NOT EXISTS <name>`", () => {
    const file = writeDump("CREATE SCHEMA IF NOT EXISTS nango_records;\n");
    expect(extractSchemasFromDump(file).sort()).toEqual(["nango_records", "public"]);
  });

  it("excludes Postgres system schemas defensively", () => {
    const file = writeDump(
      "CREATE SCHEMA pg_catalog;\nCREATE SCHEMA information_schema;\nCREATE SCHEMA pg_toast;\nCREATE SCHEMA nango;\n",
    );
    expect(extractSchemasFromDump(file).sort()).toEqual(["nango", "public"]);
  });

  it("does NOT match incidental `CREATE SCHEMA` substrings in comments / data", () => {
    // A comment or a string column value must not be mistaken for a schema decl.
    const file = writeDump(
      "-- this CREATE SCHEMA mention is a comment\nINSERT INTO t VALUES ('CREATE SCHEMA fake;');\nCREATE SCHEMA nango;\n",
    );
    expect(extractSchemasFromDump(file).sort()).toEqual(["nango", "public"]);
  });

  it("dedupes repeated CREATE SCHEMA of the same name", () => {
    const file = writeDump("CREATE SCHEMA nango;\nCREATE SCHEMA nango;\n");
    expect(extractSchemasFromDump(file)).toEqual(["public", "nango"]);
  });
});

// --------------------------------------------------------------------------
// Integration (OPT-IN + DOCKER-GATED): real create→import round-trip against a
// live Nango DB whose schema has a partitioned table with >= 1 partition child.
//
// This block spins up TWO real postgres containers (`docker run -d`), unlike the
// suite's only other docker test which merely runs `docker compose config` (no
// container, no image pull). To keep the default `npm test` / CI run lean and
// flake-free (image pulls, fixed ports/names, daemon races), it is OPT-IN: set
// `CINATRA_CLI_DOCKER_IT=1` (or `RUN_DOCKER_IT=1`) AND have Docker available. The
// hermetic `extractSchemasFromDump` unit tests above always run. The live run was
// exercised for real during development (see the PR for the recorded round-trip).
// --------------------------------------------------------------------------

function dockerAvailable() {
  return spawnSync("docker", ["version"], { encoding: "utf8" }).status === 0;
}

const RUN_DOCKER_IT =
  process.env.CINATRA_CLI_DOCKER_IT === "1" || process.env.RUN_DOCKER_IT === "1";
const HAVE_DOCKER = RUN_DOCKER_IT && dockerAvailable();

const APP_PORT = 55534;
const NANGO_PORT = 55535;
const APP_CONTAINER = "cli68-it-app";
const NANGO_CONTAINER = "cli68-it-nango";
const APP_URL = `postgresql://postgres:postgres@127.0.0.1:${APP_PORT}/postgres`;
const NANGO_URL = `postgresql://nango:nango@127.0.0.1:${NANGO_PORT}/nango`;

// Match the CLI's default postgres-client image MAJOR so a dump produced by the
// client tools restores cleanly (a 17-client dump carries GUCs a 16 server would
// reject — that is a rig version skew, not the bug under test).
const PG_IMAGE = "postgres:17-alpine";

function dockerRun(name, port, user, pass, db) {
  spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
  const r = spawnSync(
    "docker",
    [
      "run", "-d", "--name", name,
      "-e", `POSTGRES_PASSWORD=${pass}`,
      "-e", `POSTGRES_USER=${user}`,
      "-e", `POSTGRES_DB=${db}`,
      "-p", `${port}:5432`,
      PG_IMAGE,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`docker run ${name} failed: ${r.stderr}`);
}

function waitReady(name, user) {
  for (let i = 0; i < 60; i += 1) {
    if (spawnSync("docker", ["exec", name, "pg_isready", "-U", user], { encoding: "utf8" }).status === 0) {
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`${name} did not become ready`);
}

function execSql(name, user, db, sql) {
  const r = spawnSync(
    "docker",
    ["exec", "-i", name, "psql", "-U", user, "-d", db, "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql on ${name} failed: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

function scalar(name, user, db, query) {
  const r = spawnSync(
    "docker",
    ["exec", "-i", name, "psql", "-U", user, "-d", db, "-tAc", query],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`psql scalar on ${name} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const NANGO_SEED = `
CREATE SCHEMA IF NOT EXISTS nango;
CREATE SCHEMA IF NOT EXISTS nango_records;
CREATE SCHEMA IF NOT EXISTS nango_runners;

CREATE TABLE nango._nango_environments (
  id serial PRIMARY KEY, name text, secret_key text, deleted boolean DEFAULT false, account_id int DEFAULT 1
);
INSERT INTO nango._nango_environments(name, secret_key) VALUES ('dev','sk-1'),('prod','sk-2');

-- Range-partitioned table with per-day children + INHERITED pkey (the bug surface).
CREATE TABLE nango_records.records_seen (
  id bigserial, seen_at date NOT NULL, payload text, PRIMARY KEY (id, seen_at)
) PARTITION BY RANGE (seen_at);
CREATE TABLE nango_records.records_seen_20260628 PARTITION OF nango_records.records_seen
  FOR VALUES FROM ('2026-06-28') TO ('2026-06-29');
CREATE TABLE nango_records.records_seen_20260629 PARTITION OF nango_records.records_seen
  FOR VALUES FROM ('2026-06-29') TO ('2026-06-30');
INSERT INTO nango_records.records_seen(seen_at, payload) VALUES ('2026-06-28','a'),('2026-06-29','b');

CREATE TABLE nango_runners.runner_state (id serial PRIMARY KEY, state text);
INSERT INTO nango_runners.runner_state(state) VALUES ('idle');

-- A public-schema table (Nango keeps migration bookkeeping in public).
CREATE TABLE public.knex_migrations (id serial PRIMARY KEY, name text);
INSERT INTO public.knex_migrations(name) VALUES ('001_init');
`;

const APP_SEED = `
CREATE SCHEMA IF NOT EXISTS cinatra;
CREATE TABLE cinatra.widgets (id serial PRIMARY KEY, name text);
INSERT INTO cinatra.widgets(name) VALUES ('alpha'),('beta');
CREATE TABLE public.app_meta (id serial PRIMARY KEY, k text);
INSERT INTO public.app_meta(k) VALUES ('v1');
`;

describe.skipIf(!HAVE_DOCKER)(
  "cinatra-cli#68 — real backup create→import round-trip restores the partitioned Nango DB",
  () => {
    let repoRoot;
    let bundlePath;
    const env = { NANGO_DATABASE_URL: NANGO_URL, SUPABASE_SCHEMA: "cinatra" };

    beforeAll(() => {
      dockerRun(APP_CONTAINER, APP_PORT, "postgres", "postgres", "postgres");
      dockerRun(NANGO_CONTAINER, NANGO_PORT, "nango", "nango", "nango");
      waitReady(APP_CONTAINER, "postgres");
      waitReady(NANGO_CONTAINER, "nango");
      execSql(APP_CONTAINER, "postgres", "postgres", APP_SEED);
      execSql(NANGO_CONTAINER, "nango", "nango", NANGO_SEED);

      repoRoot = mkdtempSync(path.join(os.tmpdir(), "cli68-repo-"));
      const bundleDir = mkdtempSync(path.join(os.tmpdir(), "cli68-bundle-"));
      mkdirSync(bundleDir, { recursive: true });
      bundlePath = path.join(bundleDir, "cinatra-backup.tar.gz");
    }, 180_000);

    afterAll(() => {
      spawnSync("docker", ["rm", "-f", APP_CONTAINER]);
      spawnSync("docker", ["rm", "-f", NANGO_CONTAINER]);
      if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
      if (bundlePath) rmSync(path.dirname(bundlePath), { recursive: true, force: true });
    });

    it("creates a bundle that includes the Nango dump with partition children", () => {
      createBackupBundle(repoRoot, env, APP_URL, bundlePath);
      const listing = spawnSync("tar", ["-tzf", bundlePath], { encoding: "utf8" }).stdout;
      expect(listing).toContain("postgres/cinatra.sql");
      expect(listing).toContain("postgres/nango.sql");
    }, 120_000);

    it("imports the bundle back into the LIVE Nango DB without throwing (cannot-drop-inherited-constraint is gone)", () => {
      // Pre-fix this threw "Backup import failed" from psql exit on the inherited
      // partition-child pkey DROP. The Nango pre-clean makes the dump's `--clean`
      // statements no-ops, so the restore is clean and idempotent over a live DB.
      expect(() => importBackupBundle(repoRoot, env, APP_URL, bundlePath)).not.toThrow();
    }, 120_000);

    it("preserves the Nango data across the round-trip (incl. the partitioned table + public schema)", () => {
      expect(scalar(NANGO_CONTAINER, "nango", "nango", "SELECT count(*) FROM nango_records.records_seen")).toBe("2");
      expect(scalar(NANGO_CONTAINER, "nango", "nango", "SELECT count(*) FROM nango._nango_environments")).toBe("2");
      expect(scalar(NANGO_CONTAINER, "nango", "nango", "SELECT count(*) FROM nango_runners.runner_state")).toBe("1");
      expect(scalar(NANGO_CONTAINER, "nango", "nango", "SELECT count(*) FROM public.knex_migrations")).toBe("1");
    }, 60_000);

    it("preserves the cinatra app data across the round-trip", () => {
      expect(scalar(APP_CONTAINER, "postgres", "postgres", "SELECT count(*) FROM cinatra.widgets")).toBe("2");
      expect(scalar(APP_CONTAINER, "postgres", "postgres", "SELECT count(*) FROM public.app_meta")).toBe("1");
    }, 60_000);

    it("is idempotent — a second import over the just-restored live DB also succeeds", () => {
      // This is exactly the scenario that surfaced the bug: restoring a `--clean`
      // dump over a DB that already has the partitioned objects.
      expect(() => importBackupBundle(repoRoot, env, APP_URL, bundlePath)).not.toThrow();
      expect(scalar(NANGO_CONTAINER, "nango", "nango", "SELECT count(*) FROM nango_records.records_seen")).toBe("2");
    }, 120_000);
  },
);
