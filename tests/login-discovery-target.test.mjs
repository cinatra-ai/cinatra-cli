// cinatra-cli#203 — the OAuth metadata-discovery TARGET on the `cinatra login`
// path.
//
// PROOF CLASS: real-library loopback. The real
// `@modelcontextprotocol/client@2.0.0` OAuth primitives and the real
// `runLogin` / `resolveAccessToken` run against a REAL http server on 127.0.0.1
// shaped EXACTLY like a Cinatra instance's OAuth surface — the root well-known
// paths 404, the `/api/auth`-suffixed ones serve an RFC 8414 document whose
// `issuer` is `<origin>/api/auth`. Nothing in this file is mocked; the fixture's
// shape is copied from a live instance measured anonymously on 2026-08-06:
//
//   GET /.well-known/oauth-authorization-server           -> 404
//   GET /.well-known/openid-configuration                 -> 404
//   GET /.well-known/oauth-authorization-server/api/auth  -> 200  issuer=<origin>/api/auth
//   GET /.well-known/openid-configuration/api/auth        -> 200
//
// THE DEFECT THIS PINS. `runLogin` passed the bare instance ORIGIN as the
// authorization-server URL. `buildDiscoveryUrls` branches on
// `url.pathname !== "/"`: a pathless URL yields ONLY the two ROOT well-known
// locations, both of which a Cinatra instance answers 404. The library treats
// 4xx as "try the next URL", the list runs out, discovery resolves `undefined`,
// and `cinatra login` aborted before opening a browser — on v1 and on v2 alike.
//
// The first `describe` below is the regression itself, driven against this
// fixture: it asserts the OLD target still fails and the NEW one succeeds, so
// the suite would go red if the fix were reverted rather than merely proving the
// fixed path works.

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverAuthorizationServerMetadata,
  buildDiscoveryUrls,
} from "@modelcontextprotocol/client";

import {
  authorizationServerUrlFor,
  discoveryUrlsFor,
  runLogin,
  resolveAccessToken,
  buildProfileRecord,
  saveProfile,
  resolveCredentialsPath,
  OAUTH_DISCOVERY_PROTOCOL_VERSION,
} from "../src/login.mjs";

let stop;
let tmpConfigDir;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  if (tmpConfigDir) {
    await rm(tmpConfigDir, { recursive: true, force: true });
    tmpConfigDir = undefined;
  }
});

/**
 * A real HTTP server shaped like a Cinatra instance's OAuth surface.
 *
 * `issuerPath` lets a test publish a NON-echoing `issuer` (the RFC 8414 §3.3
 * failure mode). `serveRootWellKnown` lets a test model the population that
 * genuinely serves the ROOT document instead.
 */
async function startCinatraShapedInstance({
  issuerPath = "/api/auth",
  serveRootWellKnown = false,
  serveSuffixedWellKnown = true,
} = {}) {
  const seen = { paths: [], tokenForm: null, registration: null };
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(req.url, base);
    seen.paths.push(url.pathname);

    const asDocument = () => ({
      issuer: `${base}${issuerPath}`,
      authorization_endpoint: `${base}/api/auth/oauth2/authorize`,
      token_endpoint: `${base}/api/auth/oauth2/token`,
      registration_endpoint: `${base}/api/auth/oauth2/register`,
      jwks_uri: `${base}/api/auth/jwks`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      // A live instance advertises this — it is what makes forwarding the
      // RFC 9207 `iss` mandatory rather than optional (cinatra#2218 CLI leg).
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["openid", "offline_access", "mcp:connect", "cli:status"],
    });

    const json = (body, status = 200) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    // The PATH-SUFFIXED well-known locations — what a Cinatra instance serves.
    if (
      url.pathname === "/.well-known/oauth-authorization-server/api/auth" ||
      url.pathname === "/.well-known/openid-configuration/api/auth"
    ) {
      if (serveSuffixedWellKnown) {
        json(asDocument());
        return;
      }
      res.writeHead(404, { "content-type": "text/html" }).end("<html>404</html>");
      return;
    }
    // The ROOT well-known locations — 404 on a real instance.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      if (serveRootWellKnown) {
        json({ ...asDocument(), issuer: base });
        return;
      }
      res.writeHead(404, { "content-type": "text/html" }).end("<html>404</html>");
      return;
    }
    // RFC 7591 dynamic client registration — a PUBLIC client.
    if (url.pathname === "/api/auth/oauth2/register" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.registration = JSON.parse(body);
        json({
          client_id: "dcr-client-203",
          client_name: seen.registration.client_name,
          redirect_uris: seen.registration.redirect_uris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      });
      return;
    }
    // The token endpoint — authorization_code AND refresh_token grants.
    if (url.pathname === "/api/auth/oauth2/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.tokenForm = Object.fromEntries(new URLSearchParams(body));
        const refreshed = seen.tokenForm.grant_type === "refresh_token";
        json({
          access_token: refreshed ? "AT-refreshed" : "AT-interactive",
          refresh_token: refreshed ? "RT-2" : "RT-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid offline_access cli:status",
        });
      });
      return;
    }
    res.writeHead(404).end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  stop = () => new Promise((resolve) => server.close(resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

/** An `open` hook that completes the browser leg by driving the redirect. */
function completeSignIn({ iss } = {}) {
  return (authorizationUrl) => {
    const u = new URL(authorizationUrl);
    const redirectUri = u.searchParams.get("redirect_uri");
    const state = u.searchParams.get("state");
    const cb = new URL(redirectUri);
    cb.searchParams.set("code", "auth-code-203");
    cb.searchParams.set("state", state);
    if (iss) cb.searchParams.set("iss", iss);
    // Fire-and-forget: `runLogin` is already awaiting the listener.
    void fetch(cb).catch(() => {});
  };
}

async function freshEnv() {
  tmpConfigDir = await mkdtemp(join(tmpdir(), "cinatra-login-203-"));
  return { XDG_CONFIG_HOME: tmpConfigDir };
}

// ---------------------------------------------------------------------------

describe("the regression: bare origin vs the /api/auth-suffixed target", () => {
  it("the OLD target (bare origin) discovers NOTHING against a Cinatra-shaped instance", async () => {
    const { base, seen } = await startCinatraShapedInstance();
    const metadata = await discoverAuthorizationServerMetadata(base, {
      protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION,
    });
    // `undefined`, not a throw: both root probes 404, and the library treats
    // 4xx as "try the next URL" until the list is exhausted.
    expect(metadata).toBeUndefined();
    // ...and it never even ASKED for the location the instance actually serves.
    expect(seen.paths).toEqual([
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]);
  });

  it("the NEW target discovers the document, and its issuer echoes (RFC 8414 §3.3)", async () => {
    const { base, seen } = await startCinatraShapedInstance();
    const metadata = await discoverAuthorizationServerMetadata(
      authorizationServerUrlFor(base),
      { protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION },
    );
    expect(metadata?.issuer).toBe(`${base}/api/auth`);
    expect(metadata?.authorization_response_iss_parameter_supported).toBe(true);
    // First probe hits, so only one request is made.
    expect(seen.paths).toEqual(["/.well-known/oauth-authorization-server/api/auth"]);
  });
});

describe("authorizationServerUrlFor", () => {
  it("suffixes the instance origin with the auth mount", () => {
    expect(authorizationServerUrlFor("https://instance.example.com")).toBe(
      "https://instance.example.com/api/auth",
    );
    expect(authorizationServerUrlFor("http://localhost:3000")).toBe(
      "http://localhost:3000/api/auth",
    );
  });

  it("normalizes: no double slash, no trailing slash, no path drift", () => {
    // The value is compared BYTE-FOR-BYTE against the published `issuer` by
    // v2's RFC 8414 §3.3 check, so drift here fails every login.
    expect(authorizationServerUrlFor("https://instance.example.com/")).toBe(
      "https://instance.example.com/api/auth",
    );
    expect(authorizationServerUrlFor("https://instance.example.com/sub/path")).toBe(
      "https://instance.example.com/api/auth",
    );
    expect(authorizationServerUrlFor("https://instance.example.com").endsWith("/")).toBe(false);
  });

  it("is DISTINCT from the RFC 8707 resource — the origin is the resource server", () => {
    // Conflating the two is the defect. `/api/cli` is the audience the token is
    // bound to; `/api/auth` is who mints it.
    expect(authorizationServerUrlFor("https://i.example.com")).not.toBe(
      "https://i.example.com/api/cli",
    );
  });
});

describe("discoveryUrlsFor matches what the library will actually request", () => {
  it("equals the library's own buildDiscoveryUrls for the derived target", () => {
    // Guards drift: the diagnostic we print on failure is derived independently
    // of the library, so this pins the two together. A dependency bump that
    // changes the probe order fails HERE rather than misleading an operator.
    const origin = "https://instance.example.com";
    const fromLibrary = buildDiscoveryUrls(authorizationServerUrlFor(origin)).map(
      (entry) => entry.url.href,
    );
    expect(discoveryUrlsFor(origin)).toEqual(fromLibrary);
    expect(fromLibrary).toEqual([
      "https://instance.example.com/.well-known/oauth-authorization-server/api/auth",
      "https://instance.example.com/.well-known/openid-configuration/api/auth",
      "https://instance.example.com/api/auth/.well-known/openid-configuration",
    ]);
  });

  it("the bare origin would have produced only the ROOT paths", () => {
    // The mechanism behind the defect, asserted against the library rather than
    // described: `hasPath` is false for a pathless URL.
    expect(buildDiscoveryUrls("https://instance.example.com").map((e) => e.url.href)).toEqual([
      "https://instance.example.com/.well-known/oauth-authorization-server",
      "https://instance.example.com/.well-known/openid-configuration",
    ]);
  });
});

describe("runLogin completes end to end against a Cinatra-shaped instance", () => {
  it("discovers, registers, authorizes, exchanges, and persists the profile", async () => {
    const { base, seen } = await startCinatraShapedInstance();
    const env = await freshEnv();

    const result = await runLogin({
      appUrl: base,
      open: completeSignIn({ iss: `${base}/api/auth` }),
      log: () => {},
      env,
    });

    expect(result.profileKey).toBe(base);

    // The suffixed well-known was requested; the root one never was.
    expect(seen.paths).toContain("/.well-known/oauth-authorization-server/api/auth");
    expect(seen.paths).not.toContain("/.well-known/oauth-authorization-server");

    // DCR reached the endpoint the DOCUMENT names, as a public PKCE client.
    expect(seen.paths).toContain("/api/auth/oauth2/register");
    expect(seen.registration.token_endpoint_auth_method).toBe("none");
    expect(seen.registration.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The token exchange completed, carrying PKCE + the RFC 8707 resource.
    expect(seen.tokenForm.grant_type).toBe("authorization_code");
    expect(seen.tokenForm.code).toBe("auth-code-203");
    expect(seen.tokenForm.code_verifier).toBeTruthy();
    expect(seen.tokenForm.resource).toBe(`${base}/api/cli`);
    expect(seen.tokenForm.client_id).toBe("dcr-client-203");

    // The profile landed on disk with the issued token.
    const store = JSON.parse(await readFile(resolveCredentialsPath(env), "utf8"));
    expect(store.profiles[base].accessToken).toBe("AT-interactive");
    expect(store.profiles[base].clientId).toBe("dcr-client-203");
    expect(store.profiles[base].resource).toBe(`${base}/api/cli`);
  });

  it("the message names every URL tried when the instance serves no metadata at all", async () => {
    // A reachable host that is not a Cinatra instance: the operator needs to see
    // WHICH documents were missing, not a single hard-coded root path.
    const server = createServer((_req, res) => res.writeHead(404).end("nope"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    stop = () => new Promise((resolve) => server.close(resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = await freshEnv();

    const err = await runLogin({ appUrl: base, open: () => {}, log: () => {}, env }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    for (const url of discoveryUrlsFor(base)) expect(err.message).toContain(url);
  });

  it("fails CLOSED when the suffixed document publishes a non-echoing issuer", async () => {
    // RFC 8414 §3.3, enforced by v2 on every 200. The point of requesting
    // `<origin>/api/auth` is that a Cinatra instance's issuer ECHOES it; an
    // instance whose issuer does not must not be signed into silently.
    const { base } = await startCinatraShapedInstance({ issuerPath: "/somewhere-else" });
    const env = await freshEnv();
    const err = await runLogin({ appUrl: base, open: () => {}, log: () => {}, env }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Issuer mismatch/i);
    // The metadata arm is shown in full, and the distinction is narrower than
    // "trusted vs attacker-controlled": this value is PEER-controlled — it came
    // from a document served by the operator's own configured origin over the
    // transport `appUrlToProfileKey` already forces to https for a remote host.
    // That is a different class from the callback `iss`, which any party who can
    // land a redirect chooses, and which IS stripped from the message. Here the
    // operator has to see the published issuer to fix their configuration, and
    // the SDK renders it through `JSON.stringify`, so terminal control
    // characters are escaped rather than emitted.
    expect(err.message).toContain("/somewhere-else");
  });

  it("the browser is NEVER opened when discovery fails", async () => {
    const server = createServer((_req, res) => res.writeHead(404).end("nope"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    stop = () => new Promise((resolve) => server.close(resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = await freshEnv();
    let opened = 0;
    await runLogin({ appUrl: base, open: () => (opened += 1), log: () => {}, env }).catch(() => {});
    expect(opened).toBe(0);
  });
});

describe("the refresh path uses the same authorization-server URL", () => {
  it("refreshes a near-expiry profile against the /api/auth mount", async () => {
    // On `main` this failed identically to login: discovery ran against the bare
    // origin, returned `undefined`, and an expired profile was unrecoverable
    // without a fresh interactive sign-in — which also could not run.
    const { base, seen } = await startCinatraShapedInstance();
    const env = await freshEnv();

    const record = buildProfileRecord(
      {
        origin: base,
        clientInformation: { client_id: "dcr-client-203" },
        tokens: { access_token: "OLD", refresh_token: "RT-1", expires_in: 10 },
        resource: `${base}/api/cli`,
      },
      Date.now() - 5_000, // expires inside the refresh skew window
    );
    await saveProfile(base, record, {}, env);

    const out = await resolveAccessToken({ appUrl: base, env });
    expect(out.accessToken).toBe("AT-refreshed");
    expect(seen.paths).toContain("/.well-known/oauth-authorization-server/api/auth");
    expect(seen.paths).not.toContain("/.well-known/oauth-authorization-server");
    expect(seen.tokenForm.grant_type).toBe("refresh_token");
    expect(seen.tokenForm.refresh_token).toBe("RT-1");
    // The refreshed token stays bound to the `/api/cli` audience.
    expect(seen.tokenForm.resource).toBe(`${base}/api/cli`);
  });
});

describe("the narrowing this introduces, pinned rather than implied", () => {
  it("an authorization server that serves ONLY the ROOT document is no longer discovered", async () => {
    // Honest scope note. Before this change the bare origin was the ONLY target,
    // so a root-only authorization server whose `issuer` echoed that origin did
    // work. It is not reached any more, because the CLI now asks for the Cinatra
    // mount. This test exists so that trade-off is a recorded decision.
    //
    // The population is empty for this CLI: `--app-url` names a Cinatra
    // instance, every one of which serves the path-suffixed documents and NONE
    // of which serves the root ones (verified live, 2026-08-06). The same module
    // already hard-codes `/api/cli` for the RFC 8707 resource, so an instance
    // that moved its mounts is outside what this CLI supports either way.
    const { base } = await startCinatraShapedInstance({
      serveRootWellKnown: true,
      serveSuffixedWellKnown: false,
      issuerPath: "", // a root document must echo the bare origin to be valid
    });
    await expect(
      discoverAuthorizationServerMetadata(authorizationServerUrlFor(base), {
        protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION,
      }),
    ).resolves.toBeUndefined();
    // The old target would have found it — this is the delta, not a claim.
    await expect(
      discoverAuthorizationServerMetadata(base, {
        protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION,
      }),
    ).resolves.toMatchObject({ issuer: base });
  });

  it("the suffixed document wins when an instance serves BOTH", async () => {
    const { base, seen } = await startCinatraShapedInstance({ serveRootWellKnown: true });
    const metadata = await discoverAuthorizationServerMetadata(authorizationServerUrlFor(base), {
      protocolVersion: OAUTH_DISCOVERY_PROTOCOL_VERSION,
    });
    expect(metadata?.issuer).toBe(`${base}/api/auth`);
    expect(seen.paths).not.toContain("/.well-known/oauth-authorization-server");
  });
});
