// Recreate-path upgrade GATE (cinatra-cli#140). The install/refresh recreate
// paths route through this gate before any stateful container is recreated. The
// PURE decision (assertRecreateSafe / runRecreatePreflight) is driven over an
// INJECTED discover + transport — the SAME mocked-transport contract as
// upgrade-preflight-transport.test.mjs — and the docker-backed default
// (buildDeploymentPreflight) is exercised over a mocked `spawn`, so NO container
// (and no real Docker) is ever booted here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RecreatePreflightError,
  assertRecreateSafe,
  buildDeploymentPreflight,
  defaultAssertRecreateSafe,
  runRecreatePreflight,
} from "../src/recreate-preflight.mjs";
import { VERDICTS } from "../src/upgrade-preflight.mjs";
import { preflightRecreate } from "../src/install.mjs";
import { makeEntry, readLedger, recordDeployed, writeLedger } from "../src/version-ledger.mjs";

let dir;
const SLUG = "acme";
const VOL = { name: "cinatra_acme_pgdata", createdAt: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cinatra-recreate-pf-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function seedLedger(service, version, volume = VOL) {
  const l = recordDeployed(
    readLedger(SLUG, dir).ledger,
    makeEntry({ service, image: `postgres:${version}`, dataFormatVersion: version, volume }),
  );
  writeLedger(l, dir);
}

// A transport reporting the seeded volume as live + present; `overrides` tune the
// probe/marker/state/inspect/profile seams.
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

const discoverReturning = (services) => () => services;

// ---------------------------------------------------------------------------
// runRecreatePreflight — the pure decision (no throw).
// ---------------------------------------------------------------------------
describe("runRecreatePreflight — pure recreate-safety decision", () => {
  it("no stateful services discovered → trivially OK (nothing to gate)", () => {
    const d = runRecreatePreflight({ slug: SLUG, ledgerDir: dir, services: [], transport: transportFor() });
    expect(d.ok).toBe(true);
    expect(d.report).toBeNull();
  });

  it("a same-major recreate PASSES (report ok)", () => {
    seedLedger("postgres", "18");
    const d = runRecreatePreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "postgres", target: "18", volumeName: VOL.name }],
      transport: transportFor(),
    });
    expect(d.ok).toBe(true);
    expect(d.report.results[0].verdict).toBe(VERDICTS.PASS);
  });

  it("a recreate crossing a supported major boundary is NOT ok (STOP)", () => {
    seedLedger("nango-db", "15");
    const d = runRecreatePreflight({
      slug: SLUG,
      ledgerDir: dir,
      services: [{ service: "nango-db", target: "17", volumeName: VOL.name }],
      transport: transportFor(),
    });
    expect(d.ok).toBe(false);
    expect(d.report.results[0].verdict).toBe(VERDICTS.STOP);
  });
});

// ---------------------------------------------------------------------------
// assertRecreateSafe — the gate the recreate sites call (throws on a block).
// ---------------------------------------------------------------------------
describe("assertRecreateSafe — the recreate gate", () => {
  it("AC3: a fixture crossing a major boundary is REFUSED (throws RecreatePreflightError)", () => {
    seedLedger("nango-db", "15"); // pg15 data facing a pg17 recreate — the #1417 class.
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "nango-db", target: "17", volumeName: VOL.name }]),
        transport: transportFor(),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    // AC2: the refusal carries the per-family runbook deep link the standalone
    // preflight emits (cinatra-ai/cinatra#1421).
    expect(thrown.message).toContain("/self-hosting/upgrading-stateful-services#postgres");
    expect(thrown.message).toMatch(/upgrade-major/);
    // The structured report is attached (its findings are the blocking verdicts).
    expect(thrown.report.findings[0].service).toBe("nango-db");
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.STOP);
  });

  it("a NON-Postgres family refusal deep-links ITS family anchor, not #postgres", () => {
    // wordpress-db (MariaDB): any major change fails closed → the MariaDB anchor.
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "wordpress-db", target: "11.8", volumeName: VOL.name }]),
        transport: transportFor(VOL, { probeVersion: () => "11.4" }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.message).toContain("/self-hosting/upgrading-stateful-services#mariadb");
    expect(thrown.message).not.toContain("#postgres");
  });

  it("AC3: a same-major recreate PROCEEDS (no throw, ok)", () => {
    seedLedger("postgres", "18");
    const d = assertRecreateSafe({
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverReturning([{ service: "postgres", target: "18", volumeName: VOL.name }]),
      transport: transportFor(),
    });
    expect(d.ok).toBe(true);
  });

  it("AC3: ledger-absent falls back to the live PROBE adapter", () => {
    // No seedLedger — a legacy install. Detection falls to the probe (pg15 → 17).
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "nango-db", target: "17", volumeName: VOL.name }]),
        transport: transportFor(VOL, { probeVersion: () => "15" }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].detectionSource).toBe("probe");
  });

  it("AC3: ledger-absent falls back to the authoritative PG_VERSION MARKER when no probe", () => {
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "postgres", target: "18", volumeName: VOL.name }]),
        transport: transportFor(VOL, { probeVersion: () => null, readMarker: () => "17" }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].detectionSource).toBe("marker");
  });

  it("a fresh (empty/absent) volume PROCEEDS — no false block on a first install", () => {
    const d = assertRecreateSafe({
      slug: SLUG,
      ledgerDir: dir,
      discover: discoverReturning([{ service: "postgres", target: "18", volumeName: VOL.name }]),
      transport: transportFor(VOL, { volumeState: () => "absent" }),
    });
    expect(d.ok).toBe(true);
  });

  it("no services discovered PROCEEDS (nothing stateful to gate)", () => {
    const d = assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover: discoverReturning([]), transport: transportFor() });
    expect(d.ok).toBe(true);
  });

  it("FAIL-CLOSED: an unresolvable compose config (configResolved false) REFUSES — never a blind recreate", () => {
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([]),
        transport: transportFor(),
        configResolved: () => false,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.message).toMatch(/could not resolve the deployment's compose config/);
  });

  it("a null/invalid slug does NOT throw an 'invalid slug' ledger error — detection falls to the probe", () => {
    // An unrecorded attach checkout resolves to a null slug. The gate must still
    // run (no ledger key → probe/marker), never crash on the missing key.
    const ok = assertRecreateSafe({
      slug: null,
      ledgerDir: dir,
      discover: discoverReturning([{ service: "postgres", target: "18", volumeName: VOL.name }]),
      transport: transportFor(VOL, { probeVersion: () => "18" }), // matches target → PASS
    });
    expect(ok.ok).toBe(true);
    // …and a boundary is still caught with a null slug (probe pg15 → pg17).
    expect(() =>
      assertRecreateSafe({
        slug: null,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "nango-db", target: "17", volumeName: VOL.name }]),
        transport: transportFor(VOL, { probeVersion: () => "15" }),
      }),
    ).toThrow(RecreatePreflightError);
  });

  it("a downgrade recreate is BLOCKED (fail-closed direction)", () => {
    seedLedger("postgres", "18");
    expect(() =>
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "postgres", target: "17", volumeName: VOL.name }]),
        transport: transportFor(),
      }),
    ).toThrow(RecreatePreflightError);
  });

  it("an unreadable version on a non-empty un-ledgered volume FAILS CLOSED (never a guess)", () => {
    let thrown = null;
    try {
      assertRecreateSafe({
        slug: SLUG,
        ledgerDir: dir,
        discover: discoverReturning([{ service: "postgres", target: "18", volumeName: VOL.name }]),
        transport: transportFor(VOL, { probeVersion: () => null, readMarker: () => null }),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
  });
});

// ---------------------------------------------------------------------------
// buildDeploymentPreflight — the docker-backed default over a MOCKED `spawn`.
// Proves the real production wiring (resolved compose config = recreate intent →
// target version + actual volume name, docker volume inspect) end-to-end without
// a daemon.
// ---------------------------------------------------------------------------
describe("buildDeploymentPreflight — docker-backed discover + transport (mocked spawn)", () => {
  // A resolved `docker compose config --format json` with a Postgres service that
  // pins pg18 and mounts a named data volume — the recreate would deploy pg18.
  const COMPOSE_CONFIG = {
    name: "cinatra_acme",
    services: {
      postgres: {
        image: "postgres:18-alpine",
        volumes: [{ type: "volume", source: "cinatra-postgres", target: "/var/lib/postgresql" }],
      },
    },
    volumes: { "cinatra-postgres": { name: VOL.name } },
  };

  function fakeSpawn(handlers) {
    return (_cmd, args) => {
      const joined = args.join(" ");
      for (const [needle, out] of handlers) {
        if (joined.includes(needle)) {
          return { status: 0, stdout: typeof out === "function" ? out(args) : out, stderr: "" };
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  it("discover reads the compose config as the recreate INTENT (target + actual volume)", () => {
    const spawn = fakeSpawn([
      ["config --format json", JSON.stringify(COMPOSE_CONFIG)],
      ["volume inspect", JSON.stringify([{ Name: VOL.name, CreatedAt: VOL.createdAt }])],
    ]);
    const { discover, state } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    const services = discover();
    expect(state.configResolved).toBe(true);
    const pg = services.find((s) => s.service === "postgres");
    expect(pg).toBeTruthy();
    expect(pg.target).toBe("18");
    expect(pg.volumeName).toBe(VOL.name);
  });

  it("an existing pg17 volume (ledger) facing the pg18 recreate is REFUSED end-to-end (STOP)", () => {
    seedLedger("postgres", "17"); // recorded pg17 data; the compose config pins pg18.
    const spawn = fakeSpawn([
      ["config --format json", JSON.stringify(COMPOSE_CONFIG)],
      ["volume inspect", JSON.stringify([{ Name: VOL.name, CreatedAt: VOL.createdAt }])],
      // The emptiness probe (`docker run … ls -A`) must report a NON-empty volume,
      // else the data dir reads as a fresh init and the boundary is not gated.
      ["/__preflight_probe", "PG_VERSION\nbase\nglobal"],
    ]);
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    let thrown = null;
    try {
      assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover, transport });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    // The block is the supported-major STOP off the recorded ledger version, not
    // an unknown-version fail-closed — proving the ledger adapter drove it.
    expect(thrown.report.findings[0].service).toBe("postgres");
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.STOP);
    expect(thrown.report.findings[0].detectionSource).toBe("ledger");
  });

  it("an unresolvable compose config → configResolved false; defaultAssertRecreateSafe then REFUSES (fail-closed)", () => {
    const badSpawn = () => ({ status: 1, stdout: "", stderr: "no configuration file provided" });
    const { discover, state } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, ledgerDir: dir, spawn: badSpawn });
    const services = discover();
    expect(state.configResolved).toBe(false);
    expect(services).toEqual([]); // no ledger entries seeded → nothing discovered
    // The full production gate turns an inconclusive (unresolvable) config into a
    // hard refusal rather than a blind recreate.
    expect(() => defaultAssertRecreateSafe({ slug: SLUG, targetDir: dir, ledgerDir: dir, spawn: badSpawn })).toThrow(RecreatePreflightError);
  });

  it("finding-3: the marker read NEVER issues `docker run` against an ABSENT volume (no auto-create)", () => {
    // A legacy (no-ledger) deployment whose data volume is absent. `docker run
    // -v name:…` would AUTO-CREATE the named volume, mutating a fresh install —
    // the read must short-circuit on the absent inspect and issue no `run`.
    const calls = [];
    const spawn = (_cmd, args) => {
      calls.push(args.join(" "));
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) return { status: 1, stdout: "", stderr: "Error: No such volume: x" }; // ABSENT
      return { status: 0, stdout: "", stderr: "" };
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    discover();
    expect(transport.readMarker("postgres", "PG_VERSION")).toBeNull();
    expect(calls.some((c) => c.startsWith("run "))).toBe(false);
  });

  it("finding-3: a stable-identity marker read returns the PG_VERSION value", () => {
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) return { status: 0, stdout: JSON.stringify([{ Name: VOL.name, CreatedAt: VOL.createdAt }]), stderr: "" };
      if (joined.startsWith("run ")) return { status: 0, stdout: "17\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    discover();
    expect(transport.readMarker("postgres", "PG_VERSION")).toBe("17");
  });

  it("finding-3 (TOCTOU): a volume whose identity CHANGES mid-read is DISCARDED (read returns null → fail closed)", () => {
    // A concurrent teardown deletes the volume during the read; our mount auto-
    // recreates it (different CreatedAt). The before/after identity check catches
    // it and refuses to trust the reading.
    let inspectCall = 0;
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) {
        inspectCall += 1;
        const createdAt = inspectCall === 1 ? "2026-01-01T00:00:00Z" : "2026-09-09T00:00:00Z"; // recreated mid-read
        return { status: 0, stdout: JSON.stringify([{ Name: VOL.name, CreatedAt: createdAt }]), stderr: "" };
      }
      if (joined.startsWith("run ")) return { status: 0, stdout: "17\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    discover();
    expect(transport.readMarker("postgres", "PG_VERSION")).toBeNull();
  });

  it("finding-3 END-TO-END: a volume recreated mid-preflight yields a FAIL-CLOSED verdict, never a permissive PASS", () => {
    // No ledger, no live probe: detection would fall to the emptiness probe +
    // marker, both of which MOUNT the volume. A concurrent teardown recreates it
    // during the first mount (CreatedAt flips T1→T2). WITHOUT the identity guard
    // the emptiness probe reads "empty" → PASS (fail-open); WITH it, volumeState
    // fails closed to "present" and the unknown version → FAIL-CLOSED refusal.
    let recreated = false;
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) {
        const createdAt = recreated ? "2026-09-09T00:00:00Z" : "2026-01-01T00:00:00Z";
        return { status: 0, stdout: JSON.stringify([{ Name: VOL.name, CreatedAt: createdAt }]), stderr: "" };
      }
      if (joined.startsWith("run ")) { recreated = true; return { status: 0, stdout: "", stderr: "" }; } // the mount recreated it
      return { status: 0, stdout: "", stderr: "" }; // ps → no running container (no probe)
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    let thrown = null;
    try {
      assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover, transport });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
  });

  it("finding-3 (real transport): a FAILED final inspect (daemon timeout) after an absent start is NOT read as stable absence → FAIL-CLOSED", () => {
    // Initial inspects confirm absent; a concurrent actor then creates a pg17
    // volume; the post-probe recheck inspect TIMES OUT (error, not "no such
    // volume"). A lossy inspect would collapse the error to null → null==null →
    // "stable absent" → PASS. The three-way recheck treats the error as
    // "uncertain" → fail closed.
    let inspectN = 0;
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) {
        inspectN += 1;
        // Inspects 1-3 (initial + volumeState + marker guard): confirmed absent.
        // Inspect 4 (the post-probe recheck): daemon timeout → ERROR, not absent.
        if (inspectN <= 3) return { status: 1, stdout: "", stderr: "Error: No such volume: x" };
        return { status: 1, stdout: "", stderr: "request timed out" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    let thrown = null;
    try {
      assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover, transport });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
  });

  it("finding-3 END-TO-END (ledger precedence): a LEDGER-matched volume recreated mid-preflight → FAIL-CLOSED, not a stale PASS", () => {
    // The subtle precedence hole: the ledger records v18 bound to the volume's T1
    // identity, and the FIRST inspect captures T1 — so a naive ledger match reads
    // "v18 == target 18 → PASS" even though a concurrent teardown recreated the
    // volume (T1→T2) mid-preflight. The post-probe identity re-check must override
    // the stale ledger match and fail closed.
    seedLedger("postgres", "18"); // v18 bound to VOL identity (createdAt T1).
    let recreated = false;
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) return { status: 0, stdout: JSON.stringify(COMPOSE_CONFIG), stderr: "" };
      if (joined.includes("volume inspect")) {
        const createdAt = recreated ? "2026-09-09T00:00:00Z" : VOL.createdAt; // T1 → T2 across the mount
        return { status: 0, stdout: JSON.stringify([{ Name: VOL.name, CreatedAt: createdAt }]), stderr: "" };
      }
      if (joined.startsWith("run ")) { recreated = true; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 0, stdout: "", stderr: "" };
    };
    const { discover, transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    let thrown = null;
    try {
      assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover, transport });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.report.findings[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#189 — `profileEnabled` derived from the ACTIVE profiles.
//
// The docker-backed transport used to hardcode `profileEnabled: () => true`, so a
// service in a profile the bring-up never activates was still fail-closed —
// turning cinatra-ai/cinatra#2329 (`twenty-redis` declares no named data volume)
// into a hard block on a fresh isolated install.
//
// The two-sided fixture the issue demands: ONE profile-gated stateful service with
// an UNIDENTIFIABLE volume, checked in both directions. Driven over the docker-
// backed transport with a mocked `spawn` that reproduces the REAL compose engine's
// contract (verified live in recreate-preflight-profiles-docker.test.mjs): a plain
// `config` DROPS profile-gated services, `--profile "*"` includes them WITH their
// `profiles` attribute.
// ---------------------------------------------------------------------------
describe("buildDeploymentPreflight — profileEnabled from the ACTIVE profiles (cinatra-cli#189)", () => {
  // The `--profile "*"` view: the default `postgres` + the profile-gated
  // `twenty-redis` copied shape-for-shape from cinatra's compose (redis:7,
  // profiles: ["twenty"], NO volumes at all → data volume unidentifiable).
  const ALL_PROFILES_CONFIG = {
    name: "cinatra_acme",
    services: {
      postgres: {
        image: "postgres:18-alpine",
        volumes: [{ type: "volume", source: "cinatra-postgres", target: "/var/lib/postgresql" }],
      },
      "twenty-redis": { image: "redis:7", profiles: ["twenty"] },
    },
    volumes: { "cinatra-postgres": { name: VOL.name } },
  };
  // The ACTIVE view with the `twenty` profile OFF — compose drops the gated service.
  const ACTIVE_WITHOUT_TWENTY = {
    name: "cinatra_acme",
    services: { postgres: ALL_PROFILES_CONFIG.services.postgres },
    volumes: ALL_PROFILES_CONFIG.volumes,
  };
  // The ACTIVE view with the `twenty` profile ON (COMPOSE_PROFILES=twenty).
  const ACTIVE_WITH_TWENTY = ALL_PROFILES_CONFIG;

  /** A spawn whose `config` answer depends on whether `--profile *` is present —
   *  the ONLY difference between the intent view and the active view. */
  function spawnWithProfiles(activeConfig, { activeResolveFails = false } = {}) {
    return (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) {
        if (joined.includes("--profile * config")) {
          return { status: 0, stdout: JSON.stringify(ALL_PROFILES_CONFIG), stderr: "" };
        }
        if (activeResolveFails) return { status: 1, stdout: "", stderr: "service twenty-redis depends on undefined profile" };
        return { status: 0, stdout: JSON.stringify(activeConfig), stderr: "" };
      }
      if (joined.includes("volume inspect")) {
        return { status: 0, stdout: JSON.stringify([{ Name: VOL.name, CreatedAt: VOL.createdAt }]), stderr: "" };
      }
      if (joined.startsWith("run ") && joined.includes("__preflight_probe")) {
        return { status: 0, stdout: "18\ndocker", stderr: "" }; // non-empty pg volume
      }
      if (joined.startsWith("run ")) return { status: 0, stdout: "18\n", stderr: "" }; // PG_VERSION marker
      return { status: 0, stdout: "", stderr: "" };
    };
  }

  function runGate(spawn) {
    const { discover, transport } = buildDeploymentPreflight({
      slug: SLUG,
      targetDir: dir,
      composeProject: "cinatra_acme",
      ledgerDir: dir,
      spawn,
    });
    const services = discover();
    let thrown = null;
    let decision = null;
    try {
      decision = assertRecreateSafe({ slug: SLUG, ledgerDir: dir, discover: () => services, transport });
    } catch (err) {
      thrown = err;
    }
    const report = decision?.report ?? thrown?.report ?? null;
    return { thrown, report, transport };
  }

  it("the ACTIVE profile set is resolved WITHOUT `--profile \"*\"` (the argv a plain `up` uses)", () => {
    const seen = [];
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) {
        seen.push(joined);
        return { status: 0, stdout: JSON.stringify(joined.includes("--profile *") ? ALL_PROFILES_CONFIG : ACTIVE_WITHOUT_TWENTY), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn }).discover();
    // Exactly two resolves: the INTENT view (all profiles) + the ACTIVE view.
    expect(seen).toHaveLength(2);
    expect(seen.filter((s) => s.includes("--profile * config"))).toHaveLength(1);
    expect(seen.filter((s) => !s.includes("--profile"))).toHaveLength(1);
  });

  it("an unresolvable INTENT view skips the second resolve entirely (the gate already refuses on configResolved)", () => {
    const seen = [];
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) {
        seen.push(joined);
        return { status: 1, stdout: "", stderr: "no configuration file provided" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const built = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, ledgerDir: dir, spawn });
    built.discover();
    expect(seen).toHaveLength(1); // no second doomed docker call
    expect(built.state.configResolved).toBe(false);
    expect(built.transport.profileEnabled("twenty-redis")).toBe(true); // still permissive
  });

  it("profile NOT activated → the unidentifiable-volume service is SKIPPED and never blocks", () => {
    const { thrown, report } = runGate(spawnWithProfiles(ACTIVE_WITHOUT_TWENTY));
    expect(thrown).toBeNull(); // the bring-up proceeds — cinatra-ai/cinatra#2329 no longer fail-closes it
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    const gated = report.results.find((r) => r.service === "twenty-redis");
    expect(gated.verdict).toBe(VERDICTS.SKIPPED);
    expect(gated.reason).toBe("profile disabled — service not deployed here");
    // …while the default-profile service is still REALLY evaluated (not skipped).
    expect(report.results.find((r) => r.service === "postgres").verdict).toBe(VERDICTS.PASS);
  });

  it("profile ACTIVATED → the SAME service is fully evaluated and BLOCKS (fail-closed guarantee unchanged)", () => {
    const { thrown, report } = runGate(spawnWithProfiles(ACTIVE_WITH_TWENTY));
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    const finding = report.findings.find((f) => f.service === "twenty-redis");
    expect(finding.verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(finding.reason).toMatch(/data volume could not be identified/);
  });

  it("an UNRESOLVABLE active view never skips on a guess → the service is still evaluated (fail closed)", () => {
    const { thrown, report } = runGate(spawnWithProfiles(ACTIVE_WITHOUT_TWENTY, { activeResolveFails: true }));
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(report.findings.find((f) => f.service === "twenty-redis").verdict).toBe(VERDICTS.FAIL_CLOSED);
  });

  it("a DEFAULT-profile service missing from the active view is still evaluated (only profile-gated services may be skipped)", () => {
    // A pathological active view that omits `postgres` even though it declares no
    // profiles. Absence alone must never authorize a skip — the predicate demands
    // positive proof the service is profile-gated.
    const spawn = spawnWithProfiles({ name: "cinatra_acme", services: {}, volumes: ALL_PROFILES_CONFIG.volumes });
    const built = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    built.discover();
    expect(built.transport.profileEnabled("postgres")).toBe(true);
    expect(built.transport.profileEnabled("twenty-redis")).toBe(false);
  });

  it("before discover() runs, the predicate is permissive (no facts ⇒ evaluate everything)", () => {
    const { transport } = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, ledgerDir: dir, spawn: spawnWithProfiles(ACTIVE_WITHOUT_TWENTY) });
    expect(transport.profileEnabled("twenty-redis")).toBe(true);
  });

  it("an `services: []` (array, not object) active view is NOT authoritative → still evaluated", () => {
    // `resolveComposeConfig` only validates JSON syntax. A valid-JSON document whose
    // `services` is an array must never be read as proof of an empty active set —
    // that would skip every gated service on a malformed response.
    const spawn = spawnWithProfiles({ name: "cinatra_acme", services: [], volumes: {} });
    const built = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    built.discover();
    expect(built.transport.profileEnabled("twenty-redis")).toBe(true);
  });

  it("a second discover() does not leave stale profile facts behind", () => {
    // Run 1 sees the gated service; run 2's config no longer declares it. The
    // closured facts describe the CURRENT discovery, so it must not stay "gated".
    let call = 0;
    const spawn = (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("config --format json")) {
        const gatedRun = call++ < 2; // the first discover()'s two resolves
        if (joined.includes("--profile * config")) {
          return { status: 0, stdout: JSON.stringify(gatedRun ? ALL_PROFILES_CONFIG : ACTIVE_WITHOUT_TWENTY), stderr: "" };
        }
        return { status: 0, stdout: JSON.stringify(ACTIVE_WITHOUT_TWENTY), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const built = buildDeploymentPreflight({ slug: SLUG, targetDir: dir, composeProject: "cinatra_acme", ledgerDir: dir, spawn });
    built.discover();
    expect(built.transport.profileEnabled("twenty-redis")).toBe(false);
    built.discover(); // the service is gone from the config entirely
    expect(built.transport.profileEnabled("twenty-redis")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// preflightRecreate — install.mjs's glue: rethrow a verdict, swallow a bug.
// ---------------------------------------------------------------------------
describe("preflightRecreate — the install/refresh glue over the gate", () => {
  it("RE-THROWS a RecreatePreflightError (a blocking verdict aborts the bring-up)", () => {
    expect(() =>
      preflightRecreate({
        slug: SLUG,
        targetDir: dir,
        deps: {
          assertRecreateSafe: () => {
            throw new RecreatePreflightError("boundary!", { findings: [] });
          },
        },
      }),
    ).toThrow(/boundary!/);
  });

  it("RE-RAISES an unexpected internal error as a FAIL-CLOSED refusal (never silently proceeds)", () => {
    let thrown = null;
    try {
      preflightRecreate({
        slug: SLUG,
        targetDir: dir,
        deps: {
          assertRecreateSafe: () => {
            throw new Error("docker inspect blew up");
          },
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    expect(thrown.message).toMatch(/could not be evaluated/);
    expect(thrown.message).toMatch(/docker inspect blew up/);
  });

  it("passes the deployment identity through to the gate", () => {
    let seen = null;
    preflightRecreate({
      slug: "beta",
      targetDir: dir,
      composeProject: "cinatra_beta",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      envFile: "/x/.env.local",
      deps: { assertRecreateSafe: (args) => { seen = args; } },
    });
    expect(seen.slug).toBe("beta");
    expect(seen.targetDir).toBe(dir);
    expect(seen.composeProject).toBe("cinatra_beta");
    expect(seen.composeFiles).toEqual(["docker-compose.cinatra-isolated.yml"]);
    expect(seen.envFile).toBe("/x/.env.local");
  });
});
