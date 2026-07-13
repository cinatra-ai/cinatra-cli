// ---------------------------------------------------------------------------
// Postgres detection adapters — the REAL live-probe + raw `PG_VERSION` marker
// readers behind the fail-closed upgrade preflight's fenced seams
// (cinatra-cli#128 residual 1, folded in with `db upgrade-major` cinatra-cli#129,
// upgrade-paths epic cinatra-ai/cinatra#1419).
//
// cli#128 shipped the preflight's adapter CHAIN with the ledger adapter real but
// the live probe and the raw on-disk marker STUBBED to null (a null probe/marker
// on a non-empty, un-ledgered volume fails closed rather than guessing). This
// module makes both real:
//
//   * LIVE PROBE — `SHOW server_version` against the RUNNING container for the
//     service (a probe is only meaningful when the server is up; when it is down
//     the chain falls through to the raw marker). Never opens a host port; runs
//     entirely via `docker exec`.
//
//   * RAW `PG_VERSION` MARKER — read from the deployment's ACTUAL data path. The
//     official pg18 images moved PGDATA out from under the legacy `.../data`
//     mount to a `<major>/docker` subdir under the PARENT mount
//     (docker-library/postgres#1259), so the marker's location is layout-
//     dependent and MUST come from the deployment, never an assumption. The read
//     probes BOTH layouts inside a throwaway container that mounts the volume
//     read-only, using the service's OWN already-pulled image (`--pull=never` —
//     a preflight/marker read never reaches the network).
//
// SHAPE. The version-string PARSERS + the marker-read shell are PURE / data (the
// unit of test); the docker-driving factories take an INJECTED docker seam so
// they are exercised with a mocked `docker exec` / `docker run` and never boot a
// container in unit tests. index.mjs wires the real spawnSync-backed seams.
// Import-light: node-builtin-free (no imports) so it is importable from the
// eager-`pg`-free unit tests and from index.mjs's command handlers alike.
// ---------------------------------------------------------------------------

// --- pure version-string parsers -------------------------------------------

/**
 * Parse a Postgres MAJOR from a server version string. Handles both probe
 * shapes: `SHOW server_version` ("17.2", "18beta1", "15.6 (Debian …)") and the
 * verbose `SELECT version()` ("PostgreSQL 17.2 (Debian 17.2-1.pgdg…) on
 * x86_64-…"). Returns the leading major as a string, or null when nothing
 * parses (the caller records null → the preflight fails closed rather than
 * guessing).
 */
export function parseServerVersionMajor(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Strip a leading "PostgreSQL " banner (the verbose `version()` form).
  const afterBanner = s.replace(/^PostgreSQL\s+/i, "");
  // The first token is the dotted/annotated version ("17.2", "18beta1",
  // "15.6"); the major is its leading run of digits.
  const token = afterBanner.split(/\s+/, 1)[0] ?? "";
  const m = token.match(/^(\d+)/);
  return m ? m[1] : null;
}

/**
 * Parse a Postgres MAJOR from the raw contents of a `PG_VERSION` marker file.
 * Modern clusters (pg10+) write just the major ("17\n"); this trims whitespace
 * and takes the first line, then its leading digits. Returns null on empty /
 * unreadable input.
 */
export function parsePgVersionMarker(raw) {
  if (raw == null) return null;
  const firstLine = String(raw).split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return null;
  const m = firstLine.match(/^(\d+)/);
  return m ? m[1] : null;
}

// --- layout-aware raw marker read (pure shell, both pg layouts) -------------

// The mount point the volume is bound to inside the throwaway reader container.
export const PG_MARKER_READ_MOUNT = "/__cinatra_pgver";

/**
 * A `/bin/sh -c` program that prints the `PG_VERSION` contents from whichever
 * layout the volume actually holds — read from the deployment's ACTUAL data
 * path, never an assumption:
 *   1. LEGACY (pg<=17): the volume is mounted AT `.../data`, so `PG_VERSION`
 *      sits at the mount root.
 *   2. pg18 PARENT (docker-library/postgres#1259): the volume is mounted at the
 *      PARENT `/var/lib/postgresql`; PGDATA moved to `<major>/docker`, so
 *      `PG_VERSION` is at `<mount>/<major>/docker/PG_VERSION`.
 * Prints nothing (→ null marker → fail closed) when neither exists. `set -e` is
 * deliberately NOT used: a missing legacy file must fall through to the parent
 * search, not abort the probe.
 */
export const PG_MARKER_READ_SH =
  `M=${PG_MARKER_READ_MOUNT}; ` +
  `if [ -f "$M/PG_VERSION" ]; then cat "$M/PG_VERSION"; exit 0; fi; ` +
  // pg18 parent layout: <major>/docker/PG_VERSION. Glob one level for the
  // major dir (do not assume it — it is the very version we are detecting).
  `for d in "$M"/*/docker; do if [ -f "$d/PG_VERSION" ]; then cat "$d/PG_VERSION"; exit 0; fi; done; ` +
  `exit 0`;

// --- docker-driving factories (injected seam; thin over the pure parts) -----

/**
 * Build the preflight transport's `probeVersion(service)` from an injected
 * docker seam. The probe is meaningful ONLY while the server is up; when the
 * service has no running container (`runningContainerFor` → null) it returns
 * null so the adapter chain falls through to the raw marker.
 *
 * @param {object} deps
 * @param {(service: string) => string|null} deps.runningContainerFor  the
 *   running container name for a service, or null when it is not up.
 * @param {(container: string, argv: string[]) => (string|null)} deps.dockerExec
 *   run a client inside `container`, returning trimmed stdout or null on any
 *   failure.
 * @returns {(service: string) => string|null}
 */
export function makeProbeVersion({ runningContainerFor, dockerExec }) {
  return (service) => {
    const container = runningContainerFor ? runningContainerFor(service) : null;
    if (!container) return null;
    // -tA: tuples-only, unaligned — bare "17.2". `SHOW server_version` is
    // cheaper + more robust than parsing verbose version().
    const out = dockerExec(container, ["psql", "-U", "postgres", "-tAc", "SHOW server_version"]);
    return parseServerVersionMajor(out);
  };
}

/**
 * Build the preflight transport's `readMarker(service, markerFile)` from an
 * injected docker seam. Reads the raw `PG_VERSION` from the deployment's actual
 * data path via a throwaway read-only mount of the service's data volume, using
 * the service's OWN already-pulled image (`--pull=never`).
 *
 * @param {object} deps
 * @param {(service: string) => string|null} deps.volumeFor  the service's DATA
 *   volume name, or null when it cannot be identified.
 * @param {(service: string) => string|null} deps.imageFor  the service's own
 *   image ref (for the `--pull=never` throwaway reader), or null.
 * @param {(volumeName: string, image: string, program: string) => (string|null)} deps.dockerReadVolume
 *   mount `volumeName` read-only into a throwaway `image` container and run
 *   `/bin/sh -c program`, returning trimmed stdout or null on any failure.
 * @returns {(service: string, markerFile: string) => string|null}
 */
export function makeMarkerReader({ volumeFor, imageFor, dockerReadVolume }) {
  return (service, markerFile) => {
    // Only PG_VERSION is authoritative (the matrix supplies the file name); a
    // different/absent marker request is not readable here.
    if (markerFile !== "PG_VERSION") return null;
    const volumeName = volumeFor ? volumeFor(service) : null;
    const image = imageFor ? imageFor(service) : null;
    if (!volumeName || !image) return null;
    const out = dockerReadVolume(volumeName, image, PG_MARKER_READ_SH);
    return parsePgVersionMarker(out);
  };
}

export const __test = {
  parseServerVersionMajor,
  parsePgVersionMarker,
  PG_MARKER_READ_SH,
  PG_MARKER_READ_MOUNT,
  makeProbeVersion,
  makeMarkerReader,
};
