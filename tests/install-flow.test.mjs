// cinatra-cli#17 — install multi-instance flow: parser enum surface (T5a/T5b),
// --status/--list-instances (T6), and the runInstall conflict → classify →
// execute paths (isolated T8/T8b, default-record T8c, stop-existing T11, attach
// T12, external T13). Docker is fully stubbed via the injectable `deps` seam —
// no live daemon / Postgres needed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_REPO_URL, parseInstallArgs, runInstall } from "../src/install.mjs";
import { readInstanceRegistry } from "../src/instance-registry.mjs";
import { readMarker } from "../src/instance-marker.mjs";

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
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      bringUpInfra: () => {},
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

  // ── cinatra-cli#35 — default project name + ownership preflight ─────────────
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
    // …and the SAME name is recorded.
    const reg = readInstanceRegistry(regPath);
    expect(reg.registry.instances["p35-default"].composeProject).toBe("cinatra_p35_default");
  });

  it("eng#513: the default `up` passes `--env-file .env.local` (secrets never interpolate blank)", async () => {
    // The base docker-compose.yml interpolates ${NANGO_ENCRYPTION_KEY} /
    // ${CINATRA_BRIDGE_TOKEN} with NO compose defaults. The default flow writes
    // .env.local BEFORE the infra `up`, so the `up` must resolve interpolation
    // from that file — omitting it starts nango-server with a BLANK encryption
    // key (the cinatra-cli#57 failure class on the DEFAULT path; live-observed
    // in the v0.1.7 closeout real-host sweep, engineering#513).
    const installDir = path.join(sandbox, "p513-envfile");
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
    expect(upCalls.length).toBe(1);
    expect(upCalls[0].envFile).toBe(path.join(installDir, ".env.local"));
    // …and that file really exists at `up` time (env-before-infra ordering).
    expect(existsSync(upCalls[0].envFile)).toBe(true);
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
    const genDoc = JSON.parse(body);
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
        // WayFlow is a compose service in the band (host port 3010).
        wayflow: {
          image: "cinatra-wayflow",
          environment: { PORT: "3010", CINATRA_BASE_URL: "http://host.docker.internal:3000" },
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
    const nangoEnv = JSON.parse(genBody).services["nango-server"].environment;
    expect(nangoEnv.NANGO_SERVER_URL).toBe("http://localhost:13003");
    expect(nangoEnv.NANGO_PUBLIC_SERVER_URL).toBe("http://localhost:13003");
    expect(nangoEnv.RECORDS_DATABASE_URL).toBe("postgresql://nango-db:5432/nango");
    expect(nangoEnv.SERVER_PORT).toBe("3003");
    // No un-offset default self-URL survives anywhere in the generated compose.
    expect(genBody).not.toContain("localhost:3003");
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
});
