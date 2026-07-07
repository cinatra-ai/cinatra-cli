// Template materialization: recursively copy a templates/<kind>/ tree into a
// target directory, substituting {{token}} placeholders in file CONTENTS and in
// FILE/DIR NAMES. Zero dependencies — Node builtins only.
//
// A `.tmpl` extension on a template file is stripped on copy (lets template
// files that would otherwise be interpreted by tooling — e.g. package.json —
// live in the tree as-is; we do not actually use it but it is supported).
//
// DOTFILE RESTORATION (cinatra#402 publish trap): `npm` hard-excludes `.gitignore`
// and `.npmrc` from a published tarball — even when they sit inside a directory
// listed in `package.json#files`. Since this scaffolder now ships INSIDE the
// published `@cinatra-ai/cinatra` package, those two template files are stored
// in the tree under non-dotted sentinel names (`gitignore`, `npmrc`) so they
// survive packing, and are renamed back to their leading-dot form on scaffold.
// The generated extension's on-disk output preserves the expected dotfiles.
// No other dotfile (`.gitattributes`, `.github/**`)
// needs this — npm ships those — so the map is intentionally minimal.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Sentinel template name → restored dotfile name on scaffold. */
const RESTORE_DOTFILES = new Map([
  ["gitignore", ".gitignore"],
  ["npmrc", ".npmrc"],
]);

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Substitute {{token}} occurrences in a string from a flat vars map. */
export function substitute(text, vars) {
  return text.replace(TOKEN_RE, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
    return whole; // leave unknown tokens untouched (visible signal of a gap)
  });
}

/** Collect every {{token}} referenced in a string (for validation/tests). */
export function referencedTokens(text) {
  const out = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) out.add(m[1]);
  return out;
}

/**
 * Recursively render `srcDir` into `destDir`, substituting `vars` in both names
 * and contents. Returns the list of written file paths (relative to destDir).
 */
export function renderTree(srcDir, destDir, vars) {
  const written = [];
  mkdirSync(destDir, { recursive: true });
  const walk = (curSrc, curDest, relPrefix) => {
    const entries = readdirSync(curSrc, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(curSrc, entry.name);
      let name = substitute(entry.name, vars);
      const isDir = entry.isDirectory();
      if (!isDir && name.endsWith(".tmpl")) name = name.slice(0, -".tmpl".length);
      // Restore npm-hostile dotfiles from their packed sentinel name (see the
      // DOTFILE RESTORATION note above). Files only — never directories.
      if (!isDir && RESTORE_DOTFILES.has(name)) name = RESTORE_DOTFILES.get(name);
      const destPath = join(curDest, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (isDir) {
        mkdirSync(destPath, { recursive: true });
        walk(srcPath, destPath, rel);
      } else {
        const raw = readFileSync(srcPath, "utf8");
        writeFileSync(destPath, substitute(raw, vars));
        written.push(rel);
      }
    }
  };
  walk(srcDir, destDir, "");
  written.sort();
  return written;
}

/** True if `p` is an existing non-empty directory. */
export function isNonEmptyDir(p) {
  try {
    const st = statSync(p);
    if (!st.isDirectory()) return false;
    return readdirSync(p).length > 0;
  } catch {
    return false;
  }
}
