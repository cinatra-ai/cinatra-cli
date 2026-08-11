// ---------------------------------------------------------------------------
// Preview endpoint OWNERSHIP verification (cinatra-ai/cinatra-cli#219).
//
// WHY THIS EXISTS: the preview composition decides where this instance's
// services live by STRING MANIPULATION. `rewriteLoopbackUrlForContainer`
// (`preview.mjs`) swaps a host-loopback hostname for the container's host
// gateway and returns — it cannot tell whether `host.docker.internal:<port>` is
// THIS instance's service or a different stack's that happens to hold that host
// port. When it is not, the preview silently reads and writes another
// instance's data and stays healthy throughout, because the app reached *a*
// working service.
//
// That is not hypothetical: cinatra-cli#219 reproduced it on a default-ports
// install whose own containers had lost their publications while another
// compose project held the same ports. Health stayed 200 {"status":"ok"} the
// whole time.
//
// THE CHECK: the install path already inspects live, checkout-owned Compose
// containers and uses their published ports as its authoritative conflict gate
// (`install.mjs`'s `ownershipFromInspect` / `targetComposeOwnership`). This
// module applies the SAME proof on the preview path — a container's compose
// `working_dir` label rooted at THIS checkout is what makes its published host
// ports ours — and refuses the composition when a container-dialed endpoint
// resolves somewhere else.
//
// It deliberately does NOT re-implement that gate inside `install.mjs`: the
// preview lifecycle must not import `install.mjs` (which lazy-imports the
// preview composition), so this is a standalone, node-builtins-only module that
// both the lifecycle and its tests can use. The LABEL CONTRACT and the
// interface-aware port key are kept identical to the install path's on purpose;
// a unit test pins the label names so the two cannot drift apart silently.
//
// SCOPE — deliberately narrow (cinatra-cli#219 AC4):
//   - Only LOCALLY-MANAGED endpoints are checked: a value is checked only when
//     the preview composition would REWRITE it, i.e. it is one of the
//     container-dialed keys AND its host is a loopback address. An external or
//     hosted endpoint (a managed database, the hosted registry) legitimately
//     belongs to no Compose project and is never flagged.
//   - The verdict is about OWNERSHIP, not reachability. This module never
//     claims a service is up, only whose it is.
//
// LEAK DISCIPLINE: the values inspected here are the credential-bearing
// passthrough surface (`SUPABASE_DB_URL` carries a password, `NANGO_SECRET_KEY`
// is a credential). This module accepts values only to extract a PORT NUMBER
// from them, and every message it produces names KEYS, PORTS, CONTAINER NAMES
// and COMPOSE PROJECTS — never a value, never a redacted value, never a length.
// ---------------------------------------------------------------------------

import path from "node:path";

// --- the compose label contract (identical to the install path's) ----------

/** The compose project name label. */
export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
/**
 * The compose project's ROOT DIRECTORY label — the ownership proof. A project
 * NAME can collide (two checkouts with the same basename), the working_dir
 * cannot: it is the absolute path compose resolved the project from.
 */
export const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
/** The compose service name label (diagnostics only). */
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** Bounded timeout for the docker CLI metadata probes this module runs. */
export const OWNERSHIP_PROBE_TIMEOUT_MS = 15_000;

// --- the operator lever ----------------------------------------------------

/**
 * The mode lever. `enforce` (the default) REFUSES the composition when a
 * container-dialed endpoint is not this instance's; `warn` performs the same
 * check and prints the same finding as a loud warning, then proceeds.
 *
 * There is deliberately no "off": the two settings are cinatra-cli#219 AC1's
 * two sanctioned outcomes ("refuses to boot (or boots with an explicit, loud
 * degradation)"), and a silent mode would restore exactly the failure this
 * check exists to end. `warn` is what an operator whose infrastructure is NOT a
 * compose project rooted at the checkout (an operator-managed local service, a
 * co-use instance dialing the donor's stack) uses to proceed deliberately.
 */
export const ENDPOINT_OWNERSHIP_ENV = "CINATRA_PREVIEW_ENDPOINT_OWNERSHIP";
export const ENDPOINT_OWNERSHIP_MODES = Object.freeze(["enforce", "warn"]);
export const ENDPOINT_OWNERSHIP_DEFAULT_MODE = "enforce";

/**
 * The PER-KEY exemption. A loopback address is not always a compose service of
 * this checkout: `--infra=external` with an operator-managed local Postgres, or
 * an SSH/port-forward tunnel to a remote service, is a legitimate topology in
 * which no container can possibly prove ownership. Naming those keys exempts
 * exactly them — the gate stays live for every other endpoint, which is what a
 * blanket `warn` gives up.
 *
 * Comma/space separated key names, e.g. `REDIS_URL,SUPABASE_DB_URL`.
 */
export const ENDPOINT_OWNERSHIP_ALLOW_ENV = "CINATRA_PREVIEW_ENDPOINT_OWNERSHIP_ALLOW";

/** The exempted key set (upper-cased, de-duped). */
export function resolveEndpointOwnershipAllowlist(env = {}) {
  const raw = env?.[ENDPOINT_OWNERSHIP_ALLOW_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Resolve the ownership mode from the environment. FAIL-CLOSED on a bad value,
 * exactly like the build levers: a typo must never silently downgrade a safety
 * gate to something the operator did not ask for.
 */
export function resolveEndpointOwnershipMode(env = {}) {
  const raw = env?.[ENDPOINT_OWNERSHIP_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return ENDPOINT_OWNERSHIP_DEFAULT_MODE;
  const value = raw.trim().toLowerCase();
  if (ENDPOINT_OWNERSHIP_MODES.includes(value)) return value;
  throw new Error(
    `${ENDPOINT_OWNERSHIP_ENV}=${JSON.stringify(raw)} is invalid — accepted values are ` +
      `${ENDPOINT_OWNERSHIP_MODES.join(" | ")} (default ${ENDPOINT_OWNERSHIP_DEFAULT_MODE}). ` +
      `It is not silently ignored: an unrecognised value would leave you believing the ` +
      `endpoint-ownership gate was configured when it was not.`,
  );
}

// --- endpoint → port -------------------------------------------------------

/**
 * The scheme defaults the app's own clients apply when a URL omits the port.
 * Kept SMALL and explicit: an unknown scheme with no explicit port yields
 * `null`, which is reported as UNVERIFIABLE rather than guessed — a guessed
 * port would produce a fabricated ownership verdict.
 */
export const SCHEME_DEFAULT_PORTS = Object.freeze({
  "http:": 80,
  "https:": 443,
  // `redis:` and `rediss:` share ONE default port (6379). The 6380 sometimes
  // seen for TLS is a hosting-provider convention, not the scheme default, and
  // encoding it here would turn a correct 6379 publication into a refusal.
  "redis:": 6379,
  "rediss:": 6379,
  "postgres:": 5432,
  "postgresql:": 5432,
});

/**
 * The host port an endpoint value names, or `null` when it cannot be derived.
 *
 * Takes a possibly credential-bearing value and returns ONLY a number — nothing
 * else about the value ever leaves this function (leak discipline).
 */
export function endpointPortFromValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.port !== "") {
    const n = Number.parseInt(parsed.port, 10);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  }
  return SCHEME_DEFAULT_PORTS[parsed.protocol] ?? null;
}

/** The interface-aware host-port key (the install path's `hostPortKey` shape). */
export function hostPortKey(hostIp, port) {
  const host = typeof hostIp === "string" && hostIp.length > 0 ? hostIp : "0.0.0.0";
  return `${host}:${port}`;
}

// --- ownership from `docker inspect` rows (pure) ---------------------------

/**
 * The ownership snapshot proven by raw `docker inspect` rows: the host-port
 * KEYS, the compose PROJECT names, and a per-container summary — for containers
 * PROVEN rooted at `expectDir` via the compose working_dir label.
 *
 * Only RUNNING containers contribute PORTS: a created/exited/restarting
 * container publishes nothing, so counting its recorded port map as "ours"
 * would re-create the exact defect (cinatra-cli#219 AC2 — a container that is
 * up but publishes no host port must be DETECTED, not papered over). Non-running
 * own containers are still returned in `containers`, because naming them is what
 * turns the refusal into an actionable message.
 *
 * PURE — the unit of test.
 *
 * @param {any[]} inspectRows
 * @param {string} expectDir
 */
export function ownershipFromInspect(inspectRows, expectDir) {
  const ports = new Set();
  const projects = new Set();
  const containers = [];
  if (!Array.isArray(inspectRows) || !expectDir) return { ports, projects, containers };
  const want = path.resolve(String(expectDir));
  for (const row of inspectRows) {
    const labels = row?.Config?.Labels ?? {};
    const workingDir = labels[COMPOSE_WORKING_DIR_LABEL];
    // Ownership proof: this container's compose project is rooted at OUR dir.
    if (typeof workingDir !== "string" || path.resolve(workingDir) !== want) continue;
    const project = labels[COMPOSE_PROJECT_LABEL];
    if (typeof project === "string" && project) projects.add(project);
    const running = row?.State?.Running === true;
    const published = [];
    const portMap = row?.NetworkSettings?.Ports ?? {};
    for (const [spec, bindings] of Object.entries(portMap)) {
      // `spec` is e.g. "5432/tcp"; only TCP is verified (the endpoints are TCP).
      if (!/\/tcp$/i.test(spec)) continue;
      for (const b of Array.isArray(bindings) ? bindings : []) {
        const hp = Number.parseInt(String(b?.HostPort ?? ""), 10);
        if (!Number.isFinite(hp) || hp <= 0) continue;
        published.push(hp);
        // A `0.0.0.0` (or absent) HostIp publishes on all interfaces and so
        // holds any narrower loopback key for the same port; an explicit
        // interface records only its own key. Same rule as the install gate.
        if (running) ports.add(hostPortKey(b?.HostIp, hp));
      }
    }
    containers.push({
      name: typeof row?.Name === "string" ? row.Name.replace(/^\//, "") : "(unnamed)",
      service: typeof labels[COMPOSE_SERVICE_LABEL] === "string" ? labels[COMPOSE_SERVICE_LABEL] : "(unknown)",
      project: typeof project === "string" ? project : "(unknown)",
      state: typeof row?.State?.Status === "string" ? row.State.Status : running ? "running" : "(unknown)",
      running,
      published: [...new Set(published)].sort((a, b) => a - b),
    });
  }
  containers.sort((a, b) => a.name.localeCompare(b.name));
  return { ports, projects, containers };
}

/** True iff `port` is published by the owned snapshot on any interface. */
export function ownsHostPort(ownedPorts, port) {
  if (!(ownedPorts instanceof Set)) return false;
  if (ownedPorts.has(hostPortKey("0.0.0.0", port))) return true;
  for (const key of ownedPorts) {
    const idx = key.lastIndexOf(":");
    if (idx === -1) continue;
    if (Number.parseInt(key.slice(idx + 1), 10) === port) return true;
  }
  return false;
}

/**
 * A holder summary from raw inspect rows (pure): who publishes `port`.
 *
 * RUNNING containers only — a stopped container's recorded port map is history,
 * not a held port, and counting it would manufacture a conflict.
 */
export function holdersFromInspect(inspectRows, port) {
  const holders = [];
  if (!Array.isArray(inspectRows)) return holders;
  for (const row of inspectRows) {
    if (row?.State?.Running !== true) continue;
    const labels = row?.Config?.Labels ?? {};
    const portMap = row?.NetworkSettings?.Ports ?? {};
    let holds = false;
    for (const [spec, bindings] of Object.entries(portMap)) {
      if (!/\/tcp$/i.test(spec)) continue;
      for (const b of Array.isArray(bindings) ? bindings : []) {
        if (Number.parseInt(String(b?.HostPort ?? ""), 10) === port) holds = true;
      }
    }
    if (!holds) continue;
    holders.push({
      name: typeof row?.Name === "string" ? row.Name.replace(/^\//, "") : "(unnamed)",
      project: typeof labels[COMPOSE_PROJECT_LABEL] === "string" ? labels[COMPOSE_PROJECT_LABEL] : null,
      workingDir: typeof labels[COMPOSE_WORKING_DIR_LABEL] === "string" ? labels[COMPOSE_WORKING_DIR_LABEL] : null,
      service: typeof labels[COMPOSE_SERVICE_LABEL] === "string" ? labels[COMPOSE_SERVICE_LABEL] : null,
    });
  }
  return holders;
}

// --- the docker probes (injectable) ----------------------------------------

function inspectIds(ids, deps) {
  const r = deps.runDocker(["inspect", ...ids], { timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS });
  if (r.status !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout ?? "");
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function idList(result) {
  if (!result || result.status !== 0) return null;
  return (result.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * ONE snapshot of every container on this host, from which BOTH questions are
 * answered — who this checkout owns, and who else holds a given host port.
 *
 * Two docker calls TOTAL, regardless of how many endpoints are verified: a
 * per-endpoint holder query would multiply a sluggish daemon's latency by the
 * number of endpoints before anything is built.
 *
 * Containers are matched by the compose `working_dir` LABEL rather than by
 * `compose ps`, so ownership covers every compose project rooted at this
 * checkout — the default project, an ISOLATED install's explicitly-named
 * project, and a legacy basename project alike. `compose ps` would have to
 * guess the project name and would report an isolated stack as absent, turning
 * this guard into a false refusal on the isolated path (#219 AC5).
 *
 * `status: "unavailable"` means the probe itself could not run (no docker CLI,
 * an inspect failure). That is an UNKNOWN, never a mismatch — the caller
 * degrades to a warning rather than claiming an ownership violation it did not
 * observe.
 */
export function inspectContainerWorld({ checkoutDir, deps }) {
  const empty = { status: "unavailable", rows: [], ports: new Set(), projects: new Set(), containers: [] };
  if (!checkoutDir) return empty;
  const dir = path.resolve(String(checkoutDir));
  const ids = idList(deps.runDocker(["ps", "-a", "-q"], { timeoutMs: OWNERSHIP_PROBE_TIMEOUT_MS }));
  if (ids === null) return empty;
  // A successful listing with NO containers is a real, readable answer ("nothing
  // runs on this host"), not a probe failure.
  if (ids.length === 0) return { status: "ok", rows: [], ports: new Set(), projects: new Set(), containers: [] };
  const rows = inspectIds(ids, deps);
  if (rows === null) return empty;
  return { status: "ok", rows, ...ownershipFromInspect(rows, dir) };
}

// --- verification ----------------------------------------------------------

/** The compose projects of the checkout's RUNNING containers. */
export function liveProjects(own) {
  return [...new Set((own?.containers ?? []).filter((c) => c.running).map((c) => c.project))].sort();
}

/**
 * Verify that every container-dialed endpoint the composition would rewrite
 * belongs to THIS instance.
 *
 * `entries` is `[{ key, value }]` — the caller (which owns the rewrite rule)
 * decides WHICH keys are container-dialed and which of their values are
 * host-loopback; this module never re-derives that policy.
 *
 * Verdicts:
 *   - "owned"        — a RUNNING container rooted at this checkout publishes it,
 *                      and no other container publishes the same host port.
 *   - "contested"    — this checkout publishes it AND so does something else.
 *                      Ownership is then NOT conclusive: which listener the
 *                      container's host-gateway dial actually lands on depends
 *                      on the interfaces involved, so this is a violation, not a
 *                      pass. (A publication bound to a single interface does not
 *                      exclude a second listener on another interface of the
 *                      same port.)
 *   - "foreign"      — another docker container publishes it (named).
 *   - "unowned"      — nothing this checkout owns publishes it (a non-docker
 *                      listener, an operator-managed local service, or nothing
 *                      at all).
 *   - "exempt"       — the operator named this key in the allowlist.
 *   - "unverifiable" — no port could be derived from the value (never guessed).
 *   - "unknown"      — the ownership probe could not run at all.
 *
 * "foreign" / "contested" / "unowned" are VIOLATIONS. "unverifiable" /
 * "unknown" are reported as warnings and never block: refusing on evidence we
 * do not have would be a fabricated verdict.
 *
 * ONE MORE REFUSAL, not per-endpoint: when the checkout's own RUNNING containers
 * span MORE THAN ONE compose project, "rooted at this checkout" no longer picks
 * out a single stack — two projects from one directory have separate volumes and
 * therefore separate DATA, so a port published by the stale one is a
 * cross-instance endpoint even though both are "ours". The install path refuses
 * exactly this shape (its legacy self-instance guard, cinatra-cli#159); the
 * preview refuses it here rather than composing against whichever stack happens
 * to hold the port.
 */
export function verifyEndpointOwnership({ entries = [], checkoutDir, deps, allow = new Set() }) {
  const results = [];
  if (entries.length === 0) {
    return {
      probe: "skipped",
      own: { ports: new Set(), projects: new Set(), containers: [] },
      results,
      violations: [],
      warnings: [],
      projectConflict: null,
    };
  }
  const own = inspectContainerWorld({ checkoutDir, deps });
  const here = path.resolve(String(checkoutDir));
  const isOurs = (h) => typeof h.workingDir === "string" && path.resolve(h.workingDir) === here;
  for (const { key, value } of entries) {
    if (allow.has(String(key).toUpperCase())) {
      results.push({ key, port: endpointPortFromValue(value), verdict: "exempt" });
      continue;
    }
    const port = endpointPortFromValue(value);
    if (port === null) {
      results.push({ key, port: null, verdict: "unverifiable" });
      continue;
    }
    if (own.status !== "ok") {
      results.push({ key, port, verdict: "unknown" });
      continue;
    }
    // The holders are read even when we DO publish the port: a single
    // publication does not prove exclusivity, and a second listener on another
    // interface of the same port is precisely how the container's dial can land
    // somewhere else.
    const foreign = holdersFromInspect(own.rows, port).filter((h) => !isOurs(h));
    if (ownsHostPort(own.ports, port)) {
      results.push({
        key,
        port,
        verdict: foreign.length > 0 ? "contested" : "owned",
        // What the publication PROVES depends on the interface it is bound to:
        // an all-interfaces binding cannot coexist with another listener on the
        // same port, a loopback-only one can (see LOOPBACK_ONLY_CAVEAT).
        allInterfaces: own.ports.has(hostPortKey("0.0.0.0", port)) || own.ports.has(hostPortKey("::", port)),
        ...(foreign.length > 0 ? { holders: foreign } : {}),
      });
      continue;
    }
    results.push({ key, port, verdict: foreign.length > 0 ? "foreign" : "unowned", holders: foreign });
  }
  const live = liveProjects(own);
  const verified = results.some((r) => r.verdict === "owned" || r.verdict === "contested");
  const projectConflict = own.status === "ok" && live.length > 1 && verified ? live : null;
  const violations = results.filter(
    (r) => r.verdict === "foreign" || r.verdict === "unowned" || r.verdict === "contested",
  );
  const warnings = results.filter((r) => r.verdict === "unverifiable" || r.verdict === "unknown");
  return { probe: own.status, own, results, violations, warnings, projectConflict };
}

/**
 * The scope statement printed alongside a PASS whose evidence is a
 * loopback-bound publication.
 *
 * The proof this gate can give is "no OTHER container Docker knows about holds
 * this host port". A publication bound to `127.0.0.1` does not exclude a
 * listener on another interface of the same port, and a host-native (non-Docker)
 * process is invisible to `docker inspect` entirely — so on an engine where the
 * container's gateway address is NOT the host loopback, a stranger there would
 * not be caught. Stating that is not a caveat for its own sake: over-claiming a
 * verification is the same class of defect as not verifying at all.
 */
export const LOOPBACK_ONLY_CAVEAT = (keys) =>
  `  NOTE: ${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} published on the host LOOPBACK only. ` +
  `That proves no other CONTAINER holds the port, which is the check this gate can make; it cannot see a ` +
  `host-native listener on a different interface of the same port.`;

/**
 * Render the finding as operator-readable lines. KEY NAMES, PORTS, CONTAINER
 * NAMES and COMPOSE PROJECTS only — never a value (leak discipline).
 */
export function formatOwnershipFinding({ report, checkoutDir, gatewayHost = "host.docker.internal" }) {
  const lines = [];
  const nameHolders = (holders) =>
    holders
      .map(
        (h) =>
          `${h.name}${h.project ? ` (compose project "${h.project}"` : " (no compose project"}` +
          `${h.workingDir ? `, rooted at ${h.workingDir})` : ")"}`,
      )
      .join(", ");
  if (report.projectConflict) {
    lines.push(
      `  ${checkoutDir} has RUNNING containers under more than one compose project ` +
        `(${report.projectConflict.map((p) => `"${p}"`).join(", ")}). Two projects from one directory keep ` +
        `SEPARATE volumes and therefore separate data, so "rooted at this checkout" no longer identifies ONE ` +
        `stack — the endpoint would be composed against whichever of them holds the port. Stop the stale ` +
        `project (\`docker compose -p <project> down\`) and re-run.`,
    );
  }
  for (const r of report.violations) {
    if (r.verdict === "foreign") {
      lines.push(
        `  ${r.key} -> ${gatewayHost}:${r.port} — host port ${r.port} is published by ${nameHolders(r.holders)}, ` +
          `NOT by this instance (${checkoutDir}).`,
      );
    } else if (r.verdict === "contested") {
      lines.push(
        `  ${r.key} -> ${gatewayHost}:${r.port} — this instance publishes host port ${r.port}, but so does ` +
          `${nameHolders(r.holders)}. Ownership is NOT conclusive: a publication bound to one interface does ` +
          `not exclude a second listener on another interface of the same port, so which service the ` +
          `container reaches is undetermined.`,
      );
    } else {
      lines.push(
        `  ${r.key} -> ${gatewayHost}:${r.port} — no container of this instance (${checkoutDir}) publishes host port ` +
          `${r.port}; whatever answers there does not belong to this instance.`,
      );
    }
  }
  const ownLines = report.own.containers.map(
    (c) =>
      `    - ${c.name} (service ${c.service}, project ${c.project}, state ${c.state}): ` +
      (c.published.length > 0
        ? `publishes ${c.published.join(", ")}`
        : `publishes NO host port` + (c.running ? " while RUNNING — it cannot satisfy a host-gateway URL" : "")),
  );
  if (ownLines.length > 0) {
    lines.push(`  This instance's own compose containers:`);
    lines.push(...ownLines);
  } else {
    lines.push(
      `  This instance has NO compose containers rooted at ${checkoutDir} — its stack is not running. ` +
        `Start it (\`docker compose up -d\` in the checkout, or re-run \`cinatra install\`) before composing a preview.`,
    );
  }
  return lines;
}

/**
 * The refusal/warning message for a failed verification. Names the mismatch —
 * which key, which port, who actually holds it — and the two ways forward.
 */
export function ownershipFailureMessage({ report, checkoutDir, mode, gatewayHost }) {
  const headline =
    mode === "warn"
      ? `WARNING: this preview's container-dialed endpoints do NOT all belong to this instance ` +
        `(${ENDPOINT_OWNERSHIP_ENV}=warn — proceeding anyway).`
      : `Refusing to compose this preview: a container-dialed endpoint does not belong to this instance.`;
  return [
    headline,
    ...formatOwnershipFinding({ report, checkoutDir, gatewayHost }),
    `  The preview container dials these addresses through ${gatewayHost ?? "host.docker.internal"}, so a host port held by ` +
      `another stack means the preview would read and write THAT stack's data while reporting healthy ` +
      `(cinatra-ai/cinatra-cli#219).`,
    `  Fix the collision — free the host port and bring this instance's own stack up, or re-band this ` +
      `instance (\`cinatra install --on-conflict=isolated\`) so it publishes ports nothing else holds — ` +
      `then re-run.`,
    `  If an endpoint here is deliberately NOT a compose service of this checkout — an ` +
      `\`--infra=external\` install pointed at an operator-managed local service, or a port-forward/SSH ` +
      `tunnel — no container can prove its ownership. Name those keys in ` +
      `${ENDPOINT_OWNERSHIP_ALLOW_ENV} (comma separated) to exempt exactly them and keep the check live for ` +
      `everything else, or set ${ENDPOINT_OWNERSHIP_ENV}=warn to print this finding instead of enforcing it.`,
  ].join("\n");
}

/**
 * The call site: verify, then REFUSE (enforce) or WARN LOUDLY (warn).
 *
 * Warnings that are not violations (an unverifiable value, an unavailable
 * probe) are always printed and never block.
 */
export function assertEndpointOwnership({ entries = [], checkoutDir, deps, env = {}, gatewayHost }) {
  const mode = resolveEndpointOwnershipMode(env);
  const allow = resolveEndpointOwnershipAllowlist(env);
  const report = verifyEndpointOwnership({ entries, checkoutDir, deps, allow });
  const exempt = report.results.filter((r) => r.verdict === "exempt");
  if (exempt.length > 0) {
    deps.log?.(
      `  ${ENDPOINT_OWNERSHIP_ALLOW_ENV}: ownership NOT verified for ${exempt.map((r) => r.key).join(", ")} ` +
        `(operator-declared non-compose endpoints).`,
    );
  }
  for (const w of report.warnings) {
    deps.log?.(
      w.verdict === "unverifiable"
        ? `  NOTE: ${w.key} names no port this check can derive, so its ownership was NOT verified.`
        : `  NOTE: could not inspect this checkout's own containers, so ${w.key} (host port ${w.port}) ` +
          `ownership was NOT verified — docker metadata was unavailable.`,
    );
  }
  if (report.violations.length === 0 && !report.projectConflict) {
    const owned = report.results.filter((r) => r.verdict === "owned");
    if (owned.length > 0) {
      deps.log?.(
        `  endpoint ownership verified: ` + owned.map((r) => `${r.key} (host port ${r.port})`).join(", "),
      );
      // Say exactly what that verification did and did not establish. A
      // loopback-only publication does not exclude a listener on ANOTHER
      // interface of the same port, and this gate sees only what Docker knows —
      // so claiming more than "no other container holds it" would be an
      // over-claim, and an over-claim is what cinatra-cli#219 is about.
      const loopbackOnly = owned.filter((r) => r.allInterfaces === false).map((r) => r.key);
      if (loopbackOnly.length > 0) deps.log?.(LOOPBACK_ONLY_CAVEAT(loopbackOnly));
    }
    return report;
  }
  const message = ownershipFailureMessage({ report, checkoutDir, mode, gatewayHost });
  if (mode === "warn") {
    (deps.logError ?? deps.log)?.(message);
    return report;
  }
  throw new Error(message);
}

// --- test surface ----------------------------------------------------------

export const __test = {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  COMPOSE_SERVICE_LABEL,
  ENDPOINT_OWNERSHIP_ENV,
  ENDPOINT_OWNERSHIP_MODES,
  ENDPOINT_OWNERSHIP_DEFAULT_MODE,
  SCHEME_DEFAULT_PORTS,
  ENDPOINT_OWNERSHIP_ALLOW_ENV,
  resolveEndpointOwnershipAllowlist,
  liveProjects,
  resolveEndpointOwnershipMode,
  endpointPortFromValue,
  hostPortKey,
  ownershipFromInspect,
  ownsHostPort,
  holdersFromInspect,
  inspectContainerWorld,
  LOOPBACK_ONLY_CAVEAT,
  verifyEndpointOwnership,
  formatOwnershipFinding,
  ownershipFailureMessage,
  assertEndpointOwnership,
};
