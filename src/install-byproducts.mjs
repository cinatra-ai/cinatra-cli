// ---------------------------------------------------------------------------
// The install's OWN working-tree byproducts (cinatra-ai/cinatra-cli#198).
//
// `cinatra install` is contractually re-runnable — "bootstrap FROM ZERO and
// re-runnable RECONCILE in one entrypoint". The git-move primitive guards that
// re-run with a clean-tree refusal, which exists to protect OPERATOR work.
//
// The problem it solves and the problem it created are the same fact: a
// COMPLETED install leaves the checkout dirty with files the installer itself
// wrote. The shared setup phase re-links the cloned dev extensions into the pnpm
// workspace (mutating `pnpm-lock.yaml`) and regenerates the TRACKED extension
// barrel for the acquired set. So the guard fired on 100% of post-completion
// re-runs and steered every operator to `--force`, whose stash-first behaviour
// would one day stash the real operator work the guard was built to protect.
//
//     A guard that always trips stops guarding.
//
// This module is the boundary: it names — as DATA, in one place — the paths the
// install's own phases deterministically regenerate from committed inputs, and
// classifies a `git status` into "the installer's" vs "the operator's". The
// refusal is unchanged for the second class.
//
// THE TRADE-OFF, STATED (issue AC2/AC3): a PATH rule cannot distinguish an
// operator's manual edit to one of these same files from the installer's
// byproduct. That residual is acceptable only because setup regenerates them
// deterministically from committed inputs on every run — a manual edit there is
// overwritten by the next reconcile regardless — and it is never silent: the
// exempted paths are printed whenever the exemption is used, and the refusal
// message names the boundary. The set is DECLARED, never learned from a previous
// run: a self-recording manifest would silently broaden what the guard stops
// protecting, which is exactly what AC3 forbids.
//
// EVERYTHING ELSE FAILS CLOSED. Being wrong here does not merely inconvenience
// an operator — it skips a refusal and then hands the path to
// `git checkout HEAD --`. So the classifier requires a positive match on the
// path AND on the status shape, never normalises a path git already gave us
// verbatim, and treats any rename/copy as operator work. One residual is
// unavoidable and worth naming: porcelain v1 collapses a dirty SUBMODULE to a
// plain `M`, so a submodule mounted at an exempt path would look like an
// in-place edit. No cinatra checkout has one there (`pnpm-lock.yaml` is a file
// and `src/lib/generated/` holds generated sources), and the restore below is
// not `--recurse-submodules`, so nested work would be left alone rather than
// destroyed.
// ---------------------------------------------------------------------------

/**
 * The install-owned paths, each with the phase that writes it. `kind`:
 *   - "exact"  — this repo-relative path exactly.
 *   - "prefix" — this directory prefix and everything beneath it.
 *
 * Repo-relative, POSIX separators (git reports paths that way on every platform).
 */
export const INSTALL_BYPRODUCT_RULES = Object.freeze([
  Object.freeze({
    kind: "exact",
    path: "pnpm-lock.yaml",
    why: "workspace re-link — the cloned dev extensions join the pnpm workspace, so the workspace install rewrites the lockfile",
  }),
  Object.freeze({
    kind: "prefix",
    path: "src/lib/generated/",
    why: "tracked generated barrels — rewritten by the extension-manifest regeneration for the acquired set",
  }),
]);

/**
 * True iff `p` is a path the install's own phases regenerate.
 *
 * Compared RAW, with no normalisation. `git status -z` emits unquoted,
 * repo-relative pathnames with `/` separators on every platform, so there is
 * nothing to normalise — and normalising would be actively unsafe: a backslash
 * is a legal character in a POSIX filename, so folding `\` to `/` would make a
 * real tracked file literally named `src\lib\generated\notes.ts` match the
 * `src/lib/generated/` rule. That file is operator work, and matching it would
 * both skip its refusal and hand it to `git checkout HEAD --`.
 */
export function isInstallByproductPath(p, rules = INSTALL_BYPRODUCT_RULES) {
  if (typeof p !== "string" || p.length === 0) return false;
  return rules.some((rule) => (rule.kind === "prefix" ? p.startsWith(rule.path) : p === rule.path));
}

/**
 * The `git status` XY codes the install's own phases actually produce: an
 * in-place rewrite of a file that already exists at HEAD (unstaged, staged, or
 * both), plus a generated file that is not tracked yet.
 *
 * An ALLOWLIST, not a denylist — the exemption skips a refusal and (for the
 * tracked shapes) hands the path to `git checkout HEAD --`, so anything whose
 * shape we do not positively recognise must fall through to the operator class
 * and refuse. That is what keeps an unmerged conflict (`UU`/`AA`/`DD`), a
 * staged addition with nothing in HEAD to restore (`A `), or a deletion out of
 * the exempt set: none of those is something setup produces, and each would
 * either destroy state or fail the restore.
 */
export const INSTALL_BYPRODUCT_STATUS_CODES = Object.freeze([
  " M", // modified in the work tree
  "M ", // modification staged
  "MM", // staged, then modified again
  "??", // untracked (exempt from the refusal; never restored — see `resettable`)
]);

/**
 * Parse `git status --porcelain -z` output.
 *
 * `-z` (rather than the quoted default) so a path with a space, a quote, or a
 * non-ASCII byte is never mis-split — the guard decides whether to REFUSE from
 * these paths, so a parse that silently drops an entry would drop a refusal.
 *
 * Returns `[{ code, path, from, untracked }]`; for a rename/copy the ORIGINAL
 * path is carried in `from` (git emits it as the next NUL-separated field).
 * `R`/`C` is honoured in EITHER status column — git reports a work-tree-side
 * rename/copy in the second one, and consuming only the first would leave that
 * record's source path standing as a bogus record of its own.
 */
export function parseGitPorcelainZ(out) {
  const fields = String(out ?? "").split("\0").filter((f) => f.length > 0);
  const entries = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    // "XY <path>" — two status columns, a space, then at least one path char.
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const p = field.slice(3);
    let from = null;
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      from = fields[i + 1] ?? null;
      i += 1;
    }
    entries.push({ code, path: p, from, untracked: code === "??" });
  }
  return entries;
}

/**
 * Split a working tree's dirt into the install's own byproducts and everything
 * else.
 *
 * FAIL-CLOSED on three axes, because being wrong here skips a refusal:
 *   - the PATH must be install-owned;
 *   - the STATUS SHAPE must be one setup actually produces
 *     (`INSTALL_BYPRODUCT_STATUS_CODES`) — an unmerged conflict, a staged
 *     addition, or a deletion under an exempt path is NOT the installer's and
 *     could not be restored from HEAD anyway;
 *   - a RENAME/COPY is never the installer's. Setup rewrites files in place; a
 *     record carrying a second path means someone MOVED something, which is
 *     operator work whichever end of it is install-owned.
 *
 * `resettable` is the subset the updater may safely restore from HEAD before the
 * move: byproducts that are TRACKED (an untracked file has nothing in HEAD to
 * restore, and git preserves untracked files across a fast-forward anyway).
 */
export function classifyWorkingTreeDirt(porcelainZ, rules = INSTALL_BYPRODUCT_RULES) {
  const entries = parseGitPorcelainZ(porcelainZ);
  const byproducts = [];
  const operator = [];
  for (const entry of entries) {
    const own =
      entry.from === null &&
      INSTALL_BYPRODUCT_STATUS_CODES.includes(entry.code) &&
      isInstallByproductPath(entry.path, rules);
    (own ? byproducts : operator).push(entry);
  }
  return {
    entries,
    byproducts,
    operator,
    clean: entries.length === 0,
    resettable: byproducts.filter((e) => !e.untracked).map((e) => e.path),
  };
}

/** The declared boundary, as operator-readable lines (AC3 — the guard states
 *  what it does and does not protect, rather than exempting silently). */
export function byproductBoundaryLines(rules = INSTALL_BYPRODUCT_RULES) {
  return rules.map((rule) => `      ${rule.path}${rule.kind === "prefix" ? "**" : ""} — ${rule.why}`);
}

/** The lines the updater prints when it exempts (and restores) its own dirt. */
export function byproductExemptionLines(byproducts, rules = INSTALL_BYPRODUCT_RULES) {
  if (!Array.isArray(byproducts) || byproducts.length === 0) return [];
  return [
    `  The working tree carries only this install's OWN byproducts — exempt from the clean-tree refusal`,
    `  and restored from HEAD before the move (setup regenerates them):`,
    ...byproducts.map((e) => `      ${e.path}`),
    `  Every other uncommitted change still refuses. The exempt set is exactly:`,
    ...byproductBoundaryLines(rules),
  ];
}

/**
 * The note a COMPLETED install prints when it leaves dirt OUTSIDE the declared
 * set — the drift signal that keeps the declaration honest. Without it, a future
 * setup phase that starts writing another tracked file would silently
 * re-introduce the "every reconcile needs --force" defect, and nothing would say
 * so until an operator hit it.
 */
export function installByproductDriftLines(dirt, rules = INSTALL_BYPRODUCT_RULES) {
  if (!dirt || !Array.isArray(dirt.operator) || dirt.operator.length === 0) return [];
  return [
    "",
    "  Note: this checkout has uncommitted changes OUTSIDE the install's own byproduct set:",
    ...dirt.operator.slice(0, 10).map((e) => `      ${e.code.trim() || "??"} ${e.path}`),
    ...(dirt.operator.length > 10 ? [`      … and ${dirt.operator.length - 10} more`] : []),
    "  A re-run will REFUSE them (that is the guard working). Commit/stash them, or re-run with --force.",
    "  The install's own byproducts — exempt, and not part of that refusal — are:",
    ...byproductBoundaryLines(rules),
  ];
}
