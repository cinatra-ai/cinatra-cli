// ---------------------------------------------------------------------------
// Supported source→target upgrade matrix — the DECISION TABLE the fail-closed
// upgrade preflight (cinatra-cli#128) consults (part of the upgrade-paths epic,
// cinatra-ai/cinatra#1419).
//
// SCOPE / OWNERSHIP. The AUTHORITATIVE definition of the supported matrix + the
// pinned floating tags is epic sub-issue 1 (cinatra-ai/cinatra#1420), which lands
// in the `cinatra` product (compose pins + the shipped matrix data). This module
// is the CLI's SHIPPED-WITH copy of that decision table: the installed CLI must
// be able to reason about "is this (service, source→target) hop supported?"
// WITHOUT reaching back to a running instance (the preflight runs BEFORE any
// container is recreated, precisely when the app may be down). The preflight
// consumes a matrix OBJECT (injectable) — this module supplies the default one
// plus the PURE lookups over it; when #1420 pins the authoritative data the two
// reconcile to one shape (this is the client half of that contract, mirroring
// how `extensions reconcile` shipped the client half of its host contract).
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
//             migration: "cinatra instance db upgrade-major",
//             caseScoped: false },       //   is an UNSUPPORTED hop → fail closed.
//         ],
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

// The authoritative matrix REVISION this shipped-with copy is reconciled against
// (cinatra-ai/cinatra docs/architecture/upgrade-matrix.json, loaded via
// scripts/lib/upgrade-matrix.mjs `MATRIX_REVISION`). cli#128 shipped this copy as
// the client half of the #1420 contract "to reconcile when the authoritative pins
// land"; #1420 landed at revision 2 (PR #1438), so this copy is reconciled to it
// (cinatra-cli#129): the Postgres transitions here agree with the authoritative
// service list — platform-postgres 17->18 (baseline), the nango-postgres 15->17
// case exception (cinatra-ai/cinatra#1417 Case B), and twenty/plane held at their
// upstream-dictated majors (no in-place major hop). The reconcile is regression-
// guarded by tests/upgrade-matrix-reconcile.test.mjs. Both repos pin this number,
// so a future authoritative revision bump fails closed on skew on both sides.
export const RECONCILED_MATRIX_REVISION = 2;

// The CLI's shipped-with copy of the supported matrix. Version-axis orders and
// the supported forward hops reflect the stack pins the 0.1.x product line ships
// (platform pg 18, nango pg 17, twenty pg 16, plane pg 15.7, mariadb 11.4,
// neo4j 2026.05, redis 8 / twenty-redis 7, valkey 7.2.11, rabbitmq 3.13,
// verdaccio 6); the authoritative pin + matrix data is cinatra-ai/cinatra#1420.
// Services with no listed transition currently support NO in-place major hop
// (fail closed until a guarded path lands — epic sub-issues 3 & 4).
export const DEFAULT_UPGRADE_MATRIX = Object.freeze({
  version: "0.1.x-shipped",
  services: {
    // Four Postgres instances share the same guarded logical dump→restore path
    // (epic sub-issue 3); each is a distinct compose service so its OWN volume +
    // detected major is evaluated independently. The nango 15→17 hop is the
    // cinatra-ai/cinatra#1417 concrete case, carried as a case-scoped exception.
    postgres: pgService("/var/lib/postgresql", [{ from: "17", to: "18" }]),
    // nango-db holds at the upstream-validated pg17 baseline; the ONLY supported
    // forward hop is the pre-baseline pg15 field volume, carried as the
    // cinatra-ai/cinatra#1417 Case B case-scoped exception (skips 16 in one
    // logical dump/restore hop). Reconciled to authoritative revision 2: there is
    // NO general 16->17 nango transition (an earlier shipped copy carried one —
    // removed here so this copy cannot authorize a hop the authoritative matrix
    // fail-closes).
    "nango-db": pgService("/var/lib/postgresql", [
      { from: "15", to: "17", caseScoped: true },
    ]),
    "twenty-db": pgService("/var/lib/postgresql", []),
    "plane-db": pgService("/var/lib/postgresql", []),
    // Non-Postgres stateful families (epic sub-issue 4) — ordered axes are known
    // so downgrades/unknown hops are CLASSIFIED (blocked / fail-closed), but no
    // in-place major transition is supported yet (empty `transitions`). Each
    // carries its RESERVED per-family runbook anchor (cinatra-ai/cinatra#1421):
    // a fail-closed stop message for one of these services deep-links the exact
    // runbook section that documents its (manual, out-of-CLI) guarded path.
    "wordpress-db": { order: ["11.4"], marker: null, dataMount: "/var/lib/mysql", runbookAnchor: "mariadb", transitions: [] },
    "drupal-db": { order: ["11.4"], marker: null, dataMount: "/var/lib/mysql", runbookAnchor: "mariadb", transitions: [] },
    neo4j: { order: ["5", "2026.05"], marker: null, dataMount: "/data", runbookAnchor: "neo4j", transitions: [] },
    redis: { order: ["7", "8"], marker: null, dataMount: "/data", runbookAnchor: "redis-and-valkey", transitions: [] },
    "twenty-redis": { order: ["7", "8"], marker: null, dataMount: "/data", runbookAnchor: "redis-and-valkey", transitions: [] },
    "plane-redis": { order: ["7.2.11"], marker: null, dataMount: "/data", runbookAnchor: "redis-and-valkey", transitions: [] },
    "plane-mq": { order: ["3.13"], marker: null, dataMount: "/var/lib/rabbitmq", runbookAnchor: "rabbitmq", transitions: [] },
    verdaccio: { order: ["6"], marker: null, dataMount: "/verdaccio/storage", runbookAnchor: "verdaccio", transitions: [] },
  },
});

/** Build a Postgres service entry: the pg major axis, the authoritative
 *  `PG_VERSION` raw marker, and the supported forward hops (all routed through
 *  the sanctioned `db upgrade-major` command). */
function pgService(dataMount, hops) {
  return {
    order: ["15", "16", "17", "18"],
    marker: "PG_VERSION",
    dataMount,
    // All four Postgres instances share the runbook's "Postgres" family section.
    runbookAnchor: "postgres",
    transitions: hops.map((h) => ({
      from: h.from,
      to: h.to,
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
 * The runbook URL a service's guided stop / fail-closed message should link.
 * Deep-linked to the service's RESERVED per-family anchor in the upgrade runbook
 * (cinatra-ai/cinatra#1421 acceptance; the reserved anchors landed in
 * cinatra-ai/docs `guides/hosting/upgrading-stateful-services.md`, docs#135) so
 * an operator lands directly on the section that documents their family's path
 * — `#postgres`, `#mariadb`, `#neo4j`, `#redis-and-valkey`, `#rabbitmq`,
 * `#verdaccio`. A service the matrix does not know has no family, so it falls
 * back to the bare page URL (never a broken fragment).
 */
export function serviceRunbookUrl(matrix, service) {
  const entry = serviceEntry(matrix, service);
  const anchor =
    entry && typeof entry.runbookAnchor === "string" && entry.runbookAnchor.length
      ? entry.runbookAnchor
      : null;
  return anchor ? `${UPGRADE_RUNBOOK_URL}#${anchor}` : UPGRADE_RUNBOOK_URL;
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
  serviceRunbookUrl,
  compareVersions,
  supportedTransition,
  imageParts,
  deriveDataFormatVersion,
};
