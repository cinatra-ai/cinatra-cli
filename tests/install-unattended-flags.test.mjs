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

import {
  installAfterExtensionSync,
  resolvePnpmInstallInvocation,
  setupPhaseOptions,
} from "../src/index.mjs";
import {
  moveExistingCheckoutToRef,
  parseInstallArgs,
  pnpmInstallInvocation,
  resolvePnpmInvocation,
  runInstall,
  runSetupInTarget,
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
    expect(parseInstallArgs(["--no-fetch", "--ref", "main"]).noFetch).toBe(true);
    const all = parseInstallArgs([
      "--pinned-extensions",
      "--frozen-lockfile",
      "--no-fetch",
      "--ref",
      "main",
    ]);
    expect([all.pinnedExtensions, all.frozenLockfile, all.noFetch]).toEqual([true, true, true]);
  });

  it("--no-fetch REFUSES without an explicit --ref, naming both flags", () => {
    // Without --ref the install targets the default "main", and --no-fetch
    // would resolve that from whatever the checkout happens to hold — quietly
    // moving a checkout parked at a commit off it. The two flags only make
    // sense together, so say so instead of moving the operator's HEAD.
    expect(() => parseInstallArgs(["--no-fetch"])).toThrow(/--no-fetch/);
    expect(() => parseInstallArgs(["--no-fetch"])).toThrow(/--ref/);
    expect(() => parseInstallArgs(["--no-fetch", "dev"])).toThrow(/--ref/);
    // With one it parses.
    expect(parseInstallArgs(["--no-fetch", "--ref", "a".repeat(40)]).noFetch).toBe(true);
    expect(parseInstallArgs(["--no-fetch", "--ref=main"]).noFetch).toBe(true);
  });

  it("they are VALUE-LESS: the token after one is still read as the mode positional", () => {
    // The regression this pins: listing a boolean in the value-taking set would
    // make `install --no-fetch dev` swallow `dev` as a value and silently run a
    // DEFAULT-mode install, while `install --no-fetch bogus` would stop
    // rejecting the unknown trailing argument.
    expect(parseInstallArgs(["--no-fetch", "--ref", "main", "dev"]).mode).toBe("dev");
    expect(parseInstallArgs(["--frozen-lockfile", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["--pinned-extensions", "demo"]).mode).toBe("demo");
    expect(() => parseInstallArgs(["--no-fetch", "--ref", "main", "bogus"])).toThrow(
      /Unknown argument "bogus"/,
    );
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
      expect(parseInstallArgs(["--no-fetch", "--ref", "main", "--mode", mode]).noFetch).toBe(true);
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

describe("pnpmInstallInvocation — BOTH tiers of the install's own dependency step", () => {
  // `pnpmInstall` takes a shortcut when the caller already probed that Corepack
  // is absent and pnpm is present. That shortcut is a second construction site
  // for the command line, so it is asserted here alongside the tiered one — a
  // revert of either branch has to fail.
  it("the already-probed direct-pnpm tier, OFF then ON", () => {
    expect(pnpmInstallInvocation({ usePnpmDirect: true })).toEqual({
      command: "pnpm",
      args: ["install"],
      label: "pnpm install",
    });
    expect(pnpmInstallInvocation({ usePnpmDirect: true, frozenLockfile: true })).toEqual({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      label: "pnpm install --frozen-lockfile",
    });
  });

  it("the tiered resolve, OFF then ON", () => {
    expect(pnpmInstallInvocation({ usePnpmDirect: false, exists: present("corepack") })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
    expect(
      pnpmInstallInvocation({ usePnpmDirect: false, exists: present("corepack"), frozenLockfile: true }),
    ).toEqual({
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
      label: "corepack pnpm install --frozen-lockfile",
    });
  });
});

describe("setupChildArgs — the opt-ins forwarded to the setup child", () => {
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

  it("--pinned-extensions appends --pinned, and composes with --skip-dev-apps", () => {
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

  it("--pinned never reaches a prod setup child (the pinned fleet is a dev-path concept)", () => {
    expect(setupChildArgs({ mode: "prod", pinnedExtensions: true })).toEqual([
      "instance",
      "setup",
      "prod",
    ]);
  });

  it("--frozen-lockfile IS forwarded, for dev AND prod (both run their own install)", () => {
    // The child re-links the workspace after its own extension sync / prod
    // acquisition. That is a second `pnpm install` inside the same run, so a
    // frozen install that stopped at the parent could still rewrite the
    // tracked lockfile — the exact thing the flag exists to prevent.
    expect(setupChildArgs({ mode: "dev", frozenLockfile: true })).toEqual([
      "instance",
      "setup",
      "dev",
      "--frozen-lockfile",
    ]);
    expect(setupChildArgs({ mode: "prod", frozenLockfile: true })).toEqual([
      "instance",
      "setup",
      "prod",
      "--frozen-lockfile",
    ]);
    expect(
      setupChildArgs({ mode: "demo", skipDevApps: true, pinnedExtensions: true, frozenLockfile: true }),
    ).toEqual(["instance", "setup", "dev", "--skip-dev-apps", "--pinned", "--frozen-lockfile"]);
  });
});

describe("runSetupInTarget — the REAL command line it spawns", () => {
  function spawnRecorder() {
    const calls = [];
    return {
      calls,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    };
  }

  it("OFF spawns the published bin with today's argv", () => {
    const { calls, spawn } = spawnRecorder();
    runSetupInTarget({ targetDir: "/target", mode: "dev", skipDevApps: false, log: () => {}, spawn });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args.slice(1)).toEqual(["instance", "setup", "dev"]);
    expect(calls[0].options.cwd).toBe("/target");
  });

  it("ON spawns the published bin with every forwarded opt-in, in order", () => {
    const { calls, spawn } = spawnRecorder();
    runSetupInTarget({
      targetDir: "/target",
      mode: "dev",
      skipDevApps: true,
      pinnedExtensions: true,
      frozenLockfile: true,
      log: () => {},
      spawn,
    });
    expect(calls[0].args.slice(1)).toEqual([
      "instance",
      "setup",
      "dev",
      "--skip-dev-apps",
      "--pinned",
      "--frozen-lockfile",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2b. The setup child's OWN dependency install — the second `pnpm install` a
//     `--frozen-lockfile` run performs. The install spawns `instance setup
//     <mode>`, and that child re-links the workspace after its own extension
//     sync; without the flag reaching THERE, a run that asked for a frozen
//     install could still rewrite the tracked lockfile.
// ---------------------------------------------------------------------------
describe("resolvePnpmInstallInvocation — the setup child's own install", () => {
  it("OFF is byte-for-byte the previous invocation on all three tiers", () => {
    expect(resolvePnpmInstallInvocation({ exists: present("corepack", "pnpm") })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
    expect(resolvePnpmInstallInvocation({ exists: present("pnpm") })).toEqual({
      command: "pnpm",
      args: ["install"],
      label: "pnpm install",
    });
    expect(resolvePnpmInstallInvocation({ exists: () => false })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
    expect(
      resolvePnpmInstallInvocation({
        exists: present("npm"),
        repoRoot: "/repo",
        readPin: () => "pnpm@10.0.0",
      }).args,
    ).toEqual(["exec", "-y", "--", "pnpm@10.0.0", "install"]);
  });

  it("ON appends --frozen-lockfile to EVERY tier", () => {
    expect(resolvePnpmInstallInvocation({ exists: present("corepack"), frozenLockfile: true })).toEqual({
      command: "corepack",
      args: ["pnpm", "install", "--frozen-lockfile"],
      label: "corepack pnpm install --frozen-lockfile",
    });
    expect(resolvePnpmInstallInvocation({ exists: present("pnpm"), frozenLockfile: true })).toEqual({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      label: "pnpm install --frozen-lockfile",
    });
    expect(resolvePnpmInstallInvocation({ exists: () => false, frozenLockfile: true }).args).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
    expect(
      resolvePnpmInstallInvocation({
        exists: present("npm"),
        repoRoot: "/repo",
        readPin: () => "pnpm@10.0.0",
        frozenLockfile: true,
      }).args,
    ).toEqual(["exec", "-y", "--", "pnpm@10.0.0", "install", "--frozen-lockfile"]);
  });
});

describe("installAfterExtensionSync — carries the frozen opt-in to the re-link", () => {
  const syncResult = { results: [{ action: "cloned" }] };

  function recorder() {
    const calls = [];
    return {
      calls,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    };
  }

  it("OFF issues the plain re-link (unchanged)", () => {
    const { calls, spawn } = recorder();
    const res = installAfterExtensionSync("/repo", syncResult, { spawn, exists: present("pnpm") });
    expect(calls[0].args).toEqual(["install"]);
    expect(res).toEqual({ ok: true, label: "pnpm install" });
  });

  it("ON issues the frozen re-link", () => {
    const { calls, spawn } = recorder();
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn,
      exists: present("pnpm"),
      frozenLockfile: true,
    });
    expect(calls[0].args).toEqual(["install", "--frozen-lockfile"]);
    expect(res).toEqual({ ok: true, label: "pnpm install --frozen-lockfile" });
  });
});

describe("setupPhaseOptions — only `instance setup dev|prod` reads the flag", () => {
  it("reads --frozen-lockfile from the setup command's OWN trailing args", () => {
    expect(setupPhaseOptions([])).toEqual({ frozenLockfile: false });
    expect(setupPhaseOptions(["--skip-dev-apps"])).toEqual({ frozenLockfile: false });
    expect(setupPhaseOptions(["--pinned", "--frozen-lockfile"])).toEqual({ frozenLockfile: true });
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

  it("resolves a LOCAL BRANCH through refs/heads, not through a same-named TAG", () => {
    // `git rev-parse <name>^{commit}` prefers refs/tags/<name> over
    // refs/heads/<name> (verified: with both present it answers the TAG's
    // commit), while the checkout step takes the BRANCH by name. So a
    // bare-name resolution checks out the operator's branch and then
    // fast-forwards it onto the TAG's commit — silently moving their branch to
    // a commit they never named. Pinned with the tag AHEAD of the branch,
    // which is the direction where the fast-forward actually succeeds.
    const { checkout, headSha } = buildOrphanedCheckout(sandbox, "collide");
    const parent = gitIn(["rev-parse", `${headSha}^`], checkout);
    // Branch `release` parked at the OLDER commit; a TAG of the same name at
    // the newer one.
    execFileSync("git", ["-C", checkout, "checkout", "-B", "release", parent], { stdio: "ignore" });
    execFileSync("git", ["-C", checkout, "tag", "release", headSha], { stdio: "ignore" });

    const sha = moveExistingCheckoutToRef({
      targetDir: checkout,
      ref: "release",
      fetch: false,
      log: () => {},
    });
    // The BRANCH's commit is what `--ref release` means here.
    expect(sha).toBe(parent);
    // Still on the branch, and the branch was NOT dragged onto the tag.
    expect(gitIn(["symbolic-ref", "HEAD"], checkout)).toBe("refs/heads/release");
    expect(gitIn(["rev-parse", "refs/heads/release"], checkout)).toBe(parent);
    expect(gitIn(["rev-parse", "refs/tags/release^{commit}"], checkout)).toBe(headSha);
  });

  it("does not let a stale origin/<ref> beat the operator's own branch", () => {
    const { checkout, headSha } = buildOrphanedCheckout(sandbox, "stale-remote");
    const parent = gitIn(["rev-parse", `${headSha}^`], checkout);
    execFileSync("git", ["-C", checkout, "checkout", "-B", "topic", headSha], { stdio: "ignore" });
    // A remote-tracking ref left behind at the OLDER commit by some earlier fetch.
    execFileSync("git", ["-C", checkout, "update-ref", "refs/remotes/origin/topic", parent], {
      stdio: "ignore",
    });
    const sha = moveExistingCheckoutToRef({
      targetDir: checkout,
      ref: "topic",
      fetch: false,
      log: () => {},
    });
    expect(sha).toBe(headSha);
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

  it("OFF: the sync is tip-tracking, pnpm is bare, the setup child carries no opt-in", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "off"), [], deps);
    expect(seen.sync).toHaveLength(1);
    expect(seen.sync[0].argv).toEqual([]);
    expect(seen.pnpm).toHaveLength(1);
    expect(seen.pnpm[0].frozenLockfile).toBe(false);
    expect(seen.setup).toHaveLength(1);
    expect(seen.setup[0].pinnedExtensions).toBeFalsy();
    expect(seen.setup[0].frozenLockfile).toBeFalsy();
  });

  it("--pinned-extensions: the install's OWN sync and the setup child both run pinned", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "pinned"), ["--pinned-extensions"], deps);
    expect(seen.sync[0].argv).toEqual(["--pinned"]);
    expect(seen.setup[0].pinnedExtensions).toBe(true);
    // It did NOT turn on anything else.
    expect(seen.pnpm[0].frozenLockfile).toBe(false);
    expect(seen.setup[0].frozenLockfile).toBeFalsy();
  });

  it("--frozen-lockfile: BOTH dependency installs carry it — the install's and the child's", async () => {
    const { seen, deps } = recordingDeps();
    await install(path.join(sandbox, "frozen"), ["--frozen-lockfile"], deps);
    expect(seen.pnpm[0].frozenLockfile).toBe(true);
    expect(seen.setup[0].frozenLockfile).toBe(true);
    expect(seen.sync[0].argv).toEqual([]);
    expect(seen.setup[0].pinnedExtensions).toBeFalsy();
  });

  it("the three compose: pinned sync + a pinned, frozen setup child + a frozen dependency install", async () => {
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
    expect(seen.sync[0].argv).toEqual(["--pinned"]);
    expect(seen.pnpm[0].frozenLockfile).toBe(true);
    expect(seen.setup[0]).toMatchObject({
      mode: "dev",
      skipDevApps: true,
      pinnedExtensions: true,
      frozenLockfile: true,
    });
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

  // The co-use executor owns its WHOLE install tail — its own extension sync,
  // its own dependency install and its own setup call. An opt-in that stopped
  // at the default path would silently give a co-use instance a tip-tracking
  // fleet and a lockfile-rewriting install.
  it("co-use carries the same opt-ins through its own tail", async () => {
    const seen = { sync: [], pnpm: [], setup: [] };
    const installDir = path.join(sandbox, "couse");
    await runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--on-conflict=co-use",
        "--pinned-extensions",
        "--frozen-lockfile",
        "--yes",
      ],
      {
        log: () => {},
        deps: {
          ...recordingDeps().deps,
          // Past the fail-closed capability gate, with a donor that supplies the
          // shared endpoints; no stack is ever brought up on this road.
          probeCookiePrefixSupport: () => true,
          readDonorEnv: () => ({
            SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/postgres",
            REDIS_URL: "redis://127.0.0.1:6379",
            NANGO_SERVER_URL: "http://127.0.0.1:3003",
            BETTER_AUTH_SECRET: "donor-secret",
            CINATRA_ENCRYPTION_KEY: "donor-enc",
          }),
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async () => {},
          },
          bringUpInfra: () => {
            throw new Error("co-use must NOT bring up an infra stack");
          },
          syncDevExtensions: async (args) => {
            seen.sync.push(args);
            return { skipped: true, reason: "no declared dev extensions", results: [] };
          },
          pnpmInstall: (args) => seen.pnpm.push(args),
          runSetup: (args) => {
            seen.setup.push(args);
            return { tolerated: true, registrySkew: false, lines: [] };
          },
        },
      },
    );
    expect(seen.sync[0].argv).toEqual(["--pinned"]);
    expect(seen.pnpm[0].frozenLockfile).toBe(true);
    expect(seen.setup[0]).toMatchObject({ pinnedExtensions: true, frozenLockfile: true });
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
