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
  it("splits repo / tag / digest of a pinned reference", () => {
    expect(imageParts("postgres:18-alpine@sha256:9a8afc")).toEqual({
      repo: "postgres",
      tag: "18-alpine",
      digest: "sha256:9a8afc",
    });
  });
  it("handles registry ports and missing tags", () => {
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
  it("returns null off-axis / untagged / unknown service (fail-closed upstream)", () => {
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
  it("extracts matrix-known services with resolved volume names + derived versions", () => {
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

  it("picks the DATA volume by dataMount when a service mounts several volumes", () => {
    const doc = configDoc();
    doc.services.postgres.volumes.push({ type: "volume", source: "pg-scratch", target: "/scratch" });
    doc.volumes["pg-scratch"] = { name: "cinatra_main_pg-scratch" };
    const { found } = statefulServicesFromComposeConfig(doc);
    expect(found.find((s) => s.service === "postgres").volumeName).toBe("cinatra_main_postgres-data");
  });

  it("skips (loudly) a service whose data volume cannot be identified", () => {
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

  it("records live-volume-bound entries; absent volumes are skipped, not guessed", () => {
    const res = recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect });
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

  it("re-recording updates entries (idempotent installs converge)", () => {
    recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect });
    const doc = configDoc();
    doc.services.postgres.image = "postgres:18.1-alpine";
    const res = recordDeployedStack({ slug: "main", configJson: doc, ledgerDir: dir, inspectVolume: inspect });
    expect(res.status).toBe("ok");
    expect(readLedger("main", dir).ledger.services.postgres.image).toBe("postgres:18.1-alpine");
  });

  it("NEVER overwrites a malformed ledger", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "main.json"), "{not json");
    const res = recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect });
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

    const res = recordDeployedStack({ slug: "main", configJson: configDoc(), ledgerDir: dir, inspectVolume: inspect });
    expect(res.recorded).toEqual(["nango-db"]);
    expect(res.skipped.find((s) => s.service === "postgres").reason).toMatch(/migration in flight/i);
    // The live postgres entry is still the SOURCE (the journal was not clobbered).
    const after = rl("main", dir).ledger;
    expect(after.services.postgres.dataFormatVersion).toBe("17");
    expect(after.pending?.service).toBe("postgres");
  });
});

describe("captureDeployedVersions — the install/refresh hook over the shell seam", () => {
  it("resolves the compose config and records through injected docker captures", () => {
    const calls = [];
    const capture = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("config")) return JSON.stringify(configDoc());
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = args[2];
        if (name === "explicit-wp-vol") return null;
        return JSON.stringify([{ Name: name, CreatedAt: "2026-03-01T00:00:00Z" }]);
      }
      return null;
    };
    const logs = [];
    const res = captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      composeProject: "cinatra_main",
      ledgerDir: dir,
      capture,
      log: (l) => logs.push(l),
    });
    expect(res.status).toBe("ok");
    expect(res.recorded.sort()).toEqual(["nango-db", "postgres"]);
    // The config call carried the SAME -p the `up` used.
    const configCall = calls.find((c) => c.includes("config"));
    expect(configCall).toContain("-p");
    expect(configCall).toContain("cinatra_main");
    expect(logs.join("\n")).toMatch(/recorded 2 stateful service\(s\)/);
    expect(readLedger("main", dir).ledger.services.postgres.volume.createdAt).toBe("2026-03-01T00:00:00Z");
  });

  it("reports config-unavailable (and records nothing) when compose config fails; never throws", () => {
    const res = captureDeployedVersions({
      slug: "main",
      targetDir: "/nonexistent",
      ledgerDir: dir,
      capture: () => null,
      log: () => {},
    });
    expect(res.status).toBe("config-unavailable");
    expect(readLedger("main", dir).status).toBe("missing");
  });
});
