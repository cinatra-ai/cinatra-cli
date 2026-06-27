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
//   2. ROUTING — `matchDescriptor` returns the SAME id for every command across
//      the `instance …` namespace (cinatra-cli#61), the deprecated bare aliases,
//      and the tricky longest-match / no-mode edges.
//   3. TABLE VALIDITY — `validateCommandTable` accepts the real table and
//      rejects ambiguous ties / alias-shadows / dangling alias targets.
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
          "command": "instance",
          "deprecated": null,
          "hidden": true,
          "id": "instance",
          "match": "group",
        },
        {
          "command": "instance setup",
          "deprecated": null,
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "instance setup dev|prod",
          "deprecated": null,
          "hidden": true,
          "id": "setup.dev|prod",
          "match": "command+mode+sub",
        },
        {
          "command": "instance setup nango",
          "deprecated": null,
          "hidden": true,
          "id": "setup.nango",
          "match": "command+mode+sub",
        },
        {
          "command": "instance branch setup",
          "deprecated": null,
          "hidden": false,
          "id": "setup.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "instance branch teardown",
          "deprecated": null,
          "hidden": false,
          "id": "teardown.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone new",
          "deprecated": null,
          "hidden": false,
          "id": "setup.clone",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone refresh-seed",
          "deprecated": null,
          "hidden": false,
          "id": "clone.refresh-seed",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone prune",
          "deprecated": null,
          "hidden": false,
          "id": "clone.prune",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone list",
          "deprecated": null,
          "hidden": false,
          "id": "clone.list",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone start",
          "deprecated": null,
          "hidden": false,
          "id": "clone.start",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone stop",
          "deprecated": null,
          "hidden": false,
          "id": "clone.stop",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone status",
          "deprecated": null,
          "hidden": false,
          "id": "clone.status",
          "match": "command+mode+sub",
        },
        {
          "command": "instance clone slug-for-worktree",
          "deprecated": null,
          "hidden": false,
          "id": "clone.slug-for-worktree",
          "match": "command+mode+sub",
        },
        {
          "command": "instance db migrate",
          "deprecated": null,
          "hidden": false,
          "id": "db.migrate",
          "match": "command+mode+sub",
        },
        {
          "command": "instance refresh",
          "deprecated": null,
          "hidden": false,
          "id": "dev.refresh",
          "match": "command+mode",
        },
        {
          "command": "instance tunnel",
          "deprecated": null,
          "hidden": false,
          "id": "dev.tunnel",
          "match": "command+mode",
        },
        {
          "command": "instance start",
          "deprecated": null,
          "hidden": false,
          "id": "dev.start",
          "match": "command+mode",
        },
        {
          "command": "instance stop",
          "deprecated": null,
          "hidden": false,
          "id": "dev.stop",
          "match": "command+mode",
        },
        {
          "command": "instance restart",
          "deprecated": null,
          "hidden": false,
          "id": "dev.restart",
          "match": "command+mode",
        },
        {
          "command": "instance wordpress",
          "deprecated": null,
          "hidden": false,
          "id": "dev.wordpress",
          "match": "command+mode",
        },
        {
          "command": "instance drupal",
          "deprecated": null,
          "hidden": false,
          "id": "dev.drupal",
          "match": "command+mode",
        },
        {
          "command": "instance reset",
          "deprecated": null,
          "hidden": false,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "instance backup create",
          "deprecated": null,
          "hidden": false,
          "id": "backup.create",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup import",
          "deprecated": null,
          "hidden": false,
          "id": "backup.import",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup export-api-configs",
          "deprecated": null,
          "hidden": false,
          "id": "backup.export-api-configs",
          "match": "command+mode+sub",
        },
        {
          "command": "instance backup import-api-configs",
          "deprecated": null,
          "hidden": false,
          "id": "backup.import-api-configs",
          "match": "command+mode+sub",
        },
        {
          "command": "setup",
          "deprecated": "instance setup",
          "hidden": true,
          "id": "setup",
          "match": "command-no-mode",
        },
        {
          "command": "setup dev|prod",
          "deprecated": "instance setup",
          "hidden": true,
          "id": "setup.dev|prod",
          "match": "command+mode",
        },
        {
          "command": "instance setup branch",
          "deprecated": "instance branch setup",
          "hidden": true,
          "id": "setup.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "instance teardown branch",
          "deprecated": "instance branch teardown",
          "hidden": true,
          "id": "teardown.branch",
          "match": "command+mode+sub",
        },
        {
          "command": "setup branch",
          "deprecated": "instance branch setup",
          "hidden": true,
          "id": "setup.branch",
          "match": "command+mode",
        },
        {
          "command": "teardown branch",
          "deprecated": "instance branch teardown",
          "hidden": true,
          "id": "teardown.branch",
          "match": "command+mode",
        },
        {
          "command": "setup clone",
          "deprecated": "instance clone new",
          "hidden": true,
          "id": "setup.clone",
          "match": "command+mode",
        },
        {
          "command": "clone refresh-seed",
          "deprecated": "instance clone refresh-seed",
          "hidden": true,
          "id": "clone.refresh-seed",
          "match": "command+mode",
        },
        {
          "command": "clone prune",
          "deprecated": "instance clone prune",
          "hidden": true,
          "id": "clone.prune",
          "match": "command+mode",
        },
        {
          "command": "clone list",
          "deprecated": "instance clone list",
          "hidden": true,
          "id": "clone.list",
          "match": "command+mode",
        },
        {
          "command": "clone start",
          "deprecated": "instance clone start",
          "hidden": true,
          "id": "clone.start",
          "match": "command+mode",
        },
        {
          "command": "clone stop",
          "deprecated": "instance clone stop",
          "hidden": true,
          "id": "clone.stop",
          "match": "command+mode",
        },
        {
          "command": "clone status",
          "deprecated": "instance clone status",
          "hidden": true,
          "id": "clone.status",
          "match": "command+mode",
        },
        {
          "command": "clone slug-for-worktree",
          "deprecated": "instance clone slug-for-worktree",
          "hidden": true,
          "id": "clone.slug-for-worktree",
          "match": "command+mode",
        },
        {
          "command": "db migrate",
          "deprecated": "instance db migrate",
          "hidden": true,
          "id": "db.migrate",
          "match": "command+mode",
        },
        {
          "command": "reset dev",
          "deprecated": "instance reset",
          "hidden": true,
          "id": "reset.dev",
          "match": "command+mode",
        },
        {
          "command": "backup create",
          "deprecated": "instance backup create",
          "hidden": true,
          "id": "backup.create",
          "match": "command+mode",
        },
        {
          "command": "backup import",
          "deprecated": "instance backup import",
          "hidden": true,
          "id": "backup.import",
          "match": "command+mode",
        },
        {
          "command": "backup export-api-configs",
          "deprecated": "instance backup export-api-configs",
          "hidden": true,
          "id": "backup.export-api-configs",
          "match": "command+mode",
        },
        {
          "command": "backup import-api-configs",
          "deprecated": "instance backup import-api-configs",
          "hidden": true,
          "id": "backup.import-api-configs",
          "match": "command+mode",
        },
      ]
    `);
  });

  it("every CANONICAL (non-deprecated) descriptor path is unique", () => {
    // The command-routing contract: alias descriptors deliberately REUSE the canonical id, so the old
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
    // The id-keyed handler map lives in `buildHandlers()` in index.mjs. The
    // `instance` GROUP head has NO handler (it is dispatched specially to group
    // help), so it is exempt. Alias ids are covered by their canonical twin (same id).
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
      "no canonical or alias descriptor may live under a `dev` head",
    ).toEqual([]);
    // And no deprecated alias may still target a `dev …` form.
    const aliasesTargetingDev = COMMAND_DESCRIPTORS.filter(
      (d) => d.deprecated && d.deprecated.split(" ")[0] === "dev",
    );
    expect(aliasesTargetingDev).toEqual([]);
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

    // Class-C canonical namespace (`instance …`, renamed cinatra-cli#61) —
    // longest-match across variable depth.
    [["instance", "setup"], "setup"], // no-mode group form (hidden internal phase)
    [["instance", "setup", "dev"], "setup.dev|prod"], // hidden internal phase (cinatra-cli#62)
    [["instance", "setup", "prod"], "setup.dev|prod"], // hidden internal phase
    [["instance", "setup", "nango"], "setup.nango"], // hidden internal phase
    // cinatra-cli#62: branch lifecycle renamed to `instance branch setup|teardown`.
    [["instance", "branch", "setup"], "setup.branch"],
    [["instance", "branch", "teardown"], "teardown.branch"],
    // The old `instance setup branch` / `instance teardown branch` forms still
    // route (as deprecated aliases) to the same handler id.
    [["instance", "setup", "branch"], "setup.branch"],
    [["instance", "teardown", "branch"], "teardown.branch"],
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
    [["instance", "refresh"], "dev.refresh"],
    [["instance", "tunnel"], "dev.tunnel"],
    [["instance", "tunnel", "start"], "dev.tunnel"],
    [["instance", "start"], "dev.start"],
    [["instance", "stop"], "dev.stop"],
    [["instance", "restart"], "dev.restart"],
    [["instance", "wordpress"], "dev.wordpress"],
    [["instance", "wordpress", "start"], "dev.wordpress"],
    [["instance", "drupal", "stop"], "dev.drupal"],
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

    // Deprecated bare aliases route to the SAME id as the canonical twin.
    [["setup"], "setup"],
    [["setup", "dev"], "setup.dev|prod"],
    [["setup", "prod"], "setup.dev|prod"],
    // cinatra-cli#62: branch bare aliases re-point at the renamed `branch …` forms.
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
    [["instance", "setup", "bogus"], null],
    [["setup", "bogus"], null],
    // cinatra-cli#62: there is no bare `setup nango` (acceptance item 4) — UNKNOWN.
    [["setup", "nango"], null],
    [["instance", "clone"], null], // no `instance clone` subgroup — unknown (points at `instance --help`).
    [["agents"], null],
    [["agents", "bogus"], null],
    [["mcp", "llm-access", "bogus"], null],
    [["mcp"], null],
    [["bogus"], null],
    // A LITERAL `"dev|prod"` arg must NOT match the alternation token.
    [["instance", "setup", "dev|prod"], null],
    [["setup", "dev|prod"], null],
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

  it("a deprecated alias and its canonical form resolve to the same handler id", () => {
    const alias = matchDescriptor(COMMAND_DESCRIPTORS, ["db", "migrate"]);
    const canonical = matchDescriptor(COMMAND_DESCRIPTORS, ["instance", "db", "migrate"]);
    expect(alias.id).toBe(canonical.id);
    expect(alias.deprecated).toBe("instance db migrate");
    expect(canonical.deprecated).toBeUndefined();
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
    expect(d.deprecated).toBeUndefined();
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

  it("hidden + deprecated descriptors are excluded from the help index", () => {
    const ids = new Set(helpIndex.map((e) => e.command));
    expect(ids.has("setup")).toBe(false); // bare alias
    expect(ids.has("instance setup")).toBe(false); // no-mode form (hidden)
    expect(ids.has("mcp tunnel")).toBe(false); // removed feature
    expect(ids.has("instance")).toBe(false); // group head
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
