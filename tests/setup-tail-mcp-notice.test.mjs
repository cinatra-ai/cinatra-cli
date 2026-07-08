// cinatra-cli#104 — the setup tail must render the "creds provisioned but no
// public MCP URL (Tailscale unconfigured)" gap as a single actionable NOTICE,
// NOT a ✗ FAIL that reads as a broken setup. The STANDALONE `cinatra doctor`
// must keep FAILing on the same gap (it is the authoritative post-boot gate),
// and the assertion verdict must stay "fail" so the standalone exit code is
// unchanged.
//
// Hermetic: a mock pg client + captured console output. No DB, no app, no docker.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  doctorAssertLlmMcpAccess,
  printDoctorReport,
  LLM_MCP_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
} from "../src/index.mjs";

const SCHEMA = "cinatra";
const LLM_KEY = LLM_MCP_SETTINGS_KEY;
const MCP_KEY = MCP_SETTINGS_KEY;

function createMetadataClient(store = {}) {
  return {
    async query(text, params) {
      const sql = String(text);
      if (/select value from .*\.metadata where key/i.test(sql)) {
        const key = params?.[0];
        const value = store[key];
        return {
          rows: value === undefined ? [] : [{ value: JSON.stringify(value) }],
          rowCount: value === undefined ? 0 : 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const provisionedLlm = () => ({
  providers: { openai: { clientId: "cinatra-llm-openai", clientSecret: "x", scope: "mcp:connect" } },
});
const publicUrlRow = () => ({ publicBaseUrl: "https://node.example.ts.net", publicBaseUrlSource: "tailscale-auto" });

// Build a { assertions, counts } report from a list of assertions.
function toReport(assertions) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const a of assertions) counts[a.verdict] += 1;
  return { assertions, counts };
}

function captureLog(fn) {
  const lines = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

afterEach(() => vi.restoreAllMocks());

// =========================================================================
// tailNotice attachment on the llm-mcp-access assertion
// =========================================================================
describe("doctorAssertLlmMcpAccess — tailNotice (cinatra-cli#104)", () => {
  it("attaches a Tailscale tunnel NOTICE when creds present but NO public URL", async () => {
    const client = createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: {} });
    const { assertion } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    // verdict stays "fail" — standalone doctor + its exit code are unchanged.
    expect(assertion.verdict).toBe("fail");
    expect(assertion.tailNotice).toBeTruthy();
    expect(assertion.tailNotice.hint).toMatch(/cinatra instance tunnel start/);
    expect(assertion.tailNotice.detail).toMatch(/provisioned/i);
  });

  it("does NOT attach a tailNotice when creds AND public URL are present (pass)", async () => {
    const client = createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: publicUrlRow() });
    const { assertion } = await doctorAssertLlmMcpAccess(client, SCHEMA);
    expect(assertion.verdict).toBe("pass");
    expect(assertion.tailNotice).toBeUndefined();
  });

  it("does NOT attach a tailNotice when creds are MISSING (a genuine gap, stays a FAIL)", async () => {
    // creds missing, url present
    const c1 = createMetadataClient({ [LLM_KEY]: {}, [MCP_KEY]: publicUrlRow() });
    expect((await doctorAssertLlmMcpAccess(c1, SCHEMA)).assertion.tailNotice).toBeUndefined();
    // neither present
    const c2 = createMetadataClient({ [LLM_KEY]: {}, [MCP_KEY]: {} });
    expect((await doctorAssertLlmMcpAccess(c2, SCHEMA)).assertion.tailNotice).toBeUndefined();
  });
});

// =========================================================================
// printDoctorReport — tail vs standalone rendering of the notice-carrying fail
// =========================================================================
describe("printDoctorReport — tail NOTICE vs standalone FAIL (cinatra-cli#104)", () => {
  async function llmNoUrlAssertion() {
    const client = createMetadataClient({ [LLM_KEY]: provisionedLlm(), [MCP_KEY]: {} });
    return (await doctorAssertLlmMcpAccess(client, SCHEMA)).assertion;
  }

  it("tail mode: renders an actionable ℹ NOTICE, not a ✗ FAIL, and reads as complete", async () => {
    const report = toReport([
      await llmNoUrlAssertion(),
      { id: "public-reachability", label: "Public reachability", verdict: "skip", detail: "no public MCP URL configured", remediation: null },
      { id: "dev-apps-presence", label: "Dev apps", verdict: "pass", detail: "present", remediation: null },
    ]);
    const out = captureLog(() => printDoctorReport(report, { mode: "tail" }));

    // NOTICE line names the fix command; NOT a FAIL for llm-mcp-access.
    expect(out).toMatch(/ℹ \[NOTICE\].*cinatra instance tunnel start|ℹ \[NOTICE\]/);
    expect(out).toMatch(/cinatra instance tunnel start/);
    expect(out).not.toMatch(/✗ \[FAIL\] LLM MCP access/);
    // Summary: the notice is NOT counted as a fail; it reads as a completed setup.
    expect(out).toMatch(/0 fail/);
    expect(out).toMatch(/1 notice/);
  });

  it("standalone mode: the SAME assertion still renders a ✗ FAIL and counts as a fail", async () => {
    const report = toReport([
      await llmNoUrlAssertion(),
      { id: "dev-apps-presence", label: "Dev apps", verdict: "pass", detail: "present", remediation: null },
    ]);
    const out = captureLog(() => printDoctorReport(report, { mode: "standalone" }));

    expect(out).toMatch(/✗ \[FAIL\] LLM MCP access/);
    expect(out).not.toMatch(/\[NOTICE\]/);
    expect(out).toMatch(/1 fail/);
    expect(out).not.toMatch(/notice/);
  });
});
