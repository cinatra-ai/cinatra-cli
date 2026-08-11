# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **A preview no longer wires itself to another instance's services, and it can
  finally reach its own connection service.** The preview composition decided
  where this instance's services live by string manipulation: it swapped a
  loopback hostname for the container's host gateway and trusted the result,
  with nothing confirming that `host.docker.internal:<port>` was *this*
  instance's service rather than a different stack's that happened to hold the
  same host port. When it was not, the preview read and wrote the other stack's
  data and reported healthy throughout, because the app reached *a* working
  service. Every container-dialed loopback endpoint is now VERIFIED before the
  composition trusts it, using the same proof the install path's port-conflict
  gate already relies on — a live container whose Compose project is rooted at
  this checkout. A mismatch is refused with the holder named (container, Compose
  project and its directory), a service that is running but publishes no host
  port is reported rather than papered over by whatever else answers on that
  port, and endpoints that are legitimately external or hosted are never
  flagged. `CINATRA_PREVIEW_ENDPOINT_OWNERSHIP=warn` prints the same finding and
  proceeds, for infrastructure that deliberately is not a Compose service of the
  checkout. Together with it, `NANGO_SERVER_URL` and `NANGO_SECRET_KEY` are now
  forwarded into the container (the address container-rewritten like its
  siblings, the credential verbatim): a preview could previously neither reach
  nor authenticate to its connection service, so saving a provider key reported
  partial success and connector flows were non-functional.

### Added

- **`cinatra install --mode preview` — a front door over the preview lifecycle.**
  Both spellings (`--mode preview` and the positional `install preview`) are
  accepted and run a documented composition: the normal dev provisioning
  (checkout at `--ref`, infra, `.env.local`), then that instance's configuration
  wired into the existing `cinatra instance preview create`, which builds a
  local non-production image at the resolved SHA and health-gates it on
  `/api/health`. Preview stays one lifecycle with one registry, one slug scheme
  and one host-port pool — `install` is a caller, not a second implementation.
  The composition supplies the four things neither side did alone: the
  passthrough environment sourced from the install rather than ambient shell
  state, a boot `CINATRA_ENCRYPTION_KEY` provisioned and persisted outside the
  checkout (so the dev `.env.local` contract gains no production-only secret),
  host-loopback Postgres/Redis endpoints rewritten to a container-reachable
  address while the app and auth URLs are re-pointed at the preview's own
  published port, and a mode translation that resolves `preview` to the
  underlying `dev` install everywhere. The checkout is left as an ordinary dev
  install — production semantics exist only inside the container — and the run
  ends with the handoff to `cinatra instance preview refresh | status | list`.
  Re-running `install --mode preview` reconciles the checkout, skips create,
  reports the existing preview's slug/SHA/port, and points ref drift at
  `refresh`; image rebuilds stay explicit.

- **Execution-plane lifecycle (`cinatra instance execution …`, exec-plane S4).**
  `install` offers an execution-mode choice — `disabled` (the default; nothing is
  provisioned and models stay fully usable), `local-dev` (run sandbox containers
  on this machine under the hardened L0 profile), or `remote` (an out-of-process
  broker you supply a URL + shared secret for) — interactive on a TTY, otherwise
  `disabled` or an explicit `--execution-mode`. Choosing a mode writes the
  execution-plane configuration for you: the env keys the instance actually reads
  plus the persisted placement mode, so a `local-dev` install boots straight into
  a successful broker↔worker handshake with **no manual env editing**. New
  `cinatra instance execution set-mode | doctor | status | pull | verify | prune |
  gc` verbs manage the mode, the digest-pinned L0 sandbox image, and the
  self-check. `cinatra doctor` gained an execution-plane section, and `cinatra
  update` / `cinatra instance refresh` keep the local image and the app moving
  together.
- **Execution self-check with five actionable checks.** `cinatra instance
  execution doctor` reports mode detection, broker reachability, the
  broker↔worker handshake (running the boot phase's own probe command over the
  L0 image and applying the boot phase's own success predicate), L0 image
  presence by digest, and egress-gateway container state — each `healthy`,
  `degraded` (with a remediation that names the actual consequence) or
  `disabled`. `--strict` exits non-zero on any degraded check.
- **L0 image lifecycle.** `execution pull` acquires the image (build for
  local-dev, digest-pinned pull for remote) and records its digest;
  `execution verify` proves the image is present, matches its recorded pin, and
  can run the handshake command under the hardened profile; `execution prune`
  reaps superseded L0 images while keeping the configured one and anything
  backing a running container.

### Changed

- **The MCP client moves from `@modelcontextprotocol/sdk@^1.29.0` to
  `@modelcontextprotocol/client@2.0.0` (exact pin).** This is a package
  migration, not a version bump: the v1 line contains zero occurrences of the
  `2026-07-28` protocol revision, so it was not a route to it at all. Both
  consumers move — `src/marketplace-mcp.mjs` (the marketplace submit path) and
  `src/login.mjs` (the OAuth primitives behind `cinatra login`).

  The marketplace path now negotiates with an explicit
  `versionNegotiation: { mode: "auto" }`: it probes for `2026-07-28` with
  `server/discover` and falls back to the 2025-era `initialize` handshake when
  the peer refuses. Measured live against the real marketplace, that peer is
  still 2025-era today (it answers the probe HTTP 400 and selects `2025-06-18`),
  so the negotiated result is unchanged — but the peer is an independently
  operated hosted service that can adopt the new revision with no change here,
  and `auto` follows it without one. The mode is passed as an options OBJECT and
  asserted to be one at module load: written as a bare string the client reads
  `mode` as `undefined` and silently selects the legacy era, producing a working
  client that never negotiated.

  `cinatra login` gains RFC 9207 authorization-response issuer validation: the
  `iss` parameter the authorization server returns on the redirect is now
  captured and validated against the discovered metadata's issuer before the
  authorization code is redeemed. This is required by the new client, not
  optional hardening — when a server advertises
  `authorization_response_iss_parameter_supported` (a Cinatra instance does), an
  absent `iss` is itself a failure. Servers that do not implement RFC 9207 are
  unaffected. Metadata discovery also now enforces the RFC 8414 issuer echo, and
  the `MCP-Protocol-Version` header it sends is pinned explicitly rather than
  inherited from the package default (the value is unchanged: `2025-11-25`).

  No CLI error surface changes shape: no command branched on an SDK error class
  or parsed an SDK message prefix, and every first-party failure message on the
  marketplace path is preserved verbatim. Two login messages deliberately change,
  both to keep attacker-controlled text off an operator's terminal: a failed
  RFC 9207 check now reports the issuer the CLI *expected* instead of the one it
  received, and an authorization-callback `error` value is shown only when it is
  a recognized OAuth error code. `bin/cinatra.mjs` prints `error.message`
  verbatim, so a value chosen by an attacker — including terminal control
  characters — would otherwise reach the console.

- **The host's extension declaration is read by SCHEMA, not by presence.** A
  Cinatra checkout may declare its extension set either as
  `cinatra.systemExtensions` — a list of versioned specs such as
  `"@cinatra-ai/nango-connector@^0.1.0"` — or as the older `cinatra.extensions`.
  `extensions acquire-prod` (which the production image build runs) and
  `extensions verify-prod` read `cinatra.systemExtensions` only when it is a
  non-empty list of well-formed versioned specs with unique names, and read
  `cinatra.extensions` otherwise. Presence alone is not enough, because a
  checkout can carry a `cinatra.systemExtensions` list of bare package names:
  reading that would discard every version range and stop enforcing that the
  locked version satisfies the declared pin. A declaration that is empty, mixed,
  malformed, unversioned or duplicated is never read as the versioned shape, and
  when no other declaration is available nothing is treated as declared — so the
  lock↔declaration bijection fails loudly instead of passing vacuously.
  Diagnostics name the declaration that was actually read.
- The CLI-managed sandbox image path is now the digest-pinned execution-plane L0
  image (built from `docker/sandbox/Dockerfile`, its resolved digest recorded).
  The retired `:latest` skill-shell image is no longer built by
  `instance reset --full` (or any other CLI path) — digest pins only.
- **The execution-plane configuration the CLI writes now matches what the
  instance actually reads.** The previous release wrote four settings no released
  Cinatra reads, so an instance configured for `local-dev` silently never started
  its sandbox. Choosing a mode now writes the real configuration — including the
  placement mode, which lives in the instance database rather than the
  environment file — and generates the instance-local secrets the plane needs.
  Existing instances configured by the previous release should re-run
  `cinatra instance execution set-mode local-dev` (or `disabled`); the old
  settings are inert and can be deleted.
- The install default is now `disabled` for every install mode. A sandbox that
  can run model-authored commands is never provisioned by omission; it is always
  an explicit choice. (Previously a dev install silently selected `local-dev`.)
- `cinatra instance sandbox build | doctor | status | gc` still work as hidden
  aliases of the new `instance execution` verbs.


### Removed

- `create-extension` no longer offers the `workflow` kind — the workflow
  extension kind is retired. The scaffolder now supports exactly four kinds
  (`agent`, `connector`, `artifact`, `skill`); requesting `workflow` is a usage
  error, and the `templates/workflow/` scaffold tree has been deleted.

### Fixed

- **A local install now provisions `NANGO_SECRET_KEY`, so Nango-backed
  connectors work on a fresh instance.** Nothing ever set it: the install mints
  `NANGO_ENCRYPTION_KEY` and `CINATRA_BRIDGE_TOKEN`, but the secret key fell
  through to whatever an operator typed at `/setup/connections` — and
  nango-server refuses anything that is not a UUID v4 with
  `invalid_secret_key_format` (HTTP 401), so every Google OAuth / Calendar /
  Gmail save failed with no hint about what the field wanted. Generating a UUID
  would not have fixed it either: `FLAG_AUTH_ENABLED=false` on the bundled
  nango-server disables its DASHBOARD auth, not its API secret-key auth, so a
  random key clears the format gate and then 401s again ("does not match any
  account") because no Nango environment carries it. The key is not ours to
  choose — nango-server seeds its own `prod`/`dev` environments into nango-db at
  first boot. So every local bring-up now ADOPTS that value: once Nango reports
  healthy, the reconcile reads the seeded environment key for this instance's
  runtime mode (`production` → `prod`, else `dev` — the same selection the CLI's
  own Nango discovery makes) and writes it into `.env.local`, where the app
  reads it. Host and container hold one value by construction. It runs on every
  local bring-up — `install`, an isolated instance, an attach, a re-converge,
  `instance refresh` and `instance reset --full` — so an instance installed
  before this fix heals on its next run: an absent key is minted, and a
  malformed one is replaced with a message naming the 401 it was causing. A
  VALID key is never rotated: one that already matches is left byte-identical
  (re-running writes nothing at all), and one that diverges is reported with the
  remedy rather than overwritten — the sole exception is `reset --full`, which
  destroyed the nango volume itself, so the key it left behind names an
  environment that no longer exists and is re-pointed at the rebuilt stack. A
  hosted `NANGO_SERVER_URL` is never touched — that key belongs to the
  operator's own Nango account — and an install pointed at one with no key set
  now says so instead of failing silently. The step is loud-but-non-fatal: an
  unreachable nango-db, a missing `psql` or a schema that moved warns (naming
  the manual read) and lets the install finish. No key value is ever logged.
  (#211)

- **`instance reset --purge-app-data` no longer strands the registry user it
  just orphaned.** The app mints one Verdaccio npm user per instance namespace
  and keeps the generated password in its own database. Purging the app data
  threw that password away but left the `htpasswd` entry behind with the old
  hash, so re-onboarding under the same name re-issued the adduser call with a
  fresh password, Verdaccio answered HTTP 401, and a supposedly fresh instance
  was blocked at `/setup/name` by its own leftovers — one more orphan per reset,
  forever. The reset now reads the namespaces the app recorded BEFORE it drops
  the schema that holds them (the live namespace, every namespace the instance
  was renamed away from, and a mint whose identity write never landed) and
  removes exactly those entries from the registry user store afterwards, then
  restarts the registry service and waits for it to serve again — Verdaccio
  merges `htpasswd` into an in-memory map and never forgets a user that left the
  file, so the rewrite alone would have left the running registry answering 401
  from the stale copy (found by running the real command against a real
  registry, not by reading the file). The boundary is deliberately narrow:
  package storage is never touched (only lines of `htpasswd` are rewritten,
  atomically, through a staging file; the sibling `.verdaccio-db.json` holds the
  package list and is left alone), registry
  users this instance never claimed are left alone (the dev-seed publisher and
  any throwaway e2e users — the reset has no evidence that those are orphans),
  `--keep-app-data` removes nothing at all because the app keeps the password
  that matches its user, and `--full` needs no reconcile because it already
  destroys the whole registry volume. Re-running the reset is a clean no-op: the
  second pass finds no user of its own and writes nothing. The step is
  loud-but-non-fatal — it runs after the destructive purge, so an unreachable
  registry, an unreadable store or a failed rewrite warns and lets the reset
  finish instead of stranding a half-built instance. Every such warning NAMES
  the users, because the row that recorded them is already purged and a re-run
  would find nothing: the warning is the operator's only remaining record. The
  namespace read itself now fails CLOSED — anything other than "the schema does
  not exist yet" aborts the reset BEFORE the drop rather than silently reporting
  that nothing was recorded — and after the restart the removal is verified
  against the live store instead of assumed. `cinatra instance reset --help` now
  documents the whole flag/purge boundary. (#208)

- **The CLI no longer needs Corepack to exist — Node 25 unbundled it.** Node 25
  removed Corepack from the distribution, and with it the `pnpm` shim Corepack
  provided, so a stock Node 25 host has NEITHER `corepack` NOR `pnpm` on `PATH`.
  Every internal workspace-install step therefore fell through to attempting a
  `corepack pnpm install` that does not exist: `cinatra instance reset` and
  `cinatra instance setup dev` reported a FAILED post-extension-sync workspace
  link and skipped extension-manifest regeneration (leaving the workspace
  unlinked), `cinatra instance clone new` failed its dependency install
  outright, and `cinatra install` was blocked at the requirements check by a
  remediation (`corepack enable`) that is impossible on that Node line.
  Dependency installs now select in three tiers — Corepack when present (the
  pin is honored by Corepack itself, unchanged), the bare `pnpm` on `PATH`
  otherwise, and finally the checkout's OWN `packageManager` pin run through
  `npm exec` (`npm exec -y -- pnpm@<pin> install`), which needs nothing but the
  npm that ships with every Node line and keeps the install as reproducible as
  the Corepack route. The clone auto-install, the post-extension-sync re-link,
  the update/reconcile dependency step and `cinatra install` all share that
  selection, and every remediation the CLI prints now names a command that is
  actually runnable on the host it printed it on. Two paths additionally fail
  CLOSED rather than mid-way: `cinatra instance reset --full` proves an install
  command exists BEFORE it tears the stack down and deletes `node_modules` (it
  previously removed the dependency tree and only then discovered it could not
  reinstall it), and `cinatra install` proves it right after the checkout
  materializes — the first moment the checkout's pin is readable — and before
  any local-ignore write, co-use hand-off, conflict resolution or infra
  bring-up. A host that has Corepack is completely unaffected. (#207)

- **`cinatra update` / `cinatra instance refresh` no longer require Corepack.**
  The update/reconcile dependency step and the post-extension-sync workspace
  re-link invoked `corepack pnpm install` unconditionally, so on a machine
  where Corepack is not enabled the update aborted at the dependency step and
  left the instance mid-reconcile — even with a perfectly good `pnpm` on
  `PATH`. Both steps now apply the same selection `cinatra install` has always
  used: pnpm runs through Corepack when Corepack is present (honoring the
  pinned pnpm) and degrades to the bare `pnpm` on `PATH` when it is not, with
  the step's progress and failure messages naming the binary actually invoked.
  When neither tool is available, the canonical `corepack pnpm install` is
  still attempted so the loud failure names the command to enable. (#205)

- **`cinatra login` can discover OAuth metadata against a real instance again.**
  Both the interactive sign-in and the token refresh passed the instance's bare
  ORIGIN as the authorization-server URL. Discovery builds its well-known URLs
  from that value and, for a URL with no path, tries only the two ROOT
  locations — which a Cinatra instance answers `404`, because its authorization
  server is mounted at `/api/auth` and the documents live at the path-suffixed
  `/.well-known/oauth-authorization-server/api/auth`. Discovery therefore
  resolved to nothing and the command aborted with `Could not discover OAuth
  metadata …` before opening a browser; an expired profile could not be
  refreshed either, and no interactive re-login was possible to repair it. The
  origin is the RESOURCE server (it is what the profile is keyed by and what the
  RFC 8707 `resource` `<origin>/api/cli` is built from); the authorization
  server is a distinct URL underneath it. Every primitive that takes an
  `authorizationServerUrl` now receives `<origin>/api/auth`, which is also the
  only value that can satisfy the RFC 8414 §3.3 issuer-echo check the instance's
  published `issuer` requires. The failure message now names every well-known
  URL that was actually tried. An authorization server that serves ONLY the root
  document is no longer discovered — no Cinatra instance is in that population.
  (#203)

- The recreate preflight no longer blocks an install over services it is not
  bringing up. It now derives each service's profile state from the profiles
  actually active for the bring-up — the same profile rules Compose applies to
  the `up` itself, including `COMPOSE_PROFILES` from the environment and from
  `--env-file` — instead of treating every service in the resolved config as
  deployed. A stateful service in a profile the install does not activate is
  reported as skipped and cannot block; the most visible symptom was a fresh
  `install --on-conflict isolated` aborting on `twenty-redis`, a service in the
  opt-in `twenty` profile that the install never starts. Services in an
  activated profile are still checked in full, so the fail-closed protection
  against recreating a stateful container across a data-format boundary is
  unchanged. (#189)
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
  symlink.** Backports the production extension-acquisition fix onto the 0.1.3 command
  surface: the acquired-tree re-verify walk (`computeTreeSha256FromDir`) now
  skips a `node_modules` install root even when pnpm lands it as a symlink — the
  in-repo `@cinatra-ai/sdk-extensions` workspace package linked into each acquired
  extension's `node_modules` — instead of failing closed on the non-regular entry.
  Branched from `v0.1.3` and ports ONLY this fix (none of the `dev`→`instance`,
  `setup`→internal-phase, or bare-form-removal refactors). Integrity is unchanged:
  a device/FIFO `node_modules`, and any symlink OUTSIDE `node_modules`, still
  hard-fail.

## [0.1.5] - 2026-06-30

The new/reorganized command surface plus the production extension-acquisition fix
at the new boundary. Published, but the Cinatra app stays on the 0.1.6 backport
for this release cycle.

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
  marketplace would reject BEFORE publishing, for every kind.
- **Scaffolded connectors now declare `cinatra.uiSurface: "schema-config"` with a
  starter `cinatra.configSchema`** (a `text` + `secret` setup form) — the
  hot-installable declarative setup surface the host renders WITHOUT a rebuild.
  This replaces the old bundled-React `setup-page.tsx` assumption as the default.
  The gate validates the `configSchema` (the extended setup-field vocabulary:
  `select`, `record-list`, `banner`, `advisory` in addition to `text`, `secret`,
  `nango-connect`, `repeatable-list`, `status-probe`, `copyable-credential`,
  `named-action`) and rejects any smuggled per-field key — the configSchema is
  pure data, never executable code or HTML. See **Migrating to hot-installable
  extensions** in `templates/_shared/MIGRATING-HOT-INSTALL.md`.

### Removed

- **BREAKING:** Removed the deprecated bare-form command aliases (`cinatra
  setup …`, `cinatra db migrate`, `cinatra clone …`, `cinatra reset dev`,
  `cinatra backup …`). These printed a one-line deprecation rename hint in 0.1.4;
  they are now gone — use the namespaced `cinatra instance …` forms. (#81, PR #82)

### Fixed

- **Production extension acquisition.** The acquired-tree re-verify walk
  (`computeTreeSha256FromDir`) now skips a `node_modules` install root even when
  pnpm lands it as a symlink, fixing a fail-closed production install.
  Integrity is unchanged: a device/FIFO
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
