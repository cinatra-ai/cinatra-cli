// Marketplace MCP call helper for the CLI. Mirrors the TS http-client
// pattern (StreamableHTTPClientTransport, `cinatra-<kebab>` tool names,
// structuredContent-preferred parse) but stays in .mjs because the CLI is
// plain Node ESM with no TS loader.
//
// Brand wording: prose says "Cinatra"; `cinatra-ai` only for the npm scope
// / GitHub org. The Marketplace base URL is hardcoded; an env override is
// honored only outside production.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";
const MCP_ROUTE = "/wp-json/cinatra/mcp";

// ---------------------------------------------------------------------------
// Protocol-revision negotiation (cinatra#2218, CLI leg).
//
// `{ mode: "auto" }`: probe for the modern revision with `server/discover`,
// fall back to the 2025-era `initialize` handshake when the peer refuses.
//
// Measured on the LIVE wire 2026-08-06, anonymously and non-mutatingly, driven
// through this module's own client identity against the real marketplace peer
// (the wordpress/mcp-adapter at `/wp-json/cinatra/mcp`, `serverInfo` =
// "Cinatra Marketplace"). One connect cycle:
//
//   mode                 era     revision     HTTP frames
//   -------------------  ------  -----------  ---------------------------------
//   { mode: "auto" }     legacy  2025-06-18   3 (probe refused 400, then
//                                                initialize + initialized)
//   { mode: "legacy" }   legacy  2025-06-18   2
//   "auto" (bare string) legacy  2025-06-18   2 — NO PROBE ISSUED AT ALL
//
// So the peer does not implement 2026-07-28 today: it answers a `server/discover`
// probe carrying the modern `_meta` envelope HTTP 400 / -32600 "Invalid Request:
// Missing Mcp-Session-Id header", and on `initialize` the SERVER selects
// 2025-06-18. `auto` therefore reaches the identical era today at the cost of
// one refused round trip, and this helper reconnects per call.
//
// It is still the right setting, and the reason is the peer rather than the
// price. The supported-revisions contract scopes its explicit-`legacy` exception
// to a peer that is KNOWN 2025-era AND PINNED (the graphiti image, whose posture
// cannot move without a visible docker-compose pin bump). This peer is an
// independently-operated hosted service — it can gain 2026-07-28, or drop the
// 2025-era `initialize`, with no change in this repo and no signal that would
// prompt one. `auto` costs one refused round trip if it never moves and breaks
// nothing if it does; `legacy` would break outright with nothing to trigger a flip.
//
// THE BARE-STRING TRAP (row 3 above, observed on the wire rather than only read
// from the source): `versionNegotiation` is an options OBJECT whose default mode
// is `legacy`. Written as a bare string the client reads `options?.mode` as
// `undefined` and silently selects legacy — a fully working client that never
// negotiated. The sibling TS surfaces make that a compile error by typing the
// constant `VersionNegotiationOptions`; this file is plain Node ESM with no TS
// loader, so the equivalent guard has to be a RUNTIME one — see the assertion
// below, which runs at module load, plus the tests that assert the object
// reaches the `Client` constructor with `mode === "auto"`.
//
// The peer's session id is peer-required, stays client-library-managed and
// transport-private, and is never read, persisted, routed or authorized on
// (cinatra#2218 AC4).
// ---------------------------------------------------------------------------
/** @type {import("@modelcontextprotocol/client").VersionNegotiationOptions} */
export const MARKETPLACE_VERSION_NEGOTIATION = Object.freeze({ mode: "auto" });

// Runtime stand-in for the TS compile error the sibling surfaces get. A bare
// string (or any object without an explicit mode) would negotiate nothing while
// still "working", so fail loudly at import rather than silently on the wire.
if (
  typeof MARKETPLACE_VERSION_NEGOTIATION !== "object" ||
  MARKETPLACE_VERSION_NEGOTIATION === null ||
  MARKETPLACE_VERSION_NEGOTIATION.mode !== "auto"
) {
  throw new Error(
    "marketplace-mcp: versionNegotiation must be the options OBJECT { mode: \"auto\" } — " +
      "a bare string leaves `mode` undefined and silently selects the legacy era.",
  );
}

export function resolveMarketplaceBaseUrl(override) {
  if (process.env.NODE_ENV !== "production") {
    const candidate = (override ?? process.env.MARKETPLACE_BASE_URL ?? "").trim();
    if (candidate) {
      return candidate.replace(/\/+$/, "");
    }
  }
  return MARKETPLACE_BASE_URL;
}

function authHeaders(token) {
  if (!token) return {};
  const value = /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}`;
  return { Authorization: value };
}

function extractText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return null;
  const textItem = content.find((c) => c.type === "text");
  return textItem && typeof textItem.text === "string" ? textItem.text : null;
}

/**
 * Build the MCP tool name from an extender ability snake_case key.
 *
 * The WP ability id is `cinatra/<kebab>`, but MCP tool names cannot contain a
 * `/`, so the WordPress mcp-adapter exposes them with the namespace separator
 * flattened to a dash: `cinatra-<kebab>`. Match the exposed name exactly, or
 * tool calls fail with "Tool not found: cinatra/<kebab>".
 */
function mcpToolName(abilityKey) {
  return `cinatra-${abilityKey.replace(/_/g, "-")}`;
}

/**
 * Connect to the marketplace MCP, call one tool, parse + return the result,
 * close the client. Throws on tool-level errors (with the marketplace's error
 * text included).
 *
 * ERROR SURFACE (cinatra#2218 CLI leg). This module classifies nothing: its own
 * four failure messages below are verbatim-preserved across the v1 -> v2 move,
 * and every other failure propagates as the client library raised it. The sole
 * consumer, `runExtensionsSubmit`, does not catch, and `bin/cinatra.mjs` prints
 * `error.message` and exits non-zero — so the message TEXT is the whole contract
 * (no CLI code branches on an SDK error class, a `.code`, or a message prefix;
 * audited repo-wide).
 *
 * Two measured v1 -> v2 text deltas, both non-breaking here:
 *   * v2 drops v1's "Streamable HTTP error: " / "MCP error <code>: " message
 *     prefixes. Nothing in this CLI parsed them.
 *   * Under `{ mode: "auto" }` an unreachable peer surfaces as
 *     `SdkError(ERA_NEGOTIATION_FAILED)` rather than a bare `TypeError`, because
 *     the `server/discover` probe fails first and the negotiator wraps it.
 *     Measured against a closed port, the v2 message STRICTLY CONTAINS the v1
 *     one — "Version negotiation probe failed: fetch failed" vs "fetch failed" —
 *     and the original error is preserved on `.data.cause`, so no cause is
 *     hidden from the operator and nothing needs unwrapping.
 */
export async function callMarketplaceTool(abilityKey, args, opts = {}) {
  const baseUrl = resolveMarketplaceBaseUrl(opts.baseUrl);
  // Token precedence: an explicit vendor token (e.g. from publish automation)
  // wins, falling back to the instance principal token for local/manual use.
  // CINATRA_MARKETPLACE_VENDOR_TOKEN is the vendor token;
  // a developer's shell may still export MARKETPLACE_INSTANCE_TOKEN.
  const token =
    opts.token ??
    process.env.CINATRA_MARKETPLACE_VENDOR_TOKEN ??
    process.env.MARKETPLACE_INSTANCE_TOKEN;
  if (!token) {
    throw new Error(
      "No marketplace token set. Export CINATRA_MARKETPLACE_VENDOR_TOKEN (CI vendor token) " +
        "or MARKETPLACE_INSTANCE_TOKEN (local) before submitting to the marketplace.",
    );
  }

  const endpoint = new URL(baseUrl + MCP_ROUTE);
  // `requestInit.headers` is merged LAST into the transport's computed header
  // set on v2 (`_commonHeaders()`), so the Authorization header survives every
  // frame — verified on the wire by the tests, not assumed from the v1 shape.
  // Note `requestInit.signal` would be INERT here (the transport overwrites it);
  // a deadline on this surface belongs on the transport `fetch` option or on
  // `connect(transport, { timeout })`. This helper sets neither, as before.
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: authHeaders(token) },
  });
  const client = new Client(
    { name: "cinatra-cli", version: "1.0.0" },
    { versionNegotiation: MARKETPLACE_VERSION_NEGOTIATION },
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: mcpToolName(abilityKey), arguments: args });
    if (result?.isError) {
      const text = extractText(result) ?? "unknown error";
      throw new Error(`Marketplace ${abilityKey} returned an error: ${text}`);
    }
    if (result?.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = extractText(result);
    if (text != null) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Marketplace ${abilityKey}: response was not JSON.`);
      }
    }
    throw new Error(`Marketplace ${abilityKey}: empty response.`);
  } finally {
    await client.close().catch(() => {});
  }
}
