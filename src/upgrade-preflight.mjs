// ---------------------------------------------------------------------------
// Fail-closed upgrade preflight with per-service adapters (cinatra-cli#128,
// upgrade-paths epic cinatra-ai/cinatra#1419).
//
// PURPOSE. Consulted BEFORE any stateful container is recreated. For each
// stateful service it DETECTS the deployed data-format version, evaluates it
// against the target the new image ships (using the supported matrix as the
// decision table), and returns a per-service VERDICT. An older-major data dir
// facing a naive recreate becomes a GUIDED STOP (naming the incompatibility, the
// backup step, and the sanctioned migration command) — never the silent
// crash-loop of cinatra-ai/cinatra#1417.
//
// DETECTION IS AN ADAPTER CHAIN, NOT ONE GENERIC MARKER PARSER. Per service, in
// order:
//   1. RECORDED LEDGER version (PRIMARY) — bound to the volume's identity. A
//      ledger/volume identity MISMATCH is itself a fail-closed finding; a leftover
//      migration journal is a fail-closed "interrupted migration".
//   2. A supported LIVE PROBE (e.g. `SELECT version()`, vendor status tools).
//   3. A raw ON-DISK MARKER ONLY where authoritative (Postgres `PG_VERSION`),
//      read from the deployment's ACTUAL data path (the pg18 images changed the
//      data layout — the path comes from the deployment, never an assumption).
//
// DECISION. detected-vs-target against the matrix:
//   - disabled profile / empty volume → explicit NON-findings (skipped / pass).
//   - matching versions → pass.
//   - supported forward hop pending → STOP with the migration pointer + backup
//     step + runbook link.
//   - downgrade → BLOCKED. unsupported hop / unknown / unreadable / mismatch /
//     interrupted migration → FAIL CLOSED.
//
// SCOPED ESCAPE PATH. A transition-scoped authorization ({ service, source,
// target }) may bypass ONLY the recreate STOP for the EXACT transition it names —
// never the eligibility check. Unknown/unsupported/downgrade stay blocked even
// WITH an authorization (the authorization is consulted only inside the
// supported-forward-hop branch); there is no generic force flag.
//
// SHAPE. The decision core is PURE (no I/O — the unit of test). The orchestrator
// gathers facts through an INJECTED transport (docker inspect / probe / marker
// reads), so the whole preflight is exercised end-to-end in tests with a mocked
// transport and never boots a container. Import-light: only the pure matrix +
// ledger modules (both node-builtin-only).
// ---------------------------------------------------------------------------

import {
  DEFAULT_UPGRADE_MATRIX,
  UPGRADE_RUNBOOK_URL,
  compareVersions,
  serviceEntry,
  serviceMarkerFile,
  supportedTransition,
} from "./upgrade-matrix.mjs";
import { getEntry, pendingFor, readLedger } from "./version-ledger.mjs";

// Verdict vocabulary. `pass` / `skipped` are non-findings; `stop` is the guided
// supported-upgrade halt; `authorized-proceed` is a stop bypassed by a matching
// scoped authorization; `blocked` (downgrade) and `fail-closed` (everything
// unsafe) both HALT a recreate. `blocks()` is the single predicate the recreate
// caller gates on.
export const VERDICTS = Object.freeze({
  PASS: "pass",
  SKIPPED: "skipped",
  STOP: "stop",
  AUTHORIZED_PROCEED: "authorized-proceed",
  BLOCKED: "blocked",
  FAIL_CLOSED: "fail-closed",
});

/** True iff a verdict must HALT a container recreate. */
export function blocks(verdict) {
  return verdict === VERDICTS.STOP || verdict === VERDICTS.BLOCKED || verdict === VERDICTS.FAIL_CLOSED;
}

// --- volume identity -------------------------------------------------------

/** Extract a stable volume identity from a `docker volume inspect` row. Pure.
 *  `createdAt` changes when a same-named volume is destroyed+recreated, so
 *  (name, createdAt) distinguishes "the SAME volume the ledger recorded" from "a
 *  new volume that happens to reuse the name". Returns null on a malformed row. */
export function volumeIdentityFromInspect(row) {
  if (!row || typeof row !== "object") return null;
  const name = row.Name;
  const createdAt = row.CreatedAt;
  if (typeof name !== "string" || !name.length) return null;
  if (typeof createdAt !== "string" || !createdAt.length) return null;
  return { name, createdAt };
}

/** Compare a recorded ledger volume identity against the live one.
 *  Returns "match" | "mismatch" | "absent" (no live volume at all). */
export function volumeIdentityStatus(recorded, live) {
  if (!live) return "absent";
  if (!recorded) return "absent";
  return recorded.name === live.name && recorded.createdAt === live.createdAt ? "match" : "mismatch";
}

// --- detection (pure over already-gathered facts) --------------------------

/**
 * Detect the deployed data-format version for one service from the facts the
 * transport gathered. PURE. Returns:
 *   { version, source, finding }
 *     - version: the detected version string, or null when nothing authoritative
 *       resolved it.
 *     - source: "ledger" | "probe" | "marker" | null
 *     - finding: null on a clean detection, else a fail-closed reason string
 *       ("ledger-volume-mismatch" | "interrupted-migration") that the decision
 *       turns into a fail-closed verdict REGARDLESS of any probe/marker value.
 *
 * Precedence: a ledger entry (bound to a MATCHING live volume) wins outright — it
 * is the PRIMARY source and short-circuits the probe/marker. A ledger/volume
 * mismatch or an interrupted migration is a HARD finding (we do not silently fall
 * through to a probe, which could read a half-migrated volume). Only a LEGACY
 * install with no ledger entry falls through to probe → marker.
 */
export function detectVersion({ service, ledger, liveVolumeIdentity, probeVersion, markerVersion }) {
  const pending = pendingFor(ledger, service);
  if (pending) {
    return { version: null, source: null, finding: "interrupted-migration" };
  }
  const entry = getEntry(ledger, service);
  if (entry) {
    const status = volumeIdentityStatus(entry.volume, liveVolumeIdentity);
    if (status !== "match") {
      return { version: null, source: null, finding: "ledger-volume-mismatch" };
    }
    return { version: entry.dataFormatVersion ?? null, source: "ledger", finding: null };
  }
  // Legacy install (no ledger entry) → probe, then authoritative raw marker.
  if (probeVersion != null && probeVersion !== "") {
    return { version: String(probeVersion), source: "probe", finding: null };
  }
  if (markerVersion != null && markerVersion !== "") {
    return { version: String(markerVersion), source: "marker", finding: null };
  }
  return { version: null, source: null, finding: null };
}

// --- decision (pure) -------------------------------------------------------

function verdict(service, verdict, reason, extra = {}) {
  return { service, verdict, reason, ...extra };
}

/**
 * Evaluate a single service's preflight verdict. PURE — the unit of test.
 *
 * @param {object} a
 * @param {string} a.service
 * @param {string|null} a.detected     detected data-format version (null ⇒ unknown)
 * @param {string|null} a.detectionFinding  a hard finding from detectVersion
 *   ("ledger-volume-mismatch" | "interrupted-migration") or null
 * @param {string|null} a.target       the version the new image ships (null ⇒ unknown)
 * @param {"empty"|"present"|"absent"} a.volumeState  empty/absent ⇒ fresh init
 * @param {boolean} a.profileEnabled   false ⇒ the service is not deployed here
 * @param {object}  a.matrix           the supported matrix (decision table)
 * @param {{service,source,target}|null} a.authorization  scoped escape (exact match only)
 * @param {string|null} a.detectionSource  where `detected` came from (for the message)
 */
export function decideService({
  service,
  detected,
  detectionFinding = null,
  detectionSource = null,
  target,
  volumeState = "present",
  profileEnabled = true,
  matrix = DEFAULT_UPGRADE_MATRIX,
  authorization = null,
}) {
  if (profileEnabled === false) {
    return verdict(service, VERDICTS.SKIPPED, "profile disabled — service not deployed here");
  }
  // A service the matrix does not know cannot be reasoned about → fail closed.
  if (!serviceEntry(matrix, service)) {
    return verdict(service, VERDICTS.FAIL_CLOSED, `unknown service "${service}" — not in the supported matrix`, {
      remediation: unknownRemediation(service),
    });
  }
  if (detectionFinding === "interrupted-migration") {
    return verdict(service, VERDICTS.FAIL_CLOSED, "a migration was interrupted (pending journal present)", {
      remediation:
        `Restore ${service} from backup (or complete/roll back the in-flight migration) before recreating the ` +
        `container. See ${UPGRADE_RUNBOOK_URL}.`,
    });
  }
  if (detectionFinding === "ledger-volume-mismatch") {
    return verdict(service, VERDICTS.FAIL_CLOSED, "recorded ledger version does not match the live volume identity", {
      remediation:
        `The ${service} volume was recreated out-of-band — its data-format version is unknown. Back up and verify ` +
        `it before recreating the container. See ${UPGRADE_RUNBOOK_URL}.`,
    });
  }
  // Empty / absent volume → fresh init, always safe (explicit non-finding).
  if (volumeState === "empty" || volumeState === "absent") {
    return verdict(service, VERDICTS.PASS, "empty/fresh volume — nothing to migrate");
  }
  if (detected == null) {
    return verdict(service, VERDICTS.FAIL_CLOSED, "deployed version is unknown/unreadable on a non-empty volume", {
      remediation: unknownRemediation(service),
    });
  }
  // INTEGRITY-ONLY mode: no target supplied (a standalone `upgrade-preflight`
  // with no proposed hop). Detection was clean and the volume is bound + readable
  // — nothing to migrate. The recreate CALLER always supplies a target; if IT
  // cannot determine one it constructs its own fail-closed finding rather than
  // calling with a null target.
  if (target == null) {
    return verdict(service, VERDICTS.PASS, `recorded ${detected} — no target specified (integrity check only)`, {
      detected,
      target: null,
      detectionSource,
    });
  }
  // DELIBERATE: identical detected/target strings pass even off the matrix
  // axis — equal versions mean the recreate deploys the very version the
  // volume already runs, i.e. NO data-format transition exists to guard. The
  // axis only orders NON-equal pairs (below), where unknown = fail closed.
  if (String(detected) === String(target)) {
    return verdict(service, VERDICTS.PASS, `matching versions (${detected})`, { detected, target, detectionSource });
  }
  const cmp = compareVersions(matrix, service, detected, target);
  if (cmp === null) {
    return verdict(
      service,
      VERDICTS.FAIL_CLOSED,
      `unknown/unordered version (detected ${detected} → target ${target})`,
      { detected, target, detectionSource, remediation: unknownRemediation(service) },
    );
  }
  if (cmp > 0) {
    return verdict(service, VERDICTS.BLOCKED, `downgrade blocked (detected ${detected} → target ${target})`, {
      detected,
      target,
      detectionSource,
      remediation:
        `Downgrading ${service} from ${detected} to ${target} is unsafe and unsupported. Pin the previous image ` +
        `or restore a matching backup. See ${UPGRADE_RUNBOOK_URL}.`,
    });
  }
  // Forward hop. Must be an EXPLICITLY supported transition (adjacency is not
  // sufficient) or it is an unsupported hop → fail closed.
  const transition = supportedTransition(matrix, service, detected, target);
  if (!transition) {
    return verdict(
      service,
      VERDICTS.FAIL_CLOSED,
      `unsupported upgrade hop (detected ${detected} → target ${target})`,
      {
        detected,
        target,
        detectionSource,
        remediation:
          `No supported ${service} upgrade path from ${detected} to ${target}. Back up your data and consult ` +
          `${UPGRADE_RUNBOOK_URL}.`,
      },
    );
  }
  // Supported forward hop. A scoped authorization for the EXACT (service, source,
  // target) may bypass ONLY this stop — nothing above it.
  if (authorizationMatches(authorization, service, detected, target)) {
    return verdict(service, VERDICTS.AUTHORIZED_PROCEED, `authorized ${service} transition ${detected} → ${target}`, {
      detected,
      target,
      detectionSource,
      migration: transition.migration,
    });
  }
  return verdict(service, VERDICTS.STOP, `supported upgrade pending (detected ${detected} → target ${target})`, {
    detected,
    target,
    detectionSource,
    migration: transition.migration,
    caseScoped: Boolean(transition.caseScoped),
    remediation:
      `Back up ${service} first, then run \`${transition.migration}\` to migrate ${detected} → ${target} before ` +
      `recreating the container. See ${UPGRADE_RUNBOOK_URL}.`,
  });
}

function unknownRemediation(service) {
  return (
    `Refusing to recreate the ${service} container while its data-format version is unknown — a mismatched major ` +
    `would crash-loop. Back up the volume and determine its version. See ${UPGRADE_RUNBOOK_URL}.`
  );
}

/** An authorization matches ONLY when it names the EXACT (service, source→target)
 *  transition being evaluated. Never a wildcard, never a generic force. */
export function authorizationMatches(authorization, service, source, target) {
  if (!authorization || typeof authorization !== "object") return false;
  return (
    authorization.service === service &&
    String(authorization.source) === String(source) &&
    String(authorization.target) === String(target)
  );
}

// --- orchestration (injected transport; no direct I/O here) ----------------

/**
 * @typedef {Object} PreflightTransport
 * @property {(name: string) => object|null} inspectVolume  parsed `docker volume
 *   inspect` row for a volume name (or null when the volume does not exist).
 * @property {(name: string) => "empty"|"present"|"absent"} volumeState  whether
 *   the named volume holds data (best-effort; "absent" when it does not exist).
 * @property {(service: string) => string|null} probeVersion  a live version probe
 *   (e.g. `SELECT version()`), or null when unavailable/unsupported.
 * @property {(service: string, marker: string) => string|null} readMarker  the raw
 *   on-disk marker value read from the deployment's ACTUAL data path (Postgres
 *   `PG_VERSION`), or null.
 * @property {(service: string) => boolean} profileEnabled  whether the service's
 *   compose profile is enabled for this deployment.
 */

/**
 * Run the preflight for a set of services on one instance. Reads the ledger,
 * then for each requested service gathers live facts via the injected transport,
 * detects the deployed version through the adapter chain, and decides a verdict.
 * Returns { ok, findings[], results[] } where `results` is every per-service
 * verdict and `findings` is the subset that BLOCKS a recreate; `ok` is true iff
 * nothing blocks (an all-clear preflight — safe to recreate).
 *
 * @param {object} a
 * @param {string} a.slug                 instance slug (ledger key)
 * @param {Array<{service,target,volumeName}>} a.services  services to check +
 *   the target version each new image ships + the volume name backing each
 *   (the ACTUAL volume name from the deployment — never assumed).
 * @param {PreflightTransport} a.transport
 * @param {object}  [a.matrix]            supported matrix (defaults to shipped)
 * @param {string}  [a.ledgerDir]         ledger dir override (tests)
 * @param {Array<{service,source,target}>} [a.authorizations]  scoped escapes
 */
export function runPreflight({
  slug,
  services,
  transport,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  authorizations = [],
}) {
  const read = readLedger(slug, ledgerDir);
  // A malformed ledger is a fail-closed condition for EVERY service — never
  // silently treated as "no recorded version" (that would reopen the naive
  // recreate hazard the ledger exists to close).
  if (read.status === "malformed") {
    const results = services.map((s) =>
      verdict(s.service, VERDICTS.FAIL_CLOSED, "deployed-version ledger is malformed — refusing to recreate blind", {
        remediation: `Repair the ledger for instance "${slug}" (see the version-ledger docs), then retry.`,
      }),
    );
    return { ok: false, findings: results.slice(), results };
  }
  const ledger = read.ledger;
  const authIndex = new Map();
  for (const a of authorizations ?? []) {
    if (a && a.service) authIndex.set(`${a.service}`, a);
  }

  const results = [];
  for (const spec of services) {
    const { service, target, volumeName } = spec;
    const profileEnabled = transport.profileEnabled ? transport.profileEnabled(service) : true;
    if (profileEnabled === false) {
      results.push(decideService({ service, profileEnabled: false, matrix }));
      continue;
    }

    // Discovery could not identify the service's DATA volume (bind-mounted
    // data path / ambiguous mounts / unresolvable volume name): the service
    // cannot be checked, so recreating it cannot be cleared — fail closed.
    if (spec.volumeUnidentified) {
      results.push(
        verdict(service, VERDICTS.FAIL_CLOSED, `data volume could not be identified (${spec.volumeUnidentified})`, {
          remediation:
            `Refusing to clear a ${service} recreate while its data volume cannot be identified. ` +
            `See ${UPGRADE_RUNBOOK_URL}.`,
        }),
      );
      continue;
    }

    const inspectRow = volumeName && transport.inspectVolume ? transport.inspectVolume(volumeName) : null;
    const liveVolumeIdentity = volumeIdentityFromInspect(inspectRow);
    const volumeState = transport.volumeState ? transport.volumeState(volumeName) : inspectRow ? "present" : "absent";

    const markerFile = serviceMarkerFile(matrix, service);
    const markerVersion =
      markerFile && transport.readMarker ? transport.readMarker(service, markerFile) : null;
    const probeVersion = transport.probeVersion ? transport.probeVersion(service) : null;

    const detection = detectVersion({
      service,
      ledger,
      liveVolumeIdentity,
      probeVersion,
      markerVersion,
    });

    results.push(
      decideService({
        service,
        detected: detection.version,
        detectionFinding: detection.finding,
        detectionSource: detection.source,
        target,
        volumeState,
        profileEnabled: true,
        matrix,
        authorization: authIndex.get(service) ?? null,
      }),
    );
  }

  const findings = results.filter((r) => blocks(r.verdict));
  return { ok: findings.length === 0, findings, results };
}

// --- rendering + command entrypoint ----------------------------------------

const USAGE =
  "Usage: cinatra instance db upgrade-preflight [--service <name>] [--target <service>=<version>] [--json]\n" +
  "  Read-only: detects each stateful service's deployed data-format version and\n" +
  "  reports whether recreating its container is safe (fail-closed on unknowns).\n" +
  "  With no --target, runs an integrity-only check; --target models a proposed hop.";

/** Parse the args AFTER `cinatra instance db upgrade-preflight`. Strict: an
 *  unknown flag is rejected (never silently ignored). `--service` and `--target`
 *  may repeat. `--target` is `<service>=<version>` (the version the NEW image
 *  would ship for that service). */
export function parsePreflightArgs(argv) {
  let json = false;
  const only = [];
  const targets = {};
  let slug = null;
  const readValue = (a, i) => {
    const v = a.includes("=") && a.indexOf("=") < a.length - 1 ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--service" || a.startsWith("--service=")) {
      const inline = a.startsWith("--service=");
      const v = inline ? a.slice("--service=".length) : argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value for --service.");
      only.push(v);
      continue;
    }
    if (a === "--instance" || a.startsWith("--instance=")) {
      const inline = a.startsWith("--instance=");
      const v = inline ? a.slice("--instance=".length) : argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value for --instance.");
      slug = v;
      continue;
    }
    if (a === "--target" || a.startsWith("--target=")) {
      const inline = a.startsWith("--target=");
      const v = inline ? a.slice("--target=".length) : argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value for --target.");
      const eq = v.indexOf("=");
      if (eq <= 0 || eq === v.length - 1) {
        throw new Error(`--target must be <service>=<version> (got "${v}").`);
      }
      targets[v.slice(0, eq)] = v.slice(eq + 1);
      continue;
    }
    throw new Error(`Unexpected argument "${a}" for cinatra instance db upgrade-preflight. ${USAGE}`);
  }
  return { json, only, targets, slug };
}

/** Render a preflight report to human-readable lines. Pure (returns a string). */
export function formatReport(report) {
  const lines = [];
  const order = [VERDICTS.FAIL_CLOSED, VERDICTS.BLOCKED, VERDICTS.STOP, VERDICTS.AUTHORIZED_PROCEED, VERDICTS.PASS, VERDICTS.SKIPPED];
  const label = {
    [VERDICTS.FAIL_CLOSED]: "FAIL-CLOSED",
    [VERDICTS.BLOCKED]: "BLOCKED",
    [VERDICTS.STOP]: "STOP",
    [VERDICTS.AUTHORIZED_PROCEED]: "AUTHORIZED",
    [VERDICTS.PASS]: "ok",
    [VERDICTS.SKIPPED]: "skipped",
  };
  const sorted = [...report.results].sort(
    (a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.service.localeCompare(b.service),
  );
  for (const r of sorted) {
    lines.push(`  [${label[r.verdict] ?? r.verdict}] ${r.service}: ${r.reason}`);
    if (r.remediation) lines.push(`      → ${r.remediation}`);
    else if (r.migration && r.verdict === VERDICTS.AUTHORIZED_PROCEED) {
      lines.push(`      → authorized to proceed via \`${r.migration}\``);
    }
  }
  if (report.ok) {
    lines.push("");
    lines.push("Preflight OK — no blocking findings; recreating stateful containers is safe.");
  } else {
    lines.push("");
    lines.push(
      `Preflight BLOCKED — ${report.findings.length} finding(s) must be resolved before recreating stateful containers.`,
    );
  }
  return lines.join("\n");
}

/**
 * Command entrypoint. Runs the preflight and renders it; returns the process
 * exit code (0 = safe / all non-findings, 1 = at least one blocking finding).
 *
 * The REAL fact-gathering transport (docker volume inspect, live probes, on-disk
 * PG_VERSION reads) + the service/target/volume-name discovery from the running
 * deployment are injected by index.mjs's handler (`buildTransport` + `discover`);
 * this function stays pure over those seams so it is fully driven by a mocked
 * transport in tests. `deps.log` captures output for tests.
 */
export function runPreflightCommand(argv, deps = {}) {
  let parsed;
  try {
    parsed = parsePreflightArgs(argv);
  } catch (err) {
    (deps.logError ?? console.error)(err.message);
    return 2;
  }
  const log = deps.log ?? console.log;

  let services;
  try {
    services = (deps.discover ?? (() => []))(parsed);
  } catch (err) {
    (deps.logError ?? console.error)(`upgrade-preflight: ${err.message}`);
    return 2;
  }
  if (parsed.only.length) {
    const want = new Set(parsed.only);
    services = services.filter((s) => want.has(s.service));
  }
  // `--target <service>=<version>` overrides the target the discovery derived
  // (or supplies one for an integrity-only discovery). A target for an
  // undiscovered service is ignored (nothing to check it against).
  if (parsed.targets && Object.keys(parsed.targets).length) {
    services = services.map((s) =>
      Object.prototype.hasOwnProperty.call(parsed.targets, s.service)
        ? { ...s, target: parsed.targets[s.service] }
        : s,
    );
  }
  if (!services.length) {
    log("No stateful services to check (none deployed, or --service matched nothing).");
    return 0;
  }

  const report = runPreflight({
    slug: deps.slug ?? parsed.slug,
    services,
    transport: deps.transport,
    matrix: deps.matrix ?? DEFAULT_UPGRADE_MATRIX,
    ledgerDir: deps.ledgerDir,
    authorizations: deps.authorizations ?? [],
  });

  if (parsed.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(formatReport(report));
  }
  return report.ok ? 0 : 1;
}

export const __test = {
  USAGE,
  volumeIdentityFromInspect,
  volumeIdentityStatus,
  detectVersion,
  decideService,
  authorizationMatches,
  runPreflight,
  parsePreflightArgs,
  formatReport,
  runPreflightCommand,
  blocks,
};
