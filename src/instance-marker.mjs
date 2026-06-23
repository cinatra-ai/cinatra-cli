// ---------------------------------------------------------------------------
// Per-checkout instance marker `.cinatra/instance.json` (cinatra-cli#17, T2).
//
// Written at install (inside the target checkout), read at re-run / attach /
// status. It is a HINT, never authority: the AUTHORITATIVE state of an install
// is (instance-registry row) + (live Docker `working_dir` labels). A marker can
// be stale (containers torn down out-of-band), partial (`provisioning` — the
// install crashed before health), or copied. So every reader MUST reconcile it
// against the registry + live Docker before trusting it (reconcileMarker).
//
// Import-light: node builtins only.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const MARKER_VERSION = 1;
const MARKER_DIRNAME = ".cinatra";
const MARKER_FILENAME = "instance.json";

/** Absolute path to a checkout's marker file. */
export function markerPath(installDir) {
  return path.join(installDir, MARKER_DIRNAME, MARKER_FILENAME);
}

/**
 * Write the marker for `installDir`. The marker mirrors the salient registry
 * fields so a status read can show the local checkout's claimed identity, but
 * it carries no authority of its own. Atomic temp+rename; mode 0600 (it records
 * the compose project / app port, not secrets, but parity with the registry
 * write keeps it private). Returns the path written.
 */
export function writeMarker(installDir, fields) {
  const dir = path.join(installDir, MARKER_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const body = {
    version: MARKER_VERSION,
    slug: fields.slug ?? null,
    id: fields.id ?? null,
    mode: fields.mode ?? null,
    composeProject: fields.composeProject ?? null,
    composeFiles: Array.isArray(fields.composeFiles) ? [...fields.composeFiles] : [],
    appPort: fields.appPort ?? null,
    ref: fields.ref ?? null,
    sha: fields.sha ?? null,
    infraMode: fields.infraMode ?? null,
    state: fields.state ?? "provisioning",
    updatedAt: new Date().toISOString(),
  };
  const payload = JSON.stringify(body, null, 2) + "\n";
  const file = path.join(dir, MARKER_FILENAME);
  const tmp = path.join(dir, `.instance.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/**
 * Read the marker for `installDir`. NEVER throws.
 * Returns { status, marker }:
 *   - "missing"   → no marker file; marker = null
 *   - "ok"        → parsed; marker = the object
 *   - "malformed" → unreadable / invalid JSON / wrong shape; marker = null
 */
export function readMarker(installDir) {
  const file = markerPath(installDir);
  if (!existsSync(file)) return { status: "missing", marker: null };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { status: "malformed", marker: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", marker: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", marker: null };
  }
  return { status: "ok", marker: parsed };
}

/**
 * Reconcile a marker against the AUTHORITATIVE registry row + live-Docker
 * ownership signal. The marker NEVER promotes a checkout to "healthy" on its
 * own — only registry `state === "ready"` + a live-owned signal does.
 *
 * @param {object|null} marker        the parsed marker (or null when absent)
 * @param {object|null} registryRow   the instance-registry row for this slug (or null)
 * @param {boolean}     liveOwned     true iff live Docker shows containers whose
 *                                    compose `working_dir` is this checkout
 *                                    (proven via ownedPortsFromInspect upstream)
 * @returns {{ healthy: boolean, state: string, reason: string }}
 *   - healthy: safe to treat as an up, install-owned instance
 *   - state:   the reconciled state label ("ready"|"provisioning"|"external"|
 *              "stale"|"absent"|"unknown")
 *   - reason:  human-readable explanation (for --status output)
 */
export function reconcileMarker(marker, registryRow, liveOwned) {
  // No registry row → the marker (if any) is at most a self-claim with nothing
  // authoritative behind it. Never healthy.
  if (!registryRow) {
    if (marker) {
      return {
        healthy: false,
        state: "unknown",
        reason:
          "marker present but no registry row — the checkout claims an instance the registry does not record " +
          "(stale marker, or registry repaired/removed); treat as not installed.",
      };
    }
    return { healthy: false, state: "absent", reason: "no marker and no registry row." };
  }

  // External infra: not install-owned; "healthy" is about the pointer existing,
  // not about install-owned containers. Report it as external (never auto-drop).
  if (registryRow.state === "external") {
    return {
      healthy: true,
      state: "external",
      reason: "registry records an EXTERNAL-infra instance (resources are operator-owned, never auto-removed).",
    };
  }

  // A provisioning row is a ghost until health flips it to ready — NEVER healthy.
  if (registryRow.state === "provisioning") {
    return {
      healthy: false,
      state: "provisioning",
      reason:
        "registry row is still `provisioning` (install did not reach health) — resumable/cleanable, not installed. " +
        "Re-run with --resume to reconcile, or let the next install/teardown clean it up.",
    };
  }

  // registry says ready, but live Docker shows nothing owned by this checkout →
  // the stack was torn down out-of-band. Ready row + no live containers ≠ up.
  if (registryRow.state === "ready" && !liveOwned) {
    return {
      healthy: false,
      state: "stale",
      reason:
        "registry row is `ready` but no live containers are owned by this checkout (stack stopped/removed out-of-band). " +
        "Re-run install/attach to bring it back up.",
    };
  }

  // ready + live-owned → genuinely up and install-owned.
  return {
    healthy: true,
    state: "ready",
    reason: "registry `ready` and live containers are owned by this checkout.",
  };
}

export const __test = {
  MARKER_VERSION,
  markerPath,
  writeMarker,
  readMarker,
  reconcileMarker,
};
