// cinatra-cli#233 — the isolated/default install starts the WayFlow runtime
// BEFORE the extension repos are cloned, so the loader walks an empty
// `extensions/` directory: 0 agents mounted, `/agents/<vendor>/<slug>/` → HTTP
// 404, while `/.health` still answers `ok` and `cinatra doctor` passes over it
// (cinatra#2654 row 7). These tests pin the three acceptance points:
//
//   1. the runtime is made to mount the agent sources only AFTER they exist —
//      driven through the REAL `runInstall` with a real extension clone;
//   2. the doctor's WayFlow probe judges agent AVAILABILITY, not only health;
//   3. the mount step's own contract: reload, restart fallback, and a verdict
//      VERIFIED against the runtime rather than assumed from the reload.
//
// Hermetic: no daemon, no network beyond a local file:// git origin, injected
// fetch/spawn everywhere.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { doctorAssertWayflowReadiness, effectiveComposeProjectName } from "../src/index.mjs";
import { runInstall } from "../src/install.mjs";
import {
  AGENT_SOURCES_DIRNAME,
  INSTALL_EXIT_AGENTS_UNAVAILABLE,
  DEFAULT_WAYFLOW_ENDPOINT,
  WAYFLOW_BRIDGE_TOKEN_HEADER,
  WAYFLOW_RELOAD_PATH,
  agentRoutePath,
  discoverAgentSources,
  fetchWayflowHealth,
  judgeAgentAvailability,
  mountAgentSourcesAfterSync,
  probeAgentRoute,
  readWayflowBridgeToken,
  reloadWayflowAgents,
  resolveWayflowEndpoint,
  restartWayflowService,
} from "../src/wayflow-agent-mount.mjs";

const BRIDGE_TOKEN = "tok-233-never-logged";

/** A checkout with `n` agent sources on disk, an `.env.local` and the narrow
 *  generated env file the runtime is configured from. */
function makeCheckout(root, { agents = [], endpoint = null, token = BRIDGE_TOKEN } = {}) {
  mkdirSync(root, { recursive: true });
  for (const label of agents) {
    const [vendor, slug] = label.split("/");
    mkdirSync(path.join(root, AGENT_SOURCES_DIRNAME, vendor, slug, "cinatra"), { recursive: true });
    writeFileSync(path.join(root, AGENT_SOURCES_DIRNAME, vendor, slug, "cinatra", "oas.json"), "{}");
  }
  writeFileSync(path.join(root, ".env.local"), endpoint ? `WAYFLOW_BASE_URL=${endpoint}\n` : "PORT=3000\n");
  if (token !== null) {
    mkdirSync(path.join(root, "docker", "wayflow"), { recursive: true });
    writeFileSync(path.join(root, "docker", "wayflow", ".wayflow.env"), `CINATRA_BRIDGE_TOKEN=${token}\n`);
  }
  return root;
}

const json = (status, body) => ({ status, json: async () => body });

/** A fetch double driven by an ordered script of `/.health` answers plus the
 *  reload answer and per-route answers, recording every request. `routes` maps
 *  an agent label to its answer; `route` is the default for the rest. */
function makeFetch({ healthSequence = [], reload = json(200, { agents: 0 }), route = json(404, {}), routes = {} } = {}) {
  const calls = [];
  let healthIndex = 0;
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {} });
    const u = String(url);
    if (u.endsWith("/.health")) {
      const answer = healthSequence[Math.min(healthIndex, healthSequence.length - 1)];
      healthIndex += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (u.endsWith(WAYFLOW_RELOAD_PATH)) {
      if (reload instanceof Error) throw reload;
      return reload;
    }
    for (const [label, answer] of Object.entries(routes)) {
      if (u.endsWith(agentRoutePath(label))) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
    if (route instanceof Error) throw route;
    return route;
  };
  impl.calls = calls;
  return impl;
}

/** The probe list `judgeAgentAvailability` consumes, spelled compactly. */
const probesOf = (...pairs) => pairs.map(([label, status]) => ({ label, status, reachable: status !== null }));

describe("cinatra-cli#233 — agent-source discovery mirrors the loader's own rule", () => {
  let sandbox;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-233-disc-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("finds `<vendor>/<slug>` for every extensions/**/cinatra/oas.json, sorted", () => {
    const root = makeCheckout(path.join(sandbox, "found"), { agents: ["cinatra-ai/blog-draft-writer-agent", "acme/alpha-agent"] });
    expect(discoverAgentSources({ targetDir: root })).toEqual(["acme/alpha-agent", "cinatra-ai/blog-draft-writer-agent"]);
  });

  it("skips a slug dir WITHOUT cinatra/oas.json — the loader's probe pattern is not a mountable agent", () => {
    const root = makeCheckout(path.join(sandbox, "probe"), { agents: ["acme/real-agent"] });
    mkdirSync(path.join(root, AGENT_SOURCES_DIRNAME, "acme", "not-an-agent", "src"), { recursive: true });
    expect(discoverAgentSources({ targetDir: root })).toEqual(["acme/real-agent"]);
  });

  it("an absent extensions/ directory is zero sources, never a throw (the fresh-install state)", () => {
    const root = path.join(sandbox, "empty");
    mkdirSync(root, { recursive: true });
    expect(discoverAgentSources({ targetDir: root })).toEqual([]);
    expect(discoverAgentSources({ targetDir: null })).toEqual([]);
  });

  it("addresses the loader's own route shape", () => {
    expect(agentRoutePath("cinatra-ai/blog-draft-writer-agent")).toBe("/agents/cinatra-ai/blog-draft-writer-agent/");
  });
});

describe("cinatra-cli#233 — the endpoint and the bridge token", () => {
  let sandbox;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-233-env-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it("uses THIS instance's remapped endpoint from .env.local, not a hardcoded :3010", () => {
    const root = makeCheckout(path.join(sandbox, "isolated"), { endpoint: "http://localhost:13010" });
    expect(resolveWayflowEndpoint({ targetDir: root })).toBe("http://localhost:13010");
  });

  it("an already-parsed env wins, and an absent/unparseable value falls back to the default endpoint", () => {
    const root = makeCheckout(path.join(sandbox, "fallback"));
    expect(resolveWayflowEndpoint({ targetDir: root, env: { WAYFLOW_BASE_URL: "http://localhost:23010" } })).toBe(
      "http://localhost:23010",
    );
    expect(resolveWayflowEndpoint({ targetDir: root })).toBe(DEFAULT_WAYFLOW_ENDPOINT);
    expect(resolveWayflowEndpoint({ targetDir: root, env: { WAYFLOW_BASE_URL: "not a url" } })).toBe(DEFAULT_WAYFLOW_ENDPOINT);
  });

  it("reads the bridge token from the narrow generated env file; an absent file is null, never a throw", () => {
    const withToken = makeCheckout(path.join(sandbox, "tok"));
    expect(readWayflowBridgeToken({ targetDir: withToken })).toBe(BRIDGE_TOKEN);
    const without = makeCheckout(path.join(sandbox, "notok"), { token: null });
    expect(readWayflowBridgeToken({ targetDir: without })).toBeNull();
  });
});

describe("cinatra-cli#233 — the reload + route probes speak the loader's contract", () => {
  it("POSTs the reload route with the bridge-token header and reads the report's agent count", async () => {
    const fetchImpl = makeFetch({ reload: json(200, { added: ["acme/a"], agents: 1 }) });
    const out = await reloadWayflowAgents({ endpoint: "http://localhost:3010", token: BRIDGE_TOKEN, fetchImpl });
    expect(out.ok).toBe(true);
    expect(out.agents).toBe(1);
    const call = fetchImpl.calls.at(-1);
    expect(call.url).toBe(`http://localhost:3010${WAYFLOW_RELOAD_PATH}`);
    expect(call.method).toBe("POST");
    expect(call.headers[WAYFLOW_BRIDGE_TOKEN_HEADER]).toBe(BRIDGE_TOKEN);
  });

  it("classifies the reload outcomes the loader can answer", async () => {
    const cases = [
      [json(404, {}), "reload-route-absent"],
      [json(405, {}), "reload-route-absent"],
      [json(503, {}), "reload-disabled"],
      [json(403, {}), "reload-forbidden"],
      [json(500, {}), "reload-http-500"],
    ];
    for (const [answer, reason] of cases) {
      const out = await reloadWayflowAgents({
        endpoint: "http://localhost:3010",
        token: BRIDGE_TOKEN,
        fetchImpl: makeFetch({ reload: answer }),
      });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe(reason);
    }
    const noToken = await reloadWayflowAgents({ endpoint: "http://localhost:3010", token: null, fetchImpl: makeFetch() });
    expect(noToken.reason).toBe("no-bridge-token");
  });

  it("reads 404 as NOT MOUNTED and 405 as mounted — the row-7 evidence signal", async () => {
    const absent = await probeAgentRoute({
      endpoint: "http://localhost:3010",
      label: "cinatra-ai/blog-draft-writer-agent",
      fetchImpl: makeFetch({ route: json(404, {}) }),
    });
    expect(absent.mounted).toBe(false);
    const present = await probeAgentRoute({
      endpoint: "http://localhost:3010",
      label: "cinatra-ai/blog-draft-writer-agent",
      fetchImpl: makeFetch({ route: json(405, {}) }),
    });
    expect(present.mounted).toBe(true);
    // An unreachable runtime is UNKNOWN, never a false "absent".
    const down = await probeAgentRoute({
      endpoint: "http://localhost:3010",
      label: "acme/a",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down.mounted).toBeNull();
  });

  it("a health probe reports the mounted count, and a transport error is not a 0", async () => {
    const ok = await fetchWayflowHealth({
      endpoint: "http://localhost:3010",
      fetchImpl: makeFetch({ healthSequence: [json(200, { status: "ok", agents: 29 })] }),
    });
    expect(ok.reachable).toBe(true);
    expect(ok.healthy).toBe(true);
    expect(ok.agents).toBe(29);
    const down = await fetchWayflowHealth({
      endpoint: "http://localhost:3010",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down.reachable).toBe(false);
    expect(down.agents).toBeNull();
  });

  it("an ANSWERING but unhealthy runtime is reachable and NOT healthy — answering is not serving", async () => {
    const five = await fetchWayflowHealth({
      endpoint: "http://localhost:3010",
      fetchImpl: makeFetch({ healthSequence: [json(500, { error: "boom" })] }),
    });
    expect(five.reachable).toBe(true);
    expect(five.healthy).toBe(false);
    const unknown = await fetchWayflowHealth({
      endpoint: "http://localhost:3010",
      fetchImpl: makeFetch({ healthSequence: [json(200, { status: "error", agents: 3 })] }),
    });
    expect(unknown.healthy).toBe(false);
  });
});

describe("cinatra-cli#233 — mountAgentSourcesAfterSync repairs the fresh-install mount", () => {
  let sandbox;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-233-mount-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  const COMPOSE_ARGS = ["compose", "-f", "docker-compose.cinatra-isolated.yml", "-p", "cinatra_x233", "--profile", "wayflow"];

  it("the row-7 state — 0 mounted, sources on disk — is reloaded and VERIFIED as mounted", async () => {
    const root = makeCheckout(path.join(sandbox, "row7"), {
      agents: ["cinatra-ai/blog-draft-writer-agent"],
      endpoint: "http://localhost:13010",
    });
    const fetchImpl = makeFetch({
      healthSequence: [json(200, { status: "ok", agents: 0 }), json(200, { status: "ok", agents: 1 })],
      reload: json(200, { added: ["cinatra-ai/blog-draft-writer-agent"], agents: 1 }),
      route: json(405, {}),
    });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: { fetchImpl },
    });
    expect(out.status).toBe("mounted");
    expect(out.method).toBe("reload");
    expect(out.mounted).toBe(1);
    // Addressed THIS instance's remapped endpoint, not :3010.
    expect(fetchImpl.calls.map((c) => c.url)).toContain(`http://localhost:13010${WAYFLOW_RELOAD_PATH}`);
    // SECRET BOUNDARY: the token authenticates the request and never reaches a log line.
    expect(logs.join("\n")).not.toContain(BRIDGE_TOKEN);
  });

  it("no agent sources on disk → states it and touches nothing (no reload, no restart)", async () => {
    const root = makeCheckout(path.join(sandbox, "nosrc"));
    const fetchImpl = makeFetch();
    const spawnSync = () => ({ status: 0 });
    spawnSync.calls = 0;
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: () => {},
      deps: { fetchImpl, spawnSync },
    });
    expect(out.status).toBe("no-sources");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("a runtime that already SERVES them all is left alone (idempotent re-run / reconcile)", async () => {
    const root = makeCheckout(path.join(sandbox, "already"), { agents: ["acme/a"] });
    const fetchImpl = makeFetch({ healthSequence: [json(200, { status: "ok", agents: 3 })], route: json(405, {}) });
    const out = await mountAgentSourcesAfterSync({ targetDir: root, composeArgs: COMPOSE_ARGS, log: () => {}, deps: { fetchImpl } });
    expect(out.status).toBe("already-mounted");
    expect(fetchImpl.calls.filter((c) => c.url.endsWith(WAYFLOW_RELOAD_PATH))).toHaveLength(0);
  });

  it("a positive agent COUNT does not skip the repair when the new source itself 404s", async () => {
    // The runtime holds two OLD agents (`agents: 2`) and not the one just
    // cloned. A count-only check would call this already-mounted and leave the
    // new agent unserved.
    const root = makeCheckout(path.join(sandbox, "stale-count"), { agents: ["acme/new-agent"] });
    const fetchImpl = makeFetch({
      healthSequence: [json(200, { status: "ok", agents: 2 }), json(200, { status: "ok", agents: 3 })],
      reload: json(200, { agents: 3 }),
      routes: { "acme/new-agent": json(404, {}) },
    });
    const first = await mountAgentSourcesAfterSync({ targetDir: root, composeArgs: COMPOSE_ARGS, log: () => {}, deps: { fetchImpl } });
    // It did NOT skip: the reload was attempted.
    expect(fetchImpl.calls.filter((c) => c.url.endsWith(WAYFLOW_RELOAD_PATH))).toHaveLength(1);
    // And because the route still 404s afterwards, it is NOT reported mounted.
    expect(first.status).toBe("failed");
  });

  it("only ONE of several sources mounted is a failure, and the missing one is named", async () => {
    const root = makeCheckout(path.join(sandbox, "partial"), { agents: ["acme/a", "acme/b"] });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: {
        fetchImpl: makeFetch({
          healthSequence: [json(200, { status: "ok", agents: 1 })],
          reload: json(200, { agents: 1 }),
          routes: { "acme/a": json(405, {}), "acme/b": json(404, {}) },
        }),
      },
    });
    expect(out.status).toBe("failed");
    expect(logs.join("\n")).toContain("acme/b");
  });

  it("the bridge token is NEVER sent to a non-loopback endpoint — the restart route is used instead", async () => {
    const root = makeCheckout(path.join(sandbox, "remote"), {
      agents: ["acme/a"],
      endpoint: "http://wayflow.example.com:3010",
    });
    const fetchImpl = makeFetch({
      healthSequence: [json(200, { status: "ok", agents: 0 }), json(200, { status: "ok", agents: 1 })],
      route: json(405, {}),
    });
    const spawned = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: () => {},
      deps: {
        fetchImpl,
        spawnSync: (cmd, args) => {
          spawned.push([cmd, ...args]);
          return { status: 0 };
        },
        sleepImpl: async () => {},
      },
    });
    // No request to the reload route at all, so the token cannot leave the host.
    expect(fetchImpl.calls.filter((c) => c.url.endsWith(WAYFLOW_RELOAD_PATH))).toHaveLength(0);
    for (const call of fetchImpl.calls) expect(JSON.stringify(call.headers)).not.toContain(BRIDGE_TOKEN);
    expect(out.method).toBe("restart");
    expect(spawned[0]).toContain("restart");
  });

  it("a runtime whose image predates the reload route RESTARTS the one service, under the caller's project", async () => {
    const root = makeCheckout(path.join(sandbox, "oldimage"), { agents: ["acme/a"] });
    const fetchImpl = makeFetch({
      healthSequence: [json(200, { status: "ok", agents: 0 }), json(200, { status: "ok", agents: 1 })],
      reload: json(404, {}),
      route: json(405, {}),
    });
    const spawned = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: () => {},
      deps: {
        fetchImpl,
        spawnSync: (cmd, args) => {
          spawned.push([cmd, ...args]);
          return { status: 0 };
        },
        sleepImpl: async () => {},
      },
    });
    expect(out.status).toBe("mounted");
    expect(out.method).toBe("restart");
    // The RECORDED project the caller resolved — never a basename-derived one.
    expect(spawned[0]).toEqual(["docker", ...COMPOSE_ARGS, "restart", "wayflow"]);
  });

  it("reload AND restart unavailable → a loud, named failure that prescribes the manual restart", async () => {
    const root = makeCheckout(path.join(sandbox, "broken"), { agents: ["acme/a"] });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: {
        fetchImpl: makeFetch({ healthSequence: [json(200, { status: "ok", agents: 0 })], reload: json(503, {}) }),
        spawnSync: () => ({ status: 1 }),
      },
    });
    expect(out.status).toBe("failed");
    const text = logs.join("\n");
    expect(text).toContain("reload-disabled");
    expect(text).toContain("/agents/acme/a/");
    expect(text).toContain("cinatra instance wayflow start");
  });

  it("the verdict is what the RUNTIME answers, not what the reload claimed", async () => {
    const root = makeCheckout(path.join(sandbox, "lying"), { agents: ["acme/a"] });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: {
        fetchImpl: makeFetch({
          // The reload reports 5, but the runtime still serves nothing.
          healthSequence: [json(200, { status: "ok", agents: 0 }), json(200, { status: "ok", agents: 0 })],
          reload: json(200, { agents: 5 }),
          route: json(404, {}),
        }),
      },
    });
    expect(out.status).toBe("failed");
    expect(logs.join("\n")).toContain("did not take effect");
  });

  it("an unreachable runtime is reported, never silently passed over", async () => {
    const root = makeCheckout(path.join(sandbox, "down"), { agents: ["acme/a"] });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    });
    expect(out.status).toBe("unreachable");
    expect(logs.join("\n")).toContain("could not be mounted");
  });

  it("a 5xx /.health with every route answering 405 is NOT success — answering is not health", async () => {
    const root = makeCheckout(path.join(sandbox, "unhealthy"), { agents: ["acme/a"] });
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: () => {},
      deps: {
        fetchImpl: makeFetch({ healthSequence: [json(500, { error: "boom" })], reload: json(200, { agents: 1 }), route: json(405, {}) }),
        spawnSync: () => ({ status: 0 }),
        sleepImpl: async () => {},
      },
    });
    expect(out.status).toBe("failed");
  });

  it("an ABSENT agent count is not coverage — every route answering still does not prove it", async () => {
    const root = makeCheckout(path.join(sandbox, "nocount"), { agents: ["acme/a"] });
    const logs = [];
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: (m) => logs.push(String(m)),
      deps: {
        // A 200 `ok` with NO `agents` field, and the route answering.
        fetchImpl: makeFetch({ healthSequence: [json(200, { status: "ok" })], reload: json(200, {}), route: json(405, {}) }),
        spawnSync: () => ({ status: 0 }),
        sleepImpl: async () => {},
      },
    });
    expect(out.status).toBe("failed");
    expect(logs.join("\n")).toContain("no agent count");
  });

  it("a malformed /.health body is not health either", async () => {
    const root = makeCheckout(path.join(sandbox, "malformed"), { agents: ["acme/a"] });
    const broken = { status: 200, json: async () => { throw new Error("not json"); } };
    const out = await mountAgentSourcesAfterSync({
      targetDir: root,
      composeArgs: COMPOSE_ARGS,
      log: () => {},
      deps: {
        fetchImpl: makeFetch({ healthSequence: [broken], reload: json(200, { agents: 1 }), route: json(405, {}) }),
        spawnSync: () => ({ status: 0 }),
        sleepImpl: async () => {},
      },
    });
    expect(out.status).toBe("failed");
  });

  it("restartWayflowService refuses without a compose context rather than guessing a project", () => {
    expect(restartWayflowService({ targetDir: "/tmp", composeArgs: null, deps: { spawnSync: () => ({ status: 0 }) } })).toEqual({
      ok: false,
      reason: "no-compose-context",
    });
  });
});

describe("cinatra-cli#233 — the doctor judges AVAILABILITY, not only health", () => {
  const LABEL = "cinatra-ai/blog-draft-writer-agent";

  it("row 7 exactly: /.health ok with 0 agents while sources are on disk → FAIL", () => {
    const v = judgeAgentAvailability({ sources: [LABEL], agents: 0, probes: probesOf([LABEL, 404]) });
    expect(v.verdict).toBe("fail");
    expect(v.detail).toContain(`/agents/${LABEL}/`);
    expect(v.detail).toContain("started before the extension sources existed");
    expect(v.remedy).toContain("cinatra install");
  });

  it("the reference state — agents mounted and every route answering 405 — is a PASS", () => {
    const v = judgeAgentAvailability({ sources: [LABEL], agents: 29, probes: probesOf([LABEL, 405]) });
    expect(v.verdict).toBe("pass");
    expect(v.detail).toContain("29 agent(s) mounted");
  });

  it("a positive count that does not include THIS on-disk agent (404) is a FAIL, not a pass on the count", () => {
    const v = judgeAgentAvailability({ sources: ["acme/a"], agents: 2, probes: probesOf(["acme/a", 404]) });
    expect(v.verdict).toBe("fail");
    expect(v.detail).toContain("mount predates");
  });

  it("several sources with only the FIRST mounted is a FAIL that names the missing one", () => {
    const v = judgeAgentAvailability({
      sources: ["acme/a", "acme/b"],
      agents: 1,
      probes: probesOf(["acme/a", 405], ["acme/b", 404]),
    });
    expect(v.verdict).toBe("fail");
    expect(v.detail).toContain("/agents/acme/b/");
    expect(v.detail).not.toContain("/agents/acme/a/");
  });

  it("a 5xx agent route is mounted-but-not-serving → FAIL, with the logs remediation", () => {
    const v = judgeAgentAvailability({ sources: ["acme/a"], agents: 1, probes: probesOf(["acme/a", 500]) });
    expect(v.verdict).toBe("fail");
    expect(v.detail).toContain("5xx");
    expect(v.remedy).toContain("container logs");
  });

  it("an INDETERMINATE probe is a SKIP, never a PASS — an unknown is not readiness", () => {
    const v = judgeAgentAvailability({ sources: ["acme/a"], agents: 3, probes: probesOf(["acme/a", null]) });
    expect(v.verdict).toBe("skip");
    expect(v.detail).toContain("could not be determined");
  });

  it("every route answers but the count does not cover the sources → FAIL", () => {
    const v = judgeAgentAvailability({
      sources: ["acme/a", "acme/b"],
      agents: 1,
      probes: probesOf(["acme/a", 405], ["acme/b", 405]),
    });
    expect(v.verdict).toBe("fail");
    expect(v.detail).toContain("not serving all of them");
  });

  it("0 mounted AND no sources on disk → FAIL (nothing to run), and mounted-with-no-sources still passes", () => {
    expect(judgeAgentAvailability({ sources: [], agents: 0 }).verdict).toBe("fail");
    expect(judgeAgentAvailability({ sources: [], agents: 4 }).verdict).toBe("pass");
  });

  it("an ABSENT agent count is a SKIP, not a PASS — routes answering do not prove coverage", () => {
    const v = judgeAgentAvailability({ sources: ["acme/a"], agents: null, probes: probesOf(["acme/a", 405]) });
    expect(v.verdict).toBe("skip");
    expect(v.detail).toContain("no agent count");
    // …and with no sources either, still not a pass.
    expect(judgeAgentAvailability({ sources: [], agents: null }).verdict).toBe("skip");
  });

  it("a 404 still decides even when the count is absent — a missing route is not an unknown", () => {
    const v = judgeAgentAvailability({ sources: ["acme/a"], agents: null, probes: probesOf(["acme/a", 404]) });
    expect(v.verdict).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// The doctor assertion itself, end to end over the real probe.
// ---------------------------------------------------------------------------
describe("cinatra-cli#233 — doctorAssertWayflowReadiness over a real checkout", () => {
  let sandbox;
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-233-doc-"));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  const dockerWithWayflow = (project) => (args) => {
    if (args[0] !== "ps") return { status: -1, stdout: "" };
    const want = Object.fromEntries(
      args.filter((a) => typeof a === "string" && a.startsWith("label=com.docker.compose.")).map((a) => a.replace("label=", "").split("=")),
    );
    const mine = want["com.docker.compose.project"] === project && want["com.docker.compose.service"] === "wayflow";
    return { status: 0, stdout: mine ? `${project}-wayflow-1` : "" };
  };

  async function assertFor(dirName, { agents, routeStatus, sources = ["cinatra-ai/blog-draft-writer-agent"], routes = {} }) {
    const root = makeCheckout(path.join(sandbox, dirName), { agents: sources });
    const project = effectiveComposeProjectName(root);
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.endsWith("/.health")) return json(200, { status: "ok", agents });
      for (const [label, answer] of Object.entries(routes)) {
        if (u.endsWith(agentRoutePath(label))) {
          if (answer === null) throw new Error("ECONNREFUSED");
          return json(answer, {});
        }
      }
      if (routeStatus === null) throw new Error("ECONNREFUSED");
      return json(routeStatus, {});
    };
    return doctorAssertWayflowReadiness({ fetchImpl, dockerImpl: dockerWithWayflow(project), repoRoot: root, env: {} });
  }

  it("row 7 — container up, /.health ok, 0 agents mounted, agent route 404 → FAIL (this PASSED before)", async () => {
    const a = await assertFor("row7", { agents: 0, routeStatus: 404 });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain("0 agent(s) mounted");
    expect(a.detail).toContain("/.health ok");
    expect(a.remediation).toContain("cinatra install");
  });

  it("the reference state — 29 agents mounted, the agent route answering 405 → PASS", async () => {
    const a = await assertFor("reference", { agents: 29, routeStatus: 405 });
    expect(a.verdict).toBe("pass");
    expect(a.detail).toContain("29 agent(s) mounted");
    expect(a.detail).toContain("HTTP 405");
  });

  it("two sources, only one served → FAIL naming the unserved one (not just the first probed)", async () => {
    const a = await assertFor("partial", {
      agents: 2,
      sources: ["acme/a", "acme/b"],
      routes: { "acme/a": 405, "acme/b": 404 },
    });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain("/agents/acme/b/");
  });

  it("an agent route answering 500 → FAIL (mounted, not serving), never a pass on the count", async () => {
    const a = await assertFor("erroring", { agents: 1, routeStatus: 500 });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain("5xx");
  });

  it("an unreachable agent route → SKIP, never PASS (indeterminate is not readiness)", async () => {
    const a = await assertFor("indeterminate", { agents: 3, routeStatus: null });
    expect(a.verdict).toBe("skip");
    expect(a.detail).toContain("could not be determined");
  });
});

// ---------------------------------------------------------------------------
// THE ORDERING PIN — the real `runInstall`, a real extension clone.
//
// The install clones the host repo, brings the local stack up (WayFlow with
// it), and only THEN clones the declared extension repos. This drives that
// whole sequence for real and records, at each runtime-arming event, how many
// agent sources existed on disk AT THAT MOMENT.
// ---------------------------------------------------------------------------
describe("cinatra-cli#233 — a fresh install arms the runtime only after the agent sources exist", () => {
  let sandbox;
  let hostOrigin;
  let extOrigin;

  function git(args, cwd) {
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
      stdio: "ignore",
    });
  }

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "cin-233-order-"));
    // A real agent extension repo: the loader mounts it because it carries
    // cinatra/oas.json.
    const extSrc = path.join(sandbox, "ext-src");
    mkdirSync(path.join(extSrc, "cinatra"), { recursive: true });
    writeFileSync(path.join(extSrc, "package.json"), JSON.stringify({ name: "@acme/demo-agent", version: "0.0.0" }));
    writeFileSync(path.join(extSrc, "cinatra", "oas.json"), JSON.stringify({ openapi: "3.1.0" }));
    git(["init", "-b", "main"], extSrc);
    git(["add", "-A"], extSrc);
    git(["commit", "-m", "init"], extSrc);
    extOrigin = path.join(sandbox, "ext-origin.git");
    git(["clone", "--bare", extSrc, extOrigin], sandbox);

    // The host repo declares that extension, so the install really clones it.
    const hostSrc = path.join(sandbox, "host-src");
    mkdirSync(path.join(hostSrc, "packages", "migrations"), { recursive: true });
    writeFileSync(path.join(hostSrc, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
      path.join(hostSrc, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    writeFileSync(
      path.join(hostSrc, "package.json"),
      JSON.stringify({
        name: "cinatra-host",
        cinatra: { devExtensions: { "@acme/demo-agent": { url: `file://${extOrigin}`, branch: "main" } } },
      }),
    );
    // The narrow generated env file the runtime is configured from — present in
    // the fixture so the REAL mount below exercises the authenticated reload
    // path rather than degrading to the tokenless fallback.
    mkdirSync(path.join(hostSrc, "docker", "wayflow"), { recursive: true });
    writeFileSync(path.join(hostSrc, "docker", "wayflow", ".wayflow.env"), `CINATRA_BRIDGE_TOKEN=${BRIDGE_TOKEN}\n`);
    writeFileSync(path.join(hostSrc, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
    writeFileSync(path.join(hostSrc, ".gitignore"), ".env.local\nextensions/\n");
    git(["init", "-b", "main"], hostSrc);
    git(["add", "-A"], hostSrc);
    git(["commit", "-m", "init"], hostSrc);
    hostOrigin = path.join(sandbox, "host-origin.git");
    git(["clone", "--bare", hostSrc, hostOrigin], sandbox);
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  beforeEach(() => {
    const home = mkdtempSync(path.join(sandbox, "home-"));
    process.env.CINATRA_INSTANCE_REGISTRY = path.join(home, "instances.json");
    process.env.CINATRA_ALLOC_LOCK = path.join(home, "alloc.lock");
  });

  /** Drive one real install, recording every runtime-arming event with the
   *  number of agent sources on disk at that moment. */
  async function installRecording(installDir, extraArgs = []) {
    const events = [];
    const count = () => discoverAgentSources({ targetDir: installDir }).length;
    const deps = {
      runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
      commandExists: () => true,
      composeAvailable: () => true,
      detectPortConflicts: async () => [],
      composePublishedPortsForTarget: () => [],
      composeConfigForFiles: () => ({ name: "cinatra", services: {}, networks: {}, volumes: {} }),
      targetComposeOwnedPorts: () => new Set(),
      liveComposeInspect: () => [],
      readCloneRegistry: () => null,
      runComposeDown: () => {},
      inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
      bringUpInfra: (args) => {
        events.push({ step: "bring-up", sources: count(), composeProject: args?.composeProject ?? null, wayflow: args?.wayflow });
      },
      mountAgentSourcesAfterSync: async (args) => {
        events.push({ step: "mount", sources: count(), composeArgs: args?.composeArgs ?? null });
        return { status: "mounted", sources: count(), mounted: count() };
      },
    };
    const res = await runInstall(
      ["--dir", installDir, "--repo-url", `file://${hostOrigin}`, "--ref", "main", "--yes", "--no-install", ...extraArgs],
      { log: () => {}, deps },
    );
    return { res, events };
  }

  it("clones the agent source, then arms the runtime — the LAST arming event sees it on disk", async () => {
    const installDir = path.join(sandbox, "fresh");
    const { res, events } = await installRecording(installDir);
    expect(res.infraPlan).toBe("default");
    // The real clone happened.
    expect(existsSync(path.join(installDir, "extensions", "acme", "demo-agent", "cinatra", "oas.json"))).toBe(true);
    expect(discoverAgentSources({ targetDir: installDir })).toEqual(["acme/demo-agent"]);
    // THE ACCEPTANCE INVARIANT: the runtime is started or reloaded only after
    // the agent sources it mounts exist. Whichever event arms it last must have
    // seen them.
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1).sources).toBe(1);
    // A fresh install really does run the mount step, after the sync.
    const mount = events.find((e) => e.step === "mount");
    expect(mount).toBeTruthy();
    expect(mount.sources).toBe(1);
    expect(events.indexOf(mount)).toBeGreaterThan(events.findIndex((e) => e.step === "bring-up"));
  });

  it("regression control: the bring-up ALONE still sees an empty extensions/ — the defect, and why the mount step exists", async () => {
    // If a future change defers the WayFlow start until after the clone, this
    // control is the one to update: the invariant above is the requirement,
    // this measurement is the cinatra#2654 row-7 mechanism.
    const installDir = path.join(sandbox, "control");
    const { events } = await installRecording(installDir);
    const bringUp = events.find((e) => e.step === "bring-up");
    expect(bringUp.sources).toBe(0);
    expect(bringUp.wayflow).toBe(true);
  });

  it("the mount step addresses the install's RECORDED compose project and the wayflow profile", async () => {
    const installDir = path.join(sandbox, "project");
    const { events } = await installRecording(installDir);
    const mount = events.find((e) => e.step === "mount");
    expect(mount.composeArgs).toContain("-p");
    expect(mount.composeArgs[mount.composeArgs.indexOf("-p") + 1]).toBe("cinatra_project");
    expect(mount.composeArgs).toContain("wayflow");
  });

  it("--no-wayflow installs no runtime, so nothing is mounted (the opt-out stays cheap)", async () => {
    const installDir = path.join(sandbox, "lean");
    const { events } = await installRecording(installDir, ["--no-wayflow"]);
    expect(events.find((e) => e.step === "mount")).toBeUndefined();
    expect(events.find((e) => e.step === "bring-up").wayflow).toBe(false);
  });

  it("--no-infra owns no local runtime, so the mount step never runs", async () => {
    const installDir = path.join(sandbox, "ext-infra");
    const { events } = await installRecording(installDir, ["--no-infra"]);
    expect(events.find((e) => e.step === "mount")).toBeUndefined();
  });

  // The REAL repair inside the real install — no injected mount seam. Only the
  // runtime's own HTTP surface and the compose restart are faked, so the
  // discovery, the reload attempt, the fallback and the verification all run.
  describe("the REAL mount implementation inside a real install", () => {
    async function realInstall(installDir, wayflowMountDeps) {
      const logs = [];
      const before = process.exitCode;
      process.exitCode = 0;
      try {
        await runInstall(
          ["--dir", installDir, "--repo-url", `file://${hostOrigin}`, "--ref", "main", "--yes", "--no-install"],
          {
            log: (m) => logs.push(String(m)),
            deps: {
              runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
              commandExists: () => true,
              composeAvailable: () => true,
              detectPortConflicts: async () => [],
              composePublishedPortsForTarget: () => [],
              composeConfigForFiles: () => ({ name: "cinatra", services: {}, networks: {}, volumes: {} }),
              targetComposeOwnedPorts: () => new Set(),
              liveComposeInspect: () => [],
              readCloneRegistry: () => null,
              runComposeDown: () => {},
              inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
              bringUpInfra: () => {},
              wayflowMountDeps,
            },
          },
        );
        return { logs, exitCode: process.exitCode };
      } finally {
        process.exitCode = before ?? 0;
      }
    }

    it("a runtime that stays empty makes the install report the defect and exit NON-ZERO", async () => {
      const installDir = path.join(sandbox, "real-fail");
      const { logs, exitCode } = await realInstall(installDir, {
        // The runtime is up and answers `ok`, but mounts nothing and 404s the
        // agent route — the exact row-7 state. Reload is refused and the restart
        // fallback fails too, so the repair genuinely does not take.
        fetchImpl: async (url) => {
          const u = String(url);
          if (u.endsWith("/.health")) return json(200, { status: "ok", agents: 0 });
          if (u.endsWith(WAYFLOW_RELOAD_PATH)) return json(503, {});
          return json(404, {});
        },
        spawnSync: () => ({ status: 1 }),
        sleepImpl: async () => {},
      });
      // The install COMPLETED — and still does not report a clean success.
      expect(exitCode).toBe(INSTALL_EXIT_AGENTS_UNAVAILABLE);
      const text = logs.join("\n");
      expect(text).toContain("cannot serve its agents");
      expect(text).toContain("/agents/acme/demo-agent/");
      expect(text).toContain("cinatra doctor");
    });

    it("the real reload path: the cloned agent is mounted, the token goes only to loopback, exit CLEAN", async () => {
      const installDir = path.join(sandbox, "real-ok");
      let reloaded = false;
      const seen = [];
      const { logs, exitCode } = await realInstall(installDir, {
        fetchImpl: async (url, init = {}) => {
          const u = String(url);
          seen.push({ url: u, headers: init.headers ?? {} });
          if (u.endsWith(WAYFLOW_RELOAD_PATH)) {
            expect(init.method).toBe("POST");
            reloaded = true;
            return json(200, { added: ["acme/demo-agent"], agents: 1 });
          }
          if (u.endsWith("/.health")) return json(200, { status: "ok", agents: reloaded ? 1 : 0 });
          return json(reloaded ? 405 : 404, {});
        },
        spawnSync: () => ({ status: 0 }),
        sleepImpl: async () => {},
      });
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).toContain("serves all 1 agent source(s)");
      // The token was read from the checkout's own generated env file and sent
      // to the loopback runtime — and to nothing else.
      const tokenCalls = seen.filter((c) => JSON.stringify(c.headers).includes(BRIDGE_TOKEN));
      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0].url).toBe(`${DEFAULT_WAYFLOW_ENDPOINT}${WAYFLOW_RELOAD_PATH}`);
      // And it never reached a log line.
      expect(logs.join("\n")).not.toContain(BRIDGE_TOKEN);
    });
  });
});
