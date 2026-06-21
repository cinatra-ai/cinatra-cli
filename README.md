# cinatra

The command-line tool for setting up, operating, and maintaining a [Cinatra](https://cinatra.ai) instance.

```sh
npx cinatra install
```

`cinatra install` is the only command that runs **from zero** — before any Cinatra checkout exists. It checks your prerequisites first (Node 20+, git, pnpm via Corepack, Docker + Compose), clones the Cinatra repo, creates your environment, brings up the local infra, and runs setup inside the freshly cloned checkout.

Every other command operates **on a Cinatra checkout** — a cloned copy of the Cinatra repository. After `install`, run them from inside that checkout (or point at one with `CINATRA_REPO_ROOT`).

## Install

No global install required — run on demand with `npx`:

```sh
npx cinatra <command>
```

Or install globally:

```sh
npm install -g cinatra
cinatra <command>
```

Requires **Node.js >= 20**.

## The checkout-driven model

This CLI is intentionally **thin**: it bundles no Cinatra application code. The heavy, version-sensitive internals it drives — the database **migration runner**, the **connector catalog**, and the **agent-skill** compiler — are resolved **from your checkout at runtime**, against the exact versions installed there. This keeps the published tool small and guarantees the runner code always matches the migrations and schema in the checkout it operates on.

Practically, that means:

- `cinatra install` works from anywhere (it creates the checkout).
- All other commands need a checkout. They resolve it in this order:
  1. `CINATRA_REPO_ROOT=<path-to-checkout>` if set, else
  2. an upward search from your current directory for a Cinatra checkout.

  If neither finds one, the command fails with a clear message rather than guessing.

```sh
# Run from inside a checkout:
cd my-cinatra
cinatra setup dev

# Or point at one explicitly:
CINATRA_REPO_ROOT=/path/to/my-cinatra cinatra db migrate
```

## Common commands

```sh
cinatra install [--dir <path>] [--ref <main|tag|sha>] [--mode dev|prod]
cinatra setup dev                  # provision a local dev instance
cinatra setup prod                 # provision a production instance
cinatra db migrate [--down]        # apply / revert core schema migrations
cinatra status                     # local or remote instance status
cinatra doctor [--strict]          # diagnose the local setup
cinatra agents install <name>      # resolve + install an agent dependency tree
```

Run `cinatra --help` for the full command list, and `cinatra <command> --help` for per-command options.

```sh
cinatra --help
cinatra --version
```

## Versioning

`cinatra --version` reports **this CLI's** own version. It is distinct from the Cinatra application version and from the `cinatra.ai/v1` API version.

## License

[Apache-2.0](./LICENSE)
