// ---------------------------------------------------------------------------
// Supported source→target upgrade matrix — the DECISION TABLE the fail-closed
// upgrade preflight (cinatra-cli#128) consults (part of the upgrade-paths epic,
// cinatra-ai/cinatra#1419).
//
// SCOPE / OWNERSHIP. The AUTHORITATIVE definition of the supported matrix + the
// pinned floating tags is epic sub-issue 1 (cinatra-ai/cinatra#1420), which
// LANDED in the `cinatra` product as docs/architecture/upgrade-matrix.json
// (revision 1, baseline release 0.1.9; merged via cinatra PR #1438, squash
// 4e89bf4a). This module is the CLI's SHIPPED-WITH copy of that decision table,
// RECONCILED against that revision: the installed CLI must be able to reason
// about "is this (service, source→target) hop supported?" WITHOUT reaching back
// to a running instance (the preflight runs BEFORE any container is recreated,
// precisely when the app may be down). The preflight consumes a matrix OBJECT
// (injectable) — this module supplies the default one plus the PURE lookups
// over it. AUTHORITATIVE_MATRIX_REVISION below is the skew pin (the product
// side's scripts/lib/upgrade-matrix.mjs MATRIX_REVISION is the same contract on
// the other half): when the authoritative matrix bumps its revision, this copy
// must be re-reconciled and the pin bumped in the same change.
//
// COVERAGE NOTE (deliberate subset, fail-closed direction): this copy carries
// exactly the DB-engine-style compose services whose data volumes the preflight
// guards today (the set the #131 recorder already ships). Authoritative entries
// for coupled FILE/object-store volumes (twenty-server files, wordpress/drupal
// content trees, plane-minio uploads, graphiti's volume-less derived state) are
// NOT mirrored yet — those services simply stay outside preflight discovery
// (statefulServicesFromComposeConfig only surfaces matrix-known services), so
// nothing is silently passed; widening the guarded set rides epic sub-issue 4
// with the non-Postgres family paths. For the services carried here the version
// axes, supported hops, mechanisms, and the single case-scoped exception are
// reconciled 1:1 with revision 1 (transitions the authoritative matrix lists
// with supported=false are simply NOT listed here — an unlisted hop already
// fails closed, same outcome).
//
// SERVICE KEYS ARE THE REAL COMPOSE SERVICE NAMES (docker-compose.yml at the
// product root — grounded against origin/main): `postgres` (platform),
// `nango-db`, `twenty-db`, `plane-db`, `wordpress-db`, `drupal-db`, `neo4j`,
// `redis`, `twenty-redis`, `plane-redis` (valkey), `plane-mq` (rabbitmq),
// `verdaccio`. Keying by the compose service name is what lets the installer's
// ledger recording, the compose-config discovery, and this decision table line
// up mechanically — no separate mapping layer to drift.
//
// SHAPE. A matrix is data, never behaviour:
//   {
//     version: "<baseline pin label>",   // provenance of the ordered lists
//     services: {
//       "<service>": {
//         order: ["15","16","17","18"],  // the service's ordered version axis;
//                                        //   comparison is INDEX-based (never a
//                                        //   numeric assumption — redis "7"/"8",
//                                        //   pg majors, mariadb "11.4" all differ).
//                                        //   A version absent from `order` is
//                                        //   INCOMPARABLE → fail closed.
//         marker: "PG_VERSION" | null,   // authoritative raw on-disk marker file
//                                        //   name, ONLY where one exists (Postgres
//                                        //   PG_VERSION). null ⇒ no raw marker is
//                                        //   authoritative for this service.
//         dataMount: "/var/lib/...",     // the container mount-path PREFIX of the
//                                        //   service's DATA volume — how the
//                                        //   recorder picks the data volume when a
//                                        //   service mounts more than one.
//         transitions: [                 // EXPLICITLY supported forward hops. A
//           { from: "17", to: "18",      //   forward-ordered hop that is NOT listed
//             mechanism: "logical-dump-restore",
//             migration: "cinatra instance db upgrade-major",
//             caseScoped: false },       //   is an UNSUPPORTED hop → fail closed.
//         ],                             //   `migration` is the sanctioned CLI
//                                        //   command, or null when the mechanism
//                                        //   has no executable CLI command yet
//                                        //   (the stop message then points at the
//                                        //   runbook instead of a command).
//       },
//     },
//   }
//
// Import-light: NO imports, NO heavy deps — importable from the eager-`pg`-free
// unit tests and from the preflight (which itself only shells `docker`).
// ---------------------------------------------------------------------------

// The sanctioned Postgres major-upgrade command (epic sub-issue 3,
// cinatra-cli#129 `cinatra instance db upgrade-major`). The preflight's stop
// message points here for a SUPPORTED pending hop; it is never a generic force.
export const PG_UPGRADE_MAJOR_COMMAND = "cinatra instance db upgrade-major";

// The reserved stable runbook URL the stop messages link. Path is RESERVED here
// (epic sub-issue 6 owns the page CONTENT — cinatra-ai/docs); the preflight only
// ever LINKS it, never asserts the page exists.
export const UPGRADE_RUNBOOK_URL =
  "https://docs.cinatra.ai/self-hosting/upgrading-stateful-services";

// The authoritative matrix revision + baseline this shipped copy is reconciled
// against (cinatra docs/architecture/upgrade-matrix.json — the product side pins
// the same pair in scripts/lib/upgrade-matrix.mjs and its works-after fixtures
// resolve through it, so both halves of the cross-repo pair act on the same
// decision table by construction). Bump ONLY together with a re-reconcile.
export const AUTHORITATIVE_MATRIX_REVISION = 1;
export const AUTHORITATIVE_MATRIX_BASELINE = "0.1.9";

// The CLI's shipped-with copy of the supported matrix, reconciled to the
// authoritative revision above. Version-axis orders and the supported forward
// hops mirror the authoritative data for every service carried here (platform
// pg 18, nango pg 17 + the case-scoped pg15 exception, twenty pg 16, plane pg
// 15.7, mariadb 11.4→11.8 in-place, neo4j 5.26→2026.05 in-place store-format,
// redis 7→8 discard-recreate, valkey 7.2.11 / rabbitmq 3.13 / verdaccio 6
// holds). A transition whose mechanism has no sanctioned CLI command yet
// carries migration: null (the preflight stop then points at the runbook);
// hops the authoritative matrix marks supported=false are not listed (an
// unlisted hop fails closed — same outcome, one representation).
export const DEFAULT_UPGRADE_MATRIX = Object.freeze({
  version: `${AUTHORITATIVE_MATRIX_BASELINE}-shipped`,
  revision: AUTHORITATIVE_MATRIX_REVISION,
  baselineRelease: AUTHORITATIVE_MATRIX_BASELINE,
  services: {
    // Four Postgres instances share the same guarded logical dump→restore path
    // (epic sub-issue 3 — `cinatra instance db upgrade-major`); each is a
    // distinct compose service so its OWN volume + detected major is evaluated
    // independently. The nango 15→17 hop is the cinatra-ai/cinatra#1417 Case B
    // concrete case, carried as a case-scoped exception (it does NOT widen the
    // general nango baseline, which holds at 17); the platform 17→18 hop is the
    // Case A supported baseline transition.
    postgres: pgService("/var/lib/postgresql", [{ from: "17", to: "18" }]),
    "nango-db": pgService("/var/lib/postgresql", [{ from: "15", to: "17", caseScoped: true }]),
    "twenty-db": pgService("/var/lib/postgresql", []),
    "plane-db": pgService("/var/lib/postgresql", []),
    // Non-Postgres stateful families (epic sub-issue 4): axes are ordered so
    // downgrades/unknown hops are CLASSIFIED (blocked / fail-closed); the hops
    // the authoritative matrix supports are listed with their mechanism but NO
    // executable CLI command yet (migration: null → runbook-guided stop).
    "wordpress-db": {
      order: ["11.4", "11.8"],
      marker: null,
      dataMount: "/var/lib/mysql",
      transitions: [{ from: "11.4", to: "11.8", mechanism: "in-place-store-format", migration: null }],
    },
    "drupal-db": {
      order: ["11.4", "11.8"],
      marker: null,
      dataMount: "/var/lib/mysql",
      transitions: [{ from: "11.4", to: "11.8", mechanism: "in-place-store-format", migration: null }],
    },
    neo4j: {
      order: ["5.26", "2026.05"],
      marker: null,
      dataMount: "/data",
      transitions: [{ from: "5.26", to: "2026.05", mechanism: "in-place-store-format", migration: null }],
    },
    redis: {
      order: ["7", "8"],
      marker: null,
      dataMount: "/data",
      transitions: [{ from: "7", to: "8", mechanism: "discard-recreate", migration: null }],
    },
    "twenty-redis": { order: ["7", "8"], marker: null, dataMount: "/data", transitions: [] },
    "plane-redis": { order: ["7.2.11"], marker: null, dataMount: "/data", transitions: [] },
    "plane-mq": { order: ["3.13"], marker: null, dataMount: "/var/lib/rabbitmq", transitions: [] },
    verdaccio: { order: ["6"], marker: null, dataMount: "/verdaccio/storage", transitions: [] },
  },
});

/** Build a Postgres service entry: the pg major axis, the authoritative
 *  `PG_VERSION` raw marker, and the supported forward hops (all routed through
 *  the sanctioned `db upgrade-major` command via the logical dump→restore
 *  mechanism — pg_dump crosses any source major in one hop). */
function pgService(dataMount, hops) {
  return {
    order: ["15", "16", "17", "18"],
    marker: "PG_VERSION",
    dataMount,
    transitions: hops.map((h) => ({
      from: h.from,
      to: h.to,
      mechanism: "logical-dump-restore",
      migration: h.migration ?? PG_UPGRADE_MAJOR_COMMAND,
      caseScoped: Boolean(h.caseScoped),
    })),
  };
}

/** The service's matrix entry, or null when the matrix does not know the
 *  service (an unknown service is itself a fail-closed condition upstream). */
export function serviceEntry(matrix, service) {
  const entry = matrix?.services?.[service];
  return entry && typeof entry === "object" ? entry : null;
}

/** The authoritative raw on-disk marker file name for a service, or null when no
 *  raw marker is authoritative (only Postgres has one — `PG_VERSION`). */
export function serviceMarkerFile(matrix, service) {
  const entry = serviceEntry(matrix, service);
  return entry && typeof entry.marker === "string" && entry.marker.length ? entry.marker : null;
}

/**
 * Compare two versions on a service's ORDERED axis. INDEX-based, never numeric:
 *   -1  → `a` precedes `b` (a→b is a forward UPGRADE)
 *    0  → same position (matching)
 *    1  → `a` follows `b` (a→b is a DOWNGRADE)
 *  null → either version is not on the axis (INCOMPARABLE → fail closed)
 */
export function compareVersions(matrix, service, a, b) {
  const entry = serviceEntry(matrix, service);
  if (!entry || !Array.isArray(entry.order)) return null;
  const ia = entry.order.indexOf(String(a));
  const ib = entry.order.indexOf(String(b));
  if (ia === -1 || ib === -1) return null;
  if (ia < ib) return -1;
  if (ia > ib) return 1;
  return 0;
}

/** The supported transition record for an EXACT (service, from→to) hop, or null.
 *  A forward-ordered hop that is not listed here is an UNSUPPORTED hop — never
 *  inferred from adjacency. */
export function supportedTransition(matrix, service, from, to) {
  const entry = serviceEntry(matrix, service);
  if (!entry || !Array.isArray(entry.transitions)) return null;
  return (
    entry.transitions.find((t) => String(t.from) === String(from) && String(t.to) === String(to)) ??
    null
  );
}

/** Split an image REFERENCE into { repo, tag, digest } (each null when absent).
 *  Pure. Handles registry ports ("reg:5000/img:tag") and digest pins
 *  ("postgres:18-alpine@sha256:…"). */
export function imageParts(imageRef) {
  if (typeof imageRef !== "string" || imageRef.length === 0) {
    return { repo: null, tag: null, digest: null };
  }
  let rest = imageRef;
  let digest = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }
  // The tag separator is a ":" AFTER the last "/" (else it is a registry port).
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon === -1) return { repo: rest, tag: null, digest };
  return { repo: rest.slice(0, colon), tag: rest.slice(colon + 1) || null, digest };
}

/**
 * Derive the data-format version a service's IMAGE ships, normalized onto the
 * service's ordered axis. Pure. From the image tag ("18-alpine",
 * "3.13.6-management-alpine", "2026.05-community"):
 *   0. try the RAW tag on the axis first (an axis entry may BE a full tag —
 *      e.g. a dated object-store release — which the variant-strip below would
 *      mangle),
 *   1. strip the variant suffix (everything from the first "-"),
 *   2. try the full dotted version, then progressively shorter dotted prefixes
 *      ("3.13.6" → "3.13" → "3"), returning the FIRST one on the axis.
 * Returns null when the image has no tag or nothing lands on the axis — the
 * caller records null and the preflight fails closed rather than guessing.
 */
export function deriveDataFormatVersion(matrix, service, imageRef) {
  const entry = serviceEntry(matrix, service);
  if (!entry || !Array.isArray(entry.order)) return null;
  const { tag } = imageParts(imageRef);
  if (!tag) return null;
  if (entry.order.includes(tag)) return tag;
  const base = tag.split("-")[0];
  if (!base) return null;
  const parts = base.split(".");
  for (let n = parts.length; n >= 1; n -= 1) {
    const candidate = parts.slice(0, n).join(".");
    if (entry.order.includes(candidate)) return candidate;
  }
  return null;
}

export const __test = {
  pgService,
  serviceEntry,
  serviceMarkerFile,
  compareVersions,
  supportedTransition,
  imageParts,
  deriveDataFormatVersion,
};
