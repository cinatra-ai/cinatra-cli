// ---------------------------------------------------------------------------
// Instance registry — the source of truth for FULL Cinatra instances that
// `cinatra install` brings up (cinatra-cli#17). Distinct from the CLONE
// registry (`clones.json`, src/clone-registry.mjs), which tracks per-branch
// dev clones that SHARE one infra stack. An INSTANCE is its own complete stack
// (its own compose project, its own Postgres/Redis/Nango containers + named
// volumes, its own app port).
//
// Why a registry (not just live Docker): the AUTHORITATIVE state of an install
// is (registry row) + (live Docker `working_dir` labels). The per-checkout
// `.cinatra/instance.json` marker is a HINT only. A `provisioning` row with no
// live containers is NOT "already installed" — it is a resumable/cleanable
// ghost. `--status`, `--attach`, and `stop-existing` all read this registry as
// truth; a plain default install records a row here too (so those paths have
// authority to read).
//
// Registry file: ~/.cinatra/instances.json
//   { "version": 1, "instances": { "<slug>": {
//       id, slug, mode, installDir, composeProject, composeFiles[],
//       ports: { "<service>": [hostPort, …] },   // per-service LIST: a service
//                                                  // can publish >1 host port
//                                                  // (neo4j → 7474 AND 7687)
//       appPort, repoUrl, ref, sha, infraMode, createdResources[], state,
//       createdAt } } }
//
// Import-light: node builtins only + the lock/atomic-write discipline REUSED
// from clone-registry. It never imports index.mjs (the heavy graph). The lock
// implementation (`withRegistryLock`) and slug validation (`isValidSlug`) are
// imported from clone-registry.mjs so there is ONE implementation, not a fork.
//
// Safety invariants (mirrors clone-registry):
//   - readInstanceRegistry distinguishes missing / ok / malformed; mutating
//     callers go through requireUsableInstanceRegistry, which REFUSES a
//     malformed file (left in place for manual repair, never auto-reset).
//   - Per-slot structural validation + cross-entry uniqueness (slug, appPort,
//     composeProject) — a syntactically-valid JSON file with a structurally
//     bad slot is classified malformed, never silently reused.
//   - Atomic temp+rename write; mode 0600.
// ---------------------------------------------------------------------------

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { isValidSlug, withRegistryLock } from "./clone-registry.mjs";

const REGISTRY_VERSION = 1;

// The lifecycle states a row can hold:
//   - provisioning → allocated but not yet healthy (resumable/cleanable ghost)
//   - ready        → infra up + healthy, install-owned
//   - external     → points at operator-supplied infra (--infra=external);
//                    its resources are NOT install-owned → never auto-dropped.
export const INSTANCE_STATES = new Set(["provisioning", "ready", "external"]);

const VALID_MODES = new Set(["dev", "prod"]);
// infraMode:
//   - "new"      → an install-owned Docker stack (default / isolated).
//   - "external" → operator-supplied infra; resources are not install-owned.
//   - "co-use"   → SHARES a donor instance's running infra (no stack of its own);
//                  its only owned resource is the separate `cinatra_inst_<slug>`
//                  Postgres database. A co-use row records the DONOR's compose
//                  project (it has no project of its own), so — unlike "new" /
//                  "external" rows — co-use rows are EXEMPT from the cross-row
//                  composeProject-uniqueness rule (cinatra-cli#40).
const VALID_INFRA_MODES = new Set(["new", "external", "co-use"]);

export function defaultInstanceRegistryPath() {
  // CINATRA_INSTANCE_REGISTRY redirects the registry (parity with how the clone
  // system can be redirected; also the hermetic-test + alternate-home seam).
  const override = process.env.CINATRA_INSTANCE_REGISTRY;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(os.homedir(), ".cinatra", "instances.json");
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, instances: {} };
}

/** True iff `ports` is a `{ <service>: number[] }` map with positive integers. */
function isValidPortsMap(ports) {
  if (!ports || typeof ports !== "object" || Array.isArray(ports)) return false;
  for (const list of Object.values(ports)) {
    if (!Array.isArray(list) || list.length === 0) return false;
    for (const p of list) {
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return false;
    }
  }
  return true;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}

// Structural validation of one instance slot. A row that does not match this
// shape is registry corruption — readInstanceRegistry classifies the whole file
// `malformed` so requireUsableInstanceRegistry refuses to mutate.
function isValidInstanceSlot(slug, slot) {
  if (!isValidSlug(slug)) return false;
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
  if (slot.slug !== slug) return false;
  if (typeof slot.id !== "string" || slot.id.length === 0) return false;
  if (!VALID_MODES.has(slot.mode)) return false;
  if (typeof slot.installDir !== "string" || slot.installDir.length === 0) return false;
  if (typeof slot.composeProject !== "string" || slot.composeProject.length === 0) return false;
  if (!isStringArray(slot.composeFiles) || slot.composeFiles.length === 0) return false;
  if (!isValidPortsMap(slot.ports)) return false;
  if (slot.appPort != null && (!Number.isInteger(slot.appPort) || slot.appPort <= 0 || slot.appPort > 65535)) {
    return false;
  }
  if (typeof slot.repoUrl !== "string" || slot.repoUrl.length === 0) return false;
  if (typeof slot.ref !== "string" || slot.ref.length === 0) return false;
  if (slot.sha != null && typeof slot.sha !== "string") return false;
  if (!VALID_INFRA_MODES.has(slot.infraMode)) return false;
  if (slot.createdResources != null && !isStringArray(slot.createdResources)) return false;
  if (!INSTANCE_STATES.has(slot.state)) return false;
  if (typeof slot.createdAt !== "string" || slot.createdAt.length === 0) return false;
  return true;
}

// Validate every instance entry AND cross-entry uniqueness on the keys that MUST
// be unique across instances: slug (the map key, by construction), appPort (two
// instances cannot publish the same host app port), and composeProject (two
// instances cannot share a compose project name — that would cross-wire their
// containers/volumes). EXCEPTION (cinatra-cli#40): a "co-use" row records the
// DONOR's compose project (it owns no stack of its own), so co-use rows are
// exempt from the composeProject-uniqueness check — multiple co-use instances
// plus the donor legitimately share one project. appPort uniqueness still holds
// for co-use rows (each co-use instance binds its OWN app port).
function areRegistryEntriesValid(instances) {
  const seenAppPorts = new Set();
  const seenProjects = new Set();
  for (const [slug, slot] of Object.entries(instances)) {
    if (!isValidInstanceSlot(slug, slot)) return false;
    if (slot.appPort != null) {
      if (seenAppPorts.has(slot.appPort)) return false;
      seenAppPorts.add(slot.appPort);
    }
    if (slot.infraMode !== "co-use") {
      if (seenProjects.has(slot.composeProject)) return false;
      seenProjects.add(slot.composeProject);
    }
  }
  return true;
}

/**
 * Read the instance registry file. NEVER throws.
 * Returns { status, registry, raw }:
 *   - "missing"   → file absent; registry = fresh empty registry
 *   - "ok"        → parsed + validated; registry = the parsed object
 *   - "malformed" → unreadable / invalid JSON / bad shape; registry = null,
 *                   raw = bytes on disk (so callers can preserve them)
 */
export function readInstanceRegistry(filePath) {
  if (!existsSync(filePath)) {
    return { status: "missing", registry: emptyRegistry(), raw: null };
  }
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { status: "malformed", registry: null, raw: null, error: err };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: "malformed", registry: null, raw, error: err };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.instances !== "object" ||
    parsed.instances === null ||
    Array.isArray(parsed.instances)
  ) {
    return { status: "malformed", registry: null, raw };
  }
  if (!areRegistryEntriesValid(parsed.instances)) {
    return { status: "malformed", registry: null, raw };
  }
  if (typeof parsed.version !== "number") parsed.version = REGISTRY_VERSION;
  return { status: "ok", registry: parsed, raw };
}

/**
 * Read the registry for a MUTATING command. Throws on a malformed registry
 * because silently resetting it could hand out an app port / compose project an
 * existing instance owns. The bad file is left untouched on disk.
 */
export function requireUsableInstanceRegistry(filePath) {
  const result = readInstanceRegistry(filePath);
  if (result.status === "malformed") {
    throw new Error(
      `Instance registry at ${filePath} is malformed and was NOT modified. ` +
        `Inspect/repair it by hand (or delete it only if you are sure no Cinatra ` +
        `instances are recorded there), then retry.`,
    );
  }
  return result.registry;
}

/** Atomic write: temp file in the same dir + rename. Creates ~/.cinatra/ if absent. */
export function writeInstanceRegistry(filePath, data) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const payload =
    JSON.stringify({ ...data, version: data.version ?? REGISTRY_VERSION }, null, 2) + "\n";
  const tmp = path.join(dir, `.instances.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, filePath);
}

// --- slot operations (pure) ------------------------------------------------

function cloneRegistryObject(registry) {
  return {
    version: registry.version ?? REGISTRY_VERSION,
    instances: { ...registry.instances },
  };
}

/**
 * Allocate (or return the existing) registry row for `slug`.
 *
 * Pure — returns { registry, slot } with a NEW registry object; the caller
 * persists it via writeInstanceRegistry inside the shared alloc lock.
 *
 * - slug present AND same installDir → returns the existing row unchanged
 *   (idempotent re-run, regardless of `state`).
 * - slug present AND different installDir → THROWS (never alias two checkouts
 *   onto one instance row).
 * - slug absent → a fresh `provisioning` row (the caller flips it to `ready`
 *   via markInstanceReady only after infra health succeeds; a leftover
 *   `provisioning` row is a resumable/cleanable ghost, never a silent success).
 *
 * Cross-row collision (different slug, same appPort or same composeProject) is
 * rejected so the registry can never record two instances that would clash.
 */
export function allocateInstance(registry, slug, fields) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid instance slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  const {
    id,
    mode,
    installDir,
    composeProject,
    composeFiles,
    ports,
    appPort = null,
    repoUrl,
    ref,
    sha = null,
    infraMode,
    createdResources = [],
    state = "provisioning",
  } = fields ?? {};

  if (typeof installDir !== "string" || installDir.length === 0) {
    throw new Error("allocateInstance requires a non-empty installDir.");
  }
  if (typeof composeProject !== "string" || composeProject.length === 0) {
    throw new Error("allocateInstance requires a non-empty composeProject.");
  }
  if (!isStringArray(composeFiles) || composeFiles.length === 0) {
    throw new Error("allocateInstance requires a non-empty composeFiles[].");
  }
  if (!VALID_MODES.has(mode)) {
    throw new Error(`allocateInstance requires mode "dev" or "prod" (got ${JSON.stringify(mode)}).`);
  }
  if (!VALID_INFRA_MODES.has(infraMode)) {
    throw new Error(
      `allocateInstance requires infraMode "new", "external", or "co-use" (got ${JSON.stringify(infraMode)}).`,
    );
  }
  if (!INSTANCE_STATES.has(state)) {
    throw new Error(`allocateInstance got an invalid state ${JSON.stringify(state)}.`);
  }

  const existing = registry.instances[slug];
  if (existing) {
    if (existing.installDir !== installDir) {
      throw new Error(
        `Instance slug "${slug}" already maps to ${existing.installDir} — refusing to alias ` +
          `it onto ${installDir}. Use a distinct --instance slug, or release the existing instance first.`,
      );
    }
    return { registry: cloneRegistryObject(registry), slot: existing };
  }

  // Cross-row uniqueness on appPort + composeProject (different slug). A co-use
  // row shares the DONOR's compose project by design (cinatra-cli#40), so the
  // composeProject collision check is SKIPPED when EITHER side is a co-use row —
  // a co-use instance and its donor (or two co-use siblings) legitimately share
  // one project. appPort uniqueness is always enforced (each instance binds its
  // own app port).
  for (const [otherSlug, other] of Object.entries(registry.instances)) {
    if (otherSlug === slug) continue;
    if (appPort != null && other.appPort === appPort) {
      throw new Error(
        `App port ${appPort} is already recorded for instance "${otherSlug}". Choose another --app-port.`,
      );
    }
    const eitherCoUse = infraMode === "co-use" || other.infraMode === "co-use";
    if (!eitherCoUse && other.composeProject === composeProject) {
      throw new Error(
        `Compose project "${composeProject}" is already recorded for instance "${otherSlug}". ` +
          `Choose a distinct --instance slug.`,
      );
    }
  }

  const slot = {
    id: typeof id === "string" && id.length ? id : `inst_${slug}`,
    slug,
    mode,
    installDir,
    composeProject,
    composeFiles: [...composeFiles],
    ports: ports && typeof ports === "object" ? ports : {},
    appPort,
    repoUrl,
    ref,
    sha,
    infraMode,
    createdResources: [...createdResources],
    state,
    createdAt: new Date().toISOString(),
  };
  const next = cloneRegistryObject(registry);
  next.instances[slug] = slot;
  return { registry: next, slot };
}

/** Flip a row to state "ready" after provisioning + health succeed. Optionally
 *  patch the resolved SHA / ports / createdResources discovered during bring-up.
 *  Returns a new registry. */
export function markInstanceReady(registry, slug, patch = {}) {
  const existing = registry.instances[slug];
  if (!existing) {
    throw new Error(`Cannot mark unknown instance slug "${slug}" ready.`);
  }
  const next = cloneRegistryObject(registry);
  next.instances[slug] = { ...existing, ...patch, slug, state: "ready" };
  return next;
}

/** Remove a row. Returns { registry, removed } — `removed` is the dropped row or null. */
export function releaseInstance(registry, slug) {
  const removed = registry.instances[slug] ?? null;
  const next = cloneRegistryObject(registry);
  delete next.instances[slug];
  return { registry: next, removed };
}

export function getInstance(registry, slug) {
  return registry.instances[slug] ?? null;
}

export function listInstances(registry) {
  return Object.entries(registry.instances)
    .map(([slug, slot]) => ({ ...slot, slug }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Find the instance row whose recorded installDir matches `installDir`
 *  (absolute-path compare). Returns { slug, slot } or null. */
export function findInstanceByInstallDir(registry, installDir) {
  if (!registry || typeof installDir !== "string") return null;
  const want = path.resolve(installDir);
  for (const [slug, slot] of Object.entries(registry.instances)) {
    if (typeof slot?.installDir === "string" && path.resolve(slot.installDir) === want) {
      return { slug, slot };
    }
  }
  return null;
}

/** Find the instance row whose recorded composeProject matches. */
export function findInstanceByComposeProject(registry, composeProject) {
  if (!registry || typeof composeProject !== "string") return null;
  for (const [slug, slot] of Object.entries(registry.instances)) {
    if (slot?.composeProject === composeProject) return { slug, slot };
  }
  return null;
}

// --- test surface ----------------------------------------------------------

export const __test = {
  REGISTRY_VERSION,
  INSTANCE_STATES,
  defaultInstanceRegistryPath,
  readInstanceRegistry,
  requireUsableInstanceRegistry,
  writeInstanceRegistry,
  allocateInstance,
  markInstanceReady,
  releaseInstance,
  getInstance,
  listInstances,
  findInstanceByInstallDir,
  findInstanceByComposeProject,
  isValidInstanceSlot,
};
