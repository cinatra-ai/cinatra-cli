// ---------------------------------------------------------------------------
// `cinatra instance db upgrade-major` — the sanctioned guarded Postgres
// major-version upgrade (cinatra-cli#129, upgrade-paths epic
// cinatra-ai/cinatra#1419). This is the command the fail-closed preflight's STOP
// message points to for a SUPPORTED pending hop (cinatra-cli#128).
//
// MECHANISM: logical dump -> fresh target-major volume -> restore, one command
// for all four Postgres instances (platform / nango / twenty / plane), driven by
// the supported matrix — chosen over in-place `pg_upgrade` (the alpine images
// lack the old-major binaries, and skipped majors are the observed reality;
// `pg_dump` crosses any source major in one hop). The nango pg15->17 case is a
// case-scoped matrix exception (cinatra-ai/cinatra#1417 Case B) executed on this
// SAME guarded path — never a fresh-init/re-auth reset.
//
// GUARDED TRANSACTION (each step gates the next; a failed step aborts and rolls
// back, never leaving a half-cut store). The ORIGINAL volume is opened READ-ONLY
// (the clone) and untouched until the commit boundary, so the intact source IS
// the rollback until cutover:
//   1. eligibility — the matrix authorizes exactly this (service, from->to) hop
//      (a downgrade / unsupported hop / unknown pair fails CLOSED, exit 3,
//      BEFORE any mutation).
//   2. quiesce — no container may still reference the data volume (the caller
//      stops the writers first; `pg_dump` is not cluster-atomic).
//   3. verified backup OFF A CLONE — clone the source volume (read-only) to a
//      CANDIDATE, run the SOURCE-major server on the clone, `pg_dump`/`pg_dumpall`
//      with pipeline-failure detection + sha256 checksum; disk-space prechecked
//      BEFORE the clone AND the restore.
//   4. fresh target-major volume + restore — create a FRESH volume with the
//      TARGET major's mount layout, restore the checksum-verified dump.
//   5. verify — content read-backs + a server-version assertion on the restored
//      target (stronger than row counts).
//   6. COMMIT BOUNDARY -> cut over onto the original volume (its {name,
//      createdAt} identity preserved so the ledger binding survives); old volume
//      PRESERVED until post-verify passes; post-cutover verify.
//   7. ledger COMMIT (the deployed-version ledger is part of the transaction:
//      the target entry commits ONLY after post-verify; any abort restores the
//      source entry). Retention: the retired candidate/target volumes are removed
//      best-effort AFTER commit; the checksummed dump stays under the operator's
//      retention window in --backup-dir.
//
// EXIT-CODE CONTRACT (stable; mirrors the harness family paths' contract in the
// product `scripts/upgrade/lib.sh`, and the ledger's transactional states):
//   0  upgraded, verified, ledger committed (or an informational no-op: already
//      at target)
//   2  usage / misconfiguration
//   3  fail-closed refusal BEFORE any mutation (matrix verdict, downgrade,
//      un-quiesced volume, disk precheck, a begin the ledger refuses)
//   4  fail-closed INTERRUPTED: a post-commit failure (cutover / post-cutover
//      verify), OR a pre-commit abort whose ledger rollback itself FAILED — the
//      pending ledger journal is RETAINED (the preflight's "interrupted
//      migration" finding) + the candidate/target volumes + dump kept as
//      recovery material
//   5  aborted pre-commit: rolled back + VERIFIED — the source volume is intact
//      and the ledger carries the source entry again
//
// SHAPE. The eligibility PLAN + the guarded-frame STATE MACHINE
// (`runGuardedUpgrade`) are PURE over an INJECTED transport + ledger seam + a
// failure-injection seam, so every step, every failure path, and every ledger
// state is exercised in unit tests with a mocked transport and NEVER boots a
// container. `runGuardedUpgrade` is the executable CONTRACT of the frame (and
// drives the `--dry-run` step preview); the destructive dump/restore/cutover
// MECHANICS are delegated by the command to the product's guarded shell frame —
// `scripts/upgrade/postgres-upgrade-major.sh` (the exact mechanism the
// works-after upgrade-from arm proves with real docker, cinatra-ai/cinatra#1422)
// — with the deployed-version ledger wired in as its `UPGRADE_LEDGER_HOOK`
// (src/upgrade-ledger-hook.mjs). This is the seam documented in that frame's
// scripts/upgrade/lib.sh. index.mjs supplies the real resolve + execute seams.
// ---------------------------------------------------------------------------

import {
  DEFAULT_UPGRADE_MATRIX,
  compareVersions,
  serviceEntry,
  serviceRunbookUrl,
  supportedTransition,
} from "./upgrade-matrix.mjs";

export const UPGRADE_EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  REFUSED: 3,
  INTERRUPTED: 4,
  ROLLED_BACK: 5,
});

// The transaction phase, which decides how a failure is handled: a pre-commit
// failure rolls back to the intact source; a post-commit failure is a
// fail-closed interruption (never a false "clean abort").
export const PHASE = Object.freeze({ PRE_COMMIT: "pre-commit", POST_COMMIT: "post-commit" });

// --- pg mount layout (the pg18 parent-mount move) ---------------------------

export const PG_LEGACY_MOUNT = "/var/lib/postgresql/data"; // pg<=17
export const PG_PARENT_MOUNT = "/var/lib/postgresql"; // pg>=18 (docker-library/postgres#1259)

/** The volume MOUNT TARGET dictated by a Postgres MAJOR: <=17 keeps the legacy
 *  `.../data` child mount; >=18 requires the PARENT mount (PGDATA moved to
 *  `<major>/docker`). A non-numeric major defaults to the parent (the fail-safe
 *  for the newest layout). */
export function pgMountTargetForMajor(major) {
  const n = Number(String(major ?? "").split(/[.-]/)[0]);
  return Number.isFinite(n) && n <= 17 ? PG_LEGACY_MOUNT : PG_PARENT_MOUNT;
}

// --- eligibility plan (pure) ------------------------------------------------

/**
 * Resolve whether a (service, detected -> target) hop may be executed on the
 * guarded path. PURE — the unit of eligibility test. Reuses the SAME matrix
 * lookups the preflight decides on, so the command can only ever execute a hop
 * the preflight would STOP on.
 *
 * Returns one of:
 *   { ok: false, code, reason, remediation }  — refuse (code 0 = clean no-op
 *       "already at target"; code 3 = fail-closed)
 *   { ok: true, service, from, to, caseScoped, migration, sourceMount, targetMount }
 */
export function planTransition({ service, detected, target, matrix = DEFAULT_UPGRADE_MATRIX }) {
  if (!serviceEntry(matrix, service)) {
    return refuse(UPGRADE_EXIT.REFUSED, `unknown service "${service}" — not in the supported matrix`, unknownRemediation(service, matrix));
  }
  if (detected == null || detected === "") {
    return refuse(
      UPGRADE_EXIT.REFUSED,
      `the deployed version of ${service} is unknown/unreadable — refusing to upgrade a store whose source major cannot be established`,
      unknownRemediation(service, matrix),
    );
  }
  if (target == null || target === "") {
    return refuse(UPGRADE_EXIT.REFUSED, `no target version resolved for ${service} — nothing to upgrade to`, unknownRemediation(service, matrix));
  }
  if (String(detected) === String(target)) {
    return refuse(UPGRADE_EXIT.OK, `${service} is already at ${target} — nothing to upgrade`, null);
  }
  const cmp = compareVersions(matrix, service, detected, target);
  if (cmp === null) {
    return refuse(
      UPGRADE_EXIT.REFUSED,
      `unknown/unordered version for ${service} (detected ${detected} -> target ${target})`,
      unknownRemediation(service, matrix),
    );
  }
  if (cmp > 0) {
    return refuse(
      UPGRADE_EXIT.REFUSED,
      `downgrade blocked for ${service} (detected ${detected} -> target ${target})`,
      `Downgrading ${service} from ${detected} to ${target} is unsafe and unsupported. Pin the previous image or restore a matching backup. See ${serviceRunbookUrl(matrix, service)}.`,
    );
  }
  const transition = supportedTransition(matrix, service, detected, target);
  if (!transition) {
    return refuse(
      UPGRADE_EXIT.REFUSED,
      `unsupported upgrade hop for ${service} (detected ${detected} -> target ${target})`,
      `No supported ${service} upgrade path from ${detected} to ${target}. Back up your data and consult ${serviceRunbookUrl(matrix, service)}.`,
    );
  }
  return {
    ok: true,
    service,
    from: String(detected),
    to: String(target),
    caseScoped: Boolean(transition.caseScoped),
    migration: transition.migration,
    // The runbook URL deep-linked to this service's reserved per-family anchor
    // (cinatra-ai/cinatra#1421), resolved from the SAME matrix the plan was built
    // from so the guarded executor's messages stay consistent with a
    // caller-injected matrix (never re-derived against a different default).
    runbookUrl: serviceRunbookUrl(matrix, service),
    // Layout is dictated by each SIDE's major: the source clone mounts at the
    // source-major target; the fresh restore volume mounts at the target-major
    // target (the 17->18 hop is the layout MOVE; the nango 15->17 case stays
    // legacy on both sides).
    sourceMount: pgMountTargetForMajor(detected),
    targetMount: pgMountTargetForMajor(target),
  };
}

function refuse(code, reason, remediation) {
  return { ok: false, code, reason, remediation: remediation ?? null };
}

function unknownRemediation(service, matrix = DEFAULT_UPGRADE_MATRIX) {
  return (
    `Refusing to upgrade ${service} while its source data-format version is unknown — a mismatched major would ` +
    `crash-loop. Back up the volume and determine its version (run \`cinatra instance db upgrade-preflight\`). See ${serviceRunbookUrl(matrix, service)}.`
  );
}

// --- guarded transaction state machine (pure over injected seams) -----------

/**
 * @typedef {Object} UpgradeTransport  Every method returns { ok, detail? } and
 *   is the seam a test mocks / index.mjs backs with docker.
 * @property {(args: object) => {ok:boolean, users?:string[], detail?:string}} quiesced
 *   true iff NO container references the data volume.
 * @property {(args: object) => {ok:boolean, detail?:string}} diskPrecheck
 *   room for the candidate clone + the dump (fail-closed BEFORE any mutation).
 * @property {(args: object) => {ok:boolean, candidateCreated?:boolean, detail?:string}} verifiedBackup
 *   clone source->candidate (read-only), run the SOURCE server on the clone,
 *   dump + checksum. The ORIGINAL is only opened read-only here. `candidateCreated`
 *   is true iff THIS run created the candidate volume (false when it refused a
 *   pre-existing one), so rollback removes only what it created.
 * @property {(args: object) => {ok:boolean, targetCreated?:boolean, detail?:string}} restoreFresh
 *   create the FRESH target-major volume + restore the verified dump.
 *   `targetCreated` is true iff THIS run created the target volume.
 * @property {(args: object) => {ok:boolean, detail?:string}} verifyTarget
 *   server-version + content read-back on the restored target volume.
 * @property {(args: object) => {ok:boolean, detail?:string}} cutover
 *   wipe the original + copy the restored target bytes in (identity preserved).
 * @property {(args: object) => {ok:boolean, detail?:string}} verifyCutover
 *   the same verify battery on the cut-over original volume.
 * @property {(name: string) => void} removeVolume  best-effort cleanup.
 */

/**
 * Run the guarded upgrade transaction. PURE over the injected `transport`,
 * `ledger` ({ begin, commit, rollback } — each returns { ok }), and `inject`
 * (returns true to fail a named step) seams. Returns { code, phase, message,
 * artifacts }.
 */
export function runGuardedUpgrade({
  plan,
  sourceVolume,
  candidateVolume,
  targetVolume,
  sourceImage,
  targetImage,
  dumpFile,
  backupDir,
  transport,
  ledger,
  inject = () => false,
  log = () => {},
}) {
  const service = plan.service;
  // Prefer the plan's matrix-resolved per-family runbook URL; fall back to the
  // default-matrix anchor for the service so a caller-built plan that omits
  // `runbookUrl` never renders "See undefined." (upgrade-major is Postgres-only,
  // so the fallback resolves to the same `#postgres` anchor).
  const runbookUrl = plan.runbookUrl ?? serviceRunbookUrl(DEFAULT_UPGRADE_MATRIX, service);
  let phase = PHASE.PRE_COMMIT;
  let ledgerBegun = false;
  let candidateCreated = false;
  let targetCreated = false;

  const done = (code, message, extra = {}) => ({ code, phase, service, message, ...extra });

  // Roll back a PRE-COMMIT abort. The ledger rollback is attempted+VERIFIED
  // FIRST: a FAILED rollback is a retained journal — the fail-closed interrupted
  // state (exit 4) — and in that case the candidate/target volumes are KEPT as
  // recovery material (never destroyed before the journal is resolved). Only a
  // VERIFIED rollback removes the volumes THIS run created and reports exit 5.
  const rollback = (reason) => {
    log(`pre-commit abort (${reason}) — rolling back; the source volume '${sourceVolume}' was only opened read-only and is intact`);
    const r = ledger.rollback();
    if (!r || !r.ok) {
      return done(
        UPGRADE_EXIT.INTERRUPTED,
        `LEDGER ROLLBACK FAILED after ${reason} — the pending journal is RETAINED (fail-closed interrupted state). ` +
          `The source volume '${sourceVolume}' is intact; the candidate/target volumes are KEPT as recovery material. ` +
          `Resolve the ledger before any retry. See ${runbookUrl}.`,
      );
    }
    if (candidateCreated) transport.removeVolume(candidateVolume);
    if (targetCreated) transport.removeVolume(targetVolume);
    return done(
      UPGRADE_EXIT.ROLLED_BACK,
      `aborted pre-commit (${reason}): rolled back — '${sourceVolume}' is intact and the ledger carries the ${plan.from} source entry again.`,
    );
  };

  // A POST-COMMIT failure NEVER rolls the ledger back: it leaves the pending
  // journal (the fail-closed "interrupted migration") + the candidate/target
  // volumes + the checksummed dump as recovery material.
  const interrupted = (reason) =>
    done(
      UPGRADE_EXIT.INTERRUPTED,
      `POST-COMMIT INTERRUPTION (${reason}): the pending ledger journal is RETAINED (fail-closed 'interrupted migration'); ` +
        `the target volume '${targetVolume}' and the checksummed dump '${dumpFile}' are kept as recovery material. See ${runbookUrl}.`,
      { dumpFile, targetVolume },
    );

  // ── 1. quiesce (fail-closed, BEFORE any ledger touch) ──────────────────────
  const q = transport.quiesced({ volumeName: sourceVolume });
  if (!q || !q.ok) {
    return done(
      UPGRADE_EXIT.REFUSED,
      `'${sourceVolume}' is not quiesced${q?.users?.length ? ` — still referenced by: ${q.users.join(", ")}` : ""}. ` +
        `Stop the ${service} container first (quiesce is step 2 of the guarded frame).`,
    );
  }

  // ── 2. disk precheck (fail-closed, BEFORE any mutation) ────────────────────
  const disk = transport.diskPrecheck({ volumeName: sourceVolume, backupDir });
  if (!disk || !disk.ok) {
    return done(UPGRADE_EXIT.REFUSED, `disk precheck failed for '${sourceVolume}'${disk?.detail ? ` — ${disk.detail}` : ""}. No mutation was performed.`);
  }

  // ── 3. ledger BEGIN (pending journal; live entry stays the SOURCE) ─────────
  const begun = ledger.begin();
  if (!begun || !begun.ok) {
    // A refused begin (pending journal already present, volume-identity
    // mismatch, malformed ledger) is a fail-closed refusal — nothing was
    // mutated and nothing is rolled back (the pre-existing journal stays as-is).
    return done(UPGRADE_EXIT.REFUSED, `ledger begin refused for ${service}${begun?.detail ? ` — ${begun.detail}` : ""}. No mutation was performed. See ${runbookUrl}.`);
  }
  ledgerBegun = true;

  // ── 4. verified backup OFF THE CANDIDATE CLONE ─────────────────────────────
  // The transport reports whether IT created the candidate (it REFUSES a
  // pre-existing same-named volume — retained recovery material — rather than
  // overlaying it), so a later rollback removes ONLY a volume this run created,
  // never a pre-existing artifact.
  const backup = transport.verifiedBackup({
    sourceImage,
    sourceVolume,
    candidateVolume,
    sourceMount: plan.sourceMount,
    dumpFile,
    expectMajor: plan.from,
  });
  if (backup && backup.candidateCreated) candidateCreated = true;
  if (!backup || !backup.ok || inject("backup-verify")) {
    return rollback("verified backup failed");
  }

  // ── 5. fresh target-major volume + restore ─────────────────────────────────
  const restore = transport.restoreFresh({
    targetImage,
    targetVolume,
    targetMount: plan.targetMount,
    dumpFile,
    expectMajor: plan.to,
  });
  if (restore && restore.targetCreated) targetCreated = true;
  if (!restore || !restore.ok || inject("restore")) {
    return rollback("restore into the fresh target volume failed");
  }

  // ── 6. post-verify the restored target ─────────────────────────────────────
  const vt = transport.verifyTarget({
    targetImage,
    targetVolume,
    targetMount: plan.targetMount,
    expectMajor: plan.to,
  });
  if (!vt || !vt.ok || inject("post-verify")) {
    return rollback("post-verify of the restored target failed");
  }

  // ── 7. COMMIT BOUNDARY — cut over onto the original volume ─────────────────
  phase = PHASE.POST_COMMIT;
  log(`COMMIT BOUNDARY: target verified — cutting over onto '${sourceVolume}' (volume identity preserved)`);
  const cut = transport.cutover({ sourceVolume, targetVolume, targetMount: plan.targetMount, targetImage });
  if (!cut || !cut.ok || inject("cutover")) {
    return interrupted("cutover failed");
  }
  const vc = transport.verifyCutover({ sourceVolume, targetMount: plan.targetMount, targetImage, expectMajor: plan.to });
  if (!vc || !vc.ok || inject("cutover-verify")) {
    return interrupted("post-cutover verify failed");
  }

  // ── 8. ledger COMMIT + best-effort cleanup (retention rule) ────────────────
  const committed = ledger.commit();
  if (!committed || !committed.ok) {
    // The bytes are already cut over; a commit that cannot be recorded is an
    // interrupted state (the journal is retained), never a silent success.
    return interrupted("ledger commit failed after a verified cutover");
  }
  // AFTER the commit: removing the retired volumes must not masquerade as an
  // interruption (the journal is already cleared). The dump stays in backupDir.
  transport.removeVolume(candidateVolume);
  transport.removeVolume(targetVolume);
  return done(
    UPGRADE_EXIT.OK,
    `DONE: ${service} upgraded ${plan.from} -> ${plan.to}; ledger committed. ` +
      `Backup retained at ${dumpFile} (+.sha256) under your retention window; the retired candidate/target volumes were removed.`,
    { dumpFile },
  );
}

// --- argument parsing -------------------------------------------------------

const USAGE =
  "Usage: cinatra instance db upgrade-major --service <name> [--instance <slug>] " +
  "[--target <version>] [--backup-dir <dir>] [--yes] [--json]\n" +
  "  Guarded logical dump -> fresh target-major volume -> restore for a Postgres\n" +
  "  instance. Fails CLOSED on an unsupported/unknown/downgrade hop; the old\n" +
  "  volume is preserved until post-verify passes.";

/** Parse the args AFTER `cinatra instance db upgrade-major`. Strict: an unknown
 *  flag is rejected. `--service` is required (which stateful service to upgrade).
 *  `--target <version>` overrides the target the discovery derived. */
export function parseUpgradeMajorArgs(argv) {
  const out = { service: null, slug: null, target: null, backupDir: null, yes: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`Missing value for ${name}.`);
      return v;
    };
    if (a === "--json") { out.json = true; continue; }
    if (a === "--yes" || a === "-y") { out.yes = true; continue; }
    if (a === "--service" || a.startsWith("--service=")) { out.service = take("--service"); continue; }
    if (a === "--instance" || a.startsWith("--instance=")) { out.slug = take("--instance"); continue; }
    if (a === "--target" || a.startsWith("--target=")) { out.target = take("--target"); continue; }
    if (a === "--backup-dir" || a.startsWith("--backup-dir=")) { out.backupDir = take("--backup-dir"); continue; }
    throw new Error(`Unexpected argument "${a}" for cinatra instance db upgrade-major. ${USAGE}`);
  }
  if (!out.service) throw new Error(`--service <name> is required. ${USAGE}`);
  return out;
}

// --- dry-run plan preview ---------------------------------------------------

/**
 * Enumerate the guarded frame's ORDERED steps for a plan, by driving the tested
 * contract model (runGuardedUpgrade) with a recording no-op transport. This is
 * the single source of truth for "what steps will run" — the same model the
 * product's `scripts/upgrade/postgres-upgrade-major.sh` mechanism implements —
 * so the dry-run preview can never drift from the executed frame.
 */
export function previewSteps(plan) {
  const steps = [];
  const record = (name) => () => {
    steps.push(name);
    return { ok: true };
  };
  runGuardedUpgrade({
    plan,
    sourceVolume: "<source>",
    candidateVolume: "<candidate>",
    targetVolume: "<target>",
    sourceImage: "<source-image>",
    targetImage: "<target-image>",
    dumpFile: "<dump>",
    backupDir: "<backup-dir>",
    transport: {
      quiesced: record("quiesce writers"),
      diskPrecheck: record("disk-space precheck (clone + dump)"),
      verifiedBackup: (a) => (record(`verified backup off a read-only clone (pg_dump ${plan.from}, checksummed)`)(a), { ok: true, candidateCreated: true }),
      restoreFresh: (a) => (record(`fresh pg${plan.to} volume at ${plan.targetMount} + restore`)(a), { ok: true, targetCreated: true }),
      verifyTarget: record("post-verify the restored target (server version + content read-back)"),
      cutover: record("COMMIT BOUNDARY: cut over onto the original volume (identity preserved)"),
      verifyCutover: record("post-cutover verify"),
      removeVolume: () => {},
    },
    ledger: {
      begin: () => (steps.push("ledger BEGIN (pending journal; live entry stays the source)"), { ok: true }),
      commit: () => (steps.push("ledger COMMIT (only after post-verify)"), { ok: true }),
      rollback: () => ({ ok: true }),
    },
  });
  return steps;
}

/**
 * Command entrypoint. PURE over injected seams so it is fully driven by mocks in
 * tests. The eligibility PLAN, the guarded-frame CONTRACT, and the ledger states
 * are decided here; the destructive dump/restore/cutover MECHANICS are delegated
 * to the product's guarded shell frame (`scripts/upgrade/postgres-upgrade-major.sh`,
 * the same mechanism the works-after upgrade-from arm proves with real docker),
 * driven through `deps.execute` with the deployed-version ledger wired in as its
 * `UPGRADE_LEDGER_HOOK`. Default (no --yes) prints the plan (a dry run); --yes
 * executes. Returns the process exit code.
 *
 * @param {string[]} argv  args after `upgrade-major`
 * @param {object} deps
 * @param {(parsed: object) => ({detected, target, sourceVolume, sourceImage, targetImage, backupDir?}|{refusal})} deps.resolvePlan
 *   resolve the deployed version + target + volume/images for --service (the
 *   real one runs the read-only preflight detection; a refusal short-circuits).
 * @param {(ctx: object) => number} [deps.execute]  run the guarded mechanism and
 *   return the process exit code (0/2/3/4/5). Required for a --yes run.
 * @param {object} [deps.matrix]
 * @param {(s:string)=>void} [deps.log] @param {(s:string)=>void} [deps.logError]
 */
export function runUpgradeMajorCommand(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  let parsed;
  try {
    parsed = parseUpgradeMajorArgs(argv);
  } catch (err) {
    logError(err.message);
    return UPGRADE_EXIT.USAGE;
  }

  let resolved;
  try {
    resolved = deps.resolvePlan(parsed);
  } catch (err) {
    logError(`upgrade-major: ${err.message}`);
    return UPGRADE_EXIT.USAGE;
  }
  if (resolved && resolved.refusal) {
    // A discovery-level refusal (no instance, ambiguous volume, docker
    // unavailable) — fail-closed, no mutation.
    logError(resolved.refusal.reason ?? "could not resolve the upgrade target.");
    return resolved.refusal.code ?? UPGRADE_EXIT.REFUSED;
  }

  const plan = planTransition({
    service: parsed.service,
    detected: resolved.detected,
    target: parsed.target ?? resolved.target,
    matrix: deps.matrix ?? DEFAULT_UPGRADE_MATRIX,
  });
  if (!plan.ok) {
    if (plan.code === UPGRADE_EXIT.OK) {
      log(plan.reason);
      return UPGRADE_EXIT.OK;
    }
    logError(`upgrade-major refused: ${plan.reason}`);
    if (plan.remediation) logError(`  -> ${plan.remediation}`);
    return plan.code;
  }

  const ctx = {
    plan,
    service: parsed.service,
    slug: resolved.slug ?? parsed.slug ?? null,
    sourceVolume: resolved.sourceVolume,
    sourceImage: resolved.sourceImage,
    targetImage: resolved.targetImage,
    backupDir: parsed.backupDir ?? resolved.backupDir ?? null,
    steps: previewSteps(plan),
  };

  // Default is a DRY RUN: describe exactly what --yes would do (no mutation).
  if (!parsed.yes) {
    const lines = [
      `Guarded Postgres major upgrade — ${plan.service}: ${plan.from} -> ${plan.to}` +
        `${plan.caseScoped ? " (case-scoped exception)" : ""}`,
      `  volume '${resolved.sourceVolume}' (mount ${plan.sourceMount} -> ${plan.targetMount})`,
      "  steps (each gates the next; the source volume is intact until the commit boundary):",
      ...ctx.steps.map((s, i) => `    ${i + 1}. ${s}`),
      `  Backup retained under your retention window; the old volume is preserved until post-verify passes.`,
      `  Re-run with --yes to execute. See ${plan.runbookUrl}.`,
    ];
    if (parsed.json) log(JSON.stringify({ dryRun: true, ...ctx }, null, 2));
    else log(lines.join("\n"));
    return UPGRADE_EXIT.OK;
  }

  if (typeof deps.execute !== "function") {
    logError("upgrade-major: no executor is available (the guarded mechanism ships with your cinatra checkout — run inside/point at it).");
    return UPGRADE_EXIT.USAGE;
  }
  const code = deps.execute(ctx);
  return typeof code === "number" ? code : UPGRADE_EXIT.INTERRUPTED;
}

export const __test = {
  USAGE,
  UPGRADE_EXIT,
  PHASE,
  pgMountTargetForMajor,
  PG_LEGACY_MOUNT,
  PG_PARENT_MOUNT,
  planTransition,
  runGuardedUpgrade,
  previewSteps,
  parseUpgradeMajorArgs,
  runUpgradeMajorCommand,
};
