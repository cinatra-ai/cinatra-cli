// Fail-closed upgrade preflight — mocked-transport INTEGRATION. Drives the full
// runPreflight orchestrator + runPreflightCommand entrypoint over an injected
// transport + a real on-disk ledger, with NO container boot (cinatra-cli#128).
// The real Docker/verify-stack E2E is host-fenced (see the PR's E2E script).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_UPGRADE_MATRIX } from "../src/upgrade-matrix.mjs";
import { runPreflight, runPreflightCommand, VERDICTS } from "../src/upgrade-preflight.mjs";
import { makeEntry, recordDeployed, readLedger, writeLedger } from "../src/version-ledger.mjs";

let dir;
const SLUG = "acme";
const VOL = { name: "cinatra_acme_pgdata", createdAt: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cinatra-preflight-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seedLedger(service, version, volume = VOL) {
  const l = recordDeployed(readLedger(SLUG, dir).ledger, makeEntry({ service, image: `postgres:${version}`, dataFormatVersion: version, volume }));
  writeLedger(l, dir);
}

// A transport that reports the seeded volume as live + present. `overrides`
// tunes individual seams (probe/marker/state/inspect/profile).
function transportFor(volume = VOL, overrides = {}) {
  return {
    inspectVolume: () => ({ Name: volume.name, CreatedAt: volume.createdAt }),
    volumeState: () => "present",
    probeVersion: () => null,
    readMarker: () => null,
    profileEnabled: () => true,
    ...overrides,
  };
}

describe("runPreflight — ledger-driven detection over a mocked transport", () => {
  it("recorded version matching the target → OK (safe to recreate)", () => {
    seedLedger("postgres", "18");
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor(),
    });
    expect(rep.ok).toBe(true);
    expect(rep.findings).toHaveLength(0);
    expect(rep.results[0].verdict).toBe(VERDICTS.PASS);
  });

  it("recorded older major facing a supported target → STOP, report NOT ok", () => {
    seedLedger("nango-db", "15");
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "nango-db", target: "17", volumeName: VOL.name }],
      transport: transportFor(),
    });
    expect(rep.ok).toBe(false);
    expect(rep.results[0].verdict).toBe(VERDICTS.STOP);
    expect(rep.results[0].migration).toBe("cinatra instance db upgrade-major");
  });

  it("a volume recreated out-of-band (identity mismatch) → FAIL CLOSED", () => {
    seedLedger("postgres", "17", VOL);
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor({ name: VOL.name, createdAt: "2026-12-31T00:00:00Z" }),
    });
    expect(rep.ok).toBe(false);
    expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(rep.results[0].reason).toMatch(/volume identity/i);
  });

  it("a disabled profile is skipped (no probe/inspect consulted)", () => {
    seedLedger("postgres", "18");
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor(VOL, { profileEnabled: () => false }),
    });
    expect(rep.results[0].verdict).toBe(VERDICTS.SKIPPED);
    expect(rep.ok).toBe(true);
  });

  it("a legacy install (no ledger entry) falls back to a live probe", () => {
    // No seedLedger — the ledger file is absent. Detection falls to the probe.
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "nango-db", target: "17", volumeName: VOL.name }],
      transport: transportFor(VOL, { probeVersion: () => "15" }),
    });
    expect(rep.results[0].verdict).toBe(VERDICTS.STOP); // 15 → 17 supported, pending
  });

  it("a legacy install falls back to the authoritative PG_VERSION marker when no probe", () => {
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor(VOL, { probeVersion: () => null, readMarker: () => "17" }),
    });
    expect(rep.results[0].verdict).toBe(VERDICTS.STOP);
    expect(rep.results[0].detectionSource).toBe("marker");
  });

  it("a malformed ledger fails EVERY service closed (never treated as no-record)", () => {
    // Corrupt the ledger file directly on disk.
    seedLedger("postgres", "18");
    writeFileSync(path.join(dir, `${SLUG}.json`), "{ corrupt");
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor(),
    });
    expect(rep.ok).toBe(false);
    expect(rep.results.every((r) => r.verdict === VERDICTS.FAIL_CLOSED)).toBe(true);
  });

  it("mixed services report the worst as blocking while clean ones pass", () => {
    seedLedger("postgres", "18");
    seedLedger("nango-db", "15");
    const rep = runPreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [
        { service: "postgres", target: "18", volumeName: VOL.name },
        { service: "nango-db", target: "17", volumeName: VOL.name },
      ],
      transport: transportFor(),
    });
    expect(rep.ok).toBe(false);
    expect(rep.findings).toHaveLength(1);
    expect(rep.findings[0].service).toBe("nango-db");
  });
});

// A tiny helper local to this file (avoids importing fs twice at top scope in a
// way that shadows). Writes an intentionally-corrupt ledger.
function require_write_garbage(d, slug) {
  const { writeFileSync } = require_fs();
  writeFileSync(path.join(d, `${slug}.json`), "{ corrupt");
}
function require_fs() {
  // eslint-disable-next-line no-undef
  return require_fs_cache || (require_fs_cache = load_fs());
}
let require_fs_cache = null;
function load_fs() {
  // Use a dynamic import synchronously is not possible; use node:fs via a static
  // import instead. (Declared below via the ESM import at file top would be
  // cleaner; kept local to avoid touching the import block.)
  return globalThis.__cinatra_fs || (globalThis.__cinatra_fs = fsModule());
}
function fsModule() {
  return { writeFileSync: fsWrite };
}
import { writeFileSync as fsWrite } from "node:fs";

describe("runPreflightCommand — entrypoint exit codes + rendering", () => {
  function discoverFrom(ledgerDir, slug) {
    return () => {
      const { ledger } = readLedger(slug, ledgerDir);
      return Object.values(ledger.services).map((e) => ({ service: e.service, volumeName: e.volume?.name ?? null, target: null }));
    };
  }

  it("integrity-only run (no --target) exits 0 and renders an OK line", () => {
    seedLedger("postgres", "18");
    const out = [];
    const code = runPreflightCommand([], {
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverFrom(dir, SLUG),
      transport: transportFor(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Preflight OK/);
  });

  it("a modeled --target hop that STOPS exits 1", () => {
    seedLedger("nango-db", "15");
    const out = [];
    const code = runPreflightCommand(["--target", "nango-db=17"], {
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverFrom(dir, SLUG),
      transport: transportFor(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/BLOCKED/);
  });

  it("--json emits the raw structured report", () => {
    seedLedger("postgres", "17");
    const out = [];
    const code = runPreflightCommand(["--json", "--target", "postgres=18"], {
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverFrom(dir, SLUG),
      transport: transportFor(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.results[0].verdict).toBe(VERDICTS.STOP);
    expect(parsed.ok).toBe(false);
  });

  it("a scoped authorization flips the STOP to authorized-proceed (exit 0)", () => {
    seedLedger("postgres", "17");
    const out = [];
    const code = runPreflightCommand(["--target", "postgres=18"], {
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverFrom(dir, SLUG),
      transport: transportFor(),
      authorizations: [{ service: "postgres", source: "17", target: "18" }],
      log: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/AUTHORIZED/);
  });

  it("a bad arg exits 2 without running the preflight", () => {
    const errs = [];
    const code = runPreflightCommand(["--bogus"], { slug: SLUG, ledgerDir: dir, discover: () => [], transport: transportFor(), logError: (s) => errs.push(s) });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/Unexpected argument/);
  });

  it("--service filters discovery to the named service", () => {
    seedLedger("postgres", "18");
    seedLedger("nango-db", "15");
    const out = [];
    const code = runPreflightCommand(["--json", "--service", "postgres"], {
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverFrom(dir, SLUG),
      transport: transportFor(),
      log: (s) => out.push(s),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].service).toBe("postgres");
  });
});
