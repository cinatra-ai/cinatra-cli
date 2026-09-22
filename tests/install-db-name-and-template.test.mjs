// An operator-chosen database NAME and TEMPLATE for a shared-Postgres install.
//
// Several isolated instances on one machine share ONE PostgreSQL server and get
// one database each, created in an instant from a template database the
// operator prepared (migrated and seeded once). `--db-name` was parsed and
// never read, and there was no way to name the template at all — so the
// database was always `cinatra_inst_<slug>` created from the built-in seed.
//
// These tests pin the whole road: the ONE validation pattern (refused before
// any connection is opened), the EXACT SQL each path issues (identifier
// quoting included), what happens to a database that already exists, and the
// byte-for-byte unchanged default. No live Postgres: the pg client is injected
// into `defaultCoUseDbOps`, and the executor's own DB ops are injected through
// `runInstall`'s `deps` seam exactly as the existing co-use tests do.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defaultCoUseDbOps, parseInstallArgs, runInstall } from "../src/install.mjs";
import {
  OPERATOR_DB_NAME_RE,
  RESERVED_DB_NAMES,
  assertOperatorDbName,
  assertOperatorQueueName,
  assertOperatorTemplateName,
  buildCoUseEnv,
  coUseRollbackPlan,
  isOperatorDbName,
  isOperatorTemplateName,
} from "../src/install-couse.mjs";
import { isProtectedDbName } from "../src/clone-registry.mjs";
import { readInstanceRegistry } from "../src/instance-registry.mjs";

// ---------------------------------------------------------------------------
// 1. The ONE validation pattern (pure).
// ---------------------------------------------------------------------------
describe("operator-chosen database names — the one validation pattern", () => {
  it("ACCEPTS a PostgreSQL identifier that needs no quoting to survive folding", () => {
    for (const name of [
      "c",
      "a1",
      "team_instance_7",
      "my_own_database",
      "x".repeat(63), // exactly the 63-byte ceiling
    ]) {
      expect(assertOperatorDbName("--db-name", name), name).toBe(name);
      expect(isOperatorDbName(name), name).toBe(true);
    }
  });

  it("REFUSES anything else — case, leading character, length, and SQL metacharacters", () => {
    for (const name of [
      "",
      "1abc", // must start with a letter
      "_abc", // ditto
      "Cinatra", // upper case folds — a quoted identifier would not match it
      "team-instance", // a dash is not an unquoted identifier character
      "team instance",
      "team.instance",
      "-db", // flag-shaped
      'a"b', // the quote a naive interpolation would break out of
      "x; DROP DATABASE postgres",
      "x".repeat(64), // one byte over the ceiling — Postgres would truncate it
    ]) {
      expect(() => assertOperatorDbName("--db-name", name), name).toThrow(/--db-name/);
      expect(isOperatorDbName(name), name).toBe(false);
    }
    expect(isOperatorDbName(null)).toBe(false);
    expect(isOperatorDbName(undefined)).toBe(false);
  });

  it("REFUSES every reserved name — the SAME set the destructive clone guard protects", () => {
    // One constant, not two: the set a `--db-name` may not claim is exactly the
    // set `isProtectedDbName` refuses to drop. A second copy could drift apart
    // from it, and the CREATE side would then hand out a name the DROP side
    // treats as sacred (or the other way round).
    for (const name of RESERVED_DB_NAMES) {
      expect(isProtectedDbName(name), name).toBe(true);
      expect(() => assertOperatorDbName("--db-name", name), name).toThrow(/reserved/);
      expect(isOperatorDbName(name), name).toBe(false);
    }
    expect(RESERVED_DB_NAMES).toContain("postgres");
    expect(RESERVED_DB_NAMES).toContain("cinatra");
    expect(RESERVED_DB_NAMES).toContain("cinatra_seed");
    expect(RESERVED_DB_NAMES).toContain("template0");
    expect(RESERVED_DB_NAMES).toContain("template1");
  });

  it("REFUSES the CLI's OWN database namespaces — it creates and drops those itself", () => {
    // `cinatra_seed` itself is caught one rule earlier, by the reserved set.
    expect(() => assertOperatorDbName("--db-name", "cinatra_seed")).toThrow(/reserved/);
    expect(isOperatorDbName("cinatra_seed")).toBe(false);
    for (const name of [
      "cinatra_seed_backup", // anything starting with the seed name
      "cinatra_clone_alpha", // `clone prune` derives and force-drops this exact name
      "cinatra_inst_alpha", // another instance's derived database
      "cinatra_inst_", // the bare namespace
    ]) {
      expect(() => assertOperatorDbName("--db-name", name), name).toThrow(/the CLI creates and drops/);
      expect(isOperatorDbName(name), name).toBe(false);
    }
  });

  it("a TEMPLATE is only READ, so it may be a CLI-owned name — the built-in seed included", () => {
    // The target guard cannot govern the source: `cinatra_seed` is the default
    // template, so a guard that refused it would refuse the default road.
    expect(assertOperatorTemplateName("--db-template", "cinatra_seed")).toBe("cinatra_seed");
    expect(isOperatorTemplateName("cinatra_seed")).toBe(true);
    expect(isOperatorTemplateName("team_seed_template")).toBe(true);
    // The pattern still governs it.
    expect(() => assertOperatorTemplateName("--db-template", "Bad-Name")).toThrow(/Invalid --db-template/);
    expect(isOperatorTemplateName('a"b')).toBe(false);
  });

  it("names the flag it was given, so the same pattern serves both flags", () => {
    expect(() => assertOperatorDbName("--db-template", "Bad")).toThrow(/--db-template/);
    expect(OPERATOR_DB_NAME_RE.source).toBe("^[a-z][a-z0-9_]{0,62}$");
  });
});

// ---------------------------------------------------------------------------
// 2. The rollback plan and the env builder carry the operator's choices.
// ---------------------------------------------------------------------------
describe("co-use rollback plan + env builder with operator-chosen values", () => {
  it("plans a DROP of an operator-named database it created this run", () => {
    const plan = coUseRollbackPlan({ createdDb: true, dbName: "team_instance_a", operatorNamed: true });
    expect(plan.map((s) => s.step)).toEqual(["dropDatabase", "releaseInstanceSlot"]);
    expect(plan[0]).toMatchObject({ dbName: "team_instance_a", createdThisRun: true, operatorNamed: true });
  });

  it("still REFUSES to plan a DROP of a name that passes neither guard", () => {
    expect(() => coUseRollbackPlan({ createdDb: true, dbName: "postgres", operatorNamed: true })).toThrow(
      /refuses/,
    );
    // Without an operator name the narrow co-use shape is still the only one.
    expect(() => coUseRollbackPlan({ createdDb: true, dbName: "team_instance_a" })).toThrow(
      /non-co-use-shaped/,
    );
  });

  it("buildCoUseEnv writes the operator's queue name, else the derived one", () => {
    const base = { slug: "alpha", appPort: 3300, dbUrl: "postgresql://u:p@127.0.0.1:5434/team_instance_a" };
    expect(buildCoUseEnv({ ...base }).BULLMQ_QUEUE_NAME).toBe("cinatra-inst-alpha");
    expect(buildCoUseEnv({ ...base, queueName: "team-instance-a-jobs" }).BULLMQ_QUEUE_NAME).toBe("team-instance-a-jobs");
    expect(() => buildCoUseEnv({ ...base, queueName: "bad name" })).toThrow(/--bullmq-queue/);
    expect(() => assertOperatorQueueName("--bullmq-queue", "a:b")).toThrow(/--bullmq-queue/);
    expect(assertOperatorQueueName("--bullmq-queue", "cinatra-inst-alpha")).toBe("cinatra-inst-alpha");
  });
});

// ---------------------------------------------------------------------------
// 3. The parser — every refusal lands before any side effect.
// ---------------------------------------------------------------------------
describe("parseInstallArgs — --db-name / --db-template / the once-ignored flags", () => {
  it("carries both names through and routes the install to the shared-infra road", () => {
    const opts = parseInstallArgs(["--db-name", "team_instance_a", "--db-template", "team_seed_template"]);
    expect(opts.couseSidecar.dbName).toBe("team_instance_a");
    expect(opts.couseSidecar.dbTemplate).toBe("team_seed_template");
    expect(opts.couseRequested).toBe(true);
    // The inline form the rest of this surface advertises works too.
    expect(parseInstallArgs(["--db-template=team_seed_template"]).couseSidecar.dbTemplate).toBe(
      "team_seed_template",
    );
    expect(parseInstallArgs(["--db-template=team_seed_template"]).couseRequested).toBe(true);
  });

  it("REFUSES an invalid or reserved name while parsing, before anything is opened", () => {
    expect(() => parseInstallArgs(["--db-name", "Bad-Name"])).toThrow(/Invalid --db-name/);
    expect(() => parseInstallArgs(["--db-name="])).toThrow(/--db-name/);
    expect(() => parseInstallArgs(["--db-name", "postgres"])).toThrow(/reserved/);
    expect(() => parseInstallArgs(["--db-template", "no template"])).toThrow(/Invalid --db-template/);
  });

  it("the value token is skipped by the positional scan (no 'unknown trailing arg')", () => {
    expect(parseInstallArgs(["dev", "--db-template", "team_seed_template"]).mode).toBe("dev");
  });

  it("--bullmq-queue is now READ, and a malformed queue name is refused", () => {
    expect(parseInstallArgs(["--bullmq-queue", "team-instance-a-jobs"]).couseSidecar.bullmqQueue).toBe("team-instance-a-jobs");
    expect(() => parseInstallArgs(["--bullmq-queue", "bull:queue"])).toThrow(/--bullmq-queue/);
  });

  it("REFUSES a CLI-owned or reserved name while parsing, before anything is opened", () => {
    for (const name of ["cinatra_clone_alpha", "cinatra_inst_alpha", "cinatra_seed_backup"]) {
      expect(() => parseInstallArgs(["--db-name", name]), name).toThrow(/the CLI creates and drops/);
    }
    expect(() => parseInstallArgs(["--db-name", "cinatra_seed"])).toThrow(/reserved/);
    expect(() => parseInstallArgs(["--db-name", "cinatra"])).toThrow(/reserved/);
    // The default template is still nameable — it is read, never claimed.
    expect(parseInstallArgs(["--db-template", "cinatra_seed"]).couseSidecar.dbTemplate).toBe("cinatra_seed");
  });

  it("--redis-db is REFUSED instead of being accepted and ignored, and asserts nothing false", () => {
    expect(() => parseInstallArgs(["--redis-db", "3"])).toThrow(/--redis-db/);
    expect(() => parseInstallArgs(["--redis-db", "3"])).toThrow(/not implemented/);
    // It must not offer a remedy this road never reads: a co-use signal routes
    // past --infra=external, so --redis-url would be inherited from the donor
    // and the operator's value silently dropped.
    let message = "";
    try {
      parseInstallArgs(["--redis-db", "3"]);
    } catch (err) {
      message = err.message;
    }
    expect(message).not.toMatch(/--redis-url/);
    expect(message).not.toMatch(/--infra=external/);
    // And it must not assert a donor for a command that names none.
    expect(message).not.toMatch(/donor/);
    expect(message).toMatch(/--bullmq-queue/);
  });

  it("REFUSES a database flag that would silently override an explicit --on-conflict / --infra", () => {
    // The database flags SELECT the shared-infra road. Accepting them beside a
    // contradicting choice took that road anyway and ignored what was asked for.
    expect(() => parseInstallArgs(["--on-conflict=isolated", "--db-name", "team_instance_a"])).toThrow(
      /--on-conflict=isolated/,
    );
    expect(() => parseInstallArgs(["--infra=external", "--db-template", "team_seed_template"])).toThrow(
      /--infra=external/,
    );
    expect(() => parseInstallArgs(["--on-conflict=prompt", "--bullmq-queue", "jobs"])).toThrow(
      /shared-infra/,
    );
    expect(() => parseInstallArgs(["--infra=new", "--reuse-from", "/somewhere"])).toThrow(/--infra=new/);
    // The message names what was TYPED, not the value it normalises to.
    expect(() => parseInstallArgs(["--no-infra", "--db-name", "team_instance_a"])).toThrow(/--no-infra/);
    expect(() => parseInstallArgs(["--no-infra", "--db-name", "team_instance_a"])).not.toThrow(
      /--infra=external/,
    );
    // The two spellings of the road itself are of course accepted.
    expect(parseInstallArgs(["--on-conflict=co-use", "--db-name", "team_instance_a"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--infra=share", "--db-name", "team_instance_a"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--db-name", "team_instance_a"]).couseRequested).toBe(true);
  });

  it("the preview front door names the new flag in its co-use refusal", () => {
    expect(() => parseInstallArgs(["--mode", "preview", "--db-template", "team_seed_template"])).toThrow(
      /cannot be combined with co-use/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. The SQL actually issued — exact statement text and identifier quoting.
// ---------------------------------------------------------------------------
function fakePg({ databases = {}, currentDatabase = "postgres" } = {}) {
  const record = { created: [], queries: [], connections: [], ends: 0 };
  const client = {
    connect: async () => {},
    end: async () => {
      record.ends += 1;
    },
    query: async (sql, params = null) => {
      record.queries.push({ sql, params });
      if (sql.startsWith("SELECT 1 FROM pg_database")) {
        const present = Object.hasOwn(databases, params[0]);
        return { rowCount: present ? 1 : 0, rows: present ? [{ "?column?": 1 }] : [] };
      }
      if (sql.startsWith("SELECT datistemplate, datallowconn FROM pg_database")) {
        const row = databases[params[0]];
        return {
          rowCount: row ? 1 : 0,
          rows: row
            ? [{ datistemplate: row.template === true, datallowconn: row.allowConnections === true }]
            : [],
        };
      }
      if (sql === "SELECT current_database()") {
        return { rowCount: 1, rows: [{ current_database: currentDatabase }] };
      }
      if (sql.startsWith("CREATE DATABASE")) {
        record.created.push(sql);
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  return {
    record,
    createClient: async (connectionString) => {
      record.connections.push(connectionString);
      return client;
    },
  };
}

const ADMIN_URL = "postgresql://u:p@127.0.0.1:5434/postgres";

describe("defaultCoUseDbOps — the statements that reach PostgreSQL", () => {
  it("DEFAULT path: the derived name from the built-in seed, unchanged", async () => {
    const pg = fakePg({ databases: { cinatra_seed: { template: true } } });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    const res = await ops.createCoUseDb({ adminUrl: ADMIN_URL, dbName: "cinatra_inst_alpha" });
    expect(res).toEqual({ created: true, warnings: [] });
    expect(pg.record.queries).toEqual([
      { sql: "SELECT 1 FROM pg_database WHERE datname = $1", params: ["cinatra_inst_alpha"] },
      { sql: 'CREATE DATABASE "cinatra_inst_alpha" TEMPLATE "cinatra_seed"', params: null },
    ]);
    // It runs against the server's maintenance database, never the new one.
    expect(pg.record.connections).toEqual(["postgresql://u:p@127.0.0.1:5434/postgres"]);
  });

  it("OPERATOR path: the chosen name, the chosen template, both quoted as identifiers", async () => {
    const pg = fakePg({ databases: { team_seed_template: { template: true } } });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    const res = await ops.createCoUseDb({
      adminUrl: ADMIN_URL,
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    });
    expect(res).toEqual({ created: true, warnings: [] });
    expect(pg.record.queries).toEqual([
      { sql: "SELECT 1 FROM pg_database WHERE datname = $1", params: ["team_instance_a"] },
      {
        sql: "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
        params: ["team_seed_template"],
      },
      { sql: 'CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"', params: null },
    ]);
  });

  it("an EXISTING target database is REUSED: no CREATE, and the run owns no drop", async () => {
    const pg = fakePg({
      databases: { team_instance_a: { template: false }, team_seed_template: { template: true } },
    });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    const res = await ops.createCoUseDb({
      adminUrl: ADMIN_URL,
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    });
    expect(res).toEqual({ created: false, warnings: [] });
    expect(pg.record.created).toEqual([]);
    expect(pg.record.queries.map((q) => q.sql)).toEqual(["SELECT 1 FROM pg_database WHERE datname = $1"]);
    // `created: false` is what keeps the rollback plan from planning a DROP.
    expect(coUseRollbackPlan({ createdDb: false, dbName: "team_instance_a", operatorNamed: true })).toEqual([
      { step: "releaseInstanceSlot" },
    ]);
  });

  it("REFUSES a template that does not exist, and one that is not usable as a template", async () => {
    const missing = fakePg({ databases: {} });
    await expect(
      defaultCoUseDbOps({ createClient: missing.createClient }).createCoUseDb({
        adminUrl: ADMIN_URL,
        dbName: "team_instance_a",
        template: "team_seed_template",
        operatorNamed: true,
        verifyTemplate: true,
      }),
    ).rejects.toThrow(/team_seed_template.*does not exist/s);
    expect(missing.record.created).toEqual([]);

    const notTemplate = fakePg({ databases: { team_seed_template: { template: false } } });
    await expect(
      defaultCoUseDbOps({ createClient: notTemplate.createClient }).createCoUseDb({
        adminUrl: ADMIN_URL,
        dbName: "team_instance_a",
        template: "team_seed_template",
        operatorNamed: true,
        verifyTemplate: true,
      }),
    ).rejects.toThrow(/not marked as a template/);
    expect(notTemplate.record.created).toEqual([]);
  });

  it("REFUSES a CLI-owned name at the STATEMENT layer too, on both the create and the drop road", async () => {
    // The parser is the first gate, not the only one: the ops layer is what a
    // future caller reaches directly, and it is the last thing before SQL.
    const pg = fakePg();
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    for (const name of ["cinatra_seed", "cinatra_clone_alpha", "cinatra_inst_alpha", "postgres", "cinatra"]) {
      await expect(
        ops.createCoUseDb({ adminUrl: ADMIN_URL, dbName: name, operatorNamed: true }),
        name,
      ).rejects.toThrow(/Refusing to create/);
      await expect(
        ops.dropDbCreatedByThisRun({
          adminUrl: ADMIN_URL,
          dbName: name,
          createdThisRun: true,
          operatorNamed: true,
        }),
        name,
      ).rejects.toThrow(/refuses/);
    }
    expect(pg.record.connections).toEqual([]);
    // The DERIVED road is untouched: it still creates and drops its own shape.
    const derived = fakePg({ databases: { cinatra_seed: { template: true } } });
    const derivedOps = defaultCoUseDbOps({ createClient: derived.createClient });
    expect(await derivedOps.createCoUseDb({ adminUrl: ADMIN_URL, dbName: "cinatra_inst_alpha" })).toEqual({
      created: true,
      warnings: [],
    });
  });

  it("REFUSES a database that is its own template, at the statement layer too", async () => {
    const pg = fakePg({ databases: { team_seed_template: { template: true } } });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    await expect(
      ops.createCoUseDb({
        adminUrl: ADMIN_URL,
        dbName: "team_seed_template",
        template: "team_seed_template",
        operatorNamed: true,
        verifyTemplate: true,
      }),
    ).rejects.toThrow(/its own template/);
    expect(pg.record.connections).toEqual([]);
  });

  it("WARNS — without refusing — when the template still allows connections", async () => {
    const open = fakePg({ databases: { team_seed_template: { template: true, allowConnections: true } } });
    const res = await defaultCoUseDbOps({ createClient: open.createClient }).createCoUseDb({
      adminUrl: ADMIN_URL,
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    });
    expect(res.created).toBe(true); // a warning, never a refusal
    expect(res.warnings.join(" ")).toMatch(/team_seed_template.*allows connections/);
    expect(open.record.created).toHaveLength(1);

    // Marked the way every message instructs: no warning at all.
    const closed = fakePg({ databases: { team_seed_template: { template: true, allowConnections: false } } });
    const quiet = await defaultCoUseDbOps({ createClient: closed.createClient }).createCoUseDb({
      adminUrl: ADMIN_URL,
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    });
    expect(quiet.warnings ?? []).toEqual([]);
  });

  it("resolveDatabaseName asks the server which database a connection string names", async () => {
    const pg = fakePg({ currentDatabase: "donor_app" });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    const name = await ops.resolveDatabaseName({ connectionString: "postgresql://u:p@127.0.0.1:5434/" });
    expect(name).toBe("donor_app");
    // It asks over the connection string AS GIVEN — re-pointing it at the
    // maintenance database would answer "postgres" every time.
    expect(pg.record.connections).toEqual(["postgresql://u:p@127.0.0.1:5434/"]);
    expect(pg.record.queries).toEqual([{ sql: "SELECT current_database()", params: null }]);
  });

  it("REFUSES an invalid name or template BEFORE a connection is opened", async () => {
    const pg = fakePg();
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    await expect(
      ops.createCoUseDb({ adminUrl: ADMIN_URL, dbName: 'a"b', operatorNamed: true }),
    ).rejects.toThrow(/Refusing/);
    await expect(
      ops.createCoUseDb({ adminUrl: ADMIN_URL, dbName: "team_instance_a", operatorNamed: true, template: "Bad" }),
    ).rejects.toThrow(/template/);
    // The derived road keeps its narrow shape guard.
    await expect(ops.createCoUseDb({ adminUrl: ADMIN_URL, dbName: "team_instance_a" })).rejects.toThrow(
      /non-co-use-shaped/,
    );
    expect(pg.record.connections).toEqual([]);
  });

  it("the owned DROP refuses a database this run did not create, or a name that fails both guards", async () => {
    const pg = fakePg({ databases: { team_instance_a: { template: false } } });
    const ops = defaultCoUseDbOps({ createClient: pg.createClient });
    await expect(
      ops.dropDbCreatedByThisRun({ adminUrl: ADMIN_URL, dbName: "team_instance_a", createdThisRun: false }),
    ).rejects.toThrow(/not created by this run/);
    await expect(
      ops.dropDbCreatedByThisRun({
        adminUrl: ADMIN_URL,
        dbName: "postgres",
        createdThisRun: true,
        operatorNamed: true,
      }),
    ).rejects.toThrow(/refuses/);
    expect(pg.record.connections).toEqual([]);

    await ops.dropDbCreatedByThisRun({
      adminUrl: ADMIN_URL,
      dbName: "team_instance_a",
      createdThisRun: true,
      operatorNamed: true,
    });
    expect(pg.record.queries).toEqual([
      { sql: 'DROP DATABASE IF EXISTS "team_instance_a" WITH (FORCE)', params: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. The whole install road, with the pg client and setup injected.
// ---------------------------------------------------------------------------
function buildFixtureOrigin(sandbox) {
  const src = path.join(sandbox, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    path.join(src, "packages", "migrations", "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
  );
  writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }),
  );
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "ignore",
    });
  G(["init", "-b", "main"], src);
  G(["add", "-A"], src);
  G(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  G(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

describe("runInstall — a shared-Postgres instance with an operator-chosen name and template", () => {
  let sandbox;
  let originRepo;
  let regPath;

  const DONOR_ENV = {
    SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/postgres",
    REDIS_URL: "redis://127.0.0.1:6379",
    BETTER_AUTH_SECRET: "donor-secret",
    CINATRA_ENCRYPTION_KEY: "donor-enc",
  };

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-dbname-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
  });
  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    regPath = path.join(d, "instances.json");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  const couseDeps = (extra = {}) => ({
    runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
    commandExists: () => true,
    composeAvailable: () => true,
    detectPortConflicts: async () => [],
    readCloneRegistry: () => null,
    readDonorEnv: () => ({ ...DONOR_ENV }),
    probeCookiePrefixSupport: () => true,
    bringUpInfra: () => {
      throw new Error("a shared-infra install must NOT bring up a stack");
    },
    runSetup: () => {},
    skipCoUseInstall: true,
    ...extra,
  });

  const baseArgs = (installDir) => [
    "--dir",
    installDir,
    "--repo-url",
    `file://${originRepo}`,
    "--ref",
    "main",
    "--on-conflict=co-use",
    "--no-install",
    "--no-setup",
    "--yes",
  ];

  it("creates the operator's database from the operator's template and points the env at it", async () => {
    const installDir = path.join(sandbox, "inst-a");
    const creates = [];
    const res = await runInstall(
      [
        ...baseArgs(installDir),
        "--db-name",
        "team_instance_a",
        "--db-template",
        "team_seed_template",
        "--bullmq-queue",
        "team-instance-a-jobs",
      ],
      {
        log: () => {},
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async (a) => {
              creates.push(a);
              return { created: true };
            },
            dropDbCreatedByThisRun: async () => {
              throw new Error("should not drop on success");
            },
          },
        }),
      },
    );
    expect(res.infraPlan).toBe("co-use");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    });
    const envBody = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(envBody).toMatch(/SUPABASE_DB_URL=.*\/team_instance_a/);
    expect(envBody).toMatch(/BULLMQ_QUEUE_NAME=team-instance-a-jobs/);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["inst-a"].createdResources).toContain("db:team_instance_a");
  });

  it("without the flags nothing moves: the derived name, the built-in seed, the derived queue", async () => {
    const installDir = path.join(sandbox, "plain");
    const creates = [];
    await runInstall(baseArgs(installDir), {
      log: () => {},
      deps: couseDeps({
        coUseDbOps: {
          createCoUseDb: async (a) => {
            creates.push(a);
            return { created: true };
          },
          dropDbCreatedByThisRun: async () => {},
        },
      }),
    });
    expect(creates).toEqual([
      {
        adminUrl: DONOR_ENV.SUPABASE_DB_URL,
        dbName: "cinatra_inst_plain",
        template: "cinatra_seed",
        operatorNamed: false,
        verifyTemplate: false,
      },
    ]);
    const envBody = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(envBody).toMatch(/SUPABASE_DB_URL=.*\/cinatra_inst_plain/);
    expect(envBody).toMatch(/BULLMQ_QUEUE_NAME=cinatra-inst-plain/);
  });

  it("an operator database that ALREADY exists is reused and never dropped on a rollback", async () => {
    const installDir = path.join(sandbox, "existing");
    const drops = [];
    await expect(
      runInstall([...baseArgs(installDir).filter((a) => a !== "--no-setup"), "--db-name", "team_instance_b"], {
        log: () => {},
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async () => ({ created: false }), // it was already there
            dropDbCreatedByThisRun: async (a) => {
              drops.push(a);
            },
          },
          runSetup: () => {
            throw new Error("boom: setup failed");
          },
        }),
      }),
    ).rejects.toThrow(/boom: setup failed/);
    expect(drops).toEqual([]);
  });

  it("a database this run DID create under the operator's name is rolled back exactly once", async () => {
    const installDir = path.join(sandbox, "rollback");
    const drops = [];
    await expect(
      runInstall([...baseArgs(installDir).filter((a) => a !== "--no-setup"), "--db-name", "team_instance_c"], {
        log: () => {},
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async (a) => {
              drops.push(a);
            },
          },
          runSetup: () => {
            throw new Error("boom");
          },
        }),
      }),
    ).rejects.toThrow(/boom/);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      dbName: "team_instance_c",
      createdThisRun: true,
      operatorNamed: true,
    });
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.rollback).toBeUndefined();
  });

  it("REFUSES a --db-name that is the donor's OWN database — the separation would be gone", async () => {
    // The whole claim of this road is a database of its own. Naming the donor's
    // database passes every shape guard, finds an existing database, reports
    // "reusing" and points the new instance at the donor's data.
    const installDir = path.join(sandbox, "collide-donor");
    const creates = [];
    await expect(
      runInstall([...baseArgs(installDir), "--db-name", "donor_app_db"], {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...DONOR_ENV, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/donor_app_db" }),
          coUseDbOps: {
            createCoUseDb: async (a) => {
              creates.push(a);
              return { created: false };
            },
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      }),
    ).rejects.toThrow(/--db-name "donor_app_db"[\s\S]*donor/);
    // Refused before anything was opened.
    expect(creates).toEqual([]);
    // And the refusal never prints a connection string.
    let message = "";
    await runInstall([...baseArgs(installDir), "--db-name", "donor_app_db"], {
      log: () => {},
      deps: couseDeps({
        readDonorEnv: () => ({ ...DONOR_ENV, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/donor_app_db" }),
        coUseDbOps: { createCoUseDb: async () => ({ created: false }), dropDbCreatedByThisRun: async () => {} },
      }),
    }).catch((err) => {
      message = err.message;
    });
    expect(message).not.toMatch(/postgresql:\/\//);
    expect(message).not.toMatch(/:p@/);
  });

  it("finds the donor's database in a libpq dbname parameter when the URL path carries none", async () => {
    // A hand-written or provider-issued URL can name its database in the query
    // instead of the path. Reading only the path made the collision guard skip
    // itself without a word — the donor's own database again, behind a success.
    const installDir = path.join(sandbox, "dbname-param");
    const creates = [];
    const resolves = [];
    await expect(
      runInstall([...baseArgs(installDir), "--db-name", "donor_app"], {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...DONOR_ENV, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/?dbname=donor_app" }),
          coUseDbOps: {
            createCoUseDb: async (a) => {
              creates.push(a);
              return { created: false };
            },
            dropDbCreatedByThisRun: async () => {},
            resolveDatabaseName: async (a) => {
              resolves.push(a);
              return null;
            },
          },
        }),
      }),
    ).rejects.toThrow(/--db-name "donor_app"[\s\S]*donor/);
    expect(creates).toEqual([]);
    // The name was in the URL, so the server was never asked.
    expect(resolves).toEqual([]);
  });

  it("ASKS THE SERVER for the donor's database when the URL names none, and refuses on a match", async () => {
    const installDir = path.join(sandbox, "ask-server");
    const creates = [];
    const resolves = [];
    await expect(
      runInstall([...baseArgs(installDir), "--db-name", "donor_default"], {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...DONOR_ENV, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/" }),
          coUseDbOps: {
            createCoUseDb: async (a) => {
              creates.push(a);
              return { created: true };
            },
            dropDbCreatedByThisRun: async () => {},
            resolveDatabaseName: async (a) => {
              resolves.push(a);
              return "donor_default";
            },
          },
        }),
      }),
    ).rejects.toThrow(/--db-name "donor_default"[\s\S]*donor/);
    // Asked over the donor's own connection string, and BEFORE the create.
    expect(resolves).toEqual([{ connectionString: "postgresql://u:p@127.0.0.1:5434/" }]);
    expect(creates).toEqual([]);
  });

  it("never asks the server when the URL already names the donor's database (the default road)", async () => {
    const installDir = path.join(sandbox, "no-ask");
    const resolves = [];
    await runInstall([...baseArgs(installDir), "--db-name", "team_instance_e"], {
      log: () => {},
      deps: couseDeps({
        coUseDbOps: {
          createCoUseDb: async () => ({ created: true }),
          dropDbCreatedByThisRun: async () => {},
          resolveDatabaseName: async (a) => {
            resolves.push(a);
            return null;
          },
        },
      }),
    });
    expect(resolves).toEqual([]);
  });

  it("SAYS SO instead of skipping silently when the donor's database cannot be established", async () => {
    const installDir = path.join(sandbox, "unknown-donor");
    const logs = [];
    const res = await runInstall([...baseArgs(installDir), "--db-name", "team_instance_f"], {
      log: (m) => logs.push(String(m)),
      deps: couseDeps({
        readDonorEnv: () => ({ ...DONOR_ENV, SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/" }),
        coUseDbOps: {
          createCoUseDb: async () => ({ created: true }),
          dropDbCreatedByThisRun: async () => {},
          resolveDatabaseName: async () => {
            throw new Error("server unreachable for this probe");
          },
        },
      }),
    });
    // The install proceeds — the check could not be made, and says so.
    expect(res.infraPlan).toBe("co-use");
    expect(logs.join("\n")).toMatch(/could not determine the donor instance's own database/);
  });

  it("REFUSES a DERIVED name that collides with the donor's database, pointing at --instance", async () => {
    // No --db-name here: the derived name itself can collide when the donor is
    // a co-use instance, and the operator road's guard must not be the only one.
    const installDir = path.join(sandbox, "derived-collide");
    const creates = [];
    await expect(
      runInstall(baseArgs(installDir), {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({
            ...DONOR_ENV,
            SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/cinatra_inst_derived_collide",
          }),
          coUseDbOps: {
            createCoUseDb: async (a) => {
              creates.push(a);
              return { created: true };
            },
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      }),
    ).rejects.toThrow(/--instance/);
    expect(creates).toEqual([]);
  });

  it("a converge WITHOUT --db-name still reports the RECORDED database, not the derived one", async () => {
    const installDir = path.join(sandbox, "converge-plain");
    const mkDeps = () =>
      couseDeps({
        coUseDbOps: {
          createCoUseDb: async () => ({ created: true }),
          dropDbCreatedByThisRun: async () => {},
        },
      });
    await runInstall([...baseArgs(installDir), "--db-name", "team_instance_g"], {
      log: () => {},
      deps: mkDeps(),
    });
    const logs = [];
    await runInstall(baseArgs(installDir), { log: (m) => logs.push(String(m)), deps: mkDeps() });
    const summary = logs.find((l) => l.includes("Instance:")) ?? "";
    expect(summary).toMatch(/separate DB team_instance_g/);
    expect(summary).not.toMatch(/cinatra_inst_converge_plain/);
    // And the converge itself names the database it converged on.
    expect(logs.join("\n")).toMatch(/already recorded ready on database team_instance_g/);
  });

  it("says plainly that a PostgreSQL system template produces an EMPTY database", async () => {
    const installDir = path.join(sandbox, "systpl");
    const logs = [];
    const creates = [];
    await runInstall([...baseArgs(installDir), "--db-name", "team_instance_h", "--db-template", "template0"], {
      log: (m) => logs.push(String(m)),
      deps: couseDeps({
        coUseDbOps: {
          createCoUseDb: async (a) => {
            creates.push(a);
            return { created: true };
          },
          dropDbCreatedByThisRun: async () => {},
        },
      }),
    });
    // Accepted — it is valid PostgreSQL — and stated, because an empty database
    // is not what an operator reaching for a template usually means.
    expect(creates[0]).toMatchObject({ template: "template0" });
    expect(logs.join("\n")).toMatch(/template0[\s\S]*EMPTY/);
  });

  it("REFUSES a --db-name equal to the --db-template — an instance would run inside its own template", async () => {
    const installDir = path.join(sandbox, "collide-template");
    const creates = [];
    await expect(
      runInstall(
        [...baseArgs(installDir), "--db-name", "team_seed_template", "--db-template", "team_seed_template"],
        {
          log: () => {},
          deps: couseDeps({
            coUseDbOps: {
              createCoUseDb: async (a) => {
                creates.push(a);
                return { created: false };
              },
              dropDbCreatedByThisRun: async () => {},
            },
          }),
        },
      ),
    ).rejects.toThrow(/--db-name[\s\S]*--db-template/);
    expect(creates).toEqual([]);
  });

  it("an idempotent re-run REFUSES a --db-name that disagrees with the recorded one, and reports the recorded one", async () => {
    const installDir = path.join(sandbox, "rerun");
    const creates = [];
    const mkDeps = () =>
      couseDeps({
        coUseDbOps: {
          createCoUseDb: async (a) => {
            creates.push(a);
            return { created: true };
          },
          dropDbCreatedByThisRun: async () => {},
        },
      });
    await runInstall([...baseArgs(installDir), "--db-name", "team_instance_a"], {
      log: () => {},
      deps: mkDeps(),
    });
    expect(creates).toHaveLength(1);

    // A re-run naming a DIFFERENT database changes nothing at all — the converge
    // path returns before any SQL and before the env write. Reporting success
    // under the new name would be a plain untruth.
    await expect(
      runInstall([...baseArgs(installDir), "--db-name", "team_instance_z"], {
        log: () => {},
        deps: mkDeps(),
      }),
    ).rejects.toThrow(/team_instance_a/);
    expect(creates).toHaveLength(1); // still no second create

    // A re-run naming the SAME database converges and prints the RECORDED name.
    const logs = [];
    const res = await runInstall([...baseArgs(installDir), "--db-name", "team_instance_a"], {
      log: (m) => logs.push(String(m)),
      deps: mkDeps(),
    });
    expect(res.infraPlan).toBe("co-use");
    expect(logs.join("\n")).toMatch(/separate DB team_instance_a/);
    expect(logs.join("\n")).not.toMatch(/team_instance_z/);
  });

  it("says so when a named --db-template was NOT used because the database already existed", async () => {
    const installDir = path.join(sandbox, "tmplunused");
    const logs = [];
    await runInstall(
      [...baseArgs(installDir), "--db-name", "team_instance_b", "--db-template", "team_seed_template"],
      {
        log: (m) => logs.push(String(m)),
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async () => ({ created: false }), // it was already there
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      },
    );
    const blob = logs.join("\n");
    expect(blob).toMatch(/Reusing existing co-use database team_instance_b/);
    expect(blob).toMatch(/team_seed_template was NOT used/);
  });

  it("--db-template alone keeps the derived name and still checks the operator's template", async () => {
    const installDir = path.join(sandbox, "tmplonly");
    const creates = [];
    const logs = [];
    await runInstall([...baseArgs(installDir), "--db-template", "team_seed_template"], {
      log: (m) => logs.push(String(m)),
      deps: couseDeps({
        coUseDbOps: {
          createCoUseDb: async (a) => {
            creates.push(a);
            return { created: true };
          },
          dropDbCreatedByThisRun: async () => {},
        },
      }),
    });
    expect(creates[0]).toMatchObject({
      dbName: "cinatra_inst_tmplonly",
      template: "team_seed_template",
      operatorNamed: false,
      verifyTemplate: true,
    });
    // The run says which template the database came from, so the log is not
    // silent about the one input that decides what is inside it.
    expect(logs.join("\n")).toMatch(/Created co-use database cinatra_inst_tmplonly from template team_seed_template\./);
  });
});
