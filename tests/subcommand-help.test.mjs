// `cinatra <subcommand> --help|-h` must print usage and exit 0 WITHOUT running
// the handler (cinatra#255 footgun). Before this guard, `--help` was an unknown
// flag the per-command arg parsers silently ignored, so the handler EXECUTED —
// for `install` that meant a real from-zero install kicked off (it clones the
// cinatra repo and starts Docker) the moment a user typed `cinatra install
// --help`. These tests pin that a help flag short-circuits to usage with NO
// side effect, across every matcher shape plus the destructive commands.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// Each test runs the CLI inside a FRESH empty temp dir with a sabotaged PATH so
// that any attempt to actually perform work (git clone, docker, pnpm) is both
// observable (the dir would gain a `cinatra/` checkout) and unable to succeed.
// A correct `--help` short-circuit never touches the dir and exits 0 fast.
let workdir;
const created = [];

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "cinatra-help-"));
  created.push(workdir);
});

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function runHelp(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: workdir,
    timeout: 30_000,
    env: {
      ...process.env,
      // Force any spawned tool lookup to fail fast rather than do real work,
      // and keep installers non-interactive. A correct short-circuit never gets
      // far enough to consult these.
      PATH: workdir,
      CI: "1",
    },
  });
}

// The temp dir must remain empty (no `cinatra/` checkout, no `.env.local`, no
// docker artifacts) — proof that no handler side effect ran.
function assertNoSideEffect() {
  const entries = readdirSync(workdir);
  expect(entries, `temp dir should be untouched, saw: ${entries.join(", ")}`).toEqual([]);
  expect(existsSync(path.join(workdir, "cinatra"))).toBe(false);
  expect(existsSync(path.join(workdir, ".env.local"))).toBe(false);
}

describe("cinatra install --help (the footgun)", () => {
  it("exits 0 and performs NO install/clone/docker side effect", () => {
    const res = runHelp(["install", "--help"]);
    expect(res.status).toBe(0);
    // Prints usage for the install command, NOT the install's own progress.
    expect(res.stdout).toContain("cinatra install");
    expect(res.stdout).toMatch(/Usage:/i);
    // It must NOT have started a real install.
    expect(res.stdout).not.toContain("Checking requirements");
    expect(res.stderr).not.toMatch(/git clone/i);
    assertNoSideEffect();
  });

  it("`-h` is also honored (no install side effect)", () => {
    const res = runHelp(["install", "-h"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cinatra install");
    expect(res.stdout).not.toContain("Checking requirements");
    assertNoSideEffect();
  });
});

describe("cinatra <subcommand> --help across matcher shapes", () => {
  // [argv, expected usage token] — one per match kind plus more destructive cmds.
  const cases = [
    [["install", "--help"], "cinatra install"], // command, destructive
    [["update", "--help"], "cinatra update"], // command, moves git + reconciles — must NOT run on --help
    [["upgrade", "--help"], "cinatra upgrade"], // command, alias of update — same footgun guard
    // The command-routing contract (renamed cinatra-cli#61): Class-C bootstrap
    // commands are namespaced under `cinatra instance …`. cinatra-cli#62: the
    // branch lifecycle was renamed to `instance branch setup|teardown` (the
    // `command+mode+sub` shape here).
    [["instance", "branch", "setup", "--help"], "cinatra instance branch setup"], // command+mode+sub, destructive
    [["instance", "branch", "teardown", "--help"], "cinatra instance branch teardown"], // command+mode+sub, destructive
    [["instance", "db", "migrate", "--help"], "cinatra instance db migrate"], // command+mode+sub, destructive
    [["instance", "db", "upgrade-preflight", "--help"], "cinatra instance db upgrade-preflight"], // command+mode+sub, read-only — usage only, no docker/ledger read
    [["instance", "db", "upgrade-major", "--help"], "cinatra instance db upgrade-major"], // command+mode+sub, destructive transaction — must NOT run on --help
    [["instance", "clone", "prune", "--help"], "cinatra instance clone prune"], // command+mode+sub, destructive
    [["instance", "refresh", "--help"], "cinatra instance refresh"], // command+mode, destructive
    [["instance", "start", "--help"], "cinatra instance start"], // command+mode, spawns pnpm dev — must NOT run on --help
    [["instance", "stop", "--help"], "cinatra instance stop"], // command+mode, sends signals — must NOT run on --help
    [["instance", "restart", "--help"], "cinatra instance restart"], // command+mode, stop+start — must NOT run on --help
    [["instance", "wordpress", "start", "--help"], "cinatra instance wordpress"], // command+mode, spawns docker compose — must NOT run on --help
    [["instance", "drupal", "stop", "--help"], "cinatra instance drupal"], // command+mode, spawns docker compose — must NOT run on --help
    [["instance", "backup", "import", "--help"], "cinatra instance backup import"], // command+mode+sub, destructive
    [["instance", "reset", "--help"], "cinatra instance reset"], // command+mode, destructive
    [["mcp", "llm-access", "setup", "--help"], "cinatra mcp llm-access setup"], // command+mode+sub
    [["doctor", "--help"], "cinatra doctor"], // command (read-only, still must not run)
    [["status", "-h"], "cinatra status"], // command, -h alias
    [["logs", "--help"], "cinatra logs"], // command, read-only — usage only, no log read/compose spawn
    [["agents", "list", "--help"], "cinatra agents list"], // command+mode, read-only — usage only, no lockfile read
    [["agents", "uninstall", "--help"], "cinatra agents uninstall"], // command+mode, destructive — must NOT touch DB/lockfile on --help
    [["extensions", "list", "--help"], "cinatra extensions list"], // command+mode, read-only — usage only, no fs walk
  ];

  it.each(cases)("`%j` prints usage, exits 0, no side effect", (args, token) => {
    const res = runHelp(args);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toContain(token);
    expect(res.stdout).toMatch(/Usage:/i);
    assertNoSideEffect();
  });
});

describe("cinatra <subcommand> --help edge cases", () => {
  it("an unknown command with --help falls back to the full banner (exit 0)", () => {
    const res = runHelp(["bogus", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    expect(res.stdout).toContain("Usage:");
    assertNoSideEffect();
  });

  it("a hidden descriptor (the removed `mcp tunnel` stub) with --help shows the full banner, not a synopsis", () => {
    // A hidden, summary-less descriptor has no public synopsis; printCommandHelp
    // falls back to the full banner rather than advertise a hidden entry.
    const res = runHelp(["mcp", "tunnel", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    assertNoSideEffect();
  });

  it("the bare no-mode `setup --help` routes no descriptor and falls back to the full banner", () => {
    // `["setup","--help"]` matches nothing (the no-mode `setup` form is
    // length-exact), so runCli falls through to the global banner. A trailing
    // routable token (`setup dev --help`) is what steers to `cinatra install`.
    const res = runHelp(["setup", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    assertNoSideEffect();
  });

  it("global `cinatra --help` still renders the full banner (unchanged)", () => {
    const res = runHelp(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    expect(res.stdout).toContain("cinatra install");
  });

  it("a `--help` AFTER the `--` end-of-flags separator is NOT treated as help", () => {
    // hasHelpFlag stops scanning at `--`; a help token after it is positional.
    // `install -- --help` therefore does NOT short-circuit; it dispatches to the
    // install handler, which (with no real toolchain on PATH) fails fast. The
    // point is only that it did NOT print usage — it reached the handler.
    const res = runHelp(["install", "--", "--help"]);
    expect(res.stdout).not.toMatch(/^Usage: cinatra install$/m);
  });

  // cinatra-cli#81: the old TOP-LEVEL bare forms were removed with NO back-compat.
  // They no longer route a help descriptor, so `<bare> --help` falls back to the
  // GLOBAL banner (exit 0, no side effect) — it must NOT print a "deprecated form"
  // synopsis (that mechanism is gone) and must NOT run the destructive handler.
  const removedBareHelpCases = [
    [["db", "migrate", "--help"]],
    [["clone", "prune", "--help"]],
    [["reset", "dev", "--help"]],
    [["backup", "import", "--help"]],
    [["setup", "branch", "--help"]],
    [["teardown", "branch", "--help"]],
  ];

  it.each(removedBareHelpCases)(
    "removed bare form `%j --help` exits 0, prints the GLOBAL banner, no deprecated synopsis",
    (args) => {
      const res = runHelp(args);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("Cinatra setup CLI"); // the global banner
      expect(res.stdout).not.toMatch(/deprecated form/i);
      expect(res.stdout).not.toMatch(/is now "cinatra/);
      assertNoSideEffect();
    },
  );

  // cinatra-cli#81: the removed OLD-ORDER `instance setup branch` / `instance
  // teardown branch` forms are now unknown `instance …` subcommands, so their
  // `--help` falls back to the `instance` GROUP banner (exit 0, no side effect) —
  // never a deprecated synopsis, never the destructive handler.
  const removedInstanceHelpCases = [
    [["instance", "setup", "branch", "--help"]],
    [["instance", "teardown", "branch", "--help"]],
  ];

  it.each(removedInstanceHelpCases)(
    "removed old-order form `%j --help` exits 0, prints the `instance` GROUP banner",
    (args) => {
      const res = runHelp(args);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("cinatra instance branch setup"); // group banner
      expect(res.stdout).not.toMatch(/deprecated form/i);
      expect(res.stdout).not.toMatch(/is now "cinatra/);
      assertNoSideEffect();
    },
  );

  // cinatra-cli#62: the in-repo provisioning phase (`setup dev|prod`, `setup
  // nango`) is FOLDED into `cinatra install --mode dev|prod`. Its `--help` must
  // short-circuit (exit 0, no side effect) and STEER to `cinatra install` — never
  // advertise the internal setup path. (cinatra-cli#81: the bare `setup dev` form
  // is gone, so only the namespaced `instance setup …` forms are tested here.)
  const setupPhaseHelpCases = [
    [["instance", "setup", "dev", "--help"]],
    [["instance", "setup", "prod", "--help"]],
    [["instance", "setup", "nango", "--help"]], // hidden internal phase (still routes)
  ];

  it.each(setupPhaseHelpCases)(
    "folded setup phase `%j --help` exits 0, steers to `cinatra install`, no side effect",
    (args) => {
      const res = runHelp(args);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("cinatra install --mode dev|prod");
      expect(res.stdout).toMatch(/folded into the single idempotent/i);
      // It must NOT advertise the now-internal `instance setup` path as a command.
      expect(res.stdout).not.toMatch(/Usage: cinatra instance setup/i);
      assertNoSideEffect();
    },
  );
});
