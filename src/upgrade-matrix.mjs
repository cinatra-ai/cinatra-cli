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

// The CLI's shipped-with copy of the supported matrix. Version-axis orders and
// the supported forward hops reflect the stack pins the 0.1.x line ships; the
// authoritative pin + matrix data is cinatra-ai/cinatra#1420. Services with no
// listed transition currently support NO in-place major hop (fail closed until a
// guarded path lands — epic sub-issues 3 & 4).
export const DEFAULT_UPGRADE_MATRIX = Object.freeze({
  version: "0.1.x-shipped",
  services: {
    // Four Postgres instances share the same guarded logical dump→restore path
    // (epic sub-issue 3); each is a distinct service so its OWN volume + detected
    // major is evaluated independently.
    "postgres-platform": pgService([{ from: "17", to: "18" }]),
    "postgres-nango": pgService([{ from: "15", to: "17" }, { from: "16", to: "17" }]),
    "postgres-twenty": pgService([]),
    "postgres-plane": pgService([]),
    // Non-Postgres stateful families (epic sub-issue 4) — ordered axes are known
    // so downgrades/unknown hops are CLASSIFIED (blocked / fail-closed), but no
    // in-place major transition is supported yet (empty `transitions`).
    "mariadb-wordpress": { order: ["11.4"], marker: null, transitions: [] },
    "mariadb-drupal": { order: ["11.4"], marker: null, transitions: [] },
    neo4j: { order: ["5"], marker: null, transitions: [] },
    "redis-cache": { order: ["7", "8"], marker: null, transitions: [] },
    "redis-queue": { order: ["7", "8"], marker: null, transitions: [] },
    valkey: { order: ["7.2.11"], marker: null, transitions: [] },
    rabbitmq: { order: ["3.13"], marker: null, transitions: [] },
    verdaccio: { order: ["6"], marker: null, transitions: [] },
  },
});

/** Build a Postgres service entry: the pg major axis, the authoritative
 *  `PG_VERSION` raw marker, and the supported forward hops (all routed through
 *  the sanctioned `db upgrade-major` command). */
function pgService(hops) {
  return {
    order: ["15", "16", "17", "18"],
    marker: "PG_VERSION",
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

export const __test = {
  pgService,
  serviceEntry,
  serviceMarkerFile,
  compareVersions,
  supportedTransition,
};
