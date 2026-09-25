// cinatra-cli#287 — the Twenty CRM a development install brings up beside the
// product, the two example contact views it seeds there, and the read-back of
// the connection the product makes to it.
//
// WHY ONE STACK PER MACHINE. The product's Twenty connector finds its CRM by
// FIXED values: the container `cinatra-twenty-1` and the address
// http://localhost:3300 (its development hook skips while either is missing),
// and the host lets a hook's docker helpers touch only containers named
// `cinatra-<service>-<n>`. A per-instance stack would be renamed and moved by the
// isolated compose generator and never be found. So the stack is SHARED by every
// instance on the machine, under the product's own pinned container names and a
// fixed compose project, with every published port on the loopback interface.
//
// WHAT THE INSTALL OWNS, AND WHAT IT DOES NOT. The install only makes the stack
// run and answer, and seeds two example views through the product's OWN seeder.
// The connection itself is the product's road: its development auto-connect
// mints and attaches a workspace key on every development boot. The install
// never writes a connection row, a Nango record or any product table — it only
// READS two booleans back after a start (`readDevTwentyConnection`).
//
// THE KEY RULE. The workspace key the view seed mints is held only in a local
// variable of this process: never an argument of another process, a log line,
// an error message, a thrown text or a file.
//
// Every external effect goes through an injectable seam (`deps`), so the unit
// suite drives all of it with fakes — no docker, no network, no database.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { INSTANCE_LOOPBACK_ADDRESS } from "./instance-runtime.mjs";

/** The `.env.local` line that records this install's choice. */
export const TWENTY_MODE_KEY = "CINATRA_TWENTY_MODE";
export const TWENTY_MODE_SHARED = "shared";
export const TWENTY_MODE_OFF = "off";

/** The fixed compose project of the machine-shared stack. */
export const DEV_TWENTY_PROJECT = "cinatra-dev-twenty";
/** The product's four Twenty services and their pinned container names. */
export const DEV_TWENTY_SERVICES = Object.freeze({
  "twenty-db": "cinatra-twenty-db-1",
  "twenty-redis": "cinatra-twenty-redis-1",
  "twenty-server": "cinatra-twenty-1",
  "twenty-worker": "cinatra-twenty-worker-1",
});
export const DEV_TWENTY_CONTAINERS = Object.freeze(Object.values(DEV_TWENTY_SERVICES));
/** The named volumes those services mount. */
export const DEV_TWENTY_VOLUMES = Object.freeze(["cinatra-twenty-db", "cinatra-twenty-redis", "cinatra-twenty-server"]);
/** The address the connector looks for, and the product documents. */
export const DEV_TWENTY_URL = "http://localhost:3300";
/** The product's own health budget for Twenty (scripts/setup.sh). */
export const DEV_TWENTY_HEALTH_TIMEOUT_MS = 300_000;
export const DEV_TWENTY_HEALTH_POLL_MS = 5_000;
/** The bounded wait for the product's auto-connect after a start. */
export const DEV_TWENTY_CONNECT_TIMEOUT_MS = 180_000;
export const DEV_TWENTY_CONNECT_POLL_MS = 5_000;
/** One reading attempt never outlives this, so a stalled query cannot hold a start. */
export const DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS = 10_000;
/** Twenty's single seeded dev workspace (the connector's SEED_APPLE_WORKSPACE_ID). */
export const DEV_TWENTY_WORKSPACE_ID = "20202020-1c25-4d02-bf25-6aeccf7ea419";
const SEED_KEY_NAME = "cinatra-install-seed";
const REGISTRY_ROW_ID = "twenty-workspace";

/** The two example person views. 'Demo contacts' is the name the product's own
 *  fixture file gives its person view, so a later product seed matches it by
 *  name instead of adding a second one. */
export const DEV_TWENTY_VIEWS_MANIFEST = Object.freeze({
  version: 1,
  twenty: {
    views: [
      { fixtureId: "cli-twenty-view-people-contacts", name: "Demo contacts", objectType: "person", type: "table" },
      { fixtureId: "cli-twenty-view-people-prospects", name: "Demo prospects", objectType: "person", type: "table" },
    ],
  },
});

export const DEV_TWENTY_CONNECTED_LINE = "Twenty CRM: connected by the product's development auto-connect";
export const DEV_TWENTY_NOT_CONNECTED_LINE =
  "Twenty CRM: not connected yet — the product's auto-connect did not attach a key; see the app log";

// The checkout-relative modules the view seed loads in-process.
const CONNECTOR_DIR = path.join("extensions", "cinatra-ai", "twenty-connector");
const KEYGEN_MODULE = path.join(CONNECTOR_DIR, "src", "twenty-keygen.mjs");
const CLIENT_MODULE = path.join(CONNECTOR_DIR, "scripts", "twenty-bootstrap", "lib", "twenty-client.mjs");
const SEEDER_MODULE = path.join("scripts", "fixtures", "seed-twenty-content.mjs");

// ---------------------------------------------------------------------------
// The persisted choice.
// ---------------------------------------------------------------------------

function parseEnvBody(body) {
  const out = {};
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function readEnvLocal(dir) {
  const envPath = path.join(dir, ".env.local");
  try {
    return existsSync(envPath) ? parseEnvBody(readFileSync(envPath, "utf8")) : {};
  } catch {
    return {};
  }
}

/** `off` only when the line says so; a missing line reads `shared`, so a
 *  checkout installed before this change gains the CRM. */
export function twentyModeFromEnv(env = {}) {
  return String(env[TWENTY_MODE_KEY] ?? "").trim().toLowerCase() === TWENTY_MODE_OFF ? TWENTY_MODE_OFF : TWENTY_MODE_SHARED;
}

/** The choice recorded in `<dir>/.env.local`. */
export function readTwentyMode(dir) {
  return twentyModeFromEnv(readEnvLocal(dir));
}

// ---------------------------------------------------------------------------
// The rendered compose.
// ---------------------------------------------------------------------------

/** Where the shared stack's compose document lives: outside every checkout. */
export function devTwentyComposePath(home = os.homedir()) {
  return path.join(home, ".cinatra", "twenty", "docker-compose.twenty.yml");
}

function labelsObject(labels) {
  if (Array.isArray(labels)) {
    const out = {};
    for (const entry of labels) {
      const text = String(entry);
      const eq = text.indexOf("=");
      if (eq === -1) out[text] = "";
      else out[text.slice(0, eq)] = text.slice(eq + 1);
    }
    return out;
  }
  return labels && typeof labels === "object" ? { ...labels } : {};
}

function loopbackPort(port) {
  if (port && typeof port === "object") return { ...port, host_ip: INSTANCE_LOOPBACK_ADDRESS };
  // Short syntax: [HOST_IP:]PUBLISHED:TARGET[/PROTO] — replace any host address.
  const text = String(port);
  const [spec, proto] = text.split("/");
  const parts = spec.split(":");
  if (parts.length < 2) return text; // a container port alone publishes nothing fixed
  return `${INSTANCE_LOOPBACK_ADDRESS}:${parts.slice(-2).join(":")}${proto ? `/${proto}` : ""}`;
}

function withoutName(entry) {
  if (!entry || typeof entry !== "object") return {};
  const { name: _discarded, ...rest } = entry;
  return rest;
}

/**
 * Build the shared stack's compose document from the checkout's RESOLVED
 * compose (every profile included): ONLY the four Twenty services, each pinned
 * container name unchanged, every published port on the loopback interface, no
 * `profiles`, the ownership labels — and NO resolved `name` on the document, a
 * network or a volume (those carry checkout-derived names that `-p` does not
 * override), so the fixed project derives one stable set of names everywhere.
 */
export function renderDevTwentyCompose(resolved) {
  const services = {};
  const missing = Object.keys(DEV_TWENTY_SERVICES).filter((svc) => !resolved?.services?.[svc]);
  if (missing.length > 0) {
    throw new Error(
      `Twenty CRM: the checkout's compose file does not declare ${missing.join(", ")} — ` +
        "cannot render the shared Twenty stack from it.",
    );
  }
  for (const svc of Object.keys(DEV_TWENTY_SERVICES)) {
    const s = structuredClone(resolved.services[svc]);
    // The connector and the host's docker helpers find the stack by these
    // names only, so an overlay that renamed a service never moves it.
    s.container_name = DEV_TWENTY_SERVICES[svc];
    delete s.profiles;
    if (Array.isArray(s.ports)) s.ports = s.ports.map(loopbackPort);
    s.labels = { ...labelsObject(s.labels), "ai.cinatra.managed": "true", "ai.cinatra.kind": "shared-twenty" };
    services[svc] = s;
  }
  const volumes = {};
  for (const v of DEV_TWENTY_VOLUMES) volumes[v] = withoutName(resolved?.volumes?.[v]);
  return { services, networks: { default: withoutName(resolved?.networks?.default) }, volumes };
}

// ---------------------------------------------------------------------------
// Default seams.
// ---------------------------------------------------------------------------

function defaultDocker(args, { inherit = false, cwd } = {}) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    ...(cwd ? { cwd } : {}),
    stdio: inherit ? ["ignore", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function defaultResolveComposeConfig(targetDir) {
  // Lazy: install.mjs is heavy and imports this module itself.
  const { composeConfigForFiles } = await import("./install.mjs");
  return composeConfigForFiles(targetDir, null, {}, { allProfiles: true });
}

function defaultWriteFile(file, text, { mode = 0o600 } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
}

function seams(deps = {}) {
  return {
    docker: deps.docker ?? defaultDocker,
    resolveComposeConfig: deps.resolveComposeConfig ?? defaultResolveComposeConfig,
    writeFile: deps.writeFile ?? defaultWriteFile,
    home: deps.home ?? os.homedir(),
    fetch: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    importModule: deps.importModule ?? ((url) => import(url)),
    healthTimeoutMs: deps.healthTimeoutMs ?? DEV_TWENTY_HEALTH_TIMEOUT_MS,
    healthPollMs: deps.healthPollMs ?? DEV_TWENTY_HEALTH_POLL_MS,
  };
}

// ---------------------------------------------------------------------------
// The stack: reuse-first by name, then the bounded health wait.
// ---------------------------------------------------------------------------

/** True when the checkout's own compose file names all four pinned containers.
 *  A checkout that predates the Twenty stack (an older --ref), or a directory
 *  with no compose file at all, is left alone before any docker call. */
function checkoutDeclaresTwenty(targetDir) {
  try {
    const file = path.join(targetDir, "docker-compose.yml");
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8");
    return DEV_TWENTY_CONTAINERS.every((name) => text.includes(name));
  } catch {
    return false;
  }
}

/** `docker ps -a` over exactly the four names -> Map(name -> state). */
function readStackState(s) {
  const filters = DEV_TWENTY_CONTAINERS.flatMap((name) => ["--filter", `name=^${name}$`]);
  const r = s.docker(["ps", "-a", ...filters, "--format", "{{.Names}}\t{{.State}}"]);
  if (r.status !== 0) return null;
  const state = new Map();
  for (const line of String(r.stdout ?? "").split(/\r?\n/)) {
    const [name, st] = line.trim().split("\t");
    if (name && DEV_TWENTY_CONTAINERS.includes(name)) state.set(name, String(st ?? "").trim());
  }
  return state;
}

/** Compose's refusal to start a service whose dependency never became healthy. */
const UNHEALTHY_DEPENDENCY_RE = /dependency failed to start|is unhealthy/i;

async function waitForHealth(s) {
  const url = `${DEV_TWENTY_URL}/healthz`;
  const deadline = s.now() + s.healthTimeoutMs;
  for (;;) {
    try {
      const res = await s.fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res?.ok) return true;
    } catch {
      /* not up yet */
    }
    if (s.now() >= deadline) return false;
    await s.sleep(s.healthPollMs);
  }
}

/**
 * Make the machine-shared Twenty CRM run and answer, and seed the two example
 * contact views. Called by a development install after its setup child, and by
 * `instance refresh` after its reconcile.
 *
 *   - `noTwenty` (the `--no-twenty` choice) -> one skip line, no docker call.
 *   - demo -> one line: the product's demo overlay starts its own CRM.
 *   - all four containers running -> reused; all present, some stopped ->
 *     `docker start` of those by name; none -> a fresh compose document and ONE
 *     `up`; one to three present -> a named refusal (throws), as is a failed
 *     `up` or `start`.
 *   - a health timeout and any seeding failure are named WARNINGS, never failures.
 */
export async function ensureDevTwentyCrm({ targetDir, mode = "dev", noTwenty = false, log = console.log, deps = {} } = {}) {
  if (noTwenty) {
    log(`- Twenty CRM: skipped (turned off with --no-twenty; ${TWENTY_MODE_KEY}=${TWENTY_MODE_OFF}).`);
    return { action: "skipped", reason: "no-twenty" };
  }
  if (mode === "demo") {
    log("- Twenty CRM: left to the demo overlay, which starts and connects its own CRM.");
    return { action: "skipped", reason: "demo" };
  }
  if (mode !== "dev") return { action: "skipped", reason: "not-development" };
  if (!checkoutDeclaresTwenty(targetDir)) {
    log("- Twenty CRM: skipped — this checkout's compose file does not declare the Twenty stack.");
    return { action: "skipped", reason: "not-declared" };
  }

  const s = seams(deps);
  log("- Twenty CRM: ensuring the machine-shared stack (reused by name when it already exists)…");
  const state = readStackState(s);
  if (!state) {
    log("  ⚠ Twenty CRM WARNING: docker did not answer `docker ps`; the CRM was not started.");
    return { action: "skipped", reason: "docker-unavailable", healthy: false };
  }

  let action;
  let upPending = null;
  if (state.size === DEV_TWENTY_CONTAINERS.length) {
    const stopped = DEV_TWENTY_CONTAINERS.filter((name) => state.get(name) !== "running");
    if (stopped.length === 0) {
      action = "reused";
      log("  Twenty CRM: all four containers already run — reusing them.");
    } else {
      const r = s.docker(["start", ...stopped]);
      if (r.status !== 0) {
        throw new Error(`Twenty CRM: docker start ${stopped.join(" ")} failed (exit ${r.status}).`);
      }
      action = "started";
      log(`  Twenty CRM: started the stopped containers ${stopped.join(", ")}.`);
    }
  } else if (state.size > 0) {
    const present = DEV_TWENTY_CONTAINERS.filter((name) => state.has(name));
    const absent = DEV_TWENTY_CONTAINERS.filter((name) => !state.has(name));
    throw new Error(
      `Twenty CRM: refusing — found ${present.length} of the 4 shared containers (${present.join(", ")}); ` +
        `missing ${absent.join(", ")}. Remove the partial set (docker rm -f ${present.join(" ")}) or restore ` +
        "the missing containers, then re-run. Pass --no-twenty to install without the CRM.",
    );
  } else {
    const resolved = await s.resolveComposeConfig(targetDir);
    if (!resolved) {
      throw new Error("Twenty CRM: `docker compose config` could not resolve the checkout's compose file.");
    }
    // A checkout whose compose file predates the Twenty stack (an older --ref)
    // has nothing to render from: say so and leave the install alone.
    const undeclared = Object.keys(DEV_TWENTY_SERVICES).filter((svc) => !resolved?.services?.[svc]);
    if (undeclared.length > 0) {
      log(
        `  ⚠ Twenty CRM WARNING: this checkout's compose file does not declare ${undeclared.join(", ")}; ` +
          "the CRM was not started.",
      );
      return { action: "skipped", reason: "not-declared", healthy: false };
    }
    const doc = renderDevTwentyCompose(resolved);
    const file = devTwentyComposePath(s.home);
    s.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    const upArgs = ["compose", "-p", DEV_TWENTY_PROJECT, "-f", file, "up", "-d"];
    const r = s.docker(upArgs, { inherit: true, cwd: path.dirname(file) });
    if (r.status !== 0) {
      const detail = String(r.stderr ?? "").trim();
      // A server slower than its own healthcheck makes compose refuse to start
      // the worker that waits on it: that is the health condition, which the
      // bounded wait below reports as a warning, never an install failure.
      if (!UNHEALTHY_DEPENDENCY_RE.test(detail)) {
        throw new Error(`Twenty CRM: docker compose -p ${DEV_TWENTY_PROJECT} up -d failed (exit ${r.status}).${detail ? `\n${detail}` : ""}`);
      }
      upPending = upArgs;
      log("  ⚠ Twenty CRM WARNING: a Twenty service did not report healthy while starting; waiting for it.");
    }
    action = "created";
    log(`  Twenty CRM: started the shared stack (project ${DEV_TWENTY_PROJECT}, compose file ${file}).`);
  }

  const healthy = await waitForHealth(s);
  if (healthy && upPending) {
    // The server answers now: start what compose held back, once.
    const again = s.docker(upPending, { inherit: true, cwd: path.dirname(upPending[4]) });
    if (again.status !== 0) {
      log(`  ⚠ Twenty CRM WARNING: docker compose -p ${DEV_TWENTY_PROJECT} up -d exited ${again.status} after the server answered.`);
    }
  }
  if (!healthy) {
    log(
      `  ⚠ Twenty CRM WARNING: did not answer ${DEV_TWENTY_URL}/healthz within ${Math.round(s.healthTimeoutMs / 1000)} s — ` +
        "continuing. The example views are seeded on the next install or refresh once it answers.",
    );
  } else {
    await seedDevTwentyViews({ targetDir, log, s });
  }
  log(
    `  Twenty CRM: ${DEV_TWENTY_URL} (shared by every instance on this machine); ` +
      "the product connects it at the first development start.",
  );
  return { action, healthy };
}

// ---------------------------------------------------------------------------
// The two example views.
// ---------------------------------------------------------------------------

const PERSON_VIEW_NAMES_SQL =
  'SELECT v.name FROM core.view v JOIN core."objectMetadata" o ON o.id = v."objectMetadataId" ' +
  `WHERE o."nameSingular" = 'person' AND o."workspaceId" = '${DEV_TWENTY_WORKSPACE_ID}' AND v."deletedAt" IS NULL`;

/** Seed the two example person views through the product's own seeder. The
 *  workspace key it mints lives only in `key` below. Never throws. */
async function seedDevTwentyViews({ targetDir, log, s }) {
  const server = DEV_TWENTY_SERVICES["twenty-server"];
  const wanted = DEV_TWENTY_VIEWS_MANIFEST.twenty.views.map((v) => v.name);
  let key = null;
  const scrub = (text) => {
    const t = String(text ?? "");
    return key ? t.split(key).join("****") : t;
  };
  try {
    // Twenty's own idempotent workspace seed (the connector's argv).
    const seed = s.docker(["exec", server, "yarn", "command:prod", "workspace:seed:dev", "--light"]);
    if (seed.status !== 0) {
      log(`  ⚠ Twenty CRM WARNING: the workspace seed exited ${seed.status}; example contact views not seeded.`);
      return { seeded: false };
    }
    // Read-only presence reading of the two view names in Twenty's database.
    const presence = s.docker([
      "exec",
      DEV_TWENTY_SERVICES["twenty-db"],
      "psql",
      "-U",
      "postgres",
      "-d",
      "default",
      "-At",
      "-c",
      PERSON_VIEW_NAMES_SQL,
    ]);
    const present = new Set(
      presence.status === 0 ? String(presence.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [],
    );
    if (wanted.every((name) => present.has(name))) {
      log("  Twenty CRM: example contact views already present (Demo contacts, Demo prospects).");
      return { seeded: true, created: 0 };
    }

    const base = (rel) => pathToFileURL(path.join(targetDir, rel)).href;
    const { parseTwentyApiKey } = await s.importModule(base(KEYGEN_MODULE));
    const minted = s.docker([
      "exec",
      server,
      "yarn",
      "command:prod",
      "workspace:generate-api-key",
      "-w",
      DEV_TWENTY_WORKSPACE_ID,
      "-n",
      SEED_KEY_NAME,
    ]);
    // Only trust the output of a clean exit; never echo it.
    key = minted.status === 0 ? parseTwentyApiKey(minted.stdout) : null;
    if (!key) {
      log(`  ⚠ Twenty CRM WARNING: could not mint a seeding key (exit ${minted.status}); example contact views not seeded.`);
      return { seeded: false };
    }
    const { TwentyClient } = await s.importModule(base(CLIENT_MODULE));
    const { seedTwentyContent } = await s.importModule(base(SEEDER_MODULE));
    const client = new TwentyClient({ baseUrl: DEV_TWENTY_URL, apiKey: key, logger: () => {} });
    const summary = await seedTwentyContent({
      client,
      manifest: structuredClone(DEV_TWENTY_VIEWS_MANIFEST),
      catalogToolNames: [],
      log: () => {},
    });
    const created = summary?.views?.created ?? 0;
    const errors = summary?.views?.error ?? 0;
    if (errors > 0 || summary?.listOk?.views === false) {
      log(`  ⚠ Twenty CRM WARNING: example contact views seeded with ${errors} error(s); re-run the install to retry.`);
    } else {
      log(`  Twenty CRM: example contact views ready (Demo contacts, Demo prospects; ${created} created).`);
    }
    return { seeded: errors === 0, created };
  } catch (err) {
    const message = scrub(err instanceof Error ? err.message : err).slice(0, 200);
    log(`  ⚠ Twenty CRM WARNING: seeding the example contact views failed (${message}).`);
    return { seeded: false };
  } finally {
    key = null;
  }
}

// ---------------------------------------------------------------------------
// The connection reading after a start.
// ---------------------------------------------------------------------------

/** The read-only query: two booleans of the product's one Twenty row. */
export function devTwentyConnectionQuery(schema) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(schema))) {
    throw new Error("Twenty CRM: unexpected SUPABASE_SCHEMA shape.");
  }
  return (
    `SELECT (nango_connection_id IS NOT NULL) AS attached, enabled ` +
    `FROM "${schema}".external_mcp_servers WHERE id = '${REGISTRY_ROW_ID}'`
  );
}

async function defaultQuery(connectionString, text) {
  const mod = await import("pg");
  const ns = mod.default ?? mod;
  const Client = ns.Client ?? mod.Client;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS,
    query_timeout: DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS,
  });
  await client.connect();
  try {
    const res = await client.query(text);
    return res.rows ?? [];
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * After a start that answered its health probe: wait (bounded, polled) for the
 * product's development auto-connect and print exactly ONE line — connected
 * only when the row is attached AND enabled, the named hint otherwise. Reads
 * two booleans, writes nothing, never throws, and does nothing when
 * `CINATRA_TWENTY_MODE=off`.
 */
export async function readDevTwentyConnection({ repoRoot, log = console.log, deps = {} } = {}) {
  let env;
  try {
    env = (deps.readEnv ?? readEnvLocal)(repoRoot) ?? {};
  } catch {
    env = {};
  }
  if (twentyModeFromEnv(env) === TWENTY_MODE_OFF) return { skipped: true };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? DEV_TWENTY_CONNECT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEV_TWENTY_CONNECT_POLL_MS;
  const queryTimeoutMs = deps.queryTimeoutMs ?? DEV_TWENTY_CONNECT_QUERY_TIMEOUT_MS;
  try {
    const text = devTwentyConnectionQuery(String(env.SUPABASE_SCHEMA ?? "").trim() || "cinatra");
    const dbUrl = String(env.SUPABASE_DB_URL ?? "").trim();
    const query = deps.query ?? (dbUrl ? (sql) => defaultQuery(dbUrl, sql) : null);
    if (query) {
      const deadline = now() + timeoutMs;
      for (;;) {
        try {
          const attemptMs = Math.max(1, Math.min(queryTimeoutMs, deadline - now()));
          let timer;
          const rows = await Promise.race([
            query(text),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("reading timed out")), attemptMs);
            }),
          ]).finally(() => clearTimeout(timer));
          const row = Array.isArray(rows) ? rows[0] : null;
          if (row && row.attached === true && row.enabled === true) {
            log(DEV_TWENTY_CONNECTED_LINE);
            return { connected: true };
          }
        } catch {
          /* the table may not exist yet on a first boot — keep waiting */
        }
        if (now() >= deadline) break;
        await sleep(pollMs);
      }
    }
  } catch {
    /* fall through to the hint */
  }
  log(DEV_TWENTY_NOT_CONNECTED_LINE);
  return { connected: false };
}
