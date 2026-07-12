// Supported upgrade matrix — the decision table's pure lookups (cinatra-cli#128).

import { describe, expect, it } from "vitest";

import {
  DEFAULT_UPGRADE_MATRIX,
  PG_UPGRADE_MAJOR_COMMAND,
  compareVersions,
  serviceEntry,
  serviceMarkerFile,
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
  it("nango supports both 15→17 and 16→17", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "15", "17")).toBeTruthy();
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "16", "17")).toBeTruthy();
  });
  it("an ordered-but-unlisted hop is NOT supported (twenty/plane have no in-place path yet)", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "twenty-db", "16", "18")).toBeNull();
    // Even an adjacent forward hop is unsupported unless explicitly listed.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "16", "17")).toBeNull();
  });
});
