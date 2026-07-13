// The ledger-transaction hook the guarded upgrade frame drives at each
// transaction boundary (cinatra-cli#129). Exercised against a REAL temp
// deployed-version ledger with an injected volume-identity seam (no docker).

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { dockerVolumeIdentity, runLedgerHook } from "../src/upgrade-ledger-hook.mjs";

const SLUG = "acme";
const SERVICE = "postgres";
const VOL = { name: "cinatra-postgres", createdAt: "2026-01-01T00:00:00Z" };
const idOf = () => VOL;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "cinatra-hook-"));
}
function readLedgerFile(dir) {
  return JSON.parse(readFileSync(join(dir, `${SLUG}.json`), "utf8"));
}

const dirs = [];
function ledgerDir() {
  const d = freshDir();
  dirs.push(d);
  return d;
}
afterEach(() => {});

async function hook(dir, op, { image, volumeName = "cinatra-postgres", targetMajor, volumeIdentityOf = idOf } = {}) {
  return runLedgerHook({
    op,
    service: SERVICE,
    image,
    volumeName,
    slug: SLUG,
    targetMajor,
    ledgerDir: dir,
    volumeIdentityOf,
  });
}

describe("runLedgerHook — the guarded frame's transactional wiring", () => {
  it("record -> begin -> commit promotes the target; the live entry stays the SOURCE until commit", async () => {
    const dir = ledgerDir();
    expect((await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" })).ok).toBe(true);
    expect(readLedgerFile(dir).services.postgres.image).toBe("postgres:17-alpine");

    expect((await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" })).ok).toBe(true);
    let l = readLedgerFile(dir);
    expect(l.pending.service).toBe("postgres");
    expect(l.pending.target.image).toBe("postgres:18-alpine");
    expect(l.services.postgres.image).toBe("postgres:17-alpine"); // live entry unchanged until commit

    expect((await hook(dir, "commit")).ok).toBe(true);
    l = readLedgerFile(dir);
    expect(l.pending).toBeNull();
    expect(l.services.postgres.image).toBe("postgres:18-alpine");
    expect(l.services.postgres.dataFormatVersion).toBe("18");
  });

  it("begin -> rollback restores the source entry (a pre-commit abort)", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" });
    await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" });
    expect((await hook(dir, "rollback")).ok).toBe(true);
    const l = readLedgerFile(dir);
    expect(l.pending).toBeNull();
    expect(l.services.postgres.image).toBe("postgres:17-alpine"); // source restored
  });

  it("a second begin while a journal is pending is a fail-closed refusal (code 6)", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" });
    await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" });
    const r = await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(6);
  });

  it("commit / rollback without a pending journal refuse (code 6)", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" });
    expect((await hook(dir, "commit")).code).toBe(6);
    expect((await hook(dir, "rollback")).code).toBe(6);
  });

  it("begin on a legacy install with NO prior entry captures a null source; rollback removes the entry", async () => {
    const dir = ledgerDir();
    expect((await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" })).ok).toBe(true);
    expect(readLedgerFile(dir).pending.source).toBeNull();
    await hook(dir, "rollback");
    expect(readLedgerFile(dir).services.postgres).toBeUndefined();
  });

  it("an unresolvable volume identity fails closed (code 6), ledger untouched", async () => {
    const dir = ledgerDir();
    const r = await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18", volumeIdentityOf: () => null });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(6);
  });

  it("begin FAILS CLOSED when the recorded source entry is bound to a different volume identity", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" }); // bound to VOL
    // The live volume was destroyed+recreated (new createdAt) — begin must refuse.
    const recreated = { name: "cinatra-postgres", createdAt: "2026-09-09T00:00:00Z" };
    const r = await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18", volumeIdentityOf: () => recreated });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(6);
    expect(r.message).toMatch(/identity mismatch/);
    // The ledger was not mutated — still the source entry, no pending journal.
    const l = readLedgerFile(dir);
    expect(l.pending).toBeNull();
    expect(l.services.postgres.image).toBe("postgres:17-alpine");
  });

  it("record DELIBERATELY rebinds a recreated volume (a fresh-init re-record is legitimate, unlike begin)", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" }); // bound to VOL
    const recreated = { name: "cinatra-postgres", createdAt: "2026-09-09T00:00:00Z" };
    const r = await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17", volumeIdentityOf: () => recreated });
    expect(r.ok).toBe(true);
    expect(readLedgerFile(dir).services.postgres.volume.createdAt).toBe("2026-09-09T00:00:00Z");
  });

  it("commit/rollback FAIL CLOSED when the live volume identity is unresolvable (never silently finish a journal)", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" });
    await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" });
    expect((await hook(dir, "commit", { volumeIdentityOf: () => null })).code).toBe(6);
    // The journal is untouched — still pending, still finishable with a real identity.
    expect(readLedgerFile(dir).pending.service).toBe("postgres");
    expect((await hook(dir, "commit")).ok).toBe(true);
  });

  it("commit FAILS CLOSED when the volume was destroyed+recreated mid-migration", async () => {
    const dir = ledgerDir();
    await hook(dir, "record", { image: "postgres:17-alpine", targetMajor: "17" });
    await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: "18" }); // pending target bound to VOL
    const recreated = { name: "cinatra-postgres", createdAt: "2026-09-09T00:00:00Z" };
    const r = await hook(dir, "commit", { volumeIdentityOf: () => recreated });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(6);
    expect(r.message).toMatch(/destroyed\+recreated mid-migration/);
    // Still pending — the journal is retained (interrupted), never committed.
    expect(readLedgerFile(dir).pending.service).toBe("postgres");
  });

  it("validates op + required env (usage, code 2)", async () => {
    const dir = ledgerDir();
    expect((await hook(dir, "bogus", {})).code).toBe(2);
    expect((await runLedgerHook({ op: "begin", service: "postgres", slug: null, ledgerDir: dir })).code).toBe(2);
    expect((await runLedgerHook({ op: "begin", service: null, slug: SLUG, ledgerDir: dir })).code).toBe(2);
    expect((await hook(dir, "begin", { image: null })).code).toBe(2);
    // A begin with no target data-format version must fail closed (would record
    // an unknown version — the naive-recreate hazard).
    expect((await hook(dir, "begin", { image: "postgres:18-alpine", targetMajor: undefined })).code).toBe(2);
  });
});

describe("dockerVolumeIdentity", () => {
  it("parses `docker volume inspect` name + createdAt", () => {
    const id = dockerVolumeIdentity("v", () => "cinatra-postgres\t2026-01-01T00:00:00Z");
    expect(id).toEqual({ name: "cinatra-postgres", createdAt: "2026-01-01T00:00:00Z" });
  });
  it("returns null on failure / malformed output", () => {
    expect(dockerVolumeIdentity("v", () => null)).toBeNull();
    expect(dockerVolumeIdentity("v", () => "onlyname")).toBeNull();
    expect(dockerVolumeIdentity("", () => "x\ty")).toBeNull();
  });
});
