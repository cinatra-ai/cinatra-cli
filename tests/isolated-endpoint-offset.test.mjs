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

import { runInstall } from "../src/install.mjs";
import {
  __test as isoTest,
  assertComposeAppUrlsRemapped,
  assertComposeHostUrlsRemapped,
  generateIsolatedCompose,
  publishedPortsByService,
} from "../src/install-isolation.mjs";
import { isolatedComposeHasA2aPeers, missingIsolatedServices } from "../src/isolated-a2a.mjs";
import { DEFAULT_APP_PORT as ALLOCATOR_DEFAULT_APP_PORT } from "../src/instance-alloc.mjs";
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

    // The regeneration ran and SAID which service the file did not carry.
    const regenLine = lines.find((l) => l.includes("Regenerated docker-compose.cinatra-isolated.yml"));
    expect(regenLine).toBeDefined();
    expect(regenLine).toContain("wayflow");

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
    // No regeneration: the file was current, which is the whole point.
    expect(lines.find((l) => l.includes("Regenerated docker-compose.cinatra-isolated.yml"))).toBeUndefined();

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
