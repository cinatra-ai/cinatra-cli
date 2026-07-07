// ---------------------------------------------------------------------------
// `cinatra install` — from-zero dev/prod bootstrap (cinatra#255 §3.1, Class C).
//
// This is the ONLY command that runs BEFORE any cinatra checkout exists: it is
// the headline reason the dependency-light `cinatra` core is published. Invoked
// as `npx cinatra install`, it downloads cinatra, checks requirements first,
// clones ONLY the repos the host declares, creates the env, brings up infra, and
// runs setup inside the freshly-cloned target.
//
// DELIBERATELY self-contained: node builtins + `git`/`docker`/`corepack`
// subprocesses + the two pre-install-safe sync modules
// (`cinatra-dev-extensions.mjs`, `dev-apps.mjs`). It does NOT import the heavy
// `index.mjs` graph (pg, pacote, the MCP SDK, …) and — critically — does NOT
// call `getRepoRoot()`: there is no checkout to anchor on when bootstrapping
// from zero. It operates purely on the `--dir` target it is about to create,
// and hands setup off to the TARGET's own `bin/cinatra.mjs` as a subprocess
// (exactly what `pnpm setup:dev` does), so the target resolves its own repo
// root via its own cwd-walk.
//
// Flow (dev):
//   preflight (FIRST, before any download) → resolve target dir →
//   clone/update host at --ref (record the resolved SHA) → create/reconcile
//   .env.local → bring up + wait for docker infra → sync cinatra.devExtensions
//   → `corepack pnpm install` → run `setup dev` in the target (which itself
//   clones cinatra.devApps and provisions DB/Nango/MCP/OAuth).
//
// Flow (prod) mirrors scripts/setup.sh's prod branch: install → acquire-prod →
// install → setup prod. The required-extension set is acquired by `setup prod`
// itself, so install does not pre-sync devExtensions in prod mode.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { syncCinatraDevExtensions } from "./cinatra-dev-extensions.mjs";
import { isValidSlug } from "./clone-registry.mjs";
import {
  defaultInstanceRegistryPath,
  requireUsableInstanceRegistry,
  writeInstanceRegistry,
  allocateInstance,
  markInstanceReady,
  releaseInstance,
  getInstance,
  listInstances,
} from "./instance-registry.mjs";
import {
  writeMarker,
  readMarker,
  reconcileMarker,
} from "./instance-marker.mjs";
import {
  defaultAllocLockPath,
  withAllocLock,
  allocateAppPort,
  allocateBandOffset,
  validateAppPort,
  assertAppPortFree,
  reservedPorts,
  validatePortOffset,
} from "./instance-alloc.mjs";
import {
  classifyPortHolder,
  generateIsolatedCompose,
  writeIsolatedComposeFile,
  assertComposeHostUrlsRemapped,
  ISOLATED_COMPOSE_FILENAME,
} from "./install-isolation.mjs";
import {
  deriveCoUseSlug,
  coUseDbName,
  isCoUseDbNameShape,
  coUseQueueName,
  coUseCookiePrefix,
  parseAuthCookiePrefixSupport,
  assertCoUsePrereqs,
  buildCoUseEnv,
  coUseRollbackPlan,
} from "./install-couse.mjs";

// Absolute path to THIS published `cinatra` CLI's own bin entry. After the
// monorepo's `packages/cli` is removed (cinatra#402, P2), the freshly-cloned
// TARGET checkout no longer ships `packages/cli/bin/cinatra.mjs`, so the
// acquire-prod + setup-in-target subprocesses MUST be driven by the published
// CLI's own bin (the very binary running `cinatra install`), pointed at the
// target via `cwd` + `CINATRA_REPO_ROOT`. Resolved module-relatively (src/ →
// ../bin/cinatra.mjs) so it is deterministic regardless of how the CLI was
// launched (npx, global bin, symlink shim).
const PUBLISHED_CLI_BIN = fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url));

export const DEFAULT_REPO_URL = "https://github.com/cinatra-ai/cinatra.git";
export const DEFAULT_INSTALL_DIRNAME = "cinatra";
const MIN_NODE_MAJOR = 24;

// The fixed host ports the DEFAULT dev stack publishes — i.e. exactly what
// `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
// (NO `--profile`) binds. Profile-gated services (wordpress/drupal/twenty/
// plane/a2a-peers) are NOT brought up by `cinatra install`, so their ports are
// deliberately excluded. Each entry is `{ port, host, service }` where `host`
// is the publish interface ("127.0.0.1" loopback-only, or "0.0.0.0" all-
// interfaces). This static band is the PRE-CLONE early guard; the AUTHORITATIVE
// gate (detectPortConflicts) re-derives the band from the cloned checkout's
// `docker compose config` so it adapts to whatever that checkout declares.
// Kept in sync with cinatra's docker-compose{,.dev}.yml; if they drift, the
// post-clone authoritative check still catches the real ports.
export const DEFAULT_DEV_HOST_PORTS = Object.freeze([
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "nango-db", host: "127.0.0.1", port: 5435 },
  { service: "neo4j", host: "127.0.0.1", port: 7474 },
  { service: "neo4j", host: "127.0.0.1", port: 7687 },
  { service: "verdaccio", host: "0.0.0.0", port: 4873 },
  { service: "nango-server", host: "0.0.0.0", port: 3003 },
  { service: "nango-server", host: "0.0.0.0", port: 3009 },
  { service: "graphiti", host: "0.0.0.0", port: 8000 },
]);

// Git protocols install is willing to fetch over. `https`/`ssh`/`git`/`file`
// cover the documented `--repo-url` override (HTTPS-token / SSH); anything
// else (e.g. `ext::`) is rejected up front, and the same allowlist is pinned
// into the git child env via GIT_ALLOW_PROTOCOL so a malicious submodule/url
// can never widen it.
const ALLOWED_GIT_PROTOCOLS = ["https", "ssh", "git", "file"];
const GIT_ALLOW_PROTOCOL = ALLOWED_GIT_PROTOCOLS.join(":");

// ---------------------------------------------------------------------------
// Small process helpers (self-contained — index.mjs equivalents are not
// exported, and install.mjs must stay import-light).
// ---------------------------------------------------------------------------

/** Run a command inheriting stdio; throw `message` on non-zero exit. */
function runOrThrow(command, args, message, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: env ?? process.env,
    ...(cwd ? { cwd } : {}),
  });
  if (result.error) throw new Error(`${message} (${result.error.message})`);
  if (result.status !== 0) throw new Error(message);
}

/** True iff `command <probeArgs>` exits 0 (used for the preflight). */
function commandExists(command, probeArgs = ["--version"]) {
  try {
    const r = spawnSync(command, probeArgs, { stdio: "ignore", env: process.env });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Capture trimmed stdout of a command, or null on any failure. */
function capture(command, args, { cwd, env } = {}) {
  try {
    const r = spawnSync(command, args, {
      encoding: "utf8",
      env: env ?? process.env,
      ...(cwd ? { cwd } : {}),
    });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

/** The env passed to every git child: pin the protocol allowlist + disable
 *  any interactive credential/SSH prompt so a missing-access clone fails fast
 *  instead of blocking on a hidden TTY prompt. */
function gitEnv() {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL,
    GIT_TERMINAL_PROMPT: "0",
    // Only relevant for ssh remotes; harmless otherwise.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

function git(args, { cwd } = {}) {
  return spawnSync("git", args, {
    encoding: "utf8",
    env: gitEnv(),
    ...(cwd ? { cwd } : {}),
  });
}

// ---------------------------------------------------------------------------
// Flag parsing.
// ---------------------------------------------------------------------------

/** Read `--flag value`; null when absent. Throws when the value is itself a
 *  flag-shaped token (`--ref --dir x`) — a classic foot-gun that would
 *  otherwise silently consume the next flag as a value. */
function readOption(argv, flag) {
  // Support BOTH the space form (`--flag value`) and the inline form
  // (`--flag=value`). The README / `--help` / CHANGELOG advertise the `=` form
  // for the cinatra-cli#17 surface (e.g. `--infra=share`, `--on-conflict=isolated`),
  // so the install parser MUST honour it — otherwise a documented `--infra=share`
  // would silently parse as absent and bypass the co-use gate. Mirrors
  // index.mjs's readOptionValue. The `=` form wins if both appear.
  const eqPrefix = `${flag}=`;
  const eqArg = argv.find((a) => typeof a === "string" && a.startsWith(eqPrefix));
  if (eqArg !== undefined) {
    return eqArg.slice(eqPrefix.length); // may be "" for `--flag=` (caller validates)
  }
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value (got ${value === undefined ? "end of arguments" : `"${value}"`}).`);
  }
  return value;
}

const VALID_MODES = new Set(["dev", "prod"]);
// A git ref we are willing to `checkout`: a branch/tag name or a commit sha.
// Conservative — no whitespace, no leading dash (option-injection), no `..`,
// no refspec/glob metacharacters. Covers `main`, dotted release tags, and
// 7-40 hex shas.
const SAFE_REF_RE = /^(?!-)[A-Za-z0-9._\/-]+$/;

// ── Multi-instance install surface (cinatra-cli#17) ─────────────────────────
// `--infra` chooses where infra comes from: a NEW install-owned stack (default),
// EXTERNAL operator-supplied infra (the old `--no-infra` generalised into an
// execute-against-external), or SHARE (co-use — GATED: accepted by the enum but
// dispatched to a loud "not yet available" until the namespacing prerequisites
// land; never a silent no-op). `--on-conflict` chooses what to do when a host
// port is already held: fail (abort), prompt (the interactive execute-menu),
// isolated (a second full stack on a remapped band), stop-existing (tear the
// recorded holder down, then install on default ports), attach (converge on the
// existing checkout), external (re-route to operator infra), or co-use (GATED,
// like `--infra=share`).
const VALID_INFRA = new Set(["new", "external", "share"]);
const VALID_ON_CONFLICT = new Set([
  "fail",
  "prompt",
  "isolated",
  "stop-existing",
  "attach",
  "external",
  "co-use",
]);
// The single settled spelling of the GATED co-use mode (the design's `couse`
// was a typo): `--infra=share` and `--on-conflict=co-use`.
const GATED_INFRA = "share";
const GATED_ON_CONFLICT = "co-use";

function readEnumOption(argv, flag, validSet, label) {
  const v = readOption(argv, flag);
  if (v == null) return null;
  if (!validSet.has(v)) {
    throw new Error(`Invalid ${flag} "${v}". Use one of: ${[...validSet].join(", ")}.`);
  }
  return v;
}

export function parseInstallArgs(argv = []) {
  const dirOpt = readOption(argv, "--dir");
  const refOpt = readOption(argv, "--ref");
  const repoUrlOpt = readOption(argv, "--repo-url");
  const modeOpt = readOption(argv, "--mode");

  const ref = refOpt ?? "main";
  if (!SAFE_REF_RE.test(ref) || ref.includes("..")) {
    throw new Error(
      `Invalid --ref "${ref}". Use a branch, tag, or commit sha ` +
        `(letters/digits/dot/dash/underscore/slash; no leading dash, no "..").`,
    );
  }

  let mode = "dev";
  if (modeOpt != null) {
    if (!VALID_MODES.has(modeOpt)) {
      throw new Error(`Invalid --mode "${modeOpt}". Use "dev" or "prod".`);
    }
    mode = modeOpt;
  }

  const repoUrl = repoUrlOpt ?? DEFAULT_REPO_URL;
  assertSafeRepoUrl(repoUrl);

  // Instance enum surface. The parser ACCEPTS the full enum (so an unknown value
  // still errors cleanly); the GATED values (`share` / `co-use`) are valid here
  // and routed to a loud-fail at dispatch (T5b), not rejected as invalid.
  let infra = readEnumOption(argv, "--infra", VALID_INFRA, "--infra");
  const onConflict = readEnumOption(argv, "--on-conflict", VALID_ON_CONFLICT, "--on-conflict");

  // `--no-infra` is an ALIAS for `--infra=external` (don't silently drop it).
  const noInfraFlag = argv.includes("--no-infra");
  if (noInfraFlag) {
    if (infra && infra !== "external") {
      throw new Error(`--no-infra conflicts with --infra=${infra}. Use one (—no-infra means --infra=external).`);
    }
    infra = "external";
  }
  // The legacy boolean other code reads: external infra means "do not bring up".
  const noInfra = infra === "external";

  // --instance slug (reuse the clone slug shape).
  const instanceOpt = readOption(argv, "--instance");
  if (instanceOpt != null && !isValidSlug(instanceOpt)) {
    throw new Error(`Invalid --instance "${instanceOpt}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }

  // --port-offset auto|<n> and --app-port <n>.
  const portOffsetOpt = readOption(argv, "--port-offset");
  let portOffset = null;
  if (portOffsetOpt != null) {
    portOffset = portOffsetOpt === "auto" ? "auto" : validatePortOffset(portOffsetOpt);
  }
  const appPortOpt = readOption(argv, "--app-port");
  const appPort = appPortOpt != null ? validateAppPort(appPortOpt) : null;

  // External-infra URLs (validated for shape at dispatch when used).
  const dbUrl = readOption(argv, "--db-url");
  const redisUrl = readOption(argv, "--redis-url");
  const nangoUrl = readOption(argv, "--nango-url");
  const graphitiUrl = readOption(argv, "--graphiti-url");

  // GATED co-use sidecar flags — accepted, but their presence forces the T5b
  // loud-fail (they advertise a surface that does nothing until co-use lands).
  const reuseFrom = readOption(argv, "--reuse-from");
  const dbName = readOption(argv, "--db-name");
  const redisDb = readOption(argv, "--redis-db");
  const bullmqQueue = readOption(argv, "--bullmq-queue");

  return {
    dir: dirOpt, // null → resolved later (prompt on TTY, else default).
    ref,
    repoUrl,
    mode,
    yes: argv.includes("--yes"),
    force: argv.includes("--force"),
    resetEnv: argv.includes("--reset-env"),
    skipDevApps: argv.includes("--skip-dev-apps"),
    noSetup: argv.includes("--no-setup"),
    noInfra,
    // --no-install ⇒ clone + env only; pnpm install + setup both skipped
    // (setup needs the installed deps, so skipping install implies skipping setup).
    noInstall: argv.includes("--no-install"),

    // cinatra-cli#17 surface.
    infra, // null | "new" | "external" | "share"(gated)
    onConflict, // null | one of VALID_ON_CONFLICT (co-use gated)
    instance: instanceOpt,
    portOffset, // null | "auto" | <number>
    appPort, // null | <number>
    dryRun: argv.includes("--dry-run"),
    // cinatra-cli#40: eyes-open acknowledgement that a co-use instance may SHARE
    // the donor's Graphiti/Neo4j (org-scoped, not instance-scoped) — required to
    // proceed when the donor sets GRAPHITI_URL (else co-use refuses to share it).
    allowSharedGraphiti: argv.includes("--allow-shared-graphiti"),
    resume: argv.includes("--resume"),
    status: argv.includes("--status"),
    listInstances: argv.includes("--list-instances"),
    teardownExisting: argv.includes("--teardown-existing"),
    // Explicit acknowledgement that an --infra=external --db-url target is
    // DISPOSABLE (setup + migrations may mutate it irreversibly; it is never
    // install-owned / auto-rolled-back). REQUIRED to arm an external DB
    // non-interactively — a bare --yes must NOT silently authorise pointing
    // setup at an arbitrary external database (non-rollbackable data path).
    externalDbDisposable: argv.includes("--external-db-disposable"),
    external: { dbUrl, redisUrl, nangoUrl, graphitiUrl },
    // The presence of ANY gated co-use signal (the gated enum values or the
    // co-use sidecar flags) routes to the T5b loud-fail.
    couseRequested:
      infra === GATED_INFRA ||
      onConflict === GATED_ON_CONFLICT ||
      reuseFrom != null ||
      dbName != null ||
      redisDb != null ||
      bullmqQueue != null,
    couseSidecar: { reuseFrom, dbName, redisDb, bullmqQueue },
  };
}

/** Reject a `--repo-url` whose protocol is not in the allowlist (and reject a
 *  flag-shaped value). SCP-style `git@host:org/repo` is accepted (it is ssh). */
export function assertSafeRepoUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.startsWith("-")) {
    throw new Error(`Invalid --repo-url "${url}".`);
  }
  // scp-like shorthand: user@host:path  (no "://") → ssh.
  if (!url.includes("://") && /^[^/]+@[^/]+:/.test(url)) return;
  let proto;
  try {
    proto = new URL(url).protocol.replace(/:$/, "");
  } catch {
    throw new Error(`Invalid --repo-url "${url}" (not a parseable URL).`);
  }
  if (!ALLOWED_GIT_PROTOCOLS.includes(proto)) {
    throw new Error(
      `Refusing --repo-url with protocol "${proto}". Allowed: ${ALLOWED_GIT_PROTOCOLS.join(", ")}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Preflight — runs FIRST, before any download. Collects EVERY failure so the
// operator sees the full remediation list at once, not one-at-a-time.
// ---------------------------------------------------------------------------

/** A non-null target dir's parent must be writable (the dir itself may not
 *  exist yet). Returns a remediation string on failure, else null.
 *  Under `--dry-run` (`probe:false`) we must NOT touch the filesystem, so we
 *  infer writability with a non-mutating `accessSync(W_OK)` instead of the
 *  temp-file write/remove probe (cinatra-cli#37, finding #2). */
function checkTargetWritable(targetDir, { probe = true } = {}) {
  const parent = path.dirname(path.resolve(targetDir));
  try {
    if (!existsSync(parent)) {
      return `Parent directory ${parent} does not exist — create it first (mkdir -p ${parent}).`;
    }
    if (!probe) {
      // Read-only check: no temp file is written or removed.
      accessSync(parent, fsConstants.W_OK);
      return null;
    }
    const probePath = path.join(parent, `.cinatra-install-write-probe-${process.pid}`);
    writeFileSync(probePath, "");
    spawnSync("rm", ["-f", probePath]); // best-effort cleanup of the probe file.
    return null;
  } catch (err) {
    return `Cannot write into ${parent}: ${err.message}. Choose a --dir under a writable location.`;
  }
}

export function runPreflight({ mode = "dev", targetDir = null, noInfra = false, dryRun = false, deps = {} } = {}) {
  const exists = deps.commandExists ?? commandExists;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const failures = [];
  const warnings = [];

  // Node major.
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    failures.push(
      `Node.js ${nodeVersion} detected — Cinatra requires Node.js ${MIN_NODE_MAJOR}.x or newer ` +
        `(the Better Auth bootstrap relies on native TS type-stripping). Install Node ${MIN_NODE_MAJOR}+ and retry.`,
    );
  }

  if (!exists("git")) {
    failures.push("git is not installed. Install git (https://git-scm.com/downloads) and retry.");
  }

  // A package manager via Corepack. We invoke pnpm through `corepack pnpm`, so
  // corepack is what we truly need; a bare `pnpm` on PATH is an accepted
  // fallback.
  const hasCorepack = exists("corepack", ["--version"]);
  const hasPnpm = exists("pnpm", ["--version"]);
  if (!hasCorepack && !hasPnpm) {
    failures.push(
      "Neither Corepack nor pnpm is available. Corepack ships with Node 24 — run `corepack enable`, " +
        "or install pnpm (`npm install -g pnpm`), then retry.",
    );
  }

  // Docker + Compose are required for dev infra (postgres/redis/nango) and for
  // the prod stack. `--no-infra` lets an operator point at external infra, so
  // a missing Docker becomes a WARNING (not a hard failure) in that mode.
  const hasDocker = exists("docker", ["--version"]);
  const hasCompose = hasDocker && (deps.composeAvailable ?? composeAvailable)();
  const dockerBucket = noInfra ? warnings : failures;
  if (!hasDocker) {
    dockerBucket.push(
      "Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) and retry" +
        (noInfra ? " — or ensure your external Postgres/Redis/Nango are reachable (--no-infra)." : "."),
    );
  } else if (!hasCompose) {
    dockerBucket.push(
      "Docker Compose v2 is not available (`docker compose version` failed). Update Docker Desktop and retry" +
        (noInfra ? " (or rely on external infra with --no-infra)." : "."),
    );
  }

  if (!exists("curl")) {
    // curl is used for the Nango readiness probe; warn (the wait can fall back),
    // never block.
    warnings.push("curl is not installed — the Nango readiness wait may be less reliable.");
  }

  if (targetDir) {
    // Under --dry-run the writability check must not write a temp probe file
    // (a filesystem side effect). Use the non-mutating access check instead
    // (cinatra-cli#37, finding #2).
    const writableErr = (deps.checkTargetWritable ?? checkTargetWritable)(targetDir, { probe: !dryRun });
    if (writableErr) failures.push(writableErr);
  }

  // Note: the host-PORT preflight (cinatra-cli#3) is NOT done here — it requires
  // an async socket-bind probe and is driven from runInstall (preflightPortBand
  // pre-clone + the authoritative post-clone gate). runPreflight stays a pure,
  // synchronous tool/Node/writability check so it composes cheaply and is
  // deterministically testable without touching the network.
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    mode,
    // Surfaced so runInstall knows whether to bother probing ports at all.
    infraWillStart: !noInfra && hasDocker && hasCompose,
  };
}

function composeAvailable() {
  try {
    const r = spawnSync("docker", ["compose", "version"], { stdio: "ignore", env: process.env });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Host-port conflict detection (cinatra-cli#3).
//
// `cinatra install` brings its dev infra up on a FIXED band of host ports. When
// another stack (or anything else) already holds one, the old flow cloned +
// wrote .env.local and only THEN failed at `docker compose up -d` with a message
// that misattributed the cause to the Docker daemon. We now probe the band in
// preflight (PRE-CLONE static guard) and again post-clone (AUTHORITATIVE, from
// the checkout's own `docker compose config`), failing fast with an accurate,
// actionable message that names each occupied port and (best-effort) its holder.
// ---------------------------------------------------------------------------

/** Probe one published host port by attempting to BIND a TCP listener on it.
 *  Resolves true iff the port is FREE (bind succeeded). A loopback-only publish
 *  (`127.0.0.1:p`) is probed on 127.0.0.1; an all-interfaces publish is probed
 *  on 0.0.0.0. We bind (not connect) so we detect a held port even when nothing
 *  is currently accepting on it, and we never touch a stranger's service. An
 *  inconclusive probe (timeout / unexpected error) resolves FREE so a flaky
 *  probe never blocks an otherwise-valid install. */
/** Canonicalize a publish interface into the key both the probe and the
 *  owned-port exemption compare on, so the exemption granularity matches the
 *  interface-aware probe exactly: an all-interfaces / unspecified publish
 *  (`0.0.0.0`, `::`, empty) folds to `0.0.0.0`; any explicit interface
 *  (`127.0.0.1`, a LAN ip, …) is kept verbatim. Used to build `host:port` keys. */
function normalizeHostKey(host) {
  return host === "0.0.0.0" || host === "::" || !host ? "0.0.0.0" : String(host);
}

/** The `host:port` key a band entry / owned binding is compared on. */
function hostPortKey(host, port) {
  return `${normalizeHostKey(host)}:${port}`;
}

function probeHostPortFree(host, port, { timeoutMs = 1500 } = {}) {
  const bindHost = normalizeHostKey(host);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (free) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolve(free);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const server = net.createServer();
    server.on("error", (err) => {
      // EADDRINUSE / EACCES ⇒ the port is taken ⇒ occupied.
      finish(!(err && (err.code === "EADDRINUSE" || err.code === "EACCES")));
    });
    server.listen({ host: bindHost, port, exclusive: true }, () => finish(true));
  });
}

/** Find which RUNNING docker-compose project (if any) publishes the host
 *  `host:port`, proven by that container's own compose labels — NOT inferred
 *  from the Docker proxy process. `inspectRows` is the parsed `docker inspect`
 *  array for the running containers; we match a container whose
 *  `NetworkSettings.Ports` binds the host TCP `port` on a COMPATIBLE interface,
 *  then read its compose identity from the labels. Returns `{ project,
 *  workingDir }` (either may be null) or null when no compose container
 *  publishes that binding. `host` is optional: when given, the binding must
 *  match it on the same interface-aware key used by the probe (an
 *  all-interfaces `0.0.0.0` binding also covers a narrower-interface lookup, so
 *  `127.0.0.1:p` is attributed to a project binding `0.0.0.0:p`). When `host`
 *  is omitted, any interface publishing `port` matches (the lsof-style lookup).
 *  Pure (no I/O) — the unit of test.
 *
 *  This is the honest answer to issue #9: on Docker Desktop every published port
 *  bottoms out at the shared `com.docker.backend` proxy in `lsof`, so lsof alone
 *  cannot say WHICH stack owns it. The compose labels can. */
export function identifyComposeHolder(port, inspectRows, host) {
  if (!Array.isArray(inspectRows)) return null;
  const want = String(port);
  // The interface-aware key the band entry is probed on (when host is given).
  const wantKey = host !== undefined && host !== null ? hostPortKey(host, port) : null;
  for (const row of inspectRows) {
    const portMap = row?.NetworkSettings?.Ports ?? {};
    let publishesPort = false;
    for (const [spec, bindings] of Object.entries(portMap)) {
      if (!/\/tcp$/i.test(spec)) continue;
      for (const b of Array.isArray(bindings) ? bindings : []) {
        if (String(b?.HostPort ?? "") !== want) continue;
        // Interface match: with no host filter, the port alone matches. With a
        // host filter, the binding matches iff its (canonicalized) interface IS
        // the requested one, OR it binds all-interfaces (which also holds any
        // narrower interface for the same port) — exactly the probe's semantics.
        if (
          wantKey === null ||
          hostPortKey(b?.HostIp, port) === wantKey ||
          hostPortKey("0.0.0.0", port) === hostPortKey(b?.HostIp, port)
        ) {
          publishesPort = true;
          break;
        }
      }
      if (publishesPort) break;
    }
    if (!publishesPort) continue;
    const labels = row?.Config?.Labels ?? {};
    const project = labels["com.docker.compose.project"] || null;
    const workingDir = labels["com.docker.compose.project.working_dir"] || null;
    // Only claim a compose holder when we have a label proving it — otherwise
    // this is a plain `docker run` container we can't attribute to a project.
    if (!project && !workingDir) continue;
    return { project, workingDir };
  }
  return null;
}

/** Run `docker inspect` over every RUNNING container and return the parsed
 *  array, or null when docker isn't usable / the JSON is unparseable. Injectable
 *  via `deps.capture` for tests. */
function runningContainersInspect(deps = {}) {
  const cap = deps.capture ?? capture;
  const ids = cap("docker", ["ps", "-q"]);
  const idList = (ids ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (idList.length === 0) return null;
  const raw = cap("docker", ["inspect", ...idList]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Best-effort, HONEST description of what holds `port`. Returns a structured
 *  holder `{ label, compose }`:
 *   - `compose` is `{ project, workingDir, isCinatra }` when a running compose
 *     project provably publishes the port (`isCinatra` proven by the working_dir
 *     being a real cinatra checkout — NOT assumed), else null.
 *   - `label` is a short human string for the conflict line: the compose project
 *     name when known, otherwise the lsof process (e.g. "verdaccio (pid 4242)"),
 *     otherwise null (the caller then says "could not determine which").
 *  Critically, this NEVER claims "Cinatra" without filesystem proof, fixing the
 *  issue-#9 misattribution where every port resolved to `com.docker.backend`. */
function describePortHolder(port, host, deps = {}) {
  const cap = deps.capture ?? capture;
  // 1. Try to attribute the port to a specific running compose project (honest).
  const inspectRows = deps.inspectRunning ? deps.inspectRunning() : runningContainersInspect(deps);
  const composeRaw = identifyComposeHolder(port, inspectRows, host);
  let compose = null;
  if (composeRaw) {
    const workingDir = composeRaw.workingDir;
    const isCinatra = typeof workingDir === "string" && workingDir.length > 0 && isCinatraCheckout(workingDir);
    compose = { project: composeRaw.project ?? null, workingDir: workingDir ?? null, isCinatra };
  }

  // 2. Fall back to the listening process name (lsof). On Docker Desktop this is
  //    the shared proxy, so it is ONLY used as a label, never to assert a stack.
  let lsofLabel = null;
  const out = cap("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcn"]);
  if (out) {
    // lsof -F output: lines prefixed by field char (c=command, n=name, p=pid).
    let command = null;
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("c")) command = line.slice(1);
      else if (line.startsWith("p")) pid = line.slice(1);
    }
    if (command) lsofLabel = pid ? `${command} (pid ${pid})` : command;
  }

  let label = null;
  if (compose) {
    label = compose.project
      ? `docker compose project "${compose.project}"`
      : "a docker compose project";
    if (compose.workingDir) label += ` (${compose.workingDir})`;
  } else {
    label = lsofLabel;
  }
  if (!label && !compose) return null;
  return { label, compose };
}

/** Parse the published host ports out of a `docker compose config --format json`
 *  document. Returns `[{ service, host, port }]`. Profile-gated services that
 *  the default (no-`--profile`) install does not start are already absent from
 *  the resolved config, so this naturally yields only the band install binds.
 *  Pure function (no I/O) — the unit of test. */
export function parseComposePublishedPorts(configJson) {
  const out = [];
  const services = configJson?.services;
  if (!services || typeof services !== "object") return out;
  for (const [service, svc] of Object.entries(services)) {
    const ports = Array.isArray(svc?.ports) ? svc.ports : [];
    for (const p of ports) {
      // The `config --format json` long form: { published, target, host_ip, protocol, mode }.
      if (p && (p.protocol ?? "tcp") !== "tcp") continue;
      const published = p?.published;
      if (published === undefined || published === null || published === "") continue;
      const host = p?.host_ip && String(p.host_ip).length ? String(p.host_ip) : "0.0.0.0";
      // `published` may be a number or a string. Expand a compose port RANGE
      // ("9000-9002") into each member; a single port is the degenerate range.
      // Anything non-numeric is skipped (we never misparse "9000-9002" as 9000).
      const raw = String(published).trim();
      const range = raw.match(/^(\d+)(?:-(\d+))?$/);
      if (!range) continue;
      const lo = Number.parseInt(range[1], 10);
      const hi = range[2] !== undefined ? Number.parseInt(range[2], 10) : lo;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || hi - lo > 1024) continue;
      for (let port = lo; port <= hi; port += 1) {
        out.push({ service, host, port });
      }
    }
  }
  return out;
}

/** Run `docker compose config --format json` in the cloned target and return the
 *  parsed published-port band, or null when compose can't model it (then the
 *  caller falls back to the static band). Injectable for tests. */
function composePublishedPortsForTarget(targetDir, deps = {}) {
  const cap = deps.capture ?? capture;
  const raw = cap(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "config", "--format", "json"],
    { cwd: targetDir },
  );
  if (!raw) return null;
  try {
    return parseComposePublishedPorts(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Extract the host bindings a docker-inspect record exposes, but ONLY when the
 *  container's compose `working_dir` label matches `expectDir` — i.e. the
 *  container genuinely belongs to THIS checkout, not merely a project that
 *  happens to share our directory basename (compose's default project name is
 *  the dir basename, so two checkouts named the same would otherwise collide).
 *  Returns a `Set<string>` of `host:port` KEYS (interface-aware, not bare port
 *  numbers): the binding's `HostIp` is preserved and canonicalized the same way
 *  the probe canonicalizes its publish interface, so the owned-port exemption
 *  granularity matches the interface-aware probe exactly — exempting the
 *  target's own `127.0.0.1:5434` can NEVER mask a stranger's `0.0.0.0:5434`.
 *  Pure (no I/O) — the unit of test. `inspectRows` is the parsed `docker inspect`
 *  array (one entry per container). */
export function ownedPortsFromInspect(inspectRows, expectDir) {
  const owned = new Set();
  if (!Array.isArray(inspectRows) || !expectDir) return owned;
  const want = String(expectDir);
  for (const row of inspectRows) {
    const labels = row?.Config?.Labels ?? {};
    const workingDir = labels["com.docker.compose.project.working_dir"];
    // Ownership proof: this container's compose project is rooted at OUR dir.
    if (typeof workingDir !== "string" || workingDir !== want) continue;
    const portMap = row?.NetworkSettings?.Ports ?? {};
    for (const [spec, bindings] of Object.entries(portMap)) {
      // `spec` is e.g. "5432/tcp"; only TCP is probed for conflicts.
      if (!/\/tcp$/i.test(spec)) continue;
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const hp = Number.parseInt(String(b?.HostPort ?? ""), 10);
        if (!Number.isFinite(hp) || hp <= 0) continue;
        // A `0.0.0.0` (or absent) HostIp publishes on all interfaces, so it owns
        // BOTH the all-interfaces key AND any loopback probe the band may declare
        // for the same port (binding 0.0.0.0:p also holds 127.0.0.1:p). Record
        // the all-interfaces key in that case; an explicit interface records only
        // its own key.
        const hostIp = b?.HostIp;
        owned.add(hostPortKey(hostIp, hp));
      }
    }
  }
  return owned;
}

/** The host ports THIS target's OWN running compose containers publish, proven
 *  by the compose `working_dir` label (not a basename-collision project). Lists
 *  the project's container ids (cwd-scoped `compose ps -q`), inspects them, and
 *  keeps only ports whose container is rooted at `targetDir`. Empty set on any
 *  error (fail-safe: a missed exemption only re-surfaces the real bind error,
 *  it never wrongly suppresses a stranger's conflict). */
function targetComposeOwnedPorts(targetDir, deps = {}) {
  const cap = deps.capture ?? capture;
  const ids = cap(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "ps", "-q"],
    { cwd: targetDir },
  );
  const idList = (ids ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (idList.length === 0) return new Set();
  const raw = cap("docker", ["inspect", ...idList]);
  if (!raw) return new Set();
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return new Set();
  }
  return ownedPortsFromInspect(rows, path.resolve(targetDir));
}

/** Detect host-port conflicts for the dev band. `band` is `[{service,host,port}]`
 *  (the parsed authoritative band, or the static default). Probes each port and
 *  resolves `[{ service, host, port, holder }]` for those already occupied.
 *  `deps.ownedPorts` is EXEMPTED — a `Set` of either `host:port` KEYS (the
 *  interface-aware form from `ownedPortsFromInspect`) or bare port NUMBERS
 *  (legacy/back-compat) proven to be held by THIS target's own running compose
 *  services (idempotent re-run), so a busy probe on one of them is us, not a
 *  clash. A `host:port` key matches the band entry's exact interface; an owned
 *  ALL-INTERFACES binding (`0.0.0.0:p`) additionally covers a same-port entry on
 *  any narrower interface (binding `0.0.0.0:p` also holds `127.0.0.1:p`). A bare
 *  numeric entry exempts that port on every interface (legacy semantics). Other
 *  injectables: `deps.probe(host, port)` (sync bool or Promise) and
 *  `deps.describeHolder(port, host)` (a legacy injection that takes only `port`
 *  still works — the extra `host` arg is ignored by it). */
export async function detectPortConflicts(band, deps = {}) {
  const probe = deps.probe ?? ((host, port) => probeHostPortFree(host, port));
  const describe = deps.describeHolder ?? ((port, host) => describePortHolder(port, host, deps));
  const owned = deps.ownedPorts instanceof Set ? deps.ownedPorts : new Set();
  const isOwned = (host, port) =>
    // Exact interface key (host:port) …
    owned.has(hostPortKey(host, port)) ||
    // … an owned all-interfaces binding covers any interface for the same port …
    owned.has(hostPortKey("0.0.0.0", port)) ||
    // … or a bare numeric entry (back-compat: exempt the port on every interface).
    owned.has(port);
  // De-dupe identical host:port entries (a port can be declared once).
  const seen = new Set();
  const conflicts = [];
  for (const entry of band) {
    const key = hostPortKey(entry.host, entry.port);
    if (seen.has(key)) continue;
    seen.add(key);
    // Exempt a port our OWN running stack already publishes — not a stranger.
    if (isOwned(entry.host, entry.port)) continue;
    const free = await probe(entry.host, entry.port);
    if (!free) {
      // `describe` may return a plain string (legacy/test injection) or the
      // structured `{ label, compose }` from describePortHolder. Normalize to
      // `holder` (the short human label, back-compat). Only attach a `compose`
      // descriptor when one was provably derived — the historical conflict shape
      // ({ service, host, port, holder }) is preserved byte-for-byte otherwise,
      // so existing exact-equality consumers/tests are unaffected.
      const d = describe(entry.port, entry.host) ?? null;
      const holder = typeof d === "string" ? d : (d?.label ?? null);
      const compose = d && typeof d === "object" ? (d.compose ?? null) : null;
      const conflict = { ...entry, holder };
      if (compose) conflict.compose = compose;
      conflicts.push(conflict);
    }
  }
  return conflicts;
}

/** Render a port-conflict list into an HONEST, actionable abort message that
 *  ALSO surfaces the cinatra-cli#17 EXECUTABLE options. Honesty (issue #9):
 *  each line names its holder only as precisely as we can prove it, and we name
 *  "a Cinatra stack" only when a running compose project's working_dir is
 *  provably a cinatra checkout (the `compose` descriptor `detectPortConflicts`
 *  attaches). cinatra-cli#17 (T10): we then offer the EXECUTABLE option menu
 *  (--on-conflict=isolated / stop-existing / attach, --infra=external) instead of
 *  the old `cinatra instance clone new` pointer (which is the dev-worktree path, out of
 *  scope for a from-zero second instance). `owner` is the classifier verdict; a
 *  `mixed` holder is called out so the reader knows a stop/teardown will refuse. */
export function formatPortConflictError(conflicts, { phase, owner } = {}) {
  const lines = conflicts.map((c) => {
    const where = c.host === "0.0.0.0" ? `port ${c.port}` : `${c.host}:${c.port}`;
    const by = c.holder
      ? ` (held by ${c.holder})`
      : " (held by another process — could not determine which)";
    return `  ✗ ${where} — already in use${by}${c.service ? ` [needed for ${c.service}]` : ""}`;
  });

  // Identify a SINGLE owning Cinatra stack only when EVERY conflicting port is
  // provably held by the SAME cinatra checkout (working_dir) — otherwise naming
  // one stack as "the" holder would be dishonest (stopping it may not free the
  // rest). This `compose`-descriptor signal complements the classifier `owner`.
  const stackKey = (m) => (m.workingDir ? `dir:${m.workingDir}` : `proj:${m.project ?? ""}`);
  const allSameCinatraStack =
    conflicts.length > 0 &&
    conflicts.every((c) => c.compose && c.compose.isCinatra) &&
    new Set(conflicts.map((c) => stackKey(c.compose))).size === 1;
  const named = allSameCinatraStack
    ? (conflicts.map((c) => c.compose).find((m) => m.workingDir) ?? conflicts[0].compose)
    : null;

  const header =
    `Host port conflict${conflicts.length > 1 ? "s" : ""} detected${phase ? ` (${phase})` : ""} — ` +
    `\`cinatra install\` cannot bring up its stack on the default ports:\n${lines.join("\n")}\n`;

  // The cinatra-cli#17 executable option menu (shared by both branches). NO
  // `cinatra instance clone new` pointer — that is the dev-worktree path.
  const optionMenu =
    `  • --on-conflict=isolated      Run a second FULL stack on a remapped port band + its own app port (nothing deleted).\n` +
    `  • --on-conflict=stop-existing Stop the existing stack first, then install on the default ports.\n` +
    `  • --on-conflict=attach        Converge on the existing checkout instead of a second stack.\n` +
    `  • --infra=external            Point this install at external Postgres/Redis/Nango (no local infra).`;

  if (named) {
    const dir = named.workingDir;
    const label = named.project ? `the Cinatra stack "${named.project}"` : "an existing Cinatra stack";
    const where = dir ? `${label} at ${dir}` : label;
    return (
      header +
      `\nThese ports are held by ${where}. To install a SECOND Cinatra instance alongside it, choose one:\n` +
      optionMenu +
      `\nOr stop that stack yourself (\`docker compose down\`${dir ? ` from ${dir}` : ""}) / free the ports and retry.`
    );
  }

  // Generic guidance: the conflicting ports are NOT all provably one Cinatra
  // stack (some unattributed, or held by different/non-Cinatra holders). On
  // Docker Desktop an unattributed port shows only as the shared
  // `com.docker.backend` proxy, which is why we don't guess.
  let who;
  if (owner === "other-cinatra") {
    who = "Another Cinatra instance is already holding these ports.";
  } else if (owner === "mixed") {
    who =
      "These ports are held by a MIX of a Cinatra instance and an unrelated process — " +
      "a stop/teardown will REFUSE this ambiguous holder.";
  } else {
    who =
      "These ports are not all held by a single Cinatra stack (each line above names its holder as " +
      "precisely as could be determined), so there is no one stack to replace.";
  }
  return (
    header +
    `\n${who} Choose one:\n` +
    `  • Free the ports: stop whatever is listening on each (\`docker ps\` / \`lsof -i :<port>\`), then re-run install.\n` +
    optionMenu +
    `\n  • Cancel: stop here and change nothing.`
  );
}

/** Emit a PROMINENT warning when the AUTHORITATIVE port band could not be
 *  derived from the checkout's own `docker compose config` (cinatra-cli#3,
 *  finding #1). The post-clone gate then degrades to probing the STATIC default
 *  band as a best-effort backstop — which is fine for the DEFAULT repo+ref (the
 *  static band describes it and the pre-clone guard already probed it) but may be
 *  INAPPLICABLE for a custom `--repo-url`/`--ref` whose fork can publish a
 *  different band. We surface that loudly instead of silently fail-OPEN (the
 *  classic "secure check can't run → permit anyway" anti-pattern); `docker
 *  compose up` remains the final bind-conflict authority. Returns the lines it
 *  logged (for tests). Pure but for the injected `log`. */
export function emitDegradedBandWarning({ usesDefaultBand, ref, repoUrl, log = console.log } = {}) {
  const lines = [
    "⚠ ────────────────────────────────────────────────────────────────",
    "⚠ DEGRADED PORT CHECK — could not derive the authoritative port band",
    "⚠ from this checkout's `docker compose config` (compose could not model",
    "⚠ it, or the JSON was unparseable). The authoritative host-port conflict",
    "⚠ check did NOT run; falling back to probing the STATIC default band.",
  ];
  if (!usesDefaultBand) {
    // The dangerous case: the static band describes the MAINLINE checkout only,
    // and for a custom repo-url/ref it may not match the real published ports —
    // so a genuine conflict could slip past this degraded probe.
    const which = repoUrl && repoUrl !== DEFAULT_REPO_URL ? `repo-url "${repoUrl}"` : `ref "${ref}"`;
    lines.push(
      `⚠ NON-DEFAULT ${which}: the static fallback band may NOT match this`,
      "⚠ checkout's real ports, so a port conflict could slip past THIS check.",
    );
  }
  lines.push(
    "⚠ `docker compose up` is still the final bind-conflict check — a real",
    "⚠ collision will surface there (with the conflicting port named).",
    "⚠ ────────────────────────────────────────────────────────────────",
  );
  for (const l of lines) log(l);
  return lines;
}

// ---------------------------------------------------------------------------
// Target-dir resolution + checkout state.
// ---------------------------------------------------------------------------

// A real cinatra checkout — the pnpm workspace file AND the never-removed
// internal `@cinatra-ai/migrations` package manifest (by exact name). Mirrors
// `isCinatraRepoRoot` in index.mjs: it does NOT gate on `packages/cli` (that
// package goes external at P1/P2, cinatra#402, and this sentinel must survive
// its removal) nor on the bin-colliding root package name `cinatra`. Any
// read/parse error fails closed.
function isCinatraCheckout(dir) {
  try {
    if (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) return false;
    const migrationsPkg = path.join(dir, "packages", "migrations", "package.json");
    if (!existsSync(migrationsPkg)) return false;
    return JSON.parse(readFileSync(migrationsPkg, "utf8"))?.name === "@cinatra-ai/migrations";
  } catch {
    return false;
  }
}

function isEmptyDir(dir) {
  try {
    return readdirSync(dir).filter((n) => n !== ".DS_Store").length === 0;
  } catch {
    return true; // absent counts as empty (we'll create it).
  }
}

function workingTreeIsDirty(dir) {
  const out = capture("git", ["-C", dir, "status", "--porcelain"], { env: gitEnv() });
  return out == null ? false : out.length > 0;
}

/** Normalize a git remote for equality comparison: lowercase, drop a trailing
 *  `.git`/slash, and fold the scp-shorthand `git@host:org/repo` into the same
 *  `host/org/repo` shape an `ssh://`/`https://` URL produces. Best-effort —
 *  returns the trimmed lowercased string when it cannot parse a URL. */
export function normalizeRemote(url) {
  if (typeof url !== "string") return "";
  let s = url.trim();
  // scp shorthand → ssh URL shape for comparison.
  const scp = s.match(/^[^/]+@([^:]+):(.+)$/);
  if (scp && !s.includes("://")) s = `ssh://${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(s);
    s = `${u.host}${u.pathname}`;
  } catch {
    /* leave as-is */
  }
  return s.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Env creation/reconciliation — mirrors scripts/setup.sh's env block, but in
// node (no openssl dependency: randomBytes is cross-platform).
// ---------------------------------------------------------------------------

const RUNTIME_MODE = { dev: "development", prod: "production" };

// The setup subprocess overlays `process.env` over the target's `.env.local`
// (collectEnvironment in index.mjs), so an EXPORTED runtime-mode var would win
// over the `--mode` we just wrote. These are the keys it reads; install refuses
// an ambient value that contradicts `--mode` BEFORE doing any heavy work.
const RUNTIME_MODE_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"];

function normalizeRuntimeModeValue(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.startsWith("prod")) return "production";
  if (v.startsWith("dev")) return "development";
  return null;
}

/** Throw if an exported runtime-mode var contradicts `--mode` (it would silently
 *  win when setup overlays process.env over .env.local). */
export function assertAmbientModeMatches(mode, env = process.env) {
  const wantMode = RUNTIME_MODE[mode];
  for (const key of RUNTIME_MODE_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      const ambient = normalizeRuntimeModeValue(raw);
      if (ambient && ambient !== wantMode) {
        throw new Error(
          `Exported ${key}=${raw.trim()} conflicts with --mode ${mode} (${wantMode}). ` +
            `setup overlays the shell environment over .env.local, so this would mis-mode the install. ` +
            `Unset ${key} (or align it with --mode) and retry.`,
        );
      }
    }
  }
}

function readEnvMode(envPath) {
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^CINATRA_RUNTIME_MODE=(.*)$/);
      if (m) return m[1].replace(/['"]/g, "").trim();
    }
  } catch {
    /* absent */
  }
  return null;
}

/** Create `.env.local` from `.env.example` (fresh secret + runtime mode), or —
 *  if it already exists — refuse a mode mismatch (like setup.sh) and otherwise
 *  leave it untouched unless `--reset-env`. */
export function ensureEnvLocal({ targetDir, mode, resetEnv = false, log = console.log }) {
  const envPath = path.join(targetDir, ".env.local");
  const examplePath = path.join(targetDir, ".env.example");
  const wantMode = RUNTIME_MODE[mode];

  if (existsSync(envPath) && !resetEnv) {
    const current = readEnvMode(envPath);
    const normalized = current
      ? current.startsWith("prod")
        ? "production"
        : current.startsWith("dev")
          ? "development"
          : current
      : null;
    if (normalized && normalized !== wantMode) {
      throw new Error(
        `.env.local has CINATRA_RUNTIME_MODE=${normalized} but --mode ${mode} was requested. ` +
          `Update or remove ${envPath}, or pass --reset-env to regenerate it.`,
      );
    }
    log(`  .env.local already exists (${normalized ?? "mode unset"}) — preserving it (pass --reset-env to regenerate).`);
    return { created: false, envPath };
  }

  if (!existsSync(examplePath)) {
    throw new Error(`Cannot create .env.local — ${examplePath} is missing from the cloned checkout.`);
  }
  copyFileSync(examplePath, envPath);
  const secret = randomBytes(32).toString("hex");
  // Mint the other required secrets too, otherwise a fresh install is broken
  // until they are set by hand:
  //  - NANGO_ENCRYPTION_KEY (base64 32-byte key) — Nango's connect-session flow
  //    throws (masked 500) when it is empty, so no OAuth connector can connect.
  //  - CINATRA_BRIDGE_TOKEN (shared secret) — the wayflow → /api/llm-bridge
  //    callback returns 403 (content-edit "(no response)") when it is empty.
  const nangoEncryptionKey = randomBytes(32).toString("base64");
  const bridgeToken = randomBytes(32).toString("hex");
  let body = readFileSync(envPath, "utf8");
  body = upsertEnvKey(body, "BETTER_AUTH_SECRET", secret);
  body = upsertEnvKey(body, "NANGO_ENCRYPTION_KEY", nangoEncryptionKey);
  body = upsertEnvKey(body, "CINATRA_BRIDGE_TOKEN", bridgeToken);
  body = upsertEnvKey(body, "CINATRA_RUNTIME_MODE", wantMode);
  writeFileSync(envPath, body, { mode: 0o600 });
  // `.env.local` holds minted secrets (and, for an isolated instance, the infra
  // secret surface the generated compose resolves) — keep it owner-only. `mode`
  // applies on creation; copyFileSync above may have inherited a wider example
  // mode, so chmod explicitly (best-effort on platforms without chmod semantics).
  tightenEnvLocalPerms(envPath);
  log(`  .env.local created from .env.example with fresh BETTER_AUTH_SECRET, NANGO_ENCRYPTION_KEY, CINATRA_BRIDGE_TOKEN, and CINATRA_RUNTIME_MODE=${wantMode}.`);
  return { created: true, envPath };
}

/** Best-effort tighten `.env.local` to 0600 (owner-only). It carries minted
 *  secrets + (for isolated installs) the infra-secret surface the generated
 *  compose resolves, so it must never be world/group-readable. No-op if the file
 *  is absent or chmod is unsupported. */
function tightenEnvLocalPerms(envPath) {
  try {
    if (existsSync(envPath)) chmodSync(envPath, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

/** Replace the value of `KEY=` in-place if the key line exists, else append. */
function upsertEnvKey(body, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) return body.replace(re, `${key}=${value}`);
  const sep = body.endsWith("\n") || body.length === 0 ? "" : "\n";
  return `${body}${sep}${key}=${value}\n`;
}

// ---------------------------------------------------------------------------
// Infra (docker compose up + wait), pre-install-safe.
// ---------------------------------------------------------------------------

function bringUpInfra({ targetDir, log = console.log, composeFiles = null, composeProject = null, envFile = null, nangoHealthUrl = null }) {
  log("- Starting infrastructure (Postgres + Redis + Nango)…");
  composeUpOrThrow(targetDir, { composeFiles, composeProject, envFile });
  const composeBase = composeArgsFor({ composeFiles, composeProject, envFile });
  waitForCompose(targetDir, "postgres", ["pg_isready", "-U", "postgres"], "Postgres", log, 60, composeBase);
  waitForCompose(targetDir, "redis", ["redis-cli", "ping"], "Redis", log, 60, composeBase);
  waitForNango(log, 60, nangoHealthUrl);
}

/** The leading `compose` argv that selects the recorded files + project (+ an
 *  optional env-file). When `composeFiles`/`composeProject` are null, falls back
 *  to the base default pair with no `-p` (byte-identical to the legacy default
 *  invocation). The recorded set is the authority (cinatra-cli#17 §C.8) so
 *  up/exec/down all target the same files+project. An `envFile` is threaded so
 *  the ISOLATED generated compose can resolve its scrubbed `${VAR}` placeholders
 *  from .env.local at up-time (review hardening #1) — the default path omits it, keeping
 *  compose's normal `.env` discovery (byte-identical to before). */
function composeArgsFor({ composeFiles = null, composeProject = null, envFile = null } = {}) {
  const files = composeFiles && composeFiles.length
    ? composeFiles
    : ["docker-compose.yml", "docker-compose.dev.yml"];
  const fileArgs = files.flatMap((f) => ["-f", f]);
  const projectArgs = composeProject ? ["-p", composeProject] : [];
  const envArgs = envFile ? ["--env-file", envFile] : [];
  // `--env-file`/`-p`/`-f` are all top-level compose flags (before the subcommand).
  return ["compose", ...envArgs, ...projectArgs, ...fileArgs];
}

/** Run `docker compose up -d` and, on failure, surface the REAL stderr instead
 *  of a hardcoded "is the Docker daemon running?" (cinatra-cli#3). A port
 *  collision now reads e.g. "Bind for 0.0.0.0:4873 failed: port is already
 *  allocated" rather than misattributing it to the daemon. stderr is streamed
 *  to the user (pipe) AND captured so it can be folded into the thrown error. */
function composeUpOrThrow(targetDir, { composeFiles = null, composeProject = null, envFile = null } = {}) {
  const args = [...composeArgsFor({ composeFiles, composeProject, envFile }), "up", "-d"];
  const result = spawnSync("docker", args, {
    cwd: targetDir,
    env: process.env,
    encoding: "utf8",
    // stdout inherited (compose progress), stderr captured so we can echo +
    // include it in the error; compose writes its errors to stderr.
    stdio: ["inherit", "inherit", "pipe"],
  });
  const stderr = (result.stderr ?? "").trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (result.error) {
    throw new Error(`docker compose up failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = stderr ? `\n${stderr}` : "";
    const hint = /already allocated|address already in use|port is already/i.test(stderr)
      ? "\n  A published host port is already in use — stop the conflicting stack, " +
        "or re-run `cinatra install` with --on-conflict=isolated to bring up a second instance on its own port band."
      : "\n  Ensure the Docker daemon is running and reachable, then retry.";
    throw new Error(`docker compose up -d failed (exit ${result.status}).${detail}${hint}`);
  }
}

function waitForCompose(targetDir, service, readyCmd, label, log, maxAttempts = 60, composeBase = ["compose"]) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = spawnSync("docker", [...composeBase, "exec", "-T", service, ...readyCmd], {
      stdio: "ignore",
      cwd: targetDir,
    });
    if (r.status === 0) {
      log(`  ${label} is ready.`);
      return;
    }
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`${label} did not become ready within ${maxAttempts} seconds.`);
}

function waitForNango(log, maxAttempts = 60, healthUrl = null) {
  const url = healthUrl ?? "http://127.0.0.1:3003/health";
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = spawnSync("curl", ["-sf", url], {
      stdio: "ignore",
      timeout: 3000,
    });
    if (r.status === 0) {
      log("  Nango is ready.");
      return;
    }
    spawnSync("sleep", ["2"]);
  }
  // Non-fatal: Nango can lag; setup re-probes. Warn, don't abort.
  log("  ⚠ Nango did not report healthy in time — continuing; `cinatra instance setup` will re-check.");
}

// ---------------------------------------------------------------------------
// pnpm + setup subprocess.
// ---------------------------------------------------------------------------

function pnpmInstall({ targetDir, usePnpmDirect, log = console.log }) {
  log("- Installing dependencies (pnpm install)…");
  if (usePnpmDirect) {
    runOrThrow("pnpm", ["install"], "pnpm install failed.", { cwd: targetDir });
  } else {
    runOrThrow("corepack", ["pnpm", "install"], "corepack pnpm install failed.", { cwd: targetDir });
  }
}

/** Acquire the prod required-extension set via the PUBLISHED CLI's own bin,
 *  pointed at the target checkout (mirrors scripts/setup.sh prod: extensions
 *  acquire-prod → pnpm install → setup prod). The published bin is used (not a
 *  target-local `packages/cli/bin`) because that path is removed at P2. */
function acquireProdExtensions({ targetDir, log = console.log }) {
  log("- Acquiring required extensions (pinned + integrity-verified)…");
  runOrThrow(
    process.execPath,
    [PUBLISHED_CLI_BIN, "extensions", "acquire-prod"],
    "extensions acquire-prod failed.",
    {
      cwd: targetDir,
      // Pin the repo root so the child anchors on the freshly-cloned target,
      // not an ambient checkout the published bin happens to sit near.
      env: { ...process.env, CINATRA_REPO_ROOT: targetDir },
    },
  );
}

function runSetupInTarget({ targetDir, mode, skipDevApps, log = console.log }) {
  // The command-routing contract (renamed cinatra-cli#61): invoke the CANONICAL namespaced form
  // (`cinatra instance setup <mode>`) — the only form that resolves (the bare
  // `setup <mode>` was removed in cinatra-cli#81).
  const setupArgs = [PUBLISHED_CLI_BIN, "instance", "setup", mode];
  if (mode === "dev" && skipDevApps) setupArgs.push("--skip-dev-apps");
  log(`- Running \`cinatra instance setup ${mode}\` inside ${targetDir}…`);
  runOrThrow(process.execPath, setupArgs, `cinatra instance setup ${mode} failed inside the target.`, {
    cwd: targetDir,
    // Defensive belt-and-braces: the cwd-walk already resolves the root, but
    // pin CINATRA_REPO_ROOT so a stray ambient value can't redirect the child,
    // and pin the runtime mode to the one we just wrote into .env.local so an
    // (unset-but-later-exported) ambient value can never mis-mode the child.
    env: {
      ...process.env,
      CINATRA_REPO_ROOT: targetDir,
      CINATRA_RUNTIME_MODE: RUNTIME_MODE[mode],
    },
  });
}

// ---------------------------------------------------------------------------
// Interactive helpers.
// ---------------------------------------------------------------------------

async function promptLine(question, fallback) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer.length ? answer : fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question, { yes }) {
  if (yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await promptLine(`${question} [y/N]: `, "");
  return /^y(es)?$/i.test(answer);
}

/** A destructive confirm that requires typing an EXACT phrase (never satisfied
 *  by `--yes`). For data-destroying actions (volume teardown, an external prod
 *  DB) where a stray `y` must not arm it. Non-interactive → always refuses. */
async function typedConfirm(question, phrase) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const answer = await promptLine(`${question}\n  Type "${phrase}" to confirm: `, "");
  return answer === phrase;
}

// ---------------------------------------------------------------------------
// Multi-instance install: detection authority + execute-menu + the option
// executors (Isolated / stop-existing / attach / external) — cinatra-cli#17.
// ---------------------------------------------------------------------------

/** Run `docker compose config --format json` for an explicit file set and return
 *  the parsed document (or null when compose can't model it). Used by the
 *  ISOLATED path to resolve the band it then remaps. Injectable for tests.
 *
 *  cinatra-cli#57: when the checkout has a `.env.local`, pass it via `--env-file`
 *  so `config` interpolates every `${VAR}` from the SAME env-file the isolated
 *  `up` later reads (compose's default discovery reads `.env`, NOT `.env.local`).
 *  Without it, a `${OPERATOR_SECRET:-}` resolves to its empty default here, and
 *  the generator (which only re-symbolises env-file-supplied keys with a non-empty
 *  resolved value) would leave it blank — so the operator secret would never reach
 *  the isolated container. Reading from `.env.local` makes the resolved config
 *  carry the real operator values, which the generator then re-symbolises back to
 *  `${KEY}` (resolved again from `.env.local` at up-time): end-to-end consistent. */
function composeConfigForFiles(targetDir, composeFiles, deps = {}) {
  const cap = deps.capture ?? capture;
  const fileArgs = (composeFiles && composeFiles.length
    ? composeFiles
    : ["docker-compose.yml", "docker-compose.dev.yml"]
  ).flatMap((f) => ["-f", f]);
  const envLocal = path.join(targetDir, ".env.local");
  const envArgs = existsSync(envLocal) ? ["--env-file", ".env.local"] : [];
  const raw = cap("docker", ["compose", ...envArgs, ...fileArgs, "config", "--format", "json"], { cwd: targetDir });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Inspect the live containers of the compose project rooted at `targetDir`
 *  (default base pair, cwd-scoped). Returns the parsed `docker inspect` array
 *  for the classifier (working_dir-label ownership). Empty array on any error. */
function liveComposeInspect(targetDir, deps = {}) {
  const cap = deps.capture ?? capture;
  const ids = cap(
    "docker",
    ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "ps", "-q"],
    { cwd: targetDir },
  );
  const idList = (ids ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (idList.length === 0) {
    // Fall back to a broad inspect of all running containers so we can still
    // attribute a conflict to ANOTHER checkout's project (not just our cwd).
    const allIds = cap("docker", ["ps", "-q"]);
    const allList = (allIds ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (allList.length === 0) return [];
    const rawAll = cap("docker", ["inspect", ...allList]);
    if (!rawAll) return [];
    try {
      return JSON.parse(rawAll);
    } catch {
      return [];
    }
  }
  const raw = cap("docker", ["inspect", ...idList]);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Ensure the per-checkout marker dir `.cinatra/` is locally git-ignored so the
 *  marker file (and the generated isolated compose) never make the working tree
 *  DIRTY — which would otherwise break the idempotent-update re-run and surprise
 *  the operator with an untracked file. Uses `.git/info/exclude` (a LOCAL,
 *  non-committed ignore) so it needs NO change to the cinatra repo. Best-effort:
 *  a non-git dir or a write failure is silently tolerated. */
function ensureMarkerIgnored(targetDir) {
  try {
    const gitDir = capture("git", ["-C", targetDir, "rev-parse", "--git-dir"], { env: gitEnv() });
    if (!gitDir) return;
    const excludePath = path.isAbsolute(gitDir)
      ? path.join(gitDir, "info", "exclude")
      : path.join(targetDir, gitDir, "info", "exclude");
    mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const want = [".cinatra/", ISOLATED_COMPOSE_FILENAME];
    let body = existing;
    for (const entry of want) {
      const re = new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m");
      if (!re.test(body)) {
        body = body.endsWith("\n") || body.length === 0 ? `${body}${entry}\n` : `${body}\n${entry}\n`;
      }
    }
    if (body !== existing) writeFileSync(excludePath, body);
  } catch {
    /* best-effort: never fail the install over a local-ignore write */
  }
}

/** Read both registries (read-only) for classification / status. */
function readBothRegistries(deps = {}) {
  const instReader = deps.readInstanceRegistry ?? (() => requireUsableInstanceRegistry(defaultInstanceRegistryPath()));
  let cloneRegistry = null;
  try {
    cloneRegistry = deps.readCloneRegistry ? deps.readCloneRegistry() : null;
  } catch {
    cloneRegistry = null;
  }
  let instanceRegistry = null;
  try {
    instanceRegistry = instReader();
  } catch {
    instanceRegistry = null;
  }
  return { instanceRegistry, cloneRegistry };
}

/** Validate an external-infra URL (shape only). Allows postgres(ql)/redis(s)/
 *  http(s). A flag-shaped or unparseable value throws. */
function assertExternalUrl(flag, value, allowedProtocols) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
    throw new Error(`${flag} requires a URL value.`);
  }
  let proto;
  try {
    proto = new URL(value).protocol.replace(/:$/, "");
  } catch {
    throw new Error(`Invalid ${flag} "${value}" (not a parseable URL).`);
  }
  if (!allowedProtocols.includes(proto)) {
    throw new Error(`Invalid ${flag} protocol "${proto}". Allowed: ${allowedProtocols.join(", ")}.`);
  }
  return value;
}

// ── co-use (shared-infra) executor (cinatra-cli#40, #17 option B) ────────────
//
// Co-use runs a SECOND app instance against a DONOR instance's already-running
// infra (one Postgres server, one Redis, one Nango/Graphiti) — with NO second
// Docker stack. Its only install-owned resource is a SEPARATE `cinatra_inst_*`
// Postgres database. The headline safety gate is the per-instance Better-Auth
// cookie prefix (localhost cookies are port-blind): co-use is enabled ONLY when
// the donor app build advertises `advanced.cookiePrefix` support; otherwise it
// fails CLOSED (assertCoUsePrereqs throws the precise upstream pointer). See
// install-couse.mjs for the pure derivations + the capability gate.

/** The default location of the donor checkout: an explicit `--reuse-from`, else
 *  the conventional sibling default install dir next to the co-use target. */
function resolveDonorDir(opts, targetDir) {
  if (opts.couseSidecar?.reuseFrom) return path.resolve(opts.couseSidecar.reuseFrom);
  // Convention: the donor is the default install (a `cinatra` dir next to the
  // co-use checkout's parent). Best-effort — the executor validates it exists.
  return path.resolve(path.dirname(path.resolve(targetDir)), DEFAULT_INSTALL_DIRNAME);
}

/** Read a donor checkout's `.env.local` into a { KEY: value } map (best-effort —
 *  returns {} when absent/unreadable). The executor uses it as the source env for
 *  buildCoUseEnv (inherit shared-infra endpoints + crypto secrets). */
function readDonorEnv(donorDir) {
  try {
    const p = path.join(donorDir, ".env.local");
    if (!existsSync(p)) return {};
    return parseEnvBody(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** The capability probe (cinatra-cli#40 §3.4): does the donor app build isolate
 *  auth cookies per instance? Reads the donor's checked-out `src/lib/auth.ts` and
 *  parses it. Fails CLOSED — an absent/unreadable source ⇒ unsupported ⇒ co-use
 *  refuses. Pure logic lives in install-couse.parseAuthCookiePrefixSupport. */
function probeDonorCookiePrefixSupport(donorDir) {
  try {
    const p = path.join(donorDir, "src", "lib", "auth.ts");
    if (!existsSync(p)) return false;
    return parseAuthCookiePrefixSupport(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
}

/** Lazy-import the pg Client (install.mjs stays import-light — pg is native +
 *  costly; only the co-use DB path needs it). */
async function loadPgClient(connectionString) {
  const mod = await import("pg");
  const ns = mod.default ?? mod;
  const Client = ns.Client ?? mod.Client;
  if (!Client) throw new Error("cinatra: failed to load the pg Client constructor for co-use.");
  return new Client({ connectionString });
}

/** Force the database path of a postgresql:// URL to `name` (the executor targets
 *  a specific DB without depending on index.mjs's non-exported connStringForDatabase). */
function connStringForDatabase(connectionString, name) {
  const u = new URL(connectionString);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Quote a Postgres identifier for a CREATE/DROP DATABASE statement (double the
 *  inner double-quotes). The db NAME is also shape-validated (isCoUseDbNameShape)
 *  before it ever reaches here, so this is defence-in-depth. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Default real DB operations for co-use (injectable via deps for tests). All run
 *  against the DONOR's Postgres SERVER (admin/maintenance DB) so CREATE/DROP never
 *  run while connected to the DB being mutated. */
function defaultCoUseDbOps() {
  return {
    // Idempotent create: SELECT 1 then CREATE … TEMPLATE cinatra_seed. Returns
    // { created: boolean } so rollback only drops a DB THIS run created.
    async createCoUseDb({ adminUrl, dbName }) {
      if (!isCoUseDbNameShape(dbName)) {
        throw new Error(`Refusing to create a non-co-use-shaped database ${JSON.stringify(dbName)}.`);
      }
      const client = await loadPgClient(connStringForDatabase(adminUrl, "postgres"));
      await client.connect();
      try {
        const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
        if (exists.rowCount > 0) return { created: false };
        await client.query(`CREATE DATABASE ${quoteIdent(dbName)} TEMPLATE ${quoteIdent("cinatra_seed")}`);
        return { created: true };
      } finally {
        await client.end().catch(() => {});
      }
    },
    // INSTALL-OWNED drop for rollback ONLY: drops a `cinatra_inst_<slug>` DB that
    // (a) is shaped exactly like the computed name, (b) was created THIS run, and
    // (c) carries no foreign owner (we only ever drop a DB our own run just made).
    // This is the controlled bypass of isProtectedDbName's `cinatra_inst_*`
    // protection (cinatra-cli#40 §3.2, codex Q3) — never a generic override.
    async dropDbCreatedByThisRun({ adminUrl, dbName, createdThisRun }) {
      if (createdThisRun !== true) {
        throw new Error("dropDbCreatedByThisRun refuses to drop a DB not created by this run.");
      }
      if (!isCoUseDbNameShape(dbName)) {
        throw new Error(`dropDbCreatedByThisRun refuses a non-co-use-shaped name ${JSON.stringify(dbName)}.`);
      }
      const client = await loadPgClient(connStringForDatabase(adminUrl, "postgres"));
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}

/**
 * Execute a co-use (shared-infra) install. Replaces the old loud refusal: it now
 * PROBES the donor app's cookie-prefix capability and only proceeds when it is
 * present (fail-closed otherwise — against today's app, that means it still
 * refuses, with a precise pointer to the one app change needed). All I/O is
 * injectable via `deps` so the full provisioning path is unit-tested without a
 * live Postgres.
 *
 * @returns {Promise<{ infraPlan:"co-use", instance:object }>}
 */
async function executeCoUse({ targetDir, opts, resolvedSha, log = console.log, deps = {} }) {
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const probePorts = deps.detectPortConflicts ?? detectPortConflicts;
  const readClone = deps.readCloneRegistry ?? (() => null);
  const dbOps = deps.coUseDbOps ?? defaultCoUseDbOps();
  const probeCapability = deps.probeCookiePrefixSupport ?? probeDonorCookiePrefixSupport;
  const readDonor = deps.readDonorEnv ?? readDonorEnv;

  // Slug + names (pure).
  const slug = deriveCoUseSlug(targetDir, opts);
  if (!isValidSlug(slug)) {
    throw new Error(
      `Could not derive a valid co-use instance slug from ${targetDir}. Pass --instance <slug> ` +
        `(/^[a-z0-9][a-z0-9-]{0,29}$/).`,
    );
  }
  const dbName = coUseDbName(slug);

  // 1. Resolve the donor + its env (the shared infra source).
  const donorDir = resolveDonorDir(opts, targetDir);
  const donorEnv = readDonor(donorDir);
  const adminUrl = donorEnv.SUPABASE_DB_URL ?? null;

  // 2. Capability probe → assertCoUsePrereqs. THE upstream gate (fail closed):
  //    co-use must never silently cross-clobber sessions on a shared host.
  const cookiePrefixSupported = !!probeCapability(donorDir);
  const graphitiShared = typeof donorEnv.GRAPHITI_URL === "string" && donorEnv.GRAPHITI_URL.length > 0;
  assertCoUsePrereqs({
    cookiePrefixSupported,
    graphitiShared,
    allowSharedGraphiti: opts.allowSharedGraphiti === true,
  });

  // Beyond the capability gate, we need a usable donor DB URL to create the
  // separate co-use database against the SAME server.
  if (!adminUrl) {
    throw new Error(
      `Co-use needs the donor's SUPABASE_DB_URL to create a separate database on its Postgres server, ` +
        `but ${path.join(donorDir, ".env.local")} has none. Pass --reuse-from <donor-checkout> or ensure the ` +
        `donor is installed first.`,
    );
  }

  log(`- Co-use: provisioning instance "${slug}" against the donor at ${donorDir} (separate DB ${dbName}).`);

  if (opts.dryRun) {
    log(`  [dry-run] would create database ${dbName} (TEMPLATE cinatra_seed) on the donor Postgres,`);
    log(`  [dry-run] write a co-use .env.local (cookie-prefix ${coUseCookiePrefix(slug)}, queue ${coUseQueueName(slug)}),`);
    log("  [dry-run] and run setup with --no-infra (no second Docker stack). No changes made.");
    return { infraPlan: "co-use", instance: { slug, dbName, dryRun: true }, dryRun: true };
  }

  // 3. Allocate app port + reserve the registry slot under the alloc lock (the
  //    co-use row records the donor's compose project — it owns no stack — and is
  //    EXEMPT from composeProject-uniqueness; see instance-registry).
  let createdDb = false;
  const donorProject = donorEnv.__couseDonorProject ?? `cinatra_couse_${slug.replace(/-/g, "_")}`;
  const persisted = await withAllocLock(lockPath, async () => {
    const cloneRegistry = (() => {
      try {
        return readClone();
      } catch {
        return null;
      }
    })();
    const instanceRegistry = requireUsableInstanceRegistry(registryPath);

    // Idempotent re-run: an existing READY co-use row for this dir → converge.
    const existing = getInstance(instanceRegistry, slug);
    if (existing && path.resolve(existing.installDir) === path.resolve(targetDir) && existing.state === "ready") {
      log(`  Co-use instance "${slug}" already recorded ready — converging (idempotent).`);
      return { slot: existing, idempotent: true, appPort: existing.appPort };
    }

    // App port: explicit --app-port (reject reserved/live conflict) or auto.
    const probeAppPort = async (port, host = "0.0.0.0") =>
      (await probePorts([{ service: "app", host, port }])).length === 0;
    let appPort;
    if (opts.appPort != null) {
      const reserved = reservedPorts({ cloneRegistry, instanceRegistry });
      await assertAppPortFree({
        appPort: opts.appPort,
        reserved,
        host: "0.0.0.0",
        probe: (host, port) => probeAppPort(port, host),
      });
      appPort = opts.appPort;
    } else {
      const busy = new Set();
      let attempts = 0;
      while (true) {
        appPort = allocateAppPort({ cloneRegistry, instanceRegistry, exclude: busy });
        if (await probeAppPort(appPort)) break;
        busy.add(appPort);
        if (++attempts >= 16) {
          throw new Error(
            `Could not find a live-free co-use app port after ${attempts} attempts (last tried ${appPort}). ` +
              `Free a port or pass --app-port <n>.`,
          );
        }
      }
    }

    const { registry: next, slot } = allocateInstance(instanceRegistry, slug, {
      mode: opts.mode,
      installDir: targetDir,
      // A co-use row records the donor's project (no stack of its own) + the
      // donor's compose files so --status/--down read a coherent row; the
      // uniqueness exemption lets it share the donor's project name.
      composeProject: donorProject,
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      ports: {},
      appPort,
      repoUrl: opts.repoUrl,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "co-use",
      createdResources: [`db:${dbName}`],
      state: "provisioning",
    });
    writeInstanceRegistry(registryPath, next);
    writeMarker(targetDir, {
      slug,
      id: slot.id,
      mode: opts.mode,
      composeProject: donorProject,
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      appPort,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "co-use",
      state: "provisioning",
    });
    return { slot, appPort };
  });

  if (persisted.idempotent) {
    return { infraPlan: "co-use", instance: persisted.slot, idempotent: true };
  }
  const appPort = persisted.appPort;

  // 4-7. Clone companion extensions + install deps, then create the separate DB,
  //      write env, run setup --no-infra. ALL wrapped in a transaction-style
  //      try/catch that rolls back (drops the created DB if any + releases the
  //      slot) on any failure (cinatra-cli#40 §3.2). The extension-sync + install
  //      run BEFORE setup (which needs the installed deps); a failure there
  //      rolls back the (DB-less) provisioning slot rather than orphaning it.
  try {
    if (opts.mode === "dev" && deps.skipCoUseInstall !== true) {
      log("- Cloning declared companion extension repos (cinatra.devExtensions)…");
      const extResult = await syncCinatraDevExtensions({
        repoRoot: targetDir,
        targetRoot: targetDir,
        argv: [],
        env: process.env,
        log,
      });
      if (extResult?.skipped) log(`  Dev extensions: skipped (${extResult.reason}).`);
    }
    if (!opts.noInstall && deps.skipCoUseInstall !== true) {
      const usePnpm = !commandExists("corepack", ["--version"]) && commandExists("pnpm", ["--version"]);
      pnpmInstall({ targetDir, usePnpmDirect: usePnpm, log });
    }

    const { created } = await dbOps.createCoUseDb({ adminUrl, dbName });
    createdDb = created;
    log(`  ${created ? "Created" : "Reusing existing"} co-use database ${dbName}.`);

    // Build + write the co-use .env.local (0600). Separate DB URL on the donor
    // server; inherit shared-infra endpoints + crypto secrets from the donor.
    const dbUrl = connStringForDatabase(adminUrl, dbName);
    const envMap = buildCoUseEnv({ sourceEnv: donorEnv, slug, appPort, dbUrl });
    writeCoUseEnv({ targetDir, envMap, log });

    // Run setup with NO infra bring-up (the donor's stack is the backing infra).
    if (!opts.noSetup && deps.runSetup !== false) {
      const runSetup = deps.runSetup ?? ((d) => runSetupInTarget({ ...d }));
      runSetup({ targetDir, mode: opts.mode, skipDevApps: opts.skipDevApps, log });
    }

    // Mark ready under the lock.
    await withAllocLock(lockPath, async () => {
      const reg = requireUsableInstanceRegistry(registryPath);
      if (getInstance(reg, slug)) {
        writeInstanceRegistry(registryPath, markInstanceReady(reg, slug, { sha: resolvedSha }));
      }
    });
    writeMarker(targetDir, {
      slug,
      id: persisted.slot.id,
      mode: opts.mode,
      composeProject: donorProject,
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      appPort,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "co-use",
      state: "ready",
    });
    log(`  ✓ Co-use instance "${slug}" ready: app http://localhost:${appPort}, DB ${dbName}, cookie-prefix ${coUseCookiePrefix(slug)}.`);
    return { infraPlan: "co-use", instance: { ...persisted.slot, state: "ready", appPort, dbName } };
  } catch (err) {
    log(`  ✗ Co-use provisioning failed — rolling back instance "${slug}".`);
    const plan = coUseRollbackPlan({ createdDb, dbName, runtimeDir: null });
    for (const stepObj of plan) {
      try {
        if (stepObj.step === "dropDatabase") {
          await dbOps.dropDbCreatedByThisRun({ adminUrl, dbName: stepObj.dbName, createdThisRun: true });
          log(`    rolled back: dropped ${stepObj.dbName}.`);
        } else if (stepObj.step === "releaseInstanceSlot") {
          await withAllocLock(lockPath, async () => {
            const reg = requireUsableInstanceRegistry(registryPath);
            const row = getInstance(reg, slug);
            if (row && path.resolve(row.installDir) === path.resolve(targetDir) && row.state !== "ready") {
              const { registry: rel } = releaseInstance(reg, slug);
              writeInstanceRegistry(registryPath, rel);
            }
          });
        }
      } catch (e) {
        log(`    ⚠ rollback step "${stepObj.step}" best-effort error: ${e.message}`);
      }
    }
    throw err;
  }
}

/** Write a co-use `.env.local` (mode 0600): start from the donor's env body (so
 *  inherited keys carry through verbatim) then upsert the co-use overrides. */
function writeCoUseEnv({ targetDir, envMap, log = console.log }) {
  const envPath = path.join(targetDir, ".env.local");
  // Seed from the donor's body if present, else start empty.
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [k, v] of Object.entries(envMap)) {
    body = upsertEnvKey(body, k, v);
  }
  writeFileSync(envPath, body, { mode: 0o600 });
  try {
    // Tighten perms even if the file pre-existed with a looser mode.
    spawnSync("chmod", ["600", envPath]);
  } catch {
    /* best-effort */
  }
  log(`  Wrote co-use .env.local (separate DB + cookie-prefix + queue) at ${envPath}.`);
}

// ── T6 — read-only --status / --list-instances ──────────────────────────────
/** Print the instance registry + (for a resolved checkout) the per-checkout
 *  marker, reconciled. Registry/live are shown as TRUTH; the marker is labelled
 *  a HINT. Read-only — no side effects. */
function printInstanceStatus({ targetDir, listAll, log = console.log, deps = {} }) {
  const { instanceRegistry } = readBothRegistries(deps);
  const instances = instanceRegistry ? listInstances(instanceRegistry) : [];

  log("Cinatra instances (registry is authoritative; the per-checkout marker is a HINT):");
  if (instances.length === 0) {
    log("  (none recorded in ~/.cinatra/instances.json)");
  } else {
    for (const inst of instances) {
      const ports = Object.entries(inst.ports ?? {})
        .map(([svc, list]) => `${svc}=${(list ?? []).join("/")}`)
        .join(" ");
      log(
        `  • ${inst.slug}  [${inst.state}]  ${inst.mode}  app:${inst.appPort ?? "?"}  ` +
          `project:${inst.composeProject}  dir:${inst.installDir}`,
      );
      if (ports) log(`      infra ports: ${ports}`);
    }
  }

  // For a specific checkout (not --list-instances), reconcile its marker.
  if (!listAll && targetDir) {
    const markerRead = (deps.readMarker ?? readMarker)(targetDir);
    const row = instanceRegistry
      ? listInstances(instanceRegistry).find((i) => path.resolve(i.installDir) === path.resolve(targetDir)) ?? null
      : null;
    // Best-effort live signal: does this checkout own any live container?
    let liveOwned = false;
    try {
      const owned = (deps.targetComposeOwnedPorts ?? targetComposeOwnedPorts)(targetDir);
      liveOwned = owned instanceof Set && owned.size > 0;
    } catch {
      liveOwned = false;
    }
    const reconciled = reconcileMarker(markerRead.marker, row, liveOwned);
    log("");
    log(`This checkout (${targetDir}):`);
    log(`  marker:    ${markerRead.status}${markerRead.marker?.slug ? ` (claims "${markerRead.marker.slug}")` : ""}`);
    log(`  reconciled: ${reconciled.state} — ${reconciled.reason}`);
  }
}

// ── T8/T9 — ISOLATED install executor + tagged rollback ─────────────────────
/**
 * Bring up an ISOLATED second instance: a full stack on a remapped port band +
 * its own compose project + its own app port. Ordering (review hardening #4):
 * allocate offset → render + RE-PROBE the remapped band FIRST → only THEN
 * persist the generated compose + provisioning row + marker → up → mark ready.
 * A failure before `ready` triggers the tagged rollback (no leaked project/row).
 *
 * Returns { slug, composeProject, composeFiles, appPort, ports }.
 */
async function executeIsolatedInstall({ targetDir, opts, resolvedSha, log = console.log, deps = {} }) {
  const probePorts = deps.detectPortConflicts ?? detectPortConflicts;
  const startInfra = deps.bringUpInfra ?? bringUpInfra;
  const getConfig = deps.composeConfigForFiles ?? composeConfigForFiles;
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const readClone = deps.readCloneRegistry ?? (() => null);

  // Slug: explicit --instance, else derived from the install dir basename.
  const slug = opts.instance ?? deriveInstanceSlug(targetDir);
  if (!isValidSlug(slug)) {
    throw new Error(
      `Could not derive a valid instance slug from ${targetDir}. Pass --instance <slug> ` +
        `(/^[a-z0-9][a-z0-9-]{0,29}$/).`,
    );
  }
  const composeProject = `cinatra_${slug.replace(/-/g, "_")}`;

  // cinatra-cli#57: ensure `.env.local` exists (with the minted operator secrets)
  // BEFORE resolving the compose config, so `docker compose config` interpolates
  // every `${VAR}` from the REAL instance env-file (not a blank/default). The
  // generated compose then re-symbolises exactly those env-file-supplied keys
  // back to `${KEY}`, and the isolated `up`'s `--env-file .env.local` resolves
  // them — end-to-end consistent. A dry-run writes nothing; an idempotent re-run
  // preserves the existing file (ensureEnvLocal is non-destructive without
  // --reset-env).
  if (!opts.dryRun) {
    ensureEnvLocal({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, log });
  }

  // Resolve the base band from the checkout's own compose config.
  const resolvedConfig = getConfig(targetDir, ["docker-compose.yml", "docker-compose.dev.yml"], deps);
  if (!resolvedConfig) {
    throw new Error(
      "Could not resolve the checkout's `docker compose config` to build an isolated stack. " +
        "Ensure Docker Compose v2 is available and the checkout is intact, then retry.",
    );
  }
  const baseBand = parseComposePublishedPorts(resolvedConfig);
  if (baseBand.length === 0) {
    throw new Error("The checkout's compose config publishes no host ports — nothing to isolate.");
  }

  // The whole allocate → re-probe → persist sequence runs under the shared
  // alloc lock so two installs can never pick the same offset/app-port and the
  // provisioning row is durable before the lock releases.
  const persisted = await withAllocLock(lockPath, async () => {
    const cloneRegistry = (() => {
      try {
        return readClone();
      } catch {
        return null;
      }
    })();
    const instanceRegistry = requireUsableInstanceRegistry(registryPath);

    // Idempotent re-run: an existing READY row for this dir → return it as-is.
    const existing = getInstance(instanceRegistry, slug);
    if (existing && path.resolve(existing.installDir) === path.resolve(targetDir) && existing.state === "ready") {
      log(`  Instance "${slug}" already recorded ready — converging (idempotent).`);
      return { slot: existing, generatedFile: existing.composeFiles?.[0], idempotent: true };
    }

    // App port: explicit --app-port, else allocate (cinatra-cli#38).
    // The app port (Next.js `PORT`) is the host port `pnpm dev` binds — it is
    // NOT a compose-published port, so unlike the infra band (probed below) it
    // was historically validated for numeric RANGE only and never checked for
    // RESERVED-set membership or LIVE availability. Both are checked here, under
    // the alloc lock, against the SAME consistent reserved snapshot the band
    // allocator uses and with the SAME socket probe the infra band uses.
    // (WayFlow's 3010 is a compose service in the band → already remapped+probed.)
    const probeAppPort = async (port, host = "0.0.0.0") => {
      const conflicts = await probePorts([{ service: "app", host, port }]);
      return conflicts.length === 0;
    };
    let appPort;
    if (opts.appPort != null) {
      // Explicit --app-port: REJECT on a reserved-set OR live conflict — never
      // silently record a port that collides with the default stack / a clone
      // band / a live reservation / an occupied socket.
      const reserved = reservedPorts({ cloneRegistry, instanceRegistry });
      await assertAppPortFree({
        appPort: opts.appPort,
        reserved,
        host: "0.0.0.0", // match the interface probeAppPort binds (error text honesty)
        probe: (host, port) => probeAppPort(port, host),
      });
      appPort = opts.appPort;
    } else {
      // Auto: allocateAppPort already excludes the reserved set; additionally
      // live-probe and, on a stranger-held socket, bump to the next free port
      // (excluding every probed-busy port). Bounded so a pathological host can't
      // spin forever.
      const busy = new Set();
      let attempts = 0;
      while (true) {
        appPort = allocateAppPort({ cloneRegistry, instanceRegistry, exclude: busy });
        if (await probeAppPort(appPort)) break;
        busy.add(appPort);
        attempts += 1;
        if (attempts >= 16) {
          throw new Error(
            `Could not find a live-free instance app port after ${attempts} attempts ` +
              `(last tried ${appPort}, all probed busy). ` +
              `Free a port or pass --app-port <n> with one you know is free.`,
          );
        }
      }
    }

    // Offset: explicit numeric --port-offset, else auto. Then RE-PROBE the
    // remapped band; on a stranger, bump to the next free offset (auto only).
    // The chosen app port is reserved against the band so no remapped infra
    // host port can land on this instance's own app port (cinatra-cli#38 — a
    // self-collision the band's live probe could not catch pre-bring-up).
    let offset;
    let remapped;
    if (typeof opts.portOffset === "number") {
      ({ offset, remapped } = pickFixedOffset(baseBand, opts.portOffset, cloneRegistry, instanceRegistry, appPort));
    } else {
      ({ offset, remapped } = allocateBandOffset({ band: baseBand, cloneRegistry, instanceRegistry, extraReserved: appPort }));
    }

    // Re-probe the remapped band (auto-bump loop). The band's host bindings are
    // the same interfaces as the base; probe each remapped host:port.
    const auto = typeof opts.portOffset !== "number";
    let attempts = 0;
    while (true) {
      const conflicts = await probePorts(remapped);
      if (conflicts.length === 0) break;
      if (!auto || attempts >= 8) {
        throw new Error(
          formatPortConflictError(conflicts, {
            phase: `isolated band probe (offset ${offset})`,
          }) + `\n  The chosen isolated band is itself occupied; pick a free --port-offset.`,
        );
      }
      attempts += 1;
      ({ offset, remapped } = allocateBandOffset({
        band: baseBand,
        cloneRegistry,
        instanceRegistry,
        extraReserved: appPort,
        min: offset + 10000,
      }));
    }

    // cinatra-cli#57: the isolated `up` runs with `--env-file .env.local`, so a
    // secret in the generated compose may be re-symbolised to `${KEY}` ONLY when
    // `.env.local` actually supplies that key (with a non-empty value) — else it
    // resolves to a BLANK string (the bug). `.env.local` is already created above
    // (before `getConfig`); derive the scrub-allowlist from its keys. A
    // compose-baked infra-init DEFAULT (`POSTGRES_PASSWORD: postgres`, etc.) is
    // NOT in `.env.local`, so it is left as its literal — which both resolves AND
    // preserves the distinct per-service values (postgres=`postgres` vs
    // nango-db=`nango`) a flat `${VAR}` would collapse. The host-remapped infra
    // URL keys are EXCLUDED from the allowlist: their `.env.local` values point at
    // host ports (for the host-side app/CLI), which would be wrong inside the
    // compose network — the container envs keep their literal service-DNS URLs.
    const envFileKeys = computeIsolatedScrubAllowlist(targetDir);

    // Render the resolved isolated compose for the FINAL offset. `scrubbedKeys`
    // is the set of env-file-supplied keys re-symbolised to `${KEY}` (NAMES only)
    // — used by the post-write invariant check.
    const { doc, ports, scrubbedKeys } = generateIsolatedCompose({
      resolvedConfig,
      offset,
      projectName: composeProject,
      slug,
      appPort,
      envFileKeys,
    });

    if (opts.dryRun) {
      log(`  [dry-run] would write isolated compose to ${path.join(targetDir, ISOLATED_COMPOSE_FILENAME)}`);
      log(`  [dry-run] would record instance "${slug}" project ${composeProject} app:${appPort} offset:${offset}`);
      return { slot: null, generatedFile: null, dryRun: true, appPort, ports, offset };
    }

    // cinatra-cli#57 invariant: EVERY `${VAR}` the generator just introduced must
    // be supplied by `.env.local` (so none resolves blank at `up`). The generator
    // only scrubs allowlisted keys, so this holds by construction — assert it
    // defensively so a future regression fails loud at install time, not as a
    // silent blank-password DB crash.
    assertScrubbedKeysSupplied(targetDir, scrubbedKeys);

    // cinatra-cli#97 invariant: NO generated service env may still advertise a
    // loopback URL on an UN-OFFSET (donor/default) published host port — every
    // self-URL (Nango's NANGO_SERVER_URL / NANGO_PUBLIC_SERVER_URL, any OAuth
    // callback/base URL) must have followed the host-port shift. Holds by
    // construction; assert defensively so a regression fails loud at install
    // time, not as a silent cross-instance OAuth/self-URL leak to the main stack.
    assertComposeHostUrlsRemapped(doc, new Set(baseBand.map((b) => b.port)));

    // Persist the generated compose + provisioning row + marker (recording the
    // generated SOLE file as composeFiles[]).
    const generatedFile = writeIsolatedComposeFile(path.join(targetDir, ISOLATED_COMPOSE_FILENAME), doc);
    const composeFiles = [ISOLATED_COMPOSE_FILENAME];
    const { registry: next, slot } = allocateInstance(instanceRegistry, slug, {
      mode: opts.mode,
      installDir: targetDir,
      composeProject,
      composeFiles,
      ports,
      appPort,
      repoUrl: opts.repoUrl,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "new",
      createdResources: [generatedFile],
      state: "provisioning",
    });
    writeInstanceRegistry(registryPath, next);
    writeMarker(targetDir, {
      slug,
      id: slot.id,
      mode: opts.mode,
      composeProject,
      composeFiles,
      appPort,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "new",
      state: "provisioning",
    });
    return { slot, generatedFile, composeFiles, appPort, ports, offset };
  });

  if (persisted.dryRun) {
    return { slug, composeProject, composeFiles: [ISOLATED_COMPOSE_FILENAME], appPort: persisted.appPort, ports: persisted.ports, dryRun: true };
  }

  // Idempotent re-run of a recorded ready row: still ENSURE its stack is up
  // (review hardening #4 — a stopped recorded stack must come back up, not silently
  // "succeed" without bringing it up). No rollback (it is already ready).
  if (persisted.idempotent) {
    const slot = persisted.slot;
    const envFile = path.join(targetDir, ".env.local");
    if (!opts.dryRun) {
      ensureIsolatedEnv({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, appPort: slot.appPort, ports: slot.ports, log });
      startInfra({
        targetDir,
        log,
        composeFiles: slot.composeFiles,
        composeProject: slot.composeProject,
        envFile: existsSync(envFile) ? envFile : null,
        nangoHealthUrl: nangoHealthUrlForPorts(slot.ports),
      });
    }
    return {
      slug,
      composeProject: slot.composeProject,
      composeFiles: slot.composeFiles,
      appPort: slot.appPort,
      ports: slot.ports,
      idempotent: true,
    };
  }

  const composeFiles = persisted.composeFiles;
  const appPort = persisted.appPort;
  const envFile = path.join(targetDir, ".env.local");

  // review hardening #1/#3: WRITE the env (incl. the remapped infra URLs) BEFORE the
  // isolated `up`, and bring up WITH `--env-file .env.local` so the generated
  // compose's scrubbed `${VAR}` placeholders + the remapped URLs resolve from
  // the file (never an empty/default secret). Mirrors the default flow's
  // env-before-infra ordering. A failure rolls the pending instance back.
  try {
    log(`- Configuring isolated environment for "${slug}"…`);
    ensureIsolatedEnv({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, appPort, ports: persisted.ports, log });

    log(`- Bringing up isolated instance "${slug}" (project ${composeProject}, app port ${appPort})…`);
    startInfra({
      targetDir,
      log,
      composeFiles,
      composeProject,
      envFile: existsSync(envFile) ? envFile : null,
      // The isolated Nango publishes on a remapped port; health-probe it there.
      nangoHealthUrl: nangoHealthUrlForPorts(persisted.ports),
    });
    // Mark ready ONLY after health.
    await withAllocLock(lockPath, async () => {
      const reg = requireUsableInstanceRegistry(registryPath);
      writeInstanceRegistry(registryPath, markInstanceReady(reg, slug, { sha: resolvedSha, ports: persisted.ports }));
    });
    writeMarker(targetDir, {
      slug,
      id: persisted.slot.id,
      mode: opts.mode,
      composeProject,
      composeFiles,
      appPort,
      ref: opts.ref,
      sha: resolvedSha,
      infraMode: "new",
      state: "ready",
    });
  } catch (err) {
    log(`  ✗ Isolated bring-up failed — rolling back the pending instance "${slug}".`);
    await rollbackIsolatedInstance({ targetDir, slug, composeProject, composeFiles, log, deps }).catch((e) =>
      log(`  ⚠ Rollback best-effort error: ${e.message}`),
    );
    throw err;
  }

  return { slug, composeProject, composeFiles, appPort, ports: persisted.ports, envWritten: true };
}

/** Ensure `.env.local` exists (creating it from .env.example if needed) and
 *  carry the ISOLATED app port + remapped infra URLs. Combines `ensureEnvLocal`
 *  with `writeIsolatedAppEnv`, and refuses an exported infra var that would
 *  override the rewritten value (review hardening #3). Idempotent — safe to call from the
 *  isolated executor (before up) and again from step 5b. */
function ensureIsolatedEnv({ targetDir, mode, resetEnv = false, appPort, ports = {}, log = console.log }) {
  ensureEnvLocal({ targetDir, mode, resetEnv, log });
  assertNoOverridingInfraEnv(ports);
  writeIsolatedAppEnv({ targetDir, appPort, ports, log });
}

/** cinatra-cli#57 — the keys a generated isolated compose secret may be
 *  re-symbolised to `${KEY}` against: ONLY keys the instance's `.env.local`
 *  actually supplies (so `${KEY}` resolves at `up` time, never a blank string).
 *
 *  Derived from the keys present in the (already-created) `.env.local`, MINUS the
 *  host-remapped infra-URL keys: those keys carry a HOST 127.0.0.1:<remapped>
 *  value (for the host-side app/CLI), which is wrong INSIDE the compose network —
 *  a container env referencing such a URL must keep its literal service-DNS value
 *  (the in-network `postgresql://<svc>:5432/<db>` form), so those keys must NOT
 *  be on the scrub allowlist. The result is the genuine operator-secret surface
 *  (OPENAI_API_KEY, NANGO_ENCRYPTION_KEY, BETTER_AUTH_SECRET, the
 *  ${NEO4J_PASSWORD}-sourced neo4j password, …) — the values that are identical
 *  host-side and container-side and that we must NOT persist as plaintext.
 *
 *  Returns a Set (empty when `.env.local` is absent → the generator then scrubs
 *  nothing, leaving every infra default literal: the stack still starts). */
function computeIsolatedScrubAllowlist(targetDir) {
  const envPath = path.join(targetDir, ".env.local");
  if (!existsSync(envPath)) return new Set();
  let parsed;
  try {
    parsed = parseEnvBody(readFileSync(envPath, "utf8"));
  } catch {
    return new Set();
  }
  const excluded = new Set(ISOLATED_INFRA_ENV_KEYS);
  // A key is on the allowlist ONLY when `.env.local` gives it a NON-EMPTY value:
  // a declared-but-empty key (e.g. an unset `OPENAI_API_KEY=` carried from
  // `.env.example`) does NOT supply a value, so re-symbolising the compose's
  // literal to `${KEY}` would resolve BLANK — leave such a value as its literal.
  return new Set(
    Object.entries(parsed)
      .filter(([k, v]) => !excluded.has(k) && typeof v === "string" && v.length > 0)
      .map(([k]) => k),
  );
}

/** cinatra-cli#57 invariant guard. Every `${VAR}` the generator introduced must
 *  be supplied by `.env.local` with a NON-EMPTY value — otherwise `docker compose
 *  up` resolves it to a blank string and a fresh postgres/nango-db refuses to
 *  initialise (the exact bug). The generator only scrubs allowlisted keys, so
 *  this holds by construction; assert it so a regression fails loud HERE (a clear
 *  install-time error) instead of as an opaque DB-init crash. `scrubbedKeys` are
 *  NAMES only; we never log a value. */
function assertScrubbedKeysSupplied(targetDir, scrubbedKeys = []) {
  if (!Array.isArray(scrubbedKeys) || scrubbedKeys.length === 0) return;
  const envPath = path.join(targetDir, ".env.local");
  const env = existsSync(envPath) ? parseEnvBody(readFileSync(envPath, "utf8")) : {};
  const blank = scrubbedKeys.filter((k) => typeof env[k] !== "string" || env[k].length === 0);
  if (blank.length > 0) {
    throw new Error(
      `Isolated compose generation re-symbolised ${blank.length} key(s) that .env.local does not supply ` +
        `(${blank.join(", ")}) — they would resolve to a BLANK string at \`docker compose up\` and break the ` +
        `infra DBs (cinatra-cli#57). This is an internal invariant violation; please report it.`,
    );
  }
}

// The infra-URL env keys an isolated install writes; an EXPORTED value for any
// of these would be overlaid over .env.local by setup (collectEnvironment),
// silently re-routing the isolated app to the default/another stack. We refuse a
// non-empty exported value so the rewrite stays authoritative (review hardening #3).
const ISOLATED_INFRA_ENV_KEYS = [
  "SUPABASE_DB_URL",
  "REDIS_URL",
  "NANGO_SERVER_URL",
  "NANGO_DATABASE_URL",
  "NANGO_DB_URL",
  "GRAPHITI_URL",
  // cinatra-cli#97: WAYFLOW_BASE_URL is host-remapped to the isolated WayFlow
  // port; an exported value would override the rewrite and re-route the isolated
  // app's WayFlow-backed features back at the default/main instance's WayFlow.
  "WAYFLOW_BASE_URL",
  // cinatra-cli#36: the Verdaccio registry-client + Neo4j-client URLs are now
  // rewritten too — an exported stale value (e.g. a donor's …:4873 / …:7687)
  // would otherwise win over the isolated .env.local (collectEnvironment lets
  // process.env override) and re-route the isolated instance's registry seed /
  // Neo4j client back at the donor, defeating isolation.
  "CINATRA_AGENT_REGISTRY_URL",
  "CINATRA_AGENT_REGISTRY_UI_URL",
  "NEO4J_URI",
];

function assertNoOverridingInfraEnv(ports = {}, env = process.env) {
  const offenders = ISOLATED_INFRA_ENV_KEYS.filter(
    (k) => typeof env[k] === "string" && env[k].trim().length > 0,
  );
  if (offenders.length > 0) {
    throw new Error(
      `Refusing an isolated install while these infra vars are EXPORTED in your shell: ${offenders.join(", ")}.\n` +
        `  setup overlays the shell environment over .env.local, so an exported value would silently re-route the\n` +
        `  isolated app to the default/another stack (defeating isolation). Unset them and retry:\n` +
        offenders.map((k) => `    unset ${k}`).join("\n"),
    );
  }
}

/** Pick a FIXED operator-supplied offset, verifying the remapped band does not
 *  collide with reserved ports (else throw — never silently shift it).
 *  `extraReserved` carries the instance's own chosen app port so a fixed offset
 *  is rejected if it would land an infra port on it (cinatra-cli#38). */
function pickFixedOffset(band, offset, cloneRegistry, instanceRegistry, extraReserved = null) {
  // Reuse the allocator's reservation set by trying a single-candidate window.
  try {
    return allocateBandOffset({
      band,
      cloneRegistry,
      instanceRegistry,
      extraReserved,
      min: offset,
      max: offset,
      step: 1,
    });
  } catch {
    throw new Error(
      `--port-offset ${offset} collides with a reserved port (default stack / clones / another instance), ` +
        `or pushes a port past 65535. Choose a different offset.`,
    );
  }
}

/** Best-effort isolated Nango health URL from the remapped ports map (the
 *  service is named `nango-server`; its first remapped host port serves /health).
 *  Falls back to null (skip the targeted probe) when not found. */
function nangoHealthUrlForPorts(ports) {
  const list = ports?.["nango-server"];
  if (Array.isArray(list) && list.length) {
    return `http://127.0.0.1:${list[0]}/health`;
  }
  return null;
}

/** T9 — tagged rollback for a PRE-READY isolated instance: remove only THIS
 *  pending project (recorded -p + -f) + project-scoped volumes + registry row +
 *  marker + the generated compose file. "Drop only if owner metadata matches". */
async function rollbackIsolatedInstance({ targetDir, slug, composeProject, composeFiles, log = console.log, deps = {} }) {
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const runCompose = deps.runComposeDown ?? composeDown;

  // Only roll back a project whose registry row still belongs to THIS dir and is
  // NOT ready (pre-ready rollback only — never drop a healthy instance). The
  // state re-check AND the `down` BOTH run inside ONE held alloc lock so a
  // concurrent --resume/install cannot flip the row to `ready` in the window
  // between the check and the teardown (TOCTOU): "rollback never drops a READY
  // instance" must hold even under a race. The pending instance's `down` is a
  // brief local subprocess on a freshly-allocated stack, so holding the lock
  // across it is acceptable (and far safer than a racy check-then-act).
  let downAttempted = false;
  let downError = null;
  await withAllocLock(lockPath, async () => {
    let reg;
    try {
      reg = requireUsableInstanceRegistry(registryPath);
    } catch {
      reg = null;
    }
    const row = reg ? getInstance(reg, slug) : null;
    if (!row || path.resolve(row.installDir) !== path.resolve(targetDir)) {
      return; // nothing of ours to roll back
    }
    if (row.state === "ready") {
      log(`  ⚠ Refusing rollback: instance "${slug}" is recorded READY (owner-metadata guard).`);
      return;
    }
    // review hardening #3: tear the project DOWN FIRST, THEN release the row — so if
    // `down` fails (or the process dies between), the row survives for a retried
    // rollback and we never orphan a live, UNREGISTERED stack. The `down` runs the
    // recorded -p + -f with -v (the pending instance's volumes are brand-new → safe).
    downAttempted = true;
    try {
      runCompose(targetDir, { composeFiles, composeProject, volumes: true });
    } catch (e) {
      // Down failed → keep the row so a retried rollback can finish; surface it.
      downError = e;
      return;
    }
    // Down succeeded → release the registry row (still under the same lock).
    if (getInstance(reg, slug)) {
      const { registry: next } = releaseInstance(reg, slug);
      writeInstanceRegistry(registryPath, next);
    }
  });
  if (downAttempted && !downError) {
    try {
      const markerFile = path.join(targetDir, ".cinatra", "instance.json");
      if (existsSync(markerFile)) spawnSync("rm", ["-f", markerFile]);
    } catch {
      /* best-effort */
    }
    try {
      for (const f of composeFiles ?? []) {
        const p = path.join(targetDir, f);
        if (existsSync(p) && f === ISOLATED_COMPOSE_FILENAME) spawnSync("rm", ["-f", p]);
      }
    } catch {
      /* best-effort */
    }
  }
  if (downError) {
    log(
      `  ⚠ Rollback teardown of "${slug}" failed (${downError.message}); the registry row is kept ` +
        `so a retried install/--resume can finish the rollback (no orphaned unregistered stack).`,
    );
  }
}

/** `docker compose -p <project> -f <files…> down [-v]` for the RECORDED set.
 *  Streams output; throws on hard failure. */
function composeDown(targetDir, { composeFiles = null, composeProject = null, volumes = false } = {}) {
  const args = [...composeArgsFor({ composeFiles, composeProject }), "down"];
  if (volumes) args.push("-v");
  const result = spawnSync("docker", args, { cwd: targetDir, env: process.env, encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
  const stderr = (result.stderr ?? "").trim();
  if (stderr) process.stderr.write(`${stderr}\n`);
  if (result.error) throw new Error(`docker compose down failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`docker compose down failed (exit ${result.status}).${stderr ? `\n${stderr}` : ""}`);
}

/** Derive an instance slug from the install dir basename (sanitised to the slug
 *  shape). The default install dir basename is `cinatra` → slug `cinatra`. */
function deriveInstanceSlug(targetDir) {
  const base = path.basename(path.resolve(targetDir));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

// ── cinatra-cli#35 — explicit default Compose project name + ownership preflight ──
//
// The default `up` historically passed NO `-p`, so Docker derived the project
// from the dir BASENAME. Two checkouts named `cinatra` ⇒ one shared project ⇒
// shared named volumes ⇒ a hijack/recreate + cross-`down -v` data-loss. We now
// compute an EXPLICIT, instance-scoped project name and pass it as `-p`, plus an
// ownership preflight (running + STOPPED + volumes) that REFUSES when the
// candidate project / named volumes already belong to a DIFFERENT checkout.

/** The canonical NEW default Compose project name for a checkout:
 *  `cinatra_<slug>` with the same slug the isolated path uses (explicit
 *  --instance, else the sanitised dir basename). Pure. NOTE: two dirs BOTH named
 *  `cinatra` still collapse to `cinatra_cinatra` here — naming alone is NOT the
 *  safety guarantee; the ownership preflight is (cinatra-cli#35, codex A). */
export function computeDefaultProject(opts, targetDir) {
  const slug = opts?.instance ?? deriveInstanceSlug(targetDir);
  return `cinatra_${slug.replace(/-/g, "_")}`;
}

/** The BARE basename Compose project a LEGACY default install (brought up under
 *  the dir basename, no `-p`) would have used. Compose lowercases + strips to
 *  `[a-z0-9_-]` and collapses other runs to `_`. Pure. */
export function legacyBasenameProject(targetDir) {
  const base = path.basename(path.resolve(targetDir));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+/, "");
}

/** Extract `{ project, workingDir }` ownership facts from a `docker ps -a`
 *  inspect row (containers) — running OR stopped. Pure. */
function containerProjectOwnership(row) {
  const labels = row?.Config?.Labels ?? {};
  const project = labels["com.docker.compose.project"] || null;
  const workingDir = labels["com.docker.compose.project.working_dir"] || null;
  return { project, workingDir };
}

/**
 * Decide the default-path Compose project name + ownership verdict from injected
 * inspect rows (pure — fully unit-testable). Resolution order (cinatra-cli#35):
 *
 *   1. LEGACY ADOPTION (codex B, mandatory). If a LEGACY basename project's
 *      containers are ALL rooted at THIS targetDir, ADOPT that basename project
 *      (keep volumes stable — a new `cinatra_<slug>` name would orphan the old
 *      stack AND point at FRESH empty volumes, a worse data-surprise). If the
 *      legacy project ALSO has a foreign/unknown owner, do NOT adopt — REFUSE
 *      (codex blocker #3: a mixed-owner legacy project must not be silently
 *      adopted).
 *   2. OWNERSHIP REFUSE (codex C). Else, if the candidate `cinatra_<slug>`
 *      project — or one of its named volumes — already exists and is NOT provably
 *      ours, REFUSE: routing to --on-conflict=isolated / --instance. A volume may
 *      carry only `com.docker.compose.project` (no working_dir, codex/risk #2);
 *      an unknown-dir candidate volume is refused UNLESS ownership is PROVEN
 *      (a same-target container, or `ownsCandidate` from a registry/marker row) —
 *      codex blocker #2: a name-matching preserved volume from a DIFFERENT
 *      checkout must never be silently reused.
 *   3. Else USE the new `cinatra_<slug>` (brand-new install).
 *
 * @param {object} a
 * @param {string} a.candidateProject  `cinatra_<slug>` (from computeDefaultProject)
 * @param {string} a.legacyProject     the bare basename project
 * @param {string} a.targetDir         this checkout's dir
 * @param {Array}  [a.containerRows]   `docker ps -a` inspect rows (running+stopped)
 * @param {Array}  [a.volumeRows]      `[{name, project, workingDir}]` named-volume facts
 * @param {boolean} [a.ownsCandidate]  registry/marker proof THIS checkout owns the
 *                                      candidate project (lets an own-but-unknown-dir
 *                                      volume be reused; codex blocker #2).
 * @returns {{ action:'adopt-legacy'|'use-default'|'refuse', project:string|null,
 *             reason:string, conflictDir?:string }}
 */
export function decideDefaultProjectOwnership({
  candidateProject,
  legacyProject,
  targetDir,
  containerRows = [],
  volumeRows = [],
  ownsCandidate = false,
} = {}) {
  const wantDir = targetDir ? path.resolve(targetDir) : null;
  const rows = Array.isArray(containerRows) ? containerRows : [];
  const vols = Array.isArray(volumeRows) ? volumeRows : [];

  // Per-project ownership facts gathered from the live containers.
  // project -> Set<workingDir|null>  (null = a container of that project with no
  // working_dir label — an UNKNOWN, un-attributable owner).
  const projectDirs = new Map();
  for (const r of rows) {
    const { project, workingDir } = containerProjectOwnership(r);
    if (!project) continue;
    const dir = typeof workingDir === "string" && workingDir.length ? path.resolve(workingDir) : null;
    if (!projectDirs.has(project)) projectDirs.set(project, new Set());
    projectDirs.get(project).add(dir);
  }

  // Does a container of `candidateProject` prove THIS checkout owns it?
  const candidateDirs = projectDirs.get(candidateProject) ?? new Set();
  const candidateOwnedHere = wantDir != null && candidateDirs.has(wantDir);
  const provenOurs = ownsCandidate || candidateOwnedHere;

  // 1. Legacy adoption — the basename project is rooted (ONLY) at THIS dir.
  if (legacyProject && legacyProject !== candidateProject && projectDirs.has(legacyProject)) {
    const dirs = projectDirs.get(legacyProject);
    const legacyForeign = [...dirs].filter((d) => d === null || d !== wantDir);
    if (wantDir && dirs.has(wantDir) && legacyForeign.length === 0) {
      // ALL legacy owners are us → safe to adopt (volumes stay stable).
      return {
        action: "adopt-legacy",
        project: legacyProject,
        reason:
          `an existing legacy default stack (project "${legacyProject}") is rooted at this checkout — ` +
          `adopting it keeps the named volumes stable`,
      };
    }
    if (legacyForeign.length > 0 && (!wantDir || dirs.has(wantDir) || dirs.has(null))) {
      // The legacy basename project is rooted here AND shared with a foreign/
      // unknown owner, has an UNATTRIBUTABLE owner (no working_dir label — it
      // could be THIS checkout's own old stack, so falling through could orphan
      // its data behind a fresh candidate stack; codex convergence on eng#513),
      // or the target dir itself cannot be attributed. Never adopt it (codex
      // blocker #3). REFUSE.
      const conflictDir = [...dirs].find((d) => d !== null && d !== wantDir);
      return {
        action: "refuse",
        project: null,
        conflictDir: conflictDir ?? undefined,
        reason:
          `the legacy basename project "${legacyProject}" is owned by ` +
          (conflictDir ? `a different checkout (${conflictDir})` : "another (unattributable) stack") +
          ` — adopting it could hijack that stack`,
      };
    }
    // Otherwise the legacy basename project exists ONLY at KNOWN foreign
    // checkouts: there is nothing to adopt here, and the candidate `-p` project
    // name is DISTINCT (`cinatra_<slug>` ≠ bare basename), so bringing up the
    // candidate stack cannot touch the foreign legacy stack's containers or
    // named volumes.
    // Refusing here bricked every install into a dir NAMED `cinatra` (the CLI's
    // own suggested default) on any host where a different checkout ever ran a
    // legacy default stack — with a remediation message advising the exact
    // `--instance` flag the user had already passed. Fall through to the
    // candidate-project ownership rules (2/2b), which still refuse a real
    // candidate collision.
  }

  // 2. Ownership refuse — the candidate project exists and is NOT provably ours.
  if (candidateProject && candidateDirs.size > 0) {
    const foreign = [...candidateDirs].filter((d) => d !== null && d !== wantDir);
    const hasUnknown = candidateDirs.has(null);
    // Only us → idempotent re-run (safe). Otherwise a foreign or unknown owner is
    // a conflict UNLESS proven ours by registry/marker (then an unknown-dir
    // container is treated as our own ghost).
    const onlyUs = [...candidateDirs].every((d) => d === wantDir);
    if (!onlyUs && (foreign.length > 0 || (hasUnknown && !provenOurs))) {
      const conflictDir = foreign.length > 0 ? foreign[0] : undefined;
      return {
        action: "refuse",
        project: null,
        conflictDir,
        reason:
          `the Compose project "${candidateProject}" already exists` +
          (conflictDir ? ` and is owned by a different checkout (${conflictDir})` : " and is owned by another (unattributable) stack"),
      };
    }
  }

  // 2b. A named volume of the candidate project that is NOT provably ours (volume
  //     labels may be project-name-only — risk #2). A volume rooted at a DIFFERENT
  //     checkout, owned by a different project, OR with NO dir + not-proven-ours,
  //     is a foreign-owned name collision (codex blocker #2: never reuse it).
  for (const v of vols) {
    if (!v || typeof v.name !== "string") continue;
    const ownsByLabel = v.project === candidateProject;
    const ownsByName = candidateProject && v.name.startsWith(`${candidateProject}_`);
    if (!ownsByLabel && !ownsByName) continue;
    const volDir = typeof v.workingDir === "string" && v.workingDir.length ? path.resolve(v.workingDir) : null;
    if (volDir !== null && volDir === wantDir) continue; // provably ours by dir.
    const foreignVolDir = volDir !== null && volDir !== wantDir;
    const foreignVolProject = v.project && v.project !== candidateProject;
    // An unknown-dir candidate volume is a conflict UNLESS proven ours.
    const unknownAndUnproven = volDir === null && !foreignVolProject && !provenOurs;
    if (foreignVolDir || foreignVolProject || unknownAndUnproven) {
      return {
        action: "refuse",
        project: null,
        conflictDir: volDir ?? undefined,
        reason:
          `a named volume ("${v.name}") of project "${candidateProject}" already exists and is owned by ` +
          (volDir
            ? `a different checkout (${volDir})`
            : foreignVolProject
              ? `a different project ("${v.project}")`
              : "an unverifiable owner (cannot prove it is this checkout's — refusing to reuse it)"),
      };
    }
  }

  // 3. Brand-new install (or a proven idempotent re-run) — use the explicit
  //    instance-scoped name.
  return {
    action: "use-default",
    project: candidateProject,
    reason: "no existing project/volume conflict — using an explicit instance-scoped project name",
  };
}

/** Inspect Docker for a project's ownership across RUNNING + STOPPED containers
 *  and its named volumes (cinatra-cli#35(d)). Returns
 *  `{ containerRows, volumeRows }` for `decideDefaultProjectOwnership`. Injectable
 *  via `deps.inspectProjectOwnership` for tests; the real path shells `docker`.
 *  Best-effort: any docker error yields empty sets (never throws). */
function inspectProjectOwnership(projectNames, deps = {}) {
  if (typeof deps.inspectProjectOwnership === "function") {
    return deps.inspectProjectOwnership(projectNames, deps);
  }
  const cap = deps.capture ?? capture;
  const names = (Array.isArray(projectNames) ? projectNames : [projectNames]).filter(Boolean);
  const containerRows = [];
  const seen = new Set();
  for (const name of names) {
    // Running AND stopped containers of the project (the stopped-sibling blind
    // spot — a stopped stack holds no ports but still owns the project+volumes).
    const ids = cap("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${name}`, "-q"]);
    const idList = (ids ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (idList.length === 0) continue;
    const raw = cap("docker", ["inspect", ...idList]);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
    for (const r of Array.isArray(parsed) ? parsed : []) {
      const id = r?.Id ?? JSON.stringify(r);
      if (seen.has(id)) continue;
      seen.add(id);
      containerRows.push(r);
    }
  }
  // Named volumes carrying a candidate-project label (volume labels may be
  // project-name-only — risk #2). `docker volume ls --filter label=… -q` then
  // inspect for the working_dir/project labels.
  const volumeRows = [];
  const volSeen = new Set();
  for (const name of names) {
    const vols = cap("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${name}`, "-q"]);
    const volList = (vols ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    if (volList.length === 0) continue;
    const raw = cap("docker", ["volume", "inspect", ...volList]);
    if (!raw) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = [];
    }
    for (const v of Array.isArray(parsed) ? parsed : []) {
      if (!v || typeof v.Name !== "string" || volSeen.has(v.Name)) continue;
      volSeen.add(v.Name);
      const labels = v.Labels ?? {};
      volumeRows.push({
        name: v.Name,
        project: labels["com.docker.compose.project"] || null,
        workingDir: labels["com.docker.compose.project.working_dir"] || null,
      });
    }
  }
  return { containerRows, volumeRows };
}

/** Best-effort proof that THIS checkout already brought up a DOCKER STACK under
 *  `candidateProject` — used so an idempotent re-run can reuse its OWN named
 *  volumes even when their working_dir label is absent, while a foreign checkout's
 *  name-matching volume is still refused (review blocker: foreign-volume reuse).
 *  Proof is ONLY a NON-EXTERNAL, READY registry row for this dir recording the
 *  candidate project (review blocker: non-Docker-owning row false-proof): an
 *  `external`/`--no-infra` row never started a stack, and
 *  a `provisioning` row hasn't confirmed bring-up, so neither is Docker ownership;
 *  the per-checkout MARKER is a hint (not authoritative) and is NOT counted. A
 *  same-target LIVE container is proof too, but that is established directly in the
 *  pure decision via `candidateOwnedHere` (a real working_dir label). Never throws. */
function ownsCandidateProject(targetDir, candidateProject, deps = {}) {
  const want = path.resolve(targetDir);
  try {
    const reg = deps.readInstanceRegistry
      ? deps.readInstanceRegistry()
      : requireUsableInstanceRegistry(deps.instanceRegistryPath ?? defaultInstanceRegistryPath());
    const row = listInstances(reg).find((i) => path.resolve(i.installDir) === want);
    if (
      row &&
      row.composeProject === candidateProject &&
      row.infraMode !== "external" &&
      row.state === "ready"
    ) {
      return true;
    }
  } catch {
    /* best-effort */
  }
  return false;
}

/** Resolve the default-path Compose project (legacy-adopt / refuse / use-new)
 *  via the injectable inspector + the pure decision. Throws on REFUSE with an
 *  accurate message routing to isolated/--instance. Returns the resolved project
 *  name to pass as `-p`. cinatra-cli#35(b)(c)(d). */
function resolveDefaultProject({ targetDir, opts, log = console.log, deps = {} }) {
  const candidateProject = computeDefaultProject(opts, targetDir);
  const legacyProject = legacyBasenameProject(targetDir);
  const { containerRows, volumeRows } = inspectProjectOwnership(
    [candidateProject, legacyProject],
    deps,
  );
  // codex blocker #2: registry/marker proof that THIS checkout owns the candidate
  // project — lets an own-but-unknown-dir volume be reused on a re-run, while a
  // name-matching volume from a DIFFERENT checkout is still refused. Best-effort.
  const ownsCandidate = ownsCandidateProject(targetDir, candidateProject, deps);
  const decision = decideDefaultProjectOwnership({
    candidateProject,
    legacyProject,
    targetDir,
    containerRows,
    volumeRows,
    ownsCandidate,
  });
  if (decision.action === "refuse") {
    throw new Error(
      `Refusing the default install: ${decision.reason}.\n` +
        `  Bringing up the default stack here would HIJACK / recreate that stack's containers and operate on its\n` +
        `  named volumes (a \`docker compose down -v\` from EITHER checkout could then destroy the OTHER's data).\n` +
        `  Re-run with --on-conflict=isolated for a fully-separate second stack, ` +
        `or --instance <slug> for a distinct project name.`,
    );
  }
  if (decision.action === "adopt-legacy") {
    log(`- Adopting the existing legacy default stack (project "${decision.project}") for this checkout — ${decision.reason}.`);
  }
  return decision.project;
}

// ── T8c — record the DEFAULT (non-conflict) install ─────────────────────────
/** Record a registry provisioning→ready row + marker for a plain default
 *  install (default band, base compose pair, no generated file). Default
 *  detection is via registry + the live compose `working_dir` label (NOT an
 *  injected label-only file — that would change the most-trodden default `up`
 *  invocation; accepted this lower-risk choice; documented in the PR).
 *  Returns the slug recorded, or null when the registry is unavailable. */
async function recordDefaultInstance({ targetDir, opts, resolvedSha, state, composeProject: composeProjectArg = null, log = console.log, deps = {} }) {
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const slug = opts.instance ?? deriveInstanceSlug(targetDir);
  if (!isValidSlug(slug)) return null;
  // cinatra-cli#35: record the EXPLICIT instance-scoped project name that the
  // default `up` actually used (legacy-adopted basename or new `cinatra_<slug>`),
  // NOT the hardcoded "cinatra" literal that was wrong for any non-`cinatra` dir
  // and collided for any two `cinatra` dirs. Falls back to the computed name when
  // a caller omits it (e.g. the external-record path, which has no live stack).
  const composeProject = composeProjectArg ?? computeDefaultProject(opts, targetDir);
  const composeFiles = ["docker-compose.yml", "docker-compose.dev.yml"];
  // The default infra band as a per-service ports map.
  const ports = {};
  for (const { service, port } of DEFAULT_DEV_HOST_PORTS) {
    (ports[service] ??= []).push(port);
  }

  if (opts.dryRun) {
    log(`  [dry-run] would record default instance "${slug}" project ${composeProject} app:${DEFAULT_APP_PORT_FOR_RECORD}`);
    return slug;
  }

  // Recording is BEST-EFFORT metadata for --status/--attach/stop-existing — a
  // registry conflict (e.g. a stale row from another checkout that still claims
  // the default app port, or a malformed file) must NEVER fail the install
  // itself. On any error: warn + skip the row (the marker is still written).
  let recorded = false;
  try {
    await withAllocLock(lockPath, async () => {
      const reg = requireUsableInstanceRegistry(registryPath);
      const existing = getInstance(reg, slug);
      if (existing && path.resolve(existing.installDir) !== path.resolve(targetDir)) {
        log(`  ⚠ Instance slug "${slug}" already maps to ${existing.installDir}; skipping the default registry record for ${targetDir}.`);
        return;
      }
      let working = reg;
      if (!existing) {
        const { registry: next } = allocateInstance(reg, slug, {
          mode: opts.mode,
          installDir: targetDir,
          composeProject,
          composeFiles,
          ports,
          appPort: DEFAULT_APP_PORT_FOR_RECORD,
          repoUrl: opts.repoUrl,
          ref: opts.ref,
          sha: resolvedSha,
          infraMode: state === "external" ? "external" : "new",
          state: "provisioning",
        });
        writeInstanceRegistry(registryPath, next);
        working = next;
      }
      // Flip to the final state.
      writeInstanceRegistry(registryPath, markInstanceReadyWithState(working, slug, state, { sha: resolvedSha }));
      recorded = true;
    });
  } catch (err) {
    log(`  ⚠ Could not record the instance registry row (${err.message}). Continuing — \`cinatra install --status\` may be incomplete for this checkout.`);
  }

  writeMarker(targetDir, {
    slug,
    id: `inst_${slug}`,
    mode: opts.mode,
    composeProject,
    composeFiles,
    appPort: DEFAULT_APP_PORT_FOR_RECORD,
    ref: opts.ref,
    sha: resolvedSha,
    infraMode: state === "external" ? "external" : "new",
    state,
  });
  return recorded ? slug : null;
}

// The host app port the default stack binds (`pnpm dev` → 3000). Recorded so a
// second isolated instance's allocator can avoid it.
const DEFAULT_APP_PORT_FOR_RECORD = 3000;

/** markInstanceReady but allowing an `external` terminal state too (a default
 *  external install records state=external, never auto-dropped). */
function markInstanceReadyWithState(registry, slug, state, patch = {}) {
  if (state === "ready") return markInstanceReady(registry, slug, patch);
  // external: set state directly (allocateInstance + this is the only writer).
  const existing = getInstance(registry, slug);
  if (!existing) throw new Error(`Cannot finalize unknown instance "${slug}".`);
  const next = { version: registry.version, instances: { ...registry.instances } };
  next.instances[slug] = { ...existing, ...patch, slug, state };
  return next;
}

// ── T13 — external infra execution ──────────────────────────────────────────
/** Validate the four external URLs + write them into .env.local with the
 *  sanitized-env guard so an exported SUPABASE_DB_URL/REDIS_URL/NANGO_* cannot
 *  override the generated values; record the instance as `external` (never
 *  auto-dropped). A destructive-leaning target needs a typed NON-ROLLBACKABLE
 *  confirm. Returns the env keys written. */
async function executeExternalEnv({ targetDir, opts, conflictResolution = false, log = console.log }) {
  const ext = opts.external ?? {};
  // At least one external URL must be supplied to wire anything; an --infra=
  // external with no URLs simply skips bring-up (today's --no-infra behaviour).
  const provided = Object.entries({
    SUPABASE_DB_URL: ext.dbUrl,
    REDIS_URL: ext.redisUrl,
    NANGO_SERVER_URL: ext.nangoUrl,
    GRAPHITI_URL: ext.graphitiUrl,
  }).filter(([, v]) => v != null);

  // When external was chosen TO RESOLVE a live port conflict, the local stack
  // that holds the ports is UP. The DATABASE is the mutation target (setup +
  // migrations write to SUPABASE_DB_URL), so unless an explicit --db-url
  // re-points it OFF the localhost default, setup would migrate that CONFLICTING
  // local DB. Require --db-url SPECIFICALLY here — another external URL (e.g.
  // only --redis-url) does NOT move the DB off localhost and must NOT satisfy the
  // guard. (The no-conflict --no-infra path is unaffected — there the operator
  // owns their own .env.local; see the no-URL skip below.)
  if (conflictResolution && ext.dbUrl == null) {
    throw new Error(
      "Refusing --infra=external as a conflict resolution without --db-url: a local stack is holding the " +
        "ports, so proceeding would point setup + migrations at that CONFLICTING local database (the default " +
        "localhost SUPABASE_DB_URL). Pass --db-url to target a real external database (add --redis-url/--nango-url " +
        "as needed), or choose --on-conflict=isolated for a separate local stack.",
    );
  }

  if (provided.length === 0) {
    // No-conflict --no-infra / --infra=external with no URLs: skip bring-up only
    // (the operator owns their own .env.local). The conflict path is already
    // handled by the --db-url guard above, so this branch is the legacy case.
    log("- External infra (--infra=external): no --db-url/--redis-url/--nango-url/--graphiti-url given; " +
      "skipping infra bring-up only (ensure your external Postgres/Redis/Nango are reachable before setup).");
    return { wrote: [] };
  }

  // Shape-validate each provided URL.
  const validators = {
    SUPABASE_DB_URL: () => assertExternalUrl("--db-url", ext.dbUrl, ["postgres", "postgresql"]),
    REDIS_URL: () => assertExternalUrl("--redis-url", ext.redisUrl, ["redis", "rediss"]),
    NANGO_SERVER_URL: () => assertExternalUrl("--nango-url", ext.nangoUrl, ["http", "https"]),
    GRAPHITI_URL: () => assertExternalUrl("--graphiti-url", ext.graphitiUrl, ["http", "https"]),
  };
  const values = {};
  for (const [key] of provided) values[key] = validators[key]();

  // Guard against an exported env var silently overriding the generated value
  // (setup overlays process.env over .env.local — same precedent as
  // assertAmbientModeMatches). Refuse a contradicting export.
  for (const [key, want] of Object.entries(values)) {
    const ambient = process.env[key];
    if (typeof ambient === "string" && ambient.trim().length > 0 && ambient.trim() !== want) {
      throw new Error(
        `Exported ${key}=${ambient.trim()} would override the --${externalFlagFor(key)} value you passed ` +
          `(setup overlays the shell env over .env.local). Unset ${key} (or align it) and retry.`,
      );
    }
  }

  // A DB pointed at a non-empty / production database is destructive-leaning:
  // setup/migrations CAN mutate it. Require a NON-ROLLBACKABLE acknowledgement
  // (URL validation alone is insufficient). A bare --yes must NOT silently
  // authorise this (same class as --teardown-existing's `-v`): non-interactively
  // the operator must pass the explicit --external-db-disposable ack; on a TTY a
  // typed confirm is accepted. (`--yes` still pre-accepts the TTY prompt only
  // when the disposable ack is ALSO present.)
  if (values.SUPABASE_DB_URL) {
    let ok = false;
    if (opts.externalDbDisposable) {
      ok = true; // explicit acknowledgement the target is disposable.
    } else if (opts.yes) {
      // A bare --yes is NOT enough for a non-rollbackable external DB.
      throw new Error(
        `Refusing to point setup + migrations at an EXTERNAL database (${redactUrl(values.SUPABASE_DB_URL)}) ` +
          `on a bare --yes. These resources are NOT install-owned and are NEVER auto-rolled-back; setup may ` +
          `mutate a non-empty/production DB irreversibly. Re-run with --external-db-disposable to acknowledge ` +
          `the target is disposable (or run interactively to type the confirmation).`,
      );
    } else {
      ok = await typedConfirm(
        `⚠ --infra=external points setup + migrations at an EXTERNAL database (${redactUrl(values.SUPABASE_DB_URL)}).\n` +
          `  These resources are NOT install-owned and will NEVER be auto-rolled-back. If this DB is non-empty\n` +
          `  or production, setup may mutate it irreversibly.`,
        "I understand",
      );
    }
    if (!ok) {
      throw new Error(
        "Aborted: external DB not confirmed (type \"I understand\", or pass --external-db-disposable if the target is disposable).",
      );
    }
  }

  // Write into .env.local (preserve existing unrelated keys).
  const envPath = path.join(targetDir, ".env.local");
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const [key, val] of Object.entries(values)) {
    body = upsertEnvKey(body, key, val);
  }
  writeFileSync(envPath, body);
  log(`- External infra: wrote ${Object.keys(values).join(", ")} into .env.local (resources are operator-owned; not install-managed).`);
  return { wrote: Object.keys(values) };
}

function externalFlagFor(key) {
  return {
    SUPABASE_DB_URL: "db-url",
    REDIS_URL: "redis-url",
    NANGO_SERVER_URL: "nango-url",
    GRAPHITI_URL: "graphiti-url",
  }[key] ?? key;
}

/** Redact credentials from a URL for display (user:pass@host → user:***@host). */
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

/** Rewrite a connection-URL's host PORT to `newPort`, preserving scheme, auth,
 *  host, path (db name), and query. Falls back to a default `proto://127.0.0.1:
 *  port/` when there is no existing URL to preserve. */
function rewriteUrlPort(existing, newPort, fallbackProto, fallbackPath = "") {
  if (typeof existing === "string" && existing.length > 0) {
    try {
      const u = new URL(existing);
      u.port = String(newPort);
      return u.toString();
    } catch {
      /* fall through to a fresh URL */
    }
  }
  return `${fallbackProto}://127.0.0.1:${newPort}${fallbackPath}`;
}

/**
 * Write the host app env for an ISOLATED instance: its own PORT + Better-Auth
 * URLs (so `pnpm dev` binds the isolated app port, not 3000 — review hardening #3) AND
 * the infra connection URLs RE-POINTED at the remapped host ports (review hardening #1 —
 * otherwise setup connects to the DEFAULT/conflicting stack). The remapped host
 * ports come from the generated compose's per-service `ports` map. Existing URL
 * credentials / db-name are preserved; only the port is rewritten.
 */
function writeIsolatedAppEnv({ targetDir, appPort, ports = {}, log = console.log }) {
  const envPath = path.join(targetDir, ".env.local");
  if (!existsSync(envPath)) return;
  const baseUrl = `http://localhost:${appPort}`;
  let body = readFileSync(envPath, "utf8");
  body = upsertEnvKey(body, "PORT", String(appPort));
  body = upsertEnvKey(body, "BETTER_AUTH_URL", baseUrl);
  body = upsertEnvKey(body, "NEXT_PUBLIC_BETTER_AUTH_URL", baseUrl);

  // Read the current env values (to preserve credentials/db-name on rewrite).
  const cur = parseEnvBody(body);
  const first = (svc) => {
    const list = ports?.[svc];
    return Array.isArray(list) && list.length ? list[0] : null;
  };

  // Map the well-known infra services → their connection-URL env keys, re-pointed
  // at the remapped host ports. Only services actually present in the remapped
  // band are rewritten.
  const pgPort = first("postgres");
  if (pgPort) body = upsertEnvKey(body, "SUPABASE_DB_URL", rewriteUrlPort(cur.SUPABASE_DB_URL, pgPort, "postgresql", "/postgres"));
  const redisPort = first("redis");
  if (redisPort) body = upsertEnvKey(body, "REDIS_URL", rewriteUrlPort(cur.REDIS_URL, redisPort, "redis", ""));
  const nangoPort = first("nango-server");
  if (nangoPort) body = upsertEnvKey(body, "NANGO_SERVER_URL", rewriteUrlPort(cur.NANGO_SERVER_URL, nangoPort, "http", ""));
  // The Nango DB is a SEPARATE service (`nango-db`); setup reads NANGO_DATABASE_URL
  // (or NANGO_DB_URL) and otherwise falls back to the DEFAULT local Nango DB
  // (index.mjs getNangoDatabaseUrl) — so it MUST be re-pointed too (review hardening #2).
  const nangoDbPort = first("nango-db");
  if (nangoDbPort) {
    const nangoDbUrl = rewriteUrlPort(cur.NANGO_DATABASE_URL ?? cur.NANGO_DB_URL, nangoDbPort, "postgresql", "/nango");
    body = upsertEnvKey(body, "NANGO_DATABASE_URL", nangoDbUrl);
    if (cur.NANGO_DB_URL != null) body = upsertEnvKey(body, "NANGO_DB_URL", nangoDbUrl);
  }
  const graphitiPort = first("graphiti");
  if (graphitiPort) body = upsertEnvKey(body, "GRAPHITI_URL", rewriteUrlPort(cur.GRAPHITI_URL, graphitiPort, "http", ""));
  // cinatra-cli#97: the app reaches the per-instance WayFlow runtime via
  // WAYFLOW_BASE_URL (default http://localhost:3010). WayFlow is a compose
  // service in the isolated band, so its host port is shifted — re-point the URL
  // at the isolated WayFlow host port too, else the isolated app's WayFlow-backed
  // features drive the DEFAULT/main instance's WayFlow (partial-isolation leak).
  const wayflowPort = first("wayflow");
  if (wayflowPort) body = upsertEnvKey(body, "WAYFLOW_BASE_URL", rewriteUrlPort(cur.WAYFLOW_BASE_URL, wayflowPort, "http", ""));
  // cinatra-cli#36: the registry CLIENT (Verdaccio) is env-overridable via
  // CINATRA_AGENT_REGISTRY_URL / _UI_URL (default …:4873). Without re-pointing
  // them, an isolated install run beside a live donor publishes/installs into the
  // DONOR's Verdaccio. Re-point both at the isolated Verdaccio host port. The UI
  // port is the same published port (verdaccio serves both the registry + web UI).
  const verdaccioPort = first("verdaccio");
  if (verdaccioPort) {
    const registryUrl = `http://127.0.0.1:${verdaccioPort}`;
    body = upsertEnvKey(body, "CINATRA_AGENT_REGISTRY_URL", registryUrl);
    body = upsertEnvKey(body, "CINATRA_AGENT_REGISTRY_UI_URL", registryUrl);
  }
  // cinatra-cli#36: the Neo4j client URL (NEO4J_URI, default bolt://…:7687) is
  // not in the rewrite set, so an isolated instance's Neo4j client + the
  // post-install `check:services` probe reach the DONOR's Neo4j. neo4j publishes
  // 7474 (http UI) AND 7687 (bolt); the CLIENT speaks BOLT. Every neo4j port is
  // shifted by the SAME band offset, so bolt (7687+offset) is always the HIGHER
  // of the two — pick the max rather than relying on compose port order.
  const neo4jPorts = Array.isArray(ports?.neo4j) ? ports.neo4j.filter((n) => Number.isInteger(n) && n > 0) : [];
  const neo4jBoltPort = neo4jPorts.length ? Math.max(...neo4jPorts) : null;
  if (neo4jBoltPort) body = upsertEnvKey(body, "NEO4J_URI", rewriteUrlPort(cur.NEO4J_URI, neo4jBoltPort, "bolt", ""));

  writeFileSync(envPath, body, { mode: 0o600 });
  tightenEnvLocalPerms(envPath); // keep the secret-bearing env-file owner-only (cinatra-cli#57)
  const remapped = [
    pgPort && `db:${pgPort}`,
    redisPort && `redis:${redisPort}`,
    nangoPort && `nango:${nangoPort}`,
    nangoDbPort && `nango-db:${nangoDbPort}`,
    graphitiPort && `graphiti:${graphitiPort}`,
    wayflowPort && `wayflow:${wayflowPort}`,
    verdaccioPort && `verdaccio:${verdaccioPort}`,
    neo4jBoltPort && `neo4j:${neo4jBoltPort}`,
  ]
    .filter(Boolean)
    .join(" ");
  log(`  Isolated app port ${appPort}; infra URLs re-pointed (${remapped}) in .env.local.`);
}

/** Minimal `.env` body → { KEY: value } map (last wins; quotes stripped). Used
 *  only to PRESERVE existing credentials when re-pointing an isolated URL. */
function parseEnvBody(body) {
  const out = {};
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// ── cinatra-cli#39 — backfill a label/marker-proven instance row ────────────
/**
 * The classifier proved (via `ai.cinatra.*` labels or the per-checkout marker)
 * that a holder dir is a Cinatra instance the REGISTRY does not record. Write an
 * authoritative `ready` row for it so subsequent runs resolve it from the
 * registry (the issue's "backfill" requirement). Done in the EXECUTOR, never the
 * pure classifier, under the alloc lock the other registry writers use. Best-
 * effort + idempotent: a failure or insufficient proof returns the synthesized
 * instance unchanged so resolution still proceeds with label/marker metadata.
 *
 * @param {object} a.proven  the synthesized instance from classifyPortHolder.backfill
 * @param {object} a.opts    the parsed install opts (for repoUrl/ref provenance)
 * @returns {Promise<object>} the recorded row (registry-backed) or the `proven` input.
 */
async function backfillProvenInstance({ proven, opts = {}, log = console.log, deps = {} }) {
  if (!proven || typeof proven !== "object") return proven;
  const slug = proven.slug;
  // allocateInstance refuses an invalid slug or a row with no compose project/
  // files; a label-proven isolated stack always carries both (project from the
  // `ai.cinatra.project` label, files = the generated isolated compose). If
  // either is missing, skip the backfill but keep the synthesized metadata (the
  // menu can still NAME the holder; stop/attach use the recorded row only).
  const composeProject = proven.composeProject;
  const composeFiles =
    Array.isArray(proven.composeFiles) && proven.composeFiles.length
      ? proven.composeFiles
      : [ISOLATED_COMPOSE_FILENAME];
  if (!isValidSlug(slug) || typeof composeProject !== "string" || composeProject.length === 0) {
    log(
      `  ⚠ Recognized a label/marker-proven Cinatra instance at ${proven.installDir} but cannot backfill a ` +
        `registry row (insufficient proof: slug/project). It is still offered for stop/attach.`,
    );
    return proven;
  }
  // A marker records the install mode; a label-only proof has none → default dev.
  const mode = proven.proofSource === "marker" && VALID_MODES.has(proven.kind) ? proven.kind : "dev";
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  let recorded = proven;
  try {
    await withAllocLock(lockPath, async () => {
      const reg = requireUsableInstanceRegistry(registryPath);
      const existing = getInstance(reg, slug);
      if (existing) {
        // A row already exists for this slug — if it maps elsewhere, do not alias.
        if (path.resolve(existing.installDir) !== path.resolve(proven.installDir)) {
          log(
            `  ⚠ Cannot backfill "${slug}": the registry already maps it to ${existing.installDir} ` +
              `(not ${proven.installDir}). Offering the proven holder without a backfill.`,
          );
          return;
        }
        recorded = existing;
        return;
      }
      const { registry: allocated } = allocateInstance(reg, slug, {
        mode,
        installDir: proven.installDir,
        composeProject,
        composeFiles,
        ports: proven.ports ?? {},
        appPort: proven.appPort ?? null,
        // The label/marker proof carries no repo provenance; the registry slot
        // requires non-empty repoUrl/ref. Use the proof's own value when present
        // (a marker may record it later), else this install's opts (always set:
        // repoUrl defaults to DEFAULT_REPO_URL, ref to "main" in parseInstallArgs)
        // — a reasonable provenance for a sibling Cinatra checkout.
        repoUrl: proven.repoUrl ?? opts.repoUrl ?? DEFAULT_REPO_URL,
        ref: proven.ref ?? opts.ref ?? "main",
        sha: proven.sha ?? null,
        infraMode: "new",
        state: "provisioning",
      });
      const ready = markInstanceReady(allocated, slug);
      writeInstanceRegistry(registryPath, ready);
      recorded = getInstance(ready, slug) ?? proven;
      log(`- Backfilled an authoritative registry row for the proven Cinatra instance "${slug}" (was ${proven.proofSource}-only).`);
    });
  } catch (err) {
    log(`  ⚠ Could not backfill the proven instance "${slug}" (${err?.message ?? err}). Offering it without a backfill.`);
    return proven;
  }
  return recorded;
}

// ── conflict resolution orchestrator (classify → offer + execute) ───────────
/**
 * On a detected host-port conflict, CLASSIFY the holder then OFFER + EXECUTE an
 * isolation option (the literal issue title). Returns
 * `{ infraPlan, instance?, done }` where `infraPlan` ∈
 * {"default","isolated","external","attach","skip"}.
 *
 * Decision order:
 *   1. Idempotent re-run / self-instance (our own checkout owns the ports) →
 *      attach/converge (or --resume to reconcile a provisioning ghost).
 *   2. Explicit --on-conflict / --infra → execute that option.
 *   3. Interactive TTY, no explicit flag → the MINIMAL execute-menu
 *      {Isolated / Abort / Attach} (T8b) — EXECUTE the choice.
 *   4. Non-interactive, no explicit flag → abort with the classified message.
 * Destructive options (stop-existing/teardown) REFUSE an `unrelated`/`mixed`
 * holder. `--yes` never silently picks stop/teardown/share.
 */
async function resolveConflict({ targetDir, opts, conflicts, resolvedSha, log = console.log, deps = {} }) {
  const inspect = (deps.liveComposeInspect ?? liveComposeInspect)(targetDir, deps);
  const { instanceRegistry, cloneRegistry } = readBothRegistries(deps);
  const cls = classifyPortHolder({
    // Interface-aware: pass the full `{host, port}` bindings (review hardening #4).
    conflicts: conflicts.map((c) => ({ host: c.host, port: c.port })),
    inspectRows: inspect,
    instanceRegistry,
    cloneRegistry,
    installDir: targetDir,
    // cinatra-cli#39: let the classifier consult the per-checkout marker
    // (`.cinatra/instance.json`) of a holder dir as positive Cinatra proof when
    // no registry row + no `ai.cinatra.*` label is present.
    readMarker: deps.readMarker ?? readMarker,
  });

  // cinatra-cli#39: when a holder was proven a Cinatra instance ONLY via its
  // labels/marker (no registry row), BACKFILL an authoritative registry row in
  // the EXECUTOR (never the pure classifier) so subsequent runs resolve it from
  // the registry. Best-effort: a backfill failure must never block resolution.
  if (cls.kind === "other-cinatra" && cls.backfill) {
    const backfilled = await backfillProvenInstance({ proven: cls.backfill, opts, log, deps });
    if (backfilled) cls.instance = backfilled;
  }

  // 1. Our OWN checkout owns the ports → idempotent re-run / attach.
  if (cls.kind === "idempotent-rerun" || cls.kind === "self-instance") {
    log("- This checkout's own stack already holds these ports (idempotent re-run).");
    return executeAttach({ targetDir, opts, resolvedSha, classified: cls, log, deps });
  }

  // Resolve the requested option: --on-conflict wins; else --infra=external maps
  // to external; else null (decide by menu / abort).
  let choice = opts.onConflict;
  if (!choice && opts.infra === "external") choice = "external";

  // cinatra-cli#40: the menu offers co-use ONLY when the conflicting holder is a
  // single proven Cinatra instance (the donor) AND its checkout's app build
  // advertises per-instance cookie isolation. The donor dir is the holder's
  // recorded installDir; the capability probe reads its source (fail closed).
  const couseAvailable = (() => {
    const holderDir = cls.kind === "other-cinatra" && cls.instance?.installDir;
    if (!holderDir) return false;
    const probeCapability = deps.probeCookiePrefixSupport ?? probeDonorCookiePrefixSupport;
    try {
      return !!probeCapability(holderDir);
    } catch {
      return false;
    }
  })();

  // 2/3. No explicit choice.
  if (!choice) {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    if (!interactive) {
      // Non-interactive abort-by-default.
      throw new Error(
        formatPortConflictError(conflicts, { phase: "before bringing up infra", owner: cls.kind }) +
          `\n  (non-interactive: pass an explicit --on-conflict=… or --infra=external to proceed.)`,
      );
    }
    choice = await runExecuteMenu({ conflicts, classified: cls, opts, couseAvailable, log });
  }

  switch (choice) {
    case "isolated":
    case "prompt": {
      // "prompt" already resolved to a concrete choice via the menu when
      // interactive; reaching here with "prompt" means an explicit
      // --on-conflict=prompt — run the menu now.
      if (choice === "prompt") {
        const sub = await runExecuteMenu({ conflicts, classified: cls, opts, couseAvailable, log });
        return dispatchChoice({ choice: sub, targetDir, opts, conflicts, resolvedSha, classified: cls, log, deps });
      }
      return dispatchChoice({ choice: "isolated", targetDir, opts, conflicts, resolvedSha, classified: cls, log, deps });
    }
    default:
      return dispatchChoice({ choice, targetDir, opts, conflicts, resolvedSha, classified: cls, log, deps });
  }
}

/** Execute one concrete conflict-resolution choice. */
async function dispatchChoice({ choice, targetDir, opts, conflicts, resolvedSha, classified, log, deps }) {
  switch (choice) {
    case "isolated": {
      const inst = await executeIsolatedInstall({ targetDir, opts, resolvedSha, log, deps });
      if (inst.dryRun) {
        log("  [dry-run] isolated install planned; no infra brought up.");
        return { infraPlan: "skip", instance: inst, done: false, dryRun: true };
      }
      return { infraPlan: "isolated", instance: inst, done: true };
    }
    case "external":
      // env wiring + record handled in steps 5c/7b; here just signal the plan.
      return { infraPlan: "external", done: false };
    case "attach":
      return executeAttach({ targetDir, opts, resolvedSha, classified, log, deps });
    case "stop-existing":
      return executeStopExisting({ targetDir, opts, conflicts, classified, log, deps });
    case "co-use":
      // cinatra-cli#40: the menu offered co-use (capability proven). executeCoUse
      // owns the capability re-probe + DB/env/setup; it returns an infraPlan the
      // caller treats as terminal (no default bring-up).
      return executeCoUse({ targetDir, opts, resolvedSha, log, deps });
    case "fail":
    case "abort":
      throw new Error(formatPortConflictError(conflicts, { phase: "before bringing up infra", owner: classified.kind }));
    default:
      throw new Error(`Unsupported --on-conflict choice "${choice}".`);
  }
}

/** T8b — the interactive execute-menu. Returns the chosen action string. The
 *  options offered mirror the flag surface 1:1 (acceptance: each option is
 *  selectable interactively AND via flags): Isolated / Attach / Stop-existing /
 *  External / Co-use / Abort. Stop-existing is only OFFERED for a single proven
 *  `other-cinatra` holder (it refuses an unrelated/mixed holder at execution, so
 *  offering it elsewhere would be a dead option). Co-use is OFFERED only when the
 *  donor app build advertises per-instance cookie isolation (cinatra-cli#40
 *  `couseAvailable`); otherwise it is named as unavailable with the upstream
 *  pointer, never selectable. `--yes` does NOT silently pick a destructive
 *  option; it only pre-accepts the SAFE default (Isolated). */
async function runExecuteMenu({ conflicts, classified, opts, couseAvailable = false, log = console.log }) {
  const isSingleCinatra = classified.kind === "other-cinatra" && classified.instance;
  const owner = isSingleCinatra
    ? `another Cinatra instance${classified.instance?.slug ? ` ("${classified.instance.slug}")` : ""}`
    : classified.kind === "mixed"
      ? "a MIX of a Cinatra instance and an unrelated process"
      : "another process";
  log("");
  log(`Port conflict — these ports are held by ${owner}:`);
  for (const c of conflicts) {
    const where = c.host === "0.0.0.0" ? `port ${c.port}` : `${c.host}:${c.port}`;
    log(`  ✗ ${where}${c.service ? ` [${c.service}]` : ""}`);
  }
  log("");
  log("How would you like to proceed?");
  log("  [i] Isolated  — install a second FULL stack on its own remapped ports + app port (safe, recommended)");
  log("  [a] Attach    — converge on the existing checkout instead of a second stack");
  if (isSingleCinatra) {
    log(`  [s] Stop      — stop the existing instance "${classified.instance.slug}" first, then install on the default ports`);
  }
  log("  [e] External  — point this install at external Postgres/Redis/Nango (pass --db-url/--redis-url/… ; no local infra)");
  if (couseAvailable) {
    log("  [c] Co-use    — share the existing instance's infra (separate DB + queue; no second stack)");
  }
  log("  [x] Abort     — stop and let me free the ports myself");
  if (!couseAvailable) {
    log("  (Co-use / sharing one infra stack is unavailable: the app build does not isolate auth cookies per instance — use Isolated.)");
  }
  // --yes pre-accepts the SAFE default only (never a destructive Stop).
  if (opts.yes) {
    log("  (--yes: choosing Isolated, the safe default.)");
    return "isolated";
  }
  const hint =
    `[i/a/${isSingleCinatra ? "s/" : ""}e/${couseAvailable ? "c/" : ""}x]`;
  const answer = (await promptLine(`Choice ${hint}: `, "x")).trim().toLowerCase();
  if (answer === "i" || answer === "isolated") return "isolated";
  if (answer === "a" || answer === "attach") return "attach";
  if (isSingleCinatra && (answer === "s" || answer === "stop" || answer === "stop-existing")) return "stop-existing";
  if (answer === "e" || answer === "external") return "external";
  if (couseAvailable && (answer === "c" || answer === "co-use" || answer === "couse")) return "co-use";
  return "abort";
}

/** True iff a registry/marker row records an ISOLATED instance (its own
 *  generated compose file + remapped band), as opposed to a DEFAULT-stack row.
 *  cinatra-cli#35(e): the old `composeProject === "cinatra"` sentinel no longer
 *  discriminates — a DEFAULT row now also carries an explicit
 *  `cinatra_<slug>` project name. The robust signal is the SOLE generated
 *  isolated compose file (`docker-compose.cinatra-isolated.yml`); a default row
 *  records the base `docker-compose.yml`/`.dev.yml` pair. External rows are
 *  never isolated (no local stack). */
function isIsolatedRow(row) {
  if (!row || row.infraMode === "external") return false;
  const files = Array.isArray(row.composeFiles) ? row.composeFiles : [];
  return files.includes(ISOLATED_COMPOSE_FILENAME);
}

/** The `-p` Compose project value to use for a recorded row, or null to OMIT it
 *  (compose then derives the project from the dir basename — the LEGACY default
 *  behavior). cinatra-cli#35(e): a row recorded by the new code carries the
 *  EXPLICIT project the `up` used (default or isolated) → always pass it. An OLD
 *  row written before #35 records the literal `"cinatra"` sentinel even when
 *  compose actually used a different basename — for those we OMIT `-p` so down/
 *  attach fall back to the same basename derivation the old `up` used (never a
 *  wrong `-p cinatra` that targets nothing). */
function composeProjectArgForRow(row) {
  const proj = row?.composeProject;
  if (!proj || proj === "cinatra") return null;
  return proj;
}

/** Read the instance-registry row that records THIS checkout AS an ISOLATED
 *  instance (its own generated compose file + remapped band). Returns the row or
 *  null. Best-effort (a malformed/missing registry → null). */
function lookupOwnIsolatedRow(targetDir) {
  try {
    const reg = requireUsableInstanceRegistry(defaultInstanceRegistryPath());
    const row = listInstances(reg).find((i) => path.resolve(i.installDir) === path.resolve(targetDir)) ?? null;
    if (isIsolatedRow(row)) {
      return row;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/** Re-converge on a checkout's OWN recorded isolated stack: bring it up via the
 *  RECORDED compose files + project, re-point the env at its remapped ports, and
 *  return an "isolated" plan so the later steps treat it as isolated. */
async function reconvergeIsolated({ targetDir, opts, resolvedSha, row, log = console.log, deps = {} }) {
  const startInfra = deps.bringUpInfra ?? bringUpInfra;
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  if (opts.dryRun) {
    log(`  [dry-run] would bring up isolated project ${row.composeProject} from ${(row.composeFiles ?? []).join(", ")}`);
    return { infraPlan: "isolated", instance: row, done: false, dryRun: true };
  }
  // Re-point the env at the recorded remapped ports + bring up WITH
  // `--env-file .env.local` so the generated isolated compose's scrubbed
  // `${VAR}` placeholders resolve from the file (never blank/shell defaults) —
  // mirrors the primary isolated `up`. Without this an idempotent re-converge of
  // a stopped isolated stack would start with empty secrets/wrong URLs.
  ensureIsolatedEnv({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, appPort: row.appPort, ports: row.ports ?? {}, log });
  const reconvEnvFile = path.join(targetDir, ".env.local");
  startInfra({
    targetDir,
    log,
    composeFiles: row.composeFiles,
    composeProject: row.composeProject,
    envFile: existsSync(reconvEnvFile) ? reconvEnvFile : null,
    nangoHealthUrl: nangoHealthUrlForPorts(row.ports),
  });
  // Promote a stale provisioning row to ready after a successful ensure.
  if (row.state !== "ready") {
    await withAllocLock(lockPath, async () => {
      const reg = requireUsableInstanceRegistry(registryPath);
      if (getInstance(reg, row.slug)) {
        writeInstanceRegistry(registryPath, markInstanceReady(reg, row.slug, { sha: resolvedSha }));
      }
    });
  }
  return { infraPlan: "isolated", instance: row, done: true };
}

/** T12 — attach / resume: converge on THIS checkout's OWN existing instance.
 *  Attach is for the SELF case (our own checkout already has a stack) — it is
 *  NOT a way to graft a fresh checkout onto a DIFFERENT instance's stack. So:
 *    - holder is a DIFFERENT recorded Cinatra instance (other-cinatra) AND this
 *      checkout has NO row of its own → REFUSE with guidance (review hardening #2: don't
 *      pretend to attach to a stack we don't own; use isolated/stop-existing).
 *    - this checkout HAS its own row → ensure ITS recorded stack is up, and only
 *      promote provisioning→ready when the bring-up SUCCEEDED (never on failure).
 *    - --resume reconciles a stale provisioning row of THIS checkout. */
async function executeAttach({ targetDir, opts, resolvedSha, classified, log = console.log, deps = {} }) {
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const startInfra = deps.bringUpInfra ?? bringUpInfra;

  // Determine the instance row THIS checkout maps to (registry = authority).
  let row = null;
  let reg = null;
  try {
    reg = requireUsableInstanceRegistry(registryPath);
    row = listInstances(reg).find((i) => path.resolve(i.installDir) === path.resolve(targetDir)) ?? null;
  } catch {
    reg = null;
  }

  // A DIFFERENT instance holds the ports and this checkout is not it → refuse.
  if (!row && classified?.kind === "other-cinatra" && classified.instance) {
    throw new Error(
      `Refusing --on-conflict=attach: the conflicting ports belong to a DIFFERENT instance ` +
        `"${classified.instance.slug}" at ${classified.instance.installDir}, not this checkout (${targetDir}). ` +
        `Attach only converges on YOUR OWN existing checkout. Re-run inside ${classified.instance.installDir} to ` +
        `update that instance, use --on-conflict=isolated for a separate stack here, or --on-conflict=stop-existing.`,
    );
  }

  if (opts.resume && row && row.state === "provisioning") {
    log(`- --resume: reconciling the stale provisioning row for "${row.slug}".`);
  }

  // Bring THIS checkout's recorded stack up idempotently (owned-port exemption
  // applies). Use the RECORDED compose files/project when known, else the base.
  let broughtUp = false;
  if (!opts.dryRun) {
    const composeFiles = row?.composeFiles ?? null;
    // cinatra-cli#35(e): pass the recorded explicit `-p` (default OR isolated);
    // OMIT only for a pre-#35 legacy "cinatra" sentinel row (basename fallback).
    const composeProject = composeProjectArgForRow(row);
    // When attaching to an ISOLATED instance (its own generated compose file),
    // the recorded compose's secrets are scrubbed to `${VAR}`; re-point the env
    // at the recorded remapped ports and bring up WITH `--env-file .env.local` so
    // those placeholders resolve (parity with the primary isolated `up`). A
    // DEFAULT-stack attach keeps compose's normal `.env` discovery (no env-file),
    // byte-identical to before — discriminated by the generated isolated compose
    // file, NOT by the project name (a default row now also has an explicit one).
    const attachingIsolated = isIsolatedRow(row);
    let attachEnvFile = null;
    if (attachingIsolated) {
      ensureIsolatedEnv({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, appPort: row.appPort, ports: row.ports ?? {}, log });
      const envCandidate = path.join(targetDir, ".env.local");
      attachEnvFile = existsSync(envCandidate) ? envCandidate : null;
    }
    try {
      log("- Ensuring this checkout's own infra is up (attach)…");
      startInfra({ targetDir, log, composeFiles, composeProject, envFile: attachEnvFile, nangoHealthUrl: nangoHealthUrlForPorts(row?.ports) });
      broughtUp = true;
    } catch (err) {
      log(`  ⚠ Attach bring-up reported: ${err.message}`);
      // Re-throw a hard failure so we never proceed (or promote) on a broken stack.
      throw err;
    }
    // Promote a provisioning row to ready ONLY after a SUCCESSFUL ensure.
    if (broughtUp && reg && row && row.state !== "ready") {
      await withAllocLock(lockPath, async () => {
        const fresh = requireUsableInstanceRegistry(registryPath);
        if (getInstance(fresh, row.slug)) {
          writeInstanceRegistry(registryPath, markInstanceReady(fresh, row.slug, { sha: resolvedSha }));
        }
      });
    }
  }

  return { infraPlan: "attach", instance: row ?? undefined, done: true };
}

/** T11 — stop-existing: tear down the RECORDED PROJECT of the holder, then
 *  install on the default ports. `--teardown-existing` adds `-v` behind a
 *  SEPARATE typed confirm. REFUSES an `unrelated`/`mixed` holder. After a
 *  successful down, RELEASES the torn-down instance's row + marker + alloc band
 *  reservation transactionally (review hardening #6 / §C.8). */
async function executeStopExisting({ targetDir, opts, conflicts, classified, log = console.log, deps = {} }) {
  if (classified.kind !== "other-cinatra") {
    throw new Error(
      `Refusing --on-conflict=stop-existing: the conflicting ports are NOT proven to be a single Cinatra ` +
        `instance (classified "${classified.kind}"). Stopping an unrelated/ambiguous holder could take down ` +
        `the wrong process. Stop it yourself, or use --on-conflict=isolated.`,
    );
  }
  const holder = classified.instance;
  const registryPath = deps.instanceRegistryPath ?? defaultInstanceRegistryPath();
  const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
  const runCompose = deps.runComposeDown ?? composeDown;

  const withVolumes = opts.teardownExisting;
  // Loud notice (review hardening #5): a no-`-v` down preserves the named
  // volumes, and the new default install will REUSE that data. `-v` wipes it.
  if (withVolumes) {
    const ok = await typedConfirm(
      `⚠ --teardown-existing will DELETE instance "${holder.slug}"'s data volumes (project ${holder.composeProject}).\n` +
        `  This is IRREVERSIBLE.`,
      `delete ${holder.slug}`,
    );
    if (!ok) {
      throw new Error(`Aborted: volume teardown of "${holder.slug}" not confirmed (type "delete ${holder.slug}").`);
    }
  } else {
    log(
      `- Stopping existing instance "${holder.slug}" (project ${holder.composeProject}) WITHOUT removing volumes.\n` +
        `  Its named volumes (data) are PRESERVED — the new default install will REUSE that existing data.\n` +
        `  Pass --teardown-existing for a clean slate (deletes the volumes; requires a typed confirm).`,
    );
  }

  if (opts.dryRun) {
    log(`  [dry-run] would \`docker compose -p ${holder.composeProject} -f ${(holder.composeFiles ?? []).join(" -f ")} down${withVolumes ? " -v" : ""}\``);
    return { infraPlan: "skip", done: false, dryRun: true };
  }

  // Tear down the RECORDED project + files (never a bare dir `down`).
  // cinatra-cli#35(e): use the recorded EXPLICIT `-p` (default OR isolated); a
  // pre-#35 legacy "cinatra" sentinel row falls back to basename derivation.
  runCompose(holder.installDir, {
    composeFiles: holder.composeFiles,
    composeProject: composeProjectArgForRow(holder),
    volumes: withVolumes,
  });

  // Transactional release of the torn-down instance's row + marker + band.
  await withAllocLock(lockPath, async () => {
    let reg;
    try {
      reg = requireUsableInstanceRegistry(registryPath);
    } catch {
      reg = null;
    }
    // cinatra-cli#39 (codex #1): release the slug's row ONLY when it still maps
    // to the dir we actually tore down. A label/marker-proven holder whose slug
    // COLLIDES with an unrelated registry row (backfill skipped, see
    // backfillProvenInstance) must NOT cause us to delete that unrelated row —
    // we tore down `holder.installDir`, so we may only release a row pointing
    // there. (For a normal registry-backed holder the dirs match, so this is a
    // no-op tightening.)
    const existing = reg ? getInstance(reg, holder.slug) : null;
    if (existing && path.resolve(existing.installDir) === path.resolve(holder.installDir)) {
      const { registry: next } = releaseInstance(reg, holder.slug);
      writeInstanceRegistry(registryPath, next);
    }
  });
  try {
    const markerFile = path.join(holder.installDir, ".cinatra", "instance.json");
    if (existsSync(markerFile)) spawnSync("rm", ["-f", markerFile]);
  } catch {
    /* best-effort */
  }
  log(`  Stopped "${holder.slug}". Installing on the default ports.`);

  // Proceed with a DEFAULT install on the now-free default band.
  return { infraPlan: "default", done: false };
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

export async function runInstall(argv = [], { log = console.log, deps = {} } = {}) {
  const opts = parseInstallArgs(argv);

  // cinatra-cli#40: co-use (shared-infra) signals route to the executeCoUse path
  // (no longer a flat refusal). The HARD safety gate — the donor app must isolate
  // auth cookies per instance — is enforced by a CHEAP pre-clone capability probe
  // here (fail closed before any side effect) AND again inside executeCoUse. The
  // pre-clone probe reads the DONOR checkout's source, so a co-use request against
  // an app build without cookie-prefix support still fails fast + cheap (no clone),
  // exactly like the old refusal did.
  if (opts.couseRequested && deps.skipCoUsePreGate !== true) {
    const probeCapability = deps.probeCookiePrefixSupport ?? probeDonorCookiePrefixSupport;
    const readDonor = deps.readDonorEnv ?? readDonorEnv;
    const preTargetDir = path.resolve(opts.dir ?? path.resolve(process.cwd(), DEFAULT_INSTALL_DIRNAME));
    const donorDir = resolveDonorDir(opts, preTargetDir);
    const donorEnv = readDonor(donorDir);
    assertCoUsePrereqs({
      cookiePrefixSupported: !!probeCapability(donorDir),
      graphitiShared: typeof donorEnv.GRAPHITI_URL === "string" && donorEnv.GRAPHITI_URL.length > 0,
      allowSharedGraphiti: opts.allowSharedGraphiti === true,
    });
  }

  // T6 — read-only --status / --list-instances short-circuit (no side effects).
  if (opts.status || opts.listInstances) {
    const dirForStatus = opts.dir ? path.resolve(opts.dir) : null;
    printInstanceStatus({ targetDir: dirForStatus, listAll: opts.listInstances && !opts.status, log, deps });
    return { status: true };
  }

  // Injectable seams (default to the real implementations — production behavior
  // is byte-identical when `deps` is empty). These let the integration tests
  // exercise the REAL runInstall sequencing (pre-clone gate → clone → post-clone
  // gate → infra) without a live Docker daemon, instead of the old `--no-infra`
  // path that skips BOTH gates (cinatra-cli#3, finding #3).
  const probePorts = deps.detectPortConflicts ?? detectPortConflicts;
  const dockerPresent = deps.commandExists ?? ((c, a) => commandExists(c, a));
  const composeOk = deps.composeAvailable ?? composeAvailable;
  const deriveBand = deps.composePublishedPortsForTarget ?? composePublishedPortsForTarget;
  const deriveOwnedPorts = deps.targetComposeOwnedPorts ?? targetComposeOwnedPorts;
  const startInfra = deps.bringUpInfra ?? bringUpInfra;
  const preflight = deps.runPreflight ?? runPreflight;

  // 1. Resolve the target dir (prompt on a TTY when not given).
  let targetDir = opts.dir;
  if (!targetDir) {
    const def = path.resolve(process.cwd(), DEFAULT_INSTALL_DIRNAME);
    const answer = await promptLine(
      `Where should Cinatra be installed? [${def}]: `,
      def,
    );
    targetDir = answer;
  }
  targetDir = path.resolve(targetDir);

  // 2. PREFLIGHT FIRST — before any download. Fail fast with the full list.
  log("Checking requirements…");
  const pre = preflight({ mode: opts.mode, targetDir, noInfra: opts.noInfra, dryRun: opts.dryRun });
  for (const w of pre.warnings) log(`  ⚠ ${w}`);
  if (!pre.ok) {
    const lines = pre.failures.map((f) => `  ✗ ${f}`).join("\n");
    throw new Error(`Requirements check failed:\n${lines}`);
  }
  log("  Requirements OK.");

  // Refuse an exported runtime-mode that contradicts --mode BEFORE any download
  // (setup would otherwise overlay it over .env.local and mis-mode the install).
  assertAmbientModeMatches(opts.mode);

  // 3. Resolve install location state + idempotent/dirty/force semantics.
  const targetExists = existsSync(targetDir);
  const alreadyCheckout = targetExists && isCinatraCheckout(targetDir);

  // 3a. Read-only target-exists guard (no filesystem writes) — runs BEFORE the
  //     throwing port-conflict preflight + the dry-run short-circuit so a
  //     non-empty foreign target still fails fast, and a --dry-run still
  //     surfaces the same blocker as a plan rather than performing a clone.
  if (targetExists && !isEmptyDir(targetDir) && !alreadyCheckout && !opts.force) {
    throw new Error(
      `Target ${targetDir} already exists and is not a cinatra checkout (and is not empty). ` +
        `Choose another --dir, or pass --force only if you are certain (it will clone INTO it).`,
    );
  }

  // 3b. --dry-run short-circuit (cinatra-cli#37): a "preview" flag must perform
  //     NO clone / write / infra / setup AND must NEVER throw on a detected
  //     conflict — it PREVIEWS it. Run this BEFORE the throwing pre-clone
  //     port-conflict guard below (which would otherwise abort a default-band
  //     dry-run before the preview is ever printed) and after the read-only
  //     dir/ref resolution + the target-exists check above. The conflict probe
  //     here is the SAME read-only port probe (detectPortConflicts on the
  //     static default band); it reports — never aborts. The isolated/conflict
  //     branches keep their own dry-run prints (they are only reached AFTER the
  //     clone, which dry-run never performs, so this is the single early-out for
  //     every default run). Writability was validated read-only in preflight
  //     (no temp probe file under --dry-run); nothing here touches disk.
  if (opts.dryRun) {
    const cap = deps.capture ?? capture;
    // Resolve the ref → sha WITHOUT cloning: `git ls-remote <repo> <ref>` is a
    // read-only network query (no checkout, no disk write). Best-effort: if it
    // can't resolve (offline / bad ref), report it as "<resolved at clone>".
    let resolvedSha = "<resolved at clone>";
    const lsRemote = cap("git", ["ls-remote", opts.repoUrl, opts.ref], { env: gitEnv() });
    if (lsRemote) {
      const sha = lsRemote.split(/\s+/)[0];
      if (/^[0-9a-f]{7,40}$/.test(sha)) resolvedSha = sha;
    }

    // The computed default project / instance name (mirrors recordDefaultInstance).
    const defaultSlug = opts.instance ?? deriveInstanceSlug(targetDir);
    // cinatra-cli#35: the EXPLICIT instance-scoped Compose project name the
    // default `up` would pass as `-p` (no longer the dir basename).
    const defaultComposeProject = computeDefaultProject(opts, targetDir);

    // Conflict classification on the default band — PORTS PROBED READ-ONLY only.
    // (The AUTHORITATIVE post-clone band comes from the checkout's own compose
    // config, which dry-run never has; the static default band is the best
    // read-only signal.) Under --dry-run a conflict is REPORTED, never thrown.
    let conflicts = [];
    if (pre.infraWillStart && !opts.noInfra) {
      conflicts = await probePorts(DEFAULT_DEV_HOST_PORTS);
    }
    const infraPlanIntent = opts.noInfra
      ? "external"
      : conflicts.length > 0
        ? `default (port conflict detected on ${conflicts.map((c) => c.port).join(", ")} — would prompt/resolve)`
        : "default";

    log("");
    log("✓ Dry run — no changes made (no clone, env, infra, or setup).");
    log("  Plan:");
    log(`    Directory:     ${targetDir}${alreadyCheckout ? " (existing cinatra checkout)" : ""}`);
    log(`    Ref / commit:  ${opts.ref} (${resolvedSha})`);
    log(`    Repo URL:      ${opts.repoUrl}`);
    log(`    Mode:          ${opts.mode}`);
    log(`    Infra plan:    ${infraPlanIntent}`);
    log(`    Project name:  ${isValidSlug(defaultSlug) ? defaultSlug : "(unnamed — would not record)"}`);
    log(`    Compose -p:    ${defaultComposeProject} (explicit; ownership preflight runs at install)`);
    log(`    App port:      ${DEFAULT_APP_PORT_FOR_RECORD}`);
    if (conflicts.length > 0) {
      for (const c of conflicts) {
        log(`    conflict:      port ${c.port} held — install would prompt for resolution (suggest --on-conflict=isolated).`);
      }
      log(`    Conflicts:     ${conflicts.length} default-band port(s) in use — install would classify the holder and offer a resolution.`);
    } else {
      log("    Conflicts:     none detected on the default band (read-only probe).");
    }
    log("  Writability:   validated read-only (no temp probe written).");
    log("  Would write:   the checkout, .env.local (fresh secret), then run infra/install/setup per the plan above.");
    log("  Re-run without --dry-run to perform the install.");

    return {
      dryRun: true,
      targetDir,
      ref: opts.ref,
      sha: resolvedSha,
      mode: opts.mode,
      instance: isValidSlug(defaultSlug) ? defaultSlug : null,
      infraPlan: opts.noInfra ? "external" : "default",
      appPort: DEFAULT_APP_PORT_FOR_RECORD,
      conflicts: conflicts.map((c) => c.port),
    };
  }

  // 3c. PRE-CLONE host-port guard (cinatra-cli#3): for a FRESH install of the
  //     DEFAULT repo at the DEFAULT ref that WILL bring up the dev stack, probe
  //     the known static default band BEFORE the `git clone` + `.env.local`
  //     side-effects, so an obvious port collision (e.g. another stack already
  //     holds 4873) aborts cheaply with an accurate message — not a half-
  //     provisioned target + a misleading "is the Docker daemon running?".
  //     Gated to the default repo+ref because the static band only describes the
  //     mainline checkout: a custom --repo-url/--ref fork may publish a different
  //     band, and an unrelated process on an OLD default port must NOT false-fail
  //     it. For those, we skip here and rely on the AUTHORITATIVE post-clone gate
  //     that re-derives the real band from the checkout's own compose config.
  //     Also skipped for a re-run on an existing checkout (its own stack may own
  //     the ports — the post-clone gate applies the project-up exemption).
  const usesDefaultBand =
    opts.repoUrl === DEFAULT_REPO_URL && opts.ref === "main";
  // cinatra-cli#17: the pre-clone abort is a fast early-out for the COMMON
  // case (no isolation requested, non-interactive). When the operator has opted
  // into a conflict-resolution path (an explicit --on-conflict/--infra, an
  // isolation flag, or an interactive TTY where the execute-menu can offer
  // options), DON'T hard-abort here — let the post-clone classifier offer +
  // execute the chosen option (the clone is needed to resolve the real band).
  const wantsConflictResolution =
    opts.onConflict != null ||
    opts.infra != null ||
    opts.instance != null ||
    opts.portOffset != null ||
    opts.appPort != null ||
    opts.resume ||
    (process.stdin.isTTY && process.stdout.isTTY);
  if (pre.infraWillStart && !alreadyCheckout && usesDefaultBand && !wantsConflictResolution) {
    const conflicts = await probePorts(DEFAULT_DEV_HOST_PORTS);
    if (conflicts.length > 0) {
      throw new Error(formatPortConflictError(conflicts, { phase: "preflight, before clone" }));
    }
  }

  // 4. Clone or update the host repo at --ref; record the resolved SHA.
  const resolvedSha = await cloneOrUpdateHost({
    targetDir,
    repoUrl: opts.repoUrl,
    ref: opts.ref,
    alreadyCheckout,
    force: opts.force,
    yes: opts.yes,
    log,
  });

  // Re-verify we now have a real checkout before touching its package.json.
  if (!isCinatraCheckout(targetDir)) {
    throw new Error(
      `After cloning, ${targetDir} is not a valid cinatra checkout ` +
        `(missing pnpm-workspace.yaml or packages/migrations/package.json). The --ref "${opts.ref}" may be invalid.`,
    );
  }
  log(`✓ Cinatra checked out at ${targetDir} @ ${resolvedSha} (ref: ${opts.ref}).`);

  // Locally git-ignore the per-checkout marker dir + the generated isolated
  // compose so neither dirties the working tree (keeps idempotent re-runs clean;
  // needs no change to the cinatra repo). cinatra-cli#17.
  ensureMarkerIgnored(targetDir);

  // cinatra-cli#40 — co-use (shared-infra): this checkout runs against a DONOR
  // instance's already-running infra (no second Docker stack), with its OWN app
  // port + a SEPARATE `cinatra_inst_<slug>` database. executeCoUse owns the whole
  // tail (capability re-probe, DB create, env write, setup --no-infra, record),
  // so route here and return — bypassing the default/conflict/infra machinery.
  if (opts.couseRequested) {
    // executeCoUse owns the WHOLE tail — companion dev-extensions clone, deps
    // install, capability re-probe, DB create, env write, setup --no-infra, and
    // record. The ONLY thing co-use skips vs a normal install is the second infra
    // stack. (The interactive menu pick routes through the same executeCoUse so
    // both entry points install deps before setup.)
    const couse = await executeCoUse({ targetDir, opts, resolvedSha, log, deps });
    log("");
    if (couse.dryRun) {
      log("✓ Co-use dry run — no changes made.");
    } else {
      log("✓ Cinatra co-use install complete.");
      log(`  Directory:     ${targetDir}`);
      log(`  Ref / commit:  ${opts.ref} (${resolvedSha})`);
      log(`  Mode:          ${opts.mode}`);
      log(`  Instance:      ${couse.instance?.slug} (co-use — shares the donor's infra; separate DB ${couse.instance?.dbName ?? coUseDbName(deriveCoUseSlug(targetDir, opts))})`);
      log("");
      log("  Next:");
      log(`    cd ${targetDir}`);
      log(`    pnpm dev        # start this co-use instance at http://localhost:${couse.instance?.appPort}`);
    }
    return {
      targetDir,
      ref: opts.ref,
      sha: resolvedSha,
      mode: opts.mode,
      instance: couse.instance?.slug ?? null,
      infraPlan: "co-use",
      appPort: couse.instance?.appPort ?? null,
      dryRun: couse.dryRun === true,
    };
  }

  let infraPlan = opts.noInfra ? "external" : "default";
  let resolution = null;

  // 4a-bis. RE-RUN of an already-recorded ISOLATED instance (review hardening #6): if
  //     the registry records THIS checkout as an isolated instance (its own
  //     compose project, not the default), a plain re-run must converge on its
  //     OWN remapped stack — NOT probe + start the default band (which would
  //     spin up a second, default-port stack from an isolated checkout). Detect
  //     it up front and route to the isolated re-converge path. Skipped under
  //     --infra=external and when --on-conflict/--infra explicitly overrides.
  if (!opts.noInfra && !opts.onConflict && opts.infra == null) {
    const ownIso = lookupOwnIsolatedRow(targetDir);
    if (ownIso) {
      log(`- This checkout is the recorded isolated instance "${ownIso.slug}" (project ${ownIso.composeProject}) — converging on its own stack.`);
      resolution = await reconvergeIsolated({ targetDir, opts, resolvedSha, row: ownIso, log, deps });
      infraPlan = resolution.infraPlan;
    }
  }

  // 4b. AUTHORITATIVE host-port gate (cinatra-cli#3): re-derive the published
  //     band from THIS checkout's own `docker compose config` and probe it,
  //     BEFORE writing .env.local / bringing infra up. On a conflict, cinatra-
  //     cli#17 CLASSIFIES the holder and OFFERS + EXECUTES an isolation option
  //     instead of always aborting. `infraPlan` records which infra path the
  //     later steps take: "default" (bring up the base stack), "isolated"
  //     (already handled here — bring up a remapped second stack), "external"
  //     (skip bring-up), "attach" (converge on the existing checkout), or
  //     "skip" (infra already satisfied / nothing to do).
  //     Skipped entirely under --infra=external (nothing local to bring up),
  //     and when an isolated re-converge already set the plan above.
  if (infraPlan === "default" && !opts.noInfra && dockerPresent("docker", ["--version"]) && composeOk()) {
    // Try to derive the AUTHORITATIVE band from the checkout's own compose config.
    // `null` ⇒ `docker compose config` could not be captured/parsed (the check
    // CANNOT run authoritatively). Do NOT silently fall back to the static band:
    // emit a PROMINENT degraded-mode warning so the operator knows the
    // authoritative port check did not run — fail LOUD, not silent
    // (cinatra-cli#3, finding #1). The static band is then probed only as a
    // best-effort backstop; `docker compose up` remains the final bind-conflict
    // authority (it now surfaces the real "port is already allocated" stderr).
    const authoritativeBand = deriveBand(targetDir);
    if (authoritativeBand === null) {
      emitDegradedBandWarning({ usesDefaultBand, ref: opts.ref, repoUrl: opts.repoUrl, log });
    }
    const band = authoritativeBand ?? DEFAULT_DEV_HOST_PORTS;
    if (band.length > 0) {
      // Exempt only the ports THIS target's own running compose services already
      // publish (idempotent re-run) — a stranger holding a not-yet-up service's
      // port is still a real conflict (hardening requirement: no blanket project-up skip).
      const ownedPorts = deriveOwnedPorts(targetDir);
      const conflicts = await probePorts(band, { ownedPorts });
      if (conflicts.length > 0) {
        // cinatra-cli#17: classify the holder, then offer + execute an option.
        resolution = await resolveConflict({
          targetDir,
          opts,
          conflicts,
          resolvedSha,
          log,
          deps,
        });
        infraPlan = resolution.infraPlan;
      }
    }
  }

  // cinatra-cli#40: the interactive menu can pick co-use (capability proven).
  // executeCoUse already owns the WHOLE tail (DB create, env write, setup
  // --no-infra, record) — so it is TERMINAL: return here, never falling through
  // to the default env/infra/install/setup steps (which would double-run setup).
  if (infraPlan === "co-use") {
    log("");
    log("✓ Cinatra co-use install complete.");
    log(`  Directory:     ${targetDir}`);
    log(`  Instance:      ${resolution?.instance?.slug} (co-use — shares the donor's infra)`);
    log(`    cd ${targetDir} && pnpm dev   # http://localhost:${resolution?.instance?.appPort}`);
    return {
      targetDir,
      ref: opts.ref,
      sha: resolvedSha,
      mode: opts.mode,
      instance: resolution?.instance?.slug ?? null,
      infraPlan: "co-use",
      appPort: resolution?.instance?.appPort ?? null,
    };
  }

  // 5. Create/reconcile the env (BEFORE infra so a mode mismatch fails fast).
  log("- Configuring environment…");
  ensureEnvLocal({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, log });

  // 5b. For an ISOLATED instance, point the HOST app at its own port + URLs
  //     (review hardening #3: compose isolation only covers INFRA ports; the
  //     app uses PORT/BETTER_AUTH_URL/NEXT_PUBLIC_BETTER_AUTH_URL — mirror what
  //     `branch setup`/clone write, else `pnpm dev` still collides on 3000).
  if (infraPlan === "isolated" && resolution?.instance?.appPort) {
    writeIsolatedAppEnv({
      targetDir,
      appPort: resolution.instance.appPort,
      ports: resolution.instance.ports ?? {},
      log,
    });
  }

  // 5c. EXTERNAL infra (T13): wire the operator-supplied URLs into .env.local
  //     (sanitized-env guarded) and record the instance as `external`.
  //     `conflictResolution` is true when external was chosen TO RESOLVE a live
  //     port conflict (a real local stack is holding the ports): in that case
  //     proceeding with NO external URLs would silently leave setup pointed at
  //     the CONFLICTING local DB and migrate it — so executeExternalEnv aborts
  //     unless a --db-url is supplied (review hardening: conflict-external must
  //     not fall back to the occupied local DB).
  if (infraPlan === "external") {
    const conflictResolution = resolution != null && resolution.infraPlan === "external";
    await executeExternalEnv({ targetDir, opts, conflictResolution, log });
  }

  // 5d + 6. cinatra-cli#35 — resolve the EXPLICIT default Compose project name +
  //     OWNERSHIP PREFLIGHT, THEN bring the default stack up — all UNDER ONE
  //     HELD ALLOC LOCK. Historically the default `up` passed no `-p`, so Docker
  //     derived the project from the dir BASENAME — two checkouts named `cinatra`
  //     shared one project + its named volumes (a hijack/recreate + cross-`down
  //     -v` data-loss). We now compute an explicit instance-scoped `-p`, ADOPT a
  //     legacy basename stack already rooted here (so volumes stay stable), and
  //     REFUSE when the candidate project / its named volumes already belong to a
  //     DIFFERENT checkout (independent of held ports — this catches the
  //     STOPPED-sibling blind spot the port preflight misses).
  //     The lock is HELD ACROSS the bring-up (codex blocker #1): releasing it
  //     after the preflight but before `up` would let two same-name installs both
  //     see "no project", release, and race into the SAME `-p` — re-introducing
  //     the very hijack this fix prevents. Holding it through `up` serialises
  //     them, so the second observes the first's now-existing project and refuses.
  let defaultProject = null;
  if (infraPlan === "default") {
    const lockPath = deps.allocLockPath ?? defaultAllocLockPath();
    defaultProject = await withAllocLock(lockPath, async () => {
      const resolved = resolveDefaultProject({ targetDir, opts, log, deps });
      startInfra({ targetDir, log, composeProject: resolved });
      return resolved;
    });
  }

  // 6. Log the non-default infra plans (the default bring-up already ran above
  //    under the held lock).
  //    - "isolated"/"attach": already provisioned during conflict resolution.
  //    - "external": no local infra to start.
  if (infraPlan === "external") {
    log("- Skipping local infrastructure startup (external infra). Ensure Postgres/Redis/Nango are reachable before setup.");
  } else if (infraPlan === "isolated") {
    log(`- Isolated instance "${resolution?.instance?.slug}" infra is up (project ${resolution?.instance?.composeProject}).`);
  } else if (infraPlan === "attach") {
    log("- Attached to the existing instance's infra (no second stack started).");
  }

  // 7. Clone ONLY the declared companion repos, THEN install, THEN setup.
  //    Ordering mirrors scripts/setup.sh: the root declares `workspace:*` deps
  //    on the extension packages, so the extensions must be on disk before the
  //    first `pnpm install` resolves the workspace.
  const usePnpmDirect = !commandExists("corepack", ["--version"]) && commandExists("pnpm", ["--version"]);

  if (opts.mode === "dev") {
    log("- Cloning declared companion extension repos (cinatra.devExtensions)…");
    const extResult = await syncCinatraDevExtensions({
      repoRoot: targetDir,
      targetRoot: targetDir,
      argv: [],
      env: process.env,
      log,
    });
    if (extResult?.skipped) {
      log(`  Dev extensions: skipped (${extResult.reason}).`);
    }

    if (opts.noInstall) {
      log("- Skipping dependency install + setup (--no-install). Checkout + env are ready; re-run `cinatra install --mode dev` (it reconciles in place — skips the clone, runs deps + setup) when ready.");
    } else {
      pnpmInstall({ targetDir, usePnpmDirect, log });
      if (opts.noSetup) {
        log("- Skipping setup (--no-setup). Checkout + deps are ready; re-run `cinatra install --mode dev` (it reconciles in place — runs the setup phase) when ready.");
      } else {
        // devApps are cloned by `setup dev` itself; passing --skip-dev-apps
        // through honors the operator's choice. (We do NOT sync devApps here to
        // avoid double-cloning.)
        runSetupInTarget({ targetDir, mode: "dev", skipDevApps: opts.skipDevApps, log });
      }
    }
  } else if (opts.noInstall) {
    log("- Skipping dependency install + setup (--no-install). Re-run `cinatra install --mode prod` (it reconciles in place — runs deps + acquire-prod + setup) when ready.");
  } else {
    // prod: install → acquire-prod → install → setup prod (mirrors setup.sh).
    pnpmInstall({ targetDir, usePnpmDirect, log });
    acquireProdExtensions({ targetDir, log });
    pnpmInstall({ targetDir, usePnpmDirect, log });
    if (opts.noSetup) {
      log("- Skipping setup (--no-setup). Re-run `cinatra install --mode prod` (it reconciles in place — runs the setup phase) when ready.");
    } else {
      runSetupInTarget({ targetDir, mode: "prod", skipDevApps: false, log });
    }
  }

  // 7b. T8c — record a registry row + marker for the DEFAULT / EXTERNAL install
  //     (the ISOLATED path already records its row inside the executor; an
  //     ATTACH converged on an existing row). This gives --status / --attach /
  //     stop-existing an authoritative source to read for default installs too.
  let recordedSlug = resolution?.instance?.slug ?? null;
  if (infraPlan === "default" || infraPlan === "external") {
    recordedSlug = await recordDefaultInstance({
      targetDir,
      opts,
      resolvedSha,
      state: infraPlan === "external" ? "external" : "ready",
      // cinatra-cli#35: record the SAME explicit project the default `up` used
      // (null for external — recordDefaultInstance falls back to the computed
      // instance-scoped name so the row is still accurate for --status/--down).
      composeProject: defaultProject,
      log,
      deps,
    });
  }

  // 8. Done.
  const appPortForSummary =
    infraPlan === "isolated" ? resolution?.instance?.appPort ?? DEFAULT_APP_PORT_FOR_RECORD : DEFAULT_APP_PORT_FOR_RECORD;
  log("");
  log("✓ Cinatra install complete.");
  log(`  Directory:     ${targetDir}`);
  log(`  Ref / commit:  ${opts.ref} (${resolvedSha})`);
  log(`  Mode:          ${opts.mode}`);
  if (recordedSlug) log(`  Instance:      ${recordedSlug}${infraPlan === "isolated" ? ` (isolated, project ${resolution?.instance?.composeProject})` : ""}`);
  if (infraPlan === "external") log("  Infra:         external (operator-owned; not install-managed)");
  log("");
  log("  Next:");
  log(`    cd ${targetDir}`);
  log(`    pnpm dev        # start the app at http://localhost:${appPortForSummary}`);
  log("    The first user to register becomes the admin.");
  return {
    targetDir,
    ref: opts.ref,
    sha: resolvedSha,
    mode: opts.mode,
    instance: recordedSlug,
    infraPlan,
    appPort: appPortForSummary,
  };
}

/** Clone a fresh host repo or update an existing checkout to `ref`; return the
 *  resolved commit SHA. Refuses a dirty checkout unless --force (stash-then-
 *  reset), and refuses to update a checkout whose origin is a different repo. */
async function cloneOrUpdateHost({ targetDir, repoUrl, ref, alreadyCheckout, force, yes, log }) {
  if (alreadyCheckout) {
    log(`- Existing cinatra checkout at ${targetDir} — updating to ref "${ref}"…`);
    const currentRef = capture("git", ["-C", targetDir, "rev-parse", "--short", "HEAD"], { env: gitEnv() });
    if (currentRef) log(`  Current commit: ${currentRef}`);

    // Verify the existing checkout's origin matches --repo-url. On a re-run an
    // operator may have passed a different (or default) --repo-url; updating a
    // checkout from a DIFFERENT remote would be a silent surprise. Fail loud.
    const existingOrigin = capture("git", ["-C", targetDir, "remote", "get-url", "origin"], { env: gitEnv() });
    if (existingOrigin && normalizeRemote(existingOrigin) !== normalizeRemote(repoUrl)) {
      throw new Error(
        `Refusing to update ${targetDir}: its origin is "${existingOrigin}" but --repo-url is "${repoUrl}". ` +
          `Point --repo-url at the existing origin, or choose a fresh --dir.`,
      );
    }

    // Reuse the single shared git-move primitive (fetch ref + tags → resolve to
    // a concrete commit → fast-forward / --force hard-reset). The same helper
    // backs `cinatra update`, so install and update can never drift apart.
    return moveExistingCheckoutToRef({ targetDir, ref, force, log });
  }

  if (existsSync(targetDir) && !isEmptyDir(targetDir)) {
    // Non-empty + --force was confirmed above; clone into it is unsafe, so
    // require an explicit confirmation that we may clone into a NON-empty dir.
    const ok = await confirm(`Clone INTO non-empty ${targetDir}? Existing contents may collide.`, { yes });
    if (!ok) throw new Error(`Aborted: ${targetDir} is not empty. Choose an empty --dir.`);
  }
  mkdirSync(targetDir, { recursive: true });
  log(`- Cloning ${repoUrl} into ${targetDir}…`);
  const clone = git(["clone", "--", repoUrl, targetDir]);
  if (clone.status !== 0) {
    throw new Error(
      `git clone failed: ${(clone.stderr ?? "").trim()}\n` +
        `  Check network access and that you can read ${repoUrl} ` +
        `(use --repo-url for an SSH/token remote if the repo is private).`,
    );
  }

  // Fresh clone: check out the requested ref (the clone default is the remote
  // HEAD branch). Resolve `ref` to a commit and check it out detached-then-by-
  // name so both a branch and a raw sha work.
  const checkout = git(["-C", targetDir, "checkout", ref]);
  if (checkout.status !== 0) {
    // Fetch the ref explicitly (covers a tag/sha not in the default clone) then
    // check out the fetched commit.
    const fetched = git(["-C", targetDir, "fetch", "origin", ref, "--tags"]);
    const fh = fetched.status === 0 ? git(["-C", targetDir, "checkout", "FETCH_HEAD"]) : fetched;
    if (fh.status !== 0) {
      throw new Error(
        `Could not check out ref "${ref}": ${(checkout.stderr ?? "").trim()}. ` +
          `Verify the branch/tag/sha exists in ${repoUrl}.`,
      );
    }
  }

  const sha = capture("git", ["-C", targetDir, "rev-parse", "HEAD"], { env: gitEnv() });
  if (!sha) throw new Error(`Could not resolve the checked-out commit in ${targetDir}.`);
  return sha;
}

// ---------------------------------------------------------------------------
// Shared git-move helper (cinatra-cli#11).
//
// `moveExistingCheckoutToRef` is the single git-move primitive for an EXISTING
// checkout: fetch the requested ref from origin, resolve it to a CONCRETE target
// commit, then fast-forward (or, under --force, hard-reset) the checkout onto
// THAT commit. Both `cloneOrUpdateHost`'s update branch (install on an existing
// checkout) AND `cinatra update`/`upgrade` route through it, so install and
// update can never drift apart.
//
// Why an explicitly-resolved target commit (not ambient FETCH_HEAD): `update`
// resolves the latest `v*` tag by first fetching `--tags` (whose FETCH_HEAD is
// the DEFAULT BRANCH tip, not the chosen tag), so moving to ambient FETCH_HEAD
// would land on origin/main instead of the release. We always fetch the exact
// ref and `rev-parse <ref>^{commit}` it, making the move deterministic.
//
// Import-light (node builtins + git subprocesses + a LAZY `semver` import) so it
// never drags the heavy `index.mjs` graph into the published thin CLI;
// `index.mjs`'s update handler imports it via the same lazy `import(...)` it
// already uses for `runInstall`. `deps`-injectable so it unit-tests without a
// network.
// ---------------------------------------------------------------------------

// A release tag we are willing to move to: a `v`-prefixed semver (the leading
// `v` followed by MAJOR.MINOR.PATCH and an optional pre-release/build suffix).
// Conservative — anchored, no whitespace/option-injection, so a tag name can
// never be mistaken for a git flag. The leading `v` is required so arbitrary
// annotated tags (e.g. `nightly`, `latest`) are never treated as a release.
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Pick the highest `v<semver>` release tag from a list (pure; testable without
 *  git). Non-release tags (no leading `v`, non-semver) are ignored.
 *
 *  Stable releases ALWAYS win over pre-releases: a pre-release tag is eligible
 *  ONLY when the list contains NO stable release tag at all (so a release
 *  candidate is never chosen over an existing stable release). Among stable tags
 *  — or, when none exist, among pre-releases — the highest by semver precedence
 *  wins. Returns the tag string, or null when none qualify. */
export async function pickLatestReleaseTag(tags) {
  const { default: semver } = await import("semver");
  let bestStable = null; // { tag, version }
  let bestPre = null; // { tag, version }
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag !== "string" || !RELEASE_TAG_RE.test(tag)) continue;
    const version = semver.valid(tag.slice(1));
    if (!version) continue;
    const isPre = semver.prerelease(version) !== null;
    const slot = isPre ? bestPre : bestStable;
    if (slot === null || semver.gt(version, slot.version)) {
      if (isPre) bestPre = { tag, version };
      else bestStable = { tag, version };
    }
  }
  // Stable releases take precedence over ANY pre-release; pre-releases are a
  // fallback used only when no stable release tag exists.
  const best = bestStable ?? bestPre;
  return best ? best.tag : null;
}

/** List the `v*` release tags published on ORIGIN (not local tag state) via
 *  `git ls-remote --tags origin "v*"`. Deriving candidates from the remote means
 *  a stale/private LOCAL-only tag can never be chosen as "the latest release".
 *  Strips the `refs/tags/` prefix and the `^{}` peeled-ref suffix annotated tags
 *  emit. Returns deduped tag names. Injectable via `deps.capture`. */
function listRemoteReleaseTags(targetDir, deps = {}) {
  const cap = deps.capture ?? capture;
  const raw = cap("git", ["-C", targetDir, "ls-remote", "--tags", "origin", "v*"], { env: gitEnv() });
  if (raw === null) {
    throw new Error(
      `git ls-remote --tags origin failed for ${targetDir} — could not list release tags ` +
        "from the remote (is origin reachable?).",
    );
  }
  const tags = new Set();
  for (const line of raw.split("\n")) {
    // "<sha>\trefs/tags/<name>"; annotated tags also emit a "…^{}" peeled line.
    const m = line.match(/\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (m && m[1]) tags.add(m[1].trim());
  }
  return [...tags];
}

/** Resolve the LATEST `v*` release tag PUBLISHED ON ORIGIN (highest semver;
 *  stable preferred). Candidates are read from the remote via `git ls-remote`
 *  (NOT local tag state), so a stale local-only tag can never win. Returns the
 *  tag string. Throws an actionable error when the remote can't be listed or
 *  publishes no release tag. `deps` injects `listTags` for tests. */
export async function resolveLatestReleaseTag({ targetDir, log = console.log, deps = {} } = {}) {
  log("- Querying origin for the latest release tag…");
  const tags = (deps.listTags ?? (() => listRemoteReleaseTags(targetDir, deps)))();
  const latest = await pickLatestReleaseTag(tags);
  if (!latest) {
    throw new Error(
      `No release tag (a \`v*\` semver tag) found on origin for ${targetDir}. ` +
        "`cinatra update` moves a checkout to the latest published release; this remote has none.",
    );
  }
  return latest;
}

/** Move an EXISTING checkout at `targetDir` onto `ref` (a branch, tag, or sha):
 *  fetch the ref from origin, resolve it to a CONCRETE target commit, then
 *  fast-forward — or, under `force`, hard-reset — the checkout onto that commit.
 *  Refuses a dirty working tree unless `force` (stash first); refuses a
 *  divergent/non-fast-forward move unless `force` (hard-reset). Returns the
 *  resolved HEAD sha.
 *
 *  `kind` disambiguates a tag/branch NAME COLLISION (a release tag and a local
 *  branch that happen to share the same name):
 *    - "tag"    — `ref` is a release tag: fetch it as `refs/tags/<ref>` and check
 *                 out its commit DETACHED, so a colliding local branch can never
 *                 be mutated (the correct state for a release pin). Used by
 *                 `cinatra update`'s latest-release path.
 *    - "ref"    — (default) auto-detect: a `ref` that names a local BRANCH lands
 *                 on (and stays on) that branch; anything else detaches at the
 *                 resolved commit. Used by `install`/`cloneOrUpdateHost` so
 *                 `--ref main` keeps tracking `main`.
 *
 *  `fetch: false` skips the fetch step (the caller already fetched the ref).
 *  `deps` injects `runGit(args)` + `workingTreeIsDirty` + `capture` for tests. */
export function moveExistingCheckoutToRef({
  targetDir,
  ref,
  kind = "ref",
  force = false,
  fetch = true,
  log = console.log,
  deps = {},
} = {}) {
  const runGit = deps.runGit ?? ((args) => git(["-C", targetDir, ...args]));
  const cap = deps.capture ?? capture;
  const isDirty = deps.workingTreeIsDirty ?? (() => workingTreeIsDirty(targetDir));

  // 1. Refuse / stash a dirty tree FIRST (before any fetch or move side effect).
  if (isDirty()) {
    if (!force) {
      throw new Error(
        `Refusing to move ${targetDir}: the working tree has uncommitted changes. ` +
          `Commit/stash them, or re-run with --force (which stashes them first).`,
      );
    }
    log("  --force: stashing local changes (including untracked) before the move…");
    const stash = runGit(["stash", "push", "--include-untracked", "-m", `cinatra move ${ref}`]);
    if (stash.status !== 0) {
      throw new Error(`git stash failed; refusing to hard-move a dirty tree: ${(stash.stderr ?? "").trim()}`);
    }
    log(`  Local changes stashed — recover via: git -C ${targetDir} stash list && git -C ${targetDir} stash pop`);
  }

  // 2. Fetch the EXACT ref so it is local, then resolve it to a concrete commit.
  //    For a "tag" move we fetch the FULLY-QUALIFIED `refs/tags/<ref>` into a
  //    local `refs/tags/<ref>` so the resolved commit is the TAG's — never a
  //    colliding branch's. We resolve the commit directly (NOT ambient
  //    FETCH_HEAD): a `--tags` fetch leaves FETCH_HEAD at the default branch, so
  //    trusting ambient FETCH_HEAD could land on the wrong commit for a tag move.
  const isTag = kind === "tag";
  if (fetch) {
    const fetchArgs = isTag
      ? ["fetch", "origin", "--force", `refs/tags/${ref}:refs/tags/${ref}`]
      : ["fetch", "origin", ref, "--tags", "--force"];
    const fetched = runGit(fetchArgs);
    if (fetched.status !== 0) {
      throw new Error(`git fetch origin ${ref} failed: ${(fetched.stderr ?? "").trim()}`);
    }
  }
  // Tag: resolve the tag-qualified ref unambiguously. Ref: try FETCH_HEAD (the
  // just-fetched ref), then origin/<ref>, then the bare ref — so a stale local
  // ref of the same name never wins over the freshly-fetched remote commit.
  const candidates = isTag ? [`refs/tags/${ref}`] : ["FETCH_HEAD", `origin/${ref}`, ref];
  let targetCommit = null;
  for (const candidate of candidates) {
    const r = runGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (r.status === 0 && typeof r.stdout === "string" && r.stdout.trim()) {
      targetCommit = r.stdout.trim();
      break;
    }
  }
  if (!targetCommit) {
    throw new Error(
      `Could not resolve ${isTag ? "tag" : "ref"} "${ref}" to a commit after fetching. ` +
        `Verify the ${isTag ? "tag" : "branch/tag/sha"} exists in origin.`,
    );
  }

  // 3. Check out the target. A "tag" move ALWAYS detaches at the tag commit (a
  //    release pin), immune to a tag/branch name collision. A "ref" move that
  //    names a LOCAL BRANCH checks out that branch BY NAME (so it lands on, and
  //    stays on, the branch — preserving tracking for `--ref main`); otherwise
  //    it detaches at the resolved commit. The branch check uses an exact
  //    `refs/heads/<ref>` lookup, NOT a bare `checkout <ref>` (which would prefer
  //    a branch over a same-named tag and silently mutate the wrong thing).
  const isLocalBranch =
    !isTag &&
    runGit(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]).status === 0;
  const checkoutTarget = isLocalBranch ? ref : targetCommit;
  const checkout = runGit(["checkout", checkoutTarget]);
  if (checkout.status !== 0) {
    throw new Error(
      `Could not check out ${isTag ? "tag" : "ref"} "${ref}": ${(checkout.stderr ?? "").trim()}.`,
    );
  }

  // 4. Advance to the resolved target commit. With --force, hard-reset (covers a
  //    divergent local branch / a backward move, and stays on the branch for a
  //    branch ref). Otherwise require a clean fast-forward of HEAD onto the
  //    target — `merge --ff-only` advances a branch in place (no detach) and is
  //    a no-op when already at the target; a divergent move surfaces the --force
  //    remediation rather than silently reporting a stale HEAD as "moved".
  const headSha = () => (cap("git", ["-C", targetDir, "rev-parse", "HEAD"], { env: gitEnv() }) ?? "").trim();
  if (force) {
    const reset = runGit(["reset", "--hard", targetCommit]);
    if (reset.status !== 0) {
      throw new Error(`git reset --hard ${ref} failed: ${(reset.stderr ?? "").trim()}`);
    }
  } else if (headSha() !== targetCommit) {
    const ff = runGit(["merge", "--ff-only", targetCommit]);
    if (ff.status !== 0) {
      throw new Error(
        `Could not fast-forward ${targetDir} to "${ref}" (the local checkout has diverged ` +
          `from it): ${(ff.stderr ?? "").trim()}. ` +
          `Reconcile manually, or re-run with --force to hard-reset to "${ref}".`,
      );
    }
  }

  const sha = headSha();
  if (!sha) throw new Error(`Could not resolve the checked-out commit in ${targetDir}.`);
  return sha;
}
