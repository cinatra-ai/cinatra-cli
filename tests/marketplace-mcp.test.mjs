// Tests for the CLI's marketplace MCP helper.
// The client is mocked via vi.mock so we can assert WIRING without a live
// server. The wire BEHAVIOUR (negotiated era, headers on the wire) is proven
// against real peers in `marketplace-mcp-negotiation.test.mjs` and, for the real
// hosted peer, in `marketplace-wire-negotiation.manual.test.mjs`.

import { afterEach, describe, expect, it, vi } from "vitest";

const { connectMock, callToolMock, closeMock, transportCtor, clientCtor } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  callToolMock: vi.fn(),
  closeMock: vi.fn().mockResolvedValue(undefined),
  transportCtor: vi.fn(),
  clientCtor: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client", () => ({
  Client: vi.fn(function (info, options) {
    clientCtor(info, options);
    this.connect = connectMock;
    this.callTool = callToolMock;
    this.close = closeMock;
  }),
  StreamableHTTPClientTransport: vi.fn(function (url, opts) {
    transportCtor(url, opts);
  }),
}));

const {
  callMarketplaceTool,
  resolveMarketplaceBaseUrl,
  MARKETPLACE_BASE_URL,
  MARKETPLACE_VERSION_NEGOTIATION,
} = await import("../src/marketplace-mcp.mjs");

describe("callMarketplaceTool", () => {
  afterEach(() => {
    connectMock.mockClear();
    callToolMock.mockReset();
    closeMock.mockClear();
    transportCtor.mockClear();
    clientCtor.mockClear();
    vi.unstubAllEnvs();
  });

  it("passes the negotiation OPTIONS OBJECT to the Client constructor", async () => {
    // The bare-string trap (cinatra#2218): `versionNegotiation: "auto"` leaves
    // `options?.mode` undefined and the client silently selects legacy — a
    // working client that never negotiated. Assert the OBJECT arrives, with the
    // mode explicitly set, at the exact seam that decides it.
    callToolMock.mockResolvedValue({ structuredContent: {} });
    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" });

    const [, options] = clientCtor.mock.calls[0];
    expect(options.versionNegotiation).toBe(MARKETPLACE_VERSION_NEGOTIATION);
    expect(typeof options.versionNegotiation).toBe("object");
    expect(typeof options.versionNegotiation).not.toBe("string");
    expect(options.versionNegotiation.mode).toBe("auto");
    expect(options.versionNegotiation.mode).not.toBe("legacy");
  });

  it("throws when no marketplace token is set", async () => {
    // The source resolves CINATRA_MARKETPLACE_VENDOR_TOKEN ?? MARKETPLACE_INSTANCE_TOKEN;
    // both must be unset for the no-token throw. (Updated from a stale assertion
    // that predated the dual-token message.)
    vi.stubEnv("CINATRA_MARKETPLACE_VENDOR_TOKEN", "");
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "");
    await expect(
      callMarketplaceTool("extension_submit_for_review", {}, { baseUrl: "https://mk.test" }),
    ).rejects.toThrow(/No marketplace token set/);
  });

  it("targets the MCP endpoint and uses cinatra-<kebab> tool naming", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { ok: true } });
    await callMarketplaceTool(
      "extension_submit_for_review",
      { namespace: "@acme" },
      { baseUrl: "https://mk.test", token: "tok-123" },
    );
    const [url] = transportCtor.mock.calls[0];
    expect(url.toString()).toBe("https://mk.test/wp-json/cinatra/mcp");
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submit-for-review",
      arguments: { namespace: "@acme" },
    });
  });

  it("sends a raw token as Bearer and passes a schemed token through unchanged", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });

    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "raw" });
    expect(transportCtor.mock.calls[0][1].requestInit.headers.Authorization).toBe("Bearer raw");

    transportCtor.mockClear();
    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "Basic abc==" });
    expect(transportCtor.mock.calls[0][1].requestInit.headers.Authorization).toBe("Basic abc==");
  });

  it("prefers structuredContent over text content", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { from: "structured" },
      content: [{ type: "text", text: '{"from":"wrong"}' }],
    });
    const out = await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" });
    expect(out.from).toBe("structured");
  });

  it("throws on tool-level error result", async () => {
    callToolMock.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
    await expect(
      callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" }),
    ).rejects.toThrow(/Marketplace vendor_get_self returned an error: boom/);
  });

  it("closes the client even after a successful call", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });
    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMarketplaceBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors MARKETPLACE_BASE_URL override outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://localhost:8081/");
    expect(resolveMarketplaceBaseUrl()).toBe("http://localhost:8081");
  });

  it("ignores override AND env in production (single hardcoded marketplace)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://evil.test");
    expect(resolveMarketplaceBaseUrl("http://also-evil.test")).toBe(MARKETPLACE_BASE_URL);
  });
});
