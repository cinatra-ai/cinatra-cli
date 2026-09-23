// `cinatra --version` / `-v` reserved for the CLI's own SemVer (cinatra#255
// §6 Q5): it prints the value of the CLI `package.json` `version` and exits 0,
// and is NOT aliased to `--ref` (which selects the app version).
//
// Since cinatra-cli#271 the line names the program and, when the build can
// prove one, the commit it was built from: `cinatra <version>` or
// `cinatra <version> (commit <12 hex>)`. The provenance half — which sources
// are read, and what each one proves — is pinned in version-provenance.test.mjs;
// this file keeps the flag's own contract.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");
const PKG = JSON.parse(
  readFileSync(path.join(HERE, "..", "package.json"), "utf8"),
);

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** The version line with its optional `(commit …)` half removed. */
function versionOnly(line) {
  return line.trim().replace(/^cinatra /, "").replace(/ \(commit [0-9a-f]{12}\)$/, "");
}

describe("cinatra --version", () => {
  it("prints the CLI package.json version and exits 0", () => {
    const res = runCli(["--version"]);
    expect(res.status).toBe(0);
    expect(res.stdout.trim().startsWith("cinatra ")).toBe(true);
    expect(versionOnly(res.stdout)).toBe(PKG.version);
    // Sanity: it is a SemVer-shaped string, not an apiVersion (`cinatra.ai/v1`).
    expect(versionOnly(res.stdout)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`-v` is an alias for `--version`", () => {
    const res = runCli(["-v"]);
    expect(res.status).toBe(0);
    expect(versionOnly(res.stdout)).toBe(PKG.version);
  });

  it("`--json` reports the same version for a machine caller", () => {
    const res = runCli(["--version", "--json"]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).version).toBe(PKG.version);
  });

  it("does not print the help banner for --version", () => {
    const res = runCli(["--version"]);
    expect(res.stdout).not.toContain("Cinatra setup CLI");
    expect(res.stdout).not.toContain("Usage:");
  });

  it("--help still renders the banner (unchanged)", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Cinatra setup CLI");
    // The command-routing contract (renamed cinatra-cli#61): the local bootstrap
    // commands moved under `cinatra instance …`; the top-level banner points at
    // them rather than listing `cinatra setup`.
    expect(res.stdout).toContain("cinatra instance");
    expect(res.stdout).toContain("cinatra install");
  });
});
