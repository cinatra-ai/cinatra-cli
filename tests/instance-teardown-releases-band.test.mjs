// cinatra-cli#232 — tearing an instance down must RELEASE its port reservations.
//
// Evidence (cinatra#2654 clean-install matrix, finding D5): after five isolated
// installs, all fully torn down by hand, the sixth refused with "Could not find
// a free infra band offset (10000..50000) … every candidate collides with a
// reserved port". The stacks were gone; the registry rows were not, and a row IS
// the reservation (`reservedPorts()` reads its `appPort` + `ports`). The band
// allocator only searches 10000..50000 in steps of 10000 — exactly five slots —
// so five orphaned rows exhaust it.
//
// These tests drive the REAL allocator, the REAL registry writer and the REAL
// `teardownInstance` against a temp registry + alloc lock, with `docker compose
// down` injected. No Docker, no services, no network.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  legacyBasenameProject,
  planInstanceTeardown,
  resolveTeardownTarget,
  teardownIdentity,
  teardownIdentityKey,
  teardownInstance,
  runInstall,
  rollbackIsolatedInstance,
} from "../src/install.mjs";
import {
  allocateInstance,
  getInstance,
  listInstances,
  markInstanceReady,
  readInstanceRegistry,
  requireUsableInstanceRegistry,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";
import {
  allocateAppPort,
  allocateBandOffset,
  describeInstanceReservations,
  reservedPorts,
  withAllocLock,
  BAND_OFFSET_MAX,
} from "../src/instance-alloc.mjs";
import { ISOLATED_COMPOSE_FILENAME } from "../src/install-isolation.mjs";

// The default published band of a cinatra checkout (the shape `docker compose
// config` yields; only the numbers matter here).
const BASE_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "nango-db", host: "127.0.0.1", port: 5435 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "neo4j", host: "127.0.0.1", port: 7474 },
  { service: "neo4j", host: "127.0.0.1", port: 7687 },
  { service: "verdaccio", host: "127.0.0.1", port: 4873 },
  { service: "nango-server", host: "127.0.0.1", port: 3003 },
  { service: "wayflow", host: "127.0.0.1", port: 3010 },
];

const tmp = [];
function mkTmp(prefix = "cli232-") {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
}
afterEach(() => {
  while (tmp.length) {
    try {
      rmSync(tmp.pop(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function newRegistryPaths() {
  const regDir = mkTmp("cli232-reg-");
  return { registryPath: path.join(regDir, "instances.json"), allocLockPath: path.join(regDir, "alloc") };
}

/** Group a remapped band into the registry's per-service `{ svc: [ports] }`. */
function portsMapFor(remapped) {
  const out = {};
  for (const entry of remapped) (out[entry.service] ??= []).push(entry.port);
  return out;
}

/**
 * What `executeIsolatedInstall` does to the registry, minus Docker: allocate the
 * lowest free band offset + an app port, record a row, mark it ready. Also lays
 * down the two on-disk artifacts a teardown cleans (generated compose + marker).
 */
function installIsolated({ registryPath, slug, appPort }) {
  const targetDir = mkTmp(`cli232-${slug}-`);
  writeFileSync(path.join(targetDir, ISOLATED_COMPOSE_FILENAME), "services: {}\n");
  mkdirSync(path.join(targetDir, ".cinatra"), { recursive: true });
  writeFileSync(path.join(targetDir, ".cinatra", "instance.json"), JSON.stringify({ slug }));

  const registry = requireUsableInstanceRegistry(registryPath);
  const { offset, remapped } = allocateBandOffset({
    band: BASE_BAND,
    instanceRegistry: registry,
    extraReserved: appPort,
  });
  const ports = portsMapFor(remapped);
  let next = allocateInstance(registry, slug, {
    mode: "dev",
    installDir: targetDir,
    composeProject: `cinatra_${slug.replace(/-/g, "_")}`,
    composeFiles: [ISOLATED_COMPOSE_FILENAME],
    ports,
    appPort,
    offset,
    repoUrl: "https://github.com/cinatra-ai/cinatra.git",
    ref: "main",
    infraMode: "new",
    state: "provisioning",
  }).registry;
  next = markInstanceReady(next, slug, { sha: "deadbeef", ports });
  writeInstanceRegistry(registryPath, next);
  return { slug, targetDir, offset, ports, appPort };
}

function tryAllocateOffset(registryPath, appPort) {
  return allocateBandOffset({
    band: BASE_BAND,
    instanceRegistry: requireUsableInstanceRegistry(registryPath),
    extraReserved: appPort,
  });
}

function rowFor(registryPath, slug) {
  return getInstance(readInstanceRegistry(registryPath).registry, slug);
}

function recordingDown() {
  const calls = [];
  return { calls, fn: (dir, opts) => calls.push({ dir, opts }) };
}
const failingDown = () => {
  throw new Error("docker compose down failed (exit 1).");
};

/**
 * Satisfy `typedConfirm` the way a real operator does: a real TTY stdin carrying
 * the exact phrase. `typedConfirm` has no dependency seam and must not grow one —
 * a dep that can turn the irreversible-volume gate into a pass is exactly the
 * fail-open shape the reclaim gate's single-seam rule exists to prevent. So the
 * test supplies a terminal rather than a bypass, and stdout is captured so the
 * prompt the operator would have read can be asserted too.
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

// =========================================================================
describe("cinatra-cli#232 — install → teardown → install reuses the band", () => {
  it("reproduces D5: five torn-down-but-unreleased rows exhaust 10000..50000", () => {
    const { registryPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });

    const offsets = [];
    for (let i = 0; i < 5; i += 1) offsets.push(installIsolated({ registryPath, slug: `row${i + 1}`, appPort: 3300 + i }).offset);
    expect(offsets).toEqual([10000, 20000, 30000, 40000, 50000]);

    // The sixth install — with every stack already gone but no row released.
    expect(() => tryAllocateOffset(registryPath, 3305)).toThrow(/Could not find a free infra band offset/);
  });

  it("a teardown frees the band: the next install lands on the SAME offset", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const down = recordingDown();

    const first = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    expect(first.offset).toBe(10000);

    const result = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });

    expect(result.released).toBe(true);
    expect(down.calls).toHaveLength(1);
    expect(down.calls[0].opts).toMatchObject({ composeProject: "cinatra_row1", volumes: false });
    expect(rowFor(registryPath, "row1")).toBeNull();

    // The freed band is genuinely re-allocatable — same offset, same ports.
    const second = installIsolated({ registryPath, slug: "row1b", appPort: 3300 });
    expect(second.offset).toBe(10000);
    expect(second.ports).toEqual(first.ports);
  });

  it("five install+teardown cycles never exhaust the band (the acceptance)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const deps = { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn };

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const inst = installIsolated({ registryPath, slug: `cycle${cycle}`, appPort: 3300 });
      // Every cycle reuses the LOWEST offset, because the previous one released it.
      expect(inst.offset).toBe(10000);
      const r = await teardownInstance({ slug: `cycle${cycle}`, log: () => {}, deps });
      expect(r.released).toBe(true);
    }
    expect(listInstances(readInstanceRegistry(registryPath).registry)).toHaveLength(0);
  });

  it("releases the app port and EVERY infra port together, in one registry write", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });

    const before = reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry });
    const owned = [...Object.values(inst.ports).flat(), inst.appPort];
    for (const p of owned) expect(before.has(p)).toBe(true);

    await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn },
    });

    const after = reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry });
    // NOT "most of them": every single one, with no leftover partial reservation.
    for (const p of owned) expect(after.has(p)).toBe(false);
  });

  it("cleans the per-checkout hints (marker + generated compose) after a release", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });

    await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn },
    });

    expect(existsSync(path.join(inst.targetDir, ".cinatra", "instance.json"))).toBe(false);
    expect(existsSync(path.join(inst.targetDir, ISOLATED_COMPOSE_FILENAME))).toBe(false);
  });
});

// =========================================================================
describe("cinatra-cli#232 — a FAILED teardown releases nothing (atomicity)", () => {
  it("keeps the row and the WHOLE reservation when `docker compose down` fails", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const bytesBefore = readFileSync(registryPath, "utf8");

    const result = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: failingDown },
    });

    expect(result.released).toBe(false);
    expect(result.reason).toBe("down-failed");
    // Not merely "a row survives" — the registry file is byte-identical, so no
    // half-release (some ports dropped, others kept) is even representable.
    expect(readFileSync(registryPath, "utf8")).toBe(bytesBefore);

    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry });
    for (const p of [...Object.values(inst.ports).flat(), inst.appPort]) expect(reserved.has(p)).toBe(true);
    // And the band is still held — the still-standing stack is never handed out.
    expect(() => tryAllocateOffset(registryPath, 3301)).not.toThrow();
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000);
  });

  it("a retried teardown after a fixed `down` completes the release", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });

    await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: failingDown },
    });
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    const retry = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn },
    });
    expect(retry.released).toBe(true);
    expect(rowFor(registryPath, "row1")).toBeNull();
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("refuses a malformed registry instead of releasing part of it", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeFileSync(registryPath, '{"version":1,"instances":{"bad":{"slug":"bad"}}}');
    await expect(
      teardownInstance({
        slug: "bad",
        log: () => {},
        deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn },
      }),
    ).rejects.toThrow(/malformed and was NOT modified/);
  });

  it("never releases a row that no longer points at the dir we resolved", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const down = recordingDown();

    const result = await teardownInstance({
      slug: "row1",
      expectInstallDir: path.join(os.tmpdir(), "some-other-checkout"),
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });

    expect(result).toMatchObject({ released: false, reason: "dir-mismatch" });
    expect(down.calls).toHaveLength(0);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
  });
});

// =========================================================================
describe("cinatra-cli#232 — the pre-existing stale rows operators already have", () => {
  it("reclaims a row whose checkout is gone when nothing of its project is live", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    rmSync(inst.targetDir, { recursive: true, force: true }); // the operator's `rm -rf`
    const down = recordingDown();

    const result = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: down.fn,
        inspectProjectLiveness: () => ({ containerRows: [], volumeRows: [] }),
      },
    });

    expect(result.released).toBe(true);
    expect(down.calls).toHaveLength(0); // no compose file to `down` from — never guessed at
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("REFUSES to reclaim while the project's containers still run (they hold the ports)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    rmSync(inst.targetDir, { recursive: true, force: true });

    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: recordingDown().fn,
      inspectProjectLiveness: () => ({ containerRows: [{ Id: "abc" }], volumeRows: [] }),
    };
    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });
    expect(refused).toMatchObject({ released: false, reason: "stack-still-live", liveContainers: 1 });
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    // --force is the eyes-open override.
    const forced = await teardownInstance({ slug: "row1", force: true, log: () => {}, deps });
    expect(forced.released).toBe(true);
  });

  // ── The stale-row safety must not fail OPEN ─────────────────────────────
  // The reclaim gate is a refusal-unless---force guarantee: release the row only
  // after PROVING no container of the project survives. If an inspection ERROR is
  // folded into "zero containers", the guarantee evaporates in exactly the case it
  // exists for — Docker cannot answer, so containers may well be live holding
  // those ports, and we would reclaim the row AND skip the `down`.
  //
  // Both directions are pinned: "inspected: zero containers" still releases;
  // "could not inspect" refuses.

  /** A stale row (checkout removed) ready for the reclaim path. */
  function staleRow({ registryPath, slug = "row1", appPort = 3300 }) {
    const inst = installIsolated({ registryPath, slug, appPort });
    rmSync(inst.targetDir, { recursive: true, force: true }); // the operator's `rm -rf`
    return inst;
  }

  it("REFUSES to reclaim when the liveness inspection THROWS (an error is not an all-clear)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    staleRow({ registryPath });
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: down.fn,
      inspectProjectLiveness: () => {
        throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.");
      },
    };
    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });

    expect(refused).toMatchObject({ released: false, reason: "inspect-failed" });
    expect(refused.error?.message).toMatch(/Cannot connect to the Docker daemon/);
    // NOTHING released: the row, its whole reservation, the bytes on disk.
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(down.calls).toHaveLength(0);
    // And the band is still held — the reservation really did survive.
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000);

    // --force is the eyes-open override (the operator asserts what we could not prove).
    const forced = await teardownInstance({ slug: "row1", force: true, log: () => {}, deps });
    expect(forced.released).toBe(true);
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("treats a MALFORMED inspection result as 'could not inspect', never as zero containers", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    staleRow({ registryPath });

    // Every shape that is not a usable container list. `undefined` is the one the
    // old `?? live` fallback silently turned into "zero containers".
    for (const bad of [undefined, null, {}, { containerRows: null }, { containerRows: "nope" }, "garbage"]) {
      const result = await teardownInstance({
        slug: "row1",
        log: () => {},
        deps: {
          instanceRegistryPath: registryPath,
          allocLockPath,
          runComposeDown: recordingDown().fn,
          inspectProjectLiveness: () => bad,
        },
      });
      expect(result, `malformed inspection ${JSON.stringify(bad) ?? "undefined"} must refuse`).toMatchObject({
        released: false,
        reason: "inspect-failed",
      });
      expect(rowFor(registryPath, "row1")).not.toBeNull();
    }
  });

  // The reclaim gate's ONLY seam is `inspectProjectLiveness`. It used to also
  // accept `deps.inspectProjectOwnership`, which re-admitted the fail-open
  // inspector by name: a test injecting the permissive seam was honoured by the
  // strict gate, so the gate was never actually exercised. Pin that the
  // permissive name is now inert — injecting a fail-open all-clear under it must
  // NOT release; the strict default runs and refuses on the dead daemon.
  it("ignores a `inspectProjectOwnership` injection — the fail-open name is not a seam here", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    staleRow({ registryPath });
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const result = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: down.fn,
        // The fail-open inspector, offered under its own name, saying "all clear".
        inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
        // ...while Docker is in fact unreachable. The strict default must win.
        capture: () => null,
      },
    });

    expect(result).toMatchObject({ released: false, reason: "inspect-failed" });
    expect(result.error?.message).toMatch(/could not inspect Docker/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(down.calls).toHaveLength(0);
  });

  // The three above drive the INJECTED seam. These two drive the REAL default
  // inspector, because that is where the fail-open actually lived: the
  // best-effort `inspectProjectOwnership` never throws — it converts every docker
  // error into empty sets — so a teardown defaulting to it would fail open even
  // with the catch fixed. `capture` returns null on failure and "" on a genuinely
  // empty project; the strict inspector promotes that difference into a throw.
  it("the REAL inspector refuses when `docker ps` fails, and releases when it reports nothing", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    staleRow({ registryPath });
    const base = { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn };

    // (a) daemon down / permission denied / command failure → capture() === null.
    const refused = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { ...base, capture: () => null },
    });
    expect(refused).toMatchObject({ released: false, reason: "inspect-failed" });
    expect(refused.error?.message).toMatch(/could not inspect Docker.*docker ps -a` failed/s);
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    // (b) unparseable `docker inspect` output, with ids present → still an error,
    //     never "zero containers".
    const malformed = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: {
        ...base,
        capture: (_cmd, args) => (args.includes("-q") ? "container-id-1" : "<not json>"),
      },
    });
    expect(malformed).toMatchObject({ released: false, reason: "inspect-failed" });
    expect(malformed.error?.message).toMatch(/unparseable JSON/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    // (c) the real ALL-CLEAR: docker answered, exit 0, no containers ("" ≠ null).
    //     This is the distinction the fix turns on, so it must still release.
    const released = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: { ...base, capture: () => "" },
    });
    expect(released.released).toBe(true);
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("`--down` surfaces a failed inspection as a refusal naming the failure and the way out", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    staleRow({ registryPath });

    await expect(
      runInstall(["--down", "--instance", "row1", "--yes"], {
        log: () => {},
        deps: {
          instanceRegistryPath: registryPath,
          allocLockPath,
          runComposeDown: recordingDown().fn,
          capture: () => null,
        },
      }),
      // Names the inspection failure, says nothing was released, offers retry OR --force.
    ).rejects.toThrow(/NOTHING was released[\s\S]*re-run[\s\S]*--force[\s\S]*could not inspect Docker/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
  });

  // ── The reclaim must resolve the LEGACY sentinel ─────────────────────────
  // A row written before cinatra-cli#35 records the literal "cinatra" as its
  // composeProject even when Compose derived the project from the checkout
  // BASENAME. The `down` path already compensates (`composeProjectArgForRow`
  // returns null for the sentinel, so `-p` is omitted and basename derivation
  // applies). The RECLAIM path inspected `row.composeProject` VERBATIM: for a
  // legacy `/path/custom-name` checkout it asked Docker about project "cinatra",
  // got a truthful zero, released the row — and the live `custom-name` stack kept
  // the host ports that the next install would then be handed. That is exactly
  // the collision the three-state gate exists to refuse, reached by inspecting
  // the wrong project rather than by failing open.

  /** A pre-#35 DEFAULT row: the "cinatra" sentinel as composeProject, the base
   *  compose pair, and a checkout dir whose BASENAME is the project Compose
   *  really used. `dirName` is exact (not mkdtemp-suffixed) so the derived
   *  project is predictable. Returns before the `rm -rf` so a caller can choose. */
  function legacySentinelRow({ registryPath, slug = "row1", appPort = 3300, dirName = "custom-name" }) {
    const targetDir = path.join(mkTmp("cli232-legacy-"), dirName);
    mkdirSync(path.join(targetDir, ".cinatra"), { recursive: true });
    writeFileSync(path.join(targetDir, ".cinatra", "instance.json"), JSON.stringify({ slug }));

    const registry = requireUsableInstanceRegistry(registryPath);
    const { offset, remapped } = allocateBandOffset({ band: BASE_BAND, instanceRegistry: registry, extraReserved: appPort });
    const ports = portsMapFor(remapped);
    let next = allocateInstance(registry, slug, {
      mode: "dev",
      installDir: targetDir,
      composeProject: "cinatra", // the pre-#35 sentinel — NOT what compose used
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      ports,
      appPort,
      offset,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: "new",
      state: "provisioning",
    }).registry;
    next = markInstanceReady(next, slug, { sha: "deadbeef", ports });
    writeInstanceRegistry(registryPath, next);
    return { slug, targetDir, appPort, project: legacyBasenameProject(targetDir) };
  }

  it("REFUSES a legacy sentinel row whose BASENAME project is still live (never inspects 'cinatra')", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "custom-name" });
    expect(legacy.project).toBe("custom-name"); // what the old `up` really used
    rmSync(legacy.targetDir, { recursive: true, force: true }); // the operator's `rm -rf`
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    // Docker's honest answer: the `custom-name` project is live; "cinatra" is not.
    const asked = [];
    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: down.fn,
      inspectProjectLiveness: (names) => {
        asked.push(...names);
        return {
          containerRows: names.includes("custom-name") ? [{ Id: "live-1" }, { Id: "live-2" }] : [],
          volumeRows: [],
        };
      },
    };

    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });

    // The resolution: the basename project was inspected, the sentinel never was.
    expect(asked).toEqual(["custom-name"]);
    expect(asked).not.toContain("cinatra");
    // The gate then does its job on that truthful answer.
    expect(refused).toMatchObject({
      released: false,
      reason: "stack-still-live",
      liveContainers: 2,
      inspectedProject: "custom-name",
    });
    // Nothing released: the row, its whole reservation, the bytes on disk.
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(down.calls).toHaveLength(0);
    // And the ports the live stack holds are still reserved against the next install.
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000);

    // --force stays the eyes-open override, same as for a modern row.
    const forced = await teardownInstance({ slug: "row1", force: true, log: () => {}, deps });
    expect(forced.released).toBe(true);
  });

  // The case above uses `custom-name`, a basename on which every plausible
  // derivation agrees — so it could not catch a derivation that is merely CLOSE
  // to Compose's. This one uses a DOTTED basename, where the
  // two rules part company: Compose deletes the dot (`cinatradev`), while the
  // old helper substituted it (`cinatra_dev`). The Docker stub answers honestly
  // about `cinatradev`, the name Compose really brought the stack up under, and
  // says nothing else exists. A helper that derives `cinatra_dev` therefore asks
  // about a project that never existed, is told the truth ("empty"), and RELEASES
  // a live stack's band. Red at b4750341b (released: true, row gone), green here.
  it("REFUSES a legacy sentinel row whose basename DIVERGES between the two derivations (dotted dir)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "cinatra.dev" });
    // Compose's own normalisation DELETES the dot — it does not substitute it.
    expect(legacy.project).toBe("cinatradev");
    rmSync(legacy.targetDir, { recursive: true, force: true }); // the operator's `rm -rf`
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const asked = [];
    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: down.fn,
      // Docker's honest answer: `cinatradev` is live, and NOTHING else is — in
      // particular the `cinatra_dev` a substituting derivation would ask about.
      inspectProjectLiveness: (names) => {
        asked.push(...names);
        return {
          containerRows: names.includes("cinatradev") ? [{ Id: "live-1" }, { Id: "live-2" }] : [],
          volumeRows: [],
        };
      },
    };

    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });

    expect(asked).toEqual(["cinatradev"]);
    expect(asked).not.toContain("cinatra_dev"); // the substituting derivation's ghost
    expect(asked).not.toContain("cinatra"); // and never the sentinel
    expect(refused).toMatchObject({
      released: false,
      reason: "stack-still-live",
      liveContainers: 2,
      inspectedProject: "cinatradev",
    });
    // Nothing released: the row, its reservation, the bytes on disk.
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(down.calls).toHaveLength(0);
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000);
  });

  // The same divergence through a SPACED basename, driven end-to-end so the
  // operator-facing remediation is pinned too: `docker compose -p cinatra_two
  // down` (or `-p cinatra`) targets nothing at all.
  //
  // The remedy's SHAPE is pinned here as well, and it must not carry `-v`. This
  // path is a plain `--down --yes`: the operator never asked to delete volumes
  // and never typed the confirmation this CLI requires for that. A remedy that
  // says `down -v` would route them around that gate and destroy the named
  // volumes' data the refusal exists to protect.
  it("`--down` names the COMPOSE-TRUE project for a divergent basename (spaced/`+` dir)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "My Instance" });
    expect(legacy.project).toBe("myinstance");
    rmSync(legacy.targetDir, { recursive: true, force: true });

    const asked = [];
    const err = await runInstall(["--down", "--instance", "row1", "--yes"], {
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: recordingDown().fn,
        inspectProjectLiveness: (names) => {
          asked.push(...names);
          return {
            containerRows: names.includes("myinstance") ? [{ Id: "live-1" }] : [],
            volumeRows: [],
          };
        },
      },
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(Error);
    // The Compose-TRUE project, and a NON-destructive remedy: `down`, no `-v`.
    expect(err.message).toContain("Remove them (`docker compose -p myinstance down`)");
    // Never the substituting derivation's ghost, never the sentinel.
    expect(err.message).not.toContain("cinatra_two");
    expect(err.message).not.toMatch(/-p cinatra\b/);
    // And never a volume-deleting command on a path with no typed confirmation.
    expect(err.message).not.toMatch(/down -v/);
    expect(asked).toEqual(["myinstance"]);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
  });

  // The other half of the same guarantee: `-v` is not something the operator can
  // reach by passing `--yes`. `--teardown-existing` arms volume deletion, and the
  // typed confirm gates it — non-interactively that confirm always REFUSES, so the
  // run aborts before any `down` and before the reclaim gate is ever consulted.
  // This is why the refusal above may not hand out a `-v` remedy: the CLI does not
  // delete volumes on this path, so it must not tell the operator to.
  it("`--teardown-existing` cannot be armed by `--yes` — the typed confirm gates it", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "My Instance" });
    rmSync(legacy.targetDir, { recursive: true, force: true });
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    await expect(
      runInstall(["--down", "--instance", "row1", "--yes", "--teardown-existing"], {
        log: () => {},
        deps: {
          instanceRegistryPath: registryPath,
          allocLockPath,
          runComposeDown: down.fn,
          inspectProjectLiveness: () => ({ containerRows: [], volumeRows: [] }),
        },
      }),
    ).rejects.toThrow(/not confirmed \(type "delete row1"\)/);

    expect(down.calls).toHaveLength(0);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  // The THIRD arm of the same guarantee, and the one that had no assertion: what
  // the remedy says once the operator HAS armed `--teardown-existing` and HAS
  // typed the phrase. `plan.volumes` is then true, so the refusal may name `-v` —
  // it is prescribing the deletion the operator already authorised, not routing
  // them around the gate. Pinning only the no-`-v` arms left the ternary's true
  // branch free to say anything.
  //
  // Reaching it needs a real typed confirm, so the test supplies a terminal
  // (`withTypedConfirmAnswer`) rather than a seam. Note this is NOT reachable via
  // the confirmed-`volumes` thread alone: that thread carries the decision, it does
  // not make the decision satisfiable — `plan.volumes` is still true only when the
  // typed confirm passed.
  it("once `--teardown-existing` IS typed-confirmed, the refusal's remedy carries `-v`", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    rmSync(inst.targetDir, { recursive: true, force: true }); // the reclaim path
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const { error, prompt } = await withTypedConfirmAnswer("delete row1", () =>
      runInstall(["--down", "--instance", "row1", "--yes", "--teardown-existing"], {
        log: () => {},
        deps: {
          instanceRegistryPath: registryPath,
          allocLockPath,
          runComposeDown: down.fn,
          inspectProjectLiveness: () => ({ containerRows: [{ Id: "live-1" }], volumeRows: [] }),
        },
      }),
    );

    // The confirm really ran, and really was the irreversible-volume one.
    expect(prompt).toContain('Type "delete row1" to confirm');
    expect(prompt).toContain("IRREVERSIBLE");
    // Past the confirm, the reclaim gate refused on its own terms.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("still exist");
    // …and THIS remedy does carry `-v`, on the Compose-true project.
    expect(error.message).toContain("Remove them (`docker compose -p cinatra_row1 down -v`)");
    // A refusal is still a refusal: nothing down, nothing released, bytes intact.
    expect(down.calls).toHaveLength(0);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });

  // The plan echo for a sentinel row, driven end-to-end. `--dry-run` is where an
  // operator READS the command before running it, so every name on screen must be
  // the one the real `down` uses: no `-p` at all (Compose re-derives the project
  // from the checkout basename), the derived name spelled out, and the header
  // naming that same derived project rather than the sentinel it records.
  it("`--down --dry-run` on a sentinel row echoes the OMITTED `-p` and the derived project", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "cinatra.dev" });
    expect(legacy.project).toBe("cinatradev");
    const bytes = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const lines = [];
    const result = await runInstall(["--down", "--instance", "row1", "--dry-run"], {
      log: (...a) => lines.push(a.join(" ")),
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    const text = lines.join("\n");

    expect(result).toMatchObject({ down: true, dryRun: true });
    // The header names the project the commands really use, not the sentinel.
    expect(text).toMatch(/^Tearing down instance "row1" \(dev, new, project cinatradev\)\./m);
    // The `down` passes NO `-p`: that is what makes Compose re-derive the name.
    expect(text).toMatch(/^ {2}compose: {2}down -f /m);
    expect(text).not.toMatch(/compose: {2}down -p /);
    // …and the echo says WHY, naming the derivation's result.
    expect(text).toMatch(/\(no -p: .*re-derives the project from the checkout basename — "cinatradev"\.\)/);
    // The sentinel is never presented as a target, in the header or the command.
    expect(text).not.toMatch(/-p cinatra\b/);
    expect(text).not.toMatch(/project cinatra\)/);
    // A dry run touches nothing.
    expect(down.calls).toHaveLength(0);
    expect(readFileSync(registryPath, "utf8")).toBe(bytes);
  });

  it("still reclaims a legacy sentinel row when its BASENAME project is empty (the all-clear)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "custom-name" });
    rmSync(legacy.targetDir, { recursive: true, force: true });
    const down = recordingDown();

    const asked = [];
    const result = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: down.fn,
        inspectProjectLiveness: (names) => {
          asked.push(...names);
          return { containerRows: [], volumeRows: [] };
        },
      },
    });

    expect(asked).toEqual(["custom-name"]); // resolved, not the sentinel
    expect(result.released).toBe(true);
    expect(down.calls).toHaveLength(0); // no compose file to `down` from
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("a legacy row whose dir IS named `cinatra` resolves to the same project (no behaviour change)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "cinatra" });
    expect(legacy.project).toBe("cinatra");
    rmSync(legacy.targetDir, { recursive: true, force: true });

    const asked = [];
    const refused = await teardownInstance({
      slug: "row1",
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: recordingDown().fn,
        inspectProjectLiveness: (names) => {
          asked.push(...names);
          return { containerRows: [{ Id: "live-1" }], volumeRows: [] };
        },
      },
    });
    expect(asked).toEqual(["cinatra"]);
    expect(refused).toMatchObject({ released: false, reason: "stack-still-live", inspectedProject: "cinatra" });
  });

  it("REFUSES when no project can be derived at all (an unresolvable name is not an all-clear)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    // A recorded path whose basename sanitises to nothing at all.
    const legacy = legacySentinelRow({ registryPath, dirName: "..." });
    expect(legacyBasenameProject(legacy.targetDir)).toBe("");
    rmSync(legacy.targetDir, { recursive: true, force: true });
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    let inspectorCalled = false;
    const deps = {
      instanceRegistryPath: registryPath,
      allocLockPath,
      runComposeDown: down.fn,
      inspectProjectLiveness: () => {
        inspectorCalled = true;
        return { containerRows: [], volumeRows: [] };
      },
    };
    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });

    // We never asked Docker about SOME OTHER project and read its emptiness as proof.
    expect(inspectorCalled).toBe(false);
    expect(refused).toMatchObject({ released: false, reason: "inspect-failed", inspectedProject: null });
    expect(refused.error?.message).toMatch(/no Compose project name can be derived/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    expect(down.calls).toHaveLength(0);
  });

  it("`--down` names the DERIVED project in the way out, so the operator's command works", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const legacy = legacySentinelRow({ registryPath, dirName: "custom-name" });
    rmSync(legacy.targetDir, { recursive: true, force: true });

    // `docker compose -p cinatra down` would target NOTHING; the remediation must
    // name the project the containers are actually labelled with. It must also
    // stay NON-destructive: this is a plain `--yes` run, so the operator neither
    // asked for volume deletion nor typed the confirmation this CLI requires for
    // it, and a `-v` remedy would walk them around that gate.
    await expect(
      runInstall(["--down", "--instance", "row1", "--yes"], {
        log: () => {},
        deps: {
          instanceRegistryPath: registryPath,
          allocLockPath,
          runComposeDown: recordingDown().fn,
          inspectProjectLiveness: () => ({ containerRows: [{ Id: "live-1" }], volumeRows: [] }),
        },
      }),
    ).rejects.toThrow(/Remove them \(`docker compose -p custom-name down`\)/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
  });

  it("names the reservation holders in the exhaustion error (the operator's remediation)", () => {
    const { registryPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    for (let i = 0; i < 5; i += 1) installIsolated({ registryPath, slug: `row${i + 1}`, appPort: 3300 + i });

    const registry = requireUsableInstanceRegistry(registryPath);
    expect(describeInstanceReservations(registry)).toHaveLength(5);
    let message = "";
    try {
      allocateBandOffset({ band: BASE_BAND, instanceRegistry: registry, max: BAND_OFFSET_MAX });
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain("Recorded instances holding a reservation");
    expect(message).toContain("row3  [ready]  offset 30000");
    expect(message).toContain("cinatra install --down --instance <slug> --yes");
  });

  it("describeInstanceReservations is empty for an empty registry (no noise added)", () => {
    expect(describeInstanceReservations({ version: 1, instances: {} })).toEqual([]);
    expect(describeInstanceReservations(null)).toEqual([]);
  });
});

// =========================================================================
describe("cinatra-cli#232 — rows that own no stack of their own", () => {
  function recordRow(registryPath, slug, fields) {
    const targetDir = mkTmp(`cli232-${slug}-`);
    const registry = requireUsableInstanceRegistry(registryPath);
    const { registry: next } = allocateInstance(registry, slug, {
      mode: "dev",
      installDir: targetDir,
      composeProject: fields.composeProject ?? `cinatra_${slug}`,
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      ports: {},
      appPort: fields.appPort,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: fields.infraMode,
      createdResources: fields.createdResources ?? [],
      state: fields.state ?? "ready",
    });
    writeInstanceRegistry(registryPath, next);
    return targetDir;
  }

  it("an EXTERNAL row releases its app port without any `down`", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    recordRow(registryPath, "ext", { infraMode: "external", state: "external", appPort: 3301 });
    const down = recordingDown();

    const result = await teardownInstance({
      slug: "ext",
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });

    expect(result.released).toBe(true);
    expect(down.calls).toHaveLength(0); // operator-supplied infra is never install-owned
    expect(rowFor(registryPath, "ext")).toBeNull();
  });

  it("a CO-USE row is never `down`ed (its project is the DONOR's) and needs --force", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    recordRow(registryPath, "guest", {
      infraMode: "co-use",
      appPort: 3302,
      composeProject: "cinatra_donor",
      createdResources: ["db:cinatra_inst_guest"],
    });
    const down = recordingDown();
    const deps = { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn };

    const refused = await teardownInstance({ slug: "guest", log: () => {}, deps });
    expect(refused).toMatchObject({ released: false, reason: "co-use-needs-force" });
    expect(down.calls).toHaveLength(0);
    expect(rowFor(registryPath, "guest")).not.toBeNull();

    const forced = await teardownInstance({ slug: "guest", force: true, log: () => {}, deps });
    expect(forced.released).toBe(true);
    expect(down.calls).toHaveLength(0); // still never touches the donor's stack
  });
});

// =========================================================================
// The other half of the reservation lifecycle: a FAILED install's rollback.
// cinatra-cli#111 already pins that it restores `.env.local`; what was never
// pinned is that it releases the RESERVATION it took. It does — verified here so
// the two release paths (rollback and teardown) can never drift apart.
//
// Disclosed, deliberately NOT asserted here: the same rollback still leaves
// `docker/wayflow/.wayflow.env` in the checkout (it removes a hardcoded artifact
// list — marker + generated compose — rather than the row's `createdResources`).
// That is a checkout-file residue, a DIFFERENT mechanism from the reservation,
// and it belongs to the WayFlow install lane (cinatra#2654), not this one.
describe("cinatra-cli#232 — the failed-install rollback releases its reservation too", () => {
  it("frees the band it allocated, so the retry lands on the same offset", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });

    // A PROVISIONING row, exactly as executeIsolatedInstall records it before `up`.
    const targetDir = mkTmp("cli232-rb-");
    writeFileSync(path.join(targetDir, ISOLATED_COMPOSE_FILENAME), "services: {}\n");
    const registry = requireUsableInstanceRegistry(registryPath);
    const { offset, remapped } = allocateBandOffset({ band: BASE_BAND, instanceRegistry: registry, extraReserved: 3300 });
    const ports = portsMapFor(remapped);
    writeInstanceRegistry(
      registryPath,
      allocateInstance(registry, "pending", {
        mode: "dev",
        installDir: targetDir,
        composeProject: "cinatra_pending",
        composeFiles: [ISOLATED_COMPOSE_FILENAME],
        ports,
        appPort: 3300,
        offset,
        repoUrl: "https://github.com/cinatra-ai/cinatra.git",
        ref: "main",
        infraMode: "new",
        state: "provisioning",
      }).registry,
    );

    await rollbackIsolatedInstance({
      targetDir,
      slug: "pending",
      composeProject: "cinatra_pending",
      composeFiles: [ISOLATED_COMPOSE_FILENAME],
      envSnapshot: null,
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn },
    });

    const after = readInstanceRegistry(registryPath).registry;
    const reserved = reservedPorts({ instanceRegistry: after });
    for (const p of [...Object.values(ports).flat(), 3300]) expect(reserved.has(p)).toBe(false);
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(offset);
  });

  it("a rollback whose `down` fails keeps the whole reservation (same rule as teardown)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const targetDir = mkTmp("cli232-rb-");
    const registry = requireUsableInstanceRegistry(registryPath);
    writeInstanceRegistry(
      registryPath,
      allocateInstance(registry, "pending", {
        mode: "dev",
        installDir: targetDir,
        composeProject: "cinatra_pending",
        composeFiles: [ISOLATED_COMPOSE_FILENAME],
        ports: { postgres: [15434] },
        appPort: 3300,
        offset: 10000,
        repoUrl: "https://github.com/cinatra-ai/cinatra.git",
        ref: "main",
        infraMode: "new",
        state: "provisioning",
      }).registry,
    );
    const bytes = readFileSync(registryPath, "utf8");

    await rollbackIsolatedInstance({
      targetDir,
      slug: "pending",
      composeProject: "cinatra_pending",
      composeFiles: [ISOLATED_COMPOSE_FILENAME],
      envSnapshot: null,
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: failingDown },
    });

    expect(readFileSync(registryPath, "utf8")).toBe(bytes);
  });
});

// =========================================================================
describe("cinatra-cli#232 — pure plan + target resolution", () => {
  it("planInstanceTeardown lists exactly the ports the release frees", () => {
    const row = {
      slug: "row1",
      installDir: "/x/row1",
      composeProject: "cinatra_row1",
      composeFiles: [ISOLATED_COMPOSE_FILENAME],
      ports: { postgres: [15434], neo4j: [17474, 17687] },
      appPort: 3300,
      infraMode: "new",
      state: "ready",
    };
    expect(planInstanceTeardown(row, { volumes: true })).toMatchObject({
      down: true,
      volumes: true,
      releasesPorts: [3300, 15434, 17474, 17687],
    });
    expect(planInstanceTeardown(row).volumes).toBe(false);
    expect(planInstanceTeardown({ ...row, infraMode: "co-use" }, { volumes: true })).toMatchObject({
      down: false,
      volumes: false,
    });
    expect(planInstanceTeardown(null)).toBeNull();
  });

  it("resolveTeardownTarget prefers --instance, else the row at --dir, else the cwd", () => {
    const registry = {
      version: 1,
      instances: {
        alpha: { slug: "alpha", installDir: "/w/alpha" },
        beta: { slug: "beta", installDir: "/w/beta" },
      },
    };
    expect(resolveTeardownTarget({ registry, instance: "beta" }).slug).toBe("beta");
    expect(resolveTeardownTarget({ registry, dir: "/w/alpha" }).slug).toBe("alpha");
    expect(resolveTeardownTarget({ registry, cwd: "/w/beta" }).slug).toBe("beta");
    // `<cwd>/cinatra` — the default install dir — is the second candidate.
    const nested = { version: 1, instances: { c: { slug: "c", installDir: "/w/here/cinatra" } } };
    expect(resolveTeardownTarget({ registry: nested, cwd: "/w/here" }).slug).toBe("c");
    expect(resolveTeardownTarget({ registry, dir: "/w/nothing" }).row).toBeNull();
  });
});

// =========================================================================
describe("cinatra-cli#232 — `cinatra install --down` wiring", () => {
  it("short-circuits before any preflight/clone and releases the band", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const down = recordingDown();
    const lines = [];
    // If the short-circuit regressed, these seams would be reached and throw.
    const boom = () => {
      throw new Error("install path must not run for --down");
    };

    const result = await runInstall(["--down", "--instance", "row1", "--yes"], {
      log: (m) => lines.push(String(m)),
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath,
        runComposeDown: down.fn,
        runPreflight: boom,
        detectPortConflicts: boom,
        bringUpInfra: boom,
      },
    });

    expect(result).toMatchObject({ down: true, released: true, slug: "row1" });
    expect(down.calls).toHaveLength(1);
    expect(rowFor(registryPath, "row1")).toBeNull();
    expect(lines.join("\n")).toMatch(/releases: 3300, 13003, 13010/);
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("--dry-run prints the plan and changes nothing", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const bytes = readFileSync(registryPath, "utf8");
    const down = recordingDown();

    const result = await runInstall(["--down", "--instance", "row1", "--dry-run"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });

    expect(result).toMatchObject({ down: true, dryRun: true });
    expect(down.calls).toHaveLength(0);
    expect(readFileSync(registryPath, "utf8")).toBe(bytes);
  });

  it("refuses non-interactively without --yes, and names the recorded rows when the target is unknown", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const deps = { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: recordingDown().fn };

    await expect(runInstall(["--down", "--instance", "row1"], { log: () => {}, deps })).rejects.toThrow(
      /not confirmed \(pass --yes/,
    );
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    await expect(runInstall(["--down", "--instance", "ghost", "--yes"], { log: () => {}, deps })).rejects.toThrow(
      /No recorded instance "ghost"[\s\S]*row1/,
    );
  });

  it("surfaces a failed `down` as a refusal that released nothing", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installIsolated({ registryPath, slug: "row1", appPort: 3300 });

    await expect(
      runInstall(["--down", "--instance", "row1", "--yes"], {
        log: () => {},
        deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: failingDown },
      }),
    ).rejects.toThrow(/NOTHING was released/);
    expect(rowFor(registryPath, "row1")).not.toBeNull();
  });
});

// =========================================================================
// The registry WRITE is the commit point of the release. The
// containers are already down by the time it runs, so if it fails the row must
// come through USABLE: still recorded, still holding its WHOLE reservation, and
// releasable by a retry. The one state that must never exist is half-released —
// a row missing while its ports stay reserved, or vice versa.
describe("cinatra-cli#232 — a failed registry WRITE leaves the row usable, never half-released", () => {
  /** Registry and alloc lock in SEPARATE dirs, so the registry dir can be made
   *  read-only without also breaking the lock the teardown must still take. */
  function splitPaths() {
    const regDir = mkTmp("cli232-regw-");
    const lockDir = mkTmp("cli232-lockw-");
    return { regDir, registryPath: path.join(regDir, "instances.json"), allocLockPath: path.join(lockDir, "alloc") };
  }
  const tempLitter = (dir) => readdirSync(dir).filter((f) => f.startsWith(".instances.") && f.endsWith(".tmp"));

  it("keeps the row and the WHOLE reservation when the release write fails, and a retry completes it", async () => {
    const { regDir, registryPath, allocLockPath } = splitPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const before = readFileSync(registryPath, "utf8");
    const down = recordingDown();
    const deps = { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn };

    // Make the registry dir unwritable → the atomic write throws. (The `down`
    // has ALREADY succeeded at this point; that is exactly the window.)
    chmodSync(regDir, 0o500);
    let threw = null;
    try {
      await teardownInstance({ slug: "row1", log: () => {}, deps });
    } catch (e) {
      threw = e;
    } finally {
      chmodSync(regDir, 0o700);
    }

    expect(threw, "a failed release write must surface, never be swallowed").not.toBeNull();
    expect(down.calls).toHaveLength(1); // the containers really did go down

    // The row survived UNTOUCHED — same bytes, same state, same reservation.
    expect(readFileSync(registryPath, "utf8")).toBe(before);
    const row = rowFor(registryPath, "row1");
    expect(row).not.toBeNull();
    expect(row.state).toBe("ready");
    // Not half-released: EVERY port it held is still reserved, none leaked out.
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry });
    for (const p of [...Object.values(inst.ports).flat(), 3300]) expect(reserved.has(p)).toBe(true);
    // …so its band is still held against a competing allocation.
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000);

    // No orphaned temp file from the failed attempt.
    expect(tempLitter(regDir)).toEqual([]);

    // And the row is USABLE: a retry (write now permitted) finishes the release.
    const retry = await teardownInstance({ slug: "row1", log: () => {}, deps });
    expect(retry.released).toBe(true);
    expect(rowFor(registryPath, "row1")).toBeNull();
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });

  it("the temp+rename writer orphans no temp file when the rename (the commit point) fails", () => {
    const dir = mkTmp("cli232-rename-");
    // A DIRECTORY where the registry file goes: writeFileSync(tmp) succeeds,
    // renameSync(tmp, filePath) fails — the commit point, temp already on disk.
    const registryPath = path.join(dir, "instances.json");
    mkdirSync(registryPath, { recursive: true });

    expect(() => writeInstanceRegistry(registryPath, { version: 1, instances: {} })).toThrow();
    expect(tempLitter(dir), "a failed rename must not leave its temp behind").toEqual([]);
  });
});

// =========================================================================
// `--dir` addressing is resolved OUTSIDE the alloc lock (the
// registry read that maps a directory to a slug), but the release happens
// INSIDE it. Between those two points another process can re-point that slug at
// a different checkout. The `expectInstallDir` guard exists for exactly that
// window, and this drives the REAL `--down` path through REAL lock contention —
// no hand-passed wrong argument.
describe("cinatra-cli#232 — --dir cannot release a row whose directory moved under the lock", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Take the alloc lock and hold it until `release()` is called. Resolves once
   *  the lock is genuinely held, so the contender provably queues behind it. */
  async function holdAllocLock(allocLockPath) {
    let release;
    let acquired;
    const held = new Promise((r) => (release = r));
    const isAcquired = new Promise((r) => (acquired = r));
    const done = withAllocLock(allocLockPath, async () => {
      acquired();
      await held;
    });
    await isAcquired;
    return { release, done };
  }

  it("refuses when the row is re-pointed at another checkout while the teardown waits for the lock", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const movedDir = mkTmp("cli232-moved-");
    const down = recordingDown();

    // Contention is real: we hold the alloc lock first.
    const lock = await holdAllocLock(allocLockPath);

    // The operator's command, addressing the row BY DIRECTORY. It resolves the
    // dir → slug now (outside the lock), then blocks acquiring the lock.
    const teardown = runInstall(["--down", "--dir", inst.targetDir, "--yes"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    await sleep(150); // it has resolved its target and is now queued on the lock

    // The race: while WE hold the lock, "row1" comes to mean a different
    // checkout (a concurrent release + reinstall of the same slug elsewhere).
    const reg = requireUsableInstanceRegistry(registryPath);
    reg.instances.row1.installDir = movedDir;
    writeInstanceRegistry(registryPath, reg);
    lock.release();
    await lock.done;

    // The teardown now gets the lock, re-reads, and sees the row it resolved is
    // not the row it found. It must refuse rather than tear down the new one.
    await expect(teardown).rejects.toThrow(/no longer points at/);
    expect(down.calls, "a moved row must never be `down`ed").toHaveLength(0);
    const row = rowFor(registryPath, "row1");
    expect(row).not.toBeNull();
    expect(path.resolve(row.installDir)).toBe(path.resolve(movedDir)); // the NEW row, intact
    expect(tryAllocateOffset(registryPath, 3301).offset).toBe(20000); // still reserved
  });

  it("positive control: the same --dir flow DOES release when the row stays put", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installIsolated({ registryPath, slug: "row1", appPort: 3300 });
    const down = recordingDown();

    const lock = await holdAllocLock(allocLockPath);
    const teardown = runInstall(["--down", "--dir", inst.targetDir, "--yes"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    await sleep(150);
    lock.release(); // nothing changed under the lock this time
    await lock.done;

    expect(await teardown).toMatchObject({ down: true, released: true, slug: "row1" });
    expect(down.calls).toHaveLength(1);
    expect(rowFor(registryPath, "row1")).toBeNull();
    expect(tryAllocateOffset(registryPath, 3300).offset).toBe(10000);
  });
});

// =========================================================================
// The lost-update guarantee. temp+rename prevents a TORN write,
// not a lost one: two allocations that both read the empty registry both pick
// offset 10000, and the second rename erases the first row. `withAllocLock` is
// what prevents it, so the contenders here do read→allocate→write INSIDE the
// lock exactly as production does (executeIsolatedInstall's reserve step), and
// a no-lock control proves the race is real rather than assumed.
describe("cinatra-cli#232 — two concurrent allocations cannot collide or lose a write", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** One contender: the production read→allocate→write sequence. `readDelay`
   *  widens the read→write window so an unserialised run really does interleave. */
  async function contend({ registryPath, allocLockPath, slug, readDelay, useLock = true }) {
    const body = async () => {
      const registry = requireUsableInstanceRegistry(registryPath);
      const appPort = allocateAppPort({ instanceRegistry: registry });
      const { offset, remapped } = allocateBandOffset({ band: BASE_BAND, instanceRegistry: registry, extraReserved: appPort });
      await sleep(readDelay); // the window a lost update lives in
      const next = allocateInstance(registry, slug, {
        mode: "dev",
        installDir: path.join(os.tmpdir(), `cli232-${slug}`),
        composeProject: `cinatra_${slug}`,
        composeFiles: [ISOLATED_COMPOSE_FILENAME],
        ports: portsMapFor(remapped),
        appPort,
        offset,
        repoUrl: "https://github.com/cinatra-ai/cinatra.git",
        ref: "main",
        infraMode: "new",
        state: "provisioning",
      }).registry;
      writeInstanceRegistry(registryPath, next);
      return { slug, offset, appPort };
    };
    return useLock ? withAllocLock(allocLockPath, body) : body();
  }

  it("serialises two real contenders: distinct bands, distinct app ports, neither write lost", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });

    // Launched together, with overlapping read→write windows.
    const [a, b] = await Promise.all([
      contend({ registryPath, allocLockPath, slug: "conc-a", readDelay: 120 }),
      contend({ registryPath, allocLockPath, slug: "conc-b", readDelay: 20 }),
    ]);

    // Neither picked what the other holds.
    expect(a.offset).not.toBe(b.offset);
    expect(a.appPort).not.toBe(b.appPort);
    expect([a.offset, b.offset].sort((x, y) => x - y)).toEqual([10000, 20000]);

    // Neither registry update was lost — BOTH rows survive in the final file.
    const final = readInstanceRegistry(registryPath).registry;
    expect(Object.keys(final.instances).sort()).toEqual(["conc-a", "conc-b"]);
    for (const r of [a, b]) {
      expect(final.instances[r.slug].offset).toBe(r.offset);
      expect(final.instances[r.slug].appPort).toBe(r.appPort);
    }

    // And the two reservations are genuinely disjoint (no shared host port).
    const portsOf = (slug) => [...Object.values(final.instances[slug].ports).flat(), final.instances[slug].appPort];
    const overlap = portsOf("conc-a").filter((p) => portsOf("conc-b").includes(p));
    expect(overlap).toEqual([]);
  });

  it("control: WITHOUT the lock the same two contenders collide and lose a write", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });

    const [a, b] = await Promise.all([
      contend({ registryPath, allocLockPath, slug: "race-a", readDelay: 120, useLock: false }),
      contend({ registryPath, allocLockPath, slug: "race-b", readDelay: 20, useLock: false }),
    ]);

    // Both read the same empty registry → both picked the SAME band and port…
    expect(a.offset).toBe(b.offset);
    expect(a.appPort).toBe(b.appPort);
    // …and the later rename erased the earlier row. This is what the lock buys.
    expect(Object.keys(readInstanceRegistry(registryPath).registry.instances)).toEqual(["race-a"]);
  });
});

// =========================================================================
// The failed-install rollback, driven through the REAL install.
//
// Calling `rollbackIsolatedInstance` directly (above) proves the rollback frees
// what it is handed; it cannot prove the install actually REACHES it, nor that
// what the install reserved is what the rollback releases. So this drives the
// real `runInstall --on-conflict=isolated` and injects the failure at
// `bringUpInfra` — after the reservation is allocated, probed and PERSISTED as a
// provisioning row, which is the window the D5 leak lived in. The reservation is
// captured from the registry at the moment of failure, then proven gone and
// genuinely reusable: a second real install lands on the SAME band offset AND
// the SAME app port.
describe("cinatra-cli#232 — a failed real install leaves its band + app port reusable", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cli232-inst-"));
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
    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  // The checkout's resolved `docker compose config` — the band the isolated
  // executor remaps. Mirrors tests/install-flow.test.mjs' fixture.
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
  const DEFAULT_BAND = [
    { service: "postgres", host: "127.0.0.1", port: 5434 },
    { service: "redis", host: "127.0.0.1", port: 6379 },
    { service: "nango-server", host: "0.0.0.0", port: 3003 },
    { service: "nango-db", host: "127.0.0.1", port: 5435 },
  ];
  // The DEFAULT band is held by someone else (so the run takes the isolated
  // path); every remapped band and the app-port probe come back free.
  const conflictOnDefaultBand = async (band) => {
    const pg = band.find((b) => b.service === "postgres");
    if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
    return [];
  };

  function installDeps({ registryPath, allocLockPath }, extra = {}) {
    return {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
      commandExists: () => true,
      composeAvailable: () => true,
      instanceRegistryPath: registryPath,
      allocLockPath,
      composePublishedPortsForTarget: () => DEFAULT_BAND,
      composeConfigForFiles: () => RESOLVED_CONFIG,
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      detectPortConflicts: conflictOnDefaultBand,
      runComposeDown: () => {},
      bringUpInfra: () => {},
      ...extra,
    };
  }

  const isolatedArgs = (dir, slug) => [
    "--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main",
    "--yes", "--no-install", "--on-conflict", "isolated", "--instance", slug, "--port-offset", "auto",
  ];

  it("rolls back a bring-up failure and the retry re-uses the SAME band offset and app port", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    const installDir = path.join(sandbox, "iso-rollback");
    const down = recordingDown();

    // The failure is injected AFTER the reservation exists: read the persisted
    // provisioning row from inside `bringUpInfra`, then fail the way a real
    // unhealthy stack does.
    let reservedAtFailure = null;
    await expect(
      runInstall(isolatedArgs(installDir, "iso232"), {
        log: () => {},
        deps: installDeps(
          { registryPath, allocLockPath },
          {
            runComposeDown: down.fn,
            bringUpInfra: () => {
              reservedAtFailure = rowFor(registryPath, "iso232");
              throw new Error("isolated bring-up failed: nango never became healthy");
            },
          },
        ),
      }),
    ).rejects.toThrow(/nango never became healthy/);

    // The reservation really was live at the moment of failure (else the test
    // would be asserting the reuse of nothing).
    expect(reservedAtFailure, "the install must have PERSISTED a reservation before bring-up").not.toBeNull();
    expect(reservedAtFailure.state).toBe("provisioning");
    expect(reservedAtFailure.offset).toBe(10000);
    const heldPorts = [...Object.values(reservedAtFailure.ports).flat(), reservedAtFailure.appPort];
    expect(heldPorts.length).toBeGreaterThan(1);

    // The rollback ran, and released it: no row, and not one of its ports is
    // still reserved.
    expect(down.calls.length).toBeGreaterThan(0);
    expect(rowFor(registryPath, "iso232")).toBeNull();
    const reserved = reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry });
    for (const p of heldPorts) expect(reserved.has(p), `port ${p} must not stay reserved`).toBe(false);

    // The acceptance: a real retry gets the identical band AND app port back —
    // the reservation is reusable, not merely absent from the file.
    const retry = await runInstall(isolatedArgs(installDir, "iso232"), {
      log: () => {},
      deps: installDeps({ registryPath, allocLockPath }, { runComposeDown: down.fn }),
    });
    expect(retry.infraPlan).toBe("isolated");
    const row = rowFor(registryPath, "iso232");
    expect(row.state).toBe("ready");
    expect(row.offset).toBe(reservedAtFailure.offset);
    expect(row.appPort).toBe(reservedAtFailure.appPort);
    expect(row.ports).toEqual(reservedAtFailure.ports);
  });

  it("five failed installs in a row never exhaust the band (each rollback gives its offset back)", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    const offsets = [];

    // Without the release, five leaked provisioning rows exhaust 10000..50000
    // and the sixth refuses — D5, reached through the FAILURE path this time.
    for (let i = 0; i < 5; i += 1) {
      let seen = null;
      await expect(
        runInstall(isolatedArgs(path.join(sandbox, `iso-fail-${i}`), `isofail${i}`), {
          log: () => {},
          deps: installDeps(
            { registryPath, allocLockPath },
            {
              bringUpInfra: () => {
                seen = rowFor(registryPath, `isofail${i}`);
                throw new Error("isolated bring-up failed: nango never became healthy");
              },
            },
          ),
        }),
      ).rejects.toThrow(/nango never became healthy/);
      offsets.push(seen.offset);
    }

    // Every attempt got the LOWEST offset back — nothing accumulated.
    expect(offsets).toEqual([10000, 10000, 10000, 10000, 10000]);
    expect(listInstances(readInstanceRegistry(registryPath).registry)).toEqual([]);

    // …and a sixth install still succeeds, on that same offset.
    const ok = await runInstall(isolatedArgs(path.join(sandbox, "iso-sixth"), "isosixth"), {
      log: () => {},
      deps: installDeps({ registryPath, allocLockPath }),
    });
    expect(ok.infraPlan).toBe("isolated");
    expect(rowFor(registryPath, "isosixth").offset).toBe(10000);
  });
});

// =========================================================================
// The confirmed plan must BE the executed plan.
//
// `runInstallDown` reads the registry, plans, prints and confirms all OUTSIDE
// the allocation lock; `teardownInstance` re-reads under it. Two reads, and the
// SECOND one used to decide `-v`. The dangerous shape is not a directory move
// (`expectInstallDir` already covers that, and `--instance` passes no directory
// at all) but a same-slug, SAME-DIRECTORY replacement that flips `infraMode`:
//
//   • pre-lock the row is `external` → `plan.down === false` → the
//     `--teardown-existing` typed confirm is never even reached, so a bare
//     `--yes` satisfies the ordinary confirm;
//   • another process releases the slug and reinstalls it install-owned (`new`)
//     into the same checkout while the command queues on the lock;
//   • the under-lock plan is built from THAT row, and the raw `--teardown-existing`
//     flag turns it into `volumes: true`.
//
// A bare `--yes` would have deleted data volumes the operator was never warned
// about. These tests drive the REAL `--down` path through REAL lock contention.
describe("cinatra-cli#232 — a same-slug replacement cannot inherit a confirmation it never had", () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function holdAllocLock(allocLockPath) {
    let release;
    let acquired;
    const held = new Promise((r) => (release = r));
    const isAcquired = new Promise((r) => (acquired = r));
    const done = withAllocLock(allocLockPath, async () => {
      acquired();
      await held;
    });
    await isAcquired;
    return { release, done };
  }

  /** An EXTERNAL row: it points at operator-supplied infra, owns no stack, and
   *  so can never plan a `down` — let alone a `down -v`. It still holds an
   *  app-port reservation, which is what a teardown releases. */
  function installExternal({ registryPath, slug, appPort }) {
    const targetDir = mkTmp(`cli232-${slug}-ext-`);
    const registry = requireUsableInstanceRegistry(registryPath);
    let next = allocateInstance(registry, slug, {
      mode: "dev",
      installDir: targetDir,
      composeProject: `cinatra_${slug.replace(/-/g, "_")}`,
      composeFiles: ["docker-compose.yml"],
      ports: {},
      appPort,
      offset: 0,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: "external",
      state: "provisioning",
    }).registry;
    next = markInstanceReady(next, slug, { sha: "deadbeef", ports: {} });
    writeInstanceRegistry(registryPath, next);
    return { slug, targetDir, appPort };
  }

  /** Replace `slug` in place with an install-owned row on the SAME directory —
   *  the shape a directory-only recheck cannot see. */
  function replaceWithInstallOwned(registryPath, slug) {
    const reg = requireUsableInstanceRegistry(registryPath);
    reg.instances[slug].infraMode = "new";
    reg.instances[slug].composeFiles = [ISOLATED_COMPOSE_FILENAME];
    writeInstanceRegistry(registryPath, reg);
  }

  it("refuses, and never passes -v, when an external row becomes install-owned under the lock", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installExternal({ registryPath, slug: "row1", appPort: 3300 });
    // The generated compose file the replacement row claims, so the teardown's
    // `down` path would find a real checkout to run from.
    writeFileSync(path.join(inst.targetDir, ISOLATED_COMPOSE_FILENAME), "services: {}\n");
    const down = recordingDown();

    const lock = await holdAllocLock(allocLockPath);

    // The operator's command. `--instance` passes NO expected directory, and the
    // pre-lock row is external, so `--teardown-existing` never reaches the typed
    // confirm — a bare `--yes` is the whole authorisation given here.
    const teardown = runInstall(["--down", "--instance", "row1", "--yes", "--teardown-existing"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    await sleep(150); // it has planned, confirmed, and is now queued on the lock

    replaceWithInstallOwned(registryPath, "row1");
    lock.release();
    await lock.done;

    await expect(teardown).rejects.toThrow(/CHANGED between the plan printed above/);
    // The two guarantees, in order of consequence.
    expect(down.calls, "a replaced row must never be `down`ed at all").toHaveLength(0);
    for (const call of down.calls) expect(call.opts.volumes, "and never with -v").not.toBe(true);
    // Nothing was released either: the row and its reservation are intact.
    const row = rowFor(registryPath, "row1");
    expect(row).not.toBeNull();
    expect(row.infraMode).toBe("new");
    expect(reservedPorts({ instanceRegistry: readInstanceRegistry(registryPath).registry }).has(3300)).toBe(true);
  });

  it("the refusal names the field that changed and what to do about it", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const inst = installExternal({ registryPath, slug: "row1", appPort: 3300 });
    writeFileSync(path.join(inst.targetDir, ISOLATED_COMPOSE_FILENAME), "services: {}\n");
    const down = recordingDown();

    const lock = await holdAllocLock(allocLockPath);
    const teardown = runInstall(["--down", "--instance", "row1", "--yes", "--teardown-existing"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    await sleep(150);
    replaceWithInstallOwned(registryPath, "row1");
    lock.release();
    await lock.done;

    const err = await teardown.then(
      () => null,
      (e) => e,
    );
    expect(err, "the teardown must refuse").not.toBeNull();
    // WHAT changed — both bound fields the replacement touched, old → new.
    expect(err.message).toMatch(/infraMode: "external" → "new"/);
    expect(err.message).toContain(`composeFiles: ["docker-compose.yml"] → ["${ISOLATED_COMPOSE_FILENAME}"]`);
    // …and WHAT TO DO.
    expect(err.message).toMatch(/Re-run `cinatra install --down`/);
    expect(err.message).toMatch(/read that new plan before confirming it/);
  });

  it("positive control: the same --instance --teardown-existing flow releases when the row stays put", async () => {
    const { registryPath, allocLockPath } = newRegistryPaths();
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    installExternal({ registryPath, slug: "row1", appPort: 3300 });
    const down = recordingDown();

    const lock = await holdAllocLock(allocLockPath);
    const teardown = runInstall(["--down", "--instance", "row1", "--yes", "--teardown-existing"], {
      log: () => {},
      deps: { instanceRegistryPath: registryPath, allocLockPath, runComposeDown: down.fn },
    });
    await sleep(150);
    lock.release(); // nothing changed under the lock this time
    await lock.done;

    expect(await teardown).toMatchObject({ down: true, released: true, slug: "row1" });
    // Still external, so still nothing to bring down — and certainly no `-v`.
    expect(down.calls).toHaveLength(0);
    expect(rowFor(registryPath, "row1")).toBeNull();
  });

  it("the binding is on the safety-relevant fields, and only those", () => {
    const row = {
      slug: "row1",
      mode: "dev",
      state: "ready",
      infraMode: "new",
      composeProject: "cinatra_row1",
      composeFiles: ["a.yml", "b.yml"],
      installDir: "/tmp/x",
      appPort: 3300,
      ports: { postgres: [15434] },
      createdResources: ["db"],
    };
    const key = (r) => teardownIdentityKey(teardownIdentity(r));

    expect(Object.keys(teardownIdentity(row)).sort()).toEqual([
      "composeFiles",
      "composeProject",
      "infraMode",
      "installDir",
    ]);

    // Every bound field moves the key…
    expect(key({ ...row, infraMode: "external" })).not.toBe(key(row));
    expect(key({ ...row, composeProject: "other" })).not.toBe(key(row));
    expect(key({ ...row, composeFiles: ["b.yml", "a.yml"] })).not.toBe(key(row)); // order is significant
    expect(key({ ...row, installDir: "/tmp/y" })).not.toBe(key(row));

    // …and the deliberately unbound ones do not: they are outputs of the release
    // or status that churns, never inputs to an irreversible command.
    for (const churn of [{ state: "degraded" }, { appPort: 3999 }, { ports: {} }, { mode: "prod" }, { createdResources: [] }]) {
      expect(key({ ...row, ...churn })).toBe(key(row));
    }

    // installDir is compared resolved, so a trailing slash is not a refusal.
    expect(key({ ...row, installDir: "/tmp/x/" })).toBe(key(row));
  });
});
