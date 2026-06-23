import { describe, it, expect, vi, beforeEach } from "vitest";
import { __test } from "../src/agents-install.mjs";

describe("agents-install argv parsing", () => {
  it("parses --dry-run flag", () => {
    const f = __test.parseArgv(["@cinatra/a@^1.0.0", "--dry-run"]);
    expect(f.dryRun).toBe(true);
    expect(f.rootSpec).toBe("@cinatra/a@^1.0.0");
  });
  it("parses --lockfile-only", () => {
    const f = __test.parseArgv(["@cinatra/a", "--lockfile-only"]);
    expect(f.lockfileOnly).toBe(true);
  });
  it("rejects unknown flag", () => {
    const f = __test.parseArgv(["@cinatra/a", "--nonsense"]);
    expect(f.__error).toContain("Unknown flag");
  });
});

describe("agents-install spec parsing", () => {
  it("splits scoped name and range", () => {
    expect(__test.parseSpec("@cinatra/foo@^1.0.0")).toEqual({
      name: "@cinatra/foo",
      range: "^1.0.0",
    });
  });
  it("defaults range to * when absent", () => {
    expect(__test.parseSpec("@cinatra/foo")).toEqual({
      name: "@cinatra/foo",
      range: "*",
    });
  });
  it("throws on empty range after @", () => {
    expect(() => __test.parseSpec("@cinatra/foo@")).toThrow(/empty version range/);
  });
  it("throws on empty string", () => {
    expect(() => __test.parseSpec("")).toThrow();
  });
});

describe("agents-install redactToken", () => {
  it("replaces token with ***", () => {
    expect(__test.redactToken("auth failed with tok_abcd", "tok_abcd")).toContain("***");
    expect(__test.redactToken("auth failed with tok_abcd", "tok_abcd")).not.toContain(
      "tok_abcd",
    );
  });
  it("returns input unchanged when token is null", () => {
    expect(__test.redactToken("abc", null)).toBe("abc");
  });
});

describe("agents-install lockfileToTree", () => {
  it("converts a lockfile into a DependencyTree-like shape", () => {
    const lf = {
      lockfileVersion: 1,
      root: { packageName: "@cinatra/a", packageVersion: "1.0.0" },
      packages: {
        "@cinatra/a": {
          version: "1.0.0",
          resolved: "http://x/a.tgz",
          integrity: "sha512-AA",
          dependencies: { "@cinatra/b": "1.0.0" },
        },
        "@cinatra/b": {
          version: "1.0.0",
          resolved: "http://x/b.tgz",
          integrity: "sha512-BB",
        },
      },
    };
    const tree = __test.lockfileToTree(lf);
    expect(tree.all.size).toBe(2);
    expect(tree.root.packageName).toBe("@cinatra/a");
    expect(tree.all.get("@cinatra/b").integrity).toBe("sha512-BB");
  });
});

describe("runAgentsInstall exit paths", () => {
  beforeEach(() => vi.resetModules());

  it("exits 1 on no args", async () => {
    const { runAgentsInstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    await runAgentsInstall([], {
      exit,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 on unknown flag", async () => {
    const { runAgentsInstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    await runAgentsInstall(["--nope"], {
      exit,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 on empty-range spec", async () => {
    const { runAgentsInstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stderr = { write: vi.fn() };
    await runAgentsInstall(["@cinatra/foo@"], {
      exit,
      stderr,
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
    const errMsg = stderr.write.mock.calls.map((c) => c[0]).join("");
    expect(errMsg).toMatch(/empty version range/);
  });

  // The thin CLI resolves the connector catalog (@cinatra-ai/connectors-catalog)
  // from the operator's CHECKOUT before any fresh tree resolution. With no
  // checkout root available, that config step fails fast with exit 4 (config
  // missing) — BEFORE any registry/network work. (The previous two cases here
  // mocked `@cinatra/agent-builder`, a module the current source never imports;
  // they were dead and are replaced by this contract assertion.)
  it("exits 4 (config) when no checkout root is available to resolve the connector catalog", async () => {
    const { runAgentsInstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stderr = { write: vi.fn() };
    await runAgentsInstall(
      ["@cinatra/a@^1.0.0", "--registry-url", "http://localhost:4873"],
      { exit, stderr, stdout: { write: vi.fn() }, repoRoot: undefined },
    );
    expect(exit).toHaveBeenCalledWith(4);
    const errMsg = stderr.write.mock.calls.map((c) => c[0]).join("");
    expect(errMsg).toMatch(/connector catalog|checkout/i);
  });
});

// ---------------------------------------------------------------------------
// inputSchema fallback derivation
// ---------------------------------------------------------------------------

describe("deriveInputSchemaFromOas", () => {
  function makeOas({ inputs, required = [], hidden = [] }) {
    return {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs,
          metadata: { cinatra: { required, hidden } },
        },
      },
    };
  }

  it("returns null for non-Flow input", () => {
    expect(__test.deriveInputSchemaFromOas(null)).toBeNull();
    expect(__test.deriveInputSchemaFromOas({ component_type: "Agent" })).toBeNull();
    expect(__test.deriveInputSchemaFromOas("not an object")).toBeNull();
  });

  it("returns null when start_node ref doesn't resolve", () => {
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "missing" },
      $referenced_components: { other: { component_type: "StartNode" } },
    };
    expect(__test.deriveInputSchemaFromOas(oas)).toBeNull();
  });

  it("returns null when resolved component isn't a StartNode", () => {
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "agent" },
      $referenced_components: { agent: { component_type: "Agent" } },
    };
    expect(__test.deriveInputSchemaFromOas(oas)).toBeNull();
  });

  it("extracts required[] from StartNode.metadata.cinatra.required", () => {
    const oas = makeOas({
      inputs: [
        { title: "url", type: "string", format: "uri" },
        { title: "agent_run_id", type: "string", default: "" },
      ],
      required: ["url"],
      hidden: ["agent_run_id"],
    });
    const schema = __test.deriveInputSchemaFromOas(oas);
    expect(schema).toEqual({
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" },
        agent_run_id: { type: "string" },
      },
    });
  });

  it("preserves description field on properties when present", () => {
    const oas = makeOas({
      inputs: [{ title: "url", type: "string", description: "Page URL to fetch." }],
      required: ["url"],
    });
    const schema = __test.deriveInputSchemaFromOas(oas);
    expect(schema.properties.url.description).toBe("Page URL to fetch.");
  });

  it("defaults required to [] when StartNode metadata absent", () => {
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs: [{ title: "url", type: "string" }],
        },
      },
    };
    const schema = __test.deriveInputSchemaFromOas(oas);
    expect(schema.required).toEqual([]);
    expect(schema.properties.url).toEqual({ type: "string" });
  });

  it("skips malformed input entries", () => {
    const oas = makeOas({
      inputs: [
        { title: "valid", type: "string" },
        { /* missing title */ type: "string" },
        null,
        "not an object",
      ],
      required: ["valid"],
    });
    const schema = __test.deriveInputSchemaFromOas(oas);
    expect(Object.keys(schema.properties)).toEqual(["valid"]);
  });
});

describe("pickInputSchema fallback chain", () => {
  it("prefers compiled agent.template.inputSchema when non-empty", () => {
    const agent = {
      template: {
        inputSchema: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string" } },
        },
      },
    };
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs: [{ title: "different", type: "number" }],
          metadata: { cinatra: { required: ["different"] } },
        },
      },
    };
    expect(__test.pickInputSchema(agent, oas)).toEqual(agent.template.inputSchema);
  });

  it("falls back to OAS derivation when agent.template.inputSchema is empty {}", () => {
    const agent = { template: { inputSchema: {} } };
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs: [{ title: "url", type: "string", format: "uri" }],
          metadata: { cinatra: { required: ["url"] } },
        },
      },
    };
    const schema = __test.pickInputSchema(agent, oas);
    expect(schema.required).toEqual(["url"]);
    expect(schema.properties.url).toEqual({ type: "string", format: "uri" });
  });

  it("falls back when agent.template.inputSchema has only empty required[]", () => {
    const agent = {
      template: { inputSchema: { required: [], properties: {} } },
    };
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs: [{ title: "url", type: "string" }],
          metadata: { cinatra: { required: ["url"] } },
        },
      },
    };
    const schema = __test.pickInputSchema(agent, oas);
    expect(schema.required).toEqual(["url"]);
  });

  it("falls back when agent.json is null entirely", () => {
    const oas = {
      component_type: "Flow",
      start_node: { $component_ref: "start" },
      $referenced_components: {
        start: {
          component_type: "StartNode",
          inputs: [{ title: "url", type: "string" }],
          metadata: { cinatra: { required: ["url"] } },
        },
      },
    };
    const schema = __test.pickInputSchema(null, oas);
    expect(schema.required).toEqual(["url"]);
  });

  it("returns {} when both agent and OAS are unusable", () => {
    expect(__test.pickInputSchema(null, null)).toEqual({});
    expect(__test.pickInputSchema(null, { component_type: "Agent" })).toEqual({});
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(__test.safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  it("returns null on malformed JSON instead of throwing", () => {
    expect(__test.safeJsonParse("{not json")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// agents list / uninstall — pure read-model + lockfile-pruning helpers.
// ---------------------------------------------------------------------------

describe("summarizeLockfilePackages", () => {
  const lf = {
    lockfileVersion: 2,
    root: { packageName: "@cinatra/a", version: "1.2.0" },
    packages: {
      "@cinatra/b": { version: "2.0.0" },
      "@cinatra/a": { version: "1.2.0" },
    },
  };

  it("returns rows sorted by package name with the root flagged", () => {
    expect(__test.summarizeLockfilePackages(lf)).toEqual([
      { packageName: "@cinatra/a", version: "1.2.0", root: true },
      { packageName: "@cinatra/b", version: "2.0.0", root: false },
    ]);
  });

  it("returns [] for null / packageless lockfiles", () => {
    expect(__test.summarizeLockfilePackages(null)).toEqual([]);
    expect(__test.summarizeLockfilePackages({})).toEqual([]);
    expect(__test.summarizeLockfilePackages({ packages: null })).toEqual([]);
  });

  it("tolerates a missing version field", () => {
    const rows = __test.summarizeLockfilePackages({ packages: { "@cinatra/x": {} } });
    expect(rows).toEqual([{ packageName: "@cinatra/x", version: "", root: false }]);
  });
});

describe("removeLockfilePackage", () => {
  const base = {
    lockfileVersion: 2,
    root: { packageName: "@cinatra/a", version: "1.0.0" },
    packages: { "@cinatra/a": { version: "1.0.0" }, "@cinatra/b": { version: "1.0.0" } },
  };

  it("removes the named package without mutating the input", () => {
    const { lockfile, removed } = __test.removeLockfilePackage(base, "@cinatra/b");
    expect(removed).toBe(true);
    expect(Object.keys(lockfile.packages)).toEqual(["@cinatra/a"]);
    // input untouched
    expect(Object.keys(base.packages)).toEqual(["@cinatra/a", "@cinatra/b"]);
  });

  it("reports removed:false for an absent package", () => {
    const { removed } = __test.removeLockfilePackage(base, "@cinatra/zzz");
    expect(removed).toBe(false);
  });

  it("is a no-op for a packageless lockfile", () => {
    const { removed } = __test.removeLockfilePackage({}, "@cinatra/a");
    expect(removed).toBe(false);
  });
});

describe("runAgentsList", () => {
  beforeEach(() => vi.resetModules());

  it("exits 1 on an unknown flag", async () => {
    const { runAgentsList } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    await runAgentsList(["--nope"], { exit, stderr: { write: vi.fn() }, stdout: { write: vi.fn() } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports an empty set (exit 0) when no lockfile exists", async () => {
    const { runAgentsList } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stdout = { write: vi.fn() };
    await runAgentsList(["--lockfile", "/nonexistent/path/cinatra-agents.lock"], {
      exit,
      stderr: { write: vi.fn() },
      stdout,
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(stdout.write.mock.calls.map((c) => c[0]).join("")).toMatch(/No agents installed/);
  });
});

describe("runAgentsUninstall", () => {
  beforeEach(() => vi.resetModules());

  it("exits 1 with usage when no package name is given", async () => {
    const { runAgentsUninstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stderr = { write: vi.fn() };
    await runAgentsUninstall([], { exit, stderr, stdout: { write: vi.fn() } });
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.write.mock.calls.map((c) => c[0]).join("")).toMatch(/Usage:/);
  });

  it("rejects --keep-db with --keep-lockfile (exit 1)", async () => {
    const { runAgentsUninstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    await runAgentsUninstall(["@cinatra/a", "--keep-db", "--keep-lockfile"], {
      exit,
      stderr: { write: vi.fn() },
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("rejects --lockfile with a flag-like next token instead of consuming it (no DB delete)", async () => {
    // Guard against `uninstall @a --lockfile --keep-db` swallowing --keep-db as
    // the path: that would leave keepDb=false and proceed to a DB delete the
    // user meant to skip. Must be a usage error (exit 1) BEFORE any DB work.
    const { runAgentsUninstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stderr = { write: vi.fn() };
    await runAgentsUninstall(["@cinatra/a", "--lockfile", "--keep-db"], {
      exit,
      stderr,
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.write.mock.calls.map((c) => c[0]).join("")).toMatch(/Missing value for --lockfile/);
  });

  it("rejects extra positionals (exit 1)", async () => {
    const { runAgentsUninstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stderr = { write: vi.fn() };
    await runAgentsUninstall(["@cinatra/a", "@cinatra/b", "--keep-db"], {
      exit,
      stderr,
      stdout: { write: vi.fn() },
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.write.mock.calls.map((c) => c[0]).join("")).toMatch(/exactly one <name>/);
  });

  it("--keep-db with no lockfile entry reports not-installed (exit 0, no DB needed)", async () => {
    const { runAgentsUninstall } = await import("../src/agents-install.mjs");
    const exit = vi.fn();
    const stdout = { write: vi.fn() };
    await runAgentsUninstall(
      ["@cinatra/absent", "--keep-db", "--lockfile", "/nonexistent/path/cinatra-agents.lock"],
      { exit, stderr: { write: vi.fn() }, stdout },
    );
    expect(exit).toHaveBeenCalledWith(0);
    expect(stdout.write.mock.calls.map((c) => c[0]).join("")).toMatch(/was not installed|no lockfile entry/);
  });
});
