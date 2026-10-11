// ---------------------------------------------------------------------------
// cinatra-cli#295 — build a preview with ONE extension pinned at a given commit.
//
// `--pin-extension <owner>/<repo>@<40-hex sha>` moves the one entry of the app
// commit's extension locks whose `repo` names that repository to that commit,
// inside the preview's build context and nowhere else. The image acquires its
// extensions from those two locks (`cinatra-required-extensions.lock.json` via
// the app's acquire step, `cinatra-dev-extensions.lock.json` for the dev fleet
// only) and regenerates its extension maps itself, so the lock entry is the
// whole change.
//
// An entry of the REQUIRED lock is verified by the image's acquire step against
// its `packageVersion` and `treeSha256`, so a pinned required entry carries both
// for the pinned commit. The tree hash is the app's own definition
// (`foldTreeHash` in the app's packages/cli/src/prod-extension-acquisition.mjs),
// kept byte-parallel here because this CLI can import nothing from the app.
//
// Node builtins only, like preview.mjs: the `tar` reader is imported lazily by
// the default describer, which the unit suite replaces through `deps`.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const PIN_EXTENSION_FLAG = "--pin-extension";
export const PIN_EXTENSION_LABEL = "cinatra.preview.pin";
export const REQUIRED_EXTENSIONS_LOCK = "cinatra-required-extensions.lock.json";
export const DEV_EXTENSIONS_LOCK = "cinatra-dev-extensions.lock.json";
export const EXTENSION_LOCKS = [REQUIRED_EXTENSIONS_LOCK, DEV_EXTENSIONS_LOCK];

// GitHub's own shapes: an owner of at most 39 characters, a repository name of
// letters, digits, `.`, `_` and `-`.
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
// The acquire step's own version rule: a concrete x.y.z.
const CONCRETE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * Parse one `--pin-extension` value. The repository is lower-cased (GitHub
 * names are case-insensitive, and the pin is part of the image's identity, so
 * two spellings must not be two images); the commit must already be the 40
 * lowercase hex characters the locks hold.
 */
export function parsePinExtension(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  const at = value.lastIndexOf("@");
  const repo = at > 0 ? value.slice(0, at) : "";
  const sha = at > 0 ? value.slice(at + 1) : "";
  if (!REPO_RE.test(repo)) {
    throw new Error(
      `${PIN_EXTENSION_FLAG} ${JSON.stringify(raw ?? "")} is invalid: expected <owner>/<repo>@<40-hex sha> ` +
        `(for example cinatra-ai/pdf-artifact@<commit>).`,
    );
  }
  if (!COMMIT_RE.test(sha)) {
    throw new Error(
      `${PIN_EXTENSION_FLAG} ${JSON.stringify(raw ?? "")} is invalid: the commit must be a full 40-hex lowercase ` +
        `SHA (got ${JSON.stringify(sha)}). A branch, a tag or a short SHA is never pinned.`,
    );
  }
  const lower = repo.toLowerCase();
  return { repo: lower, sha, id: `${lower}@${sha}` };
}

/** True iff `id` is the canonical form `parsePinExtension` returns. */
export function isValidPinId(id) {
  if (typeof id !== "string") return false;
  try {
    return parsePinExtension(id).id === id;
  } catch {
    return false;
  }
}

/**
 * The pin this invocation asks for, or null when the flag is absent. A bare or
 * repeated flag is a typo and is refused, never guessed at.
 */
export function resolvePinExtension(rest = []) {
  const tokens = Array.isArray(rest) ? rest.map((t) => String(t)) : [];
  const idx = [];
  tokens.forEach((t, i) => {
    if (t === PIN_EXTENSION_FLAG || t.startsWith(`${PIN_EXTENSION_FLAG}=`)) idx.push(i);
  });
  if (idx.length === 0) return null;
  if (idx.length > 1) {
    throw new Error(`${PIN_EXTENSION_FLAG} was given ${idx.length} times — a preview pins exactly one extension.`);
  }
  const t = tokens[idx[0]];
  const raw = t === PIN_EXTENSION_FLAG ? tokens[idx[0] + 1] : t.slice(PIN_EXTENSION_FLAG.length + 1);
  return parsePinExtension(raw);
}

/**
 * The image-tag suffix that names a pin: the pinned commit's first 12 hex and 8
 * hex of the repository's digest (a repository name can be 100 characters, a
 * docker tag only 128). The full pin is on the image's label and on the row.
 */
export function pinExtensionTagSuffix(id) {
  const { repo, sha } = parsePinExtension(id);
  return `-pin-${sha.slice(0, 12)}-${sha256(repo).slice(0, 8)}`;
}

function lockRows(text, lockFile, repo) {
  if (text == null) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${PIN_EXTENSION_FLAG}: ${lockFile} at the app commit is not valid JSON — nothing was pinned.`);
  }
  if (!parsed || !Array.isArray(parsed.packages)) {
    throw new Error(`${PIN_EXTENSION_FLAG}: ${lockFile} at the app commit has no "packages" list — nothing was pinned.`);
  }
  return parsed.packages.filter((row) => row && typeof row === "object" && String(row.repo ?? "").toLowerCase() === repo);
}

/**
 * Decide WHICH lock entry the pin moves, from the two locks' texts at the app
 * commit (`null` = the file is absent there). Refuses, by name and before any
 * build: a repository in no lock, listed more than once in one lock, listed in
 * both locks, or listed only in the dev lock while the image builds the
 * required fleet (the dev lock is acquired into the image with the dev fleet
 * only, so the pin would change nothing).
 */
export function planExtensionPin({ pin, locks, fleet }) {
  const found = [];
  for (const lockFile of EXTENSION_LOCKS) {
    const rows = lockRows(locks?.[lockFile] ?? null, lockFile, pin.repo);
    if (rows.length > 1) {
      throw new Error(
        `${PIN_EXTENSION_FLAG}: the repository ${pin.repo} is listed ${rows.length} times in ${lockFile} ` +
          `at the app commit — the pin moves exactly one entry, so it is refused.`,
      );
    }
    if (rows.length === 1) found.push({ lockFile, entry: rows[0] });
  }
  if (found.length === 0) {
    throw new Error(
      `${PIN_EXTENSION_FLAG}: the repository ${pin.repo} is listed in no extension lock at the app commit ` +
        `(${EXTENSION_LOCKS.join(", ")}) — there is no entry to pin.`,
    );
  }
  if (found.length > 1) {
    throw new Error(
      `${PIN_EXTENSION_FLAG}: the repository ${pin.repo} is listed in both ${REQUIRED_EXTENSIONS_LOCK} and ` +
        `${DEV_EXTENSIONS_LOCK} at the app commit — the pin moves exactly one entry, so it is refused.`,
    );
  }
  const [plan] = found;
  if (plan.lockFile === DEV_EXTENSIONS_LOCK && fleet !== "dev") {
    throw new Error(
      `${PIN_EXTENSION_FLAG}: ${pin.repo} is pinned in ${DEV_EXTENSIONS_LOCK}, which the image acquires with the ` +
        `dev fleet only, and this preview builds the ${fleet} fleet — add --fleet dev, or the pin would change nothing.`,
    );
  }
  return plan;
}

/**
 * The canonical tree-hash fold, byte-parallel to the app's `foldTreeHash`
 * (packages/cli/src/prod-extension-acquisition.mjs): REGULAR files only, sorted
 * by relPath, `<relPath>\n<100755|100644>\n<content sha256>\n` per file.
 */
export function foldTreeHash(records) {
  const sorted = [...records].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const hash = createHash("sha256");
  for (const r of sorted) hash.update(`${r.relPath}\n${r.executable ? "100755" : "100644"}\n${r.sha256}\n`);
  return hash.digest("hex");
}

/**
 * Describe a codeload tarball (gzip) the way the image's acquire step reads it:
 * the single archive root stripped, every regular file hashed, any other entry
 * type refused. Returns the tree hash and the root package.json's name and
 * version.
 */
export async function describeExtensionTarball(gzBuffer, { tar }) {
  const tarBuffer = gunzipSync(gzBuffer, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  const records = [];
  const violations = [];
  let packageJsonRaw = null;
  const parser = tar.t({
    onReadEntry: (entry) => {
      const segments = String(entry.path).replace(/^\.\//, "").split("/").filter((s) => s.length > 0);
      if (String(entry.path).startsWith("/") || segments.includes("..") || segments.length === 0) {
        violations.push(`${entry.path}: unsafe path`);
        return;
      }
      const stripped = segments.slice(1).join("/");
      if (entry.type === "Directory") return;
      if (entry.type !== "File" || stripped === "") {
        violations.push(`${entry.path}: entry type ${entry.type} is never part of a verified acquisition`);
        return;
      }
      const hash = createHash("sha256");
      const chunks = stripped === "package.json" ? [] : null;
      entry.on("data", (c) => {
        hash.update(c);
        if (chunks) chunks.push(Buffer.from(c));
      });
      entry.on("end", () => {
        records.push({ relPath: stripped, executable: ((entry.mode ?? 0) & 0o100) !== 0, sha256: hash.digest("hex") });
        if (chunks) packageJsonRaw = Buffer.concat(chunks).toString("utf8");
      });
    },
  });
  await new Promise((resolve, reject) => {
    parser.on("error", (err) => reject(new Error(`${PIN_EXTENSION_FLAG}: the tarball could not be read: ${err.message}`)));
    parser.on("end", resolve);
    parser.end(tarBuffer);
  });
  if (violations.length > 0) {
    throw new Error(`${PIN_EXTENSION_FLAG}: unsafe archive:\n  - ${violations.join("\n  - ")}`);
  }
  let manifest = null;
  try {
    manifest = JSON.parse(packageJsonRaw ?? "null");
  } catch {
    manifest = null;
  }
  return {
    treeSha256: foldTreeHash(records),
    packageName: manifest?.name ?? null,
    packageVersion: manifest?.version ?? null,
  };
}

/**
 * The real describer: the same codeload URL the image's acquire step downloads
 * (`https://codeload.github.com/<repo>/tar.gz/<sha>`), described in memory.
 */
export async function defaultDescribePinnedCommit({ repo, sha, fetchImpl = globalThis.fetch }) {
  const url = `https://codeload.github.com/${repo}/tar.gz/${sha}`;
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${PIN_EXTENSION_FLAG}: fetching ${url} failed: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${PIN_EXTENSION_FLAG}: fetching ${url} failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_COMPRESSED_BYTES) throw new Error(`${PIN_EXTENSION_FLAG}: ${url} exceeds the download bound`);
  const tar = await import("tar");
  return describeExtensionTarball(buf, { tar });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The lock text with ONE change: the planned entry's `resolvedSha` (and, in the
 * required lock, its `packageVersion` and `treeSha256`) takes the pinned
 * commit's values. Every other byte of the file stays as it was; the result is
 * re-read and compared with the expected object, and any other difference
 * refuses.
 */
export function pinnedLockText({ text, plan, pin, described = null }) {
  const required = plan.lockFile === REQUIRED_EXTENSIONS_LOCK;
  const fields = { resolvedSha: pin.sha };
  if (required) {
    if (!described || typeof described.treeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(described.treeSha256)) {
      throw new Error(`${PIN_EXTENSION_FLAG}: no tree hash was read for ${pin.id}; the required lock is not edited.`);
    }
    if (described.packageName !== plan.entry.packageName) {
      throw new Error(
        `${PIN_EXTENSION_FLAG}: ${pin.id} names the package ${JSON.stringify(described.packageName)}, and the lock ` +
          `entry is ${plan.entry.packageName} — the image's acquire step would refuse it.`,
      );
    }
    if (typeof described.packageVersion !== "string" || !CONCRETE_VERSION_RE.test(described.packageVersion)) {
      throw new Error(
        `${PIN_EXTENSION_FLAG}: ${pin.id} carries the package version ${JSON.stringify(described.packageVersion)}, ` +
          `not a concrete x.y.z version the acquire step accepts.`,
      );
    }
    fields.packageVersion = described.packageVersion;
    fields.treeSha256 = described.treeSha256;
  }
  const repoKey = new RegExp(`"repo"\\s*:\\s*"${escapeRe(String(plan.entry.repo))}"`, "g");
  const hits = [...text.matchAll(repoKey)];
  if (hits.length !== 1) {
    throw new Error(`${PIN_EXTENSION_FLAG}: the entry of ${pin.repo} in ${plan.lockFile} could not be located exactly once.`);
  }
  const at = hits[0].index;
  const open = text.lastIndexOf("{", at);
  const close = text.indexOf("}", at);
  if (open < 0 || close < 0 || text.slice(open + 1, at).includes("}")) {
    throw new Error(`${PIN_EXTENSION_FLAG}: the entry of ${pin.repo} in ${plan.lockFile} is not a flat object.`);
  }
  let block = text.slice(open, close + 1);
  for (const [key, value] of Object.entries(fields)) {
    const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(block)) {
      throw new Error(`${PIN_EXTENSION_FLAG}: the entry of ${pin.repo} in ${plan.lockFile} has no "${key}" to pin.`);
    }
    block = block.replace(re, (_m, head) => `${head}"${value}"`);
  }
  const next = text.slice(0, open) + block + text.slice(close + 1);
  // The one-change proof: the edited file parses to the original with exactly
  // the pinned fields of exactly that entry replaced.
  const expected = JSON.parse(text);
  const idx = expected.packages.findIndex((row) => row && String(row.repo ?? "").toLowerCase() === pin.repo);
  expected.packages[idx] = { ...expected.packages[idx], ...fields };
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected)) {
    throw new Error(`${PIN_EXTENSION_FLAG}: the edit of ${plan.lockFile} changed more than the one entry — refused.`);
  }
  return next;
}

/**
 * Everything a build needs for one pin, resolved BEFORE any build: the lock
 * texts at the app commit, the plan, the pinned commit's description (required
 * lock only) and the edited text. `apply(contextDir)` writes the edit into the
 * build context and refuses a context whose lock is not the text planned on.
 */
export async function prepareExtensionPin({ pin, sha, fleet, checkoutDir, readFileAtSha, describePinnedCommit }) {
  const locks = {};
  for (const lockFile of EXTENSION_LOCKS) locks[lockFile] = readFileAtSha({ sha, file: lockFile, checkoutDir });
  const plan = planExtensionPin({ pin, locks, fleet });
  const described =
    plan.lockFile === REQUIRED_EXTENSIONS_LOCK ? await describePinnedCommit({ repo: pin.repo, sha: pin.sha }) : null;
  const before = locks[plan.lockFile];
  const after = pinnedLockText({ text: before, plan, pin, described });
  return {
    id: pin.id,
    lockFile: plan.lockFile,
    fromSha: plan.entry.resolvedSha,
    before,
    after,
    apply(contextDir) {
      const file = path.join(contextDir, plan.lockFile);
      const current = readFileSync(file, "utf8");
      if (current !== before) {
        throw new Error(`${PIN_EXTENSION_FLAG}: ${plan.lockFile} in the build context is not the app commit's — refused.`);
      }
      writeFileSync(file, after);
    },
  };
}
