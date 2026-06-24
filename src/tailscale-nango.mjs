// Tailscale OAuth-client (Design C) auth-key minting via the Nango Proxy.
//
// Context: the clone auto-tunnel needs a fresh, tag-scoped, ephemeral
// Tailscale auth-key per `cinatra clone start`. Two auth modes exist:
//
//   - API-key mode (legacy, unchanged): a `tskey-api-…` token stored on the
//     Nango `cinatra-tailscale` connection is used directly as the Bearer to
//     `POST /api/v2/tailnet/-/keys`. See `readTailscaleCredentialFromNango` +
//     `autoMintTailscaleAuthKeyFromNango` in index.mjs.
//
//   - OAuth-client mode (Design C): the worker calls the **Nango Proxy** so it
//     receives ONLY the minted auth-key — never the OAuth client secret, never
//     the 1h access token. Nango holds the Tailscale OAuth client (a `TWO_STEP`
//     connection: it mints the 1h token and forwards the request). The worker's
//     Nango key is scoped to `environment:proxy` ONLY (no
//     `connections:read_credentials`) — which is load-bearing, because a
//     `read_credentials` call on the `TWO_STEP` connection echoes the stored
//     `clientSecret` in cleartext (probe-verified). The proxy path keeps the
//     secret off the worker entirely. This is why we never read credentials
//     here and never fall back to local-minting.
//
// This module is the Design-C consumer. It is deliberately self-contained
// (no `@cinatra-ai/*` import — the CLI's minimal-dep doctrine, same as the
// API-key read path) and hermetic (injectable `fetchImpl`) so it is unit
// testable without a live Nango. It NEVER logs; callers surface only the
// typed `.code`. Nothing in this module ever stringifies the auth-key, the
// access token, the client secret, an Authorization header, or a raw
// fetch/error body.

/** Default provider-config-key for the OAuth (TWO_STEP) integration. */
export const TAILSCALE_OAUTH_PROVIDER_CONFIG_KEY = "cinatra-tailscale-oauth";

/**
 * Typed error for the OAuth proxy-mint path. The mint either succeeds
 * (`{ authKey }`) or throws this — there is NO fall-back-eligible return value.
 * A throw means OAuth mode FAILS CLOSED (missing wiring, any non-2xx, network/
 * timeout, malformed body); the operator configured OAuth, so we surface the
 * failure rather than silently downgrade to the API-key path.
 *
 * Messages are static/sanitised — they never interpolate a secret, token,
 * key, or upstream body.
 */
export class TailscaleProxyMintError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status) {
    super(message);
    this.name = "TailscaleProxyMintError";
    this.code = code;
    // Marker so index.mjs catch-sites can recognise this without importing the
    // class (parallel to the connector's `TailscaleApiError`).
    this.tailscale = true;
    if (typeof status === "number") this.status = status;
  }
}

/** Default request timeout (ms) for the proxy mint — a stalled proxy must not
 *  hang clone-start indefinitely. On timeout we throw `tailscale.network`
 *  (fail-closed), never fall back. */
export const TAILSCALE_PROXY_TIMEOUT_MS = 15_000;

/**
 * Mint a Tailscale ephemeral auth-key through the Nango Proxy (Design C).
 *
 * POSTs the auth-key `capabilities` to `${serverUrl}/proxy/v2/tailnet/<tailnet>/keys`
 * with `Connection-Id` + `Provider-Config-Key` headers; Nango injects the 1h
 * access token (minted from the stored OAuth client) and forwards to Tailscale.
 * The response carries `{ key, id, … }`; we return ONLY `key` (the auth-key).
 *
 * NOTE the path is `/proxy/v2/...`, NOT `/proxy/api/v2/...` — the Tailscale
 * provider's proxy `base_url` already includes `/api`, so a doubled `/api`
 * 404s (probe-verified).
 *
 * @param {object} args
 * @param {string} args.serverUrl   Nango server URL (no trailing slash needed)
 * @param {string} args.secretKey   Nango key — in prod an `environment:proxy`-scoped key
 * @param {string} args.connectionId  the OAuth connection id (Nango-generated; persisted by the connector)
 * @param {string} [args.providerConfigKey]  defaults to `cinatra-tailscale-oauth`
 * @param {string} [args.tailnet]   defaults to `-` (the OAuth client's home tailnet)
 * @param {string[]} [args.tags]    auth-key tags; defaults to `["tag:cinatra-clone"]`
 * @param {number} [args.expirySeconds]  auth-key lifetime; defaults to 600 (short-lived; the
 *   sidecar consumes it immediately)
 * @param {number} [args.timeoutMs]  request timeout; defaults to TAILSCALE_PROXY_TIMEOUT_MS
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ authKey: string }>} the minted auth-key. Throws
 *   `TailscaleProxyMintError` on EVERY failure (missing wiring, any non-2xx,
 *   network/timeout, malformed body) — OAuth mode FAILS CLOSED and NEVER
 *   silently downgrades to the API-key path. Mode selection is governed
 *   upstream by the connector-persisted `authMode`, not by a proxy error.
 */
export async function mintTailscaleAuthKeyViaNangoProxy(args, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const serverUrl = typeof args?.serverUrl === "string" ? args.serverUrl.replace(/\/+$/, "") : "";
  const secretKey = typeof args?.secretKey === "string" ? args.secretKey : "";
  const connectionId = typeof args?.connectionId === "string" ? args.connectionId.trim() : "";
  const providerConfigKey =
    typeof args?.providerConfigKey === "string" && args.providerConfigKey.trim()
      ? args.providerConfigKey.trim()
      : TAILSCALE_OAUTH_PROVIDER_CONFIG_KEY;
  const tailnet =
    typeof args?.tailnet === "string" && args.tailnet.trim() ? args.tailnet.trim() : "-";
  const tags =
    Array.isArray(args?.tags) && args.tags.length > 0 ? args.tags : ["tag:cinatra-clone"];
  const expirySeconds =
    typeof args?.expirySeconds === "number" && Number.isFinite(args.expirySeconds) && args.expirySeconds > 0
      ? Math.floor(args.expirySeconds)
      : 600;
  const timeoutMs =
    typeof args?.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? Math.floor(args.timeoutMs)
      : TAILSCALE_PROXY_TIMEOUT_MS;

  if (!serverUrl || !secretKey || !connectionId) {
    // Missing wiring is NOT a Nango "no connection" answer — it's a
    // misconfigured OAuth worker. FAIL CLOSED (the caller pre-validates this,
    // but defend here too) rather than masquerade as fall-back-eligible.
    throw new TailscaleProxyMintError(
      "tailscale.oauth_misconfigured",
      "Tailscale OAuth proxy mint is missing required wiring (server URL, proxy key, or connection id).",
    );
  }

  const url = `${serverUrl}/proxy/v2/tailnet/${encodeURIComponent(tailnet)}/keys`;
  const body = {
    capabilities: {
      devices: { create: { ephemeral: true, preauthorized: true, reusable: false, tags } },
    },
    expirySeconds,
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        "Connection-Id": connectionId,
        "Provider-Config-Key": providerConfigKey,
      },
      body: JSON.stringify(body),
      // Bound the wait so a stalled proxy can't hang clone-start forever.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network/transport failure OR timeout (AbortSignal.timeout) — do NOT fall
    // back (could mask a real outage and silently disable the tunnel). Surface
    // a typed error with no detail.
    throw new TailscaleProxyMintError(
      "tailscale.network",
      "Tailscale auth-key mint via Nango proxy failed (network error or timeout).",
    );
  }

  const status = typeof response?.status === "number" ? response.status : 0;

  if (status === 200 || status === 201) {
    /** @type {{ key?: unknown } | null} */
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw new TailscaleProxyMintError(
        "tailscale.malformed",
        "Tailscale auth-key proxy response was not JSON.",
        status,
      );
    }
    const authKey = typeof payload?.key === "string" ? payload.key : "";
    if (!authKey) {
      throw new TailscaleProxyMintError(
        "tailscale.malformed",
        "Tailscale auth-key proxy response was missing the key field.",
        status,
      );
    }
    return { authKey };
  }

  // Non-2xx: EVERY failure throws — OAuth mode FAILS CLOSED and never silently
  // downgrades to the API-key path. (Probe-verified: Nango's proxy exposes no
  // reliable body-independent "connection absent" signal — a missing connection
  // returns `400 server_error "Failed to get connection"` and a missing
  // provider-config returns `404 unknown_provider_config` — so there is nothing
  // safe to treat as fall-back-eligible. Mode selection happens upstream via the
  // connector-persisted `authMode`, not by interpreting a proxy error.) The
  // status drives a sanitised typed code; the response BODY is never echoed.
  if (status === 401) {
    throw new TailscaleProxyMintError(
      "tailscale.proxy_unauthorized",
      "Nango rejected the proxy request (401). Check the worker's environment:proxy-scoped key.",
      401,
    );
  }
  if (status === 403) {
    throw new TailscaleProxyMintError(
      "tailscale.tag_denied",
      "Tailscale rejected the auth-key tag(s) via proxy (403). Confirm the OAuth client owns the requested tag (e.g. tag:cinatra-clone).",
      403,
    );
  }
  if (status === 429) {
    throw new TailscaleProxyMintError(
      "tailscale.rate_limited",
      "Tailscale rate-limited the auth-key request (429). Try again shortly.",
      429,
    );
  }
  if (status === 400 || status === 404) {
    // The OAuth integration/connection could not be resolved (absent or broken)
    // — the operator must reconnect Tailscale (OAuth). Fail closed.
    throw new TailscaleProxyMintError(
      "tailscale.oauth_misconfigured",
      `Nango could not resolve the Tailscale OAuth connection for the proxy mint (status ${status}). Reconnect Tailscale (OAuth client) from the connector.`,
      status,
    );
  }
  if (status >= 500) {
    throw new TailscaleProxyMintError(
      "tailscale.proxy_server",
      `Nango proxy auth-key mint failed with status ${status}.`,
      status,
    );
  }
  throw new TailscaleProxyMintError(
    "tailscale.unknown",
    `Nango proxy auth-key mint failed with status ${status}.`,
    status,
  );
}
