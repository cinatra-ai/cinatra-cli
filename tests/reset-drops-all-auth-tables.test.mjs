// Regression test for cinatra-cli#70.
//
// `cinatra instance reset --yes` (soft) dropped only 12 of the 14 Better Auth
// tables — its hard-coded DROP list had drifted from `AUTH_TABLES` and was
// missing `team` + `teamMember`. The leftover tables made the post-reset
// `runSetup` see a PARTIAL auth schema and refuse to rebuild ("Better Auth
// appears partially initialized"), leaving the instance un-bootable.
//
// The fix derives the DROP list from `AUTH_TABLES` (single source of truth).
// This test asserts the drift can never reappear: `resetDevelopmentData` must
// reference EVERY table in `AUTH_TABLES` in its `drop table if exists … cascade`
// statement, with each identifier double-quoted (the names are mixed-case).

import { describe, it, expect } from "vitest";

import { AUTH_TABLES, resetDevelopmentData } from "../src/index.mjs";

/** A minimal pg-client stub that records every SQL string it is asked to run. */
function makeRecordingClient() {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(typeof sql === "string" ? sql : String(sql?.text ?? sql));
      return { rows: [] };
    },
  };
}

describe("resetDevelopmentData drops every auth table (cinatra-cli#70)", () => {
  it("references all AUTH_TABLES (quoted) in the drop statement — keep-app-data path", async () => {
    const client = makeRecordingClient();

    await resetDevelopmentData(client, "cinatra", /* purgeAppData */ false);

    // The auth-table drop is the (only) statement on the keep-app-data path.
    const dropSql = client.queries.find((q) => /drop table if exists/i.test(q));
    expect(dropSql, "expected a `drop table if exists` statement").toBeTruthy();

    // Every Better Auth table — INCLUDING team + teamMember (the #70 omission) —
    // must appear, double-quoted, in the drop statement.
    for (const table of AUTH_TABLES) {
      expect(
        dropSql.includes(`"${table}"`),
        `reset must drop auth table "${table}" (missing it leaves a partial schema → un-bootable instance)`,
      ).toBe(true);
    }

    // And it must drop with CASCADE (FK dependency order is handled by cascade,
    // not by listing order).
    expect(/cascade/i.test(dropSql)).toBe(true);
  });

  it("the explicit #70 regressions team + teamMember are present", async () => {
    const client = makeRecordingClient();
    await resetDevelopmentData(client, "cinatra", false);
    const dropSql = client.queries.find((q) => /drop table if exists/i.test(q));
    expect(dropSql.includes('"team"')).toBe(true);
    expect(dropSql.includes('"teamMember"')).toBe(true);
  });

  it("purge-app-data path additionally drops the app schema", async () => {
    const client = makeRecordingClient();
    await resetDevelopmentData(client, "cinatra", /* purgeAppData */ true);
    expect(client.queries.some((q) => /drop schema if exists "cinatra" cascade/i.test(q))).toBe(true);
    // The auth-table drop still runs on the purge path.
    expect(client.queries.some((q) => /drop table if exists/i.test(q))).toBe(true);
  });
});
