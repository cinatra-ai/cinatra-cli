// ---------------------------------------------------------------------------
// Deployed-version CAPTURE — the installer-side half of the version ledger
// (cinatra-cli#128, upgrade-paths epic cinatra-ai/cinatra#1419).
//
// WHAT. After a successful `docker compose up` (install / isolated install /
// attach / refresh), record what was just deployed for every MATRIX-KNOWN
// stateful service: image reference + digest (from the compose pin), the derived
// data-format version, and the identity of the LIVE data volume backing it —
// into the instance's deployed-version ledger (version-ledger.mjs). The fail-
// closed preflight (upgrade-preflight.mjs) reads this ledger as its PRIMARY
// detection source.
//
// DISCOVERY IS THE RESOLVED COMPOSE CONFIG, NEVER ASSUMPTION. `docker compose
// config --format json` (with the SAME -f/-p/--env-file set the `up` used)
// yields, per service: the exact image reference and the service's volume
// mounts with their RESOLVED volume names (project-prefixed or explicitly
// named) — so the recorded volume binding is the deployment's ACTUAL volume,
// which is precisely what lets a later preflight detect an out-of-band volume
// swap. The DATA volume among a service's mounts is picked by the matrix
// entry's `dataMount` prefix (a service mounting several volumes never gets a
// guess recorded).
//
// BEST-EFFORT BY DESIGN, SKIPS ARE LOUD. Recording rides successful installs —
// a capture failure must never fail the install it describes. But every skip
// is REPORTED (returned + logged by the caller), and two skip classes are
// deliberate refusals, not failures:
//   * a MALFORMED ledger is never overwritten (manual repair, same rule as
//     version-ledger.mjs), and
//   * a service with an in-flight migration journal is never blind-recorded
//     (commit/rollback owns that entry).
//
// Imports: node builtins + the pure matrix/ledger modules only. `docker` is
// shelled through an injectable capture seam so tests drive the whole flow
// without a docker daemon.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

import {
  DEFAULT_UPGRADE_MATRIX,
  deriveDataFormatVersion,
  imageParts,
  serviceEntry,
} from "./upgrade-matrix.mjs";
import {
  makeEntry,
  pendingFor,
  readLedger,
  recordDeployed,
  withLedgerLock,
  writeLedger,
} from "./version-ledger.mjs";

const DOCKER_CAPTURE_TIMEOUT_MS = 30_000;

/** Default shell seam: run a command, return trimmed stdout (possibly "") on
 *  exit 0, else null — so callers can tell "empty output" from "failed".
 *  Never throws. */
export function defaultCapture(cmd, args, { cwd } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DOCKER_CAPTURE_TIMEOUT_MS,
    });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

/**
 * PURE: extract the matrix-known stateful services from a resolved
 * `docker compose config --format json` document.
 *
 * Returns [{ service, image, digest, dataFormatVersion, volumeSource,
 * volumeName, profiles }] for every service the matrix knows that mounts an
 * identifiable data volume, plus a `skipped` list ({ service, reason }) for
 * matrix-known services present in the config whose data volume could not be
 * identified (zero or ambiguous named-volume mounts).
 */
export function statefulServicesFromComposeConfig(configJson, matrix = DEFAULT_UPGRADE_MATRIX) {
  const found = [];
  const skipped = [];
  const services = configJson?.services;
  if (!services || typeof services !== "object") return { found, skipped };
  const topVolumes = configJson?.volumes && typeof configJson.volumes === "object" ? configJson.volumes : {};

  for (const [service, svc] of Object.entries(services)) {
    const entry = serviceEntry(matrix, service);
    if (!entry) continue; // not a guarded stateful service
    const image = typeof svc?.image === "string" && svc.image.length ? svc.image : null;
    if (!image) {
      skipped.push({ service, reason: "no image in the resolved compose config" });
      continue;
    }
    const mounts = (Array.isArray(svc?.volumes) ? svc.volumes : []).filter((m) => m?.type === "volume");
    // The DATA mount is selected by the matrix entry's dataMount prefix WHENEVER
    // one is declared — even for a single-mount service. A service whose data
    // path is bind-mounted while some auxiliary named volume exists must be
    // SKIPPED, never recorded against the auxiliary volume (that would bind the
    // ledger entry to the wrong volume's identity and defeat the mismatch check).
    let dataMounts = mounts;
    if (typeof entry.dataMount === "string" && entry.dataMount.length) {
      // Path-boundary match, not lexical: "/data" must match "/data" and
      // "/data/db" but NEVER "/data-cache".
      dataMounts = mounts.filter(
        (m) =>
          typeof m.target === "string" &&
          (m.target === entry.dataMount || m.target.startsWith(`${entry.dataMount}/`)),
      );
    }
    if (dataMounts.length !== 1) {
      skipped.push({
        service,
        reason:
          dataMounts.length === 0
            ? "no named data-volume mount in the resolved compose config"
            : `ambiguous data-volume mounts (${dataMounts.map((m) => m.target).join(", ")})`,
      });
      continue;
    }
    const source = dataMounts[0].source;
    // The RESOLVED volume name comes from the config document itself (compose
    // resolves the project prefix / an explicit `name:`) — never assembled here.
    const volumeName =
      typeof topVolumes?.[source]?.name === "string" && topVolumes[source].name.length
        ? topVolumes[source].name
        : null;
    if (!volumeName) {
      skipped.push({ service, reason: `volume "${source}" has no resolved name in the compose config` });
      continue;
    }
    found.push({
      service,
      image,
      digest: imageParts(image).digest,
      dataFormatVersion: deriveDataFormatVersion(matrix, service, image),
      volumeSource: source,
      volumeName,
      profiles: Array.isArray(svc?.profiles) ? svc.profiles : [],
    });
  }
  return { found, skipped };
}

/**
 * Record the deployed versions for one instance from an already-resolved
 * compose config. I/O limited to the injected `inspectVolume(name) →
 * { name, createdAt } | null` seam + the ledger file write.
 *
 * Skip rules (returned, never thrown):
 *   - ledger malformed        → nothing written ({ status: "malformed" })
 *   - live volume absent      → service skipped (profile off / never created —
 *                               there is nothing to bind an entry to)
 *   - migration in flight     → service skipped (journal owns the entry)
 *
 * Returns { status: "ok"|"malformed"|"empty", recorded: [service…],
 *           skipped: [{ service, reason }] }.
 */
export function recordDeployedStack({
  slug,
  configJson,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  inspectVolume,
  runningImages = null,
}) {
  const { found, skipped } = statefulServicesFromComposeConfig(configJson, matrix);
  // A wrong record is worse than no record: without deployment proof, record
  // nothing. Proof is per-service: a container RUNNING under this project
  // whose image reference EQUALS the configured pin (`runningImages`:
  // service → running image ref). The resolved config carries every
  // profile-gated service, so a dormant profile's OLD volume must never be
  // re-stamped — and neither may a STALE container still running a previous
  // pin (compose leaves an excluded profile's container running with its old
  // image; only an image-exact match proves THIS config was deployed).
  if (!(runningImages instanceof Map)) {
    return {
      status: "no-deployment-proof",
      recorded: [],
      skipped: found.map((s) => ({ service: s.service, reason: "running-service listing unavailable — not recording blind" })),
    };
  }
  return withLedgerLock(slug, ledgerDir, () => {
    const read = readLedger(slug, ledgerDir);
    if (read.status === "malformed") {
      return { status: "malformed", recorded: [], skipped };
    }
    let ledger = read.ledger;
    const recorded = [];
    for (const s of found) {
      const runningImage = runningImages.get(s.service);
      if (!runningImage) {
        skipped.push({ service: s.service, reason: "container not running under this project (profile off / not deployed)" });
        continue;
      }
      if (runningImage !== s.image) {
        skipped.push({
          service: s.service,
          reason: `running container image (${runningImage}) differs from the configured pin — stale container, not recording`,
        });
        continue;
      }
      const live = inspectVolume(s.volumeName);
      if (!live) {
        skipped.push({ service: s.service, reason: `volume ${s.volumeName} not present` });
        continue;
      }
      if (pendingFor(ledger, s.service)) {
        skipped.push({ service: s.service, reason: "migration in flight (pending journal) — not blind-recording" });
        continue;
      }
      ledger = recordDeployed(
        ledger,
        makeEntry({
          service: s.service,
          image: s.image,
          digest: s.digest,
          dataFormatVersion: s.dataFormatVersion,
          volume: live,
        }),
      );
      recorded.push(s.service);
    }
    if (recorded.length === 0) return { status: "empty", recorded, skipped };
    writeLedger(ledger, ledgerDir);
    return { status: "ok", recorded, skipped };
  });
}

/** Live volume identity via `docker volume inspect` (name + CreatedAt — the
 *  pair that distinguishes a recreated same-named volume). Null on any failure. */
export function dockerVolumeIdentity(volumeName, capture = defaultCapture) {
  if (!volumeName) return null;
  const raw = capture("docker", ["volume", "inspect", volumeName]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!row || typeof row.Name !== "string" || typeof row.CreatedAt !== "string") return null;
    if (!row.Name.length || !row.CreatedAt.length) return null;
    return { name: row.Name, createdAt: row.CreatedAt };
  } catch {
    return null;
  }
}

/** The leading `docker compose` argv for the SAME file/project/env-file set an
 *  `up` used. */
function composeBaseArgs({ composeFiles = null, composeProject = null, envFile = null }) {
  const files = composeFiles && composeFiles.length ? composeFiles : ["docker-compose.yml", "docker-compose.dev.yml"];
  const args = ["compose"];
  if (envFile) args.push("--env-file", envFile);
  if (composeProject) args.push("-p", composeProject);
  for (const f of files) args.push("-f", f);
  return args;
}

/** Resolve the compose config (json) with the SAME file/project/env-file set an
 *  `up` used. `--profile "*"` keeps profile-gated stateful services visible in
 *  the document (deployment proof is the RUNNING container, never the profile
 *  flag). Null on any failure. */
export function resolveComposeConfig({ targetDir, composeFiles = null, composeProject = null, envFile = null, capture = defaultCapture }) {
  const args = [...composeBaseArgs({ composeFiles, composeProject, envFile }), "--profile", "*", "config", "--format", "json"];
  const raw = capture("docker", args, { cwd: targetDir });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Map of compose service → RUNNING container's image reference under this
 *  files/project set (`compose ps --format json`; compose stamps the container
 *  with the exact configured ref, digest pin included) — the deployment proof
 *  recording requires. A service with several running containers (replicas)
 *  is included only when they all agree on one image. Null on any failure
 *  (the caller then refuses to record rather than recording blind). */
export function resolveRunningServiceImages({ targetDir, composeFiles = null, composeProject = null, envFile = null, capture = defaultCapture }) {
  const args = [...composeBaseArgs({ composeFiles, composeProject, envFile }), "ps", "--format", "json"];
  const raw = capture("docker", args, { cwd: targetDir });
  if (raw === null) return null;
  // Compose v2 emits NDJSON (one container per line); some builds emit an array.
  let rows;
  try {
    const parsed = JSON.parse(raw || "[]");
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        return null; // unparsable listing — no proof
      }
    }
  }
  const images = new Map();
  const conflicted = new Set();
  for (const r of rows) {
    if (!r || r.State !== "running") continue;
    const service = r.Service;
    const image = r.Image;
    if (typeof service !== "string" || !service.length || typeof image !== "string" || !image.length) continue;
    if (images.has(service) && images.get(service) !== image) conflicted.add(service);
    images.set(service, image);
  }
  for (const s of conflicted) images.delete(s);
  return images;
}

/**
 * The install/refresh hook: resolve the compose config + the running-service
 * set (deployment proof), then record the deployed stack into the slug's
 * ledger. BEST-EFFORT — never throws; every outcome is logged through `log`
 * in one summary line (and skips at detail). Returns the recordDeployedStack
 * result (status "config-unavailable" when the compose config could not be
 * resolved; "project-mismatch" when `requireProjectMatch` names a project the
 * resolved config does not — the caller's `up` targeted a different stack
 * than the instance row records, so recording would bind the wrong volumes).
 */
export function captureDeployedVersions({
  slug,
  targetDir,
  composeFiles = null,
  composeProject = null,
  envFile = null,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  requireProjectMatch = null,
  capture = defaultCapture,
  log = () => {},
}) {
  try {
    const configJson = resolveComposeConfig({ targetDir, composeFiles, composeProject, envFile, capture });
    if (!configJson) {
      log("  ⚠ version ledger: could not resolve the compose config — deployed versions not recorded.");
      return { status: "config-unavailable", recorded: [], skipped: [] };
    }
    if (requireProjectMatch && configJson.name !== requireProjectMatch) {
      log(
        `  ⚠ version ledger: this up targeted project "${configJson.name}" but instance "${slug}" records ` +
          `"${requireProjectMatch}" — not recording against the wrong stack.`,
      );
      return { status: "project-mismatch", recorded: [], skipped: [] };
    }
    const runningImages = resolveRunningServiceImages({ targetDir, composeFiles, composeProject, envFile, capture });
    const result = recordDeployedStack({
      slug,
      configJson,
      matrix,
      ledgerDir,
      inspectVolume: (name) => dockerVolumeIdentity(name, capture),
      runningImages,
    });
    if (result.status === "malformed") {
      log(`  ⚠ version ledger for "${slug}" is malformed — NOT overwritten; repair it by hand (deployed versions not recorded).`);
    } else if (result.status === "no-deployment-proof") {
      log(`  ⚠ version ledger: could not list running services — deployed versions not recorded (never recording blind).`);
    } else if (result.recorded.length) {
      log(`  Version ledger: recorded ${result.recorded.length} stateful service(s) for "${slug}" (${result.recorded.join(", ")}).`);
    }
    return result;
  } catch (err) {
    log(`  ⚠ version ledger: recording failed (${err?.message ?? err}) — install result is unaffected.`);
    return { status: "error", recorded: [], skipped: [] };
  }
}

export const __test = {
  defaultCapture,
  statefulServicesFromComposeConfig,
  recordDeployedStack,
  dockerVolumeIdentity,
  resolveComposeConfig,
  resolveRunningServiceImages,
  captureDeployedVersions,
};
