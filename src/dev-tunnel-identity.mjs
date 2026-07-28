// ---------------------------------------------------------------------------
// Dev-tunnel identity → runtime-state keying (cinatra#2172).
//
// `cinatra instance tunnel` used to write ONE hardcoded runtime directory (the
// reserved `dev-main` slug) no matter which instance invoked it. Combined with
// a hostname derivation that fell through to the reserved `cinatra-main`
// identity, ANY unregistered instance would silently squat the dev main's
// serve config, rendered compose file and compose project.
//
// This module owns the two halves of the fix that belong to the CLI:
//
//   Identity → slug
//     A sanctioned identity (from the connector's single-source-of-truth
//     classifier) maps to a runtime slug that is UNIQUE PER IDENTITY and
//     valid under `isValidSlug` (max 30 chars). The reserved `dev-main`
//     slug is preserved for — and reachable ONLY by — the declared main
//     identity, so its already-provisioned state is never orphaned.
//
//   Runtime-directory ownership
//     Because no mapping from a 63-char hostname into a 30-char slug can be
//     collision-free, the runtime directory additionally carries a manifest
//     naming the FULL canonical identity. Any mismatch REFUSES rather than
//     sharing the directory.
//
// Plain ESM `.mjs`, hermetically testable — the classifier arrives as an
// already-loaded module object, so nothing here reaches the extensions tree.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * The RESERVED per-main runtime slug. It is a valid slug shape but is NEVER
 * registered in the clone registry, and — post-cinatra#2172 — it is reachable
 * ONLY from the explicitly declared main identity.
 */
export const DEV_MAIN_SLUG = "dev-main";

/**
 * The `classifyDevTailscaleIdentity` result-shape version this CLI understands.
 * The classifier is loaded out of the OPERATOR'S on-disk extension tree, so it
 * can be older or newer than this CLI; an unknown version is unsupported and
 * fails closed rather than being guessed at.
 */
export const DEV_TUNNEL_IDENTITY_CONTRACT_VERSION = 1;

/** Ownership manifest written into each identity's runtime directory. */
export const DEV_TUNNEL_MANIFEST_FILE = "tunnel-identity.json";
export const DEV_TUNNEL_MANIFEST_VERSION = 1;

const OUTDATED_HELPER_MESSAGE =
  "The installed tunnel-identity helper is too old: it does not export " +
  "`classifyDevTailscaleIdentity`. Refusing to provision — the retired " +
  "derivation silently fell back to the reserved main identity. Update the " +
  "extension (`cinatra instance setup dev`) and retry.";

/**
 * Classify this instance's tunnel identity using an ALREADY-LOADED helper
 * module. Fails closed on an old or unrecognised helper: it must never fall
 * back to the retired derivation, and it must never infer safety from a
 * result that merely "doesn't look like main".
 *
 * @param {Record<string, unknown> | null | undefined} helperModule
 * @param {object} args
 * @param {string | null | undefined} args.dbUrl
 * @param {string | null | undefined} args.schema
 * @param {string | null | undefined} [args.mainDatabase]
 * @returns {{ ok: boolean, kind: string, hostname: string | null, key: string | null,
 *             code: string | null, reason: string | null, version: number }}
 */
export function classifyDevTunnelIdentityFromModule(
  helperModule,
  { dbUrl, schema, mainDatabase },
) {
  const classify = helperModule?.classifyDevTailscaleIdentity;
  if (typeof classify !== "function") {
    throw new Error(OUTDATED_HELPER_MESSAGE);
  }
  const identity = classify({ dbUrl, schema, mainDatabase });
  if (!identity || typeof identity !== "object") {
    throw new Error(
      "The installed tunnel-identity helper returned no classification. " +
        "Refusing to provision.",
    );
  }
  if (identity.version !== DEV_TUNNEL_IDENTITY_CONTRACT_VERSION) {
    throw new Error(
      `The installed tunnel-identity helper speaks contract version ` +
        `${String(identity.version)}; this CLI understands ` +
        `${DEV_TUNNEL_IDENTITY_CONTRACT_VERSION}. Refusing to provision — ` +
        `update the CLI or the extension so both agree.`,
    );
  }
  if (identity.ok === true && (!identity.hostname || !identity.key)) {
    throw new Error(
      "The installed tunnel-identity helper reported a sanctioned identity " +
        "without a hostname/key. Refusing to provision.",
    );
  }
  // Module-boundary check on the RESERVED kind. `kind: "main"` is what unlocks
  // the reserved runtime slug, so this CLI does not take the helper's word for
  // it on shape alone.
  if (identity.ok === true && identity.kind === "main") {
    // The caller KNOWS whether a declaration was supplied. Under the contract
    // the reserved identity is declared, never inferred — so no declaration
    // means no main, whatever the helper says.
    if (String(mainDatabase ?? "").trim() === "") {
      throw new Error(
        "The installed tunnel-identity helper claimed the RESERVED main " +
          "identity for an instance that declared none. Refusing to provision " +
          "under the reserved identity.",
      );
    }
    // A well-formed main identity is keyed on its endpoint
    // (`main:<host:port/database>`), which only the declaration path produces.
    if (typeof identity.key !== "string" || !/^main:[^\s]+\/[^\s/]+$/.test(identity.key)) {
      throw new Error(
        "The installed tunnel-identity helper claimed the RESERVED main " +
          "identity without an endpoint-scoped key. Refusing to provision " +
          "under the reserved identity.",
      );
    }
  }
  return identity;
}

const BASE32_LOWER = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * RFC 4648 base32, lowercase, unpadded. Chosen over hex so 80 bits fit in the
 * 16 slug characters that remain after the readable prefix.
 *
 * @param {Uint8Array} bytes
 * @param {number} chars  how many output characters to produce
 * @returns {string}
 */
function base32Lower(bytes, chars) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === chars) return out;
    }
  }
  if (bits > 0 && out.length < chars) {
    out += BASE32_LOWER[(value << (5 - bits)) & 31];
  }
  return out.slice(0, chars);
}

/**
 * The runtime slug for a sanctioned identity.
 *
 *   - declared main → the reserved `dev-main` (its already-provisioned state
 *     keeps working; no other identity can ever produce this value)
 *   - anything else → `dev-<readable>-<80-bit digest>`, always <= 30 chars
 *
 * The digest covers the identity's canonical KEY (kind + unsanitised
 * discriminator), not the sanitised hostname, so two instances whose hostnames
 * sanitise identically still get different runtime state.
 *
 * @param {{ ok?: boolean, kind?: string, hostname?: string | null, key?: string | null }} identity
 * @returns {string}
 */
export function devTunnelRuntimeSlug(identity) {
  if (!identity || identity.ok !== true || !identity.key) {
    throw new Error(
      "devTunnelRuntimeSlug requires a sanctioned identity — an instance with " +
        "no identity must be refused before any runtime path is computed.",
    );
  }
  // The reserved slug is unlocked ONLY by a main identity whose key carries an
  // endpoint (the declaration path). Re-checked here so the reserved slug can
  // never be reached by a caller that skipped the module-boundary gate.
  if (identity.kind === "main") {
    if (!String(identity.key).startsWith("main:")) {
      throw new Error(
        "A main identity without an endpoint-scoped key cannot claim the " +
          "reserved tunnel runtime slug.",
      );
    }
    return DEV_MAIN_SLUG;
  }

  const readable = String(identity.hostname ?? "")
    .toLowerCase()
    .replace(/^cinatra-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 9)
    .replace(/-+$/, "");
  const digest = base32Lower(createHash("sha256").update(identity.key).digest(), 16);
  return readable ? `dev-${readable}-${digest}` : `dev-${digest}`;
}

/**
 * @param {string} runtimeDir
 * @returns {string}
 */
export function devTunnelManifestPath(runtimeDir) {
  return path.join(runtimeDir, DEV_TUNNEL_MANIFEST_FILE);
}

/**
 * Read the ownership manifest. Never throws — an unreadable/garbage manifest
 * reads as absent, and the ownership assertion below treats an EXISTING
 * directory with no readable manifest as unproven (refused for every identity
 * except the reserved main, whose directory predates the manifest).
 *
 * @param {string} runtimeDir
 * @returns {{ version?: number, key?: string, kind?: string, hostname?: string, slug?: string } | null}
 */
export function readDevTunnelManifest(runtimeDir) {
  try {
    const parsed = JSON.parse(readFileSync(devTunnelManifestPath(runtimeDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Refuse to touch a runtime directory that belongs to a DIFFERENT identity.
 * Called BEFORE any filesystem or compose mutation.
 *
 * @param {object} args
 * @param {string} args.runtimeDir
 * @param {{ key?: string | null, hostname?: string | null }} args.identity
 * @param {string} args.slug
 */
export function assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity }) {
  assertRuntimeDirIsRealDirectory(runtimeDir);
  // The adoption authority is derived from the IDENTITY, never from a
  // caller-supplied slug — a caller that passed the reserved slug alongside a
  // non-main identity would otherwise buy itself adoption rights.
  const slug = devTunnelRuntimeSlug(identity);
  const manifest = readDevTunnelManifest(runtimeDir);
  if (!manifest) {
    // A directory that exists but proves no owner is only adoptable by the
    // reserved main identity, whose state predates this manifest. Any other
    // identity refuses rather than writing over state it cannot prove it owns.
    if (existsSync(runtimeDir) && slug !== DEV_MAIN_SLUG) {
      throw new Error(
        `Tunnel runtime directory ${runtimeDir} exists but carries no ownership ` +
          `manifest, so its owner cannot be proven. Refusing to reuse it. Remove ` +
          `it if it is stale.`,
      );
    }
    if (existsSync(runtimeDir)) assertAdoptableState(runtimeDir, identity);
    return;
  }
  if (manifest.version !== DEV_TUNNEL_MANIFEST_VERSION) {
    throw new Error(
      `Tunnel runtime directory ${runtimeDir} carries an ownership manifest of ` +
        `unsupported version ${String(manifest.version)} (this CLI writes ` +
        `${DEV_TUNNEL_MANIFEST_VERSION}). Refusing to reuse it.`,
    );
  }
  if (manifest.key !== identity.key) {
    throw new Error(
      `Tunnel runtime directory ${runtimeDir} belongs to a DIFFERENT dev ` +
        `instance (recorded identity "${String(manifest.key)}", this instance is ` +
        `"${String(identity.key)}"). Refusing to overwrite tunnel state this ` +
        `instance does not own.`,
    );
  }
}

/**
 * A runtime directory must be a REAL directory this process resolves
 * directly — never a symlink, which would redirect every subsequent state
 * write somewhere the ownership manifest does not describe.
 *
 * @param {string} runtimeDir
 */
function assertRuntimeDirIsRealDirectory(runtimeDir) {
  // Check the directory AND its two owning ancestors (`~/.cinatra/clones`), so
  // a swapped ancestor cannot redirect the whole tree. This is a best-effort
  // check, not a TOCTOU-proof one: Node exposes no portable `openat`/
  // `O_NOFOLLOW`, so a local process that can already write inside the 0700
  // `~/.cinatra` tree is out of scope (it has the user's own privileges).
  const parent = path.dirname(runtimeDir);
  for (const candidate of [path.dirname(parent), parent, runtimeDir]) {
    let stats = null;
    try {
      stats = lstatSync(candidate);
    } catch {
      continue; // absent — nothing to validate yet
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Tunnel runtime path ${candidate} is a symlink. Refusing to write tunnel ` +
          `state through it (the ownership manifest could not describe where the ` +
          `state actually lands). Replace it with a real directory.`,
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `Tunnel runtime path ${candidate} exists and is not a directory. Refusing ` +
          `to use it.`,
      );
    }
  }
}

/**
 * Pre-manifest state is only adoptable when the state ITSELF names this
 * identity. A pre-ownership-tracking (legacy) Tailscale serve config carried
 * the hostname the sidecar was provisioned for, so a directory whose serve
 * config names a different node demonstrably belongs to someone else.
 *
 * cinatra-cli#177 made the serve config identity-INDEPENDENT (its keys are the
 * `${TS_CERT_DOMAIN}` placeholder, never a hostname) — but every post-#177
 * DEV-TUNNEL provisioning writes the ownership manifest BEFORE the serve
 * config (clone provisioning does not use this manifest at all), so a
 * manifest-less directory with a serve config is by construction legacy
 * (hostname-keyed) and this check still discriminates the population it can
 * actually meet. A placeholder-keyed serve config WITHOUT a manifest can only
 * be tampered/hand-assembled state; `serve.includes(hostname)` is false for
 * it, so adoption refuses — deliberately fail-closed.
 *
 * @param {string} runtimeDir
 * @param {{ hostname?: string | null }} identity
 */
function assertAdoptableState(runtimeDir, identity) {
  let serve = null;
  try {
    serve = readFileSync(path.join(runtimeDir, "tailscale-serve.json"), "utf8");
  } catch {
    return; // no provisioned serve config — nothing contradicts this identity
  }
  const hostname = String(identity.hostname ?? "");
  if (hostname && !serve.includes(hostname)) {
    throw new Error(
      `Tunnel runtime directory ${runtimeDir} carries no ownership manifest and ` +
        `its serve config does not name "${hostname}", so it was provisioned for ` +
        `a DIFFERENT node. Refusing to adopt it — stop that tunnel and remove the ` +
        `directory.`,
    );
  }
}

/**
 * CLAIM the runtime directory for this identity, exclusively.
 *
 * The claim is the `O_CREAT|O_EXCL` write of the manifest itself — one atomic
 * syscall, so two concurrent runs targeting the same slug cannot both believe
 * they own it (the loser reads the winner's manifest and either matches or
 * refuses). There is deliberately NO temp-file-plus-rename dance: a fixed temp
 * name is itself a cross-process clobber, and rename REPLACES rather than
 * claims.
 *
 * Idempotent: an existing manifest for the SAME identity is left as is.
 *
 * @param {object} args
 * @param {string} args.runtimeDir
 * @param {{ kind?: string, hostname?: string | null, key?: string | null }} args.identity
 * @param {string} args.slug
 * @returns {{ claimed: boolean, adoptedPreManifestState: boolean }}
 */
export function claimDevTunnelRuntimeDir({ runtimeDir, identity }) {
  // The claim enforces the SAME authority rules as the pre-flight assertion —
  // it is self-contained, so a caller that skipped the assertion (or raced a
  // directory into existence after it) still cannot adopt a foreign directory.
  assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity });
  const slug = devTunnelRuntimeSlug(identity);

  // Pre-existing artifacts with no manifest = state provisioned before
  // ownership was tracked (only the reserved identity can reach this, and only
  // when the state does not name another node). The adoption is RECORDED
  // rather than silent: the retired bug could have written unregistered-
  // instance state here.
  const adoptedPreManifestState =
    existsSync(runtimeDir) && readDevTunnelManifest(runtimeDir) === null;

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const target = devTunnelManifestPath(runtimeDir);
  const body = `${JSON.stringify(
    {
      version: DEV_TUNNEL_MANIFEST_VERSION,
      kind: identity.kind,
      key: identity.key,
      hostname: identity.hostname,
      slug,
      ...(adoptedPreManifestState ? { adopted: "pre-manifest-state" } : {}),
    },
    null,
    2,
  )}\n`;

  // Publish COMPLETE-or-not-at-all, exclusively: write the whole body to a
  // per-invocation temp, then hard-LINK it into place. `link` fails EEXIST if
  // the target exists (so it claims rather than replaces, unlike `rename`) and
  // the target only ever becomes visible fully-written — a concurrent reader
  // can never observe a half-written manifest and mistake it for "unowned".
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
    try {
      linkSync(tmp, target);
      return { claimed: true, adoptedPreManifestState };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
  }
  // Someone already holds the claim (possibly this same identity from a
  // previous run, possibly a concurrent one). Re-verify rather than overwrite.
  assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity });
  return { claimed: false, adoptedPreManifestState: false };
}
