# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  commands. (cinatra-ai/engineering#232)

### Performance

- `pg` (the one heavy native runtime dependency) is now lazy-loaded behind the
  single database chokepoint instead of being imported at startup, so commands
  that never touch the database (`--help`, `--version`, `login`,
  `create-extension`, `cinatra dev --help`) no longer pay its load cost. The
  local bootstrap commands still run fully LOCALLY — `cinatra dev db migrate`
  and `cinatra dev setup` work even when the app server is down, talking to
  Postgres and local tooling directly. (cinatra-ai/engineering#232)

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

[0.1.3]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.3
[0.1.2]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.0
