// The disposable acknowledgement follows the DATABASE, not the flag that named
// it (cinatra-cli#269).
//
// `--infra=external` points setup and migrations at a database this install
// does not own and will never roll back, so it takes an eyes-open
// acknowledgement: `--external-db-disposable` when nobody is watching, a typed
// confirmation on a terminal. That gate used to be reached ONLY through
// `--db-url` — so the one way to arm it was to put a credential-bearing URL on
// the command line, where every process listing can read it, and the install
// that leaves the URL in its own `.env.local` (the road the CLI itself
// documents as "you own your own file") ran setup and migrations against
// whatever that file names with no acknowledgement at all.
//
// These tests pin the gate to the database instead: with no `--db-url` the
// target is the `SUPABASE_DB_URL` the checkout's `.env.local` carries, read by
// key, and it takes the SAME gate. The flag stands on its own, the refusals and
// the prompt name the database by its bare name — never the connection string
// it was read from, which carries the credential — and a file that names no
// database still leaves the existing "no server to create it on" message to say
// what is missing.
//
// No live PostgreSQL and no terminal: the install's child work is injected
// through `runInstall`'s `deps` seam, and the typed confirmation is answered by
// a real (fake) TTY on `process.stdin`, exactly as the teardown gate's tests do.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseInstallArgs, runInstall } from "../src/install.mjs";

// A password that must never reach a log line, a prompt or a failure message.
const DB_PASSWORD = "pw_from_the_env_file";
const SERVER = `postgresql://installer:${DB_PASSWORD}@127.0.0.1:5434`;
const TARGET_URL = `${SERVER}/team_instance_a`;

// The same, for a value the operator EXPORTED in their shell. Setup overlays the
// shell environment over `.env.local`, so this is the database it would migrate.
const EXPORTED_PASSWORD = "pw_from_the_shell";
const EXPORTED_URL = `postgresql://installer:${EXPORTED_PASSWORD}@127.0.0.1:5434/exported_target`;

/** Run `fn` with `SUPABASE_DB_URL` exported, restoring whatever was there. */
async function withExportedDbUrl(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "SUPABASE_DB_URL");
  const previous = process.env.SUPABASE_DB_URL;
  if (value === null) delete process.env.SUPABASE_DB_URL;
  else process.env.SUPABASE_DB_URL = value;
  try {
    return await fn();
  } finally {
    if (had) process.env.SUPABASE_DB_URL = previous;
    else delete process.env.SUPABASE_DB_URL;
  }
}

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
  // No SUPABASE_DB_URL: the operator's own file is the only thing that can name
  // the database on this road, which is the whole point of these tests.
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  gitIn(["init", "-b", "main"], src);
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  gitIn(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

/**
 * Answer a typed confirmation the way a real operator does: a real TTY stdin
 * carrying the exact phrase. `typedConfirm` has no dependency seam and must not
 * grow one — a dep that can turn a non-rollbackable gate into a pass is the
 * fail-open shape the gate exists to prevent. stdout is captured so the prompt
 * the operator would have read can be asserted too.
 */
async function withTypedConfirmAnswer(phrase, fn) {
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const stdoutDesc = Object.getOwnPropertyDescriptor(process, "stdout");
  const input = Readable.from([`${phrase}\n`]);
  input.isTTY = true;
  const written = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });
  output.isTTY = true;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const outcome = await fn().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    return { ...outcome, prompt: written.join("") };
  } finally {
    Object.defineProperty(process, "stdin", stdinDesc);
    Object.defineProperty(process, "stdout", stdoutDesc);
  }
}

describe("cinatra-cli#269 — the acknowledgement an external database takes, whichever source named it", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-external-ack-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  /** Record what the install did, and everything it printed. */
  function harness() {
    const order = [];
    const lines = [];
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
    };
    return { order, lines, deps, log: (l) => lines.push(String(l)) };
  }

  const run = (dir, extraArgs, h) =>
    runInstall(["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", ...extraArgs], {
      log: h.log,
      deps: h.deps,
    });

  /** The operator's own checkout: installed once, then pointed at their server
   *  by the key in their own `.env.local` — no credential on any command line. */
  async function checkoutNamingTheDatabase(name) {
    const dir = path.join(sandbox, name);
    await run(dir, ["--yes", "--infra", "external", "--no-install"], harness());
    appendFileSync(path.join(dir, ".env.local"), `SUPABASE_DB_URL=${TARGET_URL}\n`);
    return dir;
  }

  it("the flag stands on its own: no --db-url is needed to give it", () => {
    const opts = parseInstallArgs(["--infra=external", "--external-db-disposable"]);
    expect(opts.externalDbDisposable).toBe(true);
    expect(opts.external.dbUrl).toBeNull();
  });

  it("no --db-url, a database in .env.local, a bare --yes: refused before setup, by name", async () => {
    const dir = await checkoutNamingTheDatabase("bare-yes");
    const h = harness();
    let message = "";
    try {
      await run(dir, ["--yes", "--infra", "external"], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/--external-db-disposable/);
    expect(message).toMatch(/team_instance_a/);
    // The bare NAME, never the connection it was read from.
    expect(message).not.toContain(DB_PASSWORD);
    expect(message).not.toContain("127.0.0.1");
    // Refused BEFORE setup + migrations could touch that database.
    expect(h.order).toEqual([]);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
  });

  it("the same run with no --yes and no terminal is refused too, and names both", async () => {
    const dir = await checkoutNamingTheDatabase("no-tty");
    const h = harness();
    let message = "";
    try {
      await run(dir, ["--infra", "external", "--execution-mode", "disabled"], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/--external-db-disposable/);
    expect(message).toMatch(/team_instance_a/);
    expect(message).not.toContain(DB_PASSWORD);
    expect(h.order).toEqual([]);
  });

  it("with --external-db-disposable the install runs, and the acknowledgement names the database", async () => {
    const dir = await checkoutNamingTheDatabase("acknowledged");
    const h = harness();
    await run(dir, ["--yes", "--infra", "external", "--external-db-disposable"], h);
    expect(h.order).toEqual(["setup"]);
    const ack = h.lines.filter((l) => l.includes("team_instance_a") && l.includes("disposable"));
    expect(ack.length).toBeGreaterThan(0);
    for (const line of h.lines) expect(line).not.toContain(DB_PASSWORD);
    // The operator's own file is still theirs: the install rewrote nothing.
    expect(ack.some((l) => l.includes(SERVER))).toBe(false);
  });

  it("a typed confirmation on a terminal arms it too, and the prompt names the database", async () => {
    const dir = await checkoutNamingTheDatabase("typed-confirm");
    const h = harness();
    const { error, prompt } = await withTypedConfirmAnswer("I understand", () =>
      run(dir, ["--infra", "external", "--execution-mode", "disabled"], h),
    );
    expect(error).toBeUndefined();
    expect(h.order).toEqual(["setup"]);
    expect(prompt).toMatch(/team_instance_a/);
    expect(prompt).toMatch(/I understand/);
    expect(prompt).not.toContain(DB_PASSWORD);
  });

  it("--db-url is unchanged — still refused on a bare --yes, now naming the database", async () => {
    const h = harness();
    let message = "";
    try {
      await run(path.join(sandbox, "db-url-bare-yes"), [
        "--yes", "--infra", "external",
        "--db-url", TARGET_URL,
      ], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/--external-db-disposable/);
    expect(message).toMatch(/team_instance_a/);
    expect(message).not.toContain(DB_PASSWORD);
    expect(h.order).toEqual([]);
  });

  // The residual the file-only read left behind: setup resolves its environment
  // the way `collectEnvironment` does — the checkout's `.env.local` OVERLAID BY
  // `process.env` — so an EXPORTED SUPABASE_DB_URL is the database setup and
  // migrations actually write to. A gate that read only the file would have the
  // operator acknowledge one database while setup mutated another.
  it("an EXPORTED SUPABASE_DB_URL is what setup migrates, so it is what the gate names", async () => {
    const dir = await checkoutNamingTheDatabase("exported-wins");
    const h = harness();
    const message = await withExportedDbUrl(EXPORTED_URL, async () => {
      try {
        await run(dir, ["--yes", "--infra", "external"], h);
        return "";
      } catch (err) {
        return err.message;
      }
    });
    expect(message).toMatch(/--external-db-disposable/);
    // The database setup would REALLY write to — not the one the file names.
    expect(message).toMatch(/exported_target/);
    expect(message).not.toMatch(/team_instance_a/);
    expect(message).toMatch(/exported SUPABASE_DB_URL/);
    // Still by name only: neither credential reaches a message or a log line.
    expect(message).not.toContain(EXPORTED_PASSWORD);
    expect(message).not.toContain(DB_PASSWORD);
    expect(h.order).toEqual([]);
    for (const line of h.lines) {
      expect(line).not.toContain(EXPORTED_PASSWORD);
      expect(line).not.toContain(DB_PASSWORD);
    }
  });

  it("acknowledging it names the exported database, and the run proceeds", async () => {
    const dir = await checkoutNamingTheDatabase("exported-acknowledged");
    const h = harness();
    await withExportedDbUrl(EXPORTED_URL, () =>
      run(dir, ["--yes", "--infra", "external", "--external-db-disposable"], h),
    );
    expect(h.order).toEqual(["setup"]);
    const ack = h.lines.filter((l) => l.includes("exported_target") && l.includes("disposable"));
    expect(ack.length).toBeGreaterThan(0);
    for (const line of h.lines) expect(line).not.toContain(EXPORTED_PASSWORD);
  });

  it("an exported SUPABASE_DB_URL that is empty leaves the file's database as the target", async () => {
    const dir = await checkoutNamingTheDatabase("exported-empty");
    const h = harness();
    const message = await withExportedDbUrl("   ", async () => {
      try {
        await run(dir, ["--yes", "--infra", "external"], h);
        return "";
      } catch (err) {
        return err.message;
      }
    });
    expect(message).toMatch(/team_instance_a/);
    expect(message).toMatch(/SUPABASE_DB_URL in \.env\.local/);
    expect(h.order).toEqual([]);
  });

  it("nothing names a database: nothing to acknowledge, and the creation error still says what is missing", async () => {
    // `--external-db-disposable` on its own, no --db-url, and a checkout whose
    // `.env.local` carries no SUPABASE_DB_URL: the gate has no target, so it
    // stands aside — and the database creation says what it needs, exactly as
    // it did before.
    const h = harness();
    let message = "";
    try {
      await run(path.join(sandbox, "nothing-named"), [
        "--yes", "--infra", "external", "--external-db-disposable",
        "--db-name", "team_instance_a", "--db-template", "team_seed_template",
      ], h);
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/needs a PostgreSQL server/);
    expect(message).toMatch(/carries no SUPABASE_DB_URL/);
    expect(h.order).toEqual([]);
  });
});
