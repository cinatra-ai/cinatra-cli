// Hermetic guard for `cinatra instance verify-exposure` (cinatra-cli#246).
//
// The mode's `up` path needs Docker + Tailscale + a Nango token, exactly like
// `instance tunnel`, so — as tests/dev-tunnel.test.mjs already establishes for
// that command — this suite does NOT drive a live Funnel. It locks the
// safety-critical pieces that need no network at all:
//
//   1. The MAPPING. The scoped serve-config builder emits ONLY an `/api/mcp`
//      handler — never the `"/"` catch-all the general-purpose command writes.
//      A handler key is a MOUNT POINT at the tunnel edge, though, so the edge
//      also forwards the key's descendants: the EXACT match is enforced one hop
//      later, by the proxy, and that is what block 2 drives for real.
//
//   2. The ACCESS-LOGGING PROXY. Driven for real against a stub upstream over
//      loopback: a marked request for the mapped path must reach the upstream
//      and leave one JSON line naming the method, the path, the marker and the
//      response status — while a DESCENDANT of the mapped path must be refused
//      by the proxy itself, never reach the upstream, and leave NO line at all.
//
//   3. The LIFECYCLE. `down` states plainly that nothing was running, for
//      every reachable no-tunnel state, and never turns that into an error.
//
//   4. The CHECK's assertion logic, driven off fixture probe results + a
//      fixture proxy log: every path other than the exact mapped one is
//      refused at one fixed status AND absent from the proxy's log; the mapped
//      path is present in the log and answers the app's own documented
//      unauthenticated status.
//
//   5. NON-REGRESSION of the general-purpose `instance tunnel`, whose two
//      existing consumers (`instance setup dev`'s auto-bring-up and
//      `doctor --fix`) depend on its whole-app mapping.
//
//   6. The help/doc row that says which mode to reach for.

import { createServer } from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { cloneComposeProjectName, cloneRuntimeDir } from "../src/clone-runtime.mjs";
import { COMMAND_DESCRIPTORS, matchDescriptor } from "../src/command-table.mjs";
import { buildTailscaleServeConfig, runCli } from "../src/index.mjs";
import {
  VERIFICATION_EXPOSURE_ACCESS_LOG_MAX_BYTES,
  VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS,
  VERIFICATION_EXPOSURE_HEALTH_PATH,
  VERIFICATION_EXPOSURE_MAPPED_PATH,
  VERIFICATION_EXPOSURE_MARKER_HEADER,
  VERIFICATION_EXPOSURE_PROBE_PATHS,
  VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS,
  VERIFICATION_EXPOSURE_UNMAPPED_STATUS,
  appendAccessLogEntry,
  buildScopedTailscaleServeConfig,
  buildVerificationProbePlan,
  createAccessLoggingProxy,
  describeVerificationExposureDownOutcome,
  evaluateVerificationExposureCheck,
  acquireVerificationExposureLock,
  decideVerificationExposureProxyPort,
  listVerificationExposureArtifacts,
  readAccessLog,
  readAccessLogWithDiagnostics,
  verificationExposureAccessLogPath,
  verificationExposureComposeProjectName,
  verificationExposureLockPath,
  verificationExposureRuntimeDir,
  verificationExposureServePath,
  verificationExposureTailscaleHostname,
  writeScopedTailscaleServeConfig,
} from "../src/verification-exposure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");
const README_SRC = readFileSync(path.join(HERE, "..", "README.md"), "utf8");
const PROXY_RUNNER_SRC = readFileSync(
  path.join(HERE, "..", "src", "verification-exposure-proxy.mjs"),
  "utf8",
);

/** A stub app on loopback that RECORDS what actually reached it. */
async function withStubUpstream(fn) {
  const hits = [];
  const upstream = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url });
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise((ok) => upstream.listen(0, "127.0.0.1", ok));
  try {
    return await fn({ upstreamPort: upstream.address().port, hits });
  } finally {
    await new Promise((ok) => upstream.close(ok));
  }
}

/** The real proxy, bound on loopback, with its own temp log. */
async function withProxy({ upstreamPort, healthNonce = null }, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-cli246-proxy-"));
  const logPath = path.join(dir, "access.log");
  const server = createAccessLoggingProxy({
    upstreamHost: "127.0.0.1",
    upstreamPort,
    logPath,
    healthNonce,
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    return await fn({ server, proxyPort: server.address().port, logPath });
  } finally {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 1. the mapping admits ONLY the callback path -------------------------

describe("verification exposure — the mapping is only /api/mcp", () => {
  it("the mapped path is the app's MCP callback prefix", () => {
    expect(VERIFICATION_EXPOSURE_MAPPED_PATH).toBe("/api/mcp");
  });

  it("builds Handlers with the mapped path as its ONLY key (bridge networking)", () => {
    expect(buildScopedTailscaleServeConfig({ proxyPort: 3399, hostNetwork: false })).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": {
          Handlers: { "/api/mcp": { Proxy: "http://host.docker.internal:3399" } },
        },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
    });
  });

  it("builds Handlers with the mapped path as its ONLY key (host networking)", () => {
    expect(buildScopedTailscaleServeConfig({ proxyPort: 3399, hostNetwork: true })).toEqual({
      TCP: { 443: { HTTPS: true } },
      Web: {
        "${TS_CERT_DOMAIN}:443": {
          Handlers: { "/api/mcp": { Proxy: "http://127.0.0.1:3399" } },
        },
      },
      AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
    });
  });

  it("never emits the `/` catch-all the general-purpose command writes", () => {
    const scoped = buildScopedTailscaleServeConfig({ proxyPort: 3399, hostNetwork: false });
    const handlers = scoped.Web["${TS_CERT_DOMAIN}:443"].Handlers;
    expect(Object.keys(handlers)).toEqual(["/api/mcp"]);
    expect(Object.prototype.hasOwnProperty.call(handlers, "/")).toBe(false);
  });

  it("the handler key has NO trailing slash", () => {
    // A trailing slash would make the mount point read as a directory mount.
    // Either way the edge forwards descendants — which is why the exact match
    // is enforced at the proxy (block 2), not assumed of the edge.
    const handlers = buildScopedTailscaleServeConfig({ proxyPort: 3399, hostNetwork: false })
      .Web["${TS_CERT_DOMAIN}:443"].Handlers;
    for (const key of Object.keys(handlers)) {
      expect(key.endsWith("/")).toBe(false);
    }
  });

  it("writes the file byte-identical to the built shape, mode 0600, one handler", () => {
    withTempDir("cinatra-cli246-serve-", (dir) => {
      const servePath = path.join(dir, "state", "tailscale-serve.json");
      writeScopedTailscaleServeConfig({ servePath, proxyPort: 3401, hostNetwork: false });
      const bytes = readFileSync(servePath, "utf8");
      expect(bytes).toBe(
        JSON.stringify(
          buildScopedTailscaleServeConfig({ proxyPort: 3401, hostNetwork: false }),
          null,
          2,
        ),
      );
      const parsed = JSON.parse(bytes);
      expect(Object.keys(parsed.Web)).toEqual(["${TS_CERT_DOMAIN}:443"]);
      expect(Object.keys(parsed.Web["${TS_CERT_DOMAIN}:443"].Handlers)).toEqual(["/api/mcp"]);
      expect(statSync(servePath).mode & 0o777).toBe(0o600);
    });
  });
});

// --- 1b. runtime state is SEPARATE from `instance tunnel`'s ----------------

describe("verification exposure — runtime state is its own", () => {
  it("the runtime directory is disjoint from the general tunnel's clone runtime dir", () => {
    const home = "/tmp/does-not-exist-home";
    const mine = verificationExposureRuntimeDir("dev-main", { home });
    const theirs = cloneRuntimeDir("dev-main", { home });
    expect(mine).not.toBe(theirs);
    expect(mine.startsWith(theirs)).toBe(false);
    expect(theirs.startsWith(mine)).toBe(false);
  });

  it("the serve config and the access log live under that separate directory", () => {
    const home = "/tmp/does-not-exist-home";
    const root = verificationExposureRuntimeDir("dev-main", { home });
    expect(verificationExposureServePath("dev-main", { home }).startsWith(`${root}${path.sep}`)).toBe(true);
    expect(verificationExposureAccessLogPath("dev-main", { home }).startsWith(`${root}${path.sep}`)).toBe(true);
  });

  it("the compose project name cannot collide with the general tunnel's", () => {
    expect(verificationExposureComposeProjectName("dev-main")).not.toBe(
      cloneComposeProjectName("dev-main", 0),
    );
  });

  it("the tunnel device hostname cannot collide with the general tunnel's", () => {
    expect(verificationExposureTailscaleHostname("cinatra-dev-main")).not.toBe("cinatra-dev-main");
    expect(verificationExposureTailscaleHostname("cinatra-dev-main").length).toBeLessThanOrEqual(63);
  });
});

// --- 2. the loopback access-logging proxy ---------------------------------

describe("verification exposure — the access-logging proxy", () => {
  it("forwards a marked request to the app AND logs one JSON line for it", async () => {
    await new Promise((resolve, reject) => {
      const upstream = createServer((req, res) => {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
      });
      upstream.listen(0, "127.0.0.1", async () => {
        const upstreamPort = upstream.address().port;
        let proxy = null;
        const dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-cli246-proxy-"));
        const logPath = path.join(dir, "access.log");
        try {
          proxy = createAccessLoggingProxy({
            upstreamHost: "127.0.0.1",
            upstreamPort,
            logPath,
          });
          await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
          const proxyPort = proxy.address().port;
          const marker = "marker-abc123";
          const response = await fetch(`http://127.0.0.1:${proxyPort}/api/mcp`, {
            headers: { [VERIFICATION_EXPOSURE_MARKER_HEADER]: marker },
          });
          expect(response.status).toBe(401);

          const entries = readAccessLog(logPath);
          expect(entries.length).toBe(1);
          expect(entries[0].method).toBe("GET");
          expect(entries[0].path).toBe("/api/mcp");
          expect(entries[0].marker).toBe(marker);
          expect(entries[0].status).toBe(401);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          if (proxy) await new Promise((ok) => proxy.close(ok));
          await new Promise((ok) => upstream.close(ok));
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  });

  it("REFUSES a descendant of the mapped path: no upstream request, no log line", async () => {
    // The tunnel edge treats a handler key as a mount point, so it DOES forward
    // `/api/mcp/anything` to this proxy. The exact match is the proxy's job,
    // and this is the test that proves it does it: the upstream must never be
    // called, and the access log — which means "was forwarded to the app" —
    // must stay empty, which is exactly what the built-in check asserts.
    await withStubUpstream(async ({ upstreamPort, hits }) => {
      await withProxy({ upstreamPort }, async ({ proxyPort, logPath }) => {
        for (const probePath of ["/api/mcp/anything", "/api/mcp/", "/", "/sign-in"]) {
          const response = await fetch(`http://127.0.0.1:${proxyPort}${probePath}`, {
            headers: { [VERIFICATION_EXPOSURE_MARKER_HEADER]: `m-${probePath}` },
          });
          expect(response.status, probePath).toBe(VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS);
        }
        expect(hits).toEqual([]);
        expect(readAccessLog(logPath)).toEqual([]);
      });
    });
  });

  it("answers its own identity nonce on loopback, and never logs that as traffic", async () => {
    await withStubUpstream(async ({ upstreamPort, hits }) => {
      await withProxy({ upstreamPort, healthNonce: "nonce-xyz" }, async ({ proxyPort, logPath }) => {
        const response = await fetch(
          `http://127.0.0.1:${proxyPort}${VERIFICATION_EXPOSURE_HEALTH_PATH}`,
        );
        expect(response.status).toBe(200);
        expect((await response.json()).nonce).toBe("nonce-xyz");
        expect(hits).toEqual([]);
        expect(readAccessLog(logPath)).toEqual([]);
      });
    });
  });

  it("binds loopback only (the mapping is the ONLY way in from outside)", async () => {
    // Not a source-text assertion: the server is actually bound and its own
    // address is read back.
    await withStubUpstream(async ({ upstreamPort }) => {
      await withProxy({ upstreamPort }, async ({ server }) => {
        expect(server.address().address).toBe("127.0.0.1");
      });
    });
    // And the detached runner — the process `up` actually spawns — binds the
    // same way, with no routable-interface fallback.
    expect(PROXY_RUNNER_SRC).toContain('server.listen(proxyPort, "127.0.0.1"');
    // Exactly one bind, and it is that one: no second, routable listener.
    expect(PROXY_RUNNER_SRC.match(/server\.listen\(/g)).toHaveLength(1);
  });

  it("reads back only well-formed JSON lines (a torn line is skipped, never thrown)", () => {
    withTempDir("cinatra-cli246-log-", (dir) => {
      const logPath = path.join(dir, "access.log");
      appendAccessLogEntry(logPath, { method: "GET", path: "/api/mcp", marker: "m1", status: 401 });
      appendAccessLogEntry(logPath, { method: "POST", path: "/api/mcp", marker: "m2", status: 401 });
      const entries = readAccessLog(logPath);
      expect(entries.map((e) => e.marker)).toEqual(["m1", "m2"]);
      expect(typeof entries[0].at).toBe("string");
    });
  });

  it("tolerates a TORN FINAL line but counts a malformed line in the body", () => {
    withTempDir("cinatra-cli246-torn-", (dir) => {
      const logPath = path.join(dir, "access.log");
      appendAccessLogEntry(logPath, { method: "GET", path: "/api/mcp", marker: "m1", status: 401 });
      // The proxy was killed mid-append: a record with no terminating newline.
      appendFileSync(logPath, '{"at":"2026-01-01T00:00:00.000Z","meth');
      const torn = readAccessLogWithDiagnostics(logPath);
      expect(torn.entries.map((e) => e.marker)).toEqual(["m1"]);
      expect(torn.tornFinalLine).toBe(true);
      expect(torn.malformedLines).toBe(0);

      // A damaged line in the BODY is different: a record was lost, and a lost
      // record could be the one proving an unmapped path was forwarded.
      const damagedPath = path.join(dir, "damaged.log");
      writeFileSync(damagedPath, '{"marker":"a"}\nnot json at all\n{"marker":"b"}\n');
      const damaged = readAccessLogWithDiagnostics(damagedPath);
      expect(damaged.malformedLines).toBe(1);
    });
  });

  it("rolls the access log at its cap — public traffic cannot grow it without bound", () => {
    withTempDir("cinatra-cli246-roll-", (dir) => {
      const logPath = path.join(dir, "access.log");
      writeFileSync(logPath, "x".repeat(VERIFICATION_EXPOSURE_ACCESS_LOG_MAX_BYTES));
      appendAccessLogEntry(logPath, { method: "GET", path: "/api/mcp", marker: "after", status: 401 });
      expect(existsSync(`${logPath}.1`)).toBe(true);
      // The current run's evidence is intact in the fresh file.
      expect(readAccessLog(logPath).map((e) => e.marker)).toEqual(["after"]);
    });
  });

  it("an absent log reads as no entries, not as a throw", () => {
    withTempDir("cinatra-cli246-nolog-", (dir) => {
      expect(readAccessLog(path.join(dir, "missing.log"))).toEqual([]);
    });
  });
});

// --- 3. up / status / down, and `down` is idempotent -----------------------

describe("verification exposure — lifecycle", () => {
  it("routes up / status / down / check", () => {
    for (const action of ["up", "status", "down", "check"]) {
      const d = matchDescriptor(COMMAND_DESCRIPTORS, ["instance", "verify-exposure", action]);
      expect(d, `no descriptor routes "instance verify-exposure ${action}"`).not.toBeNull();
      expect(d.id).not.toBe("dev.tunnel");
    }
  });

  it.each([
    ["no identity is resolvable", { identityResolvable: false, sidecarTornDown: false, proxyStopped: false }],
    ["an identity resolves but nothing is running", { identityResolvable: true, sidecarTornDown: false, proxyStopped: false }],
  ])("down states plainly that nothing was running when %s", (_label, state) => {
    const outcome = describeVerificationExposureDownOutcome(state);
    expect(outcome.nothingWasRunning).toBe(true);
    expect(outcome.message).toMatch(/nothing was running/);
  });

  it("down reports what it actually tore down when something WAS running", () => {
    const outcome = describeVerificationExposureDownOutcome({
      identityResolvable: true,
      sidecarTornDown: true,
      proxyStopped: true,
    });
    expect(outcome.nothingWasRunning).toBe(false);
    expect(outcome.message).not.toMatch(/nothing was running/);
  });

  it("down reports a lone proxy teardown as a real teardown", () => {
    const outcome = describeVerificationExposureDownOutcome({
      identityResolvable: true,
      sidecarTornDown: false,
      proxyStopped: true,
    });
    expect(outcome.nothingWasRunning).toBe(false);
  });

  it.each(["up", "status", "down", "check"])(
    "refuses `%s` under CINATRA_RUNTIME_MODE=production before any side effect",
    async (action) => {
      const prev = process.env.CINATRA_RUNTIME_MODE;
      process.env.CINATRA_RUNTIME_MODE = "production";
      try {
        await expect(runCli(["instance", "verify-exposure", action])).rejects.toThrow(
          /development-only/,
        );
      } finally {
        if (prev === undefined) delete process.env.CINATRA_RUNTIME_MODE;
        else process.env.CINATRA_RUNTIME_MODE = prev;
      }
    },
  );

  it("rejects an unknown sub-command by name", async () => {
    await expect(runCli(["instance", "verify-exposure", "bogus"])).rejects.toThrow(
      /verify-exposure/,
    );
  });

  it.each([
    ["--proxy-port", "3399x"],
    ["--refused-status", "40x"],
  ])("rejects a malformed %s value instead of silently truncating it", async (flag, value) => {
    await expect(
      runCli(["instance", "verify-exposure", "status", flag, value]),
    ).rejects.toThrow(/whole number/);
  });

  it("rejects an unexpected positional argument", async () => {
    await expect(
      runCli(["instance", "verify-exposure", "status", "extra"]),
    ).rejects.toThrow(/Unexpected/);
  });

  it("never signals a recorded pid it has not IDENTIFIED as its own proxy", () => {
    // A pid can be recycled: `down` must prove the process on the recorded port
    // answers with the recorded nonce before it sends a signal.
    const stopStart = INDEX_SRC.indexOf("async function stopVerifyExposureProxy(");
    expect(stopStart).toBeGreaterThan(-1);
    const body = INDEX_SRC.slice(stopStart, INDEX_SRC.indexOf("\n/**", stopStart));
    expect(body).toContain("indeterminate: true");
    // The signal is reachable only from the branch that proved ownership.
    expect(body).toMatch(/if \(live && ours\)[\s\S]*process\.kill/);
  });

  it("publishes NOTHING until the proxy has proved it is listening", () => {
    const start = INDEX_SRC.indexOf("async function startVerifyExposureProxy(");
    expect(start).toBeGreaterThan(-1);
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf("\n/**", start));
    expect(body).toContain("verifyExposureProxyIsOurs(");
    expect(body).toContain("killChild()");
    expect(body).toMatch(/did not come up/);
    // And `up` awaits that before it writes the mapping.
    const upIdx = INDEX_SRC.indexOf("const pid = await startVerifyExposureProxy(");
    const mappingIdx = INDEX_SRC.indexOf("writeScopedTailscaleServeConfig({");
    expect(upIdx).toBeGreaterThan(-1);
    expect(mappingIdx).toBeGreaterThan(upIdx);
  });

  it("tears the sidecar down whenever a compose file was rendered, not only when the probe says it is up", () => {
    // `isComposeProjectUp` answers false for BOTH "not running" and "docker did
    // not answer"; gating teardown on it would leave a live Funnel behind while
    // `down` reported success.
    const downIdx = INDEX_SRC.indexOf('  if (action === "down") {', INDEX_SRC.indexOf("async function runVerificationExposure("));
    const body = INDEX_SRC.slice(downIdx, INDEX_SRC.indexOf('  if (action === "check") {', downIdx));
    expect(body).toContain("if (composeRendered) {");
    expect(body).toContain("tearDownDevTunnelSidecar({ projectName, composePath })");
    expect(body).toContain("could not complete the tunnel");
  });

  it("down survives a runtime directory whose ownership cannot be proven and nothing is running", () => {
    const fnStart = INDEX_SRC.indexOf("async function runVerificationExposure(");
    const body = INDEX_SRC.slice(fnStart, INDEX_SRC.indexOf("\n// ---", fnStart));
    expect(body).toContain("assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity });");
    expect(body).toContain("const hasArtifacts =");
    // …but it still refuses when artifacts DO exist under an unprovable owner.
    expect(body).toContain("if (hasArtifacts || (action !== \"status\" && action !== \"down\")) throw err;");
  });
});

// --- 4. the built-in check ------------------------------------------------

describe("verification exposure — the built-in check", () => {
  it("probes the five documented paths, each with its own marker", () => {
    expect(VERIFICATION_EXPOSURE_PROBE_PATHS).toEqual([
      "/",
      "/sign-in",
      "/sign-up",
      "/api/mcp/anything",
      "/api/mcp",
    ]);
    const plan = buildVerificationProbePlan({ marker: "run7" });
    expect(plan.map((p) => p.path)).toEqual(VERIFICATION_EXPOSURE_PROBE_PATHS);
    expect(new Set(plan.map((p) => p.marker)).size).toBe(plan.length);
    for (const probe of plan) expect(probe.marker).toContain("run7");
  });

  it("pins the exact statuses it asserts against", () => {
    // The tunnel edge's own answer for a path it has no mount point for; this
    // repository's own proxy answer for a descendant the edge DOES forward; and
    // the app's own documented answer for an unauthenticated GET on the
    // callback path (cinatra-ai/cinatra#3130).
    expect(VERIFICATION_EXPOSURE_UNMAPPED_STATUS).toBe(404);
    expect(VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS).toBe(404);
    expect(VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS).toBe(401);
  });

  it("expects the DESCENDANT to be refused by the proxy, not by the edge", () => {
    // The two refusal statuses are separately pinned: an operator whose edge
    // answers something else pins it with --refused-status, and that must not
    // silently move the status expected of this repository's own proxy.
    const plan = buildVerificationProbePlan({ marker: "roles" });
    const probes = plan.map((p) => ({
      ...p,
      status:
        p.path === VERIFICATION_EXPOSURE_MAPPED_PATH
          ? VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS
          : p.path.startsWith(`${VERIFICATION_EXPOSURE_MAPPED_PATH}/`)
            ? VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS
            : 502,
    }));
    const mapped = probes.find((p) => p.path === VERIFICATION_EXPOSURE_MAPPED_PATH);
    const outcome = evaluateVerificationExposureCheck({
      probes,
      logEntries: [{ method: "GET", path: "/api/mcp", marker: mapped.marker, status: 401 }],
      unmappedStatus: 502,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.results.find((r) => r.path === "/api/mcp/anything").role).toBe(
      "refused-at-proxy",
    );
    expect(outcome.results.find((r) => r.path === "/sign-in").role).toBe("refused-at-edge");
  });

  const conforming = () => {
    const plan = buildVerificationProbePlan({ marker: "ok" });
    const probes = plan.map((p) => ({
      ...p,
      status:
        p.path === VERIFICATION_EXPOSURE_MAPPED_PATH
          ? VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS
          : VERIFICATION_EXPOSURE_UNMAPPED_STATUS,
    }));
    const mapped = probes.find((p) => p.path === VERIFICATION_EXPOSURE_MAPPED_PATH);
    const logEntries = [
      { method: "GET", path: "/api/mcp", marker: mapped.marker, status: 401 },
    ];
    return { probes, logEntries };
  };

  it("passes when every unmapped path is refused and absent, and the mapped one answered", () => {
    const { probes, logEntries } = conforming();
    const outcome = evaluateVerificationExposureCheck({ probes, logEntries });
    expect(outcome.ok).toBe(true);
    expect(outcome.failures).toEqual([]);
    expect(outcome.results.length).toBe(5);
  });

  it("fails when an unmapped path was actually forwarded to the app", () => {
    const { probes, logEntries } = conforming();
    const leaked = probes.find((p) => p.path === "/sign-in");
    const outcome = evaluateVerificationExposureCheck({
      probes,
      logEntries: [...logEntries, { method: "GET", path: "/sign-in", marker: leaked.marker, status: 200 }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("/sign-in");
  });

  it("fails when a DESCENDANT of the mapped prefix was forwarded (loose prefix match)", () => {
    const { probes, logEntries } = conforming();
    const descendant = probes.find((p) => p.path === "/api/mcp/anything");
    const outcome = evaluateVerificationExposureCheck({
      probes,
      logEntries: [
        ...logEntries,
        { method: "GET", path: "/api/mcp/anything", marker: descendant.marker, status: 401 },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("/api/mcp/anything");
  });

  it("fails when an unmapped path came back at some OTHER status", () => {
    const { probes, logEntries } = conforming();
    const altered = probes.map((p) => (p.path === "/" ? { ...p, status: 502 } : p));
    const outcome = evaluateVerificationExposureCheck({ probes: altered, logEntries });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("502");
  });

  it("fails when the mapped path never reached the app", () => {
    const { probes } = conforming();
    const outcome = evaluateVerificationExposureCheck({ probes, logEntries: [] });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("/api/mcp");
  });

  it("fails when the mapped path answered at a status other than the app's documented one", () => {
    const { probes, logEntries } = conforming();
    const altered = probes.map((p) =>
      p.path === VERIFICATION_EXPOSURE_MAPPED_PATH ? { ...p, status: 200 } : p,
    );
    const outcome = evaluateVerificationExposureCheck({ probes: altered, logEntries });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("200");
  });

  it("fails closed when a probe could not be driven at all", () => {
    const { probes, logEntries } = conforming();
    const altered = probes.map((p) => (p.path === "/sign-up" ? { ...p, status: null } : p));
    const outcome = evaluateVerificationExposureCheck({ probes: altered, logEntries });
    expect(outcome.ok).toBe(false);
  });

  it("fails closed on an EMPTY or incomplete probe set — no probes proves nothing", () => {
    expect(evaluateVerificationExposureCheck({ probes: [], logEntries: [] }).ok).toBe(false);
    const { probes, logEntries } = conforming();
    const missingOne = probes.filter((p) => p.path !== "/api/mcp/anything");
    const outcome = evaluateVerificationExposureCheck({ probes: missingOne, logEntries });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toContain("/api/mcp/anything");
  });

  it("fails closed when the access log itself is damaged", () => {
    const { probes, logEntries } = conforming();
    const outcome = evaluateVerificationExposureCheck({
      probes,
      logEntries,
      malformedLogLines: 1,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failures.join(" ")).toMatch(/malformed/);
  });

  it("fails when the mapped path's marker appears against some OTHER path or method", () => {
    const { probes } = conforming();
    const mapped = probes.find((p) => p.path === VERIFICATION_EXPOSURE_MAPPED_PATH);
    const wrongPath = evaluateVerificationExposureCheck({
      probes,
      logEntries: [{ method: "GET", path: "/somewhere-else", marker: mapped.marker, status: 401 }],
    });
    expect(wrongPath.ok).toBe(false);
    const wrongStatus = evaluateVerificationExposureCheck({
      probes,
      logEntries: [{ method: "GET", path: "/api/mcp", marker: mapped.marker, status: 200 }],
    });
    expect(wrongStatus.ok).toBe(false);
  });

  it("fails when two probes share a marker (a leak could be read as the mapped path's)", () => {
    const { probes, logEntries } = conforming();
    const collided = probes.map((p) => ({ ...p, marker: "same" }));
    expect(evaluateVerificationExposureCheck({ probes: collided, logEntries }).ok).toBe(false);
  });
});

// --- 5. the general-purpose command is untouched ---------------------------

describe("verification exposure — `instance tunnel` is unchanged", () => {
  it("the general-purpose builder still maps the WHOLE app at `/`", () => {
    const handlers = buildTailscaleServeConfig({ nextjsPort: 3000, hostNetwork: false })
      .Web["${TS_CERT_DOMAIN}:443"].Handlers;
    expect(Object.keys(handlers)).toEqual(["/"]);
  });

  it("its descriptor is untouched", () => {
    const d = COMMAND_DESCRIPTORS.find((x) => x.id === "dev.tunnel");
    expect(d.path).toEqual(["instance", "tunnel"]);
    expect(d.match).toBe("command+mode");
  });

  it("the new mode does not write the general-purpose serve config", () => {
    const start = INDEX_SRC.indexOf("async function runVerificationExposure(");
    expect(start).toBeGreaterThan(-1);
    const end = INDEX_SRC.indexOf("\nasync function ", start + 10);
    const body = INDEX_SRC.slice(start, end === -1 ? INDEX_SRC.length : end);
    expect(body.includes("writeTailscaleServeConfig(")).toBe(false);
    expect(body.includes("writeScopedTailscaleServeConfig(")).toBe(true);
    // It must not clear or write the app DB's publicBaseUrl either: that row
    // belongs to `instance tunnel` and the operator-supplied URL surface.
    expect(body.includes("writeClonePublicBaseUrl(")).toBe(false);
  });
});

// --- 6. the doc/help row --------------------------------------------------

describe("verification exposure — help and docs say which mode to reach for", () => {
  it("the instance Usage banner advertises the mode", () => {
    const fnStart = INDEX_SRC.indexOf("function printGroupHelp(");
    const usage = INDEX_SRC.slice(
      INDEX_SRC.indexOf("Usage:", fnStart),
      INDEX_SRC.indexOf("Commands:", fnStart),
    );
    expect(usage).toContain("cinatra instance verify-exposure");
  });

  it("the descriptor summary distinguishes it from the general dev tunnel", () => {
    const d = COMMAND_DESCRIPTORS.find((x) => x.id === "dev.verify-exposure");
    expect(d).toBeTruthy();
    expect(d.summary).toMatch(/\/api\/mcp/);
    expect(d.hidden).not.toBe(true);
  });

  it("the README names the mode and its commands", () => {
    expect(README_SRC).toContain("cinatra instance verify-exposure up");
    expect(README_SRC).toContain("cinatra instance verify-exposure check");
  });
});

// --- 7. the lifecycle defects convergence found ---------------------------

describe("verification exposure — reusing, recovering and serialising the lifecycle", () => {
  it("writes the mapping for the RUNNING proxy's own port, never the flag default", () => {
    // The trap: the sidecar was stopped but the proxy was not. Publishing the
    // default port here would point the public tunnel at a port this mode
    // never verified — possibly the app itself, which admits every descendant.
    expect(
      decideVerificationExposureProxyPort({
        live: true,
        recorded: { proxyPort: 3400, upstreamPort: 3000 },
        requestedPort: 3399,
        portWasExplicit: false,
        upstreamPort: 3000,
      }),
    ).toBe(3400);
    // Nothing running: the requested port stands.
    expect(
      decideVerificationExposureProxyPort({
        live: false,
        recorded: null,
        requestedPort: 3399,
        upstreamPort: 3000,
      }),
    ).toBe(3399);
  });

  it("refuses rather than reconciling when the operator names a different port", () => {
    expect(() =>
      decideVerificationExposureProxyPort({
        live: true,
        recorded: { proxyPort: 3400, upstreamPort: 3000 },
        requestedPort: 3399,
        portWasExplicit: true,
        upstreamPort: 3000,
      }),
    ).toThrow(/already running/);
  });

  it("refuses when the running proxy forwards to a different app port", () => {
    expect(() =>
      decideVerificationExposureProxyPort({
        live: true,
        recorded: { proxyPort: 3400, upstreamPort: 3001 },
        requestedPort: 3400,
        upstreamPort: 3000,
      }),
    ).toThrow(/forwards to/);
  });

  it("lists the artifacts that prove an exposure is published, even with no identity", () => {
    withTempDir("cinatra-cli246-artifacts-", (home) => {
      expect(listVerificationExposureArtifacts({ home })).toEqual([]);
      const dir = verificationExposureRuntimeDir("slug-a", { home });
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "compose.yml"), "services: {}\n");
      const found = listVerificationExposureArtifacts({ home });
      expect(found.map((a) => a.slug)).toEqual(["slug-a"]);
      expect(found[0].hasCompose).toBe(true);
    });
  });

  it("`down` with no identity refuses to claim nothing was running when artifacts exist", () => {
    // The command's own branch: an empty scan says nothing was running; a
    // non-empty one throws rather than reporting a clean teardown over a live
    // public exposure.
    const start = INDEX_SRC.indexOf("function reportVerifyExposureDownWithoutIdentity()");
    expect(start).toBeGreaterThan(-1);
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf("\nasync function", start));
    expect(body).toContain("listVerificationExposureArtifacts()");
    expect(body).toMatch(/artifacts\.length === 0/);
    expect(body).toContain("will not report that nothing was running");
  });

  it("serialises lifecycle operations, and NEVER removes a lock it does not own", () => {
    withTempDir("cinatra-cli246-lock-", (home) => {
      const lockPath = verificationExposureLockPath("slug-a", { home });
      const release = acquireVerificationExposureLock(lockPath);
      expect(existsSync(lockPath)).toBe(true);
      // The lock names its owner the moment it exists — never an empty file a
      // second process could read as an ownerless leftover.
      expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
      // …and it names its owner IN the record, as a token: that token, and not
      // the file's identity on disk, is what release() checks. An inode number
      // is reusable the moment its file is unlinked, so a lock removed and
      // re-created by someone else can land on the very same identity — which
      // is why ownership has to be readable out of the content.
      const recordedOwner = JSON.parse(readFileSync(lockPath, "utf8")).owner;
      expect(typeof recordedOwner).toBe("string");
      expect(recordedOwner.length).toBeGreaterThan(0);
      // A second holder is refused while the first holds it.
      expect(() => acquireVerificationExposureLock(lockPath)).toThrow(/in flight/);

      // A lock whose owner is GONE is still not seized: seizing it cannot be
      // made race-free (the owner read and the removal are separate steps, and
      // a live contender can claim the path in between — whose lock the
      // takeover would then destroy). It is reported instead, with its path.
      writeFileSync(lockPath, `${JSON.stringify({ pid: 2 ** 30, at: "x" })}\n`);
      expect(() => acquireVerificationExposureLock(lockPath)).toThrow(/did not finish/);
      expect(() => acquireVerificationExposureLock(lockPath)).toThrow(/never removes a lock it does not own/);
      // An unreadable lock is treated the same way: reported, never seized.
      writeFileSync(lockPath, "");
      expect(() => acquireVerificationExposureLock(lockPath)).toThrow(/lifecycle lock/);

      // And OUR release removes nothing once the RECORD at the path is no
      // longer the one we wrote. Both overwrites above were made IN PLACE, so
      // the file's identity on disk is still the one we linked there — an
      // identity check would call it ours and delete it. It is not ours: the
      // record cannot be read as an owner record at all.
      release();
      expect(existsSync(lockPath)).toBe(true);

      // The same holds for a perfectly readable record that names a DIFFERENT
      // owner, again written in place at the same identity.
      writeFileSync(
        lockPath,
        `${JSON.stringify({ owner: `not-${recordedOwner}`, pid: process.pid, at: "x" })}\n`,
      );
      release();
      expect(existsSync(lockPath)).toBe(true);

      // …and for a DIFFERENT file at the path, not merely different contents.
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: "someone-else" })}\n`);
      release();
      expect(existsSync(lockPath)).toBe(true);
      rmSync(lockPath, { force: true });

      // Once the leftover is gone, the verb works again.
      const again = acquireVerificationExposureLock(lockPath);
      again();
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  it("taking the lock does NOT create the runtime directory it locks", () => {
    // A runtime directory conjured by the lock would carry no ownership
    // manifest, and the ownership rules refuse an unowned directory for every
    // identity but the reserved main one — so locking would break the very
    // first `up` of every other instance.
    withTempDir("cinatra-cli246-lockdir-", (home) => {
      const runtimeDir = verificationExposureRuntimeDir("slug-a", { home });
      const release = acquireVerificationExposureLock(
        verificationExposureLockPath("slug-a", { home }),
      );
      expect(existsSync(runtimeDir)).toBe(false);
      release();
      // And the lock folder is never mistaken for a published exposure.
      expect(listVerificationExposureArtifacts({ home })).toEqual([]);
    });
  });

  it("the lifecycle lock is taken BEFORE the ownership check and the state read", () => {
    // Reading first would let a concurrent `down` invalidate the snapshot: `up`
    // would publish the port of a proxy that no longer exists.
    const body = INDEX_SRC.slice(
      INDEX_SRC.indexOf("async function runVerificationExposure("),
      INDEX_SRC.indexOf("\n// ---", INDEX_SRC.indexOf("async function runVerificationExposure(")),
    );
    const lockIdx = body.indexOf("acquireVerificationExposureLock(verificationExposureLockPath(slug))");
    const ownershipIdx = body.indexOf("assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity });");
    const readIdx = body.indexOf("const proxy = await readVerifyExposureProxy(proxyStatePath);");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(ownershipIdx).toBeGreaterThan(lockIdx);
    expect(readIdx).toBeGreaterThan(lockIdx);
    // …and it is held across the whole act, then always released.
    expect(body).toContain("if (releaseLifecycleLock) releaseLifecycleLock();");
  });

  it("a proven teardown removes the rendered compose file, so a later scan is truthful", () => {
    // `docker compose down` leaves compose.yml behind; the identity-less `down`
    // scan reads that file as "an exposure is published", so it must go.
    const downIdx = INDEX_SRC.indexOf("async function runVerifyExposureDown()");
    const body = INDEX_SRC.slice(downIdx, INDEX_SRC.indexOf("\n  if (action === \"check\") {", downIdx));
    expect(body).toContain("rmSync(composePath, { force: true })");
  });

  it("an unreadable runtime root is never read as `nothing is published`", () => {
    withTempDir("cinatra-cli246-scan-", (home) => {
      // A root that does not exist is the honest empty answer…
      expect(listVerificationExposureArtifacts({ home: path.join(home, "nope") })).toEqual([]);
      // …but a root that is a FILE cannot answer the question at all.
      writeFileSync(path.join(home, ".cinatra"), "not a directory");
      expect(() => listVerificationExposureArtifacts({ home })).toThrow();
    });
  });

  it("`up` holds the lock and takes its own proxy back down when publishing fails", () => {
    const start = INDEX_SRC.indexOf("async function runVerificationExposure(");
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf("\n// ---", start));
    expect(body).toContain("acquireVerificationExposureLock(verificationExposureLockPath(slug))");
    expect(body).toContain("if (startedProxy) await stopVerifyExposureProxy(proxyStatePath);");
    expect(body).toContain("decideVerificationExposureProxyPort({");
    // The mapping and the compose render both name the decided port.
    expect(body).toContain("proxyPort: effectiveProxyPort,");
    expect(body).toContain("NEXTJS_PORT: effectiveProxyPort,");
  });
});
