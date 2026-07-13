// Supported upgrade matrix — the decision table's pure lookups (cinatra-cli#128).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_UPGRADE_MATRIX,
  PG_UPGRADE_MAJOR_COMMAND,
  UPGRADE_RUNBOOK_URL,
  compareVersions,
  serviceEntry,
  serviceMarkerFile,
  serviceRunbookUrl,
  supportedTransition,
} from "../src/upgrade-matrix.mjs";

describe("serviceEntry / serviceMarkerFile", () => {
  it("returns the entry for a known service and null for an unknown one", () => {
    expect(serviceEntry(DEFAULT_UPGRADE_MATRIX, "postgres")).toBeTruthy();
    expect(serviceEntry(DEFAULT_UPGRADE_MATRIX, "nope")).toBeNull();
  });
  it("only Postgres exposes an authoritative raw marker (PG_VERSION)", () => {
    expect(serviceMarkerFile(DEFAULT_UPGRADE_MATRIX, "postgres")).toBe("PG_VERSION");
    expect(serviceMarkerFile(DEFAULT_UPGRADE_MATRIX, "redis")).toBeNull();
    expect(serviceMarkerFile(DEFAULT_UPGRADE_MATRIX, "neo4j")).toBeNull();
  });
});

describe("serviceRunbookUrl — deep-links the reserved per-family anchor (cinatra-ai/cinatra#1421)", () => {
  // The anchors reserved by the runbook (cinatra-ai/docs
  // guides/hosting/upgrading-stateful-services.md, docs#135). Each guarded
  // stateful service maps to its family's section.
  const cases = [
    ["postgres", "postgres"],
    ["nango-db", "postgres"],
    ["twenty-db", "postgres"],
    ["plane-db", "postgres"],
    ["wordpress-db", "mariadb"],
    ["drupal-db", "mariadb"],
    ["neo4j", "neo4j"],
    ["redis", "redis-and-valkey"],
    ["twenty-redis", "redis-and-valkey"],
    ["plane-redis", "redis-and-valkey"],
    ["plane-mq", "rabbitmq"],
    ["verdaccio", "verdaccio"],
  ];
  it.each(cases)("%s → #%s", (service, anchor) => {
    expect(serviceRunbookUrl(DEFAULT_UPGRADE_MATRIX, service)).toBe(`${UPGRADE_RUNBOOK_URL}#${anchor}`);
  });
  it("every service the matrix knows carries a runbook anchor", () => {
    for (const service of Object.keys(DEFAULT_UPGRADE_MATRIX.services)) {
      expect(serviceRunbookUrl(DEFAULT_UPGRADE_MATRIX, service)).toMatch(/#[a-z0-9-]+$/);
    }
  });
  it("an unknown service (no family) falls back to the BARE page URL — never a broken fragment", () => {
    expect(serviceRunbookUrl(DEFAULT_UPGRADE_MATRIX, "not-a-service")).toBe(UPGRADE_RUNBOOK_URL);
    expect(serviceRunbookUrl(DEFAULT_UPGRADE_MATRIX, "not-a-service")).not.toContain("#");
  });
});

describe("compareVersions — index-based on the ordered axis (never numeric)", () => {
  it("orders pg majors", () => {
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "postgres", "17", "18")).toBe(-1); // upgrade
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "postgres", "18", "17")).toBe(1); // downgrade
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "postgres", "18", "18")).toBe(0);
  });
  it("orders redis on its OWN axis (7 < 8) without numeric assumptions", () => {
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "redis", "7", "8")).toBe(-1);
  });
  it("returns null when either version is off the axis (incomparable → fail closed upstream)", () => {
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "postgres", "14", "18")).toBeNull();
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "postgres", "17", "99")).toBeNull();
    expect(compareVersions(DEFAULT_UPGRADE_MATRIX, "unknown-svc", "1", "2")).toBeNull();
  });
});

describe("supportedTransition — explicit hops only, never inferred from adjacency", () => {
  it("finds an explicitly-listed pg hop and routes it through the sanctioned command", () => {
    const t = supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "17", "18");
    expect(t).toBeTruthy();
    expect(t.migration).toBe(PG_UPGRADE_MAJOR_COMMAND);
  });
  it("nango supports ONLY the 15→17 case-scoped exception (reconciled to authoritative rev 2)", () => {
    // The pre-baseline pg15 nango volume is a case-scoped exception
    // (cinatra-ai/cinatra#1417 Case B); the general baseline holds at 17. The
    // earlier shipped copy also carried a general 16→17 hop the authoritative
    // matrix does NOT have — removed in the cinatra-cli#129 reconcile.
    const caseB = supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "15", "17");
    expect(caseB).toBeTruthy();
    expect(caseB.caseScoped).toBe(true);
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "16", "17")).toBeNull();
  });
  it("an ordered-but-unlisted hop is NOT supported (twenty/plane have no in-place path yet)", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "twenty-db", "16", "18")).toBeNull();
    // Even an adjacent forward hop is unsupported unless explicitly listed.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "16", "17")).toBeNull();
  });
});
