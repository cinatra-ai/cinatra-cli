// Command-table drift + routing invariant (cinatra#255 Stage-1; the
// command-routing contract / Class-C namespacing).
//
// The CLI dispatcher routes through the declarative descriptors in
// `src/command-table.mjs` via a LONGEST-MATCH-WINS matcher (replacing
// the old first-match-wins scan) with a load-time `validateCommandTable`
// ambiguity/shadow assertion. These tests are the load-bearing guard that:
//
//   1. SNAPSHOT — the descriptor ids/paths/match-kinds/flags are pinned. An
//      added/removed command or a re-pathing shows up as a snapshot diff a
//      reviewer must consciously accept.
//   2. ROUTING — `matchDescriptor` returns the right id for every command across
//      the `instance …` namespace (cinatra-cli#61), and the old bare forms route
//      to UNKNOWN (cinatra-cli#81 removed the back-compat aliases).
//   3. TABLE VALIDITY — `validateCommandTable` accepts the real table and
//      rejects ambiguous ties / plain-prefix shadows.
//   4. HELP EQUIVALENCE — the UNION of `printHelp` (top-level) and
//      `printGroupHelp("instance")` (the Class-C group) covers every VISIBLE
//      descriptor, split correctly between the two banners.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMMAND_DESCRIPTORS,
  matchDescriptor,
  buildHelpIndex,
  validateCommandTable,
} from "../src/command-table.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

// ---------------------------------------------------------------------------
// 1. Snapshot — the canonical surface.
// ---------------------------------------------------------------------------
describe("command table — descriptor snapshot", () => {
  it("pins the full descriptor surface (id, command, match, hidden)", () => {
    const shape = COMMAND_DESCRIPTORS.map((d) => ({
      id: d.id,
      command: d.path.join(" "),
      match: d.match,
      hidden: Boolean(d.hidden),
    }));
    expect(shape).toMatchInlineSnapshot(`
      [
        {
          "command": "install",
          "hidden": false,
          "id": "install",
          "match": "command",
        },
        {
          "command": "update",
          "hidden": false,
          "id": "update",
          "match": "command",
        },
        {
          "command": "upgrade",
          "hidden": false,
          "id": "upgrade",
          "match": "command",
        },
        {
          "command": "login",
          "hidden": false,
          "id": "login",
          "match": "command",
        },
        {
          "command": "status",
          "hidden": false,
          "id": "status",
          "match": "command",
        },
        {
          "command": "logs",
          "hidden": false,
          "id": "logs",
          "match": "command",
        },
        {
          "command": "skills reset-repo",
          "hidden": false,
          "id": "skills.reset-repo",
          "match": "command+mode",
        },
        {
          "command": "extensions purge",
          "hidden": false,
          "id": "extensions.purge",
          "match": "command+mode",
        },
        {
          "command": "extensions acquire-prod",
          "hidden": false,
          "id": "extensions.acquire-prod",
          "match": "command+mode",
        },
        {
          "command": "extensions submit",
          "hidden": false,
          "id": "extensions.submit",
          "match": "command+mode",
        },
        {
          "command": "extensions reconcile",
          "hidden": false,
          "id": "extensions.reconcile",
          "match": "command+mode",
        },
        {
          "command": "extensions list",
          "hidden": false,
          "id": "extensions.list",
          "match": "command+mode",
        },
        {
          "command": "extensions verify-prod",
          "hidden": false,
          "id": "extensions.verify-prod",
          "match": "command+mode",
        },
        {
          "command": "create-extension",
          "hidden": false,
          "id": "create-extension",
          "match": "command",
        },
        {
          "command": "mcp tunnel",
          "hidden": true,
          "id": "mcp.tunnel",
          "match": "command+mode",
        },
        {
          "command": "doctor",
          "hidden": false,
          "id": "doctor",
          "match": "command",
        },
        {
          "command": "mcp llm-access setup",
          "hidden": false,
          "id": "mcp.llm-access.setup",
          "match": "command+mode+sub",
        },
        {
          "command": "mcp llm-access refresh",
          "hidden": false,
          "id": "mcp.llm-access.refresh",
          "match": "command+mode+sub",
        },
        {
          "command": "mcp llm-access verify",
          "hidden": false,
          "id": "mcp.llm-access.verify",
          "match": "command+mode+sub",
        },
        {
          "command": "agents install",
          "hidden": false,
          "id": "agents.install",
          "match": "command+mode",
        },
        {
          "command": "agents list",
          "hidden": false,
          "id": "agents.list",
          "match": "command+mode",
        },
        {
          "command": "agents uninstall",
          "hidden": false,
          "id": "agents.uninstall",
          "match": "command+mode",
        },
        {
          "command": "agent export",
          "hidden": false,
          "id": "agent.export",
          "match": "command+mode",
        },
        {
          "command": "agent import",
          "hidden": false,
          "id": "agent.import",
          "match": "command+mode",
        },
        {
          "command": "instance",
          "hidden": true,
          "id": "instance",
          "match": "group",
        },
        {
          "command": "instance setup",
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "instance setup dev|prod",
          "hidden": true,
          "id": "setup.dev|prod",
          "match": "command+mode+sub",
        },
        {
          "command": "instance setup nango",
          "hidden": true,
          "id": "setup.nango",
          "match": "command+mode+sub",
        },
        {
          "command": "instance branch setup",
          "hidden": false,
          "id": "setup.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "instance branch teardown",
          "hidden": false,
          "id": "teardown.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone new",
          "hidden": false,
          "id": "setup.clone",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone refresh-seed",
          "hidden": false,
          "id": "clone.refresh-seed",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone prune",
          "hidden": false,
          "id": "clone.prune",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone list",
          "hidden": false,
          "id": "clone.list",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone start",
          "hidden": false,
          "id": "clone.start",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone stop",
          "hidden": false,
          "id": "clone.stop",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone status",
          "hidden": false,
          "id": "clone.status",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone slug-for-worktree",
          "hidden": false,
          "id": "clone.slug-for-worktree",
          "match": "command+mode+sub",
        },
        {
          "command": "instance db migrate",
          "hidden": false,
          "id": "db.migrate",
          "match": "command+mode+sub",
        },
        {
          "command": "instance db upgrade-preflight",
          "hidden": false,
          "id": "db.upgrade-preflight",
          "match": "command+mode+sub",
        },
        {
          "command": "instance refresh",
          "hidden": false,
          "id": "dev.refresh",
          "match": "command+mode",
        },
        {
          "command": "instance tunnel",
          "hidden": false,
          "id": "dev.tunnel",
          "match": "command+mode",
        },
        {
          "command": "instance start",
          "hidden": false,
          "id": "dev.start",
          "match": "command+mode",
        },
        {
          "command": "instance stop",
          "hidden": false,
          "id": "dev.stop",
          "match": "command+mode",
        },
        {
          "command": "instance restart",
          "hidden": false,
          "id": "dev.restart",
          "match": "command+mode",
        },
        {
          "command": "instance wordpress",
          "hidden": false,
          "id": "dev.wordpress",
          "match": "command+mode",
        },
        {
          "command": "instance drupal",
          "hidden": false,
          "id": "dev.drupal",
          "match": "command+mode",
        },
        {
          "command": "instance a2a",
          "hidden": false,
          "id": "dev.a2a",
          "match": "command+mode",
        },
        {
          "command": "instance reset",
          "hidden": false,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "instance backup create",
          "hidden": false,
          "id": "backup.create",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup import",
          "hidden": false,
          "id": "backup.import",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup export-api-configs",
          "hidden": false,
          "id": "backup.export-api-configs",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup import-api-configs",
          "hidden": false,
          "id": "backup.import-api-configs",
          "match": "command+mode+sub",
        },
      ]
    `);
  });

  it("every descriptor path is unique (cinatra-cli#81: no alias re-use)", () => {
    // cinatra-cli#81 removed the deprecated bare-form aliases, so no two
    // descriptors share a routable path AND every id is unique again.
    const paths = COMMAND_DESCRIPTORS.map((d) => d.path.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
    const ids = COMMAND_DESCRIPTORS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every routable id has a matching index.mjs handler (HANDLERS key)", () => {
    // The id-keyed handler map lives in `buildHandlers()` in index.mjs. The
    // `instance` GROUP head has NO handler (it is dispatched specially to group
    // help), so it is exempt.
    for (const { id, match } of COMMAND_DESCRIPTORS) {
      if (match === "group") continue; // group head has no handler.
      const quoted = INDEX_SRC.includes(`"${id}":`);
      const bare = new RegExp(`(^|[\\s{])${escapeRe(id)}:`, "m").test(INDEX_SRC);
      expect(quoted || bare, `missing handler for "${id}"`).toBe(true);
    }
  });

  it("the `instance` group head has NO handler key (dispatched specially)", () => {
    expect(INDEX_SRC.includes('"instance":')).toBe(false);
    // A bare `instance:` handler would be a separate concern; assert the group is
    // not wired as a normal handler. (The id `"instance"` only appears as a descriptor.)
    const groupDesc = COMMAND_DESCRIPTORS.find((d) => d.match === "group");
    expect(groupDesc?.id).toBe("instance");
  });

  it("cinatra-cli#61: the `dev` namespace is fully removed (no descriptor uses it)", () => {
    const usesDevHead = COMMAND_DESCRIPTORS.filter((d) => d.path[0] === "dev");
    expect(
      usesDevHead.map((d) => d.path.join(" ")),
      "no descriptor may live under a `dev` head",
    ).toEqual([]);
  });

  it("cinatra-cli#81: no descriptor carries a `deprecated` field (mechanism removed)", () => {
    const withDeprecated = COMMAND_DESCRIPTORS.filter((d) => "deprecated" in d);
    expect(
      withDeprecated.map((d) => d.path.join(" ")),
      "the deprecated-alias mechanism was removed in cinatra-cli#81",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Routing — longest-match selection across the new namespace.
// ---------------------------------------------------------------------------
describe("command table — routing (longest-match)", () => {
  const cases = [
    // [argv, expected descriptor id | null]
    // Top-level / Class-A stay bare.
    [["install"], "install"],
    [["install", "--dir", "/tmp/x"], "install"],
    [["update", "--ref", "release-branch"], "update"],
    [["upgrade", "--force"], "upgrade"],
    [["status"], "status"],
    [["status", "extra"], "status"],
    [["logs", "--app"], "logs"],
    [["skills", "reset-repo"], "skills.reset-repo"],
    [["extensions", "purge"], "extensions.purge"],
    [["extensions", "acquire-prod"], "extensions.acquire-prod"],
    [["extensions", "submit"], "extensions.submit"],
    [["extensions", "list"], "extensions.list"],
    [["create-extension"], "create-extension"],
    [["create-extension", "agent"], "create-extension"],
    [["mcp", "tunnel"], "mcp.tunnel"],
    [["mcp", "llm-access", "setup"], "mcp.llm-access.setup"],
    [["mcp", "llm-access", "refresh"], "mcp.llm-access.refresh"],
    [["mcp", "llm-access", "verify"], "mcp.llm-access.verify"],
    [["mcp", "llm-access", "verify", "--strict"], "mcp.llm-access.verify"],
    [["doctor"], "doctor"],
    [["doctor", "--strict"], "doctor"],
    [["agents", "install"], "agents.install"],
    [["agents", "install", "@scope/x"], "agents.install"],
    [["agents", "list"], "agents.list"],
    [["agents", "uninstall"], "agents.uninstall"],
    [["agent", "export"], "agent.export"],
    [["agent", "import"], "agent.import"],

    // Class-C canonical namespace (`instance …`, renamed cinatra-cli#61) —
    // longest-match across variable depth.
    [["instance", "setup"], "setup"], // no-mode group form (hidden internal phase)
    [["instance", "setup", "dev"], "setup.dev|prod"], // hidden internal phase (cinatra-cli#62)
    [["instance", "setup", "prod"], "setup.dev|prod"], // hidden internal phase
    [["instance", "setup", "nango"], "setup.nango"], // hidden internal phase
    // cinatra-cli#62: branch lifecycle renamed to `instance branch setup|teardown`.
    [["instance", "branch", "setup"], "setup.branch"],
    [["instance", "branch", "teardown"], "teardown.branch"],
    // cinatra-cli#81: the old `instance setup branch` / `instance teardown branch`
    // forms are removed (no back-compat) — they route to UNKNOWN.
    [["instance", "setup", "branch"], null],
    [["instance", "teardown", "branch"], null],
    [["instance", "clone", "new"], "setup.clone"],
    [["instance", "clone", "refresh-seed"], "clone.refresh-seed"],
    [["instance", "clone", "prune"], "clone.prune"],
    [["instance", "clone", "list"], "clone.list"],
    [["instance", "clone", "start"], "clone.start"],
    [["instance", "clone", "stop"], "clone.stop"],
    [["instance", "clone", "status"], "clone.status"],
    [["instance", "clone", "slug-for-worktree"], "clone.slug-for-worktree"],
    [["instance", "db", "migrate"], "db.migrate"],
    [["instance", "db", "migrate", "--down"], "db.migrate"],
    [["instance", "db", "upgrade-preflight"], "db.upgrade-preflight"],
    [["instance", "db", "upgrade-preflight", "--json"], "db.upgrade-preflight"],
    [["instance", "refresh"], "dev.refresh"],
    [["instance", "tunnel"], "dev.tunnel"],
    [["instance", "tunnel", "start"], "dev.tunnel"],
    [["instance", "start"], "dev.start"],
    [["instance", "stop"], "dev.stop"],
    [["instance", "restart"], "dev.restart"],
    [["instance", "wordpress"], "dev.wordpress"],
    [["instance", "wordpress", "start"], "dev.wordpress"],
    [["instance", "drupal", "stop"], "dev.drupal"],
    [["instance", "a2a"], "dev.a2a"],
    [["instance", "a2a", "start"], "dev.a2a"],
    [["instance", "reset"], "reset.dev"],
    [["instance", "backup", "create"], "backup.create"],
    [["instance", "backup", "import"], "backup.import"],
    [["instance", "backup", "export-api-configs"], "backup.export-api-configs"],
    [["instance", "backup", "import-api-configs"], "backup.import-api-configs"],

    // The `instance` group head routes ONLY on the bare head (length-exact).
    [["instance"], "instance"],

    // cinatra-cli#61: the old `dev …` namespace is fully removed — no alias, no
    // resolution. Every former `dev …` form (and the bare `dev` head) is UNKNOWN.
    [["dev"], null],
    [["dev", "setup"], null],
    [["dev", "setup", "prod"], null],
    [["dev", "db", "migrate"], null],
    [["dev", "clone", "list"], null],
    [["dev", "tunnel", "start"], null],

    // cinatra-cli#81: the old bare forms are REMOVED (no back-compat) — every
    // former bare alias now routes to UNKNOWN.
    [["setup"], null],
    [["setup", "dev"], null],
    [["setup", "prod"], null],
    [["setup", "branch"], null],
    [["teardown", "branch"], null],
    [["setup", "clone"], null],
    [["clone", "refresh-seed"], null],
    [["clone", "prune"], null],
    [["clone", "list"], null],
    [["clone", "start"], null],
    [["clone", "stop"], null],
    [["clone", "status"], null],
    [["clone", "slug-for-worktree"], null],
    [["db", "migrate"], null],
    [["reset", "dev"], null],
    [["backup", "create"], null],
    [["backup", "import"], null],

    // No-mode-exact + unknowns: a trailing non-mode token routes to UNKNOWN.
    [["instance", "setup", "bogus"], null],
    [["setup", "bogus"], null],
    [["setup", "nango"], null],
    [["instance", "clone"], null], // no `instance clone` subgroup — unknown (points at `instance --help`).
    [["agents"], null],
    [["agents", "bogus"], null],
    [["mcp", "llm-access", "bogus"], null],
    [["mcp"], null],
    [["bogus"], null],
    // A LITERAL `"dev|prod"` arg must NOT match the alternation token.
    [["instance", "setup", "dev|prod"], null],
  ];

  it.each(cases)("routes %j -> %s", (argv, expectedId) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
    expect(d ? d.id : null).toBe(expectedId);
  });

  it("longest-match: `instance setup prod` selects the 3-token mode descriptor, not the no-mode group", () => {
    const noMode = matchDescriptor(COMMAND_DESCRIPTORS, ["instance", "setup"]);
    const withMode = matchDescriptor(COMMAND_DESCRIPTORS, ["instance", "setup", "prod"]);
    expect(noMode.match).toBe("command-no-mode");
    expect(withMode.id).toBe("setup.dev|prod");
    expect(withMode.path.length).toBeGreaterThan(noMode.path.length);
  });

  it("cinatra-cli#81: the old bare form routes to UNKNOWN; only the `instance …` form resolves", () => {
    expect(matchDescriptor(COMMAND_DESCRIPTORS, ["db", "migrate"])).toBeNull();
    const canonical = matchDescriptor(COMMAND_DESCRIPTORS, ["instance", "db", "migrate"]);
    expect(canonical.id).toBe("db.migrate");
  });
});

// ---------------------------------------------------------------------------
// 2b. Class-A stay-bare guard (the command-routing contract).
// ---------------------------------------------------------------------------
describe("command table — Class-A control plane stays bare", () => {
  const bareClassA = [
    ["extensions", "list"],
    ["agents", "list"],
    ["agents", "uninstall"],
    ["agents", "install"],
    ["extensions", "acquire-prod"],
    ["status"],
    ["skills", "reset-repo"],
    ["extensions", "purge"],
  ];

  it.each(bareClassA)("`%j` routes at its BARE path (not under instance) with no alias", (...argv) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
    expect(d, `${argv.join(" ")} must route`).not.toBeNull();
    expect(d.path[0]).not.toBe("instance");
    // It also has no namespaced `instance …` canonical form (the id is not re-pathed).
    const underInstance = COMMAND_DESCRIPTORS.filter(
      (x) => x.id === d.id && x.path[0] === "instance",
    );
    expect(underInstance.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Table validity — validateCommandTable accepts the real table, rejects bad.
// ---------------------------------------------------------------------------
describe("command table — validateCommandTable", () => {
  it("accepts the real command table", () => {
    expect(validateCommandTable(COMMAND_DESCRIPTORS)).toBe(true);
  });

  it("rejects two canonical descriptors that tie on the same path", () => {
    const bad = [
      { id: "a", path: ["foo", "bar"], match: "command+mode" },
      { id: "b", path: ["foo", "bar"], match: "command+mode" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/ambiguous/i);
  });

  it("rejects an alternation tie a raw-string compare would miss", () => {
    const bad = [
      { id: "a", path: ["x", "dev|prod"], match: "command+mode" },
      { id: "b", path: ["x", "dev"], match: "command+mode" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/ambiguous/i);
  });

  it("rejects a shorter PLAIN-prefix leaf that would shadow a longer command", () => {
    // `["foo"]` as a plain `command` leaf strictly prefixes `["foo","bar"]`, so
    // `foo bar baz` would route to the shorter leaf — forbidden.
    const bad = [
      { id: "foo", path: ["foo"], match: "command" },
      { id: "foo.bar", path: ["foo", "bar"], match: "command+mode" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/plain-prefix|shadow/i);
  });

  it("ALLOWS a legitimate group/no-mode + longer-leaf prefix pair", () => {
    const ok = [
      { id: "dev", path: ["dev"], match: "group", hidden: true },
      { id: "s", path: ["dev", "setup"], match: "command-no-mode", hidden: true },
      { id: "s.m", path: ["dev", "setup", "dev|prod"], match: "command+mode+sub" },
      { id: "s.n", path: ["dev", "setup", "nango"], match: "command+mode+sub" },
    ];
    expect(validateCommandTable(ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Help equivalence — printHelp (top-level) ∪ printGroupHelp("instance")
//    covers all.
// ---------------------------------------------------------------------------
describe("command table — docs↔surface drift (printHelp ∪ printGroupHelp)", () => {
  const helpIndex = buildHelpIndex(COMMAND_DESCRIPTORS);
  // The two Usage blocks: printHelp's (top-level) and printGroupHelp("instance")'s.
  const topUsage = extractUsageBlock(INDEX_SRC, "function printHelp()");
  const instanceUsage = extractUsageBlock(INDEX_SRC, "function printGroupHelp(");

  it("both Usage blocks exist and are non-trivial", () => {
    expect(topUsage.length).toBeGreaterThan(200);
    expect(instanceUsage.length).toBeGreaterThan(200);
  });

  it("forward: every visible descriptor appears in the correct banner", () => {
    for (const { command } of helpIndex) {
      const variants = expandPipeAlternatives(command);
      const block = command.startsWith("instance ") ? instanceUsage : topUsage;
      const label = command.startsWith("instance ") ? "printGroupHelp(instance)" : "printHelp";
      for (const v of variants) {
        expect(
          block.includes(`cinatra ${v}`),
          `"cinatra ${v}" missing from ${label} Usage`,
        ).toBe(true);
      }
    }
  });

  it("reverse: every `cinatra <cmd>` Usage line in either banner maps to a descriptor", () => {
    const lines = [
      ...extractUsageCommands(topUsage),
      ...extractUsageCommands(instanceUsage),
    ];
    expect(lines.length).toBeGreaterThan(30);
    for (const tokens of lines) {
      const d = matchDescriptor(COMMAND_DESCRIPTORS, tokens);
      expect(
        d !== null,
        `Usage advertises "cinatra ${tokens.join(" ")}" but no descriptor routes it`,
      ).toBe(true);
    }
  });

  it("hidden descriptors are excluded from the help index", () => {
    const ids = new Set(helpIndex.map((e) => e.command));
    expect(ids.has("instance setup")).toBe(false); // no-mode form (hidden)
    expect(ids.has("instance setup dev|prod")).toBe(false); // internal phase (hidden)
    expect(ids.has("mcp tunnel")).toBe(false); // removed feature
    expect(ids.has("instance")).toBe(false); // group head
  });

  it("cinatra-cli#81: the old bare forms have no help row (descriptors removed)", () => {
    const helpCommands = new Set(helpIndex.map((e) => e.command));
    for (const p of ["setup", "db migrate", "clone list", "reset dev", "backup create"]) {
      expect(helpCommands.has(p)).toBe(false);
      // And they no longer route at all.
      expect(matchDescriptor(COMMAND_DESCRIPTORS, p.split(" "))).toBeNull();
    }
  });
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Extract the `Usage:` ... up to `Commands:` slice of a named function's
// template literal. We search from the function declaration so printHelp and
// printGroupHelp blocks are isolated.
function extractUsageBlock(src, fnAnchor) {
  const fnStart = src.indexOf(fnAnchor);
  if (fnStart === -1) return "";
  const start = src.indexOf("Usage:", fnStart);
  const end = src.indexOf("Commands:", start);
  if (start === -1 || end === -1) return "";
  return src.slice(start, end);
}

function extractUsageCommands(block) {
  const out = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("cinatra ")) continue;
    const after = line.slice("cinatra ".length).trim();
    const tokens = [];
    for (const tok of after.split(/\s+/)) {
      if (tok.startsWith("[") || tok.startsWith("<") || tok.startsWith("--") || tok.startsWith("#")) break;
      tokens.push(tok);
    }
    if (tokens.length > 0) out.push(tokens);
  }
  return out;
}

function expandPipeAlternatives(command) {
  const parts = command.split(" ");
  const pipeIdx = parts.findIndex((p) => p.includes("|"));
  if (pipeIdx === -1) return [command];
  const alts = parts[pipeIdx].split("|");
  return alts.map((alt) => {
    const copy = parts.slice();
    copy[pipeIdx] = alt;
    return copy.join(" ");
  });
}
