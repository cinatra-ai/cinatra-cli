// `cinatra update` / `cinatra instance refresh` and the setup extension
// re-link must degrade to bare `pnpm` when Corepack is absent — the same
// corepack→pnpm selection `cinatra install` already applies (`usePnpmDirect`
// in src/install.mjs). These tests pin the shared selection helper and drive
// the real extension re-link seam with injected spawn/exists probes.

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolvePnpmInstallInvocation, installAfterExtensionSync } from "../src/index.mjs";

const present =
  (...cmds) =>
  (cmd) =>
    cmds.includes(cmd);

// ---------------------------------------------------------------------------
// 1. Selection helper — mirrors src/install.mjs `usePnpmDirect`.
// ---------------------------------------------------------------------------
describe("resolvePnpmInstallInvocation", () => {
  it("uses corepack when corepack is present (pnpm pin honored)", () => {
    expect(resolvePnpmInstallInvocation({ exists: present("corepack", "pnpm") })).toEqual({
      command: "corepack",
      args: ["pnpm", "install"],
      label: "corepack pnpm install",
    });
    // Corepack-only (no bare pnpm on PATH) is the canonical Node 24 shape.
    expect(resolvePnpmInstallInvocation({ exists: present("corepack") }).command).toBe("corepack");
  });

  it("falls back to bare pnpm when corepack is absent but pnpm is present", () => {
    expect(resolvePnpmInstallInvocation({ exists: present("pnpm") })).toEqual({
      command: "pnpm",
      args: ["install"],
      label: "pnpm install",
    });
  });

  it("attempts the canonical corepack command when NEITHER tool is available, so the loud failure names the command to enable", () => {
    const invocation = resolvePnpmInstallInvocation({ exists: () => false });
    expect(invocation.command).toBe("corepack");
    expect(invocation.args).toEqual(["pnpm", "install"]);
    // The refresh dependency step builds its failure text from the label —
    // pin that the message names exactly what was attempted.
    expect(`Failed to install dependencies (${invocation.label}).`).toBe(
      "Failed to install dependencies (corepack pnpm install).",
    );
  });

  it("probes availability with --version, mirroring src/install.mjs", () => {
    const probes = [];
    resolvePnpmInstallInvocation({
      exists: (cmd, args) => {
        probes.push([cmd, ...(args ?? [])]);
        return false;
      },
    });
    expect(probes).toEqual([
      ["corepack", "--version"],
      ["pnpm", "--version"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. The real re-link seam (runs during setup/refresh after an extension sync).
// ---------------------------------------------------------------------------
describe("installAfterExtensionSync corepack→pnpm fallback", () => {
  const syncResult = { results: [{ action: "cloned" }] };

  function spawnRecorder(status = 0) {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      return { status };
    };
    return { calls, spawn };
  }

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("re-links via corepack when corepack is present", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, spawn } = spawnRecorder();
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn,
      exists: present("corepack", "pnpm"),
    });
    // cinatra#2637 — the verdict carries the invocation LABEL so the caller can
    // name the exact re-link command in its own recovery text.
    expect(res).toEqual({ ok: true, label: "corepack pnpm install" });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("corepack");
    expect(calls[0].args).toEqual(["pnpm", "install"]);
    expect(calls[0].options.cwd).toBe("/repo");
  });

  it("re-links via bare pnpm when corepack is absent but pnpm is present (update on a Corepack-less machine)", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { calls, spawn } = spawnRecorder();
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn,
      exists: present("pnpm"),
    });
    expect(res).toEqual({ ok: true, label: "pnpm install" });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("pnpm");
    expect(calls[0].args).toEqual(["install"]);
  });

  it("names the binary actually attempted in the loud non-fatal failure", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { spawn } = spawnRecorder(1);
    const res = installAfterExtensionSync("/repo", syncResult, {
      spawn,
      exists: present("pnpm"),
    });
    expect(res).toEqual({ ok: false, label: "pnpm install" });
    expect(process.exitCode).toBe(1);
    const blob = errors.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(blob).toContain("Re-run `pnpm install`");
    expect(blob).not.toContain("corepack");
  });
});
