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
    cinatra install --mode demo      # a dev superset: bundled apps + sample data, pre-connected
    cinatra install --mode preview   # a dev install, then build + boot a local preview container
    cinatra status                   # check an instance's status
    cinatra doctor                   # diagnose your local setup
    cinatra agents install <name>    # add an agent to your instance
    cinatra create-extension <kind>  # scaffold a new extension to author

`cinatra install --mode dev|prod` is the single idempotent command to make an
instance exist or make it healthy: run it on a clean machine to bootstrap from
scratch, or re-run it on an existing checkout to reconcile it (it skips the clone
and just re-runs the in-repo provisioning phase — there is no separate `setup`
command to remember).

`--mode demo` is a **strict superset of `--mode dev`**: identical dev base (same
runtime, extensions, and setup), plus the demo overlay — it brings up the bundled
third-party apps (WordPress, Drupal, Twenty, Plane), loads coherent sample data
into Cinatra and each app, and leaves every app pre-connected, so a single command
yields a fully-populated, click-around demo. It stays `CINATRA_RUNTIME_MODE=development`
and rides an orthogonal `CINATRA_INSTALL_PROFILE=demo` signal, so `dev`/`prod`
behaviour is unchanged. Demo requires a Cinatra checkout that ships the demo overlay;
on a checkout that predates it, `--mode demo` refuses with a clear message rather
than producing a half-populated instance.

`--mode preview` is **not a runtime mode — it is a composition**: the same dev
provisioning, then that instance's configuration wired into `cinatra instance
preview create`, which builds a local, explicitly non-production image at the
resolved commit SHA and boots it health-gated on `/api/health`. One command takes
you from zero to a running preview of a given ref. The checkout it leaves behind
is an ordinary dev install — `CINATRA_RUNTIME_MODE=development`, `pnpm dev` still
works — because the production runtime lives only inside the container. The
preview it creates is managed by its own verbs (`cinatra instance preview
refresh | status | list`), not by re-running `install`: a re-run reconciles the
checkout, reports the existing preview, and points ref drift at `refresh`, so an
image rebuild is always something you ask for explicitly.

The first preview on a machine builds the image **cold** — the checkout's whole
multi-stage Dockerfile, which is a long job (the `next build` compile alone has
been measured at over half an hour on a fast laptop). That build is bounded so a
hung Docker can never wedge the CLI, and the bound defaults to **90 minutes**. On
a slower or heavily loaded host, raise it:

    CINATRA_PREVIEW_BUILD_TIMEOUT_MS=10800000 cinatra install --mode preview   # 3 hours

Accepted range **1000 .. 21600000** ms (1 second .. 6 hours). Notes:

- **It is an environment variable, not a flag**, so one lever covers `install
  --mode preview`, `instance preview create` and `instance preview refresh`.
- **A bad value is a hard error**, not a silent fallback: a non-integer, `0`, a
  negative, `Infinity` or an out-of-range number is rejected up front, naming the
  variable and the accepted range. `install --mode preview` rejects it while
  parsing its arguments — before the install does anything — and the `instance
  preview` verbs reject it before the image is built or a registry slot claimed.
- **The bound never goes away.** The maximum is finite on purpose — there is no
  value that disables the timeout, so a genuinely hung build is still cancelled.
- **A cancelled build is partly resumable.** Re-running reuses every layer that
  already **completed** and picks up at the step that was interrupted — but that
  step starts over from the beginning. So if a *single* step takes longer than
  the budget, retrying will never get past it; raise the budget instead.

The other local host/monorepo bootstrap commands you run from inside a Cinatra
checkout live under `cinatra instance …`:

    cinatra instance db migrate           # apply schema updates (works when the app is down)
    cinatra instance branch setup         # provision an isolated env for the current worktree
    cinatra instance branch teardown --yes  # drop that worktree's isolated schema
    cinatra instance clone new <name>     # create an isolated deep-fork clone
    cinatra instance refresh              # reconcile deps + dev DB to your checkout
    cinatra instance tunnel start         # manage the dev Tailscale Funnel
    cinatra instance verify-exposure up   # publish ONLY /api/mcp for a verification check
    cinatra instance verify-exposure check  # prove that mapping admits nothing else
    cinatra instance backup create        # take a local backup bundle
    cinatra instance reset --yes          # reset the development environment

Run `cinatra --help` for the top-level command list, or `cinatra instance --help`
for the full local-bootstrap command list.

### Which tunnel command do I want?

Two commands publish this instance on a public tunnel, and they are for
different jobs:

* `cinatra instance tunnel start|stop|status` is the **general dev tunnel**. It
  publishes the WHOLE local app, every path, and it is what `cinatra instance
  setup dev` and `cinatra doctor --fix` bring up for you. Reach for it when you
  need the app itself reachable from outside.
* `cinatra instance verify-exposure up|status|check|down` is the **verification
  exposure mode**. It admits exactly ONE path — the app's `/api/mcp` callback
  path — and nothing else, on a tunnel with its own runtime state, so the two
  never collide. Reach for it when something outside needs to reach that one
  endpoint and nothing more.

The verification exposure mode puts a loopback access-logging proxy between the
tunnel and the app. Every request it forwards to the app is recorded as a JSON
line (method, path, marker, status) in a log whose location `status` prints; a
request it refuses is never forwarded and leaves no line at all. (If the log
itself cannot be written — a full disk, say — the request is still answered, and
the missing record makes `check` fail rather than pass.)

    cinatra instance verify-exposure up       # publish /api/mcp, start the proxy
    cinatra instance verify-exposure status   # identity, mapping, proxy, log location
    cinatra instance verify-exposure check    # prove the mapping admits only /api/mcp
    cinatra instance verify-exposure down     # take it down (safe when nothing is up)

Where the exact match is enforced matters, so the mode states it plainly: a
tunnel serve-config handler key is a **mount point**, so the tunnel edge also
forwards the key's descendants (`/api/mcp/anything`). The exact match is
therefore enforced one hop later, by the access-logging proxy itself: a request
whose path is not exactly `/api/mcp` is refused there, is never forwarded to the
app, and leaves no line in the access log. Paths with no mount point at all
(`/`, `/sign-in`, `/sign-up`) never reach the proxy: the edge refuses them
itself, at whatever status your tunnel edge uses — pass `--refused-status <n>`
if yours differs from the default the check expects.

`check` drives an unauthenticated `GET` at the public origin for `/`,
`/sign-in`, `/sign-up`, `/api/mcp/anything` and `/api/mcp`, each tagged with its
own marker, and asserts that every path but `/api/mcp` comes back refused at its
fixed status AND never appears in the access log at all — proof it was refused
before the app rather than answered by it — while `/api/mcp` does appear in the
log and answers the status the app documents for an unauthenticated call. `down`
is idempotent: running it when nothing is published exits 0 and says so.

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

Scaffold a ready-to-author, ready-to-publish extension package — one of four
kinds (`agent`, `connector`, `artifact`, `skill`):

    cinatra create-extension agent invoice-extractor

It generates a complete, standalone repo (manifest, README, CI, kind gate, and
kind-specific payload). The generated package pins `@cinatra-ai/sdk-extensions`
as an optional peer; nothing is installed for you. Run `cinatra create-extension
--help` for the kinds and options.

Add `--assistant` to the `agent` kind to also ship a `cinatra/config.json`
assistant declaration — an agent-kind assistant the host adopts as a first-class
chat assistant (its own handle, persona, skill bundle, launch, and delivery):

    cinatra create-extension agent support-bot --assistant

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
