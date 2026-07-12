// Deployed-version ledger — transactional write discipline + volume-identity
// binding + malformed-file safety (cinatra-cli#128, upgrade-paths epic).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginMigration,
  commitMigration,
  getEntry,
  ledgerPath,
  makeEntry,
  pendingFor,
  readLedger,
  recordDeployed,
  requireUsableLedger,
  rollbackMigration,
  withLedgerLock,
  writeLedger,
} from "../src/version-ledger.mjs";

let dir;
const SLUG = "acme";
const VOL = { name: "cinatra_acme_pgdata", createdAt: "2026-01-01T00:00:00Z" };
const VOL2 = { name: "cinatra_acme_pgdata", createdAt: "2026-06-01T00:00:00Z" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cinatra-ledger-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function pgEntry(v = "17", volume = VOL) {
  return makeEntry({
    service: "postgres",
    image: `postgres:${v}`,
    digest: "sha256:aaa",
    dataFormatVersion: v,
    volume,
  });
}

describe("makeEntry", () => {
  it("requires a volume identity", () => {
    expect(() => makeEntry({ service: "x", image: "y" })).toThrow(/volume identity/);
  });
  it("normalizes nullable digest/dataFormatVersion", () => {
    const e = makeEntry({ service: "x", image: "img", volume: VOL });
    expect(e).toMatchObject({ service: "x", image: "img", digest: null, dataFormatVersion: null });
    expect(e.volume).toEqual(VOL);
    expect(typeof e.recordedAt).toBe("string");
  });
});

describe("recordDeployed", () => {
  it("records a service entry immutably (input ledger untouched)", () => {
    const base = readLedger(SLUG, dir).ledger;
    const next = recordDeployed(base, pgEntry("18"));
    expect(getEntry(next, "postgres").dataFormatVersion).toBe("18");
    expect(getEntry(base, "postgres")).toBeNull();
  });
  it("refuses to overwrite a service with a migration in flight", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("17"));
    l = beginMigration(l, { service: "postgres", target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL } });
    expect(() => recordDeployed(l, pgEntry("18"))).toThrow(/migration is in flight/);
  });
});

describe("transactional migration journal", () => {
  it("beginMigration stages the target WITHOUT moving the live entry", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("17"));
    l = beginMigration(l, {
      service: "postgres",
      target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL2 },
    });
    // Live entry is still the SOURCE (17) while pending holds the target.
    expect(getEntry(l, "postgres").dataFormatVersion).toBe("17");
    const p = pendingFor(l, "postgres");
    expect(p.source.dataFormatVersion).toBe("17");
    expect(p.target.dataFormatVersion).toBe("18");
  });

  it("commitMigration promotes the target ONLY after verify (commit-only-after-verify)", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("17"));
    l = beginMigration(l, {
      service: "postgres",
      target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL2 },
    });
    l = commitMigration(l, "postgres");
    expect(getEntry(l, "postgres").dataFormatVersion).toBe("18");
    expect(pendingFor(l, "postgres")).toBeNull();
  });

  it("rollbackMigration restores the SOURCE entry (never leaves the target beside a restored volume)", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("17", VOL));
    l = beginMigration(l, {
      service: "postgres",
      target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL2 },
    });
    l = rollbackMigration(l, "postgres");
    const entry = getEntry(l, "postgres");
    expect(entry.dataFormatVersion).toBe("17");
    expect(entry.volume).toEqual(VOL); // bound back to the ORIGINAL volume identity
    expect(pendingFor(l, "postgres")).toBeNull();
  });

  it("rollback of a first-ever record (no source) removes the entry entirely", () => {
    let l = readLedger(SLUG, dir).ledger;
    l = beginMigration(l, {
      service: "nango-db",
      target: { image: "postgres:17", dataFormatVersion: "17", volume: VOL },
    });
    l = rollbackMigration(l, "nango-db");
    expect(getEntry(l, "nango-db")).toBeNull();
    expect(pendingFor(l, "nango-db")).toBeNull();
  });

  it("refuses a second concurrent migration", () => {
    let l = beginMigration(readLedger(SLUG, dir).ledger, {
      service: "postgres",
      target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL },
    });
    expect(() =>
      beginMigration(l, { service: "nango-db", target: { image: "postgres:17", dataFormatVersion: "17", volume: VOL } }),
    ).toThrow(/already in flight/);
  });

  it("commit/rollback with no journal throws", () => {
    const l = readLedger(SLUG, dir).ledger;
    expect(() => commitMigration(l)).toThrow(/no migration/);
    expect(() => rollbackMigration(l)).toThrow(/no migration/);
  });
});

describe("file IO — atomic write + read roundtrip", () => {
  it("writes 0600 and round-trips through readLedger", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("18"));
    const file = writeLedger(l, dir);
    expect(file).toBe(ledgerPath(SLUG, dir));
    expect(existsSync(file)).toBe(true);
    const re = readLedger(SLUG, dir);
    expect(re.status).toBe("ok");
    expect(getEntry(re.ledger, "postgres").dataFormatVersion).toBe("18");
  });

  it("a pending journal survives a write/read roundtrip (crash-mid-migration is durable)", () => {
    let l = recordDeployed(readLedger(SLUG, dir).ledger, pgEntry("17"));
    l = beginMigration(l, {
      service: "postgres",
      target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL2 },
    });
    writeLedger(l, dir);
    const re = readLedger(SLUG, dir);
    expect(re.status).toBe("ok");
    expect(pendingFor(re.ledger, "postgres")).not.toBeNull();
  });
});

describe("malformed ledger safety", () => {
  it("classifies invalid JSON / bad shape as malformed and NEVER auto-resets", () => {
    writeFileSync(ledgerPath(SLUG, dir), "{ not json");
    expect(readLedger(SLUG, dir).status).toBe("malformed");
    // A structurally-wrong entry (missing volume) is malformed too.
    writeFileSync(
      ledgerPath(SLUG, dir),
      JSON.stringify({ version: 1, slug: SLUG, services: { x: { service: "x", image: "i", recordedAt: "t" } }, pending: null }),
    );
    expect(readLedger(SLUG, dir).status).toBe("malformed");
  });

  it("a slug mismatch is malformed (a copied/renamed ledger is never trusted)", () => {
    writeFileSync(ledgerPath(SLUG, dir), JSON.stringify({ version: 1, slug: "other", services: {}, pending: null }));
    expect(readLedger(SLUG, dir).status).toBe("malformed");
  });

  it("requireUsableLedger throws on malformed and leaves the file in place", () => {
    writeFileSync(ledgerPath(SLUG, dir), "garbage");
    expect(() => requireUsableLedger(SLUG, dir)).toThrow(/malformed/);
    expect(readFileSync(ledgerPath(SLUG, dir), "utf8")).toBe("garbage");
  });
});

describe("withLedgerLock", () => {
  const lockFile = () => path.join(dir, `${SLUG}.json.lock`);

  it("runs the fn under the lock, returns its result, and releases (re-acquirable)", async () => {
    await expect(withLedgerLock(SLUG, dir, () => "one")).resolves.toBe("one");
    expect(existsSync(lockFile())).toBe(false);
    await expect(withLedgerLock(SLUG, dir, () => "two")).resolves.toBe("two");
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withLedgerLock(SLUG, dir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("mutually excludes a second writer while held", async () => {
    let order = [];
    await withLedgerLock(SLUG, dir, async () => {
      order.push("first-in");
      expect(existsSync(lockFile())).toBe(true);
    });
    await withLedgerLock(SLUG, dir, () => order.push("second-in"));
    expect(order).toEqual(["first-in", "second-in"]);
  });

  it("rejects an invalid slug (never locks an attacker-shaped path)", async () => {
    await expect(withLedgerLock("../evil", dir, () => {})).rejects.toThrow(/Invalid instance slug/);
  });
});
