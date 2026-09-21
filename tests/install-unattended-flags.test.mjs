// Three opt-in flags that make `cinatra install` usable UNATTENDED — by a CI job
// or an automated verification runner that creates many isolated instances, each
// in a checkout already parked at an exact commit, and has to hand that checkout
// back byte-for-byte clean:
//
//   --pinned-extensions  the dev extension fleet is the checkout's COMMITTED
//                        lock, fail-closed — in the install's OWN sync AND in
//                        the `instance setup` child it spawns.
//   --frozen-lockfile    every `pnpm install` on the install path refuses a
//                        lockfile drift instead of rewriting the tracked file.
//   --no-fetch           an existing checkout is moved to --ref with NO fetch,
//                        and refuses when the ref is not already resolvable.
//
// All three are OFF by default, and every OFF case below is pinned against the
// exact child command line the install issued before they existed — so an
// operator who does not ask for them cannot be given a different install.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { devExtensionSyncArgv } from "../src/index.mjs";
import {
  moveExistingCheckoutToRef,
  parseInstallArgs,
  resolvePnpmInvocation,
  runInstall,
  setupChildArgs,
} from "../src/install.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

const present =
  (...cmds) =>
  (cmd) =>
    cmds.includes(cmd);

// ---------------------------------------------------------------------------
// 1. The parser surface — three value-less booleans, OFF by default.
// ---------------------------------------------------------------------------
describe("parseInstallArgs — the unattended opt-ins", () => {
  it("leaves all three OFF when nothing is passed (today's behaviour)", () => {
    const o = parseInstallArgs([]);
    expect(o.pinnedExtensions).toBe(false);
    expect(o.frozenLockfile).toBe(false);
    expect(o.noFetch).toBe(false);
  });

  it("parses each one ON", () => {
    expect(parseInstallArgs(["--pinned-extensions"]).pinnedExtensions).toBe(true);
    expect(parseInstallArgs(["--frozen-lockfile"]).frozenLockfile).toBe(true);
    expect(parseInstallArgs(["--no-fetch"]).noFetch).toBe(true);
    const all = parseInstallArgs(["--pinned-extensions", "--frozen-lockfile", "--no-fetch"]);
    expect([all.pinnedExtensions, all.frozenLockfile, all.noFetch]).toEqual([true, true, true]);
  });

  it("they are VALUE-LESS: the token after one is still read as the mode positional", () => {
    // The regression this pins: listing a boolean in the value-taking set would
    // make `install --no-fetch dev` swallow `dev` as a value and silently run a
    // DEFAULT-mode install, while `install --no-fetch bogus` would stop
    // rejecting the unknown trailing argument.
    expect(parseInstallArgs(["--no-fetch", "dev"]).mode).toBe("dev");
    expect(parseInstallArgs(["--frozen-lockfile", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["--pinned-extensions", "demo"]).mode).toBe("demo");
    expect(() => parseInstallArgs(["--no-fetch", "bogus"])).toThrow(/Unknown argument "bogus"/);
    expect(() => parseInstallArgs(["--frozen-lockfile", "dev", "extra"])).toThrow(
      /Unexpected extra argument/,
    );
  });

  it("--pinned-extensions is refused for a prod install (it pins the DEV fleet)", () => {
    expect(() => parseInstallArgs(["--pinned-extensions", "--mode", "prod"])).toThrow(
      /--pinned-extensions applies only to a dev-like install/,
    );
    expect(() => parseInstallArgs(["--pinned-extensions", "prod"])).toThrow(
      /--pinned-extensions applies only to a dev-like install/,
    );
  });

  it("--pinned-extensions is accepted for every dev-like mode (dev|demo|preview)", () => {
    expect(parseInstallArgs(["--pinned-extensions", "--mode", "dev"]).pinnedExtensions).toBe(true);
    expect(parseInstallArgs(["--pinned-extensions", "--mode", "demo"]).pinnedExtensions).toBe(true);
    expect(parseInstallArgs(["--pinned-extensions", "--mode", "preview"]).pinnedExtensions).toBe(true);
  });

  it("--frozen-lockfile and --no-fetch carry no mode restriction (every install installs / moves)", () => {
    for (const mode of ["dev", "prod", "demo", "preview"]) {
      expect(parseInstallArgs(["--frozen-lockfile", "--mode", mode]).frozenLockfile).toBe(true);
      expect(parseInstallArgs(["--no-fetch", "--mode", mode]).noFetch).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The two child command lines, as pure builders.
// ---------------------------------------------------------------------------
describe("resolvePnpmInvocation — --frozen-lockfile on every package-manager tier", () => {
  it("OFF is byte-for-byte the previous invocation on all three tiers", () => {
    expect(resolvePnpmInvocation({ exists: present("corepack", "pnpm") })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
    expect(resolvePnpmInvocation({ exists: present("pnpm") })).toEqual({
      command: "pnpm",
      args: ["install"],
      label: "pnpm install",
    });
    expect(resolvePnpmInvocation({ exists: () => false })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
  });

  it("ON appends --frozen-lockfile to EVERY tier (no tier can drop the opt-in)", () => {
    expect(resolvePnpmInvocation({ exists: present("corepack", "pnpm"), frozenLockfile: true })).toEqual({
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
      label: "corepack pnpm install --frozen-lockfile",
    });
    expect(resolvePnpmInvocation({ exists: present("pnpm"), frozenLockfile: true })).toEqual({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      label: "pnpm install --frozen-lockfile",
    });
    expect(resolvePnpmInvocation({ exists: () => false, frozenLockfile: true })).toEqual({
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
      label: "corepack pnpm install --frozen-lockfile",
    });
  });

  it("ON reaches the pinned-pnpm tier too (the Node line without Corepack)", () => {
    const checkout = mkdtempSync(path.join(os.tmpdir(), "cin-frozen-pin-"));
    try {
      writeFileSync(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "x", packageManager: "pnpm@10.0.0" }),
      );
      const invocation = resolvePnpmInvocation({
        targetDir: checkout,
        exists: present("npm"),
        frozenLockfile: true,
      });
      expect(invocation.command).toBe("npm");
      expect(invocation.args).toEqual(["exec", "-y", "--", "pnpm@10.0.0", "install", "--frozen-lockfile"]);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

describe("setupChildArgs — --pinned-extensions forwarded to the setup child", () => {
  it("OFF is byte-for-byte today's child argv", () => {
    expect(setupChildArgs({ mode: "dev" })).toEqual(["instance", "setup", "dev"]);
    expect(setupChildArgs({ mode: "demo" })).toEqual(["instance", "setup", "dev"]);
    expect(setupChildArgs({ mode: "prod" })).toEqual(["instance", "setup", "prod"]);
    expect(setupChildArgs({ mode: "dev", skipDevApps: true })).toEqual([
      "instance",
      "setup",
      "dev",
      "--skip-dev-apps",
    ]);
  });

  it("ON appends --pinned, and composes with --skip-dev-apps", () => {
    expect(setupChildArgs({ mode: "dev", pinnedExtensions: true })).toEqual([
      "instance",
      "setup",
      "dev",
      "--pinned",
    ]);
    expect(setupChildArgs({ mode: "demo", pinnedExtensions: true })).toEqual([
      "instance",
      "setup",
      "dev",
      "--pinned",
    ]);
    expect(setupChildArgs({ mode: "dev", skipDevApps: true, pinnedExtensions: true })).toEqual([
      "instance",
      "setup",
      "dev",
      "--skip-dev-apps",
      "--pinned",
    ]);
  });

  it("never reaches a prod setup child (the pinned fleet is a dev-path concept)", () => {
    expect(setupChildArgs({ mode: "prod", pinnedExtensions: true })).toEqual([
      "instance",
      "setup",
      "prod",
    ]);
  });
});

describe("devExtensionSyncArgv — the setup child's OWN sync keeps --pinned", () => {
  it("passes the ambient argv through unchanged when nothing narrows the run", () => {
    const ambient = ["instance", "setup", "dev", "--pinned"];
    expect(devExtensionSyncArgv(false, ambient)).toBe(ambient);
  });

  it("keeps --pinned when --skip-dev-apps narrows the run (both flags, not one)", () => {
    // The drop this pins: a narrowed run used to substitute a single-flag array
    // for the ambient argv, so `install --pinned-extensions --skip-dev-apps`
    // pinned the install's own sync and left the setup child's sync
    // tip-tracking — the exact thing --pinned-extensions exists to prevent.
    expect(devExtensionSyncArgv(true, ["instance", "setup", "dev", "--skip-dev-apps", "--pinned"])).toEqual([
      "--skip-dev-apps",
      "--pinned",
    ]);
  });

  it("is unchanged for a narrowed run that never asked to pin", () => {
    expect(devExtensionSyncArgv(true, ["instance", "setup", "dev", "--skip-dev-apps"])).toEqual([
      "--skip-dev-apps",
    ]);
    expect(devExtensionSyncArgv(true, [])).toEqual(["--skip-dev-apps"]);
  });
});

// ---------------------------------------------------------------------------
// 3. The ref move with no fetch, against a REAL checkout whose origin is gone.
//
//    Deleting the origin repository is what makes this a proof rather than an
//    assertion: any fetch at all fails loudly, so a run that completes is a run
//    that reached no remote.
// ---------------------------------------------------------------------------
function gitIn(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/** A minimal cinatra checkout (the two files `isCinatraCheckout` reads) with a
 *  real git history, cloned from a bare origin that is then DELETED. */
function buildOrphanedCheckout(sandbox, name) {
  const src = path.join(sandbox, `${name}-src`);
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
  gitIn(["commit", "-m", "first"], src);
  writeFileSync(path.join(src, "VERSION"), "second\n");
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "second"], src);

  const originRepo = path.join(sandbox, `${name}-origin.git`);
  gitIn(["clone", "--bare", src, originRepo], sandbox);
  const checkout = path.join(sandbox, `${name}-checkout`);
  execFileSync("git", ["clone", `file://${originRepo}`, checkout], { stdio: "ignore" });
  const headSha = gitIn(["rev-parse", "HEAD"], checkout);
  // The remote is now unreachable: `git remote get-url origin` still answers
  // (it is config), but every fetch fails.
  rmSync(originRepo, { recursive: true, force: true });
  return { checkout, headSha, repoUrl: `file://${originRepo}` };
}

describe("moveExistingCheckoutToRef — --no-fetch (fetch: false)", () => {
  let sandbox;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-nofetch-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("the DEFAULT still fetches — and fails loudly when the remote is gone", () => {
    const { checkout, headSha } = buildOrphanedCheckout(sandbox, "default");
    expect(() => moveExistingCheckoutToRef({ targetDir: checkout, ref: headSha, log: () => {} })).toThrow(
      /git fetch origin .* failed/,
    );
  });

  it("moves to a 40-hex commit the checkout already has, with no fetch", () => {
    const { checkout, headSha } = buildOrphanedCheckout(sandbox, "sha");
    // Park HEAD one commit back so the move has real work to do.
    const parent = gitIn(["rev-parse", `${headSha}^`], checkout);
    execFileSync("git", ["-C", checkout, "checkout", "--detach", parent], { stdio: "ignore" });
    const sha = moveExistingCheckoutToRef({
      targetDir: checkout,
      ref: headSha,
      fetch: false,
      log: () => {},
    });
    expect(sha).toBe(headSha);
    expect(gitIn(["rev-parse", "HEAD"], checkout)).toBe(headSha);
  });

  it("moves a DETACHED git worktree of that checkout", () => {
    const { checkout, headSha } = buildOrphanedCheckout(sandbox, "worktree");
    const parent = gitIn(["rev-parse", `${headSha}^`], checkout);
    const wt = path.join(sandbox, "worktree-wt");
    execFileSync("git", ["-C", checkout, "worktree", "add", "--detach", wt, parent], { stdio: "ignore" });
    const sha = moveExistingCheckoutToRef({ targetDir: wt, ref: headSha, fetch: false, log: () => {} });
    expect(sha).toBe(headSha);
    expect(gitIn(["rev-parse", "HEAD"], wt)).toBe(headSha);
  });

  it("issues NO git fetch at all, and never consults a stale FETCH_HEAD", () => {
    const calls = [];
    const targetCommit = "a".repeat(40);
    const sha = moveExistingCheckoutToRef({
      targetDir: "/nope",
      ref: targetCommit,
      fetch: false,
      log: () => {},
      deps: {
        classifyTargetDirt: () => ({
          entries: [],
          byproducts: [],
          operator: [],
          clean: true,
          resettable: [],
        }),
        capture: () => targetCommit,
        runGit: (args) => {
          calls.push(args);
          if (args[0] === "rev-parse" && args.includes(`${targetCommit}^{commit}`)) {
            return { status: 0, stdout: `${targetCommit}\n`, stderr: "" };
          }
          if (args[0] === "rev-parse") return { status: 1, stdout: "", stderr: "" };
          if (args[0] === "show-ref") return { status: 1, stdout: "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(sha).toBe(targetCommit);
    expect(calls.some((a) => a[0] === "fetch")).toBe(false);
    // FETCH_HEAD is whatever an earlier, unrelated fetch left behind — a
    // no-fetch move must not resolve through it.
    expect(calls.some((a) => a.some((t) => String(t).includes("FETCH_HEAD")))).toBe(false);
    expect(calls.some((a) => a[0] === "checkout")).toBe(true);
  });

  it("refuses an unresolvable ref by NAME, and runs nothing after the refusal", () => {
    const { checkout } = buildOrphanedCheckout(sandbox, "unresolvable");
    const missing = "b".repeat(40);
    expect(() =>
      moveExistingCheckoutToRef({ targetDir: checkout, ref: missing, fetch: false, log: () => {} }),
    ).toThrow(new RegExp(missing));

    // And nothing ran after it: no checkout / merge / reset was attempted.
    const calls = [];
    expect(() =>
      moveExistingCheckoutToRef({
        targetDir: checkout,
        ref: missing,
        fetch: false,
        log: () => {},
        deps: {
          classifyTargetDirt: () => ({
            entries: [],
            byproducts: [],
            operator: [],
            clean: true,
            resettable: [],
          }),
          runGit: (args) => {
            calls.push(args);
            return { status: 1, stdout: "", stderr: "" };
          },
        },
      }),
    ).toThrow(new RegExp(missing));
    expect(calls.some((a) => ["checkout", "merge", "reset", "stash"].includes(a[0]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. End to end through runInstall — the child command lines it issues.
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
  gitIn(["init", "-b", "main"], src);
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  gitIn(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

describe("runInstall — the unattended opt-ins reach the children", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-unattended-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  /** Record the three child invocations; run none of them. */
  function recordingDeps(extra = {}) {
    const seen = { sync: [], pnpm: [], setup: [] };
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
      syncDevExtensions: async (args) => {
        seen.sync.push(args);
        return { skipped: true, reason: "no declared dev extensions", results: [] };
      },
      pnpmInstall: (args) => {
        seen.pnpm.push(args);
      },
      runSetupInTarget: (args) => {
        seen.setup.push(args);
        return { tolerated: true, registrySkew: false, lines: [] };
      },
      ...extra,
    };
    return { seen, deps };
  }

  const install = (dir, extraArgs, deps) =>
    runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", ...extraArgs],
      { log: () => {}, deps },
    );

  it("OFF: the sync is tip-tracking, pnpm is bare, the setup child carries no --pinned", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "off"), [], deps);
    expect(seen.sync).toHaveLength(1);
    expect(seen.sync[0].argv).toEqual([]);
    expect(seen.pnpm).toHaveLength(1);
    expect(seen.pnpm[0].frozenLockfile ?? false).toBe(false);
    expect(seen.setup).toHaveLength(1);
    expect(setupChildArgs(seen.setup[0])).toEqual(["instance", "setup", "dev"]);
  });

  it("--pinned-extensions: the install's OWN sync and the setup child both run pinned", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "pinned"), ["--pinned-extensions"], deps);
    expect(seen.sync[0].argv).toContain("--pinned");
    expect(setupChildArgs(seen.setup[0])).toEqual(["instance", "setup", "dev", "--pinned"]);
    // It did NOT turn on anything else.
    expect(seen.pnpm[0].frozenLockfile ?? false).toBe(false);
  });

  it("--frozen-lockfile: the dependency install carries it; nothing else changes", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "frozen"), ["--frozen-lockfile"], deps);
    expect(seen.pnpm[0].frozenLockfile).toBe(true);
    expect(resolvePnpmInvocation({ exists: present("pnpm"), frozenLockfile: seen.pnpm[0].frozenLockfile }).args)
      .toEqual(["install", "--frozen-lockfile"]);
    expect(seen.sync[0].argv).toEqual([]);
    expect(setupChildArgs(seen.setup[0])).toEqual(["instance", "setup", "dev"]);
  });

  it("the three compose: pinned sync + pinned setup child + a frozen dependency install", async () => {
    // `--no-fetch` only means anything on an EXISTING checkout, so seed one
    // first — the unattended shape: the checkout is already there, at the commit.
    const dir = path.join(sandbox, "all-three");
    await install(dir, ["--no-install"], recordingDeps().deps);
    const sha = gitIn(["rev-parse", "HEAD"], dir);

    const { seen, deps } = recordingDeps();
    await runInstall(
      [
        "--dir", dir,
        "--repo-url", `file://${originRepo}`,
        "--ref", sha,
        "--yes",
        "--pinned-extensions",
        "--frozen-lockfile",
        "--no-fetch",
        "--skip-dev-apps",
      ],
      { log: () => {}, deps },
    );
    expect(seen.sync[0].argv).toContain("--pinned");
    expect(seen.pnpm[0].frozenLockfile).toBe(true);
    expect(setupChildArgs(seen.setup[0])).toEqual([
      "instance",
      "setup",
      "dev",
      "--skip-dev-apps",
      "--pinned",
    ]);
    expect(gitIn(["rev-parse", "HEAD"], dir)).toBe(sha);
  });

  it("--no-fetch moves an EXISTING checkout with the remote gone; without it the run fails", async () => {
    // A fresh clone first (the remote is alive for this one), then the remote is
    // deleted under it — exactly the unattended shape: a checkout already at the
    // commit, and no reachable origin.
    const dir = path.join(sandbox, "no-fetch");
    const { deps } = recordingDeps();
    await install(dir, ["--no-install"], deps);
    const sha = gitIn(["rev-parse", "HEAD"], dir);

    const gone = path.join(sandbox, "gone-origin.git");
    gitIn(["clone", "--bare", dir, gone], sandbox);
    execFileSync("git", ["-C", dir, "remote", "set-url", "origin", `file://${gone}`], { stdio: "ignore" });
    rmSync(gone, { recursive: true, force: true });

    const reinstall = (extraArgs) =>
      runInstall(
        ["--dir", dir, "--repo-url", `file://${gone}`, "--ref", sha, "--yes", "--no-install", ...extraArgs],
        { log: () => {}, deps: recordingDeps().deps },
      );

    await expect(reinstall([])).rejects.toThrow(/git fetch origin .* failed/);
    await expect(reinstall(["--no-fetch"])).resolves.toBeTruthy();
    expect(gitIn(["rev-parse", "HEAD"], dir)).toBe(sha);
  });

  it("--no-fetch refuses to CLONE (a fresh clone is a network operation)", async () => {
    const { deps } = recordingDeps();
    await expect(
      install(path.join(sandbox, "no-fetch-fresh"), ["--no-fetch", "--no-install"], deps),
    ).rejects.toThrow(/--no-fetch/);
  });
});

// ---------------------------------------------------------------------------
// 5. The flags are documented where an operator looks for them.
// ---------------------------------------------------------------------------
describe("the three flags are documented", () => {
  const FLAGS = ["--pinned-extensions", "--frozen-lockfile", "--no-fetch"];

  it("`cinatra --help` lists each one", () => {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "bin", "cinatra.mjs"), "--help"], {
      encoding: "utf8",
      env: { ...process.env, CI: "1" },
    });
    for (const flag of FLAGS) expect(out).toContain(flag);
  });

  it("the README names each one", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    for (const flag of FLAGS) expect(readme).toContain(flag);
  });

  it("the CHANGELOG's unreleased section names each one", () => {
    const changelog = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const unreleased = changelog.slice(
      changelog.indexOf("## [Unreleased]"),
      changelog.indexOf("## [", changelog.indexOf("## [Unreleased]") + 1),
    );
    for (const flag of FLAGS) expect(unreleased).toContain(flag);
  });
});
