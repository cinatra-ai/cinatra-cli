// RFC 9207 / RFC 8414 issuer-validation behaviour on the `cinatra login` path
// (cinatra#2218, CLI leg).
//
// PROOF CLASS: real-library loopback. The real
// `@modelcontextprotocol/client@2.0.0` OAuth primitives run against a REAL
// http authorization server on 127.0.0.1 serving real RFC 8414 / RFC 7591 /
// RFC 6749 documents. Nothing here is mocked.
//
// WHY THIS SUITE EXISTS. The login path opens no MCP session — it has no
// `Client`, no transport and no protocol revision — so the migration looked like
// a pure specifier swap. It is not. `exchangeAuthorization` runs
// `validateAuthorizationResponseIssuer` UNCONDITIONALLY on v2, and when the
// authorization server advertises
// `authorization_response_iss_parameter_supported: true` an ABSENT `iss` is
// itself a failure. A live cinatra instance advertises exactly that (measured
// 2026-08-06 against a deployed instance's
// `/.well-known/oauth-authorization-server/api/auth`), so a specifier-only swap
// would have broken every sign-in at the token exchange while every mocked test
// stayed green.
//
// The decision table below is the v2 contract, locked so a future dependency
// bump that changes it fails here rather than in an operator's terminal.

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";

import {
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  IssuerMismatchError,
} from "@modelcontextprotocol/client";

import {
  OAUTH_DISCOVERY_PROTOCOL_VERSION,
  rethrowWithoutUntrustedIssuer,
  startLoopbackListener,
} from "../src/login.mjs";

let stop;

afterEach(async () => {
  await stop?.();
  stop = undefined;
});

/**
 * A real authorization server. `issuerSuffix` lets a test publish an `issuer`
 * that does NOT echo the requested URL; `issParam` sets the RFC 9207
 * advertisement.
 */
async function startAuthServer({ issuerSuffix = "", issParam } = {}) {
  const seen = { discoveryHeaders: null };
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      seen.discoveryHeaders = { ...req.headers };
      const doc = {
        issuer: base + issuerSuffix,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
      };
      if (issParam !== undefined) doc.authorization_response_iss_parameter_supported = issParam;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(doc));
      return;
    }
    if (url.pathname === "/token") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ access_token: "AT", token_type: "Bearer", expires_in: 3600, refresh_token: "RT" }));
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stop = () => new Promise((resolve) => server.close(resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const exchange = (base, metadata, iss) =>
  exchangeAuthorization(base, {
    metadata,
    clientInformation: { client_id: "cli-client" },
    authorizationCode: "code-1",
    iss,
    codeVerifier: "v".repeat(43),
    redirectUri: "http://127.0.0.1:1/callback",
  });

describe("RFC 9207 `iss` decision table (the v2 contract this migration must satisfy)", () => {
  it("iss advertised + CORRECT iss forwarded -> exchange succeeds", async () => {
    const { base } = await startAuthServer({ issParam: true });
    const metadata = await discoverAuthorizationServerMetadata(base);
    await expect(exchange(base, metadata, base)).resolves.toMatchObject({ access_token: "AT" });
  });

  it("iss advertised + iss ABSENT -> THROWS (this is the migration's breaking change)", async () => {
    const { base } = await startAuthServer({ issParam: true });
    const metadata = await discoverAuthorizationServerMetadata(base);
    await expect(exchange(base, metadata, undefined)).rejects.toThrow(/Issuer mismatch/i);
  });

  it("iss advertised + WRONG iss -> THROWS (the mix-up attack this defends against)", async () => {
    const { base } = await startAuthServer({ issParam: true });
    const metadata = await discoverAuthorizationServerMetadata(base);
    await expect(exchange(base, metadata, "https://evil.example")).rejects.toThrow(/Issuer mismatch/i);
  });

  it("iss NOT advertised + iss absent -> succeeds (unchanged for servers without RFC 9207)", async () => {
    const { base } = await startAuthServer({ issParam: undefined });
    const metadata = await discoverAuthorizationServerMetadata(base);
    await expect(exchange(base, metadata, undefined)).resolves.toMatchObject({ access_token: "AT" });
  });

  it("iss NOT advertised + WRONG iss -> still THROWS (validated whenever present)", async () => {
    const { base } = await startAuthServer({ issParam: false });
    const metadata = await discoverAuthorizationServerMetadata(base);
    await expect(exchange(base, metadata, "https://evil.example")).rejects.toThrow(/Issuer mismatch/i);
  });
});

describe("the loopback listener supplies the `iss` the exchange needs", () => {
  it("resolves { code, iss } and round-trips the iss the server sent", async () => {
    const listener = await startLoopbackListener("state-abc");
    const issuer = "https://as.example.com/api/auth";
    await fetch(
      `${listener.redirectUrl}?code=the-code&state=state-abc&iss=${encodeURIComponent(issuer)}`,
    );
    await expect(listener.waitForCode()).resolves.toEqual({ code: "the-code", iss: issuer });
    listener.close();
  });

  it("resolves iss as undefined (not null) when the server sends none", async () => {
    // `validateAuthorizationResponseIssuer` branches on `iss === undefined`; a
    // `null` from `URLSearchParams.get` would take the "present" branch and fail
    // every login against a server that does not implement RFC 9207.
    const listener = await startLoopbackListener("state-xyz");
    await fetch(`${listener.redirectUrl}?code=c2&state=state-xyz`);
    const resolved = await listener.waitForCode();
    expect(resolved.code).toBe("c2");
    expect(resolved.iss).toBeUndefined();
    expect(resolved.iss).not.toBeNull();
    listener.close();
  });

  it("still rejects a state mismatch (unchanged CSRF guard)", async () => {
    const listener = await startLoopbackListener("expected");
    // Attach the rejection handler BEFORE driving the callback — the listener
    // rejects synchronously on the request, and an unobserved rejection would
    // surface as an unhandled error even though the assertion passes.
    const settled = expect(listener.waitForCode()).rejects.toThrow(/State mismatch/i);
    await fetch(`${listener.redirectUrl}?code=c&state=wrong`);
    await settled;
    listener.close();
  });
});

describe("attacker-controllable callback values never reach the terminal", () => {
  // `bin/cinatra.mjs` prints `error.message` verbatim, so any callback value
  // that reaches a message reaches an operator's console. Upstream states the
  // `received` issuer (and the callback's `error`/`error_description`/
  // `error_uri`) are attacker-controllable in a mix-up attack and MUST NOT be
  // displayed. Rejecting the flow is necessary but NOT sufficient — these tests
  // pin the sanitization, which rejection alone does not prove.

  const ESC = "\u001b";
  const HOSTILE = `https://evil.example/${ESC}[2K\rBank of Cinatra: enter your password`;

  it("the RFC 9207 mismatch message does NOT echo the received issuer", async () => {
    const { base } = await startAuthServer({ issParam: true });
    const metadata = await discoverAuthorizationServerMetadata(base);

    // What the raw library would have printed, for contrast.
    const raw = await exchange(base, metadata, HOSTILE).catch((e) => e);
    expect(raw).toBeInstanceOf(IssuerMismatchError);
    expect(raw.message).toContain("evil.example");

    // What `cinatra login` actually surfaces.
    const surfaced = await exchange(base, metadata, HOSTILE)
      .catch(rethrowWithoutUntrustedIssuer)
      .catch((e) => e);
    expect(surfaced.message).not.toContain("evil.example");
    expect(surfaced.message).not.toContain(ESC);
    expect(surfaced.message).not.toContain("Bank of Cinatra");
    // The trusted facts survive: what failed, and the issuer WE expected.
    expect(surfaced.message).toMatch(/RFC 9207 issuer check failed/);
    expect(surfaced.message).toContain(base);
    expect(surfaced.message).toMatch(/No authorization code was redeemed/);
    // ...and nothing is lost for a programmatic caller.
    expect(surfaced.cause).toBeInstanceOf(IssuerMismatchError);
  });

  it("a METADATA-arm mismatch is still shown in full (operator's own origin)", async () => {
    // Not attacker-controllable, and the operator has to see it to fix it.
    const { base } = await startAuthServer({ issuerSuffix: "/api/auth" });
    const err = await discoverAuthorizationServerMetadata(base).catch((e) => e);
    const surfaced = await Promise.reject(err)
      .catch(rethrowWithoutUntrustedIssuer)
      .catch((e) => e);
    expect(surfaced).toBe(err);
    expect(surfaced.message).toContain("/api/auth");
  });

  it("non-issuer exchange failures pass through untouched", async () => {
    const boom = new Error("token endpoint exploded");
    const out = await Promise.reject(boom)
      .catch(rethrowWithoutUntrustedIssuer)
      .catch((e) => e);
    expect(out).toBe(boom);
  });

  it("a hostile `error` on the redirect is replaced, not echoed", async () => {
    const listener = await startLoopbackListener("state-1");
    const settled = expect(listener.waitForCode()).rejects.toThrow(/Authorization error:/);
    await fetch(
      `${listener.redirectUrl}?state=state-1&error=${encodeURIComponent(`${ESC}[2Kaccess_denied — call 1-800-EVIL`)}`,
    );
    await settled;
    const err = await listener.waitForCode().catch((e) => e);
    expect(err.message).toBe("Authorization error: unrecognized error code (not shown)");
    expect(err.message).not.toContain("1-800-EVIL");
    expect(err.message).not.toContain(ESC);
    listener.close();
  });

  it("a well-known `error` code IS still shown (diagnostics preserved)", async () => {
    const listener = await startLoopbackListener("state-2");
    const settled = expect(listener.waitForCode()).rejects.toThrow(/access_denied/);
    await fetch(`${listener.redirectUrl}?state=state-2&error=access_denied`);
    await settled;
    listener.close();
  });
});

describe("RFC 8414 §3.3 issuer echo (new on v2) and the pinned discovery header", () => {
  it("accepts metadata whose issuer echoes the requested URL", async () => {
    const { base } = await startAuthServer({});
    await expect(discoverAuthorizationServerMetadata(base)).resolves.toMatchObject({ issuer: base });
  });

  it("REJECTS metadata whose issuer does not echo the requested URL", async () => {
    // v1 returned this document; v2 refuses it. Recorded because it decides how
    // the separate `cinatra login` discovery defect must be fixed: a cinatra
    // instance publishes `issuer: <origin>/api/auth` and serves the document at
    // `/.well-known/oauth-authorization-server/api/auth`, so the fix has to
    // request `<origin>/api/auth` — which ECHOES, and therefore passes this
    // check. Requesting the bare origin could never satisfy it.
    const { base } = await startAuthServer({ issuerSuffix: "/api/auth" });
    await expect(discoverAuthorizationServerMetadata(base)).rejects.toThrow(/Issuer mismatch/i);
  });

  it("stamps the PINNED MCP-Protocol-Version on discovery, not the package default", async () => {
    const { base, seen } = await startAuthServer({});
    await discoverAuthorizationServerMetadata(base, {
      protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION,
    });
    expect(seen.discoveryHeaders["mcp-protocol-version"]).toBe(OAUTH_DISCOVERY_PROTOCOL_VERSION);
    // Wire-neutral across the migration: this is the value BOTH
    // @modelcontextprotocol/sdk@1.29.0 and @modelcontextprotocol/core@2.0.0
    // carry as LATEST_PROTOCOL_VERSION, so the discovery request is unchanged.
    expect(OAUTH_DISCOVERY_PROTOCOL_VERSION).toBe("2025-11-25");
  });
});
