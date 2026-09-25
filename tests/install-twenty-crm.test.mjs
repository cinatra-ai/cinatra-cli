// cinatra-cli#287 — `cinatra install` brings up a Twenty CRM beside the product
// on every development install and on the preview composition, seeds two
// example contact (People) views in it, and `instance start` reads back the
// connection the product's own development auto-connect makes to it.
//
// WHAT THESE ARMS PIN
// -------------------
//   T1  the rendered compose: exactly the four Twenty services, their pinned
//       container names unchanged, every published port on the loopback
//       interface, no `profiles`, the two ownership labels, and NO resolved
//       `name` anywhere (top level, network or volume) so the fixed project
//       derives one stable set of names; the file is written mode 0600.
//   T2  reuse-first by container name: none present -> one compose `up`; all
//       running -> no compose call; present but stopped -> `docker start` by
//       name only; a partial set -> the named refusal; `--no-twenty` -> the
//       skip line and no docker call at all; demo -> left to the demo overlay.
//   T3  the health wait's timeout is a named WARNING and the function resolves.
//   T4  the connection reading: the connected line only for attached AND
//       enabled, the named hint otherwise (after the bounded wait); read-only
//       query text; and it runs on both successful health paths of
//       `instance start` — never when the health probe did not answer.
//   T5  the example views: both present -> no key minted; absent -> the seed,
//       one mint whose DECORATED output is parsed by the connector's own parser,
//       then the product's own seeder with exactly the two-view manifest — and
//       the key never appears in an argv, a log line or a written file.
//   T6  wiring: runInstall calls it after the setup child for dev and for the
//       preview composition, never for prod, `--no-install`, `--no-setup` or
//       `--dry-run`; the choice is persisted in `.env.local`; runDevRefresh
//       calls it once after its reconcile.
//   T7  the install help lists `--no-twenty`.
//
// Hermetic: no Docker, no network, no database, no real Twenty image. Every
// external effect goes through an injected seam (a fake docker runner, a fake
// fetch, a fake query, a fake importer), and the `instance start` arms replace
// only the spawn of `pnpm dev`, the pid-ownership probe and the reader itself.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { INSTANCE_LOOPBACK_ADDRESS } from "../src/instance-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, "..");

// --- seams the `instance start` arms steer ---------------------------------
const startControl = vi.hoisted(() => ({
  spawn: null, // (command, args, options) => fake child, or null for the real spawn
  processMatch: null, // (pid, opts) => { alive, ours, why }, or null for the real probe
  readConnection: null, // (args) => void, or null for the real reader
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => (startControl.spawn ? startControl.spawn(...args) : actual.spawn(...args)),
  };
});

vi.mock("../src/clone-runtime.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    processCommandLineMatches: (...args) =>
      startControl.processMatch ? startControl.processMatch(...args) : actual.processCommandLineMatches(...args),
  };
});

vi.mock("../src/dev-twenty.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readDevTwentyConnection: (...args) =>
      startControl.readConnection ? startControl.readConnection(...args) : actual.readDevTwentyConnection(...args),
  };
});

afterAll(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("../src/clone-runtime.mjs");
  vi.doUnmock("../src/dev-twenty.mjs");
  vi.resetModules();
});

// Loaded inside each arm, so an arm whose subject is missing fails BY NAME.
const twenty = () => import("../src/dev-twenty.mjs");

// --- fixtures ---------------------------------------------------------------
const NAMES = ["cinatra-twenty-db-1", "cinatra-twenty-redis-1", "cinatra-twenty-1", "cinatra-twenty-worker-1"];
const SERVICES = ["twenty-db", "twenty-redis", "twenty-server", "twenty-worker"];
const VOLUMES = ["cinatra-twenty-db", "cinatra-twenty-redis", "cinatra-twenty-server"];
const PROJECT = "cinatra-dev-twenty";
// The all-interfaces bind the product's compose publishes on, spelled the way
// the CLI spells its loopback constant (no address literal in this file).
const ALL_INTERFACES = [0, 0, 0, 0].join(".");
const APPLE_WORKSPACE = "20202020-1c25-4d02-bf25-6aeccf7ea419";
// A FAKE workspace key, JWT-shaped so the connector's parser accepts it. It must
// never surface outside the process that minted it.
const FAKE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlLXdvcmtzcGFjZS1rZXkifQ.ZmFrZS1zaWduYXR1cmUtbm90LWEtc2VjcmV0";
const EXPECTED_MANIFEST = {
  version: 1,
  twenty: {
    views: [
      { fixtureId: "cli-twenty-view-people-contacts", name: "Demo contacts", objectType: "person", type: "table" },
      { fixtureId: "cli-twenty-view-people-prospects", name: "Demo prospects", objectType: "person", type: "table" },
    ],
  },
};

/** The shape `docker compose config --format json` resolves the product's
 *  compose to: checkout-derived names on the project, network and volumes,
 *  profile-gated services with `profiles`, ports on every interface. */
function resolvedProductCompose() {
  const twentyEnv = { PG_DATABASE_URL: "postgres://postgres:dev@twenty-db:5432/default", SERVER_URL: "http://localhost:3300" };
  return {
    name: "cinatra",
    services: {
      postgres: {
        container_name: "cinatra-postgres-1",
        image: "postgres:16",
        ports: [{ mode: "ingress", host_ip: INSTANCE_LOOPBACK_ADDRESS, target: 5432, published: "5434", protocol: "tcp" }],
        networks: { default: null },
      },
      "twenty-db": {
        container_name: "cinatra-twenty-db-1",
        image: "postgres:16",
        profiles: ["twenty"],
        ports: [{ mode: "ingress", target: 5432, published: "5532", protocol: "tcp" }],
        environment: { POSTGRES_DB: "default", POSTGRES_USER: "postgres" },
        volumes: [{ type: "volume", source: "cinatra-twenty-db", target: "/var/lib/postgresql/data", volume: {} }],
        networks: { default: null },
      },
      "twenty-redis": {
        container_name: "cinatra-twenty-redis-1",
        image: "redis:7",
        profiles: ["twenty"],
        ports: [{ mode: "ingress", host_ip: ALL_INTERFACES, target: 6379, published: "6479", protocol: "tcp" }],
        volumes: [{ type: "volume", source: "cinatra-twenty-redis", target: "/data", volume: {} }],
        networks: { default: null },
      },
      "twenty-server": {
        container_name: "cinatra-twenty-1",
        image: "twentycrm/twenty:dev-tag",
        profiles: ["twenty"],
        ports: [{ mode: "ingress", target: 3000, published: "3300", protocol: "tcp" }],
        environment: twentyEnv,
        volumes: [{ type: "volume", source: "cinatra-twenty-server", target: "/app/packages/twenty-server/.local-storage", volume: {} }],
        depends_on: { "twenty-db": { condition: "service_healthy", required: true }, "twenty-redis": { condition: "service_healthy", required: true } },
        networks: { default: null },
      },
      "twenty-worker": {
        container_name: "cinatra-twenty-worker-1",
        image: "twentycrm/twenty:dev-tag",
        profiles: ["twenty"],
        command: ["yarn", "worker:prod"],
        environment: twentyEnv,
        labels: ["com.example.keep=yes"],
        volumes: [{ type: "volume", source: "cinatra-twenty-server", target: "/app/packages/twenty-server/.local-storage", volume: {} }],
        depends_on: { "twenty-server": { condition: "service_healthy", required: true } },
        networks: { default: null },
      },
      "plane-web": { container_name: "cinatra-plane-web-1", image: "plane", profiles: ["plane"], networks: { default: null } },
    },
    networks: { default: { name: "cinatra_default", ipam: {} } },
    volumes: {
      "cinatra-postgres": { name: "cinatra_cinatra-postgres" },
      "cinatra-twenty-db": { name: "cinatra_cinatra-twenty-db" },
      "cinatra-twenty-redis": { name: "cinatra_cinatra-twenty-redis" },
      "cinatra-twenty-server": { name: "cinatra_cinatra-twenty-server" },
    },
  };
}

/** A checkout directory whose compose file names the Twenty stack by its pinned names. */
function makeTwentyCheckout(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "docker-compose.yml"),
    `services:\n${NAMES.map((n, i) => `  ${SERVICES[i]}:\n    container_name: ${n}\n`).join("")}`,
  );
  return root;
}

/** Fake docker: answers `ps` from `state` (name -> "running" | "exited"),
 *  the view-presence query from `viewNames`, and the mint with DECORATED log
 *  text around the fake key. Records every argv. */
function fakeDocker({ state = {}, viewNames = [], mintStatus = 0, upStatus = 0, upResults = null } = {}) {
  const calls = [];
  const ups = upResults ? [...upResults] : null;
  const docker = (args) => {
    calls.push([...args]);
    if (args[0] === "ps") {
      const out = Object.entries(state).map(([name, st]) => `${name}\t${st}`).join("\n");
      return { status: 0, stdout: out ? `${out}\n` : "", stderr: "" };
    }
    if (args[0] === "compose") {
      if (ups && ups.length > 0) return { stdout: "", ...ups.shift() };
      return { status: upStatus, stdout: "", stderr: upStatus ? "compose up failed" : "" };
    }
    if (args[0] === "start") return { status: 0, stdout: args.slice(1).join("\n"), stderr: "" };
    if (args[0] === "exec" && args[1] === "cinatra-twenty-db-1") {
      return { status: 0, stdout: viewNames.map((n) => `${n}\n`).join(""), stderr: "" };
    }
    if (args[0] === "exec" && args.includes("workspace:generate-api-key")) {
      return {
        status: mintStatus,
        stdout:
          "[Nest] 41  - 09/24/2026, 10:00:00 PM     LOG [NestFactory] Starting Nest application...\n" +
          `[Nest] 41  - 09/24/2026, 10:00:01 PM     LOG [GenerateApiKeyCommand] Generated API key: ${FAKE_KEY}\n` +
          "Done in 3.21s.\n",
        stderr: "",
      };
    }
    if (args[0] === "exec") return { status: 0, stdout: "seeded\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { docker, calls };
}

/** A fake clock: `sleep` advances `now`, so bounded waits end at once. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

/** The connector's own parser, as the checkout's extension clone exports it. */
const CONNECTOR_JWT_RE = /\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/;

/** Fake importer for the three checkout modules the seeding step loads. */
function fakeImporter({ seederThrows = false } = {}) {
  const seen = { urls: [], clients: [], seeds: [] };
  class FakeTwentyClient {
    constructor(opts) {
      seen.clients.push({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
    }
  }
  const importModule = async (url) => {
    seen.urls.push(String(url));
    if (url.endsWith("/extensions/cinatra-ai/twenty-connector/src/twenty-keygen.mjs")) {
      return { parseTwentyApiKey: (text) => { const m = String(text ?? "").match(CONNECTOR_JWT_RE); return m ? m[1] : null; } };
    }
    if (url.endsWith("/extensions/cinatra-ai/twenty-connector/scripts/twenty-bootstrap/lib/twenty-client.mjs")) {
      return { TwentyClient: FakeTwentyClient };
    }
    if (url.endsWith("/scripts/fixtures/seed-twenty-content.mjs")) {
      return {
        seedTwentyContent: async (args) => {
          seen.seeds.push({ manifest: structuredClone(args.manifest), catalogToolNames: args.catalogToolNames, client: args.client });
          // The thrown text carries the key itself, so only the scrub keeps it out.
          if (seederThrows) throw new Error(`seeder exploded: rejected bearer ${seen.clients.at(-1)?.apiKey}`);
          return { views: { created: 2, replaced: 0, skipped: 0, error: 0 }, listOk: { views: true } };
        },
      };
    }
    throw new Error(`unexpected import ${url}`);
  };
  return { importModule, seen };
}

function collectFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(p));
    else out.push(p);
  }
  return out;
}

let sandbox;
beforeAll(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-twenty-"));
});
afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => {
  startControl.spawn = null;
  startControl.processMatch = null;
  startControl.readConnection = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The deps every ensure arm shares; each arm overrides what it steers. */
function ensureDeps(extra = {}) {
  const clock = fakeClock();
  const written = [];
  return {
    written,
    deps: {
      home: path.join(sandbox, `home-${Math.random().toString(36).slice(2)}`),
      resolveComposeConfig: () => resolvedProductCompose(),
      writeFile: (file, text, opts) => written.push({ file, text, opts }),
      fetch: async () => ({ ok: true, status: 200 }),
      now: clock.now,
      sleep: clock.sleep,
      importModule: fakeImporter().importModule,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// T1 — the rendered compose.
// ---------------------------------------------------------------------------
describe("T1 renderDevTwentyCompose — one machine-shared stack under fixed names", () => {
  it("T1: keeps exactly the four services, pinned names, loopback ports, no profiles, the labels and no resolved names", async () => {
    const { renderDevTwentyCompose } = await twenty();
    const doc = renderDevTwentyCompose(resolvedProductCompose());
    expect(Object.keys(doc.services).sort()).toEqual([...SERVICES].sort());
    SERVICES.forEach((svc, i) => {
      const s = doc.services[svc];
      expect(s.container_name).toBe(NAMES[i]);
      expect(s).not.toHaveProperty("profiles");
      expect(s.labels["ai.cinatra.managed"]).toBe("true");
      expect(s.labels["ai.cinatra.kind"]).toBe("shared-twenty");
      for (const port of s.ports ?? []) expect(port.host_ip).toBe(INSTANCE_LOOPBACK_ADDRESS);
    });
    // Every published port of the product's three published services survives,
    // each on the loopback interface.
    const published = SERVICES.flatMap((svc) => (doc.services[svc].ports ?? []).map((p) => String(p.published))).sort();
    expect(published).toEqual(["3300", "5532", "6479"]);
    // A label the product declared is kept beside the ownership labels.
    expect(doc.services["twenty-worker"].labels["com.example.keep"]).toBe("yes");
    // No resolved name anywhere: the fixed project derives them.
    expect(doc).not.toHaveProperty("name");
    expect(Object.keys(doc.volumes).sort()).toEqual([...VOLUMES].sort());
    for (const v of Object.values(doc.volumes)) expect(v ?? {}).not.toHaveProperty("name");
    expect(Object.keys(doc.networks)).toEqual(["default"]);
    expect(doc.networks.default ?? {}).not.toHaveProperty("name");
  });

  it("T1: an overlay that renamed a Twenty container still renders the pinned name", async () => {
    const { renderDevTwentyCompose } = await twenty();
    const resolved = resolvedProductCompose();
    resolved.services["twenty-server"].container_name = "my-overlay-twenty";
    delete resolved.services["twenty-worker"].container_name;
    const doc = renderDevTwentyCompose(resolved);
    SERVICES.forEach((svc, i) => expect(doc.services[svc].container_name).toBe(NAMES[i]));
  });

  it("T1: a resolved document without the Twenty services is a named refusal", async () => {
    const { renderDevTwentyCompose } = await twenty();
    const doc = resolvedProductCompose();
    delete doc.services["twenty-worker"];
    expect(() => renderDevTwentyCompose(doc)).toThrow(/Twenty CRM.*twenty-worker/);
  });

  it("T1: a fresh bring-up writes that document mode 0600 under ~/.cinatra/twenty", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t1-write"));
    const { docker } = fakeDocker({ viewNames: ["Demo contacts", "Demo prospects"] });
    const { deps, written } = ensureDeps({ docker });
    await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps });
    expect(written).toHaveLength(1);
    expect(written[0].file).toBe(path.join(deps.home, ".cinatra", "twenty", "docker-compose.twenty.yml"));
    expect(written[0].opts.mode).toBe(0o600);
    const doc = JSON.parse(written[0].text);
    expect(Object.keys(doc.services).sort()).toEqual([...SERVICES].sort());
    expect(doc).not.toHaveProperty("name");
  });
});

// ---------------------------------------------------------------------------
// T2 — reuse-first by container name.
// ---------------------------------------------------------------------------
describe("T2 ensureDevTwentyCrm — reuse-first by name", () => {
  const presence = ["Demo contacts", "Demo prospects"];

  it("T2: none present -> ONE compose up of the rendered file under the fixed project", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-none"));
    const { docker, calls } = fakeDocker({ viewNames: presence });
    const { deps } = ensureDeps({ docker });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    const ps = calls.filter((c) => c[0] === "ps");
    expect(ps).toHaveLength(1);
    for (const name of NAMES) expect(ps[0]).toContain(`name=^${name}$`);
    const compose = calls.filter((c) => c[0] === "compose");
    expect(compose).toEqual([
      ["compose", "-p", PROJECT, "-f", path.join(deps.home, ".cinatra", "twenty", "docker-compose.twenty.yml"), "up", "-d"],
    ]);
    expect(calls.some((c) => c[0] === "start")).toBe(false);
    expect(res.action).toBe("created");
    expect(lines.join("\n")).toContain("http://localhost:3300");
    expect(lines.join("\n")).toMatch(/first development start/);
  });

  it("T2: all four running -> reuse, no compose call and no start", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-running"));
    const state = Object.fromEntries(NAMES.map((n) => [n, "running"]));
    const { docker, calls } = fakeDocker({ state, viewNames: presence });
    const { deps, written } = ensureDeps({ docker });
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps });
    expect(calls.some((c) => c[0] === "compose")).toBe(false);
    expect(calls.some((c) => c[0] === "start")).toBe(false);
    expect(written).toHaveLength(0);
    expect(res.action).toBe("reused");
  });

  it("T2: all four present, some stopped -> `docker start` of the stopped ones by name only", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-stopped"));
    const state = { [NAMES[0]]: "running", [NAMES[1]]: "exited", [NAMES[2]]: "running", [NAMES[3]]: "created" };
    const { docker, calls } = fakeDocker({ state, viewNames: presence });
    const { deps, written } = ensureDeps({ docker });
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps });
    expect(calls.filter((c) => c[0] === "start")).toEqual([["start", NAMES[1], NAMES[3]]]);
    expect(calls.some((c) => c[0] === "compose")).toBe(false);
    expect(written).toHaveLength(0);
    expect(res.action).toBe("started");
  });

  it("T2: a partial set is the named refusal that fails the install", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-partial"));
    const state = { [NAMES[0]]: "running", [NAMES[2]]: "exited" };
    const { docker, calls } = fakeDocker({ state });
    const { deps } = ensureDeps({ docker });
    await expect(ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps })).rejects.toThrow(
      /Twenty CRM: refusing.*2 of the 4.*cinatra-twenty-redis-1/s,
    );
    expect(calls.some((c) => c[0] === "compose" || c[0] === "start")).toBe(false);
  });

  it("T2: a failed `up` is a named refusal too", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-upfail"));
    const { docker } = fakeDocker({ upStatus: 1 });
    const { deps } = ensureDeps({ docker });
    await expect(ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps })).rejects.toThrow(
      /Twenty CRM: .*up -d failed/,
    );
  });

  it("T2: an `up` held back by a server slower than its healthcheck is the health warning; once it answers, ONE more up", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-unhealthy"));
    const unhealthy = { status: 1, stderr: "dependency failed to start: container cinatra-twenty-1 is unhealthy" };
    const { docker, calls } = fakeDocker({ viewNames: presence, upResults: [unhealthy, { status: 0, stderr: "" }] });
    const { deps } = ensureDeps({ docker });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    expect(res).toMatchObject({ action: "created", healthy: true });
    expect(calls.filter((c) => c[0] === "compose")).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/Twenty CRM WARNING: a Twenty service did not report healthy/);

    // Never answering: the same warning road, the function resolves, no second up.
    const dir2 = makeTwentyCheckout(path.join(sandbox, "t2-unhealthy-timeout"));
    const second = fakeDocker({ upResults: [unhealthy] });
    const { deps: deps2 } = ensureDeps({ docker: second.docker, fetch: async () => { throw new Error("ECONNREFUSED"); } });
    const lines2 = [];
    const res2 = await ensureDevTwentyCrm({ targetDir: dir2, mode: "dev", log: (l) => lines2.push(String(l)), deps: deps2 });
    expect(res2.healthy).toBe(false);
    expect(second.calls.filter((c) => c[0] === "compose")).toHaveLength(1);
    expect(lines2.join("\n")).toMatch(/WARNING.*did not answer/);
  });

  it("T2: a checkout whose compose file does not name the Twenty stack -> the named skip line and not one docker call", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = path.join(sandbox, "t2-older-checkout");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "docker-compose.yml"), "services:\n  postgres:\n    container_name: cinatra-postgres-1\n");
    const { docker, calls } = fakeDocker();
    const { deps, written } = ensureDeps({ docker });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    expect(res.action).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(lines).toEqual(["- Twenty CRM: skipped — this checkout's compose file does not declare the Twenty stack."]);
    // A directory with no compose file at all is the same skip.
    const bare = mkdtempSync(path.join(sandbox, "t2-no-compose-"));
    await ensureDevTwentyCrm({ targetDir: bare, mode: "dev", log: () => {}, deps });
    expect(calls).toHaveLength(0);
  });

  it("T2: none present and a resolved compose without the Twenty services -> a named WARNING, no compose call, resolves", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-undeclared"));
    const { docker, calls } = fakeDocker();
    const resolved = resolvedProductCompose();
    for (const svc of SERVICES) delete resolved.services[svc];
    const { deps, written } = ensureDeps({ docker, resolveComposeConfig: () => resolved });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    expect(res.action).toBe("skipped");
    expect(calls.some((c) => c[0] === "compose" || c[0] === "start" || c[0] === "exec")).toBe(false);
    expect(written).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/Twenty CRM WARNING: .*does not declare twenty-db, twenty-redis, twenty-server, twenty-worker/);
  });

  it("T2: --no-twenty -> the skip line and not one docker call", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-off"));
    const { docker, calls } = fakeDocker();
    const { deps } = ensureDeps({ docker });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", noTwenty: true, log: (l) => lines.push(String(l)), deps });
    expect(calls).toHaveLength(0);
    expect(res.action).toBe("skipped");
    expect(lines.join("\n")).toMatch(/Twenty CRM: skipped.*--no-twenty/);
  });

  it("T2: demo -> one line saying the demo overlay owns the CRM, no docker call", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t2-demo"));
    const { docker, calls } = fakeDocker();
    const { deps } = ensureDeps({ docker });
    const lines = [];
    await ensureDevTwentyCrm({ targetDir: dir, mode: "demo", log: (l) => lines.push(String(l)), deps });
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/demo overlay/);
  });
});

// ---------------------------------------------------------------------------
// T3 — the health wait warns, never fails.
// ---------------------------------------------------------------------------
describe("T3 ensureDevTwentyCrm — bounded health wait", () => {
  it("T3: a CRM that never answers /healthz ends in the named WARNING and the function resolves", async () => {
    const { ensureDevTwentyCrm, DEV_TWENTY_HEALTH_TIMEOUT_MS } = await twenty();
    expect(DEV_TWENTY_HEALTH_TIMEOUT_MS).toBe(300_000);
    const dir = makeTwentyCheckout(path.join(sandbox, "t3"));
    const { docker, calls } = fakeDocker();
    const fetched = [];
    const { deps } = ensureDeps({
      docker,
      fetch: async (url) => {
        fetched.push(String(url));
        throw new Error("ECONNREFUSED");
      },
    });
    const lines = [];
    const res = await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    expect(res.healthy).toBe(false);
    expect(fetched.length).toBeGreaterThan(1);
    expect(new Set(fetched)).toEqual(new Set(["http://localhost:3300/healthz"]));
    expect(lines.join("\n")).toMatch(/WARNING.*did not answer http:\/\/localhost:3300\/healthz within 300 s/);
    // No seeding against a CRM that never answered.
    expect(calls.some((c) => c[0] === "exec")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4 — the connection reading.
// ---------------------------------------------------------------------------
describe("T4 readDevTwentyConnection — reads two booleans, writes nothing", () => {
  function readerDeps(rowsFor, env = {}) {
    const clock = fakeClock();
    const texts = [];
    return {
      texts,
      deps: {
        readEnv: () => ({ SUPABASE_DB_URL: "postgresql://fake", SUPABASE_SCHEMA: "cinatra_inst", ...env }),
        query: async (text) => {
          texts.push(text);
          return rowsFor(texts.length);
        },
        now: clock.now,
        sleep: clock.sleep,
      },
    };
  }

  it("T4: attached AND enabled -> exactly the connected line", async () => {
    const { readDevTwentyConnection, DEV_TWENTY_CONNECTED_LINE } = await twenty();
    const { deps, texts } = readerDeps(() => [{ attached: true, enabled: true }]);
    const lines = [];
    const res = await readDevTwentyConnection({ repoRoot: "/nowhere", log: (l) => lines.push(String(l)), deps });
    expect(res.connected).toBe(true);
    expect(lines).toEqual([DEV_TWENTY_CONNECTED_LINE]);
    expect(DEV_TWENTY_CONNECTED_LINE).toBe("Twenty CRM: connected by the product's development auto-connect");
    expect(texts).toHaveLength(1);
  });

  it("T4: the connected line also follows a row that becomes attached during the wait", async () => {
    const { readDevTwentyConnection, DEV_TWENTY_CONNECTED_LINE } = await twenty();
    const { deps } = readerDeps((n) => (n < 3 ? [] : [{ attached: true, enabled: true }]));
    const lines = [];
    await readDevTwentyConnection({ repoRoot: "/nowhere", log: (l) => lines.push(String(l)), deps });
    expect(lines).toEqual([DEV_TWENTY_CONNECTED_LINE]);
  });

  for (const [label, rows] of [
    ["attached but disabled", [{ attached: true, enabled: false }]],
    ["unattached", [{ attached: false, enabled: true }]],
    ["absent", []],
  ]) {
    it(`T4: ${label} -> the named hint after the bounded wait`, async () => {
      const { readDevTwentyConnection, DEV_TWENTY_NOT_CONNECTED_LINE, DEV_TWENTY_CONNECT_TIMEOUT_MS, DEV_TWENTY_CONNECT_POLL_MS } =
        await twenty();
      expect(DEV_TWENTY_CONNECT_TIMEOUT_MS).toBe(180_000);
      expect(DEV_TWENTY_CONNECT_POLL_MS).toBe(5_000);
      const { deps, texts } = readerDeps(() => rows);
      const lines = [];
      const res = await readDevTwentyConnection({ repoRoot: "/nowhere", log: (l) => lines.push(String(l)), deps });
      expect(res.connected).toBe(false);
      expect(lines).toEqual([DEV_TWENTY_NOT_CONNECTED_LINE]);
      expect(DEV_TWENTY_NOT_CONNECTED_LINE).toMatch(/^Twenty CRM: not connected yet .*auto-connect did not attach a key; see the app log/);
      // Polled for the whole bounded window, every five seconds.
      expect(texts.length).toBe(180_000 / 5_000 + 1);
    });
  }

  it("T4: a query that never returns cannot hold the start — each attempt is bounded, then the hint", async () => {
    const { readDevTwentyConnection, DEV_TWENTY_NOT_CONNECTED_LINE, DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS } = await twenty();
    expect(DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS).toBe(10_000);
    const { deps, texts } = readerDeps(() => new Promise(() => {}));
    const lines = [];
    const res = await readDevTwentyConnection({
      repoRoot: "/nowhere",
      log: (l) => lines.push(String(l)),
      deps: { ...deps, queryTimeoutMs: 5 },
    });
    expect(res.connected).toBe(false);
    expect(lines).toEqual([DEV_TWENTY_NOT_CONNECTED_LINE]);
    expect(texts.length).toBe(180_000 / 5_000 + 1);
  });

  it("T4: a failing query never fails the start — it ends in the hint", async () => {
    const { readDevTwentyConnection, DEV_TWENTY_NOT_CONNECTED_LINE } = await twenty();
    const { deps } = readerDeps(() => {
      throw new Error('relation "external_mcp_servers" does not exist');
    });
    const lines = [];
    await expect(readDevTwentyConnection({ repoRoot: "/nowhere", log: (l) => lines.push(String(l)), deps })).resolves.toMatchObject({
      connected: false,
    });
    expect(lines).toEqual([DEV_TWENTY_NOT_CONNECTED_LINE]);
  });

  it("T4: the query names the two columns and the one id, in the instance schema, and writes nothing", async () => {
    const { readDevTwentyConnection } = await twenty();
    const { deps, texts } = readerDeps(() => [{ attached: true, enabled: true }]);
    await readDevTwentyConnection({ repoRoot: "/nowhere", log: () => {}, deps });
    const text = texts[0];
    expect(text).toMatch(/nango_connection_id IS NOT NULL\) AS attached/);
    expect(text).toMatch(/\benabled\b/);
    expect(text).toContain('FROM "cinatra_inst".external_mcp_servers');
    expect(text).toContain("WHERE id = 'twenty-workspace'");
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(text).not.toMatch(/\*/);
  });

  it("T4: CINATRA_TWENTY_MODE=off skips the reading entirely", async () => {
    const { readDevTwentyConnection } = await twenty();
    const { deps, texts } = readerDeps(() => [{ attached: true, enabled: true }], { CINATRA_TWENTY_MODE: "off" });
    const lines = [];
    const res = await readDevTwentyConnection({ repoRoot: "/nowhere", log: (l) => lines.push(String(l)), deps });
    expect(res.skipped).toBe(true);
    expect(texts).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });
});

describe("T4 instance start — the reading runs on both successful health paths", () => {
  let checkoutRoot;
  let home;
  let port;
  const saved = {};
  let reads;

  async function freePort() {
    return await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, INSTANCE_LOOPBACK_ADDRESS, () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
  }

  beforeEach(async () => {
    for (const k of ["HOME", "CINATRA_REPO_ROOT", "PORT"]) saved[k] = process.env[k];
    home = mkdtempSync(path.join(sandbox, "start-home-"));
    checkoutRoot = mkdtempSync(path.join(sandbox, "start-checkout-"));
    writeFileSync(path.join(checkoutRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    mkdirSync(path.join(checkoutRoot, "packages", "migrations"), { recursive: true });
    writeFileSync(
      path.join(checkoutRoot, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    port = await freePort();
    writeFileSync(path.join(checkoutRoot, ".env.local"), `CINATRA_RUNTIME_MODE=development\nPORT=${port}\n`);
    process.env.HOME = home;
    process.env.CINATRA_REPO_ROOT = checkoutRoot;
    delete process.env.PORT;
    reads = [];
    startControl.readConnection = async (args) => {
      reads.push(args);
      return { connected: true };
    };
    // `pnpm dev` is never spawned: a fake child with a pid nothing owns.
    startControl.spawn = () => ({ pid: 2_147_000_001, on: () => {}, unref: () => {} });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function start() {
    const { buildHandlers } = await import("../src/index.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await buildHandlers()["dev.start"]([]);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }

  it("T4: a fresh start that answers its health probe runs the reading once", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200 }));
    await start();
    expect(reads).toHaveLength(1);
    expect(reads[0].repoRoot).toBe(checkoutRoot);
  });

  it("T4: an already-running start runs the reading once", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200 }));
    const pidDir = path.join(home, ".cinatra", "clones", "dev-main");
    mkdirSync(pidDir, { recursive: true });
    writeFileSync(path.join(pidDir, "nextjs.pid"), `2147000002\n${new Date().toISOString()}\n`);
    startControl.processMatch = () => ({ alive: true, ours: true, why: "fake" });
    await start();
    expect(reads).toHaveLength(1);
    expect(reads[0].repoRoot).toBe(checkoutRoot);
  });

  it("T4: a slow first start reads nothing; started again once healthy, it reads once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let healthy = false;
    vi.stubGlobal("fetch", async () => {
      if (healthy) return { ok: true, status: 200 };
      // Jump the clock past the probe window, so the slow start ends at once.
      vi.setSystemTime(new Date(Date.now() + 120_000));
      throw new Error("ECONNREFUSED");
    });
    await start();
    expect(reads).toHaveLength(0);
    healthy = true;
    startControl.processMatch = () => ({ alive: true, ours: true, why: "fake" });
    await start();
    expect(reads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T5 — the example views, and the workspace key held only in-process.
// ---------------------------------------------------------------------------
describe("T5 ensureDevTwentyCrm — two example contact views", () => {
  const running = Object.fromEntries(NAMES.map((n) => [n, "running"]));

  it("T5: both views present -> the seed runs, no key is minted, no seeder call", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t5-present"));
    const { docker, calls } = fakeDocker({ state: running, viewNames: ["All People", "Demo contacts", "Demo prospects"] });
    const imp = fakeImporter();
    const { deps } = ensureDeps({ docker, importModule: imp.importModule });
    await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: () => {}, deps });
    expect(calls.some((c) => c.includes("workspace:generate-api-key"))).toBe(false);
    expect(imp.seen.seeds).toHaveLength(0);
    const presence = calls.find((c) => c[0] === "exec" && c[1] === "cinatra-twenty-db-1");
    expect(presence.slice(0, 8)).toEqual(["exec", "cinatra-twenty-db-1", "psql", "-U", "postgres", "-d", "default", "-At"]);
    const sql = presence[presence.length - 1];
    expect(sql).toMatch(/core\.view/);
    expect(sql).toMatch(/core\."objectMetadata"/);
    expect(sql).toMatch(/"nameSingular" = 'person'/);
    expect(sql).toContain(`o."workspaceId" = '${APPLE_WORKSPACE}'`);
    expect(sql).toMatch(/"deletedAt" IS NULL/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("T5: absent -> seed argv, one decorated mint parsed by the connector, then the product seeder with the two-view manifest", async () => {
    const { ensureDevTwentyCrm, DEV_TWENTY_VIEWS_MANIFEST } = await twenty();
    expect(DEV_TWENTY_VIEWS_MANIFEST).toEqual(EXPECTED_MANIFEST);
    const dir = makeTwentyCheckout(path.join(sandbox, "t5-absent"));
    const { docker, calls } = fakeDocker({ viewNames: ["All People", "Person Record Page Fields"] });
    const imp = fakeImporter();
    const { deps, written } = ensureDeps({ docker, importModule: imp.importModule });
    const lines = [];
    await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });

    const execs = calls.filter((c) => c[0] === "exec");
    expect(execs[0]).toEqual(["exec", "cinatra-twenty-1", "yarn", "command:prod", "workspace:seed:dev", "--light"]);
    const mints = execs.filter((c) => c.includes("workspace:generate-api-key"));
    expect(mints).toEqual([
      ["exec", "cinatra-twenty-1", "yarn", "command:prod", "workspace:generate-api-key", "-w", APPLE_WORKSPACE, "-n", "cinatra-install-seed"],
    ]);
    // The three modules come from the checkout's own trees.
    const base = pathToFileURL(dir).href;
    expect(imp.seen.urls).toEqual(
      expect.arrayContaining([
        `${base}/extensions/cinatra-ai/twenty-connector/src/twenty-keygen.mjs`,
        `${base}/extensions/cinatra-ai/twenty-connector/scripts/twenty-bootstrap/lib/twenty-client.mjs`,
        `${base}/scripts/fixtures/seed-twenty-content.mjs`,
      ]),
    );
    // The key reached the in-process client — and only it.
    expect(imp.seen.clients).toEqual([{ baseUrl: "http://localhost:3300", apiKey: FAKE_KEY }]);
    expect(imp.seen.seeds).toHaveLength(1);
    expect(imp.seen.seeds[0].manifest).toEqual(EXPECTED_MANIFEST);
    expect(imp.seen.seeds[0].catalogToolNames).toEqual([]);

    // THE KEY RULE: never in an argv, a log line, or a written file.
    expect(JSON.stringify(calls)).not.toContain(FAKE_KEY);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
    expect(JSON.stringify(written)).not.toContain(FAKE_KEY);
    for (const file of [...collectFiles(dir), ...collectFiles(deps.home)]) {
      expect(readFileSync(file, "utf8")).not.toContain(FAKE_KEY);
    }
    expect(lines.join("\n")).toMatch(/Twenty CRM: example contact views/);
  });

  it("T5: a seeding failure is a named WARNING that never fails, and never carries the key", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t5-fail"));
    const { docker } = fakeDocker({ state: running, viewNames: [] });
    const imp = fakeImporter({ seederThrows: true });
    const { deps } = ensureDeps({ docker, importModule: imp.importModule });
    const lines = [];
    await expect(ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps })).resolves.toBeTruthy();
    expect(lines.join("\n")).toMatch(/WARNING.*example contact views/);
    expect(lines.join("\n")).toMatch(/rejected bearer \*\*\*\*/);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });

  it("T5: a failed mint is a named WARNING without the command output", async () => {
    const { ensureDevTwentyCrm } = await twenty();
    const dir = makeTwentyCheckout(path.join(sandbox, "t5-mintfail"));
    const { docker } = fakeDocker({ state: running, viewNames: [], mintStatus: 3 });
    const imp = fakeImporter();
    const { deps } = ensureDeps({ docker, importModule: imp.importModule });
    const lines = [];
    await ensureDevTwentyCrm({ targetDir: dir, mode: "dev", log: (l) => lines.push(String(l)), deps });
    expect(imp.seen.seeds).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/WARNING.*exit 3/);
    expect(lines.join("\n")).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// T6 — wiring into runInstall and runDevRefresh.
// ---------------------------------------------------------------------------
function gitIn(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function buildFixtureOrigin(root) {
  const src = path.join(root, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(path.join(src, "packages", "migrations", "package.json"), JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }));
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }));
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  gitIn(["init", "-b", "main"], src);
  gitIn(["add", "-A"], src);
  gitIn(["commit", "-m", "init"], src);
  const originRepo = path.join(root, "origin.git");
  gitIn(["clone", "--bare", src, originRepo], root);
  return originRepo;
}

describe("T6 wiring — runInstall and runDevRefresh", () => {
  let root;
  let originRepo;
  const savedEnv = {};

  beforeAll(() => {
    root = mkdtempSync(path.join(sandbox, "t6-"));
    originRepo = buildFixtureOrigin(root);
  });

  beforeEach(() => {
    for (const k of ["CINATRA_INSTANCE_REGISTRY", "CINATRA_ALLOC_LOCK", "CINATRA_RUNTIME_MODE"]) savedEnv[k] = process.env[k];
    const d = mkdtempSync(path.join(root, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
    delete process.env.CINATRA_RUNTIME_MODE;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function recordingDeps(extra = {}) {
    const order = [];
    const twentyCalls = [];
    const deps = {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
      commandExists: () => true,
      composeAvailable: () => true,
      detectPortConflicts: async () => [],
      composePublishedPortsForTarget: () => [],
      composeConfigForFiles: () => ({ name: "cinatra", services: {}, networks: {}, volumes: {} }),
      composeSupportsNoEnvResolution: () => true,
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      bringUpInfra: () => {},
      generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }),
      runComposeDown: () => {},
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      mountAgentSourcesAfterSync: async () => ({ ok: true, skipped: true }),
      acquireProdExtensions: () => {},
      syncDevExtensions: async () => ({ skipped: true, reason: "no declared dev extensions", results: [] }),
      pnpmInstall: () => order.push("pnpm"),
      runSetupInTarget: () => {
        order.push("setup");
        return { tolerated: true, registrySkew: false, lines: [] };
      },
      ensureDevTwentyCrm: async (args) => {
        order.push("twenty");
        twentyCalls.push(args);
        return { action: "stubbed" };
      },
      ...extra,
    };
    return { deps, order, twentyCalls };
  }

  const install = (dir, extraArgs, deps) =>
    (async () => {
      const { runInstall } = await import("../src/install.mjs");
      return runInstall(["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", ...extraArgs], {
        log: () => {},
        deps,
      });
    })();

  const envLine = (dir) => {
    const body = readFileSync(path.join(dir, ".env.local"), "utf8");
    return body.split("\n").filter((l) => l.startsWith("CINATRA_TWENTY_MODE="));
  };

  it("T6: a dev install calls it once, right after the setup child, and persists CINATRA_TWENTY_MODE=shared", async () => {
    const { deps, order, twentyCalls } = recordingDeps();
    const dir = path.join(root, "dev");
    await install(dir, [], deps);
    expect(twentyCalls).toHaveLength(1);
    expect(twentyCalls[0]).toMatchObject({ targetDir: dir, mode: "dev", noTwenty: false });
    expect(order.indexOf("twenty")).toBe(order.indexOf("setup") + 1);
    expect(envLine(dir)).toEqual(["CINATRA_TWENTY_MODE=shared"]);
  });

  it("T6: --no-twenty reaches it as the skip and persists CINATRA_TWENTY_MODE=off", async () => {
    const { parseInstallArgs } = await import("../src/install.mjs");
    expect(parseInstallArgs(["--mode", "dev"]).noTwenty).toBe(false);
    expect(parseInstallArgs(["--mode", "dev", "--no-twenty"]).noTwenty).toBe(true);
    const { deps, twentyCalls } = recordingDeps();
    const dir = path.join(root, "dev-off");
    await install(dir, ["--no-twenty"], deps);
    expect(twentyCalls).toHaveLength(1);
    expect(twentyCalls[0].noTwenty).toBe(true);
    expect(envLine(dir)).toEqual(["CINATRA_TWENTY_MODE=off"]);
    // A later run without the flag records the default again — one line only.
    await install(dir, [], recordingDeps().deps);
    expect(envLine(dir)).toEqual(["CINATRA_TWENTY_MODE=shared"]);
  });

  it("T6: the preview composition calls it (as the dev install it performs) before the preview step", async () => {
    const { deps, order, twentyCalls } = recordingDeps({
      previewDeps: {
        readCheckoutEnvMode: () => {
          order.push("preview");
          throw new Error("preview-sentinel");
        },
      },
    });
    await expect(install(path.join(root, "preview"), ["--mode", "preview"], deps)).rejects.toThrow(/preview-sentinel/);
    expect(twentyCalls).toHaveLength(1);
    expect(twentyCalls[0].mode).toBe("dev");
    expect(order.indexOf("twenty")).toBeLessThan(order.indexOf("preview"));
  });

  it("T6: never for prod (while a dev install through the same seam calls it once)", async () => {
    const control = recordingDeps();
    await install(path.join(root, "prod-control"), [], control.deps);
    expect(control.twentyCalls).toHaveLength(1);
    const { deps, twentyCalls, order } = recordingDeps();
    await install(
      path.join(root, "prod"),
      ["--mode", "prod", "--infra", "external", "--db-url", "postgresql://u:p@localhost:5434/inst", "--external-db-disposable"],
      deps,
    );
    expect(order).toContain("setup");
    expect(twentyCalls).toHaveLength(0);
  });

  it("T6: never under --no-install, --no-setup or --dry-run (while a plain install calls it once)", async () => {
    const control = recordingDeps();
    await install(path.join(root, "skip-control"), [], control.deps);
    expect(control.twentyCalls).toHaveLength(1);
    for (const flag of ["--no-install", "--no-setup", "--dry-run"]) {
      const { deps, twentyCalls } = recordingDeps();
      await install(path.join(root, `skip${flag}`), [flag], deps);
      expect(twentyCalls, flag).toHaveLength(0);
    }
  });

  it("T6: runDevRefresh calls it exactly once, after its reconcile succeeded", () => {
    const source = readFileSync(path.join(CLI_ROOT, "src", "index.mjs"), "utf8");
    const start = source.indexOf("async function runDevRefresh(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    const calls = body.match(/ensureDevTwentyCrm\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const reconcile = body.indexOf('await runSetup("dev"');
    expect(reconcile).toBeGreaterThan(-1);
    expect(body.indexOf("ensureDevTwentyCrm(")).toBeGreaterThan(reconcile);
    // It honours the persisted choice.
    expect(body).toMatch(/readTwentyMode\(/);
  });
});

// ---------------------------------------------------------------------------
// T7 — the install help.
// ---------------------------------------------------------------------------
describe("T7 install help", () => {
  it("T7: `cinatra --help` lists --no-twenty", () => {
    const out = execFileSync(process.execPath, [path.join(CLI_ROOT, "bin", "cinatra.mjs"), "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(out).toMatch(/--no-twenty\s+\S/);
  });

  it("T7: the persisted choice reads `shared` when the line is missing", async () => {
    const { readTwentyMode } = await twenty();
    const dir = mkdtempSync(path.join(sandbox, "t7-mode-"));
    expect(readTwentyMode(dir)).toBe("shared");
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_RUNTIME_MODE=development\n");
    expect(readTwentyMode(dir)).toBe("shared");
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_TWENTY_MODE=off\n");
    expect(readTwentyMode(dir)).toBe("off");
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
