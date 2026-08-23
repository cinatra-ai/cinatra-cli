// cinatra-cli#243 — the alloc lock's WAITER deadline, and the remediation text
// a timed-out waiter is given.
//
// `executeStopExisting` now holds the alloc lock across `docker compose down`
// on a ready, multi-container stack. Docker's own default stop grace is 10s PER
// CONTAINER, so under the clone-registry default deadline (10s) every
// concurrent install failed with a timeout as the common case. Worse, the
// message told the operator to delete the lock file — which, followed while a
// legitimate `down` holds it, destroys the mutual exclusion this executor
// depends on.
//
// No docker, no containers: the lock is a file, and a live-pid lock file is
// exactly what a working holder leaves behind.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LOCK_TIMEOUT_MS, withRegistryLock } from "../src/clone-registry.mjs";
import { ALLOC_LOCK_TIMEOUT_MS, withAllocLock } from "../src/instance-alloc.mjs";

describe("alloc lock waiter deadline (cinatra-cli#243)", () => {
  let dir;
  let lockPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cin-243-lock-"));
    lockPath = path.join(dir, "alloc.lock");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A lock held by a LIVE holder: our own pid, so `lockHolderAlive` says yes and
  // the staleness steal can never fire. This is the state a real teardown leaves
  // on disk for the whole `docker compose down`.
  function holdWithLivePid() {
    writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
  }

  it("the alloc lock's deadline is sized for a real teardown, not for one atomic write", () => {
    // The clone-registry default covers a read plus a rename. A `down` on a
    // six-container stack at full stop grace exceeds it before it has begun.
    expect(LOCK_TIMEOUT_MS).toBe(10_000);
    expect(ALLOC_LOCK_TIMEOUT_MS).toBe(180_000);
  });

  it("a waiter blocks for the deadline it was given, not the clone-registry default", async () => {
    holdWithLivePid();
    const startedAt = Date.now();
    await expect(withAllocLock(lockPath, async () => "never", { timeoutMs: 400 })).rejects.toThrow(
      /Timed out after 400ms/,
    );
    // It actually WAITED — it did not fall straight through on the first EEXIST.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
  });

  it("the timeout message never tells the operator to delete a live holder's lock", async () => {
    holdWithLivePid();
    let message = "";
    try {
      await withRegistryLock(path.join(dir, "alloc"), async () => "never", { timeoutMs: 200 });
    } catch (err) {
      message = err.message;
    }

    // The old text: "If no other 'cinatra clone' command is running, delete the
    // lock file and retry." Wrong command for this path, and destructive advice
    // — a `down` holding the lock is a legitimate holder, and unlinking its lock
    // lets a second install claim the very ports it is releasing.
    expect(message).not.toMatch(/delete the lock file and retry/);
    expect(message).toMatch(/Do NOT delete the lock file while another cinatra command is running/);
    // It names WHO holds it, so "wait for it" is actionable rather than a guess.
    expect(message).toMatch(new RegExp(`held by pid ${process.pid}`));
    // And it says an abandoned lock needs no manual cleanup at all.
    expect(message).toMatch(/reclaimed automatically/);
  });

  it("still runs `fn` under the lock and releases it (the deadline changed nothing else)", async () => {
    const seen = [];
    const out = await withAllocLock(lockPath, async () => {
      seen.push("ran");
      return 42;
    });
    expect(out).toBe(42);
    expect(seen).toEqual(["ran"]);
    // A second acquisition proves the first released.
    await expect(withAllocLock(lockPath, async () => "again", { timeoutMs: 400 })).resolves.toBe("again");
  });
});
