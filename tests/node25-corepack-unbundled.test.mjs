// cinatra-cli#207 — Node 25 unbundled Corepack.
//
// Node 25 removed Corepack from the distribution, and with it the `pnpm` shim
// Corepack provided. On that line a host has NEITHER `corepack` NOR `pnpm` by
// default, which is the one case the #205 fallback still degraded to attempting
// the (nonexistent) `corepack pnpm install` — so every internal workspace-link
// step failed and reset/setup left the workspace unlinked.
//
// The selection gains a third tier: the checkout's OWN `packageManager` pin run
// through `npm exec` (npm ships with every Node line). The first two tiers are
// unchanged — a host that HAS Corepack behaves exactly as before.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  resolvePnpmInstallInvocation,
  readPinnedPnpmSpec,
  installAfterExtensionSync,
  reinstallDependencies,
} from "../src/index.mjs";
import { runPreflight, assertWorkspaceInstallPossible, runInstall } from "../src/install.mjs";

const present =
  (...cmds) =>
  (cmd) =>
    cmds.includes(cmd);

// The real cinatra pin, integrity suffix and all.
const REAL_PIN =
  "pnpm@11.1.2+sha512.415a1cc25974731e75455c1468371be74c5aa5fb7621b50d4056d222451609f11412f23fd602e6169f1e060466641f798597e1be961a10688836a67b16569499";

function makeCheckout(packageManager) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cin-207-"));
  const pkg = { name: "cinatra", private: true };
  if (packageManager !== undefined) pkg.packageManager = packageManager;
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. Reading the pin.
// ---------------------------------------------------------------------------
describe("readPinnedPnpmSpec", () => {
  const made = [];
  const checkout = (pm) => {
    const dir = makeCheckout(pm);
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    while (made.length) rmSync(made.pop(), { recursive: true, force: true });
  });

  it("strips Corepack's `+<integrity>` suffix, which npm cannot resolve", () => {
    expect(readPinnedPnpmSpec(checkout(REAL_PIN))).toBe("pnpm@11.1.2");
  });

  it("accepts a bare pin and a prerelease pin", () => {
    expect(readPinnedPnpmSpec(checkout("pnpm@10.0.0"))).toBe("pnpm@10.0.0");
    expect(readPinnedPnpmSpec(checkout("pnpm@11.2.0-beta.1"))).toBe("pnpm@11.2.0-beta.1");
  });

  it("returns null for anything that is not an exact pnpm version pin", () => {
    expect(readPinnedPnpmSpec(checkout("yarn@4.1.0"))).toBeNull(); // different PM
    expect(readPinnedPnpmSpec(checkout("npm@10.9.0"))).toBeNull();
    expect(readPinnedPnpmSpec(checkout("pnpm@^11.1.2"))).toBeNull(); // a range, not a pin
    expect(readPinnedPnpmSpec(checkout("pnpm@latest"))).toBeNull();
    expect(readPinnedPnpmSpec(checkout(undefined))).toBeNull(); // no packageManager field
  });

  it("rejects malformed versions rather than handing them to npm", () => {
    expect(readPinnedPnpmSpec(checkout("pnpm@1.2.3-."))).toBeNull(); // empty prerelease id
    expect(readPinnedPnpmSpec(checkout("pnpm@01.2.3"))).toBeNull(); // leading zero
    expect(readPinnedPnpmSpec(checkout("pnpm@11.1"))).toBeNull(); // not a three-part version
    expect(readPinnedPnpmSpec(checkout("pnpm@11.1.2 install; rm -rf /"))).toBeNull();
  });

  it("returns null (never throws) when the manifest is missing or unreadable", () => {
    expect(readPinnedPnpmSpec("/definitely/not/a/checkout")).toBeNull();
    expect(readPinnedPnpmSpec(null)).toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), "cin-207-bad-"));
    made.push(dir);
    writeFileSync(path.join(dir, "package.json"), "{ not json");
    expect(readPinnedPnpmSpec(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The three-tier selection.
// ---------------------------------------------------------------------------
describe("resolvePnpmInstallInvocation on a Corepack-less Node line", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("runs the checkout's pinned pnpm through `npm exec` when NEITHER corepack nor pnpm exists", () => {
    dir = makeCheckout(REAL_PIN);
    const invocation = resolvePnpmInstallInvocation({ exists: present("npm"), repoRoot: dir });
    expect(invocation.command).toBe("npm");
    expect(invocation.args).toEqual(["exec", "-y", "--", "pnpm@11.1.2", "install"]);
    expect(invocation.label).toBe("npm exec -y -- pnpm@11.1.2 install");
    expect(invocation.pinned).toBe("pnpm@11.1.2");
  });

  it("keeps Corepack first even when the pin is readable (Node 24 behavior is unchanged)", () => {
    dir = makeCheckout(REAL_PIN);
    expect(resolvePnpmInstallInvocation({ exists: present("corepack", "npm"), repoRoot: dir })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
  });

  it("keeps the #205 bare-pnpm tier ahead of `npm exec` (an installed pnpm is not bypassed)", () => {
    dir = makeCheckout(REAL_PIN);
    expect(resolvePnpmInstallInvocation({ exists: present("pnpm", "npm"), repoRoot: dir })).toEqual({
      command: "pnpm",
      args: ["install"],
      label: "pnpm install",
    });
  });

  it("still degrades to the canonical corepack command when the pin is unusable", () => {
    dir = makeCheckout("yarn@4.1.0"); // not a pnpm pin → no spec to hand npm
    const invocation = resolvePnpmInstallInvocation({ exists: present("npm"), repoRoot: dir });
    expect(invocation.command).toBe("corepack");
    expect(invocation.label).toBe("corepack pnpm install");
  });

  it("still degrades to the canonical corepack command when the caller has no checkout", () => {
    const invocation = resolvePnpmInstallInvocation({ exists: present("npm") });
    expect(invocation.command).toBe("corepack");
    expect(invocation.label).toBe("corepack pnpm install");
  });

  it("probes npm only after corepack and pnpm both miss", () => {
    dir = makeCheckout(REAL_PIN);
    const probes = [];
    resolvePnpmInstallInvocation({
      exists: (cmd, args) => {
        probes.push([cmd, ...(args ?? [])]);
        return cmd === "npm";
      },
      repoRoot: dir,
    });
    expect(probes).toEqual([
      ["corepack", "--version"],
      ["pnpm", "--version"],
      ["npm", "--version"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. The seam the issue reports: the post-extension-sync workspace re-link.
// ---------------------------------------------------------------------------
describe("installAfterExtensionSync on a Node 25 host", () => {
  const syncResult = { results: [{ action: "cloned" }] };
  let dir;

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function spawnRecorder(status = 0) {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status };
    };
    return { calls, spawn };
  }

  it("re-links via the pinned pnpm instead of reporting FAILED (the reported bug)", () => {
    dir = makeCheckout(REAL_PIN);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { calls, spawn } = spawnRecorder(0);

    const res = installAfterExtensionSync(dir, syncResult, { spawn, exists: present("npm") });

    expect(res).toEqual({ ok: true });
    expect(errors).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("npm");
    expect(calls[0].args).toEqual(["exec", "-y", "--", "pnpm@11.1.2", "install"]);
    expect(calls[0].options.cwd).toBe(dir);
    expect(logs.mock.calls.flat().join("\n")).toContain("npm exec -y -- pnpm@11.1.2 install");
  });

  it("names the pinned invocation — not an unrunnable `corepack` — in the loud failure", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { spawn } = spawnRecorder(1);

    const res = installAfterExtensionSync(dir, syncResult, { spawn, exists: present("npm") });

    expect(res).toEqual({ ok: false });
    expect(process.exitCode).toBe(1);
    const blob = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(blob).toContain("Re-run `npm exec -y -- pnpm@11.1.2 install`");
    expect(blob).not.toContain("corepack");
  });

  it("aborts the prod path with the same tiering under failHard", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, spawn } = spawnRecorder(1);
    expect(() =>
      installAfterExtensionSync(dir, syncResult, { spawn, exists: present("npm"), failHard: true }),
    ).toThrow(/not linked into the workspace/);
    expect(calls[0].command).toBe("npm");
  });

  it("is unchanged on a Corepack host — same command, same cwd", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, spawn } = spawnRecorder(0);
    installAfterExtensionSync(dir, syncResult, { spawn, exists: present("corepack", "npm") });
    expect(calls[0].command).toBe("corepack");
    expect(calls[0].args).toEqual(["pnpm", "install"]);
  });

  it("still skips entirely on a warm no-op sync (no install is provoked by the new tier)", () => {
    dir = makeCheckout(REAL_PIN);
    const { calls, spawn } = spawnRecorder(0);
    const res = installAfterExtensionSync(dir, { results: [{ action: "verified-existing" }] }, {
      spawn,
      exists: present("npm"),
    });
    expect(res).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. `cinatra instance reset --full` — the DESTRUCTIVE site.
//    It removes node_modules/.pnpm-store BEFORE installing, so an install
//    command that cannot exist leaves the checkout with no dependencies at all.
// ---------------------------------------------------------------------------
describe("reinstallDependencies (instance reset --full) — fail-closed", () => {
  let dir;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("REFUSES before deleting anything when nothing on the host could reinstall", () => {
    dir = makeCheckout("yarn@4.1.0"); // Corepack-less host + no usable pnpm pin
    const removed = [];
    const spawned = [];
    expect(() =>
      reinstallDependencies(dir, {
        exists: present("npm"),
        rm: (p) => removed.push(p),
        spawn: (...a) => {
          spawned.push(a);
          return { status: 0 };
        },
      }),
    ).toThrow(/Refusing to run a full reset/);
    // The whole point: the dependency tree is still there.
    expect(removed).toEqual([]);
    expect(spawned).toEqual([]);
  });
});

describe("reinstallDependencies (instance reset --full)", () => {
  let dir;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function harness(status = 0) {
    const removed = [];
    const spawned = [];
    return {
      removed,
      spawned,
      deps: {
        rm: (p) => removed.push(p),
        spawn: (command, args, options) => {
          spawned.push({ command, args, options, removedSoFar: removed.length });
          return { status };
        },
      },
    };
  }

  it("installs with the checkout's pinned pnpm when neither corepack nor pnpm exists", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { removed, spawned, deps } = harness(0);
    reinstallDependencies(dir, { ...deps, exists: present("npm") });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("npm");
    expect(spawned[0].args).toEqual(["exec", "-y", "--", "pnpm@11.1.2", "install"]);
    expect(spawned[0].options.cwd).toBe(dir);
    // The tree is wiped FIRST — so the install that follows it must be runnable.
    expect(removed).toEqual([path.join(dir, "node_modules"), path.join(dir, ".pnpm-store")]);
    expect(spawned[0].removedSoFar).toBe(2);
  });

  it("still invokes BARE pnpm whenever pnpm is on PATH (current behavior preserved)", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { spawned, deps } = harness(0);
    reinstallDependencies(dir, { ...deps, exists: present("pnpm", "corepack", "npm") });
    expect(spawned[0].command).toBe("pnpm");
    expect(spawned[0].args).toEqual(["install"]);
  });

  it("falls back to corepack when pnpm is gone but corepack is not", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { spawned, deps } = harness(0);
    reinstallDependencies(dir, { ...deps, exists: present("corepack", "npm") });
    expect(spawned[0].command).toBe("corepack");
  });

  it("names the invocation in the failure", () => {
    dir = makeCheckout(REAL_PIN);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { deps } = harness(1);
    expect(() => reinstallDependencies(dir, { ...deps, exists: present("npm") })).toThrow(
      "Failed to reinstall dependencies (npm exec -y -- pnpm@11.1.2 install).",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The post-checkout fail-fast gate.
// ---------------------------------------------------------------------------
describe("assertWorkspaceInstallPossible", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("passes on a Node 25 host whose checkout carries a pnpm pin", () => {
    dir = makeCheckout(REAL_PIN);
    expect(assertWorkspaceInstallPossible({ targetDir: dir, exists: present("npm") }).command).toBe("npm");
  });

  it("passes on any host that has corepack or pnpm", () => {
    dir = makeCheckout(undefined); // no pin at all
    expect(assertWorkspaceInstallPossible({ targetDir: dir, exists: present("corepack") }).command).toBe(
      "corepack",
    );
    expect(assertWorkspaceInstallPossible({ targetDir: dir, exists: present("pnpm") }).command).toBe("pnpm");
  });

  it("fails FAST — before env/infra — when no tier can serve this checkout", () => {
    dir = makeCheckout("yarn@4.1.0"); // Corepack-less host + unusable pin
    expect(() => assertWorkspaceInstallPossible({ targetDir: dir, exists: present("npm") })).toThrow(
      /No usable package manager/,
    );
    // …and it says what to actually do about it.
    expect(() => assertWorkspaceInstallPossible({ targetDir: dir, exists: present("npm") })).toThrow(
      /npm install -g pnpm/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5b. WHERE the gate sits in `runInstall` — the sequencing, not just the check.
//     It must fire after the checkout materializes (that is what carries the
//     pin) but before ANY mutation: the local-ignore write, the terminal co-use
//     branch, and every conflict-resolution/infra path all come after it.
// ---------------------------------------------------------------------------
describe("runInstall gates the package manager before it mutates anything", () => {
  let sandbox;
  let originRepo;

  const buildOrigin = (packageManager) => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-207-inst-"));
    const src = path.join(sandbox, "src");
    const write = (rel, body) => {
      const p = path.join(src, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
    };
    const rootPkg = { name: "cinatra-host", private: true, cinatra: { devExtensions: {} } };
    if (packageManager) rootPkg.packageManager = packageManager;
    write("package.json", JSON.stringify(rootPkg, null, 2));
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    write(
      "packages/migrations/package.json",
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0", private: true }),
    );
    write(".env.example", "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
    write(".gitignore", ".env.local\nextensions/\n");
    const G = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
        stdio: "ignore",
      });
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "init"], src);
    originRepo = path.join(sandbox, "origin.git");
    G(["clone", "--bare", src, originRepo], sandbox);
  };

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
    originRepo = undefined;
  });

  // A stock Node 25 host: git/npm/docker/curl, but NO corepack and NO pnpm.
  const node25Host = (cmd) => ["git", "npm", "docker", "curl"].includes(cmd);

  const install = (targetDir, extra = []) =>
    runInstall(
      [
        "--dir", targetDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--mode", "dev",
        "--yes", "--no-infra", "--no-setup",
        ...extra,
      ],
      { log: () => {}, deps: { commandExists: node25Host } },
    );

  it("rejects — with nothing mutated — when the checkout has no pnpm pin to fall back on", async () => {
    buildOrigin(undefined); // no `packageManager` at all
    const targetDir = path.join(sandbox, "out");

    await expect(install(targetDir)).rejects.toThrow(/No usable package manager/);

    // The checkout is cloned (that is what the gate needed), but NOTHING past it
    // ran: no env, and the local-ignore write that immediately follows the gate
    // never happened.
    expect(existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(path.join(targetDir, ".env.local"))).toBe(false);
    const excludePath = path.join(targetDir, ".git", "info", "exclude");
    const exclude = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    expect(exclude).not.toMatch(/\.cinatra\//);
  });

  // `--no-install` never reaches an install, so refusing would be wrong there —
  // with or without a usable pin. (The pin-IS-usable case is proven end to end by
  // the standalone gate test above; driving it through runInstall would perform a
  // real dependency install.)
  for (const [label, pin] of [
    ["no pin at all", undefined],
    ["a usable pnpm pin", REAL_PIN],
  ]) {
    it(`does not gate a run that installs nothing — ${label}`, async () => {
      buildOrigin(pin);
      const targetDir = path.join(sandbox, "out");
      const result = await install(targetDir, ["--no-install"]);
      expect(result.targetDir).toBe(targetDir);
      // It got all the way past the gate and the marker write into the env step.
      expect(existsSync(path.join(targetDir, ".env.local"))).toBe(true);
      const exclude = readFileSync(path.join(targetDir, ".git", "info", "exclude"), "utf8");
      expect(exclude).toMatch(/\.cinatra\//);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. `cinatra install` preflight — a Node 25 host is installable, not blocked.
// ---------------------------------------------------------------------------
describe("runPreflight package-manager tier", () => {
  const base = { mode: "dev", targetDir: null };

  it("does not BLOCK a Node 25 host that has npm — it warns and proceeds", () => {
    const res = runPreflight({
      ...base,
      deps: {
        nodeVersion: "25.9.0",
        commandExists: (cmd) => ["git", "npm", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.failures).toEqual([]);
    const warn = res.warnings.join("\n");
    expect(warn).toMatch(/Node 25 no longer bundles Corepack/);
    expect(warn).toMatch(/npm exec/);
    // The old remediation was impossible on this host — it must be gone.
    expect(warn).not.toMatch(/corepack enable/);
  });

  it("still blocks when npm is missing too (nothing can install dependencies)", () => {
    const res = runPreflight({
      ...base,
      deps: {
        nodeVersion: "25.9.0",
        commandExists: (cmd) => ["git", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.failures.join("\n")).toMatch(/Corepack nor pnpm/);
  });

  it("is unchanged on a Corepack host (no new warning)", () => {
    const res = runPreflight({
      ...base,
      deps: {
        nodeVersion: "24.19.0",
        commandExists: (cmd) => ["git", "corepack", "npm", "docker", "curl"].includes(cmd),
        composeAvailable: () => true,
      },
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.join("\n")).not.toMatch(/Corepack/);
  });
});
