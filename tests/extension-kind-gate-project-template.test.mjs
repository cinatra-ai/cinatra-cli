// Project-template sidecar validation in the shipped extension-kind-gate.
//
// An agent extension may ship a typed `cinatra/project-template.json` (the
// authoritative task graph a project-manager agent materializes into a PM
// store). The AUTHORITATIVE enforcers live in the cinatra monorepo —
// packages/sdk-extensions/src/project-template-contract.ts
// (validateProjectTemplate + the exact-match worker-ref rule
// checkTemplateWorkerRefsAgainstDependencies), wired into the install
// pipeline by packages/agents/src/install-from-package.ts — and REFUSE the
// install of a violating package. This gate mirrors those rules so an author
// catches the refusal pre-publish; this suite is the fixture matrix pinning
// the mirror to the host's violation codes (the bracketed [code] tokens
// mirror the host codes one-to-one).
//
// Matrix: a fully-valid template (structural + exact-match) passes; each
// drift axis has a negative fixture — format tag, duplicate/invalid task ids,
// unknown/self/cyclic dependencies, non-integer offsets, due-before-start,
// inconsistent role binding, worker ref missing from cinatra.dependencies,
// and a version-constraint mismatch (name-match alone is NOT enough).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  validateProjectTemplateObject,
  checkTemplateWorkerRefsAgainstManifest,
  validateProjectTemplateSidecar,
  validateAgent,
} from "../templates/_shared/extension-kind-gate.mjs";

const WORKER_PKG = "@cinatra-ai/draft-writer-agent";

const validTemplate = () => ({
  formatVersion: PROJECT_TEMPLATE_FORMAT_VERSION,
  id: "launch-plan",
  name: "Launch plan",
  anchor: { id: "launch" },
  tasks: [
    {
      id: "draft",
      title: "Write the draft",
      schedule: { startOffsetDays: -10, dueOffsetDays: -5 },
      worker: {
        role: "draft-writer",
        packageName: WORKER_PKG,
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    },
    {
      id: "review",
      title: "Human review",
      dependsOn: ["draft"],
      approval: { id: "sign-off" },
      acceptance: [{ id: "published", description: "The post is live" }],
    },
  ],
});

const matchingEdge = () => ({
  packageName: WORKER_PKG,
  kind: "agent",
  edgeType: "runtime",
  versionConstraint: { kind: "exact", version: "1.0.0" },
  requirement: "required",
});

describe("validateProjectTemplateObject (host validateProjectTemplate mirror)", () => {
  it("accepts a fully-valid template", () => {
    expect(validateProjectTemplateObject(validTemplate())).toEqual([]);
  });

  it("collects ALL violations (never first-error-only)", () => {
    const t = validTemplate();
    t.formatVersion = "wrong";
    t.tasks[1].dependsOn = ["nonexistent"];
    const errors = validateProjectTemplateObject(t);
    expect(errors.some((e) => e.includes("[bad_format_version]"))).toBe(true);
    expect(errors.some((e) => e.includes("[unknown_dependency]"))).toBe(true);
  });

  it("rejects duplicate and pattern-invalid task ids", () => {
    const t = validTemplate();
    t.tasks[1].id = "draft";
    expect(validateProjectTemplateObject(t).some((e) => e.includes("[duplicate_task_id]"))).toBe(true);
    const t2 = validTemplate();
    t2.tasks[0].id = "has/separator";
    expect(validateProjectTemplateObject(t2).some((e) => e.includes("[bad_task_id]"))).toBe(true);
  });

  it("rejects self- and cyclic dependencies", () => {
    const t = validTemplate();
    t.tasks[0].dependsOn = ["draft"];
    expect(validateProjectTemplateObject(t).some((e) => e.includes("[self_dependency]"))).toBe(true);
    const t2 = validTemplate();
    t2.tasks[0].dependsOn = ["review"]; // review already dependsOn draft → cycle
    expect(validateProjectTemplateObject(t2).some((e) => e.includes("[cyclic_dependencies]"))).toBe(true);
  });

  it("rejects non-integer offsets and due-before-start (both reported together)", () => {
    const t = validTemplate();
    t.tasks[0].schedule = { startOffsetDays: 1.5, dueOffsetDays: -2 };
    const errors = validateProjectTemplateObject(t);
    expect(errors.some((e) => e.includes("[bad_offset]"))).toBe(true);
    expect(errors.some((e) => e.includes("[due_before_start]"))).toBe(true);
  });

  it("rejects a role bound to two different packages (ambiguous dispatch target)", () => {
    const t = validTemplate();
    t.tasks[1] = {
      id: "second",
      title: "Second",
      worker: {
        role: "draft-writer",
        packageName: "@cinatra-ai/other-agent",
        versionConstraint: { kind: "exact", version: "1.0.0" },
      },
    };
    expect(
      validateProjectTemplateObject(t).some((e) => e.includes("[inconsistent_worker_role]")),
    ).toBe(true);
  });

  it("rejects a malformed worker version constraint", () => {
    const t = validTemplate();
    t.tasks[0].worker.versionConstraint = { kind: "semver-range" }; // missing range
    expect(validateProjectTemplateObject(t).some((e) => e.includes("[bad_worker_version]"))).toBe(true);
  });
});

describe("checkTemplateWorkerRefsAgainstManifest (host exact-match rule mirror)", () => {
  it("passes when every worker ref exact-matches an edge", () => {
    expect(checkTemplateWorkerRefsAgainstManifest(validTemplate(), [matchingEdge()])).toEqual([]);
  });

  it("fails a worker ref absent from cinatra.dependencies", () => {
    const errors = checkTemplateWorkerRefsAgainstManifest(validTemplate(), []);
    expect(errors.some((e) => e.includes("[worker_not_in_dependencies]"))).toBe(true);
  });

  it("fails a version-constraint mismatch — name-match alone is NOT enough", () => {
    const edge = matchingEdge();
    edge.versionConstraint = { kind: "exact", version: "2.0.0" };
    const errors = checkTemplateWorkerRefsAgainstManifest(validTemplate(), [edge]);
    expect(errors.some((e) => e.includes("[worker_version_mismatch]"))).toBe(true);
  });

  it("fails a constraint-KIND mismatch (structural equality, not string looseness)", () => {
    const edge = matchingEdge();
    edge.versionConstraint = { kind: "semver-range", range: "1.0.0" };
    const errors = checkTemplateWorkerRefsAgainstManifest(validTemplate(), [edge]);
    expect(errors.some((e) => e.includes("[worker_version_mismatch]"))).toBe(true);
  });
});

describe("validateProjectTemplateSidecar / validateAgent wiring (on-disk fixtures)", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kind-gate-template-"));
    mkdirSync(join(dir, "cinatra"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writePkg = (deps) =>
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@cinatra-ai/release-announcement-agent",
        version: "1.0.0",
        cinatra: { kind: "agent", apiVersion: "cinatra.ai/v1", dependencies: deps },
      }),
    );
  const writeTemplate = (t) =>
    writeFileSync(join(dir, "cinatra", "project-template.json"), JSON.stringify(t));

  it("no template file → no errors (not a project-template package)", () => {
    writePkg([matchingEdge()]);
    expect(validateProjectTemplateSidecar(dir)).toEqual([]);
  });

  it("valid template + matching edge → passes through validateAgent", () => {
    writePkg([matchingEdge()]);
    writeTemplate(validTemplate());
    expect(validateAgent(dir)).toEqual([]);
  });

  it("worker ref missing from the manifest edges → the agent gate FAILS", () => {
    writePkg([]);
    writeTemplate(validTemplate());
    const errors = validateAgent(dir);
    expect(errors.some((e) => e.includes("[worker_not_in_dependencies]"))).toBe(true);
  });

  it("unparsable template JSON → structured [template_unparsable] error", () => {
    writePkg([matchingEdge()]);
    writeFileSync(join(dir, "cinatra", "project-template.json"), "{ not json");
    const errors = validateProjectTemplateSidecar(dir);
    expect(errors.some((e) => e.includes("[template_unparsable]"))).toBe(true);
  });

  it("structural violations preempt the worker-ref pass (matches the host's staged refusal)", () => {
    writePkg([matchingEdge()]);
    const t = validTemplate();
    t.tasks = [];
    writeTemplate(t);
    const errors = validateProjectTemplateSidecar(dir);
    expect(errors.some((e) => e.includes("[no_tasks]"))).toBe(true);
    expect(errors.some((e) => e.includes("[worker_not_in_dependencies]"))).toBe(false);
  });
});
