// cinatra-cli#17 — install multi-instance flow: parser enum surface (T5a/T5b),
// --status/--list-instances (T6), and the runInstall conflict → classify →
// execute paths (isolated T8/T8b, default-record T8c, stop-existing T11, attach
// T12, external T13). Docker is fully stubbed via the injectable `deps` seam —
// no live daemon / Postgres needed.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REPO_URL,
  assertIsolatedPortsStillConverge,
  effectiveIsolatedPortsFromDoc,
  parseInstallArgs,
  runInstall,
  writeIsolatedAppEnv,
} from "../src/install.mjs";
import { parseIsolatedComposeDoc, writeIsolatedComposeFile } from "../src/install-isolation.mjs";
import { readInstanceRegistry } from "../src/instance-registry.mjs";
import { readMarker } from "../src/instance-marker.mjs";
// cinatra#2654 (round 5) — `instance wayflow start`'s fallback-route detector +
// regeneration, exercised against a REAL generated isolated compose (the same
// fixture style as the D1 round-4 tests below).
import { reconcileIsolatedWayflowRoute } from "../src/index.mjs";
import { RecreatePreflightError } from "../src/recreate-preflight.mjs";

// ---------------------------------------------------------------------------
// T5a/T5b — parser enum surface + gated co-use.
// ---------------------------------------------------------------------------
describe("parseInstallArgs — cinatra-cli#17 surface", () => {
  it("accepts the implemented --infra / --on-conflict enums", () => {
    expect(parseInstallArgs(["--infra", "new"]).infra).toBe("new");
    expect(parseInstallArgs(["--infra", "external"]).infra).toBe("external");
    expect(parseInstallArgs(["--on-conflict", "isolated"]).onConflict).toBe("isolated");
    expect(parseInstallArgs(["--on-conflict", "stop-existing"]).onConflict).toBe("stop-existing");
    expect(parseInstallArgs(["--on-conflict", "attach"]).onConflict).toBe("attach");
  });

  it("ACCEPTS the gated values as valid enums but flags couseRequested (T5b)", () => {
    expect(parseInstallArgs(["--infra", "share"]).infra).toBe("share");
    expect(parseInstallArgs(["--infra", "share"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--on-conflict", "co-use"]).onConflict).toBe("co-use");
    expect(parseInstallArgs(["--on-conflict", "co-use"]).couseRequested).toBe(true);
    // co-use sidecar flags also trip the gate.
    expect(parseInstallArgs(["--db-name", "cinatra_clone_x"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--reuse-from", "/x"]).couseRequested).toBe(true);
  });

  it("rejects an unknown enum value cleanly", () => {
    expect(() => parseInstallArgs(["--infra", "bogus"])).toThrow(/Invalid --infra/);
    expect(() => parseInstallArgs(["--on-conflict", "nope"])).toThrow(/Invalid --on-conflict/);
  });

  it("honours the documented INLINE `--flag=value` form (not just `--flag value`)", () => {
    // The README / --help / CHANGELOG advertise the `=` form; the install parser
    // MUST honour it, or a documented `--infra=share` silently parses as absent
    // and BYPASSES the co-use gate (and the other `=`-form flags no-op).
    expect(parseInstallArgs(["--infra=share"]).infra).toBe("share");
    expect(parseInstallArgs(["--infra=share"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--on-conflict=co-use"]).couseRequested).toBe(true);
    expect(parseInstallArgs(["--on-conflict=isolated"]).onConflict).toBe("isolated");
    expect(parseInstallArgs(["--infra=external"]).infra).toBe("external");
    expect(parseInstallArgs(["--instance=alpha"]).instance).toBe("alpha");
    expect(parseInstallArgs(["--app-port=3400"]).appPort).toBe(3400);
    expect(parseInstallArgs(["--port-offset=20000"]).portOffset).toBe(20000);
    expect(parseInstallArgs(["--db-url=postgres://h/db"]).external.dbUrl).toBe("postgres://h/db");
    // An unknown `=` value still errors cleanly.
    expect(() => parseInstallArgs(["--infra=bogus"])).toThrow(/Invalid --infra/);
    // `--db-name=` (a co-use sidecar) in the `=` form also trips the gate.
    expect(parseInstallArgs(["--db-name=cinatra_x"]).couseRequested).toBe(true);
  });

  it("--no-infra is an alias for --infra=external (not dropped)", () => {
    const o = parseInstallArgs(["--no-infra"]);
    expect(o.infra).toBe("external");
    expect(o.noInfra).toBe(true);
  });

  it("--no-infra conflicting with --infra=new throws", () => {
    expect(() => parseInstallArgs(["--no-infra", "--infra", "new"])).toThrow(/conflicts with --infra/);
  });

  it("validates --instance / --app-port / --port-offset", () => {
    expect(parseInstallArgs(["--instance", "alpha"]).instance).toBe("alpha");
    expect(() => parseInstallArgs(["--instance", "Bad Slug"])).toThrow(/Invalid --instance/);
    expect(parseInstallArgs(["--app-port", "3400"]).appPort).toBe(3400);
    expect(() => parseInstallArgs(["--app-port", "80"])).toThrow(/Invalid --app-port/);
    expect(parseInstallArgs(["--port-offset", "auto"]).portOffset).toBe("auto");
    expect(parseInstallArgs(["--port-offset", "20000"]).portOffset).toBe(20000);
    expect(() => parseInstallArgs(["--port-offset", "5000"])).toThrow(/Invalid --port-offset/);
  });

  it("parses the boolean read-only + external flags", () => {
    const o = parseInstallArgs([
      "--status", "--list-instances", "--dry-run", "--resume", "--teardown-existing",
      "--db-url", "postgres://h/db",
    ]);
    expect(o.status && o.listInstances && o.dryRun && o.resume && o.teardownExisting).toBe(true);
    expect(o.external.dbUrl).toBe("postgres://h/db");
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#40 — co-use fail-CLOSED capability gate before any side effect.
//   The old flat "not yet available" refusal is replaced by the executor's
//   capability probe: against a donor app build WITHOUT per-instance cookie
//   isolation (the real state today), co-use is REFUSED — but now with the
//   precise upstream pointer, still BEFORE any clone/write. The probe defaults
//   (no deps) read a (missing) donor src/lib/auth.ts → unsupported → refuse.
// ---------------------------------------------------------------------------
describe("runInstall — co-use fail-closed capability gate (cinatra-cli#40)", () => {
  const couseRefuse = /Co-use is refused: the donor Cinatra app build does NOT isolate auth cookies/s;
  it("--infra=share refuses (no cookie-prefix support) before any side effect", async () => {
    await expect(runInstall(["--infra", "share", "--yes"], { log: () => {} })).rejects.toThrow(couseRefuse);
  });
  it("--on-conflict=co-use refuses with the same fail-closed message", async () => {
    await expect(runInstall(["--on-conflict", "co-use", "--yes"], { log: () => {} })).rejects.toThrow(couseRefuse);
  });
  it("gates co-use through the INLINE `=` form too (the documented spelling)", async () => {
    // Regression: the `=` form must gate BEFORE any side effect, exactly like the
    // space form — otherwise `cinatra install --infra=share` proceeds to clone +
    // bring up infra (co-use NOT actually gated).
    await expect(runInstall(["--infra=share", "--yes"], { log: () => {} })).rejects.toThrow(couseRefuse);
    await expect(runInstall(["--on-conflict=co-use", "--yes"], { log: () => {} })).rejects.toThrow(couseRefuse);
  });
});

// ---------------------------------------------------------------------------
// Shared fixture: a valid minimal cinatra checkout reachable via file:// remote.
// ---------------------------------------------------------------------------
function buildFixtureOrigin(sandbox) {
  const src = path.join(sandbox, "src");
  mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
  writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  writeFileSync(
    path.join(src, "packages", "migrations", "package.json"),
    JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
  );
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }));
  writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      stdio: "ignore",
    });
  G(["init", "-b", "main"], src);
  G(["add", "-A"], src);
  G(["commit", "-m", "init"], src);
  const originRepo = path.join(sandbox, "origin.git");
  G(["clone", "--bare", src, originRepo], sandbox);
  return originRepo;
}

// A docker/compose-present preflight that lets the gates run; the band/probe/
// infra seams are overridden per test.
const dockerPresentDeps = () => ({
  runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
  commandExists: () => true,
  composeAvailable: () => true,
});

// The resolved `docker compose config` for the fixture's default band.
const RESOLVED_CONFIG = {
  name: "cinatra",
  services: {
    postgres: {
      image: "postgres:16",
      environment: { POSTGRES_PASSWORD: "secret-plain" },
      ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    },
    redis: {
      image: "redis",
      ports: [{ published: "6379", target: 6379, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    },
    "nango-server": {
      image: "nango",
      ports: [{ published: "3003", target: 3003, host_ip: "0.0.0.0", protocol: "tcp", mode: "host" }],
    },
    "nango-db": {
      image: "postgres:16",
      ports: [{ published: "5435", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    },
  },
  networks: { default: { name: "cinatra_default" } },
  volumes: { "cinatra-postgres": { name: "cinatra_cinatra-postgres" } },
};
const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "nango-server", host: "0.0.0.0", port: 3003 },
  { service: "nango-db", host: "127.0.0.1", port: 5435 },
];

describe("runInstall — conflict resolution (cinatra-cli#17)", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-flow-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  let regPath;
  let lockPath;
  beforeEach(() => {
    // Per-test isolated registry + lock (redirect via env so the path resolvers
    // pick them up everywhere, incl. the read-only status path).
    const d = mkdtempSync(path.join(sandbox, "home-"));
    regPath = path.join(d, "instances.json");
    lockPath = path.join(d, "alloc.lock");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = lockPath;
  });

  function flowDeps(extra = {}) {
    return {
      ...dockerPresentDeps(),
      composePublishedPortsForTarget: () => DEFAULT_BAND,
      composeConfigForFiles: () => RESOLVED_CONFIG,
      // cinatra#2654 D1: pin the Compose feature probe so these tests assert the
      // PRESERVED-reference route regardless of the Compose on the machine
      // running them (the injected `composeConfigForFiles` above always returns
      // a document that keeps `env_file:`, so the route must match).
      composeSupportsNoEnvResolution: () => true,
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      bringUpInfra: () => {},
      // cinatra#2654 D1: the isolated executor provisions the WayFlow
      // bridge-token env before it resolves the compose. These tests drive
      // conflict resolution and allocation against a sandbox checkout that has no
      // `scripts/` tree, so the step is stubbed here exactly as the bring-up is;
      // tests/wayflow-isolated-env-file.test.mjs owns its real behaviour.
      generateWayflowEnv: () => ({ ok: true, skipped: true, reason: null }),
      runComposeDown: () => {},
      // cinatra-cli#35: default-path ownership preflight inspector — no existing
      // project/volume conflict by default (brand-new install). Per-test overrides
      // inject foreign/legacy rows.
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      ...extra,
    };
  }

  it("T8c: a clean DEFAULT install records a ready registry row + marker", async () => {
    const installDir = path.join(sandbox, "default-ok");
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: () => {},
        deps: flowDeps({ detectPortConflicts: async () => [] }), // no conflict
      },
    );
    expect(res.infraPlan).toBe("default");
    expect(res.instance).toBe("default-ok");
    const reg = readInstanceRegistry(regPath);
    expect(reg.status).toBe("ok");
    expect(reg.registry.instances["default-ok"].state).toBe("ready");
    // cinatra-cli#35: the default row records the EXPLICIT instance-scoped
    // Compose project name (`cinatra_<slug>`), NOT the old hardcoded "cinatra"
    // literal that collided for two dirs both named `cinatra`.
    expect(reg.registry.instances["default-ok"].composeProject).toBe("cinatra_default_ok");
    // marker written + reconcilable.
    expect(readMarker(installDir).status).toBe("ok");
  });

  // ── cinatra-cli#140 — recreate paths consult the fail-closed upgrade preflight ──
  it("#140: the default recreate routes through the upgrade gate (right slug/project) and a block ABORTS before compose up", async () => {
    // Using the REAL bringUpInfra (not the stub) so the gate actually runs; the
    // injected preflight BLOCKS, so the abort happens before a single `docker
    // compose up` — no daemon is touched (a real `up` would surface a docker
    // error, not our sentinel message).
    const installDir = path.join(sandbox, "p140-default");
    let seen = null;
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [],
            bringUpInfra: undefined, // fall through to the real bringUpInfra → the gate runs
            assertRecreateSafe: (args) => {
              seen = args;
              throw new RecreatePreflightError("STOP: nango-db 15 → 17 pending", { findings: [{ service: "nango-db", verdict: "stop" }] });
            },
          }),
        },
      ),
    ).rejects.toThrow(/STOP: nango-db 15 → 17 pending/);
    // The gate was asked to check the DEPLOYMENT's actual identity: the slug
    // recordDefaultInstance keys on, the project this `up` uses, and the dir.
    expect(seen).toBeTruthy();
    expect(seen.slug).toBe("p140-default");
    expect(seen.composeProject).toBe("cinatra_p140_default");
    expect(seen.targetDir).toBe(installDir);
    // The block aborted BEFORE the registry row flipped to ready.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["p140-default"]?.state ?? "absent").not.toBe("ready");
  });

  it("#35: the default `up` is invoked with the computed instance-scoped `-p`", async () => {
    const installDir = path.join(sandbox, "p35-default");
    const upCalls = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [], // no conflict
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("default");
    // The default `up` passed an EXPLICIT `-p cinatra_<slug>` (never the bare
    // dir basename) — the core data-risk fix.
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].composeProject).toBe("cinatra_p35_default");
    // cinatra-cli#144: the default (non-isolated) `up` is ALSO given
    // `--env-file .env.local` (mirroring the isolated `up` at T8/T8b) so the
    // base docker-compose.yml's `${NANGO_ENCRYPTION_KEY}` / `${CINATRA_BRIDGE_TOKEN}`
    // resolve from the freshly-minted secret instead of BLANK. Regression guard
    // for the exact silent-empty-secret defect (#108 shipped this; #140 dropped
    // it during the recreate-preflight refactor).
    expect(upCalls[0].envFile).toMatch(/\.env\.local$/);
    expect(upCalls[0].envFile).toBe(path.join(installDir, ".env.local"));
    // …and the file the env-file points at actually carries a populated secret
    // (ensureEnvLocal minted it) — proving the value that now flows is non-empty.
    expect(readFileSync(upCalls[0].envFile, "utf8")).toMatch(/^NANGO_ENCRYPTION_KEY=.+$/m);
    // …and the SAME name is recorded.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["p35-default"].composeProject).toBe("cinatra_p35_default");
  });

  it("#144: the default `up` FAILS CLOSED when .env.local is absent (never starts empty-secret containers)", async () => {
    const installDir = path.join(sandbox, "p144-missing-env");
    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [], // no conflict → default plan
            // Force the "unreachable" broken state: ensureEnvLocal (step 5)
            // materialized .env.local, but by the time the default bring-up runs
            // it is gone. inspectProjectOwnership runs INSIDE resolveDefaultProject,
            // just before the fail-closed guard — delete the file there.
            inspectProjectOwnership: () => {
              const envLocal = path.join(installDir, ".env.local");
              if (existsSync(envLocal)) rmSync(envLocal);
              return { containerRows: [], volumeRows: [] };
            },
            bringUpInfra: (args) => upCalls.push(args),
          }),
        },
      ),
    ).rejects.toThrow(/Refusing to start the default stack — .*\.env\.local is missing/);
    // The guard fired BEFORE any container was (re)created — no bring-up ran.
    expect(upCalls).toEqual([]);
    // …and the broken install did not flip a registry row to ready.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["p144-missing-env"]?.state ?? "absent").not.toBe("ready");
  });

  it("#35: a mismatched-working_dir inspect row REJECTS before `up` (no bringUpInfra)", async () => {
    const installDir = path.join(sandbox, "p35-hijack");
    const otherDir = path.join(sandbox, "p35-other-checkout");
    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [], // ports are FREE (the sibling is stopped)
            bringUpInfra: (args) => upCalls.push(args),
            // The candidate project already exists, owned by a DIFFERENT checkout.
            inspectProjectOwnership: () => ({
              containerRows: [
                {
                  Config: {
                    Labels: {
                      "com.docker.compose.project": "cinatra_p35_hijack",
                      "com.docker.compose.project.working_dir": otherDir,
                    },
                  },
                },
              ],
              volumeRows: [],
            }),
          }),
        },
      ),
    ).rejects.toThrow(/Refusing the default install.*different checkout/s);
    // HARD proof: infra was NEVER brought up (no hijack/recreate).
    expect(upCalls).toEqual([]);
    // No registry row recorded for the rejected install.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["p35-hijack"]).toBeUndefined();
  });

  it("#35: a STOPPED sibling at a different dir (ps -a row) refuses (the port preflight misses it)", async () => {
    const installDir = path.join(sandbox, "p35-stopped");
    const otherDir = path.join(sandbox, "p35-stopped-other");
    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            // The sibling is STOPPED → it holds NO ports → the port probe is clean.
            detectPortConflicts: async () => [],
            bringUpInfra: (args) => upCalls.push(args),
            // …but `docker ps -a` still finds its (stopped) container's labels.
            inspectProjectOwnership: () => ({
              containerRows: [
                {
                  Config: {
                    Labels: {
                      "com.docker.compose.project": "cinatra_p35_stopped",
                      "com.docker.compose.project.working_dir": otherDir,
                    },
                  },
                },
              ],
              volumeRows: [],
            }),
          }),
        },
      ),
    ).rejects.toThrow(/Refusing the default install/);
    expect(upCalls).toEqual([]);
  });

  it("#35: a legacy basename project rooted at THIS dir is ADOPTED (keeps `-p <basename>`)", async () => {
    // Install into a dir whose basename is `cinatra` (the collision case) — an
    // existing legacy `cinatra` stack rooted HERE must be adopted (volumes stay
    // stable), NOT renamed to `cinatra_cinatra` (which would orphan it + point at
    // fresh empty volumes).
    const parent = mkdtempSync(path.join(sandbox, "legacy-"));
    const installDir = path.join(parent, "cinatra"); // basename = cinatra
    const upCalls = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [],
          bringUpInfra: (args) => upCalls.push(args),
          // A legacy `cinatra` (basename) stack rooted at THIS checkout.
          inspectProjectOwnership: () => ({
            containerRows: [
              {
                Config: {
                  Labels: {
                    "com.docker.compose.project": "cinatra",
                    "com.docker.compose.project.working_dir": path.resolve(installDir),
                  },
                },
              },
            ],
            volumeRows: [],
          }),
        }),
      },
    );
    expect(res.infraPlan).toBe("default");
    // ADOPTED: the up kept the legacy `-p cinatra` (basename), not `cinatra_cinatra`.
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].composeProject).toBe("cinatra");
    // …and the adopted name is what gets recorded.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["cinatra"].composeProject).toBe("cinatra");
  });

  it("#35: a prior EXTERNAL/--no-infra row at this dir does NOT prove Docker ownership of a foreign volume", async () => {
    // Review blocker (non-Docker-owning row false-proof): `recordDefaultInstance`
    // records `composeProject` even for an `external` (`--no-infra`) install that
    // never started a Docker stack.
    // That row must NOT count as proof we own the named volumes — otherwise a
    // foreign checkout's name-matching (unknown-working_dir) volume would be
    // silently reused. Stage such an external row, then run a DEFAULT install at
    // the SAME dir while a foreign candidate volume (no working_dir) exists → the
    // ownership preflight must still REFUSE.
    const { writeInstanceRegistry, allocateInstance } = await import("../src/instance-registry.mjs");
    const installDir = path.join(sandbox, "p35-extrow");
    // Pre-seed an EXTERNAL ready-ish row recording the candidate project for this dir.
    let reg0 = allocateInstance({ version: 1, instances: {} }, "p35-extrow", {
      mode: "dev",
      installDir,
      composeProject: "cinatra_p35_extrow",
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      ports: {},
      appPort: 3000,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "external",
      state: "external",
    }).registry;
    writeInstanceRegistry(regPath, reg0);

    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [],
            bringUpInfra: (args) => upCalls.push(args),
            // A foreign candidate-labelled volume with NO working_dir (project-name
            // only) — must NOT be reused on the strength of the external row.
            inspectProjectOwnership: () => ({
              containerRows: [],
              volumeRows: [{ name: "cinatra_p35_extrow_postgres", project: "cinatra_p35_extrow", workingDir: null }],
            }),
          }),
        },
      ),
    ).rejects.toThrow(/Refusing the default install.*unverifiable owner/s);
    expect(upCalls).toEqual([]);
  });

  it("#37: --dry-run on the default path never calls the bringUpInfra seam", async () => {
    const installDir = path.join(sandbox, "dry-flow");
    const upCalls = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [], // no conflict
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.dryRun).toBe(true);
    // The infra seam was NOT invoked (no `docker compose up`).
    expect(upCalls).toEqual([]);
    // No clone happened → no marker, no .env.local.
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(false);
  });

  it("#37 (codex re-review): --dry-run PREVIEWS a default-band port conflict instead of THROWING", async () => {
    // Regression for the codex blocker: the pre-clone port-conflict guard
    // threw before the dry-run short-circuit, so a --dry-run with a default-band
    // conflict aborted before the preview was ever produced. The fix relocates
    // the dry-run early-return AHEAD of the throwing guard AND the writable
    // temp-probe, so a conflict is REPORTED (never thrown) and ZERO filesystem
    // side effects occur.
    const installDir = path.join(sandbox, "dry-conflict");
    const upCalls = [];
    const probedBands = [];
    const logs = [];
    let res;
    await expect(
      (async () => {
        res = await runInstall(
          ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
          {
            log: (m) => logs.push(String(m)),
            deps: flowDeps({
              // The default band is in conflict (someone holds postgres 5434).
              detectPortConflicts: async (band) => {
                probedBands.push(band);
                return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
              },
              bringUpInfra: (args) => upCalls.push(args),
            }),
          },
        );
      })(),
    ).resolves.toBeUndefined(); // (a) it did NOT throw on the conflict.

    // (b) the preview returned dryRun:true.
    expect(res.dryRun).toBe(true);
    // (c) the conflict is carried in BOTH the returned plan and the log output.
    expect(res.conflicts).toEqual([5434]);
    const out = logs.join("\n");
    expect(out).toMatch(/conflict:\s+port 5434 held/);
    expect(out).toMatch(/Infra plan:\s+default \(port conflict detected on 5434/);
    // The read-only port probe DID run (proving the dry-run block, not the
    // throwing guard, performed the conflict classification).
    expect(probedBands.length).toBeGreaterThan(0);
    // (d) infra was NOT brought up.
    expect(upCalls).toEqual([]);
    // (e) no files were created — no clone, no .env.local, and no leftover
    //     writable temp-probe file in the parent dir.
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(false);
    const parent = path.dirname(installDir);
    const probeLeftovers = existsSync(parent)
      ? readdirSync(parent).filter((n) => n.startsWith(".cinatra-install-write-probe"))
      : [];
    expect(probeLeftovers).toEqual([]);
  });

  it("#37 (codex re-review): --dry-run on the DEFAULT repo+ref does NOT hit the throwing pre-clone guard", async () => {
    // The HARD regression for finding #1: with the DEFAULT repo URL + ref the
    // `usesDefaultBand` pre-clone guard is ARMED — under the old ordering it
    // threw on a default-band conflict BEFORE the dry-run preview. The fix puts
    // the dry-run early-return AHEAD of that guard, so a default-band dry-run
    // PREVIEWS the conflict instead of aborting. `capture` is stubbed so no
    // real `git ls-remote` network call is made.
    const installDir = path.join(sandbox, "dry-default-band");
    const upCalls = [];
    let res;
    await expect(
      (async () => {
        res = await runInstall(
          ["--dir", installDir, "--repo-url", DEFAULT_REPO_URL, "--ref", "main", "--yes", "--dry-run"],
          {
            log: () => {},
            deps: flowDeps({
              // ls-remote stub → a deterministic sha (no network).
              capture: () => "abc1234abc1234abc1234abc1234abc1234abc12\tHEAD",
              // Default band conflicts — the guard WOULD throw if it were reached.
              detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
              bringUpInfra: (args) => upCalls.push(args),
            }),
          },
        );
      })(),
    ).resolves.toBeUndefined(); // did NOT throw via formatPortConflictError.

    expect(res.dryRun).toBe(true);
    expect(res.conflicts).toEqual([5434]);
    expect(res.sha).toBe("abc1234abc1234abc1234abc1234abc1234abc12");
    expect(upCalls).toEqual([]);
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(false);
  });

  // ── cinatra-cli#147 — `--dry-run` must PREVIEW the isolation/port intent the
  //    real run would execute, flag-for-flag, without any reservation. A conflict
  //    on the default band is the shared precondition (the real run only reaches
  //    the isolated path under a detected conflict). ─────────────────────────────
  const conflictOnDefaultBand = async (band) => {
    // The ORIGINAL default band conflicts (someone holds postgres 5434); every
    // remapped band (offset applied) and the app-port probe are FREE. Distinguish
    // by the postgres host port, exactly like the T8/T8b real-run fixture.
    const pg = band.find((b) => b.service === "postgres");
    if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
    return [];
  };

  // ── cinatra#2654 D1 (round 4) — `--on-conflict=isolated --no-wayflow` on an
  //    INLINING Compose. Provisioning `docker/wayflow/.wayflow.env` is gated on
  //    the opt-out; the render-time wiring invariant was NOT. So the file was
  //    never written, the inlining render carried no bridge token for the wayflow
  //    service, and the fallback arm aborted the install — an install that had
  //    explicitly asked for no agent runtime. ─────────────────────────────────
  const WAYFLOW_RESOLVED_CONFIG = {
    ...RESOLVED_CONFIG,
    services: {
      ...RESOLVED_CONFIG.services,
      // As an INLINING engine hands it over: the `env_file:` directive is gone
      // and, because `--no-wayflow` skipped provisioning, nothing replaced it.
      wayflow: {
        image: "cinatra/wayflow",
        profiles: ["wayflow"],
        environment: { PORT: "3010", CINATRA_AGENTS_DIR: "/agents" },
        ports: [{ published: "3010", target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      },
    },
  };
  const inliningWayflowDeps = (extra = {}) =>
    flowDeps({
      detectPortConflicts: conflictOnDefaultBand,
      composeConfigForFiles: () => WAYFLOW_RESOLVED_CONFIG,
      composeSupportsNoEnvResolution: () => false,
      composeVersionString: () => "2.38.2",
      // NOT stubbed to ok: `--no-wayflow` must mean the generator is never
      // invoked at all. A call here fails the test loudly.
      generateWayflowEnv: () => {
        throw new Error("generateWayflowEnv must not run under --no-wayflow");
      },
      ...extra,
    });

  it("#2654 D1: --on-conflict=isolated --no-wayflow completes on an INLINING Compose", async () => {
    const installDir = path.join(sandbox, "iso-no-wayflow");
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isonowf",
        "--port-offset", "auto", "--no-wayflow",
      ],
      { log: () => {}, deps: inliningWayflowDeps() },
    );
    expect(res.infraPlan).toBe("isolated");
    expect(readInstanceRegistry(regPath).registry.instances.isonowf.state).toBe("ready");
  });

  it("#2654 D1: the SAME install WITHOUT --no-wayflow still aborts on the missing token route", async () => {
    // The control: the gate is the opt-out, not a weakening of the invariant.
    // Here the generator is stubbed to succeed but the render still inlines
    // nothing, so the wayflow arm must fire exactly as before.
    const installDir = path.join(sandbox, "iso-with-wayflow");
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowithwf",
          "--port-offset", "auto",
        ],
        {
          log: () => {},
          deps: inliningWayflowDeps({ generateWayflowEnv: () => ({ ok: true, skipped: false, reason: null }) }),
        },
      ),
    ).rejects.toThrow(/carries no non-empty CINATRA_BRIDGE_TOKEN/);
  });

  // ── cinatra#2654 D1 (round 4) — the PLAIN reconcile provisions before it
  //    re-renders. A plain `cinatra install` on a checkout recorded as isolated
  //    re-derives the generated compose first. On an INLINING Compose what that
  //    render inlines IS the wiring, so with `docker/wayflow/.wayflow.env` absent
  //    the render carried no bridge token and the wiring invariant refused — and
  //    the refusal is exactly the recovery ("re-run cinatra install") every D1
  //    failure message prescribes, so it dead-ended. ──────────────────────────
  const WAYFLOW_ENV_REL_PATH = path.join("docker", "wayflow", ".wayflow.env");

  /** A `docker compose config` fake that behaves like a REAL inlining engine:
   *  the wayflow service's env file is read off disk at render time, its content
   *  copied into `environment:`, and the directive dropped. Whether the token is
   *  in the rendered document therefore depends ENTIRELY on whether the file had
   *  been provisioned before the render — which is the ordering under test. */
  const inliningConfigFor = (installDir) => () => {
    const envPath = path.join(installDir, WAYFLOW_ENV_REL_PATH);
    const inlined = existsSync(envPath)
      ? Object.fromEntries(
          readFileSync(envPath, "utf8")
            .split("\n")
            .filter((l) => l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
        )
      : {};
    return {
      ...RESOLVED_CONFIG,
      services: {
        ...RESOLVED_CONFIG.services,
        wayflow: {
          image: "cinatra/wayflow",
          profiles: ["wayflow"],
          environment: { PORT: "3010", ...inlined },
          ports: [{ published: "3010", target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
      },
    };
  };

  /** The preserving render a FIRST isolated install gets, so the fixture reaches
   *  the reconcile with a recorded row and a generated compose. */
  const preservingWayflowConfig = (installDir) => () => ({
    ...RESOLVED_CONFIG,
    services: {
      ...RESOLVED_CONFIG.services,
      wayflow: {
        image: "cinatra/wayflow",
        profiles: ["wayflow"],
        environment: { PORT: "3010" },
        env_file: [{ path: path.join(installDir, WAYFLOW_ENV_REL_PATH), required: false }],
        ports: [{ published: "3010", target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      },
    },
  });

  it("#2654 D1: a plain reconcile PROVISIONS the bridge-token env before it re-renders", async () => {
    const installDir = path.join(sandbox, "iso-reconcile-order");
    // (1) A first isolated install on a PRESERVING Compose — this is the recorded
    //     instance the plain re-run then reconciles. Its `generateWayflowEnv` is
    //     the flowDeps stub, so no `.wayflow.env` is left on disk.
    const first = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isorec",
        "--port-offset", "auto",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: conflictOnDefaultBand,
          composeConfigForFiles: preservingWayflowConfig(installDir),
        }),
      },
    );
    expect(first.infraPlan).toBe("isolated");
    expect(existsSync(path.join(installDir, WAYFLOW_ENV_REL_PATH))).toBe(false);

    // (2) The plain re-run — no --on-conflict, so it routes to the isolated
    //     re-converge — on an INLINING Compose. The generator RECORDS when it ran
    //     and writes the file, exactly as the checkout's own script does.
    const order = [];
    const inlining = inliningConfigFor(installDir);
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [],
          composeSupportsNoEnvResolution: () => false,
          composeVersionString: () => "2.38.2",
          composeConfigForFiles: (...args) => {
            order.push("render");
            return inlining(...args);
          },
          generateWayflowEnv: ({ targetDir }) => {
            order.push("provision");
            mkdirSync(path.join(targetDir, "docker", "wayflow"), { recursive: true });
            writeFileSync(
              path.join(targetDir, WAYFLOW_ENV_REL_PATH),
              "CINATRA_BRIDGE_TOKEN=reconciled-token\nCINATRA_CONTEXT_ATTEST_KEY=reconciled-attest\n",
              { mode: 0o600 },
            );
            return { ok: true, skipped: false, reason: null };
          },
        }),
      },
    );

    expect(res.infraPlan).toBe("isolated");
    // THE ORDERING: provisioned first, and the render that follows saw the file.
    expect(order[0]).toBe("provision");
    expect(order).toContain("render");
    // …and the re-derived compose carries the token route the reconcile exists
    // to repair, rather than having refused to write at all.
    const doc = parseIsolatedComposeDoc(
      readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8"),
    );
    expect(doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("${CINATRA_BRIDGE_TOKEN}");
  });

  // ── cinatra#2654 (round 5) — `cinatra instance wayflow start` is the
  //    documented hand-start the "start it by hand" message promises. A
  //    --no-wayflow FALLBACK install's recorded compose never got a
  //    bridge-token route baked in at all (the render invariant is gated on
  //    the SAME opt-out that skipped provisioning `.wayflow.env`), so starting
  //    it against the RECORDED compose with only `--env-file .env.local` gave
  //    the runtime no token: a placeholder ALREADY IN the file can be
  //    resolved that way, but a directive the render never wrote cannot be
  //    restored by it. `reconcileIsolatedWayflowRoute` (src/index.mjs) must
  //    re-derive the recorded compose, WITH wayflow now in scope, once
  //    `.wayflow.env` is provisioned — and the token must reach the wayflow
  //    service definition the subsequent `docker compose up` starts. ────────
  // The legacy-document fixtures below share one allocation, so the ENLARGED
  // map a re-derive returns is arithmetic (3010 + offset) rather than a magic
  // number, and the `.env.local` assertions can name the same port the compose
  // would publish.
  const LEGACY_OFFSET = 20000;
  const LEGACY_APP_PORT = 3350;
  const LEGACY_WAYFLOW_PORT = 3010 + LEGACY_OFFSET; // 23010
  const LEGACY_REGENERATED_PORTS = Object.freeze({ postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] });

  /** The document an in-place regeneration LEAVES ON DISK — the ports the file
   *  the `up` reads actually publishes. `reconcileIsolatedWayflowRoute` now
   *  speaks that file's own map rather than the map the regenerator reports
   *  (cinatra#2654 round-8 review, BLOCKING 1), so a stub that claims an
   *  enlarged map must WRITE it, exactly as `regenerateIsolatedComposeInPlace`
   *  does. A stub that only claimed it modelled a state that cannot occur. */
  const writeGeneratedCompose = (installDir, projectName, ports) => {
    const services = {};
    for (const [svc, list] of Object.entries(ports)) {
      services[svc] = {
        image: `${svc}:local`,
        ports: (list ?? []).map((port) => ({
          published: String(port),
          target: Number(port),
          host_ip: "127.0.0.1",
          protocol: "tcp",
          mode: "host",
        })),
      };
      // The route the re-derive exists to bake in.
      if (svc === "wayflow") services[svc].environment = { CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}" };
    }
    writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
      name: projectName,
      services,
    });
  };
  /** A faithful `regenerateIsolatedCompose` stub: it writes the enlarged
   *  document BEFORE reporting the enlarged map. */
  const regeneratesTo = (installDir, projectName, ports, offset) => () => {
    writeGeneratedCompose(installDir, projectName, ports);
    return { regenerated: true, ports, offset };
  };

  describe("instance wayflow start — the fallback-route --no-wayflow recovery (cinatra#2654 round 5)", () => {
    it("re-derives the recorded compose so the bridge token reaches the wayflow service (fail-first at 9846340b)", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-fallback");
      // (1) The install this bug reaches: --no-wayflow on a FALLBACK (inlining)
      //     Compose. Completes (the invariant is gated on the opt-out), but
      //     the recorded compose carries NO route for the token at all.
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfstart",
          "--port-offset", "auto", "--no-wayflow",
        ],
        { log: () => {}, deps: inliningWayflowDeps() },
      );
      const before = parseIsolatedComposeDoc(
        readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8"),
      );
      expect(before.services.wayflow.environment?.CINATRA_BRIDGE_TOKEN).toBeUndefined();
      expect(before.services.wayflow.env_file ?? []).toEqual([]);

      // (2) `instance wayflow start` provisions .wayflow.env FIRST (mirrors
      //     ensureWayflowBridgeEnv's real generator run, which reads the
      //     secret ensureEnvLocal already minted into .env.local).
      const envLocal = Object.fromEntries(
        readFileSync(path.join(installDir, ".env.local"), "utf8")
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
      );
      expect(envLocal.CINATRA_BRIDGE_TOKEN).toBeTruthy();
      mkdirSync(path.join(installDir, "docker", "wayflow"), { recursive: true });
      writeFileSync(
        path.join(installDir, WAYFLOW_ENV_REL_PATH),
        `CINATRA_BRIDGE_TOKEN=${envLocal.CINATRA_BRIDGE_TOKEN}\n`,
      );

      // (3) The fix under test: re-derive the recorded compose. Same inlining
      //     `composeConfigForFiles` fake as the reconcile-order test above —
      //     it reads the REAL .wayflow.env off disk at render time, exactly
      //     like a real fallback Compose engine would.
      const row = readInstanceRegistry(regPath).registry.instances.isowfstart;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          composeSupportsNoEnvResolution: () => false,
          composeConfigForFiles: inliningConfigFor(installDir),
          instanceRegistryPath: regPath,
          allocLockPath: lockPath,
        },
      });
      expect(result.regenerated).toBe(true);

      // (4) The container definition `docker compose up` is about to start now
      //     carries a non-empty token — resolved from `.env.local` at `up`
      //     time via the re-symbolised `${VAR}` placeholder.
      const after = parseIsolatedComposeDoc(
        readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8"),
      );
      expect(after.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("${CINATRA_BRIDGE_TOKEN}");
    });

    it("a PRESERVING-route install (env_file reference survives regardless of --no-wayflow): today's behavior is unchanged", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-preserving");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfpreserve",
          "--port-offset", "auto", "--no-wayflow",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: conflictOnDefaultBand,
            composeConfigForFiles: preservingWayflowConfig(installDir),
          }),
        },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowfpreserve;
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      const before = readFileSync(isoPath, "utf8");
      let regenerateCalled = false;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          // Still the preserving route: the env_file reference the render
          // above wrote is unconditional (reference preservation does not
          // gate on --no-wayflow), so this must be a pure no-op — no
          // regenerator call at all.
          composeSupportsNoEnvResolution: () => true,
          composeConfigForFiles: preservingWayflowConfig(installDir),
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            throw new Error("regenerateIsolatedCompose must not run — the wayflow route is already wired");
          },
        },
      });
      expect(result.regenerated).toBe(false);
      expect(result.reason).toBe("already-wired");
      expect(regenerateCalled).toBe(false);
      // The file on disk is untouched, byte for byte.
      expect(readFileSync(isoPath, "utf8")).toBe(before);
    });

    // ── codex convergence (round-1 review of this fix) — the detector must
    //    classify the RECORDED document by its own shape, never by the LIVE
    //    Compose engine's capability: the live probe answers what a render
    //    started NOW would produce, not which route an EARLIER render (a
    //    possibly different Compose version) actually took. Gating the gap
    //    check on it misclassified an already-healthy document across an
    //    engine change (upgrade or downgrade) since install. These two pin
    //    that a stale/misleading live answer can never turn a healthy
    //    document into an unwanted regeneration. ─────────────────────────
    it("a PRESERVING-route doc stays a no-op even when the live probe (if consulted) would say fallback", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-preserving-live-false");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfpreslivefalse",
          "--port-offset", "auto", "--no-wayflow",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: conflictOnDefaultBand,
            composeConfigForFiles: preservingWayflowConfig(installDir),
          }),
        },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowfpreslivefalse;
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      const before = readFileSync(isoPath, "utf8");
      let regenerateCalled = false;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          // The engine "now" reports it CANNOT preserve env_file — a
          // downgrade, or the probe misfiring. The recorded document was
          // rendered on a preserving engine and still carries its reference:
          // that must decide it, not this stale/misleading live answer.
          composeSupportsNoEnvResolution: () => false,
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            throw new Error("regenerateIsolatedCompose must not run — the recorded doc is already wired");
          },
        },
      });
      expect(result.regenerated).toBe(false);
      expect(result.reason).toBe("already-wired");
      expect(regenerateCalled).toBe(false);
      expect(readFileSync(isoPath, "utf8")).toBe(before);
    });

    it("a FALLBACK-route doc that already carries a good token stays a no-op even when the live probe (if consulted) would say preserving", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-fallback-live-true");
      // An install WITHOUT --no-wayflow, on an inlining Compose, only
      // succeeds once the render already carries a non-empty token — the
      // exact "control" fixture the D1 round-4 test above builds. Build it
      // the same way that test does: generateWayflowEnv actually provisions
      // the file the inlining config reads, so the completed install's
      // recorded document already has a working fallback-route token.
      const provisioned = flowDeps({
        detectPortConflicts: conflictOnDefaultBand,
        composeSupportsNoEnvResolution: () => false,
        composeConfigForFiles: inliningConfigFor(installDir),
        generateWayflowEnv: ({ targetDir }) => {
          mkdirSync(path.join(targetDir, "docker", "wayflow"), { recursive: true });
          writeFileSync(
            path.join(targetDir, WAYFLOW_ENV_REL_PATH),
            "CINATRA_BRIDGE_TOKEN=already-wired-token\nCINATRA_CONTEXT_ATTEST_KEY=already-wired-attest\n",
            { mode: 0o600 },
          );
          return { ok: true, skipped: false, reason: null };
        },
      });
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowffallbacklivetrue",
          "--port-offset", "auto",
        ],
        { log: () => {}, deps: provisioned },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowffallbacklivetrue;
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      const before = readFileSync(isoPath, "utf8");
      const beforeDoc = parseIsolatedComposeDoc(before);
      expect(beforeDoc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("${CINATRA_BRIDGE_TOKEN}");
      let regenerateCalled = false;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          // The engine "now" reports it CAN preserve env_file — an upgrade
          // since install. The recorded document was rendered on a fallback
          // engine and already carries a non-empty token: that must decide
          // it, not this stale/misleading live answer.
          composeSupportsNoEnvResolution: () => true,
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            throw new Error("regenerateIsolatedCompose must not run — the recorded doc is already wired");
          },
        },
      });
      expect(result.regenerated).toBe(false);
      expect(result.reason).toBe("already-wired");
      expect(regenerateCalled).toBe(false);
      expect(readFileSync(isoPath, "utf8")).toBe(before);
    });

    it("a non-isolated (default) row is skipped entirely — no file read", async () => {
      const row = { slug: "default-row", composeProject: "cinatra_default_row", composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"] };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: path.join(sandbox, "does-not-exist-and-must-not-be-touched"),
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {},
      });
      expect(result).toEqual({ regenerated: false, reason: "not-isolated" });
    });

    // ── round-9 review, NB 3 ────────────────────────────────────────────────
    // The NOT-ISOLATED return is a return arm too: the caller's `up` runs after
    // it exactly as after the others, and a DEFAULT/attach/external row can
    // carry the install's recorded `--no-wayflow` opt-out just as an isolated
    // one can. Starting the runtime by hand IS the act of turning it on, so the
    // record has to be cleared here as well — `cinatra instance a2a` reads it
    // when it self-heals a stale compose, and left in place it skips the
    // bridge-token assertion for an instance that does run the runtime.
    //
    // The assertion above pins the returned SHAPE, which this did not change,
    // so the write was unpinned in both directions. Both are pinned here.
    it("NB3: a NON-ISOLATED row carrying the --no-wayflow opt-out still gets it cleared", async () => {
      const row = {
        slug: "default-opted-out",
        composeProject: "cinatra_default_opted_out",
        composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
        wayflow: false,
      };
      const recorded = [];
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: path.join(sandbox, "does-not-exist-and-must-not-be-touched"),
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: { recordWayflowChoiceOnRow: async (args) => recorded.push(args) },
      });
      expect(result).toEqual({ regenerated: false, reason: "not-isolated" });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].row).toBe(row);
      expect(recorded[0].wayflow).toBe(true);
    });

    it("NB3: a row that never opted out is left completely alone — no registry write at all", async () => {
      const recorded = [];
      const deps = { recordWayflowChoiceOnRow: async (args) => recorded.push(args) };
      // A row with no `wayflow` field: every legacy row, and every install that
      // did not opt out. ABSENT means "in scope" — there is nothing to clear.
      const plain = {
        slug: "default-plain",
        composeProject: "cinatra_default_plain",
        composeFiles: ["docker-compose.yml"],
      };
      await reconcileIsolatedWayflowRoute({
        repoRoot: path.join(sandbox, "does-not-exist-and-must-not-be-touched"),
        composeFiles: plain.composeFiles,
        row: plain,
        log: () => {},
        deps,
      });
      // …and an explicit opt-IN is the same answer, by the same rule.
      await reconcileIsolatedWayflowRoute({
        repoRoot: path.join(sandbox, "does-not-exist-and-must-not-be-touched"),
        composeFiles: plain.composeFiles,
        row: { ...plain, wayflow: true },
        log: () => {},
        deps,
      });
      // A checkout with NO row has nothing to clear either.
      await reconcileIsolatedWayflowRoute({
        repoRoot: path.join(sandbox, "does-not-exist-and-must-not-be-touched"),
        composeFiles: plain.composeFiles,
        row: null,
        log: () => {},
        deps,
      });
      expect(recorded).toEqual([]);
    });

    // ── codex convergence (round-2 review of this fix) — the wayflow ARM of
    //    `composeEnvWiringGaps` only runs when `services.wayflow` exists and
    //    is an object; a document with NO wayflow service at all (a LEGACY
    //    recorded compose predating cinatra-cli#113's profile-gated-service
    //    baking) produced no gap under EITHER interpretation and so read as
    //    "already wired" — the opposite of true. ─────────────────────────
    it("a doc missing the wayflow service entirely (a legacy pre-profile-baking compose) is NOT read as already wired", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-no-wayflow-svc");
      mkdirSync(installDir, { recursive: true });
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      // Exactly the shape isolated-endpoint-offset.test.mjs's own "pre-a2a-era"
      // fixtures use: a valid CLI-generated document that simply predates the
      // wayflow service being baked in — `wayflow` is not a key in `services`
      // at all, not merely mis-wired.
      writeIsolatedComposeFile(isoPath, {
        name: "cinatra_legacy",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const row = {
        slug: "legacy-row",
        composeProject: "cinatra_legacy",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      // The regeneration that a legacy document actually gets: the re-derive
      // ADDS the `wayflow` service, so the returned map is ENLARGED with an
      // ISOLATED host port. Round-5's stub echoed `row.ports` back unchanged,
      // which made the test blind to everything that follows an enlargement —
      // it could not fail whether or not the caller did anything with the map
      // (cinatra#2654 round-6 review, BLOCKING A, "the test blindness").
      writeFileSync(
        path.join(installDir, ".env.local"),
        `PORT=3000\nWAYFLOW_BASE_URL=http://localhost:3010\nSUPABASE_DB_URL=postgresql://u:p@127.0.0.1:5434/postgres\n`,
        { mode: 0o600 },
      );
      let regenerateCalled = false;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            return regeneratesTo(installDir, row.composeProject, LEGACY_REGENERATED_PORTS, row.offset)();
          },
        },
      });
      expect(regenerateCalled).toBe(true);
      expect(result.regenerated).toBe(true);
      expect(result.reason).not.toBe("already-wired");
      // The enlarged map REACHES the caller instead of being discarded.
      expect(result.ports).toEqual(LEGACY_REGENERATED_PORTS);
    });

    // ── round-6 review, BLOCKING A ──────────────────────────────────────────
    // Re-deriving a legacy document ADDS the wayflow service on this instance's
    // ISOLATED host port, and persists that enlarged map to the registry row.
    // `.env.local` still names the DEFAULT :3010, because it was written when
    // the map held no wayflow entry at all. The `up` that follows this reconcile
    // then starts the runtime on the remapped port while the app dials the
    // default one — a dead port, or (with a default stack up) ANOTHER
    // instance's runtime, which is worse because it answers. The reconcile must
    // apply the SAME `.env.local` re-point the install path performs.
    it("BLOCKING A: a regeneration that ENLARGED the port map re-points .env.local at the isolated WayFlow port", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-repoint");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_repoint",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      writeFileSync(
        envPath,
        // What a pre-profile-baking install left behind: the DEFAULT WayFlow
        // endpoint, because this instance's band never held a wayflow port.
        `PORT=3000\nBETTER_AUTH_URL=http://localhost:3000\n` +
          `WAYFLOW_BASE_URL=http://localhost:3010\n` +
          `SUPABASE_DB_URL=postgresql://u:p@127.0.0.1:25434/postgres\n`,
        { mode: 0o600 },
      );
      const row = {
        slug: "legacy-repoint",
        composeProject: "cinatra_legacy_repoint",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(installDir, row.composeProject, LEGACY_REGENERATED_PORTS, row.offset),
        },
      });
      expect(result.regenerated).toBe(true);

      const after = readFileSync(envPath, "utf8");
      // THE FIX: the app dials the port the container it is about to start
      // publishes, never the default one another instance may hold.
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      expect(after).not.toMatch(/^WAYFLOW_BASE_URL=http:\/\/localhost:3010\/?$/m);
      // …written by the install path's OWN writer, so the whole isolated
      // re-point ran: the recorded app port too, and the credentials on an
      // existing URL preserved rather than rebuilt.
      expect(after).toMatch(new RegExp(`^PORT=${LEGACY_APP_PORT}$`, "m"));
      expect(after).toMatch(new RegExp(`^BETTER_AUTH_URL=http://localhost:${LEGACY_APP_PORT}$`, "m"));
      expect(after).toMatch(/^SUPABASE_DB_URL=postgresql:\/\/u:p@127\.0\.0\.1:25434\/postgres$/m);
      // …and the result SAYS it re-pointed, so the caller can report it.
      expect(result.envRepointed).toBe(true);
    });

    // The other side of the same rule: an UNCHANGED map is not an excuse to
    // rewrite the operator's env file. Most reconciles re-derive a document
    // that publishes exactly what the row already records.
    it("BLOCKING A: a regeneration that changed NOTHING leaves .env.local byte-identical", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-no-repoint");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_same",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      const before = `PORT=9999\nWAYFLOW_BASE_URL=http://localhost:3010\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      const row = {
        slug: "legacy-same",
        composeProject: "cinatra_legacy_same",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          // Same map, spelled differently (string ports): a benign spelling
          // difference must not read as a move. The file this stub leaves in
          // place publishes exactly `postgres: 25434`, and that file is what the
          // reconcile speaks (round-8 review, BLOCKING 1).
          regenerateIsolatedCompose: () => ({
            regenerated: true,
            ports: { postgres: ["25434"] },
            offset: row.offset,
          }),
        },
      });
      expect(result.regenerated).toBe(true);
      expect(readFileSync(envPath, "utf8")).toBe(before);
      expect(result.envRepointed).toBe(false);
    });

    // ── round-6 codex convergence ───────────────────────────────────────────
    // `writeIsolatedAppEnv` is a silent no-op on a checkout with no
    // `.env.local`. The reconcile must report what the writer DID, not what it
    // was asked to do — a claimed re-point that never happened is the same
    // shape of false success this whole issue exists to remove.
    it("a checkout with NO .env.local reports envRepointed=false and creates no file", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-no-envlocal");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_noenv",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      expect(existsSync(envPath)).toBe(false);
      const row = {
        slug: "legacy-noenv",
        composeProject: "cinatra_legacy_noenv",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(installDir, row.composeProject, LEGACY_REGENERATED_PORTS, row.offset),
        },
      });
      expect(result.regenerated).toBe(true);
      expect(result.envRepointed).toBe(false);
      expect(existsSync(envPath)).toBe(false);
    });

    // A legacy/hand-edited row can carry no `appPort`. The infra re-point must
    // still run (that is the whole point of the repair), and the operator's own
    // PORT must be left alone rather than written as `PORT=undefined`.
    it("a row with NO recorded appPort still re-points the infra URLs and leaves PORT untouched", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-no-appport");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_noapp",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      writeFileSync(envPath, `PORT=3000\nWAYFLOW_BASE_URL=http://localhost:3010\n`, { mode: 0o600 });
      const row = {
        slug: "legacy-noapp",
        composeProject: "cinatra_legacy_noapp",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(installDir, row.composeProject, LEGACY_REGENERATED_PORTS, row.offset),
        },
      });
      expect(result.envRepointed).toBe(true);
      const after = readFileSync(envPath, "utf8");
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      // NOT `PORT=undefined` / `PORT=null`.
      expect(after).toMatch(/^PORT=3000$/m);
      expect(after).not.toMatch(/^PORT=(undefined|null|NaN)$/m);
    });

    // ── round-7 review, BLOCKING A ──────────────────────────────────────────
    // The re-point ran the WHOLE isolated-env writer over the regenerated map,
    // and that writer SYNTHESIZES a URL for a key the env file does not carry:
    // `rewriteUrlPort(undefined, …)` builds `postgresql://127.0.0.1:<port>/nango`
    // with NO CREDENTIALS, where the runtime's own fallback would have supplied
    // `nango:nango`. A legacy install that never carried NANGO_DATABASE_URL
    // therefore had its Nango database connection BROKEN by a recovery that was
    // only asked to repair the WayFlow route. A repair re-points what moved and
    // what the file already says; it never invents a connection string.
    it("BLOCKING A: a legacy install with no NANGO_DATABASE_URL keeps working (the key stays ABSENT)", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-nango-absent");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_nango",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      // The operator's file: no NANGO_DATABASE_URL and no NANGO_DB_URL at all —
      // this instance relies on the app's own default for the Nango DB.
      const before =
        `PORT=3000\nBETTER_AUTH_URL=http://localhost:3000\n` +
        `WAYFLOW_BASE_URL=http://localhost:3010\n` +
        `SUPABASE_DB_URL=postgresql://u:p@127.0.0.1:25434/postgres\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      const row = {
        slug: "legacy-nango",
        composeProject: "cinatra_legacy_nango",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        // The Nango DB is ALREADY recorded at this port — the regeneration does
        // not move it. Only `wayflow` is new.
        ports: { postgres: [25434], "nango-db": [25435] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(
            installDir,
            row.composeProject,
            { postgres: [25434], "nango-db": [25435], wayflow: [LEGACY_WAYFLOW_PORT] },
            row.offset,
          ),
        },
      });
      expect(result.regenerated).toBe(true);

      const after = readFileSync(envPath, "utf8");
      // THE FIX: the key this file never carried is still not in it — no
      // credential-less connection string was written over the runtime default.
      expect(after).not.toMatch(/NANGO_DATABASE_URL/);
      expect(after).not.toMatch(/NANGO_DB_URL/);
      // …while the service that actually MOVED is re-pointed, which is the
      // repair this command exists to perform.
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      expect(result.envRepointed).toBe(true);
      // …and the caller is told WHAT was re-pointed (round-7 review, NB4).
      expect(result.repointed).toContain(`wayflow:${LEGACY_WAYFLOW_PORT}`);
      expect(result.repointed).not.toContain("nango-db:");
    });

    it("BLOCKING A: a key the env file DOES carry is re-pointed, credentials preserved", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-legacy-nango-carried");
      mkdirSync(installDir, { recursive: true });
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_legacy_nango_carried",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      writeFileSync(
        envPath,
        `WAYFLOW_BASE_URL=http://localhost:3010\n` +
          // Carried, with the operator's OWN credentials, but naming a port
          // this instance no longer publishes.
          `NANGO_DATABASE_URL=postgresql://nango:s3cret@127.0.0.1:5435/nango\n`,
        { mode: 0o600 },
      );
      const row = {
        slug: "legacy-nango-carried",
        composeProject: "cinatra_legacy_nango_carried",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434], "nango-db": [25435] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(
            installDir,
            row.composeProject,
            { postgres: [25434], "nango-db": [25435], wayflow: [LEGACY_WAYFLOW_PORT] },
            row.offset,
          ),
        },
      });
      const after = readFileSync(envPath, "utf8");
      // The port follows the recorded map; the credentials and db name are the
      // operator's own, never rebuilt.
      expect(after).toMatch(/^NANGO_DATABASE_URL=postgresql:\/\/nango:s3cret@127\.0\.0\.1:25435\/nango$/m);
    });

    // ── round-7 review, BLOCKING B ──────────────────────────────────────────
    // The recovery is not atomic: the regenerator persists the compose file AND
    // the enlarged port map on the row durably, and the `.env.local` re-point
    // happens after. A crash in that window leaves the next start reading an
    // ALREADY-REPAIRED compose — it answers "already-wired" and returns before
    // reaching the re-point, so the stale env survives every later start and the
    // app keeps dialling the default :3010 forever. The reconcile must repair
    // the env on EVERY start, not only behind a regeneration.
    const wiredIsolatedCompose = (installDir, projectName, wayflowPort) => {
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: projectName,
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
          // Carries the bridge-token route, so the detector reads it as wired —
          // exactly what the interrupted recovery left behind.
          wayflow: {
            image: "cinatra-wayflow:local",
            environment: { CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}" },
            ports: [
              { published: String(wayflowPort), target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
            ],
          },
        },
      });
    };

    it("BLOCKING B: the crash window (compose + row repaired, env stale) is repaired by the NEXT start", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-crash-window");
      mkdirSync(installDir, { recursive: true });
      wiredIsolatedCompose(installDir, "cinatra_crash_window", LEGACY_WAYFLOW_PORT);
      const envPath = path.join(installDir, ".env.local");
      writeFileSync(
        envPath,
        // What the crash left: the pre-repair endpoint.
        `PORT=${LEGACY_APP_PORT}\nWAYFLOW_BASE_URL=http://localhost:3010\n` +
          `SUPABASE_DB_URL=postgresql://u:p@127.0.0.1:5434/postgres\n`,
        { mode: 0o600 },
      );
      // The row the interrupted recovery already persisted: it carries the
      // enlarged map.
      const row = {
        slug: "crash-window",
        composeProject: "cinatra_crash_window",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      let regenerateCalled = false;
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            throw new Error("the compose is already wired — nothing to regenerate");
          },
        },
      });
      // No regeneration ran: this is the path that used to return immediately.
      expect(regenerateCalled).toBe(false);
      expect(result.regenerated).toBe(false);
      expect(result.reason).toBe("already-wired");

      const after = readFileSync(envPath, "utf8");
      // THE FIX: the recorded map and the env file agree again, before the `up`.
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      // A key the env CARRIES whose port disagrees is re-pointed too, whether or
      // not its service moved: this runs on every start, and a carried key is
      // re-pointed from its OWN value, so the operator's credentials survive
      // (round-8 review, non-blocking 4 — this comment used to say the
      // opposite of the assertion below it).
      expect(after).toMatch(/^SUPABASE_DB_URL=postgresql:\/\/u:p@127\.0\.0\.1:25434\/postgres$/m);
      expect(result.envRepointed).toBe(true);
      expect(result.repointed).toContain(`wayflow:${LEGACY_WAYFLOW_PORT}`);
    });

    it("BLOCKING B: an already-wired start whose env AGREES leaves .env.local byte-identical", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-crash-window-clean");
      mkdirSync(installDir, { recursive: true });
      wiredIsolatedCompose(installDir, "cinatra_crash_clean", LEGACY_WAYFLOW_PORT);
      const envPath = path.join(installDir, ".env.local");
      // Already correct — and carrying a hand-maintained key for a service the
      // recorded map does not name at all.
      const before =
        `PORT=${LEGACY_APP_PORT}\nWAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}\n` +
        `OPERATOR_ONLY=keep-me\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      const row = {
        slug: "crash-clean",
        composeProject: "cinatra_crash_clean",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {},
      });
      expect(result.reason).toBe("already-wired");
      // No churn: the every-start reconcile writes nothing when nothing disagrees.
      expect(readFileSync(envPath, "utf8")).toBe(before);
      expect(result.envRepointed).toBe(false);
      // …and it did NOT synthesize the absent key for the postgres the row records.
      expect(readFileSync(envPath, "utf8")).not.toMatch(/SUPABASE_DB_URL/);
    });

    // ── round-9 codex convergence ───────────────────────────────────────────
    // The SAME defect, narrowed to the regeneration arm, if the move is read off
    // the row. A regeneration that repairs only the bridge-token ROUTE moves no
    // port at all; a row that already lagged on some unrelated service describes
    // a state this run did not create. Reading that lag as an app move rewrites
    // the operator's app keys for a re-derive that moved nothing. So the arm
    // compares the map the file published BEFORE the re-derive with the map it
    // publishes AFTER it.
    it("BLOCKING 1: a regeneration that MOVED no port leaves the app keys alone, however far the row lags", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-regen-no-move");
      mkdirSync(installDir, { recursive: true });
      // NOT wired: the wayflow service is published on this instance's own port
      // but carries no bridge-token route, so the re-derive runs.
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_regen_no_move",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
          wayflow: {
            image: "cinatra-wayflow:local",
            ports: [
              {
                published: String(LEGACY_WAYFLOW_PORT),
                target: 3010,
                host_ip: "127.0.0.1",
                protocol: "tcp",
                mode: "host",
              },
            ],
          },
        },
      });
      const envPath = path.join(installDir, ".env.local");
      const HAND_SET_APP_PORT = 3005;
      const before =
        `PORT=${HAND_SET_APP_PORT}\n` +
        `BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}\n` +
        `WAYFLOW_BASE_URL=http://localhost:3010\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      // The row lags on `wayflow` — a lag that predates this run.
      const row = {
        slug: "regen-no-move",
        composeProject: "cinatra_regen_no_move",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          // The re-derive bakes the token route in and publishes exactly the
          // ports the file already published: nothing moved.
          regenerateIsolatedCompose: regeneratesTo(
            installDir,
            row.composeProject,
            { postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] },
            row.offset,
          ),
        },
      });
      expect(result.regenerated).toBe(true);
      const after = readFileSync(envPath, "utf8");
      // The WayFlow endpoint repair still lands…
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      // …and the app keys are the operator's own, untouched.
      expect(after).toMatch(new RegExp(`^PORT=${HAND_SET_APP_PORT}$`, "m"));
      expect(after).toMatch(new RegExp(`^BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}$`, "m"));
      expect(after).not.toContain(String(LEGACY_APP_PORT));
      expect(result.repointed).toBe(`wayflow:${LEGACY_WAYFLOW_PORT}`);
    });

    // ── round-9 review, NB 4 ────────────────────────────────────────────────
    // The OFFSET this run speaks, and the parity the install path already keeps.
    // `reconvergeIsolated` tracks an `effectiveOffset`: the recorded one until a
    // regeneration DERIVES and PERSISTS a different one, and that one for every
    // gate afterwards (src/install.mjs). This reconcile read the offset straight
    // off the row and never told the caller what it had actually derived, so the
    // last gate before the `up` judged a legacy row — repaired by the re-derive
    // this very run — with the offset that run had already replaced. It is the
    // fail-closed direction, but it reads an in-band gain as a disagreement, and
    // both surfaces run the same function on the same file.
    it("NB4: the offset a REGENERATION derived is what the reconcile reports", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-offset-parity");
      mkdirSync(installDir, { recursive: true });
      // A LEGACY row: no recorded offset at all, and no wayflow service in the
      // file, so the re-derive runs and repairs both.
      writeIsolatedComposeFile(path.join(installDir, "docker-compose.cinatra-isolated.yml"), {
        name: "cinatra_offset_parity",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
        },
      });
      const row = {
        slug: "offset-parity",
        composeProject: "cinatra_offset_parity",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: null,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: regeneratesTo(
            installDir,
            row.composeProject,
            LEGACY_REGENERATED_PORTS,
            LEGACY_OFFSET,
          ),
        },
      });
      expect(result.regenerated).toBe(true);
      // THE FIX: the derived offset, not the row's `null`, is what the caller
      // hands to `assertIsolatedPortsStillConverge` immediately before the `up`.
      expect(result.offset).toBe(LEGACY_OFFSET);
    });

    it("NB4: with no regeneration the reconcile reports the offset it judged with", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-offset-wired");
      mkdirSync(installDir, { recursive: true });
      wiredIsolatedCompose(installDir, "cinatra_offset_wired", LEGACY_WAYFLOW_PORT);
      const row = {
        slug: "offset-wired",
        composeProject: "cinatra_offset_wired",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {},
      });
      expect(result.reason).toBe("already-wired");
      expect(result.offset).toBe(LEGACY_OFFSET);
    });

    // ── round-9 review, BLOCKING 1 ──────────────────────────────────────────
    // The APP-identity keys belong to an APP move. On the every-start verify
    // nothing about the app can have moved — no regeneration ran — so `PORT`,
    // `BETTER_AUTH_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL` must come out of this
    // run byte-identical, whatever the row lags the file on.
    //
    // Round 8 tied them to the moved set instead, in the same commit that made
    // that set FILE-vs-ROW. The set is then non-empty exactly when the row lags
    // the file for ANY service — the crash-window state this repair exists for —
    // so an infra-only lag rewrote three app keys the operator maintains by hand,
    // to a value read off the recorded row: the source that same commit ruled
    // may not decide the map, and one no file can check, since the app is not a
    // compose service.
    //
    // The two existing tests cannot see it: the byte-identical one above uses a
    // file and a row that AGREE (so the set is empty), and the lagging-row one
    // below sets `PORT` to exactly `row.appPort` (so a rewrite is a no-op).
    // Here the row lags on `wayflow` only, and the operator's `PORT` is their
    // own — the two are deliberately set apart.
    it("BLOCKING 1: an infra-only lag leaves the operator's APP keys byte-identical", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-app-keys-untouched");
      mkdirSync(installDir, { recursive: true });
      // The file is current AND wired: it publishes this instance's own wayflow
      // port, so no regeneration runs.
      wiredIsolatedCompose(installDir, "cinatra_app_keys", LEGACY_WAYFLOW_PORT);
      const envPath = path.join(installDir, ".env.local");
      // The operator's own app port, deliberately NOT the recorded one — and a
      // WayFlow endpoint left stale by the interrupted repair, which IS this
      // command's business.
      const HAND_SET_APP_PORT = 3005;
      const before =
        `PORT=${HAND_SET_APP_PORT}\n` +
        `BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}\n` +
        `NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}\n` +
        `WAYFLOW_BASE_URL=http://localhost:3010\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      // The row never learned about the wayflow service: an infra-only lag.
      const row = {
        slug: "app-keys",
        composeProject: "cinatra_app_keys",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            throw new Error("the compose is already wired — nothing to regenerate");
          },
        },
      });
      expect(result.reason).toBe("already-wired");
      const after = readFileSync(envPath, "utf8");
      // The repair this start OWED the operator still happened…
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      // …and NOTHING about the app was touched: byte-identical, key by key.
      expect(after).toMatch(new RegExp(`^PORT=${HAND_SET_APP_PORT}$`, "m"));
      expect(after).toMatch(new RegExp(`^BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}$`, "m"));
      expect(after).toMatch(
        new RegExp(`^NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:${HAND_SET_APP_PORT}$`, "m"),
      );
      expect(after).not.toContain(String(LEGACY_APP_PORT));
      // The file differs from `before` in the WayFlow line and nothing else.
      expect(after.split("\n").filter((l) => !l.startsWith("WAYFLOW_BASE_URL="))).toEqual(
        before.split("\n").filter((l) => !l.startsWith("WAYFLOW_BASE_URL=")),
      );
      // …and the report names exactly what was written — no app entry, so the
      // command's own line cannot call this anything but an infra re-point.
      expect(result.envRepointed).toBe(true);
      expect(result.repointed).toBe(`wayflow:${LEGACY_WAYFLOW_PORT}`);
    });

    // ── round-8 review, BLOCKING 1 ──────────────────────────────────────────
    // The every-start re-point must speak the ports the FILE it is about to
    // bring up publishes, never the recorded row. Two in-repo routes reach a row
    // that LAGS the file: the regenerator's concurrent-row-move abort, which
    // raises AFTER the compose was written, and a hand-edited generated compose,
    // which the already-wired arm never regenerates. Handed the row, the repair
    // rewrites a CORRECT `.env.local` to ports the `up` will not publish — the
    // exact defect this PR exists to remove, produced by the repair.
    it("BLOCKING 1: a lagging row does not decide the re-point — the env follows the FILE", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-row-lags-file");
      mkdirSync(installDir, { recursive: true });
      // The file is current: it publishes this instance's own wayflow port.
      wiredIsolatedCompose(installDir, "cinatra_row_lags", LEGACY_WAYFLOW_PORT);
      const envPath = path.join(installDir, ".env.local");
      writeFileSync(
        envPath,
        `PORT=${LEGACY_APP_PORT}\nWAYFLOW_BASE_URL=http://localhost:3010\n`,
        { mode: 0o600 },
      );
      // The row LAGS it: written before the compose gained its wayflow service,
      // and never repaired (the abort that wrote the file raised before the row).
      const row = {
        slug: "row-lags",
        composeProject: "cinatra_row_lags",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [25434] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            throw new Error("the compose is already wired — nothing to regenerate");
          },
        },
      });
      expect(result.reason).toBe("already-wired");
      // THE FIX: the map this start speaks is the file's, so the endpoint the
      // row never learned about still reaches `.env.local`.
      expect(result.ports).toEqual({ postgres: [25434], wayflow: [LEGACY_WAYFLOW_PORT] });
      expect(readFileSync(envPath, "utf8")).toMatch(
        new RegExp(`^WAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}/?$`, "m"),
      );
    });

    it("BLOCKING 1: a row that DISAGREES with the file refuses the start, and writes nothing", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-row-disagrees");
      mkdirSync(installDir, { recursive: true });
      // What the file publishes — and what the `up` would therefore bind.
      writeGeneratedCompose(installDir, "cinatra_row_disagrees", {
        postgres: [25434],
        wayflow: [LEGACY_WAYFLOW_PORT],
      });
      const envPath = path.join(installDir, ".env.local");
      // The operator's env is CORRECT: it already names what the file publishes.
      const before =
        `PORT=${LEGACY_APP_PORT}\nWAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}\n` +
        `SUPABASE_DB_URL=postgresql://u:p@127.0.0.1:25434/postgres\n`;
      writeFileSync(envPath, before, { mode: 0o600 });
      // The row names a different band entirely.
      const row = {
        slug: "row-disagrees",
        composeProject: "cinatra_row_disagrees",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [15434], wayflow: [13010] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const err = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {},
      }).then(() => null, (e) => e);
      // THE FIX: it refuses instead of rewriting a correct file to a port
      // nothing will publish. The refusal names the service and both ports.
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('"postgres"');
      expect(err.message).toContain("15434");
      expect(err.message).toContain("25434");
      // …and it promises exactly what THIS command has earned, no more: it
      // re-provisions the bridge-token env file before the check, so the gate's
      // blanket "nothing was changed" would be an overstatement by one file
      // (round-8 codex convergence, round 2).
      expect(err.message).toContain("nothing about this instance's ports was changed");
      expect(err.message).toContain(".wayflow.env");
      expect(err.message).not.toContain("Nothing was started, and nothing was changed.");
      // …and the promise it does make is kept, byte for byte.
      expect(readFileSync(envPath, "utf8")).toBe(before);
    });

    // ── round-8 codex convergence ───────────────────────────────────────────
    // ORDER. The refusal above only means anything if it runs BEFORE the
    // regeneration: the in-place re-derive rewrites the compose AND the row, and
    // it derives ports from the checkout at the RECORDED offset — so a
    // regeneration allowed to run first could rewrite the operator's divergent
    // port away entirely, masking the disagreement so the abort never fires, and
    // a refusal after it would be claiming "nothing was changed" about a file it
    // had already written. This is the NOT-already-wired arm: the one that
    // regenerates.
    it("BLOCKING 1: a divergent compose is refused BEFORE the regeneration can rewrite it", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-divergent-unwired");
      mkdirSync(installDir, { recursive: true });
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      // NOT wired: the wayflow service carries no bridge-token route at all, so
      // this document is the one the reconcile would re-derive…
      writeIsolatedComposeFile(isoPath, {
        name: "cinatra_divergent_unwired",
        services: {
          postgres: {
            image: "postgres:16",
            ports: [{ published: "25434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
          },
          wayflow: {
            image: "cinatra-wayflow:local",
            ports: [
              {
                published: String(LEGACY_WAYFLOW_PORT),
                target: 3010,
                host_ip: "127.0.0.1",
                protocol: "tcp",
                mode: "host",
              },
            ],
          },
        },
      });
      const composeBefore = readFileSync(isoPath, "utf8");
      const envPath = path.join(installDir, ".env.local");
      const envBefore = `PORT=${LEGACY_APP_PORT}\nWAYFLOW_BASE_URL=http://localhost:${LEGACY_WAYFLOW_PORT}\n`;
      writeFileSync(envPath, envBefore, { mode: 0o600 });
      // …and the row disagrees with it on a SHARED service.
      const row = {
        slug: "divergent-unwired",
        composeProject: "cinatra_divergent_unwired",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { postgres: [15434], wayflow: [LEGACY_WAYFLOW_PORT] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      let regenerateCalled = false;
      const err = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            regenerateCalled = true;
            return { regenerated: true, ports: row.ports, offset: row.offset };
          },
        },
      }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('"postgres"');
      // THE ORDER: the gate ran first, so the re-derive never got to mask it.
      expect(regenerateCalled).toBe(false);
      expect(readFileSync(isoPath, "utf8")).toBe(composeBefore);
      expect(readFileSync(envPath, "utf8")).toBe(envBefore);
    });

    // ── round-8 review, BLOCKING 2 ──────────────────────────────────────────
    // The MISSING-KEY half of the crash window — the legacy install this command
    // exists for. Its `.env.local` was written when the map held no `wayflow`
    // entry at all, so it carries no WAYFLOW_BASE_URL; the compose and the row
    // were then repaired by a run that was interrupted before the env re-point.
    // Nothing MOVES on the next start, so a synthesis gated on a move never
    // fires and the app goes on dialling the dead default :3010 forever.
    it("BLOCKING 2: an ABSENT WAYFLOW_BASE_URL is synthesized on the every-start arm", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-absent-key");
      mkdirSync(installDir, { recursive: true });
      writeGeneratedCompose(installDir, "cinatra_absent_key", {
        wayflow: [LEGACY_WAYFLOW_PORT],
        "nango-db": [25435],
      });
      const envPath = path.join(installDir, ".env.local");
      // No WAYFLOW_BASE_URL at all, and no Nango key either.
      writeFileSync(envPath, `PORT=${LEGACY_APP_PORT}\nOPERATOR_ONLY=keep-me\n`, { mode: 0o600 });
      const row = {
        slug: "absent-key",
        composeProject: "cinatra_absent_key",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        // The row already AGREES with the file: nothing moved, which is exactly
        // why the round-7 rule never repaired this install.
        ports: { wayflow: [LEGACY_WAYFLOW_PORT], "nango-db": [25435] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          regenerateIsolatedCompose: () => {
            throw new Error("the compose is already wired — nothing to regenerate");
          },
        },
      });
      expect(result.reason).toBe("already-wired");
      const after = readFileSync(envPath, "utf8");
      // THE FIX: the app is pointed at the runtime this start is about to bring
      // up, instead of the default port a sibling instance may answer on.
      expect(after).toMatch(new RegExp(`^WAYFLOW_BASE_URL=http://127\\.0\\.0\\.1:${LEGACY_WAYFLOW_PORT}/?$`, "m"));
      expect(result.envRepointed).toBe(true);
      expect(result.repointed).toContain(`wayflow:${LEGACY_WAYFLOW_PORT}`);
      // The narrowness of round-7's rule is UNCHANGED for every other service:
      // a credential-bearing key the operator never carried is still not invented.
      expect(after).not.toMatch(/NANGO_DATABASE_URL/);
      expect(after).not.toMatch(/NANGO_DB_URL/);
      // …and the operator's own lines survive.
      expect(after).toMatch(/^OPERATOR_ONLY=keep-me$/m);
    });

    // ── round-7 review, C ───────────────────────────────────────────────────
    // `parseIsolatedComposeDoc` reads the CLI's own JSON-shaped output, so a
    // hand-written YAML compose parses as null: the reconcile answers
    // "unparseable", the check is skipped, and the caller's `up` still runs. That
    // fail-open is right — but it was SILENT, so an operator-edited file
    // declaring a tokenless wayflow service started with no word about why this
    // command did not repair it.
    it("C: an unparseable (hand-written YAML) compose WARNS loudly before the up", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-yaml-warn");
      mkdirSync(installDir, { recursive: true });
      const isoPath = path.join(installDir, "docker-compose.cinatra-isolated.yml");
      writeFileSync(
        isoPath,
        ["services:", "  wayflow:", "    image: cinatra-wayflow:local", "    ports:", '      - "3010:3010"', ""].join("\n"),
      );
      const row = {
        slug: "yaml-warn",
        composeProject: "cinatra_yaml_warn",
        composeFiles: ["docker-compose.cinatra-isolated.yml"],
        ports: { wayflow: [3010] },
        appPort: LEGACY_APP_PORT,
        offset: LEGACY_OFFSET,
      };
      const lines = [];
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: (l) => lines.push(String(l)),
        deps: {
          regenerateIsolatedCompose: () => {
            throw new Error("an unparseable document is never regenerated here");
          },
        },
      });
      expect(result).toEqual({ regenerated: false, reason: "unparseable" });
      const warn = lines.find((l) => l.includes("Could not read"));
      expect(warn).toBeTruthy();
      // It names the FILE, what was not checked, and what may happen anyway.
      expect(warn).toContain(isoPath);
      expect(warn).toContain("CINATRA_BRIDGE_TOKEN");
      expect(warn).toContain("crash-loop");
      expect(warn).toMatch(/cinatra install/);
    });

    // ── round-7 review, NB1 ─────────────────────────────────────────────────
    // The hand-start turns the runtime ON. A row still recording the install's
    // `--no-wayflow` opt-out then makes the LATER `instance a2a` self-heal skip
    // the bridge-token assertion for an instance that runs the runtime — the
    // very assertion this command just re-derived the compose to satisfy.
    it("NB1: the hand-start CLEARS the recorded --no-wayflow opt-out on the row", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-clears-optout");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfoptout",
          "--port-offset", "auto", "--no-wayflow",
        ],
        { log: () => {}, deps: inliningWayflowDeps() },
      );
      // The install recorded the opt-out.
      expect(readInstanceRegistry(regPath).registry.instances.isowfoptout.wayflow).toBe(false);

      const row = readInstanceRegistry(regPath).registry.instances.isowfoptout;
      mkdirSync(path.join(installDir, "docker", "wayflow"), { recursive: true });
      writeFileSync(path.join(installDir, WAYFLOW_ENV_REL_PATH), "CINATRA_BRIDGE_TOKEN=t\n");
      await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          composeSupportsNoEnvResolution: () => false,
          composeConfigForFiles: inliningConfigFor(installDir),
          instanceRegistryPath: regPath,
          allocLockPath: lockPath,
        },
      });

      // THE FIX: the row no longer claims an opt-out — and the key is DELETED,
      // never written as a literal `true` (a default row stays byte-identical
      // to what every previous version wrote).
      const after = readInstanceRegistry(regPath).registry.instances.isowfoptout;
      expect(after.wayflow).toBeUndefined();
      expect("wayflow" in after).toBe(false);
      // Nothing else about the row moved.
      expect(after.appPort).toBe(row.appPort);
      expect(after.offset).toBe(row.offset);
      expect(after.createdAt).toBe(row.createdAt);
    });

    // ── round-7 codex convergence, round 2 ─────────────────────────────────
    // The clear runs on every path this reconcile RETURNS from, and on none it
    // THROWS from: a regeneration that fails aborts the command without
    // starting anything, and an aborted start must not leave the row claiming a
    // runtime it never provisioned.
    it("NB1: a FAILED regeneration leaves the recorded opt-out in place", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-optout-regen-fails");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfoptoutfail",
          "--port-offset", "auto", "--no-wayflow",
        ],
        { log: () => {}, deps: inliningWayflowDeps() },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowfoptoutfail;
      expect(row.wayflow).toBe(false);

      const err = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: {
          instanceRegistryPath: regPath,
          allocLockPath: lockPath,
          regenerateIsolatedCompose: () => {
            throw new Error("re-derive failed");
          },
        },
      }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      // The row still records what the last SUCCESSFUL provisioning decided.
      expect(readInstanceRegistry(regPath).registry.instances.isowfoptoutfail.wayflow).toBe(false);
    });

    it("NB1: the opt-out is cleared on the UNPARSEABLE path too — the `up` runs there as well", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-optout-unparseable");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfoptoutyaml",
          "--port-offset", "auto", "--no-wayflow",
        ],
        { log: () => {}, deps: inliningWayflowDeps() },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowfoptoutyaml;
      expect(row.wayflow).toBe(false);
      // The operator replaced the generated file with hand-written YAML.
      writeFileSync(
        path.join(installDir, "docker-compose.cinatra-isolated.yml"),
        "services:\n  wayflow:\n    image: cinatra-wayflow:local\n",
      );
      const result = await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: { instanceRegistryPath: regPath, allocLockPath: lockPath },
      });
      expect(result.reason).toBe("unparseable");
      expect(readInstanceRegistry(regPath).registry.instances.isowfoptoutyaml.wayflow).toBeUndefined();
    });

    it("NB1: a row that never opted out is not rewritten at all", async () => {
      const installDir = path.join(sandbox, "iso-wf-start-optin-untouched");
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isowfoptin",
          "--port-offset", "auto",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: conflictOnDefaultBand,
            composeConfigForFiles: preservingWayflowConfig(installDir),
          }),
        },
      );
      const row = readInstanceRegistry(regPath).registry.instances.isowfoptin;
      const registryBefore = readFileSync(regPath, "utf8");
      await reconcileIsolatedWayflowRoute({
        repoRoot: installDir,
        composeFiles: row.composeFiles,
        row,
        log: () => {},
        deps: { composeConfigForFiles: preservingWayflowConfig(installDir) },
      });
      // Byte-identical: no lock taken, no row rewritten.
      expect(readFileSync(regPath, "utf8")).toBe(registryBefore);
    });
  });

  it("#2654 D1: a wiring refusal names an operator RECOVERY, not only 'please report it'", async () => {
    const installDir = path.join(sandbox, "iso-recovery-msg");
    let thrown = null;
    try {
      await runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isorecov",
          "--port-offset", "auto",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: conflictOnDefaultBand,
            composeSupportsNoEnvResolution: () => false,
            composeConfigForFiles: inliningConfigFor(installDir),
            // Reports success without producing the file — the generator-absent
            // shape. The render then inlines nothing.
            generateWayflowEnv: () => ({ ok: true, skipped: true, reason: "generator-absent" }),
          }),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    const msg = String(thrown.message);
    expect(msg).toContain("carries no non-empty CINATRA_BRIDGE_TOKEN");
    expect(msg).toContain("Recovery:");
    expect(msg).toContain("gen-wayflow-env.mjs --require-bridge-token");
    expect(msg).toContain("--on-conflict=isolated --no-wayflow");
    expect(msg).toContain(installDir);
    // The report-it line survives as the LAST resort, not the only one.
    expect(msg).toContain("internal invariant violation");
    expect(msg.indexOf("Recovery:")).toBeLessThan(msg.indexOf("internal invariant violation"));
  });

  it("#147 AC1/AC6: --dry-run --on-conflict=isolated (--port-offset auto) previews the SAME app port/offset/remapped band the real isolated run allocates — advisory, writing nothing, no lock", async () => {
    const installDir = path.join(sandbox, "iso147-parity-auto");
    const upCalls = [];
    const logs = [];
    // (1) DRY-RUN advisory isolated plan (empty registry — reserves nothing).
    const dry = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--dry-run", "--on-conflict", "isolated", "--instance", "iso147pa", "--port-offset", "auto",
      ],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand, bringUpInfra: (a) => upCalls.push(a) }) },
    );
    expect(dry.dryRun).toBe(true);
    expect(dry.advisory).toBe(true);
    expect(dry.infraPlan).toBe("isolated");
    // AC7: zero infra bring-up, zero writes under the target, zero registry write,
    // zero alloc.lock — the advisory is purely read-only (the sandboxed paths,
    // redirected via CINATRA_INSTANCE_REGISTRY / CINATRA_ALLOC_LOCK, never appear).
    expect(upCalls).toEqual([]);
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(false);
    // AC1: the plan is labelled advisory and shows an isolation remap, not 3000/default.
    const out = logs.join("\n");
    expect(out).toMatch(/Infra plan:\s+isolated \(advisory — not authoritative, no reservation made\)/);
    expect(out).toMatch(/Remapped band:/);
    expect(out).not.toMatch(/App port:\s+3000\b/);

    // (2) REAL isolated install, SAME flags + SAME conflict precondition. The
    //     dry-run reserved nothing, so the registry is STILL empty → the real run
    //     allocates from the identical starting state (this run is what proves the
    //     dry-run's non-mutation, and what the advisory is pinned against).
    const real = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso147pa", "--port-offset", "auto",
      ],
      { log: () => {}, deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand }) },
    );
    expect(real.infraPlan).toBe("isolated");
    const row = readInstanceRegistry(regPath).registry.instances.iso147pa;
    // Flag-for-flag PLAN PARITY: app port + band offset match EXACTLY.
    expect(dry.appPort).toBe(row.appPort);
    expect(dry.offset).toBe(row.offset);
    // Every remapped host port the real run records is present in the advisory
    // band (the static advisory band is a superset of the fixture's compose band;
    // the services both bands share agree — the parity contract for AC6).
    const advByService = {};
    for (const e of dry.remappedBand) (advByService[e.service] ??= []).push(e.port);
    for (const svc of Object.keys(row.ports)) {
      for (const p of row.ports[svc]) expect(advByService[svc] ?? []).toContain(p);
    }
  });

  it("#147 AC1/AC6: --dry-run --on-conflict=isolated with EXPLICIT --app-port + fixed --port-offset matches the real isolated allocation", async () => {
    const installDir = path.join(sandbox, "iso147-parity-fixed");
    const flags = [
      "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
      "--on-conflict", "isolated", "--instance", "iso147pf", "--app-port", "3350", "--port-offset", "20000",
    ];
    const dry = await runInstall(
      [...flags, "--yes", "--dry-run"],
      { log: () => {}, deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand }) },
    );
    expect(dry.advisory).toBe(true);
    expect(dry.appPort).toBe(3350);
    expect(dry.offset).toBe(20000);
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);

    const real = await runInstall(
      [...flags, "--yes", "--no-install"],
      { log: () => {}, deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand }) },
    );
    expect(real.infraPlan).toBe("isolated");
    const row = readInstanceRegistry(regPath).registry.instances.iso147pf;
    expect(dry.appPort).toBe(row.appPort);
    expect(dry.offset).toBe(row.offset);
    const advByService = {};
    for (const e of dry.remappedBand) (advByService[e.service] ??= []).push(e.port);
    for (const svc of Object.keys(row.ports)) {
      for (const p of row.ports[svc]) expect(advByService[svc] ?? []).toContain(p);
    }
  });

  it("#147 AC2: a bare --dry-run conflict with NO --on-conflict lists the resolution choices and does NOT assume/compute isolation", async () => {
    const installDir = path.join(sandbox, "iso147-bare");
    const logs = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }] }) },
    );
    expect(res.dryRun).toBe(true);
    expect(res.advisory).toBeUndefined(); // NOT an isolated advisory
    expect(res.infraPlan).toBe("default");
    const out = logs.join("\n");
    // Mirrors runExecuteMenu's option set (isolated/attach/stop/external/co-use/abort).
    expect(out).toMatch(/Resolution choices the install would offer/);
    expect(out).toMatch(/\[i\] Isolated/);
    expect(out).toMatch(/\[a\] Attach/);
    expect(out).toMatch(/\[s\] Stop-existing/);
    expect(out).toMatch(/\[e\] External/);
    expect(out).toMatch(/\[c\] Co-use/);
    expect(out).toMatch(/\[x\] Abort/);
    // No fabricated isolated remap.
    expect(out).not.toMatch(/Remapped band:/);
    expect(out).not.toMatch(/isolated \(advisory/);
  });

  it("#147 AC2: --dry-run with a value OTHER THAN isolated (--on-conflict attach) also lists choices, never an isolated allocation", async () => {
    const installDir = path.join(sandbox, "iso147-attach");
    const logs = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run", "--on-conflict", "attach"],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }] }) },
    );
    expect(res.advisory).toBeUndefined();
    expect(res.infraPlan).toBe("default");
    const out = logs.join("\n");
    expect(out).toMatch(/Resolution choices the install would offer/);
    expect(out).not.toMatch(/Remapped band:/);
  });

  it("#147 AC6: --dry-run --on-conflict=isolated with NO conflict stays plan 'default' (parity-true — the real run ignores isolation without a conflict)", async () => {
    const installDir = path.join(sandbox, "iso147-noconf");
    const logs = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--dry-run", "--on-conflict", "isolated", "--app-port", "3400", "--port-offset", "auto",
      ],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: async () => [] }) },
    );
    expect(res.dryRun).toBe(true);
    expect(res.advisory).toBeUndefined();
    expect(res.infraPlan).toBe("default");
    expect(res.appPort).toBe(3000);
    const out = logs.join("\n");
    expect(out).toMatch(/Infra plan:\s+default\b/);
    expect(out).not.toMatch(/isolated \(advisory/);
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("#147 AC4: an advisory --app-port that collides with the RESERVED set is REPORTED, not thrown", async () => {
    const installDir = path.join(sandbox, "iso147-reserved");
    const logs = [];
    // --app-port 3000 is the DEFAULT stack app port → reserved. Under --dry-run it
    // must be REPORTED (the real install would reject it), and the band remap is
    // still previewed (report-not-throw).
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--dry-run", "--on-conflict", "isolated", "--app-port", "3000", "--port-offset", "auto",
      ],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand }) },
    );
    expect(res.dryRun).toBe(true);
    expect(res.advisory).toBe(true);
    expect(res.offset).toBe(10000); // the band was still computed (not thrown)
    const out = logs.join("\n");
    expect(out).toMatch(/--app-port 3000 collides with the reserved set/);
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("#147 AC4: when the instance app-port pool is EXHAUSTED, the advisory reports appPort null (never the reserved default 3000) and does not throw", async () => {
    // Codex-review edge case: the auto app-port allocator throws when 3300-3399 is
    // fully reserved. The advisory must REPORT that (appPort null + a note), not
    // substitute the reserved default 3000 into an isolated plan (parity/field
    // consistency) and not throw.
    const installDir = path.join(sandbox, "iso147-exhausted");
    const fullPool = { version: 1, instances: {} };
    for (let p = 3300; p <= 3399; p += 1) fullPool.instances[`pool${p}`] = { appPort: p, ports: {} };
    const logs = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run", "--on-conflict", "isolated"],
      { log: (m) => logs.push(String(m)), deps: flowDeps({ detectPortConflicts: conflictOnDefaultBand, readInstanceRegistry: () => fullPool }) },
    );
    expect(res.dryRun).toBe(true);
    expect(res.advisory).toBe(true);
    expect(res.infraPlan).toBe("isolated");
    expect(res.appPort).toBeNull(); // NOT 3000
    expect(res.advisoryNotes.some((n) => /could not auto-allocate an instance app port/.test(n))).toBe(true);
    // The band was still computed (app-port failure does not block it).
    expect(res.offset).toBe(10000);
    const out = logs.join("\n");
    expect(out).toMatch(/App port:\s+\(could not allocate — see advisory below\)/);
  });

  it("#147 AC4: a MALFORMED instance registry is REPORTED in the advisory (the real install would abort there) — never a silent confident plan, never a throw", async () => {
    // Parity gap: the real isolated path reads the registry via the THROWING
    // `requireUsableInstanceRegistry` (aborts before allocating on a malformed
    // file); the dry-run advisory reads via the swallowing `readBothRegistries`.
    // Without surfacing it, the preview would print a confident isolated plan the
    // real install can never reach. The advisory must REPORT it (report-not-throw)
    // and still not throw.
    const installDir = path.join(sandbox, "iso147-malformed-reg");
    const logs = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--dry-run", "--on-conflict", "isolated", "--app-port", "3401", "--port-offset", "10000",
      ],
      {
        log: (m) => logs.push(String(m)),
        deps: flowDeps({
          detectPortConflicts: conflictOnDefaultBand,
          // Mirror the throwing reader `requireUsableInstanceRegistry` produces on
          // a malformed file (what the real isolated path calls, unguarded).
          readInstanceRegistry: () => {
            throw new Error("Instance registry at <path> is malformed and was NOT modified.");
          },
        }),
      },
    );
    expect(res.dryRun).toBe(true);
    expect(res.advisory).toBe(true);
    // Reported via the same `advisoryNotes` channel AC4 uses — not thrown.
    expect(res.advisoryNotes.some((n) => /instance registry is unreadable\/malformed/.test(n))).toBe(true);
    const out = logs.join("\n");
    expect(out).toMatch(/instance registry is unreadable\/malformed/);
    expect(out).toMatch(/the real install would ABORT before allocating/);
    // No reservation/lock even on the error path.
    expect(existsSync(regPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("T8/T8b: --on-conflict=isolated brings up a remapped second stack + records it", async () => {
    const installDir = path.join(sandbox, "iso");
    const upCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso",
      ],
      {
        log: () => {},
        deps: flowDeps({
          // The default band is in conflict (someone holds 5434).
          detectPortConflicts: async (band) => {
            // The remapped band (offset applied) is FREE; only the original
            // default band conflicts. Distinguish by the postgres port.
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return []; // remapped band is free
          },
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    expect(res.instance).toBe("iso");
    // Brought up with the isolated project + the SOLE generated compose file.
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].composeProject).toBe("cinatra_iso");
    expect(upCalls[0].composeFiles).toEqual(["docker-compose.cinatra-isolated.yml"]);
    // review hardening #1: the isolated `up` is given `--env-file .env.local` so the
    // scrubbed `${VAR}` placeholders + remapped URLs resolve at up-time.
    expect(upCalls[0].envFile).toMatch(/\.env\.local$/);
    // The generated compose file exists and remaps the port (no legacy 5434).
    const gen = path.join(installDir, "docker-compose.cinatra-isolated.yml");
    expect(existsSync(gen)).toBe(true);
    const body = readFileSync(gen, "utf8");
    expect(body).not.toContain('"5434"');
    expect(body).toContain('"15434"');
    // cinatra-cli#57: POSTGRES_PASSWORD is a compose-baked default NOT supplied by
    // .env.local, so the generated compose keeps its LITERAL value — it must NOT
    // be re-symbolised to a `${POSTGRES_PASSWORD}` that nothing supplies (which
    // would resolve BLANK at `up` and break a fresh postgres on its own volume).
    const genDoc = parseIsolatedComposeDoc(body);
    expect(genDoc.services.postgres.environment.POSTGRES_PASSWORD).toBe("secret-plain");
    expect(body).not.toContain("${POSTGRES_PASSWORD}");
    // Registry row recorded ready with the isolated project + app port.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.iso.state).toBe("ready");
    expect(reg.registry.instances.iso.composeProject).toBe("cinatra_iso");
    expect(reg.registry.instances.iso.appPort).toBe(3300);
    // The isolated app env was written (PORT + BETTER_AUTH_URL).
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(/^PORT=3300$/m);
    expect(env).toMatch(/^BETTER_AUTH_URL=http:\/\/localhost:3300$/m);
    // review hardening #1: the infra URLs are RE-POINTED at the remapped host ports
    // (postgres 5434→15434, redis 6379→16379, nango 3003→13003) so setup
    // connects to the ISOLATED stack, not the default/conflicting one.
    expect(env).toMatch(/^SUPABASE_DB_URL=postgresql:\/\/127\.0\.0\.1:15434\//m);
    expect(env).toMatch(/^REDIS_URL=redis:\/\/127\.0\.0\.1:16379/m);
    expect(env).toMatch(/^NANGO_SERVER_URL=http:\/\/127\.0\.0\.1:13003/m);
    // review hardening #2: the SEPARATE Nango DB (nango-db 5435→15435) is re-pointed too.
    expect(env).toMatch(/^NANGO_DATABASE_URL=postgresql:\/\/127\.0\.0\.1:15435\//m);
  });

  // ── cinatra-cli#36 — isolated registry (Verdaccio) + Neo4j client URLs ───────
  // The Verdaccio registry client (CINATRA_AGENT_REGISTRY_URL / _UI_URL, default
  // …:4873) and the Neo4j client (NEO4J_URI, default bolt://…:7687) are NOT in
  // the isolated env-rewrite set, so an isolated install beside a live donor
  // publishes/probes into the DONOR's Verdaccio + Neo4j. Assert both are now
  // re-pointed at the isolated band's remapped host ports.
  it("#36: isolated .env.local re-points Verdaccio + Neo4j client URLs at remapped ports", async () => {
    const installDir = path.join(sandbox, "iso36");
    // A resolved compose that ALSO publishes verdaccio (4873) and neo4j
    // (7474 http UI + 7687 bolt) on the default band.
    const CONFIG_WITH_REGISTRY = {
      ...RESOLVED_CONFIG,
      services: {
        ...RESOLVED_CONFIG.services,
        verdaccio: {
          image: "verdaccio/verdaccio",
          ports: [{ published: "4873", target: 4873, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
        neo4j: {
          image: "neo4j",
          ports: [
            { published: "7474", target: 7474, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
            { published: "7687", target: 7687, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
          ],
        },
      },
    };
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso36",
      ],
      {
        log: () => {},
        deps: flowDeps({
          composeConfigForFiles: () => CONFIG_WITH_REGISTRY,
          // The default band conflicts on 5434 (forces isolated); remapped is free.
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          bringUpInfra: () => {},
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    // Verdaccio 4873 → 14873 (offset 10000); registry + UI URLs both point there.
    expect(env).toMatch(/^CINATRA_AGENT_REGISTRY_URL=http:\/\/127\.0\.0\.1:14873$/m);
    expect(env).toMatch(/^CINATRA_AGENT_REGISTRY_UI_URL=http:\/\/127\.0\.0\.1:14873$/m);
    // Neo4j: the CLIENT speaks BOLT (7687 → 17687), NOT the http UI (7474 → 17474).
    expect(env).toMatch(/^NEO4J_URI=bolt:\/\/127\.0\.0\.1:17687$/m);
    expect(env).not.toMatch(/^NEO4J_URI=.*:17474/m);
    // Donor defaults must NOT survive in the isolated env.
    expect(env).not.toMatch(/^CINATRA_AGENT_REGISTRY_URL=.*:4873$/m);
    expect(env).not.toMatch(/^NEO4J_URI=.*:7687$/m);
  });

  // ── cinatra-cli#97 — app-facing self-URLs remapped (WAYFLOW + Nango) ─────────
  // Isolation shifted the DB/Redis/app-Nango-URL host ports but left two
  // app-facing URLs on the DONOR's default ports:
  //   • .env.local WAYFLOW_BASE_URL (host app → the per-instance WayFlow runtime), and
  //   • the nango-server CONTAINER's self-advertised NANGO_SERVER_URL /
  //     NANGO_PUBLIC_SERVER_URL (`localhost:3003` → the OAuth callback base).
  // Both must follow the +offset host-port shift, else the isolated stack's
  // WayFlow / OAuth flows resolve against the MAIN instance (partial-isolation
  // leak). A service-DNS infra URL + a bare port number must stay verbatim.
  it("#97: isolated install remaps WAYFLOW_BASE_URL (.env.local) + nango self-URLs (container env)", async () => {
    const installDir = path.join(sandbox, "iso97");
    const CONFIG_WITH_APP_URLS = {
      ...RESOLVED_CONFIG,
      services: {
        ...RESOLVED_CONFIG.services,
        // nango-server self-advertises its public URL on the loopback host port;
        // an in-network URL uses service-DNS and a bare port is a plain number.
        "nango-server": {
          ...RESOLVED_CONFIG.services["nango-server"],
          environment: {
            SERVER_PORT: "3003",
            NANGO_SERVER_URL: "http://localhost:3003",
            NANGO_PUBLIC_SERVER_URL: "http://localhost:3003",
            RECORDS_DATABASE_URL: "postgresql://nango-db:5432/nango",
          },
        },
        // WayFlow is a compose service in the band (host port 3010). Its host
        // secrets arrive through the narrow generated env file (cinatra#2654 D1
        // — the isolated render must keep that reference, so the fixture carries
        // it exactly as `docker compose config --no-env-resolution` emits it).
        wayflow: {
          image: "cinatra-wayflow",
          environment: { PORT: "3010", CINATRA_BASE_URL: "http://host.docker.internal:3000" },
          env_file: [{ path: "./docker/wayflow/.wayflow.env", required: false }],
          ports: [{ published: "3010", target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
      },
    };
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso97",
      ],
      {
        log: () => {},
        deps: flowDeps({
          composeConfigForFiles: () => CONFIG_WITH_APP_URLS,
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          bringUpInfra: () => {},
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");

    // (1) Host .env.local: WAYFLOW_BASE_URL re-pointed at the isolated WayFlow
    // host port (3010 → 13010); the donor default must NOT survive.
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    // Prefix match (rewriteUrlPort normalises to a trailing slash, as for the
    // sibling NANGO_SERVER_URL); the un-offset default :3010 must NOT survive.
    expect(env).toMatch(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:13010/m);
    expect(env).not.toContain(":3010");

    // (2) Generated compose: the nango-server CONTAINER's self-advertised URLs
    // follow the host-port shift (3003 → 13003); the service-DNS infra URL is
    // left verbatim; the bare SERVER_PORT number is untouched.
    const genBody = readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8");
    const nangoEnv = parseIsolatedComposeDoc(genBody).services["nango-server"].environment;
    expect(nangoEnv.NANGO_SERVER_URL).toBe("http://localhost:13003");
    expect(nangoEnv.NANGO_PUBLIC_SERVER_URL).toBe("http://localhost:13003");
    expect(nangoEnv.RECORDS_DATABASE_URL).toBe("postgresql://nango-db:5432/nango");
    expect(nangoEnv.SERVER_PORT).toBe("3003");
    // No un-offset default self-URL survives anywhere in the generated compose.
    expect(genBody).not.toContain("localhost:3003");
  });

  // ── eng#513 sweep — the #97 leak resurfaced via PROFILE-GATED services ──────
  // The REAL checkout's wayflow service is profile-gated (`profiles: [wayflow,
  // drupal, wordpress]`) and `docker compose config` DROPS profile-gated
  // services unless profiles are enabled — so on a real host the isolated
  // executor never saw wayflow: no band entry, no port remap, and the isolated
  // `.env.local` silently kept the DONOR's WAYFLOW_BASE_URL :3010 (proven live
  // in the eng#513 real-host sweep). The executor must resolve the compose
  // config with ALL profiles; the generated file keeps each service's
  // `profiles` attribute so a plain `up` still starts only the default set.
  it("eng#513: isolated install resolves the compose config with ALL profiles — a profile-gated wayflow is remapped", async () => {
    const installDir = path.join(sandbox, "iso513prof");
    const WAYFLOW_GATED = {
      image: "cinatra-wayflow",
      profiles: ["wayflow", "drupal", "wordpress"],
      environment: { PORT: "3010" },
      // cinatra#2654 D1: the bridge-token env file the runtime reads at up-time.
      env_file: [{ path: "./docker/wayflow/.wayflow.env", required: false }],
      ports: [{ published: "3010", target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
    };
    const CONFIG_ALL_PROFILES = {
      ...RESOLVED_CONFIG,
      services: { ...RESOLVED_CONFIG.services, wayflow: WAYFLOW_GATED },
    };
    const allProfilesCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "iso513p",
      ],
      {
        log: () => {},
        deps: flowDeps({
          // Mirror the real `docker compose config` contract: the profile-gated
          // wayflow exists ONLY in the all-profiles resolution.
          composeConfigForFiles: (_dir, _files, _deps, opts) => {
            allProfilesCalls.push(opts?.allProfiles === true);
            return opts?.allProfiles ? CONFIG_ALL_PROFILES : RESOLVED_CONFIG;
          },
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          bringUpInfra: () => {},
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    // The isolated executor requested the ALL-PROFILES resolution.
    expect(allProfilesCalls).toContain(true);

    // Host .env.local: WAYFLOW_BASE_URL re-pointed (3010 → 13010); the donor
    // default must NOT survive.
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:13010/m);
    expect(env).not.toContain(":3010");

    // Generated isolated compose: wayflow present, `profiles` retained (a plain
    // `up` must not start it), published port shifted into the isolated band.
    const gen = parseIsolatedComposeDoc(readFileSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"), "utf8"));
    expect(gen.services.wayflow).toBeDefined();
    expect(gen.services.wayflow.profiles).toEqual(["wayflow", "drupal", "wordpress"]);
    expect(String(gen.services.wayflow.ports[0].published)).toBe("13010");
  });

  // ── cinatra-cli#38 — isolated app port live-probe + reserved-set validate ───
  // The app port (Next.js PORT) is NOT a compose-published port, so it bypassed
  // the infra band's live probe. Distinguish the app-port probe from the band
  // probe by its synthetic service name "app".
  const isAppProbe = (band) => Array.isArray(band) && band.some((b) => b.service === "app");

  it("#38: explicit --app-port 3000 (a DEFAULT app port) REJECTS before clone/infra", async () => {
    const installDir = path.join(sandbox, "p38-reserved");
    const upCalls = [];
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "p38res", "--app-port", "3000",
        ],
        {
          log: () => {},
          deps: flowDeps({
            // Force the isolated branch (the default band conflicts on 5434);
            // any app/remapped probe reports FREE — so the ONLY failure is the
            // reserved-set rejection on the explicit 3000.
            detectPortConflicts: async (band) => {
              const pg = band.find((b) => b.service === "postgres");
              if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
              return [];
            },
            bringUpInfra: (args) => upCalls.push(args),
          }),
        },
      ),
    ).rejects.toThrow(/--app-port 3000 is reserved.*DEFAULT stack app port/s);
    // HARD proof: nothing was brought up; no ready row was recorded.
    expect(upCalls).toEqual([]);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.p38res).toBeUndefined();
  });

  it("#38: explicit --app-port on a LIVE-BUSY socket REJECTS before clone/infra", async () => {
    const installDir = path.join(sandbox, "p38-busy");
    const upCalls = [];
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "p38busy", "--app-port", "3400",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async (band) => {
              // The app-port probe reports 3400 BUSY; the default band conflicts
              // on 5434 (forces isolated); the remapped band is free.
              if (isAppProbe(band)) return [{ service: "app", host: "0.0.0.0", port: 3400, holder: null }];
              const pg = band.find((b) => b.service === "postgres");
              if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
              return [];
            },
            bringUpInfra: (args) => upCalls.push(args),
          }),
        },
      ),
    ).rejects.toThrow(/--app-port 3400 is already in use/);
    expect(upCalls).toEqual([]);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.p38busy).toBeUndefined();
  });

  it("#38: an AUTO app port that probes BUSY BUMPS to the next free port", async () => {
    const installDir = path.join(sandbox, "p38-bump");
    const upCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "p38bump",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async (band) => {
            // The first auto-allocated app port (3300) is BUSY → must bump to 3301.
            if (isAppProbe(band)) {
              return band[0].port === 3300
                ? [{ service: "app", host: "0.0.0.0", port: 3300, holder: null }]
                : [];
            }
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    // Bumped past the busy 3300 → recorded + env-written with 3301.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.p38bump.appPort).toBe(3301);
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(/^PORT=3301$/m);
    // The stack DID come up (bump succeeds, not rejects).
    expect(upCalls.length).toBe(1);
  });

  it("#38: explicit --app-port in the infra band range does NOT self-collide (band routes around it)", async () => {
    // --app-port 15434 is FREE and not in the reserved set, so it passes the
    // app-port checks. But the default auto offset (10000) maps postgres
    // 5434→15434 — the instance's own compose would own its own app port. The
    // band must reserve the app port and bump to a higher offset so the recorded
    // postgres host port is NOT 15434.
    const installDir = path.join(sandbox, "p38-selfcollide");
    const upCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "p38sc", "--app-port", "15434",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async (band) => {
            // App-port probe + every remapped band reports FREE; only the default
            // band conflicts (forces isolated).
            if (isAppProbe(band)) return [];
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.p38sc.appPort).toBe(15434);
    // NO recorded infra host port (across every service) may equal the app port
    // — that is the self-collision the band reservation prevents.
    const allInfraPorts = Object.values(reg.registry.instances.p38sc.ports ?? {}).flat();
    expect(allInfraPorts).not.toContain(15434);
    // Concretely, postgres bumped past the default offset (15434 → 25434+).
    const pgPorts = reg.registry.instances.p38sc.ports.postgres ?? [];
    expect(pgPorts.length).toBe(1);
    expect(pgPorts[0]).toBeGreaterThanOrEqual(25434);
    expect(upCalls.length).toBe(1);
  });

  it("isolated install REFUSES when an infra URL is EXPORTED in the shell (review hardening #3)", async () => {
    const installDir = path.join(sandbox, "iso-exported");
    const prev = process.env.SUPABASE_DB_URL;
    process.env.SUPABASE_DB_URL = "postgresql://127.0.0.1:5434/postgres";
    try {
      await expect(
        runInstall(
          [
            "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
            "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isoexp",
          ],
          {
            log: () => {},
            deps: flowDeps({
              detectPortConflicts: async (band) => {
                const pg = band.find((b) => b.service === "postgres");
                if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
                return [];
              },
            }),
          },
        ),
      ).rejects.toThrow(/Refusing an isolated install while these infra vars are EXPORTED/);
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = prev;
    }
  });

  // cinatra-cli#36: the registry/Neo4j client URLs join the exported-env guard —
  // an exported stale CINATRA_AGENT_REGISTRY_URL (e.g. a donor's …:4873) would
  // otherwise win over the isolated .env.local (collectEnvironment precedence)
  // and re-route the isolated instance's registry seed back at the donor.
  it("#36: isolated install REFUSES when CINATRA_AGENT_REGISTRY_URL / NEO4J_URI is EXPORTED", async () => {
    for (const { key, val } of [
      { key: "CINATRA_AGENT_REGISTRY_URL", val: "http://127.0.0.1:4873" },
      { key: "NEO4J_URI", val: "bolt://127.0.0.1:7687" },
    ]) {
      const installDir = path.join(sandbox, `iso36-exp-${key}`);
      const prev = process.env[key];
      process.env[key] = val;
      try {
        await expect(
          runInstall(
            [
              "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
              "--yes", "--no-install", "--on-conflict", "isolated", "--instance", `iso36e${key.length}`,
            ],
            {
              log: () => {},
              deps: flowDeps({
                detectPortConflicts: async (band) => {
                  const pg = band.find((b) => b.service === "postgres");
                  if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
                  return [];
                },
              }),
            },
          ),
        ).rejects.toThrow(new RegExp(`Refusing an isolated install while these infra vars are EXPORTED[\\s\\S]*${key}`));
      } finally {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      }
    }
  });

  it("idempotent isolated re-run brings the recorded stack BACK UP (review hardening #4)", async () => {
    const installDir = path.join(sandbox, "iso-idem");
    const mkDeps = (upSink) =>
      flowDeps({
        detectPortConflicts: async (band) => {
          const pg = band.find((b) => b.service === "postgres");
          if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
          return [];
        },
        bringUpInfra: (args) => upSink.push(args),
      });
    // First isolated install records a ready row.
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isoidem",
      ],
      { log: () => {}, deps: mkDeps([]) },
    );
    // Re-run with the SAME explicit isolated option — the ready row is idempotent,
    // but the recorded stack must still be ensured up (not a silent no-op).
    const upCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isoidem",
      ],
      { log: () => {}, deps: mkDeps(upCalls) },
    );
    expect(res.infraPlan).toBe("isolated");
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].composeProject).toBe("cinatra_isoidem");
  });

  it("T9: an isolated bring-up FAILURE rolls back the pending row + generated file", async () => {
    const installDir = path.join(sandbox, "iso-fail");
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isofail",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async (band) => {
              const pg = band.find((b) => b.service === "postgres");
              if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
              return [];
            },
            bringUpInfra: () => {
              throw new Error("compose up boom");
            },
            runComposeDown: () => {}, // rollback down stubbed
          }),
        },
      ),
    ).rejects.toThrow(/compose up boom/);
    // The pending row was released (rollback) and the generated file removed.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.isofail).toBeUndefined();
    expect(existsSync(path.join(installDir, "docker-compose.cinatra-isolated.yml"))).toBe(false);
  });

  it("#140: a recreate-preflight REFUSAL on the isolated path SKIPS the `down -v` rollback (preserves existing data)", async () => {
    const installDir = path.join(sandbox, "iso-p140");
    const downCalls = [];
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isop140",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async (band) => {
              const pg = band.find((b) => b.service === "postgres");
              if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
              return [];
            },
            // The recreate gate (inside the real bringUpInfra) refuses a boundary
            // crossing — simulated here by the seam throwing a RecreatePreflightError.
            bringUpInfra: () => {
              throw new RecreatePreflightError("STOP: nango-db 15 → 17 pending", { findings: [] });
            },
            runComposeDown: (d, opts) => downCalls.push({ d, ...opts }),
          }),
        },
      ),
    ).rejects.toThrow(/STOP: nango-db 15 → 17 pending/);
    // CRITICAL (data safety): the volume-deleting `down -v` rollback NEVER ran —
    // the operator's existing data volume (the one the gate refused to cross) is
    // preserved. Contrast with T9, where a normal bring-up failure DOES roll back.
    expect(downCalls).toEqual([]);
    // The pending row is left for a later retry (not released by a phantom rollback).
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.isop140).toBeDefined();
    expect(reg.registry.instances.isop140.state).not.toBe("ready");
  });

  it("T11: --on-conflict=stop-existing refuses an UNRELATED holder", async () => {
    const installDir = path.join(sandbox, "stop-unrelated");
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "stop-existing",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async (band) => {
              const pg = band.find((b) => b.service === "postgres");
              if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: "stranger" }];
              return [];
            },
            // No live container owns it → classifier returns `unrelated`.
            liveComposeInspect: () => [],
          }),
        },
      ),
    ).rejects.toThrow(/Refusing --on-conflict=stop-existing/);
  });

  it("T11: --on-conflict=stop-existing tears down a proven OTHER instance then installs default", async () => {
    // Seed an existing OTHER instance at a different dir owning port 5434.
    const otherDir = path.join(sandbox, "other-inst");
    mkdirSync(otherDir, { recursive: true });
    const { writeInstanceRegistry, allocateInstance, markInstanceReady } = await import("../src/instance-registry.mjs");
    let reg0 = allocateInstance({ version: 1, instances: {} }, "other", {
      mode: "dev",
      installDir: otherDir,
      composeProject: "cinatra_other",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      ports: { postgres: [5434] },
      appPort: 3300,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg0 = markInstanceReady(reg0, "other");
    writeInstanceRegistry(regPath, reg0);

    const installDir = path.join(sandbox, "stop-ok");
    const downCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "stop-existing",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          // Live inspect proves /other-inst owns 5434 → other-cinatra.
          liveComposeInspect: () => [
            {
              Config: { Labels: { "com.docker.compose.project.working_dir": otherDir } },
              NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
            },
          ],
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      },
    );
    expect(res.infraPlan).toBe("default");
    // Tore down the RECORDED project (no -v).
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].composeProject).toBe("cinatra_other");
    expect(downCalls[0].volumes).toBe(false);
    // The torn-down row was released; the new default row is recorded.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.other).toBeUndefined();
    expect(reg.registry.instances["stop-ok"].state).toBe("ready");
  });

  // ── cinatra-cli#39 — label/marker-proven holders are recognized + backfilled ──
  it("#39: a label-proven holder (NOT in registry) is offered stop-existing + backfilled, not aborted", async () => {
    // The holder dir owns 5434 and carries `ai.cinatra.*` labels but has NO
    // registry row. Pre-#39 the classifier returned `unrelated`, so
    // stop-existing refused; now it is recognized as other-cinatra.
    const otherDir = path.join(sandbox, "p39-labelled-holder");
    mkdirSync(otherDir, { recursive: true });
    const installDir = path.join(sandbox, "p39-stop-labelled");
    const downCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "stop-existing",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          // Live inspect proves the holder via the ai.cinatra.* labels (no registry row).
          liveComposeInspect: () => [
            {
              Config: {
                Labels: {
                  "com.docker.compose.project.working_dir": otherDir,
                  "ai.cinatra.managed": "true",
                  "ai.cinatra.kind": "instance",
                  "ai.cinatra.instance": "p39labelled",
                  "ai.cinatra.project": "cinatra_p39labelled",
                },
              },
              NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
            },
          ],
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      },
    );
    expect(res.infraPlan).toBe("default");
    // Tore down the LABEL-DERIVED project (proof it was recognized as other-cinatra).
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].dir).toBe(otherDir);
    expect(downCalls[0].composeProject).toBe("cinatra_p39labelled");
    expect(downCalls[0].volumes).toBe(false);
    // The backfilled row was released by stop-existing; the new default row exists.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.p39labelled).toBeUndefined();
    expect(reg.registry.instances["p39-stop-labelled"].state).toBe("ready");
  });

  it("#39: an isolated install beside a label-proven holder BACKFILLS the holder's registry row", async () => {
    // Choose --on-conflict=isolated so the proven holder's backfilled row is NOT
    // consumed (stop-existing would release it). After resolution the registry
    // must now record the previously-unregistered, label-proven instance.
    const otherDir = path.join(sandbox, "p39-backfill-holder");
    mkdirSync(otherDir, { recursive: true });
    const installDir = path.join(sandbox, "p39-backfill-self");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated",
      ],
      {
        log: () => {},
        deps: flowDeps({
          // The DEFAULT band conflicts (5434 held); the remapped isolated band is free.
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          liveComposeInspect: () => [
            {
              Config: {
                Labels: {
                  "com.docker.compose.project.working_dir": otherDir,
                  "ai.cinatra.managed": "true",
                  "ai.cinatra.kind": "instance",
                  "ai.cinatra.instance": "p39backfill",
                  "ai.cinatra.project": "cinatra_p39backfill",
                },
              },
              NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
            },
          ],
        }),
      },
    );
    // The holder is now an AUTHORITATIVE registry row (subsequent runs resolve it
    // from the registry, not just labels) — the issue's "backfill" requirement.
    const reg = readInstanceRegistry(regPath);
    const row = reg.registry.instances.p39backfill;
    expect(row).toBeTruthy();
    expect(row.installDir).toBe(otherDir);
    expect(row.composeProject).toBe("cinatra_p39backfill");
    expect(row.composeFiles).toContain("docker-compose.cinatra-isolated.yml");
    expect(row.state).toBe("ready");
  });

  it("#39: a marker-proven holder (no labels, no registry row) is recognized + backfilled", async () => {
    // The holder's containers carry NO ai.cinatra.* labels but a marker file
    // exists at its dir — the marker reader is the production default seam.
    const otherDir = path.join(sandbox, "p39-marker-holder");
    mkdirSync(otherDir, { recursive: true });
    const installDir = path.join(sandbox, "p39-marker-self");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated",
      ],
      {
        log: () => {},
        deps: flowDeps({
          // The DEFAULT band conflicts (5434 held); the remapped isolated band is free.
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
          // Unlabelled container — proof must come from the marker.
          liveComposeInspect: () => [
            {
              Config: { Labels: { "com.docker.compose.project.working_dir": otherDir } },
              NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
            },
          ],
          // Inject a marker reader resolving the holder dir's marker.
          readMarker: (dir) =>
            path.resolve(dir) === path.resolve(otherDir)
              ? {
                  status: "ok",
                  marker: {
                    slug: "p39marker",
                    composeProject: "cinatra_p39marker",
                    composeFiles: ["docker-compose.cinatra-isolated.yml"],
                    appPort: 3300,
                    mode: "dev",
                  },
                }
              : { status: "missing", marker: null },
        }),
      },
    );
    const reg = readInstanceRegistry(regPath);
    const row = reg.registry.instances.p39marker;
    expect(row).toBeTruthy();
    expect(row.installDir).toBe(otherDir);
    expect(row.composeProject).toBe("cinatra_p39marker");
    expect(row.state).toBe("ready");
  });

  it("#39 (hardening codex#1): stop-existing on a slug-COLLIDING label holder does NOT delete the unrelated row", async () => {
    // An existing registry row "collide" maps to dirA. A DIFFERENT, label-proven
    // holder at dirB carries ai.cinatra.instance:"collide" (slug collision).
    // Backfill must SKIP (slug already maps to dirA); stop-existing tears down
    // dirB's project but must NOT release the registry row that points at dirA.
    const dirA = path.join(sandbox, "p39-collide-existing");
    const dirB = path.join(sandbox, "p39-collide-holder");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const { writeInstanceRegistry, allocateInstance, markInstanceReady } = await import("../src/instance-registry.mjs");
    let reg0 = allocateInstance({ version: 1, instances: {} }, "collide", {
      mode: "dev",
      installDir: dirA,
      composeProject: "cinatra_collide",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      ports: { postgres: [9999] }, // unrelated ports — NOT the conflicting 5434
      appPort: 3399,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg0 = markInstanceReady(reg0, "collide");
    writeInstanceRegistry(regPath, reg0);

    const installDir = path.join(sandbox, "p39-collide-self");
    const downCalls = [];
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "stop-existing",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          // dirB owns 5434 and its labels claim slug "collide" (collides with dirA's row).
          liveComposeInspect: () => [
            {
              Config: {
                Labels: {
                  "com.docker.compose.project.working_dir": dirB,
                  "ai.cinatra.managed": "true",
                  "ai.cinatra.instance": "collide",
                  "ai.cinatra.project": "cinatra_collide_b",
                },
              },
              NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
            },
          ],
          runComposeDown: (dir, opts) => downCalls.push({ dir, ...opts }),
        }),
      },
    );
    expect(res.infraPlan).toBe("default");
    // Tore down dirB's project (the proven holder), NOT dirA.
    expect(downCalls.length).toBe(1);
    expect(downCalls[0].dir).toBe(dirB);
    expect(downCalls[0].composeProject).toBe("cinatra_collide_b");
    // CRITICAL: the unrelated registry row "collide" → dirA is INTACT (not deleted).
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.collide).toBeTruthy();
    expect(reg.registry.instances.collide.installDir).toBe(dirA);
    // The new default install row for this checkout exists.
    expect(reg.registry.instances["p39-collide-self"].state).toBe("ready");
  });

  it("T12: --on-conflict=attach REFUSES when a DIFFERENT instance holds the ports (review hardening #2)", async () => {
    // Seed another instance owning 5434 at a different dir; attaching a FRESH
    // checkout to it must refuse (attach is only for your own checkout).
    const otherDir = path.join(sandbox, "other-attach");
    mkdirSync(otherDir, { recursive: true });
    const { writeInstanceRegistry, allocateInstance, markInstanceReady } = await import("../src/instance-registry.mjs");
    let reg0 = allocateInstance({ version: 1, instances: {} }, "otherattach", {
      mode: "dev",
      installDir: otherDir,
      composeProject: "cinatra_otherattach",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      ports: { postgres: [5434] },
      appPort: 3300,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg0 = markInstanceReady(reg0, "otherattach");
    writeInstanceRegistry(regPath, reg0);

    const installDir = path.join(sandbox, "attach-refuse");
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--on-conflict", "attach",
        ],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
            liveComposeInspect: () => [
              {
                Config: { Labels: { "com.docker.compose.project.working_dir": otherDir } },
                NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
              },
            ],
          }),
        },
      ),
    ).rejects.toThrow(/Refusing --on-conflict=attach/);
  });

  it("re-run of an already-isolated checkout converges on its OWN stack, not a default one (review hardening #6)", async () => {
    // First, create an isolated instance.
    const installDir = path.join(sandbox, "iso-rerun");
    await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--on-conflict", "isolated", "--instance", "isorerun",
      ],
      {
        log: () => {},
        deps: flowDeps({
          detectPortConflicts: async (band) => {
            const pg = band.find((b) => b.service === "postgres");
            if (pg && pg.port === 5434) return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            return [];
          },
        }),
      },
    );
    // Now re-run with NO explicit option — it must converge on the isolated
    // project, NOT probe + start a default stack.
    const upCalls = [];
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: () => {},
        deps: flowDeps({
          // If the default-band gate ran, it would find a conflict and abort; the
          // re-converge path must run BEFORE that gate.
          detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("isolated");
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].composeProject).toBe("cinatra_isorerun");
  });

  it("T13: --infra=external wires the URLs into .env.local + records state=external", async () => {
    const installDir = path.join(sandbox, "ext");
    const res = await runInstall(
      [
        "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        // An external --db-url is a NON-ROLLBACKABLE target → it needs the
        // explicit disposable acknowledgement (a bare --yes is refused, below).
        "--yes", "--external-db-disposable", "--no-install", "--infra", "external",
        // No inline credentials in the fixture URL (a `user:pass@` form trips the
        // secret-scan gate's Postgres detector); the credential-bearing path is
        // covered by the isolated-URL-rewrite unit tests instead.
        "--db-url", "postgres://db.example:5432/cinatra",
        "--redis-url", "redis://cache.example:6379",
      ],
      { log: () => {}, deps: flowDeps() },
    );
    expect(res.infraPlan).toBe("external");
    const env = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(env).toMatch(/^SUPABASE_DB_URL=postgres:\/\/db\.example:5432\/cinatra$/m);
    expect(env).toMatch(/^REDIS_URL=redis:\/\/cache\.example:6379$/m);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.ext.state).toBe("external");
    expect(reg.registry.instances.ext.infraMode).toBe("external");
  });

  it("T13c: --on-conflict=external resolving a conflict REQUIRES --db-url (won't migrate the conflicting local DB)", async () => {
    // When external resolves a LIVE port conflict, the DATABASE is the mutation
    // target: unless --db-url re-points SUPABASE_DB_URL off localhost, setup would
    // migrate the CONFLICTING local DB. Both zero-URL AND a non-DB URL (e.g. only
    // --redis-url, which leaves SUPABASE_DB_URL on localhost) must abort.
    const conflictDeps = () =>
      flowDeps({
        detectPortConflicts: async (band) => {
          const pg = (band ?? []).find((b) => b.service === "postgres" && b.port === 5434);
          return pg ? [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }] : [];
        },
      });
    // (a) no URLs at all.
    await expect(
      runInstall(
        [
          "--dir", path.join(sandbox, "ext-conflict-nourl"), "--repo-url", `file://${originRepo}`,
          "--ref", "main", "--yes", "--no-install", "--on-conflict", "external",
        ],
        { log: () => {}, deps: conflictDeps() },
      ),
    ).rejects.toThrow(/Refusing --infra=external as a conflict resolution without --db-url/);
    // (b) a non-DB external URL (redis only) does NOT move the DB off localhost.
    await expect(
      runInstall(
        [
          "--dir", path.join(sandbox, "ext-conflict-redisonly"), "--repo-url", `file://${originRepo}`,
          "--ref", "main", "--yes", "--no-install", "--on-conflict", "external",
          "--redis-url", "redis://cache.example:6379",
        ],
        { log: () => {}, deps: conflictDeps() },
      ),
    ).rejects.toThrow(/Refusing --infra=external as a conflict resolution without --db-url/);
  });

  it("T13b: a bare --yes does NOT silently arm an external --db-url (refuses without the disposable ack)", async () => {
    const installDir = path.join(sandbox, "ext-bare-yes");
    await expect(
      runInstall(
        [
          "--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
          "--yes", "--no-install", "--infra", "external",
          "--db-url", "postgres://db.example:5432/cinatra",
        ],
        { log: () => {}, deps: flowDeps() },
      ),
    ).rejects.toThrow(/bare --yes|--external-db-disposable/s);
    // A non-DB external target (redis only) is NOT gated by the disposable ack.
    const redisOnlyDir = path.join(sandbox, "ext-redis-only");
    const res = await runInstall(
      [
        "--dir", redisOnlyDir, "--repo-url", `file://${originRepo}`, "--ref", "main",
        "--yes", "--no-install", "--infra", "external",
        "--redis-url", "redis://cache.example:6379",
      ],
      { log: () => {}, deps: flowDeps() },
    );
    expect(res.infraPlan).toBe("external");
  });

  it("non-interactive conflict with NO explicit option aborts (does not silently isolate)", async () => {
    const installDir = path.join(sandbox, "abort");
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: flowDeps({
            detectPortConflicts: async () => [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
          }),
        },
      ),
    ).rejects.toThrow(/Host port conflict|non-interactive/s);
  });
});

// ---------------------------------------------------------------------------
// T6 — --status / --list-instances (read-only).
// ---------------------------------------------------------------------------
describe("runInstall --status / --list-instances (T6)", () => {
  let dir;
  let regPath;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cin-status-"));
    regPath = path.join(dir, "instances.json");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = path.join(dir, "alloc.lock");
    const { writeInstanceRegistry, allocateInstance, markInstanceReady } = await import("../src/instance-registry.mjs");
    let reg = allocateInstance({ version: 1, instances: {} }, "alpha", {
      mode: "dev",
      installDir: path.join(dir, "alpha"),
      composeProject: "cinatra",
      composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
      ports: { postgres: [5434] },
      appPort: 3000,
      repoUrl: "x",
      ref: "main",
      sha: "s",
      infraMode: "new",
    }).registry;
    reg = markInstanceReady(reg, "alpha");
    writeInstanceRegistry(regPath, reg);
  });
  afterAll(() => {
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
  });

  it("--list-instances prints the recorded instance (no side effects)", async () => {
    const logs = [];
    const res = await runInstall(["--list-instances"], { log: (m) => logs.push(String(m)) });
    expect(res.status).toBe(true);
    const blob = logs.join("\n");
    expect(blob).toMatch(/alpha/);
    expect(blob).toMatch(/registry is authoritative/);
    expect(blob).toMatch(/marker is a HINT/);
  });

  it("--status for a checkout reconciles its marker (registry/live = truth)", async () => {
    const logs = [];
    await runInstall(["--status", "--dir", path.join(dir, "alpha")], { log: (m) => logs.push(String(m)) });
    const blob = logs.join("\n");
    expect(blob).toMatch(/This checkout/);
    expect(blob).toMatch(/reconciled:/);
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#40 — co-use (shared-infra) executor: capability gate (fail
// closed), the success path (separate DB + env + record, NO second stack), and
// transaction-style rollback. All I/O is injected via deps (no live PG/Docker).
// ---------------------------------------------------------------------------
describe("runInstall — co-use executor (cinatra-cli#40)", () => {
  let sandbox;
  let originRepo;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-couse-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
  });

  let regPath;
  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    regPath = path.join(d, "instances.json");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  // A donor .env.local supplying the shared-infra endpoints + the DB url against
  // whose server the co-use database is created.
  const DONOR_ENV = {
    SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/postgres",
    REDIS_URL: "redis://127.0.0.1:6379",
    NANGO_SERVER_URL: "http://127.0.0.1:3003",
    BETTER_AUTH_SECRET: "donor-secret",
    CINATRA_ENCRYPTION_KEY: "donor-enc",
  };

  // Base deps: preflight ok, docker/compose present, NO infra bring-up needed.
  // The capability probe + donor env + DB ops + setup are injected per test.
  function couseDeps(extra = {}) {
    return {
      ...dockerPresentDeps(),
      detectPortConflicts: async () => [], // co-use app port is free
      readCloneRegistry: () => null,
      readDonorEnv: () => ({ ...DONOR_ENV }),
      // capability TRUE by default (the executor success path); per-test false.
      probeCookiePrefixSupport: () => true,
      // never bring up a stack in co-use.
      bringUpInfra: () => {
        throw new Error("co-use must NOT bring up an infra stack");
      },
      runSetup: () => {}, // stub setup (no real pnpm/migrations)
      skipCoUseInstall: true, // skip pnpm install in the test
      ...extra,
    };
  }

  const baseArgs = (installDir) => [
    "--dir", installDir,
    "--repo-url", `file://${originRepo}`,
    "--ref", "main",
    "--on-conflict=co-use",
    "--no-install",
    "--no-setup",
    "--yes",
  ];

  it("REFUSES (fail closed) when the donor app build lacks cookie-prefix support — before any DB create", async () => {
    const installDir = path.join(sandbox, "refuse");
    const dbCreates = [];
    await expect(
      runInstall(baseArgs(installDir), {
        log: () => {},
        deps: couseDeps({
          probeCookiePrefixSupport: () => false, // current app state
          coUseDbOps: {
            createCoUseDb: async (a) => {
              dbCreates.push(a);
              return { created: true };
            },
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      }),
    ).rejects.toThrow(/does NOT isolate auth cookies per instance/);
    // The pre-clone gate fired — NO database was created.
    expect(dbCreates).toEqual([]);
  });

  it("SUCCESS path: creates cinatra_inst_<slug>, writes the co-use env, records infraMode co-use, NO bring-up", async () => {
    const installDir = path.join(sandbox, "myinst");
    const dbCreates = [];
    const res = await runInstall(baseArgs(installDir).filter((a) => a !== "--no-setup"), {
      log: () => {},
      deps: couseDeps({
        coUseDbOps: {
          createCoUseDb: async (a) => {
            dbCreates.push(a);
            return { created: true };
          },
          dropDbCreatedByThisRun: async () => {
            throw new Error("should not drop on success");
          },
        },
        runSetup: () => {}, // assert it is called (no throw)
      }),
    });
    expect(res.infraPlan).toBe("co-use");
    expect(res.instance).toBe("myinst");
    // The separate DB was created with the right name against the donor server.
    expect(dbCreates).toHaveLength(1);
    expect(dbCreates[0].dbName).toBe("cinatra_inst_myinst");
    // The co-use .env.local carries the isolation values.
    const envBody = readFileSync(path.join(installDir, ".env.local"), "utf8");
    expect(envBody).toMatch(/SUPABASE_DB_URL=.*\/cinatra_inst_myinst/);
    expect(envBody).toMatch(/BULLMQ_QUEUE_NAME=cinatra-inst-myinst/);
    expect(envBody).toMatch(/BETTER_AUTH_COOKIE_PREFIX=cinatra-myinst/);
    expect(envBody).toMatch(/CINATRA_REDIS_PREFIX=cinatra:myinst/);
    // Shared infra inherited.
    expect(envBody).toMatch(/REDIS_URL=redis:\/\/127\.0\.0\.1:6379/);
    // Registry row: infraMode co-use, ready.
    const reg = readInstanceRegistry(regPath);
    expect(reg.status).toBe("ok");
    expect(reg.registry.instances.myinst.infraMode).toBe("co-use");
    expect(reg.registry.instances.myinst.state).toBe("ready");
    expect(reg.registry.instances.myinst.createdResources).toContain("db:cinatra_inst_myinst");
  });

  it("ROLLBACK: a setup failure drops the created DB EXACTLY once (owned-drop) + releases the slot", async () => {
    const installDir = path.join(sandbox, "rollback");
    const drops = [];
    await expect(
      runInstall(baseArgs(installDir).filter((a) => a !== "--no-setup"), {
        log: () => {},
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async (a) => {
              drops.push(a);
            },
          },
          runSetup: () => {
            throw new Error("boom: setup failed");
          },
        }),
      }),
    ).rejects.toThrow(/boom: setup failed/);
    // The created DB was dropped exactly once, via the owned-drop guard.
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ dbName: "cinatra_inst_rollback", createdThisRun: true });
    // The provisioning slot was released (no orphan row).
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.rollback).toBeUndefined();
  });

  it("ROLLBACK does NOT drop a DB it did not create this run", async () => {
    const installDir = path.join(sandbox, "noreuse");
    const drops = [];
    await expect(
      runInstall(baseArgs(installDir).filter((a) => a !== "--no-setup"), {
        log: () => {},
        deps: couseDeps({
          coUseDbOps: {
            createCoUseDb: async () => ({ created: false }), // pre-existing DB
            dropDbCreatedByThisRun: async (a) => {
              drops.push(a);
            },
          },
          runSetup: () => {
            throw new Error("boom");
          },
        }),
      }),
    ).rejects.toThrow(/boom/);
    expect(drops).toEqual([]); // never drop a DB this run did not create
  });

  it("REFUSES shared Graphiti without --allow-shared-graphiti, ACCEPTS with it", async () => {
    const installDir = path.join(sandbox, "graphiti");
    const donorWithGraphiti = { ...DONOR_ENV, GRAPHITI_URL: "http://127.0.0.1:8000" };
    // Without the flag → refuse (before any DB create).
    const dbCreates = [];
    await expect(
      runInstall(baseArgs(installDir).filter((a) => a !== "--no-setup"), {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...donorWithGraphiti }),
          coUseDbOps: {
            createCoUseDb: async (a) => {
              dbCreates.push(a);
              return { created: true };
            },
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      }),
    ).rejects.toThrow(/Graphiti\/Neo4j is NOT instance-namespaced/);
    expect(dbCreates).toEqual([]);

    // With the eyes-open flag → proceeds (DB created).
    const installDir2 = path.join(sandbox, "graphiti-ok");
    const res = await runInstall(
      [...baseArgs(installDir2).filter((a) => a !== "--no-setup"), "--allow-shared-graphiti"],
      {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...donorWithGraphiti }),
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async () => {},
          },
        }),
      },
    );
    expect(res.infraPlan).toBe("co-use");
  });

  it("cinatra-cli#143: PROD co-use FAILS the required-env gate on an invalid donor encryption key and ROLLS BACK", async () => {
    const installDir = path.join(sandbox, "prodgatefail");
    const drops = [];
    // DONOR_ENV.CINATRA_ENCRYPTION_KEY = "donor-enc" does not decode to 32 bytes.
    // A prod co-use inherits it; the post-setup gate must hard-fail (and roll back).
    await expect(
      runInstall(
        [...baseArgs(installDir).filter((a) => a !== "--no-setup" && a !== "--no-install"), "--mode", "prod"],
        {
          log: () => {},
          deps: couseDeps({
            coUseDbOps: {
              createCoUseDb: async () => ({ created: true }),
              dropDbCreatedByThisRun: async (a) => {
                drops.push(a);
              },
            },
          }),
        },
      ),
    ).rejects.toThrow(/\[required-env-preflight\][\s\S]*CINATRA_ENCRYPTION_KEY/);
    // The gate fired BEFORE mark-ready → the created DB rolled back + slot released.
    expect(drops).toHaveLength(1);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances.prodgatefail).toBeUndefined();
  });

  it("cinatra-cli#143: PROD co-use SUCCEEDS when the donor supplies a valid encryption key (gate passes)", async () => {
    const installDir = path.join(sandbox, "prodgateok");
    const validDonor = { ...DONOR_ENV, CINATRA_ENCRYPTION_KEY: randomBytes(32).toString("hex") };
    const res = await runInstall(
      [...baseArgs(installDir).filter((a) => a !== "--no-setup" && a !== "--no-install"), "--mode", "prod"],
      {
        log: () => {},
        deps: couseDeps({
          readDonorEnv: () => ({ ...validDonor }),
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async () => {
              throw new Error("should not roll back on a passing gate");
            },
          },
        }),
      },
    );
    expect(res.infraPlan).toBe("co-use");
    expect(res.instance).toBe("prodgateok");
  });

  it("cinatra-cli#143: an idempotent PROD co-use re-run RE-VALIDATES the existing env (fails if now broken)", async () => {
    const installDir = path.join(sandbox, "prodidem");
    const validDonor = { ...DONOR_ENV, CINATRA_ENCRYPTION_KEY: randomBytes(32).toString("hex") };
    const prodArgs = [
      ...baseArgs(installDir).filter((a) => a !== "--no-setup" && a !== "--no-install"),
      "--mode",
      "prod",
    ];
    const mkDeps = () =>
      couseDeps({
        readDonorEnv: () => ({ ...validDonor }),
        coUseDbOps: {
          createCoUseDb: async () => ({ created: true }),
          dropDbCreatedByThisRun: async () => {},
        },
      });
    // First run provisions + records the instance ready (gate passes).
    const first = await runInstall(prodArgs, { log: () => {}, deps: mkDeps() });
    expect(first.infraPlan).toBe("co-use");
    // Corrupt the recorded instance's encryption key, then re-run: the idempotent
    // converge path must RE-VALIDATE and refuse rather than report success.
    const envPath = path.join(installDir, ".env.local");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(/^CINATRA_ENCRYPTION_KEY=.*$/m, "CINATRA_ENCRYPTION_KEY=broken"),
    );
    await expect(runInstall(prodArgs, { log: () => {}, deps: mkDeps() })).rejects.toThrow(
      /\[required-env-preflight\][\s\S]*CINATRA_ENCRYPTION_KEY/,
    );
  });

  // cinatra-cli#143 regression: the gate must NOT be conditioned on the setup/
  // install phases. --no-setup / --no-install short-circuit deps + setup, but the
  // co-use .env.local (donor secrets) is still written and the instance is still
  // marked ready + reported successful — so an invalid donor CINATRA_ENCRYPTION_KEY
  // under those flags must STILL hard-fail + roll back, never a silent success
  // followed by a first-boot crash (#142 goal). baseArgs KEEPS --no-setup +
  // --no-install (the sibling tests above strip them); this pins the fixed path.
  it("cinatra-cli#143: PROD co-use with --no-setup/--no-install STILL gates an invalid donor key + ROLLS BACK", async () => {
    const installDir = path.join(sandbox, "prodgatefail-nosetup");
    const drops = [];
    // DONOR_ENV.CINATRA_ENCRYPTION_KEY = "donor-enc" does not decode to 32 bytes.
    await expect(
      runInstall([...baseArgs(installDir), "--mode", "prod"], {
        log: () => {},
        deps: couseDeps({
          runSetup: () => {
            throw new Error("runSetup must NOT run under --no-setup");
          },
          coUseDbOps: {
            createCoUseDb: async () => ({ created: true }),
            dropDbCreatedByThisRun: async (a) => {
              drops.push(a);
            },
          },
        }),
      }),
    ).rejects.toThrow(/\[required-env-preflight\][\s\S]*CINATRA_ENCRYPTION_KEY/);
    // The gate fired BEFORE mark-ready even with setup/install skipped.
    expect(drops).toHaveLength(1);
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["prodgatefail-nosetup"]).toBeUndefined();
  });

  it("cinatra-cli#143: PROD co-use with --no-setup/--no-install SUCCEEDS on a valid donor key (gate runs, no setup)", async () => {
    const installDir = path.join(sandbox, "prodgateok-nosetup");
    const validDonor = { ...DONOR_ENV, CINATRA_ENCRYPTION_KEY: randomBytes(32).toString("hex") };
    const res = await runInstall([...baseArgs(installDir), "--mode", "prod"], {
      log: () => {},
      deps: couseDeps({
        readDonorEnv: () => ({ ...validDonor }),
        runSetup: () => {
          throw new Error("runSetup must NOT run under --no-setup");
        },
        coUseDbOps: {
          createCoUseDb: async () => ({ created: true }),
          dropDbCreatedByThisRun: async () => {
            throw new Error("should not roll back on a passing gate");
          },
        },
      }),
    });
    expect(res.infraPlan).toBe("co-use");
    expect(res.instance).toBe("prodgateok-nosetup");
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["prodgateok-nosetup"].state).toBe("ready");
  });
});

// ===========================================================================
// cinatra#2654 round 7, BLOCKING A — `writeIsolatedAppEnv`'s RESTRICTED re-point.
//
// The install path owns the `.env.local` it just wrote and re-points every key
// (an absent key falls back to a DEFAULT-band URL, which is the isolation leak
// the writer exists to close). A REPAIR reaching a pre-existing install owns
// nothing of the sort: `rewriteUrlPort` builds a CREDENTIAL-LESS URL when the
// file carries no value for a key, so writing one over a key the operator
// relies on the runtime's own credentialled fallback for breaks a connection
// the repair never touched.
//
// These are direct unit tests of the rule, so each arm is pinned on its own
// rather than through a reconcile fixture that can only reach a few of them.
// ===========================================================================
describe("writeIsolatedAppEnv — the RESTRICTED re-point (cinatra#2654 round 7)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cin-r7-repoint-"));
  });

  const write = (body) => {
    writeFileSync(path.join(dir, ".env.local"), body, { mode: 0o600 });
    return path.join(dir, ".env.local");
  };
  const read = () => readFileSync(path.join(dir, ".env.local"), "utf8");
  const repoint = (opts) => writeIsolatedAppEnv({ targetDir: dir, appPort: null, log: () => {}, ...opts });

  it("does NOT synthesize an absent key for a service that did not move", () => {
    write("WAYFLOW_BASE_URL=http://localhost:3010\n");
    const res = repoint({
      ports: { "nango-db": [25435], postgres: [25434], wayflow: [23010] },
      movedServices: ["wayflow"],
    });
    expect(read()).not.toMatch(/NANGO_DATABASE_URL/);
    expect(read()).not.toMatch(/SUPABASE_DB_URL/);
    expect(read()).toMatch(/^WAYFLOW_BASE_URL=http:\/\/localhost:23010\/?$/m);
    expect(res).toEqual({ remapped: "wayflow:23010" });
  });

  // ── round-7 codex convergence ────────────────────────────────────────────
  // The first cut protected an absent key only when its service had not moved.
  // A legacy row whose map GAINS `nango-db` moves it — and the same
  // credential-less `postgresql://127.0.0.1:…/nango` would have been written,
  // which is the exact defect this item names.
  it("does NOT synthesize an absent credential-bearing key even when its service MOVED", () => {
    write("WAYFLOW_BASE_URL=http://localhost:3010\n");
    repoint({
      ports: { "nango-db": [25435], postgres: [25434], redis: [26379], wayflow: [23010] },
      // Everything is new to this row: a legacy map held none of them.
      movedServices: ["nango-db", "postgres", "redis", "wayflow"],
    });
    const after = read();
    expect(after).not.toMatch(/NANGO_DATABASE_URL/);
    expect(after).not.toMatch(/NANGO_DB_URL/);
    expect(after).not.toMatch(/SUPABASE_DB_URL/);
    expect(after).not.toMatch(/REDIS_URL/);
    // The ONE synthesis a repair may perform: the WayFlow endpoint it exists to
    // repair, which carries no credentials and whose absence means the app dials
    // ANOTHER instance's runtime on the default port.
    expect(after).toMatch(/^WAYFLOW_BASE_URL=http:\/\/localhost:23010\/?$/m);
  });

  it("SYNTHESIZES the absent WAYFLOW_BASE_URL when the wayflow service moved — the one exception", () => {
    write("PORT=3350\n");
    const res = repoint({ ports: { wayflow: [23010] }, movedServices: ["wayflow"] });
    // Credential-free by construction, and its absence IS the leak: the app
    // dials the default :3010, which is another instance's runtime.
    expect(read()).toMatch(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:23010\/?$/m);
    expect(res).toEqual({ remapped: "wayflow:23010" });
  });

  // ── round-8 review, BLOCKING 2 ───────────────────────────────────────────
  // This assertion used to demand the OPPOSITE, and the rule it pinned is what
  // left the legacy install this repair exists for dialling the dead default
  // :3010. On the every-start arm nothing ever MOVES: the compose is wired on
  // this instance's own port and the row records it — only `.env.local`, written
  // before either of them, carries no WAYFLOW_BASE_URL at all. An absent key for
  // a service the file PUBLISHES is itself the disagreement (the app is pointed
  // at the default band while the container binds this instance's), so it is
  // synthesized whether or not that service moved.
  it("SYNTHESIZES the absent WAYFLOW_BASE_URL even when NOTHING moved (round-8 review, BLOCKING 2)", () => {
    write("PORT=3350\n");
    const res = repoint({ ports: { wayflow: [23010] }, movedServices: [] });
    expect(read()).toMatch(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:23010\/?$/m);
    expect(res).toEqual({ remapped: "wayflow:23010" });
  });

  it("synthesizes NOTHING for a service the file does not publish", () => {
    const before = "PORT=3350\n";
    write(before);
    // No `wayflow` entry in the effective map → no port to point anything at.
    expect(repoint({ ports: { postgres: [25434] }, movedServices: [] })).toBe(false);
    expect(read()).toBe(before);
  });

  it("does NOT add app-settings keys an operator's file never carried", () => {
    write("PORT=3000\nWAYFLOW_BASE_URL=http://localhost:3010\n");
    repoint({ appPort: 3350, ports: { wayflow: [23010] }, movedServices: ["wayflow"] });
    const after = read();
    // The carried, disagreeing key is repaired…
    expect(after).toMatch(/^PORT=3350$/m);
    // …and the two it never had are not invented by a route repair.
    expect(after).not.toMatch(/BETTER_AUTH_URL/);
  });

  it("re-points a CARRIED key from its OWN value, preserving credentials and db name", () => {
    write(
      "SUPABASE_DB_URL=postgresql://app:pw@127.0.0.1:5434/postgres\n" +
        "REDIS_URL=redis://:redispw@127.0.0.1:6379\n",
    );
    repoint({ ports: { postgres: [25434], redis: [26379] }, movedServices: [] });
    expect(read()).toMatch(/^SUPABASE_DB_URL=postgresql:\/\/app:pw@127\.0\.0\.1:25434\/postgres$/m);
    expect(read()).toMatch(/^REDIS_URL=redis:\/\/:redispw@127\.0\.0\.1:26379$/m);
  });

  // Two keys naming ONE service may legitimately hold different values; deriving
  // both from one of them clobbers the other (round-7 codex convergence).
  it("re-points each key of a MULTI-KEY service independently", () => {
    write(
      "NANGO_DATABASE_URL=postgresql://a:one@127.0.0.1:5435/nango\n" +
        "NANGO_DB_URL=postgresql://b:two@127.0.0.1:5435/nango_alt\n" +
        "CINATRA_AGENT_REGISTRY_URL=http://127.0.0.1:4873\n" +
        "CINATRA_AGENT_REGISTRY_UI_URL=http://127.0.0.1:4873/-/web\n",
    );
    repoint({ ports: { "nango-db": [25435], verdaccio: [24873] }, movedServices: [] });
    const after = read();
    expect(after).toMatch(/^NANGO_DATABASE_URL=postgresql:\/\/a:one@127\.0\.0\.1:25435\/nango$/m);
    expect(after).toMatch(/^NANGO_DB_URL=postgresql:\/\/b:two@127\.0\.0\.1:25435\/nango_alt$/m);
    expect(after).toMatch(/^CINATRA_AGENT_REGISTRY_URL=http:\/\/127\.0\.0\.1:24873\/?$/m);
    // The UI URL keeps its own path — only the port is this repair's business.
    expect(after).toMatch(/^CINATRA_AGENT_REGISTRY_UI_URL=http:\/\/127\.0\.0\.1:24873\/-\/web$/m);
  });

  it("leaves a carried value the CLI cannot parse as a URL alone", () => {
    const before = "SUPABASE_DB_URL=host=127.0.0.1 port=5434 dbname=postgres\n";
    write(before);
    const res = repoint({ ports: { postgres: [25434] }, movedServices: ["postgres"] });
    // Never replaced with a credential-less default it cannot merge into.
    expect(read()).toBe(before);
    expect(res).toBe(false);
  });

  it("treats an IMPLICIT default port as agreement, not a rewrite (round-7 codex convergence)", () => {
    const before = "GRAPHITI_URL=http://graphiti.internal/api\n";
    write(before);
    const res = repoint({ ports: { graphiti: [80] }, movedServices: [] });
    expect(read()).toBe(before);
    expect(res).toBe(false);
  });

  it("writes nothing — and reports nothing — when every carried key already agrees", () => {
    const before = "WAYFLOW_BASE_URL=http://localhost:23010\nPORT=3350\n";
    write(before);
    const res = repoint({ appPort: 3350, ports: { wayflow: [23010] }, movedServices: [] });
    expect(read()).toBe(before);
    expect(res).toBe(false);
  });

  it("reports only what it WROTE, never what was merely in the map", () => {
    write("WAYFLOW_BASE_URL=http://localhost:3010\nGRAPHITI_URL=http://127.0.0.1:8000\n");
    const res = repoint({
      ports: { wayflow: [23010], graphiti: [8000], postgres: [25434] },
      movedServices: ["wayflow", "postgres"],
    });
    // graphiti already agrees; postgres has no carried key and may not be
    // synthesized; only wayflow moved AND changed.
    expect(res).toEqual({ remapped: "wayflow:23010" });
  });

  it("re-points an app key that DISAGREES with the recorded app port, and leaves an agreeing one alone", () => {
    write("PORT=3000\nBETTER_AUTH_URL=http://localhost:3350\nWAYFLOW_BASE_URL=http://localhost:3010\n");
    repoint({ appPort: 3350, ports: { wayflow: [23010] }, movedServices: ["wayflow"] });
    const after = read();
    expect(after).toMatch(/^PORT=3350$/m);
    // Already correct: rewritten to the same value, so the operator sees no churn.
    expect(after).toMatch(/^BETTER_AUTH_URL=http:\/\/localhost:3350$/m);
    expect(after).toMatch(/^WAYFLOW_BASE_URL=http:\/\/localhost:23010\/?$/m);
  });

  // ── round-9 review, BLOCKING 1 ─────────────────────────────────────────────
  // Whether a RESTRICTED re-point may touch the app-identity keys is the
  // CALLER's decision, made by passing an `appPort` at all. This writer cannot
  // tell whether the APP moved: `movedServices` describes the ROW against the
  // FILE, and a service the row lags on says nothing about the app port.
  it("leaves the app keys alone when the caller passes no appPort, whatever moved", () => {
    write("PORT=3005\nBETTER_AUTH_URL=http://localhost:3005\nWAYFLOW_BASE_URL=http://localhost:3010\n");
    const res = repoint({
      appPort: null,
      ports: { postgres: [25434], wayflow: [23010] },
      // A lagging row: non-empty, and NOT a reason to rewrite the app keys.
      movedServices: ["postgres", "wayflow"],
    });
    const after = read();
    expect(after).toMatch(/^PORT=3005$/m);
    expect(after).toMatch(/^BETTER_AUTH_URL=http:\/\/localhost:3005$/m);
    // The infra repair this call was for still happened.
    expect(after).toMatch(/^WAYFLOW_BASE_URL=http:\/\/localhost:23010\/?$/m);
    expect(res).toEqual({ remapped: "wayflow:23010" });
  });

  it("NAMES the app port in the summary when it wrote one, so no caller can call it an infra re-point", () => {
    // The re-point writes the app keys and NO infra key: the env already names
    // the wayflow port the file publishes. The summary used to be empty here,
    // which this writer labelled "app port only" and the command then announced
    // as "this instance's own infra ports".
    write("PORT=3005\nWAYFLOW_BASE_URL=http://localhost:23010\n");
    const res = repoint({ appPort: 3350, ports: { wayflow: [23010] }, movedServices: ["wayflow"] });
    expect(read()).toMatch(/^PORT=3350$/m);
    expect(res).toEqual({ remapped: "app:3350" });
  });

  // The INSTALL path is untouched by all of it.
  it("the INSTALL path (no movedServices) still writes every key, including absent ones", () => {
    write("PORT=3000\n");
    const res = repoint({
      appPort: 3350,
      ports: { postgres: [25434], "nango-db": [25435], wayflow: [23010] },
    });
    const after = read();
    expect(after).toMatch(/^PORT=3350$/m);
    expect(after).toMatch(/^SUPABASE_DB_URL=postgresql:\/\/127\.0\.0\.1:25434\/postgres$/m);
    expect(after).toMatch(/^NANGO_DATABASE_URL=postgresql:\/\/127\.0\.0\.1:25435\/nango$/m);
    expect(after).toMatch(/^WAYFLOW_BASE_URL=http:\/\/127\.0\.0\.1:23010\/?$/m);
    expect(res).toMatchObject({ remapped: expect.stringContaining("wayflow:23010") });
  });

  it("is still a silent no-op on a checkout with no .env.local", () => {
    expect(repoint({ ports: { wayflow: [23010] }, movedServices: ["wayflow"] })).toBe(false);
    expect(existsSync(path.join(dir, ".env.local"))).toBe(false);
  });
});

// ===========================================================================
// cinatra#2654 round-8 review — the two install-path primitives `instance
// wayflow start` now shares, rather than re-spelling.
// ===========================================================================
describe("the effective-map primitives the every-start reconcile reuses (round-8 review)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cin-r8-effective-"));
  });

  const doc = (services) => ({ name: "cinatra_r8", services });
  const svc = (ports) => ({
    image: "x:local",
    ports: ports.map((p) => ({ published: String(p), target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" })),
  });

  it("speaks the FILE for a service it publishes, overriding a lagging record", () => {
    expect(effectiveIsolatedPortsFromDoc(doc({ postgres: svc([25434]) }), { postgres: [5434] })).toEqual({
      postgres: [25434],
    });
  });

  it("falls back per-service to the record for a port the file INTERPOLATES", () => {
    const d = doc({ postgres: { image: "x", ports: [{ published: "${PG_PORT}", target: 5432 }] } });
    expect(effectiveIsolatedPortsFromDoc(d, { postgres: [25434] })).toEqual({ postgres: [25434] });
  });

  it("drops a service the file no longer declares, and answers the record for a document it cannot audit", () => {
    expect(effectiveIsolatedPortsFromDoc(doc({ postgres: svc([25434]) }), { redis: [26379] })).toEqual({
      postgres: [25434],
    });
    // Not the generated shape → the pure derivation refuses to invent an answer
    // and hands back the record; refusing the LAUNCH is the caller's job.
    expect(effectiveIsolatedPortsFromDoc(["not", "a", "compose"], { redis: [26379] })).toEqual({ redis: [26379] });
  });

  it("assertIsolatedPortsStillConverge RE-READS the file and refuses a map it no longer publishes", () => {
    writeIsolatedComposeFile(path.join(dir, "docker-compose.cinatra-isolated.yml"), doc({ postgres: svc([25434]) }));
    // The map this run believes it holds still matches the file.
    expect(() =>
      assertIsolatedPortsStillConverge({ slug: "r8", targetDir: dir, ports: { postgres: [25434] }, offset: 20000 }),
    ).not.toThrow();
    // Something rewrote the file underneath the run.
    writeIsolatedComposeFile(path.join(dir, "docker-compose.cinatra-isolated.yml"), doc({ postgres: svc([35434]) }));
    expect(() =>
      assertIsolatedPortsStillConverge({ slug: "r8", targetDir: dir, ports: { postgres: [25434] }, offset: 20000 }),
    ).toThrow(/Refusing to bring up isolated instance "r8"[\s\S]*"postgres"/);
  });
});
