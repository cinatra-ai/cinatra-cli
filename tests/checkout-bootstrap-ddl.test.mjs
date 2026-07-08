// Regression for cinatra#1136 (a): `cinatra instance refresh` / `instance
// setup` ran the versioned core migration chain with only the CLI's BUNDLED
// schema baseline applied — on the update path (database provisioned by the
// previous release, code moved to the current head) the chain EXECUTES and
// aborts on tables/columns that only the CHECKOUT's schema bootstrap creates
// (observed: `relation "nango_connection" does not exist`; on a never-booted
// setup, `column "template_id" does not exist`). A plain boot self-heals
// because the boot path applies the checkout bootstrap DDL FIRST — setup must
// reconcile in the same order.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  applyCheckoutBootstrapDdl,
  checkoutResolvesTsx,
  resolveCheckoutDdlSource,
} from "../src/checkout-bootstrap-ddl.mjs";

function makeCheckout(withDdlSource) {
  const root = mkdtempSync(path.join(tmpdir(), "cinatra-1136-ddl-"));
  writeFileSync(path.join(root, "package.json"), `{"name":"cinatra"}\n`);
  if (withDdlSource) {
    mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "lib", "drizzle-store.ts"),
      "export function buildCreateStoreSchemaQueries() { return []; }\n",
    );
  }
  return root;
}

describe("resolveCheckoutDdlSource / checkoutResolvesTsx", () => {
  it("resolves <repoRoot>/src/lib/drizzle-store.ts when present, null when absent", () => {
    const withSrc = makeCheckout(true);
    const withoutSrc = makeCheckout(false);
    try {
      expect(resolveCheckoutDdlSource(withSrc)).toBe(
        path.join(withSrc, "src", "lib", "drizzle-store.ts"),
      );
      expect(resolveCheckoutDdlSource(withoutSrc)).toBeNull();
    } finally {
      rmSync(withSrc, { recursive: true, force: true });
      rmSync(withoutSrc, { recursive: true, force: true });
    }
  });

  it("checkoutResolvesTsx reflects the injected resolver outcome", () => {
    const root = makeCheckout(false);
    try {
      expect(checkoutResolvesTsx(root, { resolve: () => "/fake/tsx" })).toBe(true);
      expect(
        checkoutResolvesTsx(root, {
          resolve: () => {
            throw new Error("not found");
          },
        }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyCheckoutBootstrapDdl — decision policy", () => {
  const quiet = { log: () => {}, warn: () => {} };

  it("no checkout DDL source (baked runtime image) → quiet skip, never spawns", () => {
    const root = makeCheckout(false);
    const runs = [];
    try {
      const r = applyCheckoutBootstrapDdl({
        repoRoot: root,
        connectionString: "postgres://x",
        schemaName: "cinatra",
        ...quiet,
        deps: { run: (...a) => runs.push(a) },
      });
      expect(r).toEqual({ status: "skipped", reason: "no-ddl-source" });
      expect(runs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source present but the checkout does not resolve tsx → warned skip, never spawns", () => {
    const root = makeCheckout(true);
    const runs = [];
    try {
      const r = applyCheckoutBootstrapDdl({
        repoRoot: root,
        connectionString: "postgres://x",
        schemaName: "cinatra",
        ...quiet,
        deps: {
          run: (...a) => runs.push(a),
          resolve: () => {
            throw new Error("tsx not installed");
          },
        },
      });
      expect(r).toEqual({ status: "skipped", reason: "no-tsx" });
      expect(runs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source present + no tsx + required (dev setup/refresh) → fails EARLY with the install remediation", () => {
    const root = makeCheckout(true);
    const runs = [];
    try {
      expect(() =>
        applyCheckoutBootstrapDdl({
          repoRoot: root,
          connectionString: "postgres://x",
          schemaName: "cinatra",
          required: true,
          ...quiet,
          deps: {
            run: (...a) => runs.push(a),
            resolve: () => {
              throw new Error("tsx not installed");
            },
          },
        }),
      ).toThrow(/does not resolve `tsx`/);
      expect(runs).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("source + tsx → spawns `node --import tsx <entry>` at the checkout root with the DB env", () => {
    const root = makeCheckout(true);
    const runs = [];
    try {
      const r = applyCheckoutBootstrapDdl({
        repoRoot: root,
        connectionString: "postgres://db-under-test",
        schemaName: "cinatra_w6",
        ...quiet,
        deps: {
          run: (cmd, args, options) => runs.push({ cmd, args, options }),
          resolve: () => "/fake/tsx",
        },
      });
      expect(r).toEqual({ status: "applied" });
      expect(runs).toHaveLength(1);
      const { cmd, args, options } = runs[0];
      expect(cmd).toBe(process.execPath);
      expect(args.slice(0, 2)).toEqual(["--import", "tsx"]);
      expect(path.basename(args[2])).toBe("checkout-bootstrap-ddl-entry.mjs");
      expect(options.cwd).toBe(root);
      expect(options.env.SUPABASE_DB_URL).toBe("postgres://db-under-test");
      expect(options.env.SUPABASE_SCHEMA).toBe("cinatra_w6");
      expect(options.env.CINATRA_CHECKOUT_DDL_SOURCE).toBe(
        path.join(root, "src", "lib", "drizzle-store.ts"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a FAILED DDL run throws (the chain must not start on a half-bootstrapped schema)", () => {
    const root = makeCheckout(true);
    try {
      expect(() =>
        applyCheckoutBootstrapDdl({
          repoRoot: root,
          connectionString: "postgres://x",
          schemaName: "cinatra",
          ...quiet,
          deps: {
            run: () => {
              throw new Error("exit 1");
            },
            resolve: () => "/fake/tsx",
          },
        }),
      ).toThrow(/Checkout bootstrap DDL failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSetup ordering contract (source-shape regression)", () => {
  it("applies bundled baseline → checkout bootstrap DDL → versioned chain, in that order", () => {
    const indexPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "src",
      "index.mjs",
    );
    const source = readFileSync(indexPath, "utf8");
    const start = source.indexOf("async function runSetup(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nasync function ", start + 1);
    const body = source.slice(start, end === -1 ? undefined : end);

    const bundled = body.indexOf("await ensureStoreSchema(client, schemaName);");
    const checkoutDdl = body.indexOf("applyCheckoutBootstrapDdl({");
    const chain = body.indexOf("await runCoreMigrations({");
    expect(bundled).toBeGreaterThan(-1);
    expect(checkoutDdl).toBeGreaterThan(-1);
    expect(chain).toBeGreaterThan(-1);
    // The exact defect: the chain must NEVER run before the checkout's own
    // bootstrap DDL on the setup/refresh path.
    expect(bundled).toBeLessThan(checkoutDdl);
    expect(checkoutDdl).toBeLessThan(chain);
  });
});
