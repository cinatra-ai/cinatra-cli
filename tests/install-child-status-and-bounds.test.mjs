// The development install road's child helpers, its setup child and the
// companion sync's git child are judged by EXIT STATUS alone and bounded from
// spawn with a named failure; the road's other child waits are not changed here.
//
// The children here are real processes (the running node binary, or a small
// `git`/`docker` stand-in script placed first on PATH for one case), so each
// case reads the helper's real spawn: a child that exits non-zero while
// printing success-looking output, one that exits 0 while printing
// error-looking text, and one that never exits (it even ignores SIGTERM),
// which must be stopped at its bound, named, and leave no process behind.
//
// A case that waits on a never-exiting child runs the helper in a harness
// process with its own guard. A helper with no bound blocks its whole process
// (the wait is synchronous), so in this process it would hang the run; in the
// harness the guard stops it, and the case fails on its own assertion ("the
// helper waited past its bound"). The never-exiting child is killed after the
// case in either outcome.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as install from "../src/install.mjs";
import * as repoSync from "../src/dev-repo-sync.mjs";
import { collectSkewExemptSources } from "../src/cinatra-dev-extensions.mjs";
import { allocateInstance, markInstanceReady, requireUsableInstanceRegistry, writeInstanceRegistry } from "../src/instance-registry.mjs";

const NODE = process.execPath;
const INSTALL_URL = new URL("../src/install.mjs", import.meta.url).href;
const SYNC_URL = new URL("../src/dev-repo-sync.mjs", import.meta.url).href;
const SAYS_OK_EXITS_3 = ["-e", "console.log('ok: done, success'); process.exit(3)"];
const SAYS_ERROR_EXITS_0 = ["-e", "console.error('fatal: error: failed'); console.log('the-answer')"];
const HARNESS_GUARD_MS = 15_000;
const HARNESS_CASE_MS = 30_000;

let sandbox;
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-child-bounds-"));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function timeoutError(message) {
  return Object.assign(new Error(message), { code: "CHILD_TIMEOUT" });
}

/** A child that writes its pid, ignores SIGTERM and never exits. */
function neverExitsArgs(pidFile) {
  return [
    "-e",
    "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    pidFile,
  ];
}

function readPid(pidFile) {
  try {
    return Number(readFileSync(pidFile, "utf8"));
  } catch {
    return 0;
  }
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

function expectGone(pidFile) {
  const pid = readPid(pidFile);
  expect(pid).toBeGreaterThan(0);
  expect(isAlive(pid)).toBe(false);
}

/** Cleanup in every outcome: a child a helper never stopped is killed here. */
function killIfAlive(pidFile) {
  const pid = readPid(pidFile);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Run `body` (an async function body that may use `m`, the imported module)
 *  in a harness node process bounded by its own guard. Returns
 *  `{ guardExpired: true }` when the helper never returned, else what the
 *  body returned or threw (`code`, `message`). */
function inHarness(moduleUrl, body, { env = process.env } = {}) {
  const script =
    `const m = await import(${JSON.stringify(moduleUrl)});\n` +
    "let out;\n" +
    `try { const value = await (async () => { ${body} })(); out = { threw: false, value: value ?? null }; }\n` +
    "catch (err) { out = { threw: true, code: err?.code ?? null, message: String(err?.message ?? err) }; }\n" +
    "process.stdout.write(JSON.stringify(out), () => process.exit(0));\n";
  const r = spawnSync(NODE, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env,
    timeout: HARNESS_GUARD_MS,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT") return { guardExpired: true };
  let parsed = {};
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    parsed = { unparsed: r.stdout, stderr: r.stderr };
  }
  return { guardExpired: false, status: r.status, ...parsed };
}

/** Expect the harness to report the helper's own named timeout. */
function expectNamedTimeout(result, messageRe) {
  expect(result.guardExpired, "the helper waited past its bound (the harness guard stopped it)").toBe(false);
  expect(result.threw).toBe(true);
  expect(result.code).toBe("CHILD_TIMEOUT");
  expect(result.message).toMatch(messageRe);
}

/** A stand-in `name` script first on PATH: returns the env that carries it. */
function standInEnv(name, body) {
  const dir = mkdtempSync(path.join(sandbox, `bin-${name}-`));
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  const before = process.env.PATH;
  return { ...process.env, PATH: before === undefined ? dir : `${dir}${path.delimiter}${before}` };
}

/** Put a stand-in `name` script first on PATH of THIS process for `fn`. */
function withStandIn(name, body, fn) {
  const env = standInEnv(name, body);
  const before = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
  }
}

function standInNeverExits(pidFile) {
  return `exec "${NODE}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" "${pidFile}"`;
}

describe("install child helpers: success is the exit status (pins of the semantics main already has)", () => {
  it("capture: a non-zero exit is no answer, whatever it printed; a zero exit is the answer, whatever it said on stderr", () => {
    expect(install.captureInstallChild(NODE, SAYS_OK_EXITS_3)).toBeNull();
    expect(install.captureInstallChild(NODE, SAYS_ERROR_EXITS_0)).toBe("the-answer");
  });

  it("the raw reader: a non-zero exit is no answer; a zero exit keeps its bytes untrimmed", () => {
    expect(install.captureInstallChildRaw(NODE, SAYS_OK_EXITS_3)).toBeNull();
    expect(install.captureInstallChildRaw(NODE, ["-e", "console.error('error'); process.stdout.write(' M a\\n')"])).toBe(" M a\n");
  });

  it("the preflight probe: a non-zero exit is false and a zero exit is true, whatever either printed", () => {
    expect(install.installCommandExists(NODE, SAYS_OK_EXITS_3)).toBe(false);
    expect(install.installCommandExists(NODE, SAYS_ERROR_EXITS_0)).toBe(true);
  });

  it("the inherited-output step: a non-zero exit throws its message, a zero exit passes, whatever either printed", () => {
    expect(() => install.runInstallChildOrThrow(NODE, SAYS_OK_EXITS_3, "the step failed.")).toThrow("the step failed.");
    expect(() => install.runInstallChildOrThrow(NODE, SAYS_ERROR_EXITS_0, "the step failed.")).not.toThrow();
  });

  it("the compose probe reads only the exit status of `docker compose version`", () => {
    withStandIn("docker", 'echo "Docker Compose is installed and ready"; exit 1', () => {
      expect(install.composeAvailable()).toBe(false);
    });
    withStandIn("docker", 'echo "Error: unknown command" >&2; exit 0', () => {
      expect(install.composeAvailable()).toBe(true);
    });
  });

  it("the PATH stand-in restores PATH exactly, and deletes it when it was unset", () => {
    const before = process.env.PATH;
    withStandIn("docker", "exit 0", () => {
      expect(process.env.PATH).not.toBe(before);
    });
    expect(process.env.PATH).toBe(before);
    delete process.env.PATH;
    try {
      withStandIn("docker", "exit 0", () => {
        expect(typeof process.env.PATH).toBe("string");
      });
      expect("PATH" in process.env).toBe(false);
    } finally {
      if (before !== undefined) process.env.PATH = before;
    }
  });
});

describe("install child helpers: every wait is bounded from spawn, with a named failure", () => {
  it("capture stops a child that never exits at its bound and names it", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "capture.pid");
    try {
      const r = inHarness(
        INSTALL_URL,
        `return m.captureInstallChild(${JSON.stringify(NODE)}, ${JSON.stringify(neverExitsArgs(pidFile))}, { timeoutMs: 1500 });`,
      );
      expectNamedTimeout(r, /did not finish within 1\.5 s; it was stopped/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the raw reader stops a child that never exits at its bound and names it", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "capture-raw.pid");
    try {
      const r = inHarness(
        INSTALL_URL,
        `return m.captureInstallChildRaw(${JSON.stringify(NODE)}, ${JSON.stringify(neverExitsArgs(pidFile))}, { timeoutMs: 1500 });`,
      );
      expectNamedTimeout(r, /did not finish within 1\.5 s; it was stopped/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the preflight probe stops a child that never exits and names it, never reading it as absent", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "probe.pid");
    try {
      const r = inHarness(
        INSTALL_URL,
        `return m.installCommandExists(${JSON.stringify(NODE)}, ${JSON.stringify(neverExitsArgs(pidFile))}, { timeoutMs: 1500 });`,
      );
      expectNamedTimeout(r, /did not finish within 1\.5 s/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the inherited-output step stops a child that never exits and names the bound in its failure", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "step.pid");
    try {
      const r = inHarness(
        INSTALL_URL,
        `return m.runInstallChildOrThrow(${JSON.stringify(NODE)}, ${JSON.stringify(neverExitsArgs(pidFile))}, "the step failed.", { timeoutMs: 1500 });`,
      );
      expectNamedTimeout(r, /the step failed\. \(.*did not finish within 1\.5 s; it was stopped\.\)/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the git child of the clone and checkout steps is bounded and named by its first argument that is no flag", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "git.pid");
    const env = standInEnv("git", standInNeverExits(pidFile));
    try {
      const r = inHarness(INSTALL_URL, `return m.runInstallGit(["-C", "/x", "status"], { timeoutMs: 1500 });`, { env });
      expectNamedTimeout(r, /`git status` did not finish within 1\.5 s; it was stopped/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the compose probe is bounded and named", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "compose.pid");
    const env = standInEnv("docker", standInNeverExits(pidFile));
    try {
      const r = inHarness(INSTALL_URL, "return m.composeAvailable({ timeoutMs: 1500 });", { env });
      expectNamedTimeout(r, /`docker compose` did not finish within 1\.5 s/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the default bounds: a short read, a git transfer, a long step and a sync git child each have one", () => {
    // Red at main for the behavioural reason: main has no bound at all.
    expect(install.INSTALL_READ_TIMEOUT_MS).toBe(60_000);
    expect(install.INSTALL_GIT_TIMEOUT_MS).toBe(15 * 60_000);
    expect(install.INSTALL_STEP_TIMEOUT_MS).toBe(60 * 60_000);
    expect(repoSync.REPO_SYNC_GIT_TIMEOUT_MS).toBe(15 * 60_000);
  });
});

describe("the setup child: bounded from spawn, judged by its status", () => {
  it("spawns with a bound and SIGKILL, and an expired bound is a named failure", () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push(options);
      const error = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
      return { status: null, signal: "SIGKILL", error };
    };
    let caught = null;
    try {
      install.runSetupInTarget({ targetDir: "/target", mode: "dev", skipDevApps: false, log: () => {}, spawn });
    } catch (err) {
      caught = err;
    }
    expect(caught?.message).toMatch(
      /cinatra instance setup dev failed inside the target\. \(.*did not finish within 60 min; it was stopped\.\)/,
    );
    expect(caught?.code).toBe("CHILD_TIMEOUT");
    expect(calls[0].timeout).toBe(60 * 60_000);
    expect(calls[0].killSignal).toBe("SIGKILL");
    expect(calls[0].stdio).toBe("inherit");
  });
});

describe("failed git reads on the install road are never a clean or empty answer", () => {
  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      encoding: "utf8",
    }).trim();

  function checkoutWithCommit(name) {
    const dir = path.join(sandbox, name);
    mkdirSync(dir, { recursive: true });
    G(["init", "-q", "-b", "main"], dir);
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    G(["add", "-A"], dir);
    G(["commit", "-q", "-m", "one"], dir);
    return dir;
  }

  it("a working-tree read that fails refuses the move before any git step, never read as clean", () => {
    const dir = checkoutWithCommit("dirt-unread");
    const ran = [];
    expect(() =>
      install.moveExistingCheckoutToRef({
        targetDir: dir,
        ref: "main",
        fetch: false,
        log: () => {},
        deps: {
          captureRaw: () => null,
          runGit: (args) => {
            ran.push(args);
            throw new Error("no git step may run");
          },
        },
      }),
    ).toThrow(/Could not read the working tree state of .*`git status` did not exit 0/);
    expect(ran).toEqual([]);
  });

  it("the marker ignore: a checkout whose git-dir read fails throws naming it; a dir with no .git is left alone", () => {
    const dir = checkoutWithCommit("marker-unread");
    expect(() =>
      install.ensureMarkerIgnored(dir, { read: () => ({ status: 128, stdout: ".git\n" }) }),
    ).toThrow(/Could not read the git directory of .*exited 128/);
    expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).not.toContain(".cinatra/");
    install.ensureMarkerIgnored(dir);
    expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain(".cinatra/");
    const plain = path.join(sandbox, "not-a-checkout");
    mkdirSync(plain, { recursive: true });
    expect(() => install.ensureMarkerIgnored(plain)).not.toThrow();
    expect(existsSync(path.join(plain, ".git"))).toBe(false);
    const dangling = path.join(sandbox, "dangling-git-link");
    mkdirSync(dangling, { recursive: true });
    symlinkSync(path.join(sandbox, "no-such-git-dir"), path.join(dangling, ".git"));
    expect(() => install.ensureMarkerIgnored(dangling)).toThrow(/Could not read the git directory of /);
  });

  it("the compose feature probe: an expired bound is its own named failure and caches no answer", () => {
    install.__resetComposeFeatureProbe();
    const tmpRoot = mkdtempSync(path.join(sandbox, "probe-root-"));
    try {
      const timeout = timeoutError("`docker compose` did not finish within 60 s; it was stopped.");
      expect(() =>
        install.composeSupportsNoEnvResolution({
          tmpRoot,
          captureImpl: () => {
            throw timeout;
          },
        }),
      ).toThrow(/did not finish within 60 s/);
      // The probe's temporary directory is removed on this exit too (its
      // cleanup is best-effort; here nothing stops it).
      expect(readdirSync(tmpRoot)).toEqual([]);
      // Nothing was cached for the timeout: the next probe RUNS, and its
      // supported answer is the answer (a cached `false` would return false
      // without calling it).
      let calls = 0;
      const supported = JSON.stringify({
        services: { "cinatra-env-resolution-probe": { env_file: [{ path: "./.cinatra-probe.env", required: false }] } },
      });
      expect(
        install.composeSupportsNoEnvResolution({
          tmpRoot,
          captureImpl: () => {
            calls += 1;
            return supported;
          },
        }),
      ).toBe(true);
      expect(calls).toBe(1);
    } finally {
      install.__resetComposeFeatureProbe();
    }
  });

  it("the drift report after a completed install: a working-tree read that fails is one named warning line, never a clean tree or a failed install", () => {
    const dir = path.join(sandbox, "drift-unread");
    mkdirSync(dir, { recursive: true });
    const timedOut = [];
    expect(() =>
      install.reportInstallDrift(dir, {
        log: (l) => timedOut.push(l),
        deps: {
          captureRaw: () => {
            throw timeoutError("`git status` did not finish within 60 s; it was stopped.");
          },
        },
      }),
    ).not.toThrow();
    expect(timedOut).toEqual(["  ⚠ `git status` did not finish within 60 s; it was stopped."]);
    const failed = [];
    install.reportInstallDrift(dir, { log: (l) => failed.push(l), deps: { captureRaw: () => null } });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^ {2}⚠ Could not read the working tree state of .*`git status` did not exit 0/);
    const clean = [];
    install.reportInstallDrift(dir, { log: (l) => clean.push(l), deps: { captureRaw: () => "" } });
    expect(clean).toEqual([]);
  });

  it("an existing checkout whose origin read fails is refused, never updated as if it had no origin", async () => {
    const dir = checkoutWithCommit("origin-unread");
    await expect(
      install.cloneOrUpdateHost({
        targetDir: dir,
        repoUrl: "https://github.com/example/example.git",
        ref: "main",
        alreadyCheckout: true,
        force: false,
        yes: true,
        noFetch: false,
        log: () => {},
      }),
    ).rejects.toThrow(/Refusing to update .*its origin remote could not be read \(`git remote get-url origin` exited 2\)/);
  });

  it("with --no-fetch, a checkout with no origin remote resolves locally (git's no-such-remote status, read by status)", async () => {
    const dir = checkoutWithCommit("origin-none-nofetch");
    const head = G(["rev-parse", "HEAD"], dir);
    await expect(
      install.cloneOrUpdateHost({
        targetDir: dir,
        repoUrl: "https://github.com/example/example.git",
        ref: head,
        alreadyCheckout: true,
        force: false,
        yes: true,
        noFetch: true,
        log: () => {},
      }),
    ).resolves.toBe(head);
  });
});

describe("advisory reads degrade on an expired bound, named, instead of aborting", () => {
  it("the compose version string: an expired bound reads as 'version unknown'; any other failure still throws", () => {
    expect(
      install.composeVersionString(() => {
        throw timeoutError("`docker compose` did not finish within 60 s; it was stopped.");
      }),
    ).toBeNull();
    expect(() =>
      install.composeVersionString(() => {
        throw new Error("not a timeout");
      }),
    ).toThrow("not a timeout");
  });

  it("liveness: a volume read that outlives its bound never sinks a conclusive container answer; a container read that does still throws", () => {
    const volumesHang = (command, args) => {
      if (args[0] === "ps") return "";
      throw timeoutError("`docker volume` did not finish within 60 s; it was stopped.");
    };
    expect(install.inspectProjectLiveness(["demo"], { capture: volumesHang })).toEqual({ containerRows: [], volumeRows: [] });
    let caught = null;
    try {
      install.inspectProjectLiveness(["demo"], {
        capture: () => {
          throw timeoutError("`docker ps` did not finish within 60 s; it was stopped.");
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("CHILD_TIMEOUT");
  });

  it("liveness: a volume inspect that outlives its bound skips that project's volumes and never sinks the container answer", () => {
    const seen = [];
    const inspectHangs = (command, args) => {
      seen.push(args.slice(0, 2).join(" "));
      if (args[0] === "ps") return "";
      if (args[0] === "volume" && args[1] === "ls") return "demo_db\n";
      if (args[0] === "volume" && args[1] === "inspect") {
        throw timeoutError("`docker volume` did not finish within 60 s; it was stopped.");
      }
      throw new Error(`unexpected docker ${args.join(" ")}`);
    };
    expect(install.inspectProjectLiveness(["demo"], { capture: inspectHangs })).toEqual({ containerRows: [], volumeRows: [] });
    expect(seen).toContain("volume inspect");
    // The same read answered: its row is kept (the read above was reached, and only its timeout was degraded).
    const inspectAnswers = (command, args) => {
      if (args[0] === "ps") return "";
      if (args[0] === "volume" && args[1] === "ls") return "demo_db\n";
      return JSON.stringify([{ Name: "demo_db", Labels: { "com.docker.compose.project": "demo" } }]);
    };
    expect(install.inspectProjectLiveness(["demo"], { capture: inspectAnswers }).volumeRows).toEqual([
      { name: "demo_db", project: "demo", workingDir: null },
    ]);
  });

  it("teardown: a liveness read that outlives its bound keeps the row even with --force, and the refusal names the timeout", async () => {
    const regDir = mkdtempSync(path.join(sandbox, "teardown-"));
    const registryPath = path.join(regDir, "instances.json");
    const allocLockPath = path.join(regDir, "alloc");
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    // A stale isolated row: its checkout is gone, so only the liveness read can prove the release safe.
    let reg = allocateInstance(requireUsableInstanceRegistry(registryPath), "row1", {
      mode: "dev",
      installDir: path.join(regDir, "removed-checkout"),
      composeProject: "cinatra_row1",
      composeFiles: ["docker-compose.isolated.yml"],
      ports: { postgres: [15434] },
      appPort: 13300,
      offset: 10000,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: "new",
      state: "provisioning",
    }).registry;
    reg = markInstanceReady(reg, "row1", { sha: "deadbeef", ports: { postgres: [15434] } });
    writeInstanceRegistry(registryPath, reg);
    const before = readFileSync(registryPath, "utf8");
    const downs = [];
    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: (dir) => downs.push(dir),
      inspectProjectLiveness: () => {
        throw timeoutError("`docker ps` did not finish within 60 s; it was stopped.");
      },
    };

    const forced = await install.teardownInstance({ slug: "row1", force: true, log: () => {}, deps });
    expect(forced).toMatchObject({ released: false, reason: "inspect-failed" });
    expect(forced.error?.code).toBe("CHILD_TIMEOUT");
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(downs).toHaveLength(0);

    // The command rejects (the top-level catch exits 1), names the timeout, and still keeps the row.
    let caught = null;
    try {
      await install.runInstall(["--down", "--instance", "row1", "--yes", "--force"], { log: () => {}, deps });
    } catch (err) {
      caught = err;
    }
    expect(caught?.message).toMatch(/did not finish within 60 s; it was stopped/);
    expect(caught?.message).toMatch(/--force does not override a read that outlived its bound/);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(downs).toHaveLength(0);
  });

  it("the dry run's remote lookup: an expired bound is named in one warning and the ref resolves at clone", () => {
    const lines = [];
    const resolved = install.dryRunResolvedSha({
      cap: () => {
        throw timeoutError("`git ls-remote` did not finish within 60 s; it was stopped.");
      },
      repoUrl: "https://github.com/example/example.git",
      ref: "main",
      log: (l) => lines.push(l),
    });
    expect(resolved).toBe("<resolved at clone>");
    expect(lines).toEqual(["  ⚠ `git ls-remote` did not finish within 60 s; it was stopped. The ref is resolved at clone."]);
  });

  it("the existing checkout's current-commit log line: an expired bound is named and the update goes on", async () => {
    const dir = path.join(sandbox, "headlog-timeout");
    mkdirSync(dir, { recursive: true });
    const G = (args) =>
      execFileSync("git", args, {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        encoding: "utf8",
      }).trim();
    G(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    G(["add", "-A"]);
    G(["commit", "-q", "-m", "one"]);
    const head = G(["rev-parse", "HEAD"]);
    const lines = [];
    await expect(
      install.cloneOrUpdateHost({
        targetDir: dir,
        repoUrl: "https://github.com/example/example.git",
        ref: head,
        alreadyCheckout: true,
        force: false,
        yes: true,
        noFetch: true,
        log: (l) => lines.push(l),
        deps: {
          capture: () => {
            throw timeoutError("`git rev-parse` did not finish within 60 s; it was stopped.");
          },
        },
      }),
    ).resolves.toBe(head);
    expect(lines).toContain("  ⚠ The current commit was not read: `git rev-parse` did not finish within 60 s; it was stopped.");
  });
});

describe("the optional execution step keeps its warning policy for an expired bound", () => {
  it("a sandbox image build that outlives its bound is one named warning line; the step writes nothing and the install goes on", async () => {
    const dir = path.join(sandbox, "execution-step");
    mkdirSync(path.join(dir, "docker", "sandbox"), { recursive: true });
    writeFileSync(path.join(dir, "docker", "sandbox", "Dockerfile"), "FROM scratch\n");
    const lines = [];
    const built = [];
    await expect(
      install.provisionExecutionPlane({
        targetDir: dir,
        opts: { yes: true, execution: { mode: "local-dev" } },
        log: (l) => lines.push(l),
        deps: {
          commandExists: () => true,
          runOrThrow: (command, args, message) => {
            built.push(command);
            throw timeoutError(`${message} (\`docker build\` did not finish within 60 min; it was stopped.)`);
          },
          capture: () => {
            throw new Error("no read may follow the failed build");
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(built).toEqual(["docker"]);
    const warnings = lines.filter((l) => l.includes("⚠"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].startsWith("  ⚠ Execution-")).toBe(true);
    expect(warnings[0]).toContain("provisioning had an issue (continuing; run `cinatra instance execution doctor` to reconcile): ");
    expect(
      warnings[0].endsWith("Failed to build the sandbox L0 image (`docker build` did not finish within 60 min; it was stopped.)"),
    ).toBe(true);
    expect(existsSync(path.join(dir, ".env.local"))).toBe(false);
  });
});

describe("the companion sync's git children", () => {
  const TIMEOUT_MSG = "`git rev-parse` did not finish within 900 s; it was stopped.";
  const LOCAL_ORIGIN = path.join(path.sep, "srv", "example-companion.git");

  it("are judged by exit status: a zero exit returns its stdout whatever it said on stderr; a non-zero exit throws with its status", () => {
    withStandIn("git", 'echo "fatal: error" >&2; echo "the-answer"; exit 0', () => {
      expect(repoSync.runRepoSyncGit(["status"], sandbox).trim()).toBe("the-answer");
    });
    withStandIn("git", 'echo "ok: success"; exit 4', () => {
      let caught = null;
      try {
        repoSync.runRepoSyncGit(["status"], sandbox);
      } catch (err) {
        caught = err;
      }
      expect(caught?.status).toBe(4);
    });
  });

  it("are bounded from spawn with a named failure, and the child is gone after", { timeout: HARNESS_CASE_MS }, () => {
    const pidFile = path.join(sandbox, "sync-git.pid");
    const env = standInEnv("git", standInNeverExits(pidFile));
    try {
      const r = inHarness(SYNC_URL, `return m.runRepoSyncGit(["fetch", "origin"], ${JSON.stringify(sandbox)}, { timeoutMs: 2000 });`, {
        env,
      });
      expectNamedTimeout(r, /`git fetch` did not finish within 2 s; it was stopped/);
      expectGone(pidFile);
    } finally {
      killIfAlive(pidFile);
    }
  });

  it("the attestation re-check: a read that outlives its bound is never a quiet 'does not hold'", () => {
    const deps = {
      exists: () => true,
      git: () => {
        throw timeoutError(TIMEOUT_MSG);
      },
    };
    let caught = null;
    try {
      repoSync.attestationStillHolds({ dest: sandbox, sha: "a".repeat(40), deps });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("CHILD_TIMEOUT");
  });

  it("the registry seed's skew exemption: an attestation read that outlives its bound fails the collection named, never an empty exemption", () => {
    const deps = {
      exists: () => true,
      git: () => {
        throw timeoutError(TIMEOUT_MSG);
      },
    };
    let caught = null;
    let collected = null;
    try {
      collected = collectSkewExemptSources(
        { results: [{ dest: path.join(sandbox, "skew-attest"), pinnedSha: "c".repeat(40) }] },
        { verify: (a) => repoSync.attestationStillHolds({ ...a, deps }) },
      );
    } catch (err) {
      caught = err;
    }
    expect(collected).toBeNull();
    expect(caught?.code).toBe("CHILD_TIMEOUT");
  });

  it("the packed-path check: an index read that outlives its bound is never a quiet 'not provable'", () => {
    const deps = {
      git: () => {
        throw timeoutError("`git ls-files` did not finish within 900 s; it was stopped.");
      },
    };
    let caught = null;
    try {
      repoSync.packedPathsAreTrackedAndUnhidden({ dir: sandbox, files: ["index.js"], deps });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("CHILD_TIMEOUT");
  });

  it("the synced-tip attestation after a clone: a read that outlives its bound fails the sync, never drops the attestation quietly", () => {
    const ran = [];
    const deps = {
      exists: () => false,
      readdir: () => [],
      mkdirp: () => {},
      git: (args) => {
        ran.push(args.join(" "));
        if (args[0] === "clone") return "";
        throw timeoutError(TIMEOUT_MSG);
      },
    };
    let caught = null;
    try {
      repoSync.syncOneRepo({
        pkgName: "@example/companion",
        url: LOCAL_ORIGIN,
        branch: "main",
        dest: path.join(sandbox, "tip-attest"),
        force: false,
        deps,
        log: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe("CHILD_TIMEOUT");
    expect(ran[0]).toMatch(/^clone /);
  });

  it("the detached local-commit guard: a reachability read that outlives its bound fails the sync, never reports local commits", () => {
    const head = "b".repeat(40);
    const ran = [];
    const deps = {
      exists: () => true,
      readdir: () => ["a.txt"],
      mkdirp: () => {},
      git: (args) => {
        ran.push(args.join(" "));
        if (args[0] === "remote") return `${LOCAL_ORIGIN}\n`;
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "HEAD\n";
        if (args[0] === "rev-parse") return `${head}\n`;
        if (args.includes("status")) return "";
        if (args[0] === "rev-list") throw timeoutError("`git rev-list` did not finish within 900 s; it was stopped.");
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
    };
    let caught = null;
    let result = null;
    try {
      result = repoSync.syncOneRepo({
        pkgName: "@example/companion",
        url: LOCAL_ORIGIN,
        branch: "main",
        lockSha: "c".repeat(40),
        dest: path.join(sandbox, "detached-guard"),
        force: false,
        deps,
        log: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(result?.action).not.toBe("skipped-local-commits");
    expect(caught?.code).toBe("CHILD_TIMEOUT");
    expect(ran.some((a) => a.startsWith("rev-list"))).toBe(true);
    expect(ran.some((a) => a.startsWith("fetch") || a.startsWith("checkout"))).toBe(false);
  });

  describe("the pinned commit's presence", () => {
    let origin;
    let pin;
    const Gq = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        encoding: "utf8",
      }).trim();

    beforeAll(() => {
      const seed = path.join(sandbox, "pin-seed");
      mkdirSync(seed, { recursive: true });
      Gq(["init", "-q", "-b", "main"], seed);
      writeFileSync(path.join(seed, "a.txt"), "a\n");
      Gq(["add", "-A"], seed);
      Gq(["commit", "-q", "-m", "one"], seed);
      pin = Gq(["rev-parse", "HEAD"], seed);
      writeFileSync(path.join(seed, "b.txt"), "b\n");
      Gq(["add", "-A"], seed);
      Gq(["commit", "-q", "-m", "two"], seed);
      origin = path.join(sandbox, "pin-origin.git");
      Gq(["clone", "-q", "--bare", seed, origin], sandbox);
    });

    /** A fresh clone at the branch tip, one commit past the pin. */
    function freshDest(name) {
      const dest = path.join(sandbox, name);
      Gq(["clone", "-q", origin, dest], sandbox);
      expect(Gq(["rev-parse", "HEAD"], dest)).not.toBe(pin);
      return dest;
    }

    function depsWithPresence(answer, ran) {
      const base = repoSync.defaultRepoSyncDeps();
      return {
        ...base,
        git: (args, cwd) => {
          ran.push(args.join(" "));
          if (args[0] === "cat-file") throw answer;
          return base.git(args, cwd);
        },
      };
    }

    function syncTo(dest, sha, deps) {
      return repoSync.syncOneRepo({
        pkgName: "@example/companion",
        url: origin,
        branch: "main",
        sha,
        dest,
        force: false,
        deps,
        log: () => {},
      });
    }

    it("a presence read that fails with another status is an unread state: it throws, naming it, and fetches nothing", () => {
      const ran = [];
      const answer = Object.assign(new Error("Command failed: git ... ok: present"), { status: 128, signal: null });
      const dest = freshDest("pin-unread");
      expect(() => syncTo(dest, pin, depsWithPresence(answer, ran))).toThrow(
        /@example\/companion: could not read whether the pinned commit .* is present .*git exited 128/,
      );
      expect(ran.filter((a) => a.startsWith("fetch"))).toEqual([]);
      expect(Gq(["rev-parse", "HEAD"], dest)).not.toBe(pin);
    });

    it("a presence read that outlives its bound keeps its named failure (code CHILD_TIMEOUT) and fetches nothing", () => {
      const ran = [];
      const answer = timeoutError("`git cat-file` did not finish within 900 s; it was stopped.");
      const dest = freshDest("pin-timeout");
      let caught = null;
      try {
        syncTo(dest, pin, depsWithPresence(answer, ran));
      } catch (err) {
        caught = err;
      }
      expect(caught?.code).toBe("CHILD_TIMEOUT");
      expect(caught?.message).toMatch(/could not read whether the pinned commit .*`git cat-file` did not finish within 900 s/);
      expect(ran.filter((a) => a.startsWith("fetch"))).toEqual([]);
      expect(Gq(["rev-parse", "HEAD"], dest)).not.toBe(pin);
    });

    it("a presence read that exits 1 is absent: the exact commit is fetched and checked out", () => {
      const ran = [];
      const answer = Object.assign(new Error("Command failed"), { status: 1, signal: null });
      const dest = freshDest("pin-absent");
      syncTo(dest, pin, depsWithPresence(answer, ran));
      expect(ran).toContain(`fetch origin ${pin}`);
      expect(Gq(["rev-parse", "HEAD"], dest)).toBe(pin);
    });

    it("an object that is there but is no readable commit is never read as absent: nothing is fetched and the sync fails", () => {
      const dest = freshDest("pin-bogus");
      const bogus = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
        cwd: dest,
        input: "not a commit body",
        encoding: "utf8",
      }).trim();
      const ran = [];
      const base = repoSync.defaultRepoSyncDeps();
      const deps = {
        ...base,
        git: (args, cwd) => {
          ran.push(args.join(" "));
          return base.git(args, cwd);
        },
      };
      expect(() => syncTo(dest, bogus, deps)).toThrow();
      expect(ran.filter((a) => a.startsWith("fetch"))).toEqual([]);
      expect(Gq(["rev-parse", "HEAD"], dest)).not.toBe(bogus);
    });
  });
});
