// cinatra-cli#174 — DOCKER-GATED end-to-end verification of the execution-plane
// lifecycle (exec-plane S4; epic cinatra-ai/cinatra#1705).
//
// The hermetic tests in execution-mode.test.mjs pin the DECISIONS. This file
// proves the same contract through REAL Docker and a REAL Postgres, because the
// acceptance criteria are all statements about live surfaces:
//
//   AC1  a fresh `--execution-mode local-dev` yields a boot whose HANDSHAKE
//        succeeds with no manual env edits
//        → Rung 1 runs the boot phase's own probe command in a real container
//          over a real L0 image and judges it with the boot phase's own
//          predicate; Rung 2 writes both stores from a clean slate and asserts
//          every precondition the boot phase checks is satisfied WITHOUT any
//          hand editing.
//   AC2  `doctor` correctly diagnoses each induced failure
//        → Rung 3 induces broker-down, secret-wrong, image-missing and
//          gateway-absent FOR REAL and asserts the corresponding check (and only
//          that check's family) degrades with an actionable message.
//   AC3  `disabled` writes nothing and boot stays inert
//        → Rung 4 asserts a byte-identical `.env.local` and NO settings row.
//   +    the image lifecycle prunes superseded images
//        → Rung 5 builds two real images and prunes for real.
//
// OPT-IN, following the cli#58 precedent (tests/backup-nango-restore.test.mjs):
// this spins real containers and builds real images, so it runs only with
// `CINATRA_CLI_DOCKER_IT=1` (or `RUN_DOCKER_IT=1`) AND Docker available. Default
// `npm test` / CI stays lean and flake-free.
//
// L0 IMAGE SOURCE: when a cinatra checkout is reachable (CINATRA_CHECKOUT, or a
// sibling `../cinatra`) the REAL `docker/sandbox/Dockerfile` is built. Otherwise
// the rig builds a contract-equivalent stand-in (bash + the fixed 10001 runtime
// identity + /workspace) so the handshake rung still exercises the real hardened
// run profile. Which one was used is reported in the test name.

import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ROLLOUT_ENV_KEY,
  BROKER_URL_ENV_KEY,
  BROKER_SECRET_ENV_KEY,
  BROKER_SERVICE_TOKEN_ENV_KEY,
  PROVENANCE_KEY_ENV_KEY,
  L0_IMAGE_ENV_KEY,
  EXECUTION_SETTINGS_METADATA_KEY,
  CLI_MANAGED_EXECUTION_ENV_KEYS,
  GATEWAY_CONTAINER_NAME,
  HANDSHAKE_EXPECTED_STDOUT,
  planExecutionEnv,
  applyEnvUpsertsToBody,
  readExecutionEnv,
  evaluateClientReadiness,
  handshakeProbeRunArgs,
  evaluateHandshakeProbe,
  parseInspectedDigest,
  parseImageList,
  planImagePrune,
  l0BuildArgs,
  l0DigestInspectArgs,
  l0ImageListArgs,
  l0RemoveArgs,
  containerRunningArgs,
} from "../src/execution-mode.mjs";

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

const RUN_DOCKER_IT = process.env.CINATRA_CLI_DOCKER_IT === "1" || process.env.RUN_DOCKER_IT === "1";

function dockerAvailable() {
  return spawnSync("docker", ["version"], { encoding: "utf8" }).status === 0;
}

const HAVE_DOCKER = RUN_DOCKER_IT && dockerAvailable();

// Own names + an own port so a sibling lane can never collide with this rig.
const PG_CONTAINER = "cli174-it-pg";
const PG_PORT = 55574;
const PG_IMAGE = "postgres:17-alpine";
const L0_TAG = "cinatra-cli174-l0:dev";
const L0_SUPERSEDED_TAG = "cinatra-cli174-l0:superseded";
const L0_REPO = "cinatra-cli174-l0";
const PG_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
const SCHEMA = "cinatra";

let workdir = null;
let l0Source = "stand-in";

function docker(args, opts = {}) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 600_000, ...opts });
}

/** Locate a cinatra checkout carrying the REAL L0 Dockerfile, or null. */
function findCinatraCheckout() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.CINATRA_CHECKOUT,
    path.resolve(here, "..", "..", "cinatra"),
    path.resolve(here, "..", "..", "..", "cinatra"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "docker", "sandbox", "Dockerfile"))) return dir;
  }
  return null;
}

/**
 * A contract-equivalent stand-in for the L0 base image when no checkout is
 * reachable: the same fixed unprivileged runtime identity (10001:10001), the
 * same /workspace, and bash — which is everything the hardened run profile and
 * the handshake command depend on.
 */
const STANDIN_DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 sandbox \\
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash sandbox \\
 && mkdir -p /workspace && chown -R sandbox:sandbox /workspace /home/sandbox
WORKDIR /workspace
USER sandbox
CMD ["bash"]
`;

function buildL0Image(tag) {
  const checkout = findCinatraCheckout();
  if (checkout) {
    l0Source = "the REAL docker/sandbox/Dockerfile";
    const r = docker(
      l0BuildArgs({
        imageRef: tag,
        dockerfile: path.join(checkout, "docker", "sandbox", "Dockerfile"),
        buildContext: path.join(checkout, "docker", "sandbox"),
      }),
      { cwd: checkout },
    );
    if (r.status !== 0) throw new Error(`building the real L0 image failed: ${r.stderr}`);
    return;
  }
  l0Source = "a contract-equivalent stand-in";
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli174-l0-"));
  writeFileSync(path.join(dir, "Dockerfile"), STANDIN_DOCKERFILE);
  const r = docker(l0BuildArgs({ imageRef: tag, dockerfile: path.join(dir, "Dockerfile"), buildContext: dir }));
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`building the stand-in L0 image failed: ${r.stderr}`);
}

function psql(sql) {
  const r = docker(["exec", "-i", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
  });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

/** The metadata row the boot phase reads, straight out of Postgres. */
function readSettingsRowRaw() {
  const out = psql(
    `select value from ${SCHEMA}.metadata where key = '${EXECUTION_SETTINGS_METADATA_KEY}';`,
  );
  const m = out.match(/\{.*\}/s);
  return m ? JSON.parse(m[0]) : null;
}

function envPathIn(dir) {
  return path.join(dir, ".env.local");
}

function readEnvMap(dir) {
  const body = existsSync(envPathIn(dir)) ? readFileSync(envPathIn(dir), "utf8") : "";
  const out = {};
  for (const line of body.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

/** Write a plan into `.env.local` the way the CLI's persistExecutionEnv does. */
function applyPlanToEnvFile(dir, plan) {
  const before = existsSync(envPathIn(dir)) ? readFileSync(envPathIn(dir), "utf8") : "";
  writeFileSync(envPathIn(dir), applyEnvUpsertsToBody(before, plan.upserts), { mode: 0o600 });
}

/** Write the settings row the way the CLI's persistExecutionSettings does. */
function applySettingsRow(settings) {
  psql(
    `insert into ${SCHEMA}.metadata (key, value) values ('${EXECUTION_SETTINGS_METADATA_KEY}', '${JSON.stringify(
      settings,
    ).replaceAll("'", "''")}') on conflict (key) do update set value = excluded.value;`,
  );
}

/** Run the CLI's handshake mirror against a real container. */
function realHandshake(imageRef) {
  const started = Date.now();
  const r = docker(handshakeProbeRunArgs({ imageRef, name: `cli174-handshake-${process.pid}` }));
  return {
    probe: evaluateHandshakeProbe({
      ran: r.error === undefined || r.status !== null,
      exitCode: r.status,
      stdout: (r.stdout ?? "").trim(),
      timedOut: r.signal === "SIGTERM",
    }),
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    wallMs: Date.now() - started,
  };
}

/** Resolve a present image's digest through the real daemon, or null. */
function realDigest(imageRef) {
  const r = docker(l0DigestInspectArgs(imageRef));
  return r.status === 0 ? parseInspectedDigest(r.stdout) : null;
}

beforeAll(async () => {
  if (!HAVE_DOCKER) return;
  workdir = mkdtempSync(path.join(os.tmpdir(), "cli174-it-"));

  // A real Postgres holding the platform metadata store.
  docker(["rm", "-f", PG_CONTAINER]);
  const run = docker([
    "run", "-d", "--name", PG_CONTAINER,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-e", "POSTGRES_USER=postgres",
    "-e", "POSTGRES_DB=postgres",
    "-p", `${PG_PORT}:5432`,
    PG_IMAGE,
  ]);
  if (run.status !== 0) throw new Error(`docker run ${PG_CONTAINER} failed: ${run.stderr}`);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = docker(["exec", PG_CONTAINER, "pg_isready", "-U", "postgres"]).status === 0;
    if (!ready) spawnSync("sleep", ["1"]);
  }
  if (!ready) throw new Error(`${PG_CONTAINER} did not become ready`);

  // The metadata KV table the core's `readConnectorConfigFromDatabase` reads.
  psql(`create schema if not exists ${SCHEMA};
create table if not exists ${SCHEMA}.metadata (key text primary key, value text not null);`);

  buildL0Image(L0_TAG);
}, 900_000);

afterAll(() => {
  if (!HAVE_DOCKER) return;
  docker(["rm", "-f", PG_CONTAINER]);
  for (const tag of [L0_TAG, L0_SUPERSEDED_TAG]) docker(["image", "rm", "-f", tag]);
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Rung 1 — the handshake, for real (AC1's load-bearing half)
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#174 Rung 1 — the boot handshake runs for real on the L0 image", () => {
  it("the CLI's mirror of the boot probe returns the boot phase's own success predicate", () => {
    const { probe, stdout, stderr, wallMs } = realHandshake(L0_TAG);
    // The boot phase accepts ONLY: termination "exited", exit 0, exact stdout.
    expect(stdout, `stderr: ${stderr}`).toBe(HANDSHAKE_EXPECTED_STDOUT);
    expect(probe.ok, `probe reason: ${probe.reason} (built from ${l0Source})`).toBe(true);
    expect(wallMs).toBeGreaterThan(0);
  });

  it("it runs under the hardened profile: non-root 10001, read-only rootfs, no-new-privileges, no network", () => {
    // Same flags as the handshake argv, but a probe command that REPORTS the
    // properties — proving the profile the handshake ran under was real.
    const args = handshakeProbeRunArgs({ imageRef: L0_TAG });
    const term = args.indexOf("--");
    const introspect = [
      ...args.slice(0, term + 2), // everything up to and including the image ref
      "bash",
      "-c",
      'printf "UID=%s " "$(id -u)"; if : > /rotest 2>/dev/null; then printf "ROOTFS=rw "; else printf "ROOTFS=ro "; fi; grep -q "NoNewPrivs:.*1" /proc/self/status && printf "NNP=1" || printf "NNP=0"',
    ];
    const r = docker(introspect);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("UID=10001");
    expect(r.stdout).toContain("ROOTFS=ro");
    expect(r.stdout).toContain("NNP=1");
  });

  it("the image resolves a digest — the identity boot logs and the worker audits", () => {
    const digest = realDigest(L0_TAG);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Rung 2 — fresh local-dev provisioning: ZERO manual edits (AC1)
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#174 Rung 2 — `install --execution-mode local-dev` needs no manual edits", () => {
  let dir;

  beforeAll(() => {
    dir = path.join(workdir, "local-dev");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // A minimal, realistic `.env.local` exactly as install leaves it BEFORE the
    // execution-plane step — no execution keys at all.
    writeFileSync(
      envPathIn(dir),
      [`SUPABASE_DB_URL=${PG_URL}`, `SUPABASE_SCHEMA=${SCHEMA}`, "BETTER_AUTH_URL=http://localhost:3000", ""].join("\n"),
      { mode: 0o600 },
    );

    const plan = planExecutionEnv({
      mode: "local-dev",
      appOrigin: "http://localhost:3000",
      imageRef: L0_TAG,
      alreadyProvisioned: false,
      mintSecret: () => randomBytes(32).toString("hex"),
    });
    applyPlanToEnvFile(dir, plan);
    applySettingsRow(plan.settings);
  });

  it("writes EXACTLY the env contract the merged activation reads — and nothing it does not", () => {
    const env = readEnvMap(dir);
    expect(env[ROLLOUT_ENV_KEY]).toBe("on");
    expect(env[BROKER_URL_ENV_KEY]).toBe("http://localhost:3000/");
    expect(env[BROKER_SECRET_ENV_KEY]).toMatch(/^[0-9a-f]{64}$/);
    expect(env[BROKER_SERVICE_TOKEN_ENV_KEY]).toMatch(/^[0-9a-f]{64}$/);
    expect(env[PROVENANCE_KEY_ENV_KEY]).toMatch(/^[0-9a-f]{64}$/);
    expect(env[L0_IMAGE_ENV_KEY]).toBe(L0_TAG);
    // Not one of the keys #164 invented (no core reader exists for them).
    for (const invented of [
      "CINATRA_EXECUTION_MODE",
      "CINATRA_EXECUTION_BROKER_URL",
      "CINATRA_SANDBOX_L0_IMAGE_DIGEST",
      "CINATRA_SANDBOX_EGRESS_MODE",
    ]) {
      expect(env[invented]).toBeUndefined();
    }
    // The pre-existing keys are untouched.
    expect(env.SUPABASE_DB_URL).toBe(PG_URL);
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
  });

  it("persists the MODE in the database, because that is what the boot phase reads", () => {
    // Straight out of Postgres — not through any CLI helper.
    expect(readSettingsRowRaw()).toEqual({ mode: "local-dev", egressMode: "default_internet", egressAllowlist: [] });
  });

  it("every precondition the boot phase checks is satisfied with no hand editing", () => {
    const env = readEnvMap(dir);
    const cfg = readExecutionEnv(env);
    // 1. `isExecutionPlaneRolloutEnabled` — only the exact string "on".
    expect(cfg.rolloutOn).toBe(true);
    // 2. `evaluateExecutionPlaneReadiness` — url + secret, http(s), parseable.
    expect(evaluateClientReadiness(env[BROKER_URL_ENV_KEY], env[BROKER_SECRET_ENV_KEY])).toEqual({ state: "ready" });
    // 3. `resolveExecutionEnvironmentReadiness` — the provenance key.
    expect(cfg.provenanceKeyPresent).toBe(true);
    // 4. `readExecutionPlaneSettings` — mode local-dev (read from the real DB).
    expect(readSettingsRowRaw().mode).toBe("local-dev");
    // 5. `constructLocalDevExecutionBroker` — the L0 image is present…
    expect(realDigest(cfg.imageRef)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // …and its handshake COMPLETES. This is the readiness condition the boot
    // phase gates executor registration on.
    expect(realHandshake(cfg.imageRef).probe.ok).toBe(true);
  });

  it("no secret VALUE is ever surfaced by the CLI's own reader", () => {
    const cfg = readExecutionEnv(readEnvMap(dir));
    const serialized = JSON.stringify(cfg);
    for (const key of [BROKER_SECRET_ENV_KEY, BROKER_SERVICE_TOKEN_ENV_KEY, PROVENANCE_KEY_ENV_KEY]) {
      expect(serialized).not.toContain(readEnvMap(dir)[key]);
    }
    expect(cfg.brokerSecretPresent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rung 3 — the doctor diagnoses each INDUCED failure (AC2)
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#174 Rung 3 — each induced failure gets its own diagnosis", () => {
  /** Run the REAL doctor gatherer against a directory + env. */
  async function doctor(dir) {
    const { gatherExecutionDoctor } = await import("../src/index.mjs");
    return gatherExecutionDoctor({ repoRoot: dir, env: readEnvMap(dir) });
  }
  const byId = (checks, id) => checks.find((c) => c.id === id);

  function seed(name, { mode, mutate = () => {} }) {
    const dir = path.join(workdir, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      envPathIn(dir),
      [`SUPABASE_DB_URL=${PG_URL}`, `SUPABASE_SCHEMA=${SCHEMA}`, "BETTER_AUTH_URL=http://127.0.0.1:59999", ""].join("\n"),
      { mode: 0o600 },
    );
    const plan = planExecutionEnv({
      mode,
      appOrigin: "http://127.0.0.1:59999",
      imageRef: mode === "local-dev" ? L0_TAG : undefined,
      brokerUrl: mode === "remote" ? "http://127.0.0.1:59998" : null,
      brokerSecret: mode === "remote" ? "shared" : null,
      // A digest-pinned ref for remote (the mode requires one).
      ...(mode === "remote" ? { imageRef: `reg.invalid/l0@sha256:${"a".repeat(64)}` } : {}),
      mintSecret: () => randomBytes(32).toString("hex"),
    });
    applyPlanToEnvFile(dir, plan);
    applySettingsRow(plan.settings);
    mutate(dir);
    return dir;
  }

  it("INDUCED: broker DOWN (remote, nothing listening) → broker-reachability degrades", async () => {
    const dir = seed("broker-down", { mode: "remote" });
    const checks = await doctor(dir);
    const broker = byId(checks, "broker-reachability");
    expect(broker.verdict).toBe("degraded");
    expect(broker.detail).toMatch(/did not answer|could not be probed/);
    expect(broker.remediation).toMatch(/broker service is up/);
  });

  it("INDUCED: broker SECRET wrong (removed) → the mode + broker checks both name the seal failure", async () => {
    const dir = seed("secret-missing", {
      mode: "local-dev",
      mutate: (d) => {
        const body = readFileSync(envPathIn(d), "utf8");
        writeFileSync(envPathIn(d), body.replace(new RegExp(`^${BROKER_SECRET_ENV_KEY}=.*\n`, "m"), ""));
      },
    });
    const checks = await doctor(dir);
    expect(byId(checks, "execution-mode").verdict).toBe("degraded");
    expect(byId(checks, "execution-mode").detail).toMatch(new RegExp(`missing ${BROKER_SECRET_ENV_KEY}`));
    const broker = byId(checks, "broker-reachability");
    expect(broker.verdict).toBe("degraded");
    expect(broker.detail).toMatch(/cannot SEAL a job carrier/);
  });

  it("INDUCED: L0 image MISSING (real `docker image inspect` finds nothing) → image + handshake degrade", async () => {
    const dir = seed("image-missing", {
      mode: "local-dev",
      mutate: (d) => {
        const body = readFileSync(envPathIn(d), "utf8");
        writeFileSync(
          envPathIn(d),
          body.replace(new RegExp(`^${L0_IMAGE_ENV_KEY}=.*$`, "m"), `${L0_IMAGE_ENV_KEY}=cinatra-cli174-absent:dev`),
        );
      },
    });
    // Prove the premise against the LIVE daemon, not an assumption.
    expect(realDigest("cinatra-cli174-absent:dev")).toBeNull();

    const checks = await doctor(dir);
    const image = byId(checks, "l0-image");
    expect(image.verdict).toBe("degraded");
    expect(image.detail).toMatch(/NOT present on this host/);
    expect(image.remediation).toMatch(/execution image pull/);
    const handshake = byId(checks, "handshake");
    expect(handshake.verdict).toBe("degraded");
    expect(handshake.detail).toMatch(/register no executor/);
  });

  it("INDUCED: GATEWAY absent (a real `docker ps` that finds nothing) → gateway-container degrades", async () => {
    const dir = seed("gateway-absent", { mode: "local-dev" });

    // The absence is induced through the REAL daemon, but against a container
    // name THIS RIG owns. A shared dev machine may legitimately be running a
    // real `cinatra-exec-gateway` for another lane, and this test must never
    // remove or depend on someone else's container.
    const ABSENT = `${GATEWAY_CONTAINER_NAME}-cli174-absent`;
    const premise = docker(containerRunningArgs(ABSENT));
    expect(premise.status, premise.stderr).toBe(0);
    expect((premise.stdout ?? "").trim()).toBe("");

    const { gatherExecutionDoctor } = await import("../src/index.mjs");
    const checks = await gatherExecutionDoctor({
      repoRoot: dir,
      env: readEnvMap(dir),
      // Delegate EVERYTHING to the real daemon; only the gateway lookup is
      // re-pointed at the name we own, so the "not running" answer is a genuine
      // docker observation rather than a stub.
      dockerImpl: (args) => {
        const rewritten = args.map((a) => (typeof a === "string" ? a.split(GATEWAY_CONTAINER_NAME).join(ABSENT) : a));
        const r = docker(rewritten);
        return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim(), timedOut: false };
      },
    });

    const gateway = byId(checks, "gateway-container");
    expect(gateway.verdict).toBe("degraded");
    expect(gateway.detail).toMatch(new RegExp(GATEWAY_CONTAINER_NAME));
    expect(gateway.remediation).toBeTruthy();
  });

  it("the gateway check NEVER silently passes — it is always one of the three verdicts", async () => {
    const dir = seed("gateway-live", { mode: "local-dev" });
    const gateway = byId(await doctor(dir), "gateway-container");
    // Whatever this machine's real gateway state is, the check must state it.
    expect(["healthy", "degraded", "disabled"]).toContain(gateway.verdict);
    expect(String(gateway.detail).length).toBeGreaterThan(10);
  });

  it("a fully-provisioned local-dev instance keeps the image + handshake checks HEALTHY", async () => {
    const dir = seed("healthy", { mode: "local-dev" });
    const checks = await doctor(dir);
    // The app is deliberately not running in this rig, so broker/gateway report
    // the app-down truth; the two checks that do NOT depend on a live app must
    // be green — those are the ones the boot handshake itself depends on.
    expect(byId(checks, "l0-image").verdict).toBe("healthy");
    expect(byId(checks, "handshake").verdict).toBe("healthy");
    expect(byId(checks, "execution-mode").verdict).toBe("healthy");
  });

  it("every degraded check carries an actionable remediation (never a bare failure)", async () => {
    const dir = seed("actionable", { mode: "local-dev" });
    for (const c of await doctor(dir)) {
      if (c.verdict === "degraded") expect(String(c.remediation ?? "").length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Rung 4 — `disabled` writes nothing (AC3)
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#174 Rung 4 — `disabled` writes nothing and leaves the instance inert", () => {
  it("a fresh disabled install leaves `.env.local` BYTE-IDENTICAL and creates no settings row", () => {
    const dir = path.join(workdir, "disabled");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const original = [`SUPABASE_DB_URL=${PG_URL}`, `SUPABASE_SCHEMA=${SCHEMA}`, "BETTER_AUTH_URL=http://localhost:3000", ""].join("\n");
    writeFileSync(envPathIn(dir), original, { mode: 0o600 });

    // Clear any row a previous rung wrote, then run the disabled plan.
    psql(`delete from ${SCHEMA}.metadata where key = '${EXECUTION_SETTINGS_METADATA_KEY}';`);
    const plan = planExecutionEnv({ mode: "disabled", alreadyProvisioned: false });
    expect(plan.upserts).toEqual([]);
    expect(plan.settings).toBeNull();
    applyPlanToEnvFile(dir, plan);

    expect(readFileSync(envPathIn(dir), "utf8")).toBe(original);
    expect(readSettingsRowRaw()).toBeNull();

    // And the resulting posture is the inert one: rollout unset ⇒ the boot
    // orchestrator contributes NO execution phase at all.
    const cfg = readExecutionEnv(readEnvMap(dir));
    expect(cfg.rolloutOn).toBe(false);
    expect(cfg.clientReadiness).toEqual({ state: "not-configured" });
  });

  it("switching an ALREADY-PROVISIONED instance to disabled clears every CLI-managed key", () => {
    const dir = path.join(workdir, "disabled-switch");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(envPathIn(dir), [`SUPABASE_DB_URL=${PG_URL}`, `SUPABASE_SCHEMA=${SCHEMA}`, "KEEP_ME=1", ""].join("\n"), {
      mode: 0o600,
    });
    applyPlanToEnvFile(
      dir,
      planExecutionEnv({
        mode: "local-dev",
        appOrigin: "http://localhost:3000",
        imageRef: L0_TAG,
        mintSecret: () => "f".repeat(64),
      }),
    );
    expect(readEnvMap(dir)[ROLLOUT_ENV_KEY]).toBe("on");

    const off = planExecutionEnv({ mode: "disabled", alreadyProvisioned: true });
    applyPlanToEnvFile(dir, off);
    applySettingsRow(off.settings);

    const env = readEnvMap(dir);
    for (const key of CLI_MANAGED_EXECUTION_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env.KEEP_ME).toBe("1");
    expect(readSettingsRowRaw()).toEqual({ mode: "disabled", egressMode: "default_internet", egressAllowlist: [] });
  });
});

// ---------------------------------------------------------------------------
// Rung 5 — image lifecycle: prune superseded images, for real
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_DOCKER)("cinatra-cli#174 Rung 5 — the L0 image prune reaps ONLY superseded images", () => {
  it("keeps the configured image and removes the superseded one, through the real daemon", () => {
    // Tag a second, superseded image in the same repo.
    docker(["tag", L0_TAG, `${L0_REPO}:current`]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "cli174-prune-"));
    writeFileSync(path.join(dir, "Dockerfile"), `${STANDIN_DOCKERFILE}\nRUN true # supersede\n`);
    const built = docker(l0BuildArgs({ imageRef: L0_SUPERSEDED_TAG, dockerfile: path.join(dir, "Dockerfile"), buildContext: dir }));
    rmSync(dir, { recursive: true, force: true });
    expect(built.status, built.stderr).toBe(0);

    const listed = docker(l0ImageListArgs(L0_REPO));
    expect(listed.status).toBe(0);
    const images = parseImageList(listed.stdout);
    expect(images.length).toBeGreaterThanOrEqual(2);

    const keepDigest = realDigest(`${L0_REPO}:current`);
    const plan = planImagePrune({ images, keepDigest, keepRef: `${L0_REPO}:current`, inUseIds: [] });
    expect(plan.keep.some((i) => i.ref === `${L0_REPO}:current`)).toBe(true);
    expect(plan.remove.some((i) => i.ref === L0_SUPERSEDED_TAG)).toBe(true);

    for (const img of plan.remove) docker(l0RemoveArgs(img.ref));
    // The configured image survives; the superseded one is gone.
    expect(realDigest(`${L0_REPO}:current`)).toBe(keepDigest);
    expect(realDigest(L0_SUPERSEDED_TAG)).toBeNull();
    docker(["image", "rm", "-f", `${L0_REPO}:current`]);
  }, 900_000);
});
