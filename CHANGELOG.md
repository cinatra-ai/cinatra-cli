# Changelog

All notable changes to `@cinatra-ai/cinatra` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

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
