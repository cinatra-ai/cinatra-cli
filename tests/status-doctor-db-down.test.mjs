// cinatra-cli#93 — `cinatra status` / `cinatra doctor` must NOT crash bare when
// the local instance DB is down or un-migrated (real-host sweep repro: a
// naked `connect ECONNREFUSED 127.0.0.1:5434`, exit 1, no
// remediation). Both commands must render an ACTIONABLE degraded report
// (mirroring `runExtensionsVerifyProd`'s soft `dbError` pattern) and still exit
// non-zero.
//
// Coverage:
//   - REAL child-process runs of `bin/cinatra.mjs status|doctor` against a
//     fake checkout + a genuinely dead 127.0.0.1 port (the exact live repro).
//   - IN-PROCESS runs of the exported `runStatus` / `runDoctor` with a mocked
//     `pg` Client for the reachable-but-un-migrated class (42P01), which needs
//     a DB that accepts the connection — hermetic, no live Postgres.
//   - Unit tests for the #93 helpers (secret boundary: `describeDbTarget`
//     never leaks credentials; the not-migrated classifier stays narrow; the
//     degraded doctor report maps to NO `--fix` auto-remediation).

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

// Mocked `pg` for the IN-PROCESS tests only (child processes load the real
// `pg`). Behavior is driven per-test through `pgControl`.
const pgControl = vi.hoisted(() => ({ connectError: null, queryError: null }));
vi.mock("pg", () => {
  class Client {
    async connect() {
      if (pgControl.connectError) throw pgControl.connectError;
    }
    async query() {
      if (pgControl.queryError) throw pgControl.queryError;
      return { rows: [], rowCount: 0 };
    }
    async end() {}
  }
  return { default: { Client }, Client };
});

import {
  runStatus,
  runDoctor,
  describeDbTarget,
  isDbUnreachableError,
  isDbNotMigratedError,
  buildDbDownDoctorReport,
  buildDbDownStatusReport,
  planDoctorFixActions,
} from "../src/index.mjs";

import { makeFakeCheckout } from "./helpers/fake-checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "bin", "cinatra.mjs");

// A port that nothing listens on: bind an ephemeral listener, note the port,
// close it. (Same class of guarantee the suite's fixed `5999` relies on, but
// collision-free.)
async function getDeadPort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pgError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// --- REAL child-process repro: DB down (the eng#513 evidence-15/16 shape) ---

describe("cinatra status — local DB unreachable (child process, real dead port)", () => {
  it("prints a degraded machine-readable JSON report with a hint and exits 1 (no bare ECONNREFUSED crash)", async () => {
    const port = await getDeadPort();
    const dbCred = ["cinatra", "super-secret-pass"].join(":"); // runtime-joined: keeps the DSN literal out of source (secret-scan)
    const dbUrl = `postgres://${dbCred}@127.0.0.1:${port}/cinatra`;
    const checkout = makeFakeCheckout();
    try {
      const res = spawnSync(process.execPath, [BIN, "status"], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CINATRA_REPO_ROOT: checkout.root,
          SUPABASE_DB_URL: dbUrl,
          SUPABASE_SCHEMA: "cinatra",
        },
      });
      expect(res.status).toBe(1);
      // The old failure mode: stdout empty, stderr a bare `connect ECONNREFUSED`.
      const payload = JSON.parse(res.stdout);
      expect(payload.dbStatus).toBe("unreachable");
      expect(payload.dbTarget).toBe(`127.0.0.1:${port}`);
      expect(payload.dbError).toMatch(/ECONNREFUSED/);
      expect(payload.hint).toContain("cinatra install");
      expect(payload.hint).toContain("re-run `cinatra status`");
      // Secret boundary: the connection string's credentials never surface.
      expect(res.stdout).not.toContain("super-secret-pass");
      expect(res.stderr).not.toContain("super-secret-pass");
    } finally {
      checkout.cleanup();
    }
  });
});

describe("cinatra doctor — local DB unreachable (child process, real dead port)", () => {
  it("renders the standard doctor report with a FAIL finding + remediation and exits 1", async () => {
    const port = await getDeadPort();
    const dbCred = ["cinatra", "super-secret-pass"].join(":"); // runtime-joined: keeps the DSN literal out of source (secret-scan)
    const dbUrl = `postgres://${dbCred}@127.0.0.1:${port}/cinatra`;
    const checkout = makeFakeCheckout();
    try {
      const res = spawnSync(process.execPath, [BIN, "doctor"], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          CINATRA_REPO_ROOT: checkout.root,
          SUPABASE_DB_URL: dbUrl,
          SUPABASE_SCHEMA: "cinatra",
        },
      });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("Cinatra content-editor write-path self-check:");
      expect(res.stdout).toContain(`Instance DB unreachable at 127.0.0.1:${port}`);
      expect(res.stdout).toContain("start the local stack");
      expect(res.stdout).toContain("re-run `cinatra doctor`");
      expect(res.stdout).toContain("Summary: 0 pass, 1 fail, 0 skip.");
      expect(res.stdout).not.toContain("super-secret-pass");
      expect(res.stderr).not.toContain("super-secret-pass");
    } finally {
      checkout.cleanup();
    }
  });
});

// --- IN-PROCESS: reachable but NOT migrated (42P01) via the mocked pg client ---

describe("status/doctor — DB reachable but un-migrated (in-process, mocked pg)", () => {
  const savedEnv = {};
  const savedExitCode = process.exitCode;
  let logSpy;
  let checkout;

  function arrange({ connectError = null, queryError = null }) {
    pgControl.connectError = connectError;
    pgControl.queryError = queryError;
    checkout = makeFakeCheckout();
    for (const key of ["CINATRA_REPO_ROOT", "SUPABASE_DB_URL", "SUPABASE_SCHEMA"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CINATRA_REPO_ROOT = checkout.root;
    process.env.SUPABASE_DB_URL = ["postgres://cinatra", "super-secret-pass", "@127.0.0.1:5434/cinatra"].reduce((a, b, i) => (i === 1 ? `${a}:${b}` : `${a}${b}`)); // runtime-assembled (secret-scan)
    process.env.SUPABASE_SCHEMA = "cinatra";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  }

  afterEach(() => {
    pgControl.connectError = null;
    pgControl.queryError = null;
    logSpy?.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = savedExitCode;
    checkout?.cleanup();
    checkout = undefined;
  });

  it("`status` converts the 42P01 metadata probe into a degraded 'unmigrated' JSON report + exit 1", async () => {
    arrange({ queryError: pgError("42P01", 'relation "cinatra.metadata" does not exist') });
    await runStatus([]);
    expect(process.exitCode).toBe(1);
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const payload = JSON.parse(out);
    expect(payload.dbStatus).toBe("unmigrated");
    expect(payload.dbTarget).toBe("127.0.0.1:5434");
    expect(payload.hint).toContain("cinatra instance db migrate");
    expect(out).not.toContain("super-secret-pass");
  });

  it("`doctor` converts the 42P01 gather into a FAIL finding with the migrate remediation + exit 1", async () => {
    arrange({ queryError: pgError("42P01", 'relation "cinatra.metadata" does not exist') });
    await runDoctor([]);
    expect(process.exitCode).toBe(1);
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Instance DB at 127.0.0.1:5434 is reachable but not migrated");
    expect(out).toContain("cinatra instance db migrate");
    expect(out).toContain("Summary: 0 pass, 1 fail, 0 skip.");
    expect(out).not.toContain("super-secret-pass");
  });

  it("`doctor` reports a connect() failure as the 'unreachable' finding (in-process wiring)", async () => {
    arrange({ connectError: pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5434") });
    await runDoctor([]);
    expect(process.exitCode).toBe(1);
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("Instance DB unreachable at 127.0.0.1:5434");
    expect(out).toContain("start the local stack");
  });

  it("an UNRELATED gather error still propagates loudly (the classifier stays narrow)", async () => {
    arrange({ queryError: pgError("53300", "too many connections") });
    await expect(runDoctor([])).rejects.toThrow(/too many connections/);
  });

  // codex must-fix boundary: a NON-network connect failure (e.g. wrong
  // password, 28P01) is NOT the stack-down class — it must rethrow loudly for
  // BOTH commands, never be dressed up as "unreachable".
  it("`status` rethrows a 28P01 auth failure at connect() (not soft-reported as unreachable)", async () => {
    arrange({ connectError: pgError("28P01", "password authentication failed for user \"cinatra\"") });
    await expect(runStatus([])).rejects.toThrow(/password authentication failed/);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain('"unreachable"');
  });

  it("`doctor` rethrows a 28P01 auth failure at connect() (not soft-reported as unreachable)", async () => {
    arrange({ connectError: pgError("28P01", "password authentication failed for user \"cinatra\"") });
    await expect(runDoctor([])).rejects.toThrow(/password authentication failed/);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("Instance DB unreachable");
  });
});

// --- Unit: the #93 helpers -------------------------------------------------

describe("describeDbTarget — sanitized host:port, never credentials", () => {
  it("extracts host:port and drops user/password", () => {
    const cred = ["user", "super-secret-pass"].join(":"); // runtime-joined (secret-scan)
    const target = describeDbTarget(`postgres://${cred}@db.example.com:5641/cinatra`);
    expect(target).toBe("db.example.com:5641");
    expect(target).not.toContain("super-secret-pass");
  });

  it("defaults the port to 5432 and falls back on an unparseable string", () => {
    expect(describeDbTarget("postgres://u:p@localhost/db")).toBe("localhost:5432");
    expect(describeDbTarget("not a url")).toBe("the SUPABASE_DB_URL target");
  });
});

describe("isDbUnreachableError — narrow stack-down classifier (codex must-fix)", () => {
  it("matches network errno codes, pg connection-exception SQLSTATEs, and pg's no-code shapes", () => {
    expect(isDbUnreachableError(pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5434"))).toBe(true);
    expect(isDbUnreachableError(pgError("ENOTFOUND", "getaddrinfo ENOTFOUND db.local"))).toBe(true);
    expect(isDbUnreachableError(pgError("57P03", "the database system is starting up"))).toBe(true);
    expect(isDbUnreachableError(pgError("08006", "connection failure"))).toBe(true);
    expect(isDbUnreachableError(new Error("timeout expired"))).toBe(true);
    expect(isDbUnreachableError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("recurses into a dual-stack AggregateError (Happy Eyeballs connect)", () => {
    const agg = new AggregateError(
      [pgError("ECONNREFUSED", "connect ECONNREFUSED ::1:5434"), pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5434")],
      "",
    );
    expect(isDbUnreachableError(agg)).toBe(true);
  });

  it("does NOT match auth/config/real-bug errors (they must rethrow loudly)", () => {
    expect(isDbUnreachableError(pgError("28P01", "password authentication failed"))).toBe(false);
    expect(isDbUnreachableError(pgError("3D000", 'database "nope" does not exist'))).toBe(false);
    expect(isDbUnreachableError(new TypeError("Client is not a constructor"))).toBe(false);
    expect(isDbUnreachableError(null)).toBe(false);
  });
});

describe("isDbNotMigratedError — narrow un-migrated classifier", () => {
  it("matches undefined_table (42P01), invalid_schema_name (3F000), and the relation message", () => {
    expect(isDbNotMigratedError(pgError("42P01", 'relation "cinatra.metadata" does not exist'))).toBe(true);
    expect(isDbNotMigratedError(pgError("3F000", 'schema "cinatra" does not exist'))).toBe(true);
    expect(isDbNotMigratedError(new Error('relation "user" does not exist'))).toBe(true);
  });

  it("does NOT match unrelated errors (they must keep crashing loudly)", () => {
    expect(isDbNotMigratedError(new Error("connect ECONNREFUSED 127.0.0.1:5434"))).toBe(false);
    expect(isDbNotMigratedError(pgError("28P01", "password authentication failed"))).toBe(false);
    expect(isDbNotMigratedError(null)).toBe(false);
  });
});

describe("buildDbDownDoctorReport — degraded report shape + --fix interplay", () => {
  it("yields one FAIL assertion in the standard shape with the actionable remediation", () => {
    const report = buildDbDownDoctorReport({
      kind: "unreachable",
      target: "127.0.0.1:5434",
      message: "connect ECONNREFUSED 127.0.0.1:5434",
    });
    expect(report.counts).toEqual({ pass: 0, fail: 1, skip: 0 });
    expect(report.assertions).toHaveLength(1);
    expect(report.assertions[0].id).toBe("db-reachable");
    expect(report.assertions[0].verdict).toBe("fail");
    expect(report.assertions[0].remediation).toContain("cinatra install");
  });

  it("maps to NO --fix auto-remediation (setup/tunnel must not fire against a down DB)", () => {
    const down = buildDbDownDoctorReport({ kind: "unreachable", target: "x:1", message: "m" });
    const unmig = buildDbDownDoctorReport({ kind: "unmigrated", target: "x:1", message: "m" });
    expect(planDoctorFixActions(down)).toEqual([]);
    expect(planDoctorFixActions(unmig)).toEqual([]);
  });
});

describe("buildDbDownStatusReport — degraded status payload", () => {
  it("carries runtimeMode, dbStatus, target, error, and the per-kind hint", () => {
    const payload = buildDbDownStatusReport({
      runtimeMode: "development",
      kind: "unmigrated",
      target: "127.0.0.1:5641",
      message: 'relation "cinatra.metadata" does not exist',
    });
    expect(payload).toEqual({
      runtimeMode: "development",
      dbStatus: "unmigrated",
      dbTarget: "127.0.0.1:5641",
      dbError: 'relation "cinatra.metadata" does not exist',
      hint: expect.stringContaining("cinatra instance db migrate"),
    });
  });
});
