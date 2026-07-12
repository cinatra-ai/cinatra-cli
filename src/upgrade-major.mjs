// ---------------------------------------------------------------------------
// `cinatra instance db upgrade-major` — the guarded logical
// dump → fresh-volume → restore Postgres major upgrade (cinatra-cli#129,
// upgrade-paths epic cinatra-ai/cinatra#1419; the concrete transitions are
// cinatra-ai/cinatra#1417's Case A platform 17→18 and Case B nango 15→17).
//
// ONE command covers every Postgres instance in the stack (per-instance
// selection via --service: postgres / nango-db / twenty-db / plane-db), DRIVEN
// BY THE MATRIX: only a (service, detected → target) hop the shipped matrix
// supports (transition or case-scoped exception, mechanism logical-dump-restore,
// sanctioned command = this one) is executable. Everything else is refused with
// the preflight's own fail-closed message. Developed as the coordinated pair
// with the cinatra works-after upgrade-from fixtures
// (scripts/ci/works-after/postgres.sh + nango-db-upgrade.sh, resolving the SAME
// authoritative matrix revision — AUTHORITATIVE_MATRIX_REVISION): the fixtures
// prove the mechanism per transition; this engine executes it transactionally.
//
// THE TRANSACTION (issue frame — each step gates the next; a failed step
// aborts and ROLLS BACK, never leaving a half-cut store):
//   1. Preflight handshake — the fail-closed preflight must return exactly a
//      STOP for the requested service whose supported transition names THIS
//      command; the engine then acts as the transition-scoped authorization for
//      exactly that (service, source, target).
//   2. Disk-space prechecks (backup destination AND docker root) BEFORE
//      touching anything.
//   3. Quiesce: stop the RUNNING reverse-dependents (writers/queue consumers) —
//      a logical dump is only instance-consistent without concurrent writers.
//   4. Verified backup: roles/tablespaces via pg_dumpall --globals-only + a
//      custom-format pg_dump per database, each written via a direct
//      file-descriptor (NO shell pipe — the exit status IS the pipeline-failure
//      detection), sha256-checksummed into a manifest.
//   5. Content stats captured from the quiesced source (exact per-table row
//      counts) — the read-back baseline.
//   6. Fresh target-major volume + ledger journal (beginMigration stages the
//      candidate target entry bound to the NEW volume's identity; the live
//      entry still names the source — a preflight mid-migration fails closed).
//   7. Stop the source service; boot a SCRATCH target-image container on the
//      fresh volume (the deployment's own declared mount target — pg18 parent
//      layout vs legacy …/data comes from the resolved compose config, never an
//      assumption); restore globals (tolerant apply + role read-back — the
//      DEFINED strategy for objects the fresh-cluster bootstrap already
//      created: expected collisions are verified by outcome, never blind), then
//      per-database pg_restore --exit-on-error.
//   8. Verify: per-table read-backs against step 5 (table set + exact counts,
//      both directions) — stronger than a bare row total.
//   9. CUTOVER: rebind the compose volume key to the restored volume via the
//      CLI-managed override file (JSON — valid YAML — so the CLI can merge it
//      deterministically) + record the override in the instance row's
//      composeFiles; `up -d` recreates the service on the new volume; wait
//      ready; re-run the read-backs THROUGH the compose service (the live
//      surface, not the scratch container).
//  10. Ledger COMMIT (only after post-verify) → restart the quiesced
//      dependents. The app's own boot then self-bootstraps + runs its ledgered
//      migrations (cinatra-ai/cinatra#1417 boot-order note).
//
// ROLLBACK (any failure after quiesce): stop the scratch container, remove the
// cutover override (if written), roll the ledger journal back (restores the
// SOURCE entry), bring the service back up on the ORIGINAL volume, restart the
// dependents. The OLD volume is NEVER modified or removed by this command —
// success retires it (preserved + documented cleanup rule), failure lands back
// on it intact.
//
// RETENTION (documented rule, printed on success + in the manifest): the
// retired source volume and the backup artifacts are KEPT. Remove them manually
// (`docker volume rm <retired>` / delete the backup directory) only after the
// upgraded deployment has proven itself in real use — the runbook
// (UPGRADE_RUNBOOK_URL) owns the operator guidance.
//
// SHAPE. The engine (runUpgradeMajor) is PURE over an injected transport — the
// unit of the failure-injection tests (every abort path asserts the ledger
// landed back on the source entry and nothing touched the old volume). The
// REAL docker/compose transport (buildDockerUpgradeTransport) lives below the
// engine in this same module behind an injectable capture seam, mirroring
// version-ledger-capture.mjs. index.mjs wires discovery + transport.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  AUTHORITATIVE_MATRIX_REVISION,
  DEFAULT_UPGRADE_MATRIX,
  PG_UPGRADE_MAJOR_COMMAND,
  UPGRADE_RUNBOOK_URL,
  supportedTransition,
} from "./upgrade-matrix.mjs";
import {
  beginMigration,
  commitMigration,
  ledgerPath,
  makeEntry,
  requireUsableLedger,
  rollbackMigration,
  withLedgerLock,
  writeLedger,
} from "./version-ledger.mjs";
import { withRegistryLock } from "./clone-registry.mjs";
import { composeBaseArgs } from "./version-ledger-capture.mjs";
import { VERDICTS } from "./upgrade-preflight.mjs";

// The CLI-managed compose override that rebinds retired data-volume keys to
// their restored successors. JSON body (valid YAML → compose merges it; the CLI
// re-reads it with JSON.parse). ONE well-known file, shared by every service's
// cutover, appended ONCE to the instance row's composeFiles.
export const DB_VOLUME_OVERRIDE_FILE = "docker-compose.db-volumes.yml";

// Headroom the disk prechecks demand beyond the measured database size: the
// dump destination needs the (compressed) dump itself, the docker root needs
// the restored cluster + WAL. Deliberately conservative multipliers.
const BACKUP_HEADROOM_FACTOR = 1.2;
const RESTORE_HEADROOM_FACTOR = 1.5;
const MIN_FREE_BYTES = 256 * 1024 * 1024;

// --- args -------------------------------------------------------------------

const USAGE =
  "Usage: cinatra instance db upgrade-major --service <compose-service> [--instance <slug>] [--json]\n" +
  "  Guarded logical dump→fresh-volume→restore for a Postgres instance whose\n" +
  "  supported major upgrade the preflight reports as pending. Transactional:\n" +
  "  any failure rolls back onto the intact source volume; the retired volume\n" +
  "  and the checksummed backups are preserved.";

/** Parse the args AFTER `cinatra instance db upgrade-major`. Strict: unknown
 *  flags are rejected; `--service` is required (per-instance selection). */
export function parseUpgradeMajorArgs(argv) {
  let json = false;
  let service = null;
  let slug = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { json = true; continue; }
    if (a === "--service" || a.startsWith("--service=")) {
      const v = a.startsWith("--service=") ? a.slice("--service=".length) : argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value for --service.");
      service = v;
      continue;
    }
    if (a === "--instance" || a.startsWith("--instance=")) {
      const v = a.startsWith("--instance=") ? a.slice("--instance=".length) : argv[++i];
      if (!v || v.startsWith("--")) throw new Error("Missing value for --instance.");
      slug = v;
      continue;
    }
    throw new Error(`Unexpected argument "${a}" for ${PG_UPGRADE_MAJOR_COMMAND}. ${USAGE}`);
  }
  if (!service) throw new Error(`--service is required (which Postgres instance to upgrade). ${USAGE}`);
  return { json, service, slug };
}

// --- pure verification helpers ----------------------------------------------

/** Compare source vs restored per-table exact counts (both directions, per
 *  database). Returns a list of human-readable mismatch strings (empty = OK). */
export function compareContentStats(source, restored) {
  const mismatches = [];
  const dbs = new Set([...Object.keys(source ?? {}), ...Object.keys(restored ?? {})]);
  for (const db of dbs) {
    const s = source?.[db] ?? null;
    const r = restored?.[db] ?? null;
    if (!s) { mismatches.push(`database "${db}" present after restore but not in the source stats`); continue; }
    if (!r) { mismatches.push(`database "${db}" missing after restore`); continue; }
    const tables = new Set([...Object.keys(s), ...Object.keys(r)]);
    for (const t of tables) {
      if (!(t in s)) { mismatches.push(`${db}: table ${t} appeared after restore (not in source)`); continue; }
      if (!(t in r)) { mismatches.push(`${db}: table ${t} missing after restore`); continue; }
      if (String(s[t]) !== String(r[t])) {
        mismatches.push(`${db}: table ${t} row count ${r[t]} after restore != source ${s[t]}`);
      }
    }
  }
  return mismatches;
}

/** Extract the role names a `pg_dumpall --globals-only` dump creates. Pure. */
export function rolesFromGlobalsDump(sql) {
  const roles = new Set();
  if (typeof sql !== "string") return [];
  const re = /^CREATE ROLE ("?)([^";\n]+)\1;/gm;
  let m;
  while ((m = re.exec(sql)) !== null) roles.add(m[2]);
  return [...roles];
}

/**
 * The DEFINED fresh-cluster-collision strategy, as a pure transform: drop the
 * CREATE ROLE / ALTER ROLE statements for the BOOTSTRAP role (the fresh target
 * cluster's initdb already created it, with its password from the same compose
 * environment), so the remaining globals can be applied STRICTLY
 * (ON_ERROR_STOP) — any OTHER failure (extra roles, memberships, tablespaces)
 * aborts loudly instead of being tolerated. Never a blind lenient replay.
 */
export function filterGlobalsForBootstrap(sql, bootstrapRole) {
  if (typeof sql !== "string") return "";
  const quoted = `"${String(bootstrapRole).replace(/"/g, '""')}"`;
  return sql
    .split("\n")
    .filter((line) => {
      const m = line.match(/^(?:CREATE|ALTER) ROLE ("[^"]+"|[^\s;]+)/);
      if (!m) return true;
      return m[1] !== bootstrapRole && m[1] !== quoted;
    })
    .join("\n");
}

/** Conservative identifier gate for database/role names this engine shells
 *  through. Anything outside it aborts the transaction (fail closed) rather
 *  than risking mis-quoted shell interpolation. */
export function isSafeDbIdentifier(name) {
  return typeof name === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(name);
}

// --- engine ------------------------------------------------------------------

/**
 * Run the guarded upgrade transaction. Pure over `transport` (every docker /
 * compose / fs / registry effect goes through it); the LEDGER is driven
 * directly (real module, injectable dir) because its transactionality IS the
 * contract under test.
 *
 * @param {object} a
 * @param {string} a.slug
 * @param {string} a.service           compose service name (matrix key)
 * @param {object} a.transport         see buildDockerUpgradeTransport for the shape
 * @param {object} [a.matrix]
 * @param {string} [a.ledgerDir]
 * @param {(line: string) => void} [a.log]
 * @returns {Promise<object>} result — { status: "noop"|"refused"|"ok"|"failed", … }
 */
export async function runUpgradeMajor({ slug, service, transport, matrix = DEFAULT_UPGRADE_MATRIX, ledgerDir, log = () => {} }) {
  // SINGLE-WRITER-PER-SLUG MUTEX for the WHOLE transaction (held from before
  // the handshake until commit/rollback). Without it, two invocations could
  // both pass the pending-journal check and quiesce/dump concurrently — the
  // loser would then restart the shared dependents while the winner is still
  // migrating, invalidating the winner's quiesced snapshot. The repo's
  // hardened advisory lock (pid-liveness, no live-holder steal) anchors on the
  // slug's ledger path; the INNER ledger lock uses a different lock file, so
  // begin/commit/rollback inside do not self-deadlock. A second invocation
  // times out waiting and is REFUSED without touching anything.
  const lockAnchor = `${ledgerPath(slug, ledgerDir ?? undefined)}.upgrade-major`;
  try {
    return await withRegistryLock(lockAnchor, () => runUpgradeMajorLocked({ slug, service, transport, matrix, ledgerDir, log }));
  } catch (err) {
    if (/lock/i.test(err?.message ?? "")) {
      return {
        status: "refused",
        steps: [],
        reason: `another db upgrade for instance "${slug}" appears to be in progress (${err.message}) — not starting a second one.`,
      };
    }
    throw err;
  }
}

async function runUpgradeMajorLocked({ slug, service, transport, matrix, ledgerDir, log }) {
  const steps = [];
  const step = (name, detail = null) => { steps.push({ step: name, ...(detail ? { detail } : {}) }); log(`  • ${name}${detail ? ` — ${detail}` : ""}`); };

  const state = {
    quiesced: [],
    sourceStopped: false,
    journalOpen: false,
    scratchStarted: false,
    cutover: null,
    newVolume: null,
    committed: false,
  };

  // ── 1. Preflight handshake ─────────────────────────────────────────────────
  const report = transport.preflight();
  const result = (report?.results ?? []).find((r) => r.service === service) ?? null;
  if (!result) {
    return { status: "refused", steps, reason: `preflight returned no verdict for "${service}" — is it deployed here?` };
  }
  if (result.verdict === VERDICTS.PASS) {
    return { status: "noop", steps, reason: result.reason, detected: result.detected ?? null };
  }
  if (result.verdict !== VERDICTS.STOP) {
    return {
      status: "refused",
      steps,
      reason: `preflight verdict is "${result.verdict}" (${result.reason}) — this command executes only a SUPPORTED pending hop.`,
      remediation: result.remediation ?? null,
    };
  }
  const from = String(result.detected);
  const to = String(result.target);
  const transition = supportedTransition(matrix, service, from, to);
  if (!transition || transition.migration !== PG_UPGRADE_MAJOR_COMMAND || transition.mechanism !== "logical-dump-restore") {
    return {
      status: "refused",
      steps,
      reason:
        `the ${service} ${from} → ${to} hop is not executable by this command ` +
        `(mechanism ${transition?.mechanism ?? "unknown"} / sanctioned command ${transition?.migration ?? "none"}). See ${UPGRADE_RUNBOOK_URL}.`,
    };
  }
  step("handshake", `${service}: supported ${from} → ${to}${transition.caseScoped ? " (case-scoped exception)" : ""} — matrix revision ${matrix.revision ?? AUTHORITATIVE_MATRIX_REVISION}`);

  // Refuse to even start while a migration journal is pending (for ANY service
  // — beginMigration would refuse later; failing here keeps the store untouched).
  const preLedger = requireUsableLedger(slug, ledgerDir);
  if (preLedger.pending) {
    return {
      status: "refused",
      steps,
      reason:
        `a migration journal is already pending for "${preLedger.pending.service}" — resolve it (restore from backup ` +
        `or complete the in-flight migration) before starting another. See ${UPGRADE_RUNBOOK_URL}.`,
    };
  }

  let failedStep = null;
  try {
    // ── 2. Disk prechecks ───────────────────────────────────────────────────
    failedStep = "disk-precheck";
    const dbBytes = transport.databaseSizeBytes();
    const backupFree = transport.freeBytesAtBackupDir();
    const backupNeed = Math.ceil(dbBytes * BACKUP_HEADROOM_FACTOR) + MIN_FREE_BYTES;
    if (!(backupFree > backupNeed)) {
      throw new Error(
        `not enough free space for the backup: ${backupFree} bytes free at ${transport.backupDir}, ` +
        `need > ${backupNeed} (database size ${dbBytes} × ${BACKUP_HEADROOM_FACTOR} + headroom).`,
      );
    }
    const dockerFree = transport.freeBytesInDockerRoot();
    const restoreNeed = Math.ceil(dbBytes * RESTORE_HEADROOM_FACTOR) + MIN_FREE_BYTES;
    if (!(dockerFree > restoreNeed)) {
      throw new Error(
        `not enough free space in the docker root for the restored volume: ${dockerFree} bytes free, ` +
        `need > ${restoreNeed} (database size ${dbBytes} × ${RESTORE_HEADROOM_FACTOR} + headroom).`,
      );
    }
    step("disk-precheck", `db ${dbBytes}B; backup free ${backupFree}B; docker free ${dockerFree}B`);

    // ── 3. Quiesce writers ──────────────────────────────────────────────────
    failedStep = "quiesce";
    const deps = transport.runningDependents();
    if (deps.length) {
      transport.stopServices(deps);
      state.quiesced = deps;
    }
    step("quiesce", deps.length ? `stopped ${deps.join(", ")}` : "no running dependents");

    // ── 4. Verified backup ──────────────────────────────────────────────────
    failedStep = "dump";
    const dbs = transport.listDatabases();
    if (!dbs.length) throw new Error("the source cluster lists no databases — refusing to migrate an unreadable cluster.");
    for (const d of dbs) {
      if (!isSafeDbIdentifier(d.name) || (d.owner != null && !isSafeDbIdentifier(d.owner))) {
        throw new Error(`database name/owner "${d.name}"/"${d.owner}" is outside the safe identifier set — migrate it manually per the runbook.`);
      }
    }
    const globals = transport.dumpGlobals();
    if (!(globals.bytes > 0)) throw new Error("globals dump is empty.");
    const dumps = {};
    for (const d of dbs) {
      const dump = transport.dumpDatabase(d.name);
      if (!(dump.bytes > 0)) throw new Error(`dump of database "${d.name}" is empty.`);
      dumps[d.name] = dump;
    }
    failedStep = "content-stats";
    const sourceStats = transport.contentStats("source");
    failedStep = "backup-manifest";
    const manifestPath = transport.writeBackupManifest({
      command: PG_UPGRADE_MAJOR_COMMAND,
      matrixRevision: matrix.revision ?? AUTHORITATIVE_MATRIX_REVISION,
      slug,
      service,
      from,
      to,
      caseScoped: Boolean(transition.caseScoped),
      sourceVolume: transport.oldVolumeName,
      createdAt: new Date().toISOString(),
      globals: { path: globals.path, sha256: globals.sha256, bytes: globals.bytes },
      databases: Object.fromEntries(
        dbs.map((d) => [d.name, { owner: d.owner ?? null, path: dumps[d.name].path, sha256: dumps[d.name].sha256, bytes: dumps[d.name].bytes }]),
      ),
      retention:
        "Keep this directory and the retired source volume until the upgraded deployment has proven itself in real use; " +
        `then remove them manually. See ${UPGRADE_RUNBOOK_URL}.`,
    });
    step("verified-backup", `globals + ${dbs.length} database dump(s), checksummed → ${manifestPath}`);

    // ── 5/6. Fresh target volume + ledger journal ───────────────────────────
    failedStep = "fresh-volume";
    state.newVolume = transport.createTargetVolume();
    step("fresh-volume", state.newVolume.name);

    failedStep = "ledger-begin";
    const targetRef = transport.targetImageRef();
    await withLedgerLock(slug, ledgerDir, () => {
      const ledger = requireUsableLedger(slug, ledgerDir);
      const next = beginMigration(ledger, {
        service,
        target: makeEntry({
          service,
          image: targetRef.image,
          digest: targetRef.digest ?? null,
          dataFormatVersion: to,
          volume: state.newVolume.identity,
        }),
      });
      writeLedger(next, ledgerDir);
    });
    state.journalOpen = true;
    step("ledger-begin", `journal opened (source entry preserved; candidate ${to} staged)`);

    // ── 7. Stop source; restore into the scratch target ─────────────────────
    failedStep = "stop-source";
    transport.stopServices([service]);
    state.sourceStopped = true;
    step("stop-source", service);

    failedStep = "restore";
    // Marked BEFORE the start call: a partially-created scratch container
    // (e.g. `docker run` succeeded but the readiness wait threw inside the
    // transport) must still be removed by the rollback.
    state.scratchStarted = true;
    transport.startScratchTarget(state.newVolume.name);
    const globalsOutcome = transport.restoreGlobals();
    for (const d of dbs) {
      transport.ensureDatabase(d);
      transport.restoreDatabase(d.name);
    }
    step("restore", `globals (${(globalsOutcome?.verifiedRoles ?? []).length} role(s) verified) + ${dbs.length} database(s) restored --exit-on-error`);

    // ── 8. Verify (content read-backs) ──────────────────────────────────────
    failedStep = "verify";
    const restoredStats = transport.contentStats("scratch");
    const mismatches = compareContentStats(sourceStats, restoredStats);
    if (mismatches.length) {
      throw new Error(`content read-back mismatch after restore:\n    - ${mismatches.slice(0, 20).join("\n    - ")}`);
    }
    // STRICT stop: the cutover mounts this same volume into the compose
    // service — a scratch server that survived `rm -f` would hold the data
    // directory open concurrently. The strict form VERIFIES the container is
    // gone and throws otherwise (→ rollback), unlike the best-effort form the
    // rollback path itself uses.
    transport.stopScratchTarget(true);
    state.scratchStarted = false;
    step("verify", `read-backs OK (${Object.keys(sourceStats).length} database(s), table sets + exact counts equal)`);

    // ── 9. Cutover ───────────────────────────────────────────────────────────
    failedStep = "cutover";
    state.cutover = await transport.writeCutoverOverride(state.newVolume.name);
    transport.upServices([service]);
    transport.waitServiceReady();
    const liveStats = transport.contentStats("live");
    const liveMismatches = compareContentStats(sourceStats, liveStats);
    if (liveMismatches.length) {
      throw new Error(`post-cutover read-back mismatch through the live service:\n    - ${liveMismatches.slice(0, 20).join("\n    - ")}`);
    }
    step("cutover", `${service} recreated on ${state.newVolume.name}; live read-backs OK`);

    // ── 10. Commit + resume ──────────────────────────────────────────────────
    failedStep = "ledger-commit";
    await withLedgerLock(slug, ledgerDir, () => {
      const ledger = requireUsableLedger(slug, ledgerDir);
      writeLedger(commitMigration(ledger, service), ledgerDir);
    });
    state.journalOpen = false;
    state.committed = true;
    step("ledger-commit", `deployed-version entry now ${to}, bound to ${state.newVolume.name}`);

    // POINT OF NO ROLLBACK: the cutover is live-verified and the ledger is
    // committed. A dependent-restart hiccup must NOT unwind the migration
    // (removing the override / restoring the source entry here would split the
    // committed ledger from the mounted volume) — it becomes a WARNING with
    // the manual command instead.
    const warnings = [];
    if (state.quiesced.length) {
      try {
        transport.upServices(state.quiesced);
        step("resume-dependents", state.quiesced.join(", "));
      } catch (resumeErr) {
        warnings.push(
          `resume-dependents failed (${resumeErr?.message ?? resumeErr}) — the upgrade itself is COMMITTED and live; ` +
            `restart them manually: docker compose up -d ${state.quiesced.join(" ")}`,
        );
        step("resume-dependents", "FAILED — see warnings (upgrade committed)");
      }
    } else {
      step("resume-dependents", "none");
    }

    return {
      status: "ok",
      steps,
      warnings,
      service,
      from,
      to,
      caseScoped: Boolean(transition.caseScoped),
      oldVolume: transport.oldVolumeName,
      newVolume: state.newVolume.name,
      backupDir: transport.backupDir,
      retention:
        `Retired volume "${transport.oldVolumeName}" and the checksummed backups under ${transport.backupDir} are PRESERVED. ` +
        `Remove them manually only after the upgraded deployment has proven itself in real use ` +
        `(docker volume rm ${transport.oldVolumeName}). See ${UPGRADE_RUNBOOK_URL}.`,
    };
  } catch (err) {
    // Defensive: nothing after the ledger commit may reach this rollback (the
    // resume step above converts its failures to warnings), but if it ever
    // did, unwinding a COMMITTED cutover would split the ledger from the
    // mounted volume — refuse and surface instead.
    if (state.committed) {
      return {
        status: "ok",
        steps,
        warnings: [`post-commit step failed (${err?.message ?? err}) — the upgrade is committed and live; resolve manually.`],
        service,
        from,
        to,
        oldVolume: transport.oldVolumeName,
        newVolume: state.newVolume?.name ?? null,
        backupDir: transport.backupDir,
        retention: `Retired volume "${transport.oldVolumeName}" and the backups under ${transport.backupDir} are PRESERVED. See ${UPGRADE_RUNBOOK_URL}.`,
      };
    }
    // ── rollback — land back on the intact old volume + source ledger entry ──
    const rollbackErrors = [];
    const attempt = async (label, fn) => {
      try { await fn(); } catch (e) { rollbackErrors.push(`${label}: ${e?.message ?? e}`); }
    };
    if (state.scratchStarted) await attempt("stop-scratch", () => transport.stopScratchTarget());
    if (state.cutover) await attempt("remove-cutover-override", () => transport.removeCutoverOverride(state.cutover));
    if (state.journalOpen) {
      await attempt("ledger-rollback", () =>
        withLedgerLock(slug, ledgerDir, () => {
          const ledger = requireUsableLedger(slug, ledgerDir);
          writeLedger(rollbackMigration(ledger, service), ledgerDir);
        }),
      );
      state.journalOpen = false;
    }
    if (state.sourceStopped || state.cutover) {
      await attempt("restart-source", () => { transport.upServices([service]); transport.waitServiceReady(); });
    }
    if (state.quiesced.length) await attempt("resume-dependents", () => transport.upServices(state.quiesced));

    return {
      status: "failed",
      steps,
      failedStep,
      error: err?.message ?? String(err),
      service,
      from,
      to,
      oldVolume: transport.oldVolumeName,
      newVolume: state.newVolume?.name ?? null,
      backupDir: transport.backupDir,
      rolledBack: rollbackErrors.length === 0,
      rollbackErrors,
      note:
        `The source volume "${transport.oldVolumeName}" was NOT modified; the service was brought back up on it. ` +
        `The partial target volume${state.newVolume ? ` "${state.newVolume.name}"` : ""} and any backup artifacts were kept for diagnosis.`,
    };
  }
}

// --- the REAL docker/compose transport ---------------------------------------

/** Default runner seam: spawnSync with rich outcome. `stdoutFile` redirects
 *  stdout straight to a file descriptor (dump pipeline-failure detection —
 *  the exit status is the dump's own, no shell pipe involved). */
export function defaultRun(cmd, args, { cwd, stdoutFile = null, timeout = 15 * 60_000, input = null } = {}) {
  let fd = null;
  try {
    if (stdoutFile) fd = openSync(stdoutFile, "w");
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: [input != null ? "pipe" : "ignore", fd ?? "pipe", "pipe"],
      input: input ?? undefined,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      status: r.status,
      stdout: typeof r.stdout === "string" ? r.stdout : "",
      stderr: typeof r.stderr === "string" ? r.stderr : "",
      error: r.error ?? null,
    };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function must(outcome, what) {
  if (outcome.error) throw new Error(`${what} failed to launch: ${outcome.error.message}`);
  if (outcome.status !== 0) {
    const tail = (outcome.stderr || outcome.stdout || "").trim().split("\n").slice(-6).join("\n      ");
    throw new Error(`${what} failed (exit ${outcome.status}).${tail ? `\n      ${tail}` : ""}`);
  }
  return outcome;
}

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Parse `df -Pk` output → available bytes, or null. */
export function parseDfAvailableBytes(raw) {
  if (typeof raw !== "string") return null;
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[1].trim().split(/\s+/);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb) || availKb < 0) return null;
  return availKb * 1024;
}

export function defaultBackupRoot() {
  const override = process.env.CINATRA_DB_BACKUP_DIR;
  if (typeof override === "string" && override.length > 0) return override;
  return path.join(os.homedir(), ".cinatra", "backups");
}

/**
 * Build the real transport. All effects go through the `run` seam (tests
 * substitute it); the compose file list is kept in a mutable local so the
 * cutover's override file joins every subsequent compose invocation.
 *
 * @param {object} a
 * @param {string} a.slug
 * @param {object} a.spec  the discovered service spec:
 *   { service, volumeName, volumeSource, mountTarget, image, digest, target,
 *     environment, dependents: [running reverse-dependent services] }
 * @param {{targetDir: string, composeFiles: string[], composeProject: string|null, envFile: string|null}} a.composeCtx
 * @param {() => object} a.preflight  runs the shared fail-closed preflight for this service
 * @param {() => string[]} [a.resolveDependents]  RE-QUERIES the running
 *   reverse-dependents at call time (the engine invokes it INSIDE the
 *   per-slug mutex — a list captured before the lock could be stale: another
 *   invocation may have stopped/restarted writers in between). Throws when the
 *   running set cannot be listed (fail closed — never quiesce blind).
 * @param {{updateComposeFiles: (files: string[]) => void}} a.registry  persists the
 *   instance row's composeFiles (index.mjs wires the locked registry write)
 * @param {(cmd, args, opts?) => object} [a.run]
 * @param {(line: string) => void} [a.log]
 * @param {string} [a.backupRoot]
 * @param {() => Date} [a.now]
 */
export function buildDockerUpgradeTransport({
  slug,
  spec,
  composeCtx,
  preflight,
  registry,
  resolveDependents = null,
  run = defaultRun,
  log = () => {},
  backupRoot = defaultBackupRoot(),
  now = () => new Date(),
}) {
  const { service, volumeName, volumeSource, mountTarget, image, environment = {}, dependents = [] } = spec;
  const pgUser = typeof environment.POSTGRES_USER === "string" && environment.POSTGRES_USER.length ? environment.POSTGRES_USER : "postgres";
  if (!isSafeDbIdentifier(pgUser)) throw new Error(`POSTGRES_USER "${pgUser}" is outside the safe identifier set.`);

  const files = [...(composeCtx.composeFiles ?? [])];
  const composeArgs = () => composeBaseArgs({ composeFiles: files, composeProject: composeCtx.composeProject, envFile: composeCtx.envFile });
  const stamp = now().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const backupDir = path.join(backupRoot, slug, `${service}-${stamp}`);
  const scratchName = `cinatra-upgrade-${service}-${stamp}`.toLowerCase();

  const compose = (args, opts = {}) => run("docker", [...composeArgs(), ...args], { cwd: composeCtx.targetDir, ...opts });
  const docker = (args, opts = {}) => run("docker", args, opts);

  // psql through the RUNNING compose service (source / live phases).
  const composePsql = (db, sql) =>
    must(
      compose(["exec", "-T", service, "psql", "-U", pgUser, "-d", db, "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql]),
      `psql (${service}/${db})`,
    ).stdout.trim();
  // psql inside the scratch restore container.
  const scratchPsql = (db, sql) =>
    must(
      docker(["exec", scratchName, "psql", "-U", pgUser, "-d", db, "-tA", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql]),
      `psql (scratch/${db})`,
    ).stdout.trim();

  const listDatabasesVia = (psql) =>
    psql("postgres", "SELECT datname, pg_get_userbyid(datdba) FROM pg_database WHERE NOT datistemplate ORDER BY datname")
      .split("\n")
      .filter((l) => l.trim().length)
      .map((l) => {
        const [name, owner] = l.split("|");
        return { name, owner: owner || null };
      });

  const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const statsVia = (psql) => {
    const stats = {};
    for (const d of listDatabasesVia(psql)) {
      const rows = psql(
        d.name,
        "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
          "WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2",
      );
      const tables = rows.split("\n").filter((l) => l.includes("|")).map((l) => l.split("|"));
      const counts = {};
      const CHUNK = 40;
      for (let i = 0; i < tables.length; i += CHUNK) {
        const chunk = tables.slice(i, i + CHUNK);
        const sql = chunk
          .map(([nsp, rel]) => {
            const label = `${nsp}.${rel}`.replace(/'/g, "''");
            return `SELECT '${label}', count(*) FROM ${quoteIdent(nsp)}.${quoteIdent(rel)}`;
          })
          .join(" UNION ALL ");
        for (const line of psql(d.name, sql).split("\n")) {
          if (!line.includes("|")) continue;
          const idx = line.lastIndexOf("|");
          counts[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      stats[d.name] = counts;
    }
    return stats;
  };

  const waitPgReady = (execTargetArgs, what, tries = 60, opts = {}) => {
    for (let i = 0; i < tries; i++) {
      const r = run("docker", [...execTargetArgs, "pg_isready", "-U", pgUser, "-q"], opts);
      if (r.status === 0) return;
      spawnSync("sleep", ["2"]);
    }
    throw new Error(`${what} did not become ready in time.`);
  };

  return {
    backupDir,
    oldVolumeName: volumeName,
    preflight,

    targetImageRef() {
      return { image, digest: spec.digest ?? null };
    },

    databaseSizeBytes() {
      const out = composePsql("postgres", "SELECT coalesce(sum(pg_database_size(datname)),0) FROM pg_database WHERE NOT datistemplate");
      const n = Number(out);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`could not measure the source database size (got "${out}").`);
      return n;
    },

    freeBytesAtBackupDir() {
      mkdirSync(backupDir, { recursive: true });
      const n = parseDfAvailableBytes(must(run("df", ["-Pk", backupDir]), "df (backup dir)").stdout);
      if (n == null) throw new Error("could not determine free space at the backup directory.");
      return n;
    },

    freeBytesInDockerRoot() {
      // Measured INSIDE a scratch container over the service's own already-
      // pulled image: its writable layer + volumes live on the docker root fs.
      const out = docker(["run", "--rm", "--pull=never", "--entrypoint", "/bin/sh", image, "-c", "df -Pk /"]);
      const n = parseDfAvailableBytes(must(out, "df (docker root)").stdout);
      if (n == null) throw new Error("could not determine free space in the docker root.");
      return n;
    },

    runningDependents() {
      // Fresh at call time (inside the engine's mutex) — see resolveDependents.
      return resolveDependents ? resolveDependents() : [...dependents];
    },

    stopServices(names) {
      must(compose(["stop", ...names]), `docker compose stop ${names.join(" ")}`);
      log(`    stopped: ${names.join(", ")}`);
    },

    upServices(names) {
      must(compose(["up", "-d", "--no-deps", ...names], { timeout: 10 * 60_000 }), `docker compose up -d ${names.join(" ")}`);
      log(`    up: ${names.join(", ")}`);
    },

    listDatabases() {
      return listDatabasesVia(composePsql);
    },

    dumpGlobals() {
      mkdirSync(backupDir, { recursive: true });
      const out = path.join(backupDir, "globals.sql");
      must(
        compose(["exec", "-T", service, "pg_dumpall", "-U", pgUser, "--globals-only"], { stdoutFile: out }),
        "pg_dumpall --globals-only",
      );
      return { path: out, sha256: sha256File(out), bytes: statSync(out).size };
    },

    dumpDatabase(db) {
      const out = path.join(backupDir, `${db}.pgc`);
      must(
        compose(["exec", "-T", service, "pg_dump", "-U", pgUser, "-Fc", "-d", db], { stdoutFile: out, timeout: 60 * 60_000 }),
        `pg_dump -Fc ${db}`,
      );
      return { path: out, sha256: sha256File(out), bytes: statSync(out).size };
    },

    contentStats(where) {
      if (where === "scratch") return statsVia(scratchPsql);
      return statsVia(composePsql); // "source" and "live" both read through the compose service
    },

    writeBackupManifest(manifest) {
      const p = path.join(backupDir, "manifest.json");
      writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
      return p;
    },

    createTargetVolume() {
      const name = `${volumeName}-pg${spec.target}-${stamp}`.toLowerCase();
      must(docker(["volume", "create", name]), `docker volume create ${name}`);
      const inspect = must(docker(["volume", "inspect", name]), `docker volume inspect ${name}`);
      let row;
      try {
        const parsed = JSON.parse(inspect.stdout.trim());
        row = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        row = null;
      }
      if (!row || typeof row.Name !== "string" || typeof row.CreatedAt !== "string") {
        throw new Error(`could not read the identity of the fresh volume ${name}.`);
      }
      return { name, identity: { name: row.Name, createdAt: row.CreatedAt } };
    },

    startScratchTarget(volName) {
      if (!mountTarget) throw new Error("the deployment's data mount target is unknown — refusing to guess the pg layout.");
      const envArgs = [];
      for (const [k, v] of Object.entries(environment)) {
        if (/^POSTGRES_/.test(k) || k === "PGDATA") envArgs.push("-e", `${k}=${v}`);
      }
      must(
        docker(["run", "-d", "--name", scratchName, "-v", `${volName}:${mountTarget}`, ...envArgs, image]),
        `scratch target container (${image})`,
      );
      waitPgReady(["exec", scratchName], "the scratch target cluster");
    },

    restoreGlobals() {
      const src = path.join(backupDir, "globals.sql");
      // The defined fresh-cluster-collision strategy: strip ONLY the bootstrap
      // role's CREATE/ALTER statements (initdb already created it from the
      // same compose env), then apply the remainder STRICTLY — any other
      // failure (extra roles, memberships, tablespaces) aborts → rollback.
      const filtered = path.join(backupDir, "globals.filtered.sql");
      writeFileSync(filtered, filterGlobalsForBootstrap(readFileSync(src, "utf8"), pgUser), { mode: 0o600 });
      must(docker(["cp", filtered, `${scratchName}:/tmp/globals.sql`]), "docker cp globals.sql");
      must(
        docker(["exec", scratchName, "psql", "-U", pgUser, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "/tmp/globals.sql"]),
        "globals restore (strict)",
      );
      // Outcome read-back: every role the ORIGINAL dump names (bootstrap
      // included) must exist on the target.
      const wanted = rolesFromGlobalsDump(readFileSync(src, "utf8"));
      const have = new Set(
        must(docker(["exec", scratchName, "psql", "-U", pgUser, "-d", "postgres", "-tA", "-c", "SELECT rolname FROM pg_roles"]), "role read-back")
          .stdout.trim()
          .split("\n"),
      );
      const missing = wanted.filter((r) => !have.has(r));
      if (missing.length) throw new Error(`globals restore did not produce role(s): ${missing.join(", ")}`);
      return { verifiedRoles: wanted };
    },

    ensureDatabase({ name, owner }) {
      const exists = must(
        docker(["exec", scratchName, "psql", "-U", pgUser, "-d", "postgres", "-tA", "-c", `SELECT 1 FROM pg_database WHERE datname = '${name}'`]),
        `database existence check (${name})`,
      ).stdout.trim();
      if (exists === "1") return;
      const args = ["exec", scratchName, "createdb", "-U", pgUser];
      if (owner) args.push("-O", owner);
      args.push(name);
      must(docker(args), `createdb ${name}`);
    },

    restoreDatabase(db) {
      const src = path.join(backupDir, `${db}.pgc`);
      must(docker(["cp", src, `${scratchName}:/tmp/${db}.pgc`]), `docker cp ${db}.pgc`);
      must(
        docker(["exec", scratchName, "pg_restore", "-U", pgUser, "-d", db, "--exit-on-error", `/tmp/${db}.pgc`], { timeout: 60 * 60_000 }),
        `pg_restore ${db}`,
      );
    },

    stopScratchTarget(strict = false) {
      const r = docker(["rm", "-f", scratchName]);
      if (!strict) return; // rollback path: best-effort by design (idempotent)
      // Pre-cutover: the compose service is about to mount the SAME volume —
      // a surviving scratch server would open the data dir concurrently.
      // VERIFY it is gone; anything else aborts (→ rollback).
      if (r.status !== 0 && !/no such container/i.test(`${r.stderr}${r.stdout}`)) {
        throw new Error(`could not remove the scratch container ${scratchName}: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
      }
      const gone = docker(["container", "inspect", scratchName]);
      if (gone.status === 0) {
        throw new Error(`scratch container ${scratchName} is still present after removal — refusing to cut over while it could hold the restored volume open.`);
      }
    },

    async writeCutoverOverride(newVolumeName) {
      const overridePath = path.join(composeCtx.targetDir, DB_VOLUME_OVERRIDE_FILE);
      let doc = {
        "x-cinatra-note":
          `Managed by ${PG_UPGRADE_MAJOR_COMMAND} — rebinds retired data-volume keys to their restored successors. ` +
          "JSON body (valid YAML) so the CLI can merge it deterministically. Do not edit by hand.",
        volumes: {},
      };
      let hadFile = false;
      let previousRaw = null;
      if (existsSync(overridePath)) {
        hadFile = true;
        previousRaw = readFileSync(overridePath, "utf8");
        doc = JSON.parse(previousRaw); // malformed override = hard error (fail closed)
        if (!doc.volumes || typeof doc.volumes !== "object") doc.volumes = {};
      }
      const previousBinding = doc.volumes[volumeSource] ?? null;
      doc.volumes[volumeSource] = { external: true, name: newVolumeName };
      writeFileSync(overridePath, JSON.stringify(doc, null, 2) + "\n");

      // ATOMIC from the engine's point of view: if the registry update throws
      // AFTER the file/file-list mutation, SELF-UNDO before rethrowing — the
      // engine has not recorded a cutover yet (state.cutover unset), so its
      // rollback would otherwise restart the service through the mutated file
      // list on the NEW volume while restoring the SOURCE ledger entry.
      let filesUpdated = false;
      try {
        if (!files.includes(DB_VOLUME_OVERRIDE_FILE)) {
          files.push(DB_VOLUME_OVERRIDE_FILE);
          await registry.updateComposeFiles([...files]);
          filesUpdated = true;
        }
      } catch (err) {
        const idx = files.indexOf(DB_VOLUME_OVERRIDE_FILE);
        if (idx !== -1) files.splice(idx, 1);
        try {
          if (hadFile && previousRaw != null) writeFileSync(overridePath, previousRaw);
          else if (existsSync(overridePath)) unlinkSync(overridePath);
        } catch {
          /* the throw below carries the primary failure */
        }
        throw err;
      }
      log(`    cutover override: ${volumeSource} → ${newVolumeName} (${DB_VOLUME_OVERRIDE_FILE})`);
      return { overridePath, hadFile, previousRaw, previousBinding, filesUpdated };
    },

    async removeCutoverOverride(cutover) {
      if (!cutover) return;
      if (cutover.hadFile && cutover.previousRaw != null) {
        writeFileSync(cutover.overridePath, cutover.previousRaw);
      } else if (existsSync(cutover.overridePath)) {
        unlinkSync(cutover.overridePath);
      }
      if (cutover.filesUpdated) {
        const idx = files.indexOf(DB_VOLUME_OVERRIDE_FILE);
        if (idx !== -1) files.splice(idx, 1);
        await registry.updateComposeFiles([...files]);
      }
    },

    waitServiceReady() {
      waitPgReady([...composeArgs(), "exec", "-T", service], `the ${service} service`, 90, { cwd: composeCtx.targetDir });
    },
  };
}

// --- rendering ----------------------------------------------------------------

/** Human rendering of a runUpgradeMajor result. Pure. */
export function formatUpgradeResult(result) {
  const lines = [];
  if (result.status === "noop") {
    lines.push(`Nothing to do — ${result.reason}`);
  } else if (result.status === "refused") {
    lines.push(`REFUSED — ${result.reason}`);
    if (result.remediation) lines.push(`  → ${result.remediation}`);
  } else if (result.status === "ok") {
    lines.push(`Upgrade complete: ${result.service} ${result.from} → ${result.to}${result.caseScoped ? " (case-scoped)" : ""}.`);
    lines.push(`  new volume:     ${result.newVolume}`);
    lines.push(`  retired volume: ${result.oldVolume} (preserved)`);
    lines.push(`  backups:        ${result.backupDir}`);
    for (const w of result.warnings ?? []) lines.push(`  WARNING: ${w}`);
    lines.push(`  ${result.retention}`);
    lines.push("  Restart/boot the app now — it self-bootstraps and runs its own ledgered migrations.");
  } else {
    lines.push(`Upgrade FAILED at step "${result.failedStep}": ${result.error}`);
    lines.push(`  ${result.rolledBack ? "Rolled back cleanly" : `Rollback had errors: ${result.rollbackErrors.join("; ")}`}.`);
    lines.push(`  ${result.note}`);
  }
  return lines.join("\n");
}

export const __test = {
  USAGE,
  parseUpgradeMajorArgs,
  compareContentStats,
  rolesFromGlobalsDump,
  filterGlobalsForBootstrap,
  isSafeDbIdentifier,
  parseDfAvailableBytes,
  runUpgradeMajor,
  buildDockerUpgradeTransport,
  formatUpgradeResult,
};
