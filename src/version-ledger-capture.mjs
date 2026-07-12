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
  writeLedger,
} from "./version-ledger.mjs";

const DOCKER_CAPTURE_TIMEOUT_MS = 30_000;

/** Default shell seam: run a command, return trimmed stdout on exit 0, else
 *  null. Never throws. */
export function defaultCapture(cmd, args, { cwd } = {}) {
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: DOCKER_CAPTURE_TIMEOUT_MS,
    });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim() || null;
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
    let dataMounts = mounts;
    if (mounts.length > 1 && typeof entry.dataMount === "string" && entry.dataMount.length) {
      dataMounts = mounts.filter((m) => typeof m.target === "string" && m.target.startsWith(entry.dataMount));
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
export function recordDeployedStack({ slug, configJson, matrix = DEFAULT_UPGRADE_MATRIX, ledgerDir, inspectVolume }) {
  const { found, skipped } = statefulServicesFromComposeConfig(configJson, matrix);
  const read = readLedger(slug, ledgerDir);
  if (read.status === "malformed") {
    return { status: "malformed", recorded: [], skipped };
  }
  let ledger = read.ledger;
  const recorded = [];
  for (const s of found) {
    const live = inspectVolume(s.volumeName);
    if (!live) {
      skipped.push({ service: s.service, reason: `volume ${s.volumeName} not present (profile off / not created)` });
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

/** Resolve the compose config (json) with the SAME file/project/env-file set an
 *  `up` used. `--profile "*"` keeps profile-gated stateful services visible —
 *  whether one is actually deployed is decided by its live volume's existence,
 *  not by its profile flag. Null on any failure. */
export function resolveComposeConfig({ targetDir, composeFiles = null, composeProject = null, envFile = null, capture = defaultCapture }) {
  const files = composeFiles && composeFiles.length ? composeFiles : ["docker-compose.yml", "docker-compose.dev.yml"];
  const args = ["compose"];
  if (envFile) args.push("--env-file", envFile);
  if (composeProject) args.push("-p", composeProject);
  for (const f of files) args.push("-f", f);
  args.push("--profile", "*", "config", "--format", "json");
  const raw = capture("docker", args, { cwd: targetDir });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The install/refresh hook: resolve the compose config, then record the
 * deployed stack into the slug's ledger. BEST-EFFORT — never throws; every
 * outcome is logged through `log` in one summary line (and skips at detail).
 * Returns the recordDeployedStack result (status "config-unavailable" when the
 * compose config could not be resolved).
 */
export function captureDeployedVersions({
  slug,
  targetDir,
  composeFiles = null,
  composeProject = null,
  envFile = null,
  matrix = DEFAULT_UPGRADE_MATRIX,
  ledgerDir,
  capture = defaultCapture,
  log = () => {},
}) {
  try {
    const configJson = resolveComposeConfig({ targetDir, composeFiles, composeProject, envFile, capture });
    if (!configJson) {
      log("  ⚠ version ledger: could not resolve the compose config — deployed versions not recorded.");
      return { status: "config-unavailable", recorded: [], skipped: [] };
    }
    const result = recordDeployedStack({
      slug,
      configJson,
      matrix,
      ledgerDir,
      inspectVolume: (name) => dockerVolumeIdentity(name, capture),
    });
    if (result.status === "malformed") {
      log(`  ⚠ version ledger for "${slug}" is malformed — NOT overwritten; repair it by hand (deployed versions not recorded).`);
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
  captureDeployedVersions,
};
