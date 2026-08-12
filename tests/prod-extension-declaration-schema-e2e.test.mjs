// cinatra#2331 step 0 — REAL-COMMAND E2E over the schema-discriminated host
// extension declaration reader.
//
// The sibling suite (prod-extension-declaration-schema.test.mjs) asserts the
// discrimination in-process, at the reader and through the exported
// acquire/verify functions. THIS suite drives the published entry point
// `bin/cinatra.mjs` as a real CHILD PROCESS against fixture manifests — the
// repo standard for a CLI change (a real command run, not only unit tests).
// It is the only level that also exercises what the prod `docker build`
// actually depends on: the dispatch wiring (command-table descriptor ->
// HANDLERS["extensions.acquire-prod"] / runExtensionsVerifyProd), the
// `getRepoRoot()` checkout resolution, the `--json` report envelope, and the
// PROCESS EXIT CODE the build step gates on.
//
// Why the discrimination exists: the host is collapsing its two parallel
// declarations into ONE `cinatra.systemExtensions` carrying RANGED specs, and
// the prod image build runs this CLI at a lockfile-pinned version — so it must
// read BOTH shapes across the cutover. A presence-based
// `systemExtensions ?? extensions` would be UNSOUND: every PRE-cutover manifest
// already carries a BARE-name `systemExtensions`, which would win with every
// range nulled and silently stop enforcing "the locked version satisfies the
// declared pin".
//
// Every case below is NEGATIVE-CONTROLLED: each asserts an observable that
// FLIPS when the wrong declaration wins — and for the shapes where a wrong
// winner would otherwise pass SILENTLY (no range -> no pin check), the assertion
// is the presence of the pin finding plus the declaration it names, so a silent
// pass fails the test instead of going unnoticed.
//
// TRANSITIONAL, per cinatra#2331 step 0: "The transitional discrimination is
// removed in the CLI release after the cutover." Delete this suite together
// with the reader it covers.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { computeTreeSha256FromDir } from "../src/prod-extension-acquisition.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

const ACQ_MARKER = ".cinatra-acquired.json";
const SEED_MARKER = ".cinatra-required-seed.json";
const LOCK_FILENAME = "cinatra-required-extensions.lock.json";

const AGENT_PKG = "@cinatra-ai/demo-agent";
const CONNECTOR_PKG = "@cinatra-ai/demo-connector";
const AGENT_VER = "0.1.3";
const CONNECTOR_VER = "0.2.0";

// The SATISFIED pins, and a DELIBERATELY VIOLATED agent pin used to prove the
// declared range actually reached the version-satisfaction check. `^0.9.0`
// cannot admit 0.1.3 under npm 0.x caret semantics; a NULL range (the failure
// mode this whole discrimination prevents) skips the check entirely.
const AGENT_RANGE_OK = "^0.1.0";
const AGENT_RANGE_VIOLATED = "^0.9.0";
const CONNECTOR_RANGE_OK = "^0.2.0";

const roots = [];

afterAll(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Build a synthetic cinatra checkout the real CLI accepts: the two sentinels
 * `getRepoRoot()`/`isCinatraRepoRoot()` anchor on (pnpm-workspace.yaml +
 * packages/migrations/package.json), a root manifest carrying the DECLARATION
 * SHAPE under test, acquisition-managed extension trees stamped to match, the
 * committed acquisition lock, and the boot-projected agent runtime mount.
 *
 * `lockDrops` omits a package from the lock, which drives the
 * lock<->declaration bijection.
 */
function buildCheckout(cinatraBlock, { lockDrops = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-decl-e2e-2331-"));
  roots.push(root);

  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const migDir = path.join(root, "packages", "migrations");
  mkdirSync(migDir, { recursive: true });
  writeFileSync(
    path.join(migDir, "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }, null, 2) + "\n",
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "cinatra-workspace", cinatra: cinatraBlock }, null, 2) + "\n",
  );

  const packages = [
    { name: AGENT_PKG, version: AGENT_VER, sha: "a".repeat(40), kind: "agent" },
    { name: CONNECTOR_PKG, version: CONNECTOR_VER, sha: "b".repeat(40), kind: "connector" },
  ];

  const lockEntries = [];
  for (const p of packages) {
    const [, vendor, slug] = p.name.match(/^@([^/]+)\/(.+)$/);
    const dir = path.join(root, "extensions", vendor, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: p.name, version: p.version, cinatra: { kind: p.kind } }, null, 2) + "\n",
    );
    writeFileSync(path.join(dir, "index.mjs"), `export const kind = ${JSON.stringify(p.kind)};\n`);
    // The marker is stamped AFTER the payload and excluded from the fold, so
    // the hash below is the one acquire/verify recompute from disk.
    const treeSha256 = computeTreeSha256FromDir(dir);
    writeFileSync(
      path.join(dir, ACQ_MARKER),
      JSON.stringify({ resolvedSha: p.sha, treeSha256, acquiredAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
    );
    if (!lockDrops.includes(p.name)) {
      lockEntries.push({
        packageName: p.name,
        repo: `cinatra-ai/${slug}`,
        resolvedSha: p.sha,
        packageVersion: p.version,
        treeSha256,
      });
    }
  }
  writeFileSync(
    path.join(root, LOCK_FILENAME),
    JSON.stringify({ schemaVersion: 1, packages: lockEntries }, null, 2) + "\n",
  );

  // The boot-projected agent runtime mount: `<extension-data-root>/.agent-mount`.
  // Materializing it keeps `wayflow-missing` out of the report so the only
  // ambient finding is the (expected) DB-absent `loader-missing` one.
  const mount = path.join(root, "data", ".agent-mount");
  const [, agentVendor, agentSlug] = AGENT_PKG.match(/^@([^/]+)\/(.+)$/);
  const slugDir = path.join(mount, agentVendor, agentSlug);
  mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
  writeFileSync(path.join(slugDir, "cinatra", "oas.json"), '{"openapi":"3.0.0"}\n');
  writeFileSync(path.join(slugDir, SEED_MARKER), '{"owner":"required-seed"}\n');
  writeFileSync(
    path.join(mount, "manifest.json"),
    JSON.stringify({ kind: "agent", slugs: [{ vendor: agentVendor, slug: agentSlug }] }, null, 2) + "\n",
  );

  return root;
}

/**
 * Run the REAL entry point against a fixture checkout. The environment is
 * deliberately DB-less: `verify-prod` reports the unreachable loader as its own
 * finding class rather than aborting, so the on-disk/lock/declaration checks
 * this suite is about still run — and no test here needs (or touches) a
 * database or any credential.
 */
function runCli(root, args) {
  const env = {
    ...process.env,
    CINATRA_REPO_ROOT: root,
    CINATRA_EXTENSION_DATA_ROOT: path.join(root, "data"),
    CI: "1",
  };
  delete env.SUPABASE_DB_URL;
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: root,
    env,
    timeout: 60_000,
  });
}

/**
 * `verify-prod --json` -> the parsed report envelope. stdout is parsed WHOLE
 * (not scanned for a `{`), so `--json` is held to its actual contract: the
 * envelope is the only thing on stdout, machine-consumable as-is.
 *
 * `lockFindings` is the whole `lock-mismatch` class — both the pin violations
 * and the lock<->declaration bijection breaks — because which of the two a
 * shape produces is itself a signal of which declaration won.
 *
 * NOTE on exit codes here: these runs are deliberately DB-less, so the
 * `loader-missing` finding alone already forces exit 1. A verify exit-code
 * assertion therefore covers the CLI's non-zero WIRING, not the cause — the
 * discrimination itself is carried by the finding assertions below. (The
 * `acquire-prod` cases do gate exit 0 vs 1 on the discrimination directly.)
 */
function verifyJson(root) {
  const res = runCli(root, ["extensions", "verify-prod", "--json"]);
  expect(res.error, `spawn failed: ${res.error}`).toBeUndefined();
  const report = JSON.parse(res.stdout.trim());
  return { res, report, lockFindings: report.findings.filter((f) => f.class === "lock-mismatch") };
}

describe("cinatra#2331 step 0 — declaration discrimination through the real CLI", () => {
  // ------------------------------------------------------------------
  // Shape 2 — NEW SINGLE-LIST (ranged `systemExtensions`, no legacy list):
  // the post-cutover manifest. The new schema must win AND its ranges must
  // reach the pin check.
  // ------------------------------------------------------------------

  it("NEW single-list, coherent: `acquire-prod` exits 0 and `verify-prod` reports no lock-mismatch", () => {
    const root = buildCheckout({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    const acquire = runCli(root, ["extensions", "acquire-prod"]);
    expect(acquire.status, `stdout: ${acquire.stdout}\nstderr: ${acquire.stderr}`).toBe(0);
    expect(acquire.stdout).toMatch(/0 downloaded, 2 verified in place/);

    // NEGATIVE CONTROL: had the new list been rejected, `declared` would be
    // EMPTY and both locked packages would surface as "locked but not declared".
    const { report, lockFindings } = verifyJson(root);
    expect(lockFindings, JSON.stringify(report.findings, null, 2)).toEqual([]);
    expect(report.checked).toBe(2);
  });

  it("NEW single-list, violated pin: the finding names `cinatra.systemExtensions`", () => {
    const root = buildCheckout({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    const { res, lockFindings } = verifyJson(root);
    expect(res.status).toBe(1);
    expect(lockFindings).toHaveLength(1);
    expect(lockFindings[0].packageName).toBe(AGENT_PKG);
    expect(lockFindings[0].detail).toContain(`does not satisfy the declared pin "${AGENT_RANGE_VIOLATED}"`);
    expect(lockFindings[0].detail).toContain("cinatra.systemExtensions");
  });

  it("NEW single-list vs a lock that drops a package: `acquire-prod` refuses, naming `cinatra.systemExtensions`", () => {
    const root = buildCheckout(
      { systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`] },
      { lockDrops: [CONNECTOR_PKG] },
    );

    const acquire = runCli(root, ["extensions", "acquire-prod"]);
    expect(acquire.status).toBe(1);
    const said = acquire.stderr + acquire.stdout;
    expect(said).toContain("the acquisition lock does not match cinatra.systemExtensions");
    expect(said).toContain(`declared but not locked: ${CONNECTOR_PKG}`);
  });

  // ------------------------------------------------------------------
  // Shape 1 — LEGACY DUAL-LIST: the PRE-cutover manifest verbatim (bare
  // `systemExtensions` + ranged `extensions`). This is the shape a naive
  // presence-based fallback breaks SILENTLY.
  // ------------------------------------------------------------------

  it("LEGACY dual-list, violated pin: the bare `systemExtensions` does NOT win — the legacy pin still fires", () => {
    const root = buildCheckout({
      systemExtensions: [AGENT_PKG, CONNECTOR_PKG], // bare names — the pre-cutover shape
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    // NEGATIVE CONTROL, the load-bearing one: under `systemExtensions ??
    // extensions` the bare list wins, every range is null, the pin check is
    // skipped, and this run would report NO lock-mismatch at all — a silent
    // pass in the path that builds the production image.
    const { res, lockFindings } = verifyJson(root);
    expect(res.status).toBe(1);
    expect(lockFindings).toHaveLength(1);
    expect(lockFindings[0].detail).toContain(`does not satisfy the declared pin "${AGENT_RANGE_VIOLATED}"`);
    expect(lockFindings[0].detail).toContain("cinatra.extensions");
    expect(lockFindings[0].detail).not.toContain("cinatra.systemExtensions");
  });

  it("LEGACY dual-list whose bare list is INCOMPLETE: `acquire-prod` reads the legacy list and exits 0", () => {
    const root = buildCheckout({
      systemExtensions: [AGENT_PKG], // bare AND missing the connector
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    // NEGATIVE CONTROL: had the bare list won, the connector would be "locked
    // but not declared" and the image build would die on a healthy manifest.
    const acquire = runCli(root, ["extensions", "acquire-prod"]);
    expect(acquire.status, `stdout: ${acquire.stdout}\nstderr: ${acquire.stderr}`).toBe(0);
    expect(acquire.stdout).toMatch(/0 downloaded, 2 verified in place/);
  });

  // ------------------------------------------------------------------
  // Shape 3 — EMPTY: an empty array must never VACUOUSLY select the new
  // schema. Winning on empty would ERASE the declaration: no pin would ever be
  // checked, and the lock<->declaration bijection would then report the entire
  // locked set as undeclared instead of naming the one real defect.
  // ------------------------------------------------------------------

  it("EMPTY `systemExtensions`: never wins — the legacy list is read and its violated pin still fires", () => {
    const root = buildCheckout({
      systemExtensions: [],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    // NEGATIVE CONTROL: a vacuous win would declare NOTHING — the pin finding
    // would vanish and both packages would flip to "locked but not declared".
    const { lockFindings } = verifyJson(root);
    expect(lockFindings).toHaveLength(1);
    expect(lockFindings[0].detail).toContain("cinatra.extensions");
    expect(lockFindings.some((f) => f.detail.includes("bijection"))).toBe(false);
  });

  // ------------------------------------------------------------------
  // Shape 4 — MIXED (some ranged, some bare): one rangeless entry disqualifies
  // the whole list; a partial win would drop exactly that entry's pin.
  // ------------------------------------------------------------------

  it("MIXED `systemExtensions`: falls back to the legacy list, ranges intact", () => {
    const root = buildCheckout({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, CONNECTOR_PKG], // second entry bare
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    // NEGATIVE CONTROL: an entry-wise (rather than list-wise) selection would
    // read the SATISFIED `^0.1.0` from the mixed list and report nothing.
    const { lockFindings } = verifyJson(root);
    expect(lockFindings).toHaveLength(1);
    expect(lockFindings[0].detail).toContain(`does not satisfy the declared pin "${AGENT_RANGE_VIOLATED}"`);
    expect(lockFindings[0].detail).toContain("cinatra.extensions");
  });

  // ------------------------------------------------------------------
  // Shape 5 — MALFORMED: not an array at all.
  // ------------------------------------------------------------------

  it("MALFORMED `systemExtensions` (not an array): falls back to the legacy list", () => {
    const root = buildCheckout({
      systemExtensions: "nope",
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });

    const { lockFindings } = verifyJson(root);
    expect(lockFindings).toHaveLength(1);
    expect(lockFindings[0].detail).toContain("cinatra.extensions");
  });

  // ------------------------------------------------------------------
  // Shape 6 — RANGELESS with NO legacy list: a botched cutover (the field was
  // renamed without adding ranges). Nothing valid remains to read, so the run
  // must fail LOUD rather than pass on an empty declaration.
  // ------------------------------------------------------------------

  it("RANGELESS `systemExtensions` and no legacy list: `acquire-prod` fails loud, never vacuously", () => {
    const root = buildCheckout({ systemExtensions: [AGENT_PKG, CONNECTOR_PKG] });

    const acquire = runCli(root, ["extensions", "acquire-prod"]);
    expect(acquire.status).toBe(1);
    const said = acquire.stderr + acquire.stdout;
    // "none" resolved -> the diagnostic names BOTH candidate declarations, and
    // the bijection reports every locked package as undeclared.
    expect(said).toContain("cinatra.systemExtensions / cinatra.extensions");
    expect(said).toContain("locked but not declared");
    expect(said).toContain(AGENT_PKG);
    expect(said).toContain(CONNECTOR_PKG);
  });
});
