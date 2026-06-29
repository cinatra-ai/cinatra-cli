#!/usr/bin/env node
// SKILL.md frontmatter lint (cinatra-cli#45).
//
// Scans the SOURCE SKILL.md files in this repo and fails (exit 1) on any
// frontmatter that violates the standard skills validator — as implemented by
// the cinatra-owned SUPERSET validator in src/authoring/skill-frontmatter.mjs
// (every upstream rule PLUS the metadata.* project-key allowance). It also
// rejects SKILL.md files that still carry un-edited template placeholder copy.
//
// EXCLUSIONS (the lint must NOT scan generated mirrors or intentional fixtures):
//   - templates/**           — scaffold templates carry `{{tokens}}` (rendered,
//                              not authored) and intentionally retain placeholder
//                              guidance; they are linted via their RENDERED output
//                              by the template tests, not as raw source.
//   - node_modules/**, .git/**, .claude/** — never source (.claude holds the
//                              org-convention local tooling dir, incl. nested git
//                              worktrees that carry a FULL repo copy + templates).
//   - any path matching a `# skills-lint: ignore` exclusion list below.
//
// Zero runtime dependencies (Node builtins only) so CI runs it with no install.
//
// Usage:
//   node scripts/lint-skills.mjs [--root <dir>] [--json]
//   (default root = the repo root; exit 0 = clean, exit 1 = violations)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { lintSkillContent } from "../src/authoring/skill-frontmatter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

// Directory names never descended into (anywhere in the tree). These are
// infrastructure/tooling containers, never authored CLI source: dependency and
// VCS trees, plus `.claude` — the org-convention local tooling dir that holds
// nested git worktrees (`.claude/worktrees/<task>/…`). A worktree carries a FULL
// copy of the repo, including its `templates/` placeholder SKILL.md files; those
// live at `.claude/worktrees/<task>/templates/…`, which does NOT match the
// root-relative `templates/` EXCLUDED_PREFIX, so without pruning `.claude` the
// lint would scan another task's un-rendered templates as source and fail. The
// dir is untracked (absent on a clean checkout/CI), so this only hardens local
// runs; an authored source SKILL.md never lives under `.claude`.
const PRUNE_DIRS = new Set(["node_modules", ".git", ".claude"]);

// Path PREFIXES (relative, POSIX-style) whose SKILL.md files are excluded from
// the SOURCE lint. `templates/` holds un-rendered scaffold templates (linted via
// their rendered output in the test suite, not as raw source).
const EXCLUDED_PREFIXES = ["templates/"];

// Specific relative SKILL.md paths that are INTENTIONALLY invalid (negative-test
// fixtures). They are linted by the test suite (asserted to FAIL), never by this
// source lint. Keep this list tight + documented — every entry needs a reason.
const EXCLUDED_FILES = new Set([
  // good/bad lint fixtures live under tests/fixtures/skills-lint/ and are
  // exercised by tests/lint-skills.test.mjs; they must not fail the repo lint.
  // (matched by the tests/fixtures/ prefix rule below, listed here for clarity)
]);

// Any SKILL.md under one of these relative prefixes is a TEST FIXTURE, excluded
// from the source lint (the lint test drives them directly).
const FIXTURE_PREFIXES = ["tests/fixtures/"];

function toPosix(p) {
  return p.split(sep).join("/");
}

/** Recursively collect every SKILL.md path under `dir` (absolute paths). */
function findSkillMd(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      out.push(...findSkillMd(join(dir, entry.name)));
    } else if (entry.name === "SKILL.md") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Decide whether a relative SKILL.md path is in scope for the SOURCE lint. */
export function isSourceSkill(relPath) {
  const rel = toPosix(relPath);
  if (EXCLUDED_FILES.has(rel)) return false;
  if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) return false;
  if (FIXTURE_PREFIXES.some((p) => rel.startsWith(p))) return false;
  return true;
}

/**
 * Lint every source SKILL.md under `root`. Returns
 * { scanned, violations: [{ path, errors }] }.
 */
export function lintRepo(root = REPO_ROOT) {
  const all = findSkillMd(root);
  const violations = [];
  let scanned = 0;
  for (const abs of all) {
    const rel = relative(root, abs);
    if (!isSourceSkill(rel)) continue;
    scanned += 1;
    const content = readFileSync(abs, "utf8");
    const { ok, errors } = lintSkillContent(content);
    if (!ok) violations.push({ path: toPosix(rel), errors });
  }
  return { scanned, violations };
}

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root") opts.root = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      "Usage: node scripts/lint-skills.mjs [--root <dir>] [--json]\n" +
        "Lints all SOURCE SKILL.md frontmatter (excludes templates/ and tests/fixtures/).\n",
    );
    return 0;
  }
  const { scanned, violations } = lintRepo(opts.root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ scanned, violations }, null, 2)}\n`);
  }
  if (violations.length === 0) {
    if (!opts.json) {
      process.stdout.write(`skills-lint: OK — ${scanned} source SKILL.md file(s) valid.\n`);
    }
    return 0;
  }
  if (!opts.json) {
    process.stderr.write(
      `skills-lint: ${violations.length} of ${scanned} source SKILL.md file(s) FAILED:\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  ✗ ${v.path}\n`);
      for (const e of v.errors) process.stderr.write(`      - ${e}\n`);
    }
    process.stderr.write(
      "\nFix the frontmatter (the standard skills validator + cinatra metadata.* convention),\n" +
        "or move an intentionally-invalid file under tests/fixtures/ (and drive it from a test).\n",
    );
  }
  return 1;
}

// Run as a script (not when imported by tests). Compare canonical file URLs so
// the guard is portable across platforms and paths containing spaces (a raw
// `file://${process.argv[1]}` would mismatch a URL-encoded import.meta.url and
// silently skip main(), exiting 0 without linting).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
