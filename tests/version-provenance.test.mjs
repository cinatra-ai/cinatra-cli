// `cinatra --version` names the build it came from (cinatra-cli#271).
//
// `package.json` carries the same `version` at the published build and at every
// commit of main, so a caller that pinned the CLI to an exact commit could not
// verify the pin with `cinatra --version` — it had to ask the package manager
// for the ref it resolved. The version line now says which build is answering:
// the commit, whenever the installed package can prove one.
//
// What a build can prove was MEASURED, not assumed (npm 11):
//   - `npm install <git-ref>` into a project and the `npx` cache both record
//     `packages["node_modules/@cinatra-ai/cinatra"].resolved` ending in
//     `#<40-hex>` in `node_modules/.package-lock.json` (and in the project
//     `package-lock.json`).
//   - a GLOBAL install of the same git ref records nothing at all: no lockfile,
//     no `_resolved`, no `gitHead`, and no `.git` (npm extracts a tarball).
//   - `gitHead` is written into the REGISTRY manifest at publish time, never
//     into the packed tarball, so an installed published build has none.
// So: `gitHead` when a publisher put one in the manifest, otherwise the package
// manager's own resolved ref, otherwise the package directory's own checkout —
// and silence when none of the three knows anything.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatVersionLine, readBuildProvenance } from "../src/cli-provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const BIN = path.join(REPO, "bin", "cinatra.mjs");
const PKG = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));

const SHA = "e82ddd36e178a0b1c2d3e4f5061728394a5b6c7d";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
const PKG_PATH = ["node_modules", "@cinatra-ai", "cinatra"];

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cin-provenance-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Create `<tmp>/<segments…>` and return it. */
function dir(...segments) {
  const made = path.join(tmp, ...segments);
  mkdirSync(made, { recursive: true });
  return made;
}

/** Write a file, creating its parent directories. */
function file(target, body) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
  return target;
}

/** The lockfile shape npm 11 writes beside an installed package. */
function lockfile(resolved) {
  return `${JSON.stringify(
    {
      name: "caller",
      lockfileVersion: 3,
      packages: {
        [PKG_PATH.join("/")]: { version: PKG.version, resolved, license: "Apache-2.0" },
      },
    },
    null,
    2,
  )}\n`;
}

describe("readBuildProvenance — the manifest's own gitHead", () => {
  it("names the commit a publisher recorded in the manifest", () => {
    const packageDir = dir("pkg");
    expect(readBuildProvenance(packageDir, { version: PKG.version, gitHead: SHA })).toEqual({
      commit: SHA,
      source: "package-manifest",
    });
  });

  it("says nothing when the manifest carries no gitHead and nothing else knows", () => {
    const packageDir = dir("pkg");
    expect(readBuildProvenance(packageDir, { version: PKG.version })).toEqual({
      commit: null,
      source: null,
    });
  });

  it("ignores a gitHead that is not a full commit id", () => {
    const packageDir = dir("pkg");
    expect(readBuildProvenance(packageDir, { gitHead: "main" })).toEqual({
      commit: null,
      source: null,
    });
  });
});

describe("readBuildProvenance — the package manager's resolved ref", () => {
  it("reads the commit npm recorded beside the installed package", () => {
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, "node_modules", ".package-lock.json"), lockfile(`git+ssh://git@github.com/cinatra-ai/cinatra-cli.git#${SHA}`));
    expect(readBuildProvenance(packageDir, { version: PKG.version })).toEqual({
      commit: SHA,
      source: "package-lock",
    });
  });

  it("falls back to the caller's own package-lock.json", () => {
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, "package-lock.json"), lockfile(`git+https://github.com/cinatra-ai/cinatra-cli.git#${SHA}`));
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "package-lock" });
  });

  it("stays silent for a published build (a registry tarball resolves to no commit)", () => {
    const packageDir = dir(...PKG_PATH);
    file(
      path.join(tmp, "node_modules", ".package-lock.json"),
      lockfile(`https://registry.npmjs.org/@cinatra-ai/cinatra/-/cinatra-${PKG.version}.tgz`),
    );
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });

  it("stays silent when the ref is a range rather than a commit", () => {
    const packageDir = dir(...PKG_PATH);
    file(
      path.join(tmp, "node_modules", ".package-lock.json"),
      lockfile("git+https://github.com/cinatra-ai/cinatra-cli.git#semver:^0.1.0"),
    );
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });

  it("refuses a resolved hash that is not exactly 40 hex characters", () => {
    // The `#…` half is only a commit when it IS one: an abbreviated ref proves
    // nothing about which build this is, and a longer token is not a commit at
    // all. Both stay silent rather than printing a half-truth.
    const packageDir = dir(...PKG_PATH);
    for (const tail of [SHA.slice(0, 12), SHA.slice(0, 39), `${SHA}0`, `${SHA}ff`, "", "not-hex"]) {
      file(
        path.join(tmp, "node_modules", ".package-lock.json"),
        lockfile(`git+https://example.invalid/x.git#${tail}`),
      );
      expect(
        readBuildProvenance(packageDir, {}),
        `resolved ref ending in "#${tail}"`,
      ).toEqual({ commit: null, source: null });
    }
  });

  it("reads the entry for THIS package, never a neighbour's", () => {
    const packageDir = dir(...PKG_PATH);
    file(
      path.join(tmp, "node_modules", ".package-lock.json"),
      `${JSON.stringify({
        packages: {
          "node_modules/somebody-else": { resolved: `git+https://example.invalid/x.git#${OTHER_SHA}` },
        },
      })}\n`,
    );
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });
});

describe("readBuildProvenance — a package directory that is itself a checkout", () => {
  it("reads HEAD through the branch it points at", () => {
    const packageDir = dir("checkout");
    file(path.join(packageDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    file(path.join(packageDir, ".git", "refs", "heads", "main"), `${SHA}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "git-checkout" });
  });

  it("reads a detached HEAD directly", () => {
    const packageDir = dir("checkout");
    file(path.join(packageDir, ".git", "HEAD"), `${SHA}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "git-checkout" });
  });

  it("reads a branch that only packed-refs still holds", () => {
    const packageDir = dir("checkout");
    file(path.join(packageDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    file(
      path.join(packageDir, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted \n${OTHER_SHA} refs/remotes/origin/other\n${SHA} refs/heads/main\n`,
    );
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "git-checkout" });
  });

  it("follows a `.git` FILE to the linked directory and its shared refs", () => {
    const packageDir = dir("linked");
    const shared = dir("shared", ".git");
    const linked = path.join(shared, "worktrees", "linked");
    file(path.join(packageDir, ".git"), `gitdir: ${linked}\n`);
    file(path.join(linked, "HEAD"), "ref: refs/heads/topic\n");
    file(path.join(linked, "commondir"), "../..\n");
    file(path.join(shared, "refs", "heads", "topic"), `${SHA}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "git-checkout" });
  });

  it("stays silent when the `.git` file points at a directory that is not there", () => {
    // A worktree whose shared repository was moved or deleted: every read below
    // the pointer simply fails, and a version line must still print.
    const packageDir = dir("linked-gone");
    file(path.join(packageDir, ".git"), `gitdir: ${path.join(tmp, "no-such-gitdir")}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });

  it("stays silent for a `.git` file that points at nothing at all", () => {
    const packageDir = dir("linked-garbage");
    file(path.join(packageDir, ".git"), "this is not a gitdir pointer\n");
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });

  it("never borrows the commit of a checkout the package merely sits INSIDE", () => {
    // An installed package under someone else's repository must not report that
    // repository's HEAD as its own build.
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, ".git", "HEAD"), `${OTHER_SHA}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });
});

describe("readBuildProvenance — which source answers first", () => {
  it("prefers the manifest's gitHead over the resolved ref", () => {
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, "node_modules", ".package-lock.json"), lockfile(`git+https://example.invalid/x.git#${OTHER_SHA}`));
    expect(readBuildProvenance(packageDir, { gitHead: SHA })).toEqual({
      commit: SHA,
      source: "package-manifest",
    });
  });

  it("prefers the resolved ref over the directory's own checkout", () => {
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, "node_modules", ".package-lock.json"), lockfile(`git+https://example.invalid/x.git#${SHA}`));
    file(path.join(packageDir, ".git", "HEAD"), `${OTHER_SHA}\n`);
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: SHA, source: "package-lock" });
  });

  it("survives an unreadable lockfile and a truncated HEAD without throwing", () => {
    const packageDir = dir(...PKG_PATH);
    file(path.join(tmp, "node_modules", ".package-lock.json"), "{ not json");
    file(path.join(packageDir, ".git", "HEAD"), "ref: refs/heads/gone\n");
    expect(readBuildProvenance(packageDir, {})).toEqual({ commit: null, source: null });
  });
});

describe("formatVersionLine", () => {
  it("is the version alone when no build is known", () => {
    expect(formatVersionLine({ program: "cinatra", version: "0.1.8", commit: null })).toBe("cinatra 0.1.8");
  });

  it("names the commit in short form beside the version", () => {
    expect(formatVersionLine({ program: "cinatra", version: "0.1.8", commit: SHA })).toBe(
      "cinatra 0.1.8 (commit e82ddd36e178)",
    );
  });
});

describe("cinatra --version end to end", () => {
  function runCli(args) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  /** This checkout's HEAD, or null where the suite runs outside one. */
  function checkoutHead() {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" });
    const out = (res.stdout ?? "").trim();
    return res.status === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  }

  it("prints the version, and a commit only when the build knows one", () => {
    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(
      new RegExp(`^cinatra ${PKG.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\(commit [0-9a-f]{12}\\))?$`),
    );
  });

  it("names THIS checkout's commit when run from the repository", () => {
    const head = checkoutHead();
    if (!head) return; // not a checkout: the shape assertion above is the guard
    expect(runCli(["--version"]).stdout.trim()).toBe(`cinatra ${PKG.version} (commit ${head.slice(0, 12)})`);
  });

  it("--json carries the full commit and where it was read", () => {
    const res = runCli(["--version", "--json"]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.name).toBe(PKG.name);
    expect(report.version).toBe(PKG.version);
    const head = checkoutHead();
    if (head) {
      expect(report.commit).toBe(head);
      expect(report.commitSource).toBe("git-checkout");
    } else {
      expect(report.commit === null || /^[0-9a-f]{40}$/.test(report.commit)).toBe(true);
    }
  });

  it("`-v` answers exactly as `--version` does, in both forms", () => {
    expect(runCli(["-v"]).stdout).toBe(runCli(["--version"]).stdout);
    expect(runCli(["-v", "--json"]).stdout).toBe(runCli(["--version", "--json"]).stdout);
  });
});
