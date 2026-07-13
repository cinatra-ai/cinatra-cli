// CLI remote-target security model — CLI Class-A: RFC 8707 `resource` on interactive auth/exchange/
// refresh, the audience-bound byte helpers, the loopback-unauthenticated read
// path, and the target-origin destructive guard.
//
// The MCP SDK auth primitives are mocked so the test asserts the CLI passes
// `resource=<origin>/api/cli` WITHOUT a live server. `fetch` is injected.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- Mock the MCP SDK OAuth primitives (hoisted) -------------------------
const sdkMocks = vi.hoisted(() => ({
  discoverAuthorizationServerMetadata: vi.fn(async () => ({
    issuer: "http://localhost:3000/api/auth",
    authorization_endpoint: "http://localhost:3000/api/auth/oauth2/authorize",
    token_endpoint: "http://localhost:3000/api/auth/oauth2/token",
    registration_endpoint: "http://localhost:3000/api/auth/oauth2/register",
  })),
  registerClient: vi.fn(async () => ({
    client_id: "cli-client",
    token_endpoint_auth_method: "none",
  })),
  startAuthorization: vi.fn(async () => ({
    authorizationUrl: new URL("http://localhost:3000/api/auth/oauth2/authorize"),
    codeVerifier: "verifier",
  })),
  exchangeAuthorization: vi.fn(async () => ({
    access_token: "AT",
    refresh_token: "RT",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid cli:status",
  })),
  refreshAuthorization: vi.fn(async () => ({
    access_token: "AT2",
    refresh_token: "RT2",
    token_type: "Bearer",
    expires_in: 3600,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => sdkMocks);

const {
  runLogin,
  resolveAccessToken,
  buildProfileRecord,
  saveProfile,
  cliResourceFor,
  cliApiGetBytes,
  cliApiPostBytes,
  isLoopbackHostname,
  isLoopbackOrigin,
  assertDestructiveTargetAllowed,
} = await import("../src/login.mjs");

let configDir;
let env;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cinatra-classa-test-"));
  env = { XDG_CONFIG_HOME: configDir };
  for (const m of Object.values(sdkMocks)) m.mockClear();
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

describe("cliResourceFor", () => {
  it("builds <origin>/api/cli as a URL, normalized from origin", () => {
    expect(cliResourceFor("https://instance.example.com").href).toBe(
      "https://instance.example.com/api/cli",
    );
    // No double-path / trailing-slash drift.
    expect(cliResourceFor("http://localhost:3000").href).toBe(
      "http://localhost:3000/api/cli",
    );
  });
});

describe("RFC 8707 resource on interactive login", () => {
  it("passes resource=<origin>/api/cli + cli:* scopes on startAuthorization AND exchangeAuthorization", async () => {
    // Drive the real loopback listener: the injected `open` hook receives the
    // authorization URL with our redirect_uri's state; we hit the redirect with
    // a code so `waitForCode()` resolves and the flow reaches exchange.
    let resolveCode;
    const open = (authUrl) => {
      const u = new URL(authUrl);
      // startAuthorization is mocked to return a fixed URL with no state, so we
      // read the state the listener expects from the redirect url it printed.
      // Instead, capture the redirect target from registerClient's recorded
      // redirect_uris and complete it with the state runLogin generated.
      void u;
      resolveCode?.();
    };

    // The loopback listener validates `state`, so we must send the exact state.
    // runLogin generates it internally and passes it to startAuthorization; we
    // recover it from the startAuthorization call args, then POST the callback.
    const loginPromise = runLogin({
      appUrl: "https://instance.example.com",
      open,
      log: () => {},
      env,
    });

    // Wait until startAuthorization has been called (it carries state + the
    // redirect was registered), then hit the loopback callback with the code.
    await vi.waitFor(() => {
      expect(sdkMocks.startAuthorization).toHaveBeenCalledTimes(1);
    });
    const startArgs = sdkMocks.startAuthorization.mock.calls[0][1];
    const state = startArgs.state;
    const redirectUri = sdkMocks.registerClient.mock.calls[0][1].clientMetadata
      .redirect_uris[0];
    await fetch(`${redirectUri}?code=abc&state=${encodeURIComponent(state)}`);
    await loginPromise;

    // resource present + URL-typed on BOTH authorize and exchange.
    expect(startArgs.resource).toBeInstanceOf(URL);
    expect(startArgs.resource.href).toBe("https://instance.example.com/api/cli");
    expect(startArgs.scope).toContain("cli:status");
    expect(startArgs.scope).toContain("cli:agent:read");
    expect(startArgs.scope).toContain("cli:agent:write");
    // The reconcile control plane (cinatra-cli#126) — the host guard requires
    // the EXACT endpoint scope (no cli:* fallback), so login requests the pair.
    expect(startArgs.scope).toContain("cli:extensions:read");
    expect(startArgs.scope).toContain("cli:extensions:write");

    expect(sdkMocks.exchangeAuthorization).toHaveBeenCalledTimes(1);
    const exchangeArgs = sdkMocks.exchangeAuthorization.mock.calls[0][1];
    expect(exchangeArgs.resource).toBeInstanceOf(URL);
    expect(exchangeArgs.resource.href).toBe(
      "https://instance.example.com/api/cli",
    );

    // The persisted profile records the resource for later refresh.
    const out = await resolveAccessToken({
      appUrl: "https://instance.example.com",
      env,
    });
    expect(out.accessToken).toBe("AT");
  });
});

describe("resource on refresh", () => {
  it("re-sends the stored resource on refreshAuthorization and persists it", async () => {
    // Seed a near-expiry profile carrying a resource.
    const record = buildProfileRecord(
      {
        origin: "https://instance.example.com",
        clientInformation: { client_id: "cli-client" },
        tokens: { access_token: "OLD", refresh_token: "RT", expires_in: 10 },
        resource: "https://instance.example.com/api/cli",
      },
      Date.now() - 5_000, // obtained 5s ago, expires_in 10s → within skew
    );
    await saveProfile("https://instance.example.com", record, {}, env);

    const out = await resolveAccessToken({
      appUrl: "https://instance.example.com",
      env,
    });
    expect(out.accessToken).toBe("AT2");
    expect(sdkMocks.refreshAuthorization).toHaveBeenCalledTimes(1);
    const refreshArgs = sdkMocks.refreshAuthorization.mock.calls[0][1];
    expect(refreshArgs.resource).toBeInstanceOf(URL);
    expect(refreshArgs.resource.href).toBe(
      "https://instance.example.com/api/cli",
    );
  });

  it("buildProfileRecord defaults resource to <origin>/api/cli when not supplied", () => {
    const rec = buildProfileRecord({
      origin: "https://x.example.com",
      clientInformation: { client_id: "c" },
      tokens: { access_token: "A", expires_in: 100 },
    });
    expect(rec.resource).toBe("https://x.example.com/api/cli");
  });
});

describe("loopback detection", () => {
  it("accepts localhost / 127.0.0.0/8 / ::1 and rejects lookalikes", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    // Lookalikes must be rejected.
    expect(isLoopbackHostname("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.com")).toBe(false);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
    expect(isLoopbackHostname("127.0.0.256")).toBe(false);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });

  it("isLoopbackOrigin parses the host and fails closed on malformed input", () => {
    expect(isLoopbackOrigin("http://localhost:3000")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.5:8080")).toBe(true);
    expect(isLoopbackOrigin("https://public.example.com")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("byte helpers", () => {
  it("cliApiGetBytes attaches a Bearer for a remote (non-loopback) target", async () => {
    const record = buildProfileRecord({
      origin: "https://instance.example.com",
      clientInformation: { client_id: "c" },
      tokens: { access_token: "SECRET-TOKEN", expires_in: 3600 },
    });
    await saveProfile("https://instance.example.com", record, {}, env);

    const fetchFn = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    const bytes = await cliApiGetBytes("/api/cli/agents/export?query=x", {
      appUrl: "https://instance.example.com",
      env,
      fetchFn,
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer SECRET-TOKEN");
  });

  it("cliApiGetBytes sends NO Authorization header for a loopback target (zero-login)", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    }));
    await cliApiGetBytes("/api/cli/agents/export?query=x", {
      appUrl: "http://localhost:3000",
      env, // NOTE: no profile saved — proves it never calls resolveAccessToken
      fetchFn,
    });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/cli/agents/export?query=x");
    expect(init.headers.authorization).toBeUndefined();
  });

  it("cliApiPostBytes posts the body with the given content-type + Bearer (remote)", async () => {
    const record = buildProfileRecord({
      origin: "https://instance.example.com",
      clientInformation: { client_id: "c" },
      tokens: { access_token: "T", expires_in: 3600 },
    });
    await saveProfile("https://instance.example.com", record, {}, env);
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "new-1", name: "Imported", viewInApp: "/agents/builder/new-1" }),
    }));
    const res = await cliApiPostBytes(
      "/api/cli/agents/import?name=X",
      Buffer.from([1, 2]),
      { appUrl: "https://instance.example.com", env, contentType: "application/zip", fetchFn },
    );
    expect(res.id).toBe("new-1");
    const [, init] = fetchFn.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/zip");
    expect(init.headers.authorization).toBe("Bearer T");
  });

  it("cliApiGetBytes redacts the token in a non-2xx error", async () => {
    const record = buildProfileRecord({
      origin: "https://instance.example.com",
      clientInformation: { client_id: "c" },
      tokens: { access_token: "SUPERSECRETTOKEN", expires_in: 3600 },
    });
    await saveProfile("https://instance.example.com", record, {}, env);
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ error: "denied for Bearer SUPERSECRETTOKEN" }),
    }));
    await expect(
      cliApiGetBytes("/api/cli/agents/export?query=x", {
        appUrl: "https://instance.example.com",
        env,
        fetchFn,
      }),
    ).rejects.toThrow(/\[REDACTED\]/);
    // And the raw token must NOT appear in the message.
    await cliApiGetBytes("/api/cli/agents/export?query=x", {
      appUrl: "https://instance.example.com",
      env,
      fetchFn,
    }).catch((e) => {
      expect(e.message).not.toContain("SUPERSECRETTOKEN");
    });
  });
});

describe("target-origin destructive guard", () => {
  it("refuses a destructive verb against a remote (non-loopback) target", () => {
    expect(() =>
      assertDestructiveTargetAllowed("https://public.example.com", "extensions purge"),
    ).toThrow(/operator security gate/);
  });

  it("allows a destructive verb against a loopback target", () => {
    expect(() =>
      assertDestructiveTargetAllowed("http://localhost:3000", "skills reset-repo"),
    ).not.toThrow();
    expect(() =>
      assertDestructiveTargetAllowed("http://127.0.0.9:8080", "skills reset-repo"),
    ).not.toThrow();
  });

  it("allows a destructive verb with no remote target (local path)", () => {
    expect(() =>
      assertDestructiveTargetAllowed(undefined, "extensions purge"),
    ).not.toThrow();
  });
});
