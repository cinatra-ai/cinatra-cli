// Shared allocator (cinatra-cli#17, T3) — app-port + band-offset, cross-registry
// no-overlap invariant. Pure functions.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, afterEach, beforeEach } from "vitest";

import {
  reservedPorts,
  staticCloneBandPorts,
  allocateAppPort,
  allocateBandOffset,
  validateAppPort,
  assertAppPortFree,
  validatePortOffset,
  withAllocLock,
  defaultAllocLockPath,
  INSTANCE_APP_PORT_MIN,
  BAND_OFFSET_STEP,
  DEFAULT_APP_PORT,
} from "../src/instance-alloc.mjs";

const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "neo4j", host: "127.0.0.1", port: 7474 },
  { service: "neo4j", host: "127.0.0.1", port: 7687 },
];

describe("staticCloneBandPorts", () => {
  it("covers both clone bands (3100-3119 + 3200-3219)", () => {
    const ports = staticCloneBandPorts();
    expect(ports.has(3100)).toBe(true);
    expect(ports.has(3119)).toBe(true);
    expect(ports.has(3200)).toBe(true);
    expect(ports.has(3219)).toBe(true);
    expect(ports.has(3120)).toBe(false);
  });
});

describe("reservedPorts", () => {
  it("includes default app ports + full static clone band by default", () => {
    const r = reservedPorts();
    expect(r.has(DEFAULT_APP_PORT)).toBe(true);
    expect(r.has(3100)).toBe(true);
    expect(r.has(3219)).toBe(true);
  });

  it("includes live clone reservations and instance appPorts + infra ports", () => {
    const cloneRegistry = { clones: { a: { nextjsPort: 3105, wayflowPort: 3205 } } };
    const instanceRegistry = {
      instances: {
        x: { appPort: 3300, ports: { postgres: [15434], neo4j: [17474, 17687] } },
      },
    };
    const r = reservedPorts({ cloneRegistry, instanceRegistry });
    expect(r.has(3300)).toBe(true);
    expect(r.has(15434)).toBe(true);
    expect(r.has(17687)).toBe(true);
  });
});

describe("allocateAppPort", () => {
  it("never returns a clone-band port", () => {
    const p = allocateAppPort();
    expect(p).toBe(INSTANCE_APP_PORT_MIN); // 3300, first free above the bands
    expect(staticCloneBandPorts().has(p)).toBe(false);
  });

  it("skips an already-reserved instance appPort", () => {
    const instanceRegistry = { instances: { x: { appPort: 3300, ports: {} } } };
    const p = allocateAppPort({ instanceRegistry });
    expect(p).toBe(3301);
  });

  it("throws when the window is exhausted", () => {
    const instances = {};
    for (let port = 3300; port <= 3399; port += 1) {
      instances[`s${port}`] = { appPort: port, ports: {} };
    }
    expect(() => allocateAppPort({ instanceRegistry: { instances } })).toThrow(/No free instance app port/);
  });

  it("skips ports in the `exclude` set (cinatra-cli#38 auto-bump on a live-busy port)", () => {
    // 3300 + 3301 proven busy by a live probe → next free is 3302.
    const p = allocateAppPort({ exclude: new Set([3300, 3301]) });
    expect(p).toBe(3302);
  });
});

// ── cinatra-cli#38 — explicit --app-port reserved-set + live-availability ─────
describe("assertAppPortFree", () => {
  const freeProbe = async () => true; // every port reports FREE
  const busyProbe = async () => false; // every port reports BUSY

  it("rejects the DEFAULT app port (3000) — reserved, before any probe", async () => {
    const reserved = reservedPorts(); // includes 3000/3010 + clone bands
    await expect(
      assertAppPortFree({ appPort: 3000, reserved, probe: freeProbe }),
    ).rejects.toThrow(/reserved.*DEFAULT stack app port \(3000\)/s);
  });

  it("rejects the DEFAULT WayFlow port (3010) — reserved", async () => {
    const reserved = reservedPorts();
    await expect(
      assertAppPortFree({ appPort: 3010, reserved, probe: freeProbe }),
    ).rejects.toThrow(/reserved.*DEFAULT stack app port \(3010\)/s);
  });

  it("rejects a clone-band port (3105) — reserved", async () => {
    const reserved = reservedPorts();
    await expect(
      assertAppPortFree({ appPort: 3105, reserved, probe: freeProbe }),
    ).rejects.toThrow(/reserved.*static clone band.*3100-3119/s);
  });

  it("rejects a live-busy port even when it is outside the reserved set", async () => {
    const reserved = reservedPorts();
    await expect(
      assertAppPortFree({ appPort: 3400, reserved, probe: busyProbe }),
    ).rejects.toThrow(/already in use.*3400/s);
  });

  it("rejects a port reserved by a live instance reservation", async () => {
    const instanceRegistry = { instances: { x: { appPort: 3400, ports: {} } } };
    const reserved = reservedPorts({ instanceRegistry });
    await expect(
      assertAppPortFree({ appPort: 3400, reserved, probe: freeProbe }),
    ).rejects.toThrow(/reserved/);
  });

  it("accepts a free, non-reserved port", async () => {
    const reserved = reservedPorts();
    await expect(assertAppPortFree({ appPort: 3400, reserved, probe: freeProbe })).resolves.toBe(3400);
  });

  it("checks the reserved set even with NO probe (shape-independent of live state)", async () => {
    const reserved = reservedPorts();
    await expect(assertAppPortFree({ appPort: 3000, reserved })).rejects.toThrow(/reserved/);
    await expect(assertAppPortFree({ appPort: 3400, reserved })).resolves.toBe(3400);
  });
});

describe("allocateBandOffset — cross-registry no-overlap", () => {
  it("returns the lowest offset whose remapped band is fully free", () => {
    const { offset, remapped } = allocateBandOffset({ band: DEFAULT_BAND });
    expect(offset).toBe(BAND_OFFSET_STEP); // 10000
    expect(remapped.find((e) => e.service === "postgres").port).toBe(15434);
  });

  it("bumps to the next offset when a remapped port collides with a reservation", () => {
    // Reserve 15434 (postgres+10000) via an existing instance → must bump to 20000.
    const instanceRegistry = { instances: { x: { appPort: 3300, ports: { postgres: [15434] } } } };
    const { offset } = allocateBandOffset({ band: DEFAULT_BAND, instanceRegistry });
    expect(offset).toBe(20000);
  });

  it("does not collide with a live clone reservation", () => {
    // A clone reserving 17474 would collide with neo4j+10000; bump to 20000.
    const cloneRegistry = { clones: { a: { nextjsPort: 3105, wayflowPort: 17474 } } };
    const { offset } = allocateBandOffset({ band: DEFAULT_BAND, cloneRegistry });
    expect(offset).toBe(20000);
  });

  it("throws on an empty band", () => {
    expect(() => allocateBandOffset({ band: [] })).toThrow(/non-empty band/);
  });

  it("routes the band around the instance's own app port via extraReserved (cinatra-cli#38)", () => {
    // An explicit --app-port of 15434 would otherwise collide with postgres
    // (5434) at the default offset 10000 — the instance's OWN compose port lands
    // on its OWN app port. Reserving the app port forces a bump to offset 20000.
    const { offset } = allocateBandOffset({ band: DEFAULT_BAND, extraReserved: 15434 });
    expect(offset).toBe(20000);
    // A Set of extra reservations works too.
    const { offset: o2 } = allocateBandOffset({ band: DEFAULT_BAND, extraReserved: new Set([15434]) });
    expect(o2).toBe(20000);
  });
});

describe("validators", () => {
  it("validateAppPort", () => {
    expect(validateAppPort("3400")).toBe(3400);
    expect(() => validateAppPort("80")).toThrow(/Invalid --app-port/);
    expect(() => validateAppPort("nope")).toThrow(/Invalid --app-port/);
  });
  it("validatePortOffset requires a positive multiple of the step", () => {
    expect(validatePortOffset("10000")).toBe(10000);
    expect(validatePortOffset("20000")).toBe(20000);
    expect(() => validatePortOffset("5000")).toThrow(/Invalid --port-offset/);
    expect(() => validatePortOffset("-10000")).toThrow(/Invalid --port-offset/);
  });
});

describe("withAllocLock", () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "cin-alloc-lock-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runs fn under the lock and returns its value", async () => {
    const lockPath = path.join(tmp, "alloc.lock");
    const result = await withAllocLock(lockPath, async () => "did-it");
    expect(result).toBe("did-it");
  });

  it("serialises two contending callers (no interleave)", async () => {
    const lockPath = path.join(tmp, "alloc.lock");
    const order = [];
    const a = withAllocLock(lockPath, async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
    const b = withAllocLock(lockPath, async () => {
      order.push("b-start");
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // a fully completes before b starts (or vice-versa) — never interleaved.
    const aStart = order.indexOf("a-start");
    const aEnd = order.indexOf("a-end");
    const bStart = order.indexOf("b-start");
    expect(bStart).toBeGreaterThan(aEnd > aStart ? aEnd : -1);
  });

  it("defaultAllocLockPath ends with alloc.lock", () => {
    expect(defaultAllocLockPath().endsWith("alloc.lock")).toBe(true);
  });
});
