// `cinatra instance db upgrade-major` — the guarded transaction engine
// (cinatra-cli#129). Failure injection at EVERY step (dump failure, disk-full,
// restore failure, verify failure, cutover failure): each path must land back
// on the intact old volume WITH the source-version ledger entry intact — the
// issue's acceptance criterion, asserted against the REAL ledger module in a
// temp dir (the ledger's transactionality IS the contract under test).

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareContentStats,
  isSafeDbIdentifier,
  parseDfAvailableBytes,
  parseUpgradeMajorArgs,
  rolesFromGlobalsDump,
  runUpgradeMajor,
} from "../src/upgrade-major.mjs";
import { getEntry, makeEntry, readLedger, recordDeployed, writeLedger } from "../src/version-ledger.mjs";

const SLUG = "acme";
const SERVICE = "postgres";
const SOURCE_VOLUME = { name: "cinatra-postgres", createdAt: "2026-01-01T00:00:00Z" };

let ledgerDir;
beforeEach(() => {
  ledgerDir = mkdtempSync(path.join(os.tmpdir(), "cin-upg-ledger-"));
  // Seed the source entry the rollback must restore.
  const seeded = recordDeployed(
    { version: 1, slug: SLUG, services: {}, pending: null, updatedAt: null },
    makeEntry({ service: SERVICE, image: "postgres:17-alpine", digest: null, dataFormatVersion: "17", volume: SOURCE_VOLUME }),
  );
  writeLedger(seeded, ledgerDir);
});
afterEach(() => rmSync(ledgerDir, { recursive: true, force: true }));

const SOURCE_STATS = { postgres: { "cinatra.works_after_data": "3", "public.other": "12" } };

/** A recording fake transport. `fail[name] = true` makes that op throw;
 *  `overrides` replace whole ops. */
function makeTransport({ fail = {}, overrides = {} } = {}) {
  const calls = [];
  const op = (name, ret) => (...args) => {
    calls.push([name, ...args]);
    // `fail[name] = true` throws on every call; "once" throws only on the
    // FIRST call (so a rollback that legitimately re-runs the op — e.g.
    // waitServiceReady after restoring the original volume — can succeed).
    if (fail[name] === true || (fail[name] === "once" && !calls.some((c, i) => c[0] === name && i < calls.length - 1))) {
      throw new Error(`${name}: injected failure`);
    }
    return typeof ret === "function" ? ret(...args) : ret;
  };
  const transport = {
    backupDir: "/backups/acme/postgres-x",
    oldVolumeName: SOURCE_VOLUME.name,
    preflight: op("preflight", () => ({
      ok: false,
      findings: [],
      results: [{ service: SERVICE, verdict: "stop", reason: "supported upgrade pending (detected 17 → target 18)", detected: "17", target: "18" }],
    })),
    targetImageRef: op("targetImageRef", { image: "postgres:18-alpine@sha256:abc", digest: "sha256:abc" }),
    databaseSizeBytes: op("databaseSizeBytes", 10_000_000),
    freeBytesAtBackupDir: op("freeBytesAtBackupDir", 500 * 1024 ** 3),
    freeBytesInDockerRoot: op("freeBytesInDockerRoot", 500 * 1024 ** 3),
    runningDependents: op("runningDependents", ["app", "worker"]),
    stopServices: op("stopServices", undefined),
    upServices: op("upServices", undefined),
    listDatabases: op("listDatabases", [{ name: "postgres", owner: "postgres" }]),
    dumpGlobals: op("dumpGlobals", { path: "/b/globals.sql", sha256: "aa", bytes: 128 }),
    dumpDatabase: op("dumpDatabase", (db) => ({ path: `/b/${db}.pgc`, sha256: "bb", bytes: 4096 })),
    contentStats: op("contentStats", () => JSON.parse(JSON.stringify(SOURCE_STATS))),
    writeBackupManifest: op("writeBackupManifest", "/b/manifest.json"),
    createTargetVolume: op("createTargetVolume", {
      name: "cinatra-postgres-pg18-20260712",
      identity: { name: "cinatra-postgres-pg18-20260712", createdAt: "2026-07-12T10:00:00Z" },
    }),
    startScratchTarget: op("startScratchTarget", undefined),
    restoreGlobals: op("restoreGlobals", { verifiedRoles: ["postgres"] }),
    ensureDatabase: op("ensureDatabase", undefined),
    restoreDatabase: op("restoreDatabase", undefined),
    stopScratchTarget: op("stopScratchTarget", undefined),
    writeCutoverOverride: op("writeCutoverOverride", {
      overridePath: "/x/docker-compose.db-volumes.yml",
      hadFile: false,
      previousRaw: null,
      previousBinding: null,
      filesUpdated: true,
    }),
    removeCutoverOverride: op("removeCutoverOverride", undefined),
    waitServiceReady: op("waitServiceReady", undefined),
    ...overrides,
  };
  return { transport, calls, called: (n) => calls.some((c) => c[0] === n) };
}

function ledgerNow() {
  return readLedger(SLUG, ledgerDir).ledger;
}

function expectSourceLedgerIntact() {
  const ledger = ledgerNow();
  expect(ledger.pending).toBeNull();
  const entry = getEntry(ledger, SERVICE);
  expect(entry).toBeTruthy();
  expect(entry.dataFormatVersion).toBe("17");
  expect(entry.volume).toEqual(SOURCE_VOLUME);
}

describe("runUpgradeMajor — happy path", () => {
  it("executes the full transaction, commits the ledger only at the end, resumes dependents", async () => {
    const { transport, calls } = makeTransport();
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("ok");
    expect(result.from).toBe("17");
    expect(result.to).toBe("18");
    expect(result.oldVolume).toBe(SOURCE_VOLUME.name);
    expect(result.retention).toContain("PRESERVED");

    // Ledger committed: live entry is now the target bound to the NEW volume.
    const ledger = ledgerNow();
    expect(ledger.pending).toBeNull();
    expect(getEntry(ledger, SERVICE).dataFormatVersion).toBe("18");
    expect(getEntry(ledger, SERVICE).volume.name).toBe("cinatra-postgres-pg18-20260712");

    // Ordering invariants: quiesce before dump; dump before stop-source; the
    // scratch is stopped before cutover; cutover before dependents resume.
    const idx = (name, ...args) =>
      calls.findIndex((c) => c[0] === name && args.every((a, i) => JSON.stringify(c[i + 1]) === JSON.stringify(a)));
    expect(idx("stopServices", ["app", "worker"])).toBeLessThan(idx("dumpGlobals"));
    expect(idx("dumpGlobals")).toBeLessThan(idx("stopServices", ["postgres"]));
    expect(idx("stopScratchTarget")).toBeLessThan(idx("writeCutoverOverride"));
    expect(idx("writeCutoverOverride")).toBeLessThan(idx("upServices", ["app", "worker"]));
    // The old volume is never touched: no op ever names it destructively (the
    // transport has no remove-volume op at all — retirement is manual by design).
  });

  it("nothing to do when the preflight already passes", async () => {
    const { transport, called } = makeTransport({
      overrides: {
        preflight: () => ({ ok: true, findings: [], results: [{ service: SERVICE, verdict: "pass", reason: "matching versions (18)", detected: "18" }] }),
      },
    });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("noop");
    expect(called("stopServices")).toBe(false);
    expectSourceLedgerIntact();
  });
});

describe("runUpgradeMajor — refusals (fail closed, store untouched)", () => {
  it("refuses a fail-closed preflight verdict", async () => {
    const { transport, called } = makeTransport({
      overrides: {
        preflight: () => ({
          ok: false,
          findings: [],
          results: [{ service: SERVICE, verdict: "fail-closed", reason: "deployed version is unknown/unreadable on a non-empty volume" }],
        }),
      },
    });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("refused");
    expect(called("stopServices")).toBe(false);
    expectSourceLedgerIntact();
  });

  it("refuses a STOP whose hop the matrix does not route through this command", async () => {
    const { transport, called } = makeTransport({
      overrides: {
        preflight: () => ({
          ok: false,
          findings: [],
          // A fabricated 18→19 stop: not a supported matrix transition.
          results: [{ service: SERVICE, verdict: "stop", reason: "supported upgrade pending", detected: "18", target: "19" }],
        }),
      },
    });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("refused");
    expect(called("stopServices")).toBe(false);
    expectSourceLedgerIntact();
  });

  it("refuses while a migration journal is already pending (any service)", async () => {
    const ledger = ledgerNow();
    ledger.pending = {
      service: "nango-db",
      source: null,
      target: makeEntry({ service: "nango-db", image: "postgres:17-alpine", volume: { name: "v", createdAt: "t" } }),
      startedAt: new Date().toISOString(),
    };
    writeLedger(ledger, ledgerDir);
    const { transport, called } = makeTransport();
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("refused");
    expect(result.reason).toContain("nango-db");
    expect(called("stopServices")).toBe(false);
  });
});

describe("runUpgradeMajor — failure injection (every path lands on the intact old volume + source ledger entry)", () => {
  it("disk-full aborts BEFORE anything is touched", async () => {
    const { transport, called } = makeTransport({ overrides: { freeBytesAtBackupDir: () => 1024 } });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("disk-precheck");
    expect(called("stopServices")).toBe(false);
    expect(called("createTargetVolume")).toBe(false);
    expectSourceLedgerIntact();
  });

  it("dump failure → dependents resumed, no journal ever opened, no volume created", async () => {
    const { transport, calls, called } = makeTransport({ fail: { dumpGlobals: true } });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("dump");
    expect(result.rolledBack).toBe(true);
    expect(called("createTargetVolume")).toBe(false);
    expect(called("writeCutoverOverride")).toBe(false);
    // Dependents were quiesced and must be resumed.
    expect(calls.some((c) => c[0] === "upServices" && c[1].includes("app"))).toBe(true);
    // The source service itself was never stopped, so it is not restarted.
    expect(calls.some((c) => c[0] === "upServices" && c[1].includes("postgres"))).toBe(false);
    expectSourceLedgerIntact();
  });

  it("restore failure → scratch stopped, journal rolled back, service restarted on the old volume", async () => {
    const { transport, calls, called } = makeTransport({ fail: { restoreDatabase: true } });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("restore");
    expect(result.rolledBack).toBe(true);
    expect(called("stopScratchTarget")).toBe(true);
    expect(called("writeCutoverOverride")).toBe(false);
    expect(calls.some((c) => c[0] === "upServices" && c[1].includes("postgres"))).toBe(true);
    expect(calls.some((c) => c[0] === "upServices" && c[1].includes("app"))).toBe(true);
    expectSourceLedgerIntact();
  });

  it("verify failure (content read-back mismatch) → full rollback, cutover never written", async () => {
    const { transport, called } = makeTransport({
      overrides: {
        contentStats: (where) =>
          where === "scratch" ? { postgres: { "cinatra.works_after_data": "2", "public.other": "12" } } : JSON.parse(JSON.stringify(SOURCE_STATS)),
      },
    });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("verify");
    expect(result.error).toContain("cinatra.works_after_data");
    expect(called("writeCutoverOverride")).toBe(false);
    expectSourceLedgerIntact();
  });

  it("cutover failure (service not ready on the new volume) → override removed, ledger rolled back, old service up", async () => {
    const { transport, calls, called } = makeTransport({ fail: { waitServiceReady: "once" } });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("cutover");
    expect(result.rolledBack).toBe(true);
    expect(called("removeCutoverOverride")).toBe(true);
    // Override removal precedes the service restart (the restart must bind the
    // ORIGINAL volume again).
    const rmIdx = calls.findIndex((c) => c[0] === "removeCutoverOverride");
    const upIdx = calls.findIndex((c, i) => i > rmIdx && c[0] === "upServices" && c[1].includes("postgres"));
    expect(rmIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeGreaterThan(rmIdx);
    expectSourceLedgerIntact();
  });

  it("unsafe database identifiers abort before any dump (fail closed)", async () => {
    const { transport, called } = makeTransport({
      overrides: { listDatabases: () => [{ name: "postgres", owner: "postgres" }, { name: "we`ird", owner: "postgres" }] },
    });
    const result = await runUpgradeMajor({ slug: SLUG, service: SERVICE, transport, ledgerDir });
    expect(result.status).toBe("failed");
    expect(result.failedStep).toBe("dump");
    expect(called("dumpGlobals")).toBe(false);
    expectSourceLedgerIntact();
  });
});

describe("pure helpers", () => {
  it("parseUpgradeMajorArgs — strict flags, --service required", () => {
    expect(parseUpgradeMajorArgs(["--service", "nango-db", "--instance", "acme", "--json"])).toEqual({
      service: "nango-db",
      slug: "acme",
      json: true,
    });
    expect(() => parseUpgradeMajorArgs([])).toThrow(/--service is required/);
    expect(() => parseUpgradeMajorArgs(["--service", "postgres", "--force"])).toThrow(/Unexpected argument/);
  });

  it("compareContentStats — both directions, per database", () => {
    expect(compareContentStats({ d: { t: "3" } }, { d: { t: "3" } })).toEqual([]);
    expect(compareContentStats({ d: { t: "3" } }, { d: { t: "2" } })[0]).toContain("row count");
    expect(compareContentStats({ d: { t: "3" } }, { d: {} })[0]).toContain("missing after restore");
    expect(compareContentStats({ d: {} }, { d: { t: "1" } })[0]).toContain("appeared after restore");
    expect(compareContentStats({ d: {} }, {})[0]).toContain('database "d" missing');
  });

  it("rolesFromGlobalsDump extracts quoted and bare role names", () => {
    const sql = 'CREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER;\nCREATE ROLE "app-reader";\n';
    expect(rolesFromGlobalsDump(sql).sort()).toEqual(["app-reader", "postgres"]);
  });

  it("isSafeDbIdentifier gates the shelled identifier set", () => {
    expect(isSafeDbIdentifier("postgres")).toBe(true);
    expect(isSafeDbIdentifier("nango")).toBe(true);
    expect(isSafeDbIdentifier("we`ird")).toBe(false);
    expect(isSafeDbIdentifier("a b")).toBe(false);
    expect(isSafeDbIdentifier("")).toBe(false);
  });

  it("parseDfAvailableBytes parses df -Pk output", () => {
    const out = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 590000000 236000000 72% /\n";
    expect(parseDfAvailableBytes(out)).toBe(236000000 * 1024);
    expect(parseDfAvailableBytes("garbage")).toBeNull();
  });
});
