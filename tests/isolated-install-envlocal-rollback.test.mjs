// cinatra-cli#111 — a FAILED `install --on-conflict=isolated` rollback must also
// restore `.env.local` (it previously tore down containers/volumes/compose file/
// registry row but left `.env.local` re-pointed at the torn-down remapped band).
//
// Drives the REAL `rollbackIsolatedInstance` with docker `down` stubbed and a
// real temp instance-registry + lock, plus the pure snapshot/restore helpers.

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import {
  snapshotEnvLocal,
  restoreEnvLocal,
  rollbackIsolatedInstance,
} from "../src/install.mjs";
import { ISOLATED_COMPOSE_FILENAME } from "../src/install-isolation.mjs";
import {
  allocateInstance,
  markInstanceReady,
  writeInstanceRegistry,
  readInstanceRegistry,
  getInstance,
} from "../src/instance-registry.mjs";

const ORIGINAL = "SUPABASE_DB_URL=postgres://127.0.0.1:5432/cinatra\nPORT=3000\n";
const REPOINTED = "SUPABASE_DB_URL=postgres://127.0.0.1:59432/cinatra\nPORT=3017\n";

const tmp = [];
function mkTmp() { const d = mkdtempSync(path.join(os.tmpdir(), "cli111-")); tmp.push(d); return d; }
afterEach(() => { while (tmp.length) { try { rmSync(tmp.pop(), { recursive: true, force: true }); } catch { /* ignore */ } } });

// Build a targetDir + a temp registry holding a row for `slug` at that dir.
function setupInstance({ envLocalContent, state = "provisioning" } = {}) {
  const targetDir = mkTmp();
  const regDir = mkTmp();
  const registryPath = path.join(regDir, "instances.json");
  const allocLockPath = path.join(regDir, "alloc");
  const slug = "cinatra";
  const composeProject = "cinatra-isolated-1";

  // Artifacts the rollback removes on a successful teardown.
  writeFileSync(path.join(targetDir, ISOLATED_COMPOSE_FILENAME), "services: {}\n");
  mkdirSync(path.join(targetDir, ".cinatra"), { recursive: true });
  writeFileSync(path.join(targetDir, ".cinatra", "instance.json"), JSON.stringify({ slug }));
  if (envLocalContent !== undefined) writeFileSync(path.join(targetDir, ".env.local"), envLocalContent);

  let reg = { version: 1, instances: {} };
  reg = allocateInstance(reg, slug, {
    mode: "dev", installDir: targetDir, composeProject,
    composeFiles: [ISOLATED_COMPOSE_FILENAME], ports: {}, appPort: 3017,
    repoUrl: "https://github.com/cinatra-ai/cinatra.git", ref: "main", infraMode: "new",
    state: "provisioning",
  }).registry;
  if (state === "ready") reg = markInstanceReady(reg, slug, { sha: "deadbeef", ports: {} });
  writeInstanceRegistry(registryPath, reg);

  return { targetDir, registryPath, allocLockPath, slug, composeProject };
}
function readEnv(targetDir) {
  const p = path.join(targetDir, ".env.local");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function rowFor(registryPath, slug) {
  return getInstance(readInstanceRegistry(registryPath).registry, slug);
}
function okDown() { const calls = []; return { fn: (dir, opts) => calls.push({ dir, opts }), calls }; }

// =========================================================================
describe("snapshotEnvLocal / restoreEnvLocal (pure)", () => {
  it("snapshots an existing file's bytes", () => {
    const d = mkTmp();
    writeFileSync(path.join(d, ".env.local"), ORIGINAL);
    expect(snapshotEnvLocal(d)).toMatchObject({ existed: true, content: ORIGINAL });
  });
  it("snapshots absence", () => {
    expect(snapshotEnvLocal(mkTmp())).toMatchObject({ existed: false, content: null });
  });
  it("restore rewrites original bytes over a re-pointed file", () => {
    const d = mkTmp();
    writeFileSync(path.join(d, ".env.local"), ORIGINAL);
    const snap = snapshotEnvLocal(d);
    writeFileSync(path.join(d, ".env.local"), REPOINTED);
    restoreEnvLocal(snap, () => {});
    expect(readEnv(d)).toBe(ORIGINAL);
  });
  it("restore removes a file that did not exist at snapshot time", () => {
    const d = mkTmp();
    const snap = snapshotEnvLocal(d); // absent
    writeFileSync(path.join(d, ".env.local"), REPOINTED); // isolated install created it
    restoreEnvLocal(snap, () => {});
    expect(existsSync(path.join(d, ".env.local"))).toBe(false);
  });
  it("null snapshot is a no-op", () => {
    expect(() => restoreEnvLocal(null, () => {})).not.toThrow();
  });
});

describe("rollbackIsolatedInstance — restores .env.local (cinatra-cli#111)", () => {
  it("restores the pre-install .env.local on a successful rollback (existed)", async () => {
    const s = setupInstance({ envLocalContent: ORIGINAL });
    const snap = snapshotEnvLocal(s.targetDir);            // capture original
    writeFileSync(path.join(s.targetDir, ".env.local"), REPOINTED); // isolated re-point
    const down = okDown();

    await rollbackIsolatedInstance({
      targetDir: s.targetDir, slug: s.slug, composeProject: s.composeProject,
      composeFiles: [ISOLATED_COMPOSE_FILENAME], envSnapshot: snap, log: () => {},
      deps: { instanceRegistryPath: s.registryPath, allocLockPath: s.allocLockPath, runComposeDown: down.fn },
    });

    expect(down.calls).toHaveLength(1);                    // real teardown ran
    expect(down.calls[0].opts).toMatchObject({ volumes: true, composeProject: s.composeProject });
    expect(readEnv(s.targetDir)).toBe(ORIGINAL);           // .env.local restored
    expect(rowFor(s.registryPath, s.slug)).toBeNull();     // registry row released
    expect(existsSync(path.join(s.targetDir, ".cinatra", "instance.json"))).toBe(false); // marker removed
    expect(existsSync(path.join(s.targetDir, ISOLATED_COMPOSE_FILENAME))).toBe(false);   // compose file removed
  });

  it("removes .env.local the install created when none existed before", async () => {
    const s = setupInstance({ envLocalContent: undefined });
    const snap = snapshotEnvLocal(s.targetDir);            // absent
    writeFileSync(path.join(s.targetDir, ".env.local"), REPOINTED); // isolated install created it
    const down = okDown();

    await rollbackIsolatedInstance({
      targetDir: s.targetDir, slug: s.slug, composeProject: s.composeProject,
      composeFiles: [ISOLATED_COMPOSE_FILENAME], envSnapshot: snap, log: () => {},
      deps: { instanceRegistryPath: s.registryPath, allocLockPath: s.allocLockPath, runComposeDown: down.fn },
    });

    expect(existsSync(path.join(s.targetDir, ".env.local"))).toBe(false);
    expect(rowFor(s.registryPath, s.slug)).toBeNull();
  });

  it("does NOT touch .env.local when the row is READY (owner-metadata guard)", async () => {
    const s = setupInstance({ envLocalContent: ORIGINAL, state: "ready" });
    const snap = snapshotEnvLocal(s.targetDir);
    writeFileSync(path.join(s.targetDir, ".env.local"), REPOINTED);
    const down = okDown();

    await rollbackIsolatedInstance({
      targetDir: s.targetDir, slug: s.slug, composeProject: s.composeProject,
      composeFiles: [ISOLATED_COMPOSE_FILENAME], envSnapshot: snap, log: () => {},
      deps: { instanceRegistryPath: s.registryPath, allocLockPath: s.allocLockPath, runComposeDown: down.fn },
    });

    expect(down.calls).toHaveLength(0);                    // never torn down
    expect(readEnv(s.targetDir)).toBe(REPOINTED);          // ready instance's env preserved
    expect(rowFor(s.registryPath, s.slug)).not.toBeNull(); // row kept
  });

  it("does NOT restore .env.local when the teardown (down) fails — row kept for retry", async () => {
    const s = setupInstance({ envLocalContent: ORIGINAL });
    const snap = snapshotEnvLocal(s.targetDir);
    writeFileSync(path.join(s.targetDir, ".env.local"), REPOINTED);
    const failDown = () => { throw new Error("docker compose down failed (exit 1)"); };

    await rollbackIsolatedInstance({
      targetDir: s.targetDir, slug: s.slug, composeProject: s.composeProject,
      composeFiles: [ISOLATED_COMPOSE_FILENAME], envSnapshot: snap, log: () => {},
      deps: { instanceRegistryPath: s.registryPath, allocLockPath: s.allocLockPath, runComposeDown: failDown },
    });

    expect(readEnv(s.targetDir)).toBe(REPOINTED);          // env matches the still-standing stack
    expect(rowFor(s.registryPath, s.slug)).not.toBeNull(); // row kept so a retry finishes rollback
  });
});
