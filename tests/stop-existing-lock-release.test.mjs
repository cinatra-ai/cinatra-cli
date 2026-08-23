// cinatra-cli#239 — `--on-conflict=stop-existing` must tear the holder down and
// release its reservation under ONE held alloc lock, and must be LOUD about a
// registry it cannot read.
//
// cinatra-cli#243 (review round 2) — and the stack it tears down must be the
// stack the operator was SHOWN. The row read under the lock is compared against
// the classifier's pre-lock snapshot, and a difference REFUSES. The
// `--teardown-existing` (`-v`) arm is pinned here too: it is the destructive
// half of this executor and no test reached it before.
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
  releaseInstance,
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

describe("stop-existing: down + release under ONE alloc lock (cinatra-cli#239/#243)", () => {
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

  const stopExistingArgv = (installDir, extra = []) => [
    "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
    "--yes", "--no-install", "--on-conflict", "stop-existing", ...extra,
  ];

  // A GENUINE same-slug re-provisioning, the way `provisionIsolatedInstance`
  // does it: the old row is RELEASED and a fresh one is allocated for the same
  // slug at the same directory. cinatra-cli#243 (review round 2, blocking) —
  // the compose project and the compose file are DERIVED FROM THE SLUG
  // (`cinatra_<slug>` at src/install.mjs:2910; the single generated
  // `docker-compose.cinatra-isolated.yml` at :3120-3127), so a real
  // re-provisioning reproduces both EXACTLY and the ports with them. Nothing is
  // hand-faked here: the real `releaseInstance` / `allocateInstance` /
  // `markInstanceReady` run, so the replacement row's minted identity is the one
  // the registry itself mints.
  //
  // And the replacement row is forced to carry the OLD row's `createdAt`. That
  // is the hard case, not a convenience: `createdAt` is an ISO stamp with
  // millisecond resolution, so two row creations inside one millisecond share
  // it, and a test that merely waited for the clock to tick would prove only
  // that the two installs started at different times — not that the identity
  // distinguishes them. Pinning the stamp leaves `instanceNonce` as the ONLY
  // difference between the two rows, which is exactly the claim under test.
  function reprovisionSameSlug(slug, dir) {
    const before = readInstanceRegistry(regPath).registry;
    const old = before.instances[slug];
    const { registry: released } = releaseInstance(before, slug);
    let reg = allocateInstance(released, slug, {
      mode: "dev",
      installDir: dir,
      // Identical on every field a re-provisioning derives from the slug.
      composeProject: old.composeProject,
      composeFiles: [...old.composeFiles],
      ports: { ...old.ports },
      appPort: old.appPort,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg = markInstanceReady(reg, slug);
    // Collide the stamp deliberately — see above.
    reg.instances[slug] = { ...reg.instances[slug], createdAt: old.createdAt };
    writeInstanceRegistry(regPath, reg);
    return { before: old.instanceNonce, after: reg.instances[slug].instanceNonce };
  }

  // Make the seeded row look like one written by an OLDER cinatra-cli: before
  // `instanceNonce` existed (cinatra-cli#243), rows carried `createdAt` and
  // nothing else minted per row. Such a row must keep working — that is the
  // backward-compatible fallback the identity comparison promises.
  function stripMintedNonce(slug) {
    const reg = readInstanceRegistry(regPath).registry;
    const { instanceNonce, ...legacy } = reg.instances[slug];
    expect(instanceNonce).toEqual(expect.any(String));
    reg.instances[slug] = legacy;
    writeInstanceRegistry(regPath, reg);
    return legacy;
  }

  // Rewrite the seeded row IN PLACE, as a concurrent install re-provisioning the
  // slug at the same directory would: a new compose project and a new generated
  // compose file, same `installDir`.
  function reprovisionRow(slug, { project, files }) {
    const reg = readInstanceRegistry(regPath).registry;
    reg.instances[slug].composeProject = project;
    reg.instances[slug].composeFiles = files;
    writeInstanceRegistry(regPath, reg);
  }

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

  it("REFUSES when the row was re-provisioned in the classify-to-lock window", async () => {
    // cinatra-cli#243 (review round 2, blocking). `holder` is the classifier's
    // snapshot, taken before the lock. A slug re-provisioned at the SAME
    // directory in that window is a live, in-flight concurrent install — downing
    // its stack and releasing its row destroys it. Adopting the fresher row (the
    // behaviour this replaces) did exactly that.
    //
    // The window is injected deterministically rather than raced: the co-use
    // capability probe is the last seam to run before the executor takes the
    // lock, so rewriting the row from there lands exactly in that window.
    const otherDir = path.join(sandbox, "restale-holder");
    seedRemappedHolder("restaleother", otherDir);

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "restale-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          probeCookiePrefixSupport: () => {
            reprovisionRow("restaleother", {
              project: "cinatra_restale_v2",
              files: ["docker-compose.cinatra-isolated.v2.yml"],
            });
            return false;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(
      // cinatra-cli#243 (review round 2, NEW 3): this argv carries NO
      // `--teardown-existing`, so nothing prompted — the window is
      // classification-to-lock, and the message must say so rather than send a
      // scripted operator looking for a confirm that was never displayed. The
      // `-v` arm keeps the think-time wording (see the `--teardown-existing`
      // test below), exactly as the `-v` clause is already conditional.
      /instance "restaleother" was re-provisioned between the port-conflict classification and this command taking the allocation lock \(confirmed cinatra_restaleother, registry now records cinatra_restale_v2\)/,
    );

    // Neither stack is touched: not the one that was confirmed, and certainly
    // not the concurrent install's.
    expect(downCalls).toEqual([]);
    // And the concurrent install's row survives untouched — its reservation was
    // never released out from under it.
    const row = readInstanceRegistry(regPath).registry.instances.restaleother;
    expect(row.composeProject).toBe("cinatra_restale_v2");
    expect(row.composeFiles).toEqual(["docker-compose.cinatra-isolated.v2.yml"]);
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(reserved.has(16379)).toBe(true);
    expect(reserved.has(3300)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("REFUSES a same-slug RE-PROVISION that reproduces the project and the files exactly", async () => {
    // cinatra-cli#243 (review round 2, THE blocking finding). The previous
    // comparison read `composeProject` and the compose file paths only. Both are
    // derived from the slug, so provisioning the SAME slug twice mints a second,
    // completely different install that is byte-identical on both fields — the
    // drift check saw no difference, and the stop tore down the concurrent
    // install's stack and released its band.
    //
    // This is the reviewer's case, run for real: seed one install, then in the
    // classify-to-lock window release its row and provision the slug again
    // through the actual registry writers. Only the identity the registry mints
    // when it CREATES a row differs, and that is what must refuse.
    const otherDir = path.join(sandbox, "reprov-holder");
    seedRemappedHolder("reprovother", otherDir);
    const seeded = readInstanceRegistry(regPath).registry.instances.reprovother;

    const downCalls = [];
    let stamps = null;
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "reprov-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          probeCookiePrefixSupport: () => {
            stamps = reprovisionSameSlug("reprovother", otherDir);
            return false;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(/instance "reprovother" was re-provisioned[\s\S]*The registry row itself was REPLACED/);

    // The premise the refusal has to survive on: project and files are IDENTICAL
    // across the two installs, so nothing but the minted identity distinguishes
    // them. If this ever stops holding, the test has stopped testing the defect.
    const replacement = readInstanceRegistry(regPath).registry.instances.reprovother;
    expect(replacement.composeProject).toBe(seeded.composeProject);
    expect(replacement.composeFiles).toEqual(seeded.composeFiles);
    expect(replacement.installDir).toBe(seeded.installDir);
    // The stamp is IDENTICAL by construction, so `createdAt` could not have
    // refused this: the random per-row `instanceNonce` is the only thing that
    // differs, and it is the only thing that could have refused.
    expect(replacement.createdAt).toBe(seeded.createdAt);
    expect(replacement.instanceNonce).toEqual(expect.any(String));
    expect(replacement.instanceNonce).not.toBe(seeded.instanceNonce);
    expect(stamps).toEqual({ before: seeded.instanceNonce, after: replacement.instanceNonce });

    // Nothing of the concurrent install is touched: its stack is not downed, its
    // row is not released, its whole band is still reserved, and the lock the
    // refusal threw inside is not leaked.
    expect(downCalls).toEqual([]);
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(reserved.has(16379)).toBe(true);
    expect(reserved.has(15435)).toBe(true);
    expect(reserved.has(3300)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("--teardown-existing REFUSES a same-slug RE-PROVISION rather than `down -v` it", async () => {
    // The destructive half of the same blocking finding. The typed confirm named
    // the first install's project; the second install reuses that exact project
    // name, so `down -v` would delete the named volumes of a stack the operator
    // never saw — and, because the project name matches, would look correct in
    // every log line while doing it.
    const otherDir = path.join(sandbox, "reprov-v-holder");
    seedRemappedHolder("reprovvother", otherDir);

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "reprov-v-new"), ["--teardown-existing"]), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          // The re-provision lands INSIDE the typed confirm — the window really
          // is human think-time on this arm, which is why the message keeps that
          // wording here and drops it on the arm that never prompts.
          typedConfirm: async () => {
            reprovisionSameSlug("reprovvother", otherDir);
            return true;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(
      /was re-provisioned while the confirmation was pending[\s\S]*The registry row itself was REPLACED[\s\S]*deleting its named volumes irreversibly/,
    );

    // No `down` at all — least of all one carrying `-v`.
    expect(downCalls).toEqual([]);
    const row = readInstanceRegistry(regPath).registry.instances.reprovvother;
    expect(row).toBeTruthy();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("REFUSES a row that appears for a LABEL-PROVEN holder — it cannot be told apart from a concurrent install", async () => {
    // cinatra-cli#243 (review round 2, codex): the hole in a SYMMETRIC identity
    // rule. A label/marker-proven holder is a synthesized object with no
    // registry row behind it, so it carries no minted identity. "Compare only
    // when both sides have one" therefore DISABLES the identity check exactly
    // there — and a row that appears at that directory after classification is
    // slug-derived-identical on project and compose files, so it sails through
    // project+files and its stack is torn down. That is the original blocking
    // defect reached through the proven-holder door.
    //
    // The window is injected the way it really opens: the registry is
    // unreadable when the backfill runs (so the backfill declines and the holder
    // stays synthesized), and readable — with a row for the slug — by the time
    // the executor takes the lock.
    const otherDir = path.join(sandbox, "provenrace-holder");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(regPath, "{ this is not json", "utf8");

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "provenrace-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir, {
            "ai.cinatra.managed": "true",
            "ai.cinatra.kind": "instance",
            "ai.cinatra.instance": "provenracer",
            "ai.cinatra.project": "cinatra_provenracer",
          }),
          probeCookiePrefixSupport: () => {
            // The concurrent install lands its row: same slug, same directory,
            // and — because both are derived from the slug — the same compose
            // project and the same generated compose file the label proof named.
            seedRemappedHolder("provenracer", otherDir);
            return false;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(
      /instance "provenracer" was re-provisioned[\s\S]*recognised from its Docker labels\/marker rather than from a registry row/,
    );

    // The premise: project and files are identical, so nothing but the identity
    // could have refused this.
    const row = readInstanceRegistry(regPath).registry.instances.provenracer;
    expect(row.composeProject).toBe("cinatra_provenracer");
    expect(row.composeFiles).toEqual(["docker-compose.cinatra-isolated.yml"]);

    // The concurrent install keeps its stack, its row and its whole band.
    expect(downCalls).toEqual([]);
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(reserved.has(16379)).toBe(true);
    expect(reserved.has(3300)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a LEGACY row with NO minted nonce still stops — the identity falls back to `createdAt`", async () => {
    // Backward compatibility, stated because the review required it to be
    // stated (cinatra-cli#243). `instanceNonce` is minted at row CREATION, so
    // rows written by an older cinatra-cli have none. They must not be refused:
    // their identity falls back to `createdAt`, which is what this branch
    // compared before the nonce existed, and which is still strictly more than
    // the project+files comparison it replaced. A registry file written before
    // the upgrade keeps working without a migration.
    const otherDir = path.join(sandbox, "legacy-holder");
    seedRemappedHolder("legacyother", otherDir);
    const legacy = stripMintedNonce("legacyother");
    expect(legacy.instanceNonce).toBeUndefined();

    const downCalls = [];
    const res = await runInstall(stopExistingArgv(path.join(sandbox, "legacy-new")), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir),
        runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
      }),
    });

    expect(res.infraPlan).toBe("default");
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].composeProject).toBe("cinatra_legacyother");
    const after = readInstanceRegistry(regPath).registry;
    expect(after.instances.legacyother).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("REFUSES when a LEGACY row is REPLACED by a freshly minted one, even at the same `createdAt`", async () => {
    // The other half of the backward-compatible fallback, and the reason
    // `rowMintedIdentity` PREFIXES what it returns. The confirmed side is a
    // legacy row, so it identifies by its stamp; the replacement is a row
    // created since this change, so it identifies by its nonce. The stamp is
    // pinned to the legacy row's own value, so a bare string comparison of the
    // two identities would have matched and torn the replacement down. The
    // prefix is what keeps `createdAt:<t>` and `nonce:<u>` distinct — a row that
    // changed which kind of identity it carries is a row that was RE-CREATED.
    const otherDir = path.join(sandbox, "legacyrepl-holder");
    seedRemappedHolder("legacyreplother", otherDir);
    stripMintedNonce("legacyreplother");

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "legacyrepl-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          probeCookiePrefixSupport: () => {
            reprovisionSameSlug("legacyreplother", otherDir);
            return false;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(/instance "legacyreplother" was re-provisioned[\s\S]*The registry row itself was REPLACED/);

    // The premise: the stamp is identical and the replacement carries a nonce.
    const replacement = readInstanceRegistry(regPath).registry.instances.legacyreplother;
    expect(replacement.instanceNonce).toEqual(expect.any(String));
    expect(downCalls).toEqual([]);
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(regPath).registry });
    expect(reserved.has(16379)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("REFUSES on a moved compose FILE SET even when the project name is unchanged", async () => {
    // The review's remedy names project identity AND compose files: the file set
    // decides which containers a `down` reaches just as much as `-p` does, so a
    // re-provision that kept the project name but regenerated onto a different
    // file must not be adopted either.
    const otherDir = path.join(sandbox, "filedrift-holder");
    seedRemappedHolder("filedrifter", otherDir);

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "filedrift-new")), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          probeCookiePrefixSupport: () => {
            reprovisionRow("filedrifter", {
              project: "cinatra_filedrifter", // unchanged
              files: ["docker-compose.yml", "docker-compose.cinatra-isolated.yml"],
            });
            return false;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(
      /was re-provisioned between the port-conflict classification and this command taking the allocation lock[\s\S]*compose files moved too/,
    );

    expect(downCalls).toEqual([]);
  });

  it("--teardown-existing REFUSES rather than `down -v` a project the confirm never displayed", async () => {
    // The worst case of the same defect (review round 2, finding 2): the
    // operator reads one project name, types `delete <slug>` against it, and the
    // volumes destroyed belong to a project they were never shown. The typed
    // confirm awaits a human, so the window is think-time — seconds to minutes —
    // not a narrow race. Here the re-provision lands INSIDE the confirm, which
    // is literally "while the confirmation was pending".
    const otherDir = path.join(sandbox, "vdrift-holder");
    seedRemappedHolder("vdrifter", otherDir);

    const downCalls = [];
    const prompts = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "vdrift-new"), ["--teardown-existing"]), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          typedConfirm: async (question, phrase) => {
            prompts.push({ question, phrase });
            reprovisionRow("vdrifter", {
              project: "cinatra_vdrift_v2",
              files: ["docker-compose.cinatra-isolated.v2.yml"],
            });
            return true; // the operator confirmed — against the OLD project
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(
      /instance "vdrifter" was re-provisioned while the confirmation was pending \(confirmed cinatra_vdrifter, registry now records cinatra_vdrift_v2\)/,
    );

    // The prompt named the project the operator was shown …
    expect(prompts.length).toBe(1);
    expect(prompts[0].question).toContain("cinatra_vdrifter");
    expect(prompts[0].phrase).toBe("delete vdrifter");
    // … and NO `down` ran at all, so no volumes were deleted.
    expect(downCalls).toEqual([]);
    // The refusal says why `-v` makes this the worst case, not just that it refused.
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "vdrift-new2"), ["--teardown-existing"]), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          typedConfirm: async () => {
            reprovisionRow("vdrifter", {
              project: "cinatra_vdrift_v3",
              files: ["docker-compose.cinatra-isolated.v3.yml"],
            });
            return true;
          },
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(/--teardown-existing is set, so continuing would have run `down -v`/);
    expect(downCalls).toEqual([]);
  });

  it("--teardown-existing on a STABLE row downs with `-v` and releases the band", async () => {
    // The plain `-v` happy path — `withVolumes` was never exercised at all
    // before (review round 2, finding 3). It pins that the confirmed phrase is
    // the slug's, that `-v` actually reaches `composeDown`, and that the
    // reservation is still released whole.
    const otherDir = path.join(sandbox, "vhappy-holder");
    seedRemappedHolder("vhappy", otherDir);

    const downCalls = [];
    const prompts = [];
    const res = await runInstall(stopExistingArgv(path.join(sandbox, "vhappy-new"), ["--teardown-existing"]), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir),
        typedConfirm: async (question, phrase) => {
          prompts.push({ question, phrase });
          return true;
        },
        runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts, lockHeld: allocLockHeld() }),
      }),
    });

    expect(res.infraPlan).toBe("default");
    expect(prompts).toEqual([
      {
        question: expect.stringContaining('will DELETE instance "vhappy"\'s data volumes (project cinatra_vhappy)'),
        phrase: "delete vhappy",
      },
    ]);
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].dir).toBe(otherDir);
    expect(downCalls[0].composeProject).toBe("cinatra_vhappy");
    expect(downCalls[0].volumes).toBe(true);
    expect(downCalls[0].lockHeld).toBe(true);

    const after = readInstanceRegistry(regPath).registry;
    expect(after.instances.vhappy).toBeUndefined();
    const afterReserved = reservedPorts({ instanceRegistry: after });
    expect(afterReserved.has(16379)).toBe(false);
    expect(afterReserved.has(3300)).toBe(false);
  });

  it("a LEGACY sentinel row is confirmed as what the `down` really targets, never as \"cinatra\"", async () => {
    // cinatra-cli#243 (codex): `composeProjectArgForRow` returns null for the
    // pre-#35 `"cinatra"` sentinel, so the `down` passes NO `-p` and Compose
    // derives the project from the directory name. Printing the recorded
    // "cinatra" would name a project the teardown never touches — and the typed
    // `-v` confirm would then be taken against a stack that was never displayed,
    // which is exactly the failure the refusal above exists to prevent, reached
    // by a different road.
    const otherDir = path.join(sandbox, "legacy-holder");
    seedRemappedHolder("legacyrow", otherDir);
    const reg = readInstanceRegistry(regPath).registry;
    reg.instances.legacyrow.composeProject = "cinatra"; // the legacy sentinel
    writeInstanceRegistry(regPath, reg);

    const downCalls = [];
    const prompts = [];
    await runInstall(stopExistingArgv(path.join(sandbox, "legacy-new"), ["--teardown-existing"]), {
      log: () => {},
      deps: flowDeps({
        detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
        liveComposeInspect: holderOwns5434(otherDir),
        typedConfirm: async (question, phrase) => {
          prompts.push({ question, phrase });
          return true;
        },
        runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
      }),
    });

    // The `down` really does omit `-p` …
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].composeProject).toBe(null);
    expect(downCalls[0].volumes).toBe(true);
    // … so the confirm must NOT claim a project named "cinatra", and must say
    // where the name actually comes from.
    expect(prompts.length).toBe(1);
    expect(prompts[0].question).not.toMatch(/project cinatra\b/);
    expect(prompts[0].question).toContain("no recorded Compose project");
    expect(prompts[0].question).toContain(otherDir);
  });

  it("--teardown-existing DECLINED stops nothing", async () => {
    // The typed confirm is the only gate on irreversible deletion; a refusal
    // must not fall through to a volume-preserving `down` either.
    const otherDir = path.join(sandbox, "vdecline-holder");
    seedRemappedHolder("vdecline", otherDir);
    const registryBefore = readFileSync(regPath, "utf8");

    const downCalls = [];
    await expect(
      runInstall(stopExistingArgv(path.join(sandbox, "vdecline-new"), ["--teardown-existing"]), {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          liveComposeInspect: holderOwns5434(otherDir),
          typedConfirm: async () => false,
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      }),
    ).rejects.toThrow(/Aborted: volume teardown of "vdecline" not confirmed/);

    expect(downCalls).toEqual([]);
    expect(readFileSync(regPath, "utf8")).toBe(registryBefore);
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
