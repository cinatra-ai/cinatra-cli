// -----------------------------------------------------------------------------
// Registry-user reconcile for `cinatra instance reset --purge-app-data`
// (cinatra-cli#208 — the un-done half of cinatra#2500).
//
// THE GAP: the soft reset purges the app DB but never touched the bundled local
// Verdaccio's USER store. The app mints a Verdaccio npm user per instance
// namespace (an anonymous `PUT /-/user/org.couchdb.user:<namespace>`) and keeps
// the generated password in its own DB. Purging the DB throws that password
// away; the `htpasswd` entry survives with the OLD hash. Re-onboarding under the
// same name then re-issues the adduser call with a FRESH password, Verdaccio
// sees an existing user with a mismatched password, and answers HTTP 401 — the
// operator is blocked at `/setup/name` on a supposedly fresh instance. Every
// reset left one more orphan behind, so the store grew unboundedly.
//
// THE FIX: a `--purge-app-data` reset now removes exactly the `htpasswd` entries
// the purged database claimed as its own, and nothing else.
//
// WHY THE REGISTRY IS RESTARTED AFTERWARDS (found by running the real command
// against a real registry, not by reading the file): Verdaccio's htpasswd plugin
// reloads the file into an in-memory map with `Object.assign(this.users, parse(
// buffer))` — a MERGE. It learns new users, and it never forgets one that
// disappeared from the file. Rewriting `htpasswd` alone therefore changes
// nothing for the running process: the next adduser still matches the stale
// in-memory hash and still answers 401. The reconcile restarts the registry
// service after a rewrite and waits for it to serve again, which is what makes
// the removal take effect. No rewrite, no restart.
//
// WHAT COUNTS AS "ITS OWN" (read from `<schema>.metadata` BEFORE the schema is
// dropped, because the drop destroys the evidence):
//   - `instance_identity` → `instanceNamespace` (the live namespace) and every
//     `oldInstanceNamespaces[].name` (namespaces this instance published under
//     before a rename; each one minted its own registry user).
//   - `instance_identity_pending_provision` → `instanceNamespace` (a user that
//     was minted for a rename whose identity write never landed — an orphan the
//     moment the row is purged).
//   - The legacy key spellings (`vendorName` / `oldVendorNames`) are read too,
//     mirroring the app's own back-compat read shim.
//
// THE PURGE BOUNDARY (deliberately narrow — see the PR/CHANGELOG):
//   - `--purge-app-data` removes the users above. Package storage is NEVER
//     touched: only lines of `htpasswd` are rewritten, and every published
//     tarball, packument and dist-tag stays exactly where it was. `htpasswd` is
//     also the ONLY user state on disk — the sibling `.verdaccio-db.json` is the
//     package list plus the token-signing secret, and clearing that would
//     destroy package storage, so it is left alone.
//   - `--keep-app-data` removes NOTHING. The app keeps its DB, so it keeps the
//     encrypted password that matches the surviving `htpasswd` hash — deleting
//     the user there would break a working instance.
//   - `--full` needs nothing from this module: it runs `docker compose down -v`,
//     which destroys the whole Verdaccio volume (users AND packages) before
//     rebuilding from scratch.
//   - Users this instance never claimed — the `cinatra-dev-seed` publisher, and
//     throwaway users left by e2e lanes — are LEFT ALONE. The reset has no
//     evidence that they are orphans, and silently deleting another workflow's
//     registry account is worse than the collision this fixes. Garbage-collecting
//     abandoned test users is tracked separately (cinatra-cli#208, item 3).
//
// FAILURE DISCIPLINE: loud-but-non-fatal, like the dev registry seed. This step
// runs AFTER the destructive DB purge, so throwing here would abort a reset that
// has already dropped the schema and leave the instance half-built. A registry
// that is down, a write that fails, or a restart that does not come back warns
// and lets the reset finish. Every such warning NAMES THE USERS, because the
// evidence is already gone: the schema that recorded them was dropped a moment
// earlier, so a later re-run would find nothing to reconcile and "run the reset
// again" would be a lie. The warning is the operator's only remaining record.
//
// CONCURRENCY (honest boundary — read this before "improving" the rewrite):
// the rewrite reads the file, filters in-process, and replaces it. Two things
// narrow that to a residual, and one thing does not close it:
//   - The replacement is a COMPARE-AND-SWAP: the read snapshots the file inside
//     the container and the rewrite lands only if the live file still equals
//     that snapshot. Anything that wrote in between causes a refusal, not a
//     silent overwrite of the other writer's change.
//   - The staging file is written before the compare, so the interval between
//     the check and the rename is a single `mv`.
//   - RESIDUAL, NOT CLOSED: a write landing inside that `mv` window would still
//     be lost, and nothing here can detect it (the reset never saw that entry).
//     Closing it needs real exclusion — stopping the service and editing the
//     volume from a one-off container, or taking the lockfile Verdaccio's own
//     htpasswd plugin takes. Both were considered and rejected for this
//     DEVELOPMENT-only reset of a local single-operator registry whose app has
//     just had its database dropped and is not serving: the stop/run/start route
//     trades one exec for three container-lifecycle operations that must each be
//     unwound if they fail mid-reset (a failed unwind leaves the registry DOWN,
//     which is worse than the window it removes), and guessing the lock protocol
//     wrong wedges the registry permanently. If the app ever writes to this
//     registry concurrently with a reset, revisit that trade.
// What IS defended after the fact: the removal is VERIFIED against the live
// store once the registry is back, so a resurrected entry is reported rather
// than assumed away.
//
// SHELL SAFETY: no namespace, user name or file content is ever interpolated
// into a shell command. The commands this module runs are constant strings over
// constant paths; the filtering happens in-process and the new file content
// travels on STDIN.
//
// Dependency-light on purpose (node builtins + the `docker` binary the rest of
// the reset already shells out to), so it stays importable from the `.mjs` CLI.
// -----------------------------------------------------------------------------

import process from "node:process";
import { spawnSync } from "node:child_process";

/** Compose service that runs the bundled local registry. */
export const VERDACCIO_COMPOSE_SERVICE = "verdaccio";

/**
 * The Verdaccio user store. Fixed by `docker/verdaccio/config.yaml`
 * (`auth.htpasswd.file`) in the cinatra checkout; it lives INSIDE the storage
 * volume, alongside — but entirely separate from — package storage.
 */
export const VERDACCIO_HTPASSWD_PATH = "/verdaccio/storage/htpasswd";

/** Staging path for the atomic rewrite (same directory ⇒ `mv` is a rename). */
export const VERDACCIO_HTPASSWD_TMP_PATH = "/verdaccio/storage/htpasswd.cinatra-reset.tmp";

/** The exact bytes that were filtered, kept for the compare-and-swap. */
export const VERDACCIO_HTPASSWD_SNAPSHOT_PATH = "/verdaccio/storage/htpasswd.cinatra-reset.snapshot";

/** Exit status the rewrite uses for "the live file moved under us". */
export const STORE_CHANGED_EXIT = 9;

/** `<schema>.metadata` key holding the instance identity blob. */
export const INSTANCE_IDENTITY_METADATA_KEY = "instance_identity";

/** `<schema>.metadata` key holding a minted-but-uncommitted registry credential. */
export const PENDING_PROVISION_METADATA_KEY = "instance_identity_pending_provision";

/** Ceiling on the post-restart wait: 60 × 500ms. Verdaccio boots in about a second. */
export const RESTART_READY_ATTEMPTS = 60;
export const RESTART_READY_INTERVAL_MS = 500;

// The commands, as constants. `sh`/`test`/`cat`/`mv`/`rm` are busybox builtins
// in the alpine-based verdaccio image, and `node` is the image's own runtime —
// the readiness probe is the compose healthcheck verbatim.
const PROBE_COMMAND = "printf ready";

// The read answers a MARKER first, so "the file is not there" (a clean
// nothing-to-do) can never be confused with "the command failed" — both would
// otherwise be a bare non-zero status, and by this point the database evidence
// is already gone. It also takes the snapshot the compare-and-swap needs.
const READ_COMMAND =
  `if [ -f '${VERDACCIO_HTPASSWD_PATH}' ]; then ` +
  `cp '${VERDACCIO_HTPASSWD_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}' && ` +
  `printf 'PRESENT\\n' && cat '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}'; ` +
  `else printf 'ABSENT\\n'; fi`;

// Compare-and-swap: the rewrite lands ONLY if the live file still equals the
// snapshot that was filtered. A write that raced this one therefore causes a
// REFUSAL (STORE_CHANGED_EXIT) instead of silently discarding whatever the other
// writer added. The staging file is written FIRST so that the compare and the
// rename are adjacent — the check-to-act interval is one `mv`. That is as tight
// as this gets without holding a lock Verdaccio honors; see the header note on
// the residual window. The snapshot is removed on every path.
const WRITE_COMMAND =
  `cat > '${VERDACCIO_HTPASSWD_TMP_PATH}' || ` +
  `{ rm -f '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}'; exit 1; }; ` +
  `cmp -s '${VERDACCIO_HTPASSWD_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}' || ` +
  `{ rm -f '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}'; exit ${STORE_CHANGED_EXIT}; }; ` +
  `mv '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_PATH}'; ` +
  `rc=$?; rm -f '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}'; exit $rc`;

const VERIFY_COMMAND =
  `if [ -f '${VERDACCIO_HTPASSWD_PATH}' ]; then printf 'PRESENT\\n'; cat '${VERDACCIO_HTPASSWD_PATH}'; ` +
  `else printf 'ABSENT\\n'; fi`;

const CLEANUP_COMMAND =
  `rm -f '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_SNAPSHOT_PATH}'`;

const READY_COMMAND =
  `node -e "fetch('http://127.0.0.1:4873/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"`;

/**
 * Read one `<schema>.metadata` row value.
 *
 * The column holds a JSON *string* for both the app and this CLI; a pre-parsed
 * object is accepted too, so a future column-type change (or a driver that
 * parses `jsonb` for us) cannot silently turn every namespace read into
 * "nothing recorded".
 *
 * Returns `{ ok: true, value }` where `value` is the record object, or `null`
 * for the legitimately EMPTY record — the app clears its pending-provision stash
 * by writing literal JSON `null`, so that shape is normal and means "no
 * credential pending".
 *
 * Returns `{ ok: false }` for a row that exists but is not a record at all:
 * unparseable text, an empty value, an array, or a bare scalar. The caller must
 * treat that as fatal — it may be the only surviving name of a minted registry
 * user, and purging past it would strand that user silently.
 */
export function parseMetadataRow(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw === "object") {
    return Array.isArray(raw) ? { ok: false } : { ok: true, value: raw };
  }
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (parsed === null) return { ok: true, value: null };
  if (typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed };
}

/**
 * Every registry namespace the purged database claimed, in a stable order and
 * without duplicates. Tolerant by construction: a missing row, a missing field
 * or a malformed `oldInstanceNamespaces` entry contributes nothing rather than
 * throwing — a reset must not fail over a shape it did not expect.
 */
export function collectAppOwnedRegistryNamespaces({ identity, pendingProvision } = {}) {
  const namespaces = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || namespaces.includes(trimmed)) return;
    namespaces.push(trimmed);
  };

  add(identity?.instanceNamespace);
  // Legacy spelling still readable by the app's own back-compat shim.
  add(identity?.vendorName);

  const previous = identity?.oldInstanceNamespaces ?? identity?.oldVendorNames;
  if (Array.isArray(previous)) {
    for (const entry of previous) {
      add(typeof entry === "string" ? entry : entry?.name);
    }
  }

  add(pendingProvision?.instanceNamespace);

  return namespaces;
}

/**
 * The user name an `htpasswd` line declares, or null for a line that declares
 * none (blank lines and `#` comments). The format is `name:hash[:comment]`, so
 * the name is everything before the first colon.
 */
export function htpasswdUserName(line) {
  if (typeof line !== "string") return null;
  if (line.trim() === "" || line.trimStart().startsWith("#")) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  return line.slice(0, colon);
}

/**
 * Rewrite `contents` without the entries for `namespaces`. Comments and every
 * unlisted user survive byte-for-byte. Returns the new text plus what was
 * removed and what stayed, so the caller can report honestly.
 *
 * The trailing newline is normalized (one at the end, none for an empty file)
 * — that is the shape Verdaccio itself writes.
 */
export function filterHtpasswdEntries(contents, namespaces) {
  const doomed = new Set(namespaces ?? []);
  const lines = String(contents ?? "").split(/\r?\n/);

  const kept = [];
  const removed = [];
  const remaining = [];

  for (const line of lines) {
    const name = htpasswdUserName(line);
    if (name === null) {
      // Blank line or comment: keep the comment, drop pure padding (the join
      // below re-adds the single trailing newline).
      if (line.trim() !== "") kept.push(line);
      continue;
    }
    if (doomed.has(name)) {
      removed.push(name);
      continue;
    }
    kept.push(line);
    remaining.push(name);
  }

  const text = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  return { text, removed, remaining, changed: removed.length > 0 };
}

/**
 * Default transport over the compose `verdaccio` service. `exec` runs one shell
 * command inside it with `input` on STDIN; `restart` bounces it. Both mirror how
 * the reset already reaches its containers (`docker compose exec -T redis …`),
 * so they inherit the same project/compose-file resolution from `repoRoot`.
 *
 * Both return a plain record instead of throwing — every caller here decides for
 * itself whether a non-zero status is fatal (none of them are).
 */
export function createComposeRegistryTransport(repoRoot, { spawn = spawnSync } = {}) {
  const call = (args, input) => {
    const result = spawn("docker", args, {
      cwd: repoRoot,
      input: input ?? "",
      encoding: "utf8",
      env: process.env,
    });
    return {
      status: result?.error ? null : (result?.status ?? null),
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  };

  return {
    exec: ({ command, input }) =>
      call(["compose", "exec", "-T", VERDACCIO_COMPOSE_SERVICE, "sh", "-c", command], input),
    restart: () => call(["compose", "restart", VERDACCIO_COMPOSE_SERVICE]),
  };
}

/**
 * Bounce the registry and wait until it serves again. Returns true once the
 * in-container readiness probe passes, false when the ceiling is reached — the
 * caller reports that, it never throws.
 */
async function restartAndWait({ transport, sleep }) {
  const restart = transport.restart();
  if (restart.status !== 0) return false;

  for (let attempt = 0; attempt < RESTART_READY_ATTEMPTS; attempt++) {
    if (transport.exec({ command: READY_COMMAND }).status === 0) return true;
    await sleep(RESTART_READY_INTERVAL_MS);
  }
  return false;
}

/**
 * Split a marker-prefixed store read into presence + contents. Returns null when
 * the marker is missing or unrecognized, which the caller must treat as an
 * operational failure — never as "no store".
 */
export function parseStoreRead(stdout) {
  const text = String(stdout ?? "");
  const newline = text.indexOf("\n");
  const marker = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (marker === "ABSENT") return { present: false, contents: "" };
  if (marker === "PRESENT") {
    return { present: true, contents: newline === -1 ? "" : text.slice(newline + 1) };
  }
  return null;
}

// Every failure branch says this. The row that recorded these users was dropped
// moments ago, so "try again" would be a lie.
const NO_RERUN =
  `Re-running the reset will NOT redo this: the database row that named these users is already purged.`;

/** The manual remedy, naming the users. */
function manualRemedy(names) {
  return (
    `Remove ${names.join(", ")} from ${VERDACCIO_HTPASSWD_PATH} in the ` +
    `"${VERDACCIO_COMPOSE_SERVICE}" container, then restart that container. ` +
    `Package storage is not affected. ${NO_RERUN}`
  );
}

/**
 * Remove the registry users the purged instance owned.
 *
 * Outcomes (all non-throwing):
 *   - `nothing-recorded`      the purged DB named no registry namespace.
 *   - `registry-unavailable`  the registry container did not answer a probe.
 *   - `no-user-store`         the registry says it has no `htpasswd` yet.
 *   - `read-failed`           the store could not be read, or answered garbage.
 *   - `already-clean`         no listed namespace has an entry — nothing written.
 *   - `store-changed`         the file moved between the read and the write, so
 *                             the rewrite REFUSED rather than discard the other
 *                             writer's change.
 *   - `write-failed`          the rewrite failed; the old file is intact.
 *   - `restart-failed`        entries removed, but the registry did not come back,
 *                             so it may still serve the old in-memory user.
 *   - `verify-failed`         the registry came back still holding an entry that
 *                             should be gone, or the removal could not be checked.
 *   - `purged`                entries removed, file rewritten, registry restarted,
 *                             and the removal verified against the live store.
 *
 * `already-clean` is what a second consecutive run produces, which is what makes
 * the step idempotent: it re-reads, finds nothing of its own, writes nothing and
 * restarts nothing.
 */
export async function purgeLocalRegistryUsers({
  namespaces,
  transport,
  log = () => {},
  warn = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const owned = Array.isArray(namespaces) ? namespaces.filter(Boolean) : [];

  if (owned.length === 0) {
    log("  ✓ The purged database recorded no registry user. Nothing to reconcile.");
    return { outcome: "nothing-recorded", removed: [], remaining: [] };
  }

  const probe = transport.exec({ command: PROBE_COMMAND });
  if (probe.status !== 0) {
    warn(
      `  ⚠ Could not reach the local registry container, so its user store was left alone. ` +
        `These users can block the next onboarding at /setup/name. ${manualRemedy(owned)}`,
    );
    return { outcome: "registry-unavailable", removed: [], remaining: [] };
  }

  const read = transport.exec({ command: READ_COMMAND });
  const store = read.status === 0 ? parseStoreRead(read.stdout) : null;
  if (!store) {
    // The read may have taken the snapshot before failing — leave nothing behind.
    transport.exec({ command: CLEANUP_COMMAND });
    warn(
      `  ⚠ Could not read the local registry user store, so it was left alone. ` +
        `These users can block the next onboarding at /setup/name. ${manualRemedy(owned)}`,
    );
    return { outcome: "read-failed", removed: [], remaining: [] };
  }

  if (!store.present) {
    log("  ✓ The local registry has no user store yet. Nothing to reconcile.");
    return { outcome: "no-user-store", removed: [], remaining: [] };
  }

  const { text, removed, remaining, changed } = filterHtpasswdEntries(store.contents, owned);

  if (!changed) {
    // The read left a snapshot behind; drop it since nothing will be written.
    transport.exec({ command: CLEANUP_COMMAND });
    log(
      `  ✓ The local registry holds no user for this instance. ` +
        `${remaining.length} registry user(s) stay.`,
    );
    return { outcome: "already-clean", removed: [], remaining };
  }

  const write = transport.exec({ command: WRITE_COMMAND, input: text });
  if (write.status === STORE_CHANGED_EXIT) {
    warn(
      `  ⚠ The local registry user store changed while the reset was reading it, so nothing ` +
        `was rewritten — another writer's change would have been lost. ${manualRemedy(removed)}`,
    );
    return { outcome: "store-changed", removed: [], remaining: [...remaining, ...removed] };
  }
  if (write.status !== 0) {
    // Best-effort: drop the staging + snapshot files so nothing is left behind.
    transport.exec({ command: CLEANUP_COMMAND });
    warn(
      `  ⚠ Could not rewrite the local registry user store, so it is unchanged. ` +
        `${manualRemedy(removed)}`,
    );
    return { outcome: "write-failed", removed: [], remaining: [...remaining, ...removed] };
  }

  // The registry keeps a MERGED in-memory copy of the file and never forgets a
  // removed user, so the rewrite only takes effect after a restart.
  const restarted = await restartAndWait({ transport, sleep });
  if (!restarted) {
    warn(
      `  ⚠ Removed ${removed.join(", ")} from the local registry user store, but the ` +
        `registry did not come back within ${(RESTART_READY_ATTEMPTS * RESTART_READY_INTERVAL_MS) / 1000}s. ` +
        `It keeps removed users in memory until it restarts, so restart the ` +
        `"${VERDACCIO_COMPOSE_SERVICE}" container before you onboard. ${NO_RERUN}`,
    );
    return { outcome: "restart-failed", removed, remaining };
  }

  // Verify against the LIVE store rather than assuming the rewrite stuck. This
  // catches an entry that came back — a write that raced this one, or a registry
  // that flushed its stale map over the file. A verification that cannot run is
  // NOT a success: it is reported as unverified.
  const verify = transport.exec({ command: VERIFY_COMMAND });
  const verified = verify.status === 0 ? parseStoreRead(verify.stdout) : null;
  if (!verified) {
    warn(
      `  ⚠ Removed ${removed.join(", ")} from the local registry user store, but the removal ` +
        `could not be verified afterwards. ${manualRemedy(removed)}`,
    );
    return { outcome: "verify-failed", removed, remaining, stillPresent: [] };
  }
  const stillPresent = removed.filter((name) =>
    verified.contents.split(/\r?\n/).some((line) => htpasswdUserName(line) === name),
  );
  if (stillPresent.length > 0) {
    warn(
      `  ⚠ The local registry still holds ${stillPresent.join(", ")} after the reconcile. ` +
        `${manualRemedy(stillPresent)}`,
    );
    return { outcome: "verify-failed", removed, remaining, stillPresent };
  }

  log(
    `  ✓ Removed ${removed.length} registry user(s) this instance owned: ${removed.join(", ")}. ` +
      `${remaining.length} registry user(s) stay. Package storage is untouched.`,
  );
  return { outcome: "purged", removed, remaining };
}
