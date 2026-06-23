// Install isolation (cinatra-cli#17, T4 classifier + T7 resolved-compose).

import { describe, expect, it } from "vitest";

import {
  classifyPortHolder,
  generateIsolatedCompose,
  renderIsolatedComposeYaml,
  __test,
} from "../src/install-isolation.mjs";

const { scrubServiceEnv, isSecretEnvKey, remapServicePorts } = __test;

// A fixture `docker inspect` row that owns a host port via the working_dir label.
const inspectRow = (workingDir, hostPort, containerPort = `${hostPort}`) => ({
  Config: { Labels: { "com.docker.compose.project.working_dir": workingDir } },
  NetworkSettings: { Ports: { [`${containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }] } },
});

describe("classifyPortHolder (T4)", () => {
  const instanceRegistry = {
    instances: {
      beta: { slug: "beta", installDir: "/home/u/beta", state: "ready" },
    },
  };

  // The conflict probes the loopback interface (matching the band's 127.0.0.1
  // bindings + the inspect rows' HostIp) — classification is interface-aware.
  const loop = (port) => ({ host: "127.0.0.1", port });

  it("unrelated when no live container owns the conflicting port (degraded honesty)", () => {
    const r = classifyPortHolder({ conflicts: [loop(5434)], inspectRows: [], instanceRegistry });
    expect(r.kind).toBe("unrelated");
  });

  it("idempotent-rerun when the owner working_dir is our own install dir", () => {
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/home/u/cinatra", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("idempotent-rerun");
    expect(r.ownerDir).toBe("/home/u/cinatra");
  });

  it("other-cinatra when the owner dir is a DIFFERENT recorded instance", () => {
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/home/u/beta", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("other-cinatra");
    expect(r.instance.slug).toBe("beta");
  });

  it("unrelated when the owner dir is a live compose project NOT in the registry", () => {
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/some/other/project", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("unrelated");
  });

  it("MIXED when one port is Cinatra-owned and another is a stranger (review hardening #6)", () => {
    // 5434 owned by beta; 6379 owned by nothing (stranger).
    const r = classifyPortHolder({
      conflicts: [loop(5434), loop(6379)],
      inspectRows: [inspectRow("/home/u/beta", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("mixed");
  });

  it("MIXED when conflicting ports map to TWO different instances", () => {
    const reg = {
      instances: {
        beta: { slug: "beta", installDir: "/home/u/beta", state: "ready" },
        gamma: { slug: "gamma", installDir: "/home/u/gamma", state: "ready" },
      },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434), loop(6379)],
      inspectRows: [inspectRow("/home/u/beta", 5434), inspectRow("/home/u/gamma", 6379)],
      installDir: "/home/u/cinatra",
      instanceRegistry: reg,
    });
    expect(r.kind).toBe("mixed");
  });

  it("interface-aware: a 0.0.0.0 owner covers a loopback conflict probe", () => {
    // beta binds 0.0.0.0:3003 (all interfaces) → owns a 127.0.0.1:3003 conflict.
    const reg = { instances: { beta: { slug: "beta", installDir: "/home/u/beta", state: "ready" } } };
    const allIface = {
      Config: { Labels: { "com.docker.compose.project.working_dir": "/home/u/beta" } },
      NetworkSettings: { Ports: { "3003/tcp": [{ HostIp: "0.0.0.0", HostPort: "3003" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(3003)],
      inspectRows: [allIface],
      installDir: "/home/u/cinatra",
      instanceRegistry: reg,
    });
    expect(r.kind).toBe("other-cinatra");
  });

  it("interface-aware: a 127.0.0.1-only owner does NOT match a stranger's 0.0.0.0 conflict", () => {
    // The conflict is on 0.0.0.0:5434; beta only bound 127.0.0.1:5434 → NOT proven.
    const r = classifyPortHolder({
      conflicts: [{ host: "0.0.0.0", port: 5434 }],
      inspectRows: [inspectRow("/home/u/beta", 5434)], // HostIp 127.0.0.1
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("unrelated");
  });
});

describe("generateIsolatedCompose (T7)", () => {
  const resolvedConfig = {
    name: "cinatra",
    services: {
      postgres: {
        image: "postgres:16",
        container_name: "cinatra-postgres",
        environment: {
          POSTGRES_PASSWORD: "supersecret-plaintext",
          POSTGRES_USER: "postgres",
          OPENAI_API_KEY: "sk-leaked-value",
          PUBLIC_FLAG: "fine",
        },
        ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        networks: ["default"],
      },
      neo4j: {
        image: "neo4j",
        ports: [
          { published: "7474", target: 7474, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
          { published: "7687", target: 7687, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" },
        ],
      },
    },
    networks: { default: { name: "cinatra_default" } },
    volumes: { "cinatra-postgres": { name: "cinatra_cinatra-postgres" } },
  };

  it("shifts every published host port by the offset (no legacy binding survives)", () => {
    const { doc, ports } = generateIsolatedCompose({
      resolvedConfig,
      offset: 10000,
      projectName: "cinatra_alpha",
      slug: "alpha",
      appPort: 3300,
    });
    // postgres 5434 → 15434
    expect(doc.services.postgres.ports[0].published).toBe("15434");
    // neo4j 7474/7687 → 17474/17687
    expect(doc.services.neo4j.ports.map((p) => p.published)).toEqual(["17474", "17687"]);
    // the FULL remapped set is returned as a per-service LIST.
    expect(ports.neo4j).toEqual([17474, 17687]);
    expect(ports.postgres).toEqual([15434]);

    // NO original/legacy binding survives anywhere in the rendered file.
    const yaml = renderIsolatedComposeYaml(doc);
    expect(yaml).not.toContain('"5434"');
    expect(yaml).not.toContain('"7474"');
    expect(yaml).not.toContain('"7687"');
  });

  it("rewrites resolved resource names so nothing is shared with the default stack (review hardening #1)", () => {
    const { doc } = generateIsolatedCompose({
      resolvedConfig,
      offset: 10000,
      projectName: "cinatra_alpha",
      slug: "alpha",
    });
    expect(doc.name).toBe("cinatra_alpha");
    expect(doc.networks.default.name).toBe("cinatra_alpha_default");
    expect(doc.volumes["cinatra-postgres"].name).toBe("cinatra_alpha_cinatra-postgres");
    expect(doc.services.postgres.container_name).toBe("cinatra_alpha-postgres");
  });

  it("labels every service AND every named volume for uniform detection", () => {
    const { doc } = generateIsolatedCompose({
      resolvedConfig,
      offset: 10000,
      projectName: "cinatra_alpha",
      slug: "alpha",
      appPort: 3300,
    });
    expect(doc.services.postgres.labels["ai.cinatra.managed"]).toBe("true");
    expect(doc.services.postgres.labels["ai.cinatra.instance"]).toBe("alpha");
    expect(doc.services.postgres.labels["ai.cinatra.service"]).toBe("postgres");
    expect(doc.services.postgres.labels["ai.cinatra.app-port"]).toBe("3300");
    expect(doc.volumes["cinatra-postgres"].labels["ai.cinatra.managed"]).toBe("true");
  });

  it("scrubs interpolated SECRET env values back to ${VAR} (review hardening #2)", () => {
    const { doc } = generateIsolatedCompose({
      resolvedConfig,
      offset: 10000,
      projectName: "cinatra_alpha",
      slug: "alpha",
    });
    const env = doc.services.postgres.environment;
    expect(env.POSTGRES_PASSWORD).toBe("${POSTGRES_PASSWORD}");
    expect(env.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    // Non-secret values are preserved.
    expect(env.POSTGRES_USER).toBe("postgres");
    expect(env.PUBLIC_FLAG).toBe("fine");

    // No plaintext secret survives in the rendered file.
    const yaml = renderIsolatedComposeYaml(doc);
    expect(yaml).not.toContain("supersecret-plaintext");
    expect(yaml).not.toContain("sk-leaked-value");
  });

  it("does not mutate the input resolvedConfig (hermetic)", () => {
    const before = JSON.stringify(resolvedConfig);
    generateIsolatedCompose({ resolvedConfig, offset: 10000, projectName: "cinatra_alpha", slug: "alpha" });
    expect(JSON.stringify(resolvedConfig)).toBe(before);
  });

  it("renders valid JSON (a JSON-in-.yml compose file)", () => {
    const { doc } = generateIsolatedCompose({ resolvedConfig, offset: 10000, projectName: "cinatra_alpha", slug: "alpha" });
    const yaml = renderIsolatedComposeYaml(doc);
    expect(() => JSON.parse(yaml)).not.toThrow();
  });
});

describe("secret-key + port helpers", () => {
  it("isSecretEnvKey matches suffixes + exact high-value names", () => {
    expect(isSecretEnvKey("BETTER_AUTH_SECRET")).toBe(true);
    expect(isSecretEnvKey("POSTGRES_PASSWORD")).toBe(true);
    expect(isSecretEnvKey("SOME_TOKEN")).toBe(true);
    expect(isSecretEnvKey("NANGO_ENCRYPTION_KEY")).toBe(true);
    expect(isSecretEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvKey("POSTGRES_USER")).toBe(false);
    expect(isSecretEnvKey("PORT")).toBe(false);
  });

  it("scrubServiceEnv leaves an already-symbolic value untouched", () => {
    const out = scrubServiceEnv({ FOO_SECRET: "${FOO_SECRET}", BAR_PASSWORD: "plain" });
    expect(out.FOO_SECRET).toBe("${FOO_SECRET}");
    expect(out.BAR_PASSWORD).toBe("${BAR_PASSWORD}");
  });

  it("scrubServiceEnv re-symbolises a *_URL that embeds inline credentials (review hardening #5)", () => {
    // Assemble the credential URL at RUNTIME so no literal `user:pass@` Postgres
    // string is committed (it would trip the secret-scan gate's detector).
    const creds = ["user", "pass"].join(":");
    const credUrl = `postgresql://${creds}@db.example:5432/app`;
    const plainUrl = "postgresql://db.example:5432/app"; // no creds → kept
    const out = scrubServiceEnv({ DATABASE_URL: credUrl, OTHER_URL: plainUrl, PLAIN: "x" });
    expect(out.DATABASE_URL).toBe("${DATABASE_URL}");
    expect(out.OTHER_URL).toBe(plainUrl); // a credential-free URL is left intact
    expect(out.PLAIN).toBe("x");
  });

  it("remapServicePorts leaves an unpublished entry alone", () => {
    const out = remapServicePorts([{ target: 5432 }], 10000);
    expect(out[0].published).toBeUndefined();
  });
});
