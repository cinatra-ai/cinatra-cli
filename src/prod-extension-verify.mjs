// Production required-extension COHERENCE verification (cinatra#789).
//
// A strictly READ-ONLY, NON-mutating assertion that the prod required-extension
// state is coherent across ALL FIVE authorities that a healthy prod instance
// must agree on:
//
//   (A) on-disk required set   — extensions/<scope>/<name> trees materialized by
//                                `extensions acquire-prod` (or baked into the
//                                image), each stamped with an acquisition marker
//                                `.cinatra-acquired.json`.
//   (B) baked seed / declared  — the host's `cinatra.extensions` declaration in
//                                the root package.json (the required-in-prod set).
//   (C) the committed LOCK      — cinatra-required-extensions.lock.json, the ONLY
//                                source prod acquires from (pinned SHA + tree hash
//                                + version per package).
//   (D) loader-registered set   — what the running instance actually
//                                registered/activated: the durable, cluster-wide
//                                `<schema>.installed_extension` manifest (a
//                                required package is activated iff it has a live
//                                `active`/`locked` row — the SAME predicate the
//                                app's boot `required-activation-assert` uses via
//                                `verifyRequiredInProdInstalled`).
//   (E) WayFlow-visible set     — the materialized agent-OAS trees on disk under
//                                the resolved agent-install dir
//                                (`<vendor>/<slug>/cinatra/oas.json`, seed-owned
//                                via `.cinatra-required-seed.json`, and present in
//                                the seed `manifest.json`). This dir IS the
//                                WayFlow `:/agents:ro` mount, so its on-disk
//                                contents are exactly what WayFlow can see.
//
// This module NEVER writes, renames, downloads, or removes anything. It reuses
// the acquisition module's PURE read helpers (`readRequiredExtensionsLock`,
// `readDeclaredRequiredExtensionNames`, `computeTreeSha256FromDir`,
// `readAcquisitionMarker`, `destDirForExtension`) so there is no logic
// duplication and no accidental mutation path (the acquisition download/extract/
// swap routine is never entered).
//
// MISMATCH CLASSES (deliberately NON-OVERLAPPING; codex-converged):
//   - "missing-on-disk"        : a locked package has no on-disk dir at all.
//   - "extra-seed-owned-dir"   : an acquisition-managed dir (has a marker) whose
//                                package is NOT in the lock. Markerless dirs
//                                (dev clones / user installs) are NEVER flagged.
//   - "lock-mismatch"          : the on-disk tree / marker / package.json drifts
//                                from the lock, OR the lock<->seed bijection is
//                                broken (declared-not-locked / locked-not-declared),
//                                OR the locked version does not satisfy the seed
//                                pin.
//   - "loader-missing"         : a locked required package has no live
//                                `active`/`locked` row, or its live row's version
//                                does not match the lock, or the DB cannot be
//                                reached at all (a hard failure, never a silent
//                                skip).
//   - "wayflow-missing"        : an AGENT-kind locked required package has no
//                                materialized, seed-owned, manifest-listed OAS
//                                tree under the agent-install dir.
//
// `ok` is true iff `findings` is empty. The CLI wrapper exits non-zero on any
// finding, zero when fully coherent.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { deriveKindFromName, destDirForExtension } from "./cinatra-dev-extensions.mjs";
import {
  LOCK_FILENAME,
  computeTreeSha256FromDir,
  readAcquisitionMarker,
  readDeclaredRequiredExtensionNames,
  readRequiredExtensionsLock,
} from "./prod-extension-acquisition.mjs";

export const SEED_OWNERSHIP_MARKER_FILENAME = ".cinatra-required-seed.json";
export const SEED_MANIFEST_FILENAME = "manifest.json";
const OAS_REL_PATH = path.join("cinatra", "oas.json");

/** Every mismatch class this verifier can emit, in a stable report order. */
export const MISMATCH_CLASSES = [
  "missing-on-disk",
  "extra-seed-owned-dir",
  "lock-mismatch",
  "loader-missing",
  "wayflow-missing",
];

function finding(mismatchClass, detail, { packageName = null, remediation = null } = {}) {
  return { class: mismatchClass, packageName, detail, remediation };
}

/**
 * Determine whether a locked package is AGENT-kind (the only kind that
 * materializes a WayFlow OAS tree). Reads the VERIFIED on-disk package.json
 * `cinatra.kind`/`cinatra.type`, falling back to the name-suffix heuristic
 * (`deriveKindFromName`). A dir with no readable manifest yields null (unknown)
 * — the WayFlow check treats unknown-kind as "not provably an agent" and does
 * not fabricate a wayflow-missing finding for it (the missing-on-disk /
 * lock-mismatch checks already cover a broken dir). Pure read.
 */
export function deriveLockedPackageKind(packageName, destDir) {
  const manifestPath = path.join(destDir, "package.json");
  let declaredKind = null;
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      declaredKind = manifest?.cinatra?.kind ?? manifest?.cinatra?.type ?? null;
    } catch {
      declaredKind = null;
    }
  }
  return deriveKindFromName(packageName, declaredKind);
}

/**
 * Mirror of the app's `satisfiesRequiredVersionRange` intent using npm semver
 * (a root dependency), which implements proper npm-style 0.x caret/tilde/x-range
 * semantics. A non-concrete version or an unsupported/garbage range fails
 * closed (returns false), matching the host's fail-closed contract.
 */
export async function versionSatisfiesRange(version, range) {
  if (typeof version !== "string" || typeof range !== "string") return false;
  if (range.trim() === "*") return true;
  const { default: semver } = await import("semver");
  const coerced = semver.valid(version.trim());
  if (!coerced) return false;
  try {
    return semver.satisfies(coerced, range.trim(), { includePrerelease: false });
  } catch {
    return false;
  }
}

/**
 * Extract the installed version from an `installed_extension` row's `source`
 * jsonb, mirroring `verifyRequiredInProdInstalled`:
 *   - a `verdaccio` source carries `source.version` directly;
 *   - a static-bundle ANCHOR row records `bundled@<version>` in
 *     `source.resolvedCommitOrTreeHash` (path prefixed `static-bundle:`);
 *   - any other source is version-unverifiable -> null.
 */
export function extractRowVersion(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "verdaccio" && typeof source.version === "string") {
    return source.version;
  }
  const anchorPath = typeof source.path === "string" ? source.path : "";
  const resolved = typeof source.resolvedCommitOrTreeHash === "string" ? source.resolvedCommitOrTreeHash : "";
  if (anchorPath.startsWith("static-bundle:") && resolved.startsWith("bundled@")) {
    return resolved.slice("bundled@".length) || null;
  }
  return null;
}

/**
 * Read every live (`active`|`locked`) `installed_extension` row via the given pg
 * client, returning a Map<packageName, Array<{status, source, requiredInProd}>>.
 * Throws on a query/connection failure (the caller converts that into a hard
 * loader-missing finding — never a silent pass). READ-ONLY (a single SELECT).
 */
export async function readLiveInstalledExtensions(dbClient, schemaName) {
  // Default ONLY when blank/unset; a non-blank schema is QUOTED verbatim (same
  // double-quote escaping as index.mjs `quoteIdentifier`) so a legitimate schema
  // with unusual chars is honored rather than silently reading the wrong schema.
  const raw = typeof schemaName === "string" && schemaName.trim() ? schemaName.trim() : "cinatra";
  const quoted = `"${raw.replaceAll('"', '""')}"`;
  const res = await dbClient.query(
    `select package_name, status, source, required_in_prod
       from ${quoted}.installed_extension
      where status in ('active','locked')`,
  );
  const byName = new Map();
  for (const row of res.rows) {
    const bucket = byName.get(row.package_name);
    const record = {
      status: row.status,
      source: row.source,
      requiredInProd: row.required_in_prod === true,
    };
    if (bucket) bucket.push(record);
    else byName.set(row.package_name, [record]);
  }
  return byName;
}

/**
 * Read the WayFlow seed manifest under `installDir` — the `{ slugs: [{vendor,
 * slug}] }` list of required agent slugs the image baked. Returns
 * `{ readable, slugs }`: `readable` is false when the manifest is
 * absent/unreadable/malformed (in which case membership CANNOT be confirmed and
 * the caller must treat every agent slug as wayflow-missing rather than passing
 * on an empty set). Pure read.
 */
export function readSeedManifest(installDir) {
  const manifestPath = path.join(installDir, SEED_MANIFEST_FILENAME);
  const slugs = new Set();
  if (!existsSync(manifestPath)) return { readable: false, slugs };
  try {
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(doc?.slugs)) return { readable: false, slugs };
    for (const entry of doc.slugs) {
      if (entry && typeof entry.vendor === "string" && typeof entry.slug === "string") {
        slugs.add(`${entry.vendor}/${entry.slug}`);
      }
    }
    return { readable: true, slugs };
  } catch {
    return { readable: false, slugs };
  }
}

/**
 * Enumerate on-disk `extensions/<scope>/<name>` dirs that carry an acquisition
 * marker (i.e. are acquisition-managed). Returns a Set of scoped package names
 * (`@scope/name`). Markerless dirs (dev clones, user installs) are excluded —
 * they are never seed-owned and must never be flagged as extra. Pure read.
 */
export function listAcquisitionManagedPackages(repoRoot) {
  const extRoot = path.join(repoRoot, "extensions");
  const managed = new Set();
  if (!existsSync(extRoot) || !statSync(extRoot).isDirectory()) return managed;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    // Skip the acquisition module's own dot-prefixed staging/aside dirs.
    if (!scope.isDirectory() || scope.name.startsWith(".")) continue;
    const scopeDir = path.join(extRoot, scope.name);
    for (const pkg of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
      const dir = path.join(scopeDir, pkg.name);
      if (readAcquisitionMarker(dir)) {
        managed.add(`@${scope.name}/${pkg.name}`);
      }
    }
  }
  return managed;
}

/**
 * The verifier. READ-ONLY end to end. Returns `{ ok, findings, checked }`.
 *
 * @param {object} args
 * @param {string} args.repoRoot          workspace/image root holding extensions/ + package.json + lock
 * @param {string} [args.lockPath]        override for the lock path (defaults to <repoRoot>/LOCK_FILENAME)
 * @param {string} args.installDir        resolved agent-install dir (the WayFlow :/agents mount)
 * @param {object|null} args.dbClient     a connected pg client, or null when the DB was unreachable
 * @param {string} args.schemaName        the app DB schema (default "cinatra")
 * @param {string|null} [args.dbError]    a message when dbClient is null (surfaced as loader-missing)
 */
export async function verifyProdRequiredExtensions({
  repoRoot,
  lockPath,
  installDir,
  dbClient,
  schemaName = "cinatra",
  dbError = null,
} = {}) {
  if (!repoRoot) throw new Error("[extensions verify-prod] repoRoot is required");
  const findings = [];

  // (C) the lock is the anchor authority — a malformed lock is fatal to read.
  const lock = readRequiredExtensionsLock(lockPath ?? path.join(repoRoot, LOCK_FILENAME));
  const lockedByName = new Map(lock.packages.map((p) => [p.packageName, p]));

  // (B) declared/seed set from the root package.json.
  const rootManifestPath = path.join(repoRoot, "package.json");
  const declared = existsSync(rootManifestPath)
    ? readDeclaredRequiredExtensionNames(rootManifestPath)
    : new Set();
  // The pinned RANGE per declared name (for the version-satisfaction cross-check).
  const declaredRanges = existsSync(rootManifestPath) ? readDeclaredRanges(rootManifestPath) : new Map();

  // lock <-> seed bijection (class: lock-mismatch). Only when a root manifest
  // exists (a scratch root with no manifest is not "drift", it is "nothing to
  // cross-check" — matching the acquisition module's own guard).
  if (existsSync(rootManifestPath)) {
    const declaredNotLocked = [...declared].filter((n) => !lockedByName.has(n)).sort();
    const lockedNotDeclared = [...lockedByName.keys()].filter((n) => !declared.has(n)).sort();
    for (const name of declaredNotLocked) {
      findings.push(
        finding(
          "lock-mismatch",
          `declared in cinatra.extensions but absent from ${LOCK_FILENAME} (seed<->lock bijection broken)`,
          {
            packageName: name,
            remediation:
              "Regenerate the lock: `node scripts/extensions/update-required-extension-lock.mjs` and commit it.",
          },
        ),
      );
    }
    for (const name of lockedNotDeclared) {
      findings.push(
        finding(
          "lock-mismatch",
          `pinned in ${LOCK_FILENAME} but not declared in cinatra.extensions (seed<->lock bijection broken)`,
          {
            packageName: name,
            remediation:
              "Either declare it in cinatra.extensions or regenerate the lock to drop it: " +
              "`node scripts/extensions/update-required-extension-lock.mjs`.",
          },
        ),
      );
    }
  }

  // (A/C) extra-seed-owned-dir: an acquisition-managed on-disk dir (carries an
  // acquisition marker) whose package is NOT pinned in the lock. Markerless dirs
  // (dev clones / user installs) are NOT enumerated and never flagged.
  for (const managedName of listAcquisitionManagedPackages(repoRoot)) {
    if (!lockedByName.has(managedName)) {
      findings.push(
        finding(
          "extra-seed-owned-dir",
          `acquisition-managed directory on disk but the package is NOT pinned in ${LOCK_FILENAME} ` +
            `(a stale seed-owned tree left behind by an older lock)`,
          {
            packageName: managedName,
            remediation:
              "Re-run `cinatra extensions acquire-prod` (which owns the prune of stale seed dirs), or rebuild the " +
              "image so the required-extension materialize phase prunes it.",
          },
        ),
      );
    }
  }

  // (E) WayFlow seed manifest (read once). `readable` distinguishes a
  // confirmable slug set from an absent/malformed manifest (which cannot confirm
  // membership and therefore fails the WayFlow check for every agent slug).
  const seedManifest = readSeedManifest(installDir);

  // (D) loader-registered set. A DB failure is a HARD finding per required
  // package — never a silent pass. Read the live rows once up front.
  let liveByName = null;
  if (!dbClient) {
    findings.push(
      finding(
        "loader-missing",
        `cannot verify the loader-registered set: the instance DB is unreachable` +
          (dbError ? ` (${dbError})` : "") +
          ". A running, migrated instance is required to prove what the loader activated.",
        {
          remediation:
            "Ensure SUPABASE_DB_URL points at the running instance's database and the instance has booted, " +
            "then re-run `cinatra extensions verify-prod`.",
        },
      ),
    );
  } else {
    try {
      liveByName = await readLiveInstalledExtensions(dbClient, schemaName);
    } catch (err) {
      liveByName = null;
      findings.push(
        finding(
          "loader-missing",
          `cannot verify the loader-registered set: reading ${schemaName}.installed_extension failed ` +
            `(${err instanceof Error ? err.message : String(err)}).`,
          {
            remediation:
              "Confirm the instance DB is reachable and migrated (the installed_extension table exists), " +
              "then re-run `cinatra extensions verify-prod`.",
          },
        ),
      );
    }
  }

  // Per-locked-package checks (A/C/D/E).
  for (const entry of lock.packages) {
    const name = entry.packageName;
    const dest = destDirForExtension(name, {}, repoRoot);

    // (A) on-disk presence + (C) on-disk<->lock coherence.
    if (!existsSync(dest)) {
      findings.push(
        finding("missing-on-disk", `no on-disk directory at ${relFromRoot(repoRoot, dest)}`, {
          packageName: name,
          remediation: "Run `cinatra extensions acquire-prod` (or rebuild the image) to materialize the locked set.",
        }),
      );
    } else {
      const marker = readAcquisitionMarker(dest);
      if (!marker) {
        findings.push(
          finding(
            "lock-mismatch",
            `on-disk directory ${relFromRoot(repoRoot, dest)} is NOT acquisition-managed ` +
              `(no acquisition marker) — a locked package must be materialized by acquire-prod, not a dev clone`,
            {
              packageName: name,
              remediation:
                "Remove the unmanaged directory and run `cinatra extensions acquire-prod`, or fix the image bake.",
            },
          ),
        );
      } else if (marker.resolvedSha !== entry.resolvedSha || marker.treeSha256 !== entry.treeSha256) {
        findings.push(
          finding(
            "lock-mismatch",
            `on-disk acquisition marker pins ${short(marker.resolvedSha)}/${short(marker.treeSha256)} but the lock ` +
              `pins ${short(entry.resolvedSha)}/${short(entry.treeSha256)}`,
            {
              packageName: name,
              remediation: "Run `cinatra extensions acquire-prod` to re-acquire at the locked pin.",
            },
          ),
        );
      } else {
        // Marker agrees with the lock — re-hash the tree to prove the bytes
        // still match (a marker is a CLAIM, not proof).
        let actualTreeSha = null;
        try {
          actualTreeSha = computeTreeSha256FromDir(dest);
        } catch (err) {
          findings.push(
            finding(
              "lock-mismatch",
              `on-disk tree at ${relFromRoot(repoRoot, dest)} could not be hashed ` +
                `(${err instanceof Error ? err.message : String(err)})`,
              {
                packageName: name,
                remediation: "Inspect the directory for symlinks/foreign entries, then re-run `acquire-prod`.",
              },
            ),
          );
        }
        if (actualTreeSha !== null && actualTreeSha !== entry.treeSha256) {
          findings.push(
            finding(
              "lock-mismatch",
              `on-disk tree hash ${short(actualTreeSha)} does not match the locked treeSha256 ` +
                `${short(entry.treeSha256)} (content changed after acquisition)`,
              {
                packageName: name,
                remediation: "Run `cinatra extensions acquire-prod` to restore the locked bytes.",
              },
            ),
          );
        }
        // package.json name/version vs the lock.
        const pkgManifestPath = path.join(dest, "package.json");
        if (existsSync(pkgManifestPath)) {
          try {
            const m = JSON.parse(readFileSync(pkgManifestPath, "utf8"));
            if (m.name !== name || m.version !== entry.packageVersion) {
              findings.push(
                finding(
                  "lock-mismatch",
                  `on-disk package.json declares ${m.name}@${m.version} but the lock pins ` +
                    `${name}@${entry.packageVersion}`,
                  { packageName: name, remediation: "Run `cinatra extensions acquire-prod` to re-acquire." },
                ),
              );
            }
          } catch {
            findings.push(
              finding("lock-mismatch", `on-disk package.json is unreadable/invalid JSON`, {
                packageName: name,
                remediation: "Run `cinatra extensions acquire-prod` to re-acquire.",
              }),
            );
          }
        }
      }
    }

    // (C) locked version must satisfy the declared pin (catches D!=C via the
    // seed range even when the on-disk/DB versions are internally consistent).
    const range = declaredRanges.get(name) ?? null;
    if (range && !(await versionSatisfiesRange(entry.packageVersion, range))) {
      findings.push(
        finding(
          "lock-mismatch",
          `locked version ${entry.packageVersion} does not satisfy the declared pin "${range}" in cinatra.extensions`,
          {
            packageName: name,
            remediation:
              "Align the cinatra.extensions pin with the locked version, or re-lock a satisfying version.",
          },
        ),
      );
    }

    // (D) loader-registered/activated.
    if (liveByName) {
      const rows = liveByName.get(name) ?? [];
      if (rows.length === 0) {
        findings.push(
          finding(
            "loader-missing",
            `no live (active|locked) installed_extension row — the loader did not register/activate this package`,
            {
              packageName: name,
              remediation:
                "Check the instance boot logs (required-activation-assert) — a required package that failed to " +
                "activate aborts a prod boot; on a running instance, re-run acquisition + restart the instance.",
            },
          ),
        );
      } else {
        // PRESENCE (above) is the app's activation predicate verbatim: a live
        // active|locked row == registered/activated. The checks below are
        // ADDITIONAL coherence assertions layered on top of that predicate (they
        // never redefine "activated"), each a distinct real prod incoherence:
        //
        //   - a required package's live row(s) must be flagged
        //     `required_in_prod=true` — otherwise the canonical lifecycle
        //     primitive never auto-locks it in prod (it is not locked-in-prod).
        if (!rows.some((r) => r.requiredInProd)) {
          findings.push(
            finding(
              "loader-missing",
              `registered but the live installed_extension row(s) do NOT carry required_in_prod=true — the row is not ` +
                `treated as a required-in-prod install (it will not be locked-in-prod)`,
              {
                packageName: name,
                remediation:
                  "Re-run the required-extension install path so the row is flagged required_in_prod (locked-in-prod).",
              },
            ),
          );
        }
        //   - the REGISTERED version must match the LOCK (D vs C): a verifiable
        //     version must equal the locked version (codex round-1 rebut — a
        //     range-only check misses D!=C). An unverifiable non-registry source
        //     is checked the SAME way the app does (verifyRequiredInProdInstalled):
        //     it must satisfy the declared pin, else it is a mismatch — never a
        //     silent pass.
        const range = declaredRanges.get(name) ?? null;
        for (const row of rows) {
          const rowVersion = extractRowVersion(row.source);
          if (rowVersion === null) {
            findings.push(
              finding(
                "loader-missing",
                `a live row's source is version-unverifiable (${describeSource(row.source)}); a required-in-prod ` +
                  `install must expose a verifiable version to prove it matches the locked ${entry.packageVersion}`,
                {
                  packageName: name,
                  remediation:
                    "A required-in-prod row must come from a verdaccio or static-bundle-anchor source; re-install " +
                    "via the required-extension path.",
                },
              ),
            );
          } else if (rowVersion !== entry.packageVersion) {
            // A verifiable version that differs from the lock is drift — even if
            // it still satisfies the declared range (that would be C!=D within a
            // range, still a real registered-vs-locked incoherence).
            const withinRange = range ? await versionSatisfiesRange(rowVersion, range) : true;
            findings.push(
              finding(
                "loader-missing",
                `a live row is version ${rowVersion} but the lock pins ${entry.packageVersion} — the registered ` +
                  `install drifted from the locked set` +
                  (range && !withinRange ? ` (and does not satisfy the declared pin "${range}")` : ""),
                {
                  packageName: name,
                  remediation: "Re-acquire + re-install the locked version, then restart the instance.",
                },
              ),
            );
          }
        }
      }
    }

    // (E) WayFlow-visible — AGENT-kind required packages only.
    const kind = deriveLockedPackageKind(name, dest);
    if (kind === "agent") {
      const wf = verifyWayflowVisibility(name, installDir, seedManifest);
      if (wf) findings.push(wf);
    }
  }

  return { ok: findings.length === 0, findings, checked: lock.packages.length };
}

/**
 * WayFlow visibility for a single agent-kind locked package: prove a
 * materialized, seed-owned, manifest-listed OAS tree exists under `installDir`.
 * The slug dir is <vendor>/<slug> derived from the scoped package name
 * (@vendor/slug). `seedManifest` is `{ readable, slugs }` from readSeedManifest:
 * an UNREADABLE manifest (absent/malformed) can NOT confirm membership, so it
 * fails the check (never a silent pass). Returns a finding on any gap, or null
 * when visible. Pure read.
 */
export function verifyWayflowVisibility(packageName, installDir, seedManifest) {
  const m = String(packageName).match(/^@([^/]+)\/(.+)$/);
  if (!m) return null; // a non-scoped name never reaches here (lock validates the shape)
  const vendor = m[1];
  const slug = m[2];
  const slugKey = `${vendor}/${slug}`;
  const slugDir = path.join(installDir, vendor, slug);
  const oasPath = path.join(slugDir, OAS_REL_PATH);

  if (!existsSync(oasPath)) {
    return finding(
      "wayflow-missing",
      `no materialized OAS at ${slugKey}/${OAS_REL_PATH.split(path.sep).join("/")} under the agent-install dir ` +
        `— WayFlow cannot see this required agent`,
      {
        packageName,
        remediation:
          "Rebuild/redeploy the image so the required-extension OAS seed is materialized, or verify " +
          "CINATRA_AGENT_INSTALL_DIR points at the deploy-managed (not a stale/frozen) agent dir.",
      },
    );
  }
  if (!existsSync(path.join(slugDir, SEED_OWNERSHIP_MARKER_FILENAME))) {
    return finding(
      "wayflow-missing",
      `the OAS tree at ${slugKey} is present but NOT seed-owned (no ${SEED_OWNERSHIP_MARKER_FILENAME}) — it is not ` +
        `the image-materialized required tree WayFlow expects`,
      {
        packageName,
        remediation:
          "Let the boot required-extension-materialize phase own this slug (redeploy), or remove the foreign tree.",
      },
    );
  }
  if (!seedManifest.readable) {
    return finding(
      "wayflow-missing",
      `the OAS tree at ${slugKey} exists but the WayFlow seed ${SEED_MANIFEST_FILENAME} is absent/unreadable, so its ` +
        `membership in the current required seed set cannot be confirmed`,
      {
        packageName,
        remediation:
          "Rebuild/redeploy the image so a valid required-OAS seed manifest.json is materialized alongside the OAS trees.",
      },
    );
  }
  if (!seedManifest.slugs.has(slugKey)) {
    return finding(
      "wayflow-missing",
      `${slugKey} is not listed in the WayFlow seed ${SEED_MANIFEST_FILENAME} — the materialized tree is not part of ` +
        `the current required seed set`,
      {
        packageName,
        remediation: "Rebuild the required-OAS seed so the manifest lists this slug, then redeploy.",
      },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** The pinned RANGE per declared `cinatra.extensions` name (name@range split). */
export function readDeclaredRanges(packageJsonPath) {
  const ranges = new Map();
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const raw = Array.isArray(pkg?.cinatra?.extensions) ? pkg.cinatra.extensions : [];
    for (const entry of raw) {
      if (typeof entry !== "string" || entry.trim().length === 0) continue;
      const trimmed = entry.trim();
      const at = trimmed.lastIndexOf("@");
      if (at <= 0) {
        ranges.set(trimmed, null); // bare / unpinned
      } else {
        const name = trimmed.slice(0, at);
        const range = trimmed.slice(at + 1).trim();
        ranges.set(name, range.length > 0 ? range : null);
      }
    }
  } catch {
    /* unreadable -> empty map; the bijection check still runs off the names set */
  }
  return ranges;
}

function relFromRoot(repoRoot, dest) {
  return path.relative(repoRoot, dest).split(path.sep).join("/");
}

function short(hex) {
  return typeof hex === "string" && hex.length > 12 ? `${hex.slice(0, 12)}…` : String(hex);
}

function describeSource(source) {
  if (!source || typeof source !== "object") return "unknown source";
  if (typeof source.type === "string") return `type=${source.type}`;
  if (typeof source.path === "string") return `path=${source.path}`;
  return "unrecognized source shape";
}
