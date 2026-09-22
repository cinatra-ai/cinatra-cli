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

Every mode writes the instance's `.env.local` from the checkout's `.env.example`
and mints the secrets an instance needs before anything starts: the auth secret,
the connection service's at-rest key, the agent runtime's bridge token and
attestation key, and `CINATRA_ENCRYPTION_KEY` — the key that seals an instance's
stored secrets. That last one is written for **every** mode, not production
alone, because the checkout's own provisioning step seals its secrets with it and
runs *before* the first boot; leaving it to the app's first-boot generator made
the intended order — install, provision, then boot — fail at the second step. A
value that is already there is carried forward byte for byte and never rotated,
because a fresh key would make everything the instance has already sealed
unreadable, so a re-run leaves the line exactly as it found it. A value that is
present but malformed stops the install, naming the variable and the file, rather
than being replaced. Minted values are never printed — the install names the
variables it minted, never their contents.

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

### What a preview instance receives

A preview container is not handed your whole environment: it gets the runtime
settings the composition decides, plus a fixed passthrough list — the variables
an instance needs to serve requests, install extensions and hold connections.
Anything else you have exported stays on the host.

**Set by the composition, never inherited:** `CINATRA_RUNTIME_MODE=production`
(a preview always runs production runtime semantics), `CINATRA_EXTENSION_DATA_ROOT`
(the durable named volume's mount path) and `HOSTNAME`.

**Required:** `CINATRA_ENCRYPTION_KEY` — 64 hex characters, checked *before* the
boot rather than failing silently inside it.

**Forwarded when set on the host:**

| what it is for | variables |
|---|---|
| data + cache | `SUPABASE_DB_URL`, `SUPABASE_SCHEMA`, `REDIS_URL` |
| auth + public URLs | `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SITE_URL` |
| extension installs (which registry a package is fetched from) | `CINATRA_AGENT_REGISTRY_URL`, `CINATRA_AGENT_REGISTRY_UI_URL` |
| whether an installed package is trusted | `CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL`, `CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN`, `CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE`, `CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE` |
| connections (the connection service's address, its credential, the at-rest key) | `NANGO_SERVER_URL`, `NANGO_SECRET_KEY`, `NANGO_ENCRYPTION_KEY` |
| model access | `OPENAI_API_KEY` |
| the agent runtime bridge (its address, its shared secret, its attestation key) | `WAYFLOW_BASE_URL`, `CINATRA_BRIDGE_TOKEN`, `CINATRA_CONTEXT_ATTEST_KEY` |

Without the registry pair a preview falls back to the hosted default registry it
holds no credential for, so every marketplace install inside it fails with 401;
without the Nango trio it can neither reach nor authenticate to the connection
service, so saving a provider key reports only partial success; and without
`WAYFLOW_BASE_URL` the app falls back to its default `http://localhost:3010` —
the container itself — so every agent run refuses with "Cinatra WayFlow is not
configured for agent …: WAYFLOW_BASE_URL is not set"; and without
`CINATRA_CONTEXT_ATTEST_KEY` the bridge is reachable but the app rejects every
context callback the runtime signs. A dev install writes these into its
`.env.local` as it provisions the services behind them — the secrets it mints,
the addresses it re-points at this instance's own ports, the connector
credential it reconciles — which is why `install --mode preview` needs no extra
setup for the ones your install actually wrote; a variable your install never
wrote (an operator-supplied or externally-managed one) is simply not there to
forward. A unit test holds this list against the set the dev install road
writes, so a new variable that road starts writing fails the test until someone
decides whether a preview needs it (it does not audit variables written outside
that road).

A forwarded address the CONTAINER dials (the database, Redis, the connection
service, the package registry, the runtime bridge) that points at the host's own
loopback (`127.0.0.1` / `localhost`) is rewritten to `host.docker.internal` on the way in,
because inside the container that address would mean the container itself.
Credentials and browser-resolved URLs are forwarded verbatim — among them the
registry's browser-facing twin (`CINATRA_AGENT_REGISTRY_UI_URL`) and the
deployment-registry URL, which the browser resolves rather than the container.
A rewritten loopback endpoint is also ownership-verified before the boot
(`CINATRA_PREVIEW_ENDPOINT_OWNERSHIP`): when the endpoint is not this checkout's
own compose service — an operator-managed runtime or database, a tunnel — name
that key in `CINATRA_PREVIEW_ENDPOINT_OWNERSHIP_ALLOW` to proceed.

**Deliberately never forwarded:**
`CINATRA_DISABLE_REQUIRED_EXTENSION_MATERIALIZE`. It disables a required-extension
safety invariant; its only sanctioned use is a CI screenshot context, never a boot
workaround. A preview refuses to boot while it is set to a truthy value
(`true` / `1` / `yes` / `on`) rather than quietly passing it on, and strips it
from the container's environment either way. Variables that belong to a service
rather than to the app — the Nango service's own database URL
(`NANGO_DATABASE_URL` / `NANGO_DB_URL`) — stay on the host too: they are dialed
by those services, not by the app that talks to them.
The memory and graph endpoints (`GRAPHITI_URL`, `NEO4J_URI`) stay on the host as
well: they belong to subsystems outside extension installs, connections and the
agent runtime bridge, so forwarding them is a separate decision.

### Where a preview publishes its port

A preview container publishes its app port to a host port, and by default that
publish is on **every interface** (`0.0.0.0`) — docker's own default, unchanged.
On a host that builds previews for review, the firewall is then the only thing
keeping an unauthenticated preview off the public interface. To narrow it:

    cinatra instance preview create --bind 127.0.0.1
    cinatra install --mode preview --bind 127.0.0.1
    CINATRA_PREVIEW_BIND_HOST=127.0.0.1 cinatra instance preview create

The flag wins over the environment variable, anything that is not an IP literal
is rejected before anything is built or booted (docker publishes on an IP only —
it answers `invalid IP address: localhost` for a name), and the resolved bind is
**recorded on the preview's registry row** — so `refresh` and
`start --recreate` re-publish on the same interface instead of quietly widening
it — and on `start` a *changed* bind is applied (and recorded) only with
`--recreate`, because docker cannot move a running container's publish. The
health probe follows the bind: `localhost` for the unchanged wide publish and for
a loopback one, and the bound address itself when the publish names one
interface, so a preview bound to a LAN address is health-gated where it actually
listens.

### Which extension fleet a preview image carries

A preview image acquires only the **required** extensions, the set a real
deployment carries. A dev boot, by contrast, syncs the **dev fleet** — so a proof
run dispatched on a preview instance has no agent to run. `--fleet` decides which
of the two goes into the image:

    cinatra instance preview create --fleet dev
    cinatra instance preview refresh --slug <slug> --fleet dev

Accepted values are `required` and `dev`, and the default is `required`.
`--fleet dev` becomes the build-arg `CINATRA_EXTENSION_FLEET=dev` for the image
build; `required` passes nothing at all, so the resolved SHA's own default
stands. The resolved fleet is **recorded on the preview's registry row** and
printed by `instance preview status` as `fleet=<value>`, so a later `start` or
`refresh` reuses the same fleet — and a `refresh` that names a *different* one is
refused (the fleet is baked into the image, so changing it is creating a
different instance: create a second preview under its own `--slug` instead —
there is no `preview prune` verb, as the disk section below says).

The front door forwards it too: `cinatra install --mode preview --fleet dev`
bootstraps its first preview on the dev fleet. Because the fleet is baked into
the image, it is part of the image's *tag* — a dev preview and a required one at
the same SHA are two different images and never reuse or overwrite each other.

**A dev-fleet preview is a proof instance — never a deployment.** It exists so a
capture or verification host can dispatch a real run against a production-built
image without an install step. The extra fleet is exactly what a deployment must
not carry, which is why the default never changes on its own.

### The preview build cache and what it costs on disk

A preview build is the checkout's whole multi-stage Dockerfile, and without a
cache **two builds of the very same commit share nothing** — a rebuild costs the
full time again. When `docker buildx` is installed, the CLI builds through it
with a local layer cache, so a rebuild whose earlier steps are unchanged reuses
them; run a build and look for `CACHED` in its output (the build already runs
`--progress=plain` on that path, which is what makes those lines visible):

    cinatra instance preview refresh --slug <slug> --rebuild 2>&1 | grep CACHED

Without buildx the classic builder runs exactly as before — the CLI says which
builder it used on every build, so this is never a guess. `CINATRA_PREVIEW_BUILD_CACHE=off`
pins the classic builder even where buildx is present.

**Disk.** Preview builds are large. A spike measured roughly **18 GB of
intermediate layers per built commit** on one verification host — an approximate
figure for planning, not a promise — and the buildx cache is *additional* to
that, growing with every distinct build. There is no `preview prune` verb yet, so
cleanup is manual:

    du -sh ~/.cinatra/preview-build-cache   # measure the layer cache
    rm -rf ~/.cinatra/preview-build-cache   # prune it (a later build refills it)
    docker system df                        # measure images + build cache
    docker image ls 'cinatra-preview:*'     # the per-SHA preview images

`cinatra instance preview refresh` already removes the image it supersedes once
the new one is healthy, and pruning a preview removes its image when no other
preview references it — so the images that accumulate are the ones belonging to
previews you still have. `CINATRA_PREVIEW_BUILD_CACHE_DIR` moves the layer cache
to a bigger disk.

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
    cinatra install --infra=external \       # …and let the CLI create that database
        --db-name <name> --db-template <name>  # from your own template first

Useful extras:

    cinatra install --instance <name>        # name the instance (default: the folder name)
    cinatra install --app-port <n>           # pick the app port for an isolated instance
    cinatra install --port-offset auto|<n>   # how far to shift an isolated instance's ports
    cinatra install --db-name <name>         # name the instance's own database
    cinatra install --db-template <name>     # create it from your own template database
    cinatra install --bullmq-queue <name>    # name its job queue on the shared Redis
    cinatra install --dry-run                # show what would happen, change nothing
    cinatra install --list-instances         # list the instances you have set up
    cinatra install --status [--dir <path>]  # show one checkout's instance state
    cinatra install --resume                 # finish an install that was interrupted

### Installing unattended

If nobody is watching the install — a CI job or an automated verification runner
that creates many isolated instances, each in a checkout already parked at an
exact commit, and has to hand that checkout back byte-for-byte clean — three
opt-in flags make `cinatra install` fit:

    cinatra install --pinned-extensions   # the dev extension fleet at the checkout's
                                          # OWN committed lock shas, not the repos' tips
    cinatra install --frozen-lockfile     # `pnpm install --frozen-lockfile`: a lockfile
                                          # drift is a refusal, not a rewritten file
    cinatra install --no-fetch --ref <sha> # move an existing checkout to that commit
                                          # without fetching (it already has it)

`--pinned-extensions` applies to the install's own extension sync **and** to the
setup phase it runs, so the fleet cannot float back to a tip halfway through. It
is fail-closed: an extension the committed lock cannot pin stops the install
rather than silently tracking a branch. It belongs to a dev-like install
(`dev`/`demo`/`preview`) — a `--mode prod` install already acquires its required
extensions pinned and integrity-verified, and refuses the flag rather than
pretending to honour it. With `--mode preview` it pins the fleet of the
**checkout** (the dev half of that composition); what the preview *image*
acquires is chosen by `--fleet` and is not affected.

It also decides what happens to the **generated extension maps**
(`src/lib/generated/`) — the other file set an install writes into your
checkout. The setup phase normally regenerates them for the extension set it
just synced. With the fleet pinned to the committed lock those maps cannot
legitimately move, so they are checked instead: setup compares them with what
the generator emits for that fleet and, if any differ, names them, leaves every
tracked file exactly as it found it, and exits `22` — the code the `cinatra
install` it runs under exits with too, so a caller reading exit codes can tell a
stale committed map apart from any other failure. Regenerate them with
`node scripts/extensions/generate-extension-manifest.mjs` and commit them on the
commit the checkout is parked at, then re-run. Without the flag the maps are
regenerated in place, as before.

`--frozen-lockfile` reaches every dependency install of the run — the install's
own, and the one the setup phase runs when it re-links the workspace after its
extension sync — on every package-manager tier. A `--mode prod` install performs
three: one either side of the extension acquisition, and the setup child's.

`--no-fetch` moves an existing checkout — a plain clone or a detached git
worktree — to `--ref` (a branch, a tag, or a full commit SHA) using only what
that checkout already has. It requires an explicit `--ref`: without one the
install would target the default `main` and resolve it from whatever the
checkout happens to hold. If the ref does not resolve locally it refuses and
names it, rather than moving somewhere else, and it refuses when the target
directory holds no checkout at all, because cloning one is the very fetch the
flag suppresses. It suppresses *that* fetch only — the run still clones the
declared companion extension repos and installs dependencies from a registry.

All three are off by default: an install that does not ask for them behaves
exactly as it did before.

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
>
> **Your own database name and template.** By default the instance's database is
> named after the instance and created from the seed template the CLI maintains.
> If you run many instances against one PostgreSQL server, you can say what that
> database is called and what it is copied from: `--db-name <name>` and
> `--db-template <name>`. A template database you prepared yourself — migrated
> and seeded once, then marked a template — makes each new instance's database a
> copy made in an instant rather than a full migration run. Either flag on its
> own selects this shared-services road, so `cinatra install` refuses it beside
> an `--on-conflict`/`--infra` that asks for a different one — with one
> exception: the two TOGETHER also work on `--infra=external`, where they name a
> database to create on your own server (below).
>
> Both names must be plain PostgreSQL identifiers: a lowercase letter, then
> lowercase letters, digits or underscores, at most 63 bytes. A `--db-name` may
> not be one of the databases no cinatra command may touch (`postgres`,
> `cinatra`, the seed, `template0`, `template1`), may not sit in a namespace the
> CLI creates and drops on its own (`cinatra_clone_…`, `cinatra_inst_…`,
> `cinatra_seed…` — `instance clone prune` and `clone refresh-seed` delete those
> without asking), may not be the database the donor instance itself uses, and
> may not be the template you are copying from. Every one of those is refused
> before `cinatra install` opens a connection.
>
> The template must already exist and be marked one:
> `ALTER DATABASE "<name>" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`. Both
> halves matter — PostgreSQL will not copy a database while another session is
> connected to it, which is exactly what the second half prevents; the CLI marks
> its own seed the same way. This is checked before anything is created, and a
> template that is still open to connections is called out as a warning rather
> than refused. PostgreSQL's own `template0` and `template1` are accepted too;
> the run then says plainly that the new database will be empty.
>
> A database of the chosen name that ALREADY exists is used as it stands: it is
> never dropped, never created over — the template is then not used at all, and
> the run says so — and never removed if the install fails afterwards. Only a
> database this run created itself is rolled back. `--bullmq-queue <name>`
> likewise names the instance's job queue on the shared Redis instead of
> deriving it.
>
> One requirement the CLI cannot check for you: a co-use instance INHERITS the
> donor's `BETTER_AUTH_SECRET` and `CINATRA_ENCRYPTION_KEY`, because a database
> copied from the donor's seed must be readable with the donor's keys. If your
> own template was seeded under different keys, its encrypted rows will not
> decrypt in the new instance. Prepare the template on the same keys, or expect
> to re-enter whatever was encrypted.

### Your own PostgreSQL server: letting the install create the database

`--infra=external` points an instance at a PostgreSQL server, a Redis and a
Nango you run yourself. If the instance's database does not exist there yet, say
what it is called and what to copy it from and `cinatra install` will create it
for you, before setup and migrations run:

    cinatra install --infra=external \
        --db-url postgresql://…/team_instance_a \
        --db-name team_instance_a --db-template team_seed_template \
        --external-db-disposable

Both flags are needed together on this road: there is no built-in seed on a
server the CLI does not run, so a `--db-name` with no `--db-template` is
refused and names what is missing. They select the shared-services road when
you pass them without `--infra=external`, and `--reuse-from` / `--bullmq-queue`
belong to that road alone — the external install reads neither, so it refuses
them rather than ignoring them.

You do not have to put the credential on the command line. With no `--db-url`,
the install reads the `SUPABASE_DB_URL` your checkout's `.env.local` already
carries and creates the database on that server. The value is read by key and
used in the process — it is never passed to another command and never printed;
every line the run writes names the database and the template only.

The database is created on the server's maintenance database, from the template
exactly as on the shared road: the template must exist and be marked one
(`ALTER DATABASE "<name>" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`), and
that is checked before anything is created. A database of that name that is
already there is said out loud and left exactly as it stands — nothing is
dropped, nothing is created over, and the template is then not used. So the
command is safe to re-run.

`--db-name` must be the database the install itself points at: naming a
different one would create a database nothing then uses while setup migrated
another, so `cinatra install` refuses that, naming both databases.

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
