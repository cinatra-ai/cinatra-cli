// packages/cli/src/checkout-resolve.mjs (published as `cinatra/src/checkout-resolve.mjs`)
//
// Runtime resolution of the internal `@cinatra-ai/*` workspace packages from the
// operator's CINATRA CHECKOUT — never from the published `cinatra` CLI's own
// dependency tree.
//
// WHY THIS EXISTS (cinatra#402, P1 extraction)
// --------------------------------------------
// The `cinatra` CLI is a THIN, dependency-light driver published to npm. It is
// deliberately decoupled from the heavy in-repo workspace packages it drives:
//
//   - `@cinatra-ai/migrations`           — the node-pg-migrate runner + SQL chain
//   - `@cinatra-ai/connectors-catalog`   — the CLI-safe connector descriptors
//   - `@cinatra-ai/skills`               — the agent-skill compile/register walker
//
// Bundling any of these into the published tarball would (a) re-couple the CLI
// to the monorepo's heavy server graph and (b) ship a STALE copy of code that
// must always match the checkout it operates on. So the CLI resolves them at
// COMMAND ENTRY from the checkout's own `node_modules`, against the checkout's
// installed versions.
//
// CODEX must-fix #2 — DO NOT file://-path-only resolve
// ----------------------------------------------------
// A naive `import(pathToFileURL(<repoRoot>/packages/<pkg>/...))` is wrong:
// in the BAKED production runtime image only `packages/migrations` physical
// source is guaranteed (Next.js output-file-tracing copies it explicitly; the
// other workspace packages may be absent there). So the primary path is a
// node-module resolution anchored at the checkout root (which honors the
// package's `exports`/subpaths and finds the real installed copy), with a
// guaranteed-source self-resolution fallback used ONLY for migrations.
//
// SECURITY / CORRECTNESS (per codex review of this shim)
// ------------------------------------------------------
//   - Only `@cinatra-ai/*` specifiers are accepted (no builtins, no escape).
//   - Resolution is anchored at an ABSOLUTE `<repoRoot>/package.json`.
//   - The resolved file is realpath-contained within the checkout (realpath +
//     `path.relative`, NOT brittle `startsWith`; pnpm symlinks realpath to
//     `<repoRoot>/packages/*` and `<repoRoot>/node_modules/.pnpm/*`, both inside
//     the checkout).
//   - The OWNING package's `package.json#name` is verified to equal the
//     expected `@cinatra-ai/*` package (defense against a spoofed resolution).
//   - The expected package name is REQUIRED (derived from the specifier).

import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CINATRA_SCOPE = "@cinatra-ai/";

/**
 * `@cinatra-ai/migrations` → `@cinatra-ai/migrations`
 * `@cinatra-ai/skills/cli` → `@cinatra-ai/skills`
 * `@cinatra-ai/connectors-catalog/descriptors.mjs` → `@cinatra-ai/connectors-catalog`
 */
function packageNameFromSpecifier(specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith(CINATRA_SCOPE)) {
    throw new Error(
      `checkout-resolve: refusing to resolve non-@cinatra-ai specifier "${specifier}".`,
    );
  }
  const parts = specifier.split("/");
  // ["@cinatra-ai", "<pkg>", ...subpath]
  return `${parts[0]}/${parts[1]}`;
}

/**
 * The cinatra checkout sentinel — the pnpm workspace manifest AND the
 * never-removed internal `@cinatra-ai/migrations` package manifest (by exact
 * name). Mirrors `isCinatraRepoRoot` / `isCinatraCheckout` in index.mjs /
 * install.mjs; deliberately does NOT gate on `packages/cli` (that package goes
 * external at P1/P2) nor on the bin-colliding root name `cinatra`.
 */
function assertCinatraCheckout(repoRoot) {
  const ws = path.join(repoRoot, "pnpm-workspace.yaml");
  const migPkg = path.join(repoRoot, "packages", "migrations", "package.json");
  if (!existsSync(ws)) {
    throw new Error(
      `checkout-resolve: "${repoRoot}" is not a cinatra checkout (missing pnpm-workspace.yaml).`,
    );
  }
  let migName;
  try {
    migName = JSON.parse(readFileSync(migPkg, "utf8"))?.name;
  } catch {
    migName = undefined;
  }
  if (migName !== "@cinatra-ai/migrations") {
    throw new Error(
      `checkout-resolve: "${repoRoot}" is not a cinatra checkout ` +
        `(packages/migrations/package.json missing or not @cinatra-ai/migrations).`,
    );
  }
}

/** Best-effort native realpath; falls back to the resolved absolute path. */
function realpath(p) {
  try {
    return realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** True iff `child` is `root` or a descendant of `root` (realpath-aware). */
function isContained(root, child) {
  const rel = path.relative(realpath(root), realpath(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Walk up from `fromFile` to find the owning `package.json` and assert its
 * `name` equals `expectName`. Bounded at the checkout root.
 */
function assertOwningPackageName(fromFile, expectName, repoRoot) {
  const rootReal = realpath(repoRoot);
  let dir = path.dirname(path.resolve(fromFile));
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      let name;
      try {
        name = JSON.parse(readFileSync(pkgPath, "utf8"))?.name;
      } catch {
        name = undefined;
      }
      if (name === expectName) return;
      // A nested package.json without the expected name — keep walking up only
      // while still inside the checkout; a node_modules entry's own
      // package.json is the authoritative owner, so a mismatch here is fatal.
      throw new Error(
        `checkout-resolve: resolved "${expectName}" to a file owned by ` +
          `package "${name ?? "<unknown>"}" (${pkgPath}); refusing to import.`,
      );
    }
    const parent = path.dirname(dir);
    // Stop at the checkout root or the filesystem root.
    if (parent === dir || realpath(dir) === rootReal) {
      throw new Error(
        `checkout-resolve: could not find the owning package.json for "${expectName}".`,
      );
    }
    dir = parent;
  }
}

/**
 * Resolve a checkout-local `@cinatra-ai/*` specifier to an absolute file path,
 * validating containment + owning-package name. Returns the absolute path.
 *
 * Primary: `createRequire(<repoRoot>/package.json).resolve(specifier)` — honors
 * the package's `exports` subpaths (e.g. `@cinatra-ai/skills/cli`) and finds the
 * real installed copy in the checkout's node_modules.
 *
 * Fallback (migrations ONLY, the guaranteed-source package): self-resolve from
 * inside `<repoRoot>/packages/migrations` so a baked prod image whose top-level
 * node_modules lacks the workspace symlink still resolves.
 */
function resolveCheckoutFile(repoRoot, specifier) {
  const expectName = packageNameFromSpecifier(specifier);
  const rootAbs = path.resolve(repoRoot);

  // A resolved path is USABLE only if it is absolute, realpath-contained within
  // the checkout, and owned by the expected `@cinatra-ai/*` package. Returns
  // null (NOT throw) for an unusable candidate so the migrations fallback can
  // still run when the PRIMARY resolution points OUTSIDE the checkout (e.g. the
  // published CLI is installed inside an ambient parent's node_modules and
  // require.resolve found that copy) — codex must-fix: an outside/mismatched
  // primary must not pre-empt the guaranteed-source fallback.
  const validate = (resolved) => {
    if (!resolved || !path.isAbsolute(resolved)) return null;
    if (!isContained(rootAbs, resolved)) return null;
    try {
      assertOwningPackageName(resolved, expectName, rootAbs);
    } catch {
      return null;
    }
    return resolved;
  };

  const tryResolveFrom = (anchorPkgJson) => {
    try {
      return createRequire(anchorPkgJson).resolve(specifier);
    } catch {
      return null;
    }
  };

  // Primary: resolve from the checkout root (honors `exports` subpaths and finds
  // the installed copy in the checkout's node_modules).
  let usable = validate(tryResolveFrom(path.join(rootAbs, "package.json")));

  // Fallback for migrations ONLY (the package guaranteed present in the baked
  // prod image): self-resolve from inside `<repoRoot>/packages/migrations` so a
  // missing top-level workspace symlink — OR an ambient-parent primary that
  // failed containment above — still resolves to the in-checkout source.
  if (!usable && expectName === "@cinatra-ai/migrations") {
    const pkgJson = path.join(rootAbs, "packages", "migrations", "package.json");
    if (existsSync(pkgJson)) {
      usable = validate(tryResolveFrom(pkgJson));
    }
  }

  if (!usable) {
    throw new Error(
      `checkout-resolve: cannot resolve "${specifier}" to an in-checkout copy of ` +
        `${expectName} from the cinatra checkout at ${rootAbs} (not installed, or it ` +
        `resolved OUTSIDE the checkout). Run the install step (pnpm install) inside ` +
        `the checkout so its workspace packages are present.`,
    );
  }
  return usable;
}

/**
 * Resolve AND dynamically import a checkout-local `@cinatra-ai/*` module.
 *
 * @param {string} repoRoot  Absolute path to the cinatra checkout root.
 * @param {string} specifier e.g. "@cinatra-ai/migrations",
 *                           "@cinatra-ai/skills/cli",
 *                           "@cinatra-ai/connectors-catalog/descriptors.mjs".
 * @returns {Promise<object>} The imported module namespace.
 */
export async function importFromCheckout(repoRoot, specifier) {
  assertCinatraCheckout(repoRoot);
  const resolved = resolveCheckoutFile(repoRoot, specifier);
  return import(pathToFileURL(resolved).href);
}

// Exposed for unit tests.
export const __test = {
  packageNameFromSpecifier,
  isContained,
  resolveCheckoutFile,
  assertCinatraCheckout,
};
