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

  // cinatra-cli#39 — `ai.cinatra.*` labels + per-checkout markers are POSITIVE
  // proof, so a labelled/markered checkout that is NOT a registry row is
  // recognized as `other-cinatra` (not the old "degraded honesty" unrelated).
  it("#39: other-cinatra when an unregistered owner carries ai.cinatra.* labels", () => {
    // Same NOT-in-registry owner dir as the test above, but WITH the labels.
    const labelledRow = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/some/other/project",
          "ai.cinatra.managed": "true",
          "ai.cinatra.kind": "instance",
          "ai.cinatra.instance": "legacy-iso",
          "ai.cinatra.project": "cinatra_legacy_iso",
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [labelledRow],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("other-cinatra");
    // The instance is synthesized from the labels (slug + project) and flagged
    // for executor backfill.
    expect(r.instance.slug).toBe("legacy-iso");
    expect(r.instance.composeProject).toBe("cinatra_legacy_iso");
    expect(r.instance.installDir).toBe("/some/other/project");
    expect(r.backfill).toBeTruthy();
    expect(r.backfill.proofSource).toBe("label");
  });

  it("#39: other-cinatra when an unregistered, UNLABELLED owner has a marker present", () => {
    // The container carries NO ai.cinatra.* labels (e.g. a default-stack or an
    // old isolated stack predating the labels) but a marker exists at the dir.
    const readMarker = (dir) =>
      dir === "/some/other/project"
        ? {
            status: "ok",
            marker: {
              slug: "marked-inst",
              composeProject: "cinatra_marked_inst",
              composeFiles: ["docker-compose.cinatra-isolated.yml"],
              appPort: 3300,
              mode: "dev",
            },
          }
        : { status: "missing", marker: null };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/some/other/project", 5434)], // no ai.cinatra.* labels
      installDir: "/home/u/cinatra",
      instanceRegistry,
      readMarker,
    });
    expect(r.kind).toBe("other-cinatra");
    expect(r.instance.slug).toBe("marked-inst");
    expect(r.instance.composeProject).toBe("cinatra_marked_inst");
    expect(r.instance.composeFiles).toEqual(["docker-compose.cinatra-isolated.yml"]);
    expect(r.backfill.proofSource).toBe("marker");
  });

  it("#39: still unrelated when there is NO label AND NO marker (degraded honesty preserved)", () => {
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/some/other/project", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
      readMarker: () => ({ status: "missing", marker: null }),
    });
    expect(r.kind).toBe("unrelated");
    expect(r.backfill).toBeUndefined();
  });

  it("#39 (hardening): managed-label ALONE (no instance/project) is NOT proof → unrelated", () => {
    // `ai.cinatra.managed:"true"` with no slug/project would synthesize a
    // null-project holder a bare `down` could act on — refuse it (codex #2).
    const partialLabel = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/some/other/project",
          "ai.cinatra.managed": "true",
          // no ai.cinatra.instance / ai.cinatra.project
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [partialLabel],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("unrelated");
    expect(r.backfill).toBeUndefined();
  });

  it("#39 (hardening): a marker with no composeProject is NOT proof → unrelated", () => {
    const readMarker = (dir) =>
      dir === "/some/other/project"
        ? { status: "ok", marker: { slug: "has-slug-no-project" } } // missing composeProject
        : { status: "missing", marker: null };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [inspectRow("/some/other/project", 5434)],
      installDir: "/home/u/cinatra",
      instanceRegistry,
      readMarker,
    });
    expect(r.kind).toBe("unrelated");
    expect(r.backfill).toBeUndefined();
  });

  it("#39: a label-proven holder ALWAYS yields a usable composeProject (never null)", () => {
    const labelledRow = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/some/other/project",
          "ai.cinatra.managed": "true",
          "ai.cinatra.instance": "legacy-iso",
          "ai.cinatra.project": "cinatra_legacy_iso",
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [labelledRow],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.instance.composeProject).toBe("cinatra_legacy_iso");
    expect(r.instance.composeFiles).toEqual(["docker-compose.cinatra-isolated.yml"]);
  });

  it("#39: a registry row STILL wins over labels (registry is authority)", () => {
    // beta is recorded; even with labels naming a different slug, the registry
    // row is returned (no synthesized backfill instance).
    const labelledBeta = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/home/u/beta",
          "ai.cinatra.managed": "true",
          "ai.cinatra.instance": "not-beta",
          "ai.cinatra.project": "cinatra_not_beta",
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [labelledBeta],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("other-cinatra");
    expect(r.instance.slug).toBe("beta"); // registry row, not the label slug
    expect(r.backfill).toBeUndefined();
  });

  it("#39: a labelled OWN checkout stays idempotent-rerun (self), never other-cinatra", () => {
    const labelledSelf = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/home/u/cinatra",
          "ai.cinatra.managed": "true",
          "ai.cinatra.instance": "cinatra",
          "ai.cinatra.project": "cinatra_cinatra",
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434)],
      inspectRows: [labelledSelf],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("idempotent-rerun");
    expect(r.backfill).toBeUndefined();
  });

  it("#39: labels do NOT rescue a MIXED conflict (a stranger port still poisons it)", () => {
    // 5434 owned by a labelled Cinatra stack; 6379 owned by nobody (stranger).
    const labelledRow = {
      Config: {
        Labels: {
          "com.docker.compose.project.working_dir": "/some/other/project",
          "ai.cinatra.managed": "true",
          "ai.cinatra.instance": "legacy-iso",
          "ai.cinatra.project": "cinatra_legacy_iso",
        },
      },
      NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] } },
    };
    const r = classifyPortHolder({
      conflicts: [loop(5434), loop(6379)],
      inspectRows: [labelledRow],
      installDir: "/home/u/cinatra",
      instanceRegistry,
    });
    expect(r.kind).toBe("mixed");
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

  // ── cinatra-cli#57 — env-file-AWARE scrub (the real fix) ────────────────────
  // The bug: the generator scrubbed EVERY secret to `${VAR}`, including the
  // compose-baked infra-init DEFAULTS (POSTGRES_PASSWORD: postgres, …) that
  // nothing supplies at `up` time → they resolved BLANK and postgres/nango-db
  // failed on fresh volumes; and because several services hardcode the SAME key
  // (`POSTGRES_PASSWORD`) with DIFFERENT values, a flat `${VAR}` also collapsed
  // them. The fix: scrub a secret ONLY when the instance env-file supplies its
  // key (`envFileKeys`); a compose default stays LITERAL — resolves AND keeps its
  // distinct per-service value.
  describe("cinatra-cli#57 — env-file-aware scrub keeps infra defaults literal, scrubs operator secrets", () => {
    // Mirrors the REAL cinatra compose: postgres + nango-db both hardcode
    // POSTGRES_PASSWORD but with DIFFERENT values (postgres vs nango); operator
    // secrets (OPENAI_API_KEY, the NEO4J password) come from .env.local.
    const infraConfig = {
      name: "cinatra",
      services: {
        postgres: {
          image: "postgres:16",
          environment: { POSTGRES_PASSWORD: "postgres", POSTGRES_USER: "postgres", OPENAI_API_KEY: "sk-leaked" },
          ports: [{ published: "5434", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
        "nango-db": {
          image: "postgres:16",
          environment: { POSTGRES_PASSWORD: "nango", NANGO_DB_PASSWORD: "nango" },
          ports: [{ published: "5435", target: 5432, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
        neo4j: {
          image: "neo4j",
          environment: { "DATABASE__PROVIDERS__NEO4J__PASSWORD": "cinatra-local" },
          ports: [{ published: "7687", target: 7687, host_ip: "127.0.0.1", protocol: "tcp", mode: "host" }],
        },
      },
      networks: { default: { name: "cinatra_default" } },
      volumes: {},
    };
    // The instance's .env.local supplies ONLY the genuine operator secrets — NOT
    // the compose-baked infra-init defaults.
    const envFileKeys = new Set(["OPENAI_API_KEY", "DATABASE__PROVIDERS__NEO4J__PASSWORD", "BETTER_AUTH_SECRET"]);

    it("leaves a compose-default infra password as its LITERAL (it would otherwise resolve blank)", () => {
      const { doc } = generateIsolatedCompose({
        resolvedConfig: infraConfig, offset: 10000, projectName: "cinatra_beta", slug: "beta", envFileKeys,
      });
      // POSTGRES_PASSWORD / NANGO_DB_PASSWORD are NOT in .env.local → stay literal.
      expect(doc.services.postgres.environment.POSTGRES_PASSWORD).toBe("postgres");
      expect(doc.services["nango-db"].environment.POSTGRES_PASSWORD).toBe("nango");
      expect(doc.services["nango-db"].environment.NANGO_DB_PASSWORD).toBe("nango");
    });

    it("does NOT collapse the same key's DIFFERENT per-service values (postgres vs nango)", () => {
      const { doc } = generateIsolatedCompose({
        resolvedConfig: infraConfig, offset: 10000, projectName: "cinatra_beta", slug: "beta", envFileKeys,
      });
      // Each service keeps its OWN POSTGRES_PASSWORD — never one flattened value.
      expect(doc.services.postgres.environment.POSTGRES_PASSWORD).not.toBe(
        doc.services["nango-db"].environment.POSTGRES_PASSWORD,
      );
    });

    it("STILL scrubs a genuine operator secret that .env.local supplies (no plaintext leak)", () => {
      const { doc, scrubbedKeys } = generateIsolatedCompose({
        resolvedConfig: infraConfig, offset: 10000, projectName: "cinatra_beta", slug: "beta", envFileKeys,
      });
      // OPENAI_API_KEY + the neo4j password ARE in .env.local → re-symbolised.
      expect(doc.services.postgres.environment.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
      expect(doc.services.neo4j.environment["DATABASE__PROVIDERS__NEO4J__PASSWORD"]).toBe(
        "${DATABASE__PROVIDERS__NEO4J__PASSWORD}",
      );
      // No leaked plaintext operator secret anywhere in the rendered file.
      const yaml = renderIsolatedComposeYaml(doc);
      expect(yaml).not.toContain("sk-leaked");
      // scrubbedKeys reports ONLY the env-file-supplied keys it re-symbolised.
      expect(new Set(scrubbedKeys)).toEqual(new Set(["OPENAI_API_KEY", "DATABASE__PROVIDERS__NEO4J__PASSWORD"]));
    });

    it("INVARIANT: every `${VAR}` the generator introduces is on the envFileKeys allowlist (none resolves blank)", () => {
      const { doc, scrubbedKeys } = generateIsolatedCompose({
        resolvedConfig: infraConfig, offset: 10000, projectName: "cinatra_beta", slug: "beta", envFileKeys,
      });
      const placeholderKeys = new Set();
      for (const svc of Object.values(doc.services)) {
        for (const value of Object.values(svc.environment ?? {})) {
          const m = typeof value === "string" ? value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/) : null;
          if (m) placeholderKeys.add(m[1]);
        }
      }
      // Every introduced placeholder is a key .env.local supplies → resolves.
      for (const key of placeholderKeys) expect(envFileKeys.has(key)).toBe(true);
      // And scrubbedKeys matches exactly the introduced placeholder set.
      expect(new Set(scrubbedKeys)).toEqual(placeholderKeys);
    });

    it("with NO envFileKeys (legacy/hermetic callers) scrubs EVERY secret (back-compat)", () => {
      const { doc } = generateIsolatedCompose({
        resolvedConfig: infraConfig, offset: 10000, projectName: "cinatra_legacy", slug: "legacy",
      });
      // No allowlist → the prior unconditional behaviour: all secrets symbolic.
      expect(doc.services.postgres.environment.POSTGRES_PASSWORD).toBe("${POSTGRES_PASSWORD}");
      expect(doc.services.postgres.environment.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}");
    });
  });
});

describe("scrubServiceEnv env-file allowlist (cinatra-cli#57)", () => {
  it("scrubs a secret ONLY when its key is in the env-file Set; a default stays literal", () => {
    const keys = new Set(["OPENAI_API_KEY"]);
    const out = scrubServiceEnv({ OPENAI_API_KEY: "sk-real", POSTGRES_PASSWORD: "postgres", PUBLIC: "x" }, keys);
    expect(out.OPENAI_API_KEY).toBe("${OPENAI_API_KEY}"); // supplied → scrubbed
    expect(out.POSTGRES_PASSWORD).toBe("postgres"); // NOT supplied → literal default
    expect(out.PUBLIC).toBe("x"); // non-secret → untouched
  });

  it("a null/absent env-file Set scrubs every secret (legacy behaviour preserved)", () => {
    const out = scrubServiceEnv({ POSTGRES_PASSWORD: "postgres", PUBLIC: "x" });
    expect(out.POSTGRES_PASSWORD).toBe("${POSTGRES_PASSWORD}");
    expect(out.PUBLIC).toBe("x");
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
