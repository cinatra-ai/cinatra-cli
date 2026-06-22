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

Requires Node.js >= 20.

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
