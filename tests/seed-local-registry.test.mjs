// cinatra-cli#36 — seedLocalRegistryExtensions must honor a caller-supplied
// `registryUrl` so an ISOLATED instance publishes its bundled extensions into
// its OWN Verdaccio (the remapped host port from its .env.local), NOT a live
// donor's default :4873. These tests prove the URL threads through to the real
// reachability probe (the network surface that would otherwise hit the donor)
// and into the returned summary — without ever publishing (the probe is
// stubbed unreachable, which short-circuits before any pack/publish).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_REGISTRY_URL,
  isLoopbackRegistryUrl,
  seedLocalRegistryExtensions,
} from "../src/seed-local-registry.mjs";

describe("seedLocalRegistryExtensions — registryUrl threading (cinatra-cli#36)", () => {
  let fetchSpy;

  beforeEach(() => {
    // Stub the reachability probe to a network failure → the seed short-circuits
    // at "skipped-unreachable" (BEFORE any auth/pack/publish), but only AFTER it
    // has computed the publish target from `registryUrl`. The spy captures the
    // URL it probed so we can assert the caller's port — not the default :4873.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    // The seed helper is loud-but-non-fatal: a no-auth/skew path can set
    // process.exitCode=1. The unreachable/non-loopback short-circuits used here
    // do NOT, but reset defensively so a CI runner's exit code stays clean.
    process.exitCode = 0;
  });

  it("defaults to LOCAL_REGISTRY_URL (:4873) when no registryUrl is passed", async () => {
    const summary = await seedLocalRegistryExtensions({ repoRoot: "/nonexistent-repo" });
    expect(summary.registryUrl).toBe(LOCAL_REGISTRY_URL);
    expect(summary.status).toBe("skipped-unreachable");
    // The reachability probe targeted the DEFAULT registry.
    const probed = new URL(fetchSpy.mock.calls[0][0]);
    expect(probed.port).toBe("4873");
  });

  it("honors a passed loopback registryUrl — the isolated remapped port, not :4873", async () => {
    const isoUrl = "http://127.0.0.1:14873";
    const summary = await seedLocalRegistryExtensions({
      repoRoot: "/nonexistent-repo",
      registryUrl: isoUrl,
    });
    // The summary echoes the caller's target (so logs/diagnostics are accurate).
    expect(summary.registryUrl).toBe(isoUrl);
    expect(summary.status).toBe("skipped-unreachable");
    // CRITICAL: the actual network probe (the surface that would otherwise reach
    // the donor) used the ISOLATED port 14873, proving the URL plumbs all the
    // way through — not just into the summary object.
    expect(fetchSpy).toHaveBeenCalled();
    const probed = new URL(fetchSpy.mock.calls[0][0]);
    expect(probed.host).toBe("127.0.0.1:14873");
    expect(probed.port).toBe("14873");
  });

  it("refuses a NON-loopback registryUrl outright (never probes/publishes)", async () => {
    const remote = "https://registry.cinatra.ai";
    expect(isLoopbackRegistryUrl(remote)).toBe(false);
    const summary = await seedLocalRegistryExtensions({
      repoRoot: "/nonexistent-repo",
      registryUrl: remote,
    });
    expect(summary.status).toBe("skipped-not-loopback");
    expect(summary.registryUrl).toBe(remote);
    // The loopback guard fires BEFORE the reachability probe → no fetch at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
