// ---------------------------------------------------------------------------
// The instance's EFFECTIVE local-infra endpoints (cinatra-ai/cinatra-cli#197).
//
// WHY THIS EXISTS: a dev install's configuration is only PARTLY written down.
// `.env.example` (copied verbatim by the default env phase) defines
// `SUPABASE_DB_URL` but NOT `REDIS_URL` and NOT `CINATRA_AGENT_REGISTRY_URL` —
// the app falls back to its own defaults for those, so the install's EFFECTIVE
// configuration includes endpoints that appear nowhere in `.env.local`.
//
// That is harmless while everything runs on the host (the app's fallback and the
// stack's published port agree). It stops being harmless the moment the
// configuration is COMPOSED somewhere else: `install --mode preview` forwards
// `.env.local` into a container, where "absent" means the app's in-container
// fallback (`127.0.0.1:6379` → the container itself, and the HOSTED registry) —
// not the instance's own Redis/Verdaccio. The ISOLATED install path never hit
// this because it writes both keys explicitly (`writeIsolatedAppEnv`,
// cinatra-cli#36/#57), which is exactly why the defect only ever showed up on a
// quiet host.
//
// So this module makes the implicit half EXPLICIT, from the SAME source the
// isolated path re-points against: the checkout's own resolved
// `docker compose config` published-port map. It is a pure derivation plus one
// `docker compose config` capture — no writes, and deliberately no knowledge of
// previews, so both the install front door and the preview composition can read
// it without importing `install.mjs`.
//
// LEAK DISCIPLINE: the derived values are LOCAL loopback endpoints built from a
// port number — they carry no credential. Callers still report them by KEY NAME
// only, because the same maps are merged with the credential-bearing passthrough
// surface downstream.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

/** Run a command and return trimmed stdout, or null on any failure. Local copy
 *  (this module must not import `install.mjs`, which lazy-imports the preview
 *  composition that imports THIS module). */
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
export function composePublishedPortsForTarget(targetDir, deps = {}) {
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

/** The FIRST host port a band publishes for `service`, or null. Mirrors the
 *  isolated path's per-service `ports` lookup (`writeIsolatedAppEnv`'s `first`),
 *  so both paths pick the same port for the same service. */
export function firstPublishedPortForService(band, service) {
  if (!Array.isArray(band)) return null;
  for (const entry of band) {
    if (entry?.service === service && Number.isInteger(entry.port) && entry.port > 0) return entry.port;
  }
  return null;
}

/**
 * The endpoint keys whose EFFECTIVE value a dev install has but never writes
 * down, mapped to the compose service that publishes them.
 *
 * Deliberately NARROW — one entry per key the app resolves by FALLBACK rather
 * than from `.env.local`, and only for services `cinatra install` itself brings
 * up. Everything else in the passthrough surface is either written by
 * `.env.example` (`SUPABASE_DB_URL`, `NANGO_*`, `GRAPHITI_URL`) or is an
 * operator secret with no derivable default.
 *
 *  - REDIS_URL — the app defaults to `127.0.0.1:6379`, correct on the host and
 *    self-referential inside a container.
 *  - CINATRA_AGENT_REGISTRY_URL — the registry the SERVER-side install/publish
 *    path fetches from; unset, `@cinatra-ai/registries` lands on the hosted
 *    default the instance holds no credentials for (the cinatra-cli#190 401).
 *  - CINATRA_AGENT_REGISTRY_UI_URL — the same published Verdaccio port (it
 *    serves registry + web UI). Browser-resolved, so consumers forward it
 *    VERBATIM; it is derived here only so the pair stays consistent.
 */
export const EFFECTIVE_ENDPOINT_SPECS = Object.freeze([
  Object.freeze({ key: "REDIS_URL", service: "redis", build: (port) => `redis://127.0.0.1:${port}` }),
  Object.freeze({
    key: "CINATRA_AGENT_REGISTRY_URL",
    service: "verdaccio",
    build: (port) => `http://127.0.0.1:${port}`,
  }),
  Object.freeze({
    key: "CINATRA_AGENT_REGISTRY_UI_URL",
    service: "verdaccio",
    build: (port) => `http://127.0.0.1:${port}`,
  }),
]);

/**
 * The published host ports the DEFAULT dev stack uses for the services above —
 * the LAST-RESORT fallback for when `docker compose config` cannot be modelled
 * AT ALL (no docker on PATH, an unparseable compose file). Kept in sync with
 * `install.mjs`'s `DEFAULT_DEV_HOST_PORTS`; a unit test asserts the two agree so
 * a compose change that moves a port cannot leave this table silently stale.
 *
 * It is NOT a per-service backfill: a band that RESOLVED and does not publish
 * `redis` is positive evidence that this checkout's stack has no host-published
 * Redis, and answering that with the default port would be inventing an endpoint
 * rather than deriving one.
 */
export const DEFAULT_LOCAL_INFRA_PORTS = Object.freeze({ redis: 6379, verdaccio: 4873 });

/**
 * The install infra plans whose endpoints THIS checkout's compose band actually
 * describes — i.e. the plans where the CLI itself owns/converges a local stack
 * for this checkout:
 *
 *   - "default"  — the base stack this run brought up on the checkout's own band.
 *   - "attach"   — an idempotent re-run/attach converging on THIS checkout's own
 *                  recorded stack (`executeAttach` refuses a different instance).
 *
 * Deliberately EXCLUDED:
 *   - "external" — operator-owned infra; deriving a local loopback endpoint
 *                  would invent an endpoint the operator explicitly replaced.
 *   - "co-use"   — the endpoints belong to the DONOR's stack, not this band
 *                  (and `--mode preview` refuses co-use outright).
 *   - "isolated" — already written explicitly into `.env.local`, so there is
 *                  nothing implicit left to derive (this is a no-op there, but
 *                  excluding it keeps the isolated path provably untouched).
 */
export const LOCAL_STACK_INFRA_PLANS = Object.freeze(["default", "attach"]);

/**
 * Derive the instance's effective endpoints from a published-port `band`.
 *
 * PURE. Returns `{ values, sources }` where `sources[key]` is "compose" when the
 * port came from the resolved band and "default" when it fell back to the static
 * table — so a caller can report HOW a value was reached without printing it.
 */
export function deriveEffectiveInstanceEndpoints({
  band = null,
  specs = EFFECTIVE_ENDPOINT_SPECS,
  defaults = DEFAULT_LOCAL_INFRA_PORTS,
} = {}) {
  // A band that could not be captured at all (`null`) is an UNKNOWN, and the
  // documented default stack is the honest answer to it. A band that resolved is
  // AUTHORITATIVE — including about a service it does not publish, which is why
  // the defaults are consulted only in the first case.
  const bandResolved = Array.isArray(band);
  const values = {};
  const sources = {};
  for (const spec of specs) {
    const composePort = firstPublishedPortForService(band, spec.service);
    const port = composePort ?? (bandResolved ? null : defaults[spec.service] ?? null);
    if (!Number.isInteger(port) || port <= 0) continue;
    values[spec.key] = spec.build(port);
    sources[spec.key] = composePort ? "compose" : "default";
  }
  return { values, sources };
}

/** True iff `infraPlan` is one whose endpoints this checkout's own band describes. */
export function infraPlanOwnsLocalStack(infraPlan) {
  return LOCAL_STACK_INFRA_PLANS.includes(infraPlan);
}
