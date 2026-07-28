// The declared skill-edge ROLE on a `cinatra.dependencies` entry (cinatra#2090
// S3 wave 3).
//
// An artifact extension declares TWO skill edges — the rules its classifier
// follows and the methodology the chat follows when a user asks it to author
// one — so the edge carries `role: "matcher" | "authoring"` to say which host
// surface it feeds. Before this suite the gate ACCEPTED the field and validated
// nothing, so a typo'd role passed the author's own CI and only surfaced at
// install, where the host authority
// (`packages/extensions/src/manifest-dependencies.ts validateExtensionDependencyShape`)
// fails the whole manifest read LOUDLY.
//
// This suite is the FIXTURE MATRIX for that mirror. It pins the two problems
// the authority reports, in the authority's own order, and — critically — the
// rules it does NOT impose:
//
//   - a role is keyed on the TARGET KIND only. `edgeType` is NOT part of the
//     rule, so a role on an install-time or peer skill edge is a valid SHAPE
//     here exactly as it is at install. A gate that demanded `runtime` would
//     reject manifests the host accepts.
//   - an ABSENT role stays valid on every edge — the vocabulary is additive,
//     and every edge authored before it (including the wave-2 agent skill
//     edges) must keep passing untouched.
//
// extension-release-tooling vendors this gate; its own suite re-runs the same
// matrix against its copy, so the two cannot silently diverge.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scaffold } from "../src/authoring/scaffold.mjs";
import {
  dependencyRoleProblem,
  isValidDependencyEntry,
} from "../templates/_shared/extension-kind-gate.mjs";

const goodVc = { kind: "semver-range", range: "^1.0.0" };
/** A well-formed edge onto a skill provider; `over` supplies the case. */
const skillEdge = (over = {}) => ({
  packageName: "@cinatra-ai/blog-idea-matcher-skill",
  kind: "skill",
  edgeType: "runtime",
  requirement: "required",
  versionConstraint: goodVc,
  ...over,
});

describe("dependencyRoleProblem (mirror of validateExtensionDependencyShape's role rule)", () => {
  it("accepts both declared roles on a kind:\"skill\" edge", () => {
    expect(dependencyRoleProblem(skillEdge({ role: "matcher" }))).toBeNull();
    expect(dependencyRoleProblem(skillEdge({ role: "authoring" }))).toBeNull();
  });

  it("an ABSENT role stays valid — on a skill edge and on every other kind", () => {
    expect(dependencyRoleProblem(skillEdge())).toBeNull();
    expect(dependencyRoleProblem(skillEdge({ kind: "connector" }))).toBeNull();
    expect(dependencyRoleProblem(skillEdge({ kind: undefined }))).toBeNull();
  });

  it("REFUSES an unknown role value", () => {
    expect(dependencyRoleProblem(skillEdge({ role: "matchr" }))).toBe(
      'role, when present, must be one of matcher|authoring (got "matchr")',
    );
    // A non-string is refused the same way — the set lookup is value-based.
    expect(dependencyRoleProblem(skillEdge({ role: 1 }))).toContain("must be one of matcher|authoring");
    // Refused BEFORE the target-kind check, exactly as the authority orders it:
    // a bad value on a bad kind reports the value.
    expect(dependencyRoleProblem(skillEdge({ kind: "connector", role: "matchr" }))).toContain(
      "must be one of matcher|authoring",
    );
  });

  it("REFUSES a valid role on a non-skill edge, including a kind-LESS edge", () => {
    expect(dependencyRoleProblem(skillEdge({ kind: "connector", role: "matcher" }))).toBe(
      'role is only meaningful on a kind:"skill" edge (got kind "connector")',
    );
    expect(dependencyRoleProblem(skillEdge({ kind: undefined, role: "matcher" }))).toBe(
      'role is only meaningful on a kind:"skill" edge (got kind null)',
    );
  });

  it("does NOT constrain edgeType — the authority keys the rule on kind alone", () => {
    for (const edgeType of ["runtime", "install-time", "peer"]) {
      expect(dependencyRoleProblem(skillEdge({ edgeType, role: "matcher" }))).toBeNull();
    }
    // …and the same edge without a role is likewise untouched.
    expect(dependencyRoleProblem(skillEdge({ edgeType: "peer" }))).toBeNull();
  });
});

describe("isValidDependencyEntry carries the role verdict", () => {
  it("a role-carrying skill edge is a valid entry; a typo'd one is not", () => {
    expect(isValidDependencyEntry(skillEdge({ role: "matcher" }))).toBe(true);
    expect(isValidDependencyEntry(skillEdge({ role: "authoring" }))).toBe(true);
    expect(isValidDependencyEntry(skillEdge({ role: "matchr" }))).toBe(false);
    expect(isValidDependencyEntry(skillEdge({ kind: "artifact", role: "matcher" }))).toBe(false);
  });

  it("every pre-vocabulary edge stays valid (additive, no regression)", () => {
    expect(isValidDependencyEntry(skillEdge())).toBe(true);
    expect(
      isValidDependencyEntry({
        packageName: "@cinatra-ai/web-research-skill",
        kind: "skill",
        edgeType: "runtime",
        requirement: "required",
        versionConstraint: goodVc,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The byte an external author's CI actually executes: `cinatra create-extension`
// copies the shared gate into the generated repo, and THAT copy runs standalone.
// Importing the copied file (not the source template) proves the shipped byte
// carries the rule — the drift class the daily release-template audit flags.
// ---------------------------------------------------------------------------
describe("scaffolded artifact — the COPIED gate validates the edge role", () => {
  let parent;
  let targetDir;
  let pkgPath;
  let pristinePkg;
  let runGate;

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), "cli-2090-role-"));
    const res = scaffold({ kind: "artifact", name: "blog-idea", targetParent: parent });
    expect(res.written).toContain("extension-kind-gate.mjs");
    targetDir = res.targetDir;
    pkgPath = join(targetDir, "package.json");
    pristinePkg = readFileSync(pkgPath, "utf8");
    ({ runGate } = await import(pathToFileURL(join(targetDir, "extension-kind-gate.mjs")).href));
  });

  afterAll(() => {
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  /** Reset to the pristine scaffold, set cinatra.dependencies, run the COPY. */
  function runWithDeps(deps) {
    const pkg = JSON.parse(pristinePkg);
    pkg.cinatra.dependencies = deps;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    return runGate(targetDir);
  }

  it("accepts the wave-3 shape: a matcher edge and an authoring edge side by side", () => {
    const { errors } = runWithDeps([
      skillEdge({ role: "matcher" }),
      skillEdge({ packageName: "@cinatra-ai/blog-idea-authoring-skill", role: "authoring" }),
    ]);
    expect(errors.filter((e) => e.includes("dependencies"))).toEqual([]);
  });

  it("fails a typo'd role with the PRECISE message, not the generic shape message", () => {
    const { errors } = runWithDeps([skillEdge({ role: "matchr" })]);
    const dep = errors.find((e) => e.startsWith("cinatra.dependencies[0] is malformed"));
    expect(dep).toBeDefined();
    expect(dep).toContain("role, when present, must be one of matcher|authoring");
    expect(dep).not.toContain("need {packageName");
  });

  it("fails a role declared on a non-skill edge", () => {
    const { errors } = runWithDeps([
      skillEdge({ packageName: "@cinatra-ai/crm-connector", kind: "connector", role: "matcher" }),
    ]);
    const dep = errors.find((e) => e.startsWith("cinatra.dependencies[0] is malformed"));
    expect(dep).toBeDefined();
    expect(dep).toContain('role is only meaningful on a kind:"skill" edge');
  });

  it("a role-less dependency array is untouched by the new rule", () => {
    const { errors } = runWithDeps([skillEdge()]);
    expect(errors.filter((e) => e.includes("dependencies"))).toEqual([]);
  });
});
