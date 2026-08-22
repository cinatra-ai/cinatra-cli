// cinatra-cli#239 — `--on-conflict=stop-existing` must tear the holder down and
// release its reservation under ONE held alloc lock, and must be LOUD about a
// registry it cannot read.
//
// The defect this pins (same family as cinatra-cli#232, which #235 released for
// the teardown path): the `down` ran OUTSIDE the alloc lock, and the registry
// read was wrapped in `try { … } catch { reg = null }`. A registry that could
// not be parsed therefore collapsed into "there is no row to release" — the
// stopped instance kept its whole port reservation while the CLI reported the
// stack stopped, and the operator was told nothing.
//
// Docker is fully stubbed through the injectable `deps` seam (as everywhere in
// this suite): no daemon, no containers, no network. The registry writer, the
// allocator and the real alloc lock are the genuine ones.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runInstall } from "../src/install.mjs";
import { reservedPorts } from "../src/instance-alloc.mjs";
import {
  allocateInstance,
  markInstanceReady,
  readInstanceRegistry,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";

// --- fixture origin: a minimal valid cinatra checkout on a file:// remote ----
function buildFixtureOrigin(sandbox) {
  const src = path.join(sandbox, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    path.join(src, "packages", "migrations", "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
  );
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }));
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      stdio: "ignore",
    });
  G(["init", "-b", "main"], src);
  G(["add", "-A"], src);
  G(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  G(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "nango-server", host: "0.0.0.0", port: 3003 },
  { service: "nango-db", host: "127.0.0.1", port: 5435 },
];

const RESOLVED_CONFIG = {
  name: "cinatra",
  services: {
    postgres: { image: "postgres:16", ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }] },
    redis: { image: "redis", ports: [{ published: "6379", target: 6379, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }] },
    "nango-server": { image: "nango", ports: [{ published: "3003", target: 3003, host_ip: "0.0.0.0", protocol: "tcp", mode: "host" }] },
    "nango-db": { image: "postgres:16", ports: [{ published: "5435", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }] },
  },
  networks: { default: { name: "cinatra_default" } },
  volumes: { "cinatra-postgres": { name: "cinatra_cinatra-postgres" } },
};

describe("stop-existing: down + release under ONE alloc lock (cinatra-cli#239)", () => {
  let sandbox;
  let originRepo;
  let regPath;
  let lockPath;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-239-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    regPath = path.join(d, "instances.json");
    lockPath = path.join(d, "alloc.lock");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = lockPath;
  });

  function flowDeps(extra = {}) {
    return {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
      commandExists: () => true,
      composeAvailable: () => true,
      composePublishedPortsForTarget: () => DEFAULT_BAND,
      composeConfigForFiles: () => RESOLVED_CONFIG,
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      bringUpInfra: () => {},
      runComposeDown: () => {},
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      ...extra,
    };
  }

  // A holder on a REMAPPED band: its reservation is observable after the new
  // DEFAULT install lands, which itself re-reserves the default band's ports.
  function seedRemappedHolder(slug, dir) {
    mkdirSync(dir, { recursive: true });
    let reg = allocateInstance({ version: 1, instances: {} }, slug, {
      mode: "dev",
      installDir: dir,
      composeProject: `cinatra_${slug}`,
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      // postgres:5434 is the port it actually HOLDS (the conflict); the rest is
      // its remapped band, which nothing else reserves.
      ports: { postgres: [5434], redis: [16379], "nango-db": [15435] },
      appPort: 3300,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg = markInstanceReady(reg, slug);
    writeInstanceRegistry(regPath, reg);
  }

  // Live-inspect rows proving `dir` owns 5434 (→ classified `other-cinatra`).
  const holderOwns5434 = (dir, labels = {}) => () => [
    {
      Config: { Labels: { "com.docker.compose.project.working_dir": dir, ...labels } },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    },
  ];

  // Is the alloc lock EXCLUSIVELY held right now? `openSync(path, "wx")` is the
  // very mutex `withRegistryLock` uses, so this asks the lock itself rather than
  // merely noting that a file exists (codex round 2): EEXIST means a holder has
  // it; a successful open means it was free, and we hand the slot straight back.
  function allocLockHeld() {
    try {
      closeSync(openSync(lockPath, "wx"));
      rmSync(lockPath, { force: true });
      return false;
    } catch (err) {
      return err?.code === "EEXIST";
    }
  }

  const stopExistingArgv = (installDir) => [
    "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
    "--yes", "--no-install", "--on-conflict", "stop-existing",
  ];

  it("runs the `down` while the alloc lock is HELD, and releases the stopped row's WHOLE reservation", async () => {
    const otherDir = path.join(sandbox, "held-holder");
    seedRemappedHolder("heldother", otherDir);

    // Before: the holder's remapped band + app port are reserved.
    const before = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(before.has(16379)).toBe(true);
    expect(before.has(15435)).toBe(true);
    expect(before.has(3300)).toBe(true);

    const downCalls = [];
    const res = await runInstall(stopExistingArgv(path.join(sandbox, "held-new")), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir),
        runComposeDown: (dir, opts) => {
          // THE PIN: the alloc lock is EXCLUSIVELY held while the `down` runs.
          // Pre-#239 the `down` ran before `withAllocLock` was ever taken, so a
          // concurrent install could slip between the stop and the release.
          downCalls.push({ dir, ...opts, lockHeld: allocLockHeld() });
        },
      }),
    });

    expect(res.infraPlan).toBe("default");
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].dir).toBe(otherDir);
    expect(downCalls[0].composeProject).toBe("cinatra_heldother");
    expect(downCalls[0].lockHeld).toBe(true);

    // The row is gone and EVERY port it held left the reserved set together —
    // not a subset. (5434 is back only because the new DEFAULT row reserves it.)
    const after = readInstanceRegistry(regPath).registry;
    expect(after.instances.heldother).toBeUndefined();
    const afterReserved = reservedPorts({ instanceRegistry: after });
    expect(afterReserved.has(16379)).toBe(false);
    expect(afterReserved.has(15435)).toBe(false);
    expect(afterReserved.has(3300)).toBe(false);

    // The lock is not leaked past the critical section.
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a FAILED `down` releases NOTHING — and it failed under the lock", async () => {
    const otherDir = path.join(sandbox, "faildown-holder");
    seedRemappedHolder("faildother", otherDir);
    const registryBefore = readFileSync(regPath, "utf8");
    // The per-checkout hint describes a stack that is still up after a failed
    // `down` — it must survive with the reservation (codex round 3).
    const marker = path.join(otherDir, ".cinatra", "instance.json");
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, JSON.stringify({ slug: "faildother" }), "utf8");

    let lockHeldDuringDown = null;
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "faildown-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          runComposeDown: () => {
            lockHeldDuringDown = allocLockHeld();
            // What the real `composeDown` does on a non-zero exit.
            throw new Error("docker compose down failed (exit 1).");
          },
        }),
      }),
    ).rejects.toThrow(/docker compose down failed/);

    expect(lockHeldDuringDown).toBe(true);
    // Byte-identical: not a single port was handed out while the stack may be up.
    expect(readFileSync(regPath, "utf8")).toBe(registryBefore);
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(reserved.has(16379)).toBe(true);
    expect(reserved.has(15435)).toBe(true);
    expect(reserved.has(3300)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("downs the row as it reads UNDER THE LOCK, not the classifier's pre-lock snapshot", async () => {
    // Codex round 1, blocking: `holder` is resolved by the classifier BEFORE the
    // lock is taken. If the slug is re-provisioned at the same directory in that
    // window, its recorded compose project has moved on. Downing the stale
    // project and then releasing the FRESH row leaves a live stack unregistered
    // with its ports handed back — this leak inverted.
    //
    // The window is injected deterministically rather than raced: the co-use
    // capability probe is the last seam to run before the executor takes the
    // lock, so rewriting the row from there lands exactly in that window.
    const otherDir = path.join(sandbox, "restale-holder");
    seedRemappedHolder("restaleother", otherDir);

    const downCalls = [];
    const res = await runInstall(stopExistingArgv(path.join(sandbox, "restale-new")), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir),
        probeCookiePrefixSupport: () => {
          // Re-provisioned at the SAME dir under a new project + compose file.
          const reg = readInstanceRegistry(regPath).registry;
          reg.instances.restaleother.composeProject = "cinatra_restale_v2";
          reg.instances.restaleother.composeFiles = ["docker-compose.cinatra-isolated.v2.yml"];
          writeInstanceRegistry(regPath, reg);
          return false;
        },
        runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
      }),
    });

    expect(res.infraPlan).toBe("default");
    expect(downCalls.length).toBe(1);
    // The stack that is actually up — not `cinatra_restaleother`.
    expect(downCalls[0].composeProject).toBe("cinatra_restale_v2");
    expect(downCalls[0].composeFiles).toEqual(["docker-compose.cinatra-isolated.v2.yml"]);
    // And the row it downed is the row it released.
    expect(readInstanceRegistry(regPath).registry.instances.restaleother).toBeUndefined();
  });

  it("a MISSING registry is not a read failure — a label-proven holder still stops", async () => {
    // The loud read must not turn "no registry yet" into a refusal (codex round
    // 3). `requireUsableInstanceRegistry` reads a missing file as an EMPTY
    // registry, so a holder proven only by its labels still stops cleanly.
    const otherDir = path.join(sandbox, "noreg-holder");
    mkdirSync(otherDir, { recursive: true });
    expect(existsSync(regPath)).toBe(false);

    const downCalls = [];
    const res = await runInstall(stopExistingArgv(path.join(sandbox, "noreg-new")), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir, {
          "ai.cinatra.managed": "true",
          "ai.cinatra.kind": "instance",
          "ai.cinatra.instance": "noregholder",
          "ai.cinatra.project": "cinatra_noregholder",
        }),
        runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
      }),
    });

    expect(res.infraPlan).toBe("default");
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].composeProject).toBe("cinatra_noregholder");
  });

  it("an UNREADABLE registry is LOUD — and costs no containers", async () => {
    // A label-proven holder (no readable row) reaches the executor even with a
    // malformed registry: the classifier tolerates one, the backfill is
    // best-effort. Pre-#239 the executor swallowed the read error too, stopped
    // the stack, released nothing, and said nothing — the exact leak of #239.
    const otherDir = path.join(sandbox, "loud-holder");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(regPath, "{ this is not json", "utf8");
    const registryBefore = readFileSync(regPath, "utf8");

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "loud-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir, {
            "ai.cinatra.managed": "true",
            "ai.cinatra.kind": "instance",
            "ai.cinatra.instance": "loudholder",
            "ai.cinatra.project": "cinatra_loudholder",
          }),
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(/Instance registry at .* is malformed and was NOT modified/);

    // The registry is read BEFORE the `down`, so the refusal costs no containers.
    expect(downCalls).toEqual([]);
    // The malformed file is left in place for manual repair, never auto-reset.
    expect(readFileSync(regPath, "utf8")).toBe(registryBefore);
  });
});
