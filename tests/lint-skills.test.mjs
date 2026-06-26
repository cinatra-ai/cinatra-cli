// SKILL.md source lint (cinatra-cli#45).
//
// Asserts the lint command:
//   1. PASSES every good fixture and FAILS every bad fixture, with the right
//      reason (validator violation OR un-edited placeholder text);
//   2. scopes the SOURCE scan correctly — excludes templates/ (un-rendered) and
//      tests/fixtures/ (intentional good/bad cases) so the repo lint is clean;
//   3. reports a clean repo (no violations among real source SKILL.md files).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lintSkillContent } from "../src/authoring/skill-frontmatter.mjs";
import { lintRepo, isSourceSkill } from "../scripts/lint-skills.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const FIX = join(HERE, "fixtures", "skills-lint");

const read = (name) => readFileSync(join(FIX, name, "SKILL.md"), "utf8");

const GOOD = ["good-skill", "good-metadata-skill"];
const BAD = {
  "bad-unquoted-colon": /Invalid YAML/,
  "bad-top-level-match-when": /Unexpected key|metadata/,
  "bad-angle-brackets": /angle brackets/,
  "bad-missing-name": /Missing 'name'/,
  "bad-unexpected-key": /Unexpected key/,
  "bad-placeholder": /placeholder/,
};

describe("skills-lint fixtures", () => {
  it.each(GOOD)("good fixture %s passes the lint", (name) => {
    const { ok, errors } = lintSkillContent(read(name));
    expect(ok, errors.join("; ")).toBe(true);
  });

  it.each(Object.keys(BAD))("bad fixture %s fails the lint with the right reason", (name) => {
    const { ok, errors } = lintSkillContent(read(name));
    expect(ok).toBe(false);
    expect(errors.join("\n")).toMatch(BAD[name]);
  });

  it("every fixture directory is covered by a GOOD or BAD expectation", () => {
    // Guards against an unreferenced fixture silently rotting.
    const dirs = readdirSync(FIX, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const covered = [...GOOD, ...Object.keys(BAD)].sort();
    expect(dirs).toEqual(covered);
  });

  it("a bad fixture would pass once placeholders are allowed only if it is otherwise valid", () => {
    // The placeholder fixture is VALIDATOR-valid; it fails ONLY the placeholder
    // guard. With allowPlaceholders, it passes — proving the two checks are
    // independent (templates/fixtures can opt out of the placeholder guard).
    const r = lintSkillContent(read("bad-placeholder"), { allowPlaceholders: true });
    expect(r.ok).toBe(true);
  });
});

describe("skills-lint source scoping", () => {
  it("excludes templates/ and tests/fixtures/ from the source scan", () => {
    expect(isSourceSkill("templates/skill/skills/{{base}}/SKILL.md")).toBe(false);
    expect(isSourceSkill("tests/fixtures/skills-lint/good-skill/SKILL.md")).toBe(false);
    expect(isSourceSkill("tests/fixtures/skills-lint/bad-unquoted-colon/SKILL.md")).toBe(false);
  });

  it("includes a real source skill path (e.g. skills/<name>/SKILL.md)", () => {
    expect(isSourceSkill("skills/my-real-skill/SKILL.md")).toBe(true);
  });
});

describe("skills-lint on the real repo", () => {
  it("reports zero violations among real source SKILL.md files", () => {
    const { violations } = lintRepo(REPO_ROOT);
    expect(
      violations,
      violations.map((v) => `${v.path}: ${v.errors.join("; ")}`).join("\n"),
    ).toEqual([]);
  });
});
