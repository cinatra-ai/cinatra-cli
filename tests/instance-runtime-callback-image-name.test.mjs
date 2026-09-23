// cinatra-ai/cinatra-cli#279 — `cinatra instance wayflow start --instance
// <name>`: the callback address the container is GIVEN, the image it RUNS, and
// the name it CARRIES.
//
// WHAT THESE TESTS PIN
// --------------------
//   * the callback — an `--app-url` the operator names is handed to the
//     container exactly as written (scheme, host and port), and the derived
//     address, which names this machine's loopback, is still dialled through
//     the container's gateway to the host. The two roads are separate and both
//     are pinned, because collapsing them is the bug this issue is about;
//   * the refusals — a scheme the runtime cannot dial and a missing port, as
//     before; and now a port out of range, a credential before the host and a
//     path, a query or a fragment after it, each of which used to be taken and
//     then not used. A refusal never repeats a credential;
//   * the probe — it asks for the address the container was ACTUALLY given,
//     whatever that turned out to be, and the refusal names that address;
//   * the image — an image named with `--image` is the operator's: absent, the
//     start is refused before anything is built, pulled or replaced; present,
//     the rendered document runs it. `--rebuild` builds this checkout's own
//     image again, LABELS it with the checkout's commit and replaces a running
//     container even when it is healthy — after the build, never before it. It
//     is refused beside `--image`;
//   * the name — `--container <name>` is validated the way the engine
//     validates one and rendered as the runtime service's own
//     `container_name`; without it the document is the template's, untouched,
//     and compose's own naming gives the documented derivation. `stop` takes
//     down the container the START RECORDED, and neither verb stops or removes
//     a container under a chosen name that is not this instance's.
//
// Hermetic, in the established style of the per-instance runtime tests: no
// Docker, no network, no real checkout. The runtime directory is redirected
// with `home`, the checkout is a temp dir carrying a compose template with the
// documented placeholders, and every spawn/probe is a fake.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInstanceWayflow } from "../src/index.mjs";
import {
  INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY,
  INSTANCE_RUNTIME_GATEWAY_HOST,
  instanceRuntimeComposePath,
  parseInstanceRuntimeFlags,
  resolveInstanceRuntimePlan,
} from "../src/instance-runtime.mjs";

// The same minimal template the per-instance runtime tests use: the documented
// placeholders, and the gateway callback the checkout's own template writes.
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

// An address of the kind this issue exists for: one the operator put on this
// machine themselves and forwarded the app port to, which the container can
// dial and the container's gateway to the host cannot stand in for.
const RELAY = "http://relay.internal:3301";

// A dotted address from the range reserved for documentation, assembled rather
// than written out.
const DOTTED = [192, 0, 2, 10].join(".");

// The OCI annotation, spelled out rather than imported: it is the name a caller
// reads off a running container's image, so it is a published contract and a
// test that re-derives it from the source proves nothing about it.
const REVISION_LABEL = "org.opencontainers.image.revision";
const HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

const NAMED_IMAGE = "cinatra-wayflow:under-test";
const NAME = "team-a-runtime";
const START = ["--instance", "web-a", "--runtime-port", "3910"];

let home;
let checkout;
const made = [];

function makeCheckout(envBody = `${INSTANCE_RUNTIME_BRIDGE_TOKEN_KEY}=${TOKEN}\nPORT=3300\n`) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cin-279-co-"));
  made.push(dir);
  mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
  writeFileSync(path.join(dir, "docker", "wayflow", "compose.clone.template.yml"), TEMPLATE);
  if (envBody !== null) writeFileSync(path.join(dir, ".env.local"), envBody, { mode: 0o600 });
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "cin-279-home-"));
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

const RUNNING = { status: 0, stdout: "running\n" };
const ABSENT = { status: 1, stdout: "", stderr: "Error: No such object: x" };
const OWN_PROJECT = { status: 0, stdout: "cinatra-instance-web-a\n" };

/**
 * The verb with only its outermost boundaries replaced. `inspect` answers the
 * container-state read, `owner` the read of a container's compose project,
 * `imageInspect` the image-presence read, `exec` the in-container callback
 * probe, and `probe` the host-side runtime health read. The checkout's image
 * step is stubbed unless `realImageStep` asks for it: then it runs through the
 * fake spawn, which is how the argument list of a build is read.
 */
function runner({
  inspect = ABSENT,
  owner = OWN_PROJECT,
  imageInspect = { status: 0, stdout: "[]" },
  exec = { status: 0, stdout: "" },
  probe = { ok: true, status: 200 },
  up = { status: 0 },
  realImageStep = false,
  head = HEAD,
} = {}) {
  const launches = [];
  const lines = [];
  const run = (verb, argv, overrides = {}) =>
    runInstanceWayflow(verb, argv, {
      home,
      getRepoRoot: () => checkout,
      isComposeAvailable: () => true,
      ...(realImageStep ? { readCheckoutHeadSha: () => head } : { ensureWayflowImage: () => {} }),
      log: (line) => lines.push(String(line)),
      probeHttp: async (url) => (typeof probe === "function" ? probe(url) : probe),
      spawnSync: (cmd, args, opts) => {
        launches.push({ cmd, args, env: opts?.env ?? null });
        const answer = (fixture) => (typeof fixture === "function" ? fixture(args) : fixture);
        if (args[0] === "inspect") {
          return args.join(" ").includes("com.docker.compose.project")
            ? answer(owner)
            : answer(inspect);
        }
        if (args[0] === "image") return answer(imageInspect);
        if (args[0] === "exec") return answer(exec);
        return answer(up);
      },
      ...overrides,
    });
  return { run, launches, lines };
}

const composeOf = (slug) => readFileSync(instanceRuntimeComposePath(slug, { home }), "utf8");
const addressed = (launches) => launches.map(({ args }) => args.join(" "));
const planFor = (flags, env = {}) =>
  resolveInstanceRuntimePlan({
    verb: "start",
    argv: [...START, ...flags],
    env,
    repoRoot: checkout,
    home,
  });

/** The complete document a start of `web-a` on runtime port 3910 writes, whose
 *  runtime service carries `service` — every line under `wayflow:`. */
function documentWith(service) {
  const stateDir = path.dirname(instanceRuntimeComposePath("web-a", { home }));
  return [
    "services:",
    "  wayflow:",
    ...service,
    "  tailscale:",
    '    hostname: "cinatra-instance-web-a"',
    '    network_mode: "bridge"',
    "    volumes:",
    `      - "${stateDir}/tailscale-state:/var/lib/tailscale"`,
    "",
  ].join("\n");
}

/** The runtime service's lines as the template renders them, calling the app
 *  back at `callback`, with the template's own image line unless another. */
function serviceAsRendered(callback, { image = "    image: cinatra-wayflow:local" } = {}) {
  return [
    image,
    "    ports:",
    '      - "3910:3010"',
    "    environment:",
    `      CINATRA_BASE_URL: "${callback}"`,
    '      CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}"',
    '      WAYFLOW_BASE_URL: "http://localhost:3910"',
    "    volumes:",
    `      - "${checkout}/extensions:/agents:ro"`,
  ];
}

/** The message of a refusal, or "" when there was none. */
function refusalOf(fn) {
  try {
    fn();
  } catch (err) {
    return String(err?.message ?? "");
  }
  return "";
}

// ---------------------------------------------------------------------------

describe("the callback address the container is given", () => {
  // THE POINT OF THE ISSUE. An operator whose app is bound to this machine's
  // loopback, on an engine running containers without root, puts a relay
  // address on that interface and forwards the app port to it. That address is
  // the one thing the container CAN dial — so it is handed over as written,
  // and the rest of the document is exactly what the template renders.
  it("keeps an address the operator named, verbatim, as the callback the container is given", async () => {
    const plan = planFor(["--app-url", RELAY]);
    expect(plan.appUrl).toBe(RELAY);
    expect(plan.callbackUrl).toBe(RELAY);
    expect(plan.appPort).toBe(3301);

    await runner().run("start", [...START, "--app-url", RELAY]);
    expect(composeOf("web-a")).toBe(documentWith(serviceAsRendered(RELAY)));
  });

  // THE OTHER ROAD, UNCHANGED. Nobody named an address, so it comes from the
  // instance's own environment — which publishes the app under this machine's
  // loopback, and inside a container that means the container. The gateway
  // rewrite is the right default exactly here, and only here; and a start that
  // names nothing writes the template's document untouched.
  it("still dials the container's gateway to the host when nobody named one", async () => {
    expect(planFor([], { PORT: "3305" }).callbackUrl).toBe(
      `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3305`,
    );
    expect(planFor([], { NEXT_PUBLIC_APP_URL: "http://localhost:3306" }).callbackUrl).toBe(
      `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3306`,
    );

    await runner().run("start", START);
    expect(composeOf("web-a")).toBe(
      documentWith(serviceAsRendered(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3300`)),
    );
  });

  // The HOST is the operator's to name — this machine's loopback included,
  // which a NAMED address keeps: only the derived one is rewritten.
  it("takes any host the operator names, loopback included, and rewrites none of them", () => {
    for (const url of [
      `http://${DOTTED}:3301`,
      RELAY,
      "http://localhost:3301",
      `http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3301`,
    ]) {
      expect(planFor(["--app-url", url]).callbackUrl).toBe(url);
    }
  });

  it("honours the scheme the operator named, and a port spelled out on its scheme's default", () => {
    expect(planFor(["--app-url", "https://relay.internal:3301"]).callbackUrl).toBe(
      "https://relay.internal:3301",
    );
    // A scheme's OWN default port is a port the operator named, and the
    // rendered document carries that number — so it must not read as no port.
    const onDefault = planFor(["--app-url", "https://relay.internal:443"]);
    expect(onDefault.callbackUrl).toBe("https://relay.internal:443");
    expect(onDefault.appPort).toBe(443);
  });

  // Kept: the runtime has an http client and no other, so a scheme it cannot
  // dial would be accepted here and then not used.
  it("refuses a scheme the runtime has no client for", () => {
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", "ftp://relay.internal:3301"]),
    ).toThrow(/--app-url/);
  });

  it("refuses an address that names no port, or a port out of range", () => {
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", "http://localhost"]),
    ).toThrow(/port/);
    expect(() =>
      parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", "http://localhost:0"]),
    ).toThrow(/between 1 and 65535/);
  });

  // The address is handed over as an ORIGIN the runtime appends its own paths
  // to, so anything after the authority would be taken and then not used.
  it("refuses a path, a query or a fragment instead of dropping it", () => {
    for (const url of [
      "http://localhost:3301/app",
      "http://localhost:3301/?tenant=a",
      "http://localhost:3301/#top",
    ]) {
      expect(() => parseInstanceRuntimeFlags(["--instance", "web-a", "--app-url", url])).toThrow(
        /ORIGIN/,
      );
    }
  });

  // The same for anything BEFORE the host: a credential would be taken and
  // then not used, and the address is written into a document and named in
  // refusals, where a password does not belong.
  it("refuses a user name or a password instead of dropping it, and never repeats them", () => {
    const secret = "s3cr3t-in-the-url";
    const message = refusalOf(() =>
      parseInstanceRuntimeFlags([
        "--instance",
        "web-a",
        "--app-url",
        `http://operator:${secret}@localhost:3301`,
      ]),
    );
    expect(message).toMatch(/user name or a password/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain("operator");
  });

  // The probe proves THE ADDRESS THE CONTAINER WAS GIVEN, whatever it is —
  // otherwise a start would report a runtime healthy on the strength of an
  // address it is not using.
  it("probes the address the container was actually given, and names it when it fails", async () => {
    const { run, launches } = runner({ exec: { status: 1, stdout: "" } });
    await expect(run("start", [...START, "--app-url", RELAY])).rejects.toThrow(
      `cannot reach this instance's app at ${RELAY}`,
    );
    const probeCall = launches.find(({ args }) => args[0] === "exec");
    expect(probeCall?.args.join(" ")).toContain(`${RELAY}/api/health`);
    expect(probeCall?.args.join(" ")).not.toContain(INSTANCE_RUNTIME_GATEWAY_HOST);
  });

  // The runtime service is found by its own key at a service's indentation —
  // never a `wayflow:` nested in another service, never a comment — and the
  // named address replaces the template's callback there alone, on its full
  // port: the callback on 3301 is not the front of an address on 33010.
  it("puts the named address in place of the template's callback on the runtime service alone", async () => {
    writeFileSync(
      path.join(checkout, "docker", "wayflow", "compose.clone.template.yml"),
      [
        "services:",
        "  tailscale:",
        "    depends_on:",
        "      wayflow:",
        "        condition: service_started",
        "    environment:",
        '      UPSTREAM: "http://host.docker.internal:@@NEXTJS_PORT@@"',
        "# the runtime service follows",
        "  wayflow:",
        "    # comments decide nothing",
        "    image: cinatra-wayflow:local",
        "    ports:",
        '      - "@@WAYFLOW_PORT@@:3010"',
        "    environment:",
        '      CINATRA_BASE_URL: "http://host.docker.internal:@@NEXTJS_PORT@@"',
        '      NEIGHBOUR_URL: "http://host.docker.internal:@@NEXTJS_PORT@@0"',
        "",
      ].join("\n"),
    );
    await runner().run("start", [...START, "--app-url", RELAY, "--container", NAME]);
    expect(composeOf("web-a")).toBe(
      [
        "services:",
        "  tailscale:",
        "    depends_on:",
        "      wayflow:",
        "        condition: service_started",
        "    environment:",
        '      UPSTREAM: "http://host.docker.internal:3301"',
        "# the runtime service follows",
        "  wayflow:",
        `    container_name: "${NAME}"`,
        "    # comments decide nothing",
        "    image: cinatra-wayflow:local",
        "    ports:",
        '      - "3910:3010"',
        "    environment:",
        `      CINATRA_BASE_URL: "${RELAY}"`,
        '      NEIGHBOUR_URL: "http://host.docker.internal:33010"',
        "",
      ].join("\n"),
    );

    const { run, launches } = runner({ inspect: RUNNING });
    await run("stop", ["--instance", "web-a"]);
    expect(addressed(launches)).toContain(`rm -f ${NAME}`);
  });

  // A template that does not dial the gateway callback cannot be given the
  // named address — said before any container is touched, not at the probe.
  it("refuses a named address a template gives no place to, before anything is touched", async () => {
    writeFileSync(
      path.join(checkout, "docker", "wayflow", "compose.clone.template.yml"),
      TEMPLATE.replace("http://host.docker.internal:@@NEXTJS_PORT@@", "@@NEXTJS_PORT@@"),
    );
    const { run, launches } = runner({ inspect: RUNNING });
    await expect(run("start", [...START, "--app-url", RELAY])).rejects.toThrow(
      /could not be put in its place/,
    );
    expect(launches.map(({ args }) => args[0])).toEqual([]);
  });
});

describe("the image the container runs", () => {
  // An image the operator NAMED is theirs. Building or pulling something under
  // somebody else's tag is not this command's to do, so an absent one is a
  // refusal — and one that leaves the container it found as it found it.
  it("refuses a named image that is absent before anything is built, pulled or replaced", async () => {
    await runner().run("start", START);
    const { run, launches } = runner({
      inspect: RUNNING,
      imageInspect: ABSENT,
      realImageStep: true,
    });
    await expect(run("start", [...START, "--image", NAMED_IMAGE])).rejects.toThrow(
      `there is no image named ${NAMED_IMAGE}`,
    );
    expect(addressed(launches)).toContain(`image inspect ${NAMED_IMAGE}`);
    for (const verb of ["build", "pull", "stop", "rm", "compose"]) {
      expect(launches.some(({ args }) => args[0] === verb)).toBe(false);
    }
  });

  it("runs a named image that is there, and builds nothing", async () => {
    const { run, launches } = runner({ realImageStep: true });
    await run("start", [...START, "--image", NAMED_IMAGE]);
    expect(composeOf("web-a")).toBe(
      documentWith(
        serviceAsRendered(`http://${INSTANCE_RUNTIME_GATEWAY_HOST}:3300`, {
          image: `    image: "${NAMED_IMAGE}"`,
        }),
      ),
    );
    expect(addressed(launches)).toContain(`image inspect ${NAMED_IMAGE}`);
    expect(launches.some(({ args }) => args[0] === "build")).toBe(false);
  });

  // The reference reaches a docker argument list and a compose document, where
  // a leading dash reads as a flag, a `$` as a variable and a quote or a space
  // as the end of the value.
  it("refuses an image reference the engine or compose would read as something else", () => {
    for (const bad of ["-x", "with space", "a$b", 'a"b', ""]) {
      expect(() =>
        parseInstanceRuntimeFlags(["--instance", "web-a", "--image", bad]),
      ).toThrow(/Invalid --image/);
    }
  });

  // A stable tag says nothing about the commit under it, so the build LABELS
  // the image with the checkout's own HEAD. That label is what lets a caller
  // read a running container's image and know which commit it carries.
  it("builds this checkout's image again for --rebuild, labelled with its commit", async () => {
    const { run, launches } = runner({ realImageStep: true });
    await run("start", [...START, "--rebuild"]);
    expect(launches.find(({ args }) => args[0] === "build")?.args).toEqual([
      "build",
      "-t",
      "cinatra-wayflow:local",
      "--label",
      `${REVISION_LABEL}=${HEAD}`,
      path.join(checkout, "docker", "wayflow"),
    ]);
  });

  // A container that is up, answering and launched from the current document
  // is still running the OLD image, so `--rebuild` never reports "nothing to
  // do" — and it replaces the container only once the new image exists, so a
  // build that fails leaves the running one where it was.
  it("--rebuild replaces a running, current container, after the build and never before it", async () => {
    await runner().run("start", START);
    const { run, launches, lines } = runner({ inspect: RUNNING, realImageStep: true });
    await run("start", [...START, "--rebuild"]);
    expect(lines.join("\n")).not.toMatch(/nothing to do/i);
    const order = launches.map(({ args }) => args[0]);
    const built = order.indexOf("build");
    expect(built).toBeGreaterThan(-1);
    expect(order.indexOf("rm")).toBeGreaterThan(built);
    expect(order.indexOf("compose")).toBeGreaterThan(order.indexOf("rm"));
  });

  it("labels no commit where there is none to name", async () => {
    const { run, launches } = runner({ realImageStep: true, head: null });
    await run("start", [...START, "--rebuild"]);
    expect(launches.find(({ args }) => args[0] === "build")?.args).toEqual([
      "build",
      "-t",
      "cinatra-wayflow:local",
      path.join(checkout, "docker", "wayflow"),
    ]);
  });

  it("builds nothing without --rebuild when the checkout's image is there", async () => {
    const { run, launches } = runner({ realImageStep: true });
    await run("start", START);
    expect(addressed(launches)).toContain("image inspect cinatra-wayflow:local");
    expect(launches.some(({ args }) => args[0] === "build")).toBe(false);
  });

  // They name two different images to RUN — the checkout's own, freshly built,
  // and one the operator already has — so neither silently wins.
  it("refuses --rebuild beside --image, naming both", () => {
    const message = refusalOf(() =>
      parseInstanceRuntimeFlags([...START, "--rebuild", "--image", NAMED_IMAGE]),
    );
    expect(message).toMatch(/cannot be used together/);
    expect(message).toContain("--rebuild");
    expect(message).toContain(`--image ${NAMED_IMAGE}`);
  });
});

describe("the container's name", () => {
  it("renders a name the operator gave as the runtime service's own container_name", async () => {
    const { run, launches } = runner();
    await run("start", [
      ...START,
      "--app-url",
      RELAY,
      "--image",
      NAMED_IMAGE,
      "--container",
      NAME,
    ]);
    expect(composeOf("web-a")).toBe(
      documentWith([
        `    container_name: "${NAME}"`,
        ...serviceAsRendered(RELAY, { image: `    image: "${NAMED_IMAGE}"` }),
      ]),
    );
    expect(addressed(launches)).toContain(`inspect --format {{.State.Status}} ${NAME}`);
    expect(launches.find(({ args }) => args[0] === "exec")?.args.slice(0, 2)).toEqual([
      "exec",
      NAME,
    ]);
  });

  // The documented derivation, left to compose: a document that names no
  // container gets `<project>-<service>-1` from compose itself.
  it("leaves the name to compose when none was given: cinatra-instance-<name>-wayflow-1", async () => {
    const { run, launches, lines } = runner();
    await run("start", START);
    expect(composeOf("web-a")).not.toContain("container_name");
    expect(launches.find(({ args }) => args.includes("up"))?.args.slice(0, 3)).toEqual([
      "compose",
      "-p",
      "cinatra-instance-web-a",
    ]);
    expect(lines.join("\n")).toContain(
      "container: cinatra-instance-web-a-wayflow-1 (compose project cinatra-instance-web-a)",
    );
  });

  it("refuses a name the engine itself would refuse", () => {
    for (const bad of ["_leading", "-leading", "has space", "a".repeat(64), ""]) {
      expect(() =>
        parseInstanceRuntimeFlags(["--instance", "web-a", "--container", bad]),
      ).toThrow(/Invalid --container/);
    }
    expect(
      parseInstanceRuntimeFlags(["--instance", "web-a", "--container", "a".repeat(63)]).container,
    ).toBe("a".repeat(63));
  });

  // Without the record a `stop` would re-derive a name the start never used,
  // remove nothing, and report that there was nothing to remove.
  it("stop takes down the container the start recorded, not a re-derived one", async () => {
    await runner().run("start", [...START, "--container", NAME]);

    const { run, launches } = runner({ inspect: RUNNING });
    await run("stop", ["--instance", "web-a"]);
    expect(addressed(launches)).toEqual([
      `inspect --format {{.State.Status}} ${NAME}`,
      `inspect --format {{index .Config.Labels "com.docker.compose.project"}} ${NAME}`,
      `stop -t 10 ${NAME}`,
      `rm -f ${NAME}`,
    ]);
  });

  it("stop falls back to the derivation when no start recorded a name", async () => {
    const { run, launches } = runner({ inspect: RUNNING });
    await run("stop", ["--instance", "web-b"]);
    expect(addressed(launches)).toEqual([
      "inspect --format {{.State.Status}} cinatra-instance-web-b-wayflow-1",
      "stop -t 10 cinatra-instance-web-b-wayflow-1",
      "rm -f cinatra-instance-web-b-wayflow-1",
    ]);
  });

  // A chosen name can belong to anything on this machine. A container found
  // under it is stopped or removed only when its own labels say it is this
  // instance's runtime; otherwise both verbs refuse and touch nothing.
  it("neither verb stops or removes a container under a chosen name that is not this instance's", async () => {
    await runner().run("start", [...START, "--container", NAME]);
    const foreign = { status: 0, stdout: "some-other-project\n" };

    const starting = runner({ inspect: RUNNING, owner: foreign, realImageStep: true });
    await expect(starting.run("start", [...START, "--container", NAME])).rejects.toThrow(
      `the container named ${NAME} on this machine is not this instance's agent runtime`,
    );
    const stopping = runner({ inspect: RUNNING, owner: foreign });
    await expect(stopping.run("stop", ["--instance", "web-a"])).rejects.toThrow(
      /neither stopped nor removed it/,
    );
    for (const { launches } of [starting, stopping]) {
      for (const verb of ["stop", "rm", "compose", "build"]) {
        expect(launches.some(({ args }) => args[0] === verb)).toBe(false);
      }
    }
  });

  // A flag this verb READS must be a flag this verb HONOURS: a stop removes the
  // container its start recorded, so these would be read and then ignored.
  it("stop refuses the start's image and name flags rather than reading and ignoring them", async () => {
    const { run } = runner({ inspect: RUNNING });
    for (const flags of [["--image", NAMED_IMAGE], ["--container", NAME], ["--rebuild"]]) {
      await expect(run("stop", ["--instance", "web-a", ...flags])).rejects.toThrow(
        /takes no .*--image.*--container.*--rebuild/,
      );
    }
  });
});
