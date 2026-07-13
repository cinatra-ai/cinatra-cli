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

  it("validates op + required env (usage, code 2)", async () => {
    const dir = ledgerDir();
    expect((await hook(dir, "bogus", {})).code).toBe(2);
    expect((await runLedgerHook({ op: "begin", service: "postgres", slug: null, ledgerDir: dir })).code).toBe(2);
    expect((await runLedgerHook({ op: "begin", service: null, slug: SLUG, ledgerDir: dir })).code).toBe(2);
    expect((await hook(dir, "begin", { image: null })).code).toBe(2);
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
