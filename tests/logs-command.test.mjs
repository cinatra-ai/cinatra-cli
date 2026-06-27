// Behavioral guard for `cinatra logs [--app | --service <name>] [--follow|-f]`
// (cinatra#12).
//
// `logs` surfaces two log sources: the dev-main app log written by
// `cinatra dev start` (a file under ~/.cinatra/clones/dev-main/nextjs.log) and
// the bundled docker-compose container logs. The container path needs a real
// Docker daemon, so these tests pin the parts that DON'T: flag parsing /
// mutual-exclusion, the command-only flag-reconstruction through the
// dispatcher (the first flag lands in the `mode` slot and must still reach the
// handler), the app-log file tail (present + absent), and the
// docker-compose-unavailable honest degrade.
//
// Each test spawns the real `bin/cinatra.mjs` (the same end-to-end harness
// `subcommand-help.test.mjs` uses) with a FAKE cinatra checkout via
// CINATRA_REPO_ROOT, an isolated HOME (so the app log path is hermetic), and a
// PATH with NO `docker` so the compose branch deterministically degrades.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

let home;
let repoRoot;
let binDir; // a PATH dir holding ONLY a `node` symlink — never docker.
const created = [];

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "cinatra-logs-"));
  created.push(base);
  home = path.join(base, "home");
  repoRoot = path.join(base, "repo");
  binDir = path.join(base, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // PATH must let the spawned `node` resolve but expose NO `docker`, so the
  // compose branch deterministically degrades. node + docker commonly share a
  // system bin dir (e.g. /usr/bin), so we cannot just point PATH at node's dir;
  // instead PATH is `binDir` ALONE with a single `node` symlink in it.
  symlinkSync(process.execPath, path.join(binDir, "node"));

  // Minimal fake cinatra checkout so getRepoRoot() (via CINATRA_REPO_ROOT)
  // resolves: pnpm-workspace.yaml + packages/migrations/package.json named
  // "@cinatra-ai/migrations" (the two markers isCinatraRepoRoot() checks).
  mkdirSync(path.join(repoRoot, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    path.join(repoRoot, "packages", "migrations", "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations" }),
  );
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

// Path to the dev-main app log inside the isolated HOME — must mirror
// cloneLogPath("dev-main").
function appLogPath() {
  return path.join(home, ".cinatra", "clones", "dev-main", "nextjs.log");
}

function writeAppLog(contents) {
  const p = appLogPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, contents);
}

function runLogs(args) {
  return spawnSync(process.execPath, [BIN, "logs", ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    timeout: 30_000,
    env: {
      // PATH is binDir ALONE (a lone `node` symlink); no docker is reachable,
      // forcing the compose branch to degrade honestly.
      PATH: binDir,
      HOME: home,
      CINATRA_REPO_ROOT: repoRoot,
      CI: "1",
    },
  });
}

describe("cinatra logs — flag parsing + mutual exclusion", () => {
  it("rejects --app together with --service (exit 1, actionable message)", () => {
    const res = runLogs(["--app", "--service", "postgres"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/either --app or --service/i);
  });
});

describe("cinatra logs --app — dev-main app log file tail", () => {
  it("tails the app log when it exists (command-only flag reaches the handler)", () => {
    // `--app` is the FIRST token, so the dispatcher hands it to the `mode`
    // slot; the handler's re-prepend is what makes it visible. A regression in
    // that reconstruction would surface here as the default both-sources output
    // (which also prints the compose section) instead of the app-only output.
    writeAppLog("alpha-line\nbravo-line\ncharlie-line\n");
    const res = runLogs(["--app"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("alpha-line");
    expect(res.stdout).toContain("charlie-line");
    // --app is app-only: it must NOT print the container-logs section.
    expect(res.stdout).not.toMatch(/Container logs/i);
  });

  it("prints a `cinatra instance start` hint when no app log exists yet", () => {
    const res = runLogs(["--app"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No app log yet/i);
    expect(res.stdout).toMatch(/cinatra instance start/);
  });
});

describe("cinatra logs (default) — both sources", () => {
  it("prints the app log then the container-logs section", () => {
    writeAppLog("delta-line\n");
    const res = runLogs([]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("delta-line");
    expect(res.stdout).toMatch(/Container logs/i);
  });

  it("degrades honestly when docker compose is unavailable (still exit 0)", () => {
    // No docker on PATH → the compose section warns + skips rather than ENOENT-
    // crashing, and a SKIP is not a failure, so the command still exits 0.
    const res = runLogs([]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/docker compose is not available/i);
  });
});

describe("cinatra logs --service — container-only", () => {
  it("does NOT read the app log and degrades when docker is unavailable", () => {
    writeAppLog("should-not-appear\n");
    const res = runLogs(["--service", "postgres"]);
    // --service is container-only: the app log is irrelevant and must not print.
    expect(res.stdout).not.toContain("should-not-appear");
    expect(res.stdout).not.toMatch(/Dev main app log/i);
    // Compose unavailable here too — honest skip, exit 0.
    expect(res.stderr).toMatch(/docker compose is not available/i);
    expect(res.status).toBe(0);
  });
});
