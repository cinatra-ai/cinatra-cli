// ---------------------------------------------------------------------------
// Which build is answering (cinatra-cli#271).
//
// `package.json` carries the same `version` at the published build and at every
// commit of main, so `cinatra --version` on its own could not tell a caller
// which build it had: a machine that pinned the CLI to an exact commit had to
// ask its package manager for the ref it resolved instead. This module finds
// the commit an installed package can actually PROVE, so the version line can
// name it beside the version.
//
// What a build can prove was MEASURED on npm 11, not assumed:
//
//   - `npm install <git-ref>` into a project, and the `npx` cache, both record
//     `packages["node_modules/@cinatra-ai/cinatra"].resolved` ending in
//     `#<40-hex>` — in `node_modules/.package-lock.json` and in the caller's
//     own `package-lock.json`.
//   - a GLOBAL install of the very same git ref records nothing at all: no
//     lockfile, no `_resolved`, no `gitHead`. npm extracts a tarball, so the
//     installed tree holds no repository either. Such a build stays silent.
//   - `gitHead` is added to the REGISTRY manifest at publish time, never to the
//     packed tarball, so an installed published build carries none. It is still
//     read first: it is npm's own field for this, and a manifest that does
//     carry one is stating its build outright.
//
// So the order is: the manifest's own claim, then the package manager's
// resolved ref, then a package directory that IS a checkout (a clone, a linked
// install, the repository itself).
//
// Offline and import-light by construction: node builtins, file reads only —
// never a subprocess, never a network call. Every read is best effort; a
// missing, unreadable or unexpected file means "this build cannot prove a
// commit", never an error.
// ---------------------------------------------------------------------------

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** How much of a commit id the human-facing version line shows. */
export const SHORT_COMMIT_LENGTH = 12;

const FULL_COMMIT = /^[0-9a-f]{40}$/;

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file) {
  const body = readText(file);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** A value is a commit only if it is a full commit id; anything else is noise. */
function normalizeCommit(value) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FULL_COMMIT.test(candidate) ? candidate : null;
}

/**
 * The commit half of a package manager's resolved ref. A git ref resolves to
 * `<url>#<40-hex>`; a registry tarball resolves to a plain URL and a range to
 * `#semver:…`, and neither names a build.
 */
function commitFromResolvedRef(resolved) {
  if (typeof resolved !== "string") return null;
  const hash = resolved.lastIndexOf("#");
  return hash < 0 ? null : normalizeCommit(resolved.slice(hash + 1));
}

/**
 * The commit npm recorded for THIS package in the lockfile beside it. The
 * innermost enclosing `node_modules` is tried first, then each one above it,
 * because a lockfile keys every entry by its path from the caller's root
 * (`node_modules/a/node_modules/@scope/name`).
 */
function lockfileCommit(packageDir) {
  const segments = path.resolve(packageDir).split(path.sep);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] !== "node_modules") continue;
    const modulesDir = segments.slice(0, i + 1).join(path.sep);
    const key = segments.slice(i).join("/");
    for (const lock of [
      path.join(modulesDir, ".package-lock.json"),
      path.join(path.dirname(modulesDir), "package-lock.json"),
    ]) {
      const commit = commitFromResolvedRef(readJson(lock)?.packages?.[key]?.resolved);
      if (commit) return commit;
    }
  }
  return null;
}

/**
 * The git directory of `packageDir` ITSELF — never one of an enclosing
 * directory. A package installed inside somebody else's repository must not
 * report that repository's HEAD as its own build.
 */
function gitDirectoryOf(packageDir) {
  const entry = path.join(packageDir, ".git");
  let stat;
  try {
    stat = statSync(entry);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return entry;
  // A linked working tree (and a submodule) carries a `.git` FILE pointing at
  // the real directory.
  const pointer = /^gitdir:\s*(.+)$/m.exec(readText(entry) ?? "");
  return pointer ? path.resolve(packageDir, pointer[1].trim()) : null;
}

/** Resolve one ref under `base`, loose file first, then `packed-refs`. */
function refCommit(base, ref) {
  const loose = normalizeCommit(readText(path.join(base, ...ref.split("/")))?.trim());
  if (loose) return loose;
  const packed = readText(path.join(base, "packed-refs"));
  if (!packed) return null;
  for (const line of packed.split("\n")) {
    const match = /^([0-9a-f]{40})\s+(.+)$/.exec(line.trim());
    if (match && match[2].trim() === ref) return normalizeCommit(match[1]);
  }
  return null;
}

/** The commit a package directory that is itself a checkout is parked at. */
function checkoutCommit(packageDir) {
  const gitDir = gitDirectoryOf(packageDir);
  if (!gitDir) return null;
  const head = readText(path.join(gitDir, "HEAD"));
  if (!head) return null;
  const detached = normalizeCommit(head.trim());
  if (detached) return detached;
  const ref = /^ref:\s*(.+)$/m.exec(head)?.[1]?.trim();
  if (!ref) return null;
  // A linked working tree keeps its own HEAD beside itself but SHARES every
  // ref with the repository it was created from, named by `commondir`.
  const common = readText(path.join(gitDir, "commondir"))?.trim();
  const bases = common ? [gitDir, path.resolve(gitDir, common)] : [gitDir];
  for (const base of bases) {
    const commit = refCommit(base, ref);
    if (commit) return commit;
  }
  return null;
}

/**
 * What build `packageDir` is, as far as it can prove it.
 *
 * @param {string} packageDir the installed package's own directory
 * @param {Record<string, unknown>} [manifest] that package's parsed package.json
 * @returns {{ commit: string|null, source: "package-manifest"|"package-lock"|"git-checkout"|null }}
 */
export function readBuildProvenance(packageDir, manifest = {}) {
  const claimed = normalizeCommit(manifest?.gitHead);
  if (claimed) return { commit: claimed, source: "package-manifest" };

  const resolved = lockfileCommit(packageDir);
  if (resolved) return { commit: resolved, source: "package-lock" };

  const checkout = checkoutCommit(packageDir);
  if (checkout) return { commit: checkout, source: "git-checkout" };

  return { commit: null, source: null };
}

/** The short form of a commit id, as the version line shows it. */
export function shortCommit(commit) {
  return typeof commit === "string" ? commit.slice(0, SHORT_COMMIT_LENGTH) : "";
}

/**
 * The human-facing version line: `cinatra 0.1.8`, or
 * `cinatra 0.1.8 (commit e82ddd36e178)` when the build proved a commit.
 *
 * @param {{ program: string, version: string, commit?: string|null }} build
 * @returns {string}
 */
export function formatVersionLine({ program, version, commit }) {
  const line = `${program} ${version}`;
  return commit ? `${line} (commit ${shortCommit(commit)})` : line;
}
