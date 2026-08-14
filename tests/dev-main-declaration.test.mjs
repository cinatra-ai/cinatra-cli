// Auto-declaration of the reserved dev-main tunnel identity.
//
// THE REGRESSION: the tunnel-identity classifier is fail-closed — it never
// falls through to the reserved main hostname. That protects a multi-instance
// host, but it stranded the plain single-instance dev install: default
// database, default schema, no declaration, therefore no sanctioned identity
// and no auto-derived Funnel URL. The installer already knows the one value
// that resolves it, so it declares it.
//
// What this suite pins:
//   1. the canonical single-instance main install DOES declare, and declares
//      its own endpoint fingerprint;
//   2. every case that must NOT declare — an existing declaration (idempotence),
//      a registered clone, a schema-isolated worktree, a production instance,
//      an unfingerprintable database URL;
//   3. the declared value round-trips through the CONNECTOR'S OWN classifier
//      back to `kind: "main"` / `hostname: "cinatra-main"` — the actual
//      behaviour the operator lost, asserted against a faithful stand-in for
//      the published classifier rather than against our own restatement of it;
//   4. the I/O wrapper writes the key into `.env.local` exactly once, leaves a
//      pre-existing declaration untouched, and publishes the value into the
//      in-memory env so the SAME setup run can derive a URL from it.

import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEV_MAIN_DECLARATION_VAR,
  planDevMainDeclaration,
} from "../src/dev-main-declaration.mjs";
import { ensureDevMainDeclaration } from "../src/index.mjs";

const CANONICAL_ENDPOINT = "127.0.0.1:5434/postgres";

// ---------------------------------------------------------------------------
// A faithful stand-in for the two connector functions this feature depends on.
//
// The real ones live in the tailscale connector's `tailscale-hostname` module,
// which is an on-disk extension this standalone repo does not carry. These
// copies cover exactly the inputs the assertions below use, and they exist so
// (3) can prove the ROUND TRIP — declare a value, feed it back to a classifier
// with the connector's contract, get the reserved identity — instead of merely
// restating what our own planner just returned.
// ---------------------------------------------------------------------------

/** `host:port/database`, default port filled in, userinfo discarded. */
function parseDatabaseEndpoint(dbUrl) {
  const raw = String(dbUrl ?? "").trim();
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd <= 0) return "";
  if (!["postgres", "postgresql"].includes(raw.slice(0, schemeEnd).toLowerCase())) return "";
  if (/[?&](host|hostaddr|port|dbname)=/i.test(raw)) return "";
  const afterScheme = raw.slice(schemeEnd + 3);
  const beforeQuery = afterScheme.split(/[?#]/)[0];
  const slash = beforeQuery.indexOf("/");
  if (slash < 0) return "";
  const database = beforeQuery.slice(slash + 1).replace(/\/$/, "");
  if (!database || database.includes("/")) return "";
  const authority = beforeQuery.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (!hostPort) return "";
  const colon = hostPort.indexOf(":");
  const host = colon >= 0 ? hostPort.slice(0, colon) : hostPort;
  const port = colon >= 0 ? hostPort.slice(colon + 1) : "5432";
  if (!host || !/^[1-9]\d{0,4}$/.test(port)) return "";
  return `${host.toLowerCase()}:${port}/${database}`;
}

/** The classifier's contract, reduced to the branches this feature reaches. */
function classifyDevTailscaleIdentity({ dbUrl, schema, mainDatabase }) {
  const endpoint = parseDatabaseEndpoint(dbUrl);
  const raw = String(mainDatabase ?? "").trim();
  const declared = raw.includes("/") ? parseDatabaseEndpoint(`postgresql://${raw}`) : "";
  const schemaName = String(schema ?? "").trim();
  const database = endpoint.slice(endpoint.lastIndexOf("/") + 1);
  const cloneSlug = database.match(/^cinatra_clone_(.+)$/)?.[1] ?? "";
  const schemaSlug = schemaName.match(/^cinatra_(.+)$/)?.[1] ?? "";

  if (declared !== "" && endpoint !== "" && declared === endpoint) {
    if (cloneSlug || schemaSlug) return { ok: false, kind: "conflict", hostname: null };
    return { ok: true, kind: "main", hostname: "cinatra-main" };
  }
  if (cloneSlug) {
    return { ok: true, kind: "clone", hostname: `cinatra-clone-${cloneSlug.replace(/_/g, "-")}` };
  }
  if (schemaSlug) {
    return { ok: true, kind: "schema", hostname: `cinatra-${schemaSlug.replace(/_/g, "-")}` };
  }
  return { ok: false, kind: "unregistered", hostname: null };
}

describe("planDevMainDeclaration — the canonical single-instance main install", () => {
  it("declares this instance's own endpoint", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: CANONICAL_ENDPOINT,
      schema: "",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(true);
    expect(plan.code).toBe("canonical-main");
    expect(plan.key).toBe(DEV_MAIN_DECLARATION_VAR);
    expect(plan.value).toBe(CANONICAL_ENDPOINT);
  });

  it("treats the explicit default schema exactly like an unset one", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: CANONICAL_ENDPOINT,
      schema: "cinatra",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(true);
  });

  it("declares a non-default database name that is not a clone database", () => {
    // A canonical install is identified by what it is NOT (a clone, a
    // schema-isolated worktree) — not by the literal name `postgres`.
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: "db.internal:5432/cinatra_app",
      schema: "",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(true);
    expect(plan.value).toBe("db.internal:5432/cinatra_app");
  });
});

describe("planDevMainDeclaration — the cases that must NOT declare", () => {
  it("never clobbers an existing declaration", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: CANONICAL_ENDPOINT,
      schema: "",
      existingDeclaration: "10.0.0.9:5432/postgres",
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("already-declared");
    expect(plan.value).toBeNull();
  });

  it("leaves a declaration that already names this very endpoint alone", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: CANONICAL_ENDPOINT,
      schema: "",
      existingDeclaration: CANONICAL_ENDPOINT,
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("already-declared");
  });

  it("skips a registered clone", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: "127.0.0.1:5434/cinatra_clone_optimizations",
      schema: "",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("registered-clone");
  });

  it("skips a schema-isolated worktree", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: CANONICAL_ENDPOINT,
      schema: "cinatra_worktree_preview_a",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("schema-isolated");
  });

  it("skips a production instance", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "production",
      endpoint: CANONICAL_ENDPOINT,
      schema: "",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("not-development");
  });

  it("skips an unfingerprintable database URL", () => {
    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: "",
      schema: "",
      existingDeclaration: null,
    });

    expect(plan.declare).toBe(false);
    expect(plan.code).toBe("endpoint-unresolved");
  });

  it("is total — it never throws on absent input", () => {
    expect(() => planDevMainDeclaration()).not.toThrow();
    expect(planDevMainDeclaration().declare).toBe(false);
  });
});

describe("the declared value round-trips through the classifier", () => {
  it("flips a canonical install from unregistered to the reserved main identity", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5434/postgres";

    const before = classifyDevTailscaleIdentity({ dbUrl, schema: "", mainDatabase: null });
    expect(before.ok).toBe(false);
    expect(before.kind).toBe("unregistered");

    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: parseDatabaseEndpoint(dbUrl),
      schema: "",
      existingDeclaration: null,
    });
    expect(plan.declare).toBe(true);

    const after = classifyDevTailscaleIdentity({
      dbUrl,
      schema: "",
      mainDatabase: plan.value,
    });
    expect(after.ok).toBe(true);
    expect(after.kind).toBe("main");
    expect(after.hostname).toBe("cinatra-main");
  });

  it("leaves a clone on its own identity — the declaration is never written for it", () => {
    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:5434/cinatra_clone_lane_a";

    const plan = planDevMainDeclaration({
      runtimeMode: "development",
      endpoint: parseDatabaseEndpoint(dbUrl),
      schema: "",
      existingDeclaration: null,
    });
    expect(plan.declare).toBe(false);

    const identity = classifyDevTailscaleIdentity({ dbUrl, schema: "", mainDatabase: null });
    expect(identity.ok).toBe(true);
    expect(identity.kind).toBe("clone");
    expect(identity.hostname).not.toBe("cinatra-main");
  });
});

describe("ensureDevMainDeclaration — the env-file write", () => {
  /** Run the wrapper against a throwaway checkout root. */
  async function run({ envBody, env, schemaName = "", dbUrl }) {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "cinatra-declare-"));
    try {
      writeFileSync(path.join(repoRoot, ".env.local"), envBody);
      const outcome = await ensureDevMainDeclaration({
        repoRoot,
        env,
        dbUrl,
        schemaName,
        deps: {
          loadTailscaleHostnameModule: async () => ({ parseDatabaseEndpoint }),
          log: () => {},
        },
      });
      return { outcome, body: readFileSync(path.join(repoRoot, ".env.local"), "utf8") };
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }

  it("writes the declaration for a canonical install and publishes it into the live env", async () => {
    const env = { CINATRA_RUNTIME_MODE: "development" };
    const { outcome, body } = await run({
      envBody: "SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5434/postgres\n",
      env,
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    });

    expect(outcome.declared).toBe(true);
    expect(body).toContain(`${DEV_MAIN_DECLARATION_VAR}=${CANONICAL_ENDPOINT}\n`);
    // The SAME run must see it — otherwise the first install still ends with no
    // auto-derived URL and the operator has to run setup twice.
    expect(env[DEV_MAIN_DECLARATION_VAR]).toBe(CANONICAL_ENDPOINT);
  });

  it("leaves an operator-set declaration byte-untouched", async () => {
    const envBody = `${DEV_MAIN_DECLARATION_VAR}=10.0.0.9:5432/postgres\n`;
    const { outcome, body } = await run({
      envBody,
      env: {
        CINATRA_RUNTIME_MODE: "development",
        [DEV_MAIN_DECLARATION_VAR]: "10.0.0.9:5432/postgres",
      },
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    });

    expect(outcome.declared).toBe(false);
    expect(outcome.code).toBe("already-declared");
    expect(body).toBe(envBody);
  });

  it("writes nothing for a schema-isolated worktree", async () => {
    const envBody = "SUPABASE_SCHEMA=cinatra_worktree_preview_a\n";
    const { outcome, body } = await run({
      envBody,
      env: { CINATRA_RUNTIME_MODE: "development" },
      schemaName: "cinatra_worktree_preview_a",
      dbUrl: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
    });

    expect(outcome.declared).toBe(false);
    expect(outcome.code).toBe("schema-isolated");
    expect(body).toBe(envBody);
  });

  it("degrades quietly when the identity helper is not installed", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "cinatra-declare-"));
    try {
      writeFileSync(path.join(repoRoot, ".env.local"), "");
      const missing = new Error("no declarer");
      missing.cinatraDevCliDeclarerMissing = true;
      const outcome = await ensureDevMainDeclaration({
        repoRoot,
        env: { CINATRA_RUNTIME_MODE: "development" },
        dbUrl: "postgresql://postgres:postgres@127.0.0.1:5434/postgres",
        schemaName: "",
        deps: {
          loadTailscaleHostnameModule: async () => {
            throw missing;
          },
          log: () => {},
        },
      });

      expect(outcome.declared).toBe(false);
      expect(outcome.code).toBe("declarer-unresolvable");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
