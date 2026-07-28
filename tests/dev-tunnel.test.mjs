// Hermetic guard for `cinatra instance tunnel`.
//
// `runDevTunnel`'s `start` path requires Docker + Tailscale + a Nango
// token + the main app DB, so it CANNOT be exercised end-to-end in a
// hermetic unit test. What this suite locks instead is the set of
// safety-critical STRUCTURAL invariants, none of which need Docker/network:
//
//   1. REUSE, NOT DUPLICATION: the clone-start provisioning helpers are
//      each defined EXACTLY ONCE in index.mjs. `runDevTunnel` must call
//      them by reference, never fork a copy. A copy-paste would make this
//      assertion fail.
//
//   2. DEV-ONLY HARD REFUSAL: invoking `dev tunnel <action>` with
//      CINATRA_RUNTIME_MODE=production throws the `development-only`
//      refusal BEFORE any Docker / Nango / DB side effect. The gate is
//      the very first thing after reading env.
//
//   3. CLONE-START PARITY: `runDevTunnel` uses the SAME shared hostname
//      decision module (`verifyRegisteredHostnameMatchesPrediction` +
//      `shouldWritePublicBaseUrl`) and carries the byte-identical
//      optimistic-write + one-honest-log-line markers as `runCloneStart`.
//      The dead detached poll must stay removed from both paths.
//
// All three are asserted from the index.mjs SOURCE TEXT (1 + 3) or via a
// `runCli` call that throws before touching anything (2).

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  TAILSCALE_SERVE_FQDN_KEY,
  buildTailscaleServeConfig,
  runCli,
  writeTailscaleServeConfig,
} from "../src/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(
  path.join(HERE, "..", "src", "index.mjs"),
  "utf8",
);

function defCount(name) {
  // function declarations only (`function NAME(` / `async function NAME(`).
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  return (INDEX_SRC.match(re) ?? []).length;
}

// --- 1. reuse, not duplication -------------------------------------------

describe("dev tunnel — reuses clone-start machinery (no duplication)", () => {
  it("runDevTunnel is defined exactly once", () => {
    expect(defCount("runDevTunnel")).toBe(1);
  });

  it.each([
    "renderCloneComposeTemplate",
    "writeTailscaleServeConfig",
    "waitForTailscaleFunnelUrl",
    "writeClonePublicBaseUrl",
    "autoMintTailscaleAuthKeyFromNango",
    "probeHttp",
  ])("clone-start helper %s is defined exactly once (not forked)", (name) => {
    expect(defCount(name)).toBe(1);
  });

  it("runDevTunnel calls the shared helpers by reference", () => {
    // Slice out the runDevTunnel body so we assert the *call sites* live
    // inside it (not merely somewhere in the file).
    const start = INDEX_SRC.indexOf("async function runDevTunnel(");
    expect(start).toBeGreaterThan(-1);
    const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
    expect(nextFn).toBeGreaterThan(start);
    const body = INDEX_SRC.slice(start, nextFn);
    for (const helper of [
      "renderCloneComposeTemplate(",
      "writeTailscaleServeConfig(",
      "waitForTailscaleFunnelUrl(",
      "writeClonePublicBaseUrl(",
      "autoMintTailscaleAuthKeyFromNango(",
      "verifyRegisteredHostnameMatchesPrediction(",
      "shouldWritePublicBaseUrl(",
      "cloneComposePath(",
      "cloneTailscaleServePath(",
      "cloneComposeProjectName(",
      "cloneRuntimeDir(",
      // cinatra#2172 — the hostname comes from the single-source-of-truth
      // CLASSIFIER, never the retired fallthrough derivation.
      "classifyDevTunnelIdentityFromModule(",
      "devTunnelRuntimeSlug(",
    ]) {
      expect(body.includes(helper)).toBe(true);
    }
    // The retired derivation must NOT be called here: it fell through to the
    // reserved main hostname for any unclassifiable instance.
    expect(body.includes("deriveDevTailscaleHostname(")).toBe(false);
  });
});

// --- 2. dev-only hard refusal --------------------------------------------

describe("dev tunnel — development-only hard gate", () => {
  it.each(["start", "stop", "status"])(
    "refuses `instance tunnel %s` under CINATRA_RUNTIME_MODE=production before any side effect",
    async (action) => {
      const prev = process.env.CINATRA_RUNTIME_MODE;
      process.env.CINATRA_RUNTIME_MODE = "production";
      try {
        await expect(runCli(["instance", "tunnel", action])).rejects.toThrow(
          /cinatra instance tunnel is development-only/,
        );
      } finally {
        if (prev === undefined) delete process.env.CINATRA_RUNTIME_MODE;
        else process.env.CINATRA_RUNTIME_MODE = prev;
      }
    },
  );

  it("rejects an unknown instance tunnel sub-command", async () => {
    const prev = process.env.CINATRA_RUNTIME_MODE;
    // Even in development mode, a bad sub-action must throw the usage
    // error (sub-action parse happens before the dev gate is moot).
    process.env.CINATRA_RUNTIME_MODE = "development";
    try {
      await expect(runCli(["instance", "tunnel", "bogus"])).rejects.toThrow(
        /Unknown 'cinatra instance tunnel' sub-command/,
      );
    } finally {
      if (prev === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prev;
    }
  });
});

// --- 3. clone-start parity ------------------------------------------------

describe("dev tunnel — matches runCloneStart hostname and public URL behavior", () => {
  const start = INDEX_SRC.indexOf("async function runDevTunnel(");
  const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
  const body = INDEX_SRC.slice(start, nextFn);

  it("guards the RAW registered Self.DNSName without circular validation", () => {
    expect(
      body.includes(
        "verifyRegisteredHostnameMatchesPrediction({\n      registered: registeredDnsName,",
      ),
    ).toBe(true);
  });

  it("writes publicBaseUrl optimistically gated only by shouldWritePublicBaseUrl", () => {
    expect(
      body.includes(
        "if (shouldWritePublicBaseUrl({ funnelUrl, hostnameCheck })) {",
      ),
    ).toBe(true);
    expect(
      body.includes(
        "await writeClonePublicBaseUrl(mainDbUrl, funnelUrl, { source: urlSource, schemaName: mainSchema })",
      ),
    ).toBe(true);
  });

  it("preserves the tailscale-auto / tailscale-funnel source tagging", () => {
    expect(
      body.includes(
        'tailscaleAuthkeySource === "nango" ? "tailscale-auto" : "tailscale-funnel"',
      ),
    ).toBe(true);
  });

  it("honors the resolved SUPABASE_SCHEMA in EVERY main-DB metadata read/write — never a hardcoded \"cinatra\" (Step 3 must-fix)", () => {
    // No main-DB metadata read/write inside runDevTunnel may pass the hardcoded
    // schema literal `"cinatra"`. The start-path write threads `schemaName:
    // mainSchema`; the status/stop reads pass `mainSchema` as the schema arg.
    expect(body.includes('readMetadataValue(\n          client,\n          mainSchema,')).toBe(true);
    expect(body.includes("{ schemaName: mainSchema }")).toBe(true);
    expect(body.includes("schemaName: mainSchema })")).toBe(true);
    // The only remaining `"cinatra"` is the env fallback default, never a
    // metadata-call schema argument.
    expect(body.includes('readMetadataValue(\n          client,\n          "cinatra"')).toBe(false);
  });

  it("emits ONE honest informational log line, NOT a probe", () => {
    // The detached 5-minute /api/mcp/health poll must stay deleted. It is
    // architecturally incoherent in a one-shot CLI: it can run once, then
    // the process exits on event-loop drain. The optimistic write is
    // followed by a single accurate log line; reachability is propagation
    // timing outside the CLI lifecycle.
    expect(
      body.includes("publicBaseUrl written (source: ${urlSource}). Tailscale Funnel"),
    ).toBe(true);
    expect(body.includes("(One-shot CLI does not ")).toBe(true);
    // The dead poll's /api/mcp/health PROBE CALL must be entirely gone
    // (no probe of pollFunnelUrl anywhere in runDevTunnel).
    const probeCalls =
      body.match(/probeHttp\(`\$\{pollFunnelUrl\}\/api\/mcp\/health`/g)
        ?.length ?? 0;
    expect(probeCalls).toBe(0);
  });

  it("keeps the dev-tunnel Tailscale block free of setTimeout or detached polling", () => {
    // Hard guard against the dead 5-min poll IIFE returning. None of the
    // poll's structural signatures may exist anywhere in runDevTunnel.
    expect(body.includes("void (async () => {")).toBe(false);
    expect(body.includes("setTimeout(")).toBe(false);
    expect(body.includes("timer.unref")).toBe(false);
    expect(body.includes("pollProjectName")).toBe(false);
    expect(body.includes("pollFunnelUrl")).toBe(false);
    expect(body.includes("MCP health via Funnel")).toBe(false);
    expect(body.includes("background check")).toBe(false);
    expect(body.includes("not yet reachable after 5m")).toBe(false);
    // Nor the old synchronous probe gate.
    expect(body.includes("mcpProbe")).toBe(false);
  });

  it("fails loud with NO write on a hostname-collision mismatch", () => {
    // Guard mismatch ⇒ shouldWritePublicBaseUrl returns false ⇒ the typed
    // TailscaleProvisionError branch logs "publicBaseUrl NOT written" and
    // no writeClonePublicBaseUrl runs on that path.
    expect(body.includes("const err = hostnameCheck.error;")).toBe(true);
    expect(body.includes("err instanceof TailscaleProvisionError")).toBe(true);
    expect(body.includes("publicBaseUrl NOT written.")).toBe(true);
  });

  it("brings up ONLY the tailscale compose service with an inert WAYFLOW_PORT", () => {
    // Whitespace-insensitive on purpose: the assertion is about the compose
    // ARGUMENTS (only the `tailscale` service is started), not about how deeply
    // the array happens to be indented (cinatra-cli#176 nests it inside the
    // teardown guard).
    expect(/"up",\s*"-d",\s*"tailscale",/.test(body)).toBe(true);
    expect(body.includes("DEV_MAIN_UNUSED_WAYFLOW_PORT")).toBe(true);
  });

  it("keys runtime state by the DERIVED identity slug and asserts no real clone collides", () => {
    // cinatra#2172 — the reserved slug is no longer hardcoded into every run;
    // it is one possible OUTPUT of the identity→slug mapping (declared main
    // only). The registry-collision guard follows the derived slug.
    expect(body.includes("const tunnelSlug = devTunnelRuntimeSlug(identity);")).toBe(true);
    expect(
      body.includes("getClone(readRegistry(defaultRegistryPath()), tunnelSlug)"),
    ).toBe(true);
    for (const keyed of [
      "cloneRuntimeDir(tunnelSlug)",
      "cloneComposePath(tunnelSlug)",
      "cloneTailscaleServePath(tunnelSlug)",
      "cloneComposeProjectName(tunnelSlug, DEV_MAIN_INDEX)",
    ]) {
      expect(body.includes(keyed)).toBe(true);
    }
    // No runtime path may be built from the reserved slug directly.
    expect(body.includes("(DEV_MAIN_SLUG)")).toBe(false);
  });

  it("refuses an unsanctioned identity BEFORE any path/registry/Docker work", () => {
    // Ordering is the whole safety property: the identity gate must sit above
    // the first `cloneRuntimeDir(` in the function body.
    const gate = body.indexOf("classifyDevTunnelIdentityFromModule(");
    const firstPath = body.indexOf("cloneRuntimeDir(");
    const firstRegistry = body.indexOf("readRegistry(");
    const firstCompose = body.indexOf("isComposeProjectUp(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstPath);
    expect(gate).toBeLessThan(firstRegistry);
    expect(gate).toBeLessThan(firstCompose);
    expect(body.includes("if (!identity.ok)")).toBe(true);
  });

  it("proves runtime-directory ownership before writing into it", () => {
    const assertOwner = body.indexOf("assertDevTunnelRuntimeDirOwnership({");
    const claimOwner = body.indexOf("claimDevTunnelRuntimeDir({");
    const writeServe = body.indexOf("writeTailscaleServeConfig({");
    const renderCompose = body.indexOf("renderCloneComposeTemplate({");
    expect(assertOwner).toBeGreaterThan(-1);
    expect(assertOwner).toBeLessThan(writeServe);
    expect(assertOwner).toBeLessThan(renderCompose);
    // cinatra-cli#177 leans on this ordering: the CLAIM (manifest write) lands
    // BEFORE the serve config, so a manifest-less dir holding a serve config is
    // by construction legacy (hostname-keyed) — the adoption check depends on
    // never meeting a post-#177 placeholder config without a manifest.
    expect(claimOwner).toBeGreaterThan(assertOwner);
    expect(claimOwner).toBeLessThan(writeServe);
    expect(claimOwner).toBeLessThan(renderCompose);
  });
});

// --- 4. Step 3 helper preserves the poller-removal invariant --------------
//
// cinatra#260 Step 3 adds `ensureDevPublicMcpUrl`, which reads the live Funnel
// ONE-SHOT at setup and may auto-bring-up the tunnel. It must NOT reintroduce
// the dead detached poll the dev-tunnel work removed: no setTimeout, no
// background IIFE, no reachability poll. Asserted from the helper's SOURCE.

describe("ensureDevPublicMcpUrl — one-shot read, NO reintroduced poller", () => {
  const start = INDEX_SRC.indexOf("async function ensureDevPublicMcpUrl(");
  const nextFn = INDEX_SRC.indexOf("\nasync function runCloneStart(", start);
  const body = INDEX_SRC.slice(start, nextFn);

  it("the helper is defined exactly once", () => {
    expect(defCount("ensureDevPublicMcpUrl")).toBe(1);
    expect(start).toBeGreaterThan(-1);
    expect(nextFn).toBeGreaterThan(start);
  });

  it("contains NO background-poll signatures (the dead detached poll stays removed)", () => {
    expect(body.includes("void (async () => {")).toBe(false);
    expect(body.includes("setTimeout(")).toBe(false);
    expect(body.includes("setInterval(")).toBe(false);
    expect(body.includes(".unref(")).toBe(false);
    expect(body.includes("pollFunnelUrl")).toBe(false);
    expect(body.includes("pollProjectName")).toBe(false);
    // No reachability / HTTP probe of the funnel URL (ownership ≠ reachability).
    expect(body.includes("probeHttp(")).toBe(false);
    expect(body.includes("/api/mcp/health")).toBe(false);
    expect(body.includes("fetch(")).toBe(false);
  });

  it("reuses the shared ownership-decision helpers by reference", () => {
    expect(body.includes("verifyRegisteredHostnameMatchesPrediction")).toBe(true);
    expect(body.includes("shouldWritePublicBaseUrl(")).toBe(true);
    expect(body.includes("waitForTailscaleFunnelUrl")).toBe(true);
  });

  it("brings the tunnel up via runDevTunnel(['start']) — never forks tunnel logic", () => {
    expect(body.includes('bringUpTunnel(["start"])')).toBe(true);
  });

  it("uses a BOUNDED short read (timeoutMs), not an unbounded loop", () => {
    expect(body.includes("timeoutMs: 3_000")).toBe(true);
  });
});

// --- 5. Step 3 auto-bring-up Docker spawns are BOUNDED (no setup hang) -----
//
// codex must-fix: the auto-bring-up path (`cinatra instance setup dev` → runDevTunnel
// "start") calls `docker build` (ensureWayflowImage) and `docker compose up`.
// Both must carry a finite `timeout` so a hung docker can never block setup.

describe("auto-bring-up Docker spawns carry a finite timeout (Step 3 must-fix)", () => {
  it("defines finite bound constants for the build + compose-up", () => {
    expect(INDEX_SRC.includes("const WAYFLOW_BUILD_TIMEOUT_MS = 600_000;")).toBe(true);
    expect(INDEX_SRC.includes("const COMPOSE_UP_TIMEOUT_MS = 120_000;")).toBe(true);
  });

  it("bounds the wayflow image build spawn", () => {
    const i = INDEX_SRC.indexOf('"build", "-t", "cinatra-wayflow:local"');
    expect(i).toBeGreaterThan(-1);
    // Window covers the spawnSync options block (a comment sits between the
    // args array and the options, so reach past it).
    const window = INDEX_SRC.slice(i, i + 900);
    expect(window.includes("timeout: WAYFLOW_BUILD_TIMEOUT_MS")).toBe(true);
  });

  it("bounds the dev-tunnel `compose up -d tailscale` spawn", () => {
    const start = INDEX_SRC.indexOf("async function runDevTunnel(");
    const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
    const devBody = INDEX_SRC.slice(start, nextFn);
    expect(devBody.includes("timeout: COMPOSE_UP_TIMEOUT_MS")).toBe(true);
    // The bring-up throw recognizes the timeout case so it surfaces as a
    // soft-failed bring-up, not a silent success.
    expect(devBody.includes('upResult.error?.code === "ETIMEDOUT"')).toBe(true);
  });

  it("bounds the inner `tailscale status` exec so the Funnel-wait loop can never hang", () => {
    // codex must-fix: a HUNG `docker compose exec … tailscale status` would
    // never let the timeoutMs loop deadline be reached → setup auto-bring-up
    // could hang. The per-spawn timeout kills a stuck exec.
    expect(INDEX_SRC.includes("const TAILSCALE_STATUS_SPAWN_TIMEOUT_MS = 10_000;")).toBe(true);
    const i = INDEX_SRC.indexOf("async function waitForTailscaleFunnelUrl(");
    expect(i).toBeGreaterThan(-1);
    const window = INDEX_SRC.slice(i, i + 1200);
    expect(window.includes("timeout: TAILSCALE_STATUS_SPAWN_TIMEOUT_MS")).toBe(true);
  });

  it("bounds the fast docker-CLI metadata probes reached by setup auto-bring-up", () => {
    // codex round-3 must-fix: `compose version` (isComposeAvailable),
    // `compose ps` (isComposeProjectUp), and `image inspect` (ensureWayflowImage)
    // are now on the `cinatra instance setup dev` path before the bounded build/up/status
    // calls. A hung docker CLI must not block setup.
    expect(INDEX_SRC.includes("const DOCKER_CLI_PROBE_TIMEOUT_MS = 15_000;")).toBe(true);
    for (const anchor of [
      "function isComposeAvailable(",
      "function isComposeProjectUp(",
      '"image", "inspect", "cinatra-wayflow:local"',
    ]) {
      const i = INDEX_SRC.indexOf(anchor);
      expect(i).toBeGreaterThan(-1);
      const window = INDEX_SRC.slice(i, i + 600);
      expect(window.includes("timeout: DOCKER_CLI_PROBE_TIMEOUT_MS")).toBe(true);
    }
  });
});

// --- 6. cinatra-cli#176: the start path is never left half-up ------------------
//
// `runDevTunnel` brings the Tailscale sidecar up and only then reads the
// registered identity, checks it, and writes `publicBaseUrl`. Every step in
// that window can throw; an unguarded throw leaves a registered node with no
// URL, which the next `start` reports as "already running". The behavioural
// contract of the guard itself is covered hermetically in
// tests/dev-tunnel-cleanup.test.mjs; what is asserted here — from the SOURCE,
// because this path needs Docker + Tailscale + a DB — is that the start path
// actually routes through it, and that the teardown is reused, not forked.

describe("dev tunnel — post-sidecar failures tear the sidecar down (cinatra-cli#176)", () => {
  const start = INDEX_SRC.indexOf("async function runDevTunnel(");
  const nextFn = INDEX_SRC.indexOf("\nfunction readPidFromFile(", start);
  const body = INDEX_SRC.slice(start, nextFn);
  // `status` reads the Funnel and runs the hostname check too — scope every
  // ordering assertion to the START branch, which is the one that owns a
  // sidecar it can leave half-up.
  const startBranch = body.slice(body.indexOf('// --- action === "start"'));

  it("wraps the post-sidecar segment in the teardown guard", () => {
    expect(start).toBeGreaterThan(-1);
    expect(nextFn).toBeGreaterThan(start);
    expect(body.includes("runPostSidecarProvisioning(")).toBe(true);
    // The guard is imported as a module, not re-implemented inline.
    expect(
      INDEX_SRC.includes(
        'import { runPostSidecarProvisioning } from "./dev-tunnel-cleanup.mjs";',
      ),
    ).toBe(true);
  });

  it("the guarded window opens BEFORE the `compose up` spawn and closes ON the write", () => {
    const guardIndex = startBranch.indexOf("runPostSidecarProvisioning(");
    const upIndex = startBranch.indexOf('"up",');
    const writeIndex = startBranch.indexOf(
      "await writeClonePublicBaseUrl(mainDbUrl, funnelUrl",
    );
    const markIndex = startBranch.indexOf("markProvisioned();");
    expect(guardIndex).toBeGreaterThan(-1);
    // codex must-fix: `compose up` can leave a container behind on its own
    // error/timeout path, so the up spawn AND its throw sit inside the guard.
    expect(upIndex).toBeGreaterThan(guardIndex);
    expect(startBranch.indexOf("docker compose up failed")).toBeGreaterThan(guardIndex);
    expect(writeIndex).toBeGreaterThan(guardIndex);
    // The durable write closes the guard — a later throw must not undo a
    // legitimately provisioned tunnel.
    expect(markIndex).toBeGreaterThan(writeIndex);
  });

  it("every fallible sidecar-owning call sits INSIDE the guarded window", () => {
    const guardIndex = startBranch.indexOf("runPostSidecarProvisioning(");
    expect(guardIndex).toBeGreaterThan(-1);
    for (const call of [
      'spawnSync("docker", upArgs',
      "waitForTailscaleFunnelUrl({",
      "verifyRegisteredHostnameMatchesPrediction({",
      "writeClonePublicBaseUrl(mainDbUrl, funnelUrl",
    ]) {
      expect(startBranch.indexOf(call)).toBeGreaterThan(guardIndex);
    }
  });

  it("bounds the cleanup `compose down` and names a teardown that could not finish", () => {
    const i = INDEX_SRC.indexOf("function tearDownDevTunnelSidecar(");
    expect(i).toBeGreaterThan(-1);
    const helperSrc = INDEX_SRC.slice(i, INDEX_SRC.indexOf("\n}\n", i));
    // CODE only — the rationale comments legitimately name the probe.
    const helper = helperSrc
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    // A hung teardown would hang the very command that is already failing.
    expect(INDEX_SRC.includes("const COMPOSE_DOWN_TIMEOUT_MS = 120_000;")).toBe(true);
    expect(helper.includes("timeout: COMPOSE_DOWN_TIMEOUT_MS")).toBe(true);
    // codex round-2 must-fix: `isComposeAvailable()` is false for BOTH "docker
    // absent" and "the probe hung", so it must NOT short-circuit the teardown
    // into a claimed success — the `down` is always attempted once a compose
    // file exists.
    expect(helper.includes("isComposeAvailable()")).toBe(false);
    // codex must-fix: a cleanup that could not complete is surfaced, not
    // silently dropped — only the operator can finish it.
    expect(startBranch.includes("cinatra instance tunnel stop`")).toBe(true);
  });

  it("tears down through the SHARED helper, defined exactly once", () => {
    expect(defCount("tearDownDevTunnelSidecar")).toBe(1);
    expect(body.includes("tearDownDevTunnelSidecar({ projectName, composePath })")).toBe(
      true,
    );
    // `stop` uses the same helper — the teardown is never duplicated.
    const stopBranch = body.slice(
      body.indexOf('if (action === "stop") {'),
      body.indexOf("// --- action === \"start\""),
    );
    expect(stopBranch.includes("tearDownDevTunnelSidecar(")).toBe(true);
    expect(stopBranch.includes('"down"')).toBe(false);
  });
});

// --- 7. cinatra-cli#177: serve config keys are tailnet-qualified -----------
//
// tailscaled matches incoming Funnel conns against the serve-config Web /
// AllowFunnel keys and REJECTS anything else as unconfigured (`handleIngress:
// got ingress conn for unconfigured <host>.<tailnet>.ts.net:443; rejecting`
// in the daemon log; connect-then-TLS-EOF from outside). Keying on the bare
// device hostname produced exactly that rejection. The generated config
// therefore carries the LITERAL containerboot `${TS_CERT_DOMAIN}` placeholder,
// which the sidecar substitutes with the daemon-reported tailnet-qualified
// cert domain (MagicDNS collision suffix included) when applying
// TS_SERVE_CONFIG — the byte-level shape is pinned here hermetically; only
// the substitution itself needs a live daemon and stays out of unit scope.

describe("serve config — FQDN-keyed via ${TS_CERT_DOMAIN} (cinatra-cli#177)", () => {
  it("the key is the LITERAL containerboot placeholder (no JS interpolation)", () => {
    // The regression class this pins: a template literal (or an env-expanded
    // shell string) would swallow the placeholder at build time; containerboot
    // needs the exact bytes `${TS_CERT_DOMAIN}` in the file.
    expect(TAILSCALE_SERVE_FQDN_KEY).toBe("${TS_CERT_DOMAIN}:443");
  });

  it("builder is defined exactly once (not forked)", () => {
    expect(defCount("buildTailscaleServeConfig")).toBe(1);
  });

  it("keys Web + AllowFunnel on the placeholder — bridge networking (dev tunnel + default clone)", () => {
    expect(buildTailscaleServeConfig({ nextjsPort: 3100, hostNetwork: false })).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": {
          Handlers: { "/": { Proxy: "http://host.docker.internal:3100" } },
        },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
    });
  });

  it("keys Web + AllowFunnel on the placeholder — host networking (Linux clone affordance)", () => {
    expect(buildTailscaleServeConfig({ nextjsPort: 3105, hostNetwork: true })).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3105" } },
        },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
    });
  });

  it("writes the file BYTE-IDENTICAL to the built shape, FQDN-keyed only, mode 0600", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-cli177-serve-"));
    try {
      const servePath = path.join(dir, "state", "tailscale-serve.json");
      writeTailscaleServeConfig({ servePath, nextjsPort: 3111, hostNetwork: false });
      const bytes = readFileSync(servePath, "utf8");
      expect(bytes).toBe(
        JSON.stringify(
          buildTailscaleServeConfig({ nextjsPort: 3111, hostNetwork: false }),
          null,
          2,
        ),
      );
      const parsed = JSON.parse(bytes);
      // EXACTLY one Web key and one AllowFunnel key, both the placeholder —
      // no bare-hostname key can ride along.
      expect(Object.keys(parsed.Web)).toEqual(["${TS_CERT_DOMAIN}:443"]);
      expect(Object.keys(parsed.AllowFunnel)).toEqual(["${TS_CERT_DOMAIN}:443"]);
      expect(statSync(servePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serve-config generation is identity-INDEPENDENT (takes no hostname at all)", () => {
    // The identity/normalization path (cinatra#2172 fail-closed classifier)
    // decides the DEVICE hostname; the daemon then derives the FQDN itself.
    // No identity outcome may leak into the serve config — a mis-normalized
    // hostname must not be able to produce an unconfigured-ingress file.
    const buildStart = INDEX_SRC.indexOf("function buildTailscaleServeConfig(");
    const writeStart = INDEX_SRC.indexOf("function writeTailscaleServeConfig(");
    expect(buildStart).toBeGreaterThan(-1);
    expect(writeStart).toBeGreaterThan(buildStart);
    const writeEnd = INDEX_SRC.indexOf("\n}", writeStart);
    const helpers = INDEX_SRC.slice(buildStart, writeEnd);
    expect(helpers.includes("tailscaleHostname")).toBe(false);
    expect(helpers.includes("TAILSCALE_SERVE_FQDN_KEY")).toBe(true);
  });

  it("NO call site passes an identity hostname into the serve config", () => {
    // Sweeps the definition AND every call site (clone start, dev tunnel,
    // and any future one) in a single invariant. Paren-BALANCED slicing, not
    // first-`})`: a future nested call inside the args must not truncate the
    // inspected window and hide a hostname property behind it.
    const sliceBalancedParens = (src, from) => {
      const open = src.indexOf("(", from);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") {
          depth -= 1;
          if (depth === 0) return src.slice(from, i + 1);
        }
      }
      throw new Error("unbalanced parens after writeTailscaleServeConfig(");
    };
    let idx = INDEX_SRC.indexOf("writeTailscaleServeConfig({");
    let occurrences = 0;
    while (idx !== -1) {
      occurrences += 1;
      const args = sliceBalancedParens(INDEX_SRC, idx);
      expect(args.includes("tailscaleHostname")).toBe(false);
      idx = INDEX_SRC.indexOf("writeTailscaleServeConfig({", idx + 1);
    }
    // definition + clone-start call + dev-tunnel call.
    expect(occurrences).toBe(3);
  });
});
