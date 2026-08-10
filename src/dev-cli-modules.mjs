// Dev-CLI module discovery (cinatra#151 Stage 5c).
//
// Extensions contribute modules to the dev CLI by DECLARING them in their
// manifest: `cinatra.devCliModules: { "<key>": "./relative/module.mjs" }`.
// The CLI discovers a key by scanning `extensions/<scope>/<name>/package.json`
// — it never names a concrete extension package or path. The tailscale
// provisioning handlers consume the "tailscale-api" / "tailscale-hostname"
// keys declared by the tailscale connector's manifest.
//
// Absence posture (UNCHANGED from the retired literal lazy imports): the
// extensions tree is a gitignored clone-back target, ABSENT on a fresh
// checkout until `cinatra instance setup dev` populates it. When no present extension
// declares the requested key, the loader throws an Error with
// `.code = "ERR_MODULE_NOT_FOUND"` — the exact failure class the inline
// `import()` of a missing path produced — so every caller's existing
// graceful-degradation guard keeps working.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// cinatra-cli#176 — there is NO package-relative default root, by construction.
//
// The CLI SHIPS as its own package (`@cinatra-ai/cinatra`; the published
// `files` list is bin + `src/*.mjs` + `src/authoring/*.mjs` + templates). It
// never carries an `extensions/` tree and nothing installs one beside it: that
// tree is a gitignored clone-back target inside the OPERATOR'S CHECKOUT,
// materialized by `cinatra instance setup dev`. So the only correct root is the
// one the CALLER resolves (`getRepoRoot()` in index.mjs) and threads in.
//
// The retired default was `path.resolve(__dirname, "..", "..", "..")`, carrying
// the comment "packages/cli/src -> repo root" — a pre-extraction relic. On a
// real install this module sits at
// `<install>/node_modules/@cinatra-ai/cinatra/src/`, so three-up is
// `<install>/node_modules`. That is worse than "the declarer is missing": any
// installed package that happens to sit at
// `node_modules/extensions/<scope>/<name>` and declares the key would be
// imported AS the trusted single source of truth for the predicted Tailscale
// hostname. Both halves are pinned against a SIMULATED installed layout in
// tests/dev-cli-modules.test.mjs, which needs no checkout to run.
//
// An unresolved root therefore FAILS LOUD, and deliberately NOT with the
// `ERR_MODULE_NOT_FOUND` + `cinatraDevCliDeclarerMissing` pair below: that pair
// means "the extensions tree is genuinely empty", which callers degrade
// gracefully on (`ensureDevPublicMcpUrl`). A missing root is an
// installation/wiring defect and must never be masked as an absent extension.
export const ERR_DEV_CLI_REPO_ROOT = "ERR_CINATRA_DEV_CLI_REPO_ROOT";

/**
 * Resolve the caller-supplied checkout root, or throw the distinct
 * root-unresolved error. Never falls back to a path derived from THIS module's
 * own location.
 *
 * @param {string} key the dev-CLI module key being discovered (for the message)
 * @param {unknown} repoRoot the caller-resolved checkout root
 * @returns {string} the absolute, resolved root
 */
function requireResolvedRepoRoot(key, repoRoot) {
  if (typeof repoRoot === "string" && repoRoot.trim().length > 0) {
    return path.resolve(repoRoot.trim());
  }
  const err = new Error(
    `Dev-CLI module discovery for key "${key}" requires the RESOLVED checkout ` +
      `root: the published cinatra CLI ships without an extensions/ tree, so ` +
      `there is no package-relative fallback to scan. Pass the root the caller ` +
      `resolved (getRepoRoot()) — i.e. run from inside a cinatra checkout, or ` +
      `set CINATRA_REPO_ROOT=<path-to-checkout>.`,
  );
  err.code = ERR_DEV_CLI_REPO_ROOT;
  // Distinct from `cinatraDevCliDeclarerMissing`: this is NOT a legitimately
  // absent declarer, so no graceful-degradation guard may swallow it.
  err.cinatraDevCliRepoRootUnresolved = true;
  throw err;
}

/**
 * Find the module file declared under `cinatra.devCliModules[key]` by any
 * extension present on disk. Returns an absolute path or null.
 *
 * `repoRoot` is REQUIRED (see the note above): an absent/blank root throws
 * `ERR_CINATRA_DEV_CLI_REPO_ROOT` rather than resolving a package-relative
 * path. A present-but-extension-empty root still returns null — the absence
 * posture is unchanged.
 *
 * Deterministic: scopes and package dirs are scanned in sorted order; the
 * first declarer wins (in practice each key has exactly one declarer — a
 * duplicate would indicate two extensions claiming the same CLI surface, and
 * the first sorted one is used).
 */
export function discoverDevCliModulePath(key, repoRoot) {
  const extRoot = path.join(requireResolvedRepoRoot(key, repoRoot), "extensions");
  let scopes;
  try {
    scopes = readdirSync(extRoot).sort();
  } catch {
    return null;
  }
  for (const scope of scopes) {
    let dirs;
    try {
      dirs = readdirSync(path.join(extRoot, scope)).sort();
    } catch {
      continue;
    }
    for (const dir of dirs) {
      let pkg;
      try {
        pkg = JSON.parse(
          readFileSync(path.join(extRoot, scope, dir, "package.json"), "utf8"),
        );
      } catch {
        continue; // not a package dir
      }
      const declared = pkg?.cinatra?.devCliModules;
      if (!declared || typeof declared !== "object") continue;
      const rel = declared[key];
      if (typeof rel !== "string" || rel.length === 0) continue;
      // Confine the declared path inside the declaring extension dir
      // (a manifest is repo-external data; never let it traverse out).
      const base = path.join(extRoot, scope, dir);
      const resolved = path.resolve(base, rel);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) continue;
      return resolved;
    }
  }
  return null;
}

/**
 * What the scan actually SAW under `<root>/extensions` — the two facts that
 * separate the three ways this discovery misses (cinatra#2637):
 *   - the tree is absent/empty      → setup has not populated it yet;
 *   - the tree is full but the key is undeclared → the declaring extension is
 *     missing from the synced set (or its manifest lost the declaration);
 *   - the tree is absent while the operator's checkout HAS one → the CLI is
 *     rooted somewhere else entirely (the class where a published CLI resolved
 *     its own `node_modules` as the root and every key looked "absent").
 *
 * Bounded + total (codex round 2): this runs on a FAILURE path, over a tree of
 * repo-external data, purely to write a diagnostic line — so it must not be the
 * thing that hangs or blows up the run. It never follows a symlinked entry,
 * never opens a non-regular file (a FIFO would block forever), refuses an
 * oversized manifest, and stops after a fixed number of packages. Any unreadable
 * path degrades to "not seen" and it never throws.
 *
 * @param {string} extRoot absolute `<root>/extensions`
 * @returns {{ treeExists: boolean, packages: number, keys: string[] }}
 */
const SCAN_MAX_PACKAGES = 1000;
const SCAN_MAX_MANIFEST_BYTES = 1024 * 1024;
const SCAN_MAX_KEY_CHARS = 64;

/** Directory entries that are real directories, sorted; never symlinks. */
function realSubdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

export function scanDevCliExtensionTree(extRoot) {
  const scopes = realSubdirectories(extRoot);
  if (scopes === null) return { treeExists: false, packages: 0, keys: [] };
  let packages = 0;
  const keys = new Set();
  outer: for (const scope of scopes) {
    const dirs = realSubdirectories(path.join(extRoot, scope));
    if (dirs === null) continue;
    for (const dir of dirs) {
      if (packages >= SCAN_MAX_PACKAGES) break outer;
      const manifest = path.join(extRoot, scope, dir, "package.json");
      let pkg;
      try {
        // Regular files only, and only ones small enough to be a manifest.
        const stat = statSync(manifest);
        if (!stat.isFile() || stat.size > SCAN_MAX_MANIFEST_BYTES) continue;
        pkg = JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        continue; // not a package dir
      }
      packages += 1;
      const declared = pkg?.cinatra?.devCliModules;
      if (declared && typeof declared === "object") {
        for (const k of Object.keys(declared)) keys.add(String(k).slice(0, SCAN_MAX_KEY_CHARS));
      }
    }
  }
  return { treeExists: true, packages, keys: [...keys].sort() };
}

/**
 * The operator-facing recovery text for an unresolvable dev-CLI key
 * (cinatra#2637). Pure + exported so the wording is pinned by tests: this
 * message is the ONLY thing an operator sees when the public MCP URL cannot be
 * established, and "no extension present under extensions/" on its own told
 * them nothing about WHICH tree was scanned or what to run next.
 *
 * @param {string} key the dev-CLI key that did not resolve
 * @param {string} extRoot the absolute extensions dir that was scanned
 * @param {{ treeExists: boolean, packages: number, keys: string[] }} scan
 * @returns {string}
 */
export function describeDevCliDeclarerMissing(key, extRoot, scan) {
  const MAX_KEYS = 8;
  const shown = scan.keys.slice(0, MAX_KEYS).join(", ");
  const more = scan.keys.length > MAX_KEYS ? ` (+${scan.keys.length - MAX_KEYS} more)` : "";
  const seen = !scan.treeExists
    ? `that directory does not exist yet`
    : `${scan.packages} extension package(s) scanned; declared dev-CLI keys: ${
        scan.keys.length > 0 ? `${shown}${more}` : "none"
      }`;
  return (
    `Cannot find module for dev-CLI key "${key}" — no extension present under extensions/ ` +
    `declares cinatra.devCliModules["${key}"].\n` +
    `  Scanned: ${extRoot} — ${seen}.\n` +
    `  Recover:\n` +
    `    1. Run \`cinatra instance setup dev\` in that checkout — it clones/refreshes the extensions ` +
    `tree that declares this key (a re-run repeats the step; it is not a one-shot gate).\n` +
    `    2. If that checkout ALREADY has extensions/, this CLI is rooted somewhere else: run it from ` +
    `the checkout root, or set CINATRA_REPO_ROOT=<path-to-checkout>.`
  );
}

/**
 * Dynamic-import the module declared under `cinatra.devCliModules[key]`.
 * Throws ERR_MODULE_NOT_FOUND (as `.code`) when no present extension
 * declares the key — same failure class as the retired literal import of a
 * missing extension path, preserving every caller's degradation guard.
 *
 * `repoRoot` is REQUIRED; see `requireResolvedRepoRoot` (cinatra-cli#176).
 */
export async function loadDevCliModule(key, repoRoot) {
  const resolvedRoot = requireResolvedRepoRoot(key, repoRoot);
  const modulePath = discoverDevCliModulePath(key, resolvedRoot);
  if (!modulePath) {
    // cinatra#2637 — say WHICH tree was scanned, what was in it, and the exact
    // commands that clear the state. The bare "no extension present under
    // extensions/" left a fresh self-hoster with no next step at all.
    const extRoot = path.join(resolvedRoot, "extensions");
    const err = new Error(
      describeDevCliDeclarerMissing(key, extRoot, scanDevCliExtensionTree(extRoot)),
    );
    err.code = "ERR_MODULE_NOT_FOUND";
    // cinatra#1919 — a DISTINCT marker for "no extension DECLARES this key",
    // separate from the identical ERR_MODULE_NOT_FOUND a dynamic import() throws
    // for a declared-but-broken module (missing file / missing transitive dep).
    // Graceful-degradation guards that want to tolerate ONLY a genuinely-absent
    // declarer (see ensureDevPublicMcpUrl) key on this flag so they never mask a
    // real installation/code defect.
    err.cinatraDevCliDeclarerMissing = true;
    throw err;
  }
  return import(pathToFileURL(modulePath).href);
}
