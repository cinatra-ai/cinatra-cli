// A REAL in-process MCP peer for the CLI's marketplace path (cinatra#2218, CLI leg).
//
// PROOF CLASS: real-library loopback. The peers run the real
// `@modelcontextprotocol/server@2.0.0` over real HTTP on 127.0.0.1, and every
// frame the CLI puts on the wire is recorded by the front end before the peer
// sees it. Nothing about the negotiated era is asserted from a package version —
// it is read off the wire.
//
// WHAT THIS CANNOT COVER, stated rather than implied: both ends are the
// reference TypeScript implementation, so it pins the CLI's SIDE of the
// exchange against a conformant peer in each era. The real marketplace peer is
// a WordPress plugin (wordpress/mcp-adapter) written against a different stack;
// evidence about THAT implementation comes from the live probe in
// `marketplace-wire-negotiation.manual.test.mjs`, not from here. The
// `legacyOnly` peer below is modelled on the live peer's OBSERVED behaviour
// (it refuses a `server/discover` probe with HTTP 400 / -32600 and requires a
// session), so the two together cover both what we can run in CI and what the
// real peer actually does.

import http from "node:http";

import { McpServer, WebStandardStreamableHTTPServerTransport, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";

/** The ability the CLI's `extensions submit` path calls, in its wire form. */
export const SUBMIT_TOOL = "cinatra-extension-submit-for-review";

/**
 * Build the peer's tool surface. The handler echoes a marketplace-shaped
 * `structuredContent` payload so the CLI's parse path is exercised for real.
 *
 * NOTE the local is named `srv`, never `server` — matching the sibling repo's
 * guard against a test fixture being picked up by primitive-inventory scanners.
 */
function buildPeer({ toolResult, isError = false } = {}) {
  const srv = new McpServer({ name: "Cinatra Marketplace (test peer)", version: "0.0.1" });
  srv.registerTool(
    SUBMIT_TOOL,
    {
      title: SUBMIT_TOOL,
      description: "test double for cinatra/extension-submit-for-review",
      inputSchema: {},
    },
    async () => {
      if (isError) {
        return { isError: true, content: [{ type: "text", text: "vendor not approved" }] };
      }
      // A FIXED marketplace-shaped answer rather than an echo of the arguments.
      // The peer declares an empty input schema, so the server strips unknown
      // properties before the handler sees them — an echo would silently assert
      // the peer's defaults instead of what the CLI sent. What the CLI actually
      // put on the wire is asserted from the recorded frame body, which is the
      // stronger evidence anyway.
      return {
        content: [{ type: "text", text: JSON.stringify({ echoed: false }) }],
        structuredContent:
          toolResult ?? {
            submission_id: "sub_123",
            target_final_identity: "@acme/widget@1.2.3",
            status: "pending",
          },
      };
    },
  );
  return srv;
}

/** A peer that implements 2026-07-28 and keeps the 2025-era leg available. */
async function modernPeerHandler(request, opts) {
  const handler = createMcpHandler(() => buildPeer(opts), { legacy: "stateless" });
  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;
  const response = await handler.fetch(request, { parsedBody });
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await handler.close().catch(() => undefined);
  }
  return response;
}

/**
 * A peer that speaks the 2025 era ONLY: modern-classified traffic — including
 * the `server/discover` probe — is refused with the same shape the LIVE
 * marketplace peer was measured to return (HTTP 400 / JSON-RPC -32600). This is
 * what forces the client's legacy fallback.
 */
async function legacyOnlyPeerHandler(request, opts) {
  const srv = buildPeer(opts);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await srv.connect(transport);

  const parsedBody =
    request.method === "POST" ? await request.clone().json().catch(() => undefined) : undefined;

  let legacy = false;
  try {
    legacy = await isLegacyRequest(request, parsedBody);
  } catch {
    legacy = false;
  }
  if (!legacy) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: Missing Mcp-Session-Id header" },
      },
      { status: 400 },
    );
  }
  if (request.method.toUpperCase() !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
      { status: 405 },
    );
  }
  return transport.handleRequest(request, { parsedBody });
}

/**
 * Start a recording HTTP front end serving the marketplace MCP route.
 *
 * @param {object} [options]
 * @param {"modern"|"legacyOnly"} [options.era]   which peer class to serve
 * @param {object}  [options.toolResult]          structuredContent to return
 * @param {boolean} [options.isError]             return an `isError` tool result
 * @returns {Promise<{ baseUrl: string, frames: object[], close: () => Promise<void> }>}
 */
export async function startMarketplacePeer(options = {}) {
  const { era = "legacyOnly", ...peerOpts } = options;
  const frames = [];

  const listener = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");

    const requestHeaders = {};
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== "string") continue;
      requestHeaders[key.toLowerCase()] = value;
      headers.set(key, value);
    }

    let rpcMethod = "";
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && !Array.isArray(parsed) && typeof parsed.method === "string") {
        rpcMethod = parsed.method;
      }
    } catch {
      // GET / non-JSON — leave blank.
    }

    const url = `http://127.0.0.1:${listener.address().port}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyText,
    });

    const handle = era === "modern" ? modernPeerHandler : legacyOnlyPeerHandler;
    let response;
    try {
      response = await handle(request, peerOpts);
    } catch (err) {
      response = Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err?.message ?? err) } },
        { status: 500 },
      );
    }

    frames.push({
      method: req.method,
      path: req.url,
      status: response.status,
      requestHeaders,
      body: bodyText,
      rpcMethod,
    });

    const text = await response.text();
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(text);
  });

  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;

  return {
    baseUrl,
    frames,
    close: () => new Promise((resolve) => listener.close(resolve)),
  };
}
