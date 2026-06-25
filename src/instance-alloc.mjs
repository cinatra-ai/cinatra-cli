// ---------------------------------------------------------------------------
// Shared port/band allocator for `cinatra install` instances (cinatra-cli#17,
// T3). Two things must never collide on a single host:
//   (a) an instance's APP port  — the host port `pnpm dev` binds (default 3000),
//   (b) an instance's full-stack INFRA band — the remapped Postgres/Redis/Nango/
//       neo4j host ports for an ISOLATED install (default band + an offset).
// …against each other, against the DEFAULT stack, AND against the CLONE system's
// reserved bands (clones.json), which hand out app ports in the fixed static
// ranges 3100-3119 (Next.js) / 3200-3219 (WayFlow).
//
// ── Cross-registry coordination (review hardening #4) ──────────────────────
// There is ONE shared outer lock — `~/.cinatra/alloc.lock` — that guards a
// multi-step instance reservation (compute offset/app-port → write the
// provisioning row) so two concurrent installs can never pick the same offset
// or app port. The lock is the OUTERMOST lock for any allocation spanning both
// registries; a per-registry `withRegistryLock` is for a single-registry row
// mutation ELSEWHERE and is NEVER nested inside `alloc.lock` (deadlock-free).
//
// The clone↔instance race is ASYMMETRIC and resolved by EXCLUSION, not by a
// retrofit of the heavy clone code-path: clone app ports are a FIXED, static,
// index-derived band (CLONE_NEXTJS_PORT_BASE+i / CLONE_WAYFLOW_PORT_BASE+i, i in
// 0..CLONE_MAX_INDEX). A clone can NEVER wander into an instance's
// dynamically-chosen port — it only ever uses its own static band. So the
// instance allocator simply EXCLUDES the entire static clone band (all slots,
// reserved or not) AND, as defense-in-depth, the live clone reservations read
// from clones.json. The instance's own reservation is what `alloc.lock`
// serialises. This keeps the lane install-UX-only (no mutation of the heavy
// index.mjs clone paths) while making the no-overlap invariant hold.
//
// Import-light: node builtins + the lock reused from clone-registry.
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";

import {
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
  CLONE_MAX_INDEX,
  isValidSlug,
  withRegistryLock,
} from "./clone-registry.mjs";

// App ports the default stacks always use — never hand these out.
export const DEFAULT_APP_PORT = 3000;
export const DEFAULT_WAYFLOW_PORT = 3010;

// The instance app-port search window. Starts above the main app's default pair
// and the clone bands, deliberately AVOIDING 3100-3219 entirely (excluded
// below). 3300..3399 is the instance app-port pool.
export const INSTANCE_APP_PORT_MIN = 3300;
export const INSTANCE_APP_PORT_MAX = 3399;

// The infra-band remap step. An isolated instance shifts EVERY default infra
// host port by `offset`. The step is large enough that no two offsets overlap
// for the default band's port spread (5434/5435/6379/7474/7687/3003/3009/4873/
// 8000 fit comfortably within a 1000-wide stride; we use 10000 to keep remapped
// ports in a distinct, human-legible decade and away from the low default band).
export const BAND_OFFSET_STEP = 10000;
export const BAND_OFFSET_MIN = 10000;
export const BAND_OFFSET_MAX = 50000;

export function defaultAllocLockPath() {
  // CINATRA_ALLOC_LOCK redirects the shared allocation lock (hermetic-test +
  // alternate-home seam; pairs with CINATRA_INSTANCE_REGISTRY).
  const override = process.env.CINATRA_ALLOC_LOCK;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(os.homedir(), ".cinatra", "alloc.lock");
}

/** The full set of app ports the CLONE system statically reserves (both bands,
 *  every index). These are excluded from instance app-port allocation
 *  unconditionally — a clone could claim any of them at any time. */
export function staticCloneBandPorts() {
  const ports = new Set();
  for (let i = 0; i <= CLONE_MAX_INDEX; i += 1) {
    ports.add(CLONE_NEXTJS_PORT_BASE + i);
    ports.add(CLONE_WAYFLOW_PORT_BASE + i);
  }
  return ports;
}

/**
 * Collect every host port currently reserved across BOTH registries plus the
 * static clone band and the default app ports. Pure — the registries are passed
 * in (read under `alloc.lock` by the caller).
 *
 * @param {object} args
 * @param {object} [args.cloneRegistry]    parsed clones.json (or null)
 * @param {object} [args.instanceRegistry] parsed instances.json (or null)
 * @returns {Set<number>} every reserved host port number
 */
export function reservedPorts({ cloneRegistry = null, instanceRegistry = null } = {}) {
  const reserved = new Set([DEFAULT_APP_PORT, DEFAULT_WAYFLOW_PORT]);
  for (const p of staticCloneBandPorts()) reserved.add(p);

  // Live clone reservations (defense-in-depth on top of the static band).
  const clones = cloneRegistry?.clones ?? {};
  for (const slot of Object.values(clones)) {
    if (Number.isInteger(slot?.nextjsPort)) reserved.add(slot.nextjsPort);
    if (Number.isInteger(slot?.wayflowPort)) reserved.add(slot.wayflowPort);
  }

  // Instance reservations: the app port + every infra host port (per-service
  // LIST), so a new instance's band never lands on an existing instance's port.
  const instances = instanceRegistry?.instances ?? {};
  for (const slot of Object.values(instances)) {
    if (Number.isInteger(slot?.appPort)) reserved.add(slot.appPort);
    const portsMap = slot?.ports ?? {};
    for (const list of Object.values(portsMap)) {
      for (const p of Array.isArray(list) ? list : []) {
        if (Number.isInteger(p)) reserved.add(p);
      }
    }
  }
  return reserved;
}

/**
 * Allocate the lowest free instance APP port in [min,max], skipping the default
 * app ports, the full static clone band, and every live reservation. Pure.
 * `exclude` is an extra Set of ports to skip (e.g. ports a live probe just
 * proved busy — used by the isolated-executor auto-bump loop, cinatra-cli#38).
 * Throws when the window is exhausted.
 */
export function allocateAppPort({
  cloneRegistry = null,
  instanceRegistry = null,
  exclude = null,
  min = INSTANCE_APP_PORT_MIN,
  max = INSTANCE_APP_PORT_MAX,
} = {}) {
  const reserved = reservedPorts({ cloneRegistry, instanceRegistry });
  const skip = exclude instanceof Set ? exclude : new Set();
  for (let p = min; p <= max; p += 1) {
    if (!reserved.has(p) && !skip.has(p)) return p;
  }
  throw new Error(
    `No free instance app port in ${min}-${max} (all reserved by the default stack, clones, or other instances). ` +
      `Pass --app-port <n> with a port you know is free, or release an instance.`,
  );
}

/**
 * Given the DEFAULT infra band `[{ service, host, port }]`, find the lowest
 * band offset (a multiple of BAND_OFFSET_STEP in [min,max]) such that NONE of
 * the remapped host ports (port+offset) collides with any reserved port and all
 * remapped ports stay <= 65535. Pure. Throws when no offset fits.
 *
 * Returns { offset, remapped } where `remapped` is the band with `port` shifted.
 */
export function allocateBandOffset({
  band,
  cloneRegistry = null,
  instanceRegistry = null,
  extraReserved = null,
  step = BAND_OFFSET_STEP,
  min = BAND_OFFSET_MIN,
  max = BAND_OFFSET_MAX,
} = {}) {
  if (!Array.isArray(band) || band.length === 0) {
    throw new Error("allocateBandOffset requires a non-empty band.");
  }
  const reserved = reservedPorts({ cloneRegistry, instanceRegistry });
  // The isolated instance's OWN chosen app port (cinatra-cli#38): the remapped
  // infra band must never land a service host port ON this instance's app port
  // (e.g. --app-port 15434 + auto offset 10000 → postgres 5434→15434 would
  // self-collide at `pnpm dev`). Reserve it so band allocation routes around it.
  if (extraReserved instanceof Set) {
    for (const p of extraReserved) if (Number.isInteger(p)) reserved.add(p);
  } else if (Number.isInteger(extraReserved)) {
    reserved.add(extraReserved);
  }
  for (let offset = min; offset <= max; offset += step) {
    let ok = true;
    for (const entry of band) {
      const remapped = entry.port + offset;
      if (remapped > 65535 || reserved.has(remapped)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        offset,
        remapped: band.map((e) => ({ ...e, port: e.port + offset })),
      };
    }
  }
  throw new Error(
    `Could not find a free infra band offset (${min}..${max}) for the isolated stack — ` +
      `every candidate collides with a reserved port. Free some ports or release an instance.`,
  );
}

/**
 * Run `fn` while holding the shared OUTER allocation lock. `fn` receives no
 * arguments; the caller reads both registries, computes the allocation, and
 * writes the provisioning row INSIDE `fn` (so the reservation is durable before
 * the lock releases — rationale: keep the reservation lock until the row exists).
 * Reuses clone-registry's battle-tested lock implementation against the shared
 * `alloc.lock` path. NEVER nest a per-registry `withRegistryLock` inside `fn`.
 */
export async function withAllocLock(lockPath, fn) {
  // withRegistryLock takes a FILE path and locks `${path}.lock`; pass a base so
  // the effective lock file is `${lockPath}` → use the alloc lock path WITHOUT
  // the trailing `.lock` and let withRegistryLock append it. To make the
  // on-disk lock be exactly `alloc.lock`, hand withRegistryLock a base that
  // appends to. We standardise on locking `<dir>/alloc` → file `<dir>/alloc.lock`.
  const base = lockPath.endsWith(".lock") ? lockPath.slice(0, -".lock".length) : lockPath;
  return withRegistryLock(base, fn);
}

/** Validate an explicit `--app-port` value (operator-supplied) for SHAPE only —
 *  the numeric range. Reserved-set + live-availability are a SEPARATE concern
 *  (assertAppPortFree), checked at the call site under the alloc lock where the
 *  registries (and a consistent reserved snapshot) are in scope. */
export function validateAppPort(value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`Invalid --app-port "${value}". Must be an integer between 1024 and 65535.`);
  }
  return n;
}

/**
 * Assert an EXPLICIT operator-supplied `--app-port` is usable: it must be
 * (a) outside the RESERVED set — the default app ports (3000/3010), the static
 * clone bands (3100-3119 / 3200-3219), and every live clone/instance
 * reservation — and (b) live-FREE on the host (cinatra-cli#38). Pure: the
 * reserved set and the probe are injected; the probe is the SAME socket probe
 * the infra band uses. Returns the port when free; throws an accurate,
 * actionable error otherwise.
 *
 * @param {object} args
 * @param {number}  args.appPort   the explicit app port to check
 * @param {Set<number>} args.reserved   the reserved-port snapshot (reservedPorts(...))
 * @param {(host:string, port:number) => (boolean|Promise<boolean>)} [args.probe]
 *        returns true when the port is FREE (mirrors detectPortConflicts' probe);
 *        omit to skip the live check (validates the reserved set only)
 * @param {string} [args.host]   the interface to probe (default 127.0.0.1 — the
 *        host `pnpm dev`/Next.js binds the app port on)
 */
export async function assertAppPortFree({ appPort, reserved, probe = null, host = "127.0.0.1" } = {}) {
  if (!Number.isInteger(appPort)) {
    throw new Error(`assertAppPortFree requires an integer appPort (got ${appPort}).`);
  }
  const reservedSet = reserved instanceof Set ? reserved : new Set();
  if (reservedSet.has(appPort)) {
    let why = "the reserved set (default app ports, clone bands, or a live instance/clone reservation)";
    if (appPort === DEFAULT_APP_PORT || appPort === DEFAULT_WAYFLOW_PORT) {
      why = `a DEFAULT stack app port (${appPort})`;
    } else if (staticCloneBandPorts().has(appPort)) {
      why = `the static clone band (${appPort} is in 3100-3119 / 3200-3219)`;
    }
    throw new Error(
      `--app-port ${appPort} is reserved: it collides with ${why}. ` +
        `Pick a free port outside the reserved set, or omit --app-port to auto-allocate.`,
    );
  }
  if (typeof probe === "function") {
    const free = await probe(host, appPort);
    if (!free) {
      throw new Error(
        `--app-port ${appPort} is already in use on ${host}:${appPort} (an isolated instance would fail to bind at \`pnpm dev\`). ` +
          `Pick a free port, or omit --app-port to auto-allocate one that is probed free.`,
      );
    }
  }
  return appPort;
}

/** Validate an explicit `--port-offset` value (must be a positive multiple of
 *  the step so the remapped band stays legible and non-overlapping). */
export function validatePortOffset(value) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isInteger(n) || n <= 0 || n % BAND_OFFSET_STEP !== 0) {
    throw new Error(
      `Invalid --port-offset "${value}". Use "auto" or a positive multiple of ${BAND_OFFSET_STEP}.`,
    );
  }
  return n;
}

export const __test = {
  DEFAULT_APP_PORT,
  DEFAULT_WAYFLOW_PORT,
  INSTANCE_APP_PORT_MIN,
  INSTANCE_APP_PORT_MAX,
  BAND_OFFSET_STEP,
  BAND_OFFSET_MIN,
  BAND_OFFSET_MAX,
  defaultAllocLockPath,
  staticCloneBandPorts,
  reservedPorts,
  allocateAppPort,
  allocateBandOffset,
  withAllocLock,
  validateAppPort,
  assertAppPortFree,
  validatePortOffset,
  isValidSlug,
};
