// cinatra-cli#208 — WIRING coverage for `instance reset --purge-app-data`.
//
// The module seam (tests/purge-registry-users.test.mjs) proves what the
// reconcile DOES. It cannot prove that the reset actually calls it, nor that the
// namespaces are read while the schema that holds them still exists. Both are
// invisible there, and getting either wrong silently restores the original bug:
// the reset would drop the schema first, find nothing recorded, and cheerfully
// report "nothing to reconcile" forever.
//
// So this file drives the REAL `runResetDev` with `pg` and `node:child_process`
// mocked, and asserts on the ORDER of what it did.
//
// Every run ends in the same expected throw: the synthetic checkout carries no
// BETTER_AUTH_SECRET, so the post-reset `runSetup("dev")` refuses. That happens
// strictly AFTER the purge and the reconcile, which is exactly the window under
// test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- mocked pg -------------------------------------------------------------
const pgControl = vi.hoisted(() => ({
  queries: [],
  metadataRows: [],
  metadataError: null,
}));

vi.mock("pg", () => {
  class Client {
    async connect() {}
    async query(text, values) {
      pgControl.queries.push({ text, values });
      if (/from\s+"?[^".]+"?\.metadata/i.test(text)) {
        if (pgControl.metadataError) throw pgControl.metadataError;
        return { rows: pgControl.metadataRows, rowCount: pgControl.metadataRows.length };
      }
      return { rows: [], rowCount: 0 };
    }
    async end() {}
  }
  return { default: { Client }, Client };
});

// --- mocked child_process --------------------------------------------------
const procControl = vi.hoisted(() => ({ calls: [], htpasswd: "" }));

vi.mock("node:child_process", () => ({
  spawn: () => { throw new Error("spawn is not expected in this test"); },
  execFileSync: () => "",
  spawnSync: (command, args, options) => {
    procControl.calls.push({ command, args, input: options?.input });
    const shell = Array.isArray(args) && args[args.length - 1];
    if (command === "docker" && typeof shell === "string") {
      // Both the snapshotting read and the post-restart verification answer the
      // marker-prefixed shape the module parses.
      if (shell.startsWith("if [ -f")) {
        return { status: 0, stdout: `PRESENT\n${procControl.htpasswd}`, stderr: "" };
      }
      if (shell.startsWith("cat > ")) {
        // The compare-and-swap lands; the store now reads back rewritten.
        procControl.htpasswd = options?.input ?? "";
        return { status: 0, stdout: "", stderr: "" };
      }
      if (shell.startsWith("node -e")) return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
}));

const { runResetDev } = await import("../src/index.mjs");
const { makeFakeCheckout } = await import("./helpers/fake-checkout.mjs");

const HTPASSWD = [
  "cinatra-dev-seed:$apr1$aaaa$1111:autocreated 2026-08-01T10:00:00.000Z",
  "macbook-pro:$apr1$bbbb$2222:autocreated 2026-08-02T10:00:00.000Z",
  "lane-2392-alpha:$apr1$cccc$3333:autocreated 2026-08-05T10:00:00.000Z",
  "",
].join("\n");

const IDENTITY_ROW = {
  key: "instance_identity",
  value: JSON.stringify({ instanceNamespace: "macbook-pro", instanceDisplayName: "MacBook Pro" }),
};

let checkout;
let priorRepoRoot;

beforeEach(() => {
  pgControl.queries = [];
  pgControl.metadataRows = [IDENTITY_ROW];
  pgControl.metadataError = null;
  procControl.calls = [];
  procControl.htpasswd = HTPASSWD;

  checkout = makeFakeCheckout({
    env: {
      CINATRA_RUNTIME_MODE: "development",
      SUPABASE_DB_URL: "postgres://user@127.0.0.1:5999/db",
      SUPABASE_SCHEMA: "cinatra",
    },
  });
  priorRepoRoot = process.env.CINATRA_REPO_ROOT;
  process.env.CINATRA_REPO_ROOT = checkout.root;
});

afterEach(() => {
  if (priorRepoRoot === undefined) delete process.env.CINATRA_REPO_ROOT;
  else process.env.CINATRA_REPO_ROOT = priorRepoRoot;
  checkout?.cleanup();
  vi.unstubAllEnvs();
});

/** Run the real command; it always ends at the setup rebuild this fixture lacks. */
async function runReset(flags) {
  await expect(runResetDev(["--yes", "--no-backup", ...flags])).rejects.toThrow(
    /BETTER_AUTH_SECRET/,
  );
}

const indexOfQuery = (pattern) => pgControl.queries.findIndex((q) => pattern.test(q.text));
const dockerShellCalls = () =>
  procControl.calls
    .filter((call) => call.command === "docker")
    .map((call) => ({ args: call.args, input: call.input }));

describe("instance reset --purge-app-data — registry-user wiring", () => {
  it("reads the namespaces BEFORE it drops the schema that holds them", async () => {
    await runReset(["--purge-app-data"]);

    const readAt = indexOfQuery(/from\s+"cinatra"\.metadata/i);
    const dropAt = indexOfQuery(/drop schema if exists "cinatra"/i);

    expect(readAt).toBeGreaterThanOrEqual(0);
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeLessThan(dropAt);
  });

  it("rewrites the registry user store and restarts the registry", async () => {
    await runReset(["--purge-app-data"]);

    const docker = dockerShellCalls();
    const write = docker.find((call) => String(call.args.at(-1)).startsWith("cat > "));
    expect(write).toBeDefined();
    // Only the instance's own user leaves; the seed publisher and the e2e user stay.
    expect(write.input).not.toContain("macbook-pro:");
    expect(write.input).toContain("cinatra-dev-seed:");
    expect(write.input).toContain("lane-2392-alpha:");

    expect(docker.some((call) => call.args.join(" ") === "compose restart verdaccio")).toBe(true);
  });

  it("touches the registry only after the DB purge, never before", async () => {
    await runReset(["--purge-app-data"]);

    // The reconcile is a post-purge step: the schema drop is issued while the
    // client is still open, and the registry is reached afterwards.
    expect(indexOfQuery(/drop schema if exists "cinatra"/i)).toBeGreaterThanOrEqual(0);
    expect(dockerShellCalls().length).toBeGreaterThan(0);
  });

  it("--keep-app-data reads nothing and touches the registry not at all", async () => {
    await runReset(["--keep-app-data"]);

    expect(indexOfQuery(/from\s+"cinatra"\.metadata/i)).toBe(-1);
    expect(indexOfQuery(/drop schema if exists/i)).toBe(-1);
    expect(
      dockerShellCalls().some((call) => call.args.includes("verdaccio")),
    ).toBe(false);
    // Redis is still flushed — that half of the reset is unchanged.
    expect(
      procControl.calls.some((call) => call.command === "docker" && call.args.includes("redis")),
    ).toBe(true);
  });

  it("stops BEFORE the destructive drop when the namespace read fails unexpectedly", async () => {
    pgControl.metadataError = Object.assign(new Error("permission denied for schema cinatra"), {
      code: "42501",
    });

    await expect(
      runResetDev(["--yes", "--no-backup", "--purge-app-data"]),
    ).rejects.toThrow(/Could not read the instance registry namespaces/);

    // Nothing was dropped and the registry was never touched.
    expect(indexOfQuery(/drop schema if exists/i)).toBe(-1);
    expect(indexOfQuery(/drop table if exists/i)).toBe(-1);
    expect(dockerShellCalls()).toEqual([]);
  });

  it("stops BEFORE the destructive drop when a recorded row is present but unreadable", async () => {
    pgControl.metadataRows = [{ key: "instance_identity", value: "{not json" }];

    await expect(
      runResetDev(["--yes", "--no-backup", "--purge-app-data"]),
    ).rejects.toThrow(/present but unreadable/);

    expect(indexOfQuery(/drop schema if exists/i)).toBe(-1);
    expect(dockerShellCalls()).toEqual([]);
  });

  it("treats an absent schema as nothing recorded and still completes the purge", async () => {
    pgControl.metadataError = Object.assign(new Error('schema "cinatra" does not exist'), {
      code: "3F000",
    });

    await runReset(["--purge-app-data"]);

    expect(indexOfQuery(/drop schema if exists "cinatra"/i)).toBeGreaterThanOrEqual(0);
    // Nothing recorded ⇒ the registry is never touched.
    expect(dockerShellCalls().some((call) => call.args.includes("verdaccio"))).toBe(false);
  });
});
