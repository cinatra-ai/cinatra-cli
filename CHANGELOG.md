# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed

- `create-extension` no longer offers the `workflow` kind — the workflow
  extension kind is retired. The scaffolder now supports exactly four kinds
  (`agent`, `connector`, `artifact`, `skill`); requesting `workflow` is a usage
  error, and the `templates/workflow/` scaffold tree has been deleted.

### Fixed

- `install --mode prod` now provisions AND validates the full hard-required
  secret set before reporting success. It mints a valid 32-byte
  `CINATRA_ENCRYPTION_KEY` (and the distinct WayFlow `CINATRA_CONTEXT_ATTEST_KEY`)
  when missing, preserves a valid existing key untouched — including across
  `--reset-env` — and aborts on a malformed encryption key rather than rotating
  it (which would orphan already-encrypted data). A new post-install gate
  validates `.env.local` against the app's required-env contract and fails the
  install naming every missing or malformed required var, instead of a silent
  success that crashes on first prod boot. (#143)
- The default (non-isolated) `install` brings up Compose with
  `--env-file .env.local`, so `${NANGO_ENCRYPTION_KEY}` (and the other minted
  secrets the base `docker-compose.yml` interpolates) reach the containers
  instead of resolving blank; a missing `.env.local` now fails the install with
  an actionable message rather than silently starting empty-secret containers.
  Restores the #108 fix that #112 dropped. (#144)
- Post-install run guidance is now mode-aware: a `--mode prod` install points at
  the supported image lifecycle (pull the pinned published release image + deploy
  via the ops Compose flow, plus `cinatra instance preview create` for local
  prod-mode verification) instead of `pnpm dev`. Dev/demo guidance is unchanged.
  (#146)
- `cinatra instance start` / `restart` refuse a production-mode checkout
  (fail-closed on the raw `.env.local` runtime mode) rather than host-booting
  `pnpm dev`, and print the same image-lifecycle guidance. (#146)
- `cinatra update --instance --ref <ref>` is rejected for a production instance —
  a git ref is not proof the corresponding published image exists; select a
  released version by image tag/digest. (#146)
- `install --dry-run` previews the isolation/port intent the real run would
  execute: `--on-conflict=isolated` with a detected conflict now shows an
  advisory app port / band offset / remapped band (matching the real isolated
  allocation flag-for-flag), a bare conflict lists the resolution choices
  instead of assuming isolation, and the preview makes no registry reservation
  and acquires no allocation lock. (#147)

## [0.1.8] - 2026-07-07

### Fixed

- `agent import` repairs the local Postgres path via the shared upsert
  helper. (#95)
- `install --on-conflict=isolated` remaps app-facing self-URLs to the
  isolated instance. (#98)
- Non-pinned dev extension sync tolerates a detached companion. (#100)
- `extensions verify-prod` resolves the agent runtime mount instead of the
  deleted install-dir knob. (#101)
- `agents install` / `agent import` / `agents uninstall` no longer crash
  against the live app schema (partial-unique agent index, text ids); the
  upsert and the uninstall lookup match the live schema shape. (#106)
- `install --on-conflict=isolated` resolves the compose config with all
  profiles, so profile-gated companion services (wayflow) move to the
  isolated port band instead of keeping the donor instance's URL. (#107)
- The default infra `up` passes `--env-file .env.local`, so
  `NANGO_ENCRYPTION_KEY` no longer resolves blank. (#108)
- `install` no longer refuses when a legacy basename project exists only in
  other, known checkouts — that refusal bricked every install into a
  directory named `cinatra` on hosts where a different checkout had run a
  legacy default stack. A legacy project rooted in the target directory, or
  with an unattributable owner, is still refused. (#109)
- `status` and `doctor` degrade gracefully when the local database is down
  or un-migrated — `status` emits a machine-readable degraded payload and
  `doctor` a FAIL assertion with remediation — instead of crashing on a bare
  connection error. (#112)
- `instance refresh` / `instance setup` apply the checkout's schema
  bootstrap before the core migration chain (matching the boot order), so
  updating an existing instance no longer aborts mid-chain on tables only
  the checkout's DDL creates; detached companion checkouts are reconciled
  to the committed lock; and a same-version local-registry seed skew on
  committed-lock pins warns without flipping the exit code. (#115)

### Added

- Layer-1 artifact-parity screen in the kind gate (`produces` implies a
  runnable materialization). (#102)

### Security

- Hardened the scaffolded extension templates: the kind gate strips
  comment/CDATA splices to a fixpoint, and every kind template's CI workflow
  declares least-privilege `permissions: contents: read`. (#114)

## [0.1.7] - 2026-07-02

### Changed

- Renamed the `dev` command to `instance` (manages named Cinatra instances).
- Replaced `setup` with `install` plus an explicit `--mode` flag.

### Removed

- Removed the legacy bare-form command aliases.
- Removed all references to the retired `create-cinatra-extension` package.

### Added

- Added `extensions verify-prod` to check a running instance against its
  required-extension lock.

## [0.1.6] - 2026-06-30

Compatibility backport. This is the version the Cinatra app pins. It carries the
prior (0.1.3) `cinatra setup dev|prod` command surface plus only the production
extension-acquisition fix, so the app can pin a fixed CLI without adopting the
0.1.4/0.1.5 command-surface migration.

### Fixed

- **Production extension acquisition no longer fails on the pnpm workspace
  symlink.** Backports the `cinatra-ai/cinatra#735` fix onto the 0.1.3 command
  surface: the acquired-tree re-verify walk (`computeTreeSha256FromDir`) now
  skips a `node_modules` install root even when pnpm lands it as a symlink — the
  in-repo `@cinatra-ai/sdk-extensions` workspace package linked into each acquired
  extension's `node_modules` — instead of failing closed on the non-regular entry.
  Branched from `v0.1.3` and ports ONLY this fix (none of the `dev`→`instance`,
  `setup`→internal-phase, or bare-form-removal refactors). Integrity is unchanged:
  a device/FIFO `node_modules`, and any symlink OUTSIDE `node_modules`, still
  hard-fail. (`cinatra-ai/cinatra#735`)

## [0.1.5] - 2026-06-30

The new/reorganized command surface plus the production extension-acquisition fix
at the new boundary. Published, but the Cinatra app stays on the 0.1.6 backport
for this release cycle; adopting this surface is tracked in
`cinatra-ai/cinatra#742`.

### Changed

- **`cinatra create-extension` now ships the FULL self-contained kind gate into
  EVERY scaffolded extension repo (all five kinds), and defaults connectors to
  the hot-installable schema-config setup surface.** Previously only the `agent`
  and `workflow` scaffolds shipped a gate, and it was a lightweight stub ("any
  other kind → pass"). The gate (`extension-kind-gate.mjs`) is now the full,
  zero-dependency validator that mirrors the install pipeline: the common
  cross-kind rules (manifest shape, host-port names, `sdkAbiRange` grammar, the
  `@/` host-internal + non-SDK first-party import bans, the host-peer
  value-import ban over the `serverEntry` graph, the README/license contract,
  `serverEntry` preflight) PLUS the per-kind gate (agent OAS, connector manifest
  + **`configSchema`**, artifact descriptor, skill naming, workflow BPMN). The
  `connector/`, `artifact/`, and `skill/` template CI workflows now run it as a
  real `kind-gates` job instead of a no-op echo. Authors catch what the
  marketplace would reject BEFORE publishing, for every kind. (cinatra-cli#72)
- **Scaffolded connectors now declare `cinatra.uiSurface: "schema-config"` with a
  starter `cinatra.configSchema`** (a `text` + `secret` setup form) — the
  hot-installable declarative setup surface the host renders WITHOUT a rebuild.
  This replaces the old bundled-React `setup-page.tsx` assumption as the default.
  The gate validates the `configSchema` (the extended cinatra#658 vocabulary:
  `select`, `record-list`, `banner`, `advisory` in addition to `text`, `secret`,
  `nango-connect`, `repeatable-list`, `status-probe`, `copyable-credential`,
  `named-action`) and rejects any smuggled per-field key — the configSchema is
  pure data, never executable code or HTML. See **Migrating to hot-installable
  extensions** in `templates/_shared/MIGRATING-HOT-INSTALL.md`. (cinatra-cli#72)

### Removed

- **BREAKING:** Removed the deprecated bare-form command aliases (`cinatra
  setup …`, `cinatra db migrate`, `cinatra clone …`, `cinatra reset dev`,
  `cinatra backup …`). These printed a one-line deprecation rename hint in 0.1.4;
  they are now gone — use the namespaced `cinatra instance …` forms. (#81, PR #82)

### Fixed

- **Production extension acquisition.** The acquired-tree re-verify walk
  (`computeTreeSha256FromDir`) now skips a `node_modules` install root even when
  pnpm lands it as a symlink, fixing a fail-closed production install
  (`cinatra-ai/cinatra#735`). Integrity is unchanged: a device/FIFO
  `node_modules`, and any symlink OUTSIDE `node_modules`, still hard-fail. (#86)

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

- Added `cinatra create-extension <kind>` — scaffold a new extension package on
  disk via a shared zero-dependency authoring core. Scaffold output covers all
  five kinds: agent, connector, artifact, skill, and workflow. (#7)

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

[Unreleased]: https://github.com/cinatra-ai/cinatra-cli/compare/v0.1.6...HEAD
[0.1.8]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.8
[0.1.7]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.7
[0.1.6]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.6
[0.1.5]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.5
[0.1.4]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.4
[0.1.3]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.3
[0.1.2]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.0
