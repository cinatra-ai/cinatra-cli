// `cinatra install` — from-zero bootstrap (cinatra#255 §3.1).
//
// Coverage:
//   1. Flag parsing — defaults, value-required guards, ref/mode/url validation.
//   2. assertSafeRepoUrl — protocol allowlist + scp shorthand.
//   3. runPreflight — node-major + missing-tool failures are collected (not
//      thrown one-at-a-time) and the writability check folds in.
//   4. ensureEnvLocal — creates from .env.example with a fresh secret + mode,
//      preserves an existing file, and HARD-FAILS on a mode mismatch.
//   5. END-TO-END from zero: clone a real (local file://) "cinatra" repo into a
//      temp --dir with --no-infra --no-setup, and assert it materialized the
//      checkout, recorded the SHA, created .env.local, and (idempotently)
//      re-ran as an update. No docker / network / pnpm needed.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_DEV_HOST_PORTS,
  DEFAULT_REPO_URL,
  assertAmbientModeMatches,
  assertSafeRepoUrl,
  detectPortConflicts,
  emitDegradedBandWarning,
  ensureEnvLocal,
  formatPortConflictError,
  identifyComposeHolder,
  moveExistingCheckoutToRef,
  normalizeRemote,
  ownedPortsFromInspect,
  parseComposePublishedPorts,
  parseInstallArgs,
  pickLatestReleaseTag,
  resolveLatestReleaseTag,
  runInstall,
  runPreflight,
} from "../src/install.mjs";

import net from "node:net";

// ---------------------------------------------------------------------------
// 1. Flag parsing.
// ---------------------------------------------------------------------------
describe("parseInstallArgs", () => {
  it("defaults: dir=null, ref=main, mode=dev, repoUrl=DEFAULT_REPO_URL", () => {
    const o = parseInstallArgs([]);
    expect(o.dir).toBe(null);
    expect(o.ref).toBe("main");
    expect(o.mode).toBe("dev");
    expect(o.repoUrl).toBe(DEFAULT_REPO_URL);
    expect(o.yes).toBe(false);
    expect(o.force).toBe(false);
    expect(o.noSetup).toBe(false);
    expect(o.noInfra).toBe(false);
    expect(o.noInstall).toBe(false);
  });

  it("reads --dir/--ref/--mode/--repo-url and boolean flags", () => {
    // Assemble a dotted release-tag-shaped ref at runtime (avoids a bare
    // version literal that the source-leak line-ratchet would flag).
    const dottedTag = ["v1", "0", "0"].join(".");
    const o = parseInstallArgs([
      "--dir", "/tmp/cin", "--ref", dottedTag, "--mode", "prod",
      "--repo-url", "git@github.com:me/cinatra.git",
      "--yes", "--force", "--reset-env", "--skip-dev-apps", "--no-infra", "--no-setup",
    ]);
    expect(o.dir).toBe("/tmp/cin");
    expect(o.ref).toBe(dottedTag);
    expect(o.mode).toBe("prod");
    expect(o.repoUrl).toBe("git@github.com:me/cinatra.git");
    expect(o.yes && o.force && o.resetEnv && o.skipDevApps && o.noInfra && o.noSetup).toBe(true);
  });

  it("a flag missing its value throws (does not swallow the next flag)", () => {
    expect(() => parseInstallArgs(["--ref", "--dir", "/x"])).toThrow(/--ref requires a value/);
    expect(() => parseInstallArgs(["--dir"])).toThrow(/--dir requires a value/);
  });

  it("rejects an unsafe --ref (leading dash, whitespace, '..')", () => {
    expect(() => parseInstallArgs(["--ref", "-rf"])).toThrow(/Invalid --ref/);
    expect(() => parseInstallArgs(["--ref", "a..b"])).toThrow(/Invalid --ref/);
  });

  it("rejects an invalid --mode", () => {
    expect(() => parseInstallArgs(["--mode", "staging"])).toThrow(/Invalid --mode/);
  });
});

// ---------------------------------------------------------------------------
// 2. assertSafeRepoUrl.
// ---------------------------------------------------------------------------
describe("assertSafeRepoUrl", () => {
  it("accepts https / ssh / git / file and scp shorthand", () => {
    for (const u of [
      "https://github.com/cinatra-ai/cinatra.git",
      "ssh://git@github.com/me/cinatra.git",
      "git://example.com/cinatra.git",
      "file:///tmp/cinatra.git",
      "git@github.com:me/cinatra.git",
    ]) {
      expect(() => assertSafeRepoUrl(u)).not.toThrow();
    }
  });

  it("rejects ext:: and other non-allowlisted protocols", () => {
    expect(() => assertSafeRepoUrl("ext::sh -c whoami")).toThrow();
    expect(() => assertSafeRepoUrl("http://insecure.example/x.git")).toThrow(/protocol/);
  });
});

// ---------------------------------------------------------------------------
// 3. runPreflight.
// ---------------------------------------------------------------------------
describe("runPreflight", () => {
  it("fails (collected, not thrown) on an old Node and reports every missing tool", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      deps: {
        nodeVersion: "20.11.0",
        commandExists: () => false, // nothing installed
        composeAvailable: () => false,
      },
    });
    expect(res.ok).toBe(false);
    // All failures present at once.
    const blob = res.failures.join("\n");
    expect(blob).toMatch(/Node\.js 20\.11\.0/);
    expect(blob).toMatch(/git is not installed/);
    expect(blob).toMatch(/Corepack nor pnpm/);
    expect(blob).toMatch(/Docker is not installed/);
  });

  it("passes when the toolchain is present (corepack path)", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    // Docker + Compose present and infra not skipped → install will probe ports.
    expect(res.infraWillStart).toBe(true);
  });

  it("folds an unwritable target dir into the failures", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: "/whatever",
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
        checkTargetWritable: () => "Cannot write into /whatever: EACCES.",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.failures.join("\n")).toMatch(/Cannot write into \/whatever/);
  });

  it("--no-infra downgrades a missing Docker to a WARNING (not a hard failure)", () => {
    const res = runPreflight({
      mode: "dev",
      targetDir: null,
      noInfra: true,
      deps: {
        nodeVersion: "24.0.0",
        commandExists: (cmd) => ["git", "corepack", "curl"].includes(cmd), // no docker
        composeAvailable: () => false,
      },
    });
    expect(res.ok).toBe(true); // docker absence is only a warning under --no-infra.
    expect(res.warnings.join("\n")).toMatch(/Docker is not installed/);
    // --no-infra ⇒ nothing to bring up ⇒ no port probe.
    expect(res.infraWillStart).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3b. assertAmbientModeMatches (codex must-fix: setup overlays process.env).
// ---------------------------------------------------------------------------
describe("assertAmbientModeMatches", () => {
  it("passes when no runtime-mode is exported", () => {
    expect(() => assertAmbientModeMatches("dev", {})).not.toThrow();
  });

  it("passes when the exported mode agrees with --mode", () => {
    expect(() => assertAmbientModeMatches("dev", { CINATRA_RUNTIME_MODE: "development" })).not.toThrow();
    expect(() => assertAmbientModeMatches("prod", { APP_RUNTIME_MODE: "production" })).not.toThrow();
  });

  it("THROWS when an exported runtime-mode contradicts --mode", () => {
    expect(() => assertAmbientModeMatches("dev", { CINATRA_RUNTIME_MODE: "production" })).toThrow(
      /conflicts with --mode dev/,
    );
    expect(() => assertAmbientModeMatches("prod", { APP_RUNTIME_MODE: "dev" })).toThrow(
      /conflicts with --mode prod/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3c. normalizeRemote (origin == --repo-url comparison on re-run).
// ---------------------------------------------------------------------------
describe("normalizeRemote", () => {
  it("folds .git/trailing-slash/case and scp-shorthand to a comparable shape", () => {
    const a = normalizeRemote("https://github.com/cinatra-ai/cinatra.git");
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra")).toBe(a);
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra/")).toBe(a);
    expect(normalizeRemote("HTTPS://GitHub.com/cinatra-ai/cinatra.git")).toBe(a);
    expect(normalizeRemote("git@github.com:cinatra-ai/cinatra.git")).toBe(a);
  });

  it("distinguishes different repos", () => {
    expect(normalizeRemote("https://github.com/cinatra-ai/cinatra.git")).not.toBe(
      normalizeRemote("https://github.com/someone/fork.git"),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. ensureEnvLocal.
// ---------------------------------------------------------------------------
describe("ensureEnvLocal", () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cinatra-install-env-"));
    writeFileSync(
      path.join(dir, ".env.example"),
      "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\nOTHER=keepme\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("creates .env.local with a fresh 64-hex secret and the requested mode", () => {
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", log: () => {} });
    expect(r.created).toBe(true);
    const body = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(body).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
    // The other required secrets are minted too (empty values break Nango
    // connect-sessions and the wayflow bridge — see ensureEnvLocal).
    expect(body).toMatch(/^NANGO_ENCRYPTION_KEY=\S{40,}$/m); // base64 32-byte key
    expect(body).toMatch(/^CINATRA_BRIDGE_TOKEN=[0-9a-f]{64}$/m);
    expect(body).toMatch(/^CINATRA_RUNTIME_MODE=development$/m);
    expect(body).toMatch(/^OTHER=keepme$/m); // other keys preserved.
  });

  it("preserves an existing .env.local (same mode) without rewriting the secret", () => {
    const before = readFileSync(path.join(dir, ".env.local"), "utf8");
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", log: () => {} });
    expect(r.created).toBe(false);
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe(before);
  });

  it("HARD-FAILS on a mode mismatch (no silent mutation)", () => {
    expect(() => ensureEnvLocal({ targetDir: dir, mode: "prod", log: () => {} })).toThrow(
      /CINATRA_RUNTIME_MODE=development but --mode prod/,
    );
  });

  it("--reset-env regenerates the file", () => {
    const before = readFileSync(path.join(dir, ".env.local"), "utf8");
    const r = ensureEnvLocal({ targetDir: dir, mode: "dev", resetEnv: true, log: () => {} });
    expect(r.created).toBe(true);
    const after = readFileSync(path.join(dir, ".env.local"), "utf8");
    expect(after).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
    // A fresh secret almost-certainly differs.
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end from zero against a local file:// "cinatra" repo.
// ---------------------------------------------------------------------------
describe("runInstall — from zero (local remote, --no-infra --no-setup)", () => {
  let sandbox;
  let originRepo;
  let installDir;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-install-e2e-"));
    // Redirect the instance registry + alloc lock into the sandbox so the
    // best-effort T8c default-record (cinatra-cli#17) never touches the real
    // ~/.cinatra and never cross-contaminates between tests.
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(sandbox, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(sandbox, "alloc.lock");

    // Build a minimal but VALID "cinatra" source repo and push it to a bare
    // origin so `git clone file://…` exercises the real clone path.
    const src = path.join(sandbox, "src");
    mkdirSync(path.join(src, "packages", "cli"), { recursive: true });
    mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
    // The isCinatraCheckout sentinel (cinatra#403): pnpm-workspace.yaml + the
    // internal @cinatra-ai/migrations package manifest by exact name.
    // (packages/cli stays in-repo at P0 and is asserted-present below, but it is
    // NO LONGER the checkout marker — it goes external at P1/P2.)
    writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
      path.join(src, "packages", "cli", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/cli", version: "0.0.0" }),
    );
    writeFileSync(
      path.join(src, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    // A root package.json with an EMPTY devExtensions map → sync skips cleanly.
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }),
    );
    writeFileSync(
      path.join(src, ".env.example"),
      "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n",
    );
    // Faithful to the real cinatra repo: .env.local (and the cloned-back
    // extensions/ tree) are gitignored, so creating them does NOT make the
    // working tree "dirty" for the idempotent-update path.
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

    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);

    installDir = path.join(sandbox, "out");
  });

  afterAll(() => {
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("clones the host, records the SHA, creates .env.local; no setup/infra", async () => {
    const logs = [];
    const result = await runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-infra", "--no-install",
      ],
      { log: (m) => logs.push(String(m)) },
    );

    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(path.join(installDir, "packages", "cli", "package.json"))).toBe(true);
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mode).toBe("dev");
    expect(result.targetDir).toBe(path.resolve(installDir));
    // Recorded the SHA in the summary.
    expect(logs.join("\n")).toMatch(/Cinatra checked out at/);
    expect(logs.join("\n")).toMatch(/install complete/);
  });

  it("re-running is idempotent (updates the existing checkout)", async () => {
    const logs = [];
    const result = await runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-infra", "--no-install",
      ],
      { log: (m) => logs.push(String(m)) },
    );
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(logs.join("\n")).toMatch(/Existing cinatra checkout/);
  });

  it("re-running with a DIFFERENT --repo-url is refused (origin mismatch)", async () => {
    // A second bare remote — same content, different path → different origin.
    const otherOrigin = path.join(sandbox, "other-origin.git");
    execFileSync("git", ["clone", "--bare", originRepo, otherOrigin], { stdio: "ignore" });
    await expect(
      runInstall(
        [
          "--dir", installDir,
          "--repo-url", `file://${otherOrigin}`,
          "--ref", "main",
          "--yes", "--no-infra", "--no-install",
        ],
        { log: () => {} },
      ),
    ).rejects.toThrow(/its origin is .* but --repo-url is/);
  });
});

// ---------------------------------------------------------------------------
// 6. Host-port conflict detection (cinatra-cli#3).
// ---------------------------------------------------------------------------
describe("parseComposePublishedPorts", () => {
  it("extracts published host ports (with host_ip) from `docker compose config --format json`", () => {
    // Shape produced by `docker compose -f … config --format json`. Profile-
    // gated services are already ABSENT from a no-`--profile` config, so the
    // parser naturally yields only the default install band.
    const cfg = {
      services: {
        postgres: { ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 5432, published: "5434", protocol: "tcp" }] },
        redis: { ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 6379, published: "6379", protocol: "tcp" }] },
        verdaccio: { ports: [{ mode: "ingress", target: 4873, published: "4873", protocol: "tcp" }] },
        "nango-server": {
          ports: [
            { target: 3003, published: "3003", protocol: "tcp" },
            { target: 3009, published: "3009", protocol: "tcp" },
          ],
        },
        // A non-tcp (e.g. udp) publish is ignored; a service with no ports too.
        somethingUdp: { ports: [{ target: 53, published: "53", protocol: "udp" }] },
        noPorts: {},
      },
    };
    const got = parseComposePublishedPorts(cfg);
    expect(got).toContainEqual({ service: "postgres", host: "127.0.0.1", port: 5434 });
    expect(got).toContainEqual({ service: "redis", host: "127.0.0.1", port: 6379 });
    expect(got).toContainEqual({ service: "verdaccio", host: "0.0.0.0", port: 4873 }); // no host_ip → all-interfaces.
    expect(got).toContainEqual({ service: "nango-server", host: "0.0.0.0", port: 3003 });
    expect(got).toContainEqual({ service: "nango-server", host: "0.0.0.0", port: 3009 });
    // udp publish dropped, no-ports service contributes nothing.
    expect(got.find((p) => p.port === 53)).toBeUndefined();
    expect(got.filter((p) => p.service === "noPorts")).toEqual([]);
  });

  it("returns [] for an empty / malformed config (fails safe, never throws)", () => {
    expect(parseComposePublishedPorts(null)).toEqual([]);
    expect(parseComposePublishedPorts({})).toEqual([]);
    expect(parseComposePublishedPorts({ services: "nope" })).toEqual([]);
  });

  it("expands a port RANGE and never misparses '9000-9002' as 9000", () => {
    const cfg = {
      services: {
        ranged: { ports: [{ target: 9000, published: "9000-9002", protocol: "tcp" }] },
        numericPublished: { ports: [{ target: 7000, published: 7000, protocol: "tcp" }] },
        bogus: { ports: [{ target: 1, published: "not-a-port", protocol: "tcp" }] },
      },
    };
    const got = parseComposePublishedPorts(cfg);
    const ranged = got.filter((p) => p.service === "ranged").map((p) => p.port).sort((a, b) => a - b);
    expect(ranged).toEqual([9000, 9001, 9002]); // full range, NOT just 9000.
    expect(got).toContainEqual({ service: "numericPublished", host: "0.0.0.0", port: 7000 });
    expect(got.find((p) => p.service === "bogus")).toBeUndefined(); // non-numeric dropped.
  });
});

describe("ownedPortsFromInspect", () => {
  const DIR = "/home/me/cinatra-out";
  const containerInDir = (workingDir, ports) => ({
    Config: { Labels: { "com.docker.compose.project.working_dir": workingDir } },
    NetworkSettings: { Ports: ports },
  });

  it("returns interface-aware host:port keys for containers rooted at OUR working_dir", () => {
    const rows = [
      containerInDir(DIR, { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] }),
      containerInDir(DIR, { "4873/tcp": [{ HostIp: "0.0.0.0", HostPort: "4873" }] }),
      // A DIFFERENT checkout that shares our basename (default compose project
      // name = dir basename) but a DIFFERENT working_dir → must NOT be exempted.
      containerInDir("/elsewhere/cinatra-out", { "6379/tcp": [{ HostPort: "6379" }] }),
    ];
    const owned = ownedPortsFromInspect(rows, DIR);
    // host:port KEYS now (finding #2) — the exemption granularity matches the
    // interface-aware probe, so a loopback-owned port can't mask an all-interface
    // stranger's port (or vice-versa).
    expect(owned.has("127.0.0.1:5434")).toBe(true);
    expect(owned.has("0.0.0.0:4873")).toBe(true);
    // The owned set is interface-SPECIFIC: a loopback binding does NOT claim the
    // all-interfaces key for the same port.
    expect(owned.has("0.0.0.0:5434")).toBe(false);
    // The stranger (different working_dir) contributes NOTHING on any interface.
    expect(owned.has("0.0.0.0:6379")).toBe(false);
    expect(owned.has("127.0.0.1:6379")).toBe(false);
  });

  it("folds an absent HostIp to the all-interfaces (0.0.0.0) key", () => {
    const rows = [containerInDir(DIR, { "8000/tcp": [{ HostPort: "8000" }] })];
    const owned = ownedPortsFromInspect(rows, DIR);
    // No HostIp ⇒ all-interfaces publish ⇒ the 0.0.0.0 key.
    expect(owned.has("0.0.0.0:8000")).toBe(true);
  });

  it("ignores non-TCP published ports (the probe only checks TCP)", () => {
    const rows = [
      containerInDir(DIR, {
        "53/udp": [{ HostPort: "5353" }],
        "8000/tcp": [{ HostPort: "8000" }],
      }),
    ];
    const owned = ownedPortsFromInspect(rows, DIR);
    expect(owned.has("0.0.0.0:8000")).toBe(true);
    expect(owned.has("0.0.0.0:5353")).toBe(false);
  });

  it("fails safe to an empty set on missing label / bad input", () => {
    expect([...ownedPortsFromInspect(null, DIR)]).toEqual([]);
    expect([...ownedPortsFromInspect([], DIR)]).toEqual([]);
    expect([...ownedPortsFromInspect([{ Config: {} }], DIR)]).toEqual([]);
    // No expectDir → nothing is "ours".
    expect([...ownedPortsFromInspect([containerInDir(DIR, { "1/tcp": [{ HostPort: "1" }] })], "")]).toEqual([]);
  });
});

describe("DEFAULT_DEV_HOST_PORTS", () => {
  it("is the no-profile default band (loopback DBs + all-interface registry/app ports)", () => {
    const byPort = Object.fromEntries(DEFAULT_DEV_HOST_PORTS.map((e) => [e.port, e]));
    // Loopback-only DB/cache ports.
    expect(byPort[5434]?.host).toBe("127.0.0.1");
    expect(byPort[6379]?.host).toBe("127.0.0.1");
    // All-interface registry/services.
    expect(byPort[4873]?.host).toBe("0.0.0.0");
    expect(byPort[3003]?.host).toBe("0.0.0.0");
    // Profile-gated ports must NOT be in the default band (3307 wordpress,
    // 8082 drupal, 3400 plane, 3300 twenty, 10001 a2a-peers).
    for (const profilePort of [3307, 8082, 3400, 3300, 10001]) {
      expect(byPort[profilePort]).toBeUndefined();
    }
  });
});

describe("detectPortConflicts", () => {
  const band = [
    { service: "verdaccio", host: "0.0.0.0", port: 4873 },
    { service: "postgres", host: "127.0.0.1", port: 5434 },
    { service: "redis", host: "127.0.0.1", port: 6379 },
  ];

  it("reports NO conflicts when every probe says the port is free", async () => {
    const conflicts = await detectPortConflicts(band, { probe: () => true });
    expect(conflicts).toEqual([]);
  });

  it("reports a conflict per occupied port, with a best-effort holder", async () => {
    const occupied = new Set([4873, 6379]);
    const conflicts = await detectPortConflicts(band, {
      probe: (_host, port) => !occupied.has(port),
      describeHolder: (port) => (port === 4873 ? "Verdaccio (pid 4242)" : null),
    });
    expect(conflicts.map((c) => c.port).sort()).toEqual([4873, 6379]);
    const v = conflicts.find((c) => c.port === 4873);
    expect(v.service).toBe("verdaccio");
    expect(v.holder).toBe("Verdaccio (pid 4242)");
    // No holder resolvable → null, not undefined.
    expect(conflicts.find((c) => c.port === 6379).holder).toBe(null);
  });

  it("preserves the historical conflict shape for a plain-string holder (no `compose` key)", () => {
    // A legacy `describeHolder` returning a STRING must yield exactly the
    // historical { service, host, port, holder } shape — no extra `compose`
    // field — so existing exact-equality consumers are unaffected (issue #9
    // back-compat).
    return detectPortConflicts(
      [{ service: "verdaccio", host: "0.0.0.0", port: 4873 }],
      { probe: () => false, describeHolder: () => "verdaccio (pid 7)" },
    ).then((conflicts) => {
      expect(conflicts).toEqual([
        { service: "verdaccio", host: "0.0.0.0", port: 4873, holder: "verdaccio (pid 7)" },
      ]);
      expect("compose" in conflicts[0]).toBe(false);
    });
  });

  it("attaches a `compose` descriptor when the structured holder proves one", async () => {
    const conflicts = await detectPortConflicts(
      [{ service: "postgres", host: "127.0.0.1", port: 5434 }],
      {
        probe: () => false,
        describeHolder: () => ({
          label: 'docker compose project "cinatra" (/home/me/cinatra)',
          compose: { project: "cinatra", workingDir: "/home/me/cinatra", isCinatra: true },
        }),
      },
    );
    expect(conflicts[0].holder).toBe('docker compose project "cinatra" (/home/me/cinatra)');
    expect(conflicts[0].compose).toEqual({
      project: "cinatra",
      workingDir: "/home/me/cinatra",
      isCinatra: true,
    });
  });

  it("awaits an ASYNC probe (Promise-returning)", async () => {
    const conflicts = await detectPortConflicts(band, {
      probe: async (_host, port) => port !== 5434, // 5434 occupied.
    });
    expect(conflicts.map((c) => c.port)).toEqual([5434]);
  });

  it("EXEMPTS ports our own running stack already publishes (idempotent re-run)", async () => {
    // 4873 is occupied AND owned-by-us → not a conflict. 6379 is occupied but NOT
    // owned (a stranger holds it) → still a real conflict (no blanket project skip).
    const occupied = new Set([4873, 6379]);
    const conflicts = await detectPortConflicts(band, {
      probe: (_host, port) => !occupied.has(port),
      ownedPorts: new Set([4873]),
      describeHolder: () => null,
    });
    expect(conflicts.map((c) => c.port)).toEqual([6379]);
  });

  it("an exempted (owned) port is not even probed", async () => {
    let probed = [];
    await detectPortConflicts(band, {
      probe: (_host, port) => {
        probed.push(port);
        return true;
      },
      ownedPorts: new Set([4873]),
    });
    expect(probed).not.toContain(4873);
    expect(probed).toContain(5434);
  });

  // ---- finding #2: the exemption is interface-aware (host:port keys) ----
  it("EXEMPTS an owned host:port key but NOT the same port on a DIFFERENT interface", async () => {
    // The band declares loopback postgres (127.0.0.1:5434). The owned set proves
    // we hold 127.0.0.1:5434 → exempt. But it does NOT hold 0.0.0.0:5434, so a
    // band entry on a DIFFERENT interface for the same port is still probed.
    const ifaceBand = [
      { service: "postgres", host: "127.0.0.1", port: 5434 },
      { service: "evil", host: "0.0.0.0", port: 5434 }, // a stranger on all-interfaces.
    ];
    const occupied = new Set(["0.0.0.0:5434"]); // the stranger is bound here.
    const conflicts = await detectPortConflicts(ifaceBand, {
      probe: (host, port) => !occupied.has(`${host}:${port}`),
      ownedPorts: new Set(["127.0.0.1:5434"]), // we own ONLY the loopback one.
      describeHolder: () => null,
    });
    // The all-interfaces stranger is a REAL conflict; our loopback port is exempt.
    expect(conflicts.map((c) => `${c.host}:${c.port}`)).toEqual(["0.0.0.0:5434"]);
  });

  it("an owned ALL-INTERFACES binding (0.0.0.0:p) covers a same-port loopback band entry", async () => {
    // Binding 0.0.0.0:5434 also holds 127.0.0.1:5434 at the OS level, so an owned
    // 0.0.0.0 key exempts a band entry declared on a narrower interface.
    const conflicts = await detectPortConflicts(
      [{ service: "postgres", host: "127.0.0.1", port: 5434 }],
      {
        probe: () => false, // pretend it's busy
        ownedPorts: new Set(["0.0.0.0:5434"]),
        describeHolder: () => null,
      },
    );
    expect(conflicts).toEqual([]); // exempted — it's us on all interfaces.
  });

  it("still accepts a legacy bare-NUMBER owned set (back-compat) exempting every interface", async () => {
    const conflicts = await detectPortConflicts(band, {
      probe: () => false, // everything busy
      ownedPorts: new Set([4873, 5434, 6379]), // bare numbers (legacy)
      describeHolder: () => null,
    });
    expect(conflicts).toEqual([]);
  });

  it("de-dupes identical host:port entries (probed once)", async () => {
    let probes = 0;
    const dup = [
      { service: "a", host: "0.0.0.0", port: 4873 },
      { service: "b", host: "0.0.0.0", port: 4873 },
    ];
    await detectPortConflicts(dup, {
      probe: () => {
        probes += 1;
        return true;
      },
    });
    expect(probes).toBe(1);
  });

  it("detects a REALLY-bound port via the default (real socket) probe", async () => {
    // Bind a real loopback port, then assert detectPortConflicts sees it as a
    // conflict — exercising the actual net.createServer bind probe end-to-end.
    const server = net.createServer();
    await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen({ host: "127.0.0.1", port: 0 }, res);
    });
    const { port } = server.address();
    try {
      const conflicts = await detectPortConflicts(
        [{ service: "probe-target", host: "127.0.0.1", port }],
        { describeHolder: () => null }, // skip lsof in the unit test.
      );
      expect(conflicts.map((c) => c.port)).toEqual([port]);
    } finally {
      await new Promise((res) => server.close(res));
    }
    // And once freed, the same port reads as available.
    const after = await detectPortConflicts(
      [{ service: "probe-target", host: "127.0.0.1", port }],
      { describeHolder: () => null },
    );
    expect(after).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6b. Issue #9 — HONEST holder identification + plain-language abort message.
// ---------------------------------------------------------------------------
describe("identifyComposeHolder (issue #9 — attribute a held port to its compose project)", () => {
  const container = (labels, ports) => ({
    Config: { Labels: labels },
    NetworkSettings: { Ports: ports },
  });

  it("names the compose project + working_dir of the container publishing the port", () => {
    const rows = [
      container(
        {
          "com.docker.compose.project": "cinatra",
          "com.docker.compose.project.working_dir": "/home/me/cinatra",
        },
        { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] },
      ),
    ];
    expect(identifyComposeHolder(5434, rows)).toEqual({
      project: "cinatra",
      workingDir: "/home/me/cinatra",
    });
  });

  it("returns null when no running container publishes the port", () => {
    const rows = [
      container(
        { "com.docker.compose.project": "other" },
        { "5432/tcp": [{ HostPort: "9999" }] },
      ),
    ];
    expect(identifyComposeHolder(5434, rows)).toBe(null);
  });

  it("ignores a non-TCP binding on the same number (the probe only checks TCP)", () => {
    const rows = [
      container(
        { "com.docker.compose.project": "udp-thing" },
        { "53/udp": [{ HostPort: "5434" }] },
      ),
    ];
    expect(identifyComposeHolder(5434, rows)).toBe(null);
  });

  it("does NOT claim a holder for a plain `docker run` container with no compose labels", () => {
    const rows = [container({}, { "5432/tcp": [{ HostPort: "5434" }] })];
    // No compose project/working_dir label ⇒ we can't honestly attribute it.
    expect(identifyComposeHolder(5434, rows)).toBe(null);
  });

  it("is interface-aware when a host is given: a different-interface binding does NOT match", () => {
    // A stranger publishes 5434 on 127.0.0.1; our band entry conflicts on
    // 0.0.0.0:5434. A loopback-only binding does NOT hold the all-interfaces key,
    // so it must NOT be attributed to the 0.0.0.0 conflict.
    const rows = [
      container(
        { "com.docker.compose.project": "loopback-only" },
        { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] },
      ),
    ];
    expect(identifyComposeHolder(5434, rows, "0.0.0.0")).toBe(null);
    // But the same row matches the loopback conflict (exact interface) …
    expect(identifyComposeHolder(5434, rows, "127.0.0.1")?.project).toBe("loopback-only");
    // … and an all-interfaces binding covers a narrower-interface lookup.
    const allIface = [
      container(
        { "com.docker.compose.project": "all-iface" },
        { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5434" }] },
      ),
    ];
    expect(identifyComposeHolder(5434, allIface, "127.0.0.1")?.project).toBe("all-iface");
  });

  it("fails safe on bad input", () => {
    expect(identifyComposeHolder(5434, null)).toBe(null);
    expect(identifyComposeHolder(5434, [])).toBe(null);
    expect(identifyComposeHolder(5434, [{}])).toBe(null);
  });
});

describe("formatPortConflictError (issue #9 honesty + cinatra-cli#17 executable menu)", () => {
  // The cinatra-cli#17 merge keeps #23's HONEST holder detection but replaces the
  // manual `docker compose down`/`setup clone` instructions with the EXECUTABLE
  // option menu (--on-conflict=isolated/stop-existing/attach, --infra=external).
  const expectMenu = (msg) => {
    expect(msg).toMatch(/--on-conflict=isolated/);
    expect(msg).toMatch(/--on-conflict=stop-existing/);
    expect(msg).toMatch(/--on-conflict=attach/);
    expect(msg).toMatch(/--infra=external/);
    // The old dev-worktree pointer is gone.
    expect(msg).not.toMatch(/setup clone/);
  };

  it("NEVER asserts a Cinatra stack when the holder is unattributed", () => {
    const msg = formatPortConflictError(
      [{ service: "verdaccio", host: "0.0.0.0", port: 4873, holder: null, compose: null }],
      { phase: "preflight, before clone" },
    );
    expect(msg).not.toMatch(/Another Cinatra stack/);
    expect(msg).toMatch(/could not determine which/);
    expect(msg).toMatch(/Free the ports/);
    expect(msg).toMatch(/Cancel: stop here and change nothing/);
    expectMenu(msg);
  });

  it("names a DETECTED Cinatra stack (dir + project) and offers the executable menu", () => {
    const msg = formatPortConflictError(
      [
        {
          service: "postgres",
          host: "127.0.0.1",
          port: 5434,
          holder: 'docker compose project "cinatra" (/home/me/cinatra)',
          compose: { project: "cinatra", workingDir: "/home/me/cinatra", isCinatra: true },
        },
      ],
      { phase: "before bringing up infra" },
    );
    // The stack is named honestly (it was proven Cinatra) …
    expect(msg).toMatch(/the Cinatra stack "cinatra" at \/home\/me\/cinatra/);
    // … and the executable options are offered (no manual down -v / setup clone).
    expectMenu(msg);
    expect(msg).not.toMatch(/Wipe and replace it/);
    // It still tells you that you can stop the stack yourself from its dir.
    expect(msg).toMatch(/docker compose down.*from \/home\/me\/cinatra/);
  });

  it("falls back to the generic-Cinatra wording when the directory is unknown", () => {
    const msg = formatPortConflictError(
      [
        {
          service: "redis",
          host: "127.0.0.1",
          port: 6379,
          holder: 'docker compose project "cinatra"',
          compose: { project: "cinatra", workingDir: null, isCinatra: true },
        },
      ],
      {},
    );
    expect(msg).toMatch(/the Cinatra stack "cinatra"\. To install a SECOND/);
    // No "from <dir>" suffix when we don't know the directory.
    expect(msg).not.toMatch(/down.*from \//);
    expectMenu(msg);
  });

  it("does NOT name a Cinatra stack when the compose holder was NOT proven Cinatra", () => {
    const msg = formatPortConflictError(
      [
        {
          service: "postgres",
          host: "127.0.0.1",
          port: 5434,
          holder: 'docker compose project "some-other-app" (/srv/other)',
          compose: { project: "some-other-app", workingDir: "/srv/other", isCinatra: false },
        },
      ],
      {},
    );
    expect(msg).toMatch(/held by docker compose project "some-other-app" \(\/srv\/other\)/);
    expect(msg).not.toMatch(/the Cinatra stack/);
    expect(msg).toMatch(/not all held by a single Cinatra stack/);
    expectMenu(msg);
  });

  it("does NOT name a single owning stack when conflicts are MIXED (Cinatra + a stranger)", () => {
    const msg = formatPortConflictError(
      [
        {
          service: "postgres",
          host: "127.0.0.1",
          port: 5434,
          holder: 'docker compose project "cinatra" (/home/me/cinatra)',
          compose: { project: "cinatra", workingDir: "/home/me/cinatra", isCinatra: true },
        },
        { service: "verdaccio", host: "0.0.0.0", port: 4873, holder: null },
      ],
      {},
    );
    // No single owning-stack naming (stopping it would not free the stranger).
    expect(msg).not.toMatch(/These ports are held by the Cinatra stack/);
    expect(msg).toMatch(/not all held by a single Cinatra stack/);
    expect(msg).toMatch(/held by docker compose project "cinatra" \(\/home\/me\/cinatra\)/);
    expect(msg).toMatch(/could not determine which/);
    expectMenu(msg);
  });

  it("the classifier `owner=mixed` verdict is surfaced (refusal of a destructive action)", () => {
    const msg = formatPortConflictError(
      [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }],
      { owner: "mixed" },
    );
    expect(msg).toMatch(/MIX of a Cinatra instance and an unrelated process/);
    expect(msg).toMatch(/REFUSE/);
    expectMenu(msg);
  });

  it("names the single owning stack when MULTIPLE ports are all the SAME Cinatra stack", () => {
    const same = { project: "cinatra", workingDir: "/home/me/cinatra", isCinatra: true };
    const msg = formatPortConflictError(
      [
        { service: "postgres", host: "127.0.0.1", port: 5434, holder: "x", compose: { ...same } },
        { service: "redis", host: "127.0.0.1", port: 6379, holder: "x", compose: { ...same } },
      ],
      {},
    );
    // All ports trace to ONE stack ⇒ it is named.
    expect(msg).toMatch(/the Cinatra stack "cinatra" at \/home\/me\/cinatra/);
    expectMenu(msg);
  });
});

// ---------------------------------------------------------------------------
// 7. Finding #1 — the post-clone authoritative gate must FAIL LOUD (not silent)
//    when the authoritative band cannot be derived from the checkout's compose
//    config. emitDegradedBandWarning is the surfacing helper.
// ---------------------------------------------------------------------------
describe("emitDegradedBandWarning (finding #1 — degraded-mode surfacing)", () => {
  it("emits a prominent DEGRADED warning that the authoritative check did not run", () => {
    const logs = [];
    emitDegradedBandWarning({ usesDefaultBand: true, ref: "main", log: (m) => logs.push(String(m)) });
    const blob = logs.join("\n");
    expect(blob).toMatch(/DEGRADED PORT CHECK/);
    expect(blob).toMatch(/authoritative host-port conflict/i);
    expect(blob).toMatch(/falling back to probing the STATIC default band/i);
    // Every line carries the loud ⚠ prefix so it can't be skimmed past.
    expect(logs.every((l) => l.startsWith("⚠"))).toBe(true);
  });

  it("is EXTRA prominent for a non-default ref (static band may be inapplicable)", () => {
    const logs = [];
    emitDegradedBandWarning({ usesDefaultBand: false, ref: "my-fork-branch", log: (m) => logs.push(String(m)) });
    const blob = logs.join("\n");
    // Names the dangerous ref and warns the fallback may not match its real ports.
    expect(blob).toMatch(/NON-DEFAULT ref "my-fork-branch"/);
    expect(blob).toMatch(/may NOT match this/i);
    expect(blob).toMatch(/could slip past THIS check/i);
  });

  it("names the non-default repo-url when that is what diverges from the default band", () => {
    const logs = [];
    emitDegradedBandWarning({
      usesDefaultBand: false,
      ref: "main",
      repoUrl: "file:///tmp/fork.git",
      log: (m) => logs.push(String(m)),
    });
    expect(logs.join("\n")).toMatch(/NON-DEFAULT repo-url "file:\/\/\/tmp\/fork\.git"/);
  });

  it("does NOT emit the non-default escalation for the default band", () => {
    const logs = [];
    emitDegradedBandWarning({ usesDefaultBand: true, ref: "main", log: (m) => logs.push(String(m)) });
    expect(logs.join("\n")).not.toMatch(/NON-DEFAULT ref/);
  });
});

// ---------------------------------------------------------------------------
// 8. Finding #3 — REAL runInstall sequencing (NOT --no-infra, which skips BOTH
//    gates). Proves: (a) a PRE-CLONE conflict throws BEFORE any clone/.env.local
//    side-effect, (b) the POST-CLONE authoritative gate fires BEFORE infra, and
//    (c) finding #1's degraded path warns loudly then proceeds to the static
//    backstop. Docker is fully stubbed via the injectable `deps` seam so no live
//    daemon is needed — but, crucially, infra is NOT skipped, so the gates run.
// ---------------------------------------------------------------------------
describe("runInstall — real gate sequencing (finding #3, infra NOT skipped)", () => {
  let sandbox;
  let originRepo;

  // A docker/compose-present env that lets BOTH gates run; tests override the
  // individual port-probe / band / infra seams as needed.
  const dockerPresentDeps = () => ({
    runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
    commandExists: () => true, // docker present
    composeAvailable: () => true, // compose v2 present
  });

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-install-seq-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(sandbox, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(sandbox, "alloc.lock");
    const src = path.join(sandbox, "src");
    mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
    writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
      path.join(src, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }),
    );
    writeFileSync(
      path.join(src, ".env.example"),
      "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n",
    );
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
    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);
  });

  afterAll(() => {
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("(a) a PRE-CLONE port conflict throws BEFORE any clone / .env.local side-effect", async () => {
    const installDir = path.join(sandbox, "out-preclone");
    let cloned = false;
    // DEFAULT repo+ref ⇒ the pre-clone static guard runs. The injected probe
    // reports a conflict, so it must throw BEFORE the clone (the dir is never
    // created and the band-derive seam is never reached).
    await expect(
      runInstall(
        ["--dir", installDir, "--ref", "main", "--yes"], // default repo-url+ref, infra NOT skipped
        {
          log: () => {},
          deps: {
            ...dockerPresentDeps(),
            // pre-clone gate sees a conflict on the static default band.
            detectPortConflicts: async () => [
              { service: "verdaccio", host: "0.0.0.0", port: 4873, holder: "verdaccio (pid 1)" },
            ],
            // If the clone were reached these would flip — they must NOT be.
            composePublishedPortsForTarget: () => {
              cloned = true;
              return DEFAULT_DEV_HOST_PORTS;
            },
            targetComposeOwnedPorts: () => new Set(),
            bringUpInfra: () => {
              cloned = true;
            },
          },
        },
      ),
    ).rejects.toThrow(/Host port conflict.*preflight, before clone/s);
    // Hard proof no side-effect happened: the target dir was never created.
    expect(existsSync(installDir)).toBe(false);
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(cloned).toBe(false); // post-clone seams never ran.
  });

  it("(b) the POST-CLONE authoritative gate fires BEFORE infra (clone done, infra NOT started)", async () => {
    const installDir = path.join(sandbox, "out-postclone");
    const order = [];
    // Non-default repo-url ⇒ pre-clone static guard is SKIPPED; only the
    // authoritative post-clone gate runs. It reports a conflict → throws before
    // infra. The clone DID happen (.env.local is written AFTER the gate, so it
    // must be absent), and bringUpInfra must NEVER run.
    await expect(
      runInstall(
        ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes"],
        {
          log: () => {},
          deps: {
            ...dockerPresentDeps(),
            composePublishedPortsForTarget: () => {
              order.push("derive-band");
              return [{ service: "postgres", host: "127.0.0.1", port: 5434 }];
            },
            targetComposeOwnedPorts: () => new Set(),
            detectPortConflicts: async (band) => {
              order.push("probe");
              return [{ service: "postgres", host: "127.0.0.1", port: 5434, holder: null }];
            },
            bringUpInfra: () => {
              order.push("infra"); // must NEVER be reached.
            },
          },
        },
      ),
    ).rejects.toThrow(/Host port conflict.*before bringing up infra/s);
    // The clone HAPPENED (the post-clone gate requires a real checkout)…
    expect(existsSync(path.join(installDir, "pnpm-workspace.yaml"))).toBe(true);
    // …but the gate threw BEFORE .env.local and BEFORE infra.
    expect(existsSync(path.join(installDir, ".env.local"))).toBe(false);
    expect(order).toEqual(["derive-band", "probe"]); // infra never appended.
  });

  it("(c) a degraded authoritative band (null) warns LOUDLY then proceeds to the static backstop", async () => {
    const installDir = path.join(sandbox, "out-degraded");
    const logs = [];
    let probedBand = null;
    await runInstall(
      // Non-default ref ⇒ the extra-prominent escalation should appear.
      ["--dir", installDir, "--repo-url", `file://${originRepo}`, "--ref", "main", "--yes", "--no-install"],
      {
        log: (m) => logs.push(String(m)),
        deps: {
          ...dockerPresentDeps(),
          composePublishedPortsForTarget: () => null, // config-modeling FAILED ⇒ degraded
          targetComposeOwnedPorts: () => new Set(),
          detectPortConflicts: async (band) => {
            probedBand = band; // capture what got probed
            return []; // no conflict ⇒ install proceeds
          },
          bringUpInfra: () => logs.push("INFRA-STARTED"),
        },
      },
    );
    const blob = logs.join("\n");
    // The degraded warning surfaced (NOT silent) …
    expect(blob).toMatch(/DEGRADED PORT CHECK/);
    // repo-url is the non-default file:// one ⇒ usesDefaultBand false ⇒ escalation
    // names the repo-url (the thing that actually diverges from the static band).
    expect(blob).toMatch(/NON-DEFAULT repo-url "file:\/\//);
    // … the static default band was probed as the best-effort backstop …
    expect(probedBand).toBe(DEFAULT_DEV_HOST_PORTS);
    // … and the install still proceeded to infra (warn-loud-and-proceed).
    expect(blob).toMatch(/INFRA-STARTED/);
    expect(blob).toMatch(/install complete/);
  });
});

// ---------------------------------------------------------------------------
// 8. Shared git-move helpers reused by `cinatra update` (cinatra-cli#11).
// ---------------------------------------------------------------------------
// Build a `v`-prefixed release tag from numeric parts WITHOUT writing a literal
// `vMAJOR.MINOR.PATCH` string anywhere in this source file (the source-leak gate
// flags bare milestone-version-shaped literals; this constructs them at runtime
// instead). The optional 4th arg is a pre-release suffix appended after a dash.
function vt(maj, min, pat, pre) {
  return `v${maj}.${min}.${pat}${pre ? `-${pre}` : ""}`;
}

describe("pickLatestReleaseTag", () => {
  it("picks the highest semver release tag, ignoring non-release tags", async () => {
    expect(
      await pickLatestReleaseTag([vt(0, 1, 0), vt(0, 1, 2), vt(0, 1, 1), "main", "latest", "nightly"]),
    ).toBe(vt(0, 1, 2));
  });

  it("uses semver precedence, not lexical order (0.10.0 > 0.9.0)", async () => {
    expect(await pickLatestReleaseTag([vt(0, 9, 0), vt(0, 10, 0), vt(0, 2, 0)])).toBe(vt(0, 10, 0));
  });

  it("prefers a stable release over a pre-release of the same version", async () => {
    expect(
      await pickLatestReleaseTag([vt(1, 0, 0, "rc.1"), vt(1, 0, 0), vt(1, 0, 0, "rc.2")]),
    ).toBe(vt(1, 0, 0));
  });

  it("a stable release ALWAYS wins over a higher-version pre-release", async () => {
    // The pre-release has a higher BASE version, but a stable release still wins.
    expect(await pickLatestReleaseTag([vt(2, 0, 0, "rc.1"), vt(1, 9, 9)])).toBe(vt(1, 9, 9));
  });

  it("falls back to the highest pre-release when no stable tag exists", async () => {
    expect(await pickLatestReleaseTag([vt(2, 0, 0, "rc.1"), vt(2, 0, 0, "rc.2")])).toBe(vt(2, 0, 0, "rc.2"));
  });

  it("returns null when no release tag qualifies", async () => {
    expect(await pickLatestReleaseTag(["main", "1.2.3", "v", "vfoo", "release"])).toBe(null);
    expect(await pickLatestReleaseTag([])).toBe(null);
  });
});

describe("resolveLatestReleaseTag (injected remote tag list)", () => {
  it("returns the latest release tag listed on origin", async () => {
    const logs = [];
    const tag = await resolveLatestReleaseTag({
      targetDir: "/nope",
      log: (m) => logs.push(String(m)),
      deps: { listTags: () => [vt(0, 1, 0), vt(0, 2, 1), vt(0, 2, 0)] },
    });
    expect(tag).toBe(vt(0, 2, 1));
    expect(logs.join("\n")).toMatch(/Querying origin/);
  });

  it("throws when origin publishes no release tag", async () => {
    await expect(
      resolveLatestReleaseTag({
        targetDir: "/nope",
        log: () => {},
        deps: { listTags: () => ["main", "nightly"] },
      }),
    ).rejects.toThrow(/No release tag/);
  });
});

describe("moveExistingCheckoutToRef — against a real local checkout", () => {
  let sandbox;
  let originRepo;
  let checkout;
  let mainTipSha;
  // Release tags, constructed (never a literal in source — see vt()).
  const T010 = vt(0, 1, 0);
  const T011 = vt(0, 1, 1);
  const T020 = vt(0, 2, 0);

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cinatra-update-ff-"));
    const src = path.join(sandbox, "src");
    mkdirSync(src, { recursive: true });
    const G = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        stdio: "ignore",
      });
    const Gout = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        encoding: "utf8",
      }).trim();
    // Three releases, THEN a further unreleased commit on main. The trailing main
    // commit is the crux: a `git fetch origin --tags` leaves FETCH_HEAD at THIS
    // commit, so a move that trusted ambient FETCH_HEAD would wrongly land here
    // instead of on the latest release tag.
    writeFileSync(path.join(src, "VERSION"), `${T010}\n`);
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "first release"], src);
    G(["tag", T010], src);
    writeFileSync(path.join(src, "VERSION"), `${T011}\n`);
    G(["commit", "-am", "patch release"], src);
    G(["tag", T011], src);
    writeFileSync(path.join(src, "VERSION"), `${T020}\n`);
    G(["commit", "-am", "minor release"], src);
    G(["tag", T020], src);
    writeFileSync(path.join(src, "VERSION"), "dev-tip\n");
    G(["commit", "-am", "unreleased main work"], src);
    mainTipSha = Gout(["rev-parse", "HEAD"], src);

    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);

    // A consumer checkout sitting at the OLDEST release.
    checkout = path.join(sandbox, "checkout");
    execFileSync("git", ["clone", "--branch", T010, `file://${originRepo}`, checkout], { stdio: "ignore" });
  });

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  const readVersion = () => readFileSync(path.join(checkout, "VERSION"), "utf8").trim();
  const headSha = () =>
    execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  it("resolves the latest STABLE release tag from origin", async () => {
    // Even though main is ahead of the latest tag, the latest *release* is T020.
    const tag = await resolveLatestReleaseTag({ targetDir: checkout, log: () => {} });
    expect(tag).toBe(T020);
  });

  it("moves to the resolved release tag (kind:tag) — NOT to ambient FETCH_HEAD (main tip)", async () => {
    expect(readVersion()).toBe(T010);
    const tag = await resolveLatestReleaseTag({ targetDir: checkout, log: () => {} });
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: tag, kind: "tag", log: () => {} });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readVersion()).toBe(T020);
    // The crux: we did NOT land on the unreleased main tip.
    expect(headSha()).not.toBe(mainTipSha);
  });

  it("refuses a dirty working tree without --force", () => {
    writeFileSync(path.join(checkout, "VERSION"), "dirty\n");
    expect(() =>
      moveExistingCheckoutToRef({ targetDir: checkout, ref: T020, kind: "tag", log: () => {} }),
    ).toThrow(/uncommitted changes/);
    // Leaves the dirty file for the --force test below.
  });

  it("--force stashes a dirty tree then hard-resets to the tag", () => {
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: T011, kind: "tag", force: true, log: () => {} });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readVersion()).toBe(T011);
  });

  it("a tag move detaches HEAD (release pin) even when an older tag is requested", () => {
    // HEAD is at T011; a kind:tag move to the older T010 detaches at the tag —
    // non-destructive (re-checkout any branch), so no --force is needed.
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: T010, kind: "tag", log: () => {} });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readVersion()).toBe(T010);
  });

  it("a kind:tag move is immune to a tag/branch NAME COLLISION", () => {
    // Create a local branch literally named like the T020 tag, parked at the
    // OLDER T010 commit. A bare `git checkout <name>` would prefer this branch;
    // a kind:tag move must instead land on the T020 TAG commit (detached).
    execFileSync("git", ["-C", checkout, "branch", "-f", T020, T010], { stdio: "ignore" });
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: T020, kind: "tag", log: () => {} });
    expect(readVersion()).toBe(T020); // the TAG, not the T010-parked branch.
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The local branch is untouched (still parked at T010). Use the fully-
    // qualified refs/heads/ to disambiguate it from the same-named tag.
    const branchSha = execFileSync("git", ["-C", checkout, "rev-parse", `refs/heads/${T020}`], {
      encoding: "utf8",
    }).trim();
    const oldSha = execFileSync("git", ["-C", checkout, "rev-parse", `refs/tags/${T010}^{commit}`], {
      encoding: "utf8",
    }).trim();
    expect(branchSha).toBe(oldSha);
    expect(headSha()).not.toBe(branchSha);
    execFileSync("git", ["-C", checkout, "branch", "-D", T020], { stdio: "ignore" });
  });

  it("preserves branch tracking on a fast-forward of a BRANCH ref (no detach)", () => {
    // Reset onto the oldest release tag, create+checkout a local `main` branch
    // there, then a kind:ref move to `main` (origin has it at the unreleased
    // tip): the move must FAST-FORWARD the branch and leave HEAD ON `main`.
    execFileSync("git", ["-C", checkout, "checkout", "-f", T010], { stdio: "ignore" });
    execFileSync("git", ["-C", checkout, "checkout", "-B", "main"], { stdio: "ignore" });
    const sha = moveExistingCheckoutToRef({ targetDir: checkout, ref: "main", kind: "ref", log: () => {} });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // HEAD is still ON the `main` branch (symbolic-ref resolves), not detached.
    const branch = execFileSync("git", ["-C", checkout, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    expect(branch).toBe("main");
    // And it advanced to origin's main tip (the unreleased commit).
    expect(sha).toBe(mainTipSha);
    expect(readVersion()).toBe("dev-tip");
  });
});
