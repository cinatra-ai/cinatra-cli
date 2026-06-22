# cinatra

The command-line tool for [Cinatra](https://cinatra.ai) — the open-source AI platform you host yourself.

Cinatra lets you run AI agents, connect them to your own tools, data, and content, and put that to work across your apps and workflows — on infrastructure you control. This CLI is how you stand up a Cinatra instance and keep it running.

## Quick start

```sh
npx cinatra install
```

This sets up a Cinatra instance from scratch — it checks your prerequisites, fetches Cinatra, creates your environment, starts the local services, and runs first-time setup. After that, run the other commands from inside your new Cinatra directory.

## Install

Run on demand, no install needed:

```sh
npx cinatra <command>
```

Or install globally:

```sh
npm install -g cinatra
```

Requires Node.js >= 20.

## What you can do

```sh
cinatra install                # set up a new Cinatra instance from scratch
cinatra setup dev              # provision a local development instance
cinatra setup prod             # provision a production instance
cinatra db migrate             # apply schema updates to an instance
cinatra status                 # check an instance's status
cinatra doctor                 # diagnose your local setup
cinatra agents install <name>  # add an agent to your instance
```

Most commands run from inside your Cinatra directory. Run `cinatra --help` for the full command list and `cinatra <command> --help` for per-command options.

## License

[Apache-2.0](./LICENSE)
