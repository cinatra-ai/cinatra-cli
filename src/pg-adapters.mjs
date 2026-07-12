// ---------------------------------------------------------------------------
// REAL Postgres detection adapters for the fail-closed upgrade preflight —
// the live version probe + the raw on-disk PG_VERSION marker (cinatra-cli#128
// residuals 1, folded into the cinatra-cli#129 upgrade-major slice; upgrade-
// paths epic cinatra-ai/cinatra#1419).
//
// These replace the fail-closed null stubs index.mjs shipped in #131. They sit
// BELOW the recorded ledger in the adapter chain (upgrade-preflight.mjs
// detectVersion): only a LEGACY install with no ledger entry ever reaches
// them, and any failure returns null so the preflight FAILS CLOSED on a
// non-empty un-ledgered volume rather than guessing.
//
// LIVE PROBE. `SHOW server_version` executed INSIDE the service's RUNNING
// container over the unix socket (`docker exec <ctr> psql -U <user> …`). The
// official postgres images trust local socket connections for the bootstrap
// user, so the probe needs NO credential handling; the bootstrap user comes
// from the deployment's resolved compose environment (POSTGRES_USER), never an
// assumption. A running server answering SHOW server_version is authoritative
// for the DATA directory it serves.
//
// RAW MARKER. `PG_VERSION` read from the deployment's ACTUAL data path via a
// throwaway read-only scratch container over the service's own already-pulled
// image (`--pull=never` — a read-only preflight never reaches the network; the
// same discipline as the emptiness probe). The pg18 official images moved
// PGDATA from the legacy `<mount>/…/data` layout to `<mount>/<major>/docker`
// under a PARENT mount (docker-library/postgres#1259), so the marker location
// inside the volume depends on which layout wrote it:
//   * legacy layout (volume mounted at …/data)  → PG_VERSION at the volume ROOT;
//   * parent layout (volume mounted at /var/lib/postgresql) → EITHER a legacy
//     cluster still sitting at the volume root (the exact cinatra-ai/cinatra#1417
//     hazard: an old …/data volume rebound to the parent mount) OR the new
//     `<major>/docker/PG_VERSION`.
// The probe script therefore prefers a ROOT PG_VERSION (the hazard case), else
// accepts EXACTLY ONE `*/docker/PG_VERSION`; zero or several candidates → null
// (ambiguous — fail closed upstream).
//
// Import-light: node builtins only. All docker access goes through an injected
// capture seam (same contract as version-ledger-capture.defaultCapture) so the
// whole chain is unit-tested without a docker daemon.
// ---------------------------------------------------------------------------

/** Parse a `SHOW server_version` (or `SELECT version()`) response down to the
 *  Postgres MAJOR as a string, or null when unparseable. Pure.
 *  "17.5 (Debian 17.5-1.pgdg120+1)" → "17"; "PostgreSQL 16.3 on x86_64" → "16". */
export function parsePgServerVersion(raw) {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/(?:^|\s)(\d+)(?:\.\d+)*/);
  if (!m) return null;
  const major = Number(m[1]);
  if (!Number.isInteger(major) || major < 9 || major > 99) return null;
  return String(major);
}

/** Parse the content of a raw PG_VERSION marker file to the major string, or
 *  null. Pure. Modern majors write just the major ("17\n"). */
export function parsePgVersionFile(content) {
  if (typeof content !== "string") return null;
  const t = content.trim();
  if (!/^\d+$/.test(t)) return null;
  const major = Number(t);
  if (major < 9 || major > 99) return null;
  return t;
}

/** The POSIX sh script the marker scratch container runs over the read-only
 *  volume mounted at `mountPoint`. Prefers a root PG_VERSION (legacy cluster —
 *  including a legacy cluster rebound under a parent mount, the #1417 hazard),
 *  else EXACTLY ONE `<major>/docker/PG_VERSION` (the pg18 parent layout);
 *  anything else exits 3 (→ capture null → fail closed upstream). Pure. */
export function pgMarkerShellScript(mountPoint = "/wa_probe") {
  return (
    `if [ -f ${mountPoint}/PG_VERSION ]; then cat ${mountPoint}/PG_VERSION; exit 0; fi; ` +
    `set -- ${mountPoint}/*/docker/PG_VERSION; ` +
    `if [ "$#" -eq 1 ] && [ -f "$1" ]; then cat "$1"; exit 0; fi; ` +
    `exit 3`
  );
}

/**
 * Build the live-probe adapter: (service) → detected major string | null.
 *
 * @param {object} a
 * @param {(args: string[], opts?: object) => string|null} a.dockerCapture  the
 *   read-only docker capture seam (trimmed stdout on exit 0, else null).
 * @param {Map<string, {containerName?: string|null, pgUser?: string|null}>} a.serviceMeta
 *   per-service runtime facts from discovery: the RUNNING container's name (from
 *   `docker compose ps`) and the bootstrap user from the resolved compose
 *   environment. A service with no running container yields null (the chain
 *   falls through to the raw marker).
 */
export function buildPgProbeAdapter({ dockerCapture, serviceMeta }) {
  return (service) => {
    const meta = serviceMeta.get(service);
    if (!meta || !meta.containerName) return null;
    const user = meta.pgUser || "postgres";
    const out = dockerCapture([
      "exec",
      meta.containerName,
      "psql",
      "-U",
      user,
      "-d",
      "postgres",
      "-tA",
      "-c",
      "SHOW server_version",
    ]);
    if (out == null) return null;
    return parsePgServerVersion(out);
  };
}

/**
 * Build the raw-marker adapter: (service, markerFile) → detected major | null.
 * Only wired for the authoritative Postgres `PG_VERSION` marker; any other
 * marker name returns null (nothing else is authoritative — matrix contract).
 *
 * @param {object} a
 * @param {(args: string[], opts?: object) => string|null} a.dockerCapture
 * @param {Map<string, {volumeName?: string|null, image?: string|null}>} a.serviceMeta
 *   per-service facts: the deployment's ACTUAL resolved data volume + the
 *   service's image (already pulled — the scratch container runs --pull=never).
 */
export function buildPgMarkerAdapter({ dockerCapture, serviceMeta }) {
  return (service, markerFile) => {
    if (markerFile !== "PG_VERSION") return null;
    const meta = serviceMeta.get(service);
    if (!meta || !meta.volumeName || !meta.image) return null;
    const out = dockerCapture(
      [
        "run",
        "--rm",
        "--pull=never",
        "--entrypoint",
        "/bin/sh",
        "-v",
        `${meta.volumeName}:/wa_probe:ro`,
        meta.image,
        "-c",
        pgMarkerShellScript("/wa_probe"),
      ],
      { timeout: 60_000 },
    );
    if (out == null) return null;
    return parsePgVersionFile(out);
  };
}

export const __test = {
  parsePgServerVersion,
  parsePgVersionFile,
  pgMarkerShellScript,
  buildPgProbeAdapter,
  buildPgMarkerAdapter,
};
