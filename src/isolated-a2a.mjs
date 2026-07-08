// ---------------------------------------------------------------------------
// Isolated A2A dev-peer helpers (cinatra-cli#113).
//
// An isolated install (`--on-conflict=isolated`) generates its own remapped
// `docker-compose.cinatra-isolated.yml` from `docker compose … config`. A fresh
// install now resolves that config with `--profile "*"` (which INCLUDES every
// profile-gated service while PRESERVING each service's `profiles:` key, so they
// stay opt-in), so the `a2a-peers` dev test peers ARE baked in with remapped
// host ports. Two gaps remain that these pure helpers support:
//   * an instance recorded BEFORE the profile-baking change keeps a profile-less
//     compose across every reconcile — detect that (no a2a-peers service with a
//     published port) so it can be regenerated in place, and
//   * bringing the a2a-peers profile up on an isolated stack + wiring the app's
//     peer-URL env needs the a2a-peer services + their REMAPPED host ports, and
//     (for a deterministic regeneration that never moves a running service's
//     port) the band offset the recorded instance used.
//
// Everything here is pure (no docker, no fs, no registry) so it is unit-tested
// directly. The docker/registry-coupled orchestration lives in install.mjs.
// ---------------------------------------------------------------------------

/** The compose profile the A2A dev test peers are gated behind. */
export const A2A_PEERS_PROFILE = "a2a-peers";

/** The env key the app's dev-boot auto-connect (`ensureA2ADevPeerConnections`)
 *  reads — a comma-separated list of peer base URLs. Empty/unset = no-op. */
export const A2A_PEER_ENV_KEY = "CINATRA_A2A_DEV_PEER_URLS";

/** First published host port of a resolved-config service `ports` array, as an
 *  integer, or null. `docker compose config` emits each entry as an object with
 *  a string `.published`; the generator remaps it in place (still an object). */
function firstPublishedPort(svc) {
  const ports = Array.isArray(svc?.ports) ? svc.ports : [];
  for (const p of ports) {
    const pub = p && typeof p === "object" ? p.published : p;
    const n = Number.parseInt(String(pub ?? ""), 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** True when a service opts into the a2a-peers profile. */
function isA2aPeerService(svc) {
  return Array.isArray(svc?.profiles) && svc.profiles.includes(A2A_PEERS_PROFILE);
}

/**
 * Enumerate the a2a-peer services in a (generated or resolved) compose doc that
 * publish a host port, with that port. The port is the REMAPPED host port when
 * the doc is a generated isolated compose. Sorted by host port for stable
 * command args + URL order. Services in the profile but WITHOUT a published
 * port (e.g. the CLI-only `a2a-peer-number-bob`, which sits in a different
 * profile anyway) are excluded — there is nothing to reach.
 *
 * @param {object} doc parsed compose document (`{ services: { … } }`)
 * @returns {{ name: string, hostPort: number }[]}
 */
export function deriveA2aPeerServices(doc) {
  const services = doc && typeof doc.services === "object" && doc.services ? doc.services : {};
  const out = [];
  for (const [name, svc] of Object.entries(services)) {
    if (!isA2aPeerService(svc)) continue;
    const hostPort = firstPublishedPort(svc);
    if (hostPort == null) continue;
    out.push({ name, hostPort });
  }
  out.sort((a, b) => a.hostPort - b.hostPort || a.name.localeCompare(b.name));
  return out;
}

/**
 * Whether a compose doc already carries the a2a-peers services (at least one
 * a2a-peers-profiled service WITH a published port). Used to decide if a
 * recorded isolated compose predates the profile-baking change and needs an
 * in-place regeneration. Deliberately specific (not merely "has any profile")
 * so an unusual partial state still regenerates.
 */
export function isolatedComposeHasA2aPeers(doc) {
  return deriveA2aPeerServices(doc).length > 0;
}

/** Build the peer base-URL list for the app env from the enumerated services.
 *  Loopback `http://localhost:<remapped-host-port>` — the same shape the app's
 *  auto-connect fetches and matches against `docker ps` published ports. */
export function a2aPeerUrlsFromServices(services) {
  return (Array.isArray(services) ? services : []).map((s) => `http://localhost:${s.hostPort}`);
}

/**
 * Derive the host-port band offset a recorded isolated instance used, from its
 * recorded remapped ports vs the checkout's BASE (un-remapped) published band.
 *
 * All services in one isolated stack share a SINGLE offset, so any service
 * present in both maps yields it — but we cross-check EVERY shared service/port
 * and refuse (return null) on any disagreement, so a corrupt registry never
 * drives a wrong-offset regeneration that would move a live service's port.
 *
 * @param {Record<string, number[]>} rowPorts recorded `{ service: [hostPort…] }`
 * @param {{ service: string, port: number }[]} baseBand parsed base published band
 * @returns {number|null} the agreed offset, or null when it cannot be derived
 *   unambiguously (0 shared services, mismatched port counts, or disagreement).
 */
export function deriveBandOffsetFromRow(rowPorts, baseBand) {
  if (!rowPorts || typeof rowPorts !== "object") return null;
  if (!Array.isArray(baseBand) || baseBand.length === 0) return null;

  // base: service -> sorted unique published ports
  const base = new Map();
  for (const entry of baseBand) {
    const svc = entry?.service;
    const port = Number.parseInt(String(entry?.port ?? ""), 10);
    if (typeof svc !== "string" || !svc || !Number.isInteger(port)) continue;
    if (!base.has(svc)) base.set(svc, []);
    base.get(svc).push(port);
  }
  for (const arr of base.values()) arr.sort((a, b) => a - b);

  let offset = null;
  let shared = 0;
  for (const [svc, basePorts] of base) {
    const recorded = rowPorts[svc];
    if (!Array.isArray(recorded)) continue;
    const rec = recorded
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
    // A service present in both must line up port-for-port, or the registry is
    // inconsistent with the checkout — refuse rather than guess.
    if (rec.length !== basePorts.length) return null;
    for (let i = 0; i < basePorts.length; i += 1) {
      const candidate = rec[i] - basePorts[i];
      if (!Number.isInteger(candidate) || candidate <= 0) return null;
      if (offset == null) offset = candidate;
      else if (offset !== candidate) return null; // disagreement → ambiguous
      shared += 1;
    }
  }
  return shared > 0 ? offset : null;
}

/**
 * Whether every service present in BOTH a recorded remapped-port map and a
 * freshly generated one keeps the SAME host port(s). The determinism safety net
 * for an in-place regeneration: regenerating the isolated compose must never
 * move a service that may be RUNNING (a moved host port would recreate its
 * container on the next `up`). At a stable offset this holds by construction —
 * so a disagreement means the checkout's base published band shifted (e.g. the
 * ref moved) or the offset was mis-derived, and the caller must REFUSE to
 * overwrite rather than relocate a live service.
 *
 * Services present on only ONE side are ignored: a new profile-gated service
 * (present only in the regenerated map) is the whole point, and a service that
 * dropped its published port (present only in the recorded map) cannot move.
 *
 * @param {Record<string, number[]>} rowPorts recorded `{ service: [hostPort…] }`
 * @param {Record<string, number[]>} newPorts regenerated `{ service: [hostPort…] }`
 * @returns {boolean} true when no shared service's port changed
 */
export function sharedServicePortsAgree(rowPorts, newPorts) {
  if (!rowPorts || typeof rowPorts !== "object") return true;
  if (!newPorts || typeof newPorts !== "object") return false;
  const norm = (v) =>
    (Array.isArray(v) ? v : [])
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
  for (const [svc, recorded] of Object.entries(rowPorts)) {
    if (!Object.prototype.hasOwnProperty.call(newPorts, svc)) continue;
    const a = norm(recorded);
    const b = norm(newPorts[svc]);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
  }
  return true;
}

/**
 * Remove a `KEY=…` line from a `.env`-style body (all occurrences), collapsing
 * the newline it sat on. Mirror of the insert side of `upsertEnvKey`; used to
 * clear `CINATRA_A2A_DEV_PEER_URLS` when the a2a-peers profile is stopped (the
 * opt-out half of the opt-in wiring). A body without the key is returned
 * unchanged. Never touches other keys or comments.
 */
export function removeEnvKey(body, key) {
  const src = String(body ?? "");
  if (!src) return src;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (!re.test(src)) return src;
  // Drop the whole line including its trailing newline; keep the rest intact.
  const stripped = src.replace(new RegExp(`^${key}=.*(?:\\r?\\n)?`, "gm"), "");
  return stripped;
}
