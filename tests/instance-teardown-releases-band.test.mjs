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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  planInstanceTeardown,
  resolveTeardownTarget,
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
  allocateBandOffset,
  describeInstanceReservations,
  reservedPorts,
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
        inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
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
      inspectProjectOwnership: () => ({ containerRows: [{ Id: "abc" }], volumeRows: [] }),
    };
    const refused = await teardownInstance({ slug: "row1", log: () => {}, deps });
    expect(refused).toMatchObject({ released: false, reason: "stack-still-live", liveContainers: 1 });
    expect(rowFor(registryPath, "row1")).not.toBeNull();

    // --force is the eyes-open override.
    const forced = await teardownInstance({ slug: "row1", force: true, log: () => {}, deps });
    expect(forced.released).toBe(true);
  });

  // ── The review BLOCKER: the stale-row safety must not fail OPEN ──────────
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
      inspectProjectOwnership: () => {
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
          inspectProjectOwnership: () => bad,
        },
      });
      expect(result, `malformed inspection ${JSON.stringify(bad) ?? "undefined"} must refuse`).toMatchObject({
        released: false,
        reason: "inspect-failed",
      });
      expect(rowFor(registryPath, "row1")).not.toBeNull();
    }
  });

  // The two above drive the INJECTED seam. These two drive the REAL default
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
