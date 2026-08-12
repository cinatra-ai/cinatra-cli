// cinatra#2331 step 0 — schema-discriminated host extension declaration reader.
//
// The host is collapsing its two parallel declarations into ONE
// `cinatra.systemExtensions` carrying RANGED specs. This published CLI is what
// the prod `docker build` runs (at a lockfile-pinned version), so it must read
// BOTH shapes across the cutover — and it must never mistake the PRE-cutover
// BARE-name `systemExtensions` (which already exists in every current manifest)
// for the new schema: doing so would drop every version range and silently
// disable the locked-version-satisfies-the-declared-pin check.
//
// Hence discrimination by SCHEMA, not presence: `systemExtensions` wins ONLY
// when it is a NON-EMPTY array whose EVERY entry is a valid ranged spec.
//
// The six shapes below are the full matrix; each is asserted BOTH at the reader
// (which declaration won, with what ranges) and — for the two shapes that
// decide prod behaviour — through the REAL `verifyProdRequiredExtensions` code
// path over a REAL temp filesystem, proving the pin check still fires.
//
// The same matrix is asserted one level out, through the actual `bin/cinatra.mjs`
// as a child process (dispatch wiring, checkout resolution, exit codes, `--json`
// envelope), in prod-extension-declaration-schema-e2e.test.mjs.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DECLARATION_SCHEMA,
  acquireProdRequiredExtensions,
  computeTreeSha256FromDir,
  readDeclaredExtensionSpecs,
  readDeclaredRequiredExtensionNames,
} from "../src/prod-extension-acquisition.mjs";
import { readDeclaredRanges, verifyProdRequiredExtensions } from "../src/prod-extension-verify.mjs";

const ACQ_MARKER = ".cinatra-acquired.json";
const SEED_MARKER = ".cinatra-required-seed.json";

const AGENT_PKG = "@cinatra-ai/demo-agent";
const CONNECTOR_PKG = "@cinatra-ai/demo-connector";
const AGENT_VER = "0.1.3";
const CONNECTOR_VER = "0.2.0";
const AGENT_SHA = "a".repeat(40);
const CONNECTOR_SHA = "b".repeat(40);

// The SATISFIED pins (baseline) and a DELIBERATELY VIOLATED agent pin used to
// prove the range actually reached the version-satisfaction check.
const AGENT_RANGE_OK = "^0.1.0";
const AGENT_RANGE_VIOLATED = "^0.9.0";
const CONNECTOR_RANGE_OK = "^0.2.0";

describe("host extension declaration: schema discrimination (cinatra#2331 step 0)", () => {
  let root;
  let installDir;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cinatra-decl-2331-"));
    installDir = mkdtempSync(path.join(tmpdir(), "cinatra-decl-2331-install-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  });

  function writeManifest(cinatraBlock) {
    const p = path.join(root, "package.json");
    writeFileSync(p, JSON.stringify({ name: "cinatra-workspace", cinatra: cinatraBlock }, null, 2) + "\n");
    return p;
  }

  // ------------------------------------------------------------------
  // Shape matrix — the reader itself.
  // ------------------------------------------------------------------

  it("shape 1 — LEGACY DUAL-LIST (ranged `extensions` + bare `systemExtensions`): legacy wins, ranges kept", () => {
    const p = writeManifest({
      systemExtensions: [AGENT_PKG, CONNECTOR_PKG],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const { schema, specs } = readDeclaredExtensionSpecs(p);
    expect(schema).toBe(DECLARATION_SCHEMA.LEGACY);
    // The ranges MUST survive — a bare-name `systemExtensions` win would null them.
    expect([...specs]).toEqual([
      [AGENT_PKG, AGENT_RANGE_OK],
      [CONNECTOR_PKG, CONNECTOR_RANGE_OK],
    ]);
    expect([...readDeclaredRequiredExtensionNames(p)]).toEqual([AGENT_PKG, CONNECTOR_PKG]);
    expect(readDeclaredRanges(p).get(AGENT_PKG)).toBe(AGENT_RANGE_OK);
  });

  it("shape 2 — NEW SINGLE-LIST (ranged `systemExtensions`, no `extensions`): new schema wins, ranges kept", () => {
    const p = writeManifest({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const { schema, specs } = readDeclaredExtensionSpecs(p);
    expect(schema).toBe(DECLARATION_SCHEMA.SYSTEM);
    expect([...specs]).toEqual([
      [AGENT_PKG, AGENT_RANGE_OK],
      [CONNECTOR_PKG, CONNECTOR_RANGE_OK],
    ]);
    expect([...readDeclaredRequiredExtensionNames(p)]).toEqual([AGENT_PKG, CONNECTOR_PKG]);
    expect(readDeclaredRanges(p).get(CONNECTOR_PKG)).toBe(CONNECTOR_RANGE_OK);
  });

  it("shape 3 — EMPTY `systemExtensions` never vacuously selects the new schema", () => {
    // …with a legacy list present: legacy wins.
    const withLegacy = writeManifest({
      systemExtensions: [],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`],
    });
    const a = readDeclaredExtensionSpecs(withLegacy);
    expect(a.schema).toBe(DECLARATION_SCHEMA.LEGACY);
    expect([...a.specs]).toEqual([[AGENT_PKG, AGENT_RANGE_OK]]);

    // …with NO legacy list: nothing is declared (an empty set, not a silent
    // "new schema with zero entries" — the lock<->declaration bijection then
    // fails loud, which is exactly the fail-closed outcome we want).
    const noLegacy = writeManifest({ systemExtensions: [] });
    const b = readDeclaredExtensionSpecs(noLegacy);
    expect(b.schema).toBe(DECLARATION_SCHEMA.NONE);
    expect(b.specs.size).toBe(0);

    // …and an EMPTY legacy list is still "the legacy declaration, empty".
    const bothEmpty = writeManifest({ systemExtensions: [], extensions: [] });
    const c = readDeclaredExtensionSpecs(bothEmpty);
    expect(c.schema).toBe(DECLARATION_SCHEMA.LEGACY);
    expect(c.specs.size).toBe(0);
  });

  it("shape 4 — MIXED `systemExtensions` (some ranged, some bare): falls back to legacy", () => {
    const p = writeManifest({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, CONNECTOR_PKG],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const { schema, specs } = readDeclaredExtensionSpecs(p);
    expect(schema).toBe(DECLARATION_SCHEMA.LEGACY);
    expect(specs.get(CONNECTOR_PKG)).toBe(CONNECTOR_RANGE_OK);
  });

  it("shape 5 — MALFORMED `systemExtensions`: falls back to legacy (or to nothing)", () => {
    const legacy = [`${AGENT_PKG}@${AGENT_RANGE_OK}`];
    // Not an array at all.
    expect(readDeclaredExtensionSpecs(writeManifest({ systemExtensions: "nope", extensions: legacy })).schema).toBe(
      DECLARATION_SCHEMA.LEGACY,
    );
    // An object.
    expect(
      readDeclaredExtensionSpecs(writeManifest({ systemExtensions: { a: 1 }, extensions: legacy })).schema,
    ).toBe(DECLARATION_SCHEMA.LEGACY);
    // Non-string / empty-string members.
    expect(
      readDeclaredExtensionSpecs(writeManifest({ systemExtensions: [null, 42, "  "], extensions: legacy })).schema,
    ).toBe(DECLARATION_SCHEMA.LEGACY);
    // TRAILING `@` (a name with an EMPTY range) is not a ranged spec.
    expect(
      readDeclaredExtensionSpecs(writeManifest({ systemExtensions: [`${AGENT_PKG}@`], extensions: legacy })).schema,
    ).toBe(DECLARATION_SCHEMA.LEGACY);
    // An UNSCOPED name is not a shape this acquisition layout supports.
    expect(
      readDeclaredExtensionSpecs(writeManifest({ systemExtensions: [`demo-agent@${AGENT_RANGE_OK}`], extensions: legacy }))
        .schema,
    ).toBe(DECLARATION_SCHEMA.LEGACY);
    // A DUPLICATED name is malformed for a name-keyed declaration: the second
    // entry's range would silently overwrite the first (codex round-0 catch).
    expect(
      readDeclaredExtensionSpecs(
        writeManifest({
          systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`],
          extensions: legacy,
        }),
      ).schema,
    ).toBe(DECLARATION_SCHEMA.LEGACY);
    // …and with no legacy to fall back to, nothing is declared (fails loud
    // downstream at the bijection) rather than pinning on an arbitrary range.
    const dupOrphan = readDeclaredExtensionSpecs(
      writeManifest({
        systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`],
      }),
    );
    expect(dupOrphan.schema).toBe(DECLARATION_SCHEMA.NONE);
    expect(dupOrphan.specs.size).toBe(0);
    // Malformed with NO legacy to fall back to → nothing declared.
    const orphan = readDeclaredExtensionSpecs(writeManifest({ systemExtensions: [`${AGENT_PKG}@`] }));
    expect(orphan.schema).toBe(DECLARATION_SCHEMA.NONE);
    expect(orphan.specs.size).toBe(0);
    // An unreadable / absent manifest is "nothing to cross-check", never a throw.
    const missing = readDeclaredExtensionSpecs(path.join(root, "does-not-exist.json"));
    expect(missing.schema).toBe(DECLARATION_SCHEMA.NONE);
    expect(missing.specs.size).toBe(0);
    writeFileSync(path.join(root, "broken.json"), "{ not json");
    expect(readDeclaredExtensionSpecs(path.join(root, "broken.json")).schema).toBe(DECLARATION_SCHEMA.NONE);
  });

  it("shape 6 — RANGELESS `systemExtensions` (all bare names): falls back to legacy", () => {
    const p = writeManifest({
      systemExtensions: [AGENT_PKG, CONNECTOR_PKG],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    expect(readDeclaredExtensionSpecs(p).schema).toBe(DECLARATION_SCHEMA.LEGACY);

    // Rangeless with NO legacy: nothing declared (never a rangeless "win").
    const orphan = readDeclaredExtensionSpecs(writeManifest({ systemExtensions: [AGENT_PKG, CONNECTOR_PKG] }));
    expect(orphan.schema).toBe(DECLARATION_SCHEMA.NONE);
    expect(orphan.specs.size).toBe(0);
  });

  // ------------------------------------------------------------------
  // Behaviour through the REAL verify path: the range must reach the
  // locked-version-satisfies-the-declared-pin check under BOTH schemas.
  // ------------------------------------------------------------------

  function materializeExtension(pkgName, version, resolvedSha, kind) {
    const m = pkgName.match(/^@([^/]+)\/(.+)$/);
    const dir = path.join(root, "extensions", m[1], m[2]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: pkgName, version, cinatra: { kind } }, null, 2) + "\n",
    );
    writeFileSync(path.join(dir, "index.mjs"), `export const k = ${JSON.stringify(kind)};\n`);
    const treeSha256 = computeTreeSha256FromDir(dir);
    writeFileSync(
      path.join(dir, ACQ_MARKER),
      JSON.stringify({ resolvedSha, treeSha256, acquiredAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n",
    );
    return { dir, treeSha256 };
  }

  function materializeWayflow(pkgName) {
    const m = pkgName.match(/^@([^/]+)\/(.+)$/);
    const slugDir = path.join(installDir, m[1], m[2]);
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), '{"openapi":"3.0.0"}\n');
    writeFileSync(path.join(slugDir, SEED_MARKER), '{"owner":"required-seed"}\n');
    return { vendor: m[1], slug: m[2] };
  }

  // A coherent root (both packages on disk + locked + WayFlow tree for the
  // agent) whose DECLARATION shape is supplied by the caller.
  function buildRoot(cinatraBlock) {
    const agent = materializeExtension(AGENT_PKG, AGENT_VER, AGENT_SHA, "agent");
    const connector = materializeExtension(CONNECTOR_PKG, CONNECTOR_VER, CONNECTOR_SHA, "connector");
    writeManifest(cinatraBlock);
    writeFileSync(
      path.join(root, "cinatra-required-extensions.lock.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          packages: [
            {
              packageName: AGENT_PKG,
              repo: "cinatra-ai/demo-agent",
              resolvedSha: AGENT_SHA,
              packageVersion: AGENT_VER,
              treeSha256: agent.treeSha256,
            },
            {
              packageName: CONNECTOR_PKG,
              repo: "cinatra-ai/demo-connector",
              resolvedSha: CONNECTOR_SHA,
              packageVersion: CONNECTOR_VER,
              treeSha256: connector.treeSha256,
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const slug = materializeWayflow(AGENT_PKG);
    writeFileSync(
      path.join(installDir, "manifest.json"),
      JSON.stringify({ kind: "agent", slugs: [slug] }, null, 2) + "\n",
    );
  }

  function fakeDbClient() {
    const rows = [
      { package_name: AGENT_PKG, status: "locked", source: { type: "verdaccio", version: AGENT_VER }, required_in_prod: true },
      {
        package_name: CONNECTOR_PKG,
        status: "locked",
        source: { type: "verdaccio", version: CONNECTOR_VER },
        required_in_prod: true,
      },
    ];
    return { async query() { return { rows }; }, async end() {} };
  }

  const runVerify = () =>
    verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(),
      schemaName: "cinatra",
    });

  it("NEW single-list: a coherent manifest verifies clean, and a violated pin is caught", async () => {
    buildRoot({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const ok = await runVerify();
    expect(ok.findings).toEqual([]);
    expect(ok.ok).toBe(true);

    // Same shape, agent pin no longer satisfied by the locked version.
    buildRoot({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const bad = await runVerify();
    const pinFinding = bad.findings.find((f) => f.detail.includes("does not satisfy the declared pin"));
    expect(pinFinding).toBeTruthy();
    expect(pinFinding.packageName).toBe(AGENT_PKG);
    // The message names the declaration actually read.
    expect(pinFinding.detail).toContain(DECLARATION_SCHEMA.SYSTEM);
  });

  it("LEGACY dual-list: the bare `systemExtensions` must NOT win — the legacy pin still fires", async () => {
    // The PRE-cutover manifest shape verbatim: bare names in systemExtensions,
    // ranged specs in extensions. If discrimination were presence-based, the
    // bare list would win with null ranges and this violation would go unseen.
    buildRoot({
      systemExtensions: [AGENT_PKG, CONNECTOR_PKG],
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_VIOLATED}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    const report = await runVerify();
    const pinFinding = report.findings.find((f) => f.detail.includes("does not satisfy the declared pin"));
    expect(pinFinding).toBeTruthy();
    expect(pinFinding.packageName).toBe(AGENT_PKG);
    expect(pinFinding.detail).toContain(DECLARATION_SCHEMA.LEGACY);
  });

  it("RANGELESS single-list with no legacy: bijection fails loud instead of passing empty", async () => {
    // Nothing is declared -> every locked package is "locked but not declared".
    buildRoot({ systemExtensions: [AGENT_PKG, CONNECTOR_PKG] });
    const report = await runVerify();
    const bijection = report.findings.filter((f) => f.detail.includes("bijection broken"));
    expect(bijection.map((f) => f.packageName).sort()).toEqual([AGENT_PKG, CONNECTOR_PKG].sort());
    expect(report.ok).toBe(false);
  });

  // ------------------------------------------------------------------
  // Behaviour through the REAL acquisition path (the prod `docker build`
  // cross-check): the same discrimination decides the lock bijection.
  // ------------------------------------------------------------------

  it("acquisition cross-check reads the NEW single-list and passes on a matching lock", async () => {
    buildRoot({
      systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    // Every locked package is already materialized with a matching marker, so
    // the acquisition re-VERIFIES on disk and downloads nothing (no network).
    const outcome = await acquireProdRequiredExtensions({ repoRoot: root, log: () => {} });
    expect(outcome.skipped).toBeFalsy();
    expect(outcome.results.map((r) => r.action)).toEqual(["verified-existing", "verified-existing"]);
  });

  it("acquisition cross-check fails loud when the NEW single-list drifts from the lock", async () => {
    buildRoot({ systemExtensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`] }); // connector dropped
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await expect(acquireProdRequiredExtensions({ repoRoot: root, log: () => {} })).rejects.toThrow(
      /does not match cinatra\.systemExtensions[\s\S]*locked but not declared: @cinatra-ai\/demo-connector/,
    );
  });

  it("acquisition cross-check still reads the LEGACY list on a pre-cutover manifest", async () => {
    buildRoot({
      systemExtensions: [AGENT_PKG], // bare AND incomplete: must be ignored
      extensions: [`${AGENT_PKG}@${AGENT_RANGE_OK}`, `${CONNECTOR_PKG}@${CONNECTOR_RANGE_OK}`],
    });
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const outcome = await acquireProdRequiredExtensions({ repoRoot: root, log: () => {} });
    expect(outcome.results.map((r) => r.action)).toEqual(["verified-existing", "verified-existing"]);
    // Sanity: the on-disk trees were not mutated by the re-verification.
    expect(JSON.parse(readFileSync(path.join(root, "extensions", "cinatra-ai", "demo-agent", "package.json"), "utf8")).version).toBe(
      AGENT_VER,
    );
  });
});
