// cinatra#789 — `cinatra extensions verify-prod` coherence verifier.
//
// Exercises the REAL verify code path over a REAL temp filesystem (real
// acquisition markers, real tree hashes computed by the same fold the
// acquisition module uses, real WayFlow OAS trees + seed marker + manifest) and
// an injected pg-client stub returning the REAL `installed_extension` row shape.
// One scenario per mismatch class + the fully-coherent (exit-0) case, plus the
// DB-unreachable hard-fail. Non-mutation is asserted by snapshotting the tree
// before/after each run.
//
// The E2E run of the actual `bin/cinatra.mjs extensions verify-prod` against a
// live Postgres is a separate manual step (documented in the PR); this suite is
// the fast, hermetic regression net over every branch.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeTreeSha256FromDir } from "../src/prod-extension-acquisition.mjs";
import {
  MISMATCH_CLASSES,
  verifyProdRequiredExtensions,
  versionSatisfiesRange,
} from "../src/prod-extension-verify.mjs";

const ACQ_MARKER = ".cinatra-acquired.json";
const SEED_MARKER = ".cinatra-required-seed.json";

// A fake pg client: returns the injected rows for the installed_extension
// SELECT; throws for anything else. `throwOnQuery` simulates a DB failure.
function fakeDbClient(rows, { throwOnQuery = false } = {}) {
  return {
    async query() {
      if (throwOnQuery) throw new Error("connection refused");
      return { rows };
    },
    async end() {},
  };
}

function liveRow(packageName, version, { status = "locked", requiredInProd = true } = {}) {
  return {
    package_name: packageName,
    status,
    source: { type: "verdaccio", version },
    required_in_prod: requiredInProd,
  };
}

// Snapshot every plain-file path + its bytes under root — proves non-mutation.
function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.isFile()) out[path.relative(root, full)] = readFileSync(full);
    }
  };
  walk(root);
  return out;
}

describe("verifyProdRequiredExtensions (cinatra#789)", () => {
  let root; // workspace root: package.json + lock + extensions/
  let installDir; // agent-install dir (WayFlow mount): <vendor>/<slug>/cinatra/oas.json

  const AGENT_PKG = "@cinatra-ai/demo-agent";
  const CONNECTOR_PKG = "@cinatra-ai/demo-connector";
  const AGENT_VER = "0.1.3";
  const CONNECTOR_VER = "0.2.0";
  const AGENT_SHA = "a".repeat(40);
  const CONNECTOR_SHA = "b".repeat(40);

  // Materialize an acquisition-managed extension dir with a real payload + a
  // marker matching the lock, and return the computed treeSha256.
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

  // Materialize a WayFlow-visible agent OAS tree (oas.json + seed marker), and
  // add the slug to the seed manifest.
  function materializeWayflow(pkgName) {
    const m = pkgName.match(/^@([^/]+)\/(.+)$/);
    const slugDir = path.join(installDir, m[1], m[2]);
    mkdirSync(path.join(slugDir, "cinatra"), { recursive: true });
    writeFileSync(path.join(slugDir, "cinatra", "oas.json"), '{"openapi":"3.0.0"}\n');
    writeFileSync(path.join(slugDir, SEED_MARKER), '{"owner":"required-seed"}\n');
    return { vendor: m[1], slug: m[2] };
  }

  function writeSeedManifest(slugs) {
    writeFileSync(
      path.join(installDir, "manifest.json"),
      JSON.stringify({ kind: "agent", slugs }, null, 2) + "\n",
    );
  }

  // Build the fully-coherent baseline: root manifest declaring both packages,
  // lock pinning both, on-disk trees for both, WayFlow tree+manifest for the
  // agent only (connectors don't materialize an OAS tree).
  function buildCoherent() {
    const agent = materializeExtension(AGENT_PKG, AGENT_VER, AGENT_SHA, "agent");
    const connector = materializeExtension(CONNECTOR_PKG, CONNECTOR_VER, CONNECTOR_SHA, "connector");
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "cinatra-workspace",
          cinatra: { extensions: [`${AGENT_PKG}@^0.1.0`, `${CONNECTOR_PKG}@^0.2.0`] },
        },
        null,
        2,
      ) + "\n",
    );
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
    writeSeedManifest([slug]);
    return { agent, connector };
  }

  const coherentRows = () => [liveRow(AGENT_PKG, AGENT_VER), liveRow(CONNECTOR_PKG, CONNECTOR_VER)];

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "cinatra-verify-789-"));
    installDir = mkdtempSync(path.join(tmpdir(), "cinatra-verify-789-install-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  });

  it("all coherent → ok:true, no findings, exit-0 semantics", async () => {
    buildCoherent();
    const beforeRoot = snapshotTree(root);
    const beforeInstall = snapshotTree(installDir);
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
      schemaName: "cinatra",
    });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(2);
    // NON-MUTATION: BOTH the workspace tree AND the WayFlow install dir are
    // byte-identical after the run (the verifier never writes on either side).
    expect(snapshotTree(root)).toEqual(beforeRoot);
    expect(snapshotTree(installDir)).toEqual(beforeInstall);
  });

  it("missing-on-disk: a locked package has no on-disk dir", async () => {
    buildCoherent();
    rmSync(path.join(root, "extensions", "cinatra-ai", "demo-connector"), { recursive: true, force: true });
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find((x) => x.class === "missing-on-disk");
    expect(f).toBeTruthy();
    expect(f.packageName).toBe(CONNECTOR_PKG);
  });

  it("extra-seed-owned-dir: an acquisition-managed dir not in the lock (markerless dev clone NOT flagged)", async () => {
    buildCoherent();
    // A rogue acquisition-managed dir (has a marker) NOT present in the lock.
    materializeExtension("@cinatra-ai/rogue-agent", "9.9.9", "c".repeat(40), "agent");
    // A markerless dir (dev clone / user install) must NOT be flagged.
    mkdirSync(path.join(root, "extensions", "cinatra-ai", "dev-clone"), { recursive: true });
    writeFileSync(
      path.join(root, "extensions", "cinatra-ai", "dev-clone", "package.json"),
      '{"name":"@cinatra-ai/dev-clone","version":"0.0.1"}\n',
    );
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    expect(report.ok).toBe(false);
    const extras = report.findings.filter((x) => x.class === "extra-seed-owned-dir");
    expect(extras).toHaveLength(1);
    expect(extras[0].packageName).toBe("@cinatra-ai/rogue-agent");
    expect(report.findings.some((x) => x.packageName === "@cinatra-ai/dev-clone")).toBe(false);
  });

  it("lock-mismatch: on-disk tree drifted from the locked treeSha256", async () => {
    buildCoherent();
    // Mutate the connector's on-disk content AFTER the marker was stamped.
    writeFileSync(
      path.join(root, "extensions", "cinatra-ai", "demo-connector", "index.mjs"),
      "export const k = 'TAMPERED';\n",
    );
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find((x) => x.class === "lock-mismatch" && x.packageName === CONNECTOR_PKG);
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/tree hash/i);
  });

  it("lock-mismatch: seed<->lock bijection broken (declared-not-locked)", async () => {
    buildCoherent();
    // Declare a third package the lock does not pin.
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    pkg.cinatra.extensions.push("@cinatra-ai/ghost-agent@^0.1.0");
    writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find(
      (x) => x.class === "lock-mismatch" && x.packageName === "@cinatra-ai/ghost-agent",
    );
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/bijection/i);
  });

  it("loader-missing: no live installed_extension row for a locked package", async () => {
    buildCoherent();
    // The connector has no live row.
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient([liveRow(AGENT_PKG, AGENT_VER)]),
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find((x) => x.class === "loader-missing" && x.packageName === CONNECTOR_PKG);
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/no live/i);
  });

  it("loader-missing: live row version drifted from the locked version", async () => {
    buildCoherent();
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient([liveRow(AGENT_PKG, AGENT_VER), liveRow(CONNECTOR_PKG, "0.2.5")]),
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find((x) => x.class === "loader-missing" && x.packageName === CONNECTOR_PKG);
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/0\.2\.5.*0\.2\.0|drifted/i);
  });

  it("loader-missing: DB unreachable is a hard finding (never a silent pass)", async () => {
    buildCoherent();
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: null,
      dbError: "SUPABASE_DB_URL is not set",
    });
    expect(report.ok).toBe(false);
    const f = report.findings.find((x) => x.class === "loader-missing");
    expect(f).toBeTruthy();
    expect(f.detail).toMatch(/unreachable/i);
  });

  it("loader-missing: query failure is a hard finding", async () => {
    buildCoherent();
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient([], { throwOnQuery: true }),
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((x) => x.class === "loader-missing")).toBe(true);
  });

  it("wayflow-missing: agent OAS tree absent (connector NOT flagged)", async () => {
    buildCoherent();
    // Remove the agent's materialized OAS tree.
    rmSync(path.join(installDir, "cinatra-ai", "demo-agent"), { recursive: true, force: true });
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    expect(report.ok).toBe(false);
    const wf = report.findings.filter((x) => x.class === "wayflow-missing");
    expect(wf).toHaveLength(1);
    expect(wf[0].packageName).toBe(AGENT_PKG); // connector never produces a wayflow finding
  });

  it("wayflow-missing: OAS present but not seed-owned", async () => {
    buildCoherent();
    rmSync(path.join(installDir, "cinatra-ai", "demo-agent", SEED_MARKER), { force: true });
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    const wf = report.findings.find((x) => x.class === "wayflow-missing" && x.packageName === AGENT_PKG);
    expect(wf).toBeTruthy();
    expect(wf.detail).toMatch(/seed-owned/i);
  });

  it("wayflow-missing: OAS present + seed-owned but the seed manifest is absent (membership unconfirmable)", async () => {
    buildCoherent();
    // Remove the seed manifest entirely; the OAS tree + seed marker remain. A
    // missing manifest must NOT silently pass — membership can't be confirmed.
    rmSync(path.join(installDir, "manifest.json"), { force: true });
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    const wf = report.findings.find((x) => x.class === "wayflow-missing" && x.packageName === AGENT_PKG);
    expect(wf).toBeTruthy();
    expect(wf.detail).toMatch(/manifest.*absent\/unreadable|cannot be confirmed/i);
  });

  it("wayflow-missing: OAS present + seed-owned but the slug is absent from a readable manifest", async () => {
    buildCoherent();
    // A readable manifest that lists a DIFFERENT slug → membership fails.
    writeSeedManifest([{ vendor: "cinatra-ai", slug: "some-other-agent" }]);
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient(coherentRows()),
    });
    const wf = report.findings.find((x) => x.class === "wayflow-missing" && x.packageName === AGENT_PKG);
    expect(wf).toBeTruthy();
    expect(wf.detail).toMatch(/not listed in the WayFlow seed/i);
  });

  it("loader read honors a non-default schema (quoted verbatim, not silently defaulted)", async () => {
    buildCoherent();
    let seenSql = "";
    const capturingClient = {
      async query(sql) {
        seenSql = sql;
        return { rows: coherentRows() };
      },
      async end() {},
    };
    await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: capturingClient,
      schemaName: "tenant-42",
    });
    // The actual schema is quoted into the query — NOT silently replaced by "cinatra".
    expect(seenSql).toContain('"tenant-42".installed_extension');
    expect(seenSql).not.toContain('"cinatra".installed_extension');
  });

  it("multiple mismatch classes surface simultaneously, each distinct", async () => {
    buildCoherent();
    rmSync(path.join(root, "extensions", "cinatra-ai", "demo-connector"), { recursive: true, force: true });
    rmSync(path.join(installDir, "cinatra-ai", "demo-agent"), { recursive: true, force: true });
    const report = await verifyProdRequiredExtensions({
      repoRoot: root,
      installDir,
      dbClient: fakeDbClient([liveRow(AGENT_PKG, AGENT_VER)]), // connector loader-missing too
    });
    expect(report.ok).toBe(false);
    const classes = new Set(report.findings.map((f) => f.class));
    expect(classes.has("missing-on-disk")).toBe(true);
    expect(classes.has("loader-missing")).toBe(true);
    expect(classes.has("wayflow-missing")).toBe(true);
    // every class is one of the documented, non-overlapping set
    for (const f of report.findings) expect(MISMATCH_CLASSES).toContain(f.class);
  });
});

describe("versionSatisfiesRange (npm 0.x caret semantics)", () => {
  it("^0.1.0 admits 0.1.3 but not 0.2.0", async () => {
    expect(await versionSatisfiesRange("0.1.3", "^0.1.0")).toBe(true);
    expect(await versionSatisfiesRange("0.2.0", "^0.1.0")).toBe(false);
  });
  it("* admits any concrete version; garbage fails closed", async () => {
    expect(await versionSatisfiesRange("9.9.9", "*")).toBe(true);
    expect(await versionSatisfiesRange("not-a-version", "^0.1.0")).toBe(false);
  });
});
