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
    // eng#232 (renamed cinatra-cli#61): Class-C bootstrap commands are namespaced
    // under `cinatra instance …`.
    [["instance", "setup", "dev", "--help"], "cinatra instance setup"], // command+mode+sub (dev|prod alt), destructive
    [["instance", "db", "migrate", "--help"], "cinatra instance db migrate"], // command+mode+sub, destructive
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

  it("a hidden descriptor (`setup` no-mode) with --help shows the full banner, not a synopsis", () => {
    // `setup --help` matches the hidden `command-no-mode` descriptor; printCommandHelp
    // falls back to the full banner rather than advertise a hidden entry.
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

  // eng#232 (renamed cinatra-cli#61): a DEPRECATED bare alias (`setup dev`,
  // `db migrate`, …) with --help must still short-circuit (footgun guard: exit 0,
  // NO side effect) and resolve to the CANONICAL `instance …` synopsis, steering
  // the user to the new form.
  const aliasHelpCases = [
    [["setup", "dev", "--help"], "cinatra instance setup"],
    [["db", "migrate", "--help"], "cinatra instance db migrate"],
    [["clone", "prune", "--help"], "cinatra instance clone prune"],
    [["reset", "dev", "--help"], "cinatra instance reset"],
    [["backup", "import", "--help"], "cinatra instance backup import"],
  ];

  it.each(aliasHelpCases)(
    "deprecated alias `%j --help` exits 0, shows the canonical synopsis, no side effect",
    (args, canonicalToken) => {
      const res = runHelp(args);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain(canonicalToken);
      expect(res.stdout).toMatch(/deprecated form/i);
      expect(res.stdout).toMatch(/Usage:/i);
      assertNoSideEffect();
    },
  );
});
