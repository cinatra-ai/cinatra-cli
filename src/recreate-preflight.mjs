// ---------------------------------------------------------------------------
// Recreate-path upgrade GATE (cinatra-cli#140, upgrade-paths epic
// cinatra-ai/cinatra#1419).
//
// The install / refresh RECREATE paths (`docker compose up -d` over an EXISTING
// deployment) can replace a stateful service's container across a major
// data-format boundary — the exact silent crash-loop of cinatra-ai/cinatra#1417.
// cli#128 shipped the fail-closed preflight (upgrade-preflight.mjs) + the
// standalone `cinatra instance db upgrade-preflight` command, but the recreate
// paths in install.mjs never consulted it (cli#128 named residual #2). This
// module wires the SAME pure preflight — over the deployment's ACTUAL data
// volumes — into those recreate sites: a STOP / BLOCKED / FAIL-CLOSED verdict
// ABORTS before any container is replaced, carrying the per-family runbook deep
// link the standalone preflight emits (cinatra-ai/cinatra#1421).
//
// SHAPE. `runRecreatePreflight` / `assertRecreateSafe` are PURE over an INJECTED
// discover + transport (the unit of test — the SAME contract exercised in
// upgrade-preflight-transport.test.mjs): they run the preflight and, on any
// blocking finding, `assertRecreateSafe` THROWS a RecreatePreflightError whose
// message is the rendered report. `buildDeploymentPreflight` is the docker-backed
// default that gathers the same facts the standalone command does — the resolved
// compose config as the recreate INTENT (per stateful service: the image a
// recreate WOULD deploy → the target version, and the ACTUAL resolved data
// volume name), `docker volume inspect`, a live `SHOW server_version` probe, and
// the raw `PG_VERSION` marker read from the deployment's real data path — reusing
// the shared version-ledger-capture + pg-adapters seams. `defaultAssertRecreateSafe`
// wires the real spawnSync-backed docker seams so install.mjs's recreate sites
// call ONE gate with no docker plumbing of their own.
//
// FAIL-CLOSED, BUT NEVER FALSE-BLOCKING A FRESH INSTALL. An empty / absent volume
// is a fresh init (PASS); an existing non-empty volume whose version cannot be
// read is FAIL-CLOSED (the crash-loop direction). When the compose config cannot
// be resolved at all (docker down / not a checkout), there is nothing to gate —
// the subsequent bring-up needs the same docker/compose and fails fast with its
// own message, and a fresh install has no volume to protect — so the gate
// PROCEEDS best-effort (logged), never manufacturing a block from a transient
// resolve failure. Import-light: only the pure matrix/ledger/preflight modules +
// the already-shared capture/adapter seams (no back-edge to index.mjs/install.mjs).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

import { makeMarkerReader, makeProbeVersion, PG_MARKER_READ_MOUNT } from "./pg-adapters.mjs";
import { DEFAULT_UPGRADE_MATRIX, imageParts, serviceRunbookUrl } from "./upgrade-matrix.mjs";
import { blocks, formatReport, runPreflight, volumeIdentityFromInspect } from "./upgrade-preflight.mjs";
import { readLedger } from "./version-ledger.mjs";
import { resolveComposeConfig, statefulServicesFromComposeConfig } from "./version-ledger-capture.mjs";

const DOCKER_CLI_PROBE_TIMEOUT_MS = 15_000; // 15s — same budget as index.mjs's read-only probes.
const DOCKER_VOLUME_READ_TIMEOUT_MS = 60_000; // a throwaway container mount + read.

/** The gate's refusal. Carries the structured preflight `report` (its
 *  `findings` are the blocking verdicts) so a caller can render/inspect it; the
 *  `.message` is the already-rendered report (each finding carries its
 *  serviceRunbookUrl per-family deep link). */
export class RecreatePreflightError extends Error {
  constructor(message, report) {
    super(message);
    this.name = "RecreatePreflightError";
    this.report = report;
  }
}

/**
 * PURE decision: run the fail-closed preflight over already-discovered services
 * + an injected transport and report whether recreating is safe. No throw — the
 * caller decides what a block means. Returns { ok, report, services }.
 *
 * `services` empty (nothing stateful discovered — a fresh dir / non-stateful
 * stack) is trivially OK: there is no existing volume to gate.
 */
export function runRecreatePreflight({
  slug,
  services,
  transport,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  authorizations = [],
}) {
  if (!Array.isArray(services) || services.length === 0) {
    return { ok: true, report: null, services: [] };
  }
  const report = runPreflight({ slug, services, transport, matrix, ledgerDir, authorizations });
  return { ok: report.ok, report, services };
}

/**
 * The GATE the install/refresh recreate sites call BEFORE bringing infra up.
 * Discovers the deployment's stateful services + recreate-intent targets via the
 * injected `discover` seam, runs the preflight over the injected `transport`, and
 * — on ANY blocking verdict — THROWS a RecreatePreflightError so the recreate
 * aborts before a single stateful container is replaced. A clean preflight (or a
 * deployment with nothing stateful to gate) returns { ok: true, report }.
 *
 * FAIL CLOSED, not fail open. If the compose config could not be resolved
 * (`configResolved()` false) the recreate's TARGET versions are unknown, so the
 * check is INCONCLUSIVE and the gate REFUSES rather than recreating blind — a
 * healthy install resolves its config (the file is present + Docker is up), and
 * an unresolvable config means Docker/Compose is unavailable, which the bring-up
 * that would follow needs anyway.
 *
 * @param {object} a
 * @param {string|null} a.slug
 * @param {() => Array} a.discover
 * @param {object} a.transport
 * @param {object} [a.matrix]
 * @param {string} [a.ledgerDir]
 * @param {Array} [a.authorizations]
 * @param {() => boolean} [a.configResolved]  whether the deployment's compose
 *   config resolved. Defaults to true (an injected-transport unit test supplies
 *   its own discover/transport and is always "resolved").
 */
export function assertRecreateSafe({
  slug,
  discover,
  transport,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  authorizations = [],
  configResolved = () => true,
}) {
  const services = typeof discover === "function" ? discover() : [];
  if (configResolved() === false) {
    throw new RecreatePreflightError(
      "Refusing to recreate stateful containers — could not resolve the deployment's compose config to verify the " +
        "upgrade preflight (Docker/Compose unavailable?). The recreate's target versions are unknown, so recreating " +
        `would be blind (cinatra-ai/cinatra#1417). Ensure Docker Compose v2 is reachable, then retry. See ${serviceRunbookUrl(matrix, null)}.`,
      null,
    );
  }
  const decision = runRecreatePreflight({ slug, services, transport, matrix, ledgerDir, authorizations });
  if (decision.ok) return decision;
  const rendered = formatReport(decision.report);
  throw new RecreatePreflightError(
    "Refusing to recreate stateful containers — the upgrade preflight found a blocking data-format " +
      `boundary that a naive recreate would crash-loop (cinatra-ai/cinatra#1417):\n${rendered}`,
    decision.report,
  );
}

// --- docker-backed default (production seams) ------------------------------

/** Best-effort docker capture: trimmed stdout on exit 0, else null (so callers
 *  distinguish "empty output" from "failed"). Never throws. */
function makeDockerCapture(spawn) {
  return (args, opts = {}) => {
    try {
      const r = spawn("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DOCKER_CLI_PROBE_TIMEOUT_MS,
        ...opts,
      });
      if (r.status !== 0) return null;
      return (r.stdout ?? "").trim();
    } catch {
      return null;
    }
  };
}

/** `docker volume inspect` with an explicit three-way outcome: only docker's own
 *  "no such volume" is ABSENT; any other failure is an ERROR (treated fail-closed
 *  as "present", never as an empty/fresh volume). Mirrors index.mjs's reader. */
function makeInspectVolumeThreeWay(spawn) {
  return (name) => {
    try {
      const r = spawn("docker", ["volume", "inspect", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DOCKER_CLI_PROBE_TIMEOUT_MS,
      });
      if (r.status === 0) {
        try {
          const parsed = JSON.parse((r.stdout ?? "").trim());
          const row = Array.isArray(parsed) ? parsed[0] ?? null : parsed;
          return row ? { status: "ok", row } : { status: "error", row: null };
        } catch {
          return { status: "error", row: null };
        }
      }
      if (/no such volume/i.test(`${r.stderr ?? ""}${r.stdout ?? ""}`)) return { status: "absent", row: null };
      return { status: "error", row: null };
    } catch {
      return { status: "error", row: null };
    }
  };
}

/**
 * Build the discover + transport pair the preflight runs on, gathering the SAME
 * facts the standalone `upgrade-preflight` command does — but discover NEVER
 * throws (a recreate gate proceeds best-effort when the config can't resolve;
 * the standalone command hard-aborts). Returns { discover, transport, state }
 * where `state.configResolved` is set during `discover()`.
 *
 * @param {object} a
 * @param {string|null} a.slug              instance slug (ledger key)
 * @param {string} a.targetDir              the checkout / install dir
 * @param {string[]|null} [a.composeFiles]
 * @param {string|null} [a.composeProject]
 * @param {string|null} [a.envFile]
 * @param {object} [a.matrix]
 * @param {string} [a.ledgerDir]            ledger dir override (tests; production
 *   uses the default so discover + the preflight read the same file)
 * @param {typeof spawnSync} [a.spawn]      injectable child_process seam (tests)
 */
export function buildDeploymentPreflight({
  slug,
  targetDir,
  composeFiles = null,
  composeProject = null,
  envFile = null,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  spawn = spawnSync,
}) {
  const capture = makeDockerCapture(spawn);
  const inspectVolumeThreeWay = makeInspectVolumeThreeWay(spawn);
  const composeConfigCapture = (cmd, args, opts) => (cmd === "docker" ? capture(args, opts) : null);

  // Closured lookup maps the transport reads after discover populates them.
  const volumeImages = new Map(); // volumeName → image (emptiness probe)
  const serviceVolume = new Map(); // service → data volume name (marker read)
  const serviceImage = new Map(); // service → own image (--pull=never reader)
  const state = { configResolved: false };

  const discover = () => {
    const specs = new Map();
    if (slug) {
      const { ledger } = readLedger(slug, ledgerDir);
      for (const e of Object.values(ledger.services ?? {})) {
        specs.set(e.service, { service: e.service, volumeName: e.volume?.name ?? null, target: null });
        if (e.volume?.name && e.image) volumeImages.set(e.volume.name, e.image);
        if (e.volume?.name) serviceVolume.set(e.service, e.volume.name);
        if (e.image) serviceImage.set(e.service, e.image);
      }
    }
    // The resolved compose config is the recreate INTENT: per stateful service it
    // yields the image a recreate WOULD deploy (→ the target version) and the
    // ACTUAL resolved data volume name. Unlike the read-only command, an
    // unresolvable config here is NOT a hard abort — the gate proceeds and the
    // bring-up surfaces the real docker error.
    const config = resolveComposeConfig({
      targetDir,
      composeFiles,
      composeProject: composeProject && composeProject !== "cinatra" ? composeProject : null,
      envFile,
      capture: composeConfigCapture,
    });
    state.configResolved = Boolean(config);
    if (config) {
      const { found, skipped } = statefulServicesFromComposeConfig(config, matrix);
      for (const s of found) {
        const target = s.dataFormatVersion ?? imageParts(s.image).tag ?? "unknown";
        specs.set(s.service, { service: s.service, volumeName: s.volumeName, target });
        volumeImages.set(s.volumeName, s.image);
        serviceVolume.set(s.service, s.volumeName);
        serviceImage.set(s.service, s.image);
      }
      for (const s of skipped) {
        specs.set(s.service, { service: s.service, volumeName: null, target: null, volumeUnidentified: s.reason });
      }
    }
    return [...specs.values()];
  };

  const project = composeProject && composeProject !== "cinatra" ? composeProject : "cinatra";
  const runningContainerFor = (service) => {
    const out = capture([
      "ps",
      "--filter", `label=com.docker.compose.service=${service}`,
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", "status=running",
      "--format", "{{.Names}}",
    ]);
    if (!out) return null;
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  };
  const dockerExec = (container, argv) => capture(["exec", container, ...argv]);
  const dockerReadVolume = (volumeName, image, program) => {
    // A marker READ must NEVER create the volume: `docker run -v name:…` auto-
    // creates a missing named volume (Docker's documented behavior — there is no
    // atomic "require-existing" mount flag; `--mount` auto-creates too), which
    // would MUTATE a fresh install and leave a broken empty volume the `up` then
    // adopts. `docker volume inspect` never creates, so guard the read on BOTH
    // sides: skip the run entirely when the volume is absent (never create on a
    // fresh install), and re-check identity AFTER — if a concurrent teardown
    // deleted + our mount recreated it during the read, its {name,createdAt}
    // identity changes, so the reading is untrustworthy and we DISCARD it (→ the
    // deployed version reads unknown → fail closed) rather than trust a volume
    // that changed under us.
    if (!volumeName) return null;
    const before = inspectVolumeThreeWay(volumeName);
    if (before.status !== "ok") return null;
    const out = capture(
      ["run", "--rm", "--pull=never", "--entrypoint", "/bin/sh", "-v", `${volumeName}:${PG_MARKER_READ_MOUNT}:ro`, image, "-c", program],
      { timeout: DOCKER_VOLUME_READ_TIMEOUT_MS },
    );
    const after = inspectVolumeThreeWay(volumeName);
    const beforeId = volumeIdentityFromInspect(before.row);
    const afterId = after.status === "ok" ? volumeIdentityFromInspect(after.row) : null;
    if (!beforeId || !afterId || beforeId.name !== afterId.name || beforeId.createdAt !== afterId.createdAt) return null;
    return out;
  };

  const transport = {
    inspectVolume: (name) => {
      if (!name) return null;
      const res = inspectVolumeThreeWay(name);
      return res.status === "ok" ? res.row : null;
    },
    // Three-way status seam (cinatra-cli#140): the preflight's post-probe recheck
    // uses this so an inspect ERROR is never collapsed to "absent" (a failed
    // recheck cannot confirm the volume stayed absent → fail closed).
    inspectVolumeStatus: (name) => (name ? inspectVolumeThreeWay(name) : { status: "absent", row: null }),
    volumeState: (name) => {
      if (!name) return "absent";
      const res = inspectVolumeThreeWay(name);
      if (res.status === "absent") return "absent";
      if (res.status !== "ok") return "present"; // docker error → fail closed (never "empty" on a guess)
      const image = volumeImages.get(name);
      if (!image) return "present";
      // The emptiness probe MOUNTS the volume (`docker run -v name:…`), which
      // auto-creates a missing named volume — so the SAME TOCTOU as the marker
      // read applies: a volume deleted+recreated by a concurrent teardown during
      // the probe would list EMPTY and read as "empty" → PASS (the fail-OPEN
      // direction). Re-check identity across the probe; on any change, fail closed
      // to "present" (forces version detection → FAIL-CLOSED on an unknown), never
      // trusting a possibly-recreated volume's "empty".
      const listing = capture(
        ["run", "--rm", "--pull=never", "--entrypoint", "/bin/sh", "-v", `${name}:/__preflight_probe:ro`, image, "-c", "ls -A /__preflight_probe"],
        { timeout: DOCKER_VOLUME_READ_TIMEOUT_MS },
      );
      const after = inspectVolumeThreeWay(name);
      const beforeId = volumeIdentityFromInspect(res.row);
      const afterId = after.status === "ok" ? volumeIdentityFromInspect(after.row) : null;
      if (!beforeId || !afterId || beforeId.name !== afterId.name || beforeId.createdAt !== afterId.createdAt) return "present";
      if (listing === null) return "present";
      return listing.length === 0 ? "empty" : "present";
    },
    probeVersion: makeProbeVersion({ runningContainerFor, dockerExec }),
    readMarker: makeMarkerReader({
      volumeFor: (svc) => serviceVolume.get(svc) ?? null,
      imageFor: (svc) => serviceImage.get(svc) ?? null,
      dockerReadVolume,
    }),
    profileEnabled: () => true,
  };

  return { discover, transport, state };
}

/**
 * The production gate install.mjs calls: build the docker-backed discover +
 * transport for THIS deployment, then assert a recreate is safe. FAIL CLOSED —
 * throws a RecreatePreflightError on a blocking verdict OR an unresolvable
 * compose config (an inconclusive check). Wraps the real spawnSync seams so
 * install.mjs carries no docker plumbing of its own. (An unexpected internal
 * error is turned into a fail-closed refusal by the install-side caller,
 * `preflightRecreate`.)
 */
export function defaultAssertRecreateSafe({
  slug,
  targetDir,
  composeFiles = null,
  composeProject = null,
  envFile = null,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  spawn = spawnSync,
}) {
  const { discover, transport, state } = buildDeploymentPreflight({
    slug,
    targetDir,
    composeFiles,
    composeProject,
    envFile,
    matrix,
    ledgerDir,
    spawn,
  });
  return assertRecreateSafe({
    slug,
    discover,
    transport,
    matrix,
    ledgerDir,
    configResolved: () => state.configResolved,
  });
}

export const __test = {
  RecreatePreflightError,
  runRecreatePreflight,
  assertRecreateSafe,
  buildDeploymentPreflight,
  defaultAssertRecreateSafe,
  blocks,
};
