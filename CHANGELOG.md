# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.1.2]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.2
[0.1.1]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/cinatra-ai/cinatra-cli/releases/tag/v0.1.0
