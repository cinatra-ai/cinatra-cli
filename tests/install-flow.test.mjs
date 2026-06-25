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
// T5b — gated co-use fails LOUD before any side effect.
// ---------------------------------------------------------------------------
describe("runInstall — gated co-use loud-fail (T5b)", () => {
  it("--infra=share exits with a co-use-not-available error (no side effects)", async () => {
    await expect(runInstall(["--infra", "share", "--yes"], { log: () => {} })).rejects.toThrow(
      /Co-use .* NOT yet available/s,
    );
  });
  it("--on-conflict=co-use exits with the same loud failure", async () => {
    await expect(runInstall(["--on-conflict", "co-use", "--yes"], { log: () => {} })).rejects.toThrow(
      /Co-use .* NOT yet available/s,
    );
  });
  it("gates co-use through the INLINE `=` form too (the documented spelling)", async () => {
    // Regression: the `=` form must gate BEFORE any side effect, exactly like the
    // space form — otherwise `cinatra install --infra=share` proceeds to clone +
    // bring up infra (co-use NOT actually gated).
    await expect(runInstall(["--infra=share", "--yes"], { log: () => {} })).rejects.toThrow(
      /Co-use .* NOT yet available/s,
    );
    await expect(runInstall(["--on-conflict=co-use", "--yes"], { log: () => {} })).rejects.toThrow(
      /Co-use .* NOT yet available/s,
    );
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
    expect(reg.registry.instances["default-ok"].composeProject).toBe("cinatra");
    // marker written + reconcilable.
    expect(readMarker(installDir).status).toBe("ok");
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
