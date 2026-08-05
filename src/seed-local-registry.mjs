// -----------------------------------------------------------------------------
// Dev-only seed of the on-disk first-party extensions into the LOCAL bundled
// Verdaccio (cinatra#386).
//
// THE GAP: the repo ships ~80 first-party extension packages on disk at
// `extensions/<vendor>/<pkg>/` (e.g. `@cinatra-ai/blog-content-workflow`), but a
// fresh/bundled local Verdaccio (docker-compose `verdaccio` service at
// 127.0.0.1:4873) starts EMPTY — those packages were never published into it.
// The installer resolves REGISTRY-ONLY (pacote against the registry URL; no
// on-disk fallback), so a `GET /@cinatra-ai%2fblog-content-workflow` returns 404
// and the extension is uninstallable out of the box.
//
// THE FIX (the dev-side mirror of the production seeding contract): production
// installs resolve from immutable registry tarballs that a maintainer publishes
// to the production Verdaccio; here we do the dev equivalent — publish the
// on-disk first-party packages into the LOCAL registry during `cinatra setup
// dev`, so dev resolution matches the production "registry is the install
// backend" model WITHOUT teaching the installer a source-tree fallback (which
// would widen the install trust surface and let packaging defects hide until
// production).
//
// GUARDRAILS (codex-converged on cinatra#386):
//   - DEV-ONLY: called only from the `mode === "dev"` block of `runSetup`,
//     after the on-disk extension tree is materialized + manifests regenerated.
//     Never on the prod setup path and never on any install path.
//   - LOOPBACK-ONLY: the publish target is HARD-BOUND to a loopback host
//     (127.0.0.1 / ::1 / localhost). A non-loopback registry URL is REJECTED
//     before any publish — this seed must never push at a remote/production
//     registry. Arbitrary env registry values are not honored as a publish
//     target.
//   - REACHABILITY-GATED: if the local registry is down/unreadable, warn and
//     skip the whole step (loud-but-non-fatal — never abort setup).
//   - TEMP AUTH ONLY: self-register a throwaway Verdaccio user, write the auth
//     token only into a temp `--userconfig` file, and delete it in `finally`.
//     The real `~/.npmrc` is never read or mutated.
//   - IDEMPOTENT + NON-CLOBBERING: check the packument first; if `name@version`
//     already exists, SKIP (never force-publish / unpublish / overwrite a
//     dist-tag). Re-running setup is a cheap no-op.
//   - VERSION-SKEW DETECTION: if `name@version` already exists but the local
//     packed bytes differ from the registry tarball integrity, warn LOUDLY and
//     do NOT republish the same version — the operator must purge/reset the
//     local Verdaccio or bump the extension version. Whether that skew is
//     EXIT-AFFECTING depends on the source's sync provenance, and the DECISION
//     belongs to the caller (cinatra-cli#200): this module records the
//     unattributed skews in `summary.unexemptedSkew` and NEVER sets the exit
//     code for a skew itself. See `classifySetupExitCode` below — a skew-only
//     setup exits with the TYPED `SETUP_EXIT_REGISTRY_SKEW` code, which the
//     install boundary names and continues past instead of reporting a failed
//     setup over a substantively completed one.
//   - PRIVATE/SHAPE FILTER: only publish packages whose `package.json` has a
//     valid `name` + `version` and is not `"private": true`.
//   - FAILURE DISCIPLINE: a per-package publish failure warns, continues to the
//     remaining packages, and leaves setup loud-but-non-fatal.
//
// This module is intentionally dependency-light (node builtins, the declared
// `tar` package, and the `npm`/`git` binaries): like its `agents-install.mjs`
// sibling it cannot import the @cinatra-ai/registries TS source from a `.mjs`
// CLI script. Its ONE first-party import is the git-provenance helper from
// `dev-repo-sync.mjs`, itself a builtins-only module (cinatra-cli#200).
// -----------------------------------------------------------------------------

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { Parser as TarParser } from "tar";

import { packedPathsAreTrackedAndUnhidden } from "./dev-repo-sync.mjs";

// The bundled local Verdaccio — the ONLY sanctioned publish target for this
// dev seed. Matches docker-compose `verdaccio` (host port 4873) and the
// `DEFAULT_REGISTRY_URL` the agents-install CLI already uses.
export const LOCAL_REGISTRY_URL = "http://127.0.0.1:4873";

// Hostnames that count as loopback. A publish target MUST resolve to one of
// these or the step refuses to run (never push at a remote/production registry).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

// Per-call ceilings so a loopback service that ACCEPTS a connection then stalls
// can never hang setup. A timeout is always treated as warn-and-continue (the
// whole step is loud-but-non-fatal). Generous because publish writes a tarball.
const HTTP_TIMEOUT_MS = 15_000;
const PUBLISH_TIMEOUT_MS = 60_000;

/**
 * Compare two dotted numeric version cores (`major.minor.patch[...]`). Returns
 * 1 if `a > b`, -1 if `a < b`, 0 if equal. Pre-release/build metadata is
 * ignored (split off the first `-`/`+`); a non-numeric segment compares as 0.
 * Deliberately tiny — this only decides "would npm reject a lower publish?",
 * not full semver precedence.
 */
export function compareVersionCores(a, b) {
  const core = (v) => String(v).split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const av = core(a);
  const bv = core(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * True iff any published version is >= `onDiskVersion`. When this holds, `npm
 * publish` of the on-disk (lower-or-equal) version would be rejected as a lower
 * `latest`, so we skip gracefully instead of forcing a loud failure. When only
 * LOWER versions exist (e.g. after an on-disk version bump), this is false and
 * the caller proceeds to publish the new version.
 */
export function registryHasAtLeast(packument, onDiskVersion) {
  const versions = packument?.versions ? Object.keys(packument.versions) : [];
  return versions.some((v) => compareVersionCores(v, onDiskVersion) >= 0);
}

/**
 * True iff `registryUrl` is a well-formed http(s) URL whose host is loopback.
 * Defensive: a parse failure (or any non-loopback host) returns false so the
 * caller refuses to publish.
 */
export function isLoopbackRegistryUrl(registryUrl) {
  if (!registryUrl || typeof registryUrl !== "string") return false;
  let parsed;
  try {
    parsed = new URL(registryUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * Enumerate the on-disk first-party extension package dirs under
 * `<repoRoot>/extensions/<vendor>/<pkg>/` that carry a publishable
 * `package.json` (valid name+version, not private). Returns sorted entries
 * `{ dir, name, version, private }` for deterministic ordering.
 */
export function enumeratePublishableExtensions(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "extensions");
  const out = [];
  if (!existsSync(extensionsRoot)) return out;

  let vendors;
  try {
    vendors = readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const vendor of vendors) {
    if (!vendor.isDirectory()) continue;
    const vendorDir = path.join(extensionsRoot, vendor.name);
    let pkgs;
    try {
      pkgs = readdirSync(vendorDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue;
      const dir = path.join(vendorDir, pkg.name);
      const manifestPath = path.join(dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        // Unreadable/invalid package.json — skip (a per-package warn happens
        // at the call site only for things we actually try to publish).
        continue;
      }
      if (manifest.private === true) continue;
      if (typeof manifest.name !== "string" || !manifest.name) continue;
      if (typeof manifest.version !== "string" || !manifest.version) continue;
      out.push({
        dir,
        name: manifest.name,
        version: manifest.version,
        private: false,
      });
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Probe the registry root. Returns true on a 2xx HTTP response, false on any
 * network error / non-2xx. Used to skip the whole step when Verdaccio is down.
 */
async function isRegistryReachable(registryUrl) {
  try {
    const res = await fetch(new URL("/", registryUrl), {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read the registry packument for `name`. Returns the parsed JSON on 200, or
 * `null` on 404 / network error / non-200 (treated as "not present yet").
 */
async function fetchPackument(registryUrl, name) {
  // Scoped names must be URL-escaped (`@scope/name` → `@scope%2fname`).
  const escaped = name.replace("/", "%2f");
  try {
    const res = await fetch(new URL(`/${escaped}`, registryUrl), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 200) return await res.json();
    return null;
  } catch {
    return null;
  }
}

// The throwaway seed user. The password is DETERMINISTIC (and local-only): the
// only credential it ever guards is publish access to a loopback dev Verdaccio.
// Determinism is REQUIRED for idempotency — on a re-run the user already exists,
// so the second `cinatra setup dev` must be able to LOG BACK IN (anonymous
// adduser then returns 409) to get a fresh publish token. A random per-run
// password would lock the existing user out and break re-seeding.
const SEED_USER = "cinatra-dev-seed";
const SEED_PASSWORD = "cinatra-local-dev-seed-v1";
const SEED_EMAIL = "dev-seed@cinatra.local";

/**
 * Provision (or re-authenticate) the throwaway seed user on the LOOPBACK
 * registry and return a fresh publish token. Two-step:
 *   1. Anonymous PUT to the couchdb adduser endpoint — creates the user the
 *      first time (Verdaccio enables anonymous registration by default).
 *   2. If the user already exists (409 "already registered"), PUT again WITH
 *      Basic auth (the npm-login path) to mint a fresh token.
 * Returns `null` on any failure (the caller then skips the whole step
 * loud-but-non-fatally). NEVER include a response body in surfaced text — it may
 * reflect the password back.
 */
async function provisionSeedToken(registryUrl) {
  const base = registryUrl.replace(/\/$/, "");
  const url = `${base}/-/user/org.couchdb.user:${encodeURIComponent(SEED_USER)}`;
  const body = {
    _id: `org.couchdb.user:${SEED_USER}`,
    name: SEED_USER,
    password: SEED_PASSWORD,
    email: SEED_EMAIL,
    type: "user",
    roles: [],
    date: new Date().toISOString(),
  };

  // Step 1 — anonymous create (first-run).
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 200) {
      const parsed = await res.json().catch(() => null);
      if (parsed && typeof parsed.token === "string" && parsed.token) return parsed.token;
      return null;
    }
    // Any non-409 failure (e.g. registration disabled) → give up.
    if (res.status !== 409) return null;
  } catch {
    return null;
  }

  // Step 2 — the user already exists; re-authenticate with Basic auth (npm
  // login) using the deterministic seed password to mint a fresh token.
  try {
    const basic = Buffer.from(`${SEED_USER}:${SEED_PASSWORD}`).toString("base64");
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ name: SEED_USER, password: SEED_PASSWORD }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 201 || res.status === 200) {
      const parsed = await res.json().catch(() => null);
      if (parsed && typeof parsed.token === "string" && parsed.token) return parsed.token;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `npm pack` the package dir into `outDir` and return the absolute tarball path
 * (no publish). Used for version-skew integrity comparison. Returns null on
 * failure.
 */
function packTarball(dir, outDir, registryUrl, userconfigPath) {
  const result = spawnSync(
    "npm",
    [
      "pack",
      "--pack-destination",
      outDir,
      "--registry",
      registryUrl,
      // Pure-source first-party packages — no pack lifecycle hooks are needed,
      // and ignoring scripts keeps a malicious/accidental prepack out of setup.
      "--ignore-scripts",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfigPath },
      timeout: PUBLISH_TIMEOUT_MS,
    },
  );
  if (result.status !== 0) return null;
  // npm pack prints the produced filename on the last non-empty stdout line.
  const lines = (result.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const file = lines[lines.length - 1];
  if (!file) return null;
  const abs = path.join(outDir, path.basename(file));
  return existsSync(abs) ? abs : null;
}

// Tar entry types that carry a real package path a consumer must account for.
// `Link` matters as much as `File` (codex review): node-tar writes the SECOND
// and later members sharing an inode as hard links, so a filter that kept only
// `File` would silently drop a packed path from verification.
const PACKED_PATH_ENTRY_TYPES = new Set(["File", "ContiguousFile", "Link", "SymbolicLink"]);
// Structural entries that carry no packable content of their own.
const PACKED_SKIPPABLE_ENTRY_TYPES = new Set(["Directory", "GNUDumpDir"]);

/**
 * The package-relative paths inside a packed tarball (npm prefixes every entry
 * with `package/`). Used to ask git whether it vouches for exactly what was
 * packed.
 *
 * Fail-closed, and COMPLETE: an unreadable tarball, an entry type this does not
 * model, or an entry the tar parser itself ignored yields `null` — which the
 * provenance check treats as "cannot vouch". The parser is driven directly
 * rather than through `tar.list` because a type node-tar does not support
 * (sparse files, Solaris ACL/inode records, anything unrecognized) is reported
 * on `ignoredEntry`, which an `onentry`-only listener never sees — leaving an
 * archive member silently unaccounted for (codex review).
 */
export function listPackedMembers(tarballPath) {
  const files = [];
  let unaccountedEntry = false;
  try {
    const parser = new TarParser({
      onReadEntry: (entry) => {
        const type = String(entry.type ?? "");
        if (!PACKED_SKIPPABLE_ENTRY_TYPES.has(type)) {
          if (PACKED_PATH_ENTRY_TYPES.has(type)) {
            const rel = String(entry.path).replace(/^package\//, "");
            if (rel) files.push(rel);
          } else {
            unaccountedEntry = true;
          }
        }
        entry.resume();
      },
    });
    parser.on("ignoredEntry", () => {
      unaccountedEntry = true;
    });
    parser.end(readFileSync(tarballPath));
  } catch {
    return null;
  }
  return unaccountedEntry ? null : files;
}

/** sha512 base64 integrity string (`sha512-<base64>`) for a tarball file. */
function tarballIntegrity(tarballPath) {
  const bytes = readFileSync(tarballPath);
  const digest = createHash("sha512").update(bytes).digest("base64");
  return `sha512-${digest}`;
}

// ---------------------------------------------------------------------------
// The CROSS-PROCESS skew contract (cinatra-cli#200).
//
// `cinatra install` runs `cinatra instance setup <mode>` as a CHILD process, so
// the child's exit code is the only channel the two share. Before this contract
// existed, a local-registry version skew set a bare `process.exitCode = 1`,
// which the install boundary could only read as "setup failed inside the
// target" — aborting an install whose setup had substantively completed
// (checkout DDL applied, migrations applied, manifests regenerated, `0 failed`
// in the seed itself) and, on `--mode preview`, killing the run before the
// preview composition. The module's own "loud-but-non-fatal, NEVER aborts
// setup" contract held inside the process and was lost at its boundary.
//
// So a skew now gets a TYPED code that says what it is:
//   0                          nothing to report
//   SETUP_EXIT_REGISTRY_SKEW   the ONLY exit-affecting condition was an
//                              unattributed same-version registry skew — the
//                              instance is fully set up; the local registry
//                              just keeps serving the previously seeded bytes
//                              for those versions until a bump/purge
//   1 (or any other non-zero)  a REAL failure, which always WINS over a skew
// Everything a real failure sets keeps flowing through `process.exitCode`
// untouched; this only claims the otherwise-clean case.
// ---------------------------------------------------------------------------

/** Typed setup exit code: "local-registry version skew, nothing else".
 *
 *  The VALUE matters (codex review): node reserves 1–12 for its own fatal
 *  conditions (3 is an internal JavaScript parse error, 7 a bootstrap
 *  exception, …) and 128+N for signal deaths, while 64–78 are the BSD
 *  `sysexits` conventions other tooling may assume. A code in any of those
 *  ranges would let an unrelated fatal child be MISREAD as a benign skew — the
 *  exact fail-open this fix must not introduce. 20 sits above node's reserved
 *  block and below every convention above. */
export const SETUP_EXIT_REGISTRY_SKEW = 20;

/**
 * PROVABLY zero — the only state in which the typed skew code may be claimed.
 * `process.exitCode` may be unset, a number, or a numeric string; anything else
 * (or anything unparseable) is treated as a failure already in flight rather
 * than coerced to "clean" (codex review: `Number("")`, `Number(false)` and
 * friends are 0, which would let a skew mask a failure).
 */
function isProvablyCleanExitCode(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed !== "" && Number.isFinite(Number(trimmed)) && Number(trimmed) === 0;
  }
  return false;
}

function resolveSkewExitCode(currentExitCode, hasUnattributedSkew) {
  if (!isProvablyCleanExitCode(currentExitCode)) return currentExitCode;
  return hasUnattributedSkew ? SETUP_EXIT_REGISTRY_SKEW : 0;
}

/**
 * Decide the setup process's final exit code. Pure + fail-closed: any non-zero
 * code already set by a REAL failure is preserved unchanged (a skew must never
 * mask or downgrade it), and the typed skew code is claimed ONLY when the run
 * is otherwise clean and at least one unattributed skew was recorded.
 */
export function classifySetupExitCode(currentExitCode, unexemptedSkew = []) {
  return resolveSkewExitCode(
    currentExitCode,
    Array.isArray(unexemptedSkew) && unexemptedSkew.length > 0,
  );
}

/**
 * The same decision for a process that already KNOWS it is carrying the skew
 * outcome — `cinatra install` re-raising the typed code its setup child
 * reported. Assigning the code unconditionally there would let it overwrite a
 * non-zero the install had already set for a real failure (codex review).
 */
export function claimRegistrySkewExitCode(currentExitCode) {
  return resolveSkewExitCode(currentExitCode, true);
}

/**
 * The operator-facing verdict for a skew-only exit: WHAT happened, WHAT it
 * means for the instance, and the remedy. Shared by the setup tail and the
 * install boundary so both name the same condition (never a bare "setup
 * failed"). `names` are `pkg@version` ids.
 */
export function registrySkewVerdictLines(names = [], { context = "setup" } = {}) {
  const ids = Array.isArray(names) ? names.filter(Boolean) : [];
  if (context === "install-tail") {
    // The compact restatement at the very end of a completed install (the
    // in-context statement already printed right after the setup phase).
    return [
      "",
      `⚠ Completed WITH local-registry version skew (see the seed warnings above) — exit ` +
        `code ${SETUP_EXIT_REGISTRY_SKEW}.`,
      "  The instance is fully provisioned; the local registry still serves the previously seeded",
      "  bytes for the affected version(s). Remedy: bump the extension version, or purge/reset the",
      "  local Verdaccio, then re-run.",
    ];
  }
  if (context === "install") {
    // The install boundary sees only the child's exit CODE — the per-extension
    // warnings already streamed through the inherited stdio above — so it names
    // the condition and its remedy without re-deriving the list.
    return [
      "",
      "⚠ Local-registry version skew reported by the setup phase (see the seed warnings above).",
      "  This is NOT a failed setup: the instance is fully provisioned. The affected extension",
      "  version(s) are already published in the local registry with different bytes, so the same",
      "  version was not republished and the registry keeps serving the previously seeded content.",
      "  Remedy: bump the extension version, or purge/reset the local Verdaccio, then re-run.",
      "  Continuing the install.",
      "",
    ];
  }
  return [
    "",
    `⚠ Setup completed; the local-registry seed reported version skew on ${ids.length} ` +
      `extension${ids.length === 1 ? "" : "s"}:`,
    ...ids.map((id) => `    ${id}`),
    "  Those versions are already published in the local registry with DIFFERENT bytes, and the",
    "  on-disk source is not attributable to the extension sync (uncommitted local edits, or a",
    "  checkout the sync does not manage). The same version is never republished, so the local",
    "  registry keeps serving the previously seeded content for it — everything else in this",
    "  instance is fully provisioned.",
    "  Remedy: bump the extension version, or purge/reset the local Verdaccio, then re-run.",
    "",
  ];
}

/**
 * Seed every on-disk first-party extension into the LOCAL bundled Verdaccio.
 *
 * Loud-but-non-fatal, END-TO-END (cinatra-cli#200): it never throws past the
 * caller, never aborts setup, and — the part that used to be lost at the
 * process boundary — a version SKEW never sets the exit code here at all. A
 * skew is reported in the returned summary (`skew` = every skew seen,
 * `unexemptedSkew` = the ones no sync provenance accounts for) and the CALLER
 * classifies it via `classifySetupExitCode`, so a skew-only run exits with the
 * typed `SETUP_EXIT_REGISTRY_SKEW` code that the install boundary names and
 * continues past. `process.exitCode = 1` is still set here for REAL failures —
 * a publish failure, an unprovisionable publish user, or an unexpected error.
 *
 * Returns `{ status, registryUrl, published, skipped, failed, skew,
 * unexemptedSkew, divergentVersion }`.
 *
 * `status`:
 *   - "skipped-not-loopback"  registry target is not loopback → refused
 *   - "skipped-unreachable"   local Verdaccio not up → nothing to do
 *   - "skipped-no-auth"       could not self-register a publish user
 *   - "skipped-empty"         no publishable extensions on disk
 *   - "ok"                    ran (see counts)
 */
export async function seedLocalRegistryExtensions({
  repoRoot,
  registryUrl = LOCAL_REGISTRY_URL,
  // Resolved extension DIRECTORIES whose on-disk source the just-completed
  // extension sync verified to sit AT a committed lock pin (detached,
  // sha-verified). For those, a same-version/different-content skew is the
  // EXPECTED update-path state (cinatra#1136): the local registry still carries
  // the tarball seeded from the PREVIOUS release's pin, while the source
  // legitimately moved with the committed lock — that must not turn a
  // successful reconcile into a non-zero exit. The warning still prints (the
  // local registry keeps serving the previous content for that version until a
  // bump/purge).
  pinnedSourceDirs = null,
  // Resolved extension DIRECTORIES the just-completed extension sync verified
  // CLEAN at the freshly-fetched `origin/<branch>` tip (cinatra-cli#200 —
  // `syncedSha`). Dev-mode companion checkouts track branch tips and never
  // carry a lock pin, so they could never join the exemption above; yet their
  // upstream moving without a version bump is ROUTINE across a checkout's whole
  // dev-extension set, and the sync itself is what moved them. A clean worktree
  // at the tip the sync just fetched is the same "expected update-path state"
  // the pinned exemption describes, so it is exempted on the same terms.
  //
  // Both sets are keyed by DIRECTORY, not package name: this loop enumerates
  // directories, and only the exact checkout the sync verified may be exempt
  // (a second on-disk package declaring the same name is unattested content).
  //
  // What stays EXIT-AFFECTING (fail-closed — anything the sync did not attest):
  // a dirty worktree the sync skipped, a detached checkout carrying local
  // commits, a checkout whose sync failed or was filtered out, an attestation
  // that no longer held when it was collected, and any on-disk package the
  // dev-extension sync does not manage at all.
  syncedSourceDirs = null,
  // SECOND-STAGE provenance for an attested source that actually skews: does
  // git vouch for the exact file set `npm pack` produced? A checkout can be at
  // the attested commit with a clean status and STILL pack different bytes
  // (files hidden with assume-unchanged/skip-worktree, or ignored build output
  // a `files` field packs). Consulted ONLY on a skew — never on the hot path —
  // and fail-closed: no vouch means the skew is treated as unattributed.
  // Injectable for tests; the default is the real git check.
  verifyPackedProvenance = packedPathsAreTrackedAndUnhidden,
} = {}) {
  const summary = {
    status: "ok",
    registryUrl,
    published: [],
    skipped: [],
    failed: [],
    skew: [],
    // The subset of `skew` no sync provenance accounts for — the caller's input
    // to `classifySetupExitCode`. Everything in `skew` is warned about either way.
    unexemptedSkew: [],
    divergentVersion: [],
  };

  // GUARDRAIL: loopback-only. Refuse any non-loopback publish target outright.
  if (!isLoopbackRegistryUrl(registryUrl)) {
    summary.status = "skipped-not-loopback";
    console.warn(
      `\n⚠ Local registry seed SKIPPED: publish target '${registryUrl}' is not a loopback ` +
        `address. This dev seed only ever publishes to the local bundled Verdaccio.\n`,
    );
    return summary;
  }

  // GUARDRAIL: reachability. Verdaccio down → skip the whole step.
  if (!(await isRegistryReachable(registryUrl))) {
    summary.status = "skipped-unreachable";
    console.log(
      `- Local registry seed: skipped (Verdaccio not reachable at ${registryUrl}; ` +
        `start the docker stack and re-run \`cinatra instance setup dev\` to seed bundled extensions).`,
    );
    return summary;
  }

  const extensions = enumeratePublishableExtensions(repoRoot);
  if (extensions.length === 0) {
    summary.status = "skipped-empty";
    console.log("- Local registry seed: no publishable on-disk extensions found.");
    return summary;
  }

  // GUARDRAIL: temp auth only. Self-register and write the token into a temp
  // userconfig, removed in `finally` — the real ~/.npmrc is never touched.
  const token = await provisionSeedToken(registryUrl);
  if (!token) {
    summary.status = "skipped-no-auth";
    console.warn(
      "\n⚠ Local registry seed SKIPPED: could not provision a publish user on the local " +
        "Verdaccio (registration may be disabled). Bundled extensions will not be seeded.\n",
    );
    process.exitCode = 1;
    return summary;
  }

  let tmpDir;
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cinatra-seed-registry-"));
    const userconfigPath = path.join(tmpDir, ".npmrc");
    const host = new URL(registryUrl).host;
    writeFileSync(
      userconfigPath,
      `//${host}/:_authToken=${token}\nregistry=${registryUrl.replace(/\/$/, "")}/\n`,
      { mode: 0o600 },
    );
    for (const ext of extensions) {
      const id = `${ext.name}@${ext.version}`;
      const packument = await fetchPackument(registryUrl, ext.name);
      const existing = packument?.versions?.[ext.version];
      // IDEMPOTENT: already-present exact version → skip (or skew-check).
      if (existing) {
        // VERSION-SKEW DETECTION: compare local packed bytes to the registry
        // tarball integrity. A mismatch means the on-disk source diverged from
        // the already-published version — warn loudly, do NOT republish.
        const registryIntegrity =
          typeof existing.dist?.integrity === "string" ? existing.dist.integrity : null;
        if (registryIntegrity) {
          const packed = packTarball(ext.dir, tmpDir, registryUrl, userconfigPath);
          if (packed) {
            const localIntegrity = tarballIntegrity(packed);
            const drifted = localIntegrity !== registryIntegrity;
            const extDir = path.resolve(ext.dir);
            const attestedPin = Boolean(pinnedSourceDirs?.has(extDir));
            const attestedTip = Boolean(syncedSourceDirs?.has(extDir));
            // Second stage, and ONLY where it can change the verdict: the file
            // set that actually got packed must be one git vouches for. Read
            // before the tarball is removed.
            const packedProvenanceOk =
              drifted && (attestedPin || attestedTip)
                ? verifyPackedProvenance({ dir: ext.dir, files: listPackedMembers(packed) }) === true
                : false;
            try {
              rmSync(packed, { force: true });
            } catch {
              /* ignore */
            }
            if (drifted) {
              summary.skew.push(id);
              if (attestedPin && packedProvenanceOk) {
                // Committed-lock pin → expected after an update; informational.
                console.warn(
                  `\n⚠ Local registry seed: ${id} is already published from a previous pin; the on-disk ` +
                    `source now sits at the committed lock with the same version. NOT republishing the same ` +
                    `version — the local registry serves the previously seeded content for ${ext.version} ` +
                    `until the extension version bumps (or the local Verdaccio is purged/reset).\n`,
                );
              } else if (attestedTip && packedProvenanceOk) {
                // Branch-tip dev clone the sync just verified clean AT the
                // fetched tip → routine upstream drift on the update path;
                // informational, exactly like the pinned case.
                console.warn(
                  `\n⚠ Local registry seed: ${id} is already published from an earlier seed; the on-disk ` +
                    `source now sits at the freshly-synced branch tip with the same version. NOT republishing ` +
                    `the same version — the local registry serves the previously seeded content for ` +
                    `${ext.version} until the extension version bumps (or the local Verdaccio is ` +
                    `purged/reset).\n`,
                );
              } else {
                // Unattributed divergence — local edits without a version bump,
                // a source this sync does not manage, or packed content git does
                // not vouch for. Exit-affecting, but the CALLER decides the code
                // (classifySetupExitCode).
                summary.unexemptedSkew.push(id);
                const reason =
                  attestedPin || attestedTip
                    ? `the packed contents include files git does not track for this checkout (or that are ` +
                      `hidden from it with assume-unchanged/skip-worktree), so the difference is not ` +
                      `attributable to the extension sync`
                    : `the extension sync did not attest this checkout (no committed-lock pin, no clean ` +
                      `branch-tip state) — it looks like local edits without a version bump`;
                console.warn(
                  `\n⚠ Local registry seed: ${id} is already published but the on-disk source ` +
                    `differs from the published tarball, and ${reason}. NOT republishing the same version. ` +
                    `Purge/reset the local Verdaccio or bump the extension version to refresh it.\n`,
                );
              }
              continue;
            }
          }
        }
        summary.skipped.push(id);
        continue;
      }

      // DIVERGENT VERSION (dirty-registry tolerance): the package exists on the
      // registry but NOT at the on-disk version, AND a version >= the on-disk
      // version is already published (e.g. a higher version from a past ad-hoc
      // publish). npm would reject the lower `latest` publish; this is not a
      // fresh-instance failure, so record it as an informational skip (NON-fatal)
      // and leave the existing version(s) in place.
      //
      // IMPORTANT: when only LOWER versions exist (e.g. the on-disk version was
      // bumped since the last seed), this is FALSE — we fall through and publish
      // the new version, so a version bump actually lands. On a truly fresh
      // instance the packument is 404 → `packument` is null → we publish.
      if (registryHasAtLeast(packument, ext.version)) {
        const others = Object.keys(packument.versions).join(", ");
        summary.divergentVersion.push(id);
        console.log(
          `- Local registry seed: ${id} not published — the local registry already has ` +
            `${ext.name} at a version >= ${ext.version} (${others}). Leaving the existing version(s) in place.`,
        );
        continue;
      }

      // PUBLISH: `npm publish <dir>` against the loopback registry with the temp
      // userconfig. Per-package failure warns + continues (loud-but-non-fatal).
      const result = spawnSync(
        "npm",
        [
          "publish",
          ext.dir,
          "--registry",
          registryUrl,
          // default access keeps scoped packages public on Verdaccio.
          "--access",
          "public",
          // Pure-source first-party packages — no publish lifecycle hooks are
          // needed; ignoring scripts keeps a prepublish hook out of setup.
          "--ignore-scripts",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, NPM_CONFIG_USERCONFIG: userconfigPath },
          timeout: PUBLISH_TIMEOUT_MS,
        },
      );
      if (result.status === 0) {
        summary.published.push(id);
      } else {
        summary.failed.push(id);
        const stderr = (result.stderr || "").trim().split("\n").slice(-3).join("\n");
        console.warn(`\n⚠ Local registry seed: failed to publish ${id}\n  ${stderr}\n`);
        process.exitCode = 1;
      }
    }

    console.log(
      `- Local registry seed: ${summary.published.length} published, ` +
        `${summary.skipped.length} already present, ${summary.failed.length} failed` +
        (summary.divergentVersion.length
          ? `, ${summary.divergentVersion.length} different-version (left as-is)`
          : "") +
        (summary.skew.length
          ? `, ${summary.skew.length} version-skew (NOT republished` +
            (summary.unexemptedSkew.length
              ? `; ${summary.unexemptedSkew.length} unattributed to the extension sync`
              : "") +
            ")"
          : "") +
        ` (bundled extensions → ${registryUrl}).`,
    );
  } catch (err) {
    // Any unexpected escape is loud-but-non-fatal — setup is not rolled back.
    console.warn(
      `\n⚠ Local registry seed encountered an error:\n  ${err && err.message ? err.message : err}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  return summary;
}
