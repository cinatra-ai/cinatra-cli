// cinatra-ai/cinatra-cli#281 — `cinatra instance wayflow start --instance
// <name>`: the key the runtime signs its context callbacks with, the
// interpreter the in-container probe runs on, and the interface the runtime's
// port is published on.
//
// WHAT THESE TESTS PIN
// --------------------
//   * the context attest key — read from the checkout's own `.env.local` by
//     key and handed to the launch beside the bridge token, through the launch
//     environment alone: the rendered runtime service names both keys as the
//     `${…}` references compose resolves at launch, and neither value reaches
//     an argument list, the output or the document. Nothing else from the file
//     reaches the launch. A missing key is refused by name before anything is
//     built, replaced or started — on this verb, and on `instance clone start`,
//     which launches the same template;
//   * the probe — asked with `node` first, as it always was, and with
//     `python3` when the image has no node (the runtime image carries python
//     only). The answer names the interpreter that gave it, only an image with
//     neither is reported as one the probe could not run in, and a refusal
//     still names the callback address;
//   * the bind — the runtime port is published on this machine's loopback
//     unless `--bind` names another address, as `"<address>:<port>:3010"`; a
//     value docker cannot publish on is refused, and `stop` refuses the flag
//     like every other start flag.
//
// Hermetic, in the established style of the per-instance runtime tests: no
// Docker, no network, no real checkout. The runtime directory is redirected
// with `home`, the checkout is a temp dir carrying a compose template with the
// documented placeholders, and every spawn/probe is a fake. The clone road is
// driven through the command itself, with its state directory in a temp dir
// and a `docker` on PATH that refuses to run, and it refuses before it reaches
// anything that needs an engine.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLONE_MAX_INDEX,
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
  cloneDbName,
} from "../src/clone-registry.mjs";
import { runInstanceWayflow } from "../src/index.mjs";
// A namespace import: what this issue adds is read off it, so a name that is
// not there yet fails the one test that needs it rather than every test here.
import * as runtime from "../src/instance-runtime.mjs";
import { WAYFLOW_ENV_REQUIRED_KEYS } from "../src/wayflow-runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// The product's own names for the two keys the runtime needs from the app's
// environment, spelled out rather than imported: a test that re-derives them
// from the source proves nothing about them.
const BRIDGE_KEY = "CINATRA_BRIDGE_TOKEN";
const ATTEST_KEY = "CINATRA_CONTEXT_ATTEST_KEY";
const BRIDGE_LINE = '      CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}"';
const ATTEST_LINE = '      CINATRA_CONTEXT_ATTEST_KEY: "${CINATRA_CONTEXT_ATTEST_KEY}"';

const TOKEN = "bridge-token-value-that-must-never-be-echoed";
const ATTEST = "attest-key-value-that-must-never-be-echoed";
// A value only the checkout's file carries: it reaches neither the launch nor
// the document.
const FILE_ONLY = "file-only-value-that-must-not-reach-the-launch";

// This machine's loopback address, and one from the range reserved for
// documentation — both assembled rather than written out. Docker publishes a
// port on an IP address and refuses a name there, so the document carries the
// address, not the name.
const LOOPBACK = [127, 0, 0, 1].join(".");
const DOTTED = [192, 0, 2, 10].join(".");

// An address the operator names for the app, handed to the container as
// written (cinatra-cli#279).
const RELAY = "http://relay.internal:3301";

const START = ["--instance", "web-a", "--runtime-port", "3910"];
const CONTAINER = "cinatra-instance-web-a-wayflow-1";

// The shape of the checkout's own runtime template: the runtime service hands
// the container the bridge token by reference and names no attest key, and the
// sidecar next to it has an environment of its own.
const TEMPLATE = `services:
  wayflow:
    image: cinatra-wayflow:local
    ports:
      - "@@WAYFLOW_PORT@@:3010"
    environment:
      PORT: "3010"
      CINATRA_BASE_URL: "http://host.docker.internal:@@NEXTJS_PORT@@"
      CINATRA_BRIDGE_TOKEN: "\${CINATRA_BRIDGE_TOKEN}"
      WAYFLOW_BASE_URL: "http://localhost:@@WAYFLOW_PORT@@"
      OPENAI_API_KEY: "\${OPENAI_API_KEY:-}"
    volumes:
      - "@@WORKTREE_PATH@@/extensions:/agents:ro"
    extra_hosts:
      - "host.docker.internal:host-gateway"
  tailscale:
    hostname: "@@TS_HOSTNAME@@"
    network_mode: "@@TAILSCALE_NETWORK_MODE@@"
    environment:
      TS_AUTHKEY: "\${TS_AUTHKEY}"
    volumes:
      - "@@CLONE_STATE_DIR@@/tailscale-state:/var/lib/tailscale"
`;

const ENV_BODY =
  `${BRIDGE_KEY}=${TOKEN}\n${ATTEST_KEY}=${ATTEST}\nNANGO_ENCRYPTION_KEY=${FILE_ONLY}\nPORT=3300\n`;

let home;
let checkout;
const made = [];

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function makeCheckout(envBody = ENV_BODY, template = TEMPLATE) {
  const dir = tempDir("cin-281-co-");
  mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
  writeFileSync(path.join(dir, "docker", "wayflow", "compose.clone.template.yml"), template);
  if (envBody !== null) writeFileSync(path.join(dir, ".env.local"), envBody, { mode: 0o600 });
  return dir;
}

beforeEach(() => {
  home = tempDir("cin-281-home-");
  checkout = makeCheckout();
});

afterEach(() => {
  for (const dir of made.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

const RUNNING = { status: 0, stdout: "running\n" };
const ABSENT = { status: 1, stdout: "", stderr: "Error: No such object: x" };

/** An image that carries only python: `node` is not on its PATH. */
const PYTHON_ONLY = (args) => (args[2] === "node" ? { status: 127, stdout: "" } : { status: 0 });

/**
 * The verb with only its outermost boundaries replaced. `inspect` answers the
 * container-state read, `imageInspect` the image-presence read, `exec` the
 * in-container callback probe, and `probe` the host-side runtime health read.
 * The checkout's image step runs through the fake spawn when `realImageStep`
 * asks for it, so a build or an image read shows up among the launches.
 */
function runner({
  inspect = ABSENT,
  imageInspect = { status: 0, stdout: "[]" },
  exec = { status: 0, stdout: "" },
  probe = { ok: true, status: 200 },
  up = { status: 0 },
  realImageStep = false,
} = {}) {
  const launches = [];
  const lines = [];
  const probes = [];
  const run = (verb, argv) =>
    runInstanceWayflow(verb, argv, {
      home,
      getRepoRoot: () => checkout,
      isComposeAvailable: () => true,
      ...(realImageStep ? { readCheckoutHeadSha: () => null } : { ensureWayflowImage: () => {} }),
      log: (line) => lines.push(String(line)),
      probeHttp: async (url) => {
        probes.push(url);
        return typeof probe === "function" ? probe(url) : probe;
      },
      spawnSync: (cmd, args, opts) => {
        launches.push({ cmd, args, env: opts?.env ?? null });
        const answer = (fixture) => (typeof fixture === "function" ? fixture(args) : fixture);
        if (args[0] === "inspect") return answer(inspect);
        if (args[0] === "image") return answer(imageInspect);
        if (args[0] === "exec") return answer(exec);
        return answer(up);
      },
    });
  return { run, launches, lines, probes };
}

const composeOf = (slug) =>
  readFileSync(runtime.instanceRuntimeComposePath(slug, { home }), "utf8");

/** The runtime service's own lines in a document: `  wayflow:` and its block. */
function serviceOf(document) {
  const lines = String(document).split("\n");
  const at = lines.indexOf("  wayflow:");
  const end = lines.findIndex((line, i) => i > at && /^ {0,2}\S/.test(line));
  return lines.slice(at, end === -1 ? undefined : end);
}

/** The message a promise was rejected with, or "" when it was not. */
async function refusalOf(promise) {
  try {
    await promise;
  } catch (err) {
    return String(err?.message ?? "");
  }
  return "";
}

/** The message a call threw, or "" when it did not. */
function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return String(err?.message ?? "");
  }
  return "";
}

const execs = (launches) => launches.filter(({ args }) => args[0] === "exec");

const planFor = (flags = []) =>
  runtime.resolveInstanceRuntimePlan({
    verb: "start",
    argv: [...START, ...flags],
    repoRoot: checkout,
    home,
  });

// ---------------------------------------------------------------------------

describe("the context attest key", () => {
  it("is the key the shared runtime already requires, under the same name", () => {
    expect(WAYFLOW_ENV_REQUIRED_KEYS).toContain(ATTEST_KEY);
    expect(runtime.INSTANCE_RUNTIME_CONTEXT_ATTEST_KEY).toBe(ATTEST_KEY);
  });

  // The runtime's loader refuses to start without the key, so a container
  // launched without it never answers. It travels exactly as the bridge token
  // does: by key, from the checkout's own file, in the launch environment.
  it("reaches the launch beside the bridge token, and nothing else from the file does", async () => {
    const { run, launches } = runner();
    await run("start", START);
    const up = launches.find(({ args }) => args.includes("up"));
    expect(up.env?.[BRIDGE_KEY]).toBe(TOKEN);
    expect(up.env?.[ATTEST_KEY]).toBe(ATTEST);
    expect(Object.values(up.env ?? {})).not.toContain(FILE_ONLY);
  });

  // The template names the bridge token and not the attest key, so the verb
  // adds the key's line to the runtime service, beside the token's, as the
  // same `${…}` reference compose resolves from the launch environment.
  it("the runtime service names both keys by reference, and the document carries neither value", async () => {
    const { run, launches, lines } = runner();
    await run("start", START);
    const document = composeOf("web-a");
    expect(serviceOf(document)).toEqual([
      "  wayflow:",
      "    image: cinatra-wayflow:local",
      "    ports:",
      `      - "${LOOPBACK}:3910:3010"`,
      "    environment:",
      '      PORT: "3010"',
      '      CINATRA_BASE_URL: "http://host.docker.internal:3300"',
      BRIDGE_LINE,
      ATTEST_LINE,
      '      WAYFLOW_BASE_URL: "http://localhost:3910"',
      '      OPENAI_API_KEY: "${OPENAI_API_KEY:-}"',
      "    volumes:",
      `      - "${checkout}/extensions:/agents:ro"`,
      "    extra_hosts:",
      '      - "host.docker.internal:host-gateway"',
    ]);
    // The sidecar's own environment is not the runtime's.
    expect(document).toContain('    environment:\n      TS_AUTHKEY: "${TS_AUTHKEY}"\n    volumes:');
    for (const value of [TOKEN, ATTEST, FILE_ONLY]) {
      expect(document).not.toContain(value);
      expect(lines.join("\n")).not.toContain(value);
      for (const { args } of launches) expect(args.join(" ")).not.toContain(value);
    }
  });

  it("is refused by name before anything is built, replaced or started when the file carries none", async () => {
    checkout = makeCheckout(`${BRIDGE_KEY}=${TOKEN}\nPORT=3300\n`);
    const { run, launches } = runner({ inspect: RUNNING, realImageStep: true });
    const message = await refusalOf(run("start", START));
    expect(message).toContain(`carries no ${ATTEST_KEY}`);
    expect(message).toContain(path.join(checkout, ".env.local"));
    // Only the read of the container's state happened: no image read, no
    // build, no stop, no removal, no launch, no probe — and no document.
    expect(launches.map(({ args }) => args.join(" "))).toEqual([
      `inspect --format {{.State.Status}} ${CONTAINER}`,
    ]);
    expect(existsSync(runtime.instanceRuntimeComposePath("web-a", { home }))).toBe(false);
  });

  // The per-clone road renders the same template, so it has the same line to
  // add — and nothing else to change.
  it("the clone road's document names it beside the bridge token too, and changes nothing else", () => {
    expect(typeof runtime.cloneRuntimeComposeDocument).toBe("function");
    const rendered = TEMPLATE.replaceAll("@@WAYFLOW_PORT@@", "3219")
      .replaceAll("@@NEXTJS_PORT@@", "3119")
      .replaceAll("@@WORKTREE_PATH@@", checkout)
      .replaceAll("@@TS_HOSTNAME@@", "cinatra-web-a-19")
      .replaceAll("@@TAILSCALE_NETWORK_MODE@@", "bridge")
      .replaceAll("@@CLONE_STATE_DIR@@", home);
    const document = runtime.cloneRuntimeComposeDocument(rendered, "web-a");
    const service = serviceOf(document);
    expect(service[service.indexOf(BRIDGE_LINE) + 1]).toBe(ATTEST_LINE);
    expect(document.replace(`${ATTEST_LINE}\n`, "")).toBe(rendered);
  });
});

describe("instance clone start — the same key, the same refusal", () => {
  const INDEX = CLONE_MAX_INDEX;

  /** A registered, ready clone whose worktree's `.env.local` is `env`. */
  function cloneFixture(env) {
    const cloneHome = tempDir("cin-281-clone-home-");
    const worktree = path.join(cloneHome, "wt-web-a");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".env.local"), env, { mode: 0o600 });
    mkdirSync(path.join(cloneHome, ".cinatra"), { recursive: true });
    writeFileSync(
      path.join(cloneHome, ".cinatra", "clones.json"),
      JSON.stringify({
        version: 1,
        clones: {
          "web-a": {
            index: INDEX,
            nextjsPort: CLONE_NEXTJS_PORT_BASE + INDEX,
            wayflowPort: CLONE_WAYFLOW_PORT_BASE + INDEX,
            dbName: cloneDbName("web-a"),
            worktreePath: worktree,
            state: "ready",
            createdAt: "2026-09-23T00:00:00.000Z",
          },
        },
      }),
    );
    // A `docker` that refuses to run, first on PATH: nothing here may reach an
    // engine, whatever the command under test does.
    const bin = path.join(cloneHome, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho 'no engine in this test' >&2\nexit 1\n");
    chmodSync(path.join(bin, "docker"), 0o755);
    return { cloneHome, worktree, bin };
  }

  function cloneStart({ cloneHome, bin }) {
    const res = spawnSync(process.execPath, [BIN, "instance", "clone", "start", "--slug", "web-a"], {
      cwd: cloneHome,
      env: {
        ...process.env,
        HOME: cloneHome,
        TS_AUTHKEY: "",
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: res.status, output: `${res.stdout ?? ""}${res.stderr ?? ""}` };
  }

  it("is refused by name before anything is started when the clone's file carries none", () => {
    const fixture = cloneFixture("SUPABASE_SCHEMA=cinatra\n");
    const { status, output } = cloneStart(fixture);
    expect(output).toContain(`carries no ${ATTEST_KEY}`);
    expect(output).toContain(path.join(fixture.worktree, ".env.local"));
    expect(status).not.toBe(0);
    // Nothing was started: the clone's runtime directory — its lock, its pid
    // file, its log and its compose document — was never even created.
    expect(existsSync(path.join(fixture.cloneHome, ".cinatra", "clones", "web-a"))).toBe(false);
  });

  // The control: with the key there, the start goes on to the checks that
  // were already there, and never repeats the value.
  it("goes on past the key when the clone's file carries it", () => {
    const fixture = cloneFixture(`${ATTEST_KEY}=${ATTEST}\nSUPABASE_SCHEMA=cinatra\n`);
    const { status, output } = cloneStart(fixture);
    expect(output).not.toContain(ATTEST_KEY);
    expect(output).not.toContain(ATTEST);
    expect(output).toMatch(/missing SUPABASE_DB_URL/);
    expect(status).not.toBe(0);
  });
});

describe("the in-container probe", () => {
  it("asks with node first and with python3 when the image has no node, and names python3", async () => {
    const { run, launches, lines } = runner({ exec: PYTHON_ONLY });
    await run("start", [...START, "--app-url", RELAY]);
    expect(execs(launches).map(({ args }) => args.slice(0, 4))).toEqual([
      ["exec", CONTAINER, "node", "-e"],
      ["exec", CONTAINER, "python3", "-c"],
    ]);
    // A GET of the app's health route at the address the container was given,
    // bounded at 5 s, and any 2xx or 3xx answer is an app that answered.
    const script = execs(launches)[1].args[4];
    expect(script).toContain("urllib.request");
    expect(script).toContain(`"${RELAY}/api/health"`);
    expect(script).toContain("timeout=5");
    expect(script).toContain("200 <= status < 400");
    expect(lines.join("\n")).toContain(`${RELAY} (reached from inside the container with python3)`);
  });

  it("the verdict names the interpreter that gave it", () => {
    const plan = planFor(["--app-url", RELAY]);
    expect(typeof runtime.probeCallbackInsideContainer).toBe("function");
    expect(runtime.probeCallbackInsideContainer(plan, () => ({ status: 0 }))).toMatchObject({
      verdict: "ok",
      interpreter: "node",
    });
    expect(runtime.probeCallbackInsideContainer(plan, PYTHON_ONLY)).toMatchObject({
      verdict: "ok",
      interpreter: "python3",
    });
    expect(
      runtime.probeCallbackInsideContainer(plan, (args) =>
        args[2] === "node" ? { status: 126 } : { status: 1 },
      ),
    ).toMatchObject({ verdict: "unreachable", interpreter: "python3" });
  });

  it("names the callback address, and python3, when python3 cannot reach the app", async () => {
    const { run } = runner({ exec: (args) => (args[2] === "node" ? { status: 127 } : { status: 1 }) });
    const message = await refusalOf(run("start", [...START, "--app-url", RELAY]));
    expect(message).toContain(`cannot reach this instance's app at ${RELAY}`);
    expect(message).toContain("python3");
  });

  it("reports no-interpreter only when the image carries neither, and still names the callback address", async () => {
    const { run, launches } = runner({
      exec: (args) => (args[2] === "node" ? { status: 126 } : { status: 127 }),
    });
    const message = await refusalOf(run("start", [...START, "--app-url", RELAY]));
    expect(execs(launches).map(({ args }) => args[2])).toEqual(["node", "python3"]);
    expect(message).toMatch(/neither `node` nor `python3`/);
    expect(message).toContain(RELAY);
    expect(
      runtime.probeCallbackInsideContainer?.(planFor(["--app-url", RELAY]), () => ({ status: 127 })),
    ).toMatchObject({ verdict: "no-interpreter", interpreter: null });
  });
});

describe("the interface the runtime's port is published on", () => {
  it("is this machine's loopback when no --bind is given", async () => {
    const { run, probes, lines } = runner();
    await run("start", START);
    expect(serviceOf(composeOf("web-a"))).toContain(`      - "${LOOPBACK}:3910:3010"`);
    expect(probes).toContain("http://localhost:3910/.health");
    expect(lines.join("\n")).toContain(`published on ${LOOPBACK}`);
  });

  it("is the address an operator names with --bind — the loopback name, an IPv6 address, another interface", async () => {
    await runner().run("start", [...START, "--bind", "localhost"]);
    expect(serviceOf(composeOf("web-a"))).toContain(`      - "${LOOPBACK}:3910:3010"`);

    await runner().run("start", [...START, "--bind", "::1"]);
    expect(serviceOf(composeOf("web-a"))).toContain('      - "[::1]:3910:3010"');

    // Published on one other interface only, the runtime answers there and
    // nowhere else, so that is where the health wait dials.
    const other = runner();
    await other.run("start", [...START, "--bind", DOTTED]);
    expect(serviceOf(composeOf("web-a"))).toContain(`      - "${DOTTED}:3910:3010"`);
    expect(other.probes).toContain(`http://${DOTTED}:3910/.health`);
  });

  it("refuses a --bind docker could not publish on, before anything is touched", async () => {
    for (const bad of ["", "http://localhost", "localhost:3910", "has space", "relay.internal"]) {
      expect(thrownBy(() => runtime.parseInstanceRuntimeFlags([...START, "--bind", bad]))).toMatch(
        /^Invalid --bind /,
      );
    }
    const { run, launches } = runner();
    const message = await refusalOf(run("start", [...START, "--bind", "relay.internal"]));
    expect(message).toMatch(/^Invalid --bind "relay\.internal"\. Docker publishes a port on an IP address/);
    expect(launches).toEqual([]);
  });

  it("stop refuses --bind like every other start flag", async () => {
    const { run, launches } = runner({ inspect: RUNNING });
    const message = await refusalOf(run("stop", ["--instance", "web-a", "--bind", "::1"]));
    expect(message).toMatch(/takes no .*--bind/);
    expect(launches).toEqual([]);
  });

  // What the verb writes into the runtime service needs a place in the
  // checkout's template; one that gives it none is refused before any
  // container is looked at, rather than launched without it.
  it("refuses a template that gives the port or the key no place, before anything is touched", async () => {
    for (const [template, said] of [
      [TEMPLATE.replace('      - "@@WAYFLOW_PORT@@:3010"\n', '      - "3010"\n'), /does not publish/],
      [TEMPLATE.replace(/ {4}environment:\n( {6}.*\n)+(?= {4}volumes:)/, ""), /no environment/],
    ]) {
      checkout = makeCheckout(ENV_BODY, template);
      const { run, launches } = runner({ inspect: RUNNING });
      expect(await refusalOf(run("start", START))).toMatch(said);
      expect(launches).toEqual([]);
    }
  });
});
