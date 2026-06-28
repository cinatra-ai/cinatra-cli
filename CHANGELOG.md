# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.4] - 2026-06-29

### Changed

- **Consolidated `cinatra setup` into `cinatra install --mode dev|prod`** as the
  single idempotent "make this instance exist / make it healthy" command. `install`
  is the only documented bootstrap AND reconcile entrypoint: from a clean machine it
  clones + provisions from zero (`npx cinatra install`); re-run on an existing
  checkout it skips the fresh clone and just re-runs the in-repo setup/reconcile
  phase. The standalone `setup` provisioning phase is **demoted to an internal
  phase** — it is dropped from the documented top-level command surface (no help
  row for `instance setup dev|prod` or `instance setup nango`), but it still runs
  (install invokes it, `cinatra doctor --fix` self-heals through it, and the
  `pnpm setup:dev` dev hook still works). Running `cinatra instance setup … --help`
  now steers you to `cinatra install --mode dev|prod`. The branch lifecycle stays
  separate (it manages an existing env slice, not a from-zero install) and is
  **renamed** to `cinatra instance branch setup` / `cinatra instance branch teardown`;
  the old `cinatra instance setup branch` / `cinatra instance teardown branch` forms
  (and the bare `cinatra setup branch` / `cinatra teardown branch`) still work this
  release as deprecated aliases that print a one-line stderr rename hint. (#62)
- **BREAKING:** Renamed the `cinatra dev …` command group to `cinatra instance …`.
  The Class-C local host/monorepo bootstrap commands manage a local Cinatra
  *instance* — and several take an explicit `dev|prod` mode — so the `dev` head was
  misleading (`cinatra dev setup prod` was self-contradictory). Every subcommand
  moved verbatim under the new head: the in-repo provisioning phase (folded into
  `cinatra install` by #62), `cinatra instance branch setup|teardown`,
  `cinatra instance db migrate`, the
  `cinatra instance clone …` worktree/seed commands, `cinatra instance refresh`,
  `cinatra instance tunnel`, `cinatra instance start|stop|restart`,
  `cinatra instance wordpress|drupal`, `cinatra instance reset`, and the
  `cinatra instance backup …` commands. `cinatra instance --help` lists the full
  surface. The old `cinatra dev …` namespace is **removed entirely — there is no
  back-compat alias**, so `cinatra dev …` no longer resolves (it exits with
  "Unknown command"). The unrelated bare-path aliases (`cinatra setup dev`,
  `cinatra db migrate`, `cinatra clone …`, `cinatra reset dev`, `cinatra backup …`)
  still work this release and now point their deprecation hint at the new
  `cinatra instance …` form. (#61)

### Added

- `cinatra install --on-conflict=co-use` / `--infra=share` now IMPLEMENTS the
  shared-infra co-use path (previously gated to a loud refusal). A co-use install
  runs a second instance against a donor instance's already-running services — its
  own app port and its own `cinatra_inst_<slug>` database (templated from the
  seed), but the SAME Postgres server, Redis, and Nango (no second Docker stack).
  Isolation is real where it must be: a separate database, a distinct
  `BULLMQ_QUEUE_NAME`, and a per-instance `BETTER_AUTH_COOKIE_PREFIX`. Because two
  instances on `localhost` otherwise share login cookies (the cookie domain is
  port-blind), co-use is **enabled only when the installed app isolates cookies
  per instance** — it probes the donor checkout and, if that support is absent,
  refuses with the exact app change needed and points you at
  `--on-conflict=isolated`. Sharing a donor Graphiti (org-scoped, not
  per-instance) requires the explicit `--allow-shared-graphiti`. Provisioning is
  transactional: a failure rolls back, dropping only the database this run just
  created (a name-shape + created-this-run guard). (#40)
- `cli-smoke` — an all-commands CLI smoke entry-point (`npm run cli-smoke`) that
  exercises every command in the table at the depth that is safe to run without a
  live instance (the no-side-effect surface: `--help` / `--version`, the help-only
  `instance` group head, and the read-only no-instance paths). It asserts that
  `--help` short-circuits before any handler or side-effect for every visible
  command, that every visible command id has a reachable help row (no orphaned or
  undocumented command), and that `--version` reports the package version. This is
  the single release-closeout sweep that catches "passes unit tests but breaks when
  actually run" regressions. (#58)

### Fixed

- `cinatra instance reset` now drops **every** auth table when wiping an instance.
  Previously it left some authentication tables behind, so a "reset" instance could
  retain stale auth state (orphaned accounts / sessions) instead of starting clean.
  The reset now clears the full set of auth tables for a true from-scratch state.
  (#70, PR #71)

### Known issues

The following are known limitations shipping in 0.1.4 and tracked for a follow-up
release (0.1.5):

- `cinatra instance backup` restore is not yet wired end-to-end — backups are
  created, but the restore path needs the remaining glue before it round-trips
  cleanly. (#68)
- The source-checkout production install path has a rough edge; the published
  container image is unaffected and remains the supported production install. (#74)
- `cinatra agents install` can hit a cold-boot ordering issue on a fresh machine.
  (#69)
- `cinatra instance refresh` of the dev companion apps has a known gap. (#73)

## [0.1.3] - 2026-06-25

### Changed

- Namespaced the local host/monorepo bootstrap commands under `cinatra dev …`.
  The commands you run from inside a Cinatra checkout (`setup dev|prod|nango|branch`,
  `teardown branch`, `db migrate`, the `clone …` worktree/seed commands —
  including the renamed `setup clone` → `dev clone new` — `reset dev` → `dev reset`,
  and the `backup …` commands) now live under the `cinatra dev …` group, with
  `dev refresh` / `dev tunnel` / `dev start|stop|restart` / `dev wordpress|drupal`
  keeping their existing paths. `cinatra dev --help` lists the full local-bootstrap
  surface. The top-level funnel (`install`) and the control-plane commands
  (`login`, `status`, `doctor`, `agents …`, `extensions …`, `create-extension`,
  `mcp llm-access …`, `agent export|import`) are unchanged. The old bare forms
  still work this release as DEPRECATED aliases — each prints a one-line stderr
  hint pointing at its `cinatra dev …` form (suppressed for the
  `clone slug-for-worktree` shell hook and via `CINATRA_SUPPRESS_DEPRECATION=1`).
  They will be removed in a future minor; update your scripts to the namespaced
  commands.

### Performance

- `pg` (the one heavy native runtime dependency) is now lazy-loaded behind the
  single database chokepoint instead of being imported at startup, so commands
  that never touch the database (`--help`, `--version`, `login`,
  `create-extension`, `cinatra dev --help`) no longer pay its load cost. The
  local bootstrap commands still run fully LOCALLY — `cinatra dev db migrate`
  and `cinatra dev setup` work even when the app server is down, talking to
  Postgres and local tooling directly.

### Added

- `cinatra install` now detects an existing Cinatra instance whose ports are in
  use and OFFERS + EXECUTES an isolation option instead of just aborting. On a
  terminal it prompts {Isolated / Attach / Abort} and runs your choice; you can
  also pick up front: `--on-conflict=isolated` (a second, fully separate
  instance on a remapped port band + its own app port), `--on-conflict=stop-existing`
  (stop the existing stack first, then install on the default ports),
  `--on-conflict=attach` (re-use / update the existing checkout), or
  `--infra=external` with `--db-url`/`--redis-url`/`--nango-url`/`--graphiti-url`
  (point at your own services). Naming/sizing extras: `--instance <name>`,
  `--app-port <n>`, `--port-offset auto|<n>`. Read-only views: `--list-instances`,
  `--status`. Plus `--dry-run` and `--resume`. Stopping or wiping an existing
  instance always asks for confirmation; `--yes` alone never deletes data.
  Sharing one set of services between two instances (`co-use`,
  `--infra=share`/`--on-conflict=co-use`) is gated for now: it fails loudly and
  points you at `--on-conflict=isolated`. (#17)

### Changed

- Corrected the documented minimum Node.js version to 24 (the bootstrap already
  requires it) in the README and `package.json` engines. (#17)

## [0.1.2] - 2026-06-22

### Changed

- Folded the standalone `create-cinatra-extension` scaffolder into the unified
  CLI as `cinatra create-extension <kind>`, over a shared zero-dependency
  authoring core. The standalone `npx create-cinatra-extension` path is retired
  in favor of `cinatra create-extension <kind>`. Scaffold output remains
  byte-identical to the former standalone scaffolder across all five kinds:
  agent, connector, artifact, skill, and workflow. (#7)

## [0.1.1] - 2026-06-22

### Changed

- Hardened the installer port-gate: fail-loud on a degraded conflict check, a
  `host:port` exemption, and integration tests. (#5)
- Preflight host-port conflict detection before clone and infrastructure
  bring-up. (#4)
- Set the package `author` field. (#6)

## [0.1.0] - 2026-06-22

### Added

- Initial public release of the thin, checkout-driven `cinatra` CLI, published
  as the scoped `@cinatra-ai/cinatra`. (#2)

[0.1.4]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.4
[0.1.3]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.3
[0.1.2]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.0
