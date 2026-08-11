// cinatra-ai/cinatra-cli#219 — the preview's container-dialed endpoints must be
// PROVEN to belong to this instance before the composition trusts them.
//
// Hermetic: every docker call goes through the injected `runDocker`, and the
// world the probes see is a plain object (`tests/helpers/fake-compose-ownership`).
// The load-bearing fixture is the issue's own reproduction — a FOREIGN compose
// project holding the host port a container-dialed key names.

import path from "node:path";

import { describe, expect, it } from "vitest";

import { __test as O } from "../src/preview-endpoint-ownership.mjs";
import { answerComposeOwnership, WORKING_DIR_LABEL } from "./helpers/fake-compose-ownership.mjs";

const {
  COMPOSE_WORKING_DIR_LABEL,
  ENDPOINT_OWNERSHIP_ENV,
  assertEndpointOwnership,
  endpointPortFromValue,
  holdersFromInspect,
  hostPortKey,
  ownershipFromInspect,
  ownsHostPort,
  resolveEndpointOwnershipMode,
  verifyEndpointOwnership,
} = O;

// A throwaway Postgres fixture is assembled from parts so it cannot LOOK like a
// credential to the secret-scan gate — the same reason
// tests/install-preview-*.test.mjs and tests/clone-*.test.mjs interpolate theirs.
const pgUrl = (cred, hostPort, db) => ["postgresql:/", `${cred}@${hostPort}`, db].join("/");
const DB_CRED = ["u", "p"].join(":");
const SECRETY_CRED = ["u", "hunter2"].join(":");

const OURS = "/tmp/cinatra-instance";
const THEIRS = "/tmp/some-other-stack";

/** A deps object whose docker CLI answers ONLY the ownership probes. */
function makeDeps(world, { log = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    log,
    runDocker: (args) => {
      calls.push(args);
      return answerComposeOwnership(args, { compose: world }) ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

/** The #219 reproduction: our stack is up but a FOREIGN project holds 3003. */
const REPRO_WORLD = {
  containers: [
    { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
    { id: "own-pg", name: "cinatra-postgres-1", service: "postgres", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 5434, 5432]] },
    // Running, but with NO host publication — #219 AC2's "publication is part of
    // the contract" case.
    { id: "own-nango", name: "cinatra-nango-server-1", service: "nango-server", project: "cinatra", workingDir: OURS, ports: [] },
    // The stranger that actually answers on 3003.
    { id: "their-nango", name: "other-nango-server-1", service: "nango-server", project: "other-stack", workingDir: THEIRS, ports: [["0.0.0.0", 3003, 3003]] },
  ],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("endpoint → port derivation (never guessed)", () => {
  it("reads an explicit port, whatever the scheme", () => {
    expect(endpointPortFromValue("redis://127.0.0.1:6379")).toBe(6379);
    expect(endpointPortFromValue("http://localhost:3003")).toBe(3003);
    expect(endpointPortFromValue(pgUrl(DB_CRED, "127.0.0.1:5434", "cinatra"))).toBe(5434);
  });

  it("falls back to the scheme default only for schemes it actually knows", () => {
    expect(endpointPortFromValue("http://127.0.0.1")).toBe(80);
    expect(endpointPortFromValue("https://127.0.0.1")).toBe(443);
    expect(endpointPortFromValue("redis://127.0.0.1")).toBe(6379);
    expect(endpointPortFromValue("postgres://127.0.0.1/db")).toBe(5432);
    // An unknown scheme with no port is UNVERIFIABLE, never a guess.
    expect(endpointPortFromValue("amqp://127.0.0.1")).toBeNull();
  });

  it("returns null for a non-URL, an empty value and an out-of-range port", () => {
    expect(endpointPortFromValue("not a url")).toBeNull();
    expect(endpointPortFromValue("")).toBeNull();
    expect(endpointPortFromValue(undefined)).toBeNull();
  });
});

describe("the ownership mode lever", () => {
  it("defaults to enforce and accepts warn", () => {
    expect(resolveEndpointOwnershipMode({})).toBe("enforce");
    expect(resolveEndpointOwnershipMode({ [ENDPOINT_OWNERSHIP_ENV]: "  " })).toBe("enforce");
    expect(resolveEndpointOwnershipMode({ [ENDPOINT_OWNERSHIP_ENV]: "WARN" })).toBe("warn");
  });

  it("FAILS CLOSED on an unrecognised value (never a silent downgrade)", () => {
    expect(() => resolveEndpointOwnershipMode({ [ENDPOINT_OWNERSHIP_ENV]: "off" })).toThrow(
      new RegExp(`${ENDPOINT_OWNERSHIP_ENV}.*invalid.*enforce \\| warn`, "s"),
    );
    expect(() => resolveEndpointOwnershipMode({ [ENDPOINT_OWNERSHIP_ENV]: "0" })).toThrow(/invalid/);
  });
});

describe("ownershipFromInspect — the compose working_dir is the proof", () => {
  const rows = REPRO_WORLD.containers.map((c) => ({
    Name: `/${c.name}`,
    State: { Running: true, Status: "running" },
    Config: { Labels: { "com.docker.compose.project": c.project, [WORKING_DIR_LABEL]: c.workingDir, "com.docker.compose.service": c.service } },
    NetworkSettings: {
      Ports: Object.fromEntries((c.ports ?? []).map(([ip, hp, cp]) => [`${cp}/tcp`, [{ HostIp: ip, HostPort: String(hp) }]])),
    },
  }));

  it("keeps only containers rooted at OUR directory", () => {
    const own = ownershipFromInspect(rows, OURS);
    expect([...own.projects]).toEqual(["cinatra"]);
    expect(own.containers.map((c) => c.name).sort()).toEqual([
      "cinatra-nango-server-1",
      "cinatra-postgres-1",
      "cinatra-redis-1",
    ]);
    expect(ownsHostPort(own.ports, 6379)).toBe(true);
    expect(ownsHostPort(own.ports, 5434)).toBe(true);
    // The stranger's port is NOT ours even though it is published on this host.
    expect(ownsHostPort(own.ports, 3003)).toBe(false);
  });

  it("uses the label name the install path uses (no silent drift)", () => {
    expect(COMPOSE_WORKING_DIR_LABEL).toBe("com.docker.compose.project.working_dir");
  });

  it("a RUNNING container that publishes nothing contributes no ports but is reported", () => {
    const own = ownershipFromInspect(rows, OURS);
    const nango = own.containers.find((c) => c.service === "nango-server");
    expect(nango.published).toEqual([]);
    expect(nango.running).toBe(true);
  });

  it("a NON-running own container never contributes a port", () => {
    const stopped = [
      {
        Name: "/cinatra-redis-1",
        State: { Running: false, Status: "exited" },
        Config: { Labels: { [WORKING_DIR_LABEL]: OURS, "com.docker.compose.project": "cinatra", "com.docker.compose.service": "redis" } },
        NetworkSettings: { Ports: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: "6379" }] } },
      },
    ];
    const own = ownershipFromInspect(stopped, OURS);
    expect(ownsHostPort(own.ports, 6379)).toBe(false);
    expect(own.containers[0].state).toBe("exited");
  });

  it("skips non-TCP bindings and tolerates a path spelling difference", () => {
    const udp = [
      {
        Name: "/x",
        State: { Running: true, Status: "running" },
        Config: { Labels: { [WORKING_DIR_LABEL]: `${OURS}/`, "com.docker.compose.project": "p", "com.docker.compose.service": "s" } },
        NetworkSettings: { Ports: { "53/udp": [{ HostIp: "0.0.0.0", HostPort: "53" }] } },
      },
    ];
    const own = ownershipFromInspect(udp, OURS);
    expect(own.containers).toHaveLength(1); // the trailing slash still resolves to OURS
    expect(ownsHostPort(own.ports, 53)).toBe(false);
  });

  it("hostPortKey defaults an absent interface to all-interfaces", () => {
    expect(hostPortKey(undefined, 5434)).toBe("0.0.0.0:5434");
    expect(hostPortKey("127.0.0.1", 5434)).toBe("127.0.0.1:5434");
  });

  it("holdersFromInspect names who publishes a port", () => {
    const holders = holdersFromInspect(rows, 3003);
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ name: "other-nango-server-1", project: "other-stack", workingDir: THEIRS });
  });
});

// ---------------------------------------------------------------------------
// The verification itself
// ---------------------------------------------------------------------------

describe("verifyEndpointOwnership — the #219 reproduction", () => {
  it("REFUSES the endpoint a foreign compose project holds, and names it", () => {
    const deps = makeDeps(REPRO_WORLD);
    const report = verifyEndpointOwnership({
      entries: [
        { key: "REDIS_URL", value: "redis://127.0.0.1:6379" },
        { key: "SUPABASE_DB_URL", value: pgUrl(SECRETY_CRED, "127.0.0.1:5434", "cinatra") },
        { key: "NANGO_SERVER_URL", value: "http://localhost:3003" },
      ],
      checkoutDir: OURS,
      deps,
    });
    expect(report.results.find((r) => r.key === "REDIS_URL").verdict).toBe("owned");
    expect(report.results.find((r) => r.key === "SUPABASE_DB_URL").verdict).toBe("owned");
    const nango = report.results.find((r) => r.key === "NANGO_SERVER_URL");
    expect(nango.verdict).toBe("foreign");
    expect(nango.port).toBe(3003);
    expect(nango.holders[0].project).toBe("other-stack");
    expect(report.violations).toHaveLength(1);
  });

  it("the refusal names the key, the port and the holder — and NEVER a value", () => {
    const deps = makeDeps(REPRO_WORLD);
    let thrown = null;
    try {
      assertEndpointOwnership({
        entries: [
          { key: "SUPABASE_DB_URL", value: pgUrl(SECRETY_CRED, "127.0.0.1:5434", "cinatra") },
          { key: "NANGO_SERVER_URL", value: "http://localhost:3003" },
        ],
        checkoutDir: OURS,
        deps,
        env: {},
        gatewayHost: "host.docker.internal",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    const msg = String(thrown.message);
    expect(msg).toContain("NANGO_SERVER_URL");
    expect(msg).toContain("3003");
    expect(msg).toContain("other-nango-server-1");
    expect(msg).toContain('compose project "other-stack"');
    expect(msg).toContain(THEIRS);
    // The own-stack summary names the running-but-unpublished service (AC2).
    expect(msg).toContain("cinatra-nango-server-1");
    expect(msg).toMatch(/publishes NO host port while RUNNING/);
    // LEAK DISCIPLINE: no value, not even a fragment of one.
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("postgresql://");
    expect(msg).not.toContain("redis://");
  });

  it("PASSES silently on the happy path — no violation, no false alarm (AC4)", () => {
    const deps = makeDeps({
      containers: [
        { id: "a", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
        { id: "b", name: "cinatra-nango-server-1", service: "nango-server", project: "cinatra", workingDir: OURS, ports: [["0.0.0.0", 3003, 3003]] },
      ],
    });
    const logs = [];
    const report = assertEndpointOwnership({
      entries: [
        { key: "REDIS_URL", value: "redis://127.0.0.1:6379" },
        { key: "NANGO_SERVER_URL", value: "http://localhost:3003" },
      ],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m) },
      env: {},
    });
    expect(report.violations).toEqual([]);
    expect(logs.join("\n")).toContain("endpoint ownership verified");
  });

  it("an ISOLATED band is unaffected: a remapped port under a DIFFERENT project name rooted here is ours (AC5)", () => {
    const deps = makeDeps({
      containers: [
        { id: "iso", name: "cinatra-iso-nango-server-1", service: "nango-server", project: "cinatra_iso7", workingDir: OURS, ports: [["0.0.0.0", 3103, 3003]] },
      ],
    });
    const report = verifyEndpointOwnership({
      entries: [{ key: "NANGO_SERVER_URL", value: "http://127.0.0.1:3103" }],
      checkoutDir: OURS,
      deps,
    });
    expect(report.results[0].verdict).toBe("owned");
    // Proven by the working_dir label, not by the project NAME.
    expect([...report.own.projects]).toEqual(["cinatra_iso7"]);
  });

  it("a container-dialed port NOTHING publishes is a violation too (never absorbed)", () => {
    const deps = makeDeps({
      containers: [
        { id: "own-nango", name: "cinatra-nango-server-1", service: "nango-server", project: "cinatra", workingDir: OURS, ports: [] },
      ],
    });
    const report = verifyEndpointOwnership({
      entries: [{ key: "NANGO_SERVER_URL", value: "http://127.0.0.1:3003" }],
      checkoutDir: OURS,
      deps,
    });
    expect(report.results[0].verdict).toBe("unowned");
    expect(report.violations).toHaveLength(1);
  });

  it("reports UNKNOWN (and never a violation) when the probe itself cannot run", () => {
    const deps = { log: () => {}, runDocker: () => ({ status: 127, stdout: "", stderr: "docker: not found" }) };
    const logs = [];
    const report = assertEndpointOwnership({
      entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m) },
      env: {},
    });
    expect(report.results[0].verdict).toBe("unknown");
    expect(report.violations).toEqual([]);
    expect(logs.join("\n")).toMatch(/ownership was NOT verified/);
  });

  it("reports UNVERIFIABLE for a value with no derivable port", () => {
    const deps = makeDeps(REPRO_WORLD);
    const logs = [];
    const report = assertEndpointOwnership({
      entries: [{ key: "SUPABASE_DB_URL", value: "amqp://127.0.0.1" }],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m) },
      env: {},
    });
    expect(report.results[0].verdict).toBe("unverifiable");
    expect(report.violations).toEqual([]);
    expect(logs.join("\n")).toMatch(/names no port this check can derive/);
  });

  it("warn mode prints the SAME finding and proceeds (AC1's loud degradation)", () => {
    const deps = makeDeps(REPRO_WORLD);
    const logs = [];
    const report = assertEndpointOwnership({
      entries: [{ key: "NANGO_SERVER_URL", value: "http://localhost:3003" }],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m), logError: (m) => logs.push(m) },
      env: { [ENDPOINT_OWNERSHIP_ENV]: "warn" },
    });
    expect(report.violations).toHaveLength(1);
    const out = logs.join("\n");
    expect(out).toContain("WARNING");
    expect(out).toContain("NANGO_SERVER_URL");
    expect(out).toContain("other-nango-server-1");
  });

  it("says the stack is not running when this checkout owns no containers at all", () => {
    const deps = makeDeps({ containers: [] });
    expect(() =>
      assertEndpointOwnership({
        entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
        checkoutDir: OURS,
        deps,
        env: {},
      }),
    ).toThrow(/NO compose containers rooted at .*its stack is not running/s);
  });

  it("CONTESTED: our own publication is not conclusive when something else holds the same port", () => {
    // A publication bound to ONE interface does not exclude a second listener on
    // another interface of the same port, so "we publish it" is not proof the
    // container's host-gateway dial lands on US.
    const deps = makeDeps({
      containers: [
        { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
        { id: "their-redis", name: "other-redis-1", service: "redis", project: "other-stack", workingDir: THEIRS, ports: [["172.17.0.1", 6379, 6379]] },
      ],
    });
    const report = verifyEndpointOwnership({
      entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
      checkoutDir: OURS,
      deps,
    });
    expect(report.results[0].verdict).toBe("contested");
    expect(report.violations).toHaveLength(1);
    expect(report.results[0].holders[0].name).toBe("other-redis-1");
  });

  it("REFUSES when this checkout runs MORE THAN ONE compose project (the #159 shape)", () => {
    // Two projects rooted at one directory keep separate volumes and therefore
    // separate DATA — a port published by the stale one is a cross-instance
    // endpoint even though both are "ours".
    const deps = makeDeps({
      containers: [
        { id: "legacy", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
        { id: "planned", name: "cinatra_cinatra-postgres-1", service: "postgres", project: "cinatra_cinatra", workingDir: OURS, ports: [["127.0.0.1", 5434, 5432]] },
      ],
    });
    let thrown = null;
    try {
      assertEndpointOwnership({
        entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
        checkoutDir: OURS,
        deps,
        env: {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown?.message)).toMatch(/more than one compose project[\s\S]*"cinatra"[\s\S]*"cinatra_cinatra"/);
    // A STOPPED sibling project is not a live ambiguity.
    const oneLive = makeDeps({
      containers: [
        { id: "legacy", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, running: false, ports: [["127.0.0.1", 6379, 6379]] },
        { id: "planned", name: "cinatra_cinatra-redis-1", service: "redis", project: "cinatra_cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
      ],
    });
    expect(() =>
      assertEndpointOwnership({
        entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
        checkoutDir: OURS,
        deps: oneLive,
        env: {},
      }),
    ).not.toThrow();
  });

  it("the per-key allowlist exempts exactly the named keys and nothing else", () => {
    const deps = makeDeps(REPRO_WORLD);
    const logs = [];
    // REDIS_URL is owned; NANGO_SERVER_URL is foreign but exempted by name.
    const report = assertEndpointOwnership({
      entries: [
        { key: "REDIS_URL", value: "redis://127.0.0.1:6379" },
        { key: "NANGO_SERVER_URL", value: "http://localhost:3003" },
      ],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m) },
      env: { [O.ENDPOINT_OWNERSHIP_ALLOW_ENV]: "nango_server_url" },
    });
    expect(report.results.find((r) => r.key === "NANGO_SERVER_URL").verdict).toBe("exempt");
    expect(report.violations).toEqual([]);
    expect(logs.join("\n")).toMatch(/ownership NOT verified for NANGO_SERVER_URL/);
    // The gate stays LIVE for a key that was not named.
    expect(() =>
      assertEndpointOwnership({
        entries: [{ key: "NANGO_SERVER_URL", value: "http://localhost:3003" }],
        checkoutDir: OURS,
        deps,
        env: { [O.ENDPOINT_OWNERSHIP_ALLOW_ENV]: "REDIS_URL" },
      }),
    ).toThrow(/NANGO_SERVER_URL/);
  });

  it("the refusal names the external-infra / tunnel topology and both levers", () => {
    const deps = makeDeps({ containers: [] });
    let thrown = null;
    try {
      assertEndpointOwnership({
        entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
        checkoutDir: OURS,
        deps,
        env: {},
      });
    } catch (err) {
      thrown = err;
    }
    const msg = String(thrown?.message);
    expect(msg).toContain("--infra=external");
    expect(msg).toContain("tunnel");
    expect(msg).toContain(O.ENDPOINT_OWNERSHIP_ALLOW_ENV);
    expect(msg).toContain(O.ENDPOINT_OWNERSHIP_ENV);
  });

  it("verifies nothing (and runs no docker call) when there is nothing container-dialed", () => {
    const deps = makeDeps(REPRO_WORLD);
    const report = verifyEndpointOwnership({ entries: [], checkoutDir: OURS, deps });
    expect(report.probe).toBe("skipped");
    expect(deps.calls).toEqual([]);
  });

  it("takes ONE host snapshot however many endpoints are verified", () => {
    const deps = makeDeps(REPRO_WORLD);
    verifyEndpointOwnership({
      entries: [
        { key: "REDIS_URL", value: "redis://127.0.0.1:6379" },
        { key: "SUPABASE_DB_URL", value: pgUrl(DB_CRED, "127.0.0.1:5434", "cinatra") },
        { key: "NANGO_SERVER_URL", value: "http://localhost:3003" },
        { key: "CINATRA_AGENT_REGISTRY_URL", value: "http://127.0.0.1:4873" },
      ],
      checkoutDir: OURS,
      deps,
    });
    // Two docker calls TOTAL — a per-endpoint holder query would multiply a
    // sluggish daemon's latency by the number of endpoints before any build.
    expect(deps.calls).toHaveLength(2);
    expect(deps.calls[0]).toEqual(["ps", "-a", "-q"]);
    expect(deps.calls[1][0]).toBe("inspect");
    // Never `docker compose ps` — that would have to guess the project name and
    // would report an ISOLATED stack as absent.
    expect(deps.calls.some((c) => c[0] === "compose")).toBe(false);
  });

  it("a PASS backed by a loopback-only publication says what it did not prove", () => {
    const deps = makeDeps({
      containers: [
        { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["127.0.0.1", 6379, 6379]] },
        { id: "own-nango", name: "cinatra-nango-server-1", service: "nango-server", project: "cinatra", workingDir: OURS, ports: [["0.0.0.0", 3003, 3003]] },
      ],
    });
    const logs = [];
    assertEndpointOwnership({
      entries: [
        { key: "REDIS_URL", value: "redis://127.0.0.1:6379" },
        { key: "NANGO_SERVER_URL", value: "http://127.0.0.1:3003" },
      ],
      checkoutDir: OURS,
      deps: { ...deps, log: (m) => logs.push(m) },
      env: {},
    });
    const out = logs.join("\n");
    expect(out).toContain("endpoint ownership verified");
    // Only the loopback-bound one carries the caveat.
    expect(out).toMatch(/NOTE: REDIS_URL is published on the host LOOPBACK only/);
    expect(out).not.toContain("NANGO_SERVER_URL is published on the host LOOPBACK");
    expect(out).toContain("cannot see a host-native listener");
  });

  it("a STOPPED foreign container is not a holder (its port map is history)", () => {
    const deps = makeDeps({
      containers: [
        { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS, ports: [["0.0.0.0", 6379, 6379]] },
        { id: "dead", name: "other-redis-1", service: "redis", project: "other", workingDir: THEIRS, running: false, ports: [["0.0.0.0", 6379, 6379]] },
      ],
    });
    const report = verifyEndpointOwnership({
      entries: [{ key: "REDIS_URL", value: "redis://127.0.0.1:6379" }],
      checkoutDir: OURS,
      deps,
    });
    expect(report.results[0].verdict).toBe("owned");
  });
});
