// The `preview` lifecycle (cinatra-ai/cinatra-cli#149) — unit/integration tests
// mirroring the epic's own bar (scripts/ci/prod-boot-e2e.sh's state machine).
//
// These are HERMETIC: no real docker/git/network. Every side-effecting op is
// injected via `deps` (runDocker / resolveSha / prepareContext / probeHealth /
// now / sleep), and the registry is pointed at a temp file. A fake docker
// runner RECORDS every argv so we can assert on the exact commands — this is how
// the three hard-NEVERs (AC7) are asserted structurally.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __test as P } from "../src/preview.mjs";

const {
  isValidSlug,
  isImmutableSha,
  previewImageTag,
  previewProvenance,
  previewContainerName,
  previewVolumeName,
  assertNotProductionImageTag,
  assertMaterializeNotDisabled,
  assertEncryptionKey,
  assertPreviewCheckoutAllowed,
  readCheckoutEnvMode,
  buildPreviewRunEnvArgs,
  classifyHealthResponse,
  pollHealthGate,
  usedPreviewHostPorts,
  allocatePreviewHostPort,
  validatePreviewPort,
  readRegistry,
  writeRegistry,
  getPreview,
  listPreviews,
  makePreviewSlot,
  refreshPreviewSlot,
  runPreviewCreate,
  runPreviewRefresh,
  runPreviewStatus,
  PREVIEW_IMAGE_TAG_PREFIX,
  PREVIEW_RUNTIME_MODE,
  PREVIEW_HOST_PORT_MIN,
  PREVIEW_HOST_PORT_MAX,
  MATERIALIZE_DISABLE_ENV,
  ENCRYPTION_KEY_ENV,
  EXTENSION_DATA_ROOT_ENV,
  EXTENSION_DATA_ROOT_IN_CONTAINER,
} = P;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const KEY_64 = "00000000000000000000000000000000000000000000000000000000000000e2"; // 64 hex chars

let tmp;
let registryPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cinatra-preview-test-"));
  registryPath = path.join(tmp, "previews.json");
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// A fake docker runner that records every invocation and answers `inspect`
// (container liveness) + a scripted health probe from a shared state object.
function makeFakeDocker(state) {
  const calls = [];
  const runDocker = (args, _opts = {}) => {
    calls.push(args);
    const [verb, sub] = args;
    // `docker build ...` — success unless state.buildFails.
    if (verb === "build") {
      return state.buildFails ? { status: 1, stdout: "", stderr: "build boom", error: null } : { status: 0, stdout: "", stderr: "" };
    }
    // `docker run -d ...` — records the run; container becomes "running".
    if (verb === "run" && sub === "-d") {
      state.containerRunning = true;
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    // `docker container inspect -f {{.State.Running}} <name>` — liveness via the
    // running state (a bare inspect would succeed for a STOPPED container).
    if (verb === "container" && sub === "inspect") {
      const running = Boolean(state.containerRunning);
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "false\n", stderr: "" };
    }
    // `docker volume inspect <name>` — existence (default: does NOT exist).
    if (verb === "volume" && sub === "inspect") {
      return { status: state.volumeExists ? 0 : 1, stdout: "", stderr: "" };
    }
    // `docker image inspect <ref>` — default: does NOT exist.
    if (verb === "image" && sub === "inspect") {
      return { status: 1, stdout: "", stderr: "" };
    }
    // `docker rm -f <name>` — container gone.
    if (verb === "rm") {
      state.containerRunning = false;
      state.removedContainers = state.removedContainers ?? [];
      state.removedContainers.push(args[args.length - 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    // `docker image rm -f <tag>`.
    if (verb === "image" && sub === "rm") {
      state.removedImages = state.removedImages ?? [];
      state.removedImages.push(args[args.length - 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    // `docker volume rm -f <name>`.
    if (verb === "volume" && sub === "rm") {
      state.removedVolumes = state.removedVolumes ?? [];
      state.removedVolumes.push(args[args.length - 1]);
      return { status: 0, stdout: "", stderr: "" };
    }
    // `docker logs ...`.
    if (verb === "logs") return { status: 0, stdout: "app log tail", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runDocker };
}

// Build an injected deps object for the orchestration functions.
function makeDeps(state, { env, checkoutDir } = {}) {
  const fake = makeFakeDocker(state);
  const logs = [];
  const deps = {
    registryPath,
    checkoutDir: checkoutDir ?? tmp,
    env: env ?? { [ENCRYPTION_KEY_ENV]: KEY_64 },
    log: (...m) => logs.push(m.join(" ")),
    logError: (...m) => logs.push(m.join(" ")),
    now: () => state.now ?? 1000,
    sleep: async () => {},
    resolveSha: (ref) => state.shaForRef?.[ref] ?? state.sha ?? SHA_A,
    prepareContext: () => ({ contextDir: path.join(tmp, "ctx"), cleanup: () => {} }),
    probeHealth: async () => state.healthResponses?.shift() ?? state.health ?? null,
    // Hermetic host-port probe: every pool port reads free unless `state.busyPorts`
    // marks it busy — no real socket bind in the unit suite.
    probePort: async (p) => !(state.busyPorts instanceof Set && state.busyPorts.has(p)),
    runDocker: fake.runDocker,
  };
  return { deps, fake, logs };
}

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

describe("preview — naming + tag helpers (AC3)", () => {
  it("image tag mirrors the local `cinatra-preview:local-<sha>` namespace", () => {
    expect(previewImageTag(SHA_A)).toBe(`${PREVIEW_IMAGE_TAG_PREFIX}${SHA_A}`);
    expect(previewImageTag(SHA_A).startsWith("cinatra-preview:local-")).toBe(true);
  });
  it("provenance is `local-image:<sha>` (AC2)", () => {
    expect(previewProvenance(SHA_A)).toBe(`local-image:${SHA_A}`);
  });
  it("container + volume names are slug-derived and stable", () => {
    expect(previewContainerName("main")).toBe("cinatra-preview-main");
    expect(previewVolumeName("main")).toBe("cinatra-preview-data-main");
  });
  it("rejects non-40-hex SHAs", () => {
    expect(() => previewImageTag("nope")).toThrow(/40-hex/);
    expect(isImmutableSha(SHA_A)).toBe(true);
    expect(isImmutableSha("z".repeat(40))).toBe(false);
    expect(isValidSlug("main")).toBe(true);
    expect(isValidSlug("Bad Slug")).toBe(false);
  });
});

// --------------------------------------------------------------------------
// AC6 — CINATRA_ENCRYPTION_KEY is its own boot gate
// --------------------------------------------------------------------------

describe("preview — CINATRA_ENCRYPTION_KEY boot gate (AC6)", () => {
  it("accepts a 64-hex key and returns it", () => {
    expect(assertEncryptionKey({ [ENCRYPTION_KEY_ENV]: KEY_64 })).toBe(KEY_64);
  });
  it("fails ACTIONABLY when the key is missing", () => {
    expect(() => assertEncryptionKey({})).toThrow(/CINATRA_ENCRYPTION_KEY/);
    expect(() => assertEncryptionKey({})).toThrow(/openssl rand -hex 32/);
  });
  it("fails when the key is not exactly 64 hex chars", () => {
    expect(() => assertEncryptionKey({ [ENCRYPTION_KEY_ENV]: "abc" })).toThrow(/64 hex/);
    expect(() => assertEncryptionKey({ [ENCRYPTION_KEY_ENV]: "g".repeat(64) })).toThrow(/64 hex/);
  });
});

// --------------------------------------------------------------------------
// AC7 — the three hard NEVERs (also asserted at the orchestration level below)
// --------------------------------------------------------------------------

describe("preview — hard NEVERs, unit level (AC7)", () => {
  it("NEVER-ii: refuses a published production image name as the tag", () => {
    expect(() => assertNotProductionImageTag("ghcr.io/cinatra-ai/cinatra:v1")).toThrow(/production image name/);
    expect(() => assertNotProductionImageTag("docker.io/cinatra/cinatra:latest")).toThrow(/production image name/);
    expect(() => assertNotProductionImageTag("cinatra/cinatra")).toThrow(/production image name/);
    // A tag outside the local preview namespace is also refused.
    expect(() => assertNotProductionImageTag("some-other:tag")).toThrow(/local preview namespace/);
    // The real preview tag passes.
    expect(assertNotProductionImageTag(previewImageTag(SHA_A))).toBe(true);
  });
  it("NEVER-iii: refuses when the materialize-disable bypass is truthy", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE"]) {
      expect(() => assertMaterializeNotDisabled({ [MATERIALIZE_DISABLE_ENV]: v })).toThrow(/SAFETY invariant/);
    }
    // Absent / falsey is fine.
    expect(assertMaterializeNotDisabled({})).toBe(true);
    expect(assertMaterializeNotDisabled({ [MATERIALIZE_DISABLE_ENV]: "false" })).toBe(true);
  });
  it("NEVER-iii: the boot env NEVER carries the materialize-disable flag, even if the ambient env sets it false", () => {
    const args = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { [ENCRYPTION_KEY_ENV]: KEY_64, [MATERIALIZE_DISABLE_ENV]: "false" } });
    expect(args.join(" ")).not.toContain(MATERIALIZE_DISABLE_ENV);
  });
});

describe("preview — production runtime env (AC2)", () => {
  it("always sets CINATRA_RUNTIME_MODE=production and the durable data root, forwards the key", () => {
    const args = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { [ENCRYPTION_KEY_ENV]: KEY_64, SUPABASE_DB_URL: "postgres://x" } });
    const joined = args.join(" ");
    expect(joined).toContain(`CINATRA_RUNTIME_MODE=${PREVIEW_RUNTIME_MODE}`);
    expect(joined).toContain(`${ENCRYPTION_KEY_ENV}=${KEY_64}`);
    expect(joined).toContain(`${EXTENSION_DATA_ROOT_ENV}=${EXTENSION_DATA_ROOT_IN_CONTAINER}`);
    expect(joined).toContain("SUPABASE_DB_URL=postgres://x");
    // Never a published image name anywhere in the env.
    expect(joined).not.toContain("ghcr.io/cinatra-ai/cinatra");
  });
});

// --------------------------------------------------------------------------
// AC5 — health-gate state machine (mirrors prod-boot-e2e.sh)
// --------------------------------------------------------------------------

describe("preview — health classification (AC5)", () => {
  it("200 + status:ok is healthy; a bare 200 is NOT (not TCP-only)", () => {
    expect(classifyHealthResponse({ status: 200, body: '{"status":"ok"}' })).toBe("healthy");
    expect(classifyHealthResponse({ status: 200, body: "OK" })).toBe("unknown");
    expect(classifyHealthResponse({ status: 200, body: "" })).toBe("unknown");
  });
  it("degraded/error is terminal-degraded; starting is transient", () => {
    expect(classifyHealthResponse({ status: 503, body: '{"status":"degraded"}' })).toBe("degraded");
    expect(classifyHealthResponse({ status: 503, body: '{"status":"error"}' })).toBe("degraded");
    expect(classifyHealthResponse({ status: 503, body: '{"status":"starting"}' })).toBe("starting");
  });

  it("pollHealthGate returns healthy once ok is served (after starting)", async () => {
    let t = 0;
    const responses = [
      { status: 503, body: '{"status":"starting"}' },
      { status: 503, body: '{"status":"starting"}' },
      { status: 200, body: '{"status":"ok"}' },
    ];
    const res = await pollHealthGate({
      url: "http://x/api/health",
      timeoutMs: 100000,
      intervalMs: 1,
      deps: {
        now: () => (t += 1) * 10,
        sleep: async () => {},
        isRunning: async () => true,
        probeHealth: async () => responses.shift() ?? { status: 200, body: '{"status":"ok"}' },
      },
    });
    expect(res.state).toBe("healthy");
  });

  it("pollHealthGate FAILS LOUDLY on a terminal degraded (stops polling)", async () => {
    const res = await pollHealthGate({
      url: "http://x/api/health",
      timeoutMs: 100000,
      intervalMs: 1,
      deps: {
        now: () => 0,
        sleep: async () => {},
        isRunning: async () => true,
        probeHealth: async () => ({ status: 503, body: '{"status":"degraded"}' }),
      },
    });
    expect(res.state).toBe("degraded");
    expect(res.status).toBe(503);
  });

  it("pollHealthGate times out (never hangs) when it never reaches ok", async () => {
    let t = 0;
    const res = await pollHealthGate({
      url: "http://x/api/health",
      timeoutMs: 50,
      intervalMs: 1,
      deps: {
        now: () => (t += 20),
        sleep: async () => {},
        isRunning: async () => true,
        probeHealth: async () => ({ status: 503, body: '{"status":"starting"}' }),
      },
    });
    expect(res.state).toBe("timeout");
  });

  it("pollHealthGate reports crashed when the container dies", async () => {
    const res = await pollHealthGate({
      url: "http://x/api/health",
      timeoutMs: 1000,
      intervalMs: 1,
      deps: {
        now: () => 0,
        sleep: async () => {},
        isRunning: async () => false,
        probeHealth: async () => null,
      },
    });
    expect(res.state).toBe("crashed");
  });
});

// --------------------------------------------------------------------------
// AC9 — never conflated with a real prod checkout
// --------------------------------------------------------------------------

describe("preview — real-prod-checkout guard (AC9)", () => {
  it("refuses a production .env.local UNCONDITIONALLY (no registry escape hatch)", () => {
    expect(() => assertPreviewCheckoutAllowed({ envMode: "production" })).toThrow(/real production install/);
    expect(() => assertPreviewCheckoutAllowed({ envMode: "prod" })).toThrow(/real production install/);
    // The guard takes ONLY the checkout env mode — a caller cannot pass a
    // registry-derived flag that would suppress the refusal (the old no-op bug).
    expect(() => assertPreviewCheckoutAllowed({ envMode: "production", hasPreviewProvenance: true })).toThrow(/real production install/);
  });
  it("allows a dev checkout / no .env.local", () => {
    expect(assertPreviewCheckoutAllowed({ envMode: "development" })).toBe(true);
    expect(assertPreviewCheckoutAllowed({ envMode: null })).toBe(true);
  });
  it("readCheckoutEnvMode reads CINATRA_RUNTIME_MODE from .env.local", () => {
    writeFileSync(path.join(tmp, ".env.local"), "FOO=bar\nCINATRA_RUNTIME_MODE=production\n");
    expect(readCheckoutEnvMode(tmp)).toBe("production");
  });
});

// --------------------------------------------------------------------------
// registry + slot shape (AC3)
// --------------------------------------------------------------------------

describe("preview — registry slot bookkeeping (AC3)", () => {
  it("makePreviewSlot records sha/tag/provenance/volume and seeds history", () => {
    const slot = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" });
    expect(slot.sha).toBe(SHA_A);
    expect(slot.imageTag).toBe(previewImageTag(SHA_A));
    expect(slot.provenance).toBe(previewProvenance(SHA_A));
    expect(slot.runtimeMode).toBe("production");
    expect(slot.volumeName).toBe("cinatra-preview-data-main");
    expect(slot.history).toEqual([{ sha: SHA_A, imageTag: previewImageTag(SHA_A), at: "T0" }]);
  });
  it("refreshPreviewSlot records the NEW sha/tag and APPENDS old->new history (never silent overwrite)", () => {
    const first = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" });
    const second = refreshPreviewSlot(first, { ref: "main", sha: SHA_B, now: () => "T1" });
    expect(second.sha).toBe(SHA_B);
    expect(second.imageTag).toBe(previewImageTag(SHA_B));
    expect(second.volumeName).toBe(first.volumeName); // durable volume reused
    expect(second.history.map((h) => h.sha)).toEqual([SHA_A, SHA_B]);
  });
  it("round-trips through write/read and validates the shape", () => {
    const slot = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" });
    writeRegistry(registryPath, { version: 1, previews: { main: slot } });
    const { status, registry } = readRegistry(registryPath);
    expect(status).toBe("ok");
    expect(getPreview(registry, "main").sha).toBe(SHA_A);
  });
  it("classifies a structurally-invalid slot as malformed (fail-closed)", () => {
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify({ version: 1, previews: { main: { sha: "bad" } } }));
    expect(readRegistry(registryPath).status).toBe("malformed");
  });
});

// --------------------------------------------------------------------------
// AC1 + AC2 + AC5 — create builds + boots + health-gates to healthy
// --------------------------------------------------------------------------

describe("preview create — build + boot + health-gate (AC1, AC2, AC5)", () => {
  it("resolves a ref to a SHA, builds, boots with prod semantics, health-gates, records the row", async () => {
    const state = { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } };
    const { deps, fake } = makeDeps(state);
    const out = await runPreviewCreate(["--ref", "main", "--slug", "main"], deps);
    expect(out.state).toBe("healthy");
    expect(out.sha).toBe(SHA_A);
    expect(out.tag).toBe(previewImageTag(SHA_A));

    // A build happened, and the tag is the local preview tag (AC7-ii).
    const build = fake.calls.find((c) => c[0] === "build");
    expect(build).toBeTruthy();
    expect(build).toContain(previewImageTag(SHA_A));
    expect(build.join(" ")).not.toContain("ghcr.io/cinatra-ai/cinatra");

    // AC7-i: the ONLY boot path is `docker run` of the built image — never a
    // host `next start` / server.js.
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run).toBeTruthy();
    expect(run.join(" ")).toContain(previewImageTag(SHA_A));
    expect(fake.calls.flat().join(" ")).not.toMatch(/next start|standalone\/server\.js|server\.js/);

    // AC2: production runtime env + provenance label; never a published name.
    expect(run.join(" ")).toContain(`CINATRA_RUNTIME_MODE=${PREVIEW_RUNTIME_MODE}`);
    expect(run.join(" ")).toContain(`cinatra.preview.provenance=local-image:${SHA_A}`);

    // AC4: durable volume mounted at the extension-data root.
    expect(run.join(" ")).toContain(`cinatra-preview-data-main:${EXTENSION_DATA_ROOT_IN_CONTAINER}`);

    // AC3: the row is surfaced by status.
    const { registry } = readRegistry(registryPath);
    const row = getPreview(registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.imageTag).toBe(previewImageTag(SHA_A));
    expect(row.provenance).toBe(`local-image:${SHA_A}`);
    expect(row.state).toBe("ready");
  });

  it("AC1: create fails if a preview already exists for the slug (points to refresh)", async () => {
    writeRegistry(registryPath, { version: 1, previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" }) } });
    const { deps } = makeDeps({ sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/already exists.*refresh/s);
  });

  it("AC6: create fails before build when the encryption key is missing", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } }, { env: {} });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/CINATRA_ENCRYPTION_KEY/);
    // No build was attempted (fail early).
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });

  it("AC7-iii: create refuses when the materialize bypass is forced on", async () => {
    const { deps } = makeDeps({ sha: SHA_A }, { env: { [ENCRYPTION_KEY_ENV]: KEY_64, [MATERIALIZE_DISABLE_ENV]: "true" } });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/SAFETY invariant/);
  });

  it("AC10: a boot that never reaches healthy fails LOUDLY with diagnostics + cleans up (no orphans)", async () => {
    const state = { sha: SHA_A, health: { status: 503, body: '{"status":"degraded"}' } };
    const { deps, fake } = makeDeps(state);
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy.*degraded/s);
    // The failed container + freshly-built image + empty volume were removed.
    expect(state.removedContainers).toContain("cinatra-preview-main");
    expect(state.removedImages).toContain(previewImageTag(SHA_A));
    expect(state.removedVolumes).toContain("cinatra-preview-data-main");
    // Diagnostics were dumped.
    expect(fake.calls.find((c) => c[0] === "logs")).toBeTruthy();
    // No ready row recorded.
    expect(getPreview(readRegistry(registryPath).registry, "main")).toBeNull();
  });

  it("AC10: a timeout (never healthy) also fails loudly", async () => {
    let t = 0;
    const state = { sha: SHA_A };
    const { deps } = makeDeps(state);
    deps.now = () => (t += 200000); // blow the health budget immediately after first probe
    deps.probeHealth = async () => ({ status: 503, body: '{"status":"starting"}' });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy/);
  });

  it("AC9: create refuses a real production checkout with no preview provenance", async () => {
    writeFileSync(path.join(tmp, ".env.local"), "CINATRA_RUNTIME_MODE=production\n");
    const { deps } = makeDeps({ sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/real production install/);
  });
});

// --------------------------------------------------------------------------
// AC1 + AC3 + AC4 + AC5 — refresh at a new SHA
// --------------------------------------------------------------------------

describe("preview refresh — rebuild at a new SHA (AC1, AC3, AC4, AC5, AC10)", () => {
  function seedReady() {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" }) },
    });
  }

  it("rebuilds at the NEW sha, reboots, REUSES the volume, health-gates, cleans up the superseded image", async () => {
    seedReady();
    const state = { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } };
    const { deps, fake } = makeDeps(state);
    const out = await runPreviewRefresh(["--ref", "main", "--slug", "main"], deps);
    expect(out.sha).toBe(SHA_B);
    expect(out.previousSha).toBe(SHA_A);

    // Built the NEW tag.
    const build = fake.calls.find((c) => c[0] === "build");
    expect(build).toContain(previewImageTag(SHA_B));

    // AC4: durable volume REUSED (same name; never a `volume rm`).
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).toContain(`cinatra-preview-data-main:${EXTENSION_DATA_ROOT_IN_CONTAINER}`);
    expect(state.removedVolumes ?? []).not.toContain("cinatra-preview-data-main");

    // AC4: the replaced container was removed AND the superseded OLD image was
    // cleaned up once the new one was healthy.
    expect(state.removedContainers).toContain("cinatra-preview-main");
    expect(state.removedImages).toContain(previewImageTag(SHA_A));
    // ...but NOT the new image.
    expect(state.removedImages).not.toContain(previewImageTag(SHA_B));

    // AC3: the row records the NEW sha/tag with old->new history.
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_B);
    expect(row.history.map((h) => h.sha)).toEqual([SHA_A, SHA_B]);
  });

  it("AC1: refresh with no existing preview tells you to create first", async () => {
    const { deps } = makeDeps({ sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } });
    await expect(runPreviewRefresh(["--slug", "main"], deps)).rejects.toThrow(/No preview exists.*create/s);
  });

  it("AC4/AC10: a refresh that never reaches healthy fails loudly, PRESERVES the volume, removes the failed new image, marks degraded", async () => {
    seedReady();
    const state = { sha: SHA_B, health: { status: 503, body: '{"status":"error"}' } };
    const { deps } = makeDeps(state);
    await expect(runPreviewRefresh(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy/);
    // Durable volume PRESERVED across the failed refresh.
    expect(state.removedVolumes ?? []).not.toContain("cinatra-preview-data-main");
    // The failed NEW image was removed; the OLD image was NOT (still the last-good tag).
    expect(state.removedImages).toContain(previewImageTag(SHA_B));
    expect(state.removedImages ?? []).not.toContain(previewImageTag(SHA_A));
    // Row marked degraded, still at the old sha.
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.state).toBe("degraded");
    expect(row.sha).toBe(SHA_A);
  });

  it("a refresh whose BUILD fails leaves the running preview untouched (build before replace)", async () => {
    seedReady();
    const state = { sha: SHA_B, buildFails: true };
    const { deps } = makeDeps(state);
    await expect(runPreviewRefresh(["--slug", "main"], deps)).rejects.toThrow(/docker build.*failed/s);
    // No container was removed (we never got to replace).
    expect(state.removedContainers ?? []).not.toContain("cinatra-preview-main");
    // Registry still at the old, healthy sha.
    expect(getPreview(readRegistry(registryPath).registry, "main").sha).toBe(SHA_A);
  });

  it("AC9: refresh REFUSES a genuine production checkout even though a registry row exists (the guard is NOT a no-op for refresh)", async () => {
    // A preview row for `main` already exists globally (registry is
    // checkout-independent). The operator's shell is cd'd into a REAL --mode prod
    // checkout (.env.local = production). Refresh must refuse — the prior no-op
    // let it proceed to `git worktree add` against the production checkout.
    seedReady();
    writeFileSync(path.join(tmp, ".env.local"), "CINATRA_RUNTIME_MODE=production\n");
    const state = { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } };
    const { deps, fake } = makeDeps(state);
    await expect(runPreviewRefresh(["--ref", "main", "--slug", "main"], deps)).rejects.toThrow(/real production install/);
    // Never built (never reached prepareContext/worktree-add against the prod checkout).
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    // The row is untouched: still `ready` at the old sha, never flipped to provisioning/degraded.
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.state).toBe("ready");
    expect(row.sha).toBe(SHA_A);
  });
});

// --------------------------------------------------------------------------
// AC3 — status/list surfaces the recorded sha/tag/provenance
// --------------------------------------------------------------------------

describe("preview status/list (AC3)", () => {
  it("surfaces sha, tag, provenance, volume, and state", () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" }) },
    });
    const logs = [];
    runPreviewStatus(["--slug", "main"], { registryPath, checkoutDir: tmp, log: (...m) => logs.push(m.join(" ")) });
    const line = logs.join("\n");
    expect(line).toContain(`sha=${SHA_A}`);
    expect(line).toContain(`tag=${previewImageTag(SHA_A)}`);
    expect(line).toContain(`provenance=local-image:${SHA_A}`);
    expect(line).toContain("volume=cinatra-preview-data-main");
  });

  it("surfaces a MALFORMED registry loudly rather than reporting 'no previews'", () => {
    mkdirSync(path.dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, "{ not valid json");
    const logs = [];
    const out = runPreviewStatus(["--all"], { registryPath, checkoutDir: tmp, log: (...m) => logs.push(m.join(" ")), logError: (...m) => logs.push(m.join(" ")) });
    expect(out).toEqual({ malformed: true, rows: [] });
    expect(logs.join("\n")).toMatch(/MALFORMED/);
    expect(logs.join("\n")).not.toMatch(/No previews registered/);
  });
});

// --------------------------------------------------------------------------
// Hardening the codex-found issues (correctness of shared-tag/volume/liveness)
// --------------------------------------------------------------------------

describe("preview — shared-SHA image tags are never dropped from under a sibling", () => {
  it("refresh of one slug does NOT remove an image tag another slug still references", async () => {
    // Two previews at the SAME sha share the SHA-global tag. Give slug `two`
    // the same sha the refresh of `one` will supersede.
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        one: makePreviewSlot({ slug: "one", ref: "main", sha: SHA_A, hostPort: 3010, now: () => "T0" }),
        two: makePreviewSlot({ slug: "two", ref: "main", sha: SHA_A, hostPort: 3011, now: () => "T0" }),
      },
    });
    const state = { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } };
    const { deps } = makeDeps(state);
    await runPreviewRefresh(["--slug", "one"], deps);
    // `one` moved to SHA_B; the SHA_A tag is STILL referenced by `two`, so it
    // must NOT have been removed.
    expect(state.removedImages ?? []).not.toContain(previewImageTag(SHA_A));
    // The new SHA_B image is present and NOT removed.
    expect(state.removedImages ?? []).not.toContain(previewImageTag(SHA_B));
  });
});

describe("preview — a failed create never destroys a PRE-EXISTING durable volume", () => {
  it("leaves a pre-existing volume intact on a failed create (only removes a volume it created)", async () => {
    // Volume already exists (recovered/orphaned data) — the fake reports it.
    const state = { sha: SHA_A, volumeExists: true, health: { status: 503, body: '{"status":"error"}' } };
    const { deps } = makeDeps(state);
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy/);
    // The pre-existing volume was NOT removed.
    expect(state.removedVolumes ?? []).not.toContain("cinatra-preview-data-main");
  });
});

describe("preview — container liveness uses .State.Running, not mere existence", () => {
  it("containerRunning is false for a present-but-stopped container", () => {
    // A stopped container: inspect -f returns "false".
    const stopped = { runDocker: () => ({ status: 0, stdout: "false\n", stderr: "" }) };
    expect(P.containerRunning("x", stopped)).toBe(false);
    const running = { runDocker: () => ({ status: 0, stdout: "true\n", stderr: "" }) };
    expect(P.containerRunning("x", running)).toBe(true);
    const absent = { runDocker: () => ({ status: 1, stdout: "", stderr: "" }) };
    expect(P.containerRunning("x", absent)).toBe(false);
  });
});

describe("preview — degraded classification requires HTTP 503 (AC5, tightened)", () => {
  it("a degraded/error body with a NON-503 status is NOT terminal (keeps polling)", () => {
    expect(classifyHealthResponse({ status: 200, body: '{"status":"degraded"}' })).toBe("unknown");
    expect(classifyHealthResponse({ status: 500, body: '{"status":"error"}' })).toBe("unknown");
    // The exact 503 pairing IS terminal.
    expect(classifyHealthResponse({ status: 503, body: '{"status":"degraded"}' })).toBe("degraded");
  });
});

// --------------------------------------------------------------------------
// Host-port allocation — a preview never collides with the default stack
// (WayFlow's 3010) or with a sibling preview by default.
// --------------------------------------------------------------------------

describe("preview — host-port allocation (no default-stack / sibling collision)", () => {
  it("the preview pool is disjoint from the reserved default WayFlow port (3010)", () => {
    expect(PREVIEW_HOST_PORT_MIN).toBeGreaterThan(3010);
    expect(3010).toBeLessThan(PREVIEW_HOST_PORT_MIN);
  });

  it("allocates the pool base when nothing is claimed", async () => {
    const port = await allocatePreviewHostPort({ registry: { previews: {} }, probe: async () => true });
    expect(port).toBe(PREVIEW_HOST_PORT_MIN);
  });

  it("skips a port already claimed by another preview row (siblings never collide)", async () => {
    const registry = {
      previews: {
        a: makePreviewSlot({ slug: "a", ref: "main", sha: SHA_A, hostPort: PREVIEW_HOST_PORT_MIN, now: () => "T0" }),
      },
    };
    expect([...usedPreviewHostPorts(registry)]).toContain(PREVIEW_HOST_PORT_MIN);
    const port = await allocatePreviewHostPort({ registry, probe: async () => true });
    expect(port).toBe(PREVIEW_HOST_PORT_MIN + 1);
  });

  it("skips a port a live probe reports busy (e.g. WayFlow / another process on it)", async () => {
    const busy = new Set([PREVIEW_HOST_PORT_MIN]);
    const port = await allocatePreviewHostPort({ registry: { previews: {} }, probe: async (p) => !busy.has(p) });
    expect(port).toBe(PREVIEW_HOST_PORT_MIN + 1);
  });

  it("throws actionably when the pool is exhausted", async () => {
    await expect(
      allocatePreviewHostPort({ registry: { previews: {} }, probe: async () => false }),
    ).rejects.toThrow(/No free preview host port/);
  });

  it("validatePreviewPort accepts a valid explicit port and rejects out-of-range / trailing garbage", () => {
    expect(validatePreviewPort("4200")).toBe(4200);
    expect(() => validatePreviewPort("nope")).toThrow(/between 1024 and 65535/);
    expect(() => validatePreviewPort("80")).toThrow(/between 1024 and 65535/);
    // The whole token must be digits — no `parseInt` trailing-garbage acceptance.
    expect(() => validatePreviewPort("4321junk")).toThrow(/between 1024 and 65535/);
  });

  it("refresh of a LEGACY row (no recorded hostPort) allocates AND PERSISTS a durable port in the locked claim", async () => {
    // Legacy row: created before per-preview ports (hostPort null).
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, now: () => "T0" }) },
    });
    expect(getPreview(readRegistry(registryPath).registry, "main").hostPort).toBeNull();
    // Build fails AFTER the claim is written — abort restores from the persisted
    // provisioning row, so the restored row must already carry the allocated port,
    // proving it was written into the locked claim (visible to a concurrent create).
    const { deps } = makeDeps({ sha: SHA_B, buildFails: true });
    await expect(runPreviewRefresh(["--slug", "main"], deps)).rejects.toThrow(/docker build.*failed/s);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(Number.isInteger(row.hostPort)).toBe(true);
    expect(row.hostPort).toBeGreaterThanOrEqual(PREVIEW_HOST_PORT_MIN);
    expect(row.hostPort).toBeLessThanOrEqual(PREVIEW_HOST_PORT_MAX);
  });

  it("two creates (different slugs, no --port) get DISTINCT host ports — never both 3010", async () => {
    const { deps: d1 } = makeDeps({ sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } });
    const one = await runPreviewCreate(["--slug", "one"], d1);
    const { deps: d2 } = makeDeps({ sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } });
    const two = await runPreviewCreate(["--slug", "two"], d2);
    expect(one.hostPort).not.toBe(two.hostPort);
    expect([one.hostPort, two.hostPort]).not.toContain(3010);
    expect(one.hostPort).toBeGreaterThanOrEqual(PREVIEW_HOST_PORT_MIN);
    expect(two.hostPort).toBeGreaterThanOrEqual(PREVIEW_HOST_PORT_MIN);
  });

  it("an explicit --port is honored and recorded on the row", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } });
    const out = await runPreviewCreate(["--slug", "main", "--port", "4321"], deps);
    expect(out.hostPort).toBe(4321);
    // The published host port reaches `docker run -p`.
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).toContain("-p 4321:3000");
    expect(getPreview(readRegistry(registryPath).registry, "main").hostPort).toBe(4321);
  });

  it("refresh REUSES the durable recorded host port (does not re-allocate)", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 4444, now: () => "T0" }) },
    });
    const { deps, fake } = makeDeps({ sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } });
    const out = await runPreviewRefresh(["--slug", "main"], deps);
    expect(out.hostPort).toBe(4444);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).toContain("-p 4444:3000");
  });
});
