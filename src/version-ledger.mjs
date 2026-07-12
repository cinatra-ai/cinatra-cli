// ---------------------------------------------------------------------------
// Deployed-version ledger — the PRIMARY record of what version each stateful
// service is running, per instance, bound to the underlying volume's identity
// (cinatra-cli#128, upgrade-paths epic cinatra-ai/cinatra#1419).
//
// WHY. An upgrade recreates containers blind today: a data volume initialized
// under an older major crash-loops the new image (cinatra-ai/cinatra#1417). The
// platform's own schema fails closed with an actionable message
// (src/lib/boot/phases/schema-version-precondition.ts) — this ledger is the
// env-app-data equivalent's PRIMARY detection source. The installer records the
// deployed image/digest + detected data-format version per stateful service at
// every install/upgrade; the preflight reads this FIRST (before any live probe
// or raw on-disk marker).
//
// VOLUME-IDENTITY BINDING. Every entry is bound to the identity of the volume it
// describes ({ name, createdAt } from `docker volume inspect` — `createdAt`
// changes when a same-named volume is destroyed+recreated). A ledger entry whose
// recorded volume identity does NOT match the live volume is itself a fail-closed
// finding (the recorded version describes a volume that no longer exists — its
// data-format is unknown). The preflight owns that comparison; this module owns
// the record + the transactional write discipline.
//
// TRANSACTIONALITY. A ledger write is transactional with the operation it
// describes so a failed upgrade can NEVER leave a target-version entry beside a
// restored old volume:
//   * recordDeployed  — a plain install/upgrade record (no migration in flight).
//   * beginMigration  — opens a `pending` journal capturing the SOURCE entry +
//                       the candidate TARGET; the live services entry is left
//                       untouched (still the source) until the migration proves
//                       out.
//   * commitMigration — called ONLY AFTER the migration's post-verify passes:
//                       promotes the candidate target into the live entry and
//                       clears the journal.
//   * rollbackMigration — called on a failed/aborted upgrade: RESTORES the source
//                       entry (or removes it if there was none) and clears the
//                       journal. A crash mid-migration leaves the `pending`
//                       journal on disk, which the preflight treats as a
//                       fail-closed "interrupted migration".
//
// Registry file: ~/.cinatra/ledgers/<slug>.json (a sibling of instances.json —
// "stored WITH the instance state"; kept a separate file so a ledger read/write
// never risks the heavily-validated instance-registry classification). Redirect
// via CINATRA_VERSION_LEDGER_DIR (the hermetic-test + alternate-home seam,
// mirroring CINATRA_INSTANCE_REGISTRY).
//
// Import-light: node builtins only + the slug validation REUSED from
// clone-registry (one implementation, not a fork). Never imports index.mjs.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { isValidSlug, withRegistryLock } from "./clone-registry.mjs";

const LEDGER_VERSION = 1;

export function defaultLedgerDir() {
  const override = process.env.CINATRA_VERSION_LEDGER_DIR;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(os.homedir(), ".cinatra", "ledgers");
}

/** Absolute path to a slug's ledger file. */
export function ledgerPath(slug, dir = defaultLedgerDir()) {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid instance slug "${slug}". Must match /^[a-z0-9][a-z0-9-]{0,29}$/.`);
  }
  return path.join(dir, `${slug}.json`);
}

function emptyLedger(slug) {
  return { version: LEDGER_VERSION, slug, services: {}, pending: null, updatedAt: null };
}

/** True iff `v` is a `{ name, createdAt }` volume identity with non-empty strings. */
function isValidVolumeIdentity(v) {
  return (
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    typeof v.createdAt === "string" &&
    v.createdAt.length > 0
  );
}

/** True iff `e` is a structurally-valid service entry. `digest` +
 *  `dataFormatVersion` are nullable (a legacy image may expose neither), but the
 *  service label, the recording timestamp, and the volume identity are required
 *  — an entry with no volume binding could not be checked against the live
 *  volume, defeating the mismatch-is-fail-closed rule. */
function isValidServiceEntry(service, e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  if (e.service !== service) return false;
  if (typeof e.image !== "string" || e.image.length === 0) return false;
  if (e.digest != null && typeof e.digest !== "string") return false;
  if (e.dataFormatVersion != null && typeof e.dataFormatVersion !== "string") return false;
  if (!isValidVolumeIdentity(e.volume)) return false;
  if (typeof e.recordedAt !== "string" || e.recordedAt.length === 0) return false;
  return true;
}

function isValidPending(p) {
  if (p == null) return true;
  if (typeof p !== "object" || Array.isArray(p)) return false;
  if (typeof p.service !== "string" || p.service.length === 0) return false;
  // source may be null (no prior entry — a first record under migration control).
  if (p.source != null && !isValidServiceEntry(p.service, p.source)) return false;
  if (!isValidServiceEntry(p.service, p.target)) return false;
  if (typeof p.startedAt !== "string" || p.startedAt.length === 0) return false;
  return true;
}

/**
 * Read a slug's ledger. NEVER throws.
 * Returns { status, ledger }:
 *   - "missing"   → no file; ledger = a fresh empty ledger for `slug`
 *   - "ok"        → parsed + validated; ledger = the object
 *   - "malformed" → unreadable / invalid JSON / bad shape; ledger = null
 * A malformed ledger is NEVER silently reset — a mutating caller must refuse (see
 * requireUsableLedger) so a corrupt version record can never be papered over with
 * an empty one (which would read as "no recorded version" → the naive-recreate
 * hazard this whole feature closes).
 */
export function readLedger(slug, dir = defaultLedgerDir()) {
  const file = ledgerPath(slug, dir);
  if (!existsSync(file)) return { status: "missing", ledger: emptyLedger(slug) };
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { status: "malformed", ledger: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed", ledger: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "malformed", ledger: null };
  }
  if (parsed.slug !== slug) return { status: "malformed", ledger: null };
  if (!parsed.services || typeof parsed.services !== "object" || Array.isArray(parsed.services)) {
    return { status: "malformed", ledger: null };
  }
  for (const [service, entry] of Object.entries(parsed.services)) {
    if (!isValidServiceEntry(service, entry)) return { status: "malformed", ledger: null };
  }
  if (!isValidPending(parsed.pending ?? null)) return { status: "malformed", ledger: null };
  if (typeof parsed.version !== "number") parsed.version = LEDGER_VERSION;
  if (parsed.pending === undefined) parsed.pending = null;
  return { status: "ok", ledger: parsed };
}

/** Read for a MUTATING operation: throws on a malformed ledger (never auto-reset
 *  — the bad file is left in place for manual repair). */
export function requireUsableLedger(slug, dir = defaultLedgerDir()) {
  const result = readLedger(slug, dir);
  if (result.status === "malformed") {
    throw new Error(
      `Deployed-version ledger for instance "${slug}" is malformed and was NOT modified. ` +
        `Inspect/repair ${ledgerPath(slug, dir)} by hand, then retry.`,
    );
  }
  return result.ledger;
}

/** Atomic write: temp file in the same dir + rename; mode 0600. Creates the
 *  ledger dir if absent. CONTRACT: any read→modify→writeLedger sequence must
 *  run inside withLedgerLock (see above) so concurrent writers can never
 *  clobber each other's journal. */
export function writeLedger(ledger, dir = defaultLedgerDir()) {
  mkdirSync(dir, { recursive: true });
  const file = ledgerPath(ledger.slug, dir);
  const body = { ...ledger, version: ledger.version ?? LEDGER_VERSION, updatedAt: new Date().toISOString() };
  const payload = JSON.stringify(body, null, 2) + "\n";
  const tmp = path.join(dir, `.${ledger.slug}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, payload, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

// --- per-slug write lock ----------------------------------------------------

/**
 * Serialize a read-modify-write of one slug's ledger against concurrent
 * writers (a capture racing a migration's beginMigration must never clobber
 * the pending journal). CONTRACT: EVERY ledger mutation (read → modify →
 * writeLedger) runs inside this lock — today's only writer is the install
 * capture; the migration flows (begin/commit/rollback, cinatra-cli#129) must
 * take it too.
 *
 * Delegates to the repo's hardened advisory file lock (withRegistryLock:
 * O_EXCL create, pid-liveness stale detection, inode-stable TOCTOU-safe
 * steal with no-clobber restore, inode-checked release) rather than
 * maintaining a second lock implementation. Locks `<ledger file>.lock`.
 */
export async function withLedgerLock(slug, dir = defaultLedgerDir(), fn) {
  mkdirSync(dir, { recursive: true });
  const file = ledgerPath(slug, dir); // validates the slug
  return withRegistryLock(file, fn);
}

// --- pure ledger operations (return a NEW ledger; caller persists) ---------

function cloneLedger(ledger) {
  return {
    version: ledger.version ?? LEDGER_VERSION,
    slug: ledger.slug,
    services: { ...ledger.services },
    pending: ledger.pending ?? null,
    updatedAt: ledger.updatedAt ?? null,
  };
}

/** Build a normalized service entry from raw fields. Throws on a missing service
 *  label, image, or volume identity (the non-nullable record). */
export function makeEntry({ service, image, digest = null, dataFormatVersion = null, volume }) {
  if (typeof service !== "string" || service.length === 0) {
    throw new Error("makeEntry requires a non-empty service.");
  }
  if (typeof image !== "string" || image.length === 0) {
    throw new Error("makeEntry requires a non-empty image.");
  }
  if (!isValidVolumeIdentity(volume)) {
    throw new Error("makeEntry requires a volume identity { name, createdAt }.");
  }
  return {
    service,
    image,
    digest: digest ?? null,
    dataFormatVersion: dataFormatVersion ?? null,
    volume: { name: volume.name, createdAt: volume.createdAt },
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Record a deployed version for a service OUTSIDE a migration (a plain
 * install/upgrade that did not cross a guarded data-format boundary). Refuses if
 * a migration for THIS service is in flight — a pending journal must be resolved
 * via commit/rollback, never overwritten by a blind record.
 */
export function recordDeployed(ledger, entryFields) {
  const entry = entryFields.service && entryFields.recordedAt ? entryFields : makeEntry(entryFields);
  if (ledger.pending && ledger.pending.service === entry.service) {
    throw new Error(
      `Cannot recordDeployed for "${entry.service}" — a migration is in flight (pending journal present). ` +
        `Resolve it with commitMigration/rollbackMigration first.`,
    );
  }
  const next = cloneLedger(ledger);
  next.services[entry.service] = entry;
  return next;
}

/**
 * Open a migration journal for `service`: capture the current live entry as the
 * SOURCE and stage the candidate TARGET, WITHOUT touching the live services
 * entry (a preflight reading mid-migration still sees the source version bound to
 * the source volume). Refuses a second concurrent migration.
 */
export function beginMigration(ledger, { service, target }) {
  if (typeof service !== "string" || service.length === 0) {
    throw new Error("beginMigration requires a service.");
  }
  if (ledger.pending) {
    throw new Error(
      `A migration is already in flight for "${ledger.pending.service}". Resolve it before starting another.`,
    );
  }
  const targetEntry = target.service && target.recordedAt ? target : makeEntry({ ...target, service });
  const next = cloneLedger(ledger);
  next.pending = {
    service,
    source: ledger.services[service] ?? null,
    target: targetEntry,
    startedAt: new Date().toISOString(),
  };
  return next;
}

/**
 * Commit the in-flight migration — call ONLY AFTER the migration's post-verify
 * passes. Promotes the staged target into the live entry and clears the journal.
 * Throws if there is no journal or it is for a different service.
 */
export function commitMigration(ledger, service) {
  const p = ledger.pending;
  if (!p) throw new Error("commitMigration: no migration is in flight.");
  if (service != null && p.service !== service) {
    throw new Error(`commitMigration: pending journal is for "${p.service}", not "${service}".`);
  }
  const next = cloneLedger(ledger);
  next.services[p.service] = p.target;
  next.pending = null;
  return next;
}

/**
 * Roll back the in-flight migration — call on a failed/aborted upgrade. RESTORES
 * the source entry (or removes the service entry if there was no source), and
 * clears the journal. The live entry can therefore never end up as the target
 * version beside a restored source volume. Throws if there is no journal or it is
 * for a different service.
 */
export function rollbackMigration(ledger, service) {
  const p = ledger.pending;
  if (!p) throw new Error("rollbackMigration: no migration is in flight.");
  if (service != null && p.service !== service) {
    throw new Error(`rollbackMigration: pending journal is for "${p.service}", not "${service}".`);
  }
  const next = cloneLedger(ledger);
  if (p.source) {
    next.services[p.service] = p.source;
  } else {
    delete next.services[p.service];
  }
  next.pending = null;
  return next;
}

/** The recorded live entry for a service (ignores any pending journal), or null. */
export function getEntry(ledger, service) {
  return ledger?.services?.[service] ?? null;
}

/** The in-flight migration journal for a service, or null. */
export function pendingFor(ledger, service) {
  const p = ledger?.pending;
  return p && p.service === service ? p : null;
}

export const __test = {
  LEDGER_VERSION,
  withLedgerLock,
  defaultLedgerDir,
  ledgerPath,
  emptyLedger,
  isValidVolumeIdentity,
  isValidServiceEntry,
  readLedger,
  requireUsableLedger,
  writeLedger,
  makeEntry,
  recordDeployed,
  beginMigration,
  commitMigration,
  rollbackMigration,
  getEntry,
  pendingFor,
};
