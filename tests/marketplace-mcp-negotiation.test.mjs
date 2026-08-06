// Wire-level negotiation proof for the CLI's marketplace MCP path
// (cinatra#2218, CLI leg — the sixth v1 consumer).
//
// PROOF CLASS: real-library loopback, ungated (the peers are in-process, so
// there is no container and no network access to arrange). The module under
// test drives the real `@modelcontextprotocol/client@2.0.0` over real HTTP
// against a real `@modelcontextprotocol/server@2.0.0` peer, and the negotiated
// era is OBSERVED on the wire — never asserted from a package version.
//
// The live-peer evidence lives in `marketplace-wire-negotiation.manual.test.mjs`.

import { describe, it, expect, afterEach } from "vitest";

import { startMarketplacePeer } from "./helpers/marketplace-mcp-peer.mjs";
import {
  callMarketplaceTool,
  MARKETPLACE_VERSION_NEGOTIATION,
} from "../src/marketplace-mcp.mjs";

let peer;

afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

/** Frames the client actually emitted, in order, as `METHOD rpc -> status`. */
const summarize = (frames) =>
  frames.map((f) => `${f.method} ${f.rpcMethod || "(no-rpc)"} -> ${f.status}`);

describe("marketplace negotiation constant", () => {
  it("is an OPTIONS OBJECT with mode 'auto' — not a bare string", () => {
    // The bare-string trap: `versionNegotiation: "auto"` leaves `options?.mode`
    // undefined and the client silently selects the legacy era, producing a
    // fully working client that never negotiated. The sibling TypeScript
    // surfaces make that a compile error by typing the constant
    // `VersionNegotiationOptions`; this file is plain ESM, so the guard is the
    // module-load assertion plus this test.
    expect(typeof MARKETPLACE_VERSION_NEGOTIATION).toBe("object");
    expect(MARKETPLACE_VERSION_NEGOTIATION).not.toBeNull();
    expect(typeof MARKETPLACE_VERSION_NEGOTIATION).not.toBe("string");
    expect(MARKETPLACE_VERSION_NEGOTIATION.mode).toBe("auto");
    expect(MARKETPLACE_VERSION_NEGOTIATION.mode).not.toBe("legacy");
  });

  it("is frozen, so a later edit cannot mutate the shipped mode in place", () => {
    expect(Object.isFrozen(MARKETPLACE_VERSION_NEGOTIATION)).toBe(true);
  });
});

describe("callMarketplaceTool — negotiation observed on the wire", () => {
  it("reaches the MODERN era (2026-07-28) against a peer that answers the probe", async () => {
    peer = await startMarketplacePeer({ era: "modern" });

    const out = await callMarketplaceTool(
      "extension_submit_for_review",
      { namespace: "@acme", extension_name: "widget", version: "1.2.3" },
      { baseUrl: peer.baseUrl, token: "tok-modern" },
    );
    expect(out.submission_id).toBe("sub_123");

    // The probe was ISSUED and ACCEPTED: a server/discover frame reached the
    // peer and did not 400. This is the assertion the bare string would break.
    const discover = peer.frames.filter((f) => f.rpcMethod === "server/discover");
    expect(discover.length, summarize(peer.frames).join("\n")).toBeGreaterThan(0);
    expect(discover[0].status).toBe(200);

    // The modern era retires the initialize/initialized exchange entirely.
    expect(peer.frames.some((f) => f.rpcMethod === "initialize")).toBe(false);

    // Modern requests carry the revision + the required routing header.
    const call = peer.frames.find((f) => f.rpcMethod === "tools/call");
    expect(call.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");
    expect(call.requestHeaders["mcp-method"]).toBe("tools/call");
  });

  it("falls back to the LEGACY era against a 2025-era-only peer, after a refused probe", async () => {
    peer = await startMarketplacePeer({ era: "legacyOnly" });

    const out = await callMarketplaceTool(
      "extension_submit_for_review",
      { namespace: "@acme", extension_name: "widget", version: "1.2.3" },
      { baseUrl: peer.baseUrl, token: "tok-legacy" },
    );
    expect(out.submission_id).toBe("sub_123");

    // The probe was issued and REFUSED — that refusal is a legacy verdict, not
    // a failure. This is the shape the live marketplace peer returns today.
    const discover = peer.frames.filter((f) => f.rpcMethod === "server/discover");
    expect(discover.length, summarize(peer.frames).join("\n")).toBe(1);
    expect(discover[0].status).toBe(400);

    // ...and then the 2025-era handshake ran and the call succeeded.
    expect(peer.frames.some((f) => f.rpcMethod === "initialize")).toBe(true);
    const call = peer.frames.find((f) => f.rpcMethod === "tools/call");
    expect(call.status).toBe(200);
  });

  it("COUNTERFACTUAL: a bare-string mode issues no probe at all", async () => {
    // Reproduces the trap directly against the same peer, so the guard above is
    // shown to be load-bearing rather than decorative. Driven through the raw
    // client because the module under test cannot express the broken form.
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    peer = await startMarketplacePeer({ era: "modern" });

    for (const [label, versionNegotiation, expectProbe] of [
      ["bare string", "auto", false],
      ["options object", { mode: "auto" }, true],
    ]) {
      const before = peer.frames.length;
      const transport = new StreamableHTTPClientTransport(
        new URL(`${peer.baseUrl}/wp-json/cinatra/mcp`),
      );
      const client = new Client({ name: "cinatra-cli", version: "1.0.0" }, { versionNegotiation });
      await client.connect(transport);
      const era = client.getProtocolEra();
      await client.close().catch(() => {});

      const issued = peer.frames
        .slice(before)
        .some((f) => f.rpcMethod === "server/discover");
      expect(issued, `${label}: probe issued?`).toBe(expectProbe);
      expect(era, `${label}: negotiated era`).toBe(expectProbe ? "modern" : "legacy");
    }
  });
});

describe("callMarketplaceTool — behaviour parity across the v1 -> v2 move", () => {
  it("sends the Authorization header on EVERY frame (requestInit.headers survives v2)", async () => {
    // v2 composes `requestInit.headers` LAST into the transport's own header
    // set. Auth is the whole point of this surface, so it is proven on the wire
    // rather than read off the v2 source.
    peer = await startMarketplacePeer({ era: "legacyOnly" });
    await callMarketplaceTool(
      "extension_submit_for_review",
      {},
      { baseUrl: peer.baseUrl, token: "raw-token" },
    );
    expect(peer.frames.length).toBeGreaterThan(0);
    for (const frame of peer.frames) {
      expect(frame.requestHeaders.authorization, `frame ${frame.rpcMethod}`).toBe("Bearer raw-token");
    }
  });

  it("passes a schemed token through unchanged on EVERY frame (WP app passwords are Basic)", async () => {
    peer = await startMarketplacePeer({ era: "legacyOnly" });
    await callMarketplaceTool(
      "extension_submit_for_review",
      {},
      { baseUrl: peer.baseUrl, token: "Basic abc==" },
    );
    expect(peer.frames.length).toBeGreaterThan(1);
    for (const frame of peer.frames) {
      expect(frame.requestHeaders.authorization, `frame ${frame.rpcMethod}`).toBe("Basic abc==");
    }
  });

  it("preserves the tool-level error message verbatim", async () => {
    peer = await startMarketplacePeer({ era: "legacyOnly", isError: true });
    const err = await callMarketplaceTool(
      "extension_submit_for_review",
      {},
      { baseUrl: peer.baseUrl, token: "t" },
    ).catch((e) => e);
    // EXACT equality, not containment — "verbatim" is the claim, so a v2 error
    // prefix creeping back into this message must fail here.
    expect(err.message).toBe(
      "Marketplace extension_submit_for_review returned an error: vendor not approved",
    );
  });

  it("an unreachable peer still surfaces the underlying cause in the message", async () => {
    // Under `{ mode: 'auto' }` the probe fails first, so v2 raises
    // SdkError(ERA_NEGOTIATION_FAILED) where v1 raised a bare TypeError. The
    // operator-visible text is the whole contract here (bin/cinatra.mjs prints
    // `error.message`), so assert the v1 text is still CONTAINED in it rather
    // than replaced by a protocol-sounding message with the cause hidden.
    await expect(
      callMarketplaceTool(
        "extension_submit_for_review",
        {},
        { baseUrl: "http://127.0.0.1:1", token: "t" },
      ),
    ).rejects.toThrow(/fetch failed/);
  });
});
