// Supported upgrade matrix — the decision table's pure lookups (cinatra-cli#128)
// + the reconcile pin against the authoritative cinatra matrix revision
// (cinatra-cli#129 / cinatra-ai/cinatra#1420).

import { describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_MATRIX_BASELINE,
  AUTHORITATIVE_MATRIX_REVISION,
  DEFAULT_UPGRADE_MATRIX,
  PG_UPGRADE_MAJOR_COMMAND,
  compareVersions,
  deriveDataFormatVersion,
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
  it("nango supports ONLY the case-scoped 15→17 exception (16→17 is NOT in the authoritative matrix)", () => {
    const caseB = supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "15", "17");
    expect(caseB).toBeTruthy();
    expect(caseB.caseScoped).toBe(true);
    expect(caseB.migration).toBe(PG_UPGRADE_MAJOR_COMMAND);
    // Reconciled against authoritative revision 1: no general 16→17 hop exists.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "16", "17")).toBeNull();
    // And the general baseline stays at 17 (17→18 is fail-closed for nango).
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "nango-db", "17", "18")).toBeNull();
  });
  it("an ordered-but-unlisted hop is NOT supported (twenty/plane have no in-place path yet)", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "twenty-db", "16", "18")).toBeNull();
    // Even an adjacent forward hop is unsupported unless explicitly listed.
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "postgres", "16", "17")).toBeNull();
  });
});

describe("reconcile pin against the authoritative cinatra matrix (revision 1)", () => {
  it("pins the authoritative revision + baseline the shipped copy was reconciled to", () => {
    expect(AUTHORITATIVE_MATRIX_REVISION).toBe(1);
    expect(AUTHORITATIVE_MATRIX_BASELINE).toBe("0.1.9");
    expect(DEFAULT_UPGRADE_MATRIX.revision).toBe(AUTHORITATIVE_MATRIX_REVISION);
    expect(DEFAULT_UPGRADE_MATRIX.baselineRelease).toBe(AUTHORITATIVE_MATRIX_BASELINE);
  });
  it("only the pg logical-dump-restore hops carry the sanctioned command; other mechanisms are runbook-guided", () => {
    for (const [service, entry] of Object.entries(DEFAULT_UPGRADE_MATRIX.services)) {
      for (const t of entry.transitions) {
        if (t.mechanism === "logical-dump-restore") {
          expect(t.migration, `${service} ${t.from}→${t.to}`).toBe(PG_UPGRADE_MAJOR_COMMAND);
        } else {
          expect(t.migration, `${service} ${t.from}→${t.to}`).toBeNull();
        }
      }
    }
  });
  it("carries the authoritative non-pg supported hops (mariadb sequential 11.4→11.8, neo4j 5.26→calver, redis 7→8)", () => {
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "wordpress-db", "11.4", "11.8")?.mechanism).toBe("in-place-store-format");
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "drupal-db", "11.4", "11.8")?.mechanism).toBe("in-place-store-format");
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "neo4j", "5.26", "2026.05")?.mechanism).toBe("in-place-store-format");
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "redis", "7", "8")?.mechanism).toBe("discard-recreate");
    // Sequential-only rule: skipping 11.8 stays fail-closed (unlisted).
    expect(supportedTransition(DEFAULT_UPGRADE_MATRIX, "wordpress-db", "11.4", "12.0")).toBeNull();
  });
});

describe("deriveDataFormatVersion — raw tag wins before variant-strip", () => {
  it("derives pg majors from variant tags and honors a raw-tag axis entry", () => {
    expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, "postgres", "postgres:18-alpine@sha256:abc")).toBe("18");
    expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, "neo4j", "neo4j:2026.05-community@sha256:abc")).toBe("2026.05");
    // A raw tag that IS an axis entry must match before the variant-strip
    // mangles it (dated release tags contain "-" inside the version itself).
    const dated = {
      services: { minio: { order: ["RELEASE.2025-09-07T16-13-09Z"], marker: null, dataMount: "/data", transitions: [] } },
    };
    expect(deriveDataFormatVersion(dated, "minio", "minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:abc")).toBe(
      "RELEASE.2025-09-07T16-13-09Z",
    );
  });
});
