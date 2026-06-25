// Hermetic regression tests for the refresh-seed metadata scrub allowlist
// (cinatra-cli#42).
//
// `cinatra clone refresh-seed` builds `cinatra_seed` from a pg_dump snapshot of
// the live app DB; clones are `CREATE DATABASE … TEMPLATE cinatra_seed`, so any
// `cinatra.metadata` row carries forward. Rows bound to the SOURCE instance's
// key (e.g. `instance_identity`) are undecryptable in a clone under its own key,
// so they MUST be scrubbed — while operator connector config (e.g.
// `connector_config:nango`) is intentionally carried forward and MUST NOT be.
//
// A live-PG integration test (seed a row, run the scrub, assert the row is gone)
// is INFEASIBLE here: the repo has no Postgres test harness — every existing
// test is hermetic (no DB fixtures, no docker), and `runRefreshSeed` /
// clone-create talk to a real Postgres via `pg`. So the contract is locked at
// (a) the pure allowlist and (b) the SQL the scrub helper emits against an
// injected fake client (parameterized, idempotent), which is the real surface
// of the over-/under-deletion risk.

import { describe, it, expect } from "vitest";
import {
  seedMetadataScrubKeys,
  scrubSeedMetadata,
  NANGO_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
} from "../src/index.mjs";

describe("seedMetadataScrubKeys (refresh-seed metadata scrub allowlist)", () => {
  it("includes instance_identity in the cinatra schema", () => {
    const keys = seedMetadataScrubKeys();
    expect(
      keys.some((r) => r.schema === "cinatra" && r.key === "instance_identity"),
    ).toBe(true);
  });

  it("does NOT scrub intentionally-carried connector config (over-deletion guard)", () => {
    const scrubbedKeys = seedMetadataScrubKeys().map((r) => r.key);
    // These are operator config the CLI deliberately carries forward; the scrub
    // must be a NARROW per-key allowlist, never a broad connector_config:* wipe.
    expect(scrubbedKeys).not.toContain(NANGO_SETTINGS_KEY); // connector_config:nango
    expect(scrubbedKeys).not.toContain(MCP_SETTINGS_KEY); // connector_config:mcp_server
    expect(scrubbedKeys).not.toContain("connector_config:llm_mcp_access");
    expect(scrubbedKeys.some((k) => k.startsWith("connector_config:"))).toBe(false);
  });

  it("returns fresh row objects callers cannot use to mutate the module constant", () => {
    const a = seedMetadataScrubKeys();
    a[0].key = "tampered";
    a.push({ schema: "cinatra", key: "extra" });
    const b = seedMetadataScrubKeys();
    expect(b.some((r) => r.key === "instance_identity")).toBe(true);
    expect(b.some((r) => r.key === "tampered")).toBe(false);
    expect(b.some((r) => r.key === "extra")).toBe(false);
  });
});

describe("scrubSeedMetadata (parameterized delete over an injected client)", () => {
  it("emits a parameterized DELETE per allowlisted key and returns the keys", async () => {
    const calls = [];
    const fakeClient = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rowCount: 0 };
      },
    };
    const scrubbed = await scrubSeedMetadata(fakeClient);

    expect(scrubbed).toContain("instance_identity");
    expect(scrubbed).toEqual(seedMetadataScrubKeys().map((r) => r.key));

    // Every emitted statement is a parameterized DELETE on <schema>.metadata
    // keyed by $1 — never string-interpolating the key (injection-safe), and
    // never a broad/unqualified delete.
    for (const { sql, params } of calls) {
      expect(sql).toMatch(/DELETE FROM .*\.metadata WHERE key = \$1/);
      expect(sql).not.toMatch(/connector_config/);
      expect(Array.isArray(params)).toBe(true);
      expect(params).toHaveLength(1);
    }
    expect(calls.map((c) => c.params[0])).toContain("instance_identity");
  });

  it("is idempotent — a no-op delete (absent row) still resolves", async () => {
    // A clone built from an old seed may not carry the row at all; the delete
    // must be a harmless no-op (rowCount 0) rather than throwing.
    const fakeClient = { query: async () => ({ rowCount: 0 }) };
    await expect(scrubSeedMetadata(fakeClient)).resolves.toEqual(
      seedMetadataScrubKeys().map((r) => r.key),
    );
  });
});
