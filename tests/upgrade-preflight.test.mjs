// Fail-closed upgrade preflight — detection adapter chain + decision core
// (cinatra-cli#128). Covers every acceptance scenario at the pure level.

import { describe, expect, it } from "vitest";

import { DEFAULT_UPGRADE_MATRIX } from "../src/upgrade-matrix.mjs";
import {
  VERDICTS,
  authorizationMatches,
  blocks,
  decideService,
  detectVersion,
  parsePreflightArgs,
  volumeIdentityFromInspect,
  volumeIdentityStatus,
} from "../src/upgrade-preflight.mjs";
import { beginMigration, makeEntry, recordDeployed } from "../src/version-ledger.mjs";

const VOL = { name: "cinatra_acme_pgdata", createdAt: "2026-01-01T00:00:00Z" };
const VOL_RECREATED = { name: "cinatra_acme_pgdata", createdAt: "2026-06-01T00:00:00Z" };
const emptyLedger = { version: 1, slug: "acme", services: {}, pending: null };

function ledgerWith(service, version, volume = VOL) {
  return recordDeployed(emptyLedger, makeEntry({ service, image: `postgres:${version}`, dataFormatVersion: version, volume }));
}

// --- volume identity -------------------------------------------------------

describe("volume identity", () => {
  it("extracts (name, createdAt) from a docker volume inspect row", () => {
    expect(volumeIdentityFromInspect({ Name: "v", CreatedAt: "t" })).toEqual({ name: "v", createdAt: "t" });
    expect(volumeIdentityFromInspect({ Name: "v" })).toBeNull();
    expect(volumeIdentityFromInspect(null)).toBeNull();
  });
  it("classifies match / mismatch / absent", () => {
    expect(volumeIdentityStatus(VOL, VOL)).toBe("match");
    expect(volumeIdentityStatus(VOL, VOL_RECREATED)).toBe("mismatch");
    expect(volumeIdentityStatus(VOL, null)).toBe("absent");
  });
});

// --- detection adapter chain ----------------------------------------------

describe("detectVersion — adapter precedence", () => {
  it("recorded ledger version is PRIMARY (short-circuits probe/marker)", () => {
    const d = detectVersion({
      service: "postgres",
      ledger: ledgerWith("postgres", "17"),
      liveVolumeIdentity: VOL,
      probeVersion: "18",
      markerVersion: "16",
    });
    expect(d).toEqual({ version: "17", source: "ledger", finding: null });
  });

  it("a ledger/volume identity mismatch is a HARD finding (no fall-through to probe)", () => {
    const d = detectVersion({
      service: "postgres",
      ledger: ledgerWith("postgres", "17"),
      liveVolumeIdentity: VOL_RECREATED,
      probeVersion: "18",
      markerVersion: "18",
    });
    expect(d.finding).toBe("ledger-volume-mismatch");
    expect(d.version).toBeNull();
  });

  it("an interrupted migration (pending journal) is a HARD finding", () => {
    let l = ledgerWith("postgres", "17");
    l = beginMigration(l, { service: "postgres", target: { image: "postgres:18", dataFormatVersion: "18", volume: VOL_RECREATED } });
    const d = detectVersion({ service: "postgres", ledger: l, liveVolumeIdentity: VOL, probeVersion: "18" });
    expect(d.finding).toBe("interrupted-migration");
  });

  it("a LEGACY install (no ledger entry) falls through probe → marker", () => {
    expect(detectVersion({ service: "postgres", ledger: emptyLedger, liveVolumeIdentity: VOL, probeVersion: "17" }))
      .toEqual({ version: "17", source: "probe", finding: null });
    expect(detectVersion({ service: "postgres", ledger: emptyLedger, liveVolumeIdentity: VOL, probeVersion: null, markerVersion: "16" }))
      .toEqual({ version: "16", source: "marker", finding: null });
    expect(detectVersion({ service: "postgres", ledger: emptyLedger, liveVolumeIdentity: VOL }))
      .toEqual({ version: null, source: null, finding: null });
  });
});

// --- decision core: every acceptance scenario -----------------------------

describe("decideService — acceptance scenarios", () => {
  const base = { service: "postgres", matrix: DEFAULT_UPGRADE_MATRIX };

  it("fresh/empty volume → PASS", () => {
    expect(decideService({ ...base, detected: null, target: "18", volumeState: "empty" }).verdict).toBe(VERDICTS.PASS);
    expect(decideService({ ...base, detected: null, target: "18", volumeState: "absent" }).verdict).toBe(VERDICTS.PASS);
  });

  it("matching versions → PASS", () => {
    expect(decideService({ ...base, detected: "18", target: "18" }).verdict).toBe(VERDICTS.PASS);
  });

  it("supported upgrade pending → STOP with the migration pointer", () => {
    const r = decideService({ ...base, detected: "17", target: "18" });
    expect(r.verdict).toBe(VERDICTS.STOP);
    expect(r.migration).toBe("cinatra instance db upgrade-major");
    expect(r.remediation).toMatch(/Back up/i);
    expect(r.remediation).toMatch(/docs\.cinatra\.ai/);
    // Deep-links the reserved per-family anchor (cinatra-ai/cinatra#1421).
    expect(r.remediation).toContain("/self-hosting/upgrading-stateful-services#postgres");
  });

  it("the #1417 scenario class (older-major data dir + naive recreate) becomes a guided STOP, never a crash-loop", () => {
    // nango pg15 volume facing a pg17 image recreate.
    const r = decideService({ service: "nango-db", matrix: DEFAULT_UPGRADE_MATRIX, detected: "15", target: "17" });
    expect(r.verdict).toBe(VERDICTS.STOP);
    expect(blocks(r.verdict)).toBe(true);
    expect(r.migration).toBe("cinatra instance db upgrade-major");
  });

  it("unsupported hop → FAIL CLOSED", () => {
    // twenty has no in-place path listed.
    const r = decideService({ service: "twenty-db", matrix: DEFAULT_UPGRADE_MATRIX, detected: "16", target: "18" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.reason).toMatch(/unsupported/i);
  });

  it("unknown/unreadable version on a non-empty volume → FAIL CLOSED", () => {
    const r = decideService({ ...base, detected: null, target: "18", volumeState: "present" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
  });

  it("off-axis (unordered) version → FAIL CLOSED", () => {
    const r = decideService({ ...base, detected: "14", target: "18" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.reason).toMatch(/unknown\/unordered/i);
  });

  it("downgrade → BLOCKED", () => {
    const r = decideService({ ...base, detected: "18", target: "17" });
    expect(r.verdict).toBe(VERDICTS.BLOCKED);
    expect(r.reason).toMatch(/downgrade/i);
  });

  it("disabled profile → SKIPPED (explicit non-finding)", () => {
    expect(decideService({ ...base, profileEnabled: false }).verdict).toBe(VERDICTS.SKIPPED);
  });

  it("ledger/volume mismatch finding → FAIL CLOSED", () => {
    const r = decideService({ ...base, detected: null, detectionFinding: "ledger-volume-mismatch", target: "18" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.reason).toMatch(/volume identity/i);
  });

  it("interrupted migration finding → FAIL CLOSED", () => {
    const r = decideService({ ...base, detected: null, detectionFinding: "interrupted-migration", target: "18" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.reason).toMatch(/interrupted/i);
  });

  it("an unknown service is FAIL CLOSED (never silently passed)", () => {
    const r = decideService({ service: "mystery", matrix: DEFAULT_UPGRADE_MATRIX, detected: "1", target: "2" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.reason).toMatch(/unknown service/i);
  });

  it("no target supplied → integrity-only PASS (clean detection, nothing to migrate)", () => {
    const r = decideService({ ...base, detected: "18", target: null });
    expect(r.verdict).toBe(VERDICTS.PASS);
    expect(r.reason).toMatch(/integrity check/i);
  });
});

// --- per-family runbook anchors (cinatra-ai/cinatra#1421) -------------------

describe("remediation messages deep-link the reserved per-family runbook anchor", () => {
  const M = DEFAULT_UPGRADE_MATRIX;
  const frag = "/self-hosting/upgrading-stateful-services";

  it("a non-Postgres family's fail-closed message links ITS family anchor, not #postgres", () => {
    // wordpress-db (MariaDB) has no supported hop → any major change fails
    // closed; the message should point at the runbook's MariaDB section.
    const r = decideService({ service: "wordpress-db", matrix: M, detected: "11.4", target: "11.8" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.remediation).toContain(`${frag}#mariadb`);
    expect(r.remediation).not.toContain("#postgres");
  });

  it("a redis/valkey fail-closed message links #redis-and-valkey", () => {
    const r = decideService({ service: "twenty-redis", matrix: M, detected: "7", target: "8" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.remediation).toContain(`${frag}#redis-and-valkey`);
  });

  it("every blocking verdict for a known family carries its family fragment", () => {
    // downgrade (BLOCKED) and unknown-version (FAIL_CLOSED) both anchor.
    const down = decideService({ service: "postgres", matrix: M, detected: "18", target: "17" });
    expect(down.verdict).toBe(VERDICTS.BLOCKED);
    expect(down.remediation).toContain(`${frag}#postgres`);
    const unknown = decideService({ service: "neo4j", matrix: M, detected: null, target: "2026.05", volumeState: "present" });
    expect(unknown.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(unknown.remediation).toContain(`${frag}#neo4j`);
  });

  it("an unknown SERVICE (no family) links the BARE page URL — never a broken fragment", () => {
    const r = decideService({ service: "mystery", matrix: M, detected: "1", target: "2" });
    expect(r.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(r.remediation).toContain("docs.cinatra.ai/self-hosting/upgrading-stateful-services");
    expect(r.remediation).not.toContain(`${frag}#`);
  });
});

// --- scoped escape path ----------------------------------------------------

describe("scoped authorization — bypasses ONLY the exact supported STOP", () => {
  const base = { service: "postgres", matrix: DEFAULT_UPGRADE_MATRIX, detected: "17", target: "18" };

  it("an EXACT (service, source, target) authorization turns the STOP into AUTHORIZED-PROCEED", () => {
    const r = decideService({ ...base, authorization: { service: "postgres", source: "17", target: "18" } });
    expect(r.verdict).toBe(VERDICTS.AUTHORIZED_PROCEED);
    expect(blocks(r.verdict)).toBe(false);
    expect(r.migration).toBe("cinatra instance db upgrade-major");
  });

  it("a non-matching authorization does NOT bypass (still STOP)", () => {
    expect(decideService({ ...base, authorization: { service: "postgres", source: "16", target: "18" } }).verdict).toBe(VERDICTS.STOP);
    expect(decideService({ ...base, authorization: { service: "nango-db", source: "17", target: "18" } }).verdict).toBe(VERDICTS.STOP);
  });

  it("authorization can NEVER bypass an unsupported hop, unknown version, or downgrade (eligibility is not bypassable)", () => {
    // unsupported hop
    expect(decideService({ service: "twenty-db", matrix: DEFAULT_UPGRADE_MATRIX, detected: "16", target: "18", authorization: { service: "twenty-db", source: "16", target: "18" } }).verdict).toBe(VERDICTS.FAIL_CLOSED);
    // downgrade
    expect(decideService({ ...base, detected: "18", target: "17", authorization: { service: "postgres", source: "18", target: "17" } }).verdict).toBe(VERDICTS.BLOCKED);
    // off-axis unknown
    expect(decideService({ ...base, detected: "14", authorization: { service: "postgres", source: "14", target: "18" } }).verdict).toBe(VERDICTS.FAIL_CLOSED);
  });

  it("authorizationMatches is exact-string on all three fields", () => {
    expect(authorizationMatches({ service: "s", source: "17", target: "18" }, "s", "17", "18")).toBe(true);
    expect(authorizationMatches({ service: "s", source: "17", target: "18" }, "s", "16", "18")).toBe(false);
    expect(authorizationMatches(null, "s", "17", "18")).toBe(false);
  });
});

// --- arg parsing -----------------------------------------------------------

describe("parsePreflightArgs", () => {
  it("parses --json, repeatable --service, --instance, and --target pairs", () => {
    const p = parsePreflightArgs(["--json", "--service", "postgres", "--service=redis", "--instance", "acme", "--target", "postgres=18"]);
    expect(p).toEqual({ json: true, only: ["postgres", "redis"], slug: "acme", targets: { "postgres": "18" } });
  });
  it("rejects an unknown flag and a malformed --target", () => {
    expect(() => parsePreflightArgs(["--bogus"])).toThrow(/Unexpected argument/);
    expect(() => parsePreflightArgs(["--target", "postgres"])).toThrow(/<service>=<version>/);
    expect(() => parsePreflightArgs(["--service"])).toThrow(/Missing value/);
  });
});
