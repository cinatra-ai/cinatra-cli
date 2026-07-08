// cinatra-cli#113 — `cinatra instance a2a` must reject a `--tailscale-authkey`
// flag BEFORE any error path echoes argv, so the secret never leaks in an
// "unexpected argument" / "unknown sub-command" message. Mirrors the guard the
// sibling lifecycle/CMS paths apply as their first step. The guard runs before
// any docker/registry/fs access, so these calls never touch a real stack.

import { describe, expect, it } from "vitest";

import { runIsolatedA2aPeers } from "../src/install.mjs";

// A neutral sentinel (NOT a real Tailscale key shape): the guard matches the
// FLAG NAME, never the value, so realism adds no coverage and only risks a
// secret-scan false positive. We assert this value never appears in any error.
const SECRET = "NOT-A-REAL-KEY-sentinel-do-not-echo-42";

const capture = (argv) => runIsolatedA2aPeers(argv).then(() => null, (e) => e);

describe("runIsolatedA2aPeers — --tailscale-authkey guard", () => {
  it("rejects the equals form in the verb position without echoing the secret", async () => {
    const err = await capture([`--tailscale-authkey=${SECRET}`]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/--tailscale-authkey is not accepted/);
    expect(err.message).not.toContain(SECRET);
  });

  it("rejects the flag as a trailing token after `start` (the echo-leak path)", async () => {
    const err = await capture(["start", `--tailscale-authkey=${SECRET}`]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/--tailscale-authkey is not accepted/);
    expect(err.message).not.toContain(SECRET);
  });

  it("rejects the space form (`--tailscale-authkey <value>`) without echoing the value", async () => {
    const err = await capture(["start", "--tailscale-authkey", SECRET]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/--tailscale-authkey is not accepted/);
    expect(err.message).not.toContain(SECRET);
  });

  it("still rejects an ordinary unexpected token (guard does not swallow the arg check)", async () => {
    const err = await capture(["start", "--bogus"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Unexpected argument/);
  });
});
