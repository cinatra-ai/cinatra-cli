// Pure, side-effect-free decision helpers for `cinatra update` (cinatra-cli#60).
//
// `cinatra update` is now a TWO-CHOICE command:
//   1. Update the CLI       — `npm install -g @cinatra-ai/cinatra@latest` (DEFAULT
//                             in a TTY).
//   2. Update an instance   — move the checkout forward + reconcile deps + dev DB.
//                             By instance TYPE: dev → fast-forward latest
//                             `origin/main`; prod → latest `v*` release (today's
//                             behavior).
//
// The flow orchestration (the actual npm install / git move / reconcile) lives in
// index.mjs because it depends on that file's internal helpers + lazy imports.
// The decision + flag-parsing logic that is worth testing in isolation lives here
// so it can be unit-tested without a TTY, a network, a git checkout, or a docker
// stack.

export const CLI_PACKAGE = "@cinatra-ai/cinatra";
export const CLI_INSTALL_SPEC = `${CLI_PACKAGE}@latest`;

const UPDATE_TARGET_FLAGS = ["--cli", "--instance"];

// A git ref `update --instance` is willing to move to via --ref: a branch/tag/sha
// name. Mirrors install.mjs's SAFE_REF_RE (no whitespace, no leading dash → no
// option-injection, no `..` refspec metacharacters).
const UPDATE_SAFE_REF_RE = /^(?!-)[A-Za-z0-9._\/-]+$/;

/**
 * Parse the `cinatra update` argv into a normalized intent.
 *
 * Recognized flags:
 *   --cli            force the "update the CLI" path (bypasses the prompt).
 *   --instance       force the "update an instance" path (bypasses the prompt).
 *   --ref <ref>      (instance) pin the target ref (default: dev=origin/main,
 *                    prod=latest v* release). Forces --instance.
 *   --force          (instance) stash a dirty tree / hard-reset a divergent branch.
 *                    Forces --instance.
 *   --docker=auto|always / --no-docker  (instance) forwarded to the reconcile.
 *                    Force --instance.
 *   --dry-run        describe the chosen action; make NO changes (both paths).
 *
 * `--cli` and `--instance` are mutually exclusive. Any instance-only flag
 * (`--ref`/`--force`/docker) given together with `--cli` is a contradiction and
 * throws. Unknown flags fail loudly. ALL validation happens HERE, before any side
 * effect (npm install / git move), so a typo can never half-apply an update.
 *
 * @returns {{ target: "cli"|"instance"|null, ref: string|null, force: boolean,
 *             refreshArgs: string[], dryRun: boolean }}
 *   `target: null` means "no explicit selection" — the caller resolves it from
 *   TTY (interactive prompt) or the non-TTY back-compat default (instance).
 */
export function parseUpdateArgs(argv = []) {
  let cli = false;
  let instance = false;
  let ref = null;
  let force = false;
  let dryRun = false;
  const refreshArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cli") {
      cli = true;
      continue;
    }
    if (arg === "--instance") {
      instance = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--ref") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--ref requires a value (got ${value === undefined ? "end of arguments" : `"${value}"`}).`);
      }
      if (!UPDATE_SAFE_REF_RE.test(value) || value.includes("..")) {
        throw new Error(
          `Invalid --ref "${value}". Use a branch, tag, or commit sha ` +
            `(letters/digits/dot/dash/underscore/slash; no leading dash, no "..").`,
        );
      }
      ref = value;
      i += 1;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-docker" || arg.startsWith("--docker=")) {
      refreshArgs.push(arg);
      continue;
    }
    throw new Error(
      `Unknown flag "${arg}" for cinatra update. Supported flags: ${UPDATE_TARGET_FLAGS.join(", ")}, ` +
        `--ref <ref>, --force, --docker=auto|always, --no-docker, --dry-run.`,
    );
  }

  // The instance-only flags imply the instance path. Treat them as an implicit
  // --instance so `cinatra update --ref <tag>` "just works" without forcing the
  // user to also pass --instance.
  const instanceOnlyGiven = ref !== null || force || refreshArgs.length > 0;
  if (cli && (instance || instanceOnlyGiven)) {
    throw new Error(
      "Conflicting flags: --cli updates the CLI itself, so it cannot be combined with " +
        "--instance / --ref / --force / --docker. Pick one path.",
    );
  }

  let target = null;
  if (cli) target = "cli";
  else if (instance || instanceOnlyGiven) target = "instance";

  return { target, ref, force, refreshArgs, dryRun };
}

/**
 * Resolve the EFFECTIVE update path from a parsed selection + the TTY signal.
 *
 * Contract (cinatra-cli#60 "Back-compat"):
 *   - An explicit selection (`--cli` / `--instance` / an instance-only flag)
 *     always wins and bypasses the prompt — `interactive: false`.
 *   - No explicit selection + a TTY → present the two-choice picker
 *     (`interactive: true`); the default highlighted choice is the CLI update.
 *   - No explicit selection + NO TTY (piped / CI) → do NOT prompt; default to the
 *     INSTANCE update so existing `cinatra update` scripts (which update the
 *     instance) keep working. `interactive: false`.
 *
 * @param {"cli"|"instance"|null} target  the parsed explicit selection
 * @param {boolean} isTty                 true iff BOTH stdin and stdout are a TTY
 * @returns {{ path: "cli"|"instance", interactive: boolean, reason: string }}
 */
export function resolveUpdatePath(target, isTty) {
  if (target === "cli") {
    return { path: "cli", interactive: false, reason: "--cli flag" };
  }
  if (target === "instance") {
    return { path: "instance", interactive: false, reason: "--instance flag (or an instance-only flag)" };
  }
  if (isTty) {
    // Resolved by the interactive picker; default highlighted = CLI. The caller
    // runs the picker and overrides `path` with the user's choice.
    return { path: "cli", interactive: true, reason: "interactive (TTY) — defaulting to the CLI update" };
  }
  // Non-TTY, no explicit selection → back-compat: update the instance.
  return {
    path: "instance",
    interactive: false,
    reason: "non-interactive (no TTY) — defaulting to the instance update for script back-compat",
  };
}

/**
 * Decide the git-move target for the INSTANCE path from the instance type.
 *   - dev  → fast-forward to the latest `origin/main` (kind "ref", ref "main").
 *   - prod → move to the latest `v*` release TAG (kind "tag", resolved by the
 *            caller via resolveLatestReleaseTag). Today's behavior.
 * An explicit `--ref` always overrides the type-derived default (kind "ref").
 *
 * IMPORTANT (dev): the ref is the bare branch name `"main"`, NOT the local branch
 * as-is and NOT the literal remote-tracking ref `"origin/main"` (which is not a
 * fetchable refspec on the remote). `moveExistingCheckoutToRef({kind:"ref"})`
 * first runs `git fetch origin main`, then resolves the target commit from
 * FETCH_HEAD (the JUST-FETCHED upstream tip) — so it lands on the LATEST
 * `origin/main`, never a stale local `main`. A local `main` that has DIVERGED
 * from upstream surfaces the `--force` remediation rather than silently reporting
 * a stale HEAD as "updated" (a non-fast-forward is refused by design). Verified
 * end-to-end in tests/ (the two-clone fast-forward proof) + the live PR run.
 *
 * @param {"development"|"production"} mode  normalized instance runtime mode
 * @param {string|null} pinnedRef            an explicit --ref, or null
 * @returns {{ kind: "ref"|"tag", ref: string|null, source: string }}
 *   `ref: null` for the prod-release default means "resolve the latest release
 *   tag" (the caller fills it in); a concrete string is used verbatim.
 */
export function resolveInstanceMoveTarget(mode, pinnedRef) {
  if (pinnedRef) {
    return { kind: "ref", ref: pinnedRef, source: "--ref" };
  }
  if (mode === "production") {
    return { kind: "tag", ref: null, source: "latest v* release (prod)" };
  }
  // development (the default for any non-prod mode): fast-forward to latest
  // origin/main (the fetch+FETCH_HEAD resolution above guarantees "latest").
  return { kind: "ref", ref: "main", source: "fast-forward to latest origin/main (dev)" };
}

export const __test = {
  CLI_PACKAGE,
  CLI_INSTALL_SPEC,
  parseUpdateArgs,
  resolveUpdatePath,
  resolveInstanceMoveTarget,
};
