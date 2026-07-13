// `cinatra instance db upgrade-major` — the guarded Postgres major upgrade
// (cinatra-cli#129, upgrade-paths epic cinatra-ai/cinatra#1419). Covers the
// eligibility plan, the guarded transaction state machine (every step + every
// failure path), ledger transactionality, and the command entrypoint — all at
// the PURE level over a mocked transport + ledger (never boots a container).

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_UPGRADE_MATRIX } from "../src/upgrade-matrix.mjs";
import {
  PG_LEGACY_MOUNT,
  PG_PARENT_MOUNT,
  PHASE,
  UPGRADE_EXIT,
  parseUpgradeMajorArgs,
  pgMountTargetForMajor,
  planTransition,
  previewSteps,
  runGuardedUpgrade,
  runUpgradeMajorCommand,
} from "../src/upgrade-major.mjs";

// --- pg mount layout (the pg18 parent-mount move) ---------------------------

describe("pgMountTargetForMajor", () => {
  it("keeps pg<=17 on the legacy .../data mount and moves pg>=18 to the parent", () => {
    expect(pgMountTargetForMajor("15")).toBe(PG_LEGACY_MOUNT);
    expect(pgMountTargetForMajor("16")).toBe(PG_LEGACY_MOUNT);
    expect(pgMountTargetForMajor("17")).toBe(PG_LEGACY_MOUNT);
    expect(pgMountTargetForMajor("18")).toBe(PG_PARENT_MOUNT);
    expect(pgMountTargetForMajor("19")).toBe(PG_PARENT_MOUNT);
    expect(pgMountTargetForMajor("18-alpine")).toBe(PG_PARENT_MOUNT);
  });
});

// --- eligibility plan (pure) ------------------------------------------------

describe("planTransition — matrix eligibility (fail-closed)", () => {
  it("Case A: platform postgres 17 -> 18 is the supported baseline (layout MOVE)", () => {
    const p = planTransition({ service: "postgres", detected: "17", target: "18" });
    expect(p.ok).toBe(true);
    expect(p.from).toBe("17");
    expect(p.to).toBe("18");
    expect(p.caseScoped).toBe(false);
    expect(p.sourceMount).toBe(PG_LEGACY_MOUNT); // 17 legacy
    expect(p.targetMount).toBe(PG_PARENT_MOUNT); // 18 parent
  });
  it("Case B: nango-db 15 -> 17 is the case-scoped exception (legacy on BOTH sides)", () => {
    const p = planTransition({ service: "nango-db", detected: "15", target: "17" });
    expect(p.ok).toBe(true);
    expect(p.caseScoped).toBe(true);
    expect(p.sourceMount).toBe(PG_LEGACY_MOUNT);
    expect(p.targetMount).toBe(PG_LEGACY_MOUNT);
  });
  it("refuses a downgrade fail-closed (exit 3)", () => {
    const p = planTransition({ service: "postgres", detected: "18", target: "17" });
    expect(p.ok).toBe(false);
    expect(p.code).toBe(UPGRADE_EXIT.REFUSED);
    expect(p.reason).toMatch(/downgrade blocked/);
  });
  it("refuses an unsupported forward hop fail-closed (nango 17 -> 18)", () => {
    const p = planTransition({ service: "nango-db", detected: "17", target: "18" });
    expect(p.ok).toBe(false);
    expect(p.code).toBe(UPGRADE_EXIT.REFUSED);
    expect(p.reason).toMatch(/unsupported upgrade hop/);
  });
  it("refuses an unknown service, an off-axis version, and an unknown detected version", () => {
    expect(planTransition({ service: "mystery", detected: "1", target: "2" }).code).toBe(UPGRADE_EXIT.REFUSED);
    expect(planTransition({ service: "postgres", detected: "42", target: "18" }).code).toBe(UPGRADE_EXIT.REFUSED);
    expect(planTransition({ service: "postgres", detected: null, target: "18" }).code).toBe(UPGRADE_EXIT.REFUSED);
  });
  it("treats detected == target as a clean no-op (exit 0, not an error)", () => {
    const p = planTransition({ service: "postgres", detected: "18", target: "18" });
    expect(p.ok).toBe(false);
    expect(p.code).toBe(UPGRADE_EXIT.OK);
    expect(p.reason).toMatch(/already at 18/);
  });
  it("the case-scoped nango hop the matrix does NOT list still fails closed (16 -> 17 removed in reconcile)", () => {
    // Reconcile fix: the shipped copy no longer carries a general nango 16->17.
    const p = planTransition({ service: "nango-db", detected: "16", target: "17" });
    expect(p.ok).toBe(false);
    expect(p.code).toBe(UPGRADE_EXIT.REFUSED);
  });
});

// --- guarded transaction state machine --------------------------------------

// A mock transport: every method returns { ok:true } and records its call in
// order, unless `fail` names it. Tracks created/removed volumes so a test can
// assert the retention/cleanup + rollback rules.
function mockTransport(fail = new Set()) {
  const calls = [];
  const removed = [];
  const step = (name) => (args) => {
    calls.push(name);
    return { ok: !fail.has(name), users: name === "quiesced" && fail.has(name) ? ["holder-1"] : undefined };
  };
  return {
    calls,
    removed,
    quiesced: step("quiesced"),
    diskPrecheck: step("diskPrecheck"),
    verifiedBackup: step("verifiedBackup"),
    restoreFresh: step("restoreFresh"),
    verifyTarget: step("verifyTarget"),
    cutover: step("cutover"),
    verifyCutover: step("verifyCutover"),
    removeVolume: (name) => removed.push(name),
  };
}

function mockLedger(overrides = {}) {
  return {
    begin: vi.fn(() => ({ ok: true })),
    commit: vi.fn(() => ({ ok: true })),
    rollback: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
}

const PLAN_A = {
  ok: true,
  service: "postgres",
  from: "17",
  to: "18",
  caseScoped: false,
  sourceMount: PG_LEGACY_MOUNT,
  targetMount: PG_PARENT_MOUNT,
};

function guarded({ fail = new Set(), ledger = mockLedger(), inject = () => false } = {}) {
  const transport = mockTransport(fail);
  const result = runGuardedUpgrade({
    plan: PLAN_A,
    sourceVolume: "cinatra-postgres",
    candidateVolume: "cinatra-postgres-cand",
    targetVolume: "cinatra-postgres-target",
    sourceImage: "postgres:17-alpine",
    targetImage: "postgres:18-alpine",
    dumpFile: "/backups/pg.dump",
    backupDir: "/backups",
    transport,
    ledger,
    inject,
  });
  return { result, transport, ledger };
}

describe("runGuardedUpgrade — happy path", () => {
  it("runs the full frame, commits the ledger, and cleans up the retired volumes", () => {
    const { result, transport, ledger } = guarded();
    expect(result.code).toBe(UPGRADE_EXIT.OK);
    expect(result.phase).toBe(PHASE.POST_COMMIT);
    expect(transport.calls).toEqual([
      "quiesced",
      "diskPrecheck",
      "verifiedBackup",
      "restoreFresh",
      "verifyTarget",
      "cutover",
      "verifyCutover",
    ]);
    expect(ledger.begin).toHaveBeenCalledOnce();
    expect(ledger.commit).toHaveBeenCalledOnce();
    expect(ledger.rollback).not.toHaveBeenCalled();
    // Retention: the retired candidate + target volumes are removed AFTER commit;
    // the dump is retained (never removed).
    expect(result.dumpFile).toBe("/backups/pg.dump");
    expect(transport.removed.sort()).toEqual(["cinatra-postgres-cand", "cinatra-postgres-target"]);
  });
});

describe("runGuardedUpgrade — pre-commit refusals (no ledger, no mutation)", () => {
  it("un-quiesced volume fails closed (exit 3) with NO ledger begin", () => {
    const { result, ledger, transport } = guarded({ fail: new Set(["quiesced"]) });
    expect(result.code).toBe(UPGRADE_EXIT.REFUSED);
    expect(result.phase).toBe(PHASE.PRE_COMMIT);
    expect(ledger.begin).not.toHaveBeenCalled();
    expect(transport.calls).toEqual(["quiesced"]);
  });
  it("a failed disk precheck fails closed (exit 3) BEFORE any ledger begin", () => {
    const { result, ledger } = guarded({ fail: new Set(["diskPrecheck"]) });
    expect(result.code).toBe(UPGRADE_EXIT.REFUSED);
    expect(ledger.begin).not.toHaveBeenCalled();
  });
  it("a refused ledger begin (pending journal / identity mismatch) fails closed (exit 3), no rollback", () => {
    const ledger = mockLedger({ begin: vi.fn(() => ({ ok: false, detail: "a migration is already in flight" })) });
    const { result } = guarded({ ledger });
    expect(result.code).toBe(UPGRADE_EXIT.REFUSED);
    expect(ledger.rollback).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
  });
});

describe("runGuardedUpgrade — failure injection at each pre-commit step rolls back to the intact source", () => {
  for (const point of ["backup-verify", "restore", "post-verify"]) {
    it(`injected '${point}' failure aborts pre-commit (exit 5), restores the source ledger, removes THIS run's volumes`, () => {
      const { result, ledger, transport } = guarded({ inject: (p) => p === point });
      expect(result.code).toBe(UPGRADE_EXIT.ROLLED_BACK);
      expect(result.phase).toBe(PHASE.PRE_COMMIT);
      expect(ledger.begin).toHaveBeenCalledOnce();
      expect(ledger.rollback).toHaveBeenCalledOnce();
      expect(ledger.commit).not.toHaveBeenCalled();
      // The candidate is always created before the backup; the target only once
      // restore is reached. Both created-by-this-run volumes are removed; the
      // ORIGINAL is never in the removed set.
      expect(transport.removed).toContain("cinatra-postgres-cand");
      expect(transport.removed).not.toContain("cinatra-postgres");
    });
  }
  it("a transport-reported (non-injected) backup failure also rolls back", () => {
    const { result, ledger } = guarded({ fail: new Set(["verifiedBackup"]) });
    expect(result.code).toBe(UPGRADE_EXIT.ROLLED_BACK);
    expect(ledger.rollback).toHaveBeenCalledOnce();
  });
});

describe("runGuardedUpgrade — a FAILED rollback is the fail-closed interrupted state (exit 4)", () => {
  it("keeps the pending journal when rollback itself fails", () => {
    const ledger = mockLedger({ rollback: vi.fn(() => ({ ok: false })) });
    const { result } = guarded({ inject: (p) => p === "post-verify", ledger });
    expect(result.code).toBe(UPGRADE_EXIT.INTERRUPTED);
    expect(result.message).toMatch(/LEDGER ROLLBACK FAILED/);
  });
});

describe("runGuardedUpgrade — post-commit interruptions retain the pending journal (exit 4)", () => {
  it("a cutover failure retains the journal + recovery material, never rolls back", () => {
    const { result, ledger } = guarded({ inject: (p) => p === "cutover" });
    expect(result.code).toBe(UPGRADE_EXIT.INTERRUPTED);
    expect(result.phase).toBe(PHASE.POST_COMMIT);
    expect(ledger.rollback).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(result.message).toMatch(/interrupted migration/);
  });
  it("a post-cutover verify failure is likewise interrupted (journal retained)", () => {
    const { result, ledger } = guarded({ inject: (p) => p === "cutover-verify" });
    expect(result.code).toBe(UPGRADE_EXIT.INTERRUPTED);
    expect(ledger.rollback).not.toHaveBeenCalled();
    expect(result.targetVolume).toBe("cinatra-postgres-target");
  });
  it("a ledger commit that fails after a verified cutover is interrupted, never a silent success", () => {
    const ledger = mockLedger({ commit: vi.fn(() => ({ ok: false })) });
    const { result } = guarded({ ledger });
    expect(result.code).toBe(UPGRADE_EXIT.INTERRUPTED);
  });
});

// --- argument parsing -------------------------------------------------------

describe("parseUpgradeMajorArgs", () => {
  it("requires --service and parses the flags", () => {
    const p = parseUpgradeMajorArgs(["--service", "postgres", "--instance", "acme", "--target", "18", "--backup-dir", "/b", "--yes", "--json"]);
    expect(p).toEqual({ service: "postgres", slug: "acme", target: "18", backupDir: "/b", yes: true, json: true });
  });
  it("supports --flag=value form", () => {
    const p = parseUpgradeMajorArgs(["--service=nango-db", "--target=17"]);
    expect(p.service).toBe("nango-db");
    expect(p.target).toBe("17");
  });
  it("throws on a missing --service, an unknown flag, and a missing value", () => {
    expect(() => parseUpgradeMajorArgs([])).toThrow(/--service <name> is required/);
    expect(() => parseUpgradeMajorArgs(["--service", "postgres", "--bogus"])).toThrow(/Unexpected argument/);
    expect(() => parseUpgradeMajorArgs(["--service"])).toThrow(/Missing value/);
  });
});

// --- dry-run step preview ---------------------------------------------------

describe("previewSteps — the ordered guarded frame (dry-run source of truth)", () => {
  it("enumerates quiesce -> disk -> ledger begin -> backup -> restore -> verify -> commit boundary -> commit", () => {
    const steps = previewSteps(PLAN_A);
    expect(steps[0]).toMatch(/quiesce/);
    expect(steps.some((s) => /ledger BEGIN/.test(s))).toBe(true);
    expect(steps.some((s) => /pg_dump 17/.test(s))).toBe(true);
    expect(steps.some((s) => /fresh pg18 volume/.test(s))).toBe(true);
    expect(steps.some((s) => /COMMIT BOUNDARY/.test(s))).toBe(true);
    expect(steps[steps.length - 1]).toMatch(/ledger COMMIT/);
  });
});

// --- command entrypoint (mocked resolvePlan + execute) ----------------------

function runCmd(argv, { resolved, execute } = {}) {
  const logs = [];
  const errs = [];
  const executeSpy = execute ?? vi.fn(() => UPGRADE_EXIT.OK);
  const code = runUpgradeMajorCommand(argv, {
    resolvePlan: () =>
      resolved ?? {
        detected: "17",
        target: "18",
        sourceVolume: "cinatra-postgres",
        sourceImage: "postgres:17-alpine",
        targetImage: "postgres:18-alpine",
        backupDir: "/backups",
      },
    execute: executeSpy,
    matrix: DEFAULT_UPGRADE_MATRIX,
    log: (s) => logs.push(s),
    logError: (s) => errs.push(s),
  });
  return { code, logs, errs, execute: executeSpy };
}

describe("runUpgradeMajorCommand — dry-run + delegated execution", () => {
  it("DEFAULT (no --yes) is a dry run: prints the plan, exits 0, NEVER executes", () => {
    const { code, logs, execute } = runCmd(["--service", "postgres"]);
    expect(code).toBe(UPGRADE_EXIT.OK);
    expect(execute).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/17 -> 18/);
    expect(logs.join("\n")).toMatch(/Re-run with --yes/);
  });
  it("--yes delegates to the executor and returns its exit code, passing the resolved ctx", () => {
    const execute = vi.fn((ctx) => {
      expect(ctx.plan.from).toBe("17");
      expect(ctx.plan.to).toBe("18");
      expect(ctx.sourceVolume).toBe("cinatra-postgres");
      return UPGRADE_EXIT.OK;
    });
    const { code } = runCmd(["--service", "postgres", "--yes"], { execute });
    expect(code).toBe(UPGRADE_EXIT.OK);
    expect(execute).toHaveBeenCalledOnce();
  });
  it("propagates a guarded exit code from the executor (interrupted -> 4)", () => {
    const { code } = runCmd(["--service", "postgres", "--yes"], { execute: () => UPGRADE_EXIT.INTERRUPTED });
    expect(code).toBe(UPGRADE_EXIT.INTERRUPTED);
  });
  it("--yes with no executor available fails closed (exit 2), no execution", () => {
    const logs = [];
    const errs = [];
    const code = runUpgradeMajorCommand(["--service", "postgres", "--yes"], {
      resolvePlan: () => ({ detected: "17", target: "18", sourceVolume: "v", sourceImage: "i", targetImage: "j" }),
      log: (s) => logs.push(s),
      logError: (s) => errs.push(s),
    });
    expect(code).toBe(UPGRADE_EXIT.USAGE);
    expect(errs.join("\n")).toMatch(/guarded mechanism ships with your cinatra checkout/);
  });
  it("a usage error returns exit 2", () => {
    const { code } = runCmd(["--bogus"]);
    expect(code).toBe(UPGRADE_EXIT.USAGE);
  });
  it("a discovery-level refusal short-circuits fail-closed with its own code, no execution", () => {
    const { code, errs, execute } = runCmd(["--service", "postgres"], {
      resolved: { refusal: { code: UPGRADE_EXIT.REFUSED, reason: "could not identify the data volume" } },
    });
    expect(code).toBe(UPGRADE_EXIT.REFUSED);
    expect(execute).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/could not identify the data volume/);
  });
  it("an ineligible hop (downgrade) refuses without executing", () => {
    const { code, execute } = runCmd(["--service", "postgres", "--yes"], {
      resolved: { detected: "18", target: "17", sourceVolume: "v", sourceImage: "i", targetImage: "j" },
    });
    expect(code).toBe(UPGRADE_EXIT.REFUSED);
    expect(execute).not.toHaveBeenCalled();
  });
  it("a --target override is honored (detected == override -> clean no-op, no execution)", () => {
    const { code, execute } = runCmd(["--service", "postgres", "--target", "17", "--yes"], {
      resolved: { detected: "17", target: "18", sourceVolume: "v", sourceImage: "i", targetImage: "j" },
    });
    expect(code).toBe(UPGRADE_EXIT.OK);
    expect(execute).not.toHaveBeenCalled();
  });
});
