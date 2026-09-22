// cinatra-ai/cinatra-cli#260 — `cinatra instance wayflow start|stop --instance
// <name>`: ONE agent-runtime container for ONE instance, on a port the operator
// names, under a name the operator's other instance can never collide with.
//
// WHAT THESE TESTS PIN
// --------------------
//   * the derived names — the compose project and the container for a slug,
//     byte-for-byte the spellings `instance start` records for the same slug,
//     so the two verbs can never address different containers;
//   * two instances side by side — two slugs produce two disjoint projects,
//     containers, compose documents and ports;
//   * the rendered compose — the runtime port it publishes, the callback
//     address the runtime dials the app on, and the bridge credential left as
//     the literal `${CINATRA_BRIDGE_TOKEN}` placeholder compose resolves at
//     exec time;
//   * the health gate — the verb returns only once the runtime answers, and
//     refuses NAMING THE CALLBACK ADDRESS when the container cannot reach the
//     app;
//   * idempotence — a container that is running, answering AND launched from
//     the document this invocation would write is left alone: nothing written,
//     nothing launched; one whose document no longer says what was asked for is
//     REPLACED rather than reported healthy;
//   * the port-band assertion over BOTH of its callers — a registry row's port
//     outside the clone bands is still refused, an operator's is taken as given;
//   * the credential — never in an argument list, never in the output, and
//     never in a file this verb creates;
//   * the default — with no `--instance` the shared-service road's argument
//     list is unchanged.
//
// Hermetic: no Docker, no network, no real checkout. The runtime directory is
// redirected with `home`, the checkout is a temp dir carrying a compose template
// with the documented placeholders, and every spawn/probe is a fake.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertCloneSlotPorts, assertPortBandOk } from "../src/clone-runtime.mjs";
import {
  CLONE_NEXTJS_PORT_BASE,
  CLONE_WAYFLOW_PORT_BASE,
} from "../src/clone-registry.mjs";
import {
  composeWayflowArgs,
  effectiveComposeProjectName,
  runDevWayflow,
  runInstanceWayflow,
} from "../src/index.mjs";
import {
  INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY,
  INSTANCE_RUNTIME_CALLBACK_PROBE_TIMEOUT_MS,
  INSTANCE_RUNTIME_COMPOSE_FILE,
  INSTANCE_RUNTIME_GATEWAY_HOST,
  INSTANCE_RUNTIME_SERVICE,
  callbackProbeScript,
  callbackProbeVerdict,
  composeInstanceRuntimeUpArgs,
  containerCallbackProbeArgs,
  dockerRuntimeInspectArgs,
  dockerRuntimeRemoveArgs,
  instanceComposeProject,
  instanceRuntimeComposePath,
  instanceRuntimeContainer,
  instanceRuntimeRequested,
  instanceRuntimeTemplateVars,
  parseInstanceRuntimeFlags,
  parseRuntimeContainerState,
  resolveInstanceRuntimePlan,
} from "../src/instance-runtime.mjs";

// A compose template carrying the SIX documented placeholders (the contract
// `renderCloneComposeTemplate` substitutes into) plus the bridge-credential
// placeholder compose itself resolves. Deliberately minimal: these tests are
// about what the verb SUBSTITUTES, not about the runtime image.
const TEMPLATE = `services:
  wayflow:
    image: cinatra-wayflow:local
    ports:
      - "@@WAYFLOW_PORT@@:3010"
    environment:
      CINATRA_BASE_URL: "http://host.docker.internal:@@NEXTJS_PORT@@"
      CINATRA_BRIDGE_TOKEN: "\${CINATRA_BRIDGE_TOKEN}"
      WAYFLOW_BASE_URL: "http://localhost:@@WAYFLOW_PORT@@"
    volumes:
      - "@@WORKTREE_PATH@@/extensions:/agents:ro"
  tailscale:
    hostname: "@@TS_HOSTNAME@@"
    network_mode: "@@TAILSCALE_NETWORK_MODE@@"
    volumes:
      - "@@CLONE_STATE_DIR@@/tailscale-state:/var/lib/tailscale"
`;

const TOKEN = "bridge-token-value-that-must-never-be-echoed";

let home;
let checkout;
const made = [];

function makeCheckout(envBody = `${INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY}=${TOKEN}\nPORT=3300\n`) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cin-260-co-"));
  made.push(dir);
  mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
  writeFileSync(path.join(dir, "docker", "wayflow", "compose.clone.template.yml"), TEMPLATE);
  if (envBody !== null) writeFileSync(path.join(dir, ".env.local"), envBody, { mode: 0o600 });
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "cin-260-home-"));
  made.push(home);
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

/**
 * The verb with only its outermost boundaries replaced. `inspect` answers the
 * container-state read, `exec` answers the in-container callback probe, and
 * `probe` answers the host-side runtime health read.
 */
function runner({
  inspect = { status: 1, stdout: "" },
  exec = { status: 0, stdout: "" },
  probe = { ok: true, status: 200 },
  up = { status: 0 },
} = {}) {
  const launches = [];
  const lines = [];
  const probes = [];
  const run = (verb, argv, overrides = {}) =>
    runInstanceWayflow(verb, argv, {
      home,
      getRepoRoot: () => checkout,
      isComposeAvailable: () => true,
      ensureWayflowImage: () => {},
      log: (line) => lines.push(String(line)),
      probeHttp: async (url) => {
        probes.push(url);
        return typeof probe === "function" ? probe(url) : probe;
      },
      spawnSync: (cmd, args, opts) => {
        launches.push({ cmd, args, env: opts?.env ?? null });
        if (args[0] === "inspect") return typeof inspect === "function" ? inspect(args) : inspect;
        if (args[0] === "exec") return typeof exec === "function" ? exec(args) : exec;
        return typeof up === "function" ? up(args) : up;
      },
      ...overrides,
    });
  return { run, launches, lines, probes };
}

const RUNNING = { status: 0, stdout: "running\n" };
const ABSENT = { status: 1, stdout: "", stderr: "Error: No such object: x" };

// ---------------------------------------------------------------------------

describe("the derived names — one spelling per instance", () => {
  // `instance start` (cinatra-cli#261) RECORDS the runtime container it expects
  // for a slug as `cinatra-instance-<slug>-wayflow-1` under compose project
  // `cinatra-instance-<slug>`. This verb must produce exactly those, or the
  // instance's start and the instance's runtime name different containers.
  it("pins the compose project and the container for a slug", () => {
    expect(instanceComposeProject("web-a")).toBe("cinatra-instance-web-a");
    expect(instanceRuntimeContainer("web-a")).toBe("cinatra-instance-web-a-wayflow-1");
  });

  it("the container is the project's own service, numbered — compose's own shape", () => {
    expect(instanceRuntimeContainer("web-a")).toBe(
      `${instanceComposeProject("web-a")}-${INSTANCE_RUNTIME_SERVICE}-1`,
    );
  });

  it("refuses a name that is not a plain lower-case instance name", () => {
    expect(() => instanceComposeProject("Web A")).toThrow(/--instance/);
    expect(() => instanceRuntimeContainer("../etc")).toThrow(/--instance/);
  });

  it("the rendered compose lives in the instance's own runtime directory", () => {
    expect(instanceRuntimeComposePath("web-a", { home })).toBe(
      path.join(home, ".cinatra", "clones", "web-a", INSTANCE_RUNTIME_COMPOSE_FILE),
    );
  });
});

describe("two instances on one machine", () => {
  const planFor = (slug, port) =>
    resolveInstanceRuntimePlan({
      verb: "start",
      argv: ["--instance", slug, "--runtime-port", String(port), "--app-url", "http://127.0.0.1:3300"],
      repoRoot: checkout,
      home,
    });

  it("each owns its own project, container, compose document and port", () => {
    const a = planFor("web-a", 3910);
    const b = planFor("web-b", 3911);
    expect(a.composeProject).not.toBe(b.composeProject);
    expect(a.container).not.toBe(b.container);
    expect(a.composePath).not.toBe(b.composePath);
    expect(a.runtimePort).not.toBe(b.runtimePort);
  });

  it("their launch arguments address nothing of each other's", () => {
    const a = composeInstanceRuntimeUpArgs(planFor("web-a", 3910));
    const b = composeInstanceRuntimeUpArgs(planFor("web-b", 3911));
    expect(a).toContain("cinatra-instance-web-a");
    expect(b).toContain("cinatra-instance-web-b");
    expect(a.some((tok) => String(tok).includes("web-b"))).toBe(false);
    expect(b.some((tok) => String(tok).includes("web-a"))).toBe(false);
  });

  it("the second start touches only its own container", async () => {
    const { run, launches } = runner({ inspect: ABSENT });
    await run("start", ["--instance", "web-b", "--runtime-port", "3911"]);
    const touched = launches.flatMap(({ args }) => args.map(String));
    expect(touched.some((tok) => tok.includes("web-a"))).toBe(false);
    expect(touched.some((tok) => tok.includes("cinatra-instance-web-b"))).toBe(true);
  });
});

describe("the rendered compose carries the port, the name and the callback address", () => {
  it("publishes the operator's runtime port and dials the operator's app port", async () => {
    const { run, launches } = runner({ inspect: ABSENT });
    await run("start", [
      "--instance",
      "web-a",
      "--runtime-port",
      "3910",
      "--app-url",
      "http://127.0.0.1:3301",
    ]);
    const rendered = readFileSync(instanceRuntimeComposePath("web-a", { home }), "utf8");
    expect(rendered).toContain('"3910:3010"');
    expect(rendered).toContain(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`);
    expect(rendered).toContain(`${checkout}/extensions:/agents:ro`);

    const up = launches.find(({ args }) => args.includes("up"));
    expect(up.args).toEqual([
      "compose",
      "-p",
      "cinatra-instance-web-a",
      "-f",
      instanceRuntimeComposePath("web-a", { home }),
      "up",
      "-d",
      INSTANCE_RUNTIME_SERVICE,
    ]);
  });

  it("names the app port from the instance's own environment when no address is given", () => {
    const plan = resolveInstanceRuntimePlan({
      verb: "start",
      argv: ["--instance", "web-a", "--runtime-port", "3910"],
      env: { PORT: "3305" },
      repoRoot: checkout,
      home,
    });
    expect(plan.appPort).toBe(3305);
    expect(plan.callbackUrl).toBe(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3305`);
    expect(instanceRuntimeTemplateVars(plan).NEXTJS_PORT).toBe(3305);
  });

  it("refuses an address that does not name this machine", () => {
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", "http://example.test:3000"]),
    ).toThrow(/--app-url/);
  });

  // The rendered document dials the app at `http://host.docker.internal:<port>`
  // and this verb has no other scheme to give it, so an https address would be
  // taken and then not used — the same silent no-op the foreign-host check
  // above exists to prevent.
  it("refuses an https address rather than accepting it and dialling http", () => {
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", "https://127.0.0.1:3000"]),
    ).toThrow(/http/);
  });

  it("never echoes a credential the operator typed into the address", () => {
    const secret = "s3cr3t-in-the-url";
    let message = "";
    try {
      parseInstanceRuntimeFlags([
        "--instance",
        "web-a",
        "--app-url",
        `http://operator:${secret}@example.test:3000`,
      ]);
      throw new Error("expected a refusal");
    } catch (err) {
      message = String(err?.message ?? "");
    }
    expect(message).toMatch(/--app-url/);
    expect(message).not.toContain(secret);
  });

  it("drops a path or a query instead of carrying it into the document", () => {
    const plan = resolveInstanceRuntimePlan({
      verb: "start",
      argv: [
        "--instance",
        "web-a",
        "--runtime-port",
        "3910",
        "--app-url",
        "http://127.0.0.1:3301/app?tenant=a#top",
      ],
      repoRoot: checkout,
      home,
    });
    expect(plan.appUrl).toBe("http://127.0.0.1:3301");
    expect(plan.callbackUrl).toBe(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`);
  });
});

describe("the health gate", () => {
  it("returns once the runtime answers and the container reaches the app", async () => {
    const { run, lines, probes } = runner({ inspect: ABSENT });
    await run("start", ["--instance", "web-a", "--runtime-port", "3910"]);
    expect(probes).toContain("http://localhost:3910/.health");
    expect(lines.join("\n")).toContain("cinatra-instance-web-a-wayflow-1");
  });

  it("refuses when the runtime never answers", async () => {
    const { run } = runner({ inspect: ABSENT, probe: { ok: false, error: "timeout" } });
    await expect(
      run("start", ["--instance", "web-a", "--runtime-port", "3910"]),
    ).rejects.toThrow(/3910/);
  });

  it("refuses NAMING THE CALLBACK ADDRESS when the container cannot reach the app", async () => {
    const { run } = runner({ inspect: ABSENT, exec: { status: 1, stdout: "" } });
    await expect(
      run("start", ["--instance", "web-a", "--runtime-port", "3910", "--app-url", "http://127.0.0.1:3301"]),
    ).rejects.toThrow(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`);
  });

  // A refused address fails at once; a BLACK-HOLED one leaves `fetch` waiting
  // on the runtime's own header timeout, and `docker exec` waits with it. The
  // bound therefore lives inside the script as well as on the spawn.
  it("the in-container probe carries its own bound", () => {
    expect(callbackProbeScript("http://host.docker.internal:3301")).toContain(
      `AbortSignal.timeout(${INSTANCE_RUNTIME_CALLBACK_PROBE_TIMEOUT_MS})`,
    );
  });

  it("tells a probe that could not RUN apart from an app that cannot be REACHED", () => {
    expect(callbackProbeVerdict({ status: 0 })).toBe("ok");
    expect(callbackProbeVerdict({ status: 1 })).toBe("unreachable");
    expect(callbackProbeVerdict({ status: 127 })).toBe("no-interpreter");
    expect(callbackProbeVerdict({ status: 126 })).toBe("no-interpreter");
    expect(callbackProbeVerdict({ error: new Error("spawn ETIMEDOUT") })).toBe("probe-failed");
  });

  it("does not blame the callback address when the container carries no node", async () => {
    const { run } = runner({ inspect: ABSENT, exec: { status: 127, stdout: "" } });
    await expect(
      run("start", ["--instance", "web-a", "--runtime-port", "3910"]),
    ).rejects.toThrow(/could not be run inside it/);
  });

  it("asks the question INSIDE the container, at the address the runtime dials", () => {
    const plan = resolveInstanceRuntimePlan({
      verb: "start",
      argv: ["--instance", "web-a", "--runtime-port", "3910", "--app-url", "http://127.0.0.1:3301"],
      repoRoot: checkout,
      home,
    });
    const args = containerCallbackProbeArgs(plan);
    expect(args.slice(0, 2)).toEqual(["exec", "cinatra-instance-web-a-wayflow-1"]);
    expect(args.join(" ")).toContain(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`);
  });
});

describe("idempotence", () => {
  const FLAGS = ["--instance", "web-a", "--runtime-port", "3910", "--app-url", "http://127.0.0.1:3301"];

  it("a healthy container of this document is left alone: nothing written, nothing launched, exit 0", async () => {
    // A first start writes the document this instance's runtime was launched
    // from — the state a re-run finds on a real machine.
    await runner({ inspect: ABSENT }).run("start", FLAGS);
    const composePath = instanceRuntimeComposePath("web-a", { home });
    const written = readFileSync(composePath, "utf8");

    const before = process.exitCode;
    const { run, launches, lines } = runner({ inspect: RUNNING });
    await run("start", FLAGS);
    expect(readFileSync(composePath, "utf8")).toBe(written);
    expect(launches.map(({ args }) => args[0])).toEqual(["inspect"]);
    expect(lines.join("\n")).toMatch(/already running/i);
    expect(process.exitCode ?? 0).toBe(before ?? 0);
  });

  // THE POINT OF THE CHECK: a container answering on the port asked for says
  // nothing about the address it calls the app BACK on. Reporting it healthy
  // would leave every agent run dialling the address of the previous start.
  it("a running, answering container whose document no longer matches is REPLACED", async () => {
    await runner({ inspect: ABSENT }).run("start", FLAGS);

    const { run, launches, lines } = runner({ inspect: RUNNING });
    await run("start", [
      "--instance",
      "web-a",
      "--runtime-port",
      "3910",
      "--app-url",
      "http://127.0.0.1:3400",
    ]);
    const verbs = launches.map(({ args }) => args[0]);
    expect(verbs).toContain("rm");
    expect(verbs).toContain("compose");
    expect(lines.join("\n")).not.toMatch(/nothing to do/i);

    const rendered = readFileSync(instanceRuntimeComposePath("web-a", { home }), "utf8");
    expect(rendered).toContain(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3400`);
    expect(rendered).not.toContain(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`);
  });

  it("a running container with no document of its own is replaced, never assumed current", async () => {
    expect(existsSync(instanceRuntimeComposePath("web-a", { home }))).toBe(false);
    const { run, launches } = runner({ inspect: RUNNING });
    await run("start", FLAGS);
    expect(launches.map(({ args }) => args[0])).toContain("rm");
  });

  it("a replacement that could not be removed refuses instead of launching over it", async () => {
    await runner({ inspect: ABSENT }).run("start", FLAGS);
    const { run, launches } = runner({
      inspect: RUNNING,
      probe: { ok: false, error: "timeout" },
      up: (args) => (args[0] === "rm" ? { status: 1 } : { status: 0 }),
    });
    await expect(run("start", FLAGS)).rejects.toThrow(/could not be removed/);
    expect(launches.map(({ args }) => args[0])).not.toContain("compose");
  });

  it("a container that is up but silent is replaced", async () => {
    const { run, launches } = runner({
      inspect: RUNNING,
      probe: (url) => ({ ok: !url.includes("3910"), error: "timeout" }),
    });
    await expect(
      run("start", ["--instance", "web-a", "--runtime-port", "3910"]),
    ).rejects.toThrow(/3910/);
    const verbs = launches.map(({ args }) => args[0]);
    expect(verbs).toContain("rm");
    expect(verbs).toContain("compose");
  });

  it("reads the container's state, never guesses it", () => {
    expect(parseRuntimeContainerState({ status: 0, stdout: "running\n" })).toEqual({
      present: true,
      running: true,
      status: "running",
    });
    expect(parseRuntimeContainerState({ status: 0, stdout: "exited\n" })).toEqual({
      present: true,
      running: false,
      status: "exited",
    });
    expect(parseRuntimeContainerState(ABSENT)).toEqual({
      present: false,
      running: false,
      status: null,
    });
  });
});

describe("stop removes only that one container", () => {
  it("stops and removes the instance's own container", async () => {
    const { run, launches } = runner({ inspect: RUNNING });
    await run("stop", ["--instance", "web-a"]);
    expect(launches.map(({ args }) => args)).toEqual([
      dockerRuntimeInspectArgs({ container: "cinatra-instance-web-a-wayflow-1" }),
      ["stop", "-t", "10", "cinatra-instance-web-a-wayflow-1"],
      dockerRuntimeRemoveArgs({ container: "cinatra-instance-web-a-wayflow-1" }),
    ]);
  });

  it("a container that is not there is said out loud, not an error", async () => {
    const { run, launches, lines } = runner({ inspect: ABSENT });
    await run("stop", ["--instance", "web-a"]);
    expect(launches).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/nothing to stop/i);
  });

  // A flag this verb READS must be a flag this verb HONOURS: a stop has no port
  // and no callback address to use, so naming one is refused rather than
  // validated and dropped on the floor.
  it("refuses a start-only flag rather than reading it and ignoring it", async () => {
    const { run } = runner({ inspect: RUNNING });
    await expect(run("stop", ["--instance", "web-a", "--runtime-port", "3910"])).rejects.toThrow(
      /--runtime-port/,
    );
    await expect(
      run("stop", ["--instance", "web-a", "--app-url", "http://127.0.0.1:3301"]),
    ).rejects.toThrow(/--app-url/);
  });

  it("never reports a removal that did not happen", async () => {
    const { run } = runner({
      inspect: RUNNING,
      up: (args) => (args[0] === "rm" ? { status: 1 } : { status: 0 }),
    });
    await expect(run("stop", ["--instance", "web-a"])).rejects.toThrow(/could not be removed/);
  });
});

// The acceptance item: the band belongs to the clone registry's allocated
// slots. ONE test over BOTH callers of the assertion.
describe("the port band, over both callers of the assertion", () => {
  const OUTSIDE = CLONE_WAYFLOW_PORT_BASE + 700;

  it("a registry row's port outside the band is still refused", () => {
    expect(() =>
      assertCloneSlotPorts({ nextjsPort: CLONE_NEXTJS_PORT_BASE, wayflowPort: OUTSIDE }),
    ).toThrow(/outside band/);
    expect(() => assertPortBandOk(OUTSIDE, "wayflow")).toThrow(/outside band/);
  });

  it("the same port named on the flag is taken as given", () => {
    const plan = resolveInstanceRuntimePlan({
      verb: "start",
      argv: ["--instance", "web-a", "--runtime-port", String(OUTSIDE)],
      env: { PORT: "3300" },
      repoRoot: checkout,
      home,
    });
    expect(plan.runtimePort).toBe(OUTSIDE);
  });

  it("a port that is not a port is refused on either road", () => {
    expect(() => assertPortBandOk("3200", "wayflow")).toThrow(/not a number/);
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--runtime-port", "70000"]),
    ).toThrow(/--runtime-port/);
  });
});

describe("the bridge credential", () => {
  it("never reaches an argument list, the output, or a file this verb creates", async () => {
    const { run, launches, lines } = runner({ inspect: ABSENT });
    await run("start", ["--instance", "web-a", "--runtime-port", "3910"]);

    for (const { args } of launches) {
      expect(args.join(" ")).not.toContain(TOKEN);
    }
    expect(lines.join("\n")).not.toContain(TOKEN);

    const rendered = readFileSync(instanceRuntimeComposePath("web-a", { home }), "utf8");
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).toContain("${CINATRA_BRIDGE_TOKEN}");
  });

  it("travels the way the existing roads pass it — the launch environment only", async () => {
    const { run, launches } = runner({ inspect: ABSENT });
    await run("start", ["--instance", "web-a", "--runtime-port", "3910"]);
    const up = launches.find(({ args }) => args.includes("up"));
    expect(up.env?.[INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY]).toBe(TOKEN);
  });

  it("refuses by KEY, never by value, when the instance's environment carries none", async () => {
    checkout = makeCheckout("PORT=3300\n");
    const { run } = runner({ inspect: ABSENT });
    await expect(run("start", ["--instance", "web-a", "--runtime-port", "3910"])).rejects.toThrow(
      INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY,
    );
  });
});

describe("without --instance the shared service is untouched", () => {
  it("no instance is requested when the flag is absent", () => {
    expect(instanceRuntimeRequested([])).toBe(false);
    expect(instanceRuntimeRequested(["--instance", "web-a"])).toBe(true);
    expect(instanceRuntimeRequested(["--instance=web-a"])).toBe(true);
  });

  it("the default start's compose invocation is byte-for-byte the historical one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cin-260-shared-"));
    made.push(dir);
    const priorRegistry = process.env.CINATRA_INSTANCE_REGISTRY;
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(dir, "no-such-instances.json");
    const launches = [];
    try {
      await runDevWayflow(["start"], {
        isComposeAvailable: () => true,
        getRepoRoot: () => dir,
        ensureWayflowBridgeEnv: () => true,
        spawnSync: (cmd, args) => {
          launches.push([cmd, args]);
          return { status: 0 };
        },
      });
    } finally {
      if (priorRegistry === undefined) delete process.env.CINATRA_INSTANCE_REGISTRY;
      else process.env.CINATRA_INSTANCE_REGISTRY = priorRegistry;
    }
    expect(launches).toHaveLength(1);
    expect(launches[0][0]).toBe("docker");
    expect(launches[0][1]).toEqual(
      composeWayflowArgs("start", {
        project: effectiveComposeProjectName(dir),
        composeFiles: null,
        envFile: null,
      }),
    );
  });

  it("an unknown trailing token is still refused", async () => {
    await expect(runDevWayflow(["start", "oops"])).rejects.toThrow(/Unexpected argument/);
    await expect(
      runDevWayflow(["start", "--instance", "web-a", "oops"]),
    ).rejects.toThrow(/Unexpected argument/);
  });
});
