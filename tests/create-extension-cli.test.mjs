// `cinatra create-extension` — end-to-end command behavior through the bin
// (cinatra#402 fold). Drives the published entry point (bin/cinatra.mjs) so the
// dispatch wiring (command-table descriptor → HANDLERS["create-extension"] →
// ./authoring/cli.mjs), the mode/rest reconstruction, the typed exit codes, and
// the --help footgun guard are all exercised exactly as a user would hit them.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

let workdir;
const created = [];

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "cinatra-create-ext-cli-"));
  created.push(workdir);
});

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    cwd: workdir,
    timeout: 30_000,
    env: { ...process.env, CI: "1" },
    ...opts,
  });
}

describe("cinatra create-extension <kind> [name] --yes scaffolds on disk", () => {
  it.each(["agent", "connector", "artifact", "skill", "workflow"])(
    "scaffolds a %s into the cwd and exits 0",
    (kind) => {
      const name = `cli-${kind === "skill" ? "tools" : "thing"}`;
      const res = run(["create-extension", kind, name, "--yes"]);
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      const slug = kind === "skill" ? `${name}-skills` : `${name}-${kind}`;
      const dir = path.join(workdir, slug);
      expect(existsSync(dir), `scaffold dir ${slug} should exist`).toBe(true);
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      expect(pkg.cinatra.kind).toBe(kind);
      // Restored dotfiles present (the publish trap).
      expect(existsSync(path.join(dir, ".gitignore"))).toBe(true);
      expect(existsSync(path.join(dir, ".npmrc"))).toBe(true);
      expect(res.stdout).toContain(`Scaffolded ${pkg.name} (kind: ${kind})`);
    },
  );
});

describe("cinatra create-extension argument routing (the kind token in `mode`)", () => {
  it("`create-extension agent foo` routes the kind + name to the scaffolder", () => {
    // `create-extension` is a command-only descriptor; argv[1] (`agent`) lands
    // in the dispatcher's `mode` slot and must be re-prepended to `rest`.
    const res = run(["create-extension", "agent", "routed-thing", "--yes"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(existsSync(path.join(workdir, "routed-thing-agent"))).toBe(true);
  });

  it("honors --scope for a connector (any-scope kind)", () => {
    const res = run(["create-extension", "connector", "stripe", "--scope", "acme", "--yes"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    const pkg = JSON.parse(readFileSync(path.join(workdir, "stripe-connector", "package.json"), "utf8"));
    expect(pkg.name).toBe("@acme/stripe-connector");
  });
});

describe("cinatra create-extension typed exit codes (parity with the standalone scaffolder)", () => {
  it("exits 2 on an unknown kind (usage error), not 1", () => {
    const res = run(["create-extension", "bogus", "x", "--yes"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/kind must be one of/i);
    // No directory was created.
    expect(readdirSync(workdir)).toEqual([]);
  });

  it("exits 2 on a missing name in non-interactive mode", () => {
    const res = run(["create-extension", "agent", "--yes"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/name is required/i);
  });

  it("exits 2 on an unknown option", () => {
    const res = run(["create-extension", "agent", "x", "--nope", "--yes"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/Unknown option/i);
  });
});

describe("cinatra create-extension --help (footgun guard)", () => {
  it("prints usage, exits 0, and scaffolds NOTHING", () => {
    const res = run(["create-extension", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cinatra create-extension");
    expect(res.stdout).toMatch(/Usage:/i);
    // The central help guard short-circuits before the handler — no scaffold.
    expect(readdirSync(workdir)).toEqual([]);
  });

  it("enumerates the kinds and at least one option (the docs promise this)", () => {
    // README + AUTHORING.md tell users to run `--help` for the kinds and
    // options; this asserts that promise holds (the COMMAND_HELP_DETAILS block).
    const res = run(["create-extension", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Kinds:");
    for (const kind of ["agent", "connector", "artifact", "skill", "workflow"]) {
      expect(res.stdout, `--help should list the "${kind}" kind`).toContain(kind);
    }
    expect(res.stdout).toContain("--scope");
  });

  it("`-h` is also honored with no side effect", () => {
    const res = run(["create-extension", "-h"]);
    expect(res.status).toBe(0);
    expect(readdirSync(workdir)).toEqual([]);
  });
});

describe("cinatra create-extension is advertised in the help surface", () => {
  it("appears in the global `cinatra --help` banner", () => {
    const res = run(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("cinatra create-extension");
  });
});
