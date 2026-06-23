// Command-table drift + routing invariant (cinatra#255 Stage-1; eng#232
// Class-C namespacing).
//
// The CLI dispatcher routes through the declarative descriptors in
// `src/command-table.mjs` via a LONGEST-MATCH-WINS matcher (eng#232 — replacing
// the old first-match-wins scan) with a load-time `validateCommandTable`
// ambiguity/shadow assertion. These tests are the load-bearing guard that:
//
//   1. SNAPSHOT — the descriptor ids/paths/match-kinds/flags are pinned. An
//      added/removed command or a re-pathing shows up as a snapshot diff a
//      reviewer must consciously accept.
//   2. ROUTING — `matchDescriptor` returns the SAME id for every command across
//      the new `dev …` namespace, the deprecated bare aliases, and the tricky
//      longest-match / no-mode edges.
//   3. TABLE VALIDITY — `validateCommandTable` accepts the real table and
//      rejects ambiguous ties / alias-shadows / dangling alias targets.
//   4. HELP EQUIVALENCE — the UNION of `printHelp` (top-level) and
//      `printGroupHelp("dev")` (the Class-C group) covers every VISIBLE
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
  it("pins the full descriptor surface (id, command, match, hidden, deprecated)", () => {
    const shape = COMMAND_DESCRIPTORS.map((d) => ({
      id: d.id,
      command: d.path.join(" "),
      match: d.match,
      hidden: Boolean(d.hidden),
      deprecated: d.deprecated ?? null,
    }));
    expect(shape).toMatchInlineSnapshot(`
      [
        {
          "command": "install",
          "deprecated": null,
          "hidden": false,
          "id": "install",
          "match": "command",
        },
        {
          "command": "update",
          "deprecated": null,
          "hidden": false,
          "id": "update",
          "match": "command",
        },
        {
          "command": "upgrade",
          "deprecated": null,
          "hidden": false,
          "id": "upgrade",
          "match": "command",
        },
        {
          "command": "login",
          "deprecated": null,
          "hidden": false,
          "id": "login",
          "match": "command",
        },
        {
          "command": "status",
          "deprecated": null,
          "hidden": false,
          "id": "status",
          "match": "command",
        },
        {
          "command": "logs",
          "deprecated": null,
          "hidden": false,
          "id": "logs",
          "match": "command",
        },
        {
          "command": "skills reset-repo",
          "deprecated": null,
          "hidden": false,
          "id": "skills.reset-repo",
          "match": "command+mode",
        },
        {
          "command": "extensions purge",
          "deprecated": null,
          "hidden": false,
          "id": "extensions.purge",
          "match": "command+mode",
        },
        {
          "command": "extensions acquire-prod",
          "deprecated": null,
          "hidden": false,
          "id": "extensions.acquire-prod",
          "match": "command+mode",
        },
        {
          "command": "extensions submit",
          "deprecated": null,
          "hidden": false,
          "id": "extensions.submit",
          "match": "command+mode",
        },
        {
          "command": "extensions list",
          "deprecated": null,
          "hidden": false,
          "id": "extensions.list",
          "match": "command+mode",
        },
        {
          "command": "create-extension",
          "deprecated": null,
          "hidden": false,
          "id": "create-extension",
          "match": "command",
        },
        {
          "command": "mcp tunnel",
          "deprecated": null,
          "hidden": true,
          "id": "mcp.tunnel",
          "match": "command+mode",
        },
        {
          "command": "doctor",
          "deprecated": null,
          "hidden": false,
          "id": "doctor",
          "match": "command",
        },
        {
          "command": "mcp llm-access setup",
          "deprecated": null,
          "hidden": false,
          "id": "mcp.llm-access.setup",
          "match": "command+mode+sub",
        },
        {
          "command": "mcp llm-access refresh",
          "deprecated": null,
          "hidden": false,
          "id": "mcp.llm-access.refresh",
          "match": "command+mode+sub",
        },
        {
          "command": "mcp llm-access verify",
          "deprecated": null,
          "hidden": false,
          "id": "mcp.llm-access.verify",
          "match": "command+mode+sub",
        },
        {
          "command": "agents install",
          "deprecated": null,
          "hidden": false,
          "id": "agents.install",
          "match": "command+mode",
        },
        {
          "command": "agents list",
          "deprecated": null,
          "hidden": false,
          "id": "agents.list",
          "match": "command+mode",
        },
        {
          "command": "agents uninstall",
          "deprecated": null,
          "hidden": false,
          "id": "agents.uninstall",
          "match": "command+mode",
        },
        {
          "command": "agent export",
          "deprecated": null,
          "hidden": false,
          "id": "agent.export",
          "match": "command+mode",
        },
        {
          "command": "agent import",
          "deprecated": null,
          "hidden": false,
          "id": "agent.import",
          "match": "command+mode",
        },
        {
          "command": "dev",
          "deprecated": null,
          "hidden": true,
          "id": "dev",
          "match": "group",
        },
        {
          "command": "dev setup",
          "deprecated": null,
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "dev setup dev|prod",
          "deprecated": null,
          "hidden": false,
          "id": "setup.dev|prod",
          "match": "command+mode+sub",
        },
        {
          "command": "dev setup nango",
          "deprecated": null,
          "hidden": false,
          "id": "setup.nango",
          "match": "command+mode+sub",
        },
        {
          "command": "dev setup branch",
          "deprecated": null,
          "hidden": false,
          "id": "setup.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "dev teardown branch",
          "deprecated": null,
          "hidden": false,
          "id": "teardown.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone new",
          "deprecated": null,
          "hidden": false,
          "id": "setup.clone",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone refresh-seed",
          "deprecated": null,
          "hidden": false,
          "id": "clone.refresh-seed",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone prune",
          "deprecated": null,
          "hidden": false,
          "id": "clone.prune",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone list",
          "deprecated": null,
          "hidden": false,
          "id": "clone.list",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone start",
          "deprecated": null,
          "hidden": false,
          "id": "clone.start",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone stop",
          "deprecated": null,
          "hidden": false,
          "id": "clone.stop",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone status",
          "deprecated": null,
          "hidden": false,
          "id": "clone.status",
          "match": "command+mode+sub",
        },
        {
          "command": "dev clone slug-for-worktree",
          "deprecated": null,
          "hidden": false,
          "id": "clone.slug-for-worktree",
          "match": "command+mode+sub",
        },
        {
          "command": "dev db migrate",
          "deprecated": null,
          "hidden": false,
          "id": "db.migrate",
          "match": "command+mode+sub",
        },
        {
          "command": "dev refresh",
          "deprecated": null,
          "hidden": false,
          "id": "dev.refresh",
          "match": "command+mode",
        },
        {
          "command": "dev tunnel",
          "deprecated": null,
          "hidden": false,
          "id": "dev.tunnel",
          "match": "command+mode",
        },
        {
          "command": "dev start",
          "deprecated": null,
          "hidden": false,
          "id": "dev.start",
          "match": "command+mode",
        },
        {
          "command": "dev stop",
          "deprecated": null,
          "hidden": false,
          "id": "dev.stop",
          "match": "command+mode",
        },
        {
          "command": "dev restart",
          "deprecated": null,
          "hidden": false,
          "id": "dev.restart",
          "match": "command+mode",
        },
        {
          "command": "dev wordpress",
          "deprecated": null,
          "hidden": false,
          "id": "dev.wordpress",
          "match": "command+mode",
        },
        {
          "command": "dev drupal",
          "deprecated": null,
          "hidden": false,
          "id": "dev.drupal",
          "match": "command+mode",
        },
        {
          "command": "dev reset",
          "deprecated": null,
          "hidden": false,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "dev backup create",
          "deprecated": null,
          "hidden": false,
          "id": "backup.create",
          "match": "command+mode+sub",
        },
        {
          "command": "dev backup import",
          "deprecated": null,
          "hidden": false,
          "id": "backup.import",
          "match": "command+mode+sub",
        },
        {
          "command": "dev backup export-api-configs",
          "deprecated": null,
          "hidden": false,
          "id": "backup.export-api-configs",
          "match": "command+mode+sub",
        },
        {
          "command": "dev backup import-api-configs",
          "deprecated": null,
          "hidden": false,
          "id": "backup.import-api-configs",
          "match": "command+mode+sub",
        },
        {
          "command": "setup",
          "deprecated": "dev setup",
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "setup dev|prod",
          "deprecated": "dev setup",
          "hidden": true,
          "id": "setup.dev|prod",
          "match": "command+mode",
        },
        {
          "command": "setup nango",
          "deprecated": "dev setup nango",
          "hidden": true,
          "id": "setup.nango",
          "match": "command+mode",
        },
        {
          "command": "setup branch",
          "deprecated": "dev setup branch",
          "hidden": true,
          "id": "setup.branch",
          "match": "command+mode",
        },
        {
          "command": "teardown branch",
          "deprecated": "dev teardown branch",
          "hidden": true,
          "id": "teardown.branch",
          "match": "command+mode",
        },
        {
          "command": "setup clone",
          "deprecated": "dev clone new",
          "hidden": true,
          "id": "setup.clone",
          "match": "command+mode",
        },
        {
          "command": "clone refresh-seed",
          "deprecated": "dev clone refresh-seed",
          "hidden": true,
          "id": "clone.refresh-seed",
          "match": "command+mode",
        },
        {
          "command": "clone prune",
          "deprecated": "dev clone prune",
          "hidden": true,
          "id": "clone.prune",
          "match": "command+mode",
        },
        {
          "command": "clone list",
          "deprecated": "dev clone list",
          "hidden": true,
          "id": "clone.list",
          "match": "command+mode",
        },
        {
          "command": "clone start",
          "deprecated": "dev clone start",
          "hidden": true,
          "id": "clone.start",
          "match": "command+mode",
        },
        {
          "command": "clone stop",
          "deprecated": "dev clone stop",
          "hidden": true,
          "id": "clone.stop",
          "match": "command+mode",
        },
        {
          "command": "clone status",
          "deprecated": "dev clone status",
          "hidden": true,
          "id": "clone.status",
          "match": "command+mode",
        },
        {
          "command": "clone slug-for-worktree",
          "deprecated": "dev clone slug-for-worktree",
          "hidden": true,
          "id": "clone.slug-for-worktree",
          "match": "command+mode",
        },
        {
          "command": "db migrate",
          "deprecated": "dev db migrate",
          "hidden": true,
          "id": "db.migrate",
          "match": "command+mode",
        },
        {
          "command": "reset dev",
          "deprecated": "dev reset",
          "hidden": true,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "backup create",
          "deprecated": "dev backup create",
          "hidden": true,
          "id": "backup.create",
          "match": "command+mode",
        },
        {
          "command": "backup import",
          "deprecated": "dev backup import",
          "hidden": true,
          "id": "backup.import",
          "match": "command+mode",
        },
        {
          "command": "backup export-api-configs",
          "deprecated": "dev backup export-api-configs",
          "hidden": true,
          "id": "backup.export-api-configs",
          "match": "command+mode",
        },
        {
          "command": "backup import-api-configs",
          "deprecated": "dev backup import-api-configs",
          "hidden": true,
          "id": "backup.import-api-configs",
          "match": "command+mode",
        },
      ]
    `);
  });

  it("every CANONICAL (non-deprecated) descriptor path is unique", () => {
    // eng#232: alias descriptors deliberately REUSE the canonical id, so the old
    // "every id is unique" invariant no longer holds. The real invariant is that
    // no two canonical commands share a routable path.
    const canonical = COMMAND_DESCRIPTORS.filter((d) => !d.deprecated);
    const paths = canonical.map((d) => d.path.join(" "));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("every alias id matches a canonical id (no orphan aliases)", () => {
    const canonicalIds = new Set(
      COMMAND_DESCRIPTORS.filter((d) => !d.deprecated).map((d) => d.id),
    );
    for (const alias of COMMAND_DESCRIPTORS.filter((d) => d.deprecated)) {
      expect(
        canonicalIds.has(alias.id),
        `alias ${alias.path.join(" ")} has no canonical twin id "${alias.id}"`,
      ).toBe(true);
    }
  });

  it("every routable id has a matching index.mjs handler (HANDLERS key)", () => {
    // The id-keyed handler map lives in `buildHandlers()` in index.mjs. The `dev`
    // GROUP head has NO handler (it is dispatched specially to group help), so it
    // is exempt. Alias ids are covered by their canonical twin (same id).
    for (const { id, match } of COMMAND_DESCRIPTORS) {
      if (match === "group") continue; // group head has no handler.
      const quoted = INDEX_SRC.includes(`"${id}":`);
      const bare = new RegExp(`(^|[\\s{])${escapeRe(id)}:`, "m").test(INDEX_SRC);
      expect(quoted || bare, `missing handler for "${id}"`).toBe(true);
    }
  });

  it("the `dev` group head has NO handler key (dispatched specially)", () => {
    expect(INDEX_SRC.includes('"dev":')).toBe(false);
    // A bare `dev:` handler would be a separate concern; assert the group is not
    // wired as a normal handler. (The id `"dev"` only appears as a descriptor.)
    const groupDesc = COMMAND_DESCRIPTORS.find((d) => d.match === "group");
    expect(groupDesc?.id).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// 2. Routing — longest-match selection across the new namespace + aliases.
// ---------------------------------------------------------------------------
describe("command table — routing (longest-match + aliases)", () => {
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

    // Class-C canonical namespace — longest-match across variable depth.
    [["dev", "setup"], "setup"], // no-mode group form
    [["dev", "setup", "dev"], "setup.dev|prod"],
    [["dev", "setup", "prod"], "setup.dev|prod"],
    [["dev", "setup", "nango"], "setup.nango"],
    [["dev", "setup", "branch"], "setup.branch"],
    [["dev", "teardown", "branch"], "teardown.branch"],
    [["dev", "clone", "new"], "setup.clone"],
    [["dev", "clone", "refresh-seed"], "clone.refresh-seed"],
    [["dev", "clone", "prune"], "clone.prune"],
    [["dev", "clone", "list"], "clone.list"],
    [["dev", "clone", "start"], "clone.start"],
    [["dev", "clone", "stop"], "clone.stop"],
    [["dev", "clone", "status"], "clone.status"],
    [["dev", "clone", "slug-for-worktree"], "clone.slug-for-worktree"],
    [["dev", "db", "migrate"], "db.migrate"],
    [["dev", "db", "migrate", "--down"], "db.migrate"],
    [["dev", "refresh"], "dev.refresh"],
    [["dev", "tunnel"], "dev.tunnel"],
    [["dev", "tunnel", "start"], "dev.tunnel"],
    [["dev", "start"], "dev.start"],
    [["dev", "stop"], "dev.stop"],
    [["dev", "restart"], "dev.restart"],
    [["dev", "wordpress"], "dev.wordpress"],
    [["dev", "wordpress", "start"], "dev.wordpress"],
    [["dev", "drupal", "stop"], "dev.drupal"],
    [["dev", "reset"], "reset.dev"],
    [["dev", "backup", "create"], "backup.create"],
    [["dev", "backup", "import"], "backup.import"],
    [["dev", "backup", "export-api-configs"], "backup.export-api-configs"],
    [["dev", "backup", "import-api-configs"], "backup.import-api-configs"],

    // The `dev` group head routes ONLY on the bare head (length-exact).
    [["dev"], "dev"],

    // Deprecated bare aliases route to the SAME id as the canonical twin.
    [["setup"], "setup"],
    [["setup", "dev"], "setup.dev|prod"],
    [["setup", "prod"], "setup.dev|prod"],
    [["setup", "nango"], "setup.nango"],
    [["setup", "branch"], "setup.branch"],
    [["teardown", "branch"], "teardown.branch"],
    [["setup", "clone"], "setup.clone"],
    [["clone", "refresh-seed"], "clone.refresh-seed"],
    [["clone", "prune"], "clone.prune"],
    [["clone", "list"], "clone.list"],
    [["clone", "start"], "clone.start"],
    [["clone", "stop"], "clone.stop"],
    [["clone", "status"], "clone.status"],
    [["clone", "slug-for-worktree"], "clone.slug-for-worktree"],
    [["db", "migrate"], "db.migrate"],
    [["reset", "dev"], "reset.dev"],
    [["backup", "create"], "backup.create"],
    [["backup", "import"], "backup.import"],

    // No-mode-exact + unknowns: a trailing non-mode token routes to UNKNOWN.
    [["dev", "setup", "bogus"], null],
    [["setup", "bogus"], null],
    [["dev", "clone"], null], // no `dev clone` subgroup — unknown (points at `dev --help`).
    [["agents"], null],
    [["agents", "bogus"], null],
    [["mcp", "llm-access", "bogus"], null],
    [["mcp"], null],
    [["bogus"], null],
    // A LITERAL `"dev|prod"` arg must NOT match the alternation token.
    [["dev", "setup", "dev|prod"], null],
    [["setup", "dev|prod"], null],
  ];

  it.each(cases)("routes %j -> %s", (argv, expectedId) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
    expect(d ? d.id : null).toBe(expectedId);
  });

  it("longest-match: `dev setup prod` selects the 3-token mode descriptor, not the no-mode group", () => {
    const noMode = matchDescriptor(COMMAND_DESCRIPTORS, ["dev", "setup"]);
    const withMode = matchDescriptor(COMMAND_DESCRIPTORS, ["dev", "setup", "prod"]);
    expect(noMode.match).toBe("command-no-mode");
    expect(withMode.id).toBe("setup.dev|prod");
    expect(withMode.path.length).toBeGreaterThan(noMode.path.length);
  });

  it("a deprecated alias and its canonical form resolve to the same handler id", () => {
    const alias = matchDescriptor(COMMAND_DESCRIPTORS, ["db", "migrate"]);
    const canonical = matchDescriptor(COMMAND_DESCRIPTORS, ["dev", "db", "migrate"]);
    expect(alias.id).toBe(canonical.id);
    expect(alias.deprecated).toBe("dev db migrate");
    expect(canonical.deprecated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2b. Class-A stay-bare guard (eng#232 D2 / F3j).
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

  it.each(bareClassA)("`%j` routes at its BARE path (not under dev) with no alias", (...argv) => {
    const d = matchDescriptor(COMMAND_DESCRIPTORS, argv);
    expect(d, `${argv.join(" ")} must route`).not.toBeNull();
    expect(d.path[0]).not.toBe("dev");
    expect(d.deprecated).toBeUndefined();
    // It also has no namespaced `dev …` canonical form (the id is not re-pathed).
    const underDev = COMMAND_DESCRIPTORS.filter(
      (x) => x.id === d.id && x.path[0] === "dev",
    );
    expect(underDev.length).toBe(0);
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

  it("rejects a deprecated alias that shadows a canonical command", () => {
    const bad = [
      { id: "x", path: ["dev", "x"], match: "command+mode" },
      {
        id: "x",
        path: ["dev", "x"],
        match: "command+mode",
        hidden: true,
        deprecated: "dev x",
      },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/shadow/i);
  });

  it("rejects a deprecated alias that is not hidden", () => {
    const bad = [
      { id: "x", path: ["dev", "x"], match: "command+mode" },
      { id: "x", path: ["old", "x"], match: "command+mode", deprecated: "dev x" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/must be hidden/i);
  });

  it("rejects a deprecated alias whose target does not resolve", () => {
    const bad = [
      { id: "x", path: ["dev", "x"], match: "command+mode" },
      {
        id: "x",
        path: ["old", "x"],
        match: "command+mode",
        hidden: true,
        deprecated: "dev nope",
      },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/does not resolve/i);
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

  it("rejects a deprecated alias whose target resolves only by prefix (not exact)", () => {
    // Target "foo bogus" must NOT resolve to the plain-prefix canonical ["foo"].
    const bad = [
      { id: "foo", path: ["foo"], match: "command" },
      {
        id: "foo",
        path: ["legacy"],
        match: "command",
        hidden: true,
        deprecated: "foo bogus",
      },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/does not resolve/i);
  });

  it("rejects two deprecated aliases sharing an id AND a path (identity, not id)", () => {
    const bad = [
      { id: "x", path: ["dev", "x"], match: "command+mode" },
      { id: "x", path: ["old"], match: "command", hidden: true, deprecated: "dev x" },
      { id: "x", path: ["old"], match: "command", hidden: true, deprecated: "dev x" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/collide/i);
  });

  it("rejects two deprecated aliases that collide on the same path", () => {
    const bad = [
      { id: "a", path: ["dev", "a"], match: "command+mode" },
      { id: "b", path: ["dev", "b"], match: "command+mode" },
      { id: "a", path: ["old"], match: "command", hidden: true, deprecated: "dev a" },
      { id: "b", path: ["old"], match: "command", hidden: true, deprecated: "dev b" },
    ];
    expect(() => validateCommandTable(bad)).toThrow(/collide/i);
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
// 4. Help equivalence — printHelp (top-level) ∪ printGroupHelp("dev") covers all.
// ---------------------------------------------------------------------------
describe("command table — docs↔surface drift (printHelp ∪ printGroupHelp)", () => {
  const helpIndex = buildHelpIndex(COMMAND_DESCRIPTORS);
  // The two Usage blocks: printHelp's (top-level) and printGroupHelp("dev")'s.
  const topUsage = extractUsageBlock(INDEX_SRC, "function printHelp()");
  const devUsage = extractUsageBlock(INDEX_SRC, "function printGroupHelp(");

  it("both Usage blocks exist and are non-trivial", () => {
    expect(topUsage.length).toBeGreaterThan(200);
    expect(devUsage.length).toBeGreaterThan(200);
  });

  it("forward: every visible descriptor appears in the correct banner", () => {
    for (const { command } of helpIndex) {
      const variants = expandPipeAlternatives(command);
      const block = command.startsWith("dev ") ? devUsage : topUsage;
      const label = command.startsWith("dev ") ? "printGroupHelp(dev)" : "printHelp";
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
      ...extractUsageCommands(devUsage),
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

  it("hidden + deprecated descriptors are excluded from the help index", () => {
    const ids = new Set(helpIndex.map((e) => e.command));
    expect(ids.has("setup")).toBe(false); // bare alias
    expect(ids.has("dev setup")).toBe(false); // no-mode form (hidden)
    expect(ids.has("mcp tunnel")).toBe(false); // removed feature
    expect(ids.has("dev")).toBe(false); // group head
    expect(ids.has("db migrate")).toBe(false); // bare alias
  });

  it("the help index has no deprecated aliases", () => {
    const allDeprecatedPaths = COMMAND_DESCRIPTORS.filter((d) => d.deprecated).map(
      (d) => d.path.join(" "),
    );
    const helpCommands = new Set(helpIndex.map((e) => e.command));
    for (const p of allDeprecatedPaths) {
      expect(helpCommands.has(p)).toBe(false);
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
