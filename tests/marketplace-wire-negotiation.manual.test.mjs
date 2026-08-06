// LIVE wire probe of the real Cinatra Marketplace MCP peer (cinatra#2218, CLI leg).
//
// PROOF CLASS: live wire, against the production marketplace. Anonymous and
// NON-MUTATING — it opens a connection and reads the negotiated era, and never
// calls a tool, never sends a bearer, and never writes anything.
//
// GATED, and deliberately so: the sibling `marketplace-mcp-negotiation.test.mjs`
// is the always-on proof, because CI must not depend on a third-party host being
// reachable. Run this one by hand, or in a job that accepts network egress:
//
//     RUN_MARKETPLACE_WIRE_PROOF=1 npx vitest run tests/marketplace-wire-negotiation.manual.test.mjs
//
// WHEN THIS SUITE STARTS FAILING, THAT IS THE SIGNAL, NOT A BREAKAGE: it means
// the marketplace adapter began answering the `server/discover` probe, so the
// surface has moved to the modern revision on its own and the supported-revisions
// contract row should follow. `{ mode: 'auto' }` needs NO code change to take
// advantage of that — which is exactly why this surface is on `auto` rather than
// on an explicit `legacy` that would have to be noticed and flipped by hand.

import { describe, it, expect } from "vitest";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { MARKETPLACE_BASE_URL, MARKETPLACE_VERSION_NEGOTIATION } from "../src/marketplace-mcp.mjs";

const ENABLED = process.env.RUN_MARKETPLACE_WIRE_PROOF === "1";
const ENDPOINT = new URL(`${MARKETPLACE_BASE_URL}/wp-json/cinatra/mcp`);

/** Connect once through the real client, recording the frames it emitted. */
async function connectAndObserve(versionNegotiation) {
  const frames = [];
  const recordingFetch = async (input, init) => {
    const response = await fetch(input, init);
    let rpcMethod = "";
    try {
      const parsed = JSON.parse(String(init?.body ?? ""));
      if (parsed && typeof parsed.method === "string") rpcMethod = parsed.method;
    } catch {
      /* non-JSON frame */
    }
    frames.push({ method: init?.method ?? "GET", rpcMethod, status: response.status });
    return response;
  };

  const transport = new StreamableHTTPClientTransport(ENDPOINT, { fetch: recordingFetch });
  const client = new Client({ name: "cinatra-cli", version: "1.0.0" }, { versionNegotiation });
  try {
    await client.connect(transport);
    return {
      era: client.getProtocolEra(),
      revision: client.getNegotiatedProtocolVersion(),
      frames,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

describe.runIf(ENABLED)("LIVE: marketplace MCP peer negotiation", () => {
  it("the peer REFUSES a server/discover probe carrying the modern envelope", async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "probe-1",
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
  }, 30_000);

  it("negotiates the LEGACY era under the shipped { mode: 'auto' }, after a refused probe", async () => {
    const { era, revision, frames } = await connectAndObserve(MARKETPLACE_VERSION_NEGOTIATION);
    expect(era).toBe("legacy");
    // The SERVER selects this revision on initialize (the client offers 2025-11-25).
    expect(revision).toBe("2025-06-18");
    const probe = frames.find((f) => f.rpcMethod === "server/discover");
    expect(probe, "auto must ISSUE the probe").toBeDefined();
    expect(probe.status, "and today's peer must refuse it").toBe(400);
    expect(frames.some((f) => f.rpcMethod === "initialize")).toBe(true);
  }, 30_000);

  it("BARE STRING counterfactual: reaches the same era while issuing NO probe", async () => {
    // The trap, on the live wire rather than only in the source: a fully
    // working client whose era was never chosen. Identical outcome today —
    // which is precisely why it would go unnoticed until the peer moves.
    const { era, frames } = await connectAndObserve("auto");
    expect(era).toBe("legacy");
    expect(frames.some((f) => f.rpcMethod === "server/discover")).toBe(false);
  }, 30_000);
});
