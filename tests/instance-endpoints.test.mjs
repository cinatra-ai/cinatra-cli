// The instance's EFFECTIVE local-infra endpoints (cinatra-ai/cinatra-cli#197).
//
// HERMETIC: pure derivation over an injected band, plus one filesystem-only
// guard. Nothing here shells out to docker.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCAL_INFRA_PORTS,
  EFFECTIVE_ENDPOINT_SPECS,
  LOCAL_STACK_INFRA_PLANS,
  deriveEffectiveInstanceEndpoints,
  firstPublishedPortForService,
  infraPlanOwnsLocalStack,
  parseComposePublishedPorts,
} from "../src/instance-endpoints.mjs";
import { DEFAULT_DEV_HOST_PORTS, parseComposePublishedPorts as reExported } from "../src/install.mjs";
import { __test as P } from "../src/preview.mjs";

const { CONTAINER_REWRITE_ENV_KEYS, PASSTHROUGH_ENV_KEYS } = P;

// A resolved `docker compose config --format json` band for the DEFAULT dev
// stack — the shape `install --mode preview` sees on a quiet host.
const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "verdaccio", host: "0.0.0.0", port: 4873 },
];

// The same stack shifted by an isolation offset.
const SHIFTED_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5534 },
  { service: "redis", host: "127.0.0.1", port: 6479 },
  { service: "verdaccio", host: "0.0.0.0", port: 4973 },
];

describe("effective endpoints — derivation from the checkout's own band (#197)", () => {
  it("derives the container-dialed endpoints the install never writes down", () => {
    const { values, sources } = deriveEffectiveInstanceEndpoints({ band: DEFAULT_BAND });
    expect(values.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(values.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4873");
    expect(values.CINATRA_AGENT_REGISTRY_UI_URL).toBe("http://127.0.0.1:4873");
    // Every value came from the RESOLVED band, not the static table.
    for (const key of Object.keys(values)) expect(sources[key]).toBe("compose");
  });

  it("follows the band when the ports are shifted — it never assumes the defaults", () => {
    const { values, sources } = deriveEffectiveInstanceEndpoints({ band: SHIFTED_BAND });
    expect(values.REDIS_URL).toBe("redis://127.0.0.1:6479");
    expect(values.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4973");
    expect(sources.REDIS_URL).toBe("compose");
  });

  it("falls back to the DEFAULT stack's ports only when compose cannot be modelled AT ALL, and says so", () => {
    const { values, sources } = deriveEffectiveInstanceEndpoints({ band: null });
    expect(values.REDIS_URL).toBe(`redis://127.0.0.1:${DEFAULT_LOCAL_INFRA_PORTS.redis}`);
    expect(values.CINATRA_AGENT_REGISTRY_URL).toBe(`http://127.0.0.1:${DEFAULT_LOCAL_INFRA_PORTS.verdaccio}`);
    expect(sources.REDIS_URL).toBe("default");
    expect(sources.CINATRA_AGENT_REGISTRY_URL).toBe("default");
  });

  it("a RESOLVED band is authoritative — including about a service it does not publish", () => {
    // The static table is a last resort for an UNKNOWN band, never a per-service
    // backfill: a checkout whose stack publishes no Redis has no Redis endpoint,
    // and answering 6379 would be inventing one.
    const noRedis = [{ service: "verdaccio", host: "0.0.0.0", port: 4873 }];
    const { values } = deriveEffectiveInstanceEndpoints({ band: noRedis });
    expect(values).not.toHaveProperty("REDIS_URL");
    expect(values.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4873");
    // An EMPTY resolved band is still a resolved band.
    expect(deriveEffectiveInstanceEndpoints({ band: [] }).values).toEqual({});
  });

  it("derives NOTHING for a service the band does not publish and no default names", () => {
    const { values } = deriveEffectiveInstanceEndpoints({
      band: DEFAULT_BAND,
      specs: [{ key: "SOMETHING_URL", service: "absent-service", build: (p) => `http://127.0.0.1:${p}` }],
      defaults: {},
    });
    expect(values).toEqual({});
  });

  it("picks the FIRST published port for a service, like the isolated path's `ports` lookup", () => {
    const band = [
      { service: "neo4j", host: "127.0.0.1", port: 7474 },
      { service: "neo4j", host: "127.0.0.1", port: 7687 },
    ];
    expect(firstPublishedPortForService(band, "neo4j")).toBe(7474);
    expect(firstPublishedPortForService(band, "redis")).toBeNull();
    expect(firstPublishedPortForService(null, "redis")).toBeNull();
  });
});

describe("effective endpoints — the static fallback cannot silently go stale (#197)", () => {
  it("agrees with install.mjs's DEFAULT_DEV_HOST_PORTS for every service it names", () => {
    for (const [service, port] of Object.entries(DEFAULT_LOCAL_INFRA_PORTS)) {
      const declared = DEFAULT_DEV_HOST_PORTS.filter((e) => e.service === service).map((e) => e.port);
      expect(declared).toContain(port);
    }
  });

  it("re-exports the compose-port parser from install.mjs (its established surface)", () => {
    expect(reExported).toBe(parseComposePublishedPorts);
  });
});

describe("effective endpoints — the keys are exactly the ones preview forwards (#197)", () => {
  it("every derived key is in the passthrough set (anything else would be dropped)", () => {
    for (const spec of EFFECTIVE_ENDPOINT_SPECS) expect(PASSTHROUGH_ENV_KEYS).toContain(spec.key);
  });

  it("the CONTAINER-dialed pair rides the existing rewrite; the browser-resolved UI URL does not", () => {
    expect(CONTAINER_REWRITE_ENV_KEYS).toContain("REDIS_URL");
    expect(CONTAINER_REWRITE_ENV_KEYS).toContain("CINATRA_AGENT_REGISTRY_URL");
    // Documented contract at preview.mjs: the UI URL is resolved by the
    // operator's BROWSER, so a container-only name would not resolve.
    expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain("CINATRA_AGENT_REGISTRY_UI_URL");
  });
});

describe("effective endpoints — which infra plans this band describes (#197)", () => {
  it("covers the plans whose stack THIS checkout owns", () => {
    expect(infraPlanOwnsLocalStack("default")).toBe(true);
    expect(infraPlanOwnsLocalStack("attach")).toBe(true);
    expect(LOCAL_STACK_INFRA_PLANS).toEqual(["default", "attach"]);
  });

  it("excludes the plans that dial infra this band does not model", () => {
    // external: operator-owned endpoints — deriving a local loopback URL would
    // invent the very thing the operator replaced.
    expect(infraPlanOwnsLocalStack("external")).toBe(false);
    // co-use: the DONOR's stack (and `--mode preview` refuses co-use outright).
    expect(infraPlanOwnsLocalStack("co-use")).toBe(false);
    // isolated: already written explicitly into .env.local — nothing implicit
    // left, and excluding it keeps the isolated path provably untouched.
    expect(infraPlanOwnsLocalStack("isolated")).toBe(false);
    expect(infraPlanOwnsLocalStack(undefined)).toBe(false);
  });
});

describe("effective endpoints — parsing a real compose config (#197)", () => {
  it("derives from a `docker compose config --format json` document end to end", () => {
    const band = parseComposePublishedPorts({
      services: {
        redis: { ports: [{ published: "6379", target: 6379, host_ip: "127.0.0.1", protocol: "tcp" }] },
        verdaccio: { ports: [{ published: 4873, target: 4873, protocol: "tcp" }] },
      },
    });
    const { values } = deriveEffectiveInstanceEndpoints({ band });
    expect(values.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(values.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4873");
  });
});
