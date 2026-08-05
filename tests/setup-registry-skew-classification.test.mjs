// cinatra-cli#200 — the SKEW CLASSIFICATION contract, unit level.
//
// Three seams, each pure and each fail-closed:
//   1. `collectSkewExemptSources` — which on-disk sources the extension sync
//      positively attested (committed-lock pin, or clean at the fetched branch
//      tip); everything else is unattributed.
//   2. `classifySetupExitCode` — the setup process's final exit code: a real
//      failure always wins; an otherwise-clean run carrying unattributed skew
//      claims the TYPED skew code.
//   3. `classifySetupChildExit` — the install boundary reading that code:
//      exactly one status is tolerated-and-named, every other non-zero still
//      means "setup failed inside the target".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { collectSkewExemptSources } from "../src/cinatra-dev-extensions.mjs";
import { packedPathsAreTrackedAndUnhidden } from "../src/dev-repo-sync.mjs";
import {
  SETUP_EXIT_REGISTRY_SKEW,
  claimRegistrySkewExitCode,
  classifySetupExitCode,
  listPackedMembers,
  registrySkewVerdictLines,
} from "../src/seed-local-registry.mjs";
import { classifySetupChildExit } from "../src/install.mjs";

const SHA = "a".repeat(40);
// The attestations are re-verified against the real filesystem at collection
// time; these cases are about the PARTITIONING, so the verifier is stubbed.
// (Its real behaviour is covered by the `verify` cases below and end-to-end by
// tests/seed-registry-inplace-update.test.mjs.)
const ok = { verify: () => true };

describe("collectSkewExemptSources — sync provenance (cinatra-cli#200)", () => {
  it("partitions pinned vs branch-tip attestations, keyed by resolved directory", () => {
    const { pinnedSourceDirs, syncedSourceDirs } = collectSkewExemptSources(
      {
        results: [
          { pkgName: "@x/pinned", action: "repinned", pinnedSha: SHA, dest: "/repo/extensions/x/pinned" },
          { pkgName: "@x/tip", action: "updated", changed: false, syncedSha: SHA, dest: "/repo/extensions/x/tip" },
        ],
      },
      ok,
    );
    expect([...pinnedSourceDirs]).toEqual([path.resolve("/repo/extensions/x/pinned")]);
    expect([...syncedSourceDirs]).toEqual([path.resolve("/repo/extensions/x/tip")]);
  });

  it("exempts NOTHING the sync did not attest (fail-closed)", () => {
    // The four unattested shapes: a dirty-tree skip, a detached checkout with
    // local commits, a detached checkout the caller could not confirm at a lock,
    // and a plain leave-as-is.
    const { pinnedSourceDirs, syncedSourceDirs } = collectSkewExemptSources(
      {
        results: [
          { pkgName: "@x/dirty", action: "skipped-dirty", dest: "/repo/extensions/x/dirty" },
          { pkgName: "@x/local-commits", action: "skipped-local-commits", dest: "/repo/extensions/x/lc" },
          { pkgName: "@x/detached", action: "skipped-detached", changed: false, dest: "/repo/extensions/x/det" },
          { pkgName: "@x/plain", action: "updated", changed: true, dest: "/repo/extensions/x/plain" },
        ],
      },
      ok,
    );
    expect(pinnedSourceDirs.size).toBe(0);
    expect(syncedSourceDirs.size).toBe(0);
  });

  it("a skipped / failed / absent sync exempts nothing", () => {
    for (const input of [undefined, null, {}, { skipped: true, reason: "no-config" }, { results: null }]) {
      const sets = collectSkewExemptSources(input, ok);
      expect(sets.pinnedSourceDirs.size).toBe(0);
      expect(sets.syncedSourceDirs.size).toBe(0);
    }
  });

  it("ignores malformed / unusable result entries instead of exempting them", () => {
    const { pinnedSourceDirs, syncedSourceDirs } = collectSkewExemptSources(
      {
        results: [
          null,
          {},
          { pkgName: "@x/no-dest", syncedSha: SHA }, // nothing to key or re-verify
          { pkgName: "@x/bad-sha", syncedSha: "not-a-sha", dest: "/repo/extensions/x/bad" },
          { pkgName: "@x/non-string", syncedSha: 42, dest: "/repo/extensions/x/n" },
        ],
      },
      ok,
    );
    expect(pinnedSourceDirs.size).toBe(0);
    expect(syncedSourceDirs.size).toBe(0);
  });

  it("a pin attestation wins over a tip attestation for the same checkout", () => {
    const { pinnedSourceDirs, syncedSourceDirs } = collectSkewExemptSources(
      { results: [{ pkgName: "@x/both", pinnedSha: SHA, syncedSha: SHA, dest: "/repo/extensions/x/both" }] },
      ok,
    );
    expect([...pinnedSourceDirs]).toEqual([path.resolve("/repo/extensions/x/both")]);
    expect(syncedSourceDirs.size).toBe(0);
  });

  it("drops an attestation that NO LONGER HOLDS at the point of use", () => {
    // Setup does real work between the sync and the seed; provenance is
    // re-verified rather than trusted from earlier in the run.
    const seen = [];
    const { syncedSourceDirs } = collectSkewExemptSources(
      {
        results: [
          { pkgName: "@x/still-clean", syncedSha: SHA, dest: "/repo/extensions/x/clean" },
          { pkgName: "@x/mutated", syncedSha: SHA, dest: "/repo/extensions/x/mutated" },
        ],
      },
      {
        verify: ({ dest, sha }) => {
          seen.push({ dest, sha });
          return !dest.endsWith("mutated");
        },
      },
    );
    expect([...syncedSourceDirs]).toEqual([path.resolve("/repo/extensions/x/clean")]);
    expect(seen).toEqual([
      { dest: "/repo/extensions/x/clean", sha: SHA },
      { dest: "/repo/extensions/x/mutated", sha: SHA },
    ]);
  });
});

describe("classifySetupExitCode — the setup process's final code", () => {
  it("a clean run with no skew stays 0 (fresh from-zero installs unchanged)", () => {
    expect(classifySetupExitCode(0, [])).toBe(0);
    expect(classifySetupExitCode(undefined, [])).toBe(0);
  });

  it("a clean run carrying unattributed skew claims the typed skew code", () => {
    expect(classifySetupExitCode(0, ["@x/a@0.1.0"])).toBe(SETUP_EXIT_REGISTRY_SKEW);
    expect(classifySetupExitCode(undefined, ["@x/a@0.1.0"])).toBe(SETUP_EXIT_REGISTRY_SKEW);
  });

  it("a REAL failure always wins — skew never masks or downgrades it", () => {
    expect(classifySetupExitCode(1, ["@x/a@0.1.0"])).toBe(1);
    expect(classifySetupExitCode(2, ["@x/a@0.1.0"])).toBe(2);
    expect(classifySetupExitCode(1, [])).toBe(1);
  });

  it("tolerates a non-array / non-integer input without inventing a code", () => {
    expect(classifySetupExitCode(0, undefined)).toBe(0);
    expect(classifySetupExitCode(0, null)).toBe(0);
    expect(classifySetupExitCode("0", [])).toBe(0);
  });

  it("a numeric-STRING failure code is preserved, never rounded down to clean", () => {
    // `process.exitCode` accepts numeric strings; treating one as 0 would let a
    // skew downgrade a failure.
    expect(classifySetupExitCode("1", ["@x/a@0.1.0"])).toBe("1");
    expect(classifySetupExitCode("nonsense", ["@x/a@0.1.0"])).toBe("nonsense");
  });

  it("only a PROVABLY zero code counts as clean", () => {
    // Values `Number()` happens to coerce to 0 are not evidence of success.
    for (const value of ["", "   ", false, [], {}, Number.NaN]) {
      expect(classifySetupExitCode(value, ["@x/a@0.1.0"])).toBe(value);
    }
    expect(classifySetupExitCode(" 0 ", ["@x/a@0.1.0"])).toBe(SETUP_EXIT_REGISTRY_SKEW);
  });

  it("never collides with a code node itself reserves for a fatal condition", () => {
    // node uses 1–12 for its own fatal exits and 128+N for signal deaths; the
    // BSD sysexits conventions occupy 64–78. A collision would let an unrelated
    // fatal child be misread as a benign skew.
    expect(SETUP_EXIT_REGISTRY_SKEW).toBeGreaterThan(12);
    expect(SETUP_EXIT_REGISTRY_SKEW).toBeLessThan(64);
  });
});

describe("claimRegistrySkewExitCode — re-raising the outcome in the install process", () => {
  it("claims the typed code when the install is otherwise clean", () => {
    expect(claimRegistrySkewExitCode(undefined)).toBe(SETUP_EXIT_REGISTRY_SKEW);
    expect(claimRegistrySkewExitCode(0)).toBe(SETUP_EXIT_REGISTRY_SKEW);
  });

  it("never overwrites a non-zero the install already set for a real failure", () => {
    expect(claimRegistrySkewExitCode(1)).toBe(1);
    expect(claimRegistrySkewExitCode(2)).toBe(2);
    expect(claimRegistrySkewExitCode("1")).toBe("1");
  });
});

describe("classifySetupChildExit — the install boundary (cinatra-cli#200)", () => {
  it("tolerates ONLY the typed skew code, and names the condition", () => {
    const verdict = classifySetupChildExit(SETUP_EXIT_REGISTRY_SKEW, { canReportRegistrySkew: true });
    expect(verdict.tolerated).toBe(true);
    expect(verdict.registrySkew).toBe(true);
    const text = verdict.lines.join("\n");
    expect(text).toMatch(/local-registry version skew/i);
    expect(text).toMatch(/bump the extension version/i);
    expect(text).toMatch(/purge\/reset the local Verdaccio/i);
    // AC2: never a bare "setup failed" over a substantively completed setup.
    expect(text).not.toMatch(/setup failed/i);
    expect(text).toMatch(/NOT a failed setup/i);
  });

  it("exit 0 is success with nothing to say", () => {
    expect(classifySetupChildExit(0, { canReportRegistrySkew: true })).toEqual({
      tolerated: true,
      registrySkew: false,
      lines: [],
    });
    expect(classifySetupChildExit(0)).toEqual({ tolerated: true, registrySkew: false, lines: [] });
  });

  it("every other status is still a real failure", () => {
    for (const status of [1, 2, 3, 4, 127, null, undefined]) {
      const verdict = classifySetupChildExit(status, { canReportRegistrySkew: true });
      expect(verdict.tolerated).toBe(false);
      expect(verdict.registrySkew).toBe(false);
    }
  });

  it("the skew code is NOT tolerated for a setup that cannot mint it (prod)", () => {
    // The local-registry seed is dev-only; the same status out of a prod setup
    // is an unexplained failure, not a skew.
    const verdict = classifySetupChildExit(SETUP_EXIT_REGISTRY_SKEW);
    expect(verdict.tolerated).toBe(false);
    expect(verdict.registrySkew).toBe(false);
  });
});

describe("registrySkewVerdictLines — the operator-facing verdict", () => {
  it("the setup-tail variant enumerates the affected ids + the remedy", () => {
    const text = registrySkewVerdictLines(["@x/a@0.1.0", "@x/b@0.2.0"]).join("\n");
    expect(text).toContain("@x/a@0.1.0");
    expect(text).toContain("@x/b@0.2.0");
    expect(text).toMatch(/2 extensions/);
    expect(text).toMatch(/fully provisioned/i);
    expect(text).toMatch(/bump the extension version/i);
    expect(text).not.toMatch(/setup failed/i);
  });

  it("singularizes a single id", () => {
    expect(registrySkewVerdictLines(["@x/a@0.1.0"]).join("\n")).toMatch(/1 extension:/);
  });

  it("the install-tail variant restates it compactly with the typed code", () => {
    const text = registrySkewVerdictLines([], { context: "install-tail" }).join("\n");
    expect(text).toMatch(new RegExp(`exit code ${SETUP_EXIT_REGISTRY_SKEW}`));
    expect(text).toMatch(/fully provisioned/i);
    expect(text).not.toMatch(/setup failed/i);
  });
});

// ---------------------------------------------------------------------------
// The packed-member enumeration the second-stage provenance check consumes.
// It has one job beyond listing: never report a PARTIAL view of the archive,
// because a member it failed to account for is a packed path nobody verified.
// ---------------------------------------------------------------------------
describe("listPackedMembers — complete or nothing (cinatra-cli#200)", () => {
  let work;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-members-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** A real `npm pack` tarball of a two-file package. */
  function packFixture(name) {
    const dir = path.join(work, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: `@cinatra-fixture/${name}`, version: "0.1.0", main: "index.js" }),
    );
    writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
    const r = spawnSync("npm", ["pack", "--pack-destination", work, "--ignore-scripts"], {
      cwd: dir,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
    return path.join(work, path.basename((r.stdout || "").trim().split("\n").filter(Boolean).pop()));
  }

  /** Rewrite the FIRST tar header's typeflag to one node-tar does not support
   *  (`S`, sparse), fixing the header checksum — the shape that makes the
   *  parser report `ignoredEntry` instead of `entry`. */
  function withUnsupportedFirstMember(tgz, out) {
    const blocks = gunzipSync(readFileSync(tgz));
    blocks[156] = "S".charCodeAt(0); // typeflag
    blocks.fill(0x20, 148, 156); // checksum field counts as spaces while summing
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += blocks[i];
    const chksum = `${sum.toString(8).padStart(6, "0")}\0 `;
    blocks.write(chksum, 148, 8, "ascii");
    writeFileSync(out, gzipSync(blocks));
    return out;
  }

  it("lists every packed path, package-relative", () => {
    const members = listPackedMembers(packFixture("plain-pkg"));
    expect(members).toEqual(expect.arrayContaining(["package.json", "index.js"]));
    expect(members.every((m) => !m.startsWith("package/"))).toBe(true);
  });

  it("returns null when the archive holds a member the parser IGNORES", () => {
    // `tar.list`'s onentry never sees these, so an onentry-only enumeration
    // would return a partial list and let an unverified path through.
    const crafted = withUnsupportedFirstMember(
      packFixture("crafted-pkg"),
      path.join(work, "crafted.tgz"),
    );
    expect(listPackedMembers(crafted)).toBeNull();
  });

  it("returns null for an unreadable tarball", () => {
    expect(listPackedMembers(path.join(work, "does-not-exist.tgz"))).toBeNull();
  });

  it("a null member list can never vouch for provenance", () => {
    expect(packedPathsAreTrackedAndUnhidden({ dir: work, files: null })).toBe(false);
  });
});
