// cinatra-cli#189 — DOCKER-GATED end-to-end verification of the recreate gate's
// profile predicate.
//
// The hermetic tests in recreate-preflight.test.mjs drive the docker-backed
// transport over a mocked `spawn`. This file proves the SAME behavior through the
// REAL `docker compose` engine and REAL docker volumes, over the compose shape the
// bug was reported against:
//
//   * `twenty-redis` copied SHAPE-FOR-SHAPE from cinatra's docker-compose.yml —
//     image redis:7, profiles: ["twenty"], NO `volumes:` key at all, so the
//     preflight cannot identify its data volume (cinatra-ai/cinatra#2329);
//   * `twenty-db` — also profile-gated, but WITH an identifiable volume seeded at
//     pg15 against a pg16 pin (an unsupported hop for twenty-db);
//   * `postgres` — the default (un-profiled) service the bring-up really deploys,
//     seeded at pg18 against the pg18 pin so it PASSES on a real marker read.
//
// Two-sided, per the issue's acceptance criteria: with the `twenty` profile OFF
// the gate must PASS (both gated services SKIPPED); with it ON — activated the way
// a real `up` would see it, `COMPOSE_PROFILES` in the `--env-file` — the very same
// services must be fully evaluated and BLOCK.
//
// The gate is entered through `preflightRecreate` with NO injected deps: the exact
// function `bringUpInfra` calls before every install/refresh `docker compose up -d`,
// routing through the real `defaultAssertRecreateSafe` → real `spawnSync` → real
// `docker compose config` / `docker volume inspect` / `docker run --pull=never`.
//
// Auto-SKIPS when Docker/Compose v2 or the fixture images are unavailable, so it
// never flakes the hermetic suite — it is a bonus live proof.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { preflightRecreate } from "../src/install.mjs";
import { RecreatePreflightError, buildDeploymentPreflight, runRecreatePreflight } from "../src/recreate-preflight.mjs";
import { VERDICTS } from "../src/upgrade-preflight.mjs";

const PG_IMAGE = "postgres:18-alpine";
const TWENTY_DB_IMAGE = "postgres:16";
const TWENTY_REDIS_IMAGE = "redis:7";
// Docker volume + compose project names are DAEMON-GLOBAL, and setup/teardown
// force-remove them — so a fixed name would let two concurrent runs (parallel
// vitest projects, two checkouts, CI + a laptop on one daemon) delete each other's
// fixture mid-test. Every run gets its own suffix.
const RUN_ID = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const PG_VOL = `cinatra_cli189_pgdata_${RUN_ID}`;
const TWENTY_DB_VOL = `cinatra_cli189_twentydb_${RUN_ID}`;
const PROJECT = `cinatra_cli189_${RUN_ID}`;
const SLUG = `cli189docker${RUN_ID}`; // no recorded ledger → detection falls to the raw marker

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

/** Docker + Compose v2 usable AND every fixture image already present locally
 *  (the preflight probes with `--pull=never`, so a missing image is a skip, not
 *  a failure — and CI must never pull multi-hundred-MB images for this). */
function dockerReady() {
  if (run("docker", ["compose", "version"]).status !== 0) return false;
  for (const img of [PG_IMAGE, TWENTY_DB_IMAGE, TWENTY_REDIS_IMAGE]) {
    if (run("docker", ["image", "inspect", img]).status !== 0) return false;
  }
  return true;
}

const HAVE_DOCKER = dockerReady();

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#189 — profileEnabled over the REAL docker compose engine", () => {
  let dir;

  const gateArgs = (envFile) => ({
    slug: SLUG,
    targetDir: dir,
    composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
    composeProject: PROJECT,
    envFile,
    log: () => {},
  });

  /** Run the production gate; return the thrown error (or null) plus EVERY
   *  per-service verdict (the throwing gate carries only the blocking subset). */
  function gate(envFile) {
    let thrown = null;
    try {
      preflightRecreate(gateArgs(envFile));
    } catch (err) {
      thrown = err;
    }
    const { discover, transport } = buildDeploymentPreflight({
      slug: SLUG,
      targetDir: dir,
      composeFiles: gateArgs(envFile).composeFiles,
      composeProject: gateArgs(envFile).composeProject,
      envFile,
    });
    const decision = runRecreatePreflight({ slug: SLUG, services: discover(), transport });
    const verdicts = new Map((decision.report?.results ?? []).map((r) => [r.service, r]));
    return { thrown, verdicts };
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-cli189-"));
    writeFileSync(
      path.join(dir, "docker-compose.yml"),
      [
        "services:",
        "  postgres:",
        `    image: ${PG_IMAGE}`,
        "    volumes:",
        "      - cinatra-postgres:/var/lib/postgresql",
        "  twenty-db:",
        `    image: ${TWENTY_DB_IMAGE}`,
        '    profiles: ["twenty"]',
        "    volumes:",
        "      - cinatra-twenty-db:/var/lib/postgresql/data",
        // Verbatim shape from cinatra's compose: profile-gated, no volumes at all.
        "  twenty-redis:",
        `    image: ${TWENTY_REDIS_IMAGE}`,
        '    profiles: ["twenty"]',
        '    command: ["--maxmemory-policy", "noeviction"]',
        "volumes:",
        "  cinatra-postgres:",
        `    name: ${PG_VOL}`,
        "  cinatra-twenty-db:",
        `    name: ${TWENTY_DB_VOL}`,
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(dir, "docker-compose.dev.yml"), "services: {}\n");
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_RUNTIME_MODE=dev\n");
    // Activation the way a real `up` sees it: compose reads COMPOSE_PROFILES from
    // the very `--env-file` the bring-up passes.
    writeFileSync(path.join(dir, ".env.twenty"), "CINATRA_RUNTIME_MODE=dev\nCOMPOSE_PROFILES=twenty\n");

    for (const v of [PG_VOL, TWENTY_DB_VOL]) {
      run("docker", ["volume", "rm", "-f", v]);
      run("docker", ["volume", "create", v]);
    }
    // pg18 PARENT layout (docker-library/postgres#1259): PGDATA at <major>/docker.
    run("docker", [
      "run", "--rm", "--pull=never", "--entrypoint", "/bin/sh",
      "-v", `${PG_VOL}:/var/lib/postgresql`, PG_IMAGE,
      "-c", "mkdir -p /var/lib/postgresql/18/docker && printf '18\\n' > /var/lib/postgresql/18/docker/PG_VERSION",
    ]);
    // Legacy layout: the volume IS the data dir. pg15 data facing the pg16 pin.
    run("docker", [
      "run", "--rm", "--pull=never", "--entrypoint", "/bin/sh",
      "-v", `${TWENTY_DB_VOL}:/var/lib/postgresql/data`, TWENTY_DB_IMAGE,
      "-c", "printf '15\\n' > /var/lib/postgresql/data/PG_VERSION",
    ]);
  }, 300_000);

  afterAll(() => {
    for (const v of [PG_VOL, TWENTY_DB_VOL]) run("docker", ["volume", "rm", "-f", v]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("the real engine drops profile-gated services from a plain `config` and keeps them under `--profile \"*\"`", () => {
    const cfg = (extra) =>
      JSON.parse(
        run("docker", ["compose", "--env-file", ".env.local", "-f", "docker-compose.yml", ...extra, "config", "--format", "json"], { cwd: dir })
          .stdout,
      );
    // The contract the predicate is built on — asserted against the REAL engine.
    expect(Object.keys(cfg([])).length).toBeGreaterThan(0);
    expect(Object.keys(cfg([]).services)).toEqual(["postgres"]);
    expect(Object.keys(cfg(["--profile", "*"]).services).sort()).toEqual(["postgres", "twenty-db", "twenty-redis"]);
  }, 120_000);

  it("profile NOT activated → the gate PASSES; both gated services SKIPPED, the deployed one really evaluated", () => {
    const { thrown, verdicts } = gate(".env.local");
    expect(thrown).toBeNull(); // cinatra-ai/cinatra#2329 no longer blocks the bring-up
    expect(verdicts.get("twenty-redis").verdict).toBe(VERDICTS.SKIPPED);
    expect(verdicts.get("twenty-redis").reason).toBe("profile disabled — service not deployed here");
    expect(verdicts.get("twenty-db").verdict).toBe(VERDICTS.SKIPPED);
    // Not a blanket skip: the default-profile service is checked for real, and its
    // PASS comes from the raw PG_VERSION marker read off the live volume.
    expect(verdicts.get("postgres").verdict).toBe(VERDICTS.PASS);
    expect(verdicts.get("postgres").reason).toMatch(/matching versions \(18\)/);
  }, 300_000);

  it("profile ACTIVATED → the SAME services are fully evaluated and BLOCK (no weakening of #1417)", () => {
    const { thrown, verdicts } = gate(".env.twenty");
    expect(thrown).toBeInstanceOf(RecreatePreflightError);
    // The unidentifiable-volume service fail-closes exactly as before the fix…
    expect(verdicts.get("twenty-redis").verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(verdicts.get("twenty-redis").reason).toMatch(/data volume could not be identified/);
    // …and a gated service WITH a volume is genuinely version-checked across the
    // boundary (pg15 data → pg16 pin), not waved through.
    expect(verdicts.get("twenty-db").verdict).toBe(VERDICTS.FAIL_CLOSED);
    expect(verdicts.get("twenty-db").reason).toMatch(/detected 15 → target 16/);
    expect(verdicts.get("postgres").verdict).toBe(VERDICTS.PASS);
  }, 300_000);
});
