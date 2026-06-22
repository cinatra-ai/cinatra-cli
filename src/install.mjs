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
    noInfra: argv.includes("--no-infra"),
    // --no-install ⇒ clone + env only; pnpm install + setup both skipped
    // (setup needs the installed deps, so skipping install implies skipping setup).
    noInstall: argv.includes("--no-install"),
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
 *  exist yet). Returns a remediation string on failure, else null. */
function checkTargetWritable(targetDir) {
  const parent = path.dirname(path.resolve(targetDir));
  try {
    if (!existsSync(parent)) {
      return `Parent directory ${parent} does not exist — create it first (mkdir -p ${parent}).`;
    }
    const probe = path.join(parent, `.cinatra-install-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    spawnSync("rm", ["-f", probe]); // best-effort cleanup of the probe file.
    return null;
  } catch (err) {
    return `Cannot write into ${parent}: ${err.message}. Choose a --dir under a writable location.`;
  }
}

export function runPreflight({ mode = "dev", targetDir = null, noInfra = false, deps = {} } = {}) {
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
    const writableErr = (deps.checkTargetWritable ?? checkTargetWritable)(targetDir);
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

/** Best-effort: name the process holding `port` (lsof), e.g. "verdaccio (pid
 *  4242)". Returns null when lsof is unavailable or finds nothing. */
function describePortHolder(port, deps = {}) {
  const cap = deps.capture ?? capture;
  const out = cap("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fcn"]);
  if (!out) return null;
  // lsof -F output: lines prefixed by field char (c=command, n=name, p=pid).
  let command = null;
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("p")) pid = line.slice(1);
  }
  if (!command) return null;
  return pid ? `${command} (pid ${pid})` : command;
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
 *  `deps.describeHolder(port)`. */
export async function detectPortConflicts(band, deps = {}) {
  const probe = deps.probe ?? ((host, port) => probeHostPortFree(host, port));
  const describe = deps.describeHolder ?? ((port) => describePortHolder(port, deps));
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
      conflicts.push({ ...entry, holder: describe(entry.port) ?? null });
    }
  }
  return conflicts;
}

/** Render a port-conflict list into the actionable abort message. */
function formatPortConflictError(conflicts, { phase } = {}) {
  const lines = conflicts.map((c) => {
    const where = c.host === "0.0.0.0" ? `port ${c.port}` : `${c.host}:${c.port}`;
    const by = c.holder ? ` (held by ${c.holder})` : "";
    return `  ✗ ${where} — already in use${by}${c.service ? ` [needed for ${c.service}]` : ""}`;
  });
  return (
    `Host port conflict${conflicts.length > 1 ? "s" : ""} detected${phase ? ` (${phase})` : ""} — ` +
    `\`cinatra install\` cannot bring up its dev stack on the default ports:\n${lines.join("\n")}\n` +
    `\nAnother Cinatra stack (or another process) is already holding these ports. Options:\n` +
    `  • Stop the other stack (e.g. \`docker compose down\` in its directory), then retry.\n` +
    `  • To run a SECOND instance alongside the first, use \`cinatra setup clone\`, which shares ` +
    `infra and gives each clone its own app ports instead of a second full stack.\n` +
    `  • Or free the listed ports and retry.`
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
  let body = readFileSync(envPath, "utf8");
  body = upsertEnvKey(body, "BETTER_AUTH_SECRET", secret);
  body = upsertEnvKey(body, "CINATRA_RUNTIME_MODE", wantMode);
  writeFileSync(envPath, body);
  log(`  .env.local created from .env.example with a fresh BETTER_AUTH_SECRET and CINATRA_RUNTIME_MODE=${wantMode}.`);
  return { created: true, envPath };
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

function bringUpInfra({ targetDir, log = console.log }) {
  log("- Starting infrastructure (Postgres + Redis + Nango)…");
  composeUpOrThrow(targetDir);
  waitForCompose(targetDir, "postgres", ["pg_isready", "-U", "postgres"], "Postgres", log);
  waitForCompose(targetDir, "redis", ["redis-cli", "ping"], "Redis", log);
  waitForNango(log);
}

/** Run `docker compose up -d` and, on failure, surface the REAL stderr instead
 *  of a hardcoded "is the Docker daemon running?" (cinatra-cli#3). A port
 *  collision now reads e.g. "Bind for 0.0.0.0:4873 failed: port is already
 *  allocated" rather than misattributing it to the daemon. stderr is streamed
 *  to the user (pipe) AND captured so it can be folded into the thrown error. */
function composeUpOrThrow(targetDir) {
  const args = ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.dev.yml", "up", "-d"];
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
        "or use `cinatra setup clone` to run a second instance on its own ports."
      : "\n  Ensure the Docker daemon is running and reachable, then retry.";
    throw new Error(`docker compose up -d failed (exit ${result.status}).${detail}${hint}`);
  }
}

function waitForCompose(targetDir, service, readyCmd, label, log, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = spawnSync("docker", ["compose", "exec", "-T", service, ...readyCmd], {
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

function waitForNango(log, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const r = spawnSync("curl", ["-sf", "http://127.0.0.1:3003/health"], {
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
  log("  ⚠ Nango did not report healthy in time — continuing; `cinatra setup` will re-check.");
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
  const setupArgs = [PUBLISHED_CLI_BIN, "setup", mode];
  if (mode === "dev" && skipDevApps) setupArgs.push("--skip-dev-apps");
  log(`- Running \`cinatra setup ${mode}\` inside ${targetDir}…`);
  runOrThrow(process.execPath, setupArgs, `cinatra setup ${mode} failed inside the target.`, {
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

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

export async function runInstall(argv = [], { log = console.log, deps = {} } = {}) {
  const opts = parseInstallArgs(argv);

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
  const pre = preflight({ mode: opts.mode, targetDir, noInfra: opts.noInfra });
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

  // 3a. PRE-CLONE host-port guard (cinatra-cli#3): for a FRESH install of the
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
  if (pre.infraWillStart && !alreadyCheckout && usesDefaultBand) {
    const conflicts = await probePorts(DEFAULT_DEV_HOST_PORTS);
    if (conflicts.length > 0) {
      throw new Error(formatPortConflictError(conflicts, { phase: "preflight, before clone" }));
    }
  }

  if (targetExists && !isEmptyDir(targetDir) && !alreadyCheckout && !opts.force) {
    throw new Error(
      `Target ${targetDir} already exists and is not a cinatra checkout (and is not empty). ` +
        `Choose another --dir, or pass --force only if you are certain (it will clone INTO it).`,
    );
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

  // 4b. AUTHORITATIVE host-port gate (cinatra-cli#3): re-derive the published
  //     band from THIS checkout's own `docker compose config` and probe it,
  //     BEFORE writing .env.local / bringing infra up. This adapts to whatever
  //     the cloned ref declares (the preflight static band is only an early
  //     guess) and fails fast with an accurate message instead of the old
  //     misleading "is the Docker daemon running?" at `docker compose up`.
  //     Skipped under --no-infra (nothing to bring up) and when the target's OWN
  //     compose project already owns the ports (idempotent re-run, not a clash).
  if (!opts.noInfra && dockerPresent("docker", ["--version"]) && composeOk()) {
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
      // port is still a real conflict (codex must-fix: no blanket project-up skip).
      const ownedPorts = deriveOwnedPorts(targetDir);
      const conflicts = await probePorts(band, { ownedPorts });
      if (conflicts.length > 0) {
        throw new Error(formatPortConflictError(conflicts, { phase: "before bringing up infra" }));
      }
    }
  }

  // 5. Create/reconcile the env (BEFORE infra so a mode mismatch fails fast).
  log("- Configuring environment…");
  ensureEnvLocal({ targetDir, mode: opts.mode, resetEnv: opts.resetEnv, log });

  // 6. Bring up + wait for docker infra (skippable for external infra).
  if (opts.noInfra) {
    log("- Skipping infrastructure startup (--no-infra). Ensure Postgres/Redis/Nango are reachable before setup.");
  } else {
    startInfra({ targetDir, log });
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
      log("- Skipping dependency install + setup (--no-install). Checkout + env are ready; run `pnpm install && cinatra setup dev` inside the target when ready.");
    } else {
      pnpmInstall({ targetDir, usePnpmDirect, log });
      if (opts.noSetup) {
        log("- Skipping setup (--no-setup). Checkout + deps are ready; run `cinatra setup dev` inside the target when ready.");
      } else {
        // devApps are cloned by `setup dev` itself; passing --skip-dev-apps
        // through honors the operator's choice. (We do NOT sync devApps here to
        // avoid double-cloning.)
        runSetupInTarget({ targetDir, mode: "dev", skipDevApps: opts.skipDevApps, log });
      }
    }
  } else if (opts.noInstall) {
    log("- Skipping dependency install + setup (--no-install). Run `pnpm install && cinatra extensions acquire-prod && pnpm install && cinatra setup prod` inside the target when ready.");
  } else {
    // prod: install → acquire-prod → install → setup prod (mirrors setup.sh).
    pnpmInstall({ targetDir, usePnpmDirect, log });
    acquireProdExtensions({ targetDir, log });
    pnpmInstall({ targetDir, usePnpmDirect, log });
    if (opts.noSetup) {
      log("- Skipping setup (--no-setup). Run `cinatra setup prod` inside the target when ready.");
    } else {
      runSetupInTarget({ targetDir, mode: "prod", skipDevApps: false, log });
    }
  }

  // 8. Done.
  log("");
  log("✓ Cinatra install complete.");
  log(`  Directory:     ${targetDir}`);
  log(`  Ref / commit:  ${opts.ref} (${resolvedSha})`);
  log(`  Mode:          ${opts.mode}`);
  log("");
  log("  Next:");
  log(`    cd ${targetDir}`);
  log("    pnpm dev        # start the app at http://localhost:3000");
  log("    The first user to register becomes the admin.");
  return { targetDir, ref: opts.ref, sha: resolvedSha, mode: opts.mode };
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

    if (workingTreeIsDirty(targetDir)) {
      if (!force) {
        throw new Error(
          `Refusing to update ${targetDir}: the working tree has uncommitted changes. ` +
            `Commit/stash them, or re-run with --force (which stashes them first).`,
        );
      }
      log("  --force: stashing local changes (including untracked) before update…");
      const stash = git(["-C", targetDir, "stash", "push", "--include-untracked", "-m", "cinatra install --force"]);
      if (stash.status !== 0) {
        throw new Error(`git stash failed; refusing to hard-update a dirty tree: ${(stash.stderr ?? "").trim()}`);
      }
      log(`  Local changes stashed — recover via: git -C ${targetDir} stash list && git -C ${targetDir} stash pop`);
    }

    const fetch = git(["-C", targetDir, "fetch", "origin", ref, "--tags"]);
    if (fetch.status !== 0) {
      throw new Error(`git fetch origin ${ref} failed: ${(fetch.stderr ?? "").trim()}`);
    }
  } else {
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
  }

  // Resolve `ref` to a commit and check it out detached-then-by-name so both a
  // branch and a raw sha work. We checkout the FETCH_HEAD/ref so an update lands
  // on the requested ref deterministically.
  const checkout = git(["-C", targetDir, "checkout", ref]);
  if (checkout.status !== 0) {
    // Fall back to FETCH_HEAD (covers a freshly-fetched sha/tag not yet a local ref).
    const fh = git(["-C", targetDir, "checkout", "FETCH_HEAD"]);
    if (fh.status !== 0) {
      throw new Error(
        `Could not check out ref "${ref}": ${(checkout.stderr ?? "").trim()}. ` +
          `Verify the branch/tag/sha exists in ${repoUrl}.`,
      );
    }
  } else if (alreadyCheckout) {
    // For a branch update, fast-forward to the fetched tip. A divergent local
    // branch fails --ff-only; surface it (with the --force remediation) rather
    // than silently returning the stale HEAD as "updated".
    const ff = git(["-C", targetDir, "merge", "--ff-only", "FETCH_HEAD"]);
    if (ff.status !== 0) {
      if (!force) {
        throw new Error(
          `Could not fast-forward ${targetDir} to the fetched "${ref}" tip ` +
            `(the local branch has diverged): ${(ff.stderr ?? "").trim()}. ` +
            `Reconcile manually, or re-run with --force to hard-reset to the fetched tip.`,
        );
      }
      log("  --force: local branch diverged — hard-resetting to the fetched tip…");
      const reset = git(["-C", targetDir, "reset", "--hard", "FETCH_HEAD"]);
      if (reset.status !== 0) {
        throw new Error(`git reset --hard FETCH_HEAD failed: ${(reset.stderr ?? "").trim()}`);
      }
    }
  }

  const sha = capture("git", ["-C", targetDir, "rev-parse", "HEAD"], { env: gitEnv() });
  if (!sha) throw new Error(`Could not resolve the checked-out commit in ${targetDir}.`);
  return sha;
}
