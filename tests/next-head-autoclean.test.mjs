// cinatra-cli#105 — HEAD-stamped `.next` auto-clean seams.
//
// Covers the pure decision/IO helpers that back `instance start|restart`:
//   - parseNextCleanDirective (flag → directive; mutual exclusion)
//   - cleanNextBuildCache (.next-ONLY scope; generated/ untouched)
//   - readCheckoutHeadSha / stampNextBuildHead / readNextBuildStamp (round-trip)
//   - evaluateNextStaleness (the no-next / unstamped / head-moved / fresh /
//     head-unresolved decision matrix)
//   - applyNextCleanBeforeStart (off / force / auto behaviors)
//
// Uses real temp git repos so the git HEAD read is exercised for real.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  parseNextCleanDirective,
  cleanNextBuildCache,
  readCheckoutHeadSha,
  stampNextBuildHead,
  readNextBuildStamp,
  evaluateNextStaleness,
  applyNextCleanBeforeStart,
  NEXT_BUILD_HEAD_STAMP,
} from "../src/index.mjs";

const tmpDirs = [];
function mkTmp() {
  const d = mkdtempSync(path.join(os.tmpdir(), "cli105-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function gitRepo() {
  const dir = mkTmp();
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}
function commit(dir, msg = "c") {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}
function makeNext(dir, { sentinel = true, stamp } = {}) {
  mkdirSync(path.join(dir, ".next"), { recursive: true });
  if (sentinel) writeFileSync(path.join(dir, ".next", "OLD_CHUNK.js"), "stale", "utf8");
  if (stamp !== undefined) writeFileSync(path.join(dir, ".next", NEXT_BUILD_HEAD_STAMP), `${stamp}\n`, "utf8");
}

// =========================================================================
describe("parseNextCleanDirective", () => {
  it("maps flags to directives and defaults to auto", () => {
    expect(parseNextCleanDirective(["--clean"])).toBe("force");
    expect(parseNextCleanDirective(["--no-clean"])).toBe("off");
    expect(parseNextCleanDirective([])).toBe("auto");
    expect(parseNextCleanDirective(undefined)).toBe("auto");
    expect(parseNextCleanDirective(["--other"])).toBe("auto");
  });
  it("rejects the contradictory pair", () => {
    expect(() => parseNextCleanDirective(["--clean", "--no-clean"])).toThrow(/mutually exclusive/);
  });
});

describe("cleanNextBuildCache — .next ONLY", () => {
  it("removes .next but never generated/", () => {
    const dir = mkTmp();
    makeNext(dir);
    mkdirSync(path.join(dir, "generated"), { recursive: true });
    writeFileSync(path.join(dir, "generated", "map.ts"), "keep", "utf8");
    expect(cleanNextBuildCache(dir)).toBe(true);
    expect(existsSync(path.join(dir, ".next"))).toBe(false);
    expect(existsSync(path.join(dir, "generated", "map.ts"))).toBe(true);
  });
  it("is a no-op (false) when .next is absent", () => {
    const dir = mkTmp();
    expect(cleanNextBuildCache(dir)).toBe(false);
  });
});

describe("readCheckoutHeadSha", () => {
  it("returns the 40-hex HEAD in a git checkout", () => {
    const dir = gitRepo();
    const sha = commit(dir);
    expect(readCheckoutHeadSha(dir)).toBe(sha);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
  it("returns null outside a git checkout", () => {
    expect(readCheckoutHeadSha(mkTmp())).toBeNull();
  });
});

describe("stampNextBuildHead / readNextBuildStamp round-trip", () => {
  it("stamps the current HEAD into .next and reads it back", () => {
    const dir = gitRepo();
    const sha = commit(dir);
    makeNext(dir, { stamp: undefined });
    stampNextBuildHead(dir);
    expect(readNextBuildStamp(dir)).toBe(sha);
  });
  it("stampNextBuildHead is a no-op when .next is absent", () => {
    const dir = gitRepo();
    commit(dir);
    stampNextBuildHead(dir);
    expect(existsSync(path.join(dir, ".next"))).toBe(false);
  });
  it("readNextBuildStamp is null for a missing or malformed stamp", () => {
    const dir = mkTmp();
    expect(readNextBuildStamp(dir)).toBeNull();
    makeNext(dir, { stamp: "not-a-sha" });
    expect(readNextBuildStamp(dir)).toBeNull();
  });
});

describe("evaluateNextStaleness decision matrix", () => {
  it("no .next → not stale", () => {
    const dir = gitRepo();
    commit(dir);
    expect(evaluateNextStaleness(dir)).toMatchObject({ stale: false, reason: "no-next" });
  });
  it("unstamped .next → stale (unstamped)", () => {
    const dir = gitRepo();
    commit(dir);
    makeNext(dir, { stamp: undefined });
    expect(evaluateNextStaleness(dir)).toMatchObject({ stale: true, reason: "unstamped" });
  });
  it("stamp == HEAD → fresh (not stale)", () => {
    const dir = gitRepo();
    const sha = commit(dir);
    makeNext(dir, { stamp: sha });
    expect(evaluateNextStaleness(dir)).toMatchObject({ stale: false, reason: "fresh" });
  });
  it("stamp != HEAD (HEAD moved) → stale (head-moved)", () => {
    const dir = gitRepo();
    const first = commit(dir, "one");
    makeNext(dir, { stamp: first });
    const second = commit(dir, "two");
    expect(second).not.toBe(first);
    expect(evaluateNextStaleness(dir)).toMatchObject({ stale: true, reason: "head-moved" });
  });
  it("non-git checkout → not stale (head-unresolved), never a gratuitous purge", () => {
    const dir = mkTmp();
    makeNext(dir, { stamp: undefined });
    expect(evaluateNextStaleness(dir)).toMatchObject({ stale: false, reason: "head-unresolved" });
  });
});

describe("applyNextCleanBeforeStart", () => {
  it("off → never purges, even when stale", () => {
    const dir = gitRepo();
    commit(dir);
    makeNext(dir, { stamp: undefined }); // stale (unstamped)
    applyNextCleanBeforeStart(dir, "off");
    expect(existsSync(path.join(dir, ".next", "OLD_CHUNK.js"))).toBe(true);
  });
  it("force → purges even when fresh", () => {
    const dir = gitRepo();
    const sha = commit(dir);
    makeNext(dir, { stamp: sha }); // fresh
    applyNextCleanBeforeStart(dir, "force");
    expect(existsSync(path.join(dir, ".next"))).toBe(false);
  });
  it("auto → preserves a fresh .next", () => {
    const dir = gitRepo();
    const sha = commit(dir);
    makeNext(dir, { stamp: sha });
    applyNextCleanBeforeStart(dir, "auto");
    expect(existsSync(path.join(dir, ".next", "OLD_CHUNK.js"))).toBe(true);
  });
  it("auto → purges a HEAD-moved .next", () => {
    const dir = gitRepo();
    const first = commit(dir, "one");
    makeNext(dir, { stamp: first });
    commit(dir, "two");
    applyNextCleanBeforeStart(dir, "auto");
    expect(existsSync(path.join(dir, ".next"))).toBe(false);
  });
});
