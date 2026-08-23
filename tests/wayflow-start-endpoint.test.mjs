// cinatra-ai/cinatra-cli#240 — `cinatra instance wayflow start` must PRINT the
// endpoint the instance it just started actually serves on.
//
// The success line interpolated a module constant pinned to `:3010`. That is the
// DEFAULT instance's port, and it is the only instance it is ever right for: an
// isolated install allocates its own band, the generated compose publishes the
// WayFlow runtime on the shifted port, and `.env.local`'s `WAYFLOW_BASE_URL` is
// re-pointed at it (`install.mjs` `writeIsolatedAppEnv`, cinatra-cli#97). The
// cinatra#2654 clean-install matrix observed `:13010` there. So the operator of
// an offset instance was pointed at a dead port — or, with a default stack also
// up, at ANOTHER instance's runtime, which is the worse failure: it answers.
//
// The derivation reads `ports.wayflow[0]` off the instance's recorded row — the
// IDENTICAL expression `writeIsolatedAppEnv`'s `first("wayflow")` resolves — so
// the printed endpoint and the endpoint the app dials come from one source.
//
// Hermetic: the registry is a real one built through `instance-registry.mjs`
// (so the pin is against the shape an install actually writes, envelope unwrap
// included), and nothing here touches Docker, the network or a real checkout.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allocateInstance,
  findInstanceByInstallDir,
  markInstanceReady,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";
import { writeIsolatedComposeFile } from "../src/install-isolation.mjs";
import {
  DEFAULT_WAYFLOW_HOST_PORT,
  findInstanceRowByInstallDir,
  recordedWayflowHostPort,
  reconcileIsolatedWayflowRoute,
  runDevWayflow,
  wayflowEndpointForCheckout,
  wayflowEndpointForRecordedPorts,
} from "../src/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

const SLUG = "x2654-row1";
const INSTALL_DIR = path.join(path.sep, "opt", "cinatra-instances", "row1-dev");
const OTHER_DIR = path.join(path.sep, "opt", "cinatra-instances", "row2-dev");

// The observed isolated band from the cinatra#2654 matrix: app 3300, WayFlow
// 13010. `neo4j` carries two ports so the "first entry wins" rule is exercised
// on a real multi-port service alongside the single-port one being read.
const ISOLATED_PORTS = Object.freeze({
  postgres: [15434],
  redis: [16379],
  neo4j: [17474, 17687],
  wayflow: [13010],
});

// What a DEFAULT install records (install.mjs DEFAULT_DEV_HOST_PORTS): a
// populated band that holds NO wayflow entry, because the service is
// profile-gated and its port is never shifted.
const DEFAULT_PORTS = Object.freeze({
  postgres: [5434],
  redis: [6379],
  neo4j: [7474, 7687],
  verdaccio: [4873],
});

/** A real, structurally valid `ready` registry holding one row for `installDir`. */
function registryWithRow({ installDir = INSTALL_DIR, ports = ISOLATED_PORTS, appPort = 13300 } = {}) {
  const { registry } = allocateInstance({ version: 1, instances: {} }, SLUG, {
    mode: "dev",
    installDir,
    composeProject: "cinatra_x2654_row1",
    composeFiles: ["docker-compose.cinatra-isolated.yml"],
    ports,
    appPort,
    repoUrl: "https://github.com/cinatra-ai/cinatra.git",
    ref: "main",
    sha: "1b820b7c22c18f4b79da89e033fbbceca841db7a",
    infraMode: "new",
  });
  return markInstanceReady(registry, SLUG);
}

// ===========================================================================
// The port read — `ports.wayflow[0]`, the expression the isolated install path
// resolves WAYFLOW_BASE_URL from.
// ===========================================================================
describe("recordedWayflowHostPort", () => {
  it("reads the allocated band's first wayflow host port", () => {
    expect(recordedWayflowHostPort(ISOLATED_PORTS)).toBe(13010);
    expect(recordedWayflowHostPort({ wayflow: [13010, 13011] })).toBe(13010);
  });

  it("accepts the numeric-string form a hand-edited registry can hold", () => {
    expect(recordedWayflowHostPort({ wayflow: ["13010"] })).toBe(13010);
  });

  it("is null for every map that records no usable wayflow port", () => {
    expect(recordedWayflowHostPort(DEFAULT_PORTS)).toBe(null);
    expect(recordedWayflowHostPort({})).toBe(null);
    expect(recordedWayflowHostPort(undefined)).toBe(null);
    expect(recordedWayflowHostPort(null)).toBe(null);
    expect(recordedWayflowHostPort({ wayflow: [] })).toBe(null);
    expect(recordedWayflowHostPort({ wayflow: [0] })).toBe(null);
    expect(recordedWayflowHostPort({ wayflow: [-1] })).toBe(null);
    expect(recordedWayflowHostPort({ wayflow: ["nope"] })).toBe(null);
    expect(recordedWayflowHostPort({ wayflow: 13010 })).toBe(null);
  });
});

// ===========================================================================
// The endpoint the success line states.
// ===========================================================================
describe("wayflowEndpointForRecordedPorts", () => {
  it("an allocated band states ITS port — never the default", () => {
    expect(wayflowEndpointForRecordedPorts(ISOLATED_PORTS)).toBe("http://localhost:13010");
    expect(wayflowEndpointForRecordedPorts(ISOLATED_PORTS)).not.toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
  });

  it("an instance that allocated no band of its own keeps the default port", () => {
    // A default install's band holds no wayflow entry and that instance really
    // does serve the default port — absence here is not evidence of a remap.
    expect(wayflowEndpointForRecordedPorts(DEFAULT_PORTS)).toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
    expect(wayflowEndpointForRecordedPorts({})).toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
    expect(wayflowEndpointForRecordedPorts(undefined)).toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
  });

  it("the default port is the one the compose file publishes", () => {
    expect(DEFAULT_WAYFLOW_HOST_PORT).toBe(3010);
  });
});

// ===========================================================================
// The checkout resolution — through the REAL registry row shape, including the
// `{ slug, slot }` envelope unwrap the finder returns (cinatra-cli#230).
// ===========================================================================
describe("wayflowEndpointForCheckout", () => {
  it("an isolated instance's checkout states the offset endpoint it published", () => {
    const registry = registryWithRow();
    expect(wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => registry })).toBe(
      "http://localhost:13010",
    );
  });

  it("the row is found through the one unwrap — the raw envelope carries no ports", () => {
    // The defect class this guards (cinatra-cli#230): the registry's own finder
    // returns the `{ slug, slot }` ENVELOPE, and `.ports` off that is undefined.
    // A derivation reading the envelope would answer the DEFAULT port for an
    // instance that is demonstrably remapped, and nothing would say so.
    const registry = registryWithRow();
    expect(findInstanceByInstallDir(registry, INSTALL_DIR).ports).toBeUndefined();
    expect(findInstanceRowByInstallDir(registry, INSTALL_DIR).ports).toEqual(ISOLATED_PORTS);
  });

  it("resolves THIS checkout only — a sibling instance's band is never borrowed", () => {
    const registry = registryWithRow();
    expect(wayflowEndpointForCheckout(OTHER_DIR, { readRegistry: () => registry })).toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
  });

  it("a default install's recorded row keeps the default port", () => {
    const registry = registryWithRow({ ports: DEFAULT_PORTS, appPort: 3000 });
    expect(wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => registry })).toBe(
      `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`,
    );
  });

  it("an unmanaged, unreadable or throwing registry degrades to the default port", () => {
    const fallback = `http://localhost:${DEFAULT_WAYFLOW_HOST_PORT}`;
    expect(wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => null })).toBe(fallback);
    expect(wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => "corrupt" })).toBe(fallback);
    expect(
      wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => ({ version: 1, instances: {} }) }),
    ).toBe(fallback);
    expect(
      wayflowEndpointForCheckout(INSTALL_DIR, {
        readRegistry: () => {
          throw new Error("registry is locked");
        },
      }),
    ).toBe(fallback);
  });

  it("never throws a lifecycle command over a malformed row", () => {
    const registry = { version: 1, instances: { [SLUG]: { installDir: INSTALL_DIR, ports: "nope" } } };
    expect(() => wayflowEndpointForCheckout(INSTALL_DIR, { readRegistry: () => registry })).not.toThrow();
  });
});

// ===========================================================================
// STATIC pin — the success line must WIRE the derivation, and the hardcoded
// constant must not come back. A behavioural test on the helper alone would
// still pass if `runDevWayflow` kept printing a literal.
// ===========================================================================
describe("runDevWayflow — the printed endpoint is derived, not hardcoded", () => {
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf("async function runDevWayflow")).split("\n}\n")[0];

  it("interpolates this checkout's derived endpoint into the start line", () => {
    expect(body).toMatch(/WayFlow agent runtime started \(\$\{wayflowEndpointForCheckout\(repoRoot\)\}/);
  });

  it("states no literal default endpoint anywhere in the lifecycle command", () => {
    expect(body).not.toMatch(/localhost:3010/);
    expect(body).not.toMatch(/\b3010\b/);
  });

  it("the hardcoded module constant is gone for good", () => {
    expect(INDEX_SRC).not.toMatch(/\bWAYFLOW_LOCAL_URL\b/);
  });
});

// ===========================================================================
// cinatra#2654 round 6, NB1 — STATIC pin on the route-repair CALL SITE.
//
// `reconcileIsolatedWayflowRoute` has direct behavioural coverage
// (install-flow.test.mjs), but nothing pinned that `runDevWayflow` still CALLS
// it, or where. Its position is the whole contract: AFTER the bridge-token
// provisioning gate (the re-derive must see the file it is about to reference
// or inline) and BEFORE the `up` (a repair that lands after the container
// starts repairs nothing this run). Delete the call, or move it either side of
// those two, and every behavioural test in the suite still passes.
// ===========================================================================
describe("runDevWayflow — the isolated WayFlow route repair is wired, in order", () => {
  const body = INDEX_SRC.slice(INDEX_SRC.indexOf("async function runDevWayflow")).split("\n}\n")[0];

  // cinatra#2654 (round-9 review, NB 2): the call is resolved through the
  // command's `deps` seam now (`deps.reconcileIsolatedWayflowRoute ?? …`), so
  // the CALL itself is spelled `await reconcile({`. That seam is what lets the
  // BEHAVIOURAL test at the bottom of this file drive the same wiring for real;
  // these offsets stay because they still catch a REORDER cheaply.
  const RECONCILE_CALL = "await reconcile({";
  // Both of these are ALSO resolved through the seam now, so the needles name
  // the call rather than the identifier that used to precede it.
  const BRIDGE_ENV_GATE = "ensureWayflowBridgeEnv)(repoRoot)";
  const LAUNCH = '("docker", args';

  const at = (needle) => {
    const i = body.indexOf(needle);
    expect(i, `runDevWayflow no longer contains ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("calls the reconcile at all", () => {
    expect(body).toMatch(/deps\.reconcileIsolatedWayflowRoute \?\? reconcileIsolatedWayflowRoute/);
    expect(body).toMatch(/await reconcile\(\{/);
  });

  it("runs it AFTER the bridge-token provisioning gate and BEFORE the compose `up`", () => {
    // The env file must exist before the re-derive: on a Compose that inlines,
    // what the render inlines IS the wiring.
    expect(at(BRIDGE_ENV_GATE)).toBeLessThan(at(RECONCILE_CALL));
    // …and the repaired file must be the one the `up` reads.
    expect(at(RECONCILE_CALL)).toBeLessThan(at("composeWayflowArgs(verb"));
    expect(at(RECONCILE_CALL)).toBeLessThan(at(LAUNCH));
  });

  // ── round-7 review, NB4 ─────────────────────────────────────────────────
  // The reconcile REPORTS what it re-pointed (`envRepointed` / `repointed`) and
  // nothing in production read it — a return value with no consumer documents a
  // contract nobody has to keep. `.env.local` is the operator's own file, and a
  // command that rewrites keys in it and then starts containers should say so.
  it("CONSUMES the reconcile's result and reports the .env.local re-point (NB4)", () => {
    // The result is bound, not discarded.
    expect(body).toMatch(/const\s+\w+\s*=\s*await reconcile\(\{/);
    const binding = /const\s+(\w+)\s*=\s*await reconcile\(\{/.exec(body)[1];
    // …read for what the writer DID…
    expect(body).toContain(`${binding}?.envRepointed`);
    // …and reported on a line that names what moved.
    const reportAt = body.indexOf(`${binding}?.envRepointed`);
    expect(reportAt).toBeGreaterThan(-1);
    const report = body.slice(reportAt, reportAt + 500);
    expect(report).toMatch(/console\.log\(/);
    expect(report).toMatch(/\.env\.local/);
    expect(report).toContain(`${binding}.repointed`);
    // …before the `up`, so the operator reads it as part of THIS start.
    expect(reportAt).toBeLessThan(at(LAUNCH));
  });

  // ── round-8 review, re-weighting ────────────────────────────────────────
  // The reconcile clears its convergence gate against a SNAPSHOT, and this run
  // then rewrites `.env.local` and the registry row before it hands the file to
  // Compose. That window is time in which the file can change, and `up` binds
  // whatever it says at THAT moment. The install path closes the same gap with
  // `assertIsolatedPortsStillConverge` immediately before its bring-up; this
  // command must too, and the position is the whole point of it.
  it("RE-GATES on the compose file immediately before the `up` (round-8 review)", () => {
    expect(body).toContain("assertIsolatedPortsStillConverge");
    // After the reconcile — it re-reads what the reconcile may have rewritten…
    expect(at(RECONCILE_CALL)).toBeLessThan(at("assertIsolatedPortsStillConverge({"));
    // …and before the `up`, with the argv construction after it, so nothing
    // this command does can invalidate the verdict it launches on.
    expect(at("assertIsolatedPortsStillConverge({")).toBeLessThan(at("composeWayflowArgs(verb"));
    expect(at("assertIsolatedPortsStillConverge({")).toBeLessThan(at(LAUNCH));
    // …and it judges with the offset the RECONCILE speaks, not the row's, which
    // a re-derive this run may already have replaced (round-9 review, NB 4).
    // The reconcile's own side of that parity is pinned behaviourally in
    // install-flow.test.mjs ("the offset a REGENERATION derived …").
    expect(body).toMatch(/offset: Number\.isInteger\(route\.offset\)/);
    expect(body).not.toMatch(/offset: Number\.isInteger\(row\.offset\)/);
  });

  it("runs on the `start` verb ONLY — `stop` never rewrites the recorded compose", () => {
    const call = at(RECONCILE_CALL);
    // Walk back to the nearest enclosing `if (verb === "start") {` and confirm
    // the call is genuinely INSIDE it (brace depth never returns to 0 between
    // the guard and the call), rather than merely preceded by one.
    const guard = body.lastIndexOf('if (verb === "start") {', call);
    expect(guard, "the reconcile call is not guarded by a `start`-verb branch").toBeGreaterThan(-1);
    let depth = 0;
    for (const ch of body.slice(guard + 'if (verb === "start") {'.length, call)) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      expect(depth, "the reconcile call sits OUTSIDE the `start`-verb branch").toBeGreaterThanOrEqual(0);
    }
  });
});

// ===========================================================================
// cinatra#2654 (round-9 review, NB 2) — the last gate before the `up`, pinned by
// BEHAVIOUR rather than by source-text offsets.
//
// The offsets above prove the gate is CALLED between the reconcile and the
// launch. They cannot prove it still REFUSES: the call is guarded on the
// reconcile having returned a map (`route?.ports`), which the `absent`,
// `unparseable` and `not-isolated` arms deliberately do not, so any later change
// that stops an arm returning one disables the gate silently and every one of
// those tests stays green.
//
// So this drives the real command, with the real reconcile, and rewrites the
// compose file inside the window the reconcile opens — a sibling cinatra
// process, an editor writing out a buffer, a regeneration in another checkout.
// `docker compose up` would bind whatever the file says at THAT moment, so the
// launch must refuse. Nothing here touches Docker: the launch itself is the one
// boundary the seam replaces, and the assertion is that it is never reached.
// ===========================================================================
describe("runDevWayflow — the pre-`up` re-gate refuses a compose rewritten inside the window", () => {
  const GATE_SLUG = "x2654-gate";
  const OFFSET = 20000;
  const PG_PORT = 25434;
  const WF_PORT = 3010 + OFFSET;
  let dir;
  let registryPath;
  let priorRegistryEnv;

  const composeDoc = (pgPort) => ({
    name: "cinatra_gate",
    services: {
      postgres: {
        image: "postgres:16",
        ports: [{ published: String(pgPort), target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      },
      // Wired: it carries the bridge-token route, so the reconcile takes its
      // already-wired arm and no regeneration runs.
      wayflow: {
        image: "cinatra-wayflow:local",
        environment: { CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}" },
        ports: [{ published: String(WF_PORT), target: 3010, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
      },
    },
  });

  const isoPath = () => path.join(dir, "docker-compose.cinatra-isolated.yml");

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cin-r9-gate-"));
    writeIsolatedComposeFile(isoPath(), composeDoc(PG_PORT));
    // An `.env.local` that already names what the file publishes, so the
    // reconcile's own re-point has nothing to write and this test is about the
    // gate alone.
    writeFileSync(
      path.join(dir, ".env.local"),
      `PORT=3350\nWAYFLOW_BASE_URL=http://localhost:${WF_PORT}\n`,
      { mode: 0o600 },
    );
    const { registry } = allocateInstance({ version: 1, instances: {} }, GATE_SLUG, {
      mode: "dev",
      installDir: dir,
      composeProject: "cinatra_gate",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      ports: { postgres: [PG_PORT], wayflow: [WF_PORT] },
      appPort: 3350,
      offset: OFFSET,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      sha: "1b820b7c22c18f4b79da89e033fbbceca841db7a",
      infraMode: "new",
    });
    registryPath = path.join(dir, "instances.json");
    writeInstanceRegistry(registryPath, markInstanceReady(registry, GATE_SLUG));
    priorRegistryEnv = process.env.CINATRA_INSTANCE_REGISTRY;
    process.env.CINATRA_INSTANCE_REGISTRY = registryPath;
  });

  afterEach(() => {
    if (priorRegistryEnv === undefined) delete process.env.CINATRA_INSTANCE_REGISTRY;
    else process.env.CINATRA_INSTANCE_REGISTRY = priorRegistryEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The command, with only its outermost boundaries replaced. `mutate` runs
   *  after the REAL reconcile returns — i.e. inside the window. */
  const start = async ({ mutate = () => {} } = {}) => {
    const launches = [];
    await runDevWayflow(["start"], {
      isComposeAvailable: () => true,
      getRepoRoot: () => dir,
      ensureWayflowBridgeEnv: () => true,
      reconcileIsolatedWayflowRoute: async (args) => {
        const route = await reconcileIsolatedWayflowRoute(args);
        mutate();
        return route;
      },
      spawnSync: (cmd, cmdArgs) => {
        launches.push([cmd, cmdArgs]);
        return { status: 0 };
      },
    });
    return launches;
  };

  it("launches when the file the reconcile judged is still the file on disk", async () => {
    const launches = await start();
    // The positive control: without a mutation the gate clears and the `up` runs.
    expect(launches).toHaveLength(1);
    expect(launches[0][0]).toBe("docker");
    expect(launches[0][1]).toContain("up");
  });

  it("REFUSES the launch when the compose is rewritten between the reconcile and the `up`", async () => {
    const launches = [];
    const err = await start({
      mutate: () => writeIsolatedComposeFile(isoPath(), composeDoc(35434)),
    }).then(
      (l) => {
        launches.push(...l);
        return null;
      },
      (e) => e,
    );
    // It refuses, naming the service and both ports…
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(new RegExp(`Refusing to bring up isolated instance "${GATE_SLUG}"`));
    expect(err.message).toContain('"postgres"');
    expect(err.message).toContain(String(PG_PORT));
    expect(err.message).toContain("35434");
    // …and nothing was started: the whole point of gating BEFORE the `up`.
    expect(launches).toEqual([]);
  });
});
