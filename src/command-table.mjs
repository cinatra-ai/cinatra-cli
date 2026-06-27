// ---------------------------------------------------------------------------
// Declarative command table for the `cinatra` CLI (cinatra#255 Stage-1;
// the command-routing contract / Class-C namespacing).
//
// Plain ESM `.mjs`, NO imports, NO heavy deps — importable from anywhere
// (including the eager-`pg`-free unit tests). This module owns the DECLARATIVE
// shape of the command surface (the descriptors) and the PURE matching +
// help-index logic; `index.mjs` owns the HANDLERS (keyed by `id`) that close
// over the run* implementations and their lazy `import()`s.
//
// Why the split: the dispatcher in `index.mjs` was a hand-maintained ~200-line
// `if`-chain and the help banner (`printHelp`) was a separate hand-maintained
// string — the two drifted independently. The descriptors below are the single
// source of truth for "what commands exist"; the matcher replaces the if-chain
// and `buildHelpIndex` lets a drift test assert the help banner and the
// dispatcher stay in lockstep.
//
// MATCHING CONTRACT (the command-routing contract — REPLACES the old first-match-wins contract):
//   * Selection is LONGEST-MATCH-WINS, not first-match-wins. `matchDescriptor`
//     collects every descriptor whose `path` prefix-matches the leading argv
//     tokens and returns the one with the LONGEST `path`. This is required
//     because namespacing under `instance` introduces variable-depth paths under
//     one head (`["instance","setup"]` vs `["instance","setup","dev|prod"]` vs
//     `["instance","setup","nango"]`), where a shorter group/no-mode entry must
//     NOT shadow a longer, more-specific one. Array ORDER is no longer load-bearing
//     for selection; a `validateCommandTable` assertion at module load fails the
//     build loudly on any ambiguous tie, so ordering can never be relied upon.
//   * Match kinds are sugar over path-length prefix-matching:
//       - "command"           : pure prefix-match on `path` (length 1) — the
//                               command alone routes, trailing tokens ignored
//                               (e.g. `status`, `doctor`).
//       - "command+mode"      : pure prefix-match on `path` (length 2).
//       - "command+mode+sub"  : pure prefix-match on `path` (length 3).
//       - "group"             : a help-only head (`["instance"]`). Routes ONLY
//                               when argv is EXACTLY the head with no further
//                               routable subcommand (length-exact, like no-mode),
//                               so a longer `instance …` descriptor always wins.
//                               Has NO handler; `runCli` dispatches it specially
//                               to group help.
//       - "command-no-mode"   : NOT pure prefix-match. Matches ONLY when
//                               `argv.length === path.length` (no trailing
//                               routable token), mirroring the original
//                               `!mode` guard so `instance setup bogus` (and the
//                               alias `setup bogus`) route to UNKNOWN, never to
//                               the env-driven setup.
//   * A `deprecated` descriptor (an OLD bare path kept as a hidden alias for one
//     minor) participates in matching exactly like its canonical twin (same
//     effective path-length), and carries `deprecated: "<new path>"`. The
//     dispatcher prints a one-line stderr deprecation notice then routes to the
//     SAME handler id. `validateCommandTable` guarantees no alias ever shadows a
//     real canonical command.
//   * The dispatcher computes `rest = argv.slice(path.length)` (everything AFTER
//     the routed tokens) and `routedTokens = argv.slice(0, path.length)`. A
//     handler that needs a routed token (e.g. the `dev|prod` mode) reads it from
//     `routedTokens`. Canonical and alias forms deliver an IDENTICAL `rest` to
//     the shared handler because each slices off its own path length.
//   * `hidden: true` marks dispatch-only descriptors with no standalone help row
//     (the env-driven no-mode entries, the removed `mcp tunnel` stub, every
//     deprecated alias, and the `instance` group head). The dispatcher still routes
//     them; `buildHelpIndex` does not advertise them.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandDescriptor
 * @property {string} id        Stable handler key (index.mjs HANDLERS[id]). Alias
 *                              descriptors deliberately REUSE the canonical id.
 * @property {string[]} path    The literal token(s) that route to this command.
 * @property {"command"|"command-no-mode"|"command+mode"|"command+mode+sub"|"group"} match  Match kind.
 * @property {boolean} [hidden] Dispatch-only (no standalone help row) when true.
 * @property {string} [deprecated] When set, this is a deprecated alias; the value
 *                              is the canonical path (space-joined) the dispatcher
 *                              names in its deprecation notice. Always `hidden`.
 * @property {string} [summary] One-line description for the help index.
 */

/**
 * The canonical command surface. With longest-match selection, array order is
 * NOT load-bearing for routing (a load-time `validateCommandTable` assertion
 * forbids ambiguity). Order is kept readable/grouped for humans + the snapshot.
 *
 * @type {CommandDescriptor[]}
 */
export const COMMAND_DESCRIPTORS = [
  // ----- Top-level funnel + Class-A/B control plane (stay bare; NOT namespaced) -----
  {
    id: "install",
    path: ["install"],
    match: "command",
    summary: "Bootstrap a Cinatra dev/prod instance from zero (clone, env, infra, setup).",
  },
  {
    id: "update",
    path: ["update"],
    match: "command",
    summary: "Update the CLI or an instance (two-choice; non-TTY defaults to the instance).",
  },
  {
    id: "upgrade",
    path: ["upgrade"],
    match: "command",
    summary: "Alias for `cinatra update`.",
  },
  {
    id: "login",
    path: ["login"],
    match: "command",
    summary: "Sign in to a Cinatra instance (browser OAuth) and cache the token.",
  },
  {
    id: "status",
    path: ["status"],
    match: "command",
    summary: "Show current setup state (auth tables, user count, MCP config).",
  },
  {
    id: "logs",
    path: ["logs"],
    match: "command",
    summary: "Tail the dev-main app log and/or docker compose container logs.",
  },
  {
    id: "skills.reset-repo",
    path: ["skills", "reset-repo"],
    match: "command+mode",
    summary: "Force-push the local skills store to the connected GitHub repo (dev only).",
  },
  {
    id: "extensions.purge",
    path: ["extensions", "purge"],
    match: "command+mode",
    summary: "Fully remove an extension everywhere (dev only; loopback; destructive).",
  },
  {
    id: "extensions.acquire-prod",
    path: ["extensions", "acquire-prod"],
    match: "command+mode",
    summary: "Download the production required-extension set into extensions/.",
  },
  {
    id: "extensions.submit",
    path: ["extensions", "submit"],
    match: "command+mode",
    summary: "Submit a built extension tarball to the Cinatra Marketplace for review.",
  },
  {
    id: "extensions.list",
    path: ["extensions", "list"],
    match: "command+mode",
    summary: "List installed extensions (name, kind, version) from the extensions/ tree.",
  },
  {
    id: "create-extension",
    path: ["create-extension"],
    match: "command",
    summary: "Scaffold a new Cinatra extension package on disk (agent|connector|artifact|skill|workflow).",
  },
  {
    id: "mcp.tunnel",
    path: ["mcp", "tunnel"],
    match: "command+mode",
    hidden: true, // Removed feature — routes to a guidance error, not advertised.
  },
  {
    id: "doctor",
    path: ["doctor"],
    match: "command",
    summary: "READ-ONLY content-editor write-path self-check (the \"done\" gate).",
  },
  {
    id: "mcp.llm-access.setup",
    path: ["mcp", "llm-access", "setup"],
    match: "command+mode+sub",
    summary: "Provision OAuth clients for OpenAI, Anthropic, and Gemini (dev only).",
  },
  {
    id: "mcp.llm-access.refresh",
    path: ["mcp", "llm-access", "refresh"],
    match: "command+mode+sub",
    summary: "Rotate all LLM provider client secrets.",
  },
  {
    id: "mcp.llm-access.verify",
    path: ["mcp", "llm-access", "verify"],
    match: "command+mode+sub",
    summary: "Alias for `cinatra doctor`.",
  },
  {
    id: "agents.install",
    path: ["agents", "install"],
    match: "command+mode",
    summary: "Resolve and install an agent package tree from Verdaccio.",
  },
  {
    id: "agents.list",
    path: ["agents", "list"],
    match: "command+mode",
    summary: "List installed agents (package, version, role) from cinatra-agents.lock.",
  },
  {
    id: "agents.uninstall",
    path: ["agents", "uninstall"],
    match: "command+mode",
    summary: "Remove an installed agent (DB template rows + lockfile entry).",
  },
  {
    id: "agent.export",
    path: ["agent", "export"],
    match: "command+mode",
    summary: "Export an agent template to a portable ZIP archive.",
  },
  {
    id: "agent.import",
    path: ["agent", "import"],
    match: "command+mode",
    summary: "Import an agent template from a ZIP archive created by `agent export`.",
  },

  // ----- Class-C local host/monorepo bootstrap — namespaced under `cinatra instance …` (the command-routing contract; cinatra-cli#61) -----
  // The `instance …` head (cinatra-cli#61): these manage a local Cinatra
  // *instance* and several take an explicit `dev|prod` mode, so a `dev` head was
  // misleading (`cinatra dev setup prod` was self-contradictory). The old `dev …`
  // head is REMOVED with no back-compat alias — `cinatra dev …` no longer resolves.
  // (The bare-path aliases below are a SEPARATE deprecation lane and now
  // point at the `instance …` canonical forms.)
  {
    id: "instance",
    path: ["instance"],
    match: "group",
    hidden: true, // Help-only head — `cinatra instance` / `cinatra instance --help` print the group banner.
    summary: "Local host/monorepo bootstrap commands (run `cinatra instance --help`).",
  },
  {
    id: "setup",
    path: ["instance", "setup"],
    match: "command-no-mode", // ONLY when no mode token follows (env-driven dev|prod).
    hidden: true, // No standalone help row.
  },
  {
    id: "setup.dev|prod",
    path: ["instance", "setup", "dev|prod"],
    match: "command+mode+sub",
    summary: "Prepare Better Auth, schema, Nango, MCP server, and OAuth clients.",
  },
  {
    id: "setup.nango",
    path: ["instance", "setup", "nango"],
    match: "command+mode+sub",
    summary: "Configure Nango administration only.",
  },
  {
    id: "setup.branch",
    path: ["instance", "setup", "branch"],
    match: "command+mode+sub",
    summary: "Provision an isolated dev environment for the current git worktree.",
  },
  {
    id: "teardown.branch",
    path: ["instance", "teardown", "branch"],
    match: "command+mode+sub",
    summary: "Remove the isolated Postgres schema for the current git worktree.",
  },
  {
    id: "setup.clone",
    path: ["instance", "clone", "new"],
    match: "command+mode+sub",
    summary: "Create + provision a dormant deep-fork clone.",
  },
  {
    id: "clone.refresh-seed",
    path: ["instance", "clone", "refresh-seed"],
    match: "command+mode+sub",
    summary: "(Re)build the cinatra_seed template database.",
  },
  {
    id: "clone.prune",
    path: ["instance", "clone", "prune"],
    match: "command+mode+sub",
    summary: "Destroy a clone (drops its DB, cleans Redis, releases the slot).",
  },
  {
    id: "clone.list",
    path: ["instance", "clone", "list"],
    match: "command+mode+sub",
    summary: "List registered clones (slug, ports, database, state, worktree).",
  },
  {
    id: "clone.start",
    path: ["instance", "clone", "start"],
    match: "command+mode+sub",
    summary: "Start a registered clone.",
  },
  {
    id: "clone.stop",
    path: ["instance", "clone", "stop"],
    match: "command+mode+sub",
    summary: "Stop a registered clone.",
  },
  {
    id: "clone.status",
    path: ["instance", "clone", "status"],
    match: "command+mode+sub",
    summary: "Show a clone's predicted-vs-registered runtime status.",
  },
  {
    id: "clone.slug-for-worktree",
    path: ["instance", "clone", "slug-for-worktree"],
    match: "command+mode+sub",
    summary: "Registry lookup for shell hooks (resolve a worktree to its slug).",
  },
  {
    id: "db.migrate",
    path: ["instance", "db", "migrate"],
    match: "command+mode+sub",
    summary: "Apply the additive bootstrap + versioned core migration chain (server-down-safe).",
  },
  {
    id: "dev.refresh",
    path: ["instance", "refresh"],
    match: "command+mode",
    summary: "Reconcile your local dev environment (deps + dev DB schema).",
  },
  {
    id: "dev.tunnel",
    path: ["instance", "tunnel"],
    match: "command+mode",
    summary: "Manage the dev-main Tailscale Funnel (start|stop|status).",
  },
  {
    id: "dev.start",
    path: ["instance", "start"],
    match: "command+mode",
    summary: "Start the local dev main instance (host-native `pnpm dev` on port 3000).",
  },
  {
    id: "dev.stop",
    path: ["instance", "stop"],
    match: "command+mode",
    summary: "Stop the local dev main instance started by `instance start`.",
  },
  {
    id: "dev.restart",
    path: ["instance", "restart"],
    match: "command+mode",
    summary: "Restart the local dev main instance (`instance stop` then `instance start`).",
  },
  {
    id: "dev.wordpress",
    path: ["instance", "wordpress"],
    match: "command+mode",
    summary: "Manage the WordPress CMS dev container (start|stop) via the compose `wordpress` profile.",
  },
  {
    id: "dev.drupal",
    path: ["instance", "drupal"],
    match: "command+mode",
    summary: "Manage the Drupal CMS dev container (start|stop) via the compose `drupal` profile.",
  },
  {
    id: "reset.dev",
    path: ["instance", "reset"],
    match: "command+mode",
    summary: "Reset the development environment (requires --yes; dev only).",
  },
  {
    id: "backup.create",
    path: ["instance", "backup", "create"],
    match: "command+mode+sub",
    summary: "Export a full backup bundle to data/backups/.",
  },
  {
    id: "backup.import",
    path: ["instance", "backup", "import"],
    match: "command+mode+sub",
    summary: "Import a backup bundle (destructive — requires --yes).",
  },
  {
    id: "backup.export-api-configs",
    path: ["instance", "backup", "export-api-configs"],
    match: "command+mode+sub",
    summary: "Export connector_config:* + openai_connection metadata to JSON.",
  },
  {
    id: "backup.import-api-configs",
    path: ["instance", "backup", "import-api-configs"],
    match: "command+mode+sub",
    summary: "Import API configs from an export-api-configs JSON file.",
  },

  // ----- Deprecated LOCAL aliases (one minor) — old bare paths → their `instance …` forms -----
  // Each REUSES the canonical id, is `hidden`, and carries `deprecated:"<new>"`.
  // They reserve the old bare token paths LOCAL during the deprecation window
  // (OD-1(A)): a future Class-A remote/admin variant of `db migrate` /
  // `agent …` (the CLI remote-target security model) must take a DISTINCT `admin …` head, never these tokens.
  // cinatra-cli#61: their targets now point at the `instance …` canonical forms
  // (the `dev …` namespace they used to alias no longer exists).
  {
    id: "setup",
    path: ["setup"],
    match: "command-no-mode",
    hidden: true,
    deprecated: "instance setup",
  },
  {
    id: "setup.dev|prod",
    path: ["setup", "dev|prod"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance setup",
  },
  {
    id: "setup.nango",
    path: ["setup", "nango"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance setup nango",
  },
  {
    id: "setup.branch",
    path: ["setup", "branch"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance setup branch",
  },
  {
    id: "teardown.branch",
    path: ["teardown", "branch"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance teardown branch",
  },
  {
    id: "setup.clone",
    path: ["setup", "clone"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone new",
  },
  {
    id: "clone.refresh-seed",
    path: ["clone", "refresh-seed"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone refresh-seed",
  },
  {
    id: "clone.prune",
    path: ["clone", "prune"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone prune",
  },
  {
    id: "clone.list",
    path: ["clone", "list"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone list",
  },
  {
    id: "clone.start",
    path: ["clone", "start"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone start",
  },
  {
    id: "clone.stop",
    path: ["clone", "stop"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone stop",
  },
  {
    id: "clone.status",
    path: ["clone", "status"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone status",
  },
  {
    id: "clone.slug-for-worktree",
    path: ["clone", "slug-for-worktree"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance clone slug-for-worktree",
  },
  {
    id: "db.migrate",
    path: ["db", "migrate"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance db migrate",
  },
  {
    id: "reset.dev",
    path: ["reset", "dev"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance reset",
  },
  {
    id: "backup.create",
    path: ["backup", "create"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance backup create",
  },
  {
    id: "backup.import",
    path: ["backup", "import"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance backup import",
  },
  {
    id: "backup.export-api-configs",
    path: ["backup", "export-api-configs"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance backup export-api-configs",
  },
  {
    id: "backup.import-api-configs",
    path: ["backup", "import-api-configs"],
    match: "command+mode",
    hidden: true,
    deprecated: "instance backup import-api-configs",
  },
];

/**
 * Expand a path token's alternation into its concrete alternatives. A plain
 * token returns `[token]`; an `a|b` token returns `["a","b"]`.
 *
 * @param {string} token
 * @returns {string[]}
 */
function expandToken(token) {
  return token.includes("|") ? token.split("|") : [token];
}

/**
 * A single path token matches an argv slot. For a plain token, the slot must
 * equal it. For an `a|b` alternation token, the slot must be one of the EXPANDED
 * alternatives — never the literal `"a|b"` string. This mirrors the original
 * `mode === "dev" || mode === "prod"` guard exactly: `cinatra instance setup dev`
 * and `cinatra instance setup prod` route, but a literal `"dev|prod"` slot does NOT.
 *
 * @param {string} token
 * @param {string|undefined} slot
 * @returns {boolean}
 */
function tokenMatches(token, slot) {
  if (slot === undefined) return false;
  return expandToken(token).includes(slot);
}

/**
 * Does this descriptor's `path` route the given argv?
 *
 *  - "command-no-mode" / "group": LENGTH-EXACT — every path token matches AND
 *    argv has NO trailing routable token (`argv.length === path.length`). This
 *    mirrors the original `!mode` guard so a trailing non-mode token routes to
 *    UNKNOWN, never to the env-driven/group form.
 *  - everything else: PURE PREFIX — every path token matches the corresponding
 *    leading argv slot; trailing argv tokens (flags, positionals) are ignored.
 *
 * @param {CommandDescriptor} d
 * @param {string[]} argv
 * @returns {boolean}
 */
function descriptorMatches(d, argv) {
  const { path } = d;
  if (argv.length < path.length) return false;
  for (let i = 0; i < path.length; i++) {
    if (!tokenMatches(path[i], argv[i])) return false;
  }
  if (d.match === "command-no-mode" || d.match === "group") {
    // Length-exact: the path may not be a strict prefix of the argv.
    return argv.length === path.length;
  }
  return true;
}

/**
 * Find the descriptor that routes `argv` under LONGEST-MATCH-WINS semantics:
 * among ALL descriptors whose path prefix-matches the leading argv tokens, the
 * one with the LONGEST `path` is selected. Returns `null` when nothing matches
 * (the caller then applies its `agents`-no-mode fallback and the unknown throw).
 *
 * A `validateCommandTable` assertion (run at module load) guarantees there is
 * never an ambiguous tie at equal length, so the longest match is deterministic.
 *
 * @param {CommandDescriptor[]} descriptors
 * @param {string[]} argv
 * @returns {CommandDescriptor|null}
 */
export function matchDescriptor(descriptors, argv) {
  let best = null;
  for (const d of descriptors) {
    if (!descriptorMatches(d, argv)) continue;
    if (best === null || d.path.length > best.path.length) {
      best = d;
    }
  }
  return best;
}

/**
 * Effective matched LENGTH for ambiguity analysis: the number of leading argv
 * tokens a descriptor binds (its `path.length`).
 *
 * @param {CommandDescriptor} d
 * @returns {number}
 */
function effectiveLength(d) {
  return d.path.length;
}

/**
 * The set of concrete leading-token SEQUENCES (token arrays) a descriptor's path
 * expands to (alternation slots produce a product). Returns arrays — NOT joined
 * strings — so token boundaries are never lost (a token containing a space could
 * otherwise alias a distinct sequence). Used to detect ambiguous collisions that
 * raw-string path equality would miss (`["x","dev|prod"]` vs `["x","dev"]`).
 *
 * @param {CommandDescriptor} d
 * @returns {string[][]} expanded token sequences
 */
function expandedPaths(d) {
  let sequences = [[]];
  for (const token of d.path) {
    const alts = expandToken(token);
    const next = [];
    for (const seq of sequences) {
      for (const alt of alts) next.push([...seq, alt]);
    }
    sequences = next;
  }
  return sequences;
}

/**
 * Load-time table-validity assertion (the command-routing contract). Fails the build
 * LOUDLY (throws) on any condition that would make longest-match routing
 * ambiguous or let an alias shadow a real command:
 *
 *   (1) two NON-deprecated descriptors that TIE — same effective length AND an
 *       overlapping expanded leading-token sequence (alternation-aware), where
 *       neither is a legitimate group/no-mode prefix pair;
 *   (2) a `deprecated` whose expanded path collides with any canonical
 *       (non-deprecated) expanded path (an alias must never shadow a real one);
 *   (3) a `deprecated.target` that does not resolve to a real canonical path;
 *   (4) a `deprecated` descriptor that is not also `hidden`.
 *
 * A strict-prefix pair is ALLOWED when the shorter descriptor is a `group` head
 * or a `command-no-mode` leaf (both length-exact, so they never ambiguously
 * shadow a longer descriptor). A shorter PLAIN-prefix leaf that would
 * ambiguously shadow a longer descriptor is forbidden.
 *
 * @param {CommandDescriptor[]} descriptors
 * @returns {true}
 */
export function validateCommandTable(descriptors) {
  const canonical = descriptors.filter((d) => !d.deprecated);
  const deprecated = descriptors.filter((d) => d.deprecated);

  // An unambiguous key for an expanded token sequence — JSON-encoded so tokens
  // containing spaces/empties can never alias distinct sequences (codex
  // SHOULD-FIX). `expandedPaths` returns token ARRAYS, so boundaries are never
  // lost upstream of this key.
  const key = (seq) => JSON.stringify(seq);
  const seqs = (d) => expandedPaths(d);

  // True when `short` is a strict PREFIX of `long` (every short token leads long).
  const isStrictPrefix = (short, long) => {
    if (short.length >= long.length) return false;
    for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false;
    return true;
  };

  // A descriptor whose match kind makes it LENGTH-EXACT (it only routes when
  // argv.length === path.length) cannot ambiguously shadow a longer descriptor.
  const isLengthExact = (d) => d.match === "command-no-mode" || d.match === "group";

  // Canonical expanded-path key → descriptor, for exact shadow + target lookup.
  /** @type {Map<string, CommandDescriptor>} */
  const canonicalByPath = new Map();
  for (const d of canonical) {
    for (const seq of seqs(d)) {
      const k = key(seq);
      const existing = canonicalByPath.get(k);
      if (existing && existing !== d) {
        throw new Error(
          `command-table: ambiguous canonical descriptors for "${seq.join(" ")}" ` +
            `(ids "${existing.id}" and "${d.id}").`,
        );
      }
      canonicalByPath.set(k, d);
    }
  }

  // (1) Tie detection among canonical descriptors at EQUAL effective length AND
  //     (1b) strict-PREFIX shadowing: a shorter PLAIN-prefix leaf (NOT group,
  //     NOT command-no-mode) that is a strict prefix of a longer descriptor
  //     would steal the longer descriptor's argv (e.g. plain `["instance"]` shadowing
  //     `["instance","setup"]` for `instance typo`). Length-exact shorter forms are the
  //     ONLY allowed strict-prefix case (codex MUST-FIX).
  for (let i = 0; i < canonical.length; i++) {
    for (let j = i + 1; j < canonical.length; j++) {
      const a = canonical[i];
      const b = canonical[j];
      const seqsA = seqs(a);
      const seqsB = seqs(b);
      if (effectiveLength(a) === effectiveLength(b)) {
        const setA = new Set(seqsA.map(key));
        if (seqsB.map(key).some((k) => setA.has(k))) {
          throw new Error(
            `command-table: ambiguous tie between canonical descriptors ` +
              `"${a.id}" (${a.path.join(" ")}) and "${b.id}" (${b.path.join(" ")}) ` +
              `at equal length ${effectiveLength(a)}.`,
          );
        }
        continue;
      }
      // Different lengths: forbid a shorter PLAIN-prefix leaf shadowing a longer.
      const [shortD, shortSeqs, longSeqs] =
        effectiveLength(a) < effectiveLength(b) ? [a, seqsA, seqsB] : [b, seqsB, seqsA];
      if (isLengthExact(shortD)) continue; // group / no-mode never shadow.
      for (const s of shortSeqs) {
        for (const l of longSeqs) {
          if (isStrictPrefix(s, l)) {
            throw new Error(
              `command-table: canonical descriptor "${shortD.id}" (${s.join(" ")}) is a ` +
                `plain-prefix LEAF that would shadow a longer command (${l.join(" ")}); ` +
                `make it a group/no-mode form or re-path it.`,
            );
          }
        }
      }
    }
  }

  // (5) two deprecated aliases must not share an expanded path. Key on the
  //     descriptor IDENTITY (object), not its id — alias descriptors reuse the
  //     canonical id, so an id-based check would miss a real path collision
  //     between two distinct descriptors that share an id (codex MUST-FIX).
  /** @type {Map<string, CommandDescriptor>} */
  const aliasByPath = new Map();
  for (const d of deprecated) {
    for (const seq of seqs(d)) {
      const k = key(seq);
      const prior = aliasByPath.get(k);
      if (prior && prior !== d) {
        throw new Error(
          `command-table: two deprecated aliases collide on path "${seq.join(" ")}" ` +
            `("${prior.id}" and "${d.id}").`,
        );
      }
      aliasByPath.set(k, d);
    }
  }

  for (const d of deprecated) {
    // (4) every deprecated alias must be hidden.
    if (!d.hidden) {
      throw new Error(
        `command-table: deprecated alias "${d.id}" (${d.path.join(" ")}) must be hidden.`,
      );
    }
    // (2) an alias must never collide with a canonical command — checked as
    //     EXACT path equality AND strict-prefix shadowing (an alias that is a
    //     strict prefix of, or strictly prefixed by, a canonical leaf would
    //     mis-route). Length-exact alias forms only need the exact-equality
    //     check (they never prefix-shadow).
    for (const aliasSeq of seqs(d)) {
      const exact = canonicalByPath.get(key(aliasSeq));
      if (exact) {
        throw new Error(
          `command-table: deprecated alias "${d.id}" (${aliasSeq.join(" ")}) shadows ` +
            `canonical command "${exact.id}".`,
        );
      }
      for (const c of canonical) {
        // A canonical plain leaf SHORTER than the alias would steal the alias's
        // argv; a canonical descriptor LONGER than a plain-prefix alias would be
        // stolen by the alias. Either direction is a shadow.
        for (const cSeq of seqs(c)) {
          if (isStrictPrefix(cSeq, aliasSeq) && !isLengthExact(c)) {
            throw new Error(
              `command-table: deprecated alias "${d.id}" (${aliasSeq.join(" ")}) is shadowed by ` +
                `canonical plain-prefix command "${c.id}" (${cSeq.join(" ")}).`,
            );
          }
          if (isStrictPrefix(aliasSeq, cSeq) && !isLengthExact(d)) {
            throw new Error(
              `command-table: deprecated alias "${d.id}" (${aliasSeq.join(" ")}) is a plain-prefix ` +
                `that would shadow canonical command "${c.id}" (${cSeq.join(" ")}).`,
            );
          }
        }
      }
    }
    // (3) the alias target must resolve to an EXACT canonical path (not router
    //     prefix semantics — `"foo bogus"` must NOT resolve to plain `["foo"]`).
    const targetSeq = d.deprecated.split(" ");
    if (!canonicalByPath.has(key(targetSeq))) {
      throw new Error(
        `command-table: deprecated alias "${d.id}" targets "${d.deprecated}", ` +
          `which does not resolve to a canonical command path.`,
      );
    }
  }

  return true;
}

// Assert the real table is valid at module load — a malformed edit fails the
// build/test loudly rather than silently mis-routing.
validateCommandTable(COMMAND_DESCRIPTORS);

/**
 * A deterministic, human-readable index of the (visible) command surface,
 * derived purely from the descriptors. The drift test snapshots this and
 * asserts the union of `printHelp` + `printGroupHelp("instance")` covers every
 * visible command (and vice-versa), so the dispatcher and the banner can never
 * silently diverge.
 *
 * Hidden descriptors AND deprecated aliases are excluded — neither has a help
 * row. (Aliases are excluded by the `deprecated` property as well as `hidden`,
 * so a future edit that forgets `hidden` still cannot leak an alias into help.)
 *
 * @param {CommandDescriptor[]} descriptors
 * @returns {{ id: string, command: string, summary: string }[]}
 */
export function buildHelpIndex(descriptors) {
  return descriptors
    .filter((d) => !d.hidden && !d.deprecated)
    .map((d) => ({
      id: d.id,
      command: d.path.join(" "),
      summary: d.summary ?? "",
    }));
}

/**
 * True when `argv` carries a help request (`--help` or `-h`) as a recognized
 * affordance. The dispatcher uses this to SHORT-CIRCUIT to a usage print BEFORE
 * any handler (and therefore any side effect) runs — this is the guard that
 * stops `cinatra install --help` from kicking off a real from-zero install
 * (cinatra#255 footgun: `--help` was an unknown flag the per-command parsers
 * silently ignored, so the destructive handler executed).
 *
 * Scanning stops at the conventional `--` end-of-flags separator, so a literal
 * `-h` / `--help` that a future command might accept as a positional VALUE
 * (after `--`) is not mistaken for a help request.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function hasHelpFlag(argv) {
  for (const token of argv) {
    if (token === "--") break; // end-of-flags: anything after is positional.
    if (token === "--help" || token === "-h") return true;
  }
  return false;
}
