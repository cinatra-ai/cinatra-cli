// cinatra-cli#231 — the isolated install must state and provision the endpoints
// it ACTUALLY allocated, not the defaults it was written against.
//
// Two defects, one root cause: the per-instance port allocation was not threaded
// through to every place a port is spoken.
//
//   (1) The install success line hardcoded `http://localhost:3010` while the
//       instance's WayFlow runtime listens on the offset port (`3010 + offset`),
//       which is exactly what the generated `.env.local` already recorded in
//       WAYFLOW_BASE_URL. The operator was pointed at a dead port — or, worse, at
//       the MAIN instance's runtime when one held the default.
//
//   (2) The generated isolated compose kept
//       `CINATRA_BASE_URL: http://host.docker.internal:3000` on the `wayflow`
//       service while the isolated app runs on its own allocated port. Anything
//       the runtime calls back into the app on reaches the wrong app.
//
// Acceptance: BOTH values derive from the same per-instance allocation. These
// tests pin an install at a NONZERO offset and an explicit app port, then assert
// the success line and the container's CINATRA_BASE_URL both carry the offset
// ports — and that the success line agrees with `.env.local` to the port.
//
// Docker is fully stubbed through the injectable `deps` seam: no daemon, no
// network, no services.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __test as installTest, runInstall, runIsolatedA2aPeers } from "../src/install.mjs";
import {
  __test as isoTest,
  assertComposeAppUrlsRemapped,
  assertComposeHostUrlsRemapped,
  generateIsolatedCompose,
  interpolatedPortServices,
  publishedPortsByService,
} from "../src/install-isolation.mjs";
import { isolatedComposeHasA2aPeers, missingIsolatedServices } from "../src/isolated-a2a.mjs";
import { DEFAULT_APP_PORT as ALLOCATOR_DEFAULT_APP_PORT } from "../src/instance-alloc.mjs";
// cinatra#2654 (round 6) — the ONE reader of a row's recorded WayFlow choice.
import { recordedWayflowChoice } from "../src/instance-registry.mjs";
import {
  DEFAULT_WAYFLOW_PORT,
  WAYFLOW_RUNTIME_LOCAL,
  wayflowEndpointForPorts,
  wayflowStatusLines,
} from "../src/wayflow-runtime.mjs";

const { remapEnvAppPortUrls, findUnmappedComposeAppUrls, ownsAppPortUrl, DEFAULT_HOST_APP_PORT } = isoTest;

// The allocation this install is pinned to. Both are explicit so the expected
// endpoints are arithmetic, not whatever the allocator happened to pick.
const OFFSET = 20000;
const APP_PORT = 3350;
const EXPECTED_WAYFLOW_PORT = DEFAULT_WAYFLOW_PORT + OFFSET; // 23010

// ---------------------------------------------------------------------------
// Pure-unit coverage of the two helpers the fix is built from.
// ---------------------------------------------------------------------------
describe("cinatra-cli#231 — wayflowEndpointForPorts (the success line's source)", () => {
  it("reads the instance's REMAPPED wayflow host port out of the allocation map", () => {
    // `ports` is exactly what generateIsolatedCompose returns and what
    // writeIsolatedAppEnv reads WAYFLOW_BASE_URL from — one source, two readers.
    expect(wayflowEndpointForPorts({ wayflow: [23010], postgres: [25434] })).toBe("http://localhost:23010");
  });

  it("falls back to the default port when this install allocated no band", () => {
    // A default/attach install has no per-service map; the default port is right.
    expect(wayflowEndpointForPorts(undefined)).toBe(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);
    expect(wayflowEndpointForPorts({})).toBe(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);
    expect(wayflowEndpointForPorts({ wayflow: [] })).toBe(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);
    // A malformed entry must not render "http://localhost:NaN".
    expect(wayflowEndpointForPorts({ wayflow: ["nope"] })).toBe(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);
  });

  it("the status line RENDERS the endpoint it is given", () => {
    const line = wayflowStatusLines(WAYFLOW_RUNTIME_LOCAL, {
      endpoint: wayflowEndpointForPorts({ wayflow: [EXPECTED_WAYFLOW_PORT] }),
    }).join(" ");
    expect(line).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    expect(line).not.toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);
  });
});

describe("cinatra-cli#231 — remapEnvAppPortUrls (the compose fix)", () => {
  const skip = new Set([5434, 6379, 3003]); // a plausible published band, without 3000

  it("substitutes the app port behind the Docker host gateway", () => {
    expect(remapEnvAppPortUrls("http://host.docker.internal:3000", APP_PORT, 3000, skip)).toBe(
      `http://host.docker.internal:${APP_PORT}`,
    );
  });

  it("covers the loopback spellings a Linux host-gateway install uses", () => {
    expect(remapEnvAppPortUrls("http://localhost:3000/api", APP_PORT, 3000, skip)).toBe(
      `http://localhost:${APP_PORT}/api`,
    );
    expect(remapEnvAppPortUrls("http://127.0.0.1:3000", APP_PORT, 3000, skip)).toBe(`http://127.0.0.1:${APP_PORT}`);
  });

  it("preserves scheme, path and query exactly (surgical replace, no URL renormalisation)", () => {
    expect(remapEnvAppPortUrls("https://host.docker.internal:3000/a/b?c=1", APP_PORT, 3000, skip)).toBe(
      `https://host.docker.internal:${APP_PORT}/a/b?c=1`,
    );
  });

  it("NEVER moves a bare listen-port value — that is the container's OWN port", () => {
    // `PORT: "3000"` has no `://`; moving it would change what the container binds.
    expect(remapEnvAppPortUrls("3000", APP_PORT, 3000, skip)).toBe("3000");
  });

  it("leaves an IN-NETWORK service-DNS URL verbatim", () => {
    expect(remapEnvAppPortUrls("http://cinatra-app:3000", APP_PORT, 3000, skip)).toBe("http://cinatra-app:3000");
  });

  it("leaves a port that is NOT the default app port alone", () => {
    expect(remapEnvAppPortUrls("http://host.docker.internal:3010", APP_PORT, 3000, skip)).toBe(
      "http://host.docker.internal:3010",
    );
  });

  it("defers a LOOPBACK url to cinatra-cli#97 when the default app port IS published", () => {
    // Both rewrites must never claim the same number: if a compose service really
    // publishes 3000, cinatra-cli#97's +offset shift owns the LOOPBACK spelling.
    const published = new Set([3000, 5434]);
    expect(remapEnvAppPortUrls("http://localhost:3000", APP_PORT, 3000, published)).toBe("http://localhost:3000");
    expect(remapEnvAppPortUrls("http://127.0.0.1:3000", APP_PORT, 3000, published)).toBe("http://127.0.0.1:3000");
  });

  // ── the review's HIGH finding ────────────────────────────────────────────────
  // Ownership is PER URL, not global. cinatra-cli#97 rewrites LOOPBACK hosts
  // only, so it can never own a `host.docker.internal` URL. A stand-down keyed
  // globally on "the stack publishes 3000" left the gateway URL with NO rewriter
  // and NO invariant — the original defect, recurring under a supported shape.
  it("HIGH regression: a GATEWAY url is still substituted even when a service publishes 3000", () => {
    const published = new Set([3000, 5434]);
    expect(remapEnvAppPortUrls("http://host.docker.internal:3000", APP_PORT, 3000, published)).toBe(
      `http://host.docker.internal:${APP_PORT}`,
    );
  });

  it("HIGH regression: within ONE value, the gateway match is substituted and the loopback match deferred", () => {
    const published = new Set([3000]);
    expect(
      remapEnvAppPortUrls("http://host.docker.internal:3000/a http://localhost:3000/b", APP_PORT, 3000, published),
    ).toBe(`http://host.docker.internal:${APP_PORT}/a http://localhost:3000/b`);
  });

  it("HIGH regression: the invariant still reports a gateway leak when 3000 is published", () => {
    const published = new Set([3000, 5434]);
    const leaked = { services: { wayflow: { environment: { CINATRA_BASE_URL: "http://host.docker.internal:3000" } } } };
    expect(findUnmappedComposeAppUrls(leaked, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: published })).toEqual(
      ["wayflow.CINATRA_BASE_URL"],
    );
    // ...and does NOT claim a loopback URL that belongs to cinatra-cli#97, whose
    // own invariant (findUnmappedComposeHostUrls) covers that case.
    const loopback = { services: { nango: { environment: { NANGO_SERVER_URL: "http://localhost:3000" } } } };
    expect(findUnmappedComposeAppUrls(loopback, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: published })).toEqual([]);
  });

  it("the ownership predicate states the rule directly", () => {
    const published = new Set([3000]);
    // gateway: ours unconditionally, published or not.
    expect(ownsAppPortUrl("host.docker.internal", 3000, 3000, published)).toBe(true);
    expect(ownsAppPortUrl("host.docker.internal", 3000, 3000, new Set())).toBe(true);
    // loopback: ours only when #97 would NOT remap it.
    expect(ownsAppPortUrl("localhost", 3000, 3000, published)).toBe(false);
    expect(ownsAppPortUrl("localhost", 3000, 3000, new Set())).toBe(true);
    // a different port, or a non-app host, is never ours.
    expect(ownsAppPortUrl("host.docker.internal", 3010, 3000, published)).toBe(false);
    expect(ownsAppPortUrl("cinatra-app", 3000, 3000, new Set())).toBe(false);
  });

  it("is a no-op when this instance runs on the default port anyway", () => {
    expect(remapEnvAppPortUrls("http://host.docker.internal:3000", 3000, 3000, skip)).toBe(
      "http://host.docker.internal:3000",
    );
  });

  it("the invariant scan names the offending service.KEY, and is empty once fixed", () => {
    const leaked = { services: { wayflow: { environment: { CINATRA_BASE_URL: "http://host.docker.internal:3000" } } } };
    expect(
      findUnmappedComposeAppUrls(leaked, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: skip }),
    ).toEqual(["wayflow.CINATRA_BASE_URL"]);
    const fixed = { services: { wayflow: { environment: { CINATRA_BASE_URL: `http://host.docker.internal:${APP_PORT}` } } } };
    expect(findUnmappedComposeAppUrls(fixed, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: skip })).toEqual([]);
  });

  // The end-to-end shape of the HIGH finding, through the REAL generator: a
  // service genuinely publishes 3000 (so the #97 band remap is live on that
  // number) AND the runtime dials the app through the gateway on 3000.
  it("HIGH regression, end to end: both rewrites coexist on port 3000 without either standing down", () => {
    const cfg = {
      name: "cinatra",
      services: {
        // A service that really publishes 3000 and self-advertises on loopback:
        // cinatra-cli#97 owns BOTH its published port and that URL.
        gateway: {
          environment: { PUBLIC_URL: "http://localhost:3000" },
          ports: [{ published: "3000", target: 3000, protocol: "tcp", mode: "host" }],
        },
        // The runtime dialling the HOST app through the Docker gateway: ours,
        // regardless of what `gateway` above publishes.
        wayflow: {
          environment: { PORT: "3010", CINATRA_BASE_URL: "http://host.docker.internal:3000" },
          ports: [{ published: "3010", target: 3010, protocol: "tcp", mode: "host" }],
        },
      },
      networks: { default: { name: "cinatra_default" } },
    };
    const { doc } = generateIsolatedCompose({
      resolvedConfig: cfg,
      offset: OFFSET,
      projectName: "cinatra_dual",
      slug: "dual",
      appPort: APP_PORT,
      defaultAppPort: 3000,
    });

    // The gateway URL followed the APP-PORT substitution (this is the bug the
    // global stand-down re-introduced: it used to come out unchanged at :3000).
    expect(doc.services.wayflow.environment.CINATRA_BASE_URL).toBe(`http://host.docker.internal:${APP_PORT}`);
    // The loopback self-URL followed the #97 BAND shift, unchanged in behaviour.
    expect(doc.services.gateway.environment.PUBLIC_URL).toBe(`http://localhost:${3000 + OFFSET}`);
    // Published host ports still shift by the band offset.
    expect(String(doc.services.gateway.ports[0].published)).toBe(String(3000 + OFFSET));

    // Both invariants hold on the result, and neither stood down.
    const published = new Set([3000, 3010]);
    expect(() => assertComposeHostUrlsRemapped(doc, published)).not.toThrow();
    expect(() =>
      assertComposeAppUrlsRemapped(doc, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: published }),
    ).not.toThrow();

    // And the app invariant would have CAUGHT the leak in this exact shape.
    const leaked = JSON.parse(JSON.stringify(doc));
    leaked.services.wayflow.environment.CINATRA_BASE_URL = "http://host.docker.internal:3000";
    expect(() =>
      assertComposeAppUrlsRemapped(leaked, { appPort: APP_PORT, defaultAppPort: 3000, publishedPorts: published }),
    ).toThrow(/cinatra-cli#231/);
  });

  it("the module's fallback default app port IS the allocator's", () => {
    // install.mjs passes instance-alloc's DEFAULT_APP_PORT on the real path, and
    // install-isolation.mjs restates it as a fallback because it is import-light.
    // Compare the two CONSTANTS directly — not a literal — so changing the
    // allocator's value fails here instead of silently splitting the two.
    expect(DEFAULT_HOST_APP_PORT).toBe(ALLOCATOR_DEFAULT_APP_PORT);
  });
});

// ---------------------------------------------------------------------------
// The acceptance test: a real runInstall at a NONZERO offset.
// ---------------------------------------------------------------------------

/** Read the generated isolated compose. cinatra-cli#236 prepends a
 *  `# GENERATED FILE` YAML comment header to the JSON document, so strip any
 *  leading comment lines before parsing — this reads the file correctly both
 *  before and after that change lands. */
function readGeneratedCompose(installDir) {
  const body = readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8");
  const stripped = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  return { body, doc: JSON.parse(stripped) };
}

function buildFixtureOrigin(sandbox) {
  const src = path.join(sandbox, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    path.join(src, "packages", "migrations", "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
  );
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }));
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "ignore",
    });
  G(["init", "-b", "main"], src);
  G(["add", "-A"], src);
  G(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  G(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "nango-server", host: "0.0.0.0", port: 3003 },
  { service: "wayflow", host: "127.0.0.1", port: DEFAULT_WAYFLOW_PORT },
];

// The resolved `docker compose config` for the fixture's default band. The
// `wayflow` service is modelled exactly as the real checkout emits it: a bare
// listen `PORT`, the host-gateway callback URL on the DEFAULT app port, its
// published host port in the band, and the narrow bridge-token env file it reads
// its secrets from (carried so this fixture also satisfies cinatra-cli#236's
// render invariant once that lands; it is inert here).
const RESOLVED_CONFIG = {
  name: "cinatra",
  services: {
    postgres: {
      image: "postgres:16",
      environment: { POSTGRES_PASSWORD: "secret-plain" },
      ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    },
    redis: {
      image: "redis",
      ports: [{ published: "6379", target: 6379, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    },
    "nango-server": {
      image: "nango",
      environment: { NANGO_SERVER_URL: "http://localhost:3003" },
      ports: [{ published: "3003", target: 3003, host_ip: "0.0.0.0", protocol: "tcp", mode: "host" }],
    },
    wayflow: {
      image: "cinatra-wayflow",
      environment: {
        PORT: String(DEFAULT_WAYFLOW_PORT),
        CINATRA_BASE_URL: "http://host.docker.internal:3000",
        CINATRA_AGENTS_DIR: "/app/agents",
      },
      env_file: [{ path: "./docker/wayflow/.wayflow.env", required: false }],
      ports: [
        {
          published: String(DEFAULT_WAYFLOW_PORT),
          target: DEFAULT_WAYFLOW_PORT,
          host_ip: "127.0.0.1",
          protocol: "tcp",
          mode: "host",
        },
      ],
    },
  },
  networks: { default: { name: "cinatra_default" } },
  volumes: { "cinatra-postgres": { name: "cinatra_cinatra-postgres" } },
};

// An `a2a-peers`-profiled service WITH a published host port — the exact marker
// `isolatedComposeHasA2aPeers` looks for, and so the exact thing that used to
// make a compose file claim to be current forever (cinatra-cli#231 round 2).
const A2A_PEER_PORT = 3200;
const A2A_PEER_SERVICE = {
  image: "cinatra-a2a-peer",
  profiles: ["a2a-peers"],
  ports: [{ published: String(A2A_PEER_PORT), target: 3200, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
};

/** The same checkout, in the a2a era: it declares the peers AND `wayflow`. */
const RESOLVED_CONFIG_WITH_PEERS = {
  ...RESOLVED_CONFIG,
  services: { ...RESOLVED_CONFIG.services, "a2a-peer-alpha": A2A_PEER_SERVICE },
};

const DEFAULT_BAND_WITH_PEERS = [...DEFAULT_BAND, { service: "a2a-peer-alpha", host: "127.0.0.1", port: A2A_PEER_PORT }];

function isolatedDeps() {
  return {
    runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
    commandExists: () => true,
    composeAvailable: () => true,
    composePublishedPortsForTarget: () => DEFAULT_BAND,
    composeConfigForFiles: () => RESOLVED_CONFIG,
    targetComposeOwnedPorts: () => new Set(),
    liveComposeInspect: () => [],
    readCloneRegistry: () => null,
    bringUpInfra: () => {},
    runComposeDown: () => {},
    inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
    // Force the isolated route: postgres on the DEFAULT band is held.
    detectPortConflicts: async (band) => {
      const pg = band.find((b) => b.service === "postgres");
      if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
      return [];
    },
    // cinatra-cli#236 forward-compat: that PR adds a Compose capability probe
    // and a pre-render WayFlow env provisioning step to this seam. Both stubs
    // are inert on a checkout without them, and keep this test hermetic on one
    // with them (no daemon, no `scripts/` tree in the sandbox checkout).
    composeSupportsNoEnvResolution: () => true,
    generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }),
  };
}

describe("cinatra-cli#231 — an isolated install at a NONZERO offset states and provisions ITS OWN endpoints", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-231-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });


  it("the success line names the OFFSET WayFlow port, and it agrees with .env.local", async () => {
    const installDir = path.join(sandbox, "iso231-line");
    const lines = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso231line",
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: (l) => lines.push(String(l)), deps: isolatedDeps() },
    );
    expect(res.infraPlan).toBe("isolated");

    // (1) The agent-runtime summary line carries the instance's OWN port.
    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toBeDefined();
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);

    // The hardcoded default must NOT survive anywhere in the install output —
    // this is the exact string the operator was handed for a dead port.
    expect(lines.join("\n")).not.toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);

    // (2) Same allocation, two readers: the printed endpoint's port is the port
    // `.env.local` records, so the operator can never be told one and given the
    // other. (WAYFLOW_BASE_URL is normalised to 127.0.0.1 + a trailing slash by
    // rewriteUrlPort, so the PORT is what must agree, not the whole string.)
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
    const printedPort = Number(runtimeLine.match(/http:\/\/localhost:(\d+)/)[1]);
    const recordedPort = Number(env.match(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:(\d+)/m)[1]);
    expect(printedPort).toBe(recordedPort);
  });

  it("the generated compose points the wayflow runtime's CINATRA_BASE_URL at THIS instance's app port", async () => {
    const installDir = path.join(sandbox, "iso231-compose");
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso231compose",
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: isolatedDeps() },
    );
    expect(res.infraPlan).toBe("isolated");

    const { body, doc } = readGeneratedCompose(installDir);
    const wayflowEnv = doc.services.wayflow.environment;

    // (1) The callback URL carries the ALLOCATED app port — a substitution, not a
    // shift: 3350 is drawn from the app pool, NOT 3000 + offset (which would be
    // 23000 and equally wrong).
    expect(wayflowEnv.CINATRA_BASE_URL).toBe(`http://host.docker.internal:${APP_PORT}`);
    expect(wayflowEnv.CINATRA_BASE_URL).not.toContain(`:${DEFAULT_HOST_APP_PORT}`);
    expect(body).not.toContain("host.docker.internal:3000");

    // (2) The container's OWN listen port is untouched — a bare number is not a
    // host port and moving it would change what the process binds inside the net.
    expect(wayflowEnv.PORT).toBe(String(DEFAULT_WAYFLOW_PORT));
    // A non-URL env value is likewise left alone.
    expect(wayflowEnv.CINATRA_AGENTS_DIR).toBe("/app/agents");

    // (3) The published HOST port still follows the band offset (cinatra-cli#97
    // is untouched by this fix) — and it is the very port the success line and
    // .env.local both read, which is what makes them one allocation.
    expect(String(doc.services.wayflow.ports[0].published)).toBe(String(EXPECTED_WAYFLOW_PORT));
    expect(doc.services["nango-server"].environment.NANGO_SERVER_URL).toBe(`http://localhost:${3003 + OFFSET}`);
  });
});

// ---------------------------------------------------------------------------
// The RECONCILE path: a LEGACY row, re-converged.
// ---------------------------------------------------------------------------
//
// Round-1 review blocker. `reconvergeIsolated` re-points `.env.local` from
// `effectivePorts` — the map `regenerateIsolatedComposeInPlace` returns, which is
// ENLARGED relative to the recorded row whenever the recorded row predates a
// service being baked into the isolated compose. The determinism guard
// (`sharedServicePortsAgree`) deliberately IGNORES services present only in the
// regenerated map, so such a row reconciles happily — but it still carries no
// `wayflow` entry.
//
// Returning the recorded row unchanged therefore re-opened this very issue on
// the reconcile path: the tail printed the DEFAULT :3010 out of the stale map
// while `.env.local` recorded the offset port. Under `--reset-env` it was not
// merely a wrong print — step 5 re-resets `.env.local` and step 5b re-points it
// from that same stale map, which has no `wayflow` key to re-point WITH, so the
// FILE was left on the default port too.
//
// The fix hands the effective map back with the row. These tests pin both halves.
describe("cinatra-cli#231 — a LEGACY recorded row re-converges onto ITS OWN wayflow port", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-231-legacy-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  /** The deps of the acceptance suite, plus a stub for the version capture the
   *  re-converge performs (best-effort on the real path; stubbed here so the
   *  test never shells out to docker). */
  function reconvergeDeps() {
    return {
      ...isolatedDeps(),
      captureDeployedVersions: () => ({ ok: true, versions: {} }),
    };
  }

  /** Install once at the pinned offset, then AGE the recorded row into a legacy
   *  one: drop the `wayflow` entry from its port map (as a row recorded before
   *  WayFlow was baked into the isolated compose has) and drop the persisted
   *  `offset` (legacy rows have none — it gets re-derived from the shared
   *  services). Returns the install dir. */
  async function installThenAgeRow(name) {
    const installDir = path.join(sandbox, name);
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", name,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: reconvergeDeps() },
    );
    expect(res.infraPlan).toBe("isolated");

    const regPath = process.env.CINATRA_INSTANCE_REGISTRY;
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    const slug = Object.keys(reg.instances).find(
      (s) => path.resolve(reg.instances[s].installDir) === path.resolve(installDir),
    );
    expect(slug).toBeDefined();
    const row = reg.instances[slug];
    // Sanity: the FRESH row does carry the offset wayflow port — the ageing below
    // is what removes it, so this test can only pass for the intended reason.
    expect(row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    delete row.ports.wayflow;
    delete row.offset;
    writeFileSync(regPath, JSON.stringify(reg, null, 2) + "\n");

    return installDir;
  }

  function envOf(installDir) {
    return readFileSync(path.join(installDir, ".env.local"), "utf8");
  }

  /** A plain re-run: no --on-conflict / --infra, so runInstall routes through the
   *  isolated re-converge for a checkout the registry records as isolated. */
  function reconverge(installDir, extraArgs = []) {
    const lines = [];
    return runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", ...extraArgs,
      ],
      { log: (l) => lines.push(String(l)), deps: reconvergeDeps() },
    ).then((res) => ({ res, lines }));
  }

  it("prints the OFFSET wayflow port on the re-converge, and .env.local agrees", async () => {
    const installDir = await installThenAgeRow("iso231-legacy");
    // Point the file at the DEFAULT port first, so "agrees" can only be satisfied
    // by the re-converge actually re-pointing it — not by a leftover value.
    writeFileSync(
      path.join(installDir, ".env.local"),
      envOf(installDir).replace(/^WAYFLOW_BASE_URL=.*$/m, `WAYFLOW_BASE_URL=http://127.0.0.1:${DEFAULT_WAYFLOW_PORT}`),
    );

    const { res, lines } = await reconverge(installDir);
    expect(res.infraPlan).toBe("isolated");
    // It really did take the re-converge branch (not a fresh isolated install).
    expect(lines.join("\n")).toContain("converging on its own stack");

    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toBeDefined();
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    // The stale row's default port must not survive anywhere in the output.
    expect(lines.join("\n")).not.toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);

    const env = envOf(installDir);
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
    const printedPort = Number(runtimeLine.match(/http:\/\/localhost:(\d+)/)[1]);
    const recordedPort = Number(env.match(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:(\d+)/m)[1]);
    expect(printedPort).toBe(recordedPort);
  });

  it("--reset-env re-points the REGENERATED file too (the stale map cannot re-point it)", async () => {
    const installDir = await installThenAgeRow("iso231-legacy-reset");

    const { res, lines } = await reconverge(installDir, ["--reset-env"]);
    expect(res.infraPlan).toBe("isolated");

    // Step 5 re-created .env.local from .env.example and step 5b re-pointed it
    // from the map the re-converge handed back — which must be the EFFECTIVE one.
    const env = envOf(installDir);
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
    expect(env).not.toMatch(new RegExp(`^WAYFLOW_BASE_URL=\\S*:${DEFAULT_WAYFLOW_PORT}`, "m"));

    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    const printedPort = Number(runtimeLine.match(/http:\/\/localhost:(\d+)/)[1]);
    const recordedPort = Number(env.match(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:(\d+)/m)[1]);
    expect(printedPort).toBe(recordedPort);
  });

  it("the shared services the legacy row DID record keep their exact host ports", async () => {
    // The value of returning `effectivePorts` rests on it being the SAME band —
    // an enlargement, never a relocation. If regeneration had moved a recorded
    // service the determinism guard would have refused and `effectivePorts` would
    // still be the recorded map; assert the enlargement actually happened AND
    // that nothing already recorded moved.
    const installDir = await installThenAgeRow("iso231-legacy-band");
    const { lines } = await reconverge(installDir);

    // The LAST such line is step 5b's re-point, which reads the map the
    // re-converge handed back (the re-converge's own earlier line always reads
    // `effectivePorts` directly and so proves nothing about what was returned).
    const remapLines = lines.filter((l) => l.includes("infra URLs re-pointed"));
    expect(remapLines.length).toBeGreaterThan(1);
    const remapLine = remapLines[remapLines.length - 1];
    expect(remapLine).toContain(`wayflow:${EXPECTED_WAYFLOW_PORT}`); // the enlargement
    expect(remapLine).toContain(`db:${5434 + OFFSET}`); // recorded, unmoved
    expect(remapLine).toContain(`nango:${3003 + OFFSET}`); // recorded, unmoved

    const env = envOf(installDir);
    expect(env).toMatch(new RegExp(`^NANGO_SERVER_URL=http://127\\.0\\.0\\.1:${3003 + OFFSET}`, "m"));
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#231, round-2 review non-blocking: the two routes on which
// `effectivePorts` could still be the STALE recorded map, so the tail printed
// the default port for a runtime listening on the offset one.
//
//   (a) The in-place regeneration decided "this file is current" with a single
//       a2a-peers marker. A compose generated once the peers were baked in
//       reported itself current FOREVER, so it could never gain a service baked
//       in LATER — `wayflow` is exactly such a service. Regeneration was skipped,
//       the recorded map kept no `wayflow` entry, and the reconcile had nothing
//       to re-point `.env.local` with.
//
//   (b) The explicit ATTACH path (`--on-conflict=attach`) never regenerates at
//       all and spoke straight from the recorded map — the same defect shape,
//       reached without any staleness in the compose FILE.
//
// Both now resolve the ports from the compose file the run actually brings up,
// and record the repair on the row so `cinatra instance wayflow start`
// (cinatra-cli#240) cannot name a different endpoint than the install tail did.
// ---------------------------------------------------------------------------
describe("cinatra-cli#231 — missingIsolatedServices (the regeneration's currency test)", () => {
  const current = { services: { postgres: {}, wayflow: {}, "a2a-peer-alpha": {} } };

  it("names a LATER-baked service an a2a-era compose never gained", () => {
    const a2aEra = { services: { postgres: {}, "a2a-peer-alpha": {} } };
    expect(missingIsolatedServices(a2aEra, current)).toEqual(["wayflow"]);
    // The marker the test replaces would have called this file current, which is
    // precisely how the defect survived.
    expect(isolatedComposeHasA2aPeers({ services: { "a2a-peer-alpha": A2A_PEER_SERVICE } })).toBe(true);
  });

  it("is empty when the file carries every service the checkout declares", () => {
    expect(missingIsolatedServices(current, current)).toEqual([]);
  });

  it("reports ADDITIONS only — a service the file has and the checkout does not is left alone", () => {
    const withExtra = { services: { ...current.services, "operator-sidecar": {} } };
    expect(missingIsolatedServices(withExtra, current)).toEqual([]);
  });

  it("sorts, so the regeneration message is stable", () => {
    expect(missingIsolatedServices({ services: {} }, { services: { zeta: {}, alpha: {} } })).toEqual(["alpha", "zeta"]);
  });

  it("treats a malformed document as carrying nothing rather than throwing", () => {
    expect(missingIsolatedServices(null, current)).toEqual(["a2a-peer-alpha", "postgres", "wayflow"]);
    expect(missingIsolatedServices(current, null)).toEqual([]);
  });
});

describe("cinatra-cli#231 — publishedPortsByService (reading the run's real ports back)", () => {
  it("returns the SAME map the generator recorded, read back off its own output", () => {
    const { doc, ports } = generateIsolatedCompose({
      resolvedConfig: RESOLVED_CONFIG,
      offset: OFFSET,
      projectName: "cinatra_iso231",
      slug: "iso231",
      appPort: APP_PORT,
    });
    expect(publishedPortsByService(doc)).toEqual(ports);
    expect(publishedPortsByService(doc).wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
  });

  it("omits a service that publishes nothing, as the generator does", () => {
    expect(publishedPortsByService({ services: { worker: { image: "x" } } })).toEqual({});
  });

  // cinatra-cli#237 finding 3: a short-syntax entry ("23010:3010") IS a real
  // host-port binding — `remapServicePorts` leaving it unshifted (a separate,
  // still-open write-side concern) does not make it any less true RIGHT NOW.
  // Recording nothing for it left a missing row entry falling back to the
  // container port (3010, wrong) and let a stale row entry survive the overlay
  // unchallenged (finding 1's exact hazard, reached a second way).
  it("parses a short-syntax HOST:CONTAINER entry as the published host port", () => {
    expect(publishedPortsByService({ services: { db: { ports: ["23010:3010"] } } })).toEqual({ db: [23010] });
  });

  it("parses a short-syntax entry carrying an explicit host IP or protocol", () => {
    expect(publishedPortsByService({ services: { db: { ports: ["127.0.0.1:23010:3010"] } } })).toEqual({
      db: [23010],
    });
    expect(publishedPortsByService({ services: { db: { ports: ["23010:3010/tcp"] } } })).toEqual({ db: [23010] });
  });

  it("a bare container-port short-syntax entry publishes no FIXED host port", () => {
    // `"3010"` alone binds an EPHEMERAL host port docker assigns at `up` time —
    // there is nothing fixed to record.
    expect(publishedPortsByService({ services: { db: { ports: ["3010"] } } })).toEqual({});
  });

  it("a short-syntax port RANGE is ambiguous and is not recorded", () => {
    expect(publishedPortsByService({ services: { db: { ports: ["23010-23015:3010-3015"] } } })).toEqual({});
  });

  // ── cinatra-cli#237 round-2 finding 2 ───────────────────────────────────────
  // The LONG form used a permissive `Number.parseInt`, so a legitimate long-form
  // range came back as its FIRST port — a number the stack never binds — while
  // the short form deliberately declined the very same input. Both branches now
  // validate through one strict reader.
  it("finding 2: a LONG-FORM port RANGE is declined exactly like the short form", () => {
    expect(publishedPortsByService({ services: { db: { ports: [{ published: "23010-23015", target: 3010 }] } } })).toEqual(
      {},
    );
    // The short form's answer for the same declaration, for direct comparison.
    expect(publishedPortsByService({ services: { db: { ports: ["23010-23015:3010-3015"] } } })).toEqual({});
  });

  it("finding 2: a NON-NUMERIC long-form published value records nothing", () => {
    for (const published of ["", "  ", "abc", "23010abc", "0", "-5", "2.5"]) {
      expect(publishedPortsByService({ services: { db: { ports: [{ published, target: 3010 }] } } })).toEqual({});
    }
  });

  it("finding 2: a valid sibling entry still records when one entry is declined", () => {
    expect(
      publishedPortsByService({
        services: { db: { ports: [{ published: "23010-23015", target: 3010 }, { published: "25434", target: 5432 }] } },
      }),
    ).toEqual({ db: [25434] });
  });

  // ── cinatra-cli#237 round-2 finding 6 ───────────────────────────────────────
  // Compose accepts a zero-padded host port and binds the integer; rejecting the
  // spelling silently dropped a REAL binding from the effective map.
  it("finding 6: a ZERO-PADDED host port is accepted and normalised to the integer", () => {
    expect(publishedPortsByService({ services: { db: { ports: ["023010:3010"] } } })).toEqual({ db: [23010] });
    expect(publishedPortsByService({ services: { db: { ports: ["127.0.0.1:023010:3010/tcp"] } } })).toEqual({
      db: [23010],
    });
    expect(publishedPortsByService({ services: { db: { ports: [{ published: "023010", target: 3010 }] } } })).toEqual({
      db: [23010],
    });
  });
});

// ── cinatra-cli#237 round-2 finding 1 ────────────────────────────────────────
// `{ published: "${POSTGRES_PORT}" }` and `"${WAYFLOW_PORT}:3010"` are valid
// Compose that binds a real host port at `up` time — the file simply DECLINES to
// say which. Read as "publishes nothing", such a service was indistinguishable
// from a REMOVED one, so the wholesale replacement deleted a legitimate recorded
// allocation. These two answers must be tellable apart.
describe("cinatra-cli#237 — interpolatedPortServices (the file declines to state a truth)", () => {
  it("names a service whose LONG-FORM published port defers to a variable", () => {
    const doc = { services: { postgres: { ports: [{ published: "${POSTGRES_PORT}", target: 5432 }] } } };
    expect(interpolatedPortServices(doc)).toEqual(["postgres"]);
    // ...and it is NOT in the static map, which is exactly why the two answers
    // must be read together.
    expect(publishedPortsByService(doc)).toEqual({});
  });

  it("names a service whose SHORT-FORM host port defers to a variable", () => {
    expect(interpolatedPortServices({ services: { wayflow: { ports: ["${WAYFLOW_PORT}:3010"] } } })).toEqual(["wayflow"]);
    // The bare `$VAR` spelling Compose also accepts.
    expect(interpolatedPortServices({ services: { wayflow: { ports: ["$WAYFLOW_PORT:3010"] } } })).toEqual(["wayflow"]);
    // A whole-entry variable can expand to a `host:container` pair — deferred,
    // not an ephemeral bind.
    expect(interpolatedPortServices({ services: { wayflow: { ports: ["${WAYFLOW_PORT_SPEC}"] } } })).toEqual(["wayflow"]);
  });

  it("does NOT name a service whose host port is stated and only the CONTAINER port defers", () => {
    // "23010:${TARGET}" states host port 23010; the container port is not a
    // published-host-port truth.
    const doc = { services: { db: { ports: ["23010:${TARGET}"] } } };
    expect(interpolatedPortServices(doc)).toEqual([]);
    expect(publishedPortsByService(doc)).toEqual({ db: [23010] });
  });

  it("does NOT name a service that simply publishes nothing, or an ephemeral bind", () => {
    expect(interpolatedPortServices({ services: { worker: { image: "x" } } })).toEqual([]);
    expect(interpolatedPortServices({ services: { db: { ports: ["3010"] } } })).toEqual([]);
    expect(interpolatedPortServices({ services: { db: { ports: ["23010:3010"] } } })).toEqual([]);
  });

  it("names a service that MIXES a static and an interpolated entry (a partial statement)", () => {
    const doc = { services: { db: { ports: ["25434:5432", "${EXTRA_PORT}:9000"] } } };
    expect(interpolatedPortServices(doc)).toEqual(["db"]);
    expect(publishedPortsByService(doc)).toEqual({ db: [25434] });
  });

  it("is sorted and tolerates a malformed document", () => {
    expect(
      interpolatedPortServices({ services: { zeta: { ports: ["${Z}:1"] }, alpha: { ports: ["${A}:1"] } } }),
    ).toEqual(["alpha", "zeta"]);
    expect(interpolatedPortServices(null)).toEqual([]);
    expect(interpolatedPortServices({ services: null })).toEqual([]);
  });
});

describe("cinatra-cli#231 — an A2A-ERA compose still gains a LATER-baked service", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-231-a2aera-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  /** The checkout declares the a2a peers AND `wayflow` (the modern shape). */
  function peerDeps() {
    return {
      ...isolatedDeps(),
      composeConfigForFiles: () => RESOLVED_CONFIG_WITH_PEERS,
      composePublishedPortsForTarget: () => DEFAULT_BAND_WITH_PEERS,
      captureDeployedVersions: () => ({ ok: true, versions: {} }),
    };
  }

  function registryRow(installDir) {
    const reg = JSON.parse(readFileSync(process.env.CINATRA_INSTANCE_REGISTRY, "utf8"));
    const slug = Object.keys(reg.instances).find(
      (s) => path.resolve(reg.instances[s].installDir) === path.resolve(installDir),
    );
    return { reg, slug, row: reg.instances[slug] };
  }

  /**
   * Install, then age BOTH halves back into the a2a era: strip `wayflow` from the
   * generated compose file (a file written before cinatra#2654 baked the runtime
   * in — but one that DOES carry the a2a peers, so the old marker calls it
   * current) and from the recorded port map.
   */
  async function installThenAgeToA2aEra(name) {
    const installDir = path.join(sandbox, name);
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", name,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: peerDeps() },
    );
    expect(res.infraPlan).toBe("isolated");

    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);
    // Sanity: the FRESH file carries both, so the ageing below is what removes
    // the runtime — this test can only pass for the intended reason.
    expect(doc.services.wayflow).toBeDefined();
    expect(isolatedComposeHasA2aPeers(doc)).toBe(true);
    delete doc.services.wayflow;
    writeFileSync(isoPath, JSON.stringify(doc, null, 2) + "\n");
    // The aged file is EXACTLY the state the old marker mis-read as current.
    expect(isolatedComposeHasA2aPeers(doc)).toBe(true);

    const { reg, row } = registryRow(installDir);
    expect(row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    delete row.ports.wayflow;
    delete row.offset;
    writeFileSync(process.env.CINATRA_INSTANCE_REGISTRY, JSON.stringify(reg, null, 2) + "\n");

    return installDir;
  }

  function reconverge(installDir, extraArgs = []) {
    const lines = [];
    return runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", ...extraArgs,
      ],
      { log: (l) => lines.push(String(l)), deps: peerDeps() },
    ).then((res) => ({ res, lines }));
  }

  it("regenerates the file, and the tail names the OFFSET wayflow port", async () => {
    const installDir = await installThenAgeToA2aEra("iso231-a2aera");
    const { res, lines } = await reconverge(installDir);
    expect(res.infraPlan).toBe("isolated");
    expect(lines.join("\n")).toContain("converging on its own stack");

    // The regeneration ran (cinatra#2654 D1: a reconcile ALWAYS re-renders, so
    // the tail no longer names WHICH service was missing — it reports whether
    // the re-derived content actually changed, which it did here).
    const regenLine = lines.find((l) => l.includes("Regenerated docker-compose.cinatra-isolated.yml"));
    expect(regenLine).toBeDefined();
    expect(regenLine).toContain("content updated");

    // The file gained the runtime, at the recorded band offset.
    const { doc } = readGeneratedCompose(installDir);
    expect(publishedPortsByService(doc).wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    // …and nothing the a2a-era file already published moved.
    expect(publishedPortsByService(doc)["a2a-peer-alpha"]).toEqual([A2A_PEER_PORT + OFFSET]);

    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    expect(lines.join("\n")).not.toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);

    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
  });

  it("records the repair on the row, so `instance wayflow start` cannot name a different port", async () => {
    const installDir = await installThenAgeToA2aEra("iso231-a2aera-row");
    await reconverge(installDir);
    const { row } = registryRow(installDir);
    expect(row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    // The band the row already recorded is untouched — a repair, never a move.
    expect(row.ports.postgres).toEqual([5434 + OFFSET]);
    expect(row.ports["a2a-peer-alpha"]).toEqual([A2A_PEER_PORT + OFFSET]);
  });

  it("a row that lags a file which is ALREADY current is repaired without a regeneration", async () => {
    // The other half of the same defect: nothing is wrong with the compose file,
    // so no regeneration is due — but the recorded map still has no `wayflow`
    // entry, and it was that map the tail printed from.
    const installDir = path.join(sandbox, "iso231-rowlag");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso231rowlag",
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: peerDeps() },
    );
    const { reg, row } = registryRow(installDir);
    delete row.ports.wayflow;
    delete row.offset;
    writeFileSync(process.env.CINATRA_INSTANCE_REGISTRY, JSON.stringify(reg, null, 2) + "\n");

    const { lines } = await reconverge(installDir);
    // cinatra#2654 D1: a reconcile ALWAYS re-renders now (never skips on a
    // service-presence "up to date" test — that test is exactly what let a
    // stale/broken compose survive a reconcile), so a regeneration line is
    // still printed here; it just reports no CONTENT change, which is the
    // real point this test protects: the file needed no repair, only the row.
    const regenLine = lines.find((l) => l.includes("Regenerated docker-compose.cinatra-isolated.yml"));
    expect(regenLine).toBeDefined();
    expect(regenLine).toContain("content unchanged");

    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
    expect(registryRow(installDir).row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
  });

  it("an EXPLICIT attach states and provisions the endpoints its own stack publishes", async () => {
    // `--on-conflict=attach` bypasses the re-converge entirely, so it had only
    // the recorded map to speak from and never regenerated.
    const installDir = path.join(sandbox, "iso231-attach");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso231attach",
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: peerDeps() },
    );
    const { reg, row } = registryRow(installDir);
    delete row.ports.wayflow;
    writeFileSync(process.env.CINATRA_INSTANCE_REGISTRY, JSON.stringify(reg, null, 2) + "\n");
    // Point .env.local at the default, so "re-pointed" can only be satisfied by
    // the attach actually doing it.
    const envPath = path.join(installDir, ".env.local");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        /^WAYFLOW_BASE_URL=.*$/m,
        `WAYFLOW_BASE_URL=http://127.0.0.1:${DEFAULT_WAYFLOW_PORT}`,
      ),
    );

    const lines = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log: (l) => lines.push(String(l)), deps: peerDeps() },
    );
    expect(res.infraPlan).toBe("attach");

    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toBeDefined();
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    expect(lines.join("\n")).not.toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);

    const env = readFileSync(envPath, "utf8");
    expect(env).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${EXPECTED_WAYFLOW_PORT}`, "m"));
    const printedPort = Number(runtimeLine.match(/http:\/\/localhost:(\d+)/)[1]);
    const recordedPort = Number(env.match(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:(\d+)/m)[1]);
    expect(printedPort).toBe(recordedPort);
    expect(registryRow(installDir).row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#237 — the coordinator's adversarial convergence pass on #231's
// PR found a parseable generated compose is not automatically AUTHORITATIVE
// over the recorded row: a service the file no longer publishes must not
// survive from a stale row entry (finding 1), and a SHARED service whose port
// genuinely diverges between the two must abort the run rather than launch
// outside the recorded allocation (findings 2 + 4).
// ---------------------------------------------------------------------------
describe("cinatra-cli#237 — a diverging or shrunk compose file is never blindly trusted through the row", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-237-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  function registryRow(installDir) {
    const reg = JSON.parse(readFileSync(process.env.CINATRA_INSTANCE_REGISTRY, "utf8"));
    const slug = Object.keys(reg.instances).find(
      (s) => path.resolve(reg.instances[s].installDir) === path.resolve(installDir),
    );
    return { reg, slug, row: reg.instances[slug] };
  }

  async function freshIsolatedInstall(name, deps = isolatedDeps()) {
    const installDir = path.join(sandbox, name);
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", name,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps },
    );
    expect(res.infraPlan).toBe("isolated");
    return installDir;
  }

  it("finding 1: a service the FILE no longer publishes drops out of the effective map, even though the row still records it", async () => {
    const installDir = await freshIsolatedInstall("iso237-gone");

    // The service genuinely disappears from the generated compose (removed from
    // the checkout's own compose, or an operator edit) — the row still carries
    // its old (now stale) port.
    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);
    expect(doc.services.wayflow).toBeDefined();
    delete doc.services.wayflow;
    writeFileSync(isoPath, JSON.stringify(doc, null, 2) + "\n");

    const { row: freshRow } = registryRow(installDir);
    expect(freshRow.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);

    // Point .env.local at the DEFAULT port first: `writeIsolatedAppEnv` only
    // re-points WAYFLOW_BASE_URL when `ports.wayflow` is present, so this value
    // is what would catch a regression that starts rewriting it from a phantom
    // recorded entry again.
    const envPath = path.join(installDir, ".env.local");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        /^WAYFLOW_BASE_URL=.*$/m,
        `WAYFLOW_BASE_URL=http://127.0.0.1:${DEFAULT_WAYFLOW_PORT}`,
      ),
    );

    const lines = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log: (l) => lines.push(String(l)), deps: isolatedDeps() },
    );
    expect(res.infraPlan).toBe("attach");

    // The tail must NOT advertise the stale recorded port for a service the
    // stack does not contain — it falls back to the default, the honest
    // "this instance has no wayflow port of its own" answer, rather than a
    // dead (or worse, another instance's live) port.
    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toBeDefined();
    expect(runtimeLine).not.toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    expect(runtimeLine).toContain(`http://localhost:${DEFAULT_WAYFLOW_PORT}`);

    // .env.local must not be (re-)pointed at the phantom port either.
    const env = readFileSync(envPath, "utf8");
    expect(env).not.toMatch(new RegExp(`WAYFLOW_BASE_URL=\\S*:${EXPECTED_WAYFLOW_PORT}\\b`));

    // The row is corrected — the stale entry does not survive to mislead
    // `cinatra instance wayflow start` (cinatra-cli#240) into naming a port the
    // stack does not bind.
    expect(registryRow(installDir).row.ports.wayflow).toBeUndefined();
    // What the file DOES still publish is untouched — a repair, never a wipe.
    expect(registryRow(installDir).row.ports.postgres).toEqual([5434 + OFFSET]);
  });

  // ── round-2 finding 1 ──────────────────────────────────────────────────────
  // A parse-success file whose bindings are VARIABLE-BACKED states no static
  // port for those services. Under wholesale replacement it looked exactly like
  // a removed service, so the run DELETED a legitimate recorded allocation,
  // rewrote `.env.local` without that endpoint, and launched anyway.
  it("round-2 finding 1: a service whose published port is INTERPOLATED keeps its recorded allocation", async () => {
    const installDir = await freshIsolatedInstall("iso237-interp");
    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);

    // Two supported spellings, both valid Compose resolved at `up` time.
    doc.services.wayflow.ports[0].published = "${WAYFLOW_PORT}";
    doc.services.redis.ports = ["${REDIS_PORT}:6379"];
    // ...and, in the SAME file, a genuinely REMOVED service — the case round-1
    // finding 1 closed, which must stay closed. If the fallback were a blanket
    // overlay of the recorded map, this entry would come back too.
    delete doc.services["nango-server"];
    writeFileSync(isoPath, JSON.stringify(doc, null, 2) + "\n");

    const { row: freshRow } = registryRow(installDir);
    expect(freshRow.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    expect(freshRow.ports["nango-server"]).toEqual([3003 + OFFSET]);

    // Point .env.local at the DEFAULT wayflow port, so a re-point back to the
    // offset port is only possible from the SURVIVING recorded entry.
    const envPath = path.join(installDir, ".env.local");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        /^WAYFLOW_BASE_URL=.*$/m,
        `WAYFLOW_BASE_URL=http://127.0.0.1:${DEFAULT_WAYFLOW_PORT}`,
      ),
    );

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const lines = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log: (l) => lines.push(String(l)), deps },
    );
    expect(res.infraPlan).toBe("attach");
    // The interpolated ports are NOT a disagreement, so the stack comes up.
    expect(bringUpCalled).toBe(true);

    // The recorded allocations SURVIVE for the services the file declined to
    // speak for — not deleted, and not "repaired" to something else.
    const { row } = registryRow(installDir);
    expect(row.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);
    expect(row.ports.redis).toEqual([6379 + OFFSET]);
    // The service that genuinely LEFT the file still drops out (round-1
    // finding 1 — the two cases stay distinguishable).
    expect(row.ports["nango-server"]).toBeUndefined();
    // What the file DOES state stands unchanged.
    expect(row.ports.postgres).toEqual([5434 + OFFSET]);

    // The endpoints this run speaks come from the surviving allocation: the tail
    // and `.env.local` both name the offset port, never the default.
    const runtimeLine = lines.find((l) => l.includes("Agent runtime:"));
    expect(runtimeLine).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
    expect(readFileSync(envPath, "utf8")).toMatch(
      new RegExp(`WAYFLOW_BASE_URL=\\S*:${EXPECTED_WAYFLOW_PORT}\\b`),
    );
  });

  // ── round-2 finding 3 ──────────────────────────────────────────────────────
  // On the re-converge route `regenerateIsolatedComposeInPlace` ran BEFORE the
  // guard, rewriting the compose file AND the registry row. Worse: because it
  // re-derives the ports from the checkout at the RECORDED offset, it rewrote
  // the divergent port away — masking the disagreement so the abort never fired
  // and the stack came up on a silently clobbered file.
  it("round-2 finding 3: a divergent file that ALSO misses a service aborts BEFORE the regeneration mutates anything", async () => {
    const installDir = await freshIsolatedInstall("iso237-premutation");
    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);

    const recordedPgPort = 5434 + OFFSET;
    const divergedPgPort = recordedPgPort + 1000;
    doc.services.postgres.ports[0].published = String(divergedPgPort);
    // Missing a service the checkout declares → the in-place regeneration is
    // NOT a no-op here; it would run, rewrite the file (restoring postgres to
    // the recorded port) and persist a new row.
    delete doc.services.redis;
    const wroteBody = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(isoPath, wroteBody);

    const rowBefore = JSON.stringify(registryRow(installDir).row);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    // A plain re-run routes through the isolated re-converge (the regenerating one).
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        { log: () => {}, deps },
      ),
    ).rejects.toThrow(/postgres/);
    expect(bringUpCalled).toBe(false);

    // "Nothing was started, and nothing was changed" — literally. The compose
    // file is byte-identical to what the operator left, still diverged and still
    // missing the service the regeneration wanted to add.
    expect(readFileSync(isoPath, "utf8")).toBe(wroteBody);
    const after = readGeneratedCompose(installDir).doc;
    expect(String(after.services.postgres.ports[0].published)).toBe(String(divergedPgPort));
    expect(after.services.redis).toBeUndefined();
    // ...and the row is untouched, down to the `offset` the regeneration would
    // have persisted alongside its enlarged map.
    expect(JSON.stringify(registryRow(installDir).row)).toBe(rowBefore);
  });

  // ── round-2 finding 5 ──────────────────────────────────────────────────────
  // Every recovery path must actually change the state the abort reacts to. The
  // previous path 2 (`cinatra instance reset --yes`, then `cinatra install
  // --on-conflict=isolated`) did not: `instance reset` resets the dev DATABASE
  // and never touches the instance registry, and the re-install routes straight
  // back into this same convergence and throws again.
  it("round-2 finding 5: the abort names recovery steps that actually clear the state", async () => {
    const installDir = await freshIsolatedInstall("iso237-recovery");
    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);
    const recordedPgPort = 5434 + OFFSET;
    const divergedPgPort = recordedPgPort + 1000;
    doc.services.postgres.ports[0].published = String(divergedPgPort);
    writeFileSync(isoPath, JSON.stringify(doc, null, 2) + "\n");

    const { row, slug } = registryRow(installDir);
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps: { ...isolatedDeps(), bringUpInfra: () => {} } },
    ).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = err.message;

    // (1) restore the file — states the exact port to put back.
    expect(msg).toContain(`publishes ${recordedPgPort} again`);
    // (2) adopt the file's port — names the ROW field that disagrees, in the
    //     registry file that actually holds it, plus the exact `down` for this
    //     instance's recorded compose project.
    expect(msg).toContain(`instances["${slug}"].ports["postgres"] to [${divergedPgPort}]`);
    expect(msg).toContain(registryFile);
    expect(msg).toContain(`docker compose -p ${row.composeProject} -f docker-compose.cinatra-isolated.yml down`);
    // (3) start over — the row and the checkout marker both have to go, or a
    //     re-install lands back on the same record.
    expect(msg).toContain(`delete the "${slug}" entry from ${registryFile}`);
    expect(msg).toContain(".cinatra/instance.json");
    expect(msg).toContain("cinatra install --on-conflict=isolated");

    // The step that did NOT self-resolve is gone: `cinatra instance reset` is a
    // dev-DATABASE reset and leaves this row (and so this abort) exactly as it
    // was — offering it sent the operator in a circle.
    expect(msg).not.toContain("cinatra instance reset");
    // ...and a bare re-install is never offered as a way to "re-derive" the
    // record from the file: on its own it re-enters this same convergence.
    expect(msg).not.toMatch(/re-derived from the current file/);
  });

  it("findings 2 & 4: a SHARED service's port disagreeing between the row and the file ABORTS instead of launching the divergent stack", async () => {
    const installDir = await freshIsolatedInstall("iso237-diverge");

    const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    const { doc } = readGeneratedCompose(installDir);
    const recordedPgPort = 5434 + OFFSET;
    const divergedPgPort = recordedPgPort + 1000;
    expect(String(doc.services.postgres.ports[0].published)).toBe(String(recordedPgPort));
    doc.services.postgres.ports[0].published = String(divergedPgPort);
    writeFileSync(isoPath, JSON.stringify(doc, null, 2) + "\n");

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };

    // A plain re-run routes through the isolated re-converge.
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        { log: () => {}, deps },
      ),
    ).rejects.toThrow(/postgres/);
    expect(bringUpCalled).toBe(false);

    // Nothing was started, so the registry row is left exactly as recorded —
    // never a row and a (unlaunched) file quietly disagreeing (the split-brain
    // finding 4 closes the loop on).
    expect(registryRow(installDir).row.ports.postgres).toEqual([recordedPgPort]);

    // The explicit attach path aborts the same way — it never regenerates, so
    // it too had only the diverging file to speak from.
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "attach",
        ],
        { log: () => {}, deps },
      ),
    ).rejects.toThrow(/postgres/);
    expect(bringUpCalled).toBe(false);
    expect(registryRow(installDir).row.ports.postgres).toEqual([recordedPgPort]);
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#237 round 3. Three ways the convergence gate could still be
// walked past, and one way the repair could clobber a concurrent writer.
// ---------------------------------------------------------------------------

describe("cinatra-cli#237 round 3 — the gate cannot be laundered, skipped or raced", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-237r3-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  function registryRow(installDir) {
    const reg = JSON.parse(readFileSync(process.env.CINATRA_INSTANCE_REGISTRY, "utf8"));
    const slug = Object.keys(reg.instances).find(
      (s) => path.resolve(reg.instances[s].installDir) === path.resolve(installDir),
    );
    return { reg, slug, row: reg.instances[slug] };
  }

  async function freshIsolatedInstall(name, deps = isolatedDeps()) {
    const installDir = path.join(sandbox, name);
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", name,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps },
    );
    expect(res.infraPlan).toBe("isolated");
    return installDir;
  }

  const isoPathOf = (installDir) => path.join(installDir, "docker-compose.cinatra-isolated.yml");
  const writeCompose = (installDir, doc) =>
    writeFileSync(isoPathOf(installDir), JSON.stringify(doc, null, 2) + "\n");

  const RECORDED_REDIS = 6379 + OFFSET; // 26379

  // ── finding 1 ──────────────────────────────────────────────────────────────
  // The round-2 per-service fallback replaced a MIXED service's WHOLE list with
  // the recorded ports the moment ANY entry was interpolated. A service that
  // statically publishes a port OUTSIDE the allocated band therefore had that
  // port erased before the gate ever saw it: the effective map equalled the
  // recorded map, the gate passed, and Compose bound the out-of-band port.
  it("finding 1: a MIXED service whose STATIC port the row does NOT hold aborts — the interpolated entry cannot launder it", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-launder");
    const { doc } = readGeneratedCompose(installDir);

    const divergedRedis = RECORDED_REDIS + 10000; // 36379 — outside this instance's band.
    // The exact shape from the finding: one STATIC entry the record does not
    // hold, one INTERPOLATED entry alongside it.
    doc.services.redis.ports = [`${divergedRedis}:6379`, "${EXTRA}:9000"];
    const wroteBody = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(isoPathOf(installDir), wroteBody);

    expect(registryRow(installDir).row.ports.redis).toEqual([RECORDED_REDIS]);
    const rowBefore = JSON.stringify(registryRow(installDir).row);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };

    // Re-converge route.
    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps },
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/redis/);
    // The abort names the STATIC port the file publishes, not the recorded one —
    // that is the port Compose would actually bind.
    expect(err.message).toContain(String(divergedRedis));
    expect(bringUpCalled).toBe(false);
    expect(readFileSync(isoPathOf(installDir), "utf8")).toBe(wroteBody);
    expect(JSON.stringify(registryRow(installDir).row)).toBe(rowBefore);

    // ...and the explicit attach route aborts identically.
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "attach",
        ],
        { log: () => {}, deps },
      ),
    ).rejects.toThrow(/redis/);
    expect(bringUpCalled).toBe(false);
    expect(JSON.stringify(registryRow(installDir).row)).toBe(rowBefore);
  });

  // The other half of the same rule: the fallback still covers the INTERPOLATED
  // remainder. A mixed service whose static half AGREES with the record is not a
  // disagreement, and the recorded allocation must survive for the entry the
  // file declines to state (round-2 finding 1 stays closed).
  it("finding 1: a MIXED service whose static port the row DOES hold keeps its recorded allocation and launches", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-mixed-ok");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug } = registryRow(installDir);

    // The record holds a SECOND port for this service that the file never states
    // statically. That is what makes the fallback observable: without it the
    // effective map would carry only the static half, which is a length
    // disagreement against the record and would abort.
    const extraRecorded = RECORDED_REDIS + 1;
    const reg = JSON.parse(readFileSync(registryFile, "utf8"));
    reg.instances[slug].ports.redis = [RECORDED_REDIS, extraRecorded];
    writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");

    const { doc } = readGeneratedCompose(installDir);
    // One STATIC entry the record holds, one entry left to interpolation.
    doc.services.redis.ports = [`${RECORDED_REDIS}:6379`, "${EXTRA}:9000"];
    writeCompose(installDir, doc);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log: () => {}, deps },
    );
    expect(res.infraPlan).toBe("attach");
    // The static half agrees with the record, so this is not a disagreement.
    expect(bringUpCalled).toBe(true);
    // ...and the record answered for the INTERPOLATED remainder: the entry the
    // file declined to state survives whole, rather than being trimmed to the
    // static half the file happened to name.
    expect(registryRow(installDir).row.ports.redis).toEqual([RECORDED_REDIS, extraRecorded]);
  });

  // ── round-3 non-blocking 1 / round-4 blocker ──────────────────────────────
  // `firstSharedServicePortMismatch` used to compare list LENGTHS, so a shared
  // service that GAINED a port in the file (every recorded port still
  // published, plus a new one) read as a "disagreement" and aborted — even
  // though the file is a strict superset of the record, which is the lagging
  // row `persistIsolatedPortRepair` exists to repair, not a divergence to
  // refuse.
  //
  // Round-4's fix over-corrected: it accepted ANY superset, so a shared
  // service gaining a port OUTSIDE this instance's own recorded band no
  // longer aborted at all — the run launched on the foreign port and the row
  // silently ADOPTED it. The band-aware fix restores the abort for that case
  // while keeping the repair for a genuinely IN-BAND gain (a lagging row).
  it("round-4 blocker: a shared service that GAINS an IN-BAND port in the file repairs the row instead of aborting", async () => {
    const installDir = await freshIsolatedInstall("iso237r4-gained-inband");
    // OFFSET=20000, BAND_OFFSET_STEP=10000 → the instance's band is
    // [20000, 30000). This stays well inside it.
    const extraPort = RECORDED_REDIS + 100;
    expect(extraPort).toBeLessThan(OFFSET + 10000);
    // cinatra#2654 D1: a reconcile ALWAYS re-renders the generated compose (no
    // "already has every service" no-op). But the in-place regenerator's OWN
    // determinism guard (`sharedServicePortsAgree`) is strict-length, not
    // band-gated: it exists to stop a re-render from silently RELOCATING a
    // shared service, so a resolved config that would produce a different port
    // COUNT for redis than the recorded row holds makes it SKIP the write
    // entirely (leaving the file exactly as it stands) rather than adopt the
    // gain itself. So the gain has to reach the FILE the way it can actually
    // arise post-D1 — a sibling process (or, before this run, a still-running
    // one) already regenerated it — and the checkout's own resolved config is
    // given the same gain, so the skip fires instead of a silent overwrite back
    // to the row's stale single-port shape. The BAND-GATED adoption this test
    // is really about happens one layer up, in `persistIsolatedPortRepair`,
    // which reads the file (not the resolved config) once the skip leaves it be.
    const { doc } = readGeneratedCompose(installDir);
    doc.services.redis.ports = [`${RECORDED_REDIS}:6379`, `${extraPort}:6380`];
    writeCompose(installDir, doc);

    const resolvedConfigWithGain = {
      ...RESOLVED_CONFIG,
      services: {
        ...RESOLVED_CONFIG.services,
        redis: {
          ...RESOLVED_CONFIG.services.redis,
          ports: [
            ...RESOLVED_CONFIG.services.redis.ports,
            { published: String(extraPort - OFFSET), target: 6380, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
          ],
        },
      },
    };

    let bringUpCalled = false;
    const deps = {
      ...isolatedDeps(),
      composeConfigForFiles: () => resolvedConfigWithGain,
      bringUpInfra: () => { bringUpCalled = true; },
    };
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps },
    );
    // Not an abort — the run proceeds and brings the stack up.
    expect(res.infraPlan).toBe("isolated");
    expect(bringUpCalled).toBe(true);
    // The row picks up the gained port; the recorded one is not disturbed.
    expect(registryRow(installDir).row.ports.redis.slice().sort((a, b) => a - b)).toEqual(
      [RECORDED_REDIS, extraPort].sort((a, b) => a - b),
    );
  });

  // cinatra-cli#237 round-4 blocker (fail-first): on `c77c024`'s behavior this
  // gain is accepted — the run launches on the out-of-band port and the row
  // adopts it. The fix must abort instead, exactly as a genuine port MOVE
  // does, because the gained port may already belong to another instance's
  // allocation.
  it("round-4 blocker: a shared service that GAINS an OUT-OF-BAND port in the file still aborts", async () => {
    const installDir = await freshIsolatedInstall("iso237r4-gained-outband");
    const { doc } = readGeneratedCompose(installDir);
    // Outside [20000, 30000) — a plausible value for ANOTHER instance's band
    // (e.g. offset 40000), not this one's.
    const extraPort = RECORDED_REDIS + 5000;
    expect(extraPort).toBeGreaterThanOrEqual(OFFSET + 10000);
    doc.services.redis.ports = [`${RECORDED_REDIS}:6379`, `${extraPort}:6380`];
    writeCompose(installDir, doc);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps },
    ).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/redis/);
    expect(err.message).toContain(String(extraPort));
    // The whole point: the out-of-band port was never brought up, and the row
    // never adopted it.
    expect(bringUpCalled).toBe(false);
    expect(registryRow(installDir).row.ports.redis).toEqual([RECORDED_REDIS]);
  });

  // A legacy row that never recorded an `offset` cannot have a gain verified
  // in-band at all — the safe default is to treat it as a disagreement
  // (fail-closed) rather than silently adopt an unverifiable port.
  it("round-4 blocker: a gained port on a row with NO recorded offset aborts (band unverifiable)", async () => {
    const installDir = await freshIsolatedInstall("iso237r4-gained-nooffset");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug } = registryRow(installDir);
    // Simulate a legacy row: strip the recorded offset.
    const reg = JSON.parse(readFileSync(registryFile, "utf8"));
    delete reg.instances[slug].offset;
    writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");

    const { doc } = readGeneratedCompose(installDir);
    const extraPort = RECORDED_REDIS + 100; // in-band FOR THIS OFFSET, but the offset is now unrecorded
    doc.services.redis.ports = [`${RECORDED_REDIS}:6379`, `${extraPort}:6380`];
    writeCompose(installDir, doc);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps },
    ).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/redis/);
    expect(bringUpCalled).toBe(false);
  });

  // ── finding 2 ──────────────────────────────────────────────────────────────
  // The CLI writes its generated compose as JSON (a YAML subset), but an
  // operator may legitimately rewrite it in ordinary YAML. Compose parses and
  // launches that file; `JSON.parse` does not. Falling back to the recorded row
  // there re-armed exactly the blanket overlay findings 1/2 removed: a removed
  // service and a changed static port both become invisible.
  const YAML_COMPOSE = [
    "services:",
    "  postgres: &pg",
    "    image: postgres:16",
    "    ports:",
    '      - "25434:5432"',
    "  redis:",
    "    <<: *pg",
    "    image: redis:7",
    "    ports:",
    '      - "26379:6379"',
    "",
  ].join("\n");

  it("finding 2: a readable file the CLI cannot parse REFUSES to launch instead of falling back to the row", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-yaml");
    writeFileSync(isoPathOf(installDir), YAML_COMPOSE);
    const rowBefore = JSON.stringify(registryRow(installDir).row);

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps },
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    // Names the file it could not audit, and both ways out.
    expect(err.message).toContain("docker-compose.cinatra-isolated.yml");
    expect(err.message).toMatch(/cannot|could not/i);
    expect(err.message).toMatch(/regenerat/i);
    expect(bringUpCalled).toBe(false);

    // Nothing was started and nothing was changed — including the operator's
    // file, which is never clobbered.
    expect(readFileSync(isoPathOf(installDir), "utf8")).toBe(YAML_COMPOSE);
    expect(JSON.stringify(registryRow(installDir).row)).toBe(rowBefore);

    // The attach route refuses the same way (it never regenerates, so it had
    // only this unparseable file to speak from).
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "attach",
        ],
        { log: () => {}, deps },
      ),
    ).rejects.toThrow(/docker-compose\.cinatra-isolated\.yml/);
    expect(bringUpCalled).toBe(false);
  });

  it("finding 2: an ABSENT file still falls back to the recorded row (the round-1 ruling: only an unREADable file falls back)", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-absent");
    const rowBefore = JSON.stringify(registryRow(installDir).row);
    rmSync(isoPathOf(installDir));

    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const lines = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log: (l) => lines.push(String(l)), deps },
    );
    expect(res.infraPlan).toBe("attach");
    expect(bringUpCalled).toBe(true);
    // The row remains the best available source of truth, untouched.
    expect(JSON.stringify(registryRow(installDir).row)).toBe(rowBefore);
    // The endpoints still come from it.
    expect(lines.find((l) => l.includes("Agent runtime:"))).toContain(`http://localhost:${EXPECTED_WAYFLOW_PORT}`);
  });

  // ── finding 3 ──────────────────────────────────────────────────────────────
  // The gate validated a SNAPSHOT of the file and the launch used the file as it
  // stood later. `writeIsolatedAppEnv`'s "infra URLs re-pointed" line lands in
  // exactly that window (after the gate and the repair, before `startInfra`), so
  // hooking it reproduces the race deterministically.
  const REPOINT_LINE = "infra URLs re-pointed";

  it("finding 3: a file changed BETWEEN the gate and the launch aborts (attach)", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-toctou-attach");
    const recordedPg = 5434 + OFFSET;
    const divergedPg = recordedPg + 1000;

    let bringUpCalled = false;
    let swapped = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    // The concurrent writer: it lands after the gate has already passed on the
    // pristine file.
    const log = (l) => {
      if (!swapped && String(l).includes(REPOINT_LINE)) {
        swapped = true;
        const { doc } = readGeneratedCompose(installDir);
        doc.services.postgres.ports[0].published = String(divergedPg);
        writeCompose(installDir, doc);
      }
    };

    const err = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "attach",
      ],
      { log, deps },
    ).then(() => null, (e) => e);

    expect(swapped).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/postgres/);
    expect(err.message).toContain(String(divergedPg));
    // The whole point: the divergent stack was never brought up.
    expect(bringUpCalled).toBe(false);
  });

  it("finding 3: a file changed BETWEEN the gate and the launch aborts (re-converge)", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-toctou-reconv");
    const recordedPg = 5434 + OFFSET;
    const divergedPg = recordedPg + 1000;

    let bringUpCalled = false;
    let swapped = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const log = (l) => {
      if (!swapped && String(l).includes(REPOINT_LINE)) {
        swapped = true;
        const { doc } = readGeneratedCompose(installDir);
        doc.services.postgres.ports[0].published = String(divergedPg);
        writeCompose(installDir, doc);
      }
    };

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log, deps },
    ).then(() => null, (e) => e);

    expect(swapped).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/postgres/);
    expect(bringUpCalled).toBe(false);
  });

  // ── finding 4 ──────────────────────────────────────────────────────────────
  // `persistIsolatedPortRepair` validated against the CALLER's snapshot of the
  // row, then re-read the registry inside the lock and wrote `ports` without
  // comparing. A concurrent process that legitimately moved the row in that
  // window had its update silently overwritten by this run's stale-based repair.
  //
  // round 4: detecting the move used to be the end of it — the abandon path
  // logged a warning and RETURNED, and the caller carried on to rewrite
  // `.env.local` against this run's STALE ports and launch anyway. That
  // re-opened the exact split-brain finding 4 exists to close: this run would
  // advertise the old port while the registry held the mover's new one. The
  // abandon path must ABORT the whole run instead — neither the re-converge
  // nor the attach route may reach `startInfra` on a row it knows it lost.
  it("finding 4: a row moved by another process in the repair window aborts the run instead of skip-and-launch", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-race");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug, row: fullRow } = registryRow(installDir);

    const writeRowPorts = (ports) => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug].ports = ports;
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
    };

    // Make a repair genuinely WARRANTED, without touching the compose file: the
    // ROW lags it by one service. That is an absence on the recorded side, not a
    // disagreement, so the gate passes and the repair wants to add the entry
    // back — and the regeneration stays a no-op, since the file is complete.
    const laggingPorts = { ...fullRow.ports };
    delete laggingPorts.wayflow;
    writeRowPorts(laggingPorts);

    // What the "other process" writes while this run's repair is in flight.
    // Distinct from both the lagging row this run read and the map it derived.
    const concurrentPorts = { ...fullRow.ports, sentinel: [19999] };

    // `regenerateIsolatedComposeInPlace` resolves the checkout's compose config
    // AFTER this run has read its row and BEFORE `persistIsolatedPortRepair`
    // takes the allocation lock — i.e. exactly the window the finding is about.
    let moved = false;
    let bringUpCalled = false;
    const deps = {
      ...isolatedDeps(),
      bringUpInfra: () => { bringUpCalled = true; },
      composeConfigForFiles: (...args) => {
        if (!moved) {
          moved = true;
          writeRowPorts(concurrentPorts);
        }
        return isolatedDeps().composeConfigForFiles(...args);
      },
    };

    const lines = [];
    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: (l) => lines.push(String(l)), deps },
    ).then(() => null, (e) => e);
    expect(moved).toBe(true);

    // The abort, not a skip-and-continue: the run rejects instead of finishing.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/another|concurrent/i);
    expect(err.message).toMatch(/chang|mov/i);
    // cinatra#2654 D1: a reconcile ALWAYS re-renders now (the "file is already
    // complete, so regeneration stays a no-op" premise above no longer holds —
    // that is exactly the up-to-date-test D1 removed), so it is
    // `regenerateIsolatedComposeInPlace`'s OWN lock-compare that fires here, not
    // `persistIsolatedPortRepair`'s: the compose file is already REWRITTEN on
    // disk by the time this throw fires, so the message says so rather than
    // claiming "nothing was changed" (still true of the REGISTRY: the write
    // below is never reached).
    expect(err.message).toMatch(/regenerated docker-compose\.cinatra-isolated\.yml may already be rewritten on disk/i);
    // The whole point: a run that lost the race must never reach `startInfra` —
    // that is the route that would advertise this run's stale port while the
    // registry holds the other writer's new one.
    expect(bringUpCalled).toBe(false);

    // The other process's row STANDS — this run's stale-based repair did not
    // overwrite it, and in particular did not drop the entry it never saw.
    expect(registryRow(installDir).row.ports).toEqual(concurrentPorts);
  });

  it("finding 4: the hand-edit recovery tells the operator to stop concurrent cinatra operations first", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-recovery-text");
    const { doc } = readGeneratedCompose(installDir);
    doc.services.postgres.ports[0].published = String(5434 + OFFSET + 1000);
    writeCompose(installDir, doc);

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log: () => {}, deps: { ...isolatedDeps(), bringUpInfra: () => {} } },
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    // The recovery steps hand-edit the registry file; doing that while another
    // cinatra process holds the row is the race finding 4 closes in code.
    expect(err.message).toMatch(/stop .*cinatra|no other cinatra|concurrent cinatra/i);
  });

  // ── round-3 blocker ──────────────────────────────────────────────────────
  // `regenerateIsolatedComposeInPlace` is the re-converge route's SECOND
  // registry writer (`persistIsolatedPortRepair`, covered by finding 4 above,
  // is the first). It takes the alloc lock, re-reads the row, but used to
  // check only that the row still EXISTS, then write `{ports, offset}` derived
  // from the `row` snapshot read OUTSIDE the lock — a concurrent move in that
  // window was silently overwritten. Nor was it catchable afterwards: once
  // this write lands, `persistIsolatedPortRepair` runs with `ports` already
  // equal to what THIS write just made the row hold, so its own same-value
  // early return fires before it ever compares against `recordedPorts` — the
  // divergence that write caused is invisible downstream.
  //
  // The regeneration's own log line — emitted right after it writes the
  // compose FILE, right before it takes its OWN lock to write the registry —
  // is the seam: a concurrent writer landing there lands in exactly the
  // window between regeneration's outside read of `row.ports` and its lock.
  // A genuine regeneration (not a no-op) is needed to exercise this SECOND
  // writer at all, so only the FILE is aged (the row keeps its `wayflow`
  // entry) — the opposite of finding 4's fixture, which aged the ROW so the
  // first writer's window was the one under test.
  it("round-3 blocker: a row moved during the REGENERATION's own lock window aborts, not silently overwritten", async () => {
    const installDir = await freshIsolatedInstall("iso237r3-regen-race");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug, row: fullRow } = registryRow(installDir);

    // Age the FILE only: strip `wayflow` so the checkout's compose lags and a
    // real regeneration write is due. The row is untouched, so the write this
    // regeneration performs is the one under test, not a no-op.
    const { doc } = readGeneratedCompose(installDir);
    expect(doc.services.wayflow).toBeDefined();
    delete doc.services.wayflow;
    writeCompose(installDir, doc);
    expect(fullRow.ports.wayflow).toEqual([EXPECTED_WAYFLOW_PORT]);

    const writeRowPorts = (ports) => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug].ports = ports;
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
    };
    // What the "other process" writes DURING regeneration's own window.
    // Distinct from the row this run read, so overwriting it is detectable.
    const concurrentPorts = { ...fullRow.ports, sentinel: [19999] };

    let moved = false;
    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const log = (l) => {
      if (!moved && String(l).includes(`Regenerated ${"docker-compose.cinatra-isolated.yml"}`)) {
        moved = true;
        writeRowPorts(concurrentPorts);
      }
    };

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log, deps },
    ).then(() => null, (e) => e);
    expect(moved).toBe(true);

    // The abort, not a skip-and-continue: the run rejects instead of finishing.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/another|concurrent/i);
    expect(err.message).toMatch(/chang|mov/i);
    // round-4 non-blocking 2: on THIS path the compose FILE has already been
    // rewritten by the time this abort fires (`writeIsolatedComposeFile` runs
    // before the lock) — the message must say so honestly, rather than the
    // "nothing was changed" claim that would be false here.
    expect(err.message).toMatch(/may already be rewritten/i);
    expect(err.message).not.toMatch(/nothing was started, and nothing was\s+changed/i);
    // The whole point: a run that lost the race must never reach `startInfra`.
    expect(bringUpCalled).toBe(false);

    // The other process's row STANDS — the regeneration's own write did not
    // clobber it with the ports this run derived from its stale snapshot.
    expect(registryRow(installDir).row.ports).toEqual(concurrentPorts);
  });

  // ── round-4 non-blocking 3 ───────────────────────────────────────────────
  // The locked write above persists `{ports, offset}`, but the comparison
  // used to cover only `ports`. A concurrent writer that moves ONLY the row's
  // OFFSET (leaving `ports` exactly as this run read them) would therefore
  // read as agreement and be silently overwritten — a moved offset is a moved
  // row exactly like a moved port. Same fixture/seam as the round-3 blocker
  // above (age the FILE only, hook the regeneration's own log line), but the
  // concurrent writer touches `offset` instead of `ports`.
  it("round-4 NB3: a row whose OFFSET moved during the regeneration's own lock window aborts, even though ports alone still agree", async () => {
    const installDir = await freshIsolatedInstall("iso237r4-offset-race");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug, row: fullRow } = registryRow(installDir);

    const { doc } = readGeneratedCompose(installDir);
    expect(doc.services.wayflow).toBeDefined();
    delete doc.services.wayflow;
    writeCompose(installDir, doc);
    expect(fullRow.offset).toBe(OFFSET);

    const writeRowOffset = (offset) => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug].offset = offset;
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
    };
    const movedOffset = OFFSET + 10000;

    let moved = false;
    let bringUpCalled = false;
    const deps = { ...isolatedDeps(), bringUpInfra: () => { bringUpCalled = true; } };
    const log = (l) => {
      if (!moved && String(l).includes("Regenerated docker-compose.cinatra-isolated.yml")) {
        moved = true;
        writeRowOffset(movedOffset);
      }
    };

    const err = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      { log, deps },
    ).then(() => null, (e) => e);
    expect(moved).toBe(true);

    // The abort, not a skip-and-continue — and it must be caught by the OFFSET
    // comparison specifically: ports alone are unchanged from what this run
    // read, so only comparing offset catches this move.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/another|concurrent/i);
    expect(err.message).toMatch(/offset/i);
    expect(bringUpCalled).toBe(false);

    // The other process's offset STANDS — this run's write did not clobber it.
    expect(registryRow(installDir).row.offset).toBe(movedOffset);
  });

  // ── round-4 non-blocking 1 ───────────────────────────────────────────────
  // `regenerateIsolatedComposeInPlace` has TWO callers: `reconvergeIsolated`
  // (whose catch already rethrows a `CONCURRENT_ROW_MOVE` instead of treating
  // it as a best-effort regeneration failure — round-3 finding 1 / round-4)
  // and `runIsolatedA2aPeers`'s self-heal call, whose catch still swallowed it
  // as a warning and carried on to try to start the a2a peers against a
  // compose file that may already have been rewritten by the aborted
  // regeneration. This is the same race as the "round-3 blocker" test above,
  // exercised through the SECOND caller.
  it("round-4 NB1: the a2a-peers caller rethrows a concurrent row move instead of swallowing it", async () => {
    // Install WITHOUT the a2a-peers baked in (plain `isolatedDeps()`, exactly
    // the legacy shape `runIsolatedA2aPeers`'s self-heal exists for), then
    // drive it with peer-aware deps so the peers are genuinely MISSING and a
    // real regeneration is due.
    const installDir = await freshIsolatedInstall("iso237r4-a2a-race");
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const { slug, row: fullRow } = registryRow(installDir);
    const writeRowPorts = (ports) => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug].ports = ports;
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
    };
    const concurrentPorts = { ...fullRow.ports, sentinel: [19999] };

    let moved = false;
    const peerAwareDeps = {
      ...isolatedDeps(),
      composeConfigForFiles: () => RESOLVED_CONFIG_WITH_PEERS,
      composePublishedPortsForTarget: () => DEFAULT_BAND_WITH_PEERS,
      // `runIsolatedA2aPeers` checks `deps.isComposeAvailable` (NOT the
      // `composeAvailable` key `isolatedDeps()` sets for the main install
      // route) — without this the test falls through to a REAL `docker
      // compose version` probe, which is non-hermetic (fails on a machine
      // without Docker, or masks the race behind a slow real subprocess).
      isComposeAvailable: () => true,
      // Never actually reached on this path (the rethrow fires from inside
      // the self-heal regeneration, before `runCompose` is called) — stubbed
      // to fail loudly if that ever changes, rather than silently shelling
      // out to `docker`.
      runCompose: () => {
        throw new Error("runCompose should not be reached: the concurrent row move must abort before bring-up");
      },
    };
    const log = (l) => {
      if (!moved && String(l).includes("Regenerated docker-compose.cinatra-isolated.yml")) {
        moved = true;
        writeRowPorts(concurrentPorts);
      }
    };

    const err = await runIsolatedA2aPeers(["start"], { targetDir: installDir, log, deps: peerAwareDeps }).then(
      () => null,
      (e) => e,
    );
    expect(moved).toBe(true);
    // The abort, not a skip-and-continue: this caller must not swallow the
    // symbol and carry on trying to start the peers.
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/another|concurrent/i);
    expect(err.message).toMatch(/chang|mov|rewritten/i);
    // The other process's row STANDS.
    expect(registryRow(installDir).row.ports).toEqual(concurrentPorts);
  });

  // ── round 4 — samePortMaps compares normalised sets ─────────────────────────
  // The re-read comparison finding 4 relies on (`samePortMaps`) used to compare
  // the raw arrays with `JSON.stringify`: order, duplicates and string/number
  // spelling all then read as a disagreement, so a caller that legitimately
  // holds the SAME ports in a differently-shaped map (order not guaranteed, a
  // redundant declaration, a hand-edited registry row's port as a string) would
  // read as a concurrent move and abort a repair finding 4 needs to proceed.
  // `samePortMaps` has no other seam, so it is asserted directly via the
  // `__test` export rather than through the whole install pipeline.
  describe("round 4: samePortMaps compares normalised sets, not raw arrays", () => {
    const { samePortMaps } = installTest;

    it("a service's ports in a different ORDER read as the same map", () => {
      expect(samePortMaps({ postgres: [25434, 26379] }, { postgres: [26379, 25434] })).toBe(true);
    });

    it("a redundant DUPLICATE declaration reads as the same map", () => {
      expect(samePortMaps({ redis: [26379] }, { redis: [26379, 26379] })).toBe(true);
    });

    it("a STRING vs number spelling of the same port reads as the same map", () => {
      expect(samePortMaps({ postgres: [25434] }, { postgres: ["25434"] })).toBe(true);
    });

    it("a GENUINE port change still reads as a different map", () => {
      expect(samePortMaps({ postgres: [25434] }, { postgres: [35434] })).toBe(false);
    });

    it("a genuine move on ONE service still differs even when other services and the ordering are benign", () => {
      expect(
        samePortMaps(
          { postgres: [25434, 26379], redis: [6379] },
          { postgres: [26379, 25434], redis: [6380] },
        ),
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2654 round 6, BLOCKING B — a command that re-derives the generated
// compose for its OWN reason must reproduce the install the operator asked for.
//
// `regenerateIsolatedComposeInPlace` renders under a `wayflow` flag whose
// DEFAULT is `true`, and the `instance a2a` self-heal passed no flag at all. On
// a `--no-wayflow` install that default DEMANDS a bridge-token route the install
// deliberately never provisioned: the re-derive fails the wiring invariant, the
// self-heal swallows that as a warning, and `instance a2a start` then dead-ends
// on "the isolated compose does not include the a2a-peers services and could not
// be regenerated in place" — for an instance whose compose is exactly what its
// own install wrote. The choice is now RECORDED on the registry row at
// allocation and threaded through that caller.
// ---------------------------------------------------------------------------
describe("cinatra#2654 round 6 — the a2a self-heal reproduces the install's recorded WayFlow choice", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-2654r6-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  function registryRow(installDir) {
    const reg = JSON.parse(readFileSync(process.env.CINATRA_INSTANCE_REGISTRY, "utf8"));
    const slug = Object.keys(reg.instances).find(
      (s) => path.resolve(reg.instances[s].installDir) === path.resolve(installDir),
    );
    return { reg, slug, row: reg.instances[slug] };
  }

  // A Compose that INLINES `env_file:` — the route on which the WayFlow arm of
  // the wiring invariant has real teeth, because only an explicit non-empty
  // value can carry the token and the fixture's `wayflow` service carries none.
  // (That is precisely a `--no-wayflow` install: nothing ever wrote
  // `docker/wayflow/.wayflow.env`, so nothing could be inlined from it.)
  const inliningDeps = (extra = {}) => ({
    ...isolatedDeps(),
    composeSupportsNoEnvResolution: () => false,
    ...extra,
  });

  // The peers are genuinely MISSING from the recorded document (installed with
  // the plain fixture), so `instance a2a start` has a real self-heal to run.
  const peerAwareDeps = (extra = {}) =>
    inliningDeps({
      composeConfigForFiles: () => RESOLVED_CONFIG_WITH_PEERS,
      composePublishedPortsForTarget: () => DEFAULT_BAND_WITH_PEERS,
      // `runIsolatedA2aPeers` reads `deps.isComposeAvailable`, not the
      // `composeAvailable` key the install route uses — without it this falls
      // through to a REAL `docker compose version` probe.
      isComposeAvailable: () => true,
      ...extra,
    });

  async function leanIsolatedInstall(name) {
    const installDir = path.join(sandbox, name);
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", name,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
        "--no-wayflow",
      ],
      { log: () => {}, deps: inliningDeps() },
    );
    expect(res.infraPlan).toBe("isolated");
    return installDir;
  }

  const readIsoDoc = (installDir) =>
    JSON.parse(
      readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n"),
    );

  it("records the OPT-OUT on the registry row (an install that did not opt out records nothing)", async () => {
    const lean = await leanIsolatedInstall("iso2654r6-recorded-lean");
    expect(registryRow(lean).row.wayflow).toBe(false);

    // The default install is byte-identical to what it always recorded: an
    // ABSENT field, which every reader takes as "wayflow was in scope".
    const fullDir = path.join(sandbox, "iso2654r6-recorded-full");
    await runInstall(
      [
        "--dir", fullDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r6recfull",
        "--port-offset", String(OFFSET + 10000), "--app-port", String(APP_PORT + 1),
      ],
      { log: () => {}, deps: isolatedDeps() },
    );
    const fullRow = registryRow(fullDir).row;
    expect(fullRow.wayflow).toBeUndefined();
    expect(recordedWayflowChoice(fullRow)).toBe(true);
    expect(recordedWayflowChoice(registryRow(lean).row)).toBe(false);
    // A row from before the field existed reads as "in scope" too.
    expect(recordedWayflowChoice({ slug: "legacy" })).toBe(true);
  });

  // ── round-6 codex convergence ─────────────────────────────────────────────
  // `allocateInstance` returns an EXISTING same-directory row unchanged (its
  // idempotence contract), so a re-install never reached the field. Both
  // transitions were silently lost, and each breaks a LATER `instance a2a`
  // self-heal rather than the install that made them. The LATEST install
  // decides, exactly like the ports and offset it also re-records.
  it("a --no-wayflow RE-install of a recorded row records the opt-out (allocateInstance never sees it)", async () => {
    const installDir = path.join(sandbox, "iso2654r6-reinstall-optout");
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r6reoptout",
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    // (1) a normal install: nothing recorded, which reads as "wayflow in scope".
    await runInstall(args([]), { log: () => {}, deps: isolatedDeps() });
    expect(registryRow(installDir).row.wayflow).toBeUndefined();

    // (2) the operator changes their mind and re-installs lean.
    await runInstall(args(["--no-wayflow"]), { log: () => {}, deps: isolatedDeps() });
    const row = registryRow(installDir).row;
    expect(row.wayflow).toBe(false);
    expect(recordedWayflowChoice(row)).toBe(false);
    // …and nothing else about the row moved.
    expect(row.appPort).toBe(APP_PORT);
    expect(row.offset).toBe(OFFSET);
    expect(row.ports.wayflow).toEqual([DEFAULT_WAYFLOW_PORT + OFFSET]);
  });

  it("a re-install WITHOUT the opt-out clears a recorded opt-out (the key is DELETED, not written `true`)", async () => {
    const installDir = path.join(sandbox, "iso2654r6-reinstall-optin");
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r6reoptin",
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    await runInstall(args(["--no-wayflow"]), { log: () => {}, deps: inliningDeps() });
    expect(registryRow(installDir).row.wayflow).toBe(false);

    await runInstall(args([]), { log: () => {}, deps: isolatedDeps() });
    const row = registryRow(installDir).row;
    // A default row is byte-identical to what every previous version wrote:
    // ABSENT, never a literal `true`.
    expect(row.wayflow).toBeUndefined();
    expect("wayflow" in row).toBe(false);
    expect(recordedWayflowChoice(row)).toBe(true);
  });

  // ── round-6 codex convergence, round 2 ───────────────────────────────────
  // The alloc lock serialises WRITERS; it does not stop a slug from changing
  // hands. `cinatra instance remove x` plus a fresh install that re-uses the
  // slug for a DIFFERENT checkout leaves a re-install holding a slug that now
  // names someone else's row — and writing the choice onto it would flip THAT
  // instance's WayFlow setting. The write is identity-checked: same immutable
  // `id`, same install directory, or it is skipped.
  it("a slug that changed hands mid-run is NOT re-recorded (identity, not just the lock)", async () => {
    const installDir = path.join(sandbox, "iso2654r6-slug-reuse");
    const slug = "iso2654r6slugreuse";
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", slug,
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    // This checkout opted out, so a later re-install WITHOUT the flag wants to
    // DELETE the key — the destructive direction, and the one that silently
    // turns another instance's runtime back on.
    await runInstall(args(["--no-wayflow"]), { log: () => {}, deps: isolatedDeps() });
    expect(registryRow(installDir).row.wayflow).toBe(false);

    // Mid-run, another process removes the slug and re-uses it for a DIFFERENT
    // checkout that ALSO opted out. Fired from the re-render log line, so it
    // lands after this run read its row and before the choice is persisted.
    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const otherDir = path.join(sandbox, "iso2654r6-slug-reuse-other");
    let swapped = false;
    const swap = () => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug] = {
        ...reg.instances[slug],
        id: "inst_someone_else",
        installDir: otherDir,
        wayflow: false,
      };
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
      swapped = true;
    };

    // …and THIS run does not opt out, so its persist would delete that key.
    await runInstall(args([]), {
      log: (l) => {
        if (!swapped && String(l).includes("Regenerated docker-compose.cinatra-isolated.yml")) swap();
      },
      deps: isolatedDeps(),
    });
    expect(swapped).toBe(true);

    // The OTHER instance's opt-out stands: this run did not delete it, and did
    // not write its own choice onto a row it no longer owns.
    const after = JSON.parse(readFileSync(registryFile, "utf8")).instances[slug];
    expect(after.id).toBe("inst_someone_else");
    expect(after.installDir).toBe(otherDir);
    expect(after.wayflow).toBe(false);
  });

  // ── round-6 codex convergence, round 3 ───────────────────────────────────
  // The `id` cannot see a remove-and-reallocate of the SAME checkout under the
  // SAME slug: an allocation derives the id deterministically as
  // `inst_<slug>`, so the replacement row carries the identical one and the
  // directory matches too. `createdAt` — stamped once at allocation, never
  // rewritten by any patch writer — is what tells the two allocations apart.
  it("a slug REMOVED and re-allocated for the same checkout mid-run is a different allocation, and is left alone", async () => {
    const installDir = path.join(sandbox, "iso2654r6-realloc");
    const slug = "iso2654r6realloc";
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", slug,
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    await runInstall(args(["--no-wayflow"]), { log: () => {}, deps: isolatedDeps() });
    const first = registryRow(installDir).row;
    expect(first.wayflow).toBe(false);

    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    let realloced = false;
    const realloc = () => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      // Removed and re-created: same slug, same checkout, same derived id — a
      // NEW allocation, and only `createdAt` says so.
      reg.instances[slug] = { ...reg.instances[slug], createdAt: "2099-01-01T00:00:00.000Z", wayflow: false };
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
      realloced = true;
    };

    // This run does NOT opt out, so its persist would delete the new
    // allocation's opt-out.
    await runInstall(args([]), {
      log: (l) => {
        if (!realloced && String(l).includes("Regenerated docker-compose.cinatra-isolated.yml")) realloc();
      },
      deps: isolatedDeps(),
    });
    expect(realloced).toBe(true);

    const after = JSON.parse(readFileSync(registryFile, "utf8")).instances[slug];
    expect(after.id).toBe(first.id); // the id genuinely could not tell them apart
    expect(after.createdAt).toBe("2099-01-01T00:00:00.000Z");
    expect(after.wayflow).toBe(false);
  });

  // The promotion standing immediately after the choice write was older, and
  // slug-only: a hand-over during the bring-up marked the REPLACEMENT row ready
  // and overwrote its recorded SHA with this run's.
  it("the ready-promotion is identity-checked too: a PROVISIONING row that changed hands is not promoted", async () => {
    const installDir = path.join(sandbox, "iso2654r6-promote");
    const slug = "iso2654r6promote";
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", slug,
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      { log: () => {}, deps: isolatedDeps() },
    );
    // The PLAIN re-run (no --on-conflict): the route whose tail carries the
    // ready-promotion under test.
    const reRun = ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"];

    const registryFile = process.env.CINATRA_INSTANCE_REGISTRY;
    const otherDir = path.join(sandbox, "iso2654r6-promote-other");
    // Put the row back into `provisioning` so the re-run reaches the promotion.
    {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug] = { ...reg.instances[slug], state: "provisioning", sha: "aaaaaaa" };
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
    }

    let swapped = false;
    const swap = () => {
      const reg = JSON.parse(readFileSync(registryFile, "utf8"));
      reg.instances[slug] = {
        ...reg.instances[slug],
        id: "inst_someone_else",
        installDir: otherDir,
        state: "provisioning",
        sha: "bbbbbbb",
      };
      writeFileSync(registryFile, JSON.stringify(reg, null, 2) + "\n");
      swapped = true;
    };

    await runInstall(reRun, {
      log: (l) => {
        if (!swapped && String(l).includes("Regenerated docker-compose.cinatra-isolated.yml")) swap();
      },
      deps: isolatedDeps(),
    });
    expect(swapped).toBe(true);

    const after = JSON.parse(readFileSync(registryFile, "utf8")).instances[slug];
    // The other instance is NOT reported ready by this run, and keeps its SHA.
    expect(after.state).toBe("provisioning");
    expect(after.sha).toBe("bbbbbbb");
  });

  it("BLOCKING B: `instance a2a start` self-heals a --no-wayflow install WITHOUT demanding a bridge-token route", async () => {
    const installDir = await leanIsolatedInstall("iso2654r6-a2a-lean");

    // The install this reaches: lean by request. The `wayflow` service is
    // rendered (every profile-gated service is, so it can be enabled later) but
    // carries no token route, and nothing on disk could give it one.
    const before = readIsoDoc(installDir);
    expect(before.services.wayflow).toBeDefined();
    expect(before.services.wayflow.environment?.CINATRA_BRIDGE_TOKEN).toBeUndefined();
    expect(isolatedComposeHasA2aPeers(before)).toBe(false);

    let upCalled = false;
    const err = await runIsolatedA2aPeers(["start"], {
      targetDir: installDir,
      log: () => {},
      deps: peerAwareDeps({ runCompose: () => { upCalled = true; return { status: 0 }; } }),
    }).then(() => null, (e) => e);

    // THE FIX: the self-heal reproduces the install's own choice, so it
    // regenerates cleanly and the peers actually start.
    expect(err).toBe(null);
    expect(upCalled).toBe(true);

    const after = readIsoDoc(installDir);
    expect(isolatedComposeHasA2aPeers(after)).toBe(true);
    // …and the instance is still LEAN: the self-heal did not turn the agent
    // runtime on behind the operator's back by baking in a route for it.
    expect(after.services.wayflow.environment?.CINATRA_BRIDGE_TOKEN).toBeUndefined();
  });

  it("BLOCKING B, the other direction: a row that did NOT opt out still has the WayFlow route demanded", async () => {
    // Same inlining Compose, same tokenless fixture — but this install never
    // opted out, so the wiring invariant's WayFlow arm must still refuse. This
    // is the over-fix guard: threading `false` unconditionally (or dropping the
    // arm from this caller) would silently self-heal a BROKEN runtime into
    // place for an instance that does want one.
    const installDir = path.join(sandbox, "iso2654r6-a2a-full");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r6a2afull",
        "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ],
      // The install itself runs on a PRESERVING Compose (so it completes: the
      // `env_file:` reference carries the route). The a2a run below then meets
      // an INLINING one — an engine downgrade, or a different machine.
      { log: () => {}, deps: isolatedDeps() },
    );
    expect(registryRow(installDir).row.wayflow).toBeUndefined();

    const err = await runIsolatedA2aPeers(["start"], {
      targetDir: installDir,
      log: () => {},
      deps: peerAwareDeps({
        runCompose: () => {
          throw new Error("runCompose must not be reached: the WayFlow route is still demanded for this row");
        },
      }),
    }).then(() => null, (e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/a2a-peers services and could not be regenerated/i);
  });

  // ── round-7 review, NB2 ───────────────────────────────────────────────────
  // The re-record ran AFTER the bring-up on both re-install routes, so a failed
  // `up` left the row describing the PREVIOUS install's choice while the compose
  // on disk was already re-rendered for this one. The later `instance a2a`
  // self-heal reads that row, and the disagreement is invisible until it
  // demands (or skips) a bridge-token route for the wrong reason. The field
  // describes the RENDER, so it is written next to the regeneration it
  // describes — before the bring-up that can fail.
  const failingUpDeps = (extra = {}) =>
    inliningDeps({
      captureDeployedVersions: () => ({ ok: true, versions: {} }),
      bringUpInfra: () => {
        throw new Error("docker compose up failed (simulated)");
      },
      ...extra,
    });

  it("NB2: a FAILED bring-up on the RE-CONVERGE route still leaves the choice recorded", async () => {
    const installDir = path.join(sandbox, "iso2654r7-nb2-reconverge");
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r7nb2rec",
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    // (1) a normal install: nothing recorded, which reads as "wayflow in scope".
    await runInstall(args([]), { log: () => {}, deps: isolatedDeps() });
    expect(registryRow(installDir).row.wayflow).toBeUndefined();

    // (2) the operator re-installs LEAN — a plain re-run (no --on-conflict), so
    //     runInstall routes through the isolated re-converge — and the `up`
    //     fails after the compose has already been re-rendered without a
    //     WayFlow route.
    const err = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--no-wayflow",
      ],
      { log: () => {}, deps: failingUpDeps() },
    ).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);

    // THE FIX: the row describes the compose that WAS rendered, not the
    // bring-up that failed after it.
    const row = registryRow(installDir).row;
    expect(row.wayflow).toBe(false);
    expect(recordedWayflowChoice(row)).toBe(false);
  });

  it("NB2: a FAILED bring-up on the EXPLICIT --on-conflict=isolated re-run still leaves the choice recorded", async () => {
    const installDir = path.join(sandbox, "iso2654r7-nb2-explicit");
    const args = (extra) => [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso2654r7nb2exp",
      "--port-offset", String(OFFSET), "--app-port", String(APP_PORT),
      ...extra,
    ];
    await runInstall(args([]), { log: () => {}, deps: isolatedDeps() });
    expect(registryRow(installDir).row.wayflow).toBeUndefined();
    expect(registryRow(installDir).row.state).toBe("ready");

    // The idempotent re-run of a recorded READY row: it re-renders the compose,
    // then brings the stack up — and that `up` fails.
    const err = await runInstall(args(["--no-wayflow"]), { log: () => {}, deps: failingUpDeps() })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);

    const row = registryRow(installDir).row;
    expect(row.wayflow).toBe(false);
    expect(recordedWayflowChoice(row)).toBe(false);
  });
});
