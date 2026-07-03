// Layer-1 artifact-parity — self-verifying tests for the CANONICAL gate.
//
// The canonical `templates/_shared/extension-kind-gate.mjs` owns the Layer-1
// artifact-materialization parity screen (produces ⇒ a runnable EndNode binding
// or artifact_materialize node; binding/node validity; extension∈produces;
// riskClass:read_only on a write-seam tool). It mirrors a STATIC SUBSET of the
// host binding grammar (cinatra#923/#925). The rollout is a ratchet: ADVISORY
// (warning) by default so the un-migrated fleet never reddens; hard ERROR under
// `--enforce-artifact-parity` / env CINATRA_ARTIFACT_PARITY=block (BLOCK on
// republish). extension-release-tooling VENDORS this gate byte-for-byte and
// re-runs the same checks; these tests keep the canonical honest on its own.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgs,
  runGate,
  collectArtifactParityFindings,
  collectArtifactBindings,
  collectArtifactMaterializeNodes,
  findReadonlyWriteToolMislabels,
  normalizeProduces,
  validateArtifactBindingShape,
  ARTIFACT_AUTHORABLE_MIMES,
  ARTIFACT_WRITE_SEAM_TOOLS,
} from "../templates/_shared/extension-kind-gate.mjs";

const EXT = "@cinatra-ai/blog-post-artifact";
const VALID_BINDING = { extension: EXT, contentFrom: "draft", declaredMime: "text/markdown", titleFrom: "title" };
const VALID_MAT_INPUT = { extension: EXT, content: "{{ draft }}", title: "{{ title }}", declaredMime: "text/markdown", node_id: "persist" };
const GOOD_README = `# Example Extension

This extension does a useful, value-forward thing for the workspace. It is a
faithful fixture that satisfies the marketplace README contract so the validator
accepts it as a valid example for the test suite.

## Capabilities

- Does the first useful thing for the user
- Does a second useful thing as well
`;

function endNodeFlow(outputs, extra = {}) {
  return { component_type: "Flow", id: "flow", $referenced_components: { end: { component_type: "EndNode", id: "end", name: "End", outputs }, ...extra } };
}
function materializeFlow(input, nodeId = "persist") {
  return { component_type: "Flow", id: "flow", $referenced_components: { [nodeId]: { component_type: "ApiNode", id: nodeId, name: nodeId, url: "{{X}}/api/agents/passthrough", data: { tool: "artifact_materialize", input } } } };
}
function writeAgent(dir, { produces, oas } = {}) {
  const cinatra = { apiVersion: "cinatra.ai/v1", kind: "agent", dependencies: [] };
  if (produces !== undefined) cinatra.produces = produces;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@cinatra-ai/example-agent", license: "Apache-2.0", cinatra }, null, 2));
  writeFileSync(join(dir, "README.md"), GOOD_README);
  if (oas !== undefined) {
    mkdirSync(join(dir, "cinatra"), { recursive: true });
    writeFileSync(join(dir, "cinatra", "oas.json"), JSON.stringify(oas));
  }
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cli-parity-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.CINATRA_ARTIFACT_PARITY;
});

describe("normalizeProduces (on-disk [{extension}] shape)", () => {
  it("normalizes objects and bare strings; null when absent; empty set when malformed/empty", () => {
    expect([...normalizeProduces({ produces: [{ extension: EXT }] })]).toEqual([EXT]);
    expect([...normalizeProduces({ produces: [EXT] })]).toEqual([EXT]);
    expect(normalizeProduces({})).toBeNull();
    expect(normalizeProduces({ produces: "x" }).size).toBe(0);
    expect(normalizeProduces({ produces: [] }).size).toBe(0);
  });
});

describe("validateArtifactBindingShape", () => {
  it("accepts valid declaredMime + mimeFrom bindings", () => {
    expect(validateArtifactBindingShape(VALID_BINDING)).toEqual([]);
    expect(validateArtifactBindingShape({ extension: EXT, contentFrom: "draft", mimeFrom: "mime", titleFrom: "title" })).toEqual([]);
  });
  it("rejects unknown field, both/neither mime, non-authorable mime, empty required", () => {
    expect(validateArtifactBindingShape({ ...VALID_BINDING, nope: 1 }).some((s) => /unknown field/.test(s))).toBe(true);
    expect(validateArtifactBindingShape({ ...VALID_BINDING, mimeFrom: "m" }).some((s) => /exactly one/.test(s))).toBe(true);
    expect(validateArtifactBindingShape({ extension: EXT, contentFrom: "d", titleFrom: "t" }).some((s) => /exactly one/.test(s))).toBe(true);
    expect(validateArtifactBindingShape({ ...VALID_BINDING, declaredMime: "image/png" }).some((s) => /not text-authorable/.test(s))).toBe(true);
    expect(validateArtifactBindingShape({ ...VALID_BINDING, titleFrom: "" }).some((s) => /titleFrom/.test(s))).toBe(true);
  });
  it("pins the authorable-mime universe", () => {
    expect([...ARTIFACT_AUTHORABLE_MIMES].sort()).toEqual(["application/json", "application/xml", "text/html", "text/markdown", "text/plain"]);
  });
});

describe("collectArtifactBindings", () => {
  it("accepts a valid binding, rejects a non-produces extension + a foreign-EndNode ref, and is EndNode-scoped", () => {
    const ok = endNodeFlow([{ title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } }, { title: "title", type: "string" }]);
    expect(collectArtifactBindings(ok, new Set([EXT])).errors).toEqual([]);
    expect(collectArtifactBindings(ok, new Set(["@cinatra-ai/other"])).errors[0]).toContain("cinatra.produces");
    const badRef = endNodeFlow([{ title: "draft", type: "string", cinatra: { artifact: { ...VALID_BINDING, contentFrom: "ghost" } } }, { title: "title", type: "string" }]);
    expect(collectArtifactBindings(badRef, new Set([EXT])).errors.some((e) => /does not name an output/.test(e))).toBe(true);
    const onApiNode = endNodeFlow([{ title: "draft", type: "string" }], { mid: { component_type: "ApiNode", id: "mid", outputs: [{ title: "x", cinatra: { artifact: VALID_BINDING } }] } });
    expect(collectArtifactBindings(onApiNode, new Set([EXT])).attempted).toBe(0);
  });
});

describe("collectArtifactMaterializeNodes", () => {
  it("accepts a valid node and rejects templated extension / bad node_id / non-authorable mime / missing content", () => {
    expect(collectArtifactMaterializeNodes(materializeFlow(VALID_MAT_INPUT), new Set([EXT])).errors).toEqual([]);
    expect(collectArtifactMaterializeNodes(materializeFlow({ ...VALID_MAT_INPUT, extension: "{{e}}" }), null).errors.some((e) => /literal artifact-extension/.test(e))).toBe(true);
    expect(collectArtifactMaterializeNodes(materializeFlow({ ...VALID_MAT_INPUT, node_id: "other" }), null).errors.some((e) => /must equal this ApiNode's id/.test(e))).toBe(true);
    expect(collectArtifactMaterializeNodes(materializeFlow({ ...VALID_MAT_INPUT, declaredMime: "image/png" }), null).errors.some((e) => /not text-authorable/.test(e))).toBe(true);
    expect(collectArtifactMaterializeNodes(materializeFlow({ ...VALID_MAT_INPUT, content: "" }), null).errors.some((e) => /content/.test(e))).toBe(true);
  });
});

describe("findReadonlyWriteToolMislabels (keyed on tool, not name)", () => {
  const flow = (tool, riskClass, url = "{{X}}/api/agents/passthrough") => ({ component_type: "Flow", $referenced_components: { write: { component_type: "ApiNode", id: "write", name: "write", url, data: url.includes("passthrough") ? { tool, input: {} } : null, metadata: { cinatra: { riskClass } } } } });
  it("flags a write-seam tool stamped read_only; ignores correct labels, non-write tools, and the llm-bridge write node", () => {
    expect(findReadonlyWriteToolMislabels(flow("objects_save", "read_only")).length).toBe(1);
    expect(findReadonlyWriteToolMislabels(flow("artifact_materialize", "read_only")).length).toBe(1);
    expect(findReadonlyWriteToolMislabels(flow("objects_save", "high"))).toEqual([]);
    expect(findReadonlyWriteToolMislabels(flow("web_search", "read_only"))).toEqual([]);
    expect(findReadonlyWriteToolMislabels(flow("objects_save", "read_only", "{{X}}/api/llm-bridge"))).toEqual([]);
  });
  it("pins the write-seam tool set", () => {
    expect([...ARTIFACT_WRITE_SEAM_TOOLS].sort()).toEqual(["artifact_authoring_emit", "artifact_materialize", "objects_save"]);
  });
});

describe("parseArgs + runGate: the WARN→BLOCK ratchet", () => {
  it("parseArgs reads the flag and env", () => {
    expect(parseArgs([]).enforceArtifactParity).toBe(false);
    expect(parseArgs(["--enforce-artifact-parity"]).enforceArtifactParity).toBe(true);
    process.env.CINATRA_ARTIFACT_PARITY = "block";
    expect(parseArgs([]).enforceArtifactParity).toBe(true);
  });

  it("un-migrated producer WARNs by default and ERRORs under enforcement", () => {
    writeAgent(tmp, { produces: [{ extension: EXT }], oas: endNodeFlow([{ title: "draft", type: "string" }]) });
    const warn = runGate(tmp);
    expect(warn.errors).toEqual([]);
    expect(warn.warnings.some((w) => w.includes("no runnable materialization"))).toBe(true);
    expect(runGate(tmp, { enforceArtifactParity: true }).errors.some((e) => e.includes("no runnable materialization"))).toBe(true);
  });

  it("migrated producer (valid EndNode binding) passes in both modes", () => {
    const oas = endNodeFlow([{ title: "draft", type: "string", cinatra: { artifact: VALID_BINDING } }, { title: "title", type: "string" }]);
    writeAgent(tmp, { produces: [{ extension: EXT }], oas });
    expect(runGate(tmp).errors).toEqual([]);
    expect(runGate(tmp, { enforceArtifactParity: true }).errors).toEqual([]);
  });

  it("collectArtifactParityFindings no-ops for non-agents and for agents without produces", () => {
    expect(collectArtifactParityFindings(tmp, { cinatra: { kind: "connector", produces: [{ extension: EXT }] } })).toEqual([]);
    writeAgent(tmp, { oas: endNodeFlow([{ title: "draft", type: "string" }]) });
    expect(collectArtifactParityFindings(tmp, { cinatra: { kind: "agent" } })).toEqual([]);
  });
});
