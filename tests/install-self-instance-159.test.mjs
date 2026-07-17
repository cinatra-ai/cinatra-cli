// cinatra-cli#159 — `cinatra install` vs a checkout that ALREADY runs its own
// live instance. The real run has long exempted self-owned ports (proven via
// the compose working_dir label), but:
//   (a) --dry-run probed WITHOUT that exemption, so an idempotent re-run
//       previewed its own nine ports as foreign conflicts and suggested
//       isolating from itself;
//   (b) the plan text promised ".env.local (fresh secret)" that the real run
//       would never mint (it preserves an existing one, --reset-env opt-in);
//   (c) a LEGACY stack (pre-explicit `-p`: compose project = dir basename)
//       passed the owned-port exemption and the default path would `up -d`
//       a PARALLEL container set under the new project name onto the same
//       host ports. Now: fail CLOSED with the attach pointer, and
//       --on-conflict=attach converges (row-less attach omits `-p`, so
//       compose's basename fallback adopts the running legacy stack).
// Docker fully stubbed via deps seams — no daemon needed.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEV_HOST_PORTS, runInstall } from "../src/install.mjs";

// ---------------------------------------------------------------------------
// Fixtures (mirrors tests/install-flow.test.mjs).
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

const dockerPresentDeps = () => ({
  runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
  commandExists: () => true,
  composeAvailable: () => true,
});

const BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "nango-server", host: "0.0.0.0", port: 3003 },
];

// A probe that honors the ownedPorts exemption exactly like the real
// detectPortConflicts (bare-number form): every band port is BUSY, so whatever
// is not exempted comes back as a conflict.
const allBusyProbe = async (band, deps = {}) => {
  const owned = deps.ownedPorts instanceof Set ? deps.ownedPorts : new Set();
  return band
    .filter((e) => !owned.has(e.port) && !owned.has(`${e.host}:${e.port}`) && !owned.has(`0.0.0.0:${e.port}`))
    .map((e) => ({ ...e, holder: "test-holder" }));
};

describe("cinatra-cli#159 — install vs a live self-instance", () => {
  let sandbox;
  let originRepo;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-159-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });
  beforeEach(() => {
    const d = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(d, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(d, "alloc.lock");
  });

  function cloneCheckout(name) {
    const dir = path.join(sandbox, name);
    execFileSync("git", ["clone", `file://${originRepo}`, dir], { stdio: "ignore" });
    return dir;
  }

  function deps(extra = {}) {
    return {
      ...dockerPresentDeps(),
      composePublishedPortsForTarget: () => BAND,
      detectPortConflicts: allBusyProbe,
      bringUpInfra: () => {},
      readCloneRegistry: () => null,
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      ...extra,
    };
  }

  // The planned default project for a dir named X is `cinatra_X` (slug-derived).
  // Ownership covers the FULL static default band (the dry-run probes it) plus
  // the fixture band, as bare numeric entries — the documented back-compat
  // exemption form.
  const ownSelf = (dir, { legacy = false } = {}) => () => ({
    ports: new Set([...DEFAULT_DEV_HOST_PORTS.map((e) => e.port), ...BAND.map((e) => e.port)]),
    projects: new Set([legacy ? "cinatra" : `cinatra_${path.basename(dir).replace(/-/g, "_")}`]),
  });

  it("(a) --dry-run treats the checkout's OWN running band as self, not as foreign conflicts", async () => {
    const dir = cloneCheckout("selfrun");
    const lines = [];
    const res = await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir) }) },
    );
    expect(res.dryRun).toBe(true);
    expect(res.conflicts).toEqual([]);
    expect(res.selfOwnedPortCount).toBeGreaterThan(0);
    expect(res.selfLegacyMismatch).toBe(false);
    expect(lines.join("\n")).toMatch(/treated as self \(idempotent re-run\), not as conflicts/);
    expect(lines.join("\n")).not.toMatch(/--on-conflict=isolated/);
  });

  it("(b) --dry-run plan says the existing .env.local is PRESERVED (and fresh-secret only when absent)", async () => {
    const dir = cloneCheckout("envkeep");
    writeFileSync(path.join(dir, ".env.local"), "BETTER_AUTH_SECRET=live\nCINATRA_RUNTIME_MODE=development\n");
    const lines = [];
    await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir) }) },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/\.env\.local PRESERVED \(pass --reset-env to regenerate\)/);
    expect(out).not.toMatch(/fresh secret/);

    // Fresh-target contrast: no checkout yet → the fresh-secret promise stands.
    const freshLines = [];
    await runInstall(
      ["--dir", path.join(sandbox, "envfresh"), "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      { log: (l) => freshLines.push(String(l)), deps: deps() },
    );
    expect(freshLines.join("\n")).toMatch(/\.env\.local \(fresh secret\)/);
  });

  it("(c) --dry-run names a LEGACY-project self instance and says the real run would refuse", async () => {
    const dir = cloneCheckout("legacydry");
    const lines = [];
    const res = await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir, { legacy: true }) }) },
    );
    expect(res.selfLegacyMismatch).toBe(true);
    const out = lines.join("\n");
    expect(out).toMatch(/ALREADY runs its own live stack under compose project "cinatra"/);
    expect(out).toMatch(/would REFUSE/);
    expect(out).toMatch(/--on-conflict=attach/);
  });

  it("(c2) --dry-run with --on-conflict=attach says it CONVERGES (no stale refuse-advice)", async () => {
    const dir = cloneCheckout("legacydryattach");
    const lines = [];
    await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run", "--on-conflict", "attach"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir, { legacy: true }) }) },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/With --on-conflict=attach the real install CONVERGES/);
    expect(out).not.toMatch(/would REFUSE/);
  });

  it("(c3) --dry-run with --on-conflict=isolated says a SECOND isolated stack is allocated (no contradictory refuse-advice)", async () => {
    const dir = cloneCheckout("legacydryiso");
    const lines = [];
    await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run", "--on-conflict", "isolated"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir, { legacy: true }) }) },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/allocates a SECOND isolated stack alongside/);
    expect(out).not.toMatch(/would REFUSE/);
  });

  it("(b2) --dry-run with --reset-env says the existing .env.local is REGENERATED", async () => {
    const dir = cloneCheckout("envreset");
    writeFileSync(path.join(dir, ".env.local"), "BETTER_AUTH_SECRET=live\n");
    const lines = [];
    await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--dry-run", "--reset-env"],
      { log: (l) => lines.push(String(l)), deps: deps({ targetComposeOwnership: ownSelf(dir) }) },
    );
    expect(lines.join("\n")).toMatch(/\.env\.local REGENERATED \(--reset-env/);
  });

  it("(f) a MIXED planned+legacy self stack still fires the guard (no silent exemption)", async () => {
    const dir = cloneCheckout("mixedreal");
    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: deps({
            targetComposeOwnership: () => ({
              ports: new Set(DEFAULT_DEV_HOST_PORTS.map((e) => e.port)),
              projects: new Set(["cinatra", "cinatra_mixedreal"]),
            }),
            bringUpInfra: (args) => upCalls.push(args),
          }),
        },
      ),
    ).rejects.toThrow(/compose project "cinatra"(?!_)/);
    expect(upCalls).toEqual([]);
  });

  it("(d) REAL run fails CLOSED on the legacy-project self instance BEFORE any bring-up", async () => {
    const dir = cloneCheckout("legacyreal");
    const upCalls = [];
    await expect(
      runInstall(
        ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
        {
          log: () => {},
          deps: deps({
            targetComposeOwnership: ownSelf(dir, { legacy: true }),
            bringUpInfra: (args) => upCalls.push(args),
          }),
        },
      ),
    ).rejects.toThrow(/already runs its OWN live Cinatra stack under compose project "cinatra".*--on-conflict=attach/s);
    expect(upCalls).toEqual([]);
  });

  it("(g) --on-conflict=isolated on a legacy self-instance reaches the isolated path (guard must not dead-end its own advice)", async () => {
    const dir = cloneCheckout("legacyiso");
    const probeArgs = [];
    // The probe records what exemption it was handed; returning [] keeps the
    // run on the default path afterwards (nothing else to resolve).
    const recordingProbe = async (band, d = {}) => {
      probeArgs.push(d.ownedPorts instanceof Set ? d.ownedPorts.size : -1);
      return [];
    };
    const res = await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install", "--on-conflict", "isolated"],
      {
        log: () => {},
        deps: deps({
          targetComposeOwnership: ownSelf(dir, { legacy: true }),
          detectPortConflicts: recordingProbe,
          bringUpInfra: () => {},
        }),
      },
    );
    // No guard throw, and the probe ran WITHOUT the self-exemption (size 0):
    // self-held ports would surface as conflicts and drive the isolated path.
    expect(res.infraPlan).toBe("default"); // empty probe result → default tail
    expect(probeArgs[0]).toBe(0);
  });

  it("(e) --on-conflict=attach CONVERGES on the legacy stack (row-less attach: no -p, basename fallback adopts)", async () => {
    const dir = cloneCheckout("legacyattach");
    const upCalls = [];
    const res = await runInstall(
      ["--dir", dir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install", "--on-conflict", "attach"],
      {
        log: () => {},
        deps: deps({
          targetComposeOwnership: ownSelf(dir, { legacy: true }),
          bringUpInfra: (args) => upCalls.push(args),
        }),
      },
    );
    expect(res.infraPlan).toBe("attach");
    expect(upCalls.length).toBe(1);
    // Row-less attach passes NO explicit compose project — compose's basename
    // fallback resolves to the legacy project, adopting the running stack.
    expect(upCalls[0].composeProject ?? null).toBeNull();
    expect(upCalls[0].targetDir).toBe(dir);
  });
});
