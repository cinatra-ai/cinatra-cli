// Deployed-version CAPTURE (installer half of cinatra-cli#128): compose-config
// discovery, image-tag → data-format-version derivation, and the best-effort
// post-`up` recording flow — all driven through the injected capture seam
// (never a real docker daemon).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_UPGRADE_MATRIX, deriveDataFormatVersion, imageParts } from "../src/upgrade-matrix.mjs";
import {
  captureDeployedVersions,
  recordDeployedStack,
  statefulServicesFromComposeConfig,
} from "../src/version-ledger-capture.mjs";
import { readLedger } from "../src/version-ledger.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cinatra-vlcapture-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("imageParts", () => {
  it("splits repo / tag / digest of a pinned reference", async () => {
    expect(imageParts("postgres:18-alpine@sha256:9a8afc")).toEqual({
      repo: "postgres",
      tag: "18-alpine",
      digest: "sha256:9a8afc",
    });
  });
  it("handles registry ports and missing tags", async () => {
    expect(imageParts("reg.example:5000/team/img:1.2")).toEqual({
      repo: "reg.example:5000/team/img",
      tag: "1.2",
      digest: null,
    });
    expect(imageParts("mariadb")).toEqual({ repo: "mariadb", tag: null, digest: null });
    expect(imageParts("")).toEqual({ repo: null, tag: null, digest: null });
  });
});

describe("deriveDataFormatVersion — image tag normalized onto the service axis", () => {
  const cases = [
    ["postgres", "postgres:18-alpine@sha256:abc", "18"],
    ["plane-db", "postgres:15.7-alpine", "15"], // dotted prefix onto the pg major axis
    ["wordpress-db", "mariadb:11.4", "11.4"],
    ["redis", "redis:8-alpine", "8"],
    ["plane-redis", "valkey/valkey:7.2.11-alpine", "7.2.11"],
    ["plane-mq", "rabbitmq:3.13.6-management-alpine", "3.13"],
    ["neo4j", "neo4j:2026.05-community", "2026.05"],
    ["verdaccio", "verdaccio/verdaccio:6@sha256:e3a", "6"],
  ];
  for (const [service, image, expected] of cases) {
    it(`${service}: ${image} → ${expected}`, () => {
      expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, service, image)).toBe(expected);
    });
  }
  it("returns null off-axis / untagged / unknown service (fail-closed upstream)", async () => {
    expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, "postgres", "postgres:14-alpine")).toBeNull();
    expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, "postgres", "postgres")).toBeNull();
    expect(deriveDataFormatVersion(DEFAULT_UPGRADE_MATRIX, "nope", "postgres:18")).toBeNull();
  });
});

// A resolved-compose-config document shaped like `docker compose config
// --format json` (verified against compose v2 output).
function configDoc() {
  return {
    name: "cinatra_main",
    services: {
      postgres: {
        image: "postgres:18-alpine@sha256:9a8afc",
        volumes: [
          { type: "volume", source: "postgres-data", target: "/var/lib/postgresql" },
          { type: "bind", source: "/host/init", target: "/docker-entrypoint-initdb.d" },
        ],
      },
      "nango-db": {
        image: "postgres:17-alpine",
        volumes: [{ type: "volume", source: "nango-data", target: "/var/lib/postgresql/data" }],
      },
      "wordpress-db": {
        image: "mariadb:11.4",
        profiles: ["wordpress"],
        volumes: [{ type: "volume", source: "wp-db-data", target: "/var/lib/mysql" }],
      },
      app: { image: "cinatra-app:dev", volumes: [] }, // not matrix-known → ignored
    },
    volumes: {
      "postgres-data": { name: "cinatra_main_postgres-data" },
      "nango-data": { name: "cinatra_main_nango-data" },
      "wp-db-data": { name: "explicit-wp-vol" },
    },
  };
}

describe("statefulServicesFromComposeConfig", () => {
  it("extracts matrix-known services with resolved volume names + derived versions", async () => {
    const { found, skipped } = statefulServicesFromComposeConfig(configDoc());
    const byService = Object.fromEntries(found.map((s) => [s.service, s]));
    expect(Object.keys(byService).sort()).toEqual(["nango-db", "postgres", "wordpress-db"]);
    expect(byService.postgres).toMatchObject({
      image: "postgres:18-alpine@sha256:9a8afc",
      digest: "sha256:9a8afc",
      dataFormatVersion: "18",
      volumeName: "cinatra_main_postgres-data",
    });
    expect(byService["wordpress-db"].volumeName).toBe("explicit-wp-vol"); // explicit name honored
    expect(byService["nango-db"].dataFormatVersion).toBe("17");
    expect(skipped).toEqual([]);
  });

  it("picks the DATA volume by dataMount when a service mounts several volumes", async () => {
    const doc = configDoc();
    doc.services.postgres.volumes.push({ type: "volume", source: "pg-scratch", target: "/scratch" });
    doc.volumes["pg-scratch"] = { name: "cinatra_main_pg-scratch" };
    const { found } = statefulServicesFromComposeConfig(doc);
    expect(found.find((s) => s.service === "postgres").volumeName).toBe("cinatra_main_postgres-data");
  });

  it("dataMount matches on path boundaries only — /data never matches /data-cache", async () => {
    const doc = {
      name: "p",
      services: {
        redis: {
          image: "redis:8-alpine",
          volumes: [
            { type: "bind", source: "/host/data", target: "/data" }, // real data dir bind-mounted
            { type: "volume", source: "cache", target: "/data-cache" }, // lexical prefix trap
          ],
        },
      },
      volumes: { cache: { name: "p_cache" } },
    };
    const { found, skipped } = statefulServicesFromComposeConfig(doc);
    expect(found).toEqual([]);
    expect(skipped[0].reason).toMatch(/no named data-volume/i);
  });

  it("NEVER binds an auxiliary volume when the data path itself is bind-mounted", async () => {
    // postgres data dir on a bind mount + one unrelated named volume: recording
    // that volume would attach the ledger entry to the WRONG volume identity.
    const doc = configDoc();
    doc.services.postgres.volumes = [
      { type: "bind", source: "/host/pgdata", target: "/var/lib/postgresql" },
      { type: "volume", source: "pg-scratch", target: "/scratch" },
    ];
    doc.volumes["pg-scratch"] = { name: "cinatra_main_pg-scratch" };
    const { found, skipped } = statefulServicesFromComposeConfig(doc);
    expect(found.find((s) => s.service === "postgres")).toBeUndefined();
    expect(skipped.find((s) => s.service === "postgres").reason).toMatch(/no named data-volume/i);
  });

  it("skips (loudly) a service whose data volume cannot be identified", async () => {
    const doc = configDoc();
    doc.services.postgres.volumes = []; // no named volume at all
    delete doc.volumes["nango-data"]; // unresolvable name
    const { found, skipped } = statefulServicesFromComposeConfig(doc);
    expect(found.map((s) => s.service)).toEqual(["wordpress-db"]);
    expect(skipped.map((s) => s.service).sort()).toEqual(["nango-db", "postgres"]);
  });
});

describe("recordDeployedStack", () => {
  const LIVE = {
    "cinatra_main_postgres-data": { name: "cinatra_main_postgres-data", createdAt: "2026-01-01T00:00:00Z" },
    "cinatra_main_nango-data": { name: "cinatra_main_nango-data", createdAt: "2026-01-02T00:00:00Z" },
    // wordpress volume NOT live (profile never enabled)
  };
  const inspect = (name) => LIVE[name] ?? null;
  // Deployment proof: postgres + nango-db running THE CONFIGURED pins;
  // wordpress-db profile dormant.
  const RUNNING = new Map([
    ["postgres", "postgres:18-alpine@sha256:9a8afc"],
    ["nango-db", "postgres:17-alpine"],
  ]);

  it("records live-volume-bound entries for RUNNING services; the rest are skipped, not guessed", async () => {
    const res = await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect, runningImages: RUNNING });
    expect(res.status).toBe("ok");
    expect(res.recorded.sort()).toEqual(["nango-db", "postgres"]);
    expect(res.skipped.map((s) => s.service)).toEqual(["wordpress-db"]);
    const { status, ledger } = readLedger("main", dir);
    expect(status).toBe("ok");
    expect(ledger.services.postgres).toMatchObject({
      image: "postgres:18-alpine@sha256:9a8afc",
      digest: "sha256:9a8afc",
      dataFormatVersion: "18",
      volume: LIVE["cinatra_main_postgres-data"],
    });
    expect(ledger.services["wordpress-db"]).toBeUndefined();
  });

  it("a dormant profile's EXISTING volume is never re-stamped (container not running)", async () => {
    // wordpress-db volume exists live, but the service is not running: the old
    // volume must keep its (absent) entry rather than gaining the new pin.
    const inspectWithWp = (name) =>
      name === "explicit-wp-vol" ? { name, createdAt: "2025-01-01T00:00:00Z" } : inspect(name);
    const res = await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspectWithWp, runningImages: RUNNING });
    expect(res.recorded).not.toContain("wordpress-db");
    expect(res.skipped.find((s) => s.service === "wordpress-db").reason).toMatch(/not running/i);
    expect(readLedger("main", dir).ledger.services["wordpress-db"]).toBeUndefined();
  });

  it("refuses to record ANYTHING without deployment proof (running set unavailable)", async () => {
    const res = await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect, runningImages: null });
    expect(res.status).toBe("no-deployment-proof");
    expect(res.recorded).toEqual([]);
    expect(readLedger("main", dir).status).toBe("missing"); // nothing written
  });

  it("re-recording updates entries once the container actually runs the new pin", async () => {
    await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect, runningImages: RUNNING });
    const doc = configDoc();
    doc.services.postgres.image = "postgres:18.1-alpine";
    const running = new Map(RUNNING);
    running.set("postgres", "postgres:18.1-alpine"); // the up recreated it on the new pin
    const res = await recordDeployedStack({ slug: "main", configJson: doc, ledgerDir: dir, inspectVolume: inspect, runningImages: running });
    expect(res.status).toBe("ok");
    expect(readLedger("main", dir).ledger.services.postgres.image).toBe("postgres:18.1-alpine");
  });

  it("a STALE running container (old image, new pin) is never re-stamped", async () => {
    const doc = configDoc();
    doc.services.postgres.image = "postgres:18.1-alpine"; // config moved forward…
    // …but the running container still carries the previous pin.
    const res = await recordDeployedStack({ slug: "main", configJson: doc, ledgerDir: dir, inspectVolume: inspect, runningImages: RUNNING });
    expect(res.recorded).toEqual(["nango-db"]);
    expect(res.skipped.find((s) => s.service === "postgres").reason).toMatch(/stale container/i);
    expect(readLedger("main", dir).ledger.services.postgres).toBeUndefined();
  });

  it("NEVER overwrites a malformed ledger", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "main.json"), "{not json");
    const res = await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect, runningImages: RUNNING });
    expect(res.status).toBe("malformed");
    expect(res.recorded).toEqual([]);
    expect(readLedger("main", dir).status).toBe("malformed"); // untouched
  });

  it("skips a service with an in-flight migration journal (journal owns the entry)", async () => {
    const { beginMigration, makeEntry, readLedger: rl, writeLedger } = await import("../src/version-ledger.mjs");
    const source = makeEntry({
      service: "postgres",
      image: "postgres:17-alpine",
      dataFormatVersion: "17",
      volume: LIVE["cinatra_main_postgres-data"],
    });
    let ledger = rl("main", dir).ledger;
    ledger = { ...ledger, services: { postgres: source } };
    ledger = beginMigration(ledger, {
      service: "postgres",
      target: makeEntry({
        service: "postgres",
        image: "postgres:18-alpine",
        dataFormatVersion: "18",
        volume: { name: "new-vol", createdAt: "2026-02-01T00:00:00Z" },
      }),
    });
    writeLedger(ledger, dir);

    const res = await recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect, runningImages: RUNNING });
    expect(res.recorded).toEqual(["nango-db"]);
    expect(res.skipped.find((s) => s.service === "postgres").reason).toMatch(/migration in flight/i);
    // The live postgres entry is still the SOURCE (the journal was not clobbered).
    const after = rl("main", dir).ledger;
    expect(after.services.postgres.dataFormatVersion).toBe("17");
    expect(after.pending?.service).toBe("postgres");
  });
});

describe("captureDeployedVersions — the install/refresh hook over the shell seam", () => {
  // `compose ps --format json` NDJSON lines (compose stamps the exact
  // configured ref, digest pin included).
  const PS_NDJSON = [
    JSON.stringify({ Service: "postgres", Image: "postgres:18-alpine@sha256:9a8afc", State: "running" }),
    JSON.stringify({ Service: "nango-db", Image: "postgres:17-alpine", State: "running" }),
  ].join("\n");

  const fakeDocker = (overrides = {}) => (cmd, args) => {
    if (overrides.calls) overrides.calls.push([cmd, ...args]);
    if (args.includes("config")) return overrides.config ?? JSON.stringify(configDoc());
    if (args.includes("ps")) return overrides.ps ?? PS_NDJSON;
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args[2];
      if (name === "explicit-wp-vol") return null;
      return JSON.stringify([{ Name: name, CreatedAt: "2026-03-01T00:00:00Z" }]);
    }
    return null;
  };

  it("resolves config + running set and records through injected docker captures", async () => {
    const calls = [];
    const logs = [];
    const res = await captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      composeProject: "cinatra_main",
      ledgerDir: dir,
      capture: fakeDocker({ calls }),
      log: (l) => logs.push(l),
    });
    expect(res.status).toBe("ok");
    expect(res.recorded.sort()).toEqual(["nango-db", "postgres"]);
    // The config AND ps calls carried the SAME -p the `up` used.
    for (const probe of ["config", "ps"]) {
      const call = calls.find((c) => c.includes(probe));
      expect(call).toContain("-p");
      expect(call).toContain("cinatra_main");
    }
    expect(logs.join("\n")).toMatch(/recorded 2 stateful service\(s\)/);
    expect(readLedger("main", dir).ledger.services.postgres.volume.createdAt).toBe("2026-03-01T00:00:00Z");
  });

  it("reports config-unavailable (and records nothing) when compose config fails; never throws", async () => {
    const res = await captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      ledgerDir: dir,
      capture: () => null,
      log: () => {},
    });
    expect(res.status).toBe("config-unavailable");
    expect(readLedger("main", dir).status).toBe("missing");
  });

  it("refuses to record when the resolved project differs from the instance's recorded project", async () => {
    const res = await captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      ledgerDir: dir,
      requireProjectMatch: "cinatra_main_explicit",
      capture: fakeDocker({}), // config resolves name "cinatra_main"
      log: () => {},
    });
    expect(res.status).toBe("project-mismatch");
    expect(readLedger("main", dir).status).toBe("missing");
  });

  it("refuses to record when the running-service listing fails (deployment proof required)", async () => {
    const res = await captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      ledgerDir: dir,
      capture: (cmd, args) => (args.includes("ps") ? null : fakeDocker({})(cmd, args)),
      log: () => {},
    });
    expect(res.status).toBe("no-deployment-proof");
    expect(readLedger("main", dir).status).toBe("missing");
  });

  it("an EMPTY running listing is proof of nothing running — nothing recorded, not a failure", async () => {
    const res = await captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      ledgerDir: dir,
      capture: fakeDocker({ ps: "" }),
      log: () => {},
    });
    expect(res.status).toBe("empty");
    expect(res.skipped.every((s) => /not running/i.test(s.reason))).toBe(true);
    expect(readLedger("main", dir).status).toBe("missing");
  });
});
