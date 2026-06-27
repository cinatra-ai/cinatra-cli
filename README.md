# cinatra

The command-line tool for [Cinatra](https://cinatra.ai) — the open source AI workspace for teams, where people, AI assistants, and autonomous agents work together on durable workflows.

Use it to stand up your own Cinatra instance and keep it running — from a local dev setup to production.

## Quick start

    npx @cinatra-ai/cinatra install

Sets up a Cinatra instance from scratch: checks your prerequisites, fetches Cinatra, creates your environment, starts the local services, and runs first-time setup. After that, run the other commands from inside your Cinatra directory.

## Install

On demand, no install needed:

    npx @cinatra-ai/cinatra <command>

Or install globally (the command is then just `cinatra`):

    npm install -g @cinatra-ai/cinatra

Requires Node.js >= 24.

## What you can do

    cinatra install --mode dev       # set up OR reconcile a dev instance (single entrypoint)
    cinatra install --mode prod      # set up OR reconcile a production instance
    cinatra status                   # check an instance's status
    cinatra doctor                   # diagnose your local setup
    cinatra agents install <name>    # add an agent to your instance
    cinatra create-extension <kind>  # scaffold a new extension to author

`cinatra install --mode dev|prod` is the single idempotent command to make an
instance exist or make it healthy: run it on a clean machine to bootstrap from
scratch, or re-run it on an existing checkout to reconcile it (it skips the clone
and just re-runs the in-repo provisioning phase — there is no separate `setup`
command to remember).

The other local host/monorepo bootstrap commands you run from inside a Cinatra
checkout live under `cinatra instance …`:

    cinatra instance db migrate           # apply schema updates (works when the app is down)
    cinatra instance branch setup         # provision an isolated env for the current worktree
    cinatra instance branch teardown --yes  # drop that worktree's isolated schema
    cinatra instance clone new <name>     # create an isolated deep-fork clone
    cinatra instance refresh              # reconcile deps + dev DB to your checkout
    cinatra instance tunnel start         # manage the dev Tailscale Funnel
    cinatra instance backup create        # take a local backup bundle
    cinatra instance reset --yes          # reset the development environment

Run `cinatra --help` for the top-level command list, or `cinatra instance --help`
for the full local-bootstrap command list.

> The old bare forms (`cinatra db migrate`, `cinatra clone …`, `cinatra reset dev`,
> `cinatra backup …`, and the renamed `cinatra teardown branch`) still work this
> release but are deprecated — they print a one-line hint pointing at their
> `cinatra instance …` form. Update your scripts to the canonical commands.
>
> The in-repo provisioning phase (`cinatra setup dev|prod`) is folded into
> `cinatra install --mode dev|prod` — there is no standalone `setup` command to
> run; re-run `cinatra install` to reconcile an existing instance.

## Running more than one instance

If you already have a Cinatra instance running and `cinatra install` finds its
ports in use, it does not just stop — it tells you who holds the ports and offers
to set up a second instance for you. On a terminal it asks; you can also pick the
option up front with a flag:

    cinatra install --on-conflict=isolated   # a second, fully separate instance
                                              # on its own ports + app port
    cinatra install --on-conflict=stop-existing  # stop the existing one first,
                                                  # then install on the default ports
    cinatra install --on-conflict=attach     # re-use / update the existing checkout
    cinatra install --on-conflict=co-use     # share the running instance's services
                                             # (separate database + queue; no 2nd stack)
    cinatra install --infra=external \       # point at your own database/cache
        --db-url <url> --redis-url <url> --nango-url <url> --graphiti-url <url> \
        --external-db-disposable             # confirm the external DB is disposable
                                             # (setup may write to it; required for --db-url)

Useful extras:

    cinatra install --instance <name>        # name the instance (default: the folder name)
    cinatra install --app-port <n>           # pick the app port for an isolated instance
    cinatra install --port-offset auto|<n>   # how far to shift an isolated instance's ports
    cinatra install --dry-run                # show what would happen, change nothing
    cinatra install --list-instances         # list the instances you have set up
    cinatra install --status [--dir <path>]  # show one checkout's instance state
    cinatra install --resume                 # finish an install that was interrupted

`--list-instances` / `--status` are read-only. Stopping or wiping an existing
instance always asks for confirmation first; `--yes` alone never deletes data
(and pointing setup at your own external database with `--db-url` likewise needs
the explicit `--external-db-disposable` acknowledgement — a bare `--yes` won't do
it, because setup can write to that database).

> **Co-use (sharing one set of services).** `--on-conflict=co-use` /
> `--infra=share` runs a second instance against the first one's running services
> — its own app port and its own database, but the same Postgres server, Redis,
> and Nango (no second Docker stack). It is enabled only when the installed app
> isolates login cookies per instance (otherwise two instances on `localhost`
> would share a session, so `cinatra install` refuses with the exact app change
> needed and points you at `--on-conflict=isolated`). When the donor sets a
> Graphiti URL, add `--allow-shared-graphiti` to accept sharing it (it is
> org-scoped, not per-instance).

## Author an extension

Scaffold a ready-to-author, ready-to-publish extension package — one of five
kinds (`agent`, `connector`, `artifact`, `skill`, `workflow`):

    cinatra create-extension agent invoice-extractor

It generates a complete, standalone repo (manifest, README, CI, kind gate, and
kind-specific payload). The generated package pins `@cinatra-ai/sdk-extensions`
as an optional peer; nothing is installed for you. Run `cinatra create-extension
--help` for the kinds and options.

> This replaces the standalone `npx create-cinatra-extension` scaffolder, which
> is retired.

## Repo structure

```
bin/              Entry-point script (cinatra.mjs)
src/              CLI source modules
  authoring/      Extension scaffolding core (create-extension)
templates/        Scaffold templates for each extension kind
  agent/
  artifact/
  connector/
  skill/
  workflow/
  _shared/        Shared files copied into every generated extension
tests/            Vitest test suite
```

This repo is the **thin CLI** only. It carries no `@cinatra-ai/*` runtime
dependencies — those are resolved from the operator's Cinatra checkout at
runtime. The migration runner, dev-app manifests, and first-party SDK packages
all come from the checkout, not from this package.

## Development

Clone the repo and install dependencies:

    git clone https://github.com/cinatra-ai/cinatra-cli.git
    cd cinatra-cli
    npm ci

Run the test suite:

    npm test

The suite is run by [Vitest](https://vitest.dev/) and covers install flows,
clone/registry logic, extension scaffolding, command dispatch, and startup
contracts. Tests that need a Cinatra checkout use a synthetic fake checkout
provided by `tests/helpers/setup-fake-checkout.mjs`; no real instance is
needed to run the tests.

Smoke-check the CLI locally:

    node bin/cinatra.mjs --help
    node bin/cinatra.mjs --version

The CI pipeline (`.github/workflows/ci.yml`) runs these same steps on every
pull request: dependency assertions, the full Vitest suite, the two smoke
checks, and a dry-run pack to validate the publish payload.

When contributing, keep the thin-CLI constraint in mind: do not add
`@cinatra-ai/*` packages to `dependencies`, `devDependencies`, or
`peerDependencies`. CI will reject the PR if any first-party package appears
in the manifest or the resolved dependency tree.

## Troubleshooting

**`cinatra: command not found` after global install**
Check that npm's global `bin` directory is on your `PATH`:

    npm prefix -g       # prints the global prefix (e.g. /usr/local)
    echo $PATH          # verify <prefix>/bin appears here

If it is missing, add `$(npm prefix -g)/bin` to your shell profile
(e.g. `~/.zshrc` or `~/.bashrc`).

**`cinatra install` says ports are in use**
Another Cinatra instance (or another service) is already using the default
ports. Use `--list-instances` to see what is running:

    cinatra install --list-instances

Then pick a resolution: `--on-conflict=isolated` starts a second instance on
its own port band, `--on-conflict=attach` re-attaches to the existing checkout,
or `--on-conflict=stop-existing` stops the existing stack before installing.

**Deprecated command warnings**
Commands like `cinatra db migrate` or `cinatra teardown branch` print a deprecation
hint pointing at their canonical equivalents. Update your scripts to the canonical
forms (e.g. `cinatra instance db migrate`, `cinatra instance branch teardown`) — the
old bare forms will be removed in a future minor release. The in-repo provisioning
phase (`cinatra setup dev|prod`) was folded into `cinatra install --mode dev|prod`;
re-run `cinatra install` to reconcile an existing instance. To suppress the warnings
temporarily while you migrate, set `CINATRA_SUPPRESS_DEPRECATION=1`.

**`cinatra doctor` for diagnosing a broken instance**
If your instance is misbehaving, `cinatra doctor` checks your local setup and
reports what is wrong. Run it first before filing an issue.

**Node.js version errors**
The CLI requires Node.js 24 or later. Check your version with `node --version`
and upgrade if needed.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a full history of releases.

## License

[Apache-2.0](./LICENSE)
