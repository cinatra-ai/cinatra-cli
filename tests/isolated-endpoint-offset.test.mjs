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
import { __test as isoTest } from "../src/install-isolation.mjs";
import {
  DEFAULT_WAYFLOW_PORT,
  WAYFLOW_RUNTIME_LOCAL,
  wayflowEndpointForPorts,
  wayflowStatusLines,
} from "../src/wayflow-runtime.mjs";

const { remapEnvAppPortUrls, findUnmappedComposeAppUrls, DEFAULT_HOST_APP_PORT } = isoTest;

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

  it("stands down when the default app port IS a published compose port (the band remap owns it)", () => {
    // Both rewrites must never claim the same number: if a compose service really
    // publishes 3000, cinatra-cli#97's +offset shift is the correct owner.
    const published = new Set([3000, 5434]);
    expect(remapEnvAppPortUrls("http://host.docker.internal:3000", APP_PORT, 3000, published)).toBe(
      "http://host.docker.internal:3000",
    );
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

  it("the module's fallback default app port matches the allocator's", () => {
    // install.mjs passes instance-alloc's DEFAULT_APP_PORT on the real path; this
    // pins the import-light module's own fallback so the two cannot drift apart.
    expect(DEFAULT_HOST_APP_PORT).toBe(3000);
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
