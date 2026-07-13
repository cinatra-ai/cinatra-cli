// `cinatra extensions reconcile --plan | --apply` — operator-facing CLI
// planner/executor for a running instance's NON-REQUIRED extension updates
// (cinatra-cli#126).
//
// WHAT THIS IS: a THIN AUTHENTICATED CLIENT of a server-side plan/apply surface
// exposed by the target instance. It does NOT reimplement the in-app
// auto-update loop's selection gates and it never imports app internals — the
// running instance owns ALL of the selection + execution logic (the very seams
// the boot-seeded `extension-auto-update` loop drives), so a dry run can never
// be faked here by stubbing execution. The CLI's only jobs are: authenticate a
// platform admin against the instance, ask it to PLAN (read-only) or APPLY, and
// render the structured result deterministically. Parity with the loop's
// selection is therefore an instance-side property, not something this command
// re-derives.
//
// TRANSPORT CONTRACT (consumed here; served by the instance control plane under
// the authenticated `/api/cli/*` audience — the same Class-A surface `status`
// and the agent export/import commands use):
//
//   GET  /api/cli/extensions/reconcile/plan
//     → { planDigest, generatedAt, readModelStatus,
//         candidates: [{ packageName, currentVersion, targetVersion }],
//         skipped:    [{ packageName, reason, detail? }],
//         fences:     [{ fence, detail? }] }
//
//   POST /api/cli/extensions/reconcile/apply   body { planDigest?: string }
//     → { planDigest,
//         applied:          [{ packageName, fromVersion, toVersion }],
//         failed:           [{ packageName, reason, detail? }],
//         droppedByRecheck: [{ packageName, reason, detail? }],
//         auditWriteFailures: number,
//         initiatingOperator: string, systemExecutor: string }
//
// GATES the SERVER enforces and this command surfaces VERBATIM (never silent):
// non-required (`isSystemExtension`) only; platform-scoped NULL-org only;
// exactly one NULL-org row per package (else `ambiguous-install-scope`);
// verdaccio-live (`active|locked`) rows only (`non-verdaccio-source`); the
// operator deny list (`deny-listed`); sdk-ABI compatibility
// (`abi-incompatible`); the fleet signature-readiness fence
// (`signature-readiness` — when the fleet would not survive
// `require-signatures=true`, ZERO candidates execute); and a pre-dispatch
// TOCTOU recheck + expected-version CAS that may only SHRINK the candidate set
// (drift → `state-drift`; a concurrent update winning → `cas-version-lost`).
// (The org-row compensation fence was LIFTED by the host's row-scoped
// compensation — cinatra#1042 slice-2 — and is no longer emitted.)
//
// READ-MODEL-UNWIRED: until the instance's persistent update read-model store
// adapter is wired, PLAN reports every row as `read-model-unwired` rather than
// an empty (falsely "up to date") plan — this command renders those rows as
// unwired skips; it never invents an empty plan of its own.
//
// SAFETY SHAPE:
//   * `--plan` is the DEFAULT (dry run) and issues a GET — structurally
//     read-only, no server write is possible from this path.
//   * `--apply` POSTs. The server RE-PLANS immediately before dispatch (or, when
//     `--plan-digest <d>` is supplied, verifies the digest as a lightweight CAS
//     and refuses on mismatch), so a stale snapshot can never execute; a fresh
//     recheck may only SHRINK the root-candidate set. Application is
//     per-candidate ISOLATED — one failure never rolls back the rest.
//   * An `--apply` runs on operator demand independent of the always-on
//     `CINATRA_EXTENSION_AUTO_UPDATE` scheduling flag — every per-target gate
//     still applies; only the daily *scheduler* is decoupled.
//   * Audit-write failures are NON-FATAL (matching the loop): the update still
//     applied; the count is surfaced. The process exit code reflects ONLY
//     whether a candidate FAILED (isolated per-candidate failure ⇒ exit 1),
//     never an audit-write failure.

export const RECONCILE_PLAN_PATH = "/api/cli/extensions/reconcile/plan";
export const RECONCILE_APPLY_PATH = "/api/cli/extensions/reconcile/apply";

const VALUE_FLAGS = new Set(["--app-url", "--profile", "--plan-digest"]);

const USAGE =
  "Usage: cinatra extensions reconcile [--plan|--apply] " +
  "(--app-url <url> | --profile <name>) [--json] [--plan-digest <digest>]";

/**
 * Parse the args AFTER `cinatra extensions reconcile`.
 *
 * `--plan` is the default; `--apply` opts into execution. The two are mutually
 * exclusive. `--plan-digest` only applies to `--apply` (it pins the exact
 * candidate set the server may execute). Unknown flags are rejected rather than
 * silently ignored (an ignored `--aply` typo must never fall through to a
 * default-plan no-op that reads as success).
 *
 * @param {string[]} argv
 * @returns {{ mode: "plan"|"apply", json: boolean, appUrl: string|null, profile: string|null, planDigest: string|null }}
 */
export function parseReconcileArgs(argv) {
  let mode = null;
  let json = false;
  let appUrl = null;
  let profile = null;
  let planDigest = null;

  const setMode = (next) => {
    if (mode && mode !== next) {
      throw new Error("`--plan` and `--apply` are mutually exclusive.");
    }
    mode = next;
  };
  const assign = (flag, value) => {
    if (flag === "--app-url") appUrl = value;
    else if (flag === "--profile") profile = value;
    else if (flag === "--plan-digest") planDigest = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan") { setMode("plan"); continue; }
    if (a === "--apply") { setMode("apply"); continue; }
    if (a === "--json") { json = true; continue; }

    let handled = false;
    for (const vf of VALUE_FLAGS) {
      if (a === vf) {
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) throw new Error(`Missing value for ${vf}.`);
        assign(vf, v);
        i++;
        handled = true;
        break;
      }
      const eq = `${vf}=`;
      if (a.startsWith(eq)) {
        const v = a.slice(eq.length);
        if (!v) throw new Error(`Missing value for ${vf}.`);
        assign(vf, v);
        handled = true;
        break;
      }
    }
    if (handled) continue;

    throw new Error(`Unknown argument: ${a}\n${USAGE}`);
  }

  mode = mode ?? "plan";
  if (mode === "plan" && planDigest) {
    throw new Error(
      "--plan-digest only applies to --apply (it pins the exact candidate set apply may execute).",
    );
  }
  return { mode, json, appUrl, profile, planDigest };
}

/** Exit code for an apply result: any FAILED candidate ⇒ 1, else 0. */
export function computeExitCode(result) {
  return (result?.failed ?? []).length > 0 ? 1 : 0;
}

/** Longest `packageName` in a row list, for column alignment. */
function nameWidth(rows) {
  return rows.reduce((w, r) => Math.max(w, String(r.packageName ?? "").length), 0);
}

/**
 * Render a `--plan` (dry-run) result. `--json` emits the raw server payload
 * verbatim (the stable/parseable form an external dispatch lever gates on).
 */
export function formatPlan(plan, { json = false, origin = "instance" } = {}) {
  if (json) return `${JSON.stringify(plan, null, 2)}\n`;

  const candidates = plan?.candidates ?? [];
  const skipped = plan?.skipped ?? [];
  const fences = plan?.fences ?? [];
  const lines = [];
  lines.push(`Reconcile plan — ${origin} (read model: ${plan?.readModelStatus ?? "unknown"})`);
  lines.push("");

  if (fences.length > 0) {
    lines.push("FENCED — the instance is holding ALL updates while these hold:");
    for (const f of fences) {
      lines.push(`  ${f.fence}${f.detail ? `  (${f.detail})` : ""}`);
    }
    lines.push("");
  }

  if (candidates.length === 0) {
    // Never claim "up to date" when the read model is UNWIRED — an unwired
    // model yields NO update verdict, so an empty candidate set is "unknown",
    // not "current". This holds even if the server returned no per-row skips.
    if (plan?.readModelStatus === "unwired") {
      lines.push(
        "Would update: (none) — the instance's update read model is UNWIRED; " +
          "no update verdict is possible yet (this is NOT an up-to-date result).",
      );
    } else {
      lines.push(
        skipped.length === 0 && fences.length === 0
          ? "Would update: (none) — up to date."
          : "Would update: (none)",
      );
    }
  } else {
    lines.push(`Would update (${candidates.length}):`);
    const w = nameWidth(candidates);
    for (const c of candidates) {
      lines.push(`  ${String(c.packageName).padEnd(w)}  ${c.currentVersion} → ${c.targetVersion}`);
    }
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped (${skipped.length}):`);
    const w = nameWidth(skipped);
    for (const s of skipped) {
      lines.push(`  ${String(s.packageName).padEnd(w)}  ${s.reason}${s.detail ? `  (${s.detail})` : ""}`);
    }
  }

  lines.push("");
  if (plan?.planDigest) {
    lines.push(`Plan digest: ${plan.planDigest}`);
    lines.push(
      `  Pin this exact set: cinatra extensions reconcile --apply --plan-digest ${plan.planDigest}`,
    );
    lines.push("");
  }
  lines.push("Dry run — no changes were made.");
  return `${lines.join("\n")}\n`;
}

/**
 * Render an `--apply` result. `--json` emits the raw payload. Applied moves,
 * fresh-recheck drops (expected shrink, NOT failures), per-candidate failures,
 * and the non-fatal audit-write-failure count are all surfaced explicitly.
 */
export function formatApplyResult(result, { json = false, origin = "instance" } = {}) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;

  const applied = result?.applied ?? [];
  const failed = result?.failed ?? [];
  const dropped = result?.droppedByRecheck ?? [];
  const auditWriteFailures = result?.auditWriteFailures ?? 0;
  const lines = [];
  lines.push(`Reconcile apply — ${origin}`);
  if (result?.initiatingOperator || result?.systemExecutor) {
    lines.push(
      `  initiating operator: ${result.initiatingOperator ?? "?"}   ` +
        `system executor: ${result.systemExecutor ?? "?"}`,
    );
  }
  lines.push("");

  if (applied.length === 0 && failed.length === 0 && dropped.length === 0) {
    lines.push("Nothing to apply — the recomputed plan was empty (up to date).");
  }

  if (applied.length > 0) {
    lines.push(`Applied (${applied.length}):`);
    for (const a of applied) {
      lines.push(`  ${a.packageName}  ${a.fromVersion} → ${a.toVersion}`);
    }
    lines.push("");
  }

  if (dropped.length > 0) {
    lines.push(
      `Dropped by the fresh pre-dispatch recheck (${dropped.length}) — drifted since plan, not applied:`,
    );
    for (const d of dropped) {
      lines.push(`  ${d.packageName}  ${d.reason}${d.detail ? `  (${d.detail})` : ""}`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push(`Failed (${failed.length}):`);
    for (const f of failed) {
      lines.push(`  ${f.packageName}  ${f.reason}${f.detail ? `  (${f.detail})` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    `Audit write failures: ${auditWriteFailures}` +
      (auditWriteFailures > 0
        ? " (non-fatal — the update applied; the audit event did not persist)"
        : ""),
  );
  lines.push("");
  if (failed.length > 0) {
    lines.push(
      `${failed.length} candidate(s) failed. Per-candidate isolation means the rest still applied. Exit 1.`,
    );
  } else {
    lines.push("Apply complete. Exit 0.");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Turn a transport error into an operator-legible one. The reconcile surface is
 * a companion server slice — a 404 means this instance does not serve it yet;
 * a 409 (or a `plan-digest-mismatch` code) means the pinned digest is stale; a
 * 403 means the caller lacks platform-admin standing. Everything else is passed
 * through already token-redacted by the transport helper.
 */
export function surfaceError(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  const code = err && typeof err.code === "string" ? err.code : null;

  if (status === 404) {
    return new Error(
      "The reconcile surface is not available on this instance. It requires host " +
        "support for /api/cli/extensions/reconcile (a companion server slice). " +
        "Update the instance to a build that serves it, then retry.",
    );
  }
  if (status === 409 || code === "plan-digest-mismatch") {
    return new Error(
      "The plan changed since the supplied --plan-digest (the candidate set drifted). " +
        "Re-run `cinatra extensions reconcile --plan` and pass the fresh digest, or run " +
        "`--apply` without --plan-digest to re-plan against the live state.",
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      "Not authorized: `cinatra extensions reconcile` requires platform-admin standing " +
        `on the target instance.${err?.message ? ` (${err.message})` : ""}`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Build the default transport from the authenticated control-plane helpers.
 * Kept behind a lazy import so `--help` / arg-parse unit tests never load the
 * OAuth client. Tests inject `deps.transport` and never reach this.
 */
async function defaultTransport({ appUrl, profile }) {
  const { cliApiGetJson, cliApiPostJson } = await import("./login.mjs");
  return {
    origin: appUrl ?? (profile ? `profile:${profile}` : "instance"),
    get: (path) => cliApiGetJson(path, { appUrl, profile }),
    post: (path, body) => cliApiPostJson(path, body, { appUrl, profile }),
  };
}

/**
 * `cinatra extensions reconcile` entrypoint.
 *
 * Returns the intended process exit code (0, or 1 when an `--apply` had a
 * failed candidate) so the dispatcher can set `process.exitCode`; throws (with
 * a typed message) on a hard error. `deps` is injectable for tests:
 *   { transport: { origin, get(path), post(path, body) }, stdout(str) }
 *
 * @param {string[]} argv args AFTER `cinatra extensions reconcile`
 * @param {object} [deps]
 * @returns {Promise<number>}
 */
export async function runExtensionsReconcile(argv, deps = {}) {
  const opts = parseReconcileArgs(argv);
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));

  // A control-plane command, not a local fs/DB operation: it MUST target a
  // running instance. Require an explicit target so `reconcile` can never
  // silently act on an ambiguous default.
  if (!opts.appUrl && !opts.profile) {
    throw new Error(
      `Target a running instance: pass --app-url <https://instance> or --profile <name>.\n${USAGE}`,
    );
  }

  const transport = deps.transport ?? (await defaultTransport(opts));
  const origin = transport.origin ?? opts.appUrl ?? "instance";

  if (opts.mode === "plan") {
    let plan;
    try {
      plan = await transport.get(RECONCILE_PLAN_PATH);
    } catch (err) {
      throw surfaceError(err);
    }
    stdout(formatPlan(plan, { json: opts.json, origin }));
    return 0;
  }

  // --apply: the server re-plans (or verifies --plan-digest) and dispatches.
  let result;
  try {
    result = await transport.post(
      RECONCILE_APPLY_PATH,
      opts.planDigest ? { planDigest: opts.planDigest } : {},
    );
  } catch (err) {
    throw surfaceError(err);
  }
  stdout(formatApplyResult(result, { json: opts.json, origin }));
  return computeExitCode(result);
}
