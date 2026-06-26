// SKILL.md frontmatter: templates render validator-compatible frontmatter, and
// the Cinatra superset validator faithfully replicates the upstream skills
// validator rules (plus the metadata-only project-key allowance). cinatra-cli#44.
//
// Two halves:
//   1. RENDERED-TEMPLATE conformance — scaffold every kind that ships a SKILL.md
//      (skill, agent, artifact) and assert each rendered SKILL.md passes the
//      validator and carries a quoted `name`/`description` (so an UNRENDERED
//      template — `name: {{base}}` — can never be valid YAML and leak).
//   2. VALIDATOR-UNIT parity — exercise every failure mode the upstream
//      quick_validate.py enforces, plus the Cinatra rule that project keys are
//      accepted under `metadata:` and rejected at the top level.

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, beforeAll } from "vitest";

import { scaffold } from "../src/authoring/scaffold.mjs";
import {
  validateSkillContent,
  extractFrontmatter,
  parseFrontmatter,
  findPlaceholders,
  ALLOWED_TOP_LEVEL_KEYS,
} from "../src/authoring/skill-frontmatter.mjs";

// Kinds whose scaffold output includes at least one SKILL.md.
const SKILL_KINDS = ["skill", "agent", "artifact"];

function listSkillMd(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listSkillMd(abs, rel));
    else if (name === "SKILL.md") out.push(rel);
  }
  return out.sort();
}

const results = {};
let root;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cinatra-skill-fm-"));
  for (const kind of SKILL_KINDS) {
    results[kind] = scaffold({
      kind,
      name: `sample-${kind === "skill" ? "tools" : "thing"}`,
      scope: undefined,
      displayName: undefined,
      description: undefined,
      targetParent: root,
      force: true,
    });
  }
});

describe.each(SKILL_KINDS)("rendered %s SKILL.md passes the validator", (kind) => {
  it("every rendered SKILL.md is validator-valid", () => {
    const dir = results[kind].targetDir;
    const files = listSkillMd(dir);
    expect(files.length, `${kind} should scaffold at least one SKILL.md`).toBeGreaterThan(0);
    for (const rel of files) {
      const content = readFileSync(join(dir, rel), "utf8");
      const v = validateSkillContent(content);
      expect(v.valid, `${kind}/${rel}: ${v.message}`).toBe(true);
    }
  });

  it("rendered frontmatter quotes name and description (no unquoted placeholder leak)", () => {
    const dir = results[kind].targetDir;
    for (const rel of listSkillMd(dir)) {
      const content = readFileSync(join(dir, rel), "utf8");
      const fm = extractFrontmatter(content);
      expect(fm.ok, `${kind}/${rel} must have frontmatter`).toBe(true);
      // The name/description lines must be quoted so that even the UNRENDERED
      // template (`name: "{{base}}"`) parses as a string, never as the YAML flow
      // mapping `{{base}}` that the issue reported as "Invalid YAML".
      expect(/^name:\s*".*"\s*$/m.test(fm.frontmatter), `${rel} name must be quoted`).toBe(true);
      expect(
        /^description:\s*".*"\s*$/m.test(fm.frontmatter),
        `${rel} description must be quoted`,
      ).toBe(true);
    }
  });

  it("uses no top-level Cinatra project key (match_when / cinatra-watches)", () => {
    const dir = results[kind].targetDir;
    for (const rel of listSkillMd(dir)) {
      const content = readFileSync(join(dir, rel), "utf8");
      const fm = extractFrontmatter(content);
      expect(/^match_when:/m.test(fm.frontmatter), `${rel} must not use top-level match_when`).toBe(
        false,
      );
      expect(
        /^cinatra-watches:/m.test(fm.frontmatter),
        `${rel} must not use top-level cinatra-watches`,
      ).toBe(false);
    }
  });
});

describe("UNRENDERED templates: quoting makes them non-leaking", () => {
  // The raw template files (with {{tokens}} still present) must NOT validate as
  // valid skills — but their frontmatter must still be PARSEABLE YAML (quoted),
  // so a generator path that forgets a substitution produces a clearly-invalid
  // file, not a YAML crash. We assert the template name/description are quoted.
  const TEMPLATE_SKILL_MD = [
    "templates/skill/skills/{{base}}/SKILL.md",
    "templates/agent/skills/{{slug}}/SKILL.md",
    "templates/artifact/skills/{{base}}-matcher/SKILL.md",
  ];
  const repoRoot = join(import.meta.dirname, "..");

  it.each(TEMPLATE_SKILL_MD)("%s quotes name and description in frontmatter", (rel) => {
    const content = readFileSync(join(repoRoot, rel), "utf8");
    const fm = extractFrontmatter(content);
    expect(fm.ok).toBe(true);
    expect(/^name:\s*".*"\s*$/m.test(fm.frontmatter)).toBe(true);
    expect(/^description:\s*".*"\s*$/m.test(fm.frontmatter)).toBe(true);
    // No top-level project key in the raw template either.
    expect(/^match_when:/m.test(fm.frontmatter)).toBe(false);
  });
});

describe("scaffold input guard: a displayName cannot break SKILL.md frontmatter", () => {
  it("rejects a displayName with characters that would break or fail SKILL.md frontmatter", () => {
    // displayName is embedded inside double-quoted SKILL.md frontmatter; chars
    // that break the quoting (`"`, `\`) or fail the validator (`<`, `>`) must be
    // rejected at scaffold time, not silently produce an invalid SKILL.md.
    for (const bad of ['Weird "thing"', "back\\slash", "has <angle>", "has >gt"]) {
      expect(() =>
        scaffold({ kind: "skill", name: "sample-tools", displayName: bad, targetParent: root, force: true }),
      ).toThrow(/displayName must not contain/);
    }
  });

  it("a clean displayName still renders a validator-valid SKILL.md", () => {
    const r = scaffold({
      kind: "skill",
      name: "sample-tools",
      displayName: "My Friendly Skill",
      targetParent: root,
      force: true,
    });
    const rel = r.written.find((f) => f.endsWith("SKILL.md"));
    const content = readFileSync(join(r.targetDir, rel), "utf8");
    expect(validateSkillContent(content).valid).toBe(true);
  });
});

describe("placeholder guard (cinatra-cli#44 acceptance)", () => {
  it("detects the un-edited template scaffolding in a freshly rendered SKILL.md", () => {
    // Default scaffold (no --description) ships placeholder copy; the lint must
    // be able to flag it so a real, published package cannot retain it.
    const dir = results.skill.targetDir;
    const rel = listSkillMd(dir)[0];
    const content = readFileSync(join(dir, rel), "utf8");
    expect(findPlaceholders(content).length).toBeGreaterThan(0);
  });

  it("a fully authored SKILL.md trips no placeholder sentinel", () => {
    const authored = [
      "---",
      'name: "my-real-skill"',
      'description: "Summarizes a customer support thread into a single action item."',
      "---",
      "",
      "# My Real Skill",
      "",
      "Given a support thread, return the single highest-priority next action.",
      "",
    ].join("\n");
    expect(findPlaceholders(authored)).toEqual([]);
    expect(validateSkillContent(authored).valid).toBe(true);
  });
});

describe("superset validator — upstream rule parity", () => {
  const FM = (body) => `---\n${body}\n---\n\n# Body\n`;

  it("accepts a minimal valid skill", () => {
    expect(validateSkillContent(FM('name: "a-skill"\ndescription: "Does a thing."')).valid).toBe(
      true,
    );
  });

  it('rejects missing frontmatter ("No YAML frontmatter found")', () => {
    const r = validateSkillContent("# No frontmatter here\n");
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/No YAML frontmatter found/);
  });

  it("rejects an unquoted colon-heavy description (Invalid YAML)", () => {
    // The exact failure the issue cites: an unquoted value with `: ` parses as a
    // nested mapping under safe_load → "Invalid YAML in frontmatter".
    const r = validateSkillContent(
      FM("name: a-skill\ndescription: Stage 0 only: do not act"),
    );
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Invalid YAML in frontmatter/);
  });

  it("rejects an unrendered template placeholder name (Invalid YAML)", () => {
    // `name: {{base}}` (unquoted) is a YAML flow-mapping → invalid. This is the
    // "Invalid YAML in frontmatter" failure the issue reported for templates.
    const r = validateSkillContent(FM("name: {{base}}\ndescription: x"));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Invalid YAML in frontmatter/);
  });

  it("rejects a top-level match_when (must be under metadata)", () => {
    const r = validateSkillContent(
      FM('name: "a-skill"\ndescription: "x"\nmatch_when:\n  - agent_id: "@x/y"'),
    );
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Unexpected key/);
    expect(r.message).toMatch(/metadata/);
  });

  it("rejects a top-level cinatra-watches (must be under metadata)", () => {
    const r = validateSkillContent(
      FM('name: "a-skill"\ndescription: "x"\ncinatra-watches:\n  paths:\n    - src/'),
    );
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Unexpected key/);
  });

  it("ACCEPTS match_when nested under metadata (the Cinatra convention)", () => {
    const r = validateSkillContent(
      FM('name: "a-skill"\ndescription: "x"\nmetadata:\n  match_when:\n    - agent_id: "@x/y"'),
    );
    expect(r.valid, r.message).toBe(true);
  });

  it("ACCEPTS cinatra-watches nested under metadata", () => {
    const r = validateSkillContent(
      FM('name: "a-skill"\ndescription: "x"\nmetadata:\n  cinatra-watches:\n    paths:\n      - src/'),
    );
    expect(r.valid, r.message).toBe(true);
  });

  it("rejects an angle-bracket description", () => {
    const r = validateSkillContent(FM('name: "a-skill"\ndescription: "limit <= 5"'));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/angle brackets/);
  });

  it("rejects a non-hyphen-case name", () => {
    const r = validateSkillContent(FM('name: "A_Skill"\ndescription: "x"'));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/hyphen-case/);
  });

  it("rejects a name with leading/trailing/double hyphen", () => {
    expect(validateSkillContent(FM('name: "-skill"\ndescription: "x"')).valid).toBe(false);
    expect(validateSkillContent(FM('name: "skill-"\ndescription: "x"')).valid).toBe(false);
    expect(validateSkillContent(FM('name: "a--skill"\ndescription: "x"')).valid).toBe(false);
  });

  it("rejects a name longer than 64 characters", () => {
    const longName = "a".repeat(65);
    const r = validateSkillContent(FM(`name: "${longName}"\ndescription: "x"`));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/too long/);
  });

  it("rejects a description longer than 1024 characters", () => {
    const longDesc = "x".repeat(1025);
    const r = validateSkillContent(FM(`name: "a-skill"\ndescription: "${longDesc}"`));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/too long/);
  });

  it("rejects missing name and missing description", () => {
    expect(validateSkillContent(FM('description: "x"')).message).toMatch(/Missing 'name'/);
    expect(validateSkillContent(FM('name: "a-skill"')).message).toMatch(/Missing 'description'/);
  });

  it("allows the full upstream key set at top level", () => {
    const r = validateSkillContent(
      FM(
        [
          'name: "a-skill"',
          'description: "x"',
          'license: "Apache-2.0"',
          'allowed-tools: "Read, Write"',
          "metadata:",
          "  match_when:",
          '    - agent_id: "@x/y"',
        ].join("\n"),
      ),
    );
    expect(r.valid, r.message).toBe(true);
    expect([...ALLOWED_TOP_LEVEL_KEYS].sort()).toEqual([
      "allowed-tools",
      "description",
      "license",
      "metadata",
      "name",
    ]);
  });

  it("parseFrontmatter records a metadata: block without choking on its nesting", () => {
    const p = parseFrontmatter('name: "a-skill"\ndescription: "x"\nmetadata:\n  match_when:\n    - a');
    expect(p.ok).toBe(true);
    expect(p.value.metadata).toEqual({ __block: true });
    expect(p.value.name).toBe("a-skill");
  });
});

describe("superset validator — PyYAML typed-scalar + escape parity (codex review)", () => {
  const FM = (body) => `---\n${body}\n---\n\n# Body\n`;

  it("rejects a bare integer name (typed int, not a string)", () => {
    const r = validateSkillContent(FM("name: 123\ndescription: ok"));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Name must be a string/);
  });

  it("rejects a bare boolean/float/null description (typed, not a string)", () => {
    expect(validateSkillContent(FM("name: a-skill\ndescription: false")).message).toMatch(
      /Description must be a string/,
    );
    expect(validateSkillContent(FM("name: a-skill\ndescription: 3.14")).message).toMatch(
      /Description must be a string/,
    );
    expect(validateSkillContent(FM("name: a-skill\ndescription: null")).message).toMatch(
      /Description must be a string/,
    );
  });

  it("rejects trailing junk after a closing quote", () => {
    const r = validateSkillContent(FM('name: a-skill\ndescription: "x" junk'));
    expect(r.valid).toBe(false);
  });

  it("rejects a unicode-escaped angle bracket in a quoted description", () => {
    // `"<"` decodes to `<`, which the validator rejects — proving escape
    // decoding is faithful (a naive parser would miss this).
    const r = validateSkillContent(FM('name: a-skill\ndescription: "lt \\u003c x"'));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/angle brackets/);
  });

  it("does not treat a # inside quotes as a comment, but does strip a real trailing comment", () => {
    expect(validateSkillContent(FM('name: a-skill\ndescription: "x # not a comment"')).valid).toBe(
      true,
    );
    expect(validateSkillContent(FM("name: a-skill\ndescription: foo # real comment")).valid).toBe(
      true,
    );
  });

  it("rejects an unrendered placeholder nested inside a metadata block", () => {
    const r = validateSkillContent(
      FM("name: a-skill\ndescription: x\nmetadata:\n  match_when: {{x}}"),
    );
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/Invalid YAML/);
  });

  it("resolves YAML 1.1 implicit non-strings exactly like PyYAML (yes/octal/sexagesimal/date)", () => {
    // These all resolve to bool/int/date under safe_load → non-string → reject.
    for (const v of ["yes", "ON", "0x10", "012", "1_000", "1:20", "2026-06-26"]) {
      expect(validateSkillContent(FM(`name: ${v}\ndescription: ok`)).valid, v).toBe(false);
    }
  });

  it("keeps PyYAML-string-resolved bare values as strings (1e3, 1.0e3, my.skill, 0o10)", () => {
    // PyYAML float needs a dot AND a signed exponent, so 1e3 / 1.0e3 are STRINGS;
    // 0o10 (not 0NNN octal) and my.skill are strings too — all must pass.
    for (const v of ["1e3", "1.0e3", "my.skill", "0o10"]) {
      expect(validateSkillContent(FM(`name: a-skill\ndescription: ${v}`)).valid, v).toBe(true);
    }
  });

  it("rejects unknown/truncated double-quote escapes and decodes valid ones", () => {
    expect(validateSkillContent(FM('name: a-skill\ndescription: "bad \\q"')).valid).toBe(false);
    expect(validateSkillContent(FM('name: a-skill\ndescription: "trunc \\u12 x"')).valid).toBe(
      false,
    );
    // \U0000003c decodes to "<" → rejected by the angle-bracket rule.
    const r = validateSkillContent(FM('name: a-skill\ndescription: "x \\U0000003c y"'));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/angle brackets/);
    // a valid \u escape that is harmless passes.
    expect(validateSkillContent(FM('name: a-skill\ndescription: "ok \\u0041 z"')).valid).toBe(true);
  });

  it("rejects PyYAML-invalid nested block syntax (unbalanced flow, in-value colon, tab)", () => {
    expect(
      validateSkillContent(FM("name: a-skill\ndescription: x\nmetadata:\n  foo: [bar")).valid,
    ).toBe(false);
    expect(
      validateSkillContent(FM("name: a-skill\ndescription: x\nmetadata:\n  foo: a: b")).valid,
    ).toBe(false);
    expect(
      validateSkillContent(FM("name: a-skill\ndescription: x\nmetadata:\n\tfoo: bar")).valid,
    ).toBe(false);
  });

  it("ACCEPTS a metadata match_when sequence of agent_id mappings (the template convention)", () => {
    const r = validateSkillContent(
      FM('name: a-skill\ndescription: x\nmetadata:\n  match_when:\n    - agent_id: "@x/y"'),
    );
    expect(r.valid, r.message).toBe(true);
  });
});

describe("superset validator — nested metadata value parity (codex round-4)", () => {
  const FM = (body) => `---\n${body}\n---\n\n# Body\n`;
  const meta = (line) => FM(`name: a-skill\ndescription: x\nmetadata:\n  ${line}`);

  it("rejects a nested value beginning with a YAML indicator (@, *, !, ?)", () => {
    expect(validateSkillContent(meta("owner: @x/y")).valid).toBe(false);
    expect(validateSkillContent(meta("ref: *bar")).valid).toBe(false);
    expect(validateSkillContent(meta("tag: !bar")).valid).toBe(false);
    expect(validateSkillContent(meta("q: ? bar")).valid).toBe(false);
  });

  it("rejects a malformed flow mapping but accepts a well-formed one", () => {
    expect(validateSkillContent(meta("foo: {a: b: c}")).valid).toBe(false);
    expect(validateSkillContent(meta("map: {a: 1, b: 2}")).valid, "well-formed flow map").toBe(true);
    expect(validateSkillContent(meta("list: [a, b, c]")).valid, "flow seq").toBe(true);
  });

  it("validates double-quoted escapes inside a nested value (rejects \\q)", () => {
    expect(validateSkillContent(meta('foo: "\\q"')).valid).toBe(false);
    expect(validateSkillContent(meta('foo: "ok \\u0041"')).valid).toBe(true);
  });

  it("accepts a plain scalar with a mid-value bracket (PyYAML treats it as a string)", () => {
    expect(validateSkillContent(meta("foo: a [ b")).valid, "plain mid-bracket").toBe(true);
    expect(validateSkillContent(meta("multi: hello world foo")).valid).toBe(true);
  });
});

describe("superset validator — flow collection + block-structure parity (codex round-5)", () => {
  const FM = (body) => `---\n${body}\n---\n\n# Body\n`;
  const meta = (line) => FM(`name: a-skill\ndescription: x\nmetadata:\n  ${line}`);

  it("rejects a bad escape, indicator scalar, bad separators, and crossed delimiters INSIDE flow", () => {
    expect(validateSkillContent(meta('xs: ["\\q"]')).valid, "bad escape in flow").toBe(false);
    expect(validateSkillContent(meta("xs: [@foo]")).valid, "indicator in flow").toBe(false);
    expect(validateSkillContent(meta("xs: [a,,b]")).valid, "double comma").toBe(false);
    expect(validateSkillContent(meta("xs: [{]}")).valid, "crossed delimiters").toBe(false);
  });

  it("accepts a quoted colon-string inside a flow sequence (PyYAML treats it as a string)", () => {
    expect(validateSkillContent(meta('xs: ["a: b: c"]')).valid, "quoted colon in flow").toBe(true);
  });

  it("accepts well-formed nested flow collections", () => {
    expect(validateSkillContent(meta("xs: [a, b, c]")).valid).toBe(true);
    expect(validateSkillContent(meta("m: {a: 1, b: 2}")).valid).toBe(true);
    expect(validateSkillContent(meta("nested: [[1, 2], [3, 4]]")).valid).toBe(true);
    expect(validateSkillContent(meta("m: {a: [1, 2]}")).valid).toBe(true);
  });

  it("rejects mixing a block sequence and mapping at the same parent level", () => {
    const r = validateSkillContent(FM("name: a-skill\ndescription: x\nmetadata:\n  - a\n  b: c"));
    expect(r.valid).toBe(false);
    expect(r.message).toMatch(/mixed sequence and mapping/);
  });

  it("rejects an out-of-range timestamp but accepts a valid one", () => {
    expect(validateSkillContent(meta("released: 2026-99-99")).valid, "bad date").toBe(false);
    expect(validateSkillContent(meta("released: 2026-06-26")).valid, "good date").toBe(true);
  });

  it("does not false-reject sibling sub-blocks with different shapes at the same column", () => {
    // match_when (a sequence) and cinatra-watches.paths (a mapping then sequence)
    // are siblings under metadata; their deeper levels share columns but belong to
    // different parents — this must NOT trip the block-mixing guard.
    const r = validateSkillContent(
      FM(
        [
          "name: a-skill",
          "description: x",
          "metadata:",
          "  match_when:",
          '    - agent_id: "@x/y"',
          "  cinatra-watches:",
          "    paths:",
          "      - src/",
        ].join("\n"),
      ),
    );
    expect(r.valid, r.message).toBe(true);
  });
});
