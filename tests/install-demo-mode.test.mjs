// `cinatra install --mode demo` — the dev-superset demo mode (cinatra-cli#122).
//
// Coverage:
//   1. parseInstallArgs — accepts `demo`, lists all three modes on an invalid
//      value, and rejects `--mode demo --skip-dev-apps` (which would neuter the
//      demo apps). dev/prod + --skip-dev-apps stay allowed (AC8 unchanged).
//   1b. Positional mode (cinatra#1238 item 1) — accepts BOTH `install demo` and
//      `--mode demo`, rejects a conflict (`install demo --mode prod`), rejects an
//      unknown positional / extra trailing arg (never silently ignored), and
//      never reads a value-taking flag's value as a positional.
//   2. mode helpers — isDevLikeMode / installProfileForMode.
//   3. reconcileInstallProfile — pure add / clear / idempotent logic.
//   4. buildSetupChildEnv — CINATRA_INSTALL_PROFILE is set for demo and CLEARED
//      for dev/prod even when the ambient env leaks a stray demo profile.
//   5. ensureEnvLocal — persists CINATRA_INSTALL_PROFILE=demo (create + reconcile),
//      clears it on downgrade, is byte-unchanged for a plain dev reconcile (AC8),
//      and still hard-fails a runtime-mode mismatch.
//   6. assertTargetSupportsDemo — the target capability gate (package.json
//      `cinatra.installProfiles` must include "demo"), refusing loudly otherwise.
//   7. Real bin invocation — `cinatra install --mode bogus` lists demo, the
//      skip-dev-apps combination is refused, and demo is discoverable in help.
//   8. runInstall sequencing (Node >= 24 only, like the other E2E tests) —
//      a real from-zero `--mode demo` run stamps the profile + passes the gate;
//      a checkout lacking the marker is refused before any heavy work.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertTargetSupportsDemo,
  buildSetupChildEnv,
  ensureEnvLocal,
  extractInstallPositionals,
  installProfileForMode,
  isDevLikeMode,
  parseInstallArgs,
  reconcileInstallProfile,
  resolveInstallMode,
  runInstall,
} from "../src/install.mjs";

const BIN = fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url));
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

/** A fresh tmp dir carrying a minimal `.env.example` (what ensureEnvLocal needs). */
function mkEnvTarget() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cin-demo-env-"));
  writeFileSync(path.join(dir, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
  return dir;
}

/** A fresh tmp dir carrying a package.json with the given `cinatra` block. */
function mkPkgTarget(cinatraBlock) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cin-demo-pkg-"));
  const pkg = { name: "cinatra-host" };
  if (cinatraBlock !== undefined) pkg.cinatra = cinatraBlock;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

/** Run the real CLI bin; never throws — returns { status, stdout, stderr }. */
function runBin(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

// ---------------------------------------------------------------------------
// 1. parseInstallArgs — demo.
// ---------------------------------------------------------------------------
describe("parseInstallArgs — demo mode", () => {
  it("accepts --mode demo", () => {
    expect(parseInstallArgs(["--mode", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["--mode=demo"]).mode).toBe("demo");
  });

  it("lists all three valid modes on an invalid value", () => {
    let msg = "";
    try {
      parseInstallArgs(["--mode", "staging"]);
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toMatch(/Invalid --mode "staging"/);
    for (const m of ["dev", "prod", "demo"]) expect(msg).toContain(m);
  });

  it("rejects --mode demo --skip-dev-apps (would neuter the demo apps)", () => {
    expect(() => parseInstallArgs(["--mode", "demo", "--skip-dev-apps"])).toThrow(
      /--skip-dev-apps cannot be combined with demo mode/,
    );
  });

  it("rejects the POSITIONAL install demo --skip-dev-apps too", () => {
    expect(() => parseInstallArgs(["demo", "--skip-dev-apps"])).toThrow(
      /--skip-dev-apps cannot be combined with demo mode/,
    );
  });

  it("still allows --skip-dev-apps with dev and prod (AC8 unchanged)", () => {
    expect(parseInstallArgs(["--mode", "dev", "--skip-dev-apps"]).skipDevApps).toBe(true);
    expect(parseInstallArgs(["--mode", "prod", "--skip-dev-apps"]).skipDevApps).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. Positional mode + conflict + trailing-arg rejection (cinatra#1238 item 1).
// ---------------------------------------------------------------------------
describe("parseInstallArgs — positional mode", () => {
  it("accepts `install demo` / `install dev` / `install prod` positionally", () => {
    expect(parseInstallArgs(["demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["dev"]).mode).toBe("dev");
    expect(parseInstallArgs(["prod"]).mode).toBe("prod");
  });

  it("defaults to dev with no mode token at all", () => {
    expect(parseInstallArgs([]).mode).toBe("dev");
  });

  it("accepts the positional alongside agreeing flags/values in any order", () => {
    expect(parseInstallArgs(["--yes", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["demo", "--yes"]).mode).toBe("demo");
    expect(parseInstallArgs(["--dir", "/x", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["demo", "--ref", "main"]).mode).toBe("demo");
    expect(parseInstallArgs(["--", "demo"]).mode).toBe("demo");
  });

  it("accepts BOTH forms when they AGREE (install demo --mode demo)", () => {
    expect(parseInstallArgs(["demo", "--mode", "demo"]).mode).toBe("demo");
    expect(parseInstallArgs(["demo", "--mode=demo"]).mode).toBe("demo");
  });

  it("REJECTS a conflict between the positional and --mode", () => {
    expect(() => parseInstallArgs(["demo", "--mode", "prod"])).toThrow(/Conflicting mode/);
    expect(() => parseInstallArgs(["dev", "--mode", "demo"])).toThrow(/Conflicting mode/);
  });

  it("REJECTS an unknown positional (lists the valid modes; does not silently ignore)", () => {
    let msg = "";
    try {
      parseInstallArgs(["bogus"]);
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toMatch(/Unknown argument "bogus"/);
    for (const m of ["dev", "prod", "demo"]) expect(msg).toContain(m);
  });

  it("REJECTS an extra trailing positional after a valid mode", () => {
    expect(() => parseInstallArgs(["demo", "extra"])).toThrow(/Unexpected extra argument/);
    expect(() => parseInstallArgs(["dev", "foo", "bar"])).toThrow(/Unexpected extra argument/);
  });

  it("does NOT read a value-taking flag's value as a positional", () => {
    // --ref/--dir/--repo-url values look like bare words but must be skipped.
    expect(() => parseInstallArgs(["--ref", "demo"])).not.toThrow();
    expect(parseInstallArgs(["--ref", "demo"]).mode).toBe("dev"); // "demo" is the ref, not the mode
    expect(() => parseInstallArgs(["--instance", "prod"])).not.toThrow();
    expect(parseInstallArgs(["--sandbox-image", "x"]).mode).toBe("dev");
  });
});

describe("extractInstallPositionals / resolveInstallMode (unit)", () => {
  it("extractInstallPositionals skips value-taking flags (space + inline)", () => {
    expect(extractInstallPositionals(["--dir", "/x", "demo"])).toEqual(["demo"]);
    expect(extractInstallPositionals(["--dir=/x", "demo"])).toEqual(["demo"]);
    expect(extractInstallPositionals(["--yes", "demo", "--force"])).toEqual(["demo"]);
    expect(extractInstallPositionals(["--ref", "demo"])).toEqual([]); // value, not positional
    expect(extractInstallPositionals(["--", "--not-a-flag", "x"])).toEqual(["--not-a-flag", "x"]);
  });

  it("resolveInstallMode reconciles positional + flag and defaults to dev", () => {
    expect(resolveInstallMode([], null)).toBe("dev");
    expect(resolveInstallMode(["demo"], null)).toBe("demo");
    expect(resolveInstallMode([], "prod")).toBe("prod");
    expect(resolveInstallMode(["demo"], "demo")).toBe("demo");
    expect(() => resolveInstallMode(["demo"], "prod")).toThrow(/Conflicting mode/);
    expect(() => resolveInstallMode(["nope"], null)).toThrow(/Unknown argument/);
    expect(() => resolveInstallMode(["demo", "x"], null)).toThrow(/Unexpected extra/);
  });

  it("resolveInstallMode is self-validating on --mode (does not assume a pre-validated modeOpt)", () => {
    // Defense-in-depth (codex round): a direct caller cannot slip an invalid
    // --mode past the exported helper.
    expect(() => resolveInstallMode([], "staging")).toThrow(/Invalid --mode "staging"/);
    expect(() => resolveInstallMode(["demo"], "bogus")).toThrow(/Invalid --mode "bogus"/);
  });
});

// ---------------------------------------------------------------------------
// 2. mode helpers.
// ---------------------------------------------------------------------------
describe("mode helpers", () => {
  it("isDevLikeMode: dev + demo are dev-like, prod is not", () => {
    expect(isDevLikeMode("dev")).toBe(true);
    expect(isDevLikeMode("demo")).toBe(true);
    expect(isDevLikeMode("prod")).toBe(false);
  });

  it("installProfileForMode: only demo carries a profile", () => {
    expect(installProfileForMode("demo")).toBe("demo");
    expect(installProfileForMode("dev")).toBe(null);
    expect(installProfileForMode("prod")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 3. reconcileInstallProfile — pure logic.
// ---------------------------------------------------------------------------
describe("reconcileInstallProfile", () => {
  it("adds the profile line when missing", () => {
    const { body, changed } = reconcileInstallProfile("A=1\n", "demo");
    expect(changed).toBe(true);
    expect(body).toContain("CINATRA_INSTALL_PROFILE=demo");
  });

  it("is a no-op when the profile is already present (idempotent)", () => {
    const { changed } = reconcileInstallProfile("A=1\nCINATRA_INSTALL_PROFILE=demo\n", "demo");
    expect(changed).toBe(false);
  });

  it("clears the profile line when profile is null (downgrade)", () => {
    const { body, changed } = reconcileInstallProfile("A=1\nCINATRA_INSTALL_PROFILE=demo\nB=2\n", null);
    expect(changed).toBe(true);
    expect(body).not.toContain("CINATRA_INSTALL_PROFILE");
    expect(body).toContain("A=1");
    expect(body).toContain("B=2");
  });

  it("is a no-op when clearing an already-absent profile (dev/prod byte-parity)", () => {
    const { changed } = reconcileInstallProfile("A=1\nB=2\n", null);
    expect(changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. buildSetupChildEnv — profile pin + ambient-leak clear.
// ---------------------------------------------------------------------------
describe("buildSetupChildEnv", () => {
  it("sets CINATRA_INSTALL_PROFILE=demo + development runtime for demo", () => {
    const env = buildSetupChildEnv({ mode: "demo", targetDir: "/t", baseEnv: {} });
    expect(env.CINATRA_INSTALL_PROFILE).toBe("demo");
    expect(env.CINATRA_RUNTIME_MODE).toBe("development");
    expect(env.CINATRA_REPO_ROOT).toBe("/t");
  });

  it("CLEARS an ambient CINATRA_INSTALL_PROFILE for a plain dev child", () => {
    const env = buildSetupChildEnv({ mode: "dev", targetDir: "/t", baseEnv: { CINATRA_INSTALL_PROFILE: "demo" } });
    expect("CINATRA_INSTALL_PROFILE" in env).toBe(false);
    expect(env.CINATRA_RUNTIME_MODE).toBe("development");
  });

  it("CLEARS an ambient CINATRA_INSTALL_PROFILE for a prod child + pins production", () => {
    const env = buildSetupChildEnv({ mode: "prod", targetDir: "/t", baseEnv: { CINATRA_INSTALL_PROFILE: "demo" } });
    expect("CINATRA_INSTALL_PROFILE" in env).toBe(false);
    expect(env.CINATRA_RUNTIME_MODE).toBe("production");
  });
});

// ---------------------------------------------------------------------------
// 5. ensureEnvLocal — profile persistence.
// ---------------------------------------------------------------------------
describe("ensureEnvLocal — demo profile persistence", () => {
  const dirs = [];
  const target = () => {
    const d = mkEnvTarget();
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const readLocal = (d) => readFileSync(path.join(d, ".env.local"), "utf8");

  it("stamps CINATRA_INSTALL_PROFILE=demo + development runtime on create", () => {
    const d = target();
    const r = ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} });
    expect(r.created).toBe(true);
    const body = readLocal(d);
    expect(body).toMatch(/^CINATRA_INSTALL_PROFILE=demo$/m);
    expect(body).toMatch(/^CINATRA_RUNTIME_MODE=development$/m);
  });

  it("writes NO profile line for a plain dev create (fixtures-off default)", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "dev", log: () => {} });
    expect(readLocal(d)).not.toContain("CINATRA_INSTALL_PROFILE");
  });

  it("writes NO profile line for prod + pins production runtime", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "prod", log: () => {} });
    const body = readLocal(d);
    expect(body).not.toContain("CINATRA_INSTALL_PROFILE");
    expect(body).toMatch(/^CINATRA_RUNTIME_MODE=production$/m);
  });

  it("adds the profile when reconciling an existing dev env up to demo", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "dev", log: () => {} });
    expect(readLocal(d)).not.toContain("CINATRA_INSTALL_PROFILE");
    const r = ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} });
    expect(r.created).toBe(false);
    expect(readLocal(d)).toMatch(/^CINATRA_INSTALL_PROFILE=demo$/m);
  });

  it("clears the profile when downgrading an existing demo env to dev", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} });
    const r = ensureEnvLocal({ targetDir: d, mode: "dev", log: () => {} });
    expect(r.created).toBe(false);
    expect(readLocal(d)).not.toContain("CINATRA_INSTALL_PROFILE");
  });

  it("is byte-unchanged for a plain dev reconcile (AC8)", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "dev", log: () => {} });
    const before = readLocal(d);
    ensureEnvLocal({ targetDir: d, mode: "dev", log: () => {} });
    expect(readLocal(d)).toBe(before);
  });

  it("is byte-unchanged re-running demo on an existing demo env (idempotent)", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} });
    const before = readLocal(d);
    ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} });
    expect(readLocal(d)).toBe(before);
  });

  it("still hard-fails a runtime-mode mismatch (prod env, demo requested)", () => {
    const d = target();
    ensureEnvLocal({ targetDir: d, mode: "prod", log: () => {} });
    expect(() => ensureEnvLocal({ targetDir: d, mode: "demo", log: () => {} })).toThrow(
      /CINATRA_RUNTIME_MODE=production but --mode demo was requested/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. assertTargetSupportsDemo — capability gate.
// ---------------------------------------------------------------------------
describe("assertTargetSupportsDemo", () => {
  const dirs = [];
  const pkg = (block) => {
    const d = mkPkgTarget(block);
    dirs.push(d);
    return d;
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("passes when cinatra.installProfiles includes demo", () => {
    expect(() => assertTargetSupportsDemo(pkg({ installProfiles: ["dev", "prod", "demo"] }))).not.toThrow();
  });

  it("refuses loudly when installProfiles lacks demo", () => {
    expect(() => assertTargetSupportsDemo(pkg({ installProfiles: ["dev", "prod"] }))).toThrow(
      /does not support `--mode demo`/,
    );
  });

  it("refuses when there is no installProfiles declaration", () => {
    expect(() => assertTargetSupportsDemo(pkg({ devExtensions: {} }))).toThrow(/does not support `--mode demo`/);
  });

  it("refuses when there is no cinatra block at all", () => {
    expect(() => assertTargetSupportsDemo(pkg(undefined))).toThrow(/does not support `--mode demo`/);
  });

  it("refuses (clearly) when package.json is missing", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "cin-demo-nopkg-"));
    dirs.push(d);
    expect(() => assertTargetSupportsDemo(d)).toThrow(/is missing from the checkout/);
  });

  it("refuses (clearly) when package.json is not valid JSON", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "cin-demo-badjson-"));
    dirs.push(d);
    writeFileSync(path.join(d, "package.json"), "{ not json");
    expect(() => assertTargetSupportsDemo(d)).toThrow(/is not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// 7. Real bin invocation (does not require Node 24 — parse/help precede preflight).
// ---------------------------------------------------------------------------
describe("cinatra bin — demo surface", () => {
  it("`install --mode bogus` fails and lists demo among the valid modes", () => {
    const r = runBin(["install", "--mode", "bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Invalid --mode "bogus"/);
    expect(r.stderr).toContain("demo");
  });

  it("`install --mode demo --skip-dev-apps` is refused before any work", () => {
    const r = runBin(["install", "--mode", "demo", "--skip-dev-apps"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--skip-dev-apps cannot be combined with demo mode/);
  });

  it("`install demo` (positional) is accepted (reaches the target-support gate, not a usage error)", () => {
    // No checkout ⇒ it must fail LATER (preflight/gate), never with an
    // arg-parse "Unknown argument"/"Invalid --mode" error — proving the
    // positional mode is recognised, not dropped or rejected.
    const r = runBin(["install", "demo", "--dir", "/nonexistent-cin-demo-xyz", "--no-infra", "--yes"]);
    expect(r.status).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toMatch(/Unknown argument/);
    expect(out).not.toMatch(/Invalid --mode/);
  });

  it("`install demo --mode prod` (conflict) is refused with a clear message", () => {
    const r = runBin(["install", "demo", "--mode", "prod"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Conflicting mode/);
  });

  it("`install bogus` (unknown positional) is refused, listing the valid modes", () => {
    const r = runBin(["install", "bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Unknown argument "bogus"/);
    for (const m of ["dev", "prod", "demo"]) expect(r.stderr).toContain(m);
  });

  it("demo is discoverable in `--help`", () => {
    const r = runBin(["--help"]);
    expect(`${r.stdout}${r.stderr}`).toContain("demo");
  });
});

// ---------------------------------------------------------------------------
// 8. runInstall sequencing — real from-zero `--mode demo` (Node >= 24, like the
//    other E2E tests: the install preflight hard-requires Node 24.x).
// ---------------------------------------------------------------------------
describe.skipIf(NODE_MAJOR < 24)("runInstall — --mode demo sequencing", () => {
  let sandbox;

  const G = (args, cwd) =>
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      stdio: "ignore",
    });

  /** Build a minimal valid "cinatra" checkout → bare origin. `cinatraBlock`
   *  is spread into the root package.json's `cinatra` manifest. */
  function makeOrigin(name, cinatraBlock) {
    const src = path.join(sandbox, `src-${name}`);
    mkdirSync(path.join(src, "packages", "cli"), { recursive: true });
    mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
    writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(path.join(src, "packages", "cli", "package.json"), JSON.stringify({ name: "@cinatra-ai/cli", version: "0.0.0" }));
    writeFileSync(path.join(src, "packages", "migrations", "package.json"), JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }));
    writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {}, ...cinatraBlock } }));
    writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
    writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "init"], src);
    const origin = path.join(sandbox, `origin-${name}.git`);
    G(["clone", "--bare", src, origin], sandbox);
    return origin;
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-demo-seq-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(sandbox, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(sandbox, "alloc.lock");
  });

  afterAll(() => {
    delete process.env.CINATRA_INSTANCE_REGISTRY;
    delete process.env.CINATRA_ALLOC_LOCK;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("a marker-bearing checkout installs as demo and stamps the profile", async () => {
    const origin = makeOrigin("ok", { installProfiles: ["dev", "prod", "demo"] });
    const out = path.join(sandbox, "out-ok");
    const logs = [];
    const result = await runInstall(
      ["--dir", out, "--repo-url", `file://${origin}`, "--ref", "main", "--mode", "demo", "--yes", "--no-infra", "--no-install"],
      { log: (m) => logs.push(String(m)) },
    );
    expect(result.mode).toBe("demo");
    expect(existsSync(path.join(out, ".env.local"))).toBe(true);
    expect(readFileSync(path.join(out, ".env.local"), "utf8")).toMatch(/^CINATRA_INSTALL_PROFILE=demo$/m);
  });

  it("a checkout WITHOUT the demo marker is refused (no hollow demo)", async () => {
    const origin = makeOrigin("nomarker", {}); // devExtensions only, no installProfiles
    const out = path.join(sandbox, "out-nomarker");
    await expect(
      runInstall(
        ["--dir", out, "--repo-url", `file://${origin}`, "--ref", "main", "--mode", "demo", "--yes", "--no-infra", "--no-install"],
        { log: () => {} },
      ),
    ).rejects.toThrow(/does not support `--mode demo`/);
  });

  it("the POSITIONAL `install demo` drives the same demo install (profile stamped)", async () => {
    const origin = makeOrigin("pos", { installProfiles: ["dev", "prod", "demo"] });
    const out = path.join(sandbox, "out-pos");
    const result = await runInstall(
      ["demo", "--dir", out, "--repo-url", `file://${origin}`, "--ref", "main", "--yes", "--no-infra", "--no-install"],
      { log: () => {} },
    );
    expect(result.mode).toBe("demo");
    expect(readFileSync(path.join(out, ".env.local"), "utf8")).toMatch(/^CINATRA_INSTALL_PROFILE=demo$/m);
  });

  it("superset guarantee (CLI-side): a plain `install dev` after a demo install clears the demo profile — no demo leak", async () => {
    const origin = makeOrigin("superset", { installProfiles: ["dev", "prod", "demo"] });
    const out = path.join(sandbox, "out-superset");
    const envLocal = path.join(out, ".env.local");

    // 1) demo install → .env.local pins the demo profile.
    await runInstall(
      ["demo", "--dir", out, "--repo-url", `file://${origin}`, "--ref", "main", "--yes", "--no-infra", "--no-install"],
      { log: () => {} },
    );
    expect(readFileSync(envLocal, "utf8")).toMatch(/^CINATRA_INSTALL_PROFILE=demo$/m);

    // 2) re-run as plain dev on the SAME checkout → the demo profile is cleared
    //    (reconcile, not recreate), so the next `pnpm dev` boots a plain dev
    //    instance with NO demo overlay leaking through. The target-side setup.sh
    //    then re-stamps CINATRA_INSTALL_PROFILE=dev; the reader treats dev≡absent.
    const result = await runInstall(
      ["dev", "--dir", out, "--repo-url", `file://${origin}`, "--ref", "main", "--yes", "--no-infra", "--no-install"],
      { log: () => {} },
    );
    expect(result.mode).toBe("dev");
    expect(readFileSync(envLocal, "utf8")).not.toContain("CINATRA_INSTALL_PROFILE=demo");
  });
});
