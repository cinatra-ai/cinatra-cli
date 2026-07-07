// cinatra-cli#57 — DOCKER-GATED end-to-end verification.
//
// The unit tests in install-isolation.test.mjs assert the generator's
// env-file-aware scrub hermetically. This file proves the SAME fix through the
// REAL `docker compose` interpolation engine that the bug surfaced in:
//
//   1. generate the isolated compose from a resolved config that mirrors the real
//      cinatra stack — infra-init passwords are compose-baked LITERALS
//      (postgres / nango — and crucially DIFFERENT per service), plus an operator
//      secret (OPENAI_API_KEY) sourced from .env.local;
//   2. write a minimal .env.local supplying ONLY the operator secret;
//   3. run the ACTUAL `docker compose --env-file <env> -f <generated> config` and
//      assert EVERY required infra password resolves to a NON-BLANK value, that
//      the distinct per-service POSTGRES_PASSWORD values are NOT collapsed, and
//      that compose emits NO "variable is not set. Defaulting to a blank string"
//      warning (the bug's exact signature).
//
// Auto-SKIPS when Docker / Compose v2 is unavailable so it never flakes the
// hermetic suite — it is a bonus live proof.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  generateIsolatedCompose,
  writeIsolatedComposeFile,
  ISOLATED_COMPOSE_FILENAME,
} from "../src/install-isolation.mjs";

/** True iff `docker compose config` is usable in this environment. */
function dockerComposeAvailable() {
  const r = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return r.status === 0;
}

const HAVE_DOCKER = dockerComposeAvailable();

// A resolved `docker compose config --format json`-shaped document mirroring the
// REAL cinatra stack: postgres + nango-db each hardcode POSTGRES_PASSWORD with a
// DIFFERENT value (the collapse hazard), nango-server hardcodes its dashboard +
// db passwords, and OPENAI_API_KEY is an operator secret supplied by .env.local.
const resolvedConfig = {
  name: "cinatra",
  services: {
    postgres: {
      image: "postgres:16-alpine",
      environment: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres", POSTGRES_DB: "postgres", OPENAI_API_KEY: "sk-operator-secret" },
      ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      networks: ["default"],
    },
    "nango-db": {
      image: "postgres:16-alpine",
      environment: { POSTGRES_PASSWORD: "nango", NANGO_DB_PASSWORD: "nango", POSTGRES_USER: "nango" },
      ports: [{ published: "5435", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      networks: ["default"],
    },
    "nango-server": {
      image: "alpine:3",
      environment: { NANGO_DASHBOARD_PASSWORD: "cinatra-local" },
      networks: ["default"],
    },
  },
  networks: { default: { name: "cinatra_default" } },
  volumes: {},
};

// .env.local supplies ONLY the operator secret — NOT the compose infra defaults.
const ENV_FILE_KEYS = new Set(["OPENAI_API_KEY"]);

const REQUIRED = {
  postgres: ["POSTGRES_PASSWORD"],
  "nango-db": ["POSTGRES_PASSWORD", "NANGO_DB_PASSWORD"],
  "nango-server": ["NANGO_DASHBOARD_PASSWORD"],
};

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#57 — real `docker compose config` resolves every infra password (non-blank)", () => {
  let dir;
  let composePath;
  let envPath;
  let resolved;
  let configStderr;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-57-docker-"));
    const { doc } = generateIsolatedCompose({
      resolvedConfig,
      offset: 20000,
      projectName: "cinatra_iso57test",
      slug: "iso57test",
      appPort: 33000,
      envFileKeys: ENV_FILE_KEYS,
    });
    composePath = writeIsolatedComposeFile(path.join(dir, ISOLATED_COMPOSE_FILENAME), doc);
    envPath = path.join(dir, ".env.local");
    // The env-file supplies only the operator secret (mode + OPENAI_API_KEY).
    writeFileSync(envPath, "CINATRA_RUNTIME_MODE=development\nOPENAI_API_KEY=sk-operator-secret\n", { mode: 0o600 });
    const r = spawnSync(
      "docker",
      ["compose", "--env-file", envPath, "-f", composePath, "-p", "cinatra_iso57test", "config", "--format", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
    resolved = JSON.parse(r.stdout);
    configStderr = r.stderr;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the generated compose carries NO plaintext OPERATOR secret (it is scrubbed to ${VAR})", () => {
    const body = readFileSync(composePath, "utf8");
    expect(body).not.toContain("sk-operator-secret");
    expect(body).toContain("${OPENAI_API_KEY}");
  });

  it("`docker compose config` resolves every required infra password to NON-BLANK", () => {
    for (const [svc, keys] of Object.entries(REQUIRED)) {
      const env = resolved.services?.[svc]?.environment ?? {};
      for (const k of keys) {
        // INVARIANT (cinatra-cli#57): never an empty string (the bug → DB init fails).
        expect(typeof env[k], `${svc}.${k} must be a resolved string`).toBe("string");
        expect(env[k].length, `${svc}.${k} resolved BLANK`).toBeGreaterThan(0);
      }
    }
  });

  it("does NOT collapse the distinct per-service POSTGRES_PASSWORD values", () => {
    expect(resolved.services.postgres.environment.POSTGRES_PASSWORD).toBe("postgres");
    expect(resolved.services["nango-db"].environment.POSTGRES_PASSWORD).toBe("nango");
  });

  it("resolves the OPERATOR secret from the env-file (not blank, not the literal donor value baked in)", () => {
    expect(resolved.services.postgres.environment.OPENAI_API_KEY).toBe("sk-operator-secret");
  });

  it("emits NO 'variable is not set / blank string' warning (the bug's signature)", () => {
    const r = spawnSync(
      "docker",
      ["compose", "--env-file", envPath, "-f", composePath, "-p", "cinatra_iso57test", "config"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/variable is not set\. Defaulting to a blank string/i);
    expect(configStderr).not.toMatch(/variable is not set\. Defaulting to a blank string/i);
  });
});

// cinatra-cli#57 — `docker compose config` must interpolate ${VAR} from
// `.env.local` (via --env-file), else an operator secret sourced as
// `${OPERATOR_SECRET:-}` resolves to its empty default at config time and would
// never reach the isolated container. This proves composeConfigForFiles' fix.
describe.skipIf(!HAVE_DOCKER)("cinatra-cli#57 — config interpolates ${VAR} from .env.local (--env-file)", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-57-envfile-"));
    writeFileSync(
      path.join(dir, "docker-compose.yml"),
      JSON.stringify({
        services: { app: { image: "alpine:3", environment: { OPENAI_API_KEY: "${OPENAI_API_KEY:-}" }, command: "true" } },
      }),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("WITHOUT .env.local the ${VAR:-} resolves to its empty default", () => {
    const r = spawnSync("docker", ["compose", "-f", "docker-compose.yml", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).services.app.environment.OPENAI_API_KEY).toBe("");
  });

  it("WITH --env-file .env.local the operator secret is interpolated from the file", () => {
    writeFileSync(path.join(dir, ".env.local"), "OPENAI_API_KEY=sk-operator-from-envlocal\n", { mode: 0o600 });
    const r = spawnSync(
      "docker",
      ["compose", "--env-file", ".env.local", "-f", "docker-compose.yml", "config", "--format", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).services.app.environment.OPENAI_API_KEY).toBe("sk-operator-from-envlocal");
  });
});

// cinatra-cli#97 — DOCKER-GATED proof that the isolated nango-server container
// advertises its OWN (isolated) host port, not the donor's. The generator shifts
// the self-advertised loopback URLs (NANGO_SERVER_URL / NANGO_PUBLIC_SERVER_URL:
// http://localhost:3003) by the offset; this runs the REAL `docker compose
// config` engine and asserts the RESOLVED container env carries the SHIFTED URL
// (…:23003 for offset 20000) while a service-DNS infra URL + bare port stay
// verbatim, and the published host port itself moved to the same band.
//
// envFileKeys is an EMPTY set: like a real isolated install, .env.local does not
// supply these compose-baked defaults, so the generator keeps them LITERAL and
// `config` resolves them without a --env-file (and with no blank-string warning).
describe.skipIf(!HAVE_DOCKER)("cinatra-cli#97 — real `docker compose config` resolves the isolated nango self-URL", () => {
  let dir;
  let resolved;
  let configStderr;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-97-docker-"));
    const nangoConfig = {
      name: "cinatra",
      services: {
        "nango-server": {
          image: "alpine:3",
          command: "true",
          environment: {
            SERVER_PORT: "3003",
            NANGO_SERVER_URL: "http://localhost:3003",
            NANGO_PUBLIC_SERVER_URL: "http://localhost:3003",
            RECORDS_DATABASE_URL: "postgresql://nango-db:5432/nango",
          },
          ports: [{ published: "3003", target: 3003, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
      },
      networks: { default: { name: "cinatra_default" } },
      volumes: {},
    };
    const { doc } = generateIsolatedCompose({
      resolvedConfig: nangoConfig,
      offset: 20000,
      projectName: "cinatra_iso97test",
      slug: "iso97test",
      appPort: 33010,
      envFileKeys: new Set(),
    });
    const composePath = writeIsolatedComposeFile(path.join(dir, ISOLATED_COMPOSE_FILENAME), doc);
    const r = spawnSync(
      "docker",
      ["compose", "-f", composePath, "-p", "cinatra_iso97test", "config", "--format", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
    resolved = JSON.parse(r.stdout);
    configStderr = r.stderr;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the isolated nango-server advertises the SHIFTED host port (3003 → 23003), not the donor's", () => {
    const env = resolved.services["nango-server"].environment;
    expect(env.NANGO_SERVER_URL).toBe("http://localhost:23003");
    expect(env.NANGO_PUBLIC_SERVER_URL).toBe("http://localhost:23003");
    // The DONOR default port must NOT survive anywhere in the resolved env.
    expect(JSON.stringify(env)).not.toContain("localhost:3003");
  });

  it("leaves the in-network service-DNS infra URL + the bare port verbatim", () => {
    const env = resolved.services["nango-server"].environment;
    expect(env.RECORDS_DATABASE_URL).toBe("postgresql://nango-db:5432/nango");
    expect(env.SERVER_PORT).toBe("3003");
  });

  it("published the isolated host port on the shifted band (3003 → 23003) and emitted no blank-string warning", () => {
    const published = (resolved.services["nango-server"].ports ?? []).map((p) => String(p.published));
    expect(published).toContain("23003");
    expect(published).not.toContain("3003");
    expect(configStderr).not.toMatch(/variable is not set\. Defaulting to a blank string/i);
  });
});

// ── eng#513 — the REAL compose engine's `--profile "*"` contract ──────────────
// The isolated executor resolves the checkout's compose config with
// `--profile "*"` (composeConfigForFiles { allProfiles: true }) so profile-gated
// services (the real checkout's wayflow) enter the band/remap/self-URL logic.
// This proves the two engine behaviors that fix relies on, against the REAL
// `docker compose config`:
//   1. WITHOUT profiles a profile-gated service is DROPPED (why the leak hid);
//   2. WITH `--profile "*"` it is INCLUDED and its `profiles` attribute is
//      RETAINED (so a plain `up` of the generated file still skips it).
describe.skipIf(!HAVE_DOCKER)("eng#513 — real `docker compose --profile \"*\" config` includes profile-gated services WITH their profiles", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-513-profiles-"));
    writeFileSync(
      path.join(dir, "docker-compose.yml"),
      [
        "services:",
        "  postgres:",
        "    image: postgres:16-alpine",
        "    ports:",
        '      - "127.0.0.1:5434:5432"',
        "  wayflow:",
        "    image: alpine:3",
        "    profiles: [wayflow, drupal, wordpress]",
        "    ports:",
        '      - "127.0.0.1:3010:3010"',
        "",
      ].join("\n"),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function composeConfig(extraArgs) {
    const r = spawnSync(
      "docker",
      ["compose", ...extraArgs, "-f", "docker-compose.yml", "config", "--format", "json"],
      { cwd: dir, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }

  it("plain `config` DROPS the profile-gated service (the pre-fix blind spot)", () => {
    const resolved = composeConfig([]);
    expect(resolved.services.postgres).toBeDefined();
    expect(resolved.services.wayflow).toBeUndefined();
  });

  it('`--profile "*"` INCLUDES it, retains `profiles`, and exposes its published port', () => {
    const resolved = composeConfig(["--profile", "*"]);
    expect(resolved.services.wayflow).toBeDefined();
    expect(resolved.services.wayflow.profiles).toEqual(["wayflow", "drupal", "wordpress"]);
    const published = (resolved.services.wayflow.ports ?? []).map((p) => String(p.published));
    expect(published).toContain("3010");
  });
});
