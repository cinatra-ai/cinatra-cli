// cinatra-cli#95 — `agent import` local path + shared agent-template writer.
//
// Two layers of proof:
//
//   1. HERMETIC (always runs) — drive the shared `upsertAgentTemplate` writer
//      against a mock pg client and assert the exact regressions the bug
//      shipped: the `compiled_plan` parameter reaches pg as a JSON *string*
//      (never a JS array — the node-postgres array-literal `{…}` corruption),
//      the write targets CURRENT schema columns only (NO dropped `execution_mode`),
//      `package_name` (NOT NULL + UNIQUE) is always set, the template+version
//      write is wrapped in a transaction, and `version_number` is computed.
//
//   2. REAL BINARY E2E (skipIf no AGENTS_INSTALL_TEST_DB_URL) — create the real
//      agent_templates/agent_versions schema in an isolated pg schema (WITHOUT
//      an `execution_mode` column and WITH package_name NOT NULL, exactly
//      reproducing the failure conditions), seed a template whose compiled_plan
//      is a NON-EMPTY array, then SPAWN the actual `bin/cinatra.mjs agent export`
//      and `agent import` commands and assert the imported row's compiled_plan
//      JSON.parses back to the original array and a version row exists. This is
//      the acceptance gate: a unit assert alone is not acceptance.
//
//      Local run (verify-stack or any throwaway pg):
//        AGENTS_INSTALL_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:5699/cinatra \
//        CINATRA_REPO_ROOT=/path/to/cinatra \
//          npm test -- tests/agent-import-roundtrip.test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __test } from "../src/agents-install.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// ---------------------------------------------------------------------------
// 1. Hermetic — upsertAgentTemplate against a mock pg client
// ---------------------------------------------------------------------------

describe("upsertAgentTemplate — JSON encoding + current-schema contract (#95)", () => {
  /**
   * Mock pg client that dispatches responses by SQL shape and records every
   * call so the test can assert on the emitted SQL text + bound parameters.
   */
  function makeMockClient() {
    const calls = [];
    const client = {
      calls,
      query: vi.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (/to_regclass/.test(sql)) return { rows: [{ rel: "cinatra.agent_templates" }] };
        if (/information_schema\.columns/.test(sql)) return { rows: [{ column_name: "package_name" }] };
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
        if (/INSERT INTO .*agent_templates/s.test(sql)) return { rows: [{ id: "tmpl-uuid" }] };
        if (/INSERT INTO .*agent_versions/s.test(sql)) return { rows: [{ version_number: 1 }] };
        throw new Error(`mock: unexpected SQL: ${sql}`);
      }),
    };
    return client;
  }

  const COMPILED_PLAN = [
    { id: "step-1", kind: "http", url: "https://example.test/a" },
    { id: "step-2", kind: "transform", expr: "x + 1" },
  ];

  it("passes compiled_plan as a JSON string (not a JS array) and round-trips it", async () => {
    const client = makeMockClient();
    const result = await __test.upsertAgentTemplate(client, "cinatra", {
      name: "Roundtrip Agent",
      sourceNl: "do things",
      compiledPlan: COMPILED_PLAN, // raw JS array — the exact bug input
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      outputSchema: null,
      approvalPolicy: { steps: [] },
      packageName: "@cinatra-local/roundtrip-agent-abc",
      snapshot: { compiledPlan: COMPILED_PLAN, inputSchema: {}, taskSpec: null },
    });

    const insert = client.calls.find((c) => /INSERT INTO .*agent_templates/s.test(c.sql));
    expect(insert).toBeTruthy();
    // $5 = compiled_plan (1-indexed 5th param → params[4]).
    const compiledPlanParam = insert.params[4];
    expect(typeof compiledPlanParam).toBe("string"); // NOT a JS array
    expect(Array.isArray(compiledPlanParam)).toBe(false);
    expect(JSON.parse(compiledPlanParam)).toEqual(COMPILED_PLAN); // valid JSON, round-trips
    // $6 = input_schema, $8 = approval_policy — both JSON strings.
    expect(typeof insert.params[5]).toBe("string");
    expect(JSON.parse(insert.params[5])).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(typeof insert.params[7]).toBe("string");
    expect(JSON.parse(insert.params[7])).toEqual({ steps: [] });

    expect(result).toEqual({ templateId: "tmpl-uuid", versionId: expect.any(String), versionNumber: 1 });
  });

  it("writes CURRENT schema columns only (no execution_mode) and always sets package_name", async () => {
    const client = makeMockClient();
    await __test.upsertAgentTemplate(client, "cinatra", {
      name: "A",
      compiledPlan: COMPILED_PLAN,
      inputSchema: {},
      approvalPolicy: { steps: [] },
      packageName: "@cinatra-local/a-xyz",
      snapshot: {},
    });
    const insert = client.calls.find((c) => /INSERT INTO .*agent_templates/s.test(c.sql));
    expect(insert.sql).not.toMatch(/execution_mode/); // dropped column must never be referenced
    expect(insert.sql).toMatch(/package_name/);
    expect(insert.sql).toMatch(/ON CONFLICT \(package_name\)/); // atomic upsert, no racy SELECT
    // $11 = package_name (params[10]) — non-null.
    expect(insert.params[10]).toBe("@cinatra-local/a-xyz");
  });

  it("nullable output_schema/agent_dependencies become SQL NULL, not the string 'null'", async () => {
    const client = makeMockClient();
    await __test.upsertAgentTemplate(client, "cinatra", {
      name: "A",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: {},
      outputSchema: null,
      agentDependencies: null,
      packageName: "@cinatra-local/a-1",
      snapshot: {},
    });
    const insert = client.calls.find((c) => /INSERT INTO .*agent_templates/s.test(c.sql));
    expect(insert.params[6]).toBeNull(); // $7 output_schema
    expect(insert.params[12]).toBeNull(); // $13 agent_dependencies
  });

  it("wraps the template + version writes in a transaction (BEGIN…COMMIT)", async () => {
    const client = makeMockClient();
    await __test.upsertAgentTemplate(client, "cinatra", {
      name: "A",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: {},
      packageName: "@cinatra-local/a-2",
      snapshot: {},
    });
    const order = client.calls.map((c) => c.sql.trim());
    const beginIdx = order.findIndex((s) => /^BEGIN$/i.test(s));
    const commitIdx = order.findIndex((s) => /^COMMIT$/i.test(s));
    const tmplIdx = order.findIndex((s) => /INSERT INTO .*agent_templates/s.test(s));
    const verIdx = order.findIndex((s) => /INSERT INTO .*agent_versions/s.test(s));
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    expect(tmplIdx).toBeGreaterThan(beginIdx);
    expect(tmplIdx).toBeLessThan(commitIdx);
    expect(verIdx).toBeGreaterThan(tmplIdx);
    expect(verIdx).toBeLessThan(commitIdx);
    // version numbering is computed, not hard-coded
    const ver = client.calls.find((c) => /INSERT INTO .*agent_versions/s.test(c.sql));
    expect(ver.sql).toMatch(/COALESCE\(MAX\(version_number\), 0\) \+ 1/);
  });

  it("ROLLBACKs and rethrows when a write fails inside the transaction", async () => {
    const client = makeMockClient();
    // Make the version insert throw to exercise the rollback path.
    client.query.mockImplementation(async (sql) => {
      client.calls.push({ sql });
      if (/to_regclass/.test(sql)) return { rows: [{ rel: "cinatra.agent_templates" }] };
      if (/information_schema\.columns/.test(sql)) return { rows: [{ column_name: "package_name" }] };
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
      if (/INSERT INTO .*agent_templates/s.test(sql)) return { rows: [{ id: "t" }] };
      if (/INSERT INTO .*agent_versions/s.test(sql)) throw new Error("boom");
      throw new Error(`unexpected: ${sql}`);
    });
    await expect(
      __test.upsertAgentTemplate(client, "cinatra", {
        name: "A", compiledPlan: [], inputSchema: {}, approvalPolicy: {},
        packageName: "@cinatra-local/a-3", snapshot: {},
      }),
    ).rejects.toThrow(/boom/);
    expect(client.calls.some((c) => /^\s*ROLLBACK\s*$/i.test(c.sql))).toBe(true);
  });

  it("quotes the schema identifier (no raw interpolation)", async () => {
    const client = makeMockClient();
    await __test.upsertAgentTemplate(client, 'weird"schema', {
      name: "A", compiledPlan: [], inputSchema: {}, approvalPolicy: {},
      packageName: "@cinatra-local/a-4", snapshot: {},
    });
    const insert = client.calls.find((c) => /INSERT INTO .*agent_templates/s.test(c.sql));
    // embedded quote doubled, wrapped in double quotes → cannot break out.
    expect(insert.sql).toMatch(/"weird""schema"\.agent_templates/);
  });
});

// ---------------------------------------------------------------------------
// 2. Real-binary export→import round-trip against a real schema
// ---------------------------------------------------------------------------

const E2E_DB = process.env.AGENTS_INSTALL_TEST_DB_URL;
// A real cinatra checkout is required only so getRepoRoot() resolves; the DB
// coordinates come entirely from env (process.env wins in collectEnvironment).
const CINATRA_ROOT = process.env.CINATRA_REPO_ROOT;

describe.skipIf(!E2E_DB || !CINATRA_ROOT)(
  "agent export → import round-trip (real bin/cinatra.mjs + real schema) (#95)",
  () => {
    let pg;
    let client;
    let tmpDir;
    const SCHEMA = `agent_import_e2e_${Math.random().toString(36).slice(2, 10)}`;
    const SEED_ID = "11111111-1111-4111-8111-111111111111";
    const SEED_PLAN = [
      { id: "start", kind: "start", next: "fetch" },
      { id: "fetch", kind: "http", url: "https://example.test/data", next: "done" },
      { id: "done", kind: "end" },
    ];

    beforeAll(async () => {
      ({ default: pg } = await import("pg"));
      client = new pg.Client({ connectionString: E2E_DB });
      await client.connect();
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.query(`CREATE SCHEMA ${SCHEMA}`);
      // Faithful subset of the app schema: NO execution_mode column, package_name
      // NOT NULL + UNIQUE (so a regression to the old INSERT fails outright).
      await client.query(`
        CREATE TABLE ${SCHEMA}.agent_templates (
          id text PRIMARY KEY,
          org_id text, owner_level text, owner_id text, first_run_at timestamptz, creator_id text,
          name text NOT NULL,
          description text,
          source_nl text NOT NULL,
          compiled_plan text NOT NULL,
          input_schema text NOT NULL,
          output_schema text,
          approval_policy text NOT NULL,
          status text NOT NULL DEFAULT 'draft',
          type text NOT NULL DEFAULT 'leaf',
          task_spec text,
          package_name text NOT NULL,
          package_version text,
          agent_dependencies text,
          lg_graph_code text, lg_graph_id text,
          hitl_required boolean NOT NULL DEFAULT false,
          execution_provider text NOT NULL DEFAULT 'wayflow',
          source_type text NOT NULL DEFAULT 'internal',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX agent_templates_package_name_idx ON ${SCHEMA}.agent_templates (package_name)`,
      );
      await client.query(`
        CREATE TABLE ${SCHEMA}.agent_versions (
          id text PRIMARY KEY,
          template_id text NOT NULL,
          version_number integer NOT NULL DEFAULT 1,
          content_hash text NOT NULL,
          snapshot text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      // Seed a template whose compiled_plan is a NON-EMPTY JSON array.
      await client.query(
        `INSERT INTO ${SCHEMA}.agent_templates
           (id, name, source_nl, compiled_plan, input_schema, approval_policy, package_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [SEED_ID, "Roundtrip Agent", "do the thing", JSON.stringify(SEED_PLAN), "{}",
          JSON.stringify({ steps: [] }), "@cinatra-ai/roundtrip-seed-agent"],
      );
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "cli95-e2e-"));
    });

    afterAll(async () => {
      if (client) {
        await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await client.end().catch(() => {});
      }
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    function runCli(args) {
      return spawnSync(process.execPath, [BIN, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          CINATRA_REPO_ROOT: CINATRA_ROOT,
          SUPABASE_DB_URL: E2E_DB,
          SUPABASE_SCHEMA: SCHEMA,
        },
      });
    }

    it("exports the seeded agent then imports it, preserving a valid-JSON compiled_plan", async () => {
      const zipPath = path.join(tmpDir, "roundtrip.zip");

      const exp = runCli(["agent", "export", SEED_ID, "--file", zipPath]);
      expect(exp.stderr + exp.stdout, "export must succeed").toMatch(/Exported agent/);
      expect(exp.status, `export exit (stderr: ${exp.stderr})`).toBe(0);

      const imp = runCli(["agent", "import", zipPath]);
      expect(imp.status, `import exit (stderr: ${imp.stderr})`).toBe(0);
      expect(imp.stdout, "import must report a new ID").toMatch(/Imported agent .* → ID:/);

      // The imported (authored) row lives under the reserved local scope.
      const rows = (await client.query(
        `SELECT id, name, compiled_plan, package_name, status
           FROM ${SCHEMA}.agent_templates
          WHERE package_name LIKE '@cinatra-local/%'`,
      )).rows;
      expect(rows.length).toBe(1);
      const imported = rows[0];

      // The core bug: compiled_plan must be valid JSON that round-trips to the
      // original non-empty array (never a Postgres array literal `{…}`).
      expect(() => JSON.parse(imported.compiled_plan)).not.toThrow();
      expect(JSON.parse(imported.compiled_plan)).toEqual(SEED_PLAN);
      expect(imported.package_name).toMatch(/^@cinatra-local\/roundtrip-agent-/);
      expect(imported.status).toBe("draft");

      // A version snapshot row was created with a computed version_number.
      const versions = (await client.query(
        `SELECT version_number, snapshot FROM ${SCHEMA}.agent_versions WHERE template_id = $1`,
        [imported.id],
      )).rows;
      expect(versions.length).toBe(1);
      expect(versions[0].version_number).toBe(1);
      expect(JSON.parse(versions[0].snapshot).compiledPlan).toEqual(SEED_PLAN);
    });
  },
);
