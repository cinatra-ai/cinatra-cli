#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Deployed-version ledger HOOK for the guarded upgrade frame (cinatra-cli#129,
// upgrade-paths epic cinatra-ai/cinatra#1419). This is the "ledger transaction
// wiring": the executable the product's guarded shell mechanism
// (`scripts/upgrade/postgres-upgrade-major.sh`) invokes at each transaction
// boundary through its `UPGRADE_LEDGER_HOOK` seam (documented in that frame's
// scripts/upgrade/lib.sh), so a REAL `cinatra instance db upgrade-major` drives
// the instance-bound deployed-version ledger (src/version-ledger.mjs) instead of
// the harness file ledger.
//
// The frame calls the hook as (lib.sh `_uf_ledger`):
//     <hook> <begin|commit|rollback|record> <serviceId> <image> <volumeName>
// The ledger KEY (the compose service name), the instance slug, the target
// major, and the ledger dir come from the ENVIRONMENT (the CLI sets them when it
// invokes the frame) — so the frame's positional serviceId (a matrix id) never
// has to match the ledger's compose-service key:
//     CINATRA_UPGRADE_LEDGER_SLUG     the instance slug (ledger file key)
//     CINATRA_UPGRADE_LEDGER_SERVICE  the compose service name (ledger entry key)
//     CINATRA_UPGRADE_TARGET_MAJOR    the target data-format major (begin/record)
//     CINATRA_VERSION_LEDGER_DIR      the ledger dir (the version-ledger override)
//
// TRANSACTIONALITY (delegated to version-ledger.mjs, under its per-slug lock):
//   begin    — open the pending journal capturing the SOURCE; the live entry
//              stays the source until commit.
//   commit   — promote the target (called ONLY after the frame's post-verify).
//   rollback — restore the source entry (pre-commit abort).
//   record   — a plain post-op record (no migration in flight).
// Exit codes: 0 ok · 2 usage · 6 refused (malformed ledger / journal-state
// conflict / unresolvable volume identity) — the frame treats any non-zero as a
// ledger failure (a failed begin is fail-closed; a failed rollback is the
// retained-journal interrupted state).
// ---------------------------------------------------------------------------

import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  beginMigration,
  commitMigration,
  makeEntry,
  recordDeployed,
  requireUsableLedger,
  rollbackMigration,
  withLedgerLock,
  writeLedger,
} from "./version-ledger.mjs";

const OPS = new Set(["begin", "commit", "rollback", "record"]);

/** Resolve a volume's { name, createdAt } identity via `docker volume inspect`.
 *  Injectable (`run`) for tests; returns null on any failure. */
export function dockerVolumeIdentity(volumeName, run = defaultDockerRun) {
  if (!volumeName) return null;
  const out = run(["volume", "inspect", "-f", "{{.Name}}\t{{.CreatedAt}}", volumeName]);
  if (!out) return null;
  const [name, createdAt] = String(out).trim().split("\t");
  if (!name || !createdAt) return null;
  return { name, createdAt };
}

function defaultDockerRun(args) {
  try {
    const r = spawnSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

/**
 * Run one ledger-hook operation against the instance ledger, under the per-slug
 * lock. PURE over the injected `volumeIdentityOf` seam (so a test drives it
 * against a temp ledger dir without docker). Returns { ok, code, message }.
 */
export async function runLedgerHook({ op, service, image, volumeName, slug, targetMajor, ledgerDir, volumeIdentityOf }) {
  if (!OPS.has(op)) return { ok: false, code: 2, message: `unknown ledger op "${op}"` };
  if (!slug) return { ok: false, code: 2, message: "missing instance slug (CINATRA_UPGRADE_LEDGER_SLUG)" };
  if (!service) return { ok: false, code: 2, message: "missing ledger service (CINATRA_UPGRADE_LEDGER_SERVICE)" };
  if ((op === "begin" || op === "record") && !image) {
    return { ok: false, code: 2, message: `--image is required for "${op}"` };
  }
  // A begin/record with no target data-format version would commit a ledger
  // entry whose recorded version is unknown — the exact naive-recreate hazard
  // this whole feature closes. Require it (fail closed).
  if ((op === "begin" || op === "record") && !targetMajor) {
    return { ok: false, code: 2, message: `missing target data-format version (CINATRA_UPGRADE_TARGET_MAJOR) for "${op}"` };
  }
  const resolveIdentity = volumeIdentityOf ?? ((v) => dockerVolumeIdentity(v));

  return withLedgerLock(slug, ledgerDir, () => {
    let ledger;
    try {
      ledger = requireUsableLedger(slug, ledgerDir);
    } catch (err) {
      return { ok: false, code: 6, message: err.message };
    }
    try {
      let next;
      if (op === "begin" || op === "record") {
        const volume = resolveIdentity(volumeName);
        if (!volume) return { ok: false, code: 6, message: `could not resolve the identity of volume "${volumeName}"` };
        // Volume-identity binding at BEGIN ONLY: a recorded source entry that
        // does NOT describe the live volume (renamed, or destroyed+recreated =>
        // new createdAt) is a fail-closed finding — its data-format claim is
        // about a volume that no longer exists (version-ledger.beginMigration
        // captures the source but does not enforce this; the hook does,
        // mirroring the harness file ledger). `record` is the plain
        // (re)install/upgrade record — it DELIBERATELY rebinds to the live
        // volume (a fresh-init on a recreated volume legitimately re-records),
        // so it is exempt from the source-identity guard.
        if (op === "begin") {
          const existing = ledger.services[service];
          if (existing && (existing.volume.name !== volume.name || existing.volume.createdAt !== volume.createdAt)) {
            return {
              ok: false,
              code: 6,
              message:
                `recorded ${service} entry is bound to volume { ${existing.volume.name}, ${existing.volume.createdAt} } but the live volume is ` +
                `{ ${volume.name}, ${volume.createdAt} } — identity mismatch (fail-closed; the recorded version describes a volume that no longer exists).`,
            };
          }
        }
        const entry = makeEntry({ service, image, dataFormatVersion: targetMajor ?? null, volume });
        next = op === "begin" ? beginMigration(ledger, { service, target: entry }) : recordDeployed(ledger, entry);
      } else {
        // commit / rollback FINISH the exact migration the journal records. When
        // a journal is pending it can only be finished by naming its EXACT target
        // volume identity — a resolvable live identity is REQUIRED (an
        // unresolvable one is fail-closed, never silently finished), and a volume
        // destroyed+recreated MID-migration (new createdAt) can never be
        // committed/rolled-back over (fail-closed interrupted; mirrors the harness
        // file ledger's assertFinishesPending).
        const pending = ledger.pending;
        if (pending && pending.service === service) {
          const live = resolveIdentity(volumeName);
          if (!live) {
            return { ok: false, code: 6, message: `could not resolve the identity of volume "${volumeName}" — refusing to ${op} the pending ${service} migration` };
          }
          const want = pending.target?.volume;
          if (want && (live.name !== want.name || live.createdAt !== want.createdAt)) {
            return {
              ok: false,
              code: 6,
              message:
                `${op} sees live volume { ${live.name}, ${live.createdAt} } but the pending journal records ` +
                `{ ${want.name}, ${want.createdAt} } — the volume was destroyed+recreated mid-migration (fail-closed).`,
            };
          }
        }
        next = op === "commit" ? commitMigration(ledger, service) : rollbackMigration(ledger, service);
      }
      writeLedger(next, ledgerDir);
      return { ok: true, code: 0, message: `ledger ${op} for ${service}` };
    } catch (err) {
      // A journal-state conflict (double begin, commit/rollback without a
      // journal, service mismatch) — fail-closed refusal, ledger untouched.
      return { ok: false, code: 6, message: err.message };
    }
  });
}

/** CLI entry: `<hook> <op> <serviceId> <image> <volumeName>` + the env config. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [op, , image, volumeName] = argv; // positional serviceId (argv[1]) is ignored — the ledger key is env-driven
  const res = await runLedgerHook({
    op,
    service: env.CINATRA_UPGRADE_LEDGER_SERVICE,
    image: image ?? null,
    volumeName: volumeName ?? null,
    slug: env.CINATRA_UPGRADE_LEDGER_SLUG,
    targetMajor: env.CINATRA_UPGRADE_TARGET_MAJOR ?? null,
    ledgerDir: env.CINATRA_VERSION_LEDGER_DIR || undefined,
  });
  if (res.ok) process.stdout.write(`${res.message}\n`);
  else process.stderr.write(`LEDGER HOOK REFUSED: ${res.message}\n`);
  return res.code;
}

// Executed directly by the shell frame (never imported there): run main + exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}

export const __test = { OPS, dockerVolumeIdentity, runLedgerHook };
