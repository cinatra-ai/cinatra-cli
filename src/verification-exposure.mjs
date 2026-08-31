// ---------------------------------------------------------------------------
// `cinatra instance verify-exposure` — the verification exposure mode
// (cinatra-cli#246).
//
// WHY A SECOND MODE AND NOT A FLAG ON THE EXISTING ONE.
// `cinatra instance tunnel` publishes the WHOLE local app on a public tunnel:
// its serve config is `Handlers: { "/": { Proxy: <app> } }`. That is what its
// two existing consumers — `instance setup dev`'s auto-bring-up and
// `cinatra doctor --fix` — ask for, so narrowing it would change their
// behaviour out from under them. This mode is therefore a SEPARATE command
// with its OWN runtime state (own directory, own compose project, own device
// hostname), so the two lifecycles can never collide or overwrite each other.
//
// WHAT IT PUBLISHES.
// Exactly one path — the app's MCP callback prefix `/api/mcp` — and nothing
// else. Whichever methods the app itself answers on that path (GET, POST,
// DELETE, OPTIONS, as its route exports) travel through unchanged: the mapping
// is PATH-scoped, never method-scoped, and the app's own authentication gate
// stays the admission control an unauthenticated caller actually meets.
//
// THE EDGE IS A MOUNT POINT, THE PROXY IS THE EXACT MATCH. A serve-config
// handler key is a MOUNT POINT at the tunnel edge, not an exact path: the
// edge resolves a request by looking up the full path and then walking its
// parents, so a handler at `/api/mcp` also catches `/api/mcp/anything`. The
// edge alone therefore CANNOT give this mode the exact-path guarantee it
// publishes. The guarantee is enforced one hop later, in this module's own
// proxy: a request whose path is not EXACTLY the mapped path is answered with
// the refusal status and is never forwarded upstream and never written to the
// access log, so a descendant reaches neither the app nor the evidence file.
// The built-in check drives `/api/mcp/anything` for exactly this reason.
//
// EVERYTHING FORWARDED IS LOGGED. The mapping does not point at the app; it
// points at a small loopback access-logging proxy this module provides, which
// appends one JSON line per forwarded request (method, path, marker, status)
// as soon as the app answers it — or as soon as that attempt provably fails.
// A request still in flight therefore has no line yet, which is why the check
// drives each probe to completion before it reads the log. That log is the single source of truth the check
// reads: a path being ABSENT from it is the proof that the edge refused the
// request rather than the app answering it.
//
// This module holds the PURE, hermetically testable pieces — the mapping
// builder, the runtime paths, the proxy, the access log, and the check's
// assertion logic. `src/index.mjs` owns the command that composes them with
// the identity gate and the Docker/Tailscale provisioning it shares with
// `instance tunnel`.
// ---------------------------------------------------------------------------

import { createServer, request as httpRequest } from "node:http";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// --- the contract this mode publishes -------------------------------------

/**
 * The ONE path this mode maps. The app's MCP callback route lives here; it is
 * the only surface an external verification check needs to reach.
 */
export const VERIFICATION_EXPOSURE_MAPPED_PATH = "/api/mcp";

/**
 * The header the built-in check tags each probe with, so a request can be
 * matched between the public origin and the proxy's own log without relying on
 * timing or on the path alone.
 */
export const VERIFICATION_EXPOSURE_MARKER_HEADER = "x-cinatra-verification-marker";

/**
 * The status the tunnel edge answers with for a path that has NO entry in the
 * serve config's `Handlers`. The check asserts this EXACT value for every
 * unmapped path — one fixed status, not "any non-2xx" — so a mapping that
 * silently widened shows up as a status change rather than as a pass.
 *
 * This value is the edge's own unmapped-path behaviour, not the app's: the app
 * is never reached at all (the absence of the marker from the access log in
 * the same check is what proves that). `up` and `check` both accept an
 * explicit override so an operator who measures a different value against a
 * live edge pins the measured one without editing this file.
 */
export const VERIFICATION_EXPOSURE_UNMAPPED_STATUS = 404;

/**
 * The loopback-only path the proxy answers its own identity on. `up` polls it
 * to prove the process it just spawned — and not some unrelated process that
 * already held the port — is the one listening, and `down` re-checks it before
 * signalling a recorded pid (a pid can be recycled; a nonce cannot).
 *
 * It is never reachable from the tunnel: the mapping forwards only the mapped
 * path, and this path is not it.
 */
/**
 * The status THIS MODE'S OWN PROXY answers for a path the edge forwarded but
 * that is not exactly the mapped path (every descendant of the mapped prefix,
 * because the edge treats the handler key as a mount point). Unlike the edge's
 * status above, this one is not a measurement: this repository's own code
 * chooses it, so the check asserts it exactly and a change here is a change the
 * suite sees.
 */
export const VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS = 404;

export const VERIFICATION_EXPOSURE_HEALTH_PATH = "/__cinatra-verify-exposure/health";

/**
 * Cap for the access log. It records requests that arrived from the public
 * internet, so it must not be able to grow without bound: at the cap the file
 * is rolled to `<log>.1` (one generation) and a fresh file starts, which keeps
 * the CURRENT run's evidence intact while bounding the disk.
 */
export const VERIFICATION_EXPOSURE_ACCESS_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The status the app itself answers for an UNAUTHENTICATED GET on the mapped
 * path, per cinatra-ai/cinatra#3130, which documents and test-pins it on the
 * app side. The check asserts the mapped path answers with exactly this — the
 * mapping is not "working" if the callback path answers something else.
 */
export const VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS = 401;

/**
 * The paths the built-in check drives, in order. Three ordinary app pages that
 * must never be published by this mode, one genuine DESCENDANT of the mapped
 * prefix (the loose-prefix trap), and the mapped path itself.
 */
export const VERIFICATION_EXPOSURE_PROBE_PATHS = Object.freeze([
  "/",
  "/sign-in",
  "/sign-up",
  `${VERIFICATION_EXPOSURE_MAPPED_PATH}/anything`,
  VERIFICATION_EXPOSURE_MAPPED_PATH,
]);

/** Default loopback port the access-logging proxy binds. */
export const VERIFICATION_EXPOSURE_PROXY_PORT_DEFAULT = 3399;

// The serve-config key, byte-identical to the one the general-purpose builder
// uses: the LITERAL containerboot `${TS_CERT_DOMAIN}` placeholder the sidecar
// substitutes with its own tailnet-qualified cert domain once the node
// registers. A plain double-quoted string, NEVER a template literal.
const TAILSCALE_SERVE_FQDN_KEY = "${TS_CERT_DOMAIN}:443";

// --- the mapping ----------------------------------------------------------

/**
 * The path-scoped serve config: the same shape the general-purpose builder
 * produces, with `Handlers` narrowed from the `"/"` catch-all to the single
 * mapped path — and pointed at the access-logging proxy, never straight at the
 * app, so nothing can reach the app unlogged.
 *
 * @param {{ proxyPort: number, hostNetwork?: boolean }} args
 */
export function buildScopedTailscaleServeConfig({ proxyPort, hostNetwork = false }) {
  if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
    throw new Error(`Invalid access-logging proxy port ${String(proxyPort)}.`);
  }
  const backend = hostNetwork
    ? `http://127.0.0.1:${proxyPort}`
    : `http://host.docker.internal:${proxyPort}`;
  return {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [TAILSCALE_SERVE_FQDN_KEY]: {
        // EXACTLY one handler, keyed on the mapped path with NO trailing
        // slash. Adding a second key here — or a trailing slash to this one —
        // is the regression the suite pins.
        Handlers: { [VERIFICATION_EXPOSURE_MAPPED_PATH]: { Proxy: backend } },
      },
    },
    AllowFunnel: { [TAILSCALE_SERVE_FQDN_KEY]: true },
  };
}

/** Write the scoped serve config (0600, like the general-purpose one). */
export function writeScopedTailscaleServeConfig({ servePath, proxyPort, hostNetwork = false }) {
  mkdirSync(path.dirname(servePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    servePath,
    JSON.stringify(buildScopedTailscaleServeConfig({ proxyPort, hostNetwork }), null, 2),
    { mode: 0o600 },
  );
}

// --- runtime state, disjoint from `instance tunnel`'s ----------------------

/**
 * This mode's runtime directory. Deliberately NOT under `~/.cinatra/clones/`,
 * where the general-purpose tunnel keeps its per-identity state: the two must
 * never share a compose file, a serve config or a Tailscale state volume.
 */
export function verificationExposureRuntimeDir(slug, { home } = {}) {
  assertSlug(slug);
  return path.join(home ?? os.homedir(), ".cinatra", "verification-exposure", slug);
}

export function verificationExposureServePath(slug, opts) {
  return path.join(verificationExposureRuntimeDir(slug, opts), "tailscale-serve.json");
}

export function verificationExposureComposePath(slug, opts) {
  return path.join(verificationExposureRuntimeDir(slug, opts), "compose.yml");
}

/** The documented location `status` prints and the check reads. */
export function verificationExposureAccessLogPath(slug, opts) {
  return path.join(verificationExposureRuntimeDir(slug, opts), "access.log");
}

export function verificationExposureProxyStatePath(slug, opts) {
  return path.join(verificationExposureRuntimeDir(slug, opts), "proxy.json");
}

/** Its own compose project — never the general tunnel's. */
export function verificationExposureComposeProjectName(slug) {
  assertSlug(slug);
  return `cinatra-verify-exposure-${slug.replace(/[^a-z0-9-]/g, "-")}`;
}

/**
 * Its own Tailscale device hostname, derived from the general tunnel's so the
 * two are recognizably the same instance, and suffixed so they can never
 * register as one node. Truncated to the 63-char DNS label limit.
 */
export function verificationExposureTailscaleHostname(baseHostname) {
  const suffix = "-verify";
  const base = String(baseHostname ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) throw new Error("A verification exposure hostname needs a base hostname.");
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

function assertSlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error(`Invalid verification exposure slug "${String(slug)}".`);
  }
}

// --- the access log -------------------------------------------------------

/**
 * One forwarded request, as the proxy records it. `marker` is whatever the
 * caller tagged the request with (null for an untagged request), which is how
 * the check tells its own probes apart from ordinary traffic.
 */
export function formatAccessLogEntry({ method, path: requestPath, marker, status, at }) {
  return {
    at: at ?? new Date().toISOString(),
    method: String(method ?? "").toUpperCase(),
    path: String(requestPath ?? ""),
    marker: marker ?? null,
    status: typeof status === "number" ? status : null,
  };
}

/**
 * Append one JSON line. Creates the directory and the file on first write, and
 * rolls the file to `<log>.1` once it passes the cap — the log is fed by public
 * traffic, so an unbounded file is a disk-exhaustion surface, and one rolled
 * generation keeps the running run's evidence readable.
 */
export function appendAccessLogEntry(logPath, entry) {
  mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  rollAccessLogIfOversized(logPath);
  appendFileSync(logPath, `${JSON.stringify(formatAccessLogEntry(entry))}\n`, { mode: 0o600 });
}

function rollAccessLogIfOversized(logPath) {
  try {
    if (statSync(logPath).size < VERIFICATION_EXPOSURE_ACCESS_LOG_MAX_BYTES) return;
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet, or the roll lost a race with another writer. Either way the
    // append below is still the right next step.
  }
}

/**
 * Read the log back, WITH the diagnostics the check needs to fail closed.
 *
 * An absent log is no entries, never a throw — the mode may legitimately have
 * forwarded nothing yet. A half-written FINAL line (the proxy was killed
 * mid-append) is tolerated and counted separately, because that is a known,
 * benign shape. A malformed line ANYWHERE ELSE is not benign: it means a line
 * was lost or interleaved, and a lost line could be the very evidence that an
 * unmapped path was forwarded. It is reported as `malformedLines` so the check
 * can refuse to pass on damaged evidence rather than silently reading past it.
 *
 * @returns {{ entries: object[], malformedLines: number, tornFinalLine: boolean }}
 */
export function readAccessLogWithDiagnostics(logPath) {
  const empty = { entries: [], malformedLines: 0, tornFinalLine: false };
  if (!existsSync(logPath)) return empty;
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return empty;
  }
  const lines = raw.split("\n");
  const entries = [];
  let malformedLines = 0;
  let tornFinalLine = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    // The last element of a split on "\n" is the text AFTER the final newline:
    // an unterminated, still-being-written record.
    const isUnterminatedTail = i === lines.length - 1;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") entries.push(parsed);
      else if (isUnterminatedTail) tornFinalLine = true;
      else malformedLines += 1;
    } catch {
      if (isUnterminatedTail) tornFinalLine = true;
      else malformedLines += 1;
    }
  }
  return { entries, malformedLines, tornFinalLine };
}

/**
 * The entries alone, for callers that only need the records. `check` uses
 * {@link readAccessLogWithDiagnostics} instead, because it must fail closed on
 * damaged evidence.
 */
export function readAccessLog(logPath) {
  return readAccessLogWithDiagnostics(logPath).entries;
}

// --- the loopback access-logging proxy ------------------------------------

/**
 * The proxy the mapping actually points at — and the component that makes this
 * mode's central promise TRUE.
 *
 * The tunnel edge cannot give an exact-path guarantee: a serve-config handler
 * key is a mount point, so the edge hands this proxy `/api/mcp` AND everything
 * below it. So the proxy is the exact match. A request whose path is not
 * exactly the mapped path is answered with the refusal status right here: it is
 * never forwarded upstream, and nothing is written to the access log for it —
 * the access log means "was forwarded to the app", which is precisely the
 * question the check asks of it.
 *
 * The returned server is NOT listening yet — the caller binds it, and binds it
 * to LOOPBACK: the tunnel mapping is meant to be the only way in from outside,
 * and a proxy on a routable interface would quietly become a second one.
 *
 * @param {{ upstreamHost?: string, upstreamPort: number, logPath: string,
 *           markerHeader?: string, mappedPath?: string, refusedStatus?: number,
 *           healthNonce?: string|null }} args
 */
export function createAccessLoggingProxy({
  upstreamHost = "127.0.0.1",
  upstreamPort,
  logPath,
  markerHeader = VERIFICATION_EXPOSURE_MARKER_HEADER,
  mappedPath = VERIFICATION_EXPOSURE_MAPPED_PATH,
  refusedStatus = VERIFICATION_EXPOSURE_UNMAPPED_STATUS,
  healthNonce = null,
}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    throw new Error(`Invalid upstream port ${String(upstreamPort)}.`);
  }
  if (!Number.isInteger(refusedStatus) || refusedStatus < 100 || refusedStatus > 599) {
    throw new Error(`Invalid refusal status ${String(refusedStatus)}.`);
  }
  return createServer((req, res) => {
    const marker = headerValue(req.headers[markerHeader.toLowerCase()]);
    const requestPath = pathOf(req.url);
    let logged = false;
    const log = (status) => {
      if (logged) return;
      logged = true;
      try {
        appendAccessLogEntry(logPath, { method: req.method, path: requestPath, marker, status });
      } catch {
        // The log is evidence, not a gate: a failed append (a full disk, say)
        // must not take the forwarded request down with it. Nothing is hidden
        // by that: a MISSING record makes the check fail closed, and an
        // unmapped path is refused above this line, before any forwarding, so
        // a lost line can never turn a leak into a pass.
      }
    };

    // The proxy's own identity, on loopback only. `up` reads it to prove the
    // listener on the port is the child it just spawned, and `down` reads it
    // before signalling a pid, so a RECYCLED pid can never be killed. Never
    // logged: it is not a forwarded request.
    if (healthNonce && requestPath === VERIFICATION_EXPOSURE_HEALTH_PATH) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nonce: healthNonce, upstreamPort, mappedPath }));
      return;
    }

    // THE EXACT MATCH. Anything the edge let through that is not exactly the
    // mapped path stops here: no upstream request, no log line.
    if (requestPath !== mappedPath) {
      req.resume();
      res.writeHead(refusedStatus, { "content-type": "text/plain" });
      res.end("not mapped\n");
      return;
    }

    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${upstreamHost}:${upstreamPort}` },
      },
      (upstreamRes) => {
        log(upstreamRes.statusCode ?? null);
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      // The app is down behind the mapping. Record the attempt — the request
      // DID come through the mapping, which is what the check asks about —
      // and answer the caller honestly.
      log(502);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream unavailable");
    });
    req.pipe(upstream);
  });
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pathOf(url) {
  const raw = String(url ?? "/");
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

// --- the built-in check ---------------------------------------------------

/**
 * The probe plan: one marked request per documented path, each marker unique
 * so a leak on one path can never be mistaken for the mapped path's own
 * legitimate log line.
 */
export function buildVerificationProbePlan({ marker }) {
  const run = String(marker ?? "").trim();
  if (!run) throw new Error("A verification probe plan needs a run marker.");
  return VERIFICATION_EXPOSURE_PROBE_PATHS.map((probePath, index) => ({
    path: probePath,
    marker: `${run}-${index}`,
  }));
}

/**
 * The assertion. Given what each probe observed at the public origin and what
 * the proxy's own log recorded, decide whether the mapping really admits only
 * the mapped path.
 *
 * For every path OTHER than the exact mapped one, BOTH must hold:
 *   - the origin answered that path's fixed refusal status — the edge's own
 *     unmapped-path status for a path the edge never forwards, and this
 *     repository's proxy refusal status for a descendant of the mapped prefix,
 *     which the edge DOES forward because its handler key is a mount point —
 *     and
 *   - the probe's marker never appears in the proxy's log (it was refused at
 *     the mapping and never forwarded to the app at all).
 * For the mapped path, both of:
 *   - its marker DOES appear in the log (it really did reach the app), and
 *   - the origin answered the app's own documented unauthenticated status.
 *
 * A probe with no observed status (the request could not be driven) FAILS —
 * an unreachable origin is not evidence that a path is refused.
 */
export function evaluateVerificationExposureCheck({
  probes,
  logEntries,
  unmappedStatus = VERIFICATION_EXPOSURE_UNMAPPED_STATUS,
  proxyRefusedStatus = VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS,
  appStatus = VERIFICATION_EXPOSURE_APP_UNAUTHENTICATED_STATUS,
  mappedPath = VERIFICATION_EXPOSURE_MAPPED_PATH,
  malformedLogLines = 0,
  expectedPaths = VERIFICATION_EXPOSURE_PROBE_PATHS,
}) {
  const results = [];
  const failures = [];

  // FAIL CLOSED ON A DAMAGED OR INCOMPLETE EVIDENCE SET. An empty probe list is
  // not "everything passed", and a log with a malformed line in its body may
  // have lost the very record that would have failed this check.
  const probeList = Array.isArray(probes) ? probes : [];
  if (probeList.length === 0) {
    failures.push("no probes were driven at all, so nothing about the mapping is proven.");
  }
  const drivenPaths = probeList.map((probe) => probe.path);
  for (const expected of expectedPaths) {
    if (!drivenPaths.includes(expected)) {
      failures.push(`${expected}: this path was never probed, so nothing about it is proven.`);
    }
  }
  const markers = probeList.map((probe) => probe.marker);
  if (markers.some((m) => typeof m !== "string" || m.length === 0)) {
    failures.push("a probe carried no marker, so its requests cannot be told apart in the log.");
  } else if (new Set(markers).size !== markers.length) {
    failures.push("two probes shared a marker, so a leak on one path could be read as another's.");
  }
  if (malformedLogLines > 0) {
    failures.push(
      `the access log contains ${malformedLogLines} malformed line(s) in its body, so its ` +
        `evidence is incomplete and cannot prove a path was NOT forwarded.`,
    );
  }

  const entriesByMarker = new Map();
  for (const entry of logEntries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const marker = typeof entry.marker === "string" && entry.marker.length > 0 ? entry.marker : null;
    if (!marker) continue;
    const bucket = entriesByMarker.get(marker) ?? [];
    bucket.push(entry);
    entriesByMarker.set(marker, bucket);
  }

  for (const probe of probeList) {
    const isMapped = probe.path === mappedPath;
    // A descendant of the mapped prefix is refused by THIS repository's proxy
    // (the edge's handler key is a mount point and forwards it); every other
    // unmapped path never reaches the proxy at all and is refused by the edge.
    const isDescendantOfMapped = !isMapped && probe.path.startsWith(`${mappedPath}/`);
    const matchedEntries = entriesByMarker.get(probe.marker) ?? [];
    const reachedApp = matchedEntries.length > 0;
    const expectedStatus = isMapped
      ? appStatus
      : isDescendantOfMapped
        ? proxyRefusedStatus
        : unmappedStatus;
    const observedStatus = typeof probe.status === "number" ? probe.status : null;
    const probeFailures = [];

    if (observedStatus === null) {
      probeFailures.push(
        `${probe.path}: no response was observed at the public origin, so nothing is proven.`,
      );
    } else if (observedStatus !== expectedStatus) {
      probeFailures.push(
        isMapped
          ? `${probe.path}: answered ${observedStatus}, but the app documents ${expectedStatus} for an unauthenticated GET.`
          : `${probe.path}: answered ${observedStatus}, but an unmapped path must be refused at ${expectedStatus}.`,
      );
    }

    if (isMapped) {
      if (!reachedApp) {
        probeFailures.push(
          `${probe.path}: its marker is absent from the access log, so the mapping never forwarded it to the app.`,
        );
      } else {
        // The log line must be ABOUT this request, not merely carry its marker:
        // a marker recorded against another path or method is not evidence that
        // the mapped path was forwarded.
        // ONE entry must match ALL of it. Splitting the conditions would let
        // two unrelated lines that happen to carry the marker — one with the
        // right path, another with the right status — pass for evidence that
        // never existed.
        const matchesRequest = matchedEntries.some(
          (entry) =>
            entry.path === probe.path &&
            String(entry.method ?? "").toUpperCase() === "GET" &&
            (observedStatus === null || entry.status === observedStatus),
        );
        if (!matchesRequest) {
          probeFailures.push(
            `${probe.path}: no single access-log line records a GET on that exact path answering ` +
              `${observedStatus ?? "(none)"} for its marker.`,
          );
        }
      }
    }
    if (!isMapped && reachedApp) {
      probeFailures.push(
        `${probe.path}: its marker APPEARS in the access log — the mapping forwarded a path it must never admit.`,
      );
    }

    results.push({
      path: probe.path,
      marker: probe.marker,
      role: isMapped ? "mapped" : isDescendantOfMapped ? "refused-at-proxy" : "refused-at-edge",
      expectedStatus,
      observedStatus,
      reachedApp,
      ok: probeFailures.length === 0,
      failures: probeFailures,
    });
    failures.push(...probeFailures);
  }

  return { ok: failures.length === 0, results, failures };
}

// --- reusing a proxy that is already running ------------------------------

/**
 * Which port the mapping must be written for.
 *
 * The trap this closes: `up` can find a LIVE, verified proxy and no sidecar
 * (the sidecar was stopped, the proxy was not). Writing the mapping for the
 * flag's default port in that state would publish the tunnel at a port this
 * mode never verified — possibly the app itself, which would hand every
 * descendant path straight past the exact-match refusal. So a reused proxy's
 * OWN recorded port is the only port the mapping may name, and a request that
 * contradicts the running proxy is refused rather than reconciled silently.
 *
 * @param {{ live: boolean, recorded: object|null, requestedPort: number,
 *           portWasExplicit?: boolean, upstreamPort: number }} args
 * @returns {number} the port the serve config must be written for
 */
export function decideVerificationExposureProxyPort({
  live,
  recorded,
  requestedPort,
  portWasExplicit = false,
  upstreamPort,
}) {
  if (!live) return requestedPort;
  const recordedPort = recorded && typeof recorded.proxyPort === "number" ? recorded.proxyPort : null;
  if (!Number.isInteger(recordedPort)) {
    throw new Error(
      "A verification exposure proxy is running for this instance but its record " +
        "names no port, so the mapping cannot be written for it. Run " +
        "`cinatra instance verify-exposure down` and start it again.",
    );
  }
  if (portWasExplicit && requestedPort !== recordedPort) {
    throw new Error(
      `A verification exposure proxy is already running on 127.0.0.1:${recordedPort}, ` +
        `but --proxy-port asked for ${requestedPort}. Run ` +
        `\`cinatra instance verify-exposure down\` first, then bring it up on the port you want.`,
    );
  }
  const recordedUpstream =
    recorded && typeof recorded.upstreamPort === "number" ? recorded.upstreamPort : null;
  if (Number.isInteger(recordedUpstream) && recordedUpstream !== upstreamPort) {
    throw new Error(
      `The running verification exposure proxy forwards to 127.0.0.1:${recordedUpstream}, ` +
        `but this checkout's app port is ${upstreamPort}. Run ` +
        `\`cinatra instance verify-exposure down\` before publishing again.`,
    );
  }
  return recordedPort;
}

// --- artifacts left on disk ----------------------------------------------

/**
 * Every runtime directory of THIS mode that still holds something published —
 * a rendered compose file or a proxy record.
 *
 * `down` needs this for the state where the identity helper has gone away
 * AFTER a successful `up`: the identity gate can no longer name the slug, and
 * saying "nothing was running" there would be a lie told over a live public
 * exposure. An empty result is the proof that lets `down` say it honestly.
 */
export function listVerificationExposureArtifacts({ home } = {}) {
  const root = path.join(home ?? os.homedir(), ".cinatra", "verification-exposure");
  let slugs = [];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (err) {
    // NO root at all is the honest empty answer. Any OTHER failure (a
    // permission error, say) means the question "is anything published?" was
    // not answered, and the caller must never read that as "nothing is".
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const found = [];
  for (const slug of slugs.sort()) {
    const dir = path.join(root, slug);
    const composePath = path.join(dir, "compose.yml");
    const proxyStatePath = path.join(dir, "proxy.json");
    const hasCompose = existsSync(composePath);
    const hasProxy = existsSync(proxyStatePath);
    if (hasCompose || hasProxy) found.push({ slug, dir, hasCompose, hasProxy });
  }
  return found;
}

// --- one lifecycle operation at a time ------------------------------------

/**
 * The lock file `up` and `down` hold while they mutate this mode's state.
 *
 * DELIBERATELY OUTSIDE the per-instance runtime directory. Taking the lock
 * must not CREATE that directory: an ownership manifest is what proves who a
 * runtime directory belongs to, and a directory conjured by the lock would
 * exist with no manifest — which the ownership rules (correctly) refuse to
 * adopt for any identity but the reserved main one. Locking would then break
 * the first `up` of every other instance. So locks live in their own sibling
 * folder, which carries no ownership meaning and is never scanned as a
 * published exposure.
 */
export function verificationExposureLockPath(slug, { home } = {}) {
  assertSlug(slug);
  return path.join(
    home ?? os.homedir(),
    ".cinatra",
    "verification-exposure",
    ".locks",
    `${slug}.lock`,
  );
}

/**
 * Take the per-instance lifecycle lock, or refuse.
 *
 * Two concurrent `up` runs would each pass their own handshake and then
 * overwrite each other's proxy record, serve config and compose file — and one
 * failure path would stop the OTHER run's proxy, leaving the published mapping
 * pointing at nothing. One writer at a time is the fix.
 *
 * A lock whose owner is gone (a killed `up`) is stale and is taken over: a
 * crashed run must not wedge the verb forever.
 *
 * @returns {() => void} release
 */
export function acquireVerificationExposureLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  // THIS LOCK NEVER TAKES ANOTHER PROCESS'S LOCK AWAY, and that is a deliberate
  // design choice rather than an omission.
  //
  // An automatic "the owner is dead, so seize it" path cannot be made
  // race-free with the primitives available here: reading the owner and then
  // removing or renaming the file are separate steps, and between them the
  // path can be re-claimed by a live contender — whose lock the takeover would
  // then destroy, letting two lifecycle runs proceed at once. That is the
  // exact failure a lock exists to prevent, so this one refuses instead: a
  // leftover lock is reported, with its path, and the operator removes it. A
  // crashed run therefore costs one explicit `rm`, and nothing this code does
  // can ever delete a lock it does not own.
  //
  // The claim itself is atomic and complete: the owner record is written to a
  // private temp file and LINKED into place, so the lock never exists as an
  // empty, ownerless file, and a second claimant fails EEXIST rather than
  // overwriting.
  const fingerprintOf = (target) => {
    try {
      const stats = statSync(target);
      return `${stats.dev}:${stats.ino}`;
    } catch {
      return null;
    }
  };

  const scratch = `${lockPath}.${process.pid}.${Date.now()}`;
  writeFileSync(scratch, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  let token = null;
  try {
    linkSync(scratch, lockPath);
    token = fingerprintOf(scratch);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  } finally {
    rmSync(scratch, { force: true });
  }

  if (!token) {
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, "utf8"))?.pid ?? null;
    } catch {
      holder = null;
    }
    const alive = typeof holder === "number" && lockHolderIsAlive(holder);
    throw new Error(
      alive
        ? `Another \`cinatra instance verify-exposure\` operation (pid ${holder}) is in ` +
          `flight for this instance. Wait for it to finish.`
        : `A \`cinatra instance verify-exposure\` lifecycle lock is in place at ` +
          `${lockPath}${typeof holder === "number" ? ` (recorded pid ${holder}, which is gone)` : ""}, ` +
          `left behind by a run that did not finish. Check that no tunnel or proxy is ` +
          `still running (\`cinatra instance verify-exposure status\`), then remove that ` +
          `file to continue. This verb never removes a lock it does not own.`,
    );
  }

  return () => {
    // Release only what we still hold. Nothing here ever takes a lock away
    // automatically, so the only way this check can fail to match is an
    // operator who removed ours by hand — in which case there is nothing to
    // remove.
    //
    // KNOWN RESIDUAL, stated rather than hidden: the check and the unlink are
    // two calls, and Node exposes no inode-guarded unlink to fuse them. An
    // operator who deletes this lock by hand in the microseconds between them,
    // while another run claims the path in the same window, would have that
    // run's lock removed. It needs a hand-deletion of a live lock to happen at
    // all, and its cost is two concurrent dev-only lifecycle runs — the same
    // state the operator's own deletion was asking for.
    if (fingerprintOf(lockPath) !== token) return;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // A lock we cannot remove is reported to the next run, which refuses
      // rather than guessing — the safe direction.
    }
  };
}

function lockHolderIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// --- `down`'s outcome -----------------------------------------------------

/**
 * What `down` should say. `down` is idempotent by construction: running it on
 * a state where nothing was ever published is a success that SAYS so, not an
 * error and not a misleading "stopped".
 *
 * @param {{ identityResolvable: boolean, sidecarTornDown: boolean,
 *           proxyStopped: boolean }} state
 * @returns {{ nothingWasRunning: boolean, message: string }}
 */
export function describeVerificationExposureDownOutcome({
  identityResolvable,
  sidecarTornDown,
  proxyStopped,
}) {
  if (!identityResolvable) {
    return {
      nothingWasRunning: true,
      message:
        "cinatra instance verify-exposure down: no tunnel identity is resolvable " +
        "(the identity helper is not installed), so nothing was running and " +
        "nothing was torn down. This verb never guesses an identity.",
    };
  }
  if (!sidecarTornDown && !proxyStopped) {
    return {
      nothingWasRunning: true,
      message:
        "cinatra instance verify-exposure down: nothing was running — no verification " +
        "exposure tunnel and no access-logging proxy were published for this instance.",
    };
  }
  const parts = [];
  if (sidecarTornDown) parts.push("the verification exposure tunnel");
  if (proxyStopped) parts.push("the access-logging proxy");
  return {
    nothingWasRunning: false,
    message: `cinatra instance verify-exposure down: tore down ${parts.join(" and ")}.`,
  };
}
