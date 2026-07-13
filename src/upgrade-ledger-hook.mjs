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
        const entry = makeEntry({ service, image, dataFormatVersion: targetMajor ?? null, volume });
        next = op === "begin" ? beginMigration(ledger, { service, target: entry }) : recordDeployed(ledger, entry);
      } else if (op === "commit") {
        next = commitMigration(ledger, service);
      } else {
        next = rollbackMigration(ledger, service);
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
