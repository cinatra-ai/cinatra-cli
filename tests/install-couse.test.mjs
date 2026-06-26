// cinatra-cli#40 — co-use (shared-infra) pure helpers + the fail-closed
// capability gate. No I/O — every derivation, the env builder, the source-probe
// parser, the prereq gate, and the rollback plan are unit-tested in isolation
// (mirroring install-isolation.test.mjs).

import { describe, expect, it } from "vitest";

import {
  deriveCoUseSlug,
  coUseDbName,
  isCoUseDbNameShape,
  coUseQueueName,
  coUseRedisPrefix,
  coUseCookiePrefix,
  parseAuthCookiePrefixSupport,
  assertCoUsePrereqs,
  buildCoUseEnv,
  coUseRollbackPlan,
  COUSE_COOKIE_PREFIX_ENV,
  COUSE_REDIS_PREFIX_ENV,
} from "../src/install-couse.mjs";

describe("co-use name derivations", () => {
  it("deriveCoUseSlug prefers --instance, else the sanitised dir basename", () => {
    expect(deriveCoUseSlug("/home/u/My Cinatra B", {})).toBe("my-cinatra-b");
    expect(deriveCoUseSlug("/home/u/whatever", { instance: "alpha" })).toBe("alpha");
    expect(deriveCoUseSlug("/home/u/cinatra/", {})).toBe("cinatra");
  });

  it("coUseDbName maps to the cinatra_inst_<slug> shape (dashes → underscores)", () => {
    expect(coUseDbName("alpha")).toBe("cinatra_inst_alpha");
    expect(coUseDbName("my-inst")).toBe("cinatra_inst_my_inst");
    expect(isCoUseDbNameShape(coUseDbName("my-inst"))).toBe(true);
  });

  it("isCoUseDbNameShape fails CLOSED for anything not exactly a co-use DB name", () => {
    expect(isCoUseDbNameShape("cinatra")).toBe(false);
    expect(isCoUseDbNameShape("postgres")).toBe(false);
    expect(isCoUseDbNameShape("cinatra_clone_x")).toBe(false); // clone, not co-use
    expect(isCoUseDbNameShape("cinatra_inst_")).toBe(false); // empty suffix
    expect(isCoUseDbNameShape("cinatra_inst_-bad")).toBe(false); // bad leading char
    expect(isCoUseDbNameShape("")).toBe(false);
    expect(isCoUseDbNameShape(null)).toBe(false);
    expect(isCoUseDbNameShape("cinatra_inst_ok")).toBe(true);
  });

  it("coUseQueueName / coUseRedisPrefix / coUseCookiePrefix derive per-instance values", () => {
    expect(coUseQueueName("alpha")).toBe("cinatra-inst-alpha");
    expect(coUseRedisPrefix("alpha")).toBe("cinatra:alpha");
    expect(coUseCookiePrefix("alpha")).toBe("cinatra-alpha");
  });
});

describe("parseAuthCookiePrefixSupport — the capability probe core", () => {
  it("TRUE when src/lib/auth.ts wires advanced.cookiePrefix to the env var", () => {
    const src = `
      export const auth = betterAuth({
        appName: "Cinatra",
        advanced: { cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX?.trim() || "cinatra" },
      });`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(true);
  });

  it("TRUE for the bracket env-access form too", () => {
    const src = `betterAuth({ advanced: { cookiePrefix: process.env["BETTER_AUTH_COOKIE_PREFIX"] } })`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(true);
  });

  it("FALSE for the current app (no cookiePrefix at all)", () => {
    const src = `export const auth = betterAuth({ appName: "Cinatra", database: pool });`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(false);
  });

  it("FALSE when cookiePrefix is mentioned but NOT env-driven (no per-instance isolation)", () => {
    const src = `betterAuth({ advanced: { cookiePrefix: "cinatra" } })`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(false);
  });

  it("FALSE when cookiePrefix and the env name CO-OCCUR but are NOT a single assignment (codex Q1)", () => {
    // `cookiePrefix` is a static literal here; the env var is read elsewhere for
    // an unrelated purpose. A naive co-location grep would false-positive — the
    // assignment-bound regex must not.
    const src = `
      const base = process.env.BETTER_AUTH_COOKIE_PREFIX; // unrelated read
      betterAuth({ advanced: { cookiePrefix: "cinatra" } });`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(false);
  });

  it("TRUE with a trailing ?.trim() || fallback on the env assignment", () => {
    const src = `betterAuth({ advanced: { cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX?.trim() || "cinatra" } })`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(true);
  });

  it("FALSE when the support is only in a COMMENT (not real code)", () => {
    const src = `// advanced: { cookiePrefix: process.env.BETTER_AUTH_COOKIE_PREFIX }\nbetterAuth({})`;
    expect(parseAuthCookiePrefixSupport(src)).toBe(false);
  });

  it("FALSE (fail closed) for null / empty / non-string source", () => {
    expect(parseAuthCookiePrefixSupport(null)).toBe(false);
    expect(parseAuthCookiePrefixSupport("")).toBe(false);
    expect(parseAuthCookiePrefixSupport(undefined)).toBe(false);
  });
});

describe("assertCoUsePrereqs — fail-closed gate", () => {
  it("THROWS the upstream pointer when cookie-prefix is unsupported", () => {
    expect(() => assertCoUsePrereqs({ cookiePrefixSupported: false })).toThrow(
      /does NOT isolate auth cookies per instance/,
    );
    // The message names the exact app change needed.
    expect(() => assertCoUsePrereqs({ cookiePrefixSupported: false })).toThrow(
      new RegExp(`process\\.env\\.${COUSE_COOKIE_PREFIX_ENV}`),
    );
  });

  it("PASSES when cookie-prefix is supported and Graphiti is not shared", () => {
    expect(() => assertCoUsePrereqs({ cookiePrefixSupported: true })).not.toThrow();
  });

  it("THROWS on shared Graphiti without --allow-shared-graphiti", () => {
    expect(() =>
      assertCoUsePrereqs({ cookiePrefixSupported: true, graphitiShared: true, allowSharedGraphiti: false }),
    ).toThrow(/Graphiti\/Neo4j is NOT instance-namespaced/);
  });

  it("PASSES on shared Graphiti WITH the eyes-open flag", () => {
    expect(() =>
      assertCoUsePrereqs({ cookiePrefixSupported: true, graphitiShared: true, allowSharedGraphiti: true }),
    ).not.toThrow();
  });

  it("cookie-prefix gate takes precedence over Graphiti (fail closed on the hard blocker first)", () => {
    expect(() =>
      assertCoUsePrereqs({ cookiePrefixSupported: false, graphitiShared: true, allowSharedGraphiti: true }),
    ).toThrow(/does NOT isolate auth cookies/);
  });
});

describe("buildCoUseEnv — the pure env-map builder", () => {
  const sourceEnv = {
    SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:5434/postgres",
    REDIS_URL: "redis://127.0.0.1:6379",
    NANGO_SERVER_URL: "http://127.0.0.1:3003",
    GRAPHITI_URL: "http://127.0.0.1:8000",
    BETTER_AUTH_SECRET: "donor-secret",
    CINATRA_ENCRYPTION_KEY: "donor-enc-key",
  };
  const dbUrl = "postgresql://u:p@127.0.0.1:5434/cinatra_inst_alpha";

  it("sets the SEPARATE DB url + schema, app port, queue, cookie-prefix, redis-prefix", () => {
    const env = buildCoUseEnv({ sourceEnv, slug: "alpha", appPort: 3300, dbUrl });
    expect(env.SUPABASE_DB_URL).toBe(dbUrl); // separate DB, not the donor's
    expect(env.SUPABASE_SCHEMA).toBe("cinatra");
    expect(env.PORT).toBe("3300");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3300");
    expect(env.NEXT_PUBLIC_BETTER_AUTH_URL).toBe("http://localhost:3300");
    expect(env.BULLMQ_QUEUE_NAME).toBe("cinatra-inst-alpha");
    expect(env[COUSE_COOKIE_PREFIX_ENV]).toBe("cinatra-alpha");
    expect(env[COUSE_REDIS_PREFIX_ENV]).toBe("cinatra:alpha");
  });

  it("INHERITS the shared-infra endpoints + crypto secrets from the donor", () => {
    const env = buildCoUseEnv({ sourceEnv, slug: "alpha", appPort: 3300, dbUrl });
    expect(env.REDIS_URL).toBe(sourceEnv.REDIS_URL); // shared infra is the point
    expect(env.NANGO_SERVER_URL).toBe(sourceEnv.NANGO_SERVER_URL);
    expect(env.GRAPHITI_URL).toBe(sourceEnv.GRAPHITI_URL);
    expect(env.BETTER_AUTH_SECRET).toBe("donor-secret"); // clone-parity
    expect(env.CINATRA_ENCRYPTION_KEY).toBe("donor-enc-key");
  });

  it("does NOT point the co-use DB url at the donor's database", () => {
    const env = buildCoUseEnv({ sourceEnv, slug: "alpha", appPort: 3300, dbUrl });
    expect(env.SUPABASE_DB_URL).not.toBe(sourceEnv.SUPABASE_DB_URL);
    expect(env.SUPABASE_DB_URL).toMatch(/\/cinatra_inst_alpha$/);
  });

  it("rejects an invalid slug / appPort / dbUrl", () => {
    expect(() => buildCoUseEnv({ sourceEnv, slug: "Bad Slug", appPort: 3300, dbUrl })).toThrow(/valid slug/);
    expect(() => buildCoUseEnv({ sourceEnv, slug: "alpha", appPort: 80000, dbUrl })).toThrow(/valid appPort/);
    expect(() => buildCoUseEnv({ sourceEnv, slug: "alpha", appPort: 3300, dbUrl: "" })).toThrow(/non-empty dbUrl/);
  });
});

describe("coUseRollbackPlan — ordered teardown", () => {
  it("drops the DB (created this run) FIRST, then releases the slot", () => {
    const plan = coUseRollbackPlan({ createdDb: true, dbName: "cinatra_inst_alpha" });
    expect(plan.map((s) => s.step)).toEqual(["dropDatabase", "releaseInstanceSlot"]);
    expect(plan[0]).toMatchObject({ dbName: "cinatra_inst_alpha", createdThisRun: true });
  });

  it("does NOT include a DROP step when the DB was not created this run", () => {
    const plan = coUseRollbackPlan({ createdDb: false, dbName: "cinatra_inst_alpha" });
    expect(plan.map((s) => s.step)).toEqual(["releaseInstanceSlot"]);
  });

  it("includes a runtime-dir removal step when given one", () => {
    const plan = coUseRollbackPlan({ createdDb: true, dbName: "cinatra_inst_alpha", runtimeDir: "/tmp/rt" });
    expect(plan.map((s) => s.step)).toEqual(["dropDatabase", "removeRuntimeDir", "releaseInstanceSlot"]);
  });

  it("REFUSES to plan a DROP of a non-co-use-shaped name (defence-in-depth)", () => {
    expect(() => coUseRollbackPlan({ createdDb: true, dbName: "cinatra" })).toThrow(/non-co-use-shaped/);
    expect(() => coUseRollbackPlan({ createdDb: true, dbName: "postgres" })).toThrow(/non-co-use-shaped/);
  });
});
