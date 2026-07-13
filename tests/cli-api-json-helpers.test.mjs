// Tests for the loopback-aware JSON control-plane helpers added for
// `cinatra extensions reconcile` (cinatra-cli#126): cliApiGetJson /
// cliApiPostJson. They mirror the existing byte helpers' loopback dev-bypass
// (no Authorization header on a loopback target) and attach the HTTP status +
// server `code` to a non-2xx error so callers can branch (404 vs 409).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cliApiGetJson,
  cliApiPostJson,
  writeCredentialsStore,
  buildProfileRecord,
} from "../src/login.mjs";

let configDir;
let env;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "cinatra-json-helper-test-"));
  env = { XDG_CONFIG_HOME: configDir };
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

/** A fetch stub returning a JSON response with a given status. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    json: async () => body,
  };
}

describe("cliApiGetJson", () => {
  it("sends NO Authorization header to a loopback target (dev-bypass), and parses JSON", async () => {
    let seen;
    const fetchFn = async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { ok: true, candidates: [] });
    };
    const out = await cliApiGetJson("/api/cli/extensions/reconcile/plan", {
      appUrl: "http://localhost:3000",
      env,
      fetchFn,
    });
    expect(out).toEqual({ ok: true, candidates: [] });
    expect(seen.url).toBe("http://localhost:3000/api/cli/extensions/reconcile/plan");
    expect(seen.init.headers.authorization).toBeUndefined();
  });

  it("sends a Bearer to a non-loopback target from the saved profile", async () => {
    await writeCredentialsStore(
      {
        version: 1,
        defaultProfile: "https://inst",
        profiles: {
          "https://inst": buildProfileRecord({
            origin: "https://inst",
            clientInformation: { client_id: "c1" },
            tokens: { access_token: "AT", refresh_token: "RT", expires_in: 3600 },
          }),
        },
      },
      env,
    );
    let seen;
    const fetchFn = async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { ok: true });
    };
    await cliApiGetJson("/api/cli/extensions/reconcile/plan", {
      appUrl: "https://inst",
      env,
      fetchFn,
    });
    expect(seen.init.headers.authorization).toBe("Bearer AT");
  });

  it("throws an error carrying .status and .code on a non-2xx", async () => {
    const fetchFn = async () => jsonResponse(404, { error: "not served", code: "no-surface" });
    try {
      await cliApiGetJson("/x", { appUrl: "http://localhost:3000", env, fetchFn });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.status).toBe(404);
      expect(err.code).toBe("no-surface");
    }
  });
});

describe("cliApiPostJson", () => {
  it("serializes the JSON body with a JSON content-type and returns parsed JSON", async () => {
    let seen;
    const fetchFn = async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, { applied: [] });
    };
    const out = await cliApiPostJson(
      "/api/cli/extensions/reconcile/apply",
      { planDigest: "sha256:x" },
      { appUrl: "http://localhost:3000", env, fetchFn },
    );
    expect(out).toEqual({ applied: [] });
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen.init.body)).toEqual({ planDigest: "sha256:x" });
  });

  it("defaults a null/undefined body to {}", async () => {
    let seen;
    const fetchFn = async (url, init) => {
      seen = { url, init };
      return jsonResponse(200, {});
    };
    await cliApiPostJson("/x", undefined, { appUrl: "http://localhost:3000", env, fetchFn });
    expect(JSON.parse(seen.init.body)).toEqual({});
  });

  it("attaches .status/.code from a 409 mismatch response", async () => {
    const fetchFn = async () =>
      jsonResponse(409, { error: "stale", code: "plan-digest-mismatch" });
    try {
      await cliApiPostJson("/x", {}, { appUrl: "http://localhost:3000", env, fetchFn });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.status).toBe(409);
      expect(err.code).toBe("plan-digest-mismatch");
    }
  });
});
