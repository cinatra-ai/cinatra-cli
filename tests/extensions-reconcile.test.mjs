// Unit tests for the pure surface of `cinatra extensions reconcile`
// (cinatra-cli#126): flag parsing, plan/apply rendering, exit-code logic, and
// transport-error surfacing. No network, no credentials — every function here
// is pure over its arguments.

import { describe, it, expect } from "vitest";

import {
  parseReconcileArgs,
  formatPlan,
  formatApplyResult,
  computeExitCode,
  surfaceError,
  RECONCILE_PLAN_PATH,
  RECONCILE_APPLY_PATH,
} from "../src/extensions-reconcile.mjs";

describe("parseReconcileArgs", () => {
  it("defaults to plan mode with no flags", () => {
    expect(parseReconcileArgs([])).toEqual({
      mode: "plan",
      json: false,
      appUrl: null,
      profile: null,
      planDigest: null,
    });
  });

  it("--apply selects apply mode", () => {
    expect(parseReconcileArgs(["--apply"]).mode).toBe("apply");
  });

  it("explicit --plan is accepted (redundant with the default)", () => {
    expect(parseReconcileArgs(["--plan"]).mode).toBe("plan");
  });

  it("--plan and --apply together are rejected (mutually exclusive)", () => {
    expect(() => parseReconcileArgs(["--plan", "--apply"])).toThrow(/mutually exclusive/);
    expect(() => parseReconcileArgs(["--apply", "--plan"])).toThrow(/mutually exclusive/);
  });

  it("reads --app-url / --profile / --plan-digest in both space and = forms", () => {
    expect(parseReconcileArgs(["--app-url", "https://x"]).appUrl).toBe("https://x");
    expect(parseReconcileArgs(["--app-url=https://y"]).appUrl).toBe("https://y");
    expect(parseReconcileArgs(["--profile", "prod"]).profile).toBe("prod");
    expect(parseReconcileArgs(["--apply", "--plan-digest=sha256:abc"]).planDigest).toBe("sha256:abc");
  });

  it("--json sets the json flag", () => {
    expect(parseReconcileArgs(["--json"]).json).toBe(true);
  });

  it("rejects a value flag with a missing value", () => {
    expect(() => parseReconcileArgs(["--app-url"])).toThrow(/Missing value for --app-url/);
    expect(() => parseReconcileArgs(["--app-url", "--json"])).toThrow(/Missing value for --app-url/);
    expect(() => parseReconcileArgs(["--app-url="])).toThrow(/Missing value for --app-url/);
  });

  it("rejects an unknown flag rather than silently ignoring it", () => {
    // A silently-ignored `--aply` typo would fall through to a default-plan
    // no-op that reads as success — the exact footgun this guards.
    expect(() => parseReconcileArgs(["--aply"])).toThrow(/Unknown argument: --aply/);
  });

  it("refuses --plan-digest in plan mode (it only pins an apply set)", () => {
    expect(() => parseReconcileArgs(["--plan", "--plan-digest=sha256:x"])).toThrow(
      /--plan-digest only applies to --apply/,
    );
  });
});

describe("formatPlan", () => {
  const plan = {
    planDigest: "sha256:deadbeef",
    readModelStatus: "wired",
    candidates: [
      { packageName: "@cinatra-ai/foo", currentVersion: "1.2.0", targetVersion: "1.3.0" },
      { packageName: "@cinatra-ai/bar-longer", currentVersion: "0.4.1", targetVersion: "0.5.0" },
    ],
    skipped: [
      { packageName: "@cinatra-ai/baz", reason: "ambiguous-install-scope" },
      { packageName: "@cinatra-ai/qux", reason: "abi-incompatible", detail: "host 2.x, needs 3.x" },
    ],
    fences: [],
  };

  it("renders candidates, skips, digest, and the dry-run banner", () => {
    const out = formatPlan(plan, { origin: "https://inst" });
    expect(out).toContain("Reconcile plan — https://inst (read model: wired)");
    expect(out).toContain("Would update (2):");
    expect(out).toContain("@cinatra-ai/foo");
    expect(out).toContain("1.2.0 → 1.3.0");
    expect(out).toContain("Skipped (2):");
    expect(out).toContain("ambiguous-install-scope");
    expect(out).toContain("abi-incompatible  (host 2.x, needs 3.x)");
    expect(out).toContain("Plan digest: sha256:deadbeef");
    expect(out).toContain("Dry run — no changes were made.");
  });

  it("renders an all-unwired plan as unwired skips, never an empty 'up to date'", () => {
    const unwired = {
      planDigest: "sha256:0",
      readModelStatus: "unwired",
      candidates: [],
      skipped: [
        { packageName: "@cinatra-ai/foo", reason: "read-model-unwired" },
        { packageName: "@cinatra-ai/bar", reason: "read-model-unwired" },
      ],
      fences: [],
    };
    const out = formatPlan(unwired);
    expect(out).toContain("read model: unwired");
    expect(out).toContain("Would update: (none)");
    expect(out).toContain("read-model-unwired");
    // It must NOT falsely claim up-to-date when rows are merely unwired.
    expect(out).not.toContain("up to date");
  });

  it("renders instance-wide fences that hold all updates", () => {
    const fenced = {
      planDigest: "sha256:1",
      readModelStatus: "wired",
      candidates: [],
      skipped: [],
      // The only instance-wide fence the merged host emits today (cinatra#1418):
      // fleet signature-readiness NOT-READY holds every update, fail-closed.
      fences: [{ fence: "signature-readiness", detail: "the fleet signature-readiness predicate is NOT-READY" }],
    };
    const out = formatPlan(fenced);
    expect(out).toContain("FENCED");
    expect(out).toContain("signature-readiness");
    expect(out).toContain("the fleet signature-readiness predicate is NOT-READY");
  });

  it("reports genuinely up-to-date when there is nothing to do", () => {
    const clean = { planDigest: "sha256:2", readModelStatus: "wired", candidates: [], skipped: [], fences: [] };
    expect(formatPlan(clean)).toContain("up to date");
  });

  it("an UNWIRED read model with no rows is NOT rendered as 'up to date'", () => {
    // Defense in depth: even if the server returns readModelStatus:"unwired"
    // with empty candidates/skipped/fences, the client must not claim the
    // instance is current — an unwired model yields no update verdict.
    const unwiredEmpty = { planDigest: "sha256:3", readModelStatus: "unwired", candidates: [], skipped: [], fences: [] };
    const out = formatPlan(unwiredEmpty);
    expect(out).toContain("UNWIRED");
    expect(out).toContain("NOT an up-to-date result");
    expect(out).not.toMatch(/— up to date\./);
  });

  it("--json emits the raw payload verbatim (the parseable gate form)", () => {
    const out = formatPlan(plan, { json: true });
    expect(JSON.parse(out)).toEqual(plan);
  });
});

describe("formatApplyResult / computeExitCode", () => {
  it("renders applied moves, drops, failures, and audit-failure count", () => {
    const result = {
      planDigest: "sha256:x",
      applied: [{ packageName: "@cinatra-ai/foo", fromVersion: "1.2.0", toVersion: "1.3.0" }],
      failed: [{ packageName: "@cinatra-ai/bar", reason: "install-failed", detail: "boom" }],
      droppedByRecheck: [{ packageName: "@cinatra-ai/baz", reason: "state-drift" }],
      auditWriteFailures: 1,
      initiatingOperator: "alice@x",
      systemExecutor: "system:extension-auto-update",
    };
    const out = formatApplyResult(result, { origin: "https://inst" });
    expect(out).toContain("Reconcile apply — https://inst");
    expect(out).toContain("initiating operator: alice@x");
    expect(out).toContain("system executor: system:extension-auto-update");
    expect(out).toContain("Applied (1):");
    expect(out).toContain("1.2.0 → 1.3.0");
    expect(out).toContain("Dropped by the fresh pre-dispatch recheck (1)");
    expect(out).toContain("Failed (1):");
    expect(out).toContain("install-failed  (boom)");
    expect(out).toContain("Audit write failures: 1 (non-fatal");
    expect(out).toContain("Exit 1.");
    expect(computeExitCode(result)).toBe(1);
  });

  it("a drift-only apply (drops, no failures) is exit 0 — a drop is expected shrink, not a failure", () => {
    const result = {
      applied: [{ packageName: "@cinatra-ai/foo", fromVersion: "1.0.0", toVersion: "1.1.0" }],
      failed: [],
      droppedByRecheck: [{ packageName: "@cinatra-ai/bar", reason: "state-drift" }],
      auditWriteFailures: 0,
    };
    expect(computeExitCode(result)).toBe(0);
    expect(formatApplyResult(result)).toContain("Exit 0.");
  });

  it("an audit-write failure alone does NOT change the exit code (non-fatal)", () => {
    const result = { applied: [], failed: [], droppedByRecheck: [], auditWriteFailures: 3 };
    expect(computeExitCode(result)).toBe(0);
  });

  it("an empty apply reports up-to-date", () => {
    const result = { applied: [], failed: [], droppedByRecheck: [], auditWriteFailures: 0 };
    expect(formatApplyResult(result)).toContain("up to date");
  });

  it("--json emits the raw payload verbatim", () => {
    const result = { applied: [], failed: [], droppedByRecheck: [], auditWriteFailures: 0 };
    expect(JSON.parse(formatApplyResult(result, { json: true }))).toEqual(result);
  });
});

describe("surfaceError", () => {
  it("maps 404 to a 'surface not available on this instance' message", () => {
    const e = Object.assign(new Error("Request failed (404 Not Found)"), { status: 404 });
    expect(surfaceError(e).message).toMatch(/not available on this instance/);
  });

  it("maps 409 / plan-digest-mismatch to a stale-digest message", () => {
    const byStatus = Object.assign(new Error("x"), { status: 409 });
    const byCode = Object.assign(new Error("x"), { status: 400, code: "plan-digest-mismatch" });
    expect(surfaceError(byStatus).message).toMatch(/plan changed since the supplied --plan-digest/);
    expect(surfaceError(byCode).message).toMatch(/plan changed since the supplied --plan-digest/);
  });

  it("maps 401/403 to an authorization message", () => {
    const e = Object.assign(new Error("nope"), { status: 403 });
    expect(surfaceError(e).message).toMatch(/requires platform-admin standing/);
  });

  it("passes a generic (already-redacted) error through unchanged", () => {
    const e = Object.assign(new Error("Request failed (500 Internal Server Error)"), { status: 500 });
    expect(surfaceError(e)).toBe(e);
  });
});

describe("transport path constants", () => {
  it("target the authenticated control-plane reconcile surface", () => {
    expect(RECONCILE_PLAN_PATH).toBe("/api/cli/extensions/reconcile/plan");
    expect(RECONCILE_APPLY_PATH).toBe("/api/cli/extensions/reconcile/apply");
  });
});
