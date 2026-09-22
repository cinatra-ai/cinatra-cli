// The EXTERNAL install road creates the instance's database from a template.
//
// An operator who points `cinatra install` at their own PostgreSQL server and
// names the instance database plus the template it should be copied from used
// to be refused: `--db-name` / `--db-template` selected the shared-services
// road and were rejected beside an explicit `--infra=external`, and the only
// `CREATE DATABASE … TEMPLATE …` in the CLI lived on that shared road, which
// needs a donor checkout on the same machine. So an operator whose `.env.local`
// is already authored had no way to let the CLI create the database.
//
// These tests pin the new road end to end: the parse-time acceptance of the
// PAIR (and every refusal that still applies), the EXACT SQL it issues against
// the server's maintenance database, where the server comes from when no
// `--db-url` is passed, the untouched existing database, and the failures —
// none of which may print the credential the connection carries.
//
// No live PostgreSQL: the pg client is injected through `defaultExternalDbOps`,
// and that ops object is injected into `runInstall` through its `deps` seam,
// exactly as the shared-road tests do.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseFromTemplate,
  defaultCoUseDbOps,
  defaultExternalDbOps,
  parseInstallArgs,
  runInstall,
} from "../src/install.mjs";

// A password that must never reach a log line or a failure message.
const DB_PASSWORD = "pw_from_the_env_file";
const SERVER = `postgresql://installer:${DB_PASSWORD}@127.0.0.1:5434`;
const TARGET_URL = `${SERVER}/team_instance_a`;
const MAINTENANCE_URL = `${SERVER}/postgres`;

// ---------------------------------------------------------------------------
// 1. The parser — the pair is the external road's own database creation.
// ---------------------------------------------------------------------------
describe("parseInstallArgs — --db-name + --db-template on the external road", () => {
  it("ACCEPTS the pair beside --infra=external and does NOT route to the shared road", () => {
    const opts = parseInstallArgs([
      "--infra=external",
      "--db-name",
      "team_instance_a",
      "--db-template",
      "team_seed_template",
    ]);
    expect(opts.externalDb).toEqual({ name: "team_instance_a", template: "team_seed_template" });
    expect(opts.couseRequested).toBe(false);
    expect(opts.noInfra).toBe(true);
  });

  it("ACCEPTS the pair under --no-infra too — it is the same road, spelled differently", () => {
    const opts = parseInstallArgs([
      "--no-infra",
      "--db-name=team_instance_a",
      "--db-template=team_seed_template",
    ]);
    expect(opts.externalDb).toEqual({ name: "team_instance_a", template: "team_seed_template" });
    expect(opts.couseRequested).toBe(false);
  });

  it("leaves every other road's externalDb null — the shared road keeps its own names", () => {
    expect(parseInstallArgs([]).externalDb).toBeNull();
    const shared = parseInstallArgs(["--db-name", "team_instance_a", "--db-template", "team_seed_template"]);
    expect(shared.externalDb).toBeNull();
    expect(shared.couseRequested).toBe(true);
    expect(shared.couseSidecar).toMatchObject({
      dbName: "team_instance_a",
      dbTemplate: "team_seed_template",
    });
  });

  it("still validates both names before anything is opened", () => {
    expect(() => parseInstallArgs(["--infra=external", "--db-name", "Bad-Name", "--db-template", "t"])).toThrow(
      /Invalid --db-name/,
    );
    expect(() => parseInstallArgs(["--infra=external", "--db-name", "postgres", "--db-template", "t"])).toThrow(
      /reserved/,
    );
    expect(() =>
      parseInstallArgs(["--infra=external", "--db-name", "team_instance_a", "--db-template", "no template"]),
    ).toThrow(/Invalid --db-template/);
  });

  it("REFUSES a --db-name with no --db-template on the external road, and names the pair", () => {
    // Half the pair is still the shared road's signal: the external road copies
    // a template the operator names, and has no built-in seed to fall back on.
    let message = "";
    try {
      parseInstallArgs(["--infra=external", "--db-name", "team_instance_a"]);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/--infra=external/);
    expect(message).toMatch(/--db-template/);
    // …and a lone --db-template likewise.
    expect(() => parseInstallArgs(["--infra=external", "--db-template", "team_seed_template"])).toThrow(
      /--infra=external/,
    );
  });

  it("keeps every refusal that still applies — the contradictions and the shared-only flags", () => {
    const pair = ["--db-name", "team_instance_a", "--db-template", "team_seed_template"];
    // A road that is not the external one is still a contradiction.
    expect(() => parseInstallArgs(["--on-conflict=isolated", ...pair])).toThrow(/--on-conflict=isolated/);
    expect(() => parseInstallArgs(["--on-conflict=attach", ...pair])).toThrow(/shared-infra/);
    expect(() => parseInstallArgs(["--infra=new", ...pair])).toThrow(/--infra=new/);
    // The shared road's own flags cannot ride along on the external one: the
    // external road reads neither, so they would be silently ignored.
    expect(() => parseInstallArgs(["--infra=external", ...pair, "--bullmq-queue", "jobs"])).toThrow(
      /--infra=external/,
    );
    expect(() => parseInstallArgs(["--infra=external", ...pair, "--reuse-from", "/elsewhere"])).toThrow(
      /--infra=external/,
    );
    // Asking for BOTH roads at once is still two roads.
    expect(() => parseInstallArgs(["--infra=external", "--on-conflict=co-use", ...pair])).toThrow(
      /--infra=external/,
    );
    // And the shared road itself is untouched.
    expect(parseInstallArgs(["--infra=share", ...pair]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--on-conflict=co-use", ...pair]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--on-conflict=co-use", ...pair]).externalDb).toBeNull();
  });

  it("the preview composition still refuses the SHARED road, and accepts the external pair", () => {
    expect(() => parseInstallArgs(["--mode", "preview", "--db-template", "team_seed_template"])).toThrow(
      /cannot be combined with co-use/,
    );
    // The external road is not terminal, so a preview over it composes as usual.
    expect(
      parseInstallArgs([
        "--mode",
        "preview",
        "--infra=external",
        "--db-name",
        "team_instance_a",
        "--db-template",
        "team_seed_template",
      ]).externalDb,
    ).toEqual({ name: "team_instance_a", template: "team_seed_template" });
  });
});

// ---------------------------------------------------------------------------
// 2. The statements that reach PostgreSQL — ONE creation helper, both roads.
// ---------------------------------------------------------------------------
function fakePg({ databases = {}, order = [] } = {}) {
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
      if (sql.startsWith("CREATE DATABASE")) {
        record.created.push(sql);
        order.push("create-database");
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

describe("createDatabaseFromTemplate — the one place this CLI copies a database", () => {
  it("issues the SAME statements for the external road as for the shared one", async () => {
    const args = {
      adminUrl: TARGET_URL,
      dbName: "team_instance_a",
      template: "team_seed_template",
      operatorNamed: true,
      verifyTemplate: true,
    };
    const expected = [
      { sql: "SELECT 1 FROM pg_database WHERE datname = $1", params: ["team_instance_a"] },
      {
        sql: "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
        params: ["team_seed_template"],
      },
      { sql: 'CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"', params: null },
    ];

    const shared = fakePg({ databases: { team_seed_template: { template: true } } });
    expect(
      await defaultCoUseDbOps({ createClient: shared.createClient }).createCoUseDb({ ...args }),
    ).toEqual({ created: true, warnings: [] });

    const direct = fakePg({ databases: { team_seed_template: { template: true } } });
    expect(await createDatabaseFromTemplate({ createClient: direct.createClient, ...args })).toEqual({
      created: true,
      warnings: [],
    });

    expect(shared.record.queries).toEqual(expected);
    expect(direct.record.queries).toEqual(expected);
    // Both connect to the server's MAINTENANCE database, never to the new one.
    expect(shared.record.connections).toEqual([MAINTENANCE_URL]);
    expect(direct.record.connections).toEqual([MAINTENANCE_URL]);
  });

  it("defaultExternalDbOps names the operator's database and verifies the template", async () => {
    const pg = fakePg({ databases: { team_seed_template: { template: true } } });
    const ops = defaultExternalDbOps({ createClient: pg.createClient });
    expect(
      await ops.createExternalDb({
        adminUrl: TARGET_URL,
        dbName: "team_instance_a",
        template: "team_seed_template",
      }),
    ).toEqual({ created: true, warnings: [] });
    expect(pg.record.created).toEqual(['CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"']);
    // The operator's name is guarded by the operator rule, not the derived shape.
    await expect(
      ops.createExternalDb({ adminUrl: TARGET_URL, dbName: "postgres", template: "team_seed_template" }),
    ).rejects.toThrow(/Refusing to create/);
  });
});

// ---------------------------------------------------------------------------
// 3. The install itself — creation before setup, and never a credential.
// ---------------------------------------------------------------------------
const gitIn = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

function buildFixtureOrigin(sandbox) {
  const src = path.join(sandbox, "src-repo");
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
  gitIn(["init", "-b", "main"], src);
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  gitIn(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

describe("runInstall --infra=external — the instance database is created from the template", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-external-db-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  /** Record the child invocations + the order the install did things in. */
  function harness({ databases = {} } = {}) {
    const order = [];
    const lines = [];
    const pg = fakePg({ databases, order });
    const deps = {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: false }),
      commandExists: () => true,
      composeAvailable: () => true,
      detectPortConflicts: async () => [],
      composePublishedPortsForTarget: () => [],
      composeConfigForFiles: () => ({ name: "cinatra", services: {}, networks: {}, volumes: {} }),
      composeSupportsNoEnvResolution: () => true,
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      bringUpInfra: () => {},
      generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }),
      runComposeDown: () => {},
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      mountAgentSourcesAfterSync: async () => ({ ok: true, skipped: true }),
      syncDevExtensions: async () => ({ skipped: true, reason: "no declared dev extensions", results: [] }),
      pnpmInstall: () => {},
      runSetupInTarget: () => {
        order.push("setup");
        return { tolerated: true, registrySkew: false, lines: [] };
      },
      externalDbOps: defaultExternalDbOps({ createClient: pg.createClient }),
    };
    return { order, lines, pg, deps, log: (l) => lines.push(String(l)) };
  }

  const run = (dir, extraArgs, h) =>
    runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", ...extraArgs],
      { log: h.log, deps: h.deps },
    );

  it("with --db-url: creates the database from the template ONCE, then runs setup", async () => {
    const h = harness({ databases: { team_seed_template: { template: true } } });
    await run(path.join(sandbox, "with-url"), [
      "--infra", "external",
      "--db-url", TARGET_URL,
      "--db-name", "team_instance_a",
      "--db-template", "team_seed_template",
      "--external-db-disposable",
    ], h);

    expect(h.pg.record.queries).toEqual([
      { sql: "SELECT 1 FROM pg_database WHERE datname = $1", params: ["team_instance_a"] },
      {
        sql: "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
        params: ["team_seed_template"],
      },
      { sql: 'CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"', params: null },
    ]);
    // Against the server's maintenance database — never the one being created.
    expect(h.pg.record.connections).toEqual([MAINTENANCE_URL]);
    // Created BEFORE setup + migrations, and only once.
    expect(h.order).toEqual(["create-database", "setup"]);
    expect(h.lines.some((l) => l.includes("Created database team_instance_a from template team_seed_template"))).toBe(true);
  });

  it("without --db-url: the server comes from .env.local, and no line carries the password", async () => {
    const dir = path.join(sandbox, "from-env-file");
    // An operator who authored their own .env.local: install the checkout, then
    // point its SUPABASE_DB_URL at the external server.
    await run(dir, ["--infra", "external", "--no-install"], harness());
    appendFileSync(path.join(dir, ".env.local"), `SUPABASE_DB_URL=${TARGET_URL}\n`);

    const h = harness({ databases: { team_seed_template: { template: true } } });
    await run(dir, [
      "--infra", "external",
      "--db-name", "team_instance_a",
      "--db-template", "team_seed_template",
    ], h);

    expect(h.pg.record.connections).toEqual([MAINTENANCE_URL]);
    expect(h.pg.record.created).toEqual(['CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"']);
    expect(h.order).toEqual(["create-database", "setup"]);
    // The credential was read by key and used in process. It is in no line.
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
    expect(h.lines.some((l) => l.includes("team_instance_a") && l.includes("team_seed_template"))).toBe(true);
    // …and it is still the operator's own file: the URL was not rewritten.
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toContain(`SUPABASE_DB_URL=${TARGET_URL}`);
  });

  it("a database that ALREADY exists is used as it stands: no CREATE, one plain line, setup runs", async () => {
    const h = harness({
      databases: { team_instance_a: { template: false }, team_seed_template: { template: true } },
    });
    await run(path.join(sandbox, "already-there"), [
      "--infra", "external",
      "--db-url", TARGET_URL,
      "--db-name", "team_instance_a",
      "--db-template", "team_seed_template",
      "--external-db-disposable",
    ], h);

    expect(h.pg.record.created).toEqual([]);
    expect(h.pg.record.queries.map((q) => q.sql)).toEqual(["SELECT 1 FROM pg_database WHERE datname = $1"]);
    expect(h.order).toEqual(["setup"]);
    expect(h.lines.some((l) => l.includes("team_instance_a already exists"))).toBe(true);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });

  it("a MISSING template fails naming the template — and never the credential", async () => {
    const h = harness({ databases: {} });
    let message = "";
    try {
      await run(path.join(sandbox, "no-template"), [
        "--infra", "external",
        "--db-url", TARGET_URL,
        "--db-name", "team_instance_a",
        "--db-template", "team_seed_template",
        "--external-db-disposable",
      ], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/team_seed_template/);
    expect(message).toMatch(/does not exist/);
    expect(message).not.toContain(DB_PASSWORD);
    expect(h.pg.record.created).toEqual([]);
    expect(h.order).toEqual([]);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });

  it("REFUSES when the install's own database URL names a DIFFERENT database", async () => {
    // Creating `team_instance_a` while setup migrates another database is a
    // flag that silently does nothing. Name both, never the connection.
    const h = harness({ databases: { team_seed_template: { template: true } } });
    let message = "";
    try {
      await run(path.join(sandbox, "mismatch"), [
        "--infra", "external",
        "--db-url", `${SERVER}/another_database`,
        "--db-name", "team_instance_a",
        "--db-template", "team_seed_template",
        "--external-db-disposable",
      ], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/team_instance_a/);
    expect(message).toMatch(/another_database/);
    expect(message).not.toContain(DB_PASSWORD);
    expect(h.pg.record.connections).toEqual([]);
  });

  it("an external install with NO database flags is byte-for-byte what it was", async () => {
    const h = harness();
    await run(path.join(sandbox, "untouched"), [
      "--infra", "external",
      "--db-url", TARGET_URL,
      "--external-db-disposable",
    ], h);
    expect(h.pg.record.connections).toEqual([]);
    expect(h.pg.record.queries).toEqual([]);
    expect(h.order).toEqual(["setup"]);
  });

  // -------------------------------------------------------------------------
  // The failure the SERVER words, not the CLI's. The tests above all pin a
  // message this CLI composes itself, which can only carry what it was handed;
  // the one line that carries someone ELSE's text is the wrapping error placed
  // over the pg client, and that is the line a credential can ride out on. So the
  // client fails the way a client does — quoting the connection string it was
  // given — and the password is looked for in what the operator finally sees.
  // -------------------------------------------------------------------------

  /** A pg client that fails on connect with a message of its OWN — `quote` is
   *  the text it puts in it. A driver or a server composes that text, not this
   *  CLI, so it is the one line on this road that can carry anything at all. */
  function quotingPg(quote = null) {
    const record = { connections: [] };
    return {
      record,
      createClient: async (connectionString) => {
        record.connections.push(connectionString);
        return {
          connect: async () => {
            throw new Error(
              `connect ECONNREFUSED: could not connect to ${quote ?? connectionString} ` +
                `(server closed the connection)`,
            );
          },
          end: async () => {},
          query: async () => ({ rowCount: 0, rows: [] }),
        };
      },
    };
  }

  it("a failure that quotes the connection string reaches the operator WITHOUT the password", async () => {
    const h = harness();
    h.deps.externalDbOps = defaultExternalDbOps({ createClient: quotingPg().createClient });
    let message = "";
    try {
      await run(path.join(sandbox, "server-words"), [
        "--infra", "external",
        "--db-url", TARGET_URL,
        "--db-name", "team_instance_a",
        "--db-template", "team_seed_template",
        "--external-db-disposable",
      ], h);
    } catch (err) {
      message = err.message;
    }
    // The failure keeps the server's own words…
    expect(message).toMatch(/ECONNREFUSED/);
    expect(message).toMatch(/team_instance_a/);
    expect(message).toMatch(/team_seed_template/);
    // …and the host, so the operator knows WHICH server refused…
    expect(message).toContain("127.0.0.1:5434");
    // …but the credential is gone, replaced in place.
    expect(message).not.toContain(DB_PASSWORD);
    expect(message).toContain("//***@");
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });

  it("strips a credential from text this CLI did not compose — percent-encoded or not", async () => {
    // The wrapping error carries the FAILURE'S OWN WORDS, so the scrubber is
    // applied to text nothing here built. A driver or a proxy may quote a URL
    // in whatever form it was configured with, and neither half of a userinfo
    // has to be percent-encoded to be accepted: `new URL` splits it at the LAST
    // `@`, so `pw@with@ats` is a password a hand-authored `.env.local` can
    // carry. A scrubber that stopped at the FIRST `@` left most of it standing.
    const literal = "postgresql://installer:pw@with@ats@127.0.0.1:5434/postgres";
    const h = harness();
    h.deps.externalDbOps = defaultExternalDbOps({
      createClient: quotingPg(literal).createClient,
    });
    let message = "";
    try {
      await run(path.join(sandbox, "at-in-password"), [
        "--infra", "external",
        "--db-url", TARGET_URL,
        "--db-name", "team_instance_a",
        "--db-template", "team_seed_template",
        "--external-db-disposable",
      ], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/ECONNREFUSED/);
    // The host survives — the operator still learns WHICH server refused…
    expect(message).toContain("//***@127.0.0.1:5434/postgres");
    // …and not one character of the password does.
    expect(message).not.toContain("pw@with@ats");
    expect(message).not.toContain("with@ats");
    expect(message).not.toContain("@ats");
    for (const line of h.lines) expect(line).not.toContain("with@ats");
  });

  it("a template still open to connections WARNS, creates anyway, and names no credential", async () => {
    const h = harness({
      databases: { team_seed_template: { template: true, allowConnections: true } },
    });
    await run(path.join(sandbox, "open-template"), [
      "--infra", "external",
      "--db-url", TARGET_URL,
      "--db-name", "team_instance_a",
      "--db-template", "team_seed_template",
      "--external-db-disposable",
    ], h);
    // A warning, never a refusal — the run may well be the lucky one.
    const warned = h.lines.filter((l) => l.includes("⚠"));
    expect(warned.some((l) => l.includes("team_seed_template") && l.includes("ALLOW_CONNECTIONS false"))).toBe(true);
    expect(h.pg.record.created).toEqual(['CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"']);
    expect(h.order).toEqual(["create-database", "setup"]);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });

  it("a server URL that names NO database says the check could not run, and still creates", async () => {
    // `postgresql://…:5434/` names a server but no database, so the guard above
    // has nothing to compare `--db-name` against. It says so out loud rather
    // than skipping in silence — and it is a warning, not a refusal: the
    // operator's own file is the only thing that could have named one.
    const dir = path.join(sandbox, "no-db-in-url");
    await run(dir, ["--infra", "external", "--no-install"], harness());
    appendFileSync(path.join(dir, ".env.local"), `SUPABASE_DB_URL=${SERVER}/\n`);

    const h = harness({ databases: { team_seed_template: { template: true } } });
    await run(dir, [
      "--infra", "external",
      "--db-name", "team_instance_a",
      "--db-template", "team_seed_template",
    ], h);

    expect(h.lines.some((l) => l.includes("⚠") && l.includes("names no database"))).toBe(true);
    expect(h.pg.record.connections).toEqual([MAINTENANCE_URL]);
    expect(h.pg.record.created).toEqual(['CREATE DATABASE "team_instance_a" TEMPLATE "team_seed_template"']);
    expect(h.order).toEqual(["create-database", "setup"]);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });
});
