// Hermetic tests for the Tailscale OAuth-client (Design C) proxy-mint path.
//
// No Docker, no network — a stub `fetchImpl` is injected. These lock the
// security-critical contract: the worker mints through the Nango Proxy and
// receives ONLY the auth-key; a CONFIRMED-missing OAuth connection returns
// `null` (so the caller may fall back to API-key mode) while EVERY other
// failure throws a typed `TailscaleProxyMintError` (so a real outage never
// silently downgrades the tunnel); and nothing ever logs or leaks a secret.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  mintTailscaleAuthKeyViaNangoProxy,
  TailscaleProxyMintError,
  TAILSCALE_OAUTH_PROVIDER_CONFIG_KEY,
} from "../src/tailscale-nango.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SECRET = "tskey-client-SUPERSECRETvalue11CNTRL-deadbeefcafef00d";
const ACCESS_TOKEN = "tskey-api-ACCESSTOKENvalueSHOULDNEVERLEAK";
const MINTED_KEY = "tskey-auth-kFAKE11CNTRL-mintedauthkeyvalue";

function jsonResponse(status, body) {
  return {
    status,
    json: async () => body,
  };
}

function okArgs(overrides = {}) {
  return {
    serverUrl: "http://nango.local",
    secretKey: "nango-proxy-scoped-key",
    connectionId: "conn-uuid-1234",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mintTailscaleAuthKeyViaNangoProxy — success", () => {
  it("returns only the auth-key from the proxy `key` field", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: "k1CNTRL", key: MINTED_KEY, expires: "2026-01-01T00:00:00Z" }),
    );
    const result = await mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl });
    expect(result).toEqual({ authKey: MINTED_KEY });
  });

  it("uses /proxy/v2/tailnet/-/keys (NOT a doubled /api), the right headers, and a short-lived ephemeral body", async () => {
    let calledUrl = "";
    let calledInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      calledUrl = url;
      calledInit = init;
      return jsonResponse(200, { key: MINTED_KEY });
    });
    await mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl });

    expect(calledUrl).toBe("http://nango.local/proxy/v2/tailnet/-/keys");
    expect(calledUrl).not.toContain("/proxy/api/");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers["Connection-Id"]).toBe("conn-uuid-1234");
    expect(calledInit.headers["Provider-Config-Key"]).toBe(
      TAILSCALE_OAUTH_PROVIDER_CONFIG_KEY,
    );
    expect(calledInit.headers.Authorization).toBe("Bearer nango-proxy-scoped-key");

    const body = JSON.parse(calledInit.body);
    const create = body.capabilities.devices.create;
    expect(create.ephemeral).toBe(true);
    expect(create.preauthorized).toBe(true);
    expect(create.reusable).toBe(false);
    expect(create.tags).toEqual(["tag:cinatra-clone"]);
    expect(typeof body.expirySeconds).toBe("number");
    expect(body.expirySeconds).toBeGreaterThan(0);
  });

  it("honours a custom tailnet, providerConfigKey and tags", async () => {
    let calledUrl = "";
    let calledInit = null;
    const fetchImpl = vi.fn(async (url, init) => {
      calledUrl = url;
      calledInit = init;
      return jsonResponse(200, { key: MINTED_KEY });
    });
    await mintTailscaleAuthKeyViaNangoProxy(
      okArgs({ tailnet: "example.com", providerConfigKey: "custom-pck", tags: ["tag:x"] }),
      { fetchImpl },
    );
    expect(calledUrl).toBe("http://nango.local/proxy/v2/tailnet/example.com/keys");
    expect(calledInit.headers["Provider-Config-Key"]).toBe("custom-pck");
    expect(JSON.parse(calledInit.body).capabilities.devices.create.tags).toEqual(["tag:x"]);
  });
});

describe("mintTailscaleAuthKeyViaNangoProxy — FAILS CLOSED on every error (no fallback path exists)", () => {
  it("throws (never returns null/undefined) when wiring is incomplete — never calls fetch", async () => {
    const fetchImpl = vi.fn();
    for (const bad of [{ connectionId: "" }, { serverUrl: "" }, { secretKey: "" }]) {
      await expect(
        mintTailscaleAuthKeyViaNangoProxy(okArgs(bad), { fetchImpl }),
      ).rejects.toMatchObject({ code: "tailscale.oauth_misconfigured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws tailscale.oauth_misconfigured on 400 (missing connection: Nango `400 server_error`) and 404 (missing provider config)", async () => {
    // Probe-verified shapes: a missing connection is `400 server_error \"Failed
    // to get connection\"`; a missing provider config is `404 unknown_provider_config`.
    // Neither is a safe fall-back signal — both fail closed.
    for (const [status, body] of [
      [400, { error: { code: "server_error", message: "Failed to get connection" } }],
      [404, { error: { code: "unknown_provider_config" } }],
    ]) {
      const fetchImpl = vi.fn(async () => jsonResponse(status, body));
      await expect(
        mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl }),
      ).rejects.toMatchObject({ name: "TailscaleProxyMintError", code: "tailscale.oauth_misconfigured" });
    }
  });

  it("never resolves to a falsy value — success is the ONLY non-throw outcome", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(400, { error: { code: "server_error" } }));
    let settled;
    await mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl }).then(
      (v) => (settled = { ok: true, v }),
      (e) => (settled = { ok: false, e }),
    );
    expect(settled.ok).toBe(false); // threw, did NOT resolve null
  });
});

describe("mintTailscaleAuthKeyViaNangoProxy — status → typed code", () => {
  const cases = [
    { status: 401, code: "tailscale.proxy_unauthorized" },
    { status: 403, code: "tailscale.tag_denied" },
    { status: 429, code: "tailscale.rate_limited" },
    { status: 500, code: "tailscale.proxy_server" },
    { status: 502, code: "tailscale.proxy_server" },
    { status: 418, code: "tailscale.unknown" },
  ];
  for (const { status, code } of cases) {
    it(`throws TailscaleProxyMintError(${code}) on ${status}`, async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { code: "x" } }));
      await expect(
        mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl }),
      ).rejects.toMatchObject({ name: "TailscaleProxyMintError", code, tailscale: true });
    });
  }

  it("throws tailscale.network when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${SECRET}`); // even if the cause string carried a secret…
    });
    await expect(mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl })).rejects.toMatchObject({
      code: "tailscale.network",
    });
  });

  it("throws tailscale.network on a request timeout (AbortSignal.timeout → fetch rejects)", async () => {
    // Real AbortSignal.timeout path: fetch is given a short signal and rejects.
    const fetchImpl = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "TimeoutError")),
          );
        }),
    );
    await expect(
      mintTailscaleAuthKeyViaNangoProxy(okArgs({ timeoutMs: 20 }), { fetchImpl }),
    ).rejects.toMatchObject({ code: "tailscale.network" });
  });

  it("throws tailscale.malformed on a 200 with no key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "k1", expires: "x" }));
    await expect(mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl })).rejects.toMatchObject({
      code: "tailscale.malformed",
    });
  });

  it("throws tailscale.malformed on a 200 whose body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    await expect(mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl })).rejects.toMatchObject({
      code: "tailscale.malformed",
    });
  });
});

describe("mintTailscaleAuthKeyViaNangoProxy — never logs, never leaks", () => {
  it("does not call console.* and never puts a secret/token/key in the thrown error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Upstream error body deliberately stuffed with secret-looking values.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, {
        error: { code: "boom", message: `${SECRET} ${ACCESS_TOKEN} ${MINTED_KEY}` },
      }),
    );
    let thrown;
    try {
      await mintTailscaleAuthKeyViaNangoProxy(okArgs(), { fetchImpl });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TailscaleProxyMintError);
    const blob = `${thrown.message} ${thrown.code} ${thrown.stack ?? ""}`;
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(ACCESS_TOKEN);
    expect(blob).not.toContain(MINTED_KEY);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// --- structural: index.mjs wiring keeps the API-key path intact + falls through ---

describe("index.mjs wiring (structural)", () => {
  const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

  function defCount(name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
    return (INDEX_SRC.match(re) ?? []).length;
  }

  it("autoMintTailscaleAuthKeyFromNango and the auth-config reader are each defined once", () => {
    expect(defCount("autoMintTailscaleAuthKeyFromNango")).toBe(1);
    expect(defCount("readTailscaleAuthConfigFromClone")).toBe(1);
  });

  it("auto-mint fails CLOSED in OAuth mode — NO runtime downgrade to the API-key path", () => {
    const start = INDEX_SRC.indexOf("async function autoMintTailscaleAuthKeyFromNango(");
    const end = INDEX_SRC.indexOf("\n}", start);
    const body = INDEX_SRC.slice(start, end);
    expect(body).toContain('cfg.authMode === "oauth"');
    expect(body).toContain("discoverProxyNangoSettings(process.env)");
    expect(body).toContain("mintTailscaleAuthKeyViaNangoProxy(");
    // Three fail-closed throws: config-read-failure guard + 2 OAuth misconfig guards.
    expect(body).toContain('"tailscale.oauth_misconfigured"');
    expect(body.match(/throw new TailscaleProxyMintError\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // The OAuth branch RETURNS the minted key directly (mint throws otherwise) —
    // there is NO `if (minted?.authKey)` fall-through into the API-key path.
    expect(body).toContain("return authKey;");
    expect(body).not.toContain("if (minted?.authKey)");
    // Config-read-FAILURE on an OAuth-provisioned worker fails closed.
    expect(body).toContain("!cfg.readOk");
    expect(body).toContain("NANGO_PROXY_SECRET_KEY");
    // Legacy API-key behaviour preserved: same Nango credential read + same
    // connector mint with the same flags (NOT a claim of byte-identity — the
    // mode branch necessarily precedes it; the network behaviour is unchanged).
    expect(body).toContain("readTailscaleCredentialFromNango()");
    expect(body).toContain("mintTailscaleAuthKey({");
    expect(body).toContain("accessToken: cred.apiKey");
  });

  it("the OAuth proxy path uses an env-only proxy key, NEVER the DB-discovered admin secret", () => {
    const start = INDEX_SRC.indexOf("function discoverProxyNangoSettings(");
    const end = INDEX_SRC.indexOf("\n}", start);
    const body = INDEX_SRC.slice(start, end);
    expect(body).toContain("NANGO_PROXY_SECRET_KEY");
    // Must not reach into the Nango DB for a secret (that is the admin-key path).
    expect(body).not.toContain("discoverBootstrapNangoSettings");
    expect(body).not.toMatch(/secret_key|_nango_environments|createClient\(/);
  });

  it("the legacy API-key Nango read still targets the cinatra-tailscale connection", () => {
    expect(INDEX_SRC).toContain(
      "/connection/cinatra-tailscale?provider_config_key=cinatra-tailscale",
    );
  });
});
