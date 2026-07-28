// cinatra-cli#176 — the post-sidecar teardown guard for `instance tunnel start`.
//
// `runDevTunnel`'s start path brings the Tailscale sidecar up and THEN does the
// work that makes the tunnel useful. A throw in that window used to leave a
// registered, running node with no `publicBaseUrl` — and the next `start`
// short-circuits on `isComposeProjectUp` and reports "already running", so the
// half-up state was self-perpetuating.
//
// The guard is a pure leaf (both the segment and the teardown are injected), so
// the full contract is exercised here with no Docker, no Tailscale, no DB.

import { describe, it, expect } from "vitest";

import { runPostSidecarProvisioning } from "../src/dev-tunnel-cleanup.mjs";

describe("runPostSidecarProvisioning — tears the sidecar down on a pre-write failure", () => {
  it("tears down and rethrows the ORIGINAL error when the segment throws before the write", async () => {
    const tornDown = [];
    // The exact failure class cinatra-cli#176 reports: the dev-CLI module the
    // hostname prediction needs cannot be resolved.
    const boom = new Error("Cannot find module for dev-CLI key");
    boom.code = "ERR_MODULE_NOT_FOUND";

    const thrown = await runPostSidecarProvisioning(
      async () => {
        throw boom;
      },
      (cause) => {
        tornDown.push(cause);
      },
    ).catch((err) => err);

    expect(thrown).toBe(boom); // identity preserved, never wrapped
    expect(tornDown).toHaveLength(1);
    expect(tornDown[0]).toBe(boom); // the teardown is told WHY
  });

  it("does NOT tear down once the publicBaseUrl write has landed", async () => {
    const tornDown = [];
    const late = new Error("a cosmetic failure after the durable write");

    const thrown = await runPostSidecarProvisioning(
      async (markProvisioned) => {
        markProvisioned();
        throw late;
      },
      (cause) => {
        tornDown.push(cause);
      },
    ).catch((err) => err);

    expect(thrown).toBe(late);
    expect(tornDown).toHaveLength(0); // a provisioned tunnel is never destroyed
  });

  it("does not tear down on success, and returns the segment's value", async () => {
    const tornDown = [];
    const result = await runPostSidecarProvisioning(
      async (markProvisioned) => {
        markProvisioned();
        return "provisioned";
      },
      () => {
        tornDown.push("called");
      },
    );
    expect(result).toBe("provisioned");
    expect(tornDown).toHaveLength(0);
  });

  it("tears down on a throw even when the segment never marked (no write at all)", async () => {
    // e.g. the Funnel URL surfaced but the DB write itself threw: nothing
    // durable landed, so the sidecar must not survive.
    let tornDown = 0;
    const dbFailure = new Error("write failed");
    await expect(
      runPostSidecarProvisioning(
        async () => {
          throw dbFailure;
        },
        () => {
          tornDown += 1;
        },
      ),
    ).rejects.toBe(dbFailure);
    expect(tornDown).toBe(1);
  });

  it("AWAITS an async teardown before rethrowing", async () => {
    const order = [];
    const boom = new Error("boom");
    await expect(
      runPostSidecarProvisioning(
        async () => {
          throw boom;
        },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push("torn-down");
        },
      ),
    ).rejects.toBe(boom);
    // The teardown completed BEFORE the rejection surfaced to the caller.
    expect(order).toEqual(["torn-down"]);
  });

  it("never lets a failing teardown mask the original failure", async () => {
    const boom = new Error("the real cause");
    const thrown = await runPostSidecarProvisioning(
      async () => {
        throw boom;
      },
      () => {
        throw new Error("docker compose down also failed");
      },
    ).catch((err) => err);
    expect(thrown).toBe(boom);
  });

  it("markProvisioned is idempotent (a second call cannot re-open the guard)", async () => {
    let tornDown = 0;
    const boom = new Error("boom");
    await expect(
      runPostSidecarProvisioning(
        async (markProvisioned) => {
          markProvisioned();
          markProvisioned();
          throw boom;
        },
        () => {
          tornDown += 1;
        },
      ),
    ).rejects.toBe(boom);
    expect(tornDown).toBe(0);
  });

  it("rejects a misuse (non-function arguments) instead of silently skipping cleanup", async () => {
    await expect(runPostSidecarProvisioning(null, () => {})).rejects.toThrow(TypeError);
    await expect(runPostSidecarProvisioning(async () => {}, null)).rejects.toThrow(
      TypeError,
    );
  });
});
