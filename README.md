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

    cinatra install                  # set up a new Cinatra instance from scratch
    cinatra setup dev                # provision a local development instance
    cinatra setup prod               # provision a production instance
    cinatra db migrate               # apply schema updates to an instance
    cinatra status                   # check an instance's status
    cinatra doctor                   # diagnose your local setup
    cinatra agents install <name>    # add an agent to your instance
    cinatra create-extension <kind>  # scaffold a new extension to author

Run `cinatra --help` for the full command list.

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

> Sharing one set of services between two instances (`co-use`) is not available
> yet — `cinatra install` will tell you so and point you at `--on-conflict=isolated`,
> which gives each instance its own services instead.

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

## License

[Apache-2.0](./LICENSE)
