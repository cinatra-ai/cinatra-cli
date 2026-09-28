// cinatra-cli#291 — a development install turns the product's email safety
// switch on, so a development installation (and the preview composition, which
// performs one) never delivers email to a stored recipient by default.
//
// WHAT THESE ARMS PIN
// -------------------
//   E1  the address and its source: the flag wins over the variable, the
//       variable over the reserved default; an empty or malformed value is
//       refused by name and never echoed; the parser refuses the flag on a
//       production or co-use install and never reads the variable for
//       production; the flag's value is never read as the mode positional.
//   E2  the write: INSERT-IF-ABSENT of the product's value shape under the
//       product's key, in the instance schema; a stored setting is kept (on or
//       off) and never overwritten; exactly one line, naming the source and
//       never the address; demo is a development install too; production and
//       any other mode touch nothing.
//   E3  fail closed: no database named, or a failing statement, is a named
//       error that carries neither the connection string nor the address.
//   E4  the install, end to end over a fake database: a fresh development boot
//       reads the switch on with the default address; the flag and the
//       variable each set the address, the flag first; a re-run keeps a stored
//       setting; a production install stores nothing; the printed line names
//       the source and not the address; a failed write fails the install.
//   E5  wiring: right after the setup child and before the Twenty CRM; the
//       preview composition writes it before its preview step; never under
//       --no-install, --no-setup or --dry-run; `instance refresh` resolves the
//       variable before it changes anything and writes once after its reconcile.
//   E6  the install help lists the flag.
//
// Hermetic: no database, no Docker, no network. The database is a fake that
// keeps the product's key/value `metadata` rows in a Map and answers the two
// statements the step issues.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  EMAIL_RECIPIENT_OVERRIDE_DEFAULT as DEFAULT_ADDRESS,
  EMAIL_RECIPIENT_OVERRIDE_ENV as VARIABLE,
  EMAIL_RECIPIENT_OVERRIDE_FLAG as FLAG,
  EMAIL_SAFETY_SETTING_KEY as SETTING_KEY,
  emailSafetySetting,
  ensureDevEmailSafety,
  resolveEmailRecipientOverride,
} from "../src/dev-email-safety.mjs";
import { parseInstallArgs, runInstall } from "../src/install.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, "..");

const FLAG_ADDRESS = "flag-inbox@example.com";
const VARIABLE_ADDRESS = "variable-inbox@example.com";
const STORED_ADDRESS = "chosen-on-the-page@example.com";
// The database the fixture checkout names. No user and no password in it.
const FIXTURE_DB_URL = "postgresql://localhost:5434/postgres";
const FIXTURE_SCHEMA = "inst_schema";
const FIXTURE_TABLE = `"${FIXTURE_SCHEMA}"."metadata"`;
const INSERT_IF_ABSENT = /^INSERT INTO \S+ \(key, value\) VALUES \(\$1, \$2\) ON CONFLICT \(key\) DO NOTHING RETURNING key$/;
const SELECT_STORED = /^SELECT value FROM \S+ WHERE key = \$1$/;

/** A fake instance database: the product's key/value `metadata` rows. */
function fakeDatabase(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const statements = [];
  let failure = null;
  const query = async (text, values = []) => {
    statements.push({ text, values: [...values] });
    if (failure) throw failure;
    if (INSERT_IF_ABSENT.test(text)) {
      const [key, value] = values;
      if (rows.has(key)) return { rows: [], rowCount: 0 };
      rows.set(key, value);
      return { rows: [{ key }], rowCount: 1 };
    }
    if (SELECT_STORED.test(text)) {
      const [key] = values;
      return rows.has(key) ? { rows: [{ value: rows.get(key) }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected statement: ${text}`);
  };
  return { rows, statements, query, failWith: (err) => (failure = err) };
}

/** The switch as the product reads it: an absent or unreadable row is `{}`,
 *  and only an exact `true` turns the switch on. */
function productReading(db) {
  let stored = {};
  try {
    const raw = db.rows.get(SETTING_KEY);
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  return {
    developmentModeEnabled: stored.developmentModeEnabled === true,
    overrideRecipientEmail: String(stored.overrideRecipientEmail ?? "").trim(),
  };
}

const safetyLines = (lines) => lines.filter((l) => l.startsWith("- Email safety:"));

let sandbox;
const savedEnv = {};
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-email-safety-"));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of ["CINATRA_INSTANCE_REGISTRY", "CINATRA_ALLOC_LOCK", "CINATRA_RUNTIME_MODE", VARIABLE]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env[VARIABLE];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// E1 — the override address and its source.
// ---------------------------------------------------------------------------
describe("E1 the override address and its source", () => {
  it("E1: the flag wins over the variable, the variable over the default", () => {
    expect(resolveEmailRecipientOverride({ flagValue: FLAG_ADDRESS, env: { [VARIABLE]: VARIABLE_ADDRESS } })).toEqual({
      address: FLAG_ADDRESS,
      source: "flag",
    });
    expect(resolveEmailRecipientOverride({ env: { [VARIABLE]: VARIABLE_ADDRESS } })).toEqual({
      address: VARIABLE_ADDRESS,
      source: "variable",
    });
    expect(resolveEmailRecipientOverride({ env: {} })).toEqual({ address: DEFAULT_ADDRESS, source: "default" });
    expect(resolveEmailRecipientOverride()).toEqual({ address: DEFAULT_ADDRESS, source: "default" });
  });

  it("E1: the default is an address under the reserved .invalid top-level domain", () => {
    expect(DEFAULT_ADDRESS).toBe("nobody@example.invalid");
    expect(DEFAULT_ADDRESS.split("@")[1].endsWith(".invalid")).toBe(true);
  });

  it("E1: surrounding whitespace is trimmed from either source", () => {
    expect(resolveEmailRecipientOverride({ flagValue: `  ${FLAG_ADDRESS} ` }).address).toBe(FLAG_ADDRESS);
    expect(resolveEmailRecipientOverride({ env: { [VARIABLE]: `${VARIABLE_ADDRESS}\n` } }).address).toBe(VARIABLE_ADDRESS);
  });

  it("E1: an empty or malformed value is refused, named by its source, and never echoed", () => {
    const bad = [
      "",
      "   ",
      "no-at-sign",
      "two@@example.com",
      "first@example.com,second@example.com",
      "Some One <someone@example.com>",
      "someone@exa mple.com",
      "someone@",
    ];
    for (const value of bad) {
      for (const [args, name] of [
        [{ flagValue: value }, FLAG],
        [{ env: { [VARIABLE]: value } }, VARIABLE],
      ]) {
        let thrown = null;
        try {
          resolveEmailRecipientOverride(args);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, `${name}=${JSON.stringify(value)}`).toBeInstanceOf(Error);
        expect(thrown.message).toContain(name);
        if (value.trim()) expect(thrown.message).not.toContain(value.trim());
      }
    }
  });

  it("E1: the install parser resolves it for dev, demo and preview, and refuses the flag for prod", () => {
    expect(parseInstallArgs(["--mode", "dev"]).emailRecipientOverride).toEqual({ address: DEFAULT_ADDRESS, source: "default" });
    expect(parseInstallArgs(["--mode", "demo", FLAG, FLAG_ADDRESS]).emailRecipientOverride).toEqual({
      address: FLAG_ADDRESS,
      source: "flag",
    });
    expect(parseInstallArgs(["--mode", "preview", `${FLAG}=${FLAG_ADDRESS}`]).emailRecipientOverride).toEqual({
      address: FLAG_ADDRESS,
      source: "flag",
    });
    process.env[VARIABLE] = VARIABLE_ADDRESS;
    expect(parseInstallArgs(["--mode", "dev"]).emailRecipientOverride).toEqual({ address: VARIABLE_ADDRESS, source: "variable" });
    expect(() => parseInstallArgs(["--mode", "prod", FLAG, FLAG_ADDRESS])).toThrow(/applies only to a development install/);
    expect(parseInstallArgs(["--mode", "prod"]).emailRecipientOverride).toBeNull();
  });

  it("E1: a production install never reads the variable, so a malformed one is left alone there", () => {
    process.env[VARIABLE] = "not an address";
    expect(parseInstallArgs(["--mode", "prod"]).emailRecipientOverride).toBeNull();
    expect(() => parseInstallArgs(["--mode", "dev"])).toThrow(VARIABLE);
  });

  it("E1: the flag is refused beside co-use, whose own tail does not write the setting", () => {
    expect(() => parseInstallArgs(["--on-conflict=co-use", FLAG, FLAG_ADDRESS])).toThrow(/cannot be combined with co-use/);
    expect(() => parseInstallArgs(["--infra=share", FLAG, FLAG_ADDRESS])).toThrow(/cannot be combined with co-use/);
  });

  it("E1: a bare or empty flag is refused, and its value is never read as the mode positional", () => {
    expect(() => parseInstallArgs([FLAG])).toThrow(/requires a value/);
    expect(() => parseInstallArgs([FLAG, "--yes"])).toThrow(/requires a value/);
    expect(() => parseInstallArgs([`${FLAG}=`])).toThrow(/given but empty/);
    const opts = parseInstallArgs(["demo", FLAG, FLAG_ADDRESS]);
    expect(opts.mode).toBe("demo");
    expect(opts.emailRecipientOverride).toEqual({ address: FLAG_ADDRESS, source: "flag" });
  });
});

// ---------------------------------------------------------------------------
// E2 — the write.
// ---------------------------------------------------------------------------
describe("E2 ensureDevEmailSafety — insert-if-absent of the product's setting", () => {
  const instanceEnv = { SUPABASE_DB_URL: FIXTURE_DB_URL, SUPABASE_SCHEMA: FIXTURE_SCHEMA };

  async function ensure({ db, mode = "dev", override = null, readEnv = async () => instanceEnv, processEnv = {} } = {}) {
    const lines = [];
    const result = await ensureDevEmailSafety({
      targetDir: sandbox,
      mode,
      override,
      log: (l) => lines.push(String(l)),
      deps: { query: db.query, readEnv, processEnv },
    });
    return { result, lines };
  }

  it("E2: nothing stored -> ONE insert-if-absent of the product's shape, key and schema; the product reads it on", async () => {
    const db = fakeDatabase();
    const { result, lines } = await ensure({ db });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0].text).toMatch(INSERT_IF_ABSENT);
    expect(db.statements[0].text).toContain(`INSERT INTO ${FIXTURE_TABLE} `);
    expect(db.statements[0].values).toEqual([
      "connector_config:email-system-development",
      '{"developmentModeEnabled":true,"overrideRecipientEmail":"nobody@example.invalid"}',
    ]);
    expect(productReading(db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: DEFAULT_ADDRESS });
    expect(result).toEqual({ action: "written", source: "default", switchOn: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- Email safety: the switch is on; .*default recipient override/);
    expect(lines[0]).not.toContain(DEFAULT_ADDRESS);
  });

  it("E2: the stored value is the shape and key order the product's own page writes", () => {
    expect(JSON.stringify(emailSafetySetting(FLAG_ADDRESS))).toBe(
      `{"developmentModeEnabled":true,"overrideRecipientEmail":"${FLAG_ADDRESS}"}`,
    );
  });

  it("E2: a stored setting is kept as it is — on with another address, and off — and never overwritten", async () => {
    const on = JSON.stringify({ developmentModeEnabled: true, overrideRecipientEmail: STORED_ADDRESS });
    const dbOn = fakeDatabase({ [SETTING_KEY]: on });
    const kept = await ensure({ db: dbOn, override: { address: FLAG_ADDRESS, source: "flag" } });
    expect(dbOn.rows.get(SETTING_KEY)).toBe(on);
    expect(kept.result).toEqual({ action: "kept", source: "flag", switchOn: true });
    expect(kept.lines).toEqual([`- Email safety: the stored setting is kept as it is (the switch is on); ${FLAG} was not applied.`]);

    const off = JSON.stringify({ developmentModeEnabled: false, overrideRecipientEmail: "" });
    const dbOff = fakeDatabase({ [SETTING_KEY]: off });
    const keptOff = await ensure({ db: dbOff });
    expect(dbOff.rows.get(SETTING_KEY)).toBe(off);
    expect(productReading(dbOff).developmentModeEnabled).toBe(false);
    expect(keptOff.result).toEqual({ action: "kept", source: "default", switchOn: false });
    expect(keptOff.lines).toHaveLength(1);
    expect(keptOff.lines[0]).toMatch(/the switch is off; tick "Override recipient email" at \/configuration\/development/);

    for (const { text } of [...dbOn.statements, ...dbOff.statements]) {
      expect(INSERT_IF_ABSENT.test(text) || SELECT_STORED.test(text), text).toBe(true);
    }
    for (const line of [...kept.lines, ...keptOff.lines]) {
      expect(line).not.toContain(FLAG_ADDRESS);
      expect(line).not.toContain(STORED_ADDRESS);
    }
  });

  it("E2: the schema defaults to cinatra, and a quoted schema name stays one identifier", async () => {
    const plain = fakeDatabase();
    await ensure({ db: plain, readEnv: async () => ({ SUPABASE_DB_URL: FIXTURE_DB_URL }) });
    expect(plain.statements[0].text).toContain('INSERT INTO "cinatra"."metadata" ');
    const quoted = fakeDatabase();
    await ensure({ db: quoted, readEnv: async () => ({ SUPABASE_DB_URL: FIXTURE_DB_URL, SUPABASE_SCHEMA: 'we"ird' }) });
    expect(quoted.statements[0].text).toContain('INSERT INTO "we""ird"."metadata" ');
  });

  it("E2: the database is the checkout's .env.local overlaid by the process environment, as setup reads it", async () => {
    const dir = mkdtempSync(path.join(sandbox, "e2-env-"));
    writeFileSync(path.join(dir, ".env.local"), `SUPABASE_DB_URL=${FIXTURE_DB_URL}\nSUPABASE_SCHEMA=file_schema\n`);
    const db = fakeDatabase();
    await ensureDevEmailSafety({ targetDir: dir, log: () => {}, deps: { query: db.query, processEnv: {} } });
    expect(db.statements[0].text).toContain('INSERT INTO "file_schema"."metadata" ');
    const overlaid = fakeDatabase();
    await ensureDevEmailSafety({
      targetDir: dir,
      log: () => {},
      deps: { query: overlaid.query, processEnv: { SUPABASE_SCHEMA: "exported_schema" } },
    });
    expect(overlaid.statements[0].text).toContain('INSERT INTO "exported_schema"."metadata" ');
  });

  it("E2: without an override from the install (the refresh road), the variable and then the default are used", async () => {
    const db = fakeDatabase();
    const { result, lines } = await ensure({ db, processEnv: { [VARIABLE]: VARIABLE_ADDRESS } });
    expect(productReading(db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: VARIABLE_ADDRESS });
    expect(result.source).toBe("variable");
    expect(lines).toEqual([`- Email safety: the switch is on; outgoing email goes to the recipient override set from ${VARIABLE}.`]);
  });

  it("E2: demo is a development install too; production and any other mode touch nothing", async () => {
    const demo = fakeDatabase();
    expect((await ensure({ db: demo, mode: "demo" })).result.action).toBe("written");
    expect(productReading(demo).developmentModeEnabled).toBe(true);
    for (const mode of ["prod", "preview", ""]) {
      const db = fakeDatabase();
      let envRead = false;
      const { result, lines } = await ensure({
        db,
        mode,
        readEnv: async () => {
          envRead = true;
          return instanceEnv;
        },
      });
      expect(result.action, mode).toBe("skipped");
      expect(db.statements, mode).toHaveLength(0);
      expect(envRead, mode).toBe(false);
      expect(lines, mode).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// E3 — fail closed.
// ---------------------------------------------------------------------------
describe("E3 ensureDevEmailSafety — fails closed, and says why without secrets", () => {
  it("E3: no database named -> a named error, and nothing is queried", async () => {
    const db = fakeDatabase();
    await expect(
      ensureDevEmailSafety({ targetDir: sandbox, log: () => {}, deps: { query: db.query, readEnv: async () => ({}), processEnv: {} } }),
    ).rejects.toThrow(/no instance database is named/);
    expect(db.statements).toHaveLength(0);
  });

  it("E3: a failing statement -> a named error that carries neither the connection string nor the address", async () => {
    // Built from parts through the URL setters, so no file holds a
    // credential-shaped connection string.
    const url = new URL(FIXTURE_DB_URL);
    url.username = "installer";
    url.password = "fake-pw-9";
    const db = fakeDatabase();
    db.failWith(new Error(`connect to ${url.href} with ${url.password} failed while storing ${FLAG_ADDRESS}`));
    const lines = [];
    let thrown = null;
    try {
      await ensureDevEmailSafety({
        targetDir: sandbox,
        override: { address: FLAG_ADDRESS, source: "flag" },
        log: (l) => lines.push(String(l)),
        deps: { query: db.query, readEnv: async () => ({ SUPABASE_DB_URL: url.href }), processEnv: {} },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/^Email safety: could not store the email safety setting in the instance database/);
    expect(thrown.message).not.toContain(url.href);
    expect(thrown.message).not.toContain(url.password);
    expect(thrown.message).not.toContain(FLAG_ADDRESS);
    expect(safetyLines(lines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E4 + E5 — the install over a fake database, and its wiring.
// ---------------------------------------------------------------------------
function gitIn(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// The package name the install recognises a checkout by (its migrations package).
const MIGRATIONS_PACKAGE = ["@cinatra-ai", "migrations"].join("/");

/** A checkout origin whose `.env.example` names the instance database. */
function buildFixtureOrigin(root) {
  const src = path.join(root, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(path.join(src, "packages", "migrations", "package.json"), JSON.stringify({ name: MIGRATIONS_PACKAGE, version: "0.0.0" }));
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }));
  writeFileSync(
    path.join(src, ".env.example"),
    `BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\nSUPABASE_DB_URL=${FIXTURE_DB_URL}\nSUPABASE_SCHEMA=${FIXTURE_SCHEMA}\n`,
  );
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  gitIn(["init", "-b", "main"], src);
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "init"], src);
  const originRepo = path.join(root, "origin.git");
  gitIn(["clone", "--bare", src, originRepo], root);
  return originRepo;
}

describe("E4 + E5 the install over a fake database", () => {
  let root;
  let originRepo;

  beforeAll(() => {
    root = mkdtempSync(path.join(sandbox, "install-"));
    originRepo = buildFixtureOrigin(root);
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(root, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
    delete process.env.CINATRA_RUNTIME_MODE;
  });

  /** The Twenty CRM suite's recording harness; the email safety step is the
   *  REAL one, over the fake database. */
  function harness({ db = fakeDatabase(), extra = {} } = {}) {
    const order = [];
    const lines = [];
    const deps = {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
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
      acquireProdExtensions: () => {},
      syncDevExtensions: async () => ({ skipped: true, reason: "no declared dev extensions", results: [] }),
      pnpmInstall: () => order.push("pnpm"),
      runSetupInTarget: () => {
        order.push("setup");
        return { tolerated: true, registrySkew: false, lines: [] };
      },
      ensureDevTwentyCrm: async () => {
        order.push("twenty");
        return { action: "stubbed" };
      },
      emailSafetyDeps: {
        query: async (text, values) => {
          if (!order.includes("email-safety")) order.push("email-safety");
          return db.query(text, values);
        },
        // The instance database comes from the checkout's .env.local alone,
        // whatever the shell running this suite exports.
        processEnv: {},
      },
      ...extra,
    };
    return { db, deps, order, lines, log: (l) => lines.push(String(l)) };
  }

  const install = (dir, extraArgs, h) =>
    runInstall(["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", ...extraArgs], {
      log: h.log,
      deps: h.deps,
    });

  const noLineHolds = (lines, ...addresses) => {
    for (const line of lines) for (const address of addresses) expect(line, line).not.toContain(address);
  };

  it("E4: a fresh development boot reads the switch on with the default address, and says so without it", async () => {
    const h = harness();
    await install(path.join(root, "fresh"), [], h);
    expect(productReading(h.db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: DEFAULT_ADDRESS });
    expect(h.db.statements[0].text).toContain(`INSERT INTO ${FIXTURE_TABLE} `);
    expect(safetyLines(h.lines)).toEqual([
      "- Email safety: the switch is on; outgoing email goes to the default recipient override, a reserved address that no mail system delivers to.",
    ]);
    noLineHolds(h.lines, DEFAULT_ADDRESS);
  });

  it("E4: --email-recipient-override sets the address, and wins over the variable", async () => {
    process.env[VARIABLE] = VARIABLE_ADDRESS;
    const h = harness();
    await install(path.join(root, "flag"), [FLAG, FLAG_ADDRESS], h);
    expect(productReading(h.db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: FLAG_ADDRESS });
    expect(safetyLines(h.lines)).toEqual([`- Email safety: the switch is on; outgoing email goes to the recipient override set from ${FLAG}.`]);
    noLineHolds(h.lines, FLAG_ADDRESS, VARIABLE_ADDRESS);
  });

  it("E4: CINATRA_EMAIL_RECIPIENT_OVERRIDE sets the address when no flag is given", async () => {
    process.env[VARIABLE] = VARIABLE_ADDRESS;
    const h = harness();
    await install(path.join(root, "variable"), [], h);
    expect(productReading(h.db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: VARIABLE_ADDRESS });
    expect(safetyLines(h.lines)).toEqual([`- Email safety: the switch is on; outgoing email goes to the recipient override set from ${VARIABLE}.`]);
    noLineHolds(h.lines, VARIABLE_ADDRESS);
  });

  it("E4: a re-run keeps a stored setting — a switch a person turned off stays off, with its address", async () => {
    const dir = path.join(root, "upgrade");
    const db = fakeDatabase();
    await install(dir, [], harness({ db }));
    expect(productReading(db).developmentModeEnabled).toBe(true);
    // A person unticks the switch on the page and types another address.
    const chosen = JSON.stringify({ developmentModeEnabled: false, overrideRecipientEmail: STORED_ADDRESS });
    db.rows.set(SETTING_KEY, chosen);
    const again = harness({ db });
    await install(dir, [FLAG, FLAG_ADDRESS], again);
    expect(db.rows.get(SETTING_KEY)).toBe(chosen);
    expect(productReading(db)).toEqual({ developmentModeEnabled: false, overrideRecipientEmail: STORED_ADDRESS });
    const [line, ...rest] = safetyLines(again.lines);
    expect(rest).toEqual([]);
    expect(line).toMatch(/^- Email safety: the stored setting is kept as it is \(the switch is off; /);
    expect(line).toContain(`${FLAG} was not applied`);
    noLineHolds(again.lines, FLAG_ADDRESS, STORED_ADDRESS);
    for (const { text } of db.statements) expect(INSERT_IF_ABSENT.test(text) || SELECT_STORED.test(text), text).toBe(true);
  });

  it("E4: a production install stores nothing for the setting — even with the variable set", async () => {
    process.env[VARIABLE] = "not an address";
    const h = harness();
    await install(
      path.join(root, "prod"),
      ["--mode", "prod", "--infra", "external", "--db-url", "postgresql://localhost:5434/inst", "--external-db-disposable"],
      h,
    );
    expect(h.order).toContain("setup");
    expect(h.order).not.toContain("email-safety");
    expect(h.db.statements).toEqual([]);
    expect(safetyLines(h.lines)).toEqual([]);
  });

  it("E4: a write that cannot be made fails the install, before the Twenty CRM", async () => {
    const db = fakeDatabase();
    db.failWith(new Error("connection refused"));
    const h = harness({ db });
    await expect(install(path.join(root, "fails"), [], h)).rejects.toThrow(/could not store the email safety setting/);
    expect(h.order).toContain("email-safety");
    expect(h.order).not.toContain("twenty");
  });

  it("E5: it runs right after the setup child and before the Twenty CRM", async () => {
    const h = harness();
    await install(path.join(root, "order"), [], h);
    expect(h.order.indexOf("email-safety")).toBe(h.order.indexOf("setup") + 1);
    expect(h.order.indexOf("twenty")).toBe(h.order.indexOf("email-safety") + 1);
  });

  it("E5: the preview composition writes it (as the dev install it performs) before its preview step", async () => {
    const h = harness({
      extra: {
        previewDeps: {
          readCheckoutEnvMode: () => {
            h.order.push("preview");
            throw new Error("preview-sentinel");
          },
        },
      },
    });
    await expect(install(path.join(root, "preview"), ["--mode", "preview", FLAG, FLAG_ADDRESS], h)).rejects.toThrow(
      /preview-sentinel/,
    );
    expect(productReading(h.db)).toEqual({ developmentModeEnabled: true, overrideRecipientEmail: FLAG_ADDRESS });
    expect(h.order.indexOf("email-safety")).toBeLessThan(h.order.indexOf("preview"));
  });

  it("E5: never under --no-install, --no-setup or --dry-run (while a plain install writes it)", async () => {
    const control = harness();
    await install(path.join(root, "skip-control"), [], control);
    expect(control.db.statements.length).toBeGreaterThan(0);
    for (const flag of ["--no-install", "--no-setup", "--dry-run"]) {
      const h = harness();
      await install(path.join(root, `skip${flag}`), [flag], h);
      expect(h.db.statements, flag).toEqual([]);
      expect(safetyLines(h.lines), flag).toEqual([]);
    }
  });

  it("E5: instance refresh resolves the variable before it changes anything, and writes once after its reconcile", () => {
    const source = readFileSync(path.join(CLI_ROOT, "src", "index.mjs"), "utf8");
    const start = source.indexOf("async function runDevRefresh(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body.match(/ensureDevEmailSafety\(/g) ?? []).toHaveLength(1);
    const reconcile = body.indexOf('await runSetup("dev"');
    expect(reconcile).toBeGreaterThan(-1);
    expect(body.indexOf("ensureDevEmailSafety(")).toBeGreaterThan(reconcile);
    const resolved = body.indexOf("resolveEmailRecipientOverride(");
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(body.indexOf("- Infrastructure"));
  });
});

// ---------------------------------------------------------------------------
// E6 — the install help.
// ---------------------------------------------------------------------------
describe("E6 install help", () => {
  it("E6: `cinatra --help` lists --email-recipient-override with its description", () => {
    const out = execFileSync(process.execPath, [path.join(CLI_ROOT, "bin", "cinatra.mjs"), "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(out).toContain("[--email-recipient-override <address>]");
    expect(out).toMatch(/--email-recipient-override <address>\s+The address the email safety switch/);
  });
});
