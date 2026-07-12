// Mocked-transport integration tests for `runExtensionsReconcile`
// (cinatra-cli#126). These drive the FULL command entrypoint with an injected
// transport (no network, no OAuth) and assert the end-to-end behaviours the
// acceptance bar names: default --plan performs ZERO writes; --apply POSTs and
// moves a version; a post-apply --plan reports up-to-date; digest-CAS mismatch
// and surface-not-available are surfaced; a failed candidate drives exit 1.
//
// The REAL Docker/verify-stack E2E (a live `cinatra extensions reconcile`
// against a running instance) is fenced by host RAM in this lane and is
// documented on the PR as READY-EXCEPT-E2E — these mocked-transport tests prove
// the client contract deterministically without booting the app.

import { describe, it, expect } from "vitest";

import {
  runExtensionsReconcile,
  RECONCILE_PLAN_PATH,
  RECONCILE_APPLY_PATH,
} from "../src/extensions-reconcile.mjs";

/** A recording fake transport. `get`/`post` return the queued responses. */
function fakeTransport({ getImpl, postImpl } = {}) {
  const calls = { get: [], post: [] };
  return {
    calls,
    origin: "https://inst",
    get: async (path) => {
      calls.get.push(path);
      return getImpl ? getImpl(path) : {};
    },
    post: async (path, body) => {
      calls.post.push({ path, body });
      return postImpl ? postImpl(path, body) : {};
    },
  };
}

function captureStdout() {
  let buf = "";
  return { write: (s) => { buf += s; }, get text() { return buf; } };
}

describe("runExtensionsReconcile — target requirement", () => {
  it("refuses to run without a target (--app-url or --profile)", async () => {
    await expect(runExtensionsReconcile([], { transport: fakeTransport() })).rejects.toThrow(
      /Target a running instance/,
    );
  });
});

describe("runExtensionsReconcile — --plan (default, dry run)", () => {
  it("GETs the plan surface, prints candidates, and performs ZERO writes", async () => {
    const out = captureStdout();
    const transport = fakeTransport({
      getImpl: () => ({
        planDigest: "sha256:abc",
        readModelStatus: "wired",
        candidates: [{ packageName: "@cinatra-ai/foo", currentVersion: "1.0.0", targetVersion: "1.1.0" }],
        skipped: [],
        fences: [],
      }),
    });
    const code = await runExtensionsReconcile(["--app-url", "https://inst"], {
      transport,
      stdout: out.write,
    });
    expect(code).toBe(0);
    // Read-only proof: the GET plan path was hit, and NO post (write) occurred.
    expect(transport.calls.get).toEqual([RECONCILE_PLAN_PATH]);
    expect(transport.calls.post).toEqual([]);
    expect(out.text).toContain("Would update (1):");
    expect(out.text).toContain("1.0.0 → 1.1.0");
    expect(out.text).toContain("Dry run — no changes were made.");
  });

  it("renders an unwired read model as unwired skips (never a false empty plan)", async () => {
    const out = captureStdout();
    const transport = fakeTransport({
      getImpl: () => ({
        planDigest: "sha256:0",
        readModelStatus: "unwired",
        candidates: [],
        skipped: [{ packageName: "@cinatra-ai/foo", reason: "read-model-unwired" }],
        fences: [],
      }),
    });
    await runExtensionsReconcile(["--app-url", "https://inst"], { transport, stdout: out.write });
    expect(out.text).toContain("read-model-unwired");
    expect(transport.calls.post).toEqual([]);
  });
});

describe("runExtensionsReconcile — --apply", () => {
  it("POSTs the apply surface and reports a real version move (exit 0)", async () => {
    const out = captureStdout();
    const transport = fakeTransport({
      postImpl: () => ({
        planDigest: "sha256:abc",
        applied: [{ packageName: "@cinatra-ai/foo", fromVersion: "1.0.0", toVersion: "1.1.0" }],
        failed: [],
        droppedByRecheck: [],
        auditWriteFailures: 0,
        initiatingOperator: "alice@x",
        systemExecutor: "system:extension-auto-update",
      }),
    });
    const code = await runExtensionsReconcile(["--apply", "--app-url", "https://inst"], {
      transport,
      stdout: out.write,
    });
    expect(code).toBe(0);
    expect(transport.calls.post).toEqual([{ path: RECONCILE_APPLY_PATH, body: {} }]);
    expect(out.text).toContain("Applied (1):");
    expect(out.text).toContain("1.0.0 → 1.1.0");
    expect(out.text).toContain("initiating operator: alice@x");
  });

  it("forwards --plan-digest as a CAS in the POST body", async () => {
    const transport = fakeTransport({
      postImpl: () => ({ applied: [], failed: [], droppedByRecheck: [], auditWriteFailures: 0 }),
    });
    await runExtensionsReconcile(
      ["--apply", "--plan-digest", "sha256:pinned", "--app-url", "https://inst"],
      { transport, stdout: () => {} },
    );
    expect(transport.calls.post).toEqual([
      { path: RECONCILE_APPLY_PATH, body: { planDigest: "sha256:pinned" } },
    ]);
  });

  it("a failed candidate drives a non-zero exit (per-candidate isolation)", async () => {
    const out = captureStdout();
    const transport = fakeTransport({
      postImpl: () => ({
        applied: [{ packageName: "@cinatra-ai/foo", fromVersion: "1.0.0", toVersion: "1.1.0" }],
        failed: [{ packageName: "@cinatra-ai/bar", reason: "install-failed" }],
        droppedByRecheck: [],
        auditWriteFailures: 0,
      }),
    });
    const code = await runExtensionsReconcile(["--apply", "--app-url", "https://inst"], {
      transport,
      stdout: out.write,
    });
    expect(code).toBe(1);
    expect(out.text).toContain("Applied (1):"); // the sibling still applied
    expect(out.text).toContain("Failed (1):");
  });

  it("a drift-drop-only apply is exit 0 (a fresh-recheck drop is expected shrink)", async () => {
    const transport = fakeTransport({
      postImpl: () => ({
        applied: [],
        failed: [],
        droppedByRecheck: [{ packageName: "@cinatra-ai/foo", reason: "state-drift" }],
        auditWriteFailures: 0,
      }),
    });
    const code = await runExtensionsReconcile(["--apply", "--app-url", "https://inst"], {
      transport,
      stdout: () => {},
    });
    expect(code).toBe(0);
  });

  it("a post-apply --plan reports up-to-date once the moves have landed", async () => {
    const out = captureStdout();
    const transport = fakeTransport({
      getImpl: () => ({ planDigest: "sha256:z", readModelStatus: "wired", candidates: [], skipped: [], fences: [] }),
    });
    await runExtensionsReconcile(["--app-url", "https://inst"], { transport, stdout: out.write });
    expect(out.text).toContain("up to date");
  });
});

describe("runExtensionsReconcile — error surfacing", () => {
  it("surfaces a 404 as 'surface not available on this instance'", async () => {
    const transport = fakeTransport({
      getImpl: () => {
        throw Object.assign(new Error("Request failed (404 Not Found)"), { status: 404 });
      },
    });
    await expect(
      runExtensionsReconcile(["--app-url", "https://inst"], { transport, stdout: () => {} }),
    ).rejects.toThrow(/not available on this instance/);
  });

  it("surfaces a digest-CAS mismatch on --apply", async () => {
    const transport = fakeTransport({
      postImpl: () => {
        throw Object.assign(new Error("conflict"), { status: 409, code: "plan-digest-mismatch" });
      },
    });
    await expect(
      runExtensionsReconcile(
        ["--apply", "--plan-digest", "sha256:stale", "--app-url", "https://inst"],
        { transport, stdout: () => {} },
      ),
    ).rejects.toThrow(/plan changed since the supplied --plan-digest/);
    // A failed CAS must NOT have applied anything beyond the refused POST.
    expect(transport.calls.post).toHaveLength(1);
  });
});
