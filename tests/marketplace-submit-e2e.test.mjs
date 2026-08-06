// REAL COMMAND end-to-end proof for the migrated marketplace MCP path
// (cinatra#2218, CLI leg).
//
// PROOF CLASS: real command, real library, loopback peer. This repo's discipline
// is that a CLI behaviour change is proven by RUNNING the command, not by
// importing its module — so this spawns the published entry point
// (`bin/cinatra.mjs extensions submit …`) as a real CHILD PROCESS, against a real
// `@modelcontextprotocol/server@2.0.0` peer over real loopback HTTP, with a real
// `npm pack`-shaped tarball on disk. Nothing is mocked and nothing is stubbed.
//
// LABELLED HONESTLY — the one leg that is NOT live: the PEER. The production
// marketplace is a WordPress plugin, it requires a vendor bearer token, and a
// submission MUTATES it, so a submit cannot be run against production from a
// test. The peer here is the reference server implementation standing in for it.
// The live evidence about the real peer's protocol behaviour is the separate
// (gated, anonymous, non-mutating) `marketplace-wire-negotiation.manual.test.mjs`.
// Together: this file proves the COMMAND works end to end over a real wire, that
// file proves the REAL PEER negotiates as this module expects.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { create as tarCreate } from "tar";

import { startMarketplacePeer } from "./helpers/marketplace-mcp-peer.mjs";

const BIN = resolve(fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url)));

let workDir;
let tarballPath;

/** Build a real .tgz with npm's `package/` prefix so pacote can read it. */
async function buildTarball(dir) {
  const pkgDir = join(dir, "package");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify(
      { name: "@acme/widget", version: "1.2.3", description: "e2e fixture", cinatra: { kind: "skill" } },
      null,
      2,
    ),
  );
  await writeFile(join(pkgDir, "README.md"), "# widget\n");
  const out = join(dir, "acme-widget-1.2.3.tgz");
  await tarCreate({ gzip: true, cwd: dir, file: out }, ["package"]);
  return out;
}

/**
 * Run the real CLI as a child process.
 *
 * ASYNC spawn, deliberately — NOT the `spawnSync` the rest of this suite's
 * child-process tests use. The MCP peer runs IN THIS PROCESS, so a synchronous
 * spawn would block the event loop that has to accept the child's connection:
 * the child would wait on a socket this process cannot answer until the child
 * exits, and both sides deadlock until the timeout. Sibling suites can use
 * `spawnSync` safely because nothing here has to serve the child while it runs.
 */
function runSubmit(extraEnv, args = []) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [BIN, "extensions", "submit", tarballPath, "--skip-dependency-check", ...args],
      {
        env: {
          ...process.env,
          // The base-URL override is honored only outside production — which is
          // itself part of what this exercises.
          NODE_ENV: "test",
          ...extraEnv,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cinatra-submit-e2e-"));
  tarballPath = await buildTarball(workDir);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("`cinatra extensions submit` — real command against a real MCP peer", () => {
  it("submits over the 2025-era wire and prints the marketplace's answer", async () => {
    const peer = await startMarketplacePeer({ era: "legacyOnly" });
    try {
      const res = await runSubmit({
        MARKETPLACE_BASE_URL: peer.baseUrl,
        CINATRA_MARKETPLACE_VENDOR_TOKEN: "vendor-token-1",
      });

      expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("submission_id: sub_123");
      expect(res.stdout).toContain("target:        @acme/widget@1.2.3");
      expect(res.stdout).toContain("status:        pending");

      // The negotiation actually happened on the wire in the child process:
      // the probe was issued, this peer refused it, and the legacy handshake ran.
      const probe = peer.frames.find((f) => f.rpcMethod === "server/discover");
      expect(probe, "auto must issue the probe").toBeDefined();
      expect(probe.status).toBe(400);
      expect(peer.frames.some((f) => f.rpcMethod === "initialize")).toBe(true);

      // The vendor token reached the peer as a Bearer on the tool call.
      const call = peer.frames.find((f) => f.rpcMethod === "tools/call");
      expect(call.requestHeaders.authorization).toBe("Bearer vendor-token-1");

      // The tool name is the flattened `cinatra-<kebab>` wire form.
      expect(call.body).toContain("cinatra-extension-submit-for-review");
      // The identity the CLI derived FROM THE TARBALL reached the peer — read
      // off the recorded frame rather than echoed back by the peer, so this
      // asserts what the command actually sent.
      const sent = JSON.parse(call.body).params.arguments;
      expect(sent.namespace).toBe("@acme");
      expect(sent.extension_name).toBe("widget");
      expect(sent.version).toBe("1.2.3");
      // ...along with the digest/size/bytes the marketplace re-verifies.
      expect(sent.artifact_digest_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(sent.artifact_size_bytes).toBeGreaterThan(0);
      expect(typeof sent.tarball_base64).toBe("string");
    } finally {
      await peer.close();
    }
  }, 90_000);

  it("submits over the MODERN 2026-07-28 wire against a peer that answers the probe", async () => {
    // The point of the migration: the v1 line could not reach this revision at all.
    const peer = await startMarketplacePeer({ era: "modern" });
    try {
      const res = await runSubmit({
        MARKETPLACE_BASE_URL: peer.baseUrl,
        CINATRA_MARKETPLACE_VENDOR_TOKEN: "vendor-token-2",
      });
      expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain("submission_id: sub_123");

      const call = peer.frames.find((f) => f.rpcMethod === "tools/call");
      expect(call.requestHeaders["mcp-protocol-version"]).toBe("2026-07-28");
      expect(call.requestHeaders["mcp-method"]).toBe("tools/call");
      expect(peer.frames.some((f) => f.rpcMethod === "initialize")).toBe(false);
    } finally {
      await peer.close();
    }
  }, 90_000);

  it("surfaces a marketplace tool error on stderr and exits non-zero", async () => {
    const peer = await startMarketplacePeer({ era: "legacyOnly", isError: true });
    try {
      const res = await runSubmit({
        MARKETPLACE_BASE_URL: peer.baseUrl,
        CINATRA_MARKETPLACE_VENDOR_TOKEN: "vendor-token-3",
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(
        "Marketplace extension_submit_for_review returned an error: vendor not approved",
      );
    } finally {
      await peer.close();
    }
  }, 90_000);

  it("refuses to submit with no token, before opening any connection", async () => {
    const peer = await startMarketplacePeer({ era: "legacyOnly" });
    try {
      const res = await runSubmit({
        MARKETPLACE_BASE_URL: peer.baseUrl,
        CINATRA_MARKETPLACE_VENDOR_TOKEN: "",
        MARKETPLACE_INSTANCE_TOKEN: "",
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("No marketplace token set");
      expect(peer.frames, "no frames may reach the peer").toHaveLength(0);
    } finally {
      await peer.close();
    }
  }, 90_000);
});
