// `cinatra create-extension agent <name> --assistant` — the assistant flavor
// (cinatra#1874 W1, Assistants epic #1873).
//
// An assistant is an `agent`-kind extension whose package-root
// `cinatra/config.json` carries an `assistant` block the host adopts as a
// first-class chat assistant. Asserts, through the SHARED authoring core the
// CLI drives, that `--assistant`:
//   - overlays a well-formed cinatra/config.json onto the agent scaffold
//     (leaving the agent base — including cinatra/oas.json — intact),
//   - the declaration matches the SHARED assistant-declaration parser's field
//     contract (packages/sdk-extensions/src/assistant-declaration.ts on the host
//     — formatVersion/abiVersion EXACTLY 1, an already-normalized flat
//     preferredTag, a non-empty persona + skillBundle, launch/delivery kinds),
//   - carries NO connector `access` block, so the host install-time
//     assistant⊕executor XOR is satisfied,
//   - keeps the generated repo GATE-CLEAN (the config.json is inert to the
//     shipped kind gate; the agent oas.json still validates),
//   - ships the declaration in the npm packlist (package.json#files packs
//     `cinatra`), leaks no non-distributable path, and leaves no unreplaced
//     scaffold token,
//   - and is REJECTED for every non-agent kind.
//
// This is a SHAPE test in the CLI's zero-dependency test idiom: the authoritative
// zod parser is a TypeScript module in the HOST repo (cinatra), not importable
// from this scaffold-only package, and the CLI never depends on @cinatra-ai. The
// field contract asserted here is a byte-for-byte mirror of that parser; the REAL
// generated output was additionally cross-checked at build time against the
// parser's pinned `.mjs` mirror (scripts/audit/connector-access-config-gate.mjs).

import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it, beforeAll } from "vitest";

import { scaffold } from "../src/authoring/scaffold.mjs";
import { runGate } from "../templates/_shared/extension-kind-gate.mjs";

// Mirror of the shared assistant-declaration parser's field contract (host:
// packages/sdk-extensions/src/assistant-declaration.ts). Kept in lock-step with
// that source — do not relax without changing the parser.
const FLAT_TOKEN_RE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const LAUNCH_KINDS = ["local", "remote"];
const DELIVERY_KINDS = ["host-runtime", "webhook", "mcp-poll"];
const MCP_RESTRICTIONS = ["org-members", "platform-admins"];

const NON_DISTRIBUTABLE = [
  /^\.github\//,
  /(^|\/)\.env/,
  /(^|\/)tsconfig.*\.json$/,
  /(^|\/)\.gitattributes$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)renovate\.json$/,
  /(^|\/)extension-kind-gate\.mjs$/,
  /\.test\./,
  /(^|\/)__tests__\//,
];

function packlist(dir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Validate a parsed cinatra/config.json against the assistant-declaration field
 *  contract (the shape the host's shared parser accepts). Returns errors[]. */
function validateAssistantDeclaration(cfg, expectedTag) {
  const errors = [];
  if (cfg.formatVersion !== 1) errors.push(`formatVersion must be EXACTLY 1 (got ${JSON.stringify(cfg.formatVersion)})`);
  if ("access" in cfg) errors.push("assistant flavor must NOT carry a connector `access` block (assistant⊕executor XOR)");
  const a = cfg.assistant;
  if (!a || typeof a !== "object") {
    errors.push("must declare an `assistant` block");
    return errors;
  }
  if (a.abiVersion !== 1) errors.push(`assistant.abiVersion must be EXACTLY 1 (got ${JSON.stringify(a.abiVersion)})`);
  if (typeof a.displayName !== "string" || !a.displayName) errors.push("assistant.displayName must be a non-empty string");
  if (!FLAT_TOKEN_RE.test(a.preferredTag || "")) errors.push(`assistant.preferredTag must be a normalized flat token (got ${JSON.stringify(a.preferredTag)})`);
  if (expectedTag !== undefined && a.preferredTag !== expectedTag) errors.push(`assistant.preferredTag should be the slug base "${expectedTag}" (got ${JSON.stringify(a.preferredTag)})`);
  if (typeof a.persona !== "string" || !a.persona) errors.push("assistant.persona must be a non-empty string");
  if (!Array.isArray(a.skillBundle) || a.skillBundle.length === 0 || !a.skillBundle.every((s) => typeof s === "string" && s)) {
    errors.push("assistant.skillBundle must be a non-empty array of non-empty strings");
  }
  if (!Array.isArray(a.allowedTools)) errors.push("assistant.allowedTools must be an array");
  if (!Array.isArray(a.allowedAgents)) errors.push("assistant.allowedAgents must be an array");
  if (a.modelPrefs === undefined || typeof a.modelPrefs !== "object" || Array.isArray(a.modelPrefs)) errors.push("assistant.modelPrefs must be an object");
  if (a.mcp !== undefined) {
    if (typeof a.mcp !== "object" || a.mcp === null) errors.push("assistant.mcp must be an object");
    else {
      if (a.mcp.enabled !== undefined && typeof a.mcp.enabled !== "boolean") errors.push("assistant.mcp.enabled must be a boolean");
      if (a.mcp.restriction !== undefined && !MCP_RESTRICTIONS.includes(a.mcp.restriction)) errors.push(`assistant.mcp.restriction must be one of ${MCP_RESTRICTIONS.join(" | ")}`);
    }
  }
  if (!a.launch || !LAUNCH_KINDS.includes(a.launch.kind)) errors.push(`assistant.launch.kind must be one of ${LAUNCH_KINDS.join(" | ")}`);
  if (!a.delivery || !DELIVERY_KINDS.includes(a.delivery.kind)) errors.push(`assistant.delivery.kind must be one of ${DELIVERY_KINDS.join(" | ")}`);
  return errors;
}

let root;
let asst;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cinatra-asst-ext-"));
  asst = scaffold({ kind: "agent", name: "sample-assistant", targetParent: root, force: true, assistant: true });
});

describe("agent --assistant: assistant declaration overlay", () => {
  it("overlays cinatra/config.json onto the agent scaffold, leaving the agent base intact", () => {
    const dir = asst.targetDir;
    expect(existsSync(join(dir, "cinatra/config.json"))).toBe(true);
    // The agent base is intact — the assistant is still an agent-kind package.
    expect(existsSync(join(dir, "cinatra/oas.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.cinatra.kind).toBe("agent");
    expect(asst.assistant).toBe(true);
  });

  it("the declaration matches the shared assistant-declaration parser's field contract", () => {
    const cfg = JSON.parse(readFileSync(join(asst.targetDir, "cinatra/config.json"), "utf8"));
    const errors = validateAssistantDeclaration(cfg, "sample-assistant");
    expect(errors, errors.join("\n")).toEqual([]);
    // Sanity on the concrete scaffolded values.
    expect(cfg.assistant.displayName).toBe("Sample Assistant");
    expect(cfg.assistant.preferredTag).toBe("sample-assistant");
    expect(cfg.assistant.launch).toEqual({ kind: "local" });
    expect(cfg.assistant.delivery).toEqual({ kind: "host-runtime" });
  });

  it("carries NO connector access block (the install-time assistant⊕executor XOR holds)", () => {
    const cfg = JSON.parse(readFileSync(join(asst.targetDir, "cinatra/config.json"), "utf8"));
    expect("access" in cfg).toBe(false);
  });

  it("keeps the generated repo gate-clean (config.json is inert to the kind gate)", () => {
    const gate = runGate(asst.targetDir);
    expect(gate.errors, gate.errors.join("\n")).toEqual([]);
    expect(gate.warnings, gate.warnings.join("\n")).toEqual([]);
  });

  it("packs the declaration (package.json#files includes cinatra) and leaks no non-distributable path", () => {
    const pkg = JSON.parse(readFileSync(join(asst.targetDir, "package.json"), "utf8"));
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain("cinatra");
    const files = packlist(asst.targetDir);
    expect(files).toContain("cinatra/config.json");
    for (const f of files) {
      for (const re of NON_DISTRIBUTABLE) expect(re.test(f), `packlist leaks: ${f}`).toBe(false);
    }
  });

  it("leaves no unreplaced scaffold token in the generated config", () => {
    const body = readFileSync(join(asst.targetDir, "cinatra/config.json"), "utf8");
    expect(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(body), "unreplaced token in cinatra/config.json").toBe(false);
  });

  it("matches the golden generated file list (agent base + cinatra/config.json)", () => {
    expect(listFiles(asst.targetDir)).toEqual([
      ".gitattributes",
      ".github/workflows/actions-pinned-gate.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/gitignore-gate.yml",
      ".github/workflows/release.yml",
      ".github/workflows/source-leak-gate.yml",
      ".gitignore",
      ".npmrc",
      "LICENSE",
      "README.md",
      "cinatra/config.json",
      "cinatra/oas.json",
      "extension-kind-gate.mjs",
      "package.json",
      "renovate.json",
      "skills/sample-assistant-agent/SKILL.md",
      "tsconfig.json",
    ]);
  });
});

describe("the assistant flavor is agent-only", () => {
  it.each(["connector", "artifact", "skill"])("rejects --assistant for a non-agent kind (%s)", (kind) => {
    expect(() =>
      scaffold({ kind, name: "sample-thing", targetParent: root, force: true, assistant: true }),
    ).toThrow(/--assistant is only valid for kind "agent"/);
  });
});
