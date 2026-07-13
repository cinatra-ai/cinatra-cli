// Matrix reconcile guard (cinatra-cli#128 residual 3, done in cinatra-cli#129).
// cli#128 shipped the CLI's decision-table copy as the client half of the #1420
// contract, to reconcile when the authoritative pins landed. #1420 landed at
// authoritative revision 2 (cinatra-ai/cinatra PR #1438,
// docs/architecture/upgrade-matrix.json). This pins the CLI copy's Postgres
// entries to that authoritative service list so the two cannot drift into
// authorizing different hops.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_UPGRADE_MATRIX,
  RECONCILED_MATRIX_REVISION,
  supportedTransition,
} from "../src/upgrade-matrix.mjs";

describe("upgrade-matrix reconcile → authoritative revision 2", () => {
  it("pins the authoritative revision this copy is reconciled against", () => {
    expect(RECONCILED_MATRIX_REVISION).toBe(2);
  });

  it("platform postgres: the supported baseline hop is exactly 17 -> 18", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "17", "18")).toMatchObject({ from: "17", to: "18" });
    // 18 -> 19 is NOT supported here (prerelease-only at baseline) — fail-closed default.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "18", "19")).toBeNull();
  });

  it("nango-db: ONLY the 15 -> 17 case-scoped exception is supported (no general 16 -> 17)", () => {
    const caseB = supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "15", "17");
    expect(caseB).toMatchObject({ from: "15", to: "17", caseScoped: true });
    // The bogus general 16 -> 17 the earlier shipped copy carried is REMOVED —
    // the authoritative matrix has no such transition (fail-closed).
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "16", "17")).toBeNull();
    // nango holds at 17 upstream; 17 -> 18 is unvalidated → not supported.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "17", "18")).toBeNull();
  });

  it("twenty-db / plane-db: upstream-dictated holds — no in-place major hop offered", () => {
    for (const svc of ["twenty-db", "plane-db"]) {
      expect(DEFAULT_UPGRADE_MATRIX.services[svc].transitions).toEqual([]);
    }
  });

  it("every Postgres service keeps the authoritative PG_VERSION marker", () => {
    for (const svc of ["postgres", "nango-db", "twenty-db", "plane-db"]) {
      expect(DEFAULT_UPGRADE_MATRIX.services[svc].marker).toBe("PG_VERSION");
    }
  });
});
