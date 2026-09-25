// The `preview` lifecycle (cinatra-ai/cinatra-cli#149) — unit/integration tests
// mirroring the epic's own bar (scripts/ci/prod-boot-e2e.sh's state machine).
//
// These are HERMETIC: no real docker/git/network. Every side-effecting op is
// injected via `deps` (runDocker / resolveSha / prepareContext / probeHealth /
// now / sleep), and the registry is pointed at a temp file. A fake docker
// runner RECORDS every argv so we can assert on the exact commands — this is how
// the three hard-NEVERs (AC7) are asserted structurally.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";

// engineering#660: the two DELEGATED env writers own their key sets in
// their own modules; the coverage guard below reads them from there rather than
// transcribing them.
import { buildCoUseEnv } from "../src/install-couse.mjs";
import { CLI_MANAGED_EXECUTION_ENV_KEYS } from "../src/execution-mode.mjs";

import { __test as P } from "../src/preview.mjs";

const {
  isValidSlug,
  isImmutableSha,
  previewImageTag,
  previewProvenance,
  previewContainerName,
  previewVolumeName,
  previewArtifactVolumeName,
  ARTIFACT_VOLUME_OWNER_LABEL,
  assertNotProductionImageTag,
  assertMaterializeNotDisabled,
  assertEncryptionKey,
  assertPreviewCheckoutAllowed,
  readCheckoutEnvMode,
  buildPreviewRunEnvArgs,
  rewriteLoopbackUrlForContainer,
  CONTAINER_HOST_GATEWAY,
  CONTAINER_REWRITE_ENV_KEYS,
  containerDialedLoopbackEndpoints,
  PASSTHROUGH_ENV_KEYS,
  classifyHealthResponse,
  pollHealthGate,
  usedPreviewHostPorts,
  allocatePreviewHostPort,
  validatePreviewPort,
  // cinatra-cli#248
  PREVIEW_BIND_HOST_ENV,
  PREVIEW_BIND_HOST_DEFAULT,
  PREVIEW_BUILD_CACHE_ENV,
  PREVIEW_BUILD_CACHE_DIR_ENV,
  validateBindHost,
  resolveBindHost,
  previewReachHost,
  bindAwareProbePort,
  dockerBuildxDriver,
  dockerBuildxCacheCapable,
  acquireBuildCacheLock,
  releaseBuildCacheLock,
  resolveBuildCacheMode,
  previewBuildCacheDir,
  dockerBuildxAvailable,
  previewBuildDockerArgs,
  readRegistry,
  writeRegistry,
  getPreview,
  listPreviews,
  makePreviewSlot,
  refreshPreviewSlot,
  runPreviewCreate,
  runPreviewRefresh,
  runPreviewStart,
  runPreviewStop,
  runPreviewStatus,
  resolveBuildTimeoutMs,
  formatBuildBudget,
  buildPreviewImage,
  resolveBuildMemoryMb,
  resolveBuildTypecheck,
  resolveBuildCpus,
  resolveBuildBundler,
  buildPreviewBuildArgs,
  dockerfileDeclaredBuildArgs,
  PREVIEW_BUILD_TIMEOUT_DEFAULT_MS,
  PREVIEW_BUILD_TIMEOUT_ENV,
  PREVIEW_BUILD_TIMEOUT_MIN_MS,
  PREVIEW_BUILD_TIMEOUT_MAX_MS,
  PREVIEW_BUILD_MEMORY_ENV,
  PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB,
  PREVIEW_BUILD_MEMORY_MIN_MB,
  PREVIEW_BUILD_MEMORY_MAX_MB,
  PREVIEW_BUILD_TYPECHECK_ENV,
  PREVIEW_BUILD_CPUS_ENV,
  PREVIEW_BUILD_CPUS_MIN,
  PREVIEW_BUILD_CPUS_MAX,
  PREVIEW_BUILD_BUNDLER_ENV,
  PREVIEW_BUILD_BUNDLERS,
  PREVIEW_BUILD_CPUS_ARG,
  PREVIEW_BUILD_BUNDLER_ARG,
  // engineering#666 — the extension-fleet lever
  PREVIEW_FLEETS,
  PREVIEW_FLEET_DEFAULT,
  PREVIEW_FLEET_FLAG,
  PREVIEW_FLEET_ARG,
  resolveFleet,
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
  // The per-invocation options (timeoutMs / stdio) alongside the argv, so the
  // BOUNDS on each subprocess are assertable — cinatra-cli#194 makes the build
  // budget configurable, and a lever nothing asserts is a lever that can rot.
  const opts = [];
  const runDocker = (args, callOpts = {}) => {
    calls.push(args);
    opts.push(callOpts);
    // cinatra-cli#219 — the compose-metadata probes the endpoint-ownership gate
    // runs. Unmodelled by default (reported UNAVAILABLE, never an ownership
    // claim), so a case about something else is unaffected by the gate.
    const ownership = answerComposeOwnership(args, state);
    if (ownership) return ownership;
    const [verb, sub] = args;
    // Separate user-data volume and real container mount inspection. Existing
    // unrelated fixtures start with an owned seeded volume; new lifecycle cases
    // explicitly exercise absent/unknown/foreign data and creation outcomes.
    if (verb === "volume" && args.at(-1).startsWith("cinatra-preview-artifacts-")) {
      const name = args.at(-1); const slug = name.slice("cinatra-preview-artifacts-".length);
      if (sub === "inspect") {
        if (state.artifactProbeOverride) return state.artifactProbeOverride;
        if (state.artifactProbeUnknown) return {status:null,timedOut:true,stdout:"",stderr:""};
        if (state.artifactExists === false) return {status:1,stdout:"",stderr:"no such volume"};
        return {status:0,stdout:JSON.stringify([{Name:name,Driver:"local",Options:state.artifactOptions ?? null,
          Labels:{[ARTIFACT_VOLUME_OWNER_LABEL]:state.artifactOwner ?? slug}}]),stderr:""};
      }
      if (sub === "create") {
        state.artifactExists=true;
        return state.artifactCreateUnknown ? {status:null,timedOut:true,stdout:"",stderr:""} : {status:0,stdout:name,stderr:""};
      }
      if (sub === "rm") { state.artifactDeleted=true; return {status:0,stdout:"",stderr:""}; }
    }
    if (verb === "container" && sub === "inspect" && args.includes("{{json .}}")) {
      const slug=args.at(-1).slice("cinatra-preview-".length);
      return {status:0,stdout:JSON.stringify({Mounts:state.artifactMounts ?? [{Type:"volume",Name:previewArtifactVolumeName(slug),Destination:"/data/artifacts",RW:true}],
        Config:{Env:state.artifactEnv ?? ["CINATRA_ARTIFACT_DATA_ROOT=/data/artifacts"]}}),stderr:""};
    }
    // `docker build ...` — success unless state.buildFails / state.buildTimesOut.
    if (verb === "build") {
      if (state.buildTimesOut) {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }),
          timedOut: true,
        };
      }
      return state.buildFails ? { status: 1, stdout: "", stderr: "build boom", error: null } : { status: 0, stdout: "", stderr: "" };
    }
    // `docker run -d ...` — records the run; container becomes "running".
    if (verb === "run" && sub === "-d") {
      state.containerRunning = true;
      state.containerAbsent = false; // it exists now (cinatra-cli#220)
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    // `docker container inspect -f {{.State.Running}} <name>` — liveness via the
    // running state (a bare inspect would succeed for a STOPPED container).
    if (verb === "container" && sub === "inspect") {
      // cinatra-cli#220: PRESENCE and LIVENESS are different questions — a
      // stopped container still inspects successfully.
      state.inspects = (state.inspects ?? 0) + 1;
      // `livenessUnansweredAfter: n` answers the first n probes and goes silent
      // after that — the shape a daemon saturated mid-operation actually has.
      if (Number.isInteger(state.livenessUnansweredAfter) && state.inspects > state.livenessUnansweredAfter) {
        return { status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") };
      }
      // `restoreExits`: the parked container is renamed back and started, but
      // has exited by the time it is probed.
      if (state.restoreExits && (state.restored ?? false)) return { status: 0, stdout: "false\n", stderr: "" };
      if (state.containerAbsent) return { status: 1, stdout: "", stderr: "No such object" };
      const running = Boolean(state.containerRunning);
      if (state.containerPresentStopped && !running) return { status: 0, stdout: "false\n", stderr: "" };
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "", stderr: running ? "" : "No such object" };
    }
    // `docker volume inspect <name>` — existence (default: does NOT exist).
    // The stderr matters: cinatra-cli#220 only lets a probe that SAID "no such
    // volume" license the abort path to delete it.
    if (verb === "volume" && sub === "inspect") {
      if (state.volumeProbeUnanswered) {
        return { status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") };
      }
      return state.volumeExists
        ? { status: 0, stdout: "[]", stderr: "" }
        : { status: 1, stdout: "", stderr: `Error response from daemon: get ${args[args.length - 1]}: no such volume` };
    }
    // `docker image inspect <ref>` — default: does NOT exist. cinatra-cli#220
    // models the LOCAL image set so the build-skip is assertable, INCLUDING the
    // `cinatra.preview.sha` stamp the reuse decision reads (a docker tag is
    // mutable, so the tag alone is not proof).
    if (verb === "image" && sub === "inspect") {
      const ref = args[args.length - 1];
      const present = state.images instanceof Set && state.images.has(ref);
      if (state.imageProbeUnanswered) {
        return { status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") };
      }
      if (!present) return { status: 1, stdout: "", stderr: `Error: No such image: ${ref}` };
      // engineering#666: the tag may carry a non-default FLEET suffix, but the
      // real build stamps the SHA on the label — the tag is never the stamp.
      const stamped = state.imageLabelSha ?? (ref.split("local-")[1] ?? "").replace(/-(?:required|dev)$/, "");
      return { status: 0, stdout: `${stamped}\n`, stderr: "" };
    }
    // `docker stop|start|rename <name>` — cinatra-cli#220's lifecycle verbs.
    if (verb === "stop") {
      state.containerRunning = false;
      state.stopped = [...(state.stopped ?? []), args[args.length - 1]];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "start") {
      if (state.containerAbsent) return { status: 1, stdout: "", stderr: "No such container" };
      state.restored = true;
      state.containerRunning = true;
      state.started = [...(state.started ?? []), args[args.length - 1]];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "rename") {
      state.renames = [...(state.renames ?? []), args.slice(1)];
      // `renameFailsAfter: n` lets a test fail the n-th rename (the RESTORE) while
      // letting the park succeed.
      const n = state.renames.length;
      const fails = state.renameFails || (Number.isInteger(state.renameFailsAfter) && n > state.renameFailsAfter);
      return { status: fails ? 1 : 0, stdout: "", stderr: fails ? "rename boom" : "" };
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
  /** The options the `docker build` invocation was bounded with. */
  const buildOpts = () => opts[calls.findIndex((a) => a[0] === "build")];
  return { calls, opts, buildOpts, runDocker };
}

// Build an injected deps object for the orchestration functions.
function makeDeps(state, { env, checkoutDir, buildControlEnv } = {}) {
  const fake = makeFakeDocker(state);
  const logs = [];
  const deps = {
    registryPath,
    checkoutDir: checkoutDir ?? tmp,
    env: env ?? { [ENCRYPTION_KEY_ENV]: KEY_64 },
    // cinatra-cli#194: the build budget is read from the OPERATOR's environment,
    // not the container env contract. Default it to an EMPTY map so the suite is
    // hermetic — a developer with CINATRA_PREVIEW_BUILD_TIMEOUT_MS exported in
    // their shell must not change what these tests assert.
    buildControlEnv: buildControlEnv ?? {},
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
// cinatra-cli#190 — the registry env reaches the container, container-reachable
// --------------------------------------------------------------------------

describe("preview — agent-registry env forwarding (cinatra-cli#190)", () => {
  it("AC1: both registry keys are in the passthrough set and are forwarded when present", () => {
    expect(PASSTHROUGH_ENV_KEYS).toContain("CINATRA_AGENT_REGISTRY_URL");
    expect(PASSTHROUGH_ENV_KEYS).toContain("CINATRA_AGENT_REGISTRY_UI_URL");
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: {
        [ENCRYPTION_KEY_ENV]: KEY_64,
        CINATRA_AGENT_REGISTRY_URL: "https://registry.example.test",
        CINATRA_AGENT_REGISTRY_UI_URL: "https://registry.example.test",
      },
    });
    const joined = args.join(" ");
    expect(joined).toContain("CINATRA_AGENT_REGISTRY_URL=https://registry.example.test");
    expect(joined).toContain("CINATRA_AGENT_REGISTRY_UI_URL=https://registry.example.test");
  });

  it("AC2: the container-DIALED registry address is rewritten to the gateway host", () => {
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: {
        [ENCRYPTION_KEY_ENV]: KEY_64,
        CINATRA_AGENT_REGISTRY_URL: "http://127.0.0.1:4973",
        CINATRA_AGENT_REGISTRY_UI_URL: "http://127.0.0.1:4973",
      },
    });
    const joined = args.join(" ");
    expect(joined).toContain(`CINATRA_AGENT_REGISTRY_URL=http://${CONTAINER_HOST_GATEWAY}:4973`);
    // The UI URL is BROWSER-resolved (it only feeds a display field), so it is
    // forwarded verbatim — a container-only name would not resolve on the host.
    expect(joined).toContain("CINATRA_AGENT_REGISTRY_UI_URL=http://127.0.0.1:4973");
    expect(joined).not.toContain(`CINATRA_AGENT_REGISTRY_UI_URL=http://${CONTAINER_HOST_GATEWAY}`);
  });

  it("AC2: browser-resolved URLs are never rewritten", () => {
    for (const key of ["NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL", "NEXT_PUBLIC_SITE_URL", "CINATRA_AGENT_REGISTRY_UI_URL"]) {
      expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain(key);
    }
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: {
        [ENCRYPTION_KEY_ENV]: KEY_64,
        NEXT_PUBLIC_APP_URL: "http://localhost:3400",
        BETTER_AUTH_URL: "http://localhost:3400",
      },
    });
    const joined = args.join(" ");
    expect(joined).toContain("NEXT_PUBLIC_APP_URL=http://localhost:3400");
    expect(joined).toContain("BETTER_AUTH_URL=http://localhost:3400");
    expect(joined).not.toContain(`NEXT_PUBLIC_APP_URL=http://${CONTAINER_HOST_GATEWAY}`);
  });

  it("AC6: with no registry configured on the host, NOTHING is forwarded (hosted default stands)", () => {
    const args = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { [ENCRYPTION_KEY_ENV]: KEY_64 } });
    const joined = args.join(" ");
    expect(joined).not.toContain("CINATRA_AGENT_REGISTRY_URL");
    expect(joined).not.toContain("CINATRA_AGENT_REGISTRY_UI_URL");
    // An empty-string value is equally "not configured".
    const empty = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, CINATRA_AGENT_REGISTRY_URL: "" },
    });
    expect(empty.join(" ")).not.toContain("CINATRA_AGENT_REGISTRY_URL");
  });

  it("the boot maps the gateway host so the rewritten value resolves on a Linux engine too", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { env: { [ENCRYPTION_KEY_ENV]: KEY_64, CINATRA_AGENT_REGISTRY_URL: "http://127.0.0.1:4973" } },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).toContain(`--add-host ${CONTAINER_HOST_GATEWAY}:host-gateway`);
    expect(run.join(" ")).toContain(`CINATRA_AGENT_REGISTRY_URL=http://${CONTAINER_HOST_GATEWAY}:4973`);
  });

  it("the rewrite preserves everything but the host, is idempotent, and never guesses", () => {
    const g = CONTAINER_HOST_GATEWAY;
    // Origin-only URL keeps its exact shape (no appended root path).
    expect(rewriteLoopbackUrlForContainer("http://127.0.0.1:4973")).toBe(`http://${g}:4973`);
    // localhost, the whole 127/8 loopback block, and IPv6 loopback all count.
    expect(rewriteLoopbackUrlForContainer("http://localhost:4973/-/ping")).toBe(`http://${g}:4973/-/ping`);
    expect(rewriteLoopbackUrlForContainer("http://127.0.0.2:4973")).toBe(`http://${g}:4973`);
    expect(rewriteLoopbackUrlForContainer("redis://[::1]:6379")).toBe(`redis://${g}:6379`);
    // userinfo, port, path, query and fragment survive untouched.
    expect(rewriteLoopbackUrlForContainer("postgresql://u:p@127.0.0.1:5434/postgres?sslmode=disable")).toBe(
      `postgresql://u:p@${g}:5434/postgres?sslmode=disable`,
    );
    // Idempotent — a value already at the gateway is not loopback.
    expect(rewriteLoopbackUrlForContainer(`http://${g}:4973`)).toBe(`http://${g}:4973`);
    // Never guesses: a non-loopback host, a non-URL, and empty are unchanged.
    expect(rewriteLoopbackUrlForContainer("https://registry.cinatra.ai")).toBe("https://registry.cinatra.ai");
    expect(rewriteLoopbackUrlForContainer("not a url")).toBe("not a url");
    expect(rewriteLoopbackUrlForContainer("")).toBe("");
    // A loopback-LOOKING hostname that is not loopback is left alone.
    expect(rewriteLoopbackUrlForContainer("http://localhost.example.test:4973")).toBe(
      "http://localhost.example.test:4973",
    );
    // A NON-SPECIAL scheme keeps an opaque host, so an out-of-range "127.x" is
    // NOT a loopback address and must not be rewritten.
    expect(rewriteLoopbackUrlForContainer("postgresql://127.999.999.999:5434/db")).toBe(
      "postgresql://127.999.999.999:5434/db",
    );
    // Odd-but-accepted spellings are normalised by the URL parser, never spliced
    // into a corrupt value.
    expect(rewriteLoopbackUrlForContainer("http:////127.0.0.1:4973")).toBe(`http://${g}:4973`);
    // A trailing slash the operator actually wrote is preserved.
    expect(rewriteLoopbackUrlForContainer("http://127.0.0.1:4973/")).toBe(`http://${g}:4973/`);
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
    // cinatra-cli#220: docker NAMES a missing container; that is absence.
    const absent = { runDocker: () => ({ status: 1, stdout: "", stderr: "Error: No such object: x" }) };
    expect(P.containerRunning("x", absent)).toBe(false);
    expect(P.containerState("x", absent)).toBe("absent");
  });

  it("cinatra-cli#220: an UNANSWERED probe is `unknown` — never reported as absence", () => {
    // Observed for real: right after an aborted image build the daemon was slow
    // enough that this probe timed out. Reading that as "absent" told the
    // operator their RUNNING preview was gone, and would let `start` replace a
    // live container.
    const timedOut = { runDocker: () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") }) };
    expect(P.containerState("x", timedOut)).toBe("unknown");
    // For the health gate, unknown means KEEP POLLING, not "crashed" — a
    // momentarily unresponsive daemon must not tear down a healthy boot.
    expect(P.containerRunning("x", timedOut)).toBe(true);
    const daemonError = { runDocker: () => ({ status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }) };
    expect(P.containerState("x", daemonError)).toBe("unknown");
  });

  it("cinatra-cli#220: stop and start REFUSE on an unknown container state", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const unanswered = (extra = {}) => ({
      registryPath,
      checkoutDir: tmp,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64 },
      log: () => {},
      logError: () => {},
      runDocker: (args) =>
        args[0] === "container"
          ? { status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") }
          : { status: 0, stdout: JSON.stringify([{Name:previewArtifactVolumeName("main"),Driver:"local",Labels:{[ARTIFACT_VOLUME_OWNER_LABEL]:"main"}}]), stderr: "" },
      ...extra,
    });
    await expect(runPreviewStop(["--slug", "main"], unanswered())).rejects.toThrow(/Could not determine the state/);
    await expect(runPreviewStart(["--slug", "main"], unanswered())).rejects.toThrow(
      /Could not determine the state[\s\S]*still serving/,
    );
    // The row is left exactly as found.
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
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

// --------------------------------------------------------------------------
// The image-build budget + its operator lever (cinatra-cli#194)
//
// A fixed 30-minute ceiling could not fit a COLD build (the `next build` compile
// alone measured 31.6 min on a 24GB M4 Pro during #188's proof), so the first
// preview on a machine with no layer cache was a guaranteed cancel with no
// lever. The budget is now a raised DEFAULT plus a documented, BOUNDED env
// override. These tests pin all three acceptance criteria: the default is big
// enough to be sized for a cold build, the lever actually reaches the real
// `docker build`, and no override can remove the bound on a hung build.
// --------------------------------------------------------------------------

describe("preview build budget — default + bounded override (#194)", () => {
  const withOverride = (v) => ({ [PREVIEW_BUILD_TIMEOUT_ENV]: v });

  it("defaults to 90m — a budget sized for a COLD multi-stage build, not the old 30m", () => {
    expect(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS).toBe(5_400_000);
    // The regression this issue is about: the old ceiling was BELOW the measured
    // cost of one stage of the build it was supposed to bound.
    expect(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS).toBeGreaterThan(1_800_000);
    expect(resolveBuildTimeoutMs({})).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);
    expect(resolveBuildTimeoutMs(undefined)).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);
  });

  it("an absent / empty / all-whitespace override means `not set` and takes the default", () => {
    expect(resolveBuildTimeoutMs(withOverride(""))).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);
    expect(resolveBuildTimeoutMs(withOverride("   "))).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);
    // A non-string (an env map is strings, but be explicit) is not an override.
    expect(resolveBuildTimeoutMs({ [PREVIEW_BUILD_TIMEOUT_ENV]: 12345 })).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);
  });

  it("a valid override wins, including at both ends of the accepted range", () => {
    expect(resolveBuildTimeoutMs(withOverride("10800000"))).toBe(10_800_000); // 3h
    expect(resolveBuildTimeoutMs(withOverride(" 60000 "))).toBe(60_000); // surrounding space tolerated
    expect(resolveBuildTimeoutMs(withOverride(String(PREVIEW_BUILD_TIMEOUT_MIN_MS)))).toBe(PREVIEW_BUILD_TIMEOUT_MIN_MS);
    expect(resolveBuildTimeoutMs(withOverride(String(PREVIEW_BUILD_TIMEOUT_MAX_MS)))).toBe(PREVIEW_BUILD_TIMEOUT_MAX_MS);
  });

  it("AC3: no override can DISABLE the bound — the maximum is finite and enforced", () => {
    expect(PREVIEW_BUILD_TIMEOUT_MAX_MS).toBe(21_600_000); // 6h
    expect(Number.isFinite(PREVIEW_BUILD_TIMEOUT_MAX_MS)).toBe(true);
    for (const v of ["0", "-1", "Infinity", "never", "none", "off", "-0"]) {
      expect(() => resolveBuildTimeoutMs(withOverride(v))).toThrow(new RegExp(PREVIEW_BUILD_TIMEOUT_ENV));
    }
    expect(() => resolveBuildTimeoutMs(withOverride(String(PREVIEW_BUILD_TIMEOUT_MAX_MS + 1)))).toThrow(/exceeds the .* maximum/);
    expect(() => resolveBuildTimeoutMs(withOverride(String(PREVIEW_BUILD_TIMEOUT_MIN_MS - 1)))).toThrow(/below the .* minimum/);
  });

  it("a malformed override is a HARD error naming the var, the value and the range — never a silent fallback", () => {
    for (const v of ["90m", "1.5", "1e6", "0x10", "+5", "abc", "5 minutes"]) {
      let err;
      try {
        resolveBuildTimeoutMs(withOverride(v));
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${v} to be rejected`).toBeTruthy();
      expect(err.message).toContain(PREVIEW_BUILD_TIMEOUT_ENV);
      expect(err.message).toContain(JSON.stringify(v)); // the offending value is quoted back
      expect(err.message).toContain(String(PREVIEW_BUILD_TIMEOUT_MAX_MS)); // the accepted range
      expect(err.message).toMatch(/no value that disables it/);
    }
    // "Silently ignored" is the failure mode that would strand an operator back
    // on the budget that cancelled them, so it must never resolve to the default.
    expect(() => resolveBuildTimeoutMs(withOverride("90m"))).toThrow();
  });

  it("formats budgets readably for the log line and the timeout error", () => {
    expect(formatBuildBudget(5_400_000)).toBe("90m");
    expect(formatBuildBudget(21_600_000)).toBe("6h");
    expect(formatBuildBudget(1_000)).toBe("1s");
    expect(formatBuildBudget(1_500)).toBe("1500ms");
  });

  it("the resolved budget actually BOUNDS the real `docker build` invocation", () => {
    const state = {};
    const fake = makeFakeDocker(state);
    // Default.
    buildPreviewImage({ tag: previewImageTag(SHA_A), contextDir: "/ctx", deps: { runDocker: fake.runDocker, buildControlEnv: {} } });
    expect(fake.buildOpts().timeoutMs).toBe(PREVIEW_BUILD_TIMEOUT_DEFAULT_MS);

    // Override — the lever reaches the subprocess bound, which is the whole point.
    const fake2 = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_B),
      contextDir: "/ctx",
      deps: { runDocker: fake2.runDocker, buildControlEnv: withOverride("10800000") },
    });
    expect(fake2.buildOpts().timeoutMs).toBe(10_800_000);
  });

  it("logs the budget before the build, and names the lever only when it is NOT already set", () => {
    const lines = [];
    const fake = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: fake.runDocker, buildControlEnv: {}, log: (m) => lines.push(m) },
    });
    expect(lines.join("\n")).toContain("budget 90m");
    expect(lines.join("\n")).toContain(PREVIEW_BUILD_TIMEOUT_ENV);

    const lines2 = [];
    const fake2 = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: fake2.runDocker, buildControlEnv: withOverride("10800000"), log: (m) => lines2.push(m) },
    });
    expect(lines2.join("\n")).toContain("budget 3h");
    expect(lines2.join("\n")).toContain("override");
  });

  it("a timeout says the elapsed budget, how to raise it, and that a retry RESUMES from cache", () => {
    const fake = makeFakeDocker({ buildTimesOut: true });
    let err;
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: "/ctx",
        deps: { runDocker: fake.runDocker, buildControlEnv: {} },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toContain("timed out after 90m");
    expect(err.message).toContain(PREVIEW_BUILD_TIMEOUT_ENV);
    // The resumability guidance must be HONEST: completed layers are reused and
    // the retry picks up at the interrupted step, but that step restarts — so a
    // single step longer than the budget is never fixed by retrying alone.
    expect(err.message).toMatch(/reuses every layer that COMPLETED/);
    expect(err.message).toMatch(/restarts at the interrupted step/);
    expect(err.message).toMatch(/raising the budget is required, not just retrying/);
    // A NON-timeout failure must NOT suggest raising the budget — that would
    // send an operator with a real build error off chasing a timeout.
    const fake2 = makeFakeDocker({ buildFails: true });
    expect(() =>
      buildPreviewImage({ tag: previewImageTag(SHA_A), contextDir: "/ctx", deps: { runDocker: fake2.runDocker, buildControlEnv: {} } }),
    ).toThrow(/build boom/);
    try {
      buildPreviewImage({ tag: previewImageTag(SHA_A), contextDir: "/ctx", deps: { runDocker: makeFakeDocker({ buildFails: true }).runDocker, buildControlEnv: {} } });
    } catch (e) {
      expect(e.message).not.toMatch(/reuses every layer that COMPLETED/);
      expect(e.message).not.toMatch(/budget problem/);
    }
  });

  it("the lever is read from the OPERATOR env, NOT the container env contract", async () => {
    // This is the `install --mode preview` trap: that front door REPLACES
    // `deps.env` with a fresh object composed from the install's own .env.local
    // precisely so ambient shell state cannot leak into the container (#188 AC3).
    // A budget read from `deps.env` would therefore be silently inert on exactly
    // the front door #194 names. The container env carries a DECOY value here.
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      {
        env: { [ENCRYPTION_KEY_ENV]: KEY_64, [PREVIEW_BUILD_TIMEOUT_ENV]: "1234" },
        buildControlEnv: withOverride("7200000"),
      },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    expect(fake.buildOpts().timeoutMs).toBe(7_200_000);
    // And the budget is never forwarded INTO the container.
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).not.toContain(PREVIEW_BUILD_TIMEOUT_ENV);
  });

  it("create honours the override and FAILS FAST on a malformed one — before claiming the slug", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withOverride("3600000") },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    expect(fake.buildOpts().timeoutMs).toBe(3_600_000);

    const { deps: bad, fake: badFake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withOverride("nope") },
    );
    await expect(runPreviewCreate(["--slug", "other"], bad)).rejects.toThrow(new RegExp(PREVIEW_BUILD_TIMEOUT_ENV));
    // Nothing was built and NO registry row was claimed — the gate ran first.
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "other")).toBeFalsy();
  });

  it("refresh honours the override and FAILS FAST on a malformed one — the running preview is untouched", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const { deps: bad, fake: badFake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withOverride("0") },
    );
    await expect(runPreviewRefresh(["--slug", "main"], bad)).rejects.toThrow(new RegExp(PREVIEW_BUILD_TIMEOUT_ENV));
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    // The existing row is intact and was never flipped to `provisioning`.
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");

    const { deps, fake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withOverride("4500000") },
    );
    await runPreviewRefresh(["--slug", "main"], deps);
    expect(fake.buildOpts().timeoutMs).toBe(4_500_000);
  });
});

// cinatra-cli#210 — the image build's MEMORY lever and the CI=true forward.
//
// The seam under test is `buildPreviewBuildArgs`: it is the single place the two
// levers are read from the operator's environment and turned into `docker build`
// argv. Asserting the assembled argv (not just the resolvers) is what makes the
// #210 regression impossible to reintroduce — the whole bug was that the values
// existed in principle and never reached the subprocess.
describe("preview build levers — memory ceiling + CI forward (#210)", () => {
  const withMem = (v) => ({ [PREVIEW_BUILD_MEMORY_ENV]: v });
  const buildArgv = (fake) => fake.calls.find((c) => c[0] === "build");
  const argFor = (argv, name) => {
    const out = [];
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === "--build-arg" && String(argv[i + 1]).startsWith(`${name}=`)) {
        out.push(String(argv[i + 1]).slice(name.length + 1));
      }
    }
    return out;
  };

  it("UNSET means unset — the resolved SHA's own Dockerfile keeps its ceiling", () => {
    // The CLI must NOT assert its own idea of a good ceiling onto an arbitrary
    // SHA: a checkout that deliberately chose a different value would be
    // silently overridden, and the two would drift apart on the next change.
    expect(resolveBuildMemoryMb({})).toBeNull();
    expect(resolveBuildMemoryMb(withMem(""))).toBeNull();
    expect(resolveBuildMemoryMb(withMem("   "))).toBeNull();
    expect(resolveBuildMemoryMb({ [PREVIEW_BUILD_MEMORY_ENV]: 4096 })).toBeNull();
    // The 4096 constant survives as DOCUMENTATION of what cinatra bakes in — it
    // is quoted in help/error text and never passed as a build-arg.
    expect(PREVIEW_BUILD_MEMORY_CHECKOUT_DEFAULT_MB).toBe(4096);
    expect(buildPreviewBuildArgs({}).args.join(" ")).not.toContain("NODE_OPTIONS");
  });

  it("a valid override wins, in BOTH directions and at both ends of the range", () => {
    // Both directions must be reachable: UP clears a "JavaScript heap out of
    // memory", and DOWN is what an operator reaches for when V8 is competing with
    // the native allocator for the same container memory.
    expect(resolveBuildMemoryMb(withMem("2048"))).toBe(2048);
    expect(resolveBuildMemoryMb(withMem("8192"))).toBe(8192);
    expect(resolveBuildMemoryMb(withMem(" 3072 "))).toBe(3072);
    expect(resolveBuildMemoryMb(withMem(String(PREVIEW_BUILD_MEMORY_MIN_MB)))).toBe(PREVIEW_BUILD_MEMORY_MIN_MB);
    expect(resolveBuildMemoryMb(withMem(String(PREVIEW_BUILD_MEMORY_MAX_MB)))).toBe(PREVIEW_BUILD_MEMORY_MAX_MB);
  });

  it("a malformed or out-of-range ceiling is a HARD error — never silently ignored or clamped", () => {
    for (const v of ["0", "-1", "4.5", "4g", "4096MB", "1e3", "Infinity", "lots", "0x1000", "+4096"]) {
      let err;
      try {
        resolveBuildMemoryMb(withMem(v));
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${v} to be rejected`).toBeTruthy();
      expect(err.message).toContain(PREVIEW_BUILD_MEMORY_ENV);
      expect(err.message).toContain(JSON.stringify(v)); // the offending value is quoted back
      expect(err.message).toContain(String(PREVIEW_BUILD_MEMORY_MAX_MB)); // the accepted range
    }
    expect(() => resolveBuildMemoryMb(withMem(String(PREVIEW_BUILD_MEMORY_MIN_MB - 1)))).toThrow();
    expect(() => resolveBuildMemoryMb(withMem(String(PREVIEW_BUILD_MEMORY_MAX_MB + 1)))).toThrow();
  });

  it("the in-build tsc is OFF by default and only the documented booleans switch it", () => {
    expect(resolveBuildTypecheck({})).toBe(false);
    expect(resolveBuildTypecheck({ [PREVIEW_BUILD_TYPECHECK_ENV]: "" })).toBe(false);
    for (const v of ["1", "true", "TRUE", " yes ", "on"]) {
      expect(resolveBuildTypecheck({ [PREVIEW_BUILD_TYPECHECK_ENV]: v })).toBe(true);
    }
    for (const v of ["0", "false", "no", "off"]) {
      expect(resolveBuildTypecheck({ [PREVIEW_BUILD_TYPECHECK_ENV]: v })).toBe(false);
    }
    // A near-miss must not be silently read as its opposite.
    for (const v of ["yes-please", "2", "maybe"]) {
      expect(() => resolveBuildTypecheck({ [PREVIEW_BUILD_TYPECHECK_ENV]: v })).toThrow(
        new RegExp(PREVIEW_BUILD_TYPECHECK_ENV),
      );
    }
  });

  it("assembles CI always and NODE_OPTIONS only on an explicit override", () => {
    const { args, memoryMb, typecheck } = buildPreviewBuildArgs({});
    expect(memoryMb).toBeNull();
    expect(typecheck).toBe(false);
    expect(argFor(args, "CI")).toEqual(["true"]);
    expect(argFor(args, "NODE_OPTIONS")).toEqual([]);
    // Explicitly PINNED, not omitted: with the typecheck switch on, CI is still
    // passed (empty), so the build never depends on that SHA's ARG default.
    const on = buildPreviewBuildArgs({ [PREVIEW_BUILD_TYPECHECK_ENV]: "1" });
    expect(argFor(on.args, "CI")).toEqual([""]);
    // The ceiling composes into NODE_OPTIONS as MB — the unit the lever documents.
    const tuned = buildPreviewBuildArgs(withMem("1536"));
    expect(argFor(tuned.args, "NODE_OPTIONS")).toEqual(["--max-old-space-size=1536"]);
  });

  it("the levers REACH the real `docker build` argv — the actual #210 regression", () => {
    const fake = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: fake.runDocker, buildControlEnv: {} },
    });
    const argv = buildArgv(fake);
    expect(argFor(argv, "CI")).toEqual(["true"]); // leg 2: was absent entirely
    expect(argFor(argv, "NODE_OPTIONS")).toEqual([]); // untuned: the SHA keeps its own

    const fake2 = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_B),
      contextDir: "/ctx",
      deps: { runDocker: fake2.runDocker, buildControlEnv: withMem("2048") },
    });
    expect(argFor(buildArgv(fake2), "NODE_OPTIONS")).toEqual(["--max-old-space-size=2048"]);
  });

  it("the build-args precede the context path and never disturb the labels or the tag", () => {
    const fake = makeFakeDocker({});
    const tag = previewImageTag(SHA_A);
    buildPreviewImage({
      tag,
      contextDir: "/ctx",
      provenance: previewProvenance(SHA_A),
      sha: SHA_A,
      deps: { runDocker: fake.runDocker, buildControlEnv: {} },
    });
    const argv = buildArgv(fake);
    // docker treats the LAST positional as the context; a flag after it would be
    // parsed as a second positional and the build would fail.
    expect(argv[argv.length - 1]).toBe("/ctx");
    expect(argv.slice(0, 5)).toEqual(["build", "-t", tag, "--build-arg", "CI=true"]);
    expect(argv).toContain(`cinatra.preview.sha=${SHA_A}`);
    expect(argv).toContain(`cinatra.preview.provenance=${previewProvenance(SHA_A)}`);
  });

  it("logs the effective ceiling and the tsc decision on EVERY build, tuned or not", () => {
    const lines = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines.push(m) },
    });
    const out = lines.join("\n");
    // Untuned: says the checkout owns the ceiling, and still names the lever so
    // it is discoverable BEFORE an operator needs it.
    expect(out).toMatch(/the checkout's own Dockerfile ceiling/);
    expect(out).toContain(PREVIEW_BUILD_MEMORY_ENV);
    expect(out).toMatch(/tsc skipped/);

    const lines2 = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: {
        runDocker: makeFakeDocker({}).runDocker,
        buildControlEnv: { ...withMem("2048"), [PREVIEW_BUILD_TYPECHECK_ENV]: "1" },
        log: (m) => lines2.push(m),
      },
    });
    const out2 = lines2.join("\n");
    expect(out2).toContain("--max-old-space-size=2048");
    expect(out2).toContain("override");
    expect(out2).toMatch(/tsc ON/);
  });

  it("a FAILED build names the memory lever — a timeout does not (that one is a budget)", () => {
    let err;
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: "/ctx",
        deps: { runDocker: makeFakeDocker({ buildFails: true }).runDocker, buildControlEnv: {} },
      });
    } catch (e) {
      err = e;
    }
    expect(err.message).toContain(PREVIEW_BUILD_MEMORY_ENV);
    // The distinction the issue is ABOUT: an OOM is not fixed by a bigger budget.
    expect(err.message).toMatch(/a larger build budget cannot fix it/);
    // And the HONEST distinction inside that: the lever is V8's old space, so it
    // must not be sold as a cure for a NATIVE allocation failure (#210 review).
    expect(err.message).toMatch(/JavaScript heap out of memory" is the V8 old-space limit/);
    expect(err.message).toMatch(/NATIVE "cannot allocate memory" is NOT that limit/);
    expect(err.message).toMatch(/does not bound native allocation/);
    // And it must not over-diagnose: exit 137 names a SIGKILL, not a cause, and
    // "more RAM" is offered as MAY help — #210 measured a native wall that
    // survived 4 GB to 14 GB, so promising RAM as the remedy would misdirect.
    expect(err.message).toMatch(/only tells you something sent SIGKILL/);
    expect(err.message).toMatch(/more VM RAM MAY help/);
    expect(err.message).toMatch(/build-concurrency \/ bundler-fallback/);

    let timedOut;
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: "/ctx",
        deps: { runDocker: makeFakeDocker({ buildTimesOut: true }).runDocker, buildControlEnv: {} },
      });
    } catch (e) {
      timedOut = e;
    }
    expect(timedOut.message).not.toContain(PREVIEW_BUILD_MEMORY_ENV);
  });

  it("reads a context Dockerfile's ARG declarations, and says so when a lever is INERT", () => {
    const ctx = path.join(tmp, "ctx-old");
    mkdirSync(ctx, { recursive: true });
    // A SHA whose Dockerfile predates both ARGs — docker would drop the
    // build-args with only a warning, so the build must say it out loud.
    writeFileSync(path.join(ctx, "Dockerfile"), "FROM node:24-alpine\nENV NODE_ENV=production\nRUN echo hi\n");
    expect([...dockerfileDeclaredBuildArgs(ctx)]).toEqual([]);
    const lines = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ctx,
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: withMem("2048"), log: (m) => lines.push(m) },
    });
    const out = lines.join("\n");
    expect(out).toMatch(/ARG CI/);
    expect(out).toMatch(/ARG NODE_OPTIONS/);
    expect(out).toMatch(/very likely ignored by THIS build/);
    // Only args actually PASSED are reported: untuned, NODE_OPTIONS is not sent,
    // so warning about it would be noise on every build of an older SHA.
    const untuned = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ctx,
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => untuned.push(m) },
    });
    expect(untuned.join("\n")).toMatch(/ARG CI/);
    expect(untuned.join("\n")).not.toMatch(/ARG NODE_OPTIONS/);

    // A modern context declares both — no warning, and the build is unchanged.
    const ok = path.join(tmp, "ctx-new");
    mkdirSync(ok, { recursive: true });
    writeFileSync(
      path.join(ok, "Dockerfile"),
      'FROM node:24-alpine\nARG CI=\nARG NODE_OPTIONS="--max-old-space-size=4096"\nENV NODE_OPTIONS=${NODE_OPTIONS}\nRUN echo hi\n',
    );
    expect([...dockerfileDeclaredBuildArgs(ok)].sort()).toEqual(["CI", "NODE_OPTIONS"]);
    const lines2 = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ok,
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines2.push(m) },
    });
    expect(lines2.join("\n")).not.toMatch(/very likely ignored by THIS build/);

    // Unreadable context: "cannot tell" stays quiet rather than crying wolf, and
    // NEVER blocks the build.
    expect(dockerfileDeclaredBuildArgs(path.join(tmp, "nope"))).toBeNull();
    const lines3 = [];
    expect(() =>
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: path.join(tmp, "nope"),
        deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines3.push(m) },
      }),
    ).not.toThrow();
    expect(lines3.join("\n")).not.toMatch(/very likely ignored by THIS build/);
  });

  it("the ARG scan tolerates docker's real syntax — lowercase and line continuations", () => {
    // Dockerfile instructions are case-insensitive and can be continued across
    // lines; a scan that missed either would cry wolf on a Dockerfile that is
    // in fact fine (#210 review, finding 4).
    const ctx = path.join(tmp, "ctx-syntax");
    mkdirSync(ctx, { recursive: true });
    writeFileSync(
      path.join(ctx, "Dockerfile"),
      "FROM node:24-alpine\narg CI=\nARG \\\n  NODE_OPTIONS=--max-old-space-size=4096\nRUN echo hi\n",
    );
    expect([...dockerfileDeclaredBuildArgs(ctx)].sort()).toEqual(["CI", "NODE_OPTIONS"]);
    const lines = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ctx,
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: withMem("2048"), log: (m) => lines.push(m) },
    });
    expect(lines.join("\n")).not.toMatch(/very likely ignored by THIS build/);
  });

  it("the levers are read from the OPERATOR env, not the container env contract", async () => {
    // Same trap #194 documents: `install --mode preview` REPLACES deps.env with a
    // fresh object composed from the install's .env.local, so a lever read from
    // there is silently inert on exactly that front door. Decoys in the container env.
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      {
        env: { [ENCRYPTION_KEY_ENV]: KEY_64, [PREVIEW_BUILD_MEMORY_ENV]: "999", [PREVIEW_BUILD_TYPECHECK_ENV]: "1" },
        buildControlEnv: withMem("2048"),
      },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    expect(argFor(buildArgv(fake), "NODE_OPTIONS")).toEqual(["--max-old-space-size=2048"]);
    expect(argFor(buildArgv(fake), "CI")).toEqual(["true"]); // the container-env decoy did NOT flip it
    // And neither lever is forwarded INTO the container.
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).not.toContain(PREVIEW_BUILD_MEMORY_ENV);
    expect(run.join(" ")).not.toContain(PREVIEW_BUILD_TYPECHECK_ENV);
  });

  it("create FAILS FAST on a malformed ceiling — before the slug is ever claimed", async () => {
    const { deps: bad, fake: badFake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withMem("4g") },
    );
    await expect(runPreviewCreate(["--slug", "other"], bad)).rejects.toThrow(new RegExp(PREVIEW_BUILD_MEMORY_ENV));
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "other")).toBeFalsy();
  });

  it("refresh FAILS FAST on a malformed ceiling — the running preview is untouched", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const { deps: bad, fake: badFake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: { [PREVIEW_BUILD_TYPECHECK_ENV]: "yes-please" } },
    );
    await expect(runPreviewRefresh(["--slug", "main"], bad)).rejects.toThrow(new RegExp(PREVIEW_BUILD_TYPECHECK_ENV));
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");
  });
});

// The image build's NATIVE-memory levers: the build worker COUNT and the
// bundler selection.
//
// The bug these cover is the same shape as the memory lever's was. The
// checkout's Dockerfile declared both ARGs as its documented remedy for a
// constrained or many-core builder, and no CLI surface could send either one, so
// the remedy was unreachable from `install --mode preview` and from the
// `instance preview` verbs. The decisive assertions are therefore at the
// `docker build` ARGV level, not at the resolver: values that exist in principle
// and never reach the subprocess are exactly what failed before.
describe("preview build levers: worker count + bundler selection", () => {
  const withCpus = (v) => ({ [PREVIEW_BUILD_CPUS_ENV]: v });
  const withBundler = (v) => ({ [PREVIEW_BUILD_BUNDLER_ENV]: v });
  const buildArgv = (fake) => fake.calls.find((c) => c[0] === "build");
  const argFor = (argv, name) => {
    const out = [];
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === "--build-arg" && String(argv[i + 1]).startsWith(`${name}=`)) {
        out.push(String(argv[i + 1]).slice(name.length + 1));
      }
    }
    return out;
  };

  it("names the build-args the checkout's Dockerfile actually declares", () => {
    // A mismatch here is silent: docker drops an unconsumed --build-arg with only
    // a warning, so a renamed arg would look set and do nothing.
    expect(PREVIEW_BUILD_CPUS_ARG).toBe("CINATRA_BUILD_CPUS");
    expect(PREVIEW_BUILD_BUNDLER_ARG).toBe("CINATRA_BUILD_BUNDLER");
    // The operator-facing names join the family the other levers established.
    expect(PREVIEW_BUILD_CPUS_ENV).toBe("CINATRA_PREVIEW_BUILD_CPUS");
    expect(PREVIEW_BUILD_BUNDLER_ENV).toBe("CINATRA_PREVIEW_BUILD_BUNDLER");
    expect(PREVIEW_BUILD_BUNDLERS).toEqual(["turbopack", "webpack"]);
  });

  it("UNSET means unset: the resolved SHA keeps its own worker count and bundler", () => {
    // A preview builds an ARBITRARY SHA. Asserting the CLI's idea of a good
    // worker count or bundler onto it would silently override a checkout that
    // chose otherwise, and the two would drift on the next change.
    expect(resolveBuildCpus({})).toBeNull();
    expect(resolveBuildCpus(withCpus(""))).toBeNull();
    expect(resolveBuildCpus(withCpus("   "))).toBeNull();
    expect(resolveBuildCpus({ [PREVIEW_BUILD_CPUS_ENV]: 4 })).toBeNull(); // non-string is "not set"
    expect(resolveBuildBundler({})).toBeNull();
    expect(resolveBuildBundler(withBundler(""))).toBeNull();
    expect(resolveBuildBundler(withBundler("   "))).toBeNull();
    const { args, cpus, bundler } = buildPreviewBuildArgs({});
    expect(cpus).toBeNull();
    expect(bundler).toBeNull();
    expect(args.join(" ")).not.toContain(PREVIEW_BUILD_CPUS_ARG);
    expect(args.join(" ")).not.toContain(PREVIEW_BUILD_BUNDLER_ARG);
  });

  it("a valid worker count wins, at both ends of the accepted band", () => {
    expect(resolveBuildCpus(withCpus("3"))).toBe(3);
    expect(resolveBuildCpus(withCpus(" 4 "))).toBe(4);
    expect(resolveBuildCpus(withCpus(String(PREVIEW_BUILD_CPUS_MIN)))).toBe(PREVIEW_BUILD_CPUS_MIN);
    expect(resolveBuildCpus(withCpus(String(PREVIEW_BUILD_CPUS_MAX)))).toBe(PREVIEW_BUILD_CPUS_MAX);
  });

  it("a malformed or out-of-range worker count is a HARD error, never ignored or clamped", () => {
    for (const v of ["0", "-1", "1.5", "4 cores", "1e1", "Infinity", "auto", "0x4", "+4"]) {
      let err;
      try {
        resolveBuildCpus(withCpus(v));
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${v} to be rejected`).toBeTruthy();
      expect(err.message).toContain(PREVIEW_BUILD_CPUS_ENV);
      expect(err.message).toContain(JSON.stringify(v)); // the offending value is quoted back
      expect(err.message).toContain(String(PREVIEW_BUILD_CPUS_MAX)); // the accepted range
      // The UNIT is workers, and <n> IS the worker count (cinatra-cli#229
      // review): an operator told the value becomes "one fewer worker" sets 4
      // to get 3 and gets 4 — the over-fan-out #228 exists to stop.
      expect(err.message).toMatch(/COUNT of WORKERS/);
      expect(err.message).toMatch(/3 means three/);
      expect(err.message).not.toMatch(/one fewer|process fewer|fewer page-data/);
    }
    expect(() => resolveBuildCpus(withCpus(String(PREVIEW_BUILD_CPUS_MAX + 1)))).toThrow(/exceeds/);
  });

  it("only the accepted bundlers are taken, case-insensitively, and a typo is refused", () => {
    // The checkout's own launcher lowercases before it matches, so the CLI must
    // not reject a spelling the build would have accepted.
    for (const v of PREVIEW_BUILD_BUNDLERS) {
      expect(resolveBuildBundler(withBundler(v))).toBe(v);
      expect(resolveBuildBundler(withBundler(v.toUpperCase()))).toBe(v);
      expect(resolveBuildBundler(withBundler(` ${v} `))).toBe(v);
    }
    // A near-miss must never be silently read as one of the two: a typo that
    // costs a long build and then reports the OTHER bundler is worse than no
    // lever at all.
    for (const v of ["turbo", "webpack5", "rspack", "none", "1"]) {
      let err;
      try {
        resolveBuildBundler(withBundler(v));
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${v} to be rejected`).toBeTruthy();
      expect(err.message).toContain(PREVIEW_BUILD_BUNDLER_ENV);
      expect(err.message).toContain(JSON.stringify(v));
      expect(err.message).toContain(PREVIEW_BUILD_BUNDLERS.join(", "));
    }
  });

  it("assembles each build-arg only on an explicit override", () => {
    const tuned = buildPreviewBuildArgs({ ...withCpus("3"), ...withBundler("WEBPACK") });
    expect(tuned.cpus).toBe(3);
    expect(tuned.bundler).toBe("webpack");
    expect(argFor(tuned.args, PREVIEW_BUILD_CPUS_ARG)).toEqual(["3"]);
    expect(argFor(tuned.args, PREVIEW_BUILD_BUNDLER_ARG)).toEqual(["webpack"]); // lowercased for the build
    // Independently settable: one lever must not require the other.
    expect(argFor(buildPreviewBuildArgs(withCpus("3")).args, PREVIEW_BUILD_BUNDLER_ARG)).toEqual([]);
    expect(argFor(buildPreviewBuildArgs(withBundler("webpack")).args, PREVIEW_BUILD_CPUS_ARG)).toEqual([]);
    // And they never disturb the levers that were already there.
    expect(argFor(tuned.args, "CI")).toEqual(["true"]);
    expect(argFor(tuned.args, "NODE_OPTIONS")).toEqual([]);
  });

  it("the levers REACH the real `docker build` argv: the actual regression", () => {
    const fake = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: fake.runDocker, buildControlEnv: {} },
    });
    // Untuned: nothing is sent, so the resolved SHA's own Dockerfile decides.
    expect(argFor(buildArgv(fake), PREVIEW_BUILD_CPUS_ARG)).toEqual([]);
    expect(argFor(buildArgv(fake), PREVIEW_BUILD_BUNDLER_ARG)).toEqual([]);

    const fake2 = makeFakeDocker({});
    buildPreviewImage({
      tag: previewImageTag(SHA_B),
      contextDir: "/ctx",
      deps: {
        runDocker: fake2.runDocker,
        buildControlEnv: { ...withCpus("3"), ...withBundler("webpack") },
      },
    });
    const argv = buildArgv(fake2);
    expect(argFor(argv, PREVIEW_BUILD_CPUS_ARG)).toEqual(["3"]);
    expect(argFor(argv, PREVIEW_BUILD_BUNDLER_ARG)).toEqual(["webpack"]);
    // docker treats the LAST positional as the context; a flag after it would be
    // parsed as a second positional and the build would fail.
    expect(argv[argv.length - 1]).toBe("/ctx");
  });

  it("reaches the build through BOTH preview verbs, from the operator env", async () => {
    // The container env contract is a decoy: `install --mode preview` replaces it
    // with a fresh object composed from the install's .env.local, so a lever read
    // from there is silently inert on exactly that front door.
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      {
        env: { [ENCRYPTION_KEY_ENV]: KEY_64, [PREVIEW_BUILD_CPUS_ENV]: "99" },
        buildControlEnv: { ...withCpus("3"), ...withBundler("webpack") },
      },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    expect(argFor(buildArgv(fake), PREVIEW_BUILD_CPUS_ARG)).toEqual(["3"]);
    expect(argFor(buildArgv(fake), PREVIEW_BUILD_BUNDLER_ARG)).toEqual(["webpack"]);
    // Neither lever is forwarded INTO the container. They are build-time only.
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run.join(" ")).not.toContain(PREVIEW_BUILD_CPUS_ENV);
    expect(run.join(" ")).not.toContain(PREVIEW_BUILD_BUNDLER_ENV);

    const { deps: rdeps, fake: rfake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withCpus("2") },
    );
    await runPreviewRefresh(["--slug", "main"], rdeps);
    expect(argFor(buildArgv(rfake), PREVIEW_BUILD_CPUS_ARG)).toEqual(["2"]);
  });

  it("logs both as part of the build's identity, tuned or not", () => {
    const lines = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines.push(m) },
    });
    const out = lines.join("\n");
    // Untuned: says the checkout owns both, and still names the levers so they
    // are discoverable BEFORE an operator needs them.
    expect(out).toMatch(/build workers: the checkout's own default worker count/);
    expect(out).toContain(PREVIEW_BUILD_CPUS_ENV);
    expect(out).toContain(PREVIEW_BUILD_BUNDLER_ENV);

    const lines2 = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      deps: {
        runDocker: makeFakeDocker({}).runDocker,
        buildControlEnv: { ...withCpus("3"), ...withBundler("webpack") },
        log: (m) => lines2.push(m),
      },
    });
    const out2 = lines2.join("\n");
    // The identity line is labelled WORKERS and reports the value verbatim:
    // 3 in, "3" logged — never "2" (cinatra-cli#229 review).
    expect(out2).toMatch(/build workers: 3/);
    expect(out2).not.toMatch(/build workers: 2\b/);
    expect(out2).not.toMatch(/build CPUs/);
    expect(out2).toMatch(/Bundler: webpack/);
  });

  it("a FAILED build names the lever that applies to a NATIVE death, not only the V8 ceiling", () => {
    let err;
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: "/ctx",
        deps: { runDocker: makeFakeDocker({ buildFails: true }).runDocker, buildControlEnv: {} },
      });
    } catch (e) {
      err = e;
    }
    // The secondary defect: advising only the V8 old-space ceiling sends an
    // operator on the DEFAULT bundler path to raise a limit that is not the
    // binding constraint, and the build fails again the same way.
    expect(err.message).toContain(PREVIEW_BUILD_CPUS_ENV);
    expect(err.message).toContain(PREVIEW_BUILD_BUNDLER_ENV);
    expect(err.message).toMatch(/pinned no bundler, so it ran whatever this SHA defaults to/);
    expect(err.message).toMatch(/If that is Turbopack, a native death is the expected one/);
    expect(err.message).toMatch(/os\.cpus\(\)\.length/); // WHY a docker --cpus cap does not help
    expect(err.message).toMatch(/docker --cpus cap does NOT do/);
    // Honest about the bound: neither lever is sold as removing the floor.
    expect(err.message).toMatch(/Neither removes the checkout's documented builder-memory floor/);
    // And the build's own settings are quoted back, so the operator is not told
    // to set something they already set.
    expect(err.message).toMatch(/this build used the checkout's own default worker count/);
    // The lever is named in its true unit, and the PHASE it acts in is stated:
    // it bounds page-data/static generation AFTER compile, and cannot rescue a
    // death DURING compile (cinatra-cli#229 review, non-blocking note).
    expect(err.message).toMatch(/<n> IS the worker count, so 3 means three/);
    expect(err.message).toMatch(/does not fix a death DURING compile/);
    expect(err.message).not.toMatch(/one fewer|process fewer|fewer page-data/);

    const failWith = (buildControlEnv) => {
      try {
        buildPreviewImage({
          tag: previewImageTag(SHA_A),
          contextDir: "/ctx",
          deps: { runDocker: makeFakeDocker({ buildFails: true }).runDocker, buildControlEnv },
        });
      } catch (e) {
        return e;
      }
      throw new Error("expected the build to fail");
    };

    // The advice FITS the bundler this build actually ran. Telling an operator
    // who already pinned webpack to switch bundler is not actionable, and it
    // hides that on webpack the V8 ceiling IS the applicable lever.
    const onWebpack = failWith({ ...withCpus("3"), ...withBundler("webpack") });
    expect(onWebpack.message).toMatch(/this build used 3/); // the worker count is a lever on both paths
    expect(onWebpack.message).toMatch(/already ran on webpack/);
    expect(onWebpack.message).toMatch(new RegExp(`${PREVIEW_BUILD_MEMORY_ENV} is the ceiling that applies here`));
    expect(onWebpack.message).not.toMatch(/pin webpack with/);
    expect(onWebpack.message).not.toMatch(/If that is Turbopack/);

    const onTurbopack = failWith(withBundler("turbopack"));
    expect(onTurbopack.message).toMatch(/pinned turbopack/);
    expect(onTurbopack.message).toMatch(new RegExp(`pin webpack with ${PREVIEW_BUILD_BUNDLER_ENV}=webpack`));
    // The unset wording must not leak into a build that DID pin a bundler.
    expect(onTurbopack.message).not.toMatch(/whatever this SHA defaults to/);

    // A TIMEOUT is a budget failure, not a memory one, so it must not be
    // answered with memory levers.
    let timedOut;
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: "/ctx",
        deps: { runDocker: makeFakeDocker({ buildTimesOut: true }).runDocker, buildControlEnv: {} },
      });
    } catch (e) {
      timedOut = e;
    }
    expect(timedOut.message).not.toContain(PREVIEW_BUILD_CPUS_ENV);
    expect(timedOut.message).not.toContain(PREVIEW_BUILD_BUNDLER_ENV);
  });

  it("an old SHA that declares neither ARG still BUILDS: it is warned about, never blocked", () => {
    const ctx = path.join(tmp, "ctx-no-native-args");
    mkdirSync(ctx, { recursive: true });
    // A Dockerfile that predates both ARGs: docker would drop the build-args with
    // only a warning, so the build must say it out loud and carry on.
    writeFileSync(path.join(ctx, "Dockerfile"), "FROM node:24-alpine\nARG CI=\nRUN echo hi\n");
    const lines = [];
    expect(() =>
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: ctx,
        deps: {
          runDocker: makeFakeDocker({}).runDocker,
          buildControlEnv: { ...withCpus("3"), ...withBundler("webpack") },
          log: (m) => lines.push(m),
        },
      }),
    ).not.toThrow();
    const out = lines.join("\n");
    expect(out).toMatch(new RegExp(`ARG ${PREVIEW_BUILD_CPUS_ARG}`));
    expect(out).toMatch(new RegExp(`ARG ${PREVIEW_BUILD_BUNDLER_ARG}`));
    expect(out).toMatch(/very likely ignored by THIS build/);
    expect(out).not.toMatch(/ARG CI\b(?![_A-Z])/); // CI IS declared here, so no false alarm

    // Only args actually PASSED are reported: untuned, neither is sent, so
    // warning about them would be noise on every build of an older SHA.
    const untuned = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ctx,
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => untuned.push(m) },
    });
    expect(untuned.join("\n")).not.toMatch(/very likely ignored by THIS build/);

    // A modern context declares both, so no warning, and the build is unchanged.
    const ok = path.join(tmp, "ctx-native-args");
    mkdirSync(ok, { recursive: true });
    writeFileSync(
      path.join(ok, "Dockerfile"),
      `FROM node:24-alpine\nARG CI=\nARG ${PREVIEW_BUILD_BUNDLER_ARG}=\nARG ${PREVIEW_BUILD_CPUS_ARG}=\nRUN echo hi\n`,
    );
    const lines2 = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: ok,
      deps: {
        runDocker: makeFakeDocker({}).runDocker,
        buildControlEnv: { ...withCpus("3"), ...withBundler("webpack") },
        log: (m) => lines2.push(m),
      },
    });
    expect(lines2.join("\n")).not.toMatch(/very likely ignored by THIS build/);
  });

  it("create and refresh FAIL FAST on a typo, before a slug is claimed or a preview is touched", async () => {
    const { deps: bad, fake: badFake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withCpus("auto") },
    );
    await expect(runPreviewCreate(["--slug", "other"], bad)).rejects.toThrow(new RegExp(PREVIEW_BUILD_CPUS_ENV));
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "other")).toBeFalsy();

    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const { deps: badRefresh, fake: badRefreshFake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: withBundler("turbo") },
    );
    await expect(runPreviewRefresh(["--slug", "main"], badRefresh)).rejects.toThrow(
      new RegExp(PREVIEW_BUILD_BUNDLER_ENV),
    );
    expect(badRefreshFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#219 — the Nango wiring, and the ownership gate on every
// container-dialed loopback endpoint
// --------------------------------------------------------------------------

describe("preview — Nango address + credential forwarding (cinatra-cli#219)", () => {
  it("AC3: both keys are in the passthrough set; the ADDRESS is container-rewritten", () => {
    expect(PASSTHROUGH_ENV_KEYS).toContain("NANGO_SERVER_URL");
    expect(PASSTHROUGH_ENV_KEYS).toContain("NANGO_SECRET_KEY");
    expect(CONTAINER_REWRITE_ENV_KEYS).toContain("NANGO_SERVER_URL");
    // The CREDENTIAL is not an address — it is never rewritten.
    expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain("NANGO_SECRET_KEY");
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: {
        [ENCRYPTION_KEY_ENV]: KEY_64,
        NANGO_SERVER_URL: "http://localhost:3003",
        NANGO_SECRET_KEY: "nango-env-key",
        NANGO_ENCRYPTION_KEY: "bmFuZ28=",
      },
    });
    const joined = args.join(" ");
    expect(joined).toContain(`NANGO_SERVER_URL=http://${CONTAINER_HOST_GATEWAY}:3003`);
    expect(joined).toContain("NANGO_SECRET_KEY=nango-env-key");
    expect(joined).toContain("NANGO_ENCRYPTION_KEY=bmFuZ28=");
  });

  it("forwards nothing when the host has no Nango wiring (unchanged for that case)", () => {
    const joined = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { [ENCRYPTION_KEY_ENV]: KEY_64 } }).join(" ");
    expect(joined).not.toContain("NANGO_SERVER_URL");
    expect(joined).not.toContain("NANGO_SECRET_KEY");
  });

  it("a HOSTED Nango is forwarded verbatim (never rewritten, never ownership-checked)", () => {
    const joined = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, NANGO_SERVER_URL: "https://api.nango.example" },
    }).join(" ");
    expect(joined).toContain("NANGO_SERVER_URL=https://api.nango.example");
    expect(containerDialedLoopbackEndpoints({ NANGO_SERVER_URL: "https://api.nango.example" })).toEqual([]);
  });
});

// These NET-NEW Postgres fixtures are assembled from parts so they cannot LOOK
// like a credential to the secret-scan gate (as the install-preview suites
// already do).
const pgUrl = (cred, hostPort, db) => ["postgresql:/", `${cred}@${hostPort}`, db].join("/");
const DB_CRED = ["u", "p"].join(":");

describe("preview — container-dialed endpoint ownership (cinatra-cli#219)", () => {
  const OURS = () => tmp; // the deps' checkoutDir
  const THEIRS = "/tmp/a-different-stack";

  /** Our stack publishes 6379/5434; a FOREIGN project holds 3003 (the #219 repro). */
  function reproWorld() {
    return {
      containers: [
        { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: OURS(), ports: [["127.0.0.1", 6379, 6379]] },
        { id: "own-pg", name: "cinatra-postgres-1", service: "postgres", project: "cinatra", workingDir: OURS(), ports: [["127.0.0.1", 5434, 5432]] },
        { id: "own-nango", name: "cinatra-nango-server-1", service: "nango-server", project: "cinatra", workingDir: OURS(), ports: [] },
        { id: "their-nango", name: "other-nango-server-1", service: "nango-server", project: "other-stack", workingDir: THEIRS, ports: [["0.0.0.0", 3003, 3003]] },
      ],
    };
  }

  const envWith = (extra) => ({ [ENCRYPTION_KEY_ENV]: KEY_64, ...extra });

  it("AC1: create REFUSES before any build when a foreign stack holds the port", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: reproWorld() },
      { env: envWith({ REDIS_URL: "redis://127.0.0.1:6379", NANGO_SERVER_URL: "http://localhost:3003" }) },
    );
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(
      /Refusing to compose this preview[\s\S]*NANGO_SERVER_URL[\s\S]*other-nango-server-1/,
    );
    // Nothing was built and nothing was booted.
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(fake.calls.find((c) => c[0] === "run")).toBeUndefined();
    // The claim was released — the slug is free again.
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "main")).toBeFalsy();
  });

  it("AC4: an owned stack composes exactly as before (no new failure mode)", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: reproWorld() },
      { env: envWith({ REDIS_URL: "redis://127.0.0.1:6379", SUPABASE_DB_URL: pgUrl(DB_CRED, "127.0.0.1:5434", "cinatra") }) },
    );
    const out = await runPreviewCreate(["--slug", "main"], deps);
    expect(out.state).toBe("healthy");
    const run = fake.calls.find((c) => c[0] === "run").join(" ");
    expect(run).toContain(`REDIS_URL=redis://${CONTAINER_HOST_GATEWAY}:6379`);
  });

  it("AC4: a hosted/external endpoint is never flagged", async () => {
    const { deps } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: { containers: [] } },
      { env: envWith({ SUPABASE_DB_URL: pgUrl(DB_CRED, "db.example.test:5432", "cinatra"), REDIS_URL: "rediss://cache.example.test:6380" }) },
    );
    const out = await runPreviewCreate(["--slug", "main"], deps);
    expect(out.state).toBe("healthy");
  });

  it("AC2: a running container that publishes NO host port is reported, not absorbed", async () => {
    const world = { containers: reproWorld().containers.filter((c) => c.id === "own-nango") };
    const { deps } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: world },
      { env: envWith({ NANGO_SERVER_URL: "http://127.0.0.1:3003" }) },
    );
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(
      /cinatra-nango-server-1[\s\S]*publishes NO host port while RUNNING/,
    );
  });

  it("refresh REFUSES before the running preview is touched", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const { deps, fake } = makeDeps(
      { sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' }, compose: reproWorld() },
      { env: envWith({ NANGO_SERVER_URL: "http://localhost:3003" }) },
    );
    await expect(runPreviewRefresh(["--slug", "main"], deps)).rejects.toThrow(/Refusing to compose this preview/);
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(fake.calls.find((c) => c[0] === "rm")).toBeUndefined();
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");
  });

  it("the mode lever fails fast on a typo — before the slug is claimed", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: reproWorld() },
      { env: envWith({ REDIS_URL: "redis://127.0.0.1:6379", CINATRA_PREVIEW_ENDPOINT_OWNERSHIP: "yes" }) },
    );
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/CINATRA_PREVIEW_ENDPOINT_OWNERSHIP.*invalid/s);
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "main")).toBeFalsy();
  });

  it("warn mode proceeds with the finding printed (AC1's loud degradation)", async () => {
    const { deps, logs } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' }, compose: reproWorld() },
      { env: envWith({ NANGO_SERVER_URL: "http://localhost:3003", CINATRA_PREVIEW_ENDPOINT_OWNERSHIP: "warn" }) },
    );
    const out = await runPreviewCreate(["--slug", "main"], deps);
    expect(out.state).toBe("healthy");
    expect(logs.join("\n")).toMatch(/WARNING[\s\S]*NANGO_SERVER_URL[\s\S]*other-nango-server-1/);
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#220 — the lifecycle: reuse a present image, and the ordinary
// container operations (stop / start / re-materialize)
// --------------------------------------------------------------------------

describe("preview — an image already present for the SHA is reused (cinatra-cli#220)", () => {
  const OWNED = () => ({
    containers: [
      { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] },
    ],
  });

  function seedReady(sha = SHA_A, hostPort = 3400) {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha, hostPort, now: () => "T0" }) },
    });
  }

  it("AC1: refresh to a SHA whose image is present does NOT invoke docker build", async () => {
    seedReady(SHA_A);
    const state = {
      sha: SHA_B,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_B)]),
      compose: OWNED(),
    };
    const { deps, fake, logs } = makeDeps(state);
    const out = await runPreviewRefresh(["--ref", "main", "--slug", "main"], deps);
    expect(out.sha).toBe(SHA_B);
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    // …and the container really runs that image.
    expect(fake.calls.find((c) => c[0] === "run").join(" ")).toContain(previewImageTag(SHA_B));
    expect(logs.join("\n")).toMatch(/reusing the image already present for this SHA/);
  });

  it("AC2: --rebuild (and --force-build) force the build back on", async () => {
    for (const flag of ["--rebuild", "--force-build"]) {
      seedReady(SHA_A);
      const state = {
        sha: SHA_B,
        health: { status: 200, body: '{"status":"ok"}' },
        images: new Set([previewImageTag(SHA_B)]),
        compose: OWNED(),
      };
      const { deps, fake } = makeDeps(state);
      await runPreviewRefresh(["--ref", "main", "--slug", "main", flag], deps);
      expect(fake.calls.find((c) => c[0] === "build")).toBeTruthy();
    }
  });

  it("still builds when the image is NOT present (unchanged for the ordinary case)", async () => {
    seedReady(SHA_A);
    const { deps, fake } = makeDeps({ sha: SHA_B, health: { status: 200, body: '{"status":"ok"}' }, compose: OWNED() });
    await runPreviewRefresh(["--ref", "main", "--slug", "main"], deps);
    expect(fake.calls.find((c) => c[0] === "build")).toBeTruthy();
  });

  it("create reuses a present image too (two previews at one SHA build it once)", async () => {
    const { deps, fake } = makeDeps({
      sha: SHA_A,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
    });
    await runPreviewCreate(["--slug", "main"], deps);
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });
});

describe("preview stop / start (cinatra-cli#220 AC3, AC4, AC5, AC6)", () => {
  const OWNED = () => ({
    containers: [
      { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] },
    ],
  });

  function seedReady({ sha = SHA_A, hostPort = 3400 } = {}) {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha, hostPort, now: () => "T0" }) },
    });
  }

  it("AC4: stop stops the container and keeps volume, port and row", async () => {
    seedReady();
    const { deps, fake } = makeDeps({ containerRunning: true });
    const out = await runPreviewStop(["--slug", "main"], deps);
    expect(out.container).toBe("stopped");
    expect(fake.calls.find((c) => c[0] === "stop")).toEqual(["stop", "cinatra-preview-main"]);
    // NEVER a volume/image removal, and the row is untouched.
    expect(fake.calls.some((c) => c[0] === "volume" && c[1] === "rm")).toBe(false);
    expect(fake.calls.some((c) => c[0] === "rm")).toBe(false);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.hostPort).toBe(3400);
    expect(row.volumeName).toBe("cinatra-preview-data-main");
    expect(row.state).toBe("ready");
  });

  it("stop is idempotent and refuses an unknown slug", async () => {
    seedReady();
    const { deps: stoppedDeps, fake } = makeDeps({ containerRunning: false, containerPresentStopped: true });
    const out = await runPreviewStop(["--slug", "main"], stoppedDeps);
    expect(out.changed).toBe(false);
    expect(fake.calls.some((c) => c[0] === "stop")).toBe(false);
    const { deps: other } = makeDeps({ containerRunning: true });
    await expect(runPreviewStop(["--slug", "nope"], other)).rejects.toThrow(/No preview exists for slug "nope"/);
  });

  it("AC4: start brings a STOPPED container back WITHOUT destroying it", async () => {
    seedReady();
    const state = { containerRunning: false, containerPresentStopped: true, health: { status: 200, body: '{"status":"ok"}' }, compose: OWNED() };
    const { deps, fake } = makeDeps(state);
    const out = await runPreviewStart(["--slug", "main"], deps);
    expect(out).toMatchObject({ container: "running", rematerialized: false });
    expect(fake.calls.find((c) => c[0] === "start")).toEqual(["start", "cinatra-preview-main"]);
    // No build, no run, no removal — the container was never destroyed.
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
    expect(fake.calls.some((c) => c[0] === "rm")).toBe(false);
  });

  it("start on an already-running preview is a no-op", async () => {
    seedReady();
    const { deps, fake } = makeDeps({ containerRunning: true, health: { status: 200, body: '{"status":"ok"}' }, compose: OWNED() });
    const out = await runPreviewStart(["--slug", "main"], deps);
    expect(out.changed).toBe(false);
    expect(fake.calls.some((c) => c[0] === "run" || c[0] === "build" || c[0] === "start")).toBe(false);
  });

  it("AC3: start RE-MATERIALIZES an absent container from the recorded image — no build", async () => {
    seedReady();
    const state = {
      containerAbsent: true,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
    };
    const { deps, fake, logs } = makeDeps(state, {
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" },
    });
    const out = await runPreviewStart(["--slug", "main"], deps);
    expect(out.rematerialized).toBe(true);
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    const run = fake.calls.find((c) => c[0] === "run").join(" ");
    // Same image, same durable volume, same host port — and FRESH env.
    expect(run).toContain(previewImageTag(SHA_A));
    expect(run).toContain(`cinatra-preview-data-main:${EXTENSION_DATA_ROOT_IN_CONTAINER}`);
    expect(run).toContain("-p 3400:3000");
    expect(run).toContain(`REDIS_URL=redis://${CONTAINER_HOST_GATEWAY}:6379`);
    expect(logs.join("\n")).toMatch(/re-materialized .* from the image already present/);
  });

  it("AC3: --recreate re-materializes a RUNNING container with newly composed env", async () => {
    seedReady();
    const state = {
      containerRunning: true,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
    };
    const { deps, fake } = makeDeps(state, {
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" },
    });
    const out = await runPreviewStart(["--slug", "main", "--recreate"], deps);
    expect(out.rematerialized).toBe(true);
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    // AC6: the OLD container was PARKED (renamed + stopped), not destroyed, and
    // only dropped once the new one was healthy.
    expect(state.renames[0]).toEqual(["cinatra-preview-main", `cinatra-preview-main${P.SUPERSEDED_CONTAINER_SUFFIX}`]);
    expect(state.removedContainers).toContain(`cinatra-preview-main${P.SUPERSEDED_CONTAINER_SUFFIX}`);
  });

  it("AC6: a re-materialization that fails its health gate RESTORES the previous container", async () => {
    seedReady();
    const state = {
      containerRunning: true,
      health: { status: 503, body: '{"status":"degraded"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
    };
    const { deps } = makeDeps(state, { env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" } });
    await expect(runPreviewStart(["--slug", "main", "--recreate"], deps)).rejects.toThrow(
      /PREVIOUS container was restored and restarted/,
    );
    // Renamed aside, then renamed BACK and started again.
    expect(state.renames[1]).toEqual([`cinatra-preview-main${P.SUPERSEDED_CONTAINER_SUFFIX}`, "cinatra-preview-main"]);
    expect(state.started).toContain("cinatra-preview-main");
    // The row is NOT left degraded — the preview is as it was found.
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
  });

  it("start refuses (and never builds) when the recorded image is gone", async () => {
    seedReady();
    const { deps, fake } = makeDeps({ containerAbsent: true, compose: OWNED() });
    await expect(runPreviewStart(["--slug", "main"], deps)).rejects.toThrow(
      /recorded image .* is not present locally[\s\S]*refresh/,
    );
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
  });

  it("cinatra-cli#219 still applies to the re-materialize path", async () => {
    seedReady();
    const state = {
      containerAbsent: true,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: {
        containers: [
          { id: "theirs", name: "other-redis-1", service: "redis", project: "other", workingDir: "/tmp/elsewhere", ports: [["0.0.0.0", 6379, 6379]] },
        ],
      },
    };
    const { deps, fake } = makeDeps(state, { env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" } });
    await expect(runPreviewStart(["--slug", "main"], deps)).rejects.toThrow(/Refusing to compose this preview/);
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
  });

  it("AC5: status reports the CONTAINER's actual state, not only the row's", async () => {
    seedReady();
    const { deps: stoppedDeps, logs: stoppedLogs } = makeDeps({ containerRunning: false, containerPresentStopped: true });
    const rows = runPreviewStatus(["--slug", "main"], stoppedDeps);
    expect(rows[0].container).toBe("stopped");
    expect(stoppedLogs.join("\n")).toMatch(/state=ready container=stopped/);
    expect(stoppedLogs.join("\n")).toMatch(/row is ready but its container is STOPPED/);

    const { deps: absentDeps, logs: absentLogs } = makeDeps({ containerAbsent: true });
    expect(runPreviewStatus(["--slug", "main"], absentDeps)[0].container).toBe("absent");
    expect(absentLogs.join("\n")).toMatch(/re-materializes it from cinatra-preview:local-/);

    const { deps: upDeps, logs: upLogs } = makeDeps({ containerRunning: true });
    expect(runPreviewStatus(["--slug", "main"], upDeps)[0].container).toBe("running");
    expect(upLogs.join("\n")).not.toMatch(/row is ready but/);
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#220 — the round-1 review findings, as tests
// --------------------------------------------------------------------------

describe("preview lifecycle — soundness of the reuse + park/restore paths (cinatra-cli#220)", () => {
  const OWNED = () => ({
    containers: [
      { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] },
    ],
  });
  function seedReady({ sha = SHA_A, hostPort = 3400, state } = {}) {
    const slot = makePreviewSlot({ slug: "main", ref: "main", sha, hostPort, now: () => "T0" });
    writeRegistry(registryPath, { version: 1, previews: { main: state ? { ...slot, state } : slot } });
  }

  it("a tag that was NOT built from this SHA is rebuilt, never trusted", async () => {
    seedReady(); // row at SHA_A
    const { deps, fake, logs } = makeDeps({
      sha: SHA_B,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_B)]),
      imageLabelSha: "not-the-sha-you-are-looking-for",
      compose: OWNED(),
    });
    await runPreviewRefresh(["--slug", "main"], deps);
    expect(fake.calls.find((c) => c[0] === "build")).toBeTruthy();
    expect(logs.join("\n")).toMatch(/was NOT built from this SHA/);
  });

  it("an UNANSWERED image probe builds rather than assuming either way", async () => {
    seedReady();
    const { deps, fake, logs } = makeDeps({
      sha: SHA_B,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_B)]),
      imageProbeUnanswered: true,
      compose: OWNED(),
    });
    await runPreviewRefresh(["--slug", "main"], deps);
    expect(fake.calls.find((c) => c[0] === "build")).toBeTruthy();
    expect(logs.join("\n")).toMatch(/could not read whether .* is present/);
  });

  it("a failed create never deletes an image it only REUSED", async () => {
    const { deps, fake } = makeDeps({
      sha: SHA_A,
      health: { status: 503, body: '{"status":"degraded"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
    });
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy/);
    expect(fake.calls.some((c) => c[0] === "build")).toBe(false);
    // The cached artifact survives — the next attempt must not be forced back
    // through a build this host may not be able to run.
    expect(fake.calls.some((c) => c[0] === "image" && c[1] === "rm")).toBe(false);
  });

  it("the parked name cannot collide with another preview's container", () => {
    // A slug is [a-z0-9][a-z0-9-]* — so `foo--superseded` IS a valid slug, and a
    // `-` suffix would make parking `foo` target THAT preview's container.
    expect(P.SUPERSEDED_CONTAINER_SUFFIX).toBe(".superseded");
    expect(P.isValidSlug("foo--superseded")).toBe(true);
    expect(P.isValidSlug("foo.superseded")).toBe(false);
    const parked = `${P.previewContainerName("foo")}${P.SUPERSEDED_CONTAINER_SUFFIX}`;
    // No valid slug can produce that container name.
    expect(parked).toBe("cinatra-preview-foo.superseded");
    expect(P.previewContainerName("foo--superseded")).not.toBe(parked);
  });

  it("a restore that FAILS says so, and the row is degraded rather than falsely ready", async () => {
    seedReady();
    const state = {
      containerRunning: true,
      health: { status: 503, body: '{"status":"degraded"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
      renameFailsAfter: 1,
    };
    const { deps } = makeDeps(state, { env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" } });
    await expect(runPreviewStart(["--slug", "main", "--recreate"], deps)).rejects.toThrow(
      /could NOT be brought back[\s\S]*preview is DOWN/,
    );
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("degraded");
  });

  it("start on a DEGRADED row only clears it when health actually passes", async () => {
    seedReady({ state: "degraded" });
    // Still unhealthy: the row stays degraded and the container is untouched.
    const sick = makeDeps({ containerRunning: true, health: { status: 503, body: '{"status":"degraded"}' }, compose: OWNED() });
    await expect(runPreviewStart(["--slug", "main"], sick.deps)).rejects.toThrow(/is still degraded[\s\S]*--recreate/);
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("degraded");
    expect(sick.fake.calls.some((c) => c[0] === "rm" || c[0] === "run")).toBe(false);
    // Healthy again: promoted, still without touching the container.
    seedReady({ state: "degraded" });
    const well = makeDeps({ containerRunning: true, health: { status: 200, body: '{"status":"ok"}' }, compose: OWNED() });
    const out = await runPreviewStart(["--slug", "main"], well.deps);
    expect(out.changed).toBe(false);
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
  });

  it("stop CLAIMS the row under the lock and releases it unchanged", async () => {
    seedReady();
    const { deps } = makeDeps({ containerRunning: true });
    // A row already claimed by another operation is refused, not raced.
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        main: { ...makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }), state: "provisioning" },
      },
    });
    await expect(runPreviewStop(["--slug", "main"], deps)).rejects.toThrow(/already in-flight/);
    seedReady();
    await runPreviewStop(["--slug", "main"], deps);
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
  });
});

describe("preview — a durable volume is never destroyed on an unanswered probe (cinatra-cli#220)", () => {
  it("an unanswered `volume inspect` reads as PRE-EXISTING, so abort keeps it", async () => {
    const state = {
      sha: SHA_A,
      health: { status: 503, body: '{"status":"degraded"}' },
      volumeProbeUnanswered: true,
      compose: { containers: [] },
    };
    const { deps } = makeDeps(state);
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(/did not reach healthy/);
    // Unrecoverable if wrong: the volume holds the preview's encrypted data.
    expect(state.removedVolumes ?? []).not.toContain("cinatra-preview-data-main");
  });

  it("volumeAbsence separates docker's \"no such volume\" from a silent probe", () => {
    const absent = { runDocker: () => ({ status: 1, stdout: "", stderr: "Error: No such volume: v" }) };
    const present = { runDocker: () => ({ status: 0, stdout: "[]", stderr: "" }) };
    const quiet = { runDocker: () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: new Error("ETIMEDOUT") }) };
    expect(P.volumeAbsence({ ref: "v", deps: absent })).toBe("absent");
    expect(P.volumeAbsence({ ref: "v", deps: present })).toBe("present");
    expect(P.volumeAbsence({ ref: "v", deps: quiet })).toBe("unknown");
  });
});

describe("preview start — the re-materialize image check is the STAMPED one (cinatra-cli#220)", () => {
  function seedReady() {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
  }
  const OWNED = () => ({
    containers: [
      { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] },
    ],
  });

  it("refuses to boot a tag that was not built from this preview's SHA", async () => {
    seedReady();
    const { deps, fake } = makeDeps({
      containerRunning: true,
      health: { status: 200, body: '{"status":"ok"}' },
      images: new Set([previewImageTag(SHA_A)]),
      imageLabelSha: SHA_B,
      compose: OWNED(),
    });
    await expect(runPreviewStart(["--slug", "main", "--recreate"], deps)).rejects.toThrow(
      /was NOT built from this preview's SHA[\s\S]*--rebuild/,
    );
    // The healthy container was never touched.
    expect(fake.calls.some((c) => c[0] === "rename" || c[0] === "run")).toBe(false);
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("ready");
  });

  it("refuses on an UNANSWERED image probe instead of claiming the image is gone", async () => {
    seedReady();
    const { deps } = makeDeps({
      containerAbsent: true,
      images: new Set([previewImageTag(SHA_A)]),
      imageProbeUnanswered: true,
      compose: OWNED(),
    });
    await expect(runPreviewStart(["--slug", "main"], deps)).rejects.toThrow(
      /Could not determine whether the image .* is present/,
    );
  });
});

describe("preview — the restore/degraded messages say only what was OBSERVED (cinatra-cli#220)", () => {
  function seedReady(state) {
    const slot = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" });
    writeRegistry(registryPath, { version: 1, previews: { main: state ? { ...slot, state } : slot } });
  }
  const OWNED = () => ({
    containers: [
      { id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] },
    ],
  });

  it("a restored container that started and then EXITED is not reported as removed", async () => {
    seedReady();
    // The re-materialized container never becomes healthy; the parked one is
    // renamed back and started, but is present-and-stopped when probed.
    const state = {
      containerRunning: true,
      health: { status: 503, body: '{"status":"degraded"}' },
      images: new Set([previewImageTag(SHA_A)]),
      compose: OWNED(),
      restoreExits: true,
    };
    const { deps } = makeDeps(state, { env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" } });
    await expect(runPreviewStart(["--slug", "main", "--recreate"], deps)).rejects.toThrow(
      /was put back as cinatra-preview-main but is NOT running[\s\S]*docker logs/,
    );
    expect(getPreview(readRegistry(registryPath).registry, "main").state).toBe("degraded");
  });

  it("the degraded re-probe never claims 'left running' on an unread state", async () => {
    seedReady("degraded");
    const { deps } = makeDeps({
      containerRunning: true,
      health: { status: 503, body: '{"status":"degraded"}' },
      compose: OWNED(),
      livenessUnansweredAfter: 1,
    });
    await expect(runPreviewStart(["--slug", "main"], deps)).rejects.toThrow(
      /docker did not answer a state probe, so whether it is still up is UNKNOWN/,
    );
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#248 AC1 — the publish bind address
// --------------------------------------------------------------------------

describe("preview — the publish bind address (cinatra-cli#248 AC1)", () => {
  const OK = { status: 200, body: '{"status":"ok"}' };

  function seedReadyBound({ bind = "127.0.0.1", hostPort = 3400 } = {}) {
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort, bind, now: () => "T0" }),
      },
    });
  }

  it("validates the SHAPE and returns the form `docker run -p` parses", () => {
    expect(validateBindHost("127.0.0.1")).toBe("127.0.0.1");
    expect(validateBindHost("  0.0.0.0  ")).toBe(PREVIEW_BIND_HOST_DEFAULT);
    // An IPv6 literal is BRACKETED: `-p ::1:3400:3000` is ambiguous to docker's
    // own colon-separated publish parser, `-p [::1]:3400:3000` is not.
    expect(validateBindHost("::1")).toBe("[::1]");
    expect(validateBindHost("[::1]")).toBe("[::1]");
  });

  it("refuses a HOSTNAME — docker publishes on an IP literal only", () => {
    // Measured against a real engine (server 29.7.2), not assumed:
    //   $ docker run -p localhost:34995:80 alpine/curl ...
    //   docker: invalid IP address: localhost
    // Accepting a name here would spend a whole build before docker said that.
    for (const name of ["localhost", "example.test", "host.docker.internal", "my-host"]) {
      expect(() => validateBindHost(name)).toThrow(/--bind/);
      expect(() => validateBindHost(name)).toThrow(/IP/);
    }
  });

  it("rejects the values that must never reach `docker run`, naming the lever", () => {
    for (const bad of [
      "",
      "   ",
      "127.0.0.1:3400",
      "http://127.0.0.1",
      "256.256.256.256",
      "1.2.3",
      "a b",
      "127.0.0.1,0.0.0.0",
      undefined,
      null,
      42,
    ]) {
      expect(() => validateBindHost(bad)).toThrow(/--bind/);
    }
  });

  it("the FLAG wins over the env, and neither set means UNCHANGED (null)", () => {
    expect(resolveBindHost({ rest: [], env: {} })).toBe(null);
    expect(resolveBindHost({ rest: [], env: { [PREVIEW_BIND_HOST_ENV]: "127.0.0.1" } })).toBe("127.0.0.1");
    expect(resolveBindHost({ rest: ["--bind", "10.0.0.5"], env: { [PREVIEW_BIND_HOST_ENV]: "127.0.0.1" } })).toBe("10.0.0.5");
    expect(resolveBindHost({ rest: ["--bind=10.0.0.5"], env: {} })).toBe("10.0.0.5");
    // A PRESENT env value is validated, blank included: `FOO=$UNSET` expands to
    // the empty string, and reading that as "unset" would publish on EVERY
    // interface at the moment the operator believed they had narrowed it.
    expect(() => resolveBindHost({ rest: [], env: { [PREVIEW_BIND_HOST_ENV]: "  " } })).toThrow(/--bind/);
    expect(() => resolveBindHost({ rest: [], env: { [PREVIEW_BIND_HOST_ENV]: "" } })).toThrow(/--bind/);
    // A bare `--bind` with no value is a typo, not "unset".
    expect(() => resolveBindHost({ rest: ["--bind"], env: {} })).toThrow(/--bind/);
  });

  it("UNSET publishes byte-identically to the pre-#248 argv (the default is unchanged)", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: OK });
    const out = await runPreviewCreate(["--slug", "main"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe(`${out.hostPort}:3000`);
  });

  it("`--bind` narrows the publish to one interface", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: OK });
    const out = await runPreviewCreate(["--slug", "main", "--bind", "127.0.0.1"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe(`127.0.0.1:${out.hostPort}:3000`);
    expect(run).not.toContain(`${out.hostPort}:3000`);
  });

  it("CINATRA_PREVIEW_BIND_HOST reaches the same argv — and never the container env", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: OK },
      { env: { [ENCRYPTION_KEY_ENV]: KEY_64, [PREVIEW_BIND_HOST_ENV]: "127.0.0.1" } },
    );
    const out = await runPreviewCreate(["--slug", "main"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe(`127.0.0.1:${out.hostPort}:3000`);
    // It is an INVOCATION lever, not part of the container contract.
    expect(run.join(" ")).not.toContain(PREVIEW_BIND_HOST_ENV);
  });

  it("an invalid address is refused BEFORE any docker call and before any claim", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: OK });
    await expect(runPreviewCreate(["--slug", "main", "--bind", "127.0.0.1:3400"], deps)).rejects.toThrow(/--bind/);
    expect(fake.calls).toEqual([]);
  });

  it("the bind is PERSISTED on the registry row and carried forward by `refresh`", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: OK });
    await runPreviewCreate(["--slug", "main", "--bind", "127.0.0.1"], deps);
    expect(getPreview(readRegistry(registryPath).registry, "main").bind).toBe("127.0.0.1");

    const { deps: deps2, fake: fake2 } = makeDeps({ sha: SHA_B, health: OK });
    const out = await runPreviewRefresh(["--slug", "main"], deps2);
    const run = fake2.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe(`127.0.0.1:${out.hostPort}:3000`);
    expect(getPreview(readRegistry(registryPath).registry, "main").bind).toBe("127.0.0.1");
  });

  it("`start --recreate` reuses the recorded bind exactly as it reuses the recorded port", async () => {
    seedReadyBound();
    const { deps, fake } = makeDeps({
      sha: SHA_A,
      health: OK,
      containerRunning: true,
      images: new Set([previewImageTag(SHA_A)]),
    });
    const out = await runPreviewStart(["--slug", "main", "--recreate"], deps);
    expect(out.hostPort).toBe(3400);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe("127.0.0.1:3400:3000");
  });

  it("a row written before #248 (no `bind`) still publishes the unchanged default", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: { main: { ...makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) } },
    });
    const reg = readRegistry(registryPath).registry;
    delete reg.previews.main.bind; // exactly the legacy row shape
    writeRegistry(registryPath, reg);
    const { deps, fake } = makeDeps({
      sha: SHA_A,
      health: OK,
      containerRunning: true,
      images: new Set([previewImageTag(SHA_A)]),
    });
    await runPreviewStart(["--slug", "main", "--recreate"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe("3400:3000");
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#248 AC2 — the DEPLOYMENT-registry env keys
// --------------------------------------------------------------------------

describe("preview — deployment-registry env forwarding (cinatra-cli#248 AC2)", () => {
  const KEYS = [
    "CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL",
    "CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN",
    "CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE",
    "CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE",
  ];
  const VALUES = {
    CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL: "https://deployments.example.test",
    CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN: "read-only-token",
    CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE: "hosted",
    CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE: "false",
  };

  it("all four keys are in the passthrough set", () => {
    for (const k of KEYS) expect(PASSTHROUGH_ENV_KEYS).toContain(k);
  });

  it("they reach the container env VERBATIM when set on the host", () => {
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, ...VALUES },
    });
    const joined = args.join(" ");
    for (const k of KEYS) expect(joined).toContain(`${k}=${VALUES[k]}`);
  });

  it("NOTHING is forwarded when they are unset — or set empty", () => {
    const args = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { [ENCRYPTION_KEY_ENV]: KEY_64 } });
    for (const k of KEYS) expect(args.join(" ")).not.toContain(k);
    const empty = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL: "" },
    });
    expect(empty.join(" ")).not.toContain("CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL");
  });

  it("the PUBLIC url is NOT container-rewritten — 'PUBLIC' means externally reachable", () => {
    for (const k of KEYS) expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain(k);
    const args = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: { [ENCRYPTION_KEY_ENV]: KEY_64, CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL: "http://127.0.0.1:4400" },
    });
    expect(args.join(" ")).toContain("CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL=http://127.0.0.1:4400");
    expect(args.join(" ")).not.toContain(`CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL=http://${CONTAINER_HOST_GATEWAY}`);
  });

  it("they reach the real `docker run` argv through `instance preview create`", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { env: { [ENCRYPTION_KEY_ENV]: KEY_64, ...VALUES } },
    );
    await runPreviewCreate(["--slug", "main"], deps);
    const run = fake.calls.find((c) => c[0] === "run").join(" ");
    for (const k of KEYS) expect(run).toContain(`${k}=${VALUES[k]}`);
  });
});

// --------------------------------------------------------------------------
// cinatra-cli#248 AC3 — a warm build cache through buildx
// --------------------------------------------------------------------------

describe("preview — warm build cache (cinatra-cli#248 AC3)", () => {
  it("the buildx probe trusts only an answer that IDENTIFIES buildx", () => {
    expect(
      dockerBuildxAvailable({ runDocker: () => ({ status: 0, stdout: "github.com/docker/buildx v0.17.1", stderr: "" }) }),
    ).toBe(true);
    // A daemon that answers 0 with nothing is NOT proof buildx is there.
    expect(dockerBuildxAvailable({ runDocker: () => ({ status: 0, stdout: "", stderr: "" }) })).toBe(false);
    expect(
      dockerBuildxAvailable({ runDocker: () => ({ status: 1, stdout: "", stderr: "docker: 'buildx' is not a docker command" }) }),
    ).toBe(false);
    expect(dockerBuildxAvailable({ runDocker: () => { throw new Error("no docker"); } })).toBe(false);
  });

  it("with NO cache dir the build argv is byte-identical to the classic one", () => {
    expect(
      previewBuildDockerArgs({
        tag: "cinatra-preview:local-x",
        contextDir: "/ctx",
        buildArgs: ["--build-arg", "CI=true"],
        provenance: "local-image:x",
        sha: "x",
      }),
    ).toEqual([
      "build",
      "-t",
      "cinatra-preview:local-x",
      "--build-arg",
      "CI=true",
      "--label",
      "cinatra.preview.provenance=local-image:x",
      "--label",
      "cinatra.preview.sha=x",
      "/ctx",
    ]);
  });

  it("with a cache dir it builds through buildx, caching in BOTH directions", () => {
    const args = previewBuildDockerArgs({ tag: "t", contextDir: "/ctx", buildArgs: [], cacheDir: "/cache" });
    expect(args.slice(0, 2)).toEqual(["buildx", "build"]);
    // `--load` puts the result back in the local image store the rest of the
    // lifecycle inspects; `--progress=plain` is what makes the CACHED lines
    // AC3's proof greps for visible at all.
    expect(args).toContain("--load");
    expect(args).toContain("--progress=plain");
    expect(args).toContain("--cache-from=type=local,src=/cache");
    expect(args).toContain("--cache-to=type=local,dest=/cache,mode=max");
    expect(args[args.length - 1]).toBe("/ctx");
  });

  it("the cache mode defaults to auto and fails CLOSED on a typo", () => {
    expect(resolveBuildCacheMode({})).toBe("auto");
    expect(resolveBuildCacheMode({ [PREVIEW_BUILD_CACHE_ENV]: "  " })).toBe("auto");
    expect(resolveBuildCacheMode({ [PREVIEW_BUILD_CACHE_ENV]: "OFF" })).toBe("off");
    expect(() => resolveBuildCacheMode({ [PREVIEW_BUILD_CACHE_ENV]: "yes" })).toThrow(PREVIEW_BUILD_CACHE_ENV);
  });

  it("the cache directory is overridable and defaults under the CLI's own state root", () => {
    expect(previewBuildCacheDir({ [PREVIEW_BUILD_CACHE_DIR_ENV]: "/tmp/x" })).toBe("/tmp/x");
    expect(previewBuildCacheDir({})).toContain(".cinatra");
  });

  it("a build with buildx present runs `buildx build` with the local cache, and CREATES the cache dir", () => {
    const calls = [];
    const cacheDir = path.join(tmp, "bx-cache");
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: path.join(tmp, "ctx"),
      sha: SHA_A,
      provenance: previewProvenance(SHA_A),
      deps: {
        log: () => {},
        buildControlEnv: { [PREVIEW_BUILD_CACHE_DIR_ENV]: cacheDir },
        runDocker: (args) => {
          calls.push(args);
          if (args[0] === "buildx" && args[1] === "version") {
            return { status: 0, stdout: "github.com/docker/buildx v0.17.1", stderr: "" };
          }
          if (args[0] === "buildx" && args[1] === "inspect") {
            return { status: 0, stdout: "Name: builder\nDriver: docker-container\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });
    const build = calls.find((c) => c[0] === "buildx" && c[1] === "build");
    expect(build).toBeTruthy();
    expect(build.join(" ")).toContain(`--cache-from=type=local,src=${cacheDir}`);
    expect(build.join(" ")).toContain(`--cache-to=type=local,dest=${cacheDir},mode=max`);
    expect(existsSync(cacheDir)).toBe(true);
    // The image content is untouched: the same tag, labels and context.
    expect(build).toContain(previewImageTag(SHA_A));
    expect(build[build.length - 1]).toBe(path.join(tmp, "ctx"));
  });

  it("falls back to the classic builder, UNCHANGED, when buildx is not there", () => {
    const calls = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: path.join(tmp, "ctx"),
      sha: SHA_A,
      deps: {
        log: () => {},
        buildControlEnv: {},
        runDocker: (args) => {
          calls.push(args);
          if (args[0] === "buildx") return { status: 1, stdout: "", stderr: "unknown command" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(calls.some((c) => c[0] === "buildx" && c[1] === "build")).toBe(false);
    const build = calls.find((c) => c[0] === "build");
    expect(build).toBeTruthy();
    expect(build.join(" ")).not.toContain("--cache-from");
    expect(build.join(" ")).not.toContain("--progress=plain");
  });

  it("CINATRA_PREVIEW_BUILD_CACHE=off keeps the classic builder even where buildx IS present", () => {
    const calls = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: path.join(tmp, "ctx"),
      sha: SHA_A,
      deps: {
        log: () => {},
        buildControlEnv: { [PREVIEW_BUILD_CACHE_ENV]: "off" },
        runDocker: (args) => {
          calls.push(args);
          if (args[0] === "buildx" && args[1] === "version") {
            return { status: 0, stdout: "github.com/docker/buildx v0.17.1", stderr: "" };
          }
          if (args[0] === "buildx" && args[1] === "inspect") {
            return { status: 0, stdout: "Name: builder\nDriver: docker-container\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(calls.some((c) => c[0] === "buildx")).toBe(false);
    expect(calls.find((c) => c[0] === "build")).toBeTruthy();
  });

  it("a typo'd cache mode is refused BEFORE the slug claim, like every other build lever", async () => {
    const { deps, fake } = makeDeps(
      { sha: SHA_A, health: { status: 200, body: '{"status":"ok"}' } },
      { buildControlEnv: { [PREVIEW_BUILD_CACHE_ENV]: "sometimes" } },
    );
    await expect(runPreviewCreate(["--slug", "main"], deps)).rejects.toThrow(PREVIEW_BUILD_CACHE_ENV);
    expect(fake.calls).toEqual([]);
  });
});


// --------------------------------------------------------------------------
// cinatra-cli#248 — convergence round: the defects a codex review found
// --------------------------------------------------------------------------

describe("preview — bind: what the CLI DIALS follows what docker PUBLISHES (cinatra-cli#248)", () => {
  const OK = { status: 200, body: '{"status":"ok"}' };

  it("previewReachHost is localhost for unset and for every wildcard spelling", () => {
    expect(previewReachHost(null)).toBe("localhost");
    expect(previewReachHost("0.0.0.0")).toBe("localhost");
    expect(previewReachHost("[::]")).toBe("localhost");
    expect(previewReachHost("127.0.0.1")).toBe("127.0.0.1");
    expect(previewReachHost("[::1]")).toBe("[::1]");
  });

  it("a preview bound to ONE non-loopback interface is health-gated THERE, not on localhost", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: OK });
    const urls = [];
    deps.probeHealth = async (url) => {
      urls.push(url);
      return OK;
    };
    const out = await runPreviewCreate(["--slug", "main", "--bind", "10.0.0.5"], deps);
    // localhost never reaches a publish narrowed to another interface — gating
    // there would time out and tear down a container that was in fact healthy.
    expect(urls).toEqual([`http://10.0.0.5:${out.hostPort}/api/health`]);
  });

  it("the UNSET path still gates on localhost, byte for byte", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: OK });
    const urls = [];
    deps.probeHealth = async (url) => {
      urls.push(url);
      return OK;
    };
    const out = await runPreviewCreate(["--slug", "main"], deps);
    expect(urls).toEqual([`http://localhost:${out.hostPort}/api/health`]);
  });

  it("an IPv6 bind is probed on ITS OWN address as well as the wide one", async () => {
    const probed = [];
    const probe = async (port, host = "0.0.0.0") => {
      probed.push(`${host}:${port}`);
      // 3400 is held by an IPv6-only socket; IPv4 3400 is free.
      return !(host === "::1" && port === 3400);
    };
    const bound = bindAwareProbePort({ probe, bind: "[::1]" });
    expect(await bound(3400)).toBe(false);
    expect(await bound(3401)).toBe(true);
    expect(probed).toContain("::1:3400");
    // No bind (and a wildcard) leaves the probe exactly as it was.
    expect(bindAwareProbePort({ probe, bind: null })).toBe(probe);
    expect(bindAwareProbePort({ probe, bind: "0.0.0.0" })).toBe(probe);
  });
});

describe("preview — bind: the row never claims an interface the container is not on (cinatra-cli#248)", () => {
  const OK = { status: 200, body: '{"status":"ok"}' };

  it("a FAILED refresh leaves the row on the bind the still-running container has", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: OK });
    await runPreviewCreate(["--slug", "main"], deps); // wide publish, bind null
    expect(getPreview(readRegistry(registryPath).registry, "main").bind).toBe(null);

    const { deps: deps2 } = makeDeps({ sha: SHA_B, health: OK, buildFails: true });
    await expect(runPreviewRefresh(["--slug", "main", "--bind", "127.0.0.1"], deps2)).rejects.toThrow(/build/i);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    // The old container was never replaced — it is still published on every
    // interface, so a row saying 127.0.0.1 would be a lie the operator acts on.
    expect(row.state).toBe("ready");
    expect(row.bind).toBe(null);
  });

  it("`start` WITHOUT --recreate neither applies nor records a new bind — and says so", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, bind: null, now: () => "T0" }),
      },
    });
    const { deps, fake, logs } = makeDeps({
      sha: SHA_A,
      health: OK,
      containerRunning: true,
      images: new Set([previewImageTag(SHA_A)]),
    });
    await runPreviewStart(["--slug", "main", "--bind", "127.0.0.1"], deps);
    // Nothing was re-materialized: docker cannot move a running publish.
    expect(fake.calls.some((c) => c[0] === "run")).toBe(false);
    expect(getPreview(readRegistry(registryPath).registry, "main").bind).toBe(null);
    expect(logs.join("\n")).toMatch(/--bind 127\.0\.0\.1 was NOT applied/);
    expect(logs.join("\n")).toMatch(/--recreate/);
  });

  it("`start --recreate` DOES apply and record it", async () => {
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, bind: null, now: () => "T0" }),
      },
    });
    const { deps, fake } = makeDeps({
      sha: SHA_A,
      health: OK,
      containerRunning: true,
      images: new Set([previewImageTag(SHA_A)]),
    });
    await runPreviewStart(["--slug", "main", "--bind", "127.0.0.1", "--recreate"], deps);
    const run = fake.calls.find((c) => c[0] === "run");
    expect(run[run.indexOf("-p") + 1]).toBe("127.0.0.1:3400:3000");
    expect(getPreview(readRegistry(registryPath).registry, "main").bind).toBe("127.0.0.1");
  });
});

describe("preview — the build cache only runs on a builder that can hold one (cinatra-cli#248)", () => {
  const buildxThen = (inspect) => (args) => {
    if (args[0] === "buildx" && args[1] === "version") {
      return { status: 0, stdout: "github.com/docker/buildx v0.17.1", stderr: "" };
    }
    if (args[0] === "buildx" && args[1] === "inspect") return inspect;
    return { status: 0, stdout: "", stderr: "" };
  };

  it("reads the builder's driver, and reads an unanswerable probe as UNKNOWN", () => {
    expect(
      dockerBuildxDriver({ runDocker: buildxThen({ status: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" }) }),
    ).toBe("docker");
    expect(
      dockerBuildxDriver({
        runDocker: buildxThen({ status: 0, stdout: "Name: builder\nDriver: docker-container\n", stderr: "" }),
      }),
    ).toBe("docker-container");
    expect(dockerBuildxDriver({ runDocker: buildxThen({ status: 1, stdout: "", stderr: "no builder" }) })).toBe(null);
  });

  it("the DEFAULT `docker` driver cannot export a local cache, so it is not cache-capable", () => {
    const docker = { runDocker: buildxThen({ status: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" }) };
    expect(dockerBuildxCacheCapable(docker)).toBe(false);
    expect(
      dockerBuildxCacheCapable({
        runDocker: buildxThen({ status: 0, stdout: "Name: b\nDriver: docker-container\n", stderr: "" }),
      }),
    ).toBe(true);
  });

  it("buildx PRESENT on the default driver still builds classic — a cache is not worth a failed build", () => {
    const calls = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: path.join(tmp, "ctx"),
      sha: SHA_A,
      deps: {
        log: () => {},
        buildControlEnv: { [PREVIEW_BUILD_CACHE_DIR_ENV]: path.join(tmp, "no-cache-here") },
        runDocker: (args) => {
          calls.push(args);
          return buildxThen({ status: 0, stdout: "Name: default\nDriver: docker\n", stderr: "" })(args);
        },
      },
    });
    // `--cache-to=type=local` fails outright on that driver; the classic builder
    // is the answer that is only slower, never broken.
    expect(calls.some((c) => c[0] === "buildx" && c[1] === "build")).toBe(false);
    const build = calls.find((c) => c[0] === "build");
    expect(build.join(" ")).not.toContain("--cache-from");
    expect(existsSync(path.join(tmp, "no-cache-here"))).toBe(false);
  });

  it("an UNWRITABLE cache directory degrades to classic instead of dying mid-build", () => {
    const cacheDir = path.join(tmp, "ro-cache");
    mkdirSync(cacheDir, { recursive: true });
    chmodSync(cacheDir, 0o500); // exists, and `mkdirSync` is happy — only a write proves it
    const calls = [];
    try {
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: path.join(tmp, "ctx"),
        sha: SHA_A,
        deps: {
          log: () => {},
          buildControlEnv: { [PREVIEW_BUILD_CACHE_DIR_ENV]: cacheDir },
          runDocker: (args) => {
            calls.push(args);
            return buildxThen({ status: 0, stdout: "Name: b\nDriver: docker-container\n", stderr: "" })(args);
          },
        },
      });
    } finally {
      chmodSync(cacheDir, 0o700);
    }
    expect(calls.some((c) => c[0] === "buildx" && c[1] === "build")).toBe(false);
    expect(calls.find((c) => c[0] === "build")).toBeTruthy();
  });

  it("only ONE concurrent build exports the cache; the others still READ it", () => {
    const cacheDir = path.join(tmp, "lock-cache");
    mkdirSync(cacheDir, { recursive: true });
    const held = acquireBuildCacheLock(cacheDir);
    expect(held).toBeTruthy();
    // A second build cannot take it — a local cache destination written twice at
    // once loses one of the two exports.
    expect(acquireBuildCacheLock(cacheDir)).toBe(null);

    const calls = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: path.join(tmp, "ctx"),
      sha: SHA_A,
      deps: {
        log: () => {},
        buildControlEnv: { [PREVIEW_BUILD_CACHE_DIR_ENV]: cacheDir },
        runDocker: (args) => {
          calls.push(args);
          return buildxThen({ status: 0, stdout: "Name: b\nDriver: docker-container\n", stderr: "" })(args);
        },
      },
    });
    const build = calls.find((c) => c[0] === "buildx" && c[1] === "build");
    expect(build.join(" ")).toContain(`--cache-from=type=local,src=${cacheDir}`);
    expect(build.join(" ")).not.toContain("--cache-to");

    releaseBuildCacheLock(held);
    // Released: the next build exports again, and the release is idempotent.
    const second = acquireBuildCacheLock(cacheDir);
    expect(second).toBeTruthy();
    releaseBuildCacheLock(second);
    releaseBuildCacheLock(second);
  });

  it("a build that HOLDS the lock releases it even when docker fails", () => {
    const cacheDir = path.join(tmp, "fail-cache");
    expect(() =>
      buildPreviewImage({
        tag: previewImageTag(SHA_A),
        contextDir: path.join(tmp, "ctx"),
        sha: SHA_A,
        deps: {
          log: () => {},
          buildControlEnv: { [PREVIEW_BUILD_CACHE_DIR_ENV]: cacheDir },
          runDocker: (args) => {
            if (args[0] === "buildx" && args[1] === "build") return { status: 1, stdout: "", stderr: "build boom" };
            return buildxThen({ status: 0, stdout: "Name: b\nDriver: docker-container\n", stderr: "" })(args);
          },
        },
      }),
    ).toThrow(/build/i);
    // The lock is free again: a dead build must not wedge every later one.
    const after = acquireBuildCacheLock(cacheDir);
    expect(after).toBeTruthy();
    releaseBuildCacheLock(after);
  });

  it("the read-only argv carries --cache-from and NO --cache-to", () => {
    const args = previewBuildDockerArgs({ tag: "t", contextDir: "/ctx", cacheDir: "/cache", cacheWrite: false });
    expect(args).toContain("--cache-from=type=local,src=/cache");
    expect(args.join(" ")).not.toContain("--cache-to");
  });
});

// --------------------------------------------------------------------------
// engineering#660 (item 1) — the passthrough list COVERS the dev
// install's extension-install, connection-service and runtime-bridge variables
//
// The gap this closes is not a missing key alone (the registry keys arrived
// with #190, the Nango pair with #219, the deployment-registry four with #248)
// but a missing GUARD: nothing tied PASSTHROUGH_ENV_KEYS to the dev install's
// own set, so the next variable the dev road starts writing could be dropped
// from a preview container silently — a preview that boots fine and then cannot
// install an extension, save a connection, or run an agent.
//
// So the expected set is not transcribed here: it is READ OUT of the dev
// install road — every key `src/install.mjs` re-points or upserts into an
// instance's env file (INCLUDING the writes whose key argument is a constant
// rather than a literal: an unresolved constant is a RED, not a hole), its
// isolation-critical set, the connector credential `src/nango-secret-key.mjs`
// reconciles, and the two delegated writers whose key sets live in their own
// modules (`buildCoUseEnv`, `CLI_MANAGED_EXECUTION_ENV_KEYS`). Every key found
// there must be CLASSIFIED below — forwarded into a preview, set by the preview
// composition itself, or deliberately not forwarded, each with its reason. A
// new dev-install variable is therefore a RED here until someone decides which
// it is; that decision is the point of the test.
// --------------------------------------------------------------------------

describe("preview — the passthrough list covers the dev install's set (engineering#660)", () => {
  const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

  /** The files the dev install road resolves its env-key CONSTANTS from. */
  const KEY_CONSTANT_SOURCES = [
    "../src/install.mjs",
    "../src/prod-env-validate.mjs",
    "../src/wayflow-runtime.mjs",
    "../src/isolated-a2a.mjs",
    "../src/install-couse.mjs",
    "../src/nango-secret-key.mjs",
    "../src/execution-mode.mjs",
  ];

  /** `IDENT` / `IDENT.name` → the env key it names, read out of the road. */
  function keyConstants() {
    const map = new Map();
    for (const rel of KEY_CONSTANT_SOURCES) {
      const src = readSrc(rel);
      for (const m of src.matchAll(/(?:export\s+)?const ([A-Za-z_$][\w$]*) = ["']([A-Z][A-Z0-9_]*)["'];/g)) {
        map.set(m[1], m[2]);
      }
      // `export const ATTEST_KEY = { name: "CINATRA_CONTEXT_ATTEST_KEY", … }`
      for (const m of src.matchAll(/(?:export\s+)?const ([A-Za-z_$][\w$]*) = \{\s*\n\s*name: ["']([A-Z][A-Z0-9_]*)["']/g)) {
        map.set(`${m[1]}.name`, m[2]);
      }
    }
    // …and the ALIASES the road binds them to right before the write
    // (`const ATTEST = ATTEST_KEY.name;`, `const ENC = INSTANCE_ENCRYPTION_KEY;`).
    // Resolved to a fixpoint so an alias of an alias is read too.
    for (let pass = 0; pass < 4; pass += 1) {
      let grew = false;
      for (const rel of KEY_CONSTANT_SOURCES) {
        for (const m of readSrc(rel).matchAll(/const ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$.]*);/g)) {
          const target = map.get(m[2]);
          if (target && !map.has(m[1])) {
            map.set(m[1], target);
            grew = true;
          }
        }
      }
      if (!grew) break;
    }
    return map;
  }

  /**
   * Every env key the dev install writes into an instance's env file, plus the
   * write sites whose key is COMPUTED (those cannot be read statically; they
   * are counted instead, so a new one is a red).
   */
  function devInstallEnvWrites() {
    const installSrc = readSrc("../src/install.mjs");
    const nangoSrc = readSrc("../src/nango-secret-key.mjs");
    const constants = keyConstants();
    const keys = new Set();
    let computedSites = 0;

    // `repointKey("<service>", "KEY", …)` — the infra/connection URLs an install
    // re-points at this instance's own host ports. The key argument is read
    // whether it is a literal (either quote style) or a constant this road
    // declares; a call site whose key resolves to NEITHER is counted below
    // rather than skipped, so it cannot pass as a silent green.
    for (const m of installSrc.matchAll(
      /repointKey\(\s*["'][^"']*["']\s*,\s*(?:["']([A-Z][A-Z0-9_]*)["']|([A-Za-z_$][\w$.]*))\s*,/g,
    )) {
      if (m[1]) {
        keys.add(m[1]);
        continue;
      }
      const resolved = constants.get(m[2]);
      if (resolved) keys.add(resolved);
      else computedSites += 1;
    }

    // `upsertEnvKey(<body>, <key>, …)` — the values an install writes outright.
    // The key argument is a literal, a constant this road declares, or a loop
    // variable; only the third is unreadable, and it is counted below.
    for (const m of installSrc.matchAll(
      /(?<!function )upsertEnvKey\(\s*[A-Za-z_$][\w$.]*\s*,\s*(?:["']([A-Z][A-Z0-9_]*)["']|([A-Za-z_$][\w$.]*))\s*,/g,
    )) {
      if (m[1]) {
        keys.add(m[1]);
        continue;
      }
      const resolved = constants.get(m[2]);
      if (resolved) keys.add(resolved);
      else computedSites += 1;
    }
    // The same for the execution-plane writer, which upserts through a helper.
    for (const _ of installSrc.matchAll(/applyEnvUpsertsToBody\(/g)) computedSites += 1;

    // `for (const key of ["A", "B"]) … upsertEnvKey(body, key, …)` — the loop
    // sites whose key set IS written down, right there, as an array literal.
    for (const m of installSrc.matchAll(/for \(const (?:key|k) of \[([^\]]*)\]\)/g)) {
      for (const lit of m[1].matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) keys.add(lit[1]);
    }

    // The isolation-critical set (`ISOLATED_INFRA_ENV_KEYS`): the keys an
    // isolated install refuses to let the ambient shell override.
    const isolated = installSrc.match(/const ISOLATED_INFRA_ENV_KEYS = \[([\s\S]*?)\n\];/);
    expect(isolated, "ISOLATED_INFRA_ENV_KEYS no longer parses out of src/install.mjs").toBeTruthy();
    for (const m of isolated[1].matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) keys.add(m[1]);

    // The connector credential the bring-up reconciles (cinatra-cli#211).
    for (const m of nangoSrc.matchAll(/NANGO_SECRET_KEY_VAR = ["']([A-Z][A-Z0-9_]*)["']/g)) keys.add(m[1]);

    // The two DELEGATED writers. Their key sets are not literals in
    // install.mjs, so they are taken from the modules that own them rather than
    // guessed: the co-use env writer (`writeCoUseEnv` writes exactly what
    // `buildCoUseEnv` returns) and the execution-plane writer
    // (`persistExecutionEnv` writes exactly `CLI_MANAGED_EXECUTION_ENV_KEYS`).
    // The donor keys `buildCoUseEnv` INHERITS are conditional on the fixture
    // carrying them, so the fixture is not transcribed either: the inherit
    // loops' array literals are read out of the writer's OWN module, and a key
    // that road starts inheriting is therefore discovered rather than missed.
    const couseSrc = readSrc("../src/install-couse.mjs");
    const inheritedDonorKeys = new Set();
    for (const m of couseSrc.matchAll(/for \(const (?:key|k) of \[([^\]]*)\]\)/g)) {
      for (const lit of m[1].matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) inheritedDonorKeys.add(lit[1]);
    }
    expect(
      inheritedDonorKeys.size,
      "the buildCoUseEnv inherit loops no longer parse out of src/install-couse.mjs",
    ).toBeGreaterThan(0);
    for (const key of Object.keys(
      buildCoUseEnv({
        sourceEnv: Object.fromEntries([...inheritedDonorKeys].map((k) => [k, "x"])),
        slug: "couse",
        appPort: 3100,
        dbUrl: "postgresql://127.0.0.1:5432/couse",
      }),
    )) {
      keys.add(key);
    }
    for (const key of CLI_MANAGED_EXECUTION_ENV_KEYS) keys.add(key);
    // …and the planner's OWN write sites, because that constant is a declared
    // INVENTORY while `persistExecutionEnv` writes whatever the plan carries: a
    // key the planner starts pushing without adding it to the inventory is read
    // here, not missed.
    for (const m of readSrc("../src/execution-mode.mjs").matchAll(
      /upserts(?:\.push\(|\s*=\s*\[)\{\s*key:\s*(?:["']([A-Z][A-Z0-9_]*)["']|([A-Za-z_$][\w$.]*))\s*,/g,
    )) {
      if (m[1]) {
        keys.add(m[1]);
        continue;
      }
      const resolved = constants.get(m[2]);
      if (resolved) keys.add(resolved);
      else computedSites += 1;
    }

    return { keys, computedSites };
  }

  const devInstallEnvKeys = () => devInstallEnvWrites().keys;

  // The extension-install, connection-service and runtime-bridge half of that
  // set: a preview container that lacks any of these installs no non-bundled
  // extension (it falls back to the hosted registry it holds no credential
  // for), holds no connection (it can neither reach nor authenticate to the
  // connection service), or cannot run an agent. Every one MUST be in
  // PASSTHROUGH_ENV_KEYS.
  const FORWARDED_TO_A_PREVIEW = [
    "CINATRA_AGENT_REGISTRY_URL", // where an extension package is fetched FROM
    "CINATRA_AGENT_REGISTRY_UI_URL", // the registry's browser-facing twin
    "NANGO_SERVER_URL", // the connection service's ADDRESS
    "NANGO_SECRET_KEY", // …and its CREDENTIAL — an address alone still 401s
    "NANGO_ENCRYPTION_KEY", // the at-rest key the stored connections need
    // The RUNTIME BRIDGE, all three halves. The dev install re-points
    // WAYFLOW_BASE_URL at this instance's own WayFlow host port
    // (src/install.mjs, cinatra-cli#97); a preview that does not receive it
    // falls back to the app's default `http://localhost:3010`, which inside the
    // container is the container itself — the product then refuses every agent
    // run with "Cinatra WayFlow is not configured for agent …: WAYFLOW_BASE_URL
    // is not set". CINATRA_BRIDGE_TOKEN authenticates the runtime's callbacks
    // into the app, and CINATRA_CONTEXT_ATTEST_KEY is the DISTINCT attestation
    // contract the runtime signs its context callbacks with — ensureEnvLocal
    // mints both for EVERY mode (src/install.mjs), and without the attestation
    // key the app fails CLOSED on the composed-child context path
    // (src/wayflow-runtime.mjs: "it starts and then rejects every context
    // callback"), which is the same broken agent run one layer in.
    "WAYFLOW_BASE_URL",
    "CINATRA_BRIDGE_TOKEN",
    "CINATRA_CONTEXT_ATTEST_KEY",
    "SUPABASE_DB_URL", // the instance's own data, extension rows included
    "SUPABASE_SCHEMA",
    "REDIS_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "NEXT_PUBLIC_BETTER_AUTH_URL",
    "BULLMQ_QUEUE_NAME",
  ];

  // Decided by the preview composition itself, so absence from
  // PASSTHROUGH_ENV_KEYS is not a drop: these reach the container through a
  // dedicated path (or are deliberately forced).
  const SET_BY_THE_COMPOSITION = {
    CINATRA_RUNTIME_MODE: "forced to production by the preview composition (AC2)",
    CINATRA_ENCRYPTION_KEY: "required + validated + forwarded explicitly (AC6), never an optional passthrough",
    PORT: "the container's port is the preview's own publish decision",
  };

  // The rest of the dev install's set, each with the reason a preview container
  // must NOT receive it. This is the other half of the guard: a key here is a
  // DECISION, not an omission.
  const DELIBERATELY_NOT_FORWARDED = {
    // Nango's OWN database. Consumed by the nango-server/nango-db services on
    // the host, never by the app talking to Nango as a connection-service
    // CLIENT — the app needs the server URL and the secret key, both above.
    NANGO_DATABASE_URL: "the connection service's own database, read by the Nango services, not by the app",
    NANGO_DB_URL: "the legacy spelling of the same Nango-owned database URL",
    // Other subsystems entirely: neither is part of installing an extension,
    // holding a connection or running an agent, so #660 does not forward them;
    // a preview that needs the memory/graph subsystem is a separate decision.
    GRAPHITI_URL: "a different subsystem (memory service), outside #660's three classes",
    NEO4J_URI: "a different subsystem (graph store), outside #660's three classes",
    // Host-side bookkeeping, meaningless inside the container.
    CINATRA_INSTALL_PROFILE: "host-install bookkeeping (the dev/demo overlay), meaningless in the container",
    CINATRA_WAYFLOW_RUNTIME:
      "the CLI's record of what THIS install decided about the local runtime (doctor reads it); the container dials the runtime by address, not by that record",
    CINATRA_A2A_DEV_PEER_URLS: "a DEV-boot peer list; a preview runs production runtime semantics",
    CINATRA_TWENTY_MODE: "the CLI's record of the install's Twenty CRM choice (refresh and start read it); host-side, meaningless in the container",
    // The co-use topology's namespacing. Written only on the co-use path, and
    // Queue names now forward explicitly for isolated captures; these other
    // co-use values still have independent contracts.
    BETTER_AUTH_COOKIE_PREFIX: "the co-use path's cookie namespace (same class as the queue name)",
    CINATRA_REDIS_PREFIX: "the co-use path's forward-compat Redis prefix, documented as not yet honoured",
    // The execution plane is opt-in and writes NOTHING when disabled (the
    // default). Carrying a broker address + its secrets into a preview is a
    // separate decision with its own security surface; #660 does not make it.
    CINATRA_EXECUTION_PLANE_ROLLOUT: "the execution plane is opt-in and out of #660's three classes",
    EXECUTION_BROKER_URL: "execution-plane client config, out of #660's three classes",
    EXECUTION_BROKER_SECRET: "execution-plane signing secret, out of #660's three classes",
    EXECUTION_BROKER_SERVICE_TOKEN: "execution-plane service token, out of #660's three classes",
    EXECUTION_ENVIRONMENT_PROVENANCE_KEY: "execution-plane provenance key, out of #660's three classes",
    CINATRA_SANDBOX_L0_IMAGE: "execution-plane sandbox image override, out of #660's three classes",
    EXECUTION_SANDBOX_NETWORK: "execution-plane sandbox network override, out of #660's three classes",
  };

  it("reads a real, non-vacuous key set out of the dev install road", () => {
    const keys = devInstallEnvKeys();
    // If a refactor breaks the extraction, this test must FAIL rather than pass
    // on an empty set and wave a dropped variable through.
    expect(keys.size).toBeGreaterThan(8);
    for (const anchor of [
      "CINATRA_AGENT_REGISTRY_URL",
      "NANGO_SERVER_URL",
      "NANGO_SECRET_KEY",
      "SUPABASE_DB_URL",
      "WAYFLOW_BASE_URL",
      // the constant-keyed writes: the class a literal-only reader cannot see
      "CINATRA_CONTEXT_ATTEST_KEY",
      "CINATRA_BRIDGE_TOKEN",
    ]) {
      expect([...keys]).toContain(anchor);
    }
  });

  it("sees every write site — a key written through a CONSTANT is read, not skipped", () => {
    // The remaining sites write a key that is only known at runtime: the co-use
    // writer (its keys come from `buildCoUseEnv`, enumerated above), the
    // external-infra writer (operator-supplied infra keys), the two
    // `BETTER_AUTH_URL` loop writes (their array literal is read above),
    // `repointKey`'s own body (its call sites are read above) and
    // `persistExecutionEnv` (its keys are `CLI_MANAGED_EXECUTION_ENV_KEYS`).
    // A NEW computed-key write site is a red: enumerate its keys here the way
    // the delegated writers are enumerated, or the guard stops being a guard.
    expect(
      devInstallEnvWrites().computedSites,
      "an env write whose key is computed was added to (or lost from) src/install.mjs or src/execution-mode.mjs. Enumerate its key set here.",
    ).toBe(6);
  });

  it("classifies EVERY variable the dev install writes — a new one is a red, never a silent drop", () => {
    const unclassified = [...devInstallEnvKeys()].filter(
      (k) =>
        !FORWARDED_TO_A_PREVIEW.includes(k) && !(k in DELIBERATELY_NOT_FORWARDED) && !(k in SET_BY_THE_COMPOSITION),
    );
    expect(
      unclassified,
      `The dev install now writes ${unclassified.join(", ")}. Decide: forward it into a preview ` +
        "(add it to PASSTHROUGH_ENV_KEYS and to FORWARDED_TO_A_PREVIEW) or record why it stays out " +
        "(DELIBERATELY_NOT_FORWARDED / SET_BY_THE_COMPOSITION). Do not delete this assertion.",
    ).toEqual([]);
  });

  it("forwards every extension-install, connection-service and runtime-bridge variable of that set", () => {
    for (const key of FORWARDED_TO_A_PREVIEW) {
      expect(PASSTHROUGH_ENV_KEYS, `${key} is written by the dev install but a preview would not receive it`).toContain(key);
    }
  });

  it("a dev-install-shaped env really reaches the container", () => {
    const env = {
      [ENCRYPTION_KEY_ENV]: KEY_64,
      CINATRA_AGENT_REGISTRY_URL: "http://registry.example.test:4873",
      CINATRA_AGENT_REGISTRY_UI_URL: "http://registry.example.test:4873",
      NANGO_SERVER_URL: "http://nango.example.test:3003",
      NANGO_SECRET_KEY: "not-a-real-secret-fixture",
      NANGO_ENCRYPTION_KEY: "nango-encryption-key",
      SUPABASE_DB_URL: "postgresql://db.example.test:5432/postgres",
      SUPABASE_SCHEMA: "cinatra",
      BULLMQ_QUEUE_NAME: "isolated-preview-queue",
      REDIS_URL: "redis://cache.example.test:6379",
      BETTER_AUTH_SECRET: "better-auth-secret",
      BETTER_AUTH_URL: "http://app.example.test:3000",
      NEXT_PUBLIC_BETTER_AUTH_URL: "http://app.example.test:3000",
      WAYFLOW_BASE_URL: "http://wayflow.example.test:3010",
      CINATRA_BRIDGE_TOKEN: "bridge-token",
      CINATRA_CONTEXT_ATTEST_KEY: "attest-key",
    };
    const joined = buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env }).join(" ");
    for (const key of FORWARDED_TO_A_PREVIEW) {
      expect(joined).toContain(`${key}=${env[key]}`);
    }
  });

  it("rewrites the runtime bridge's ADDRESS to the container gateway and leaves its SECRETS verbatim", () => {
    // A dev install writes `http://127.0.0.1:<wayflow port>`; forwarded
    // verbatim that address means the CONTAINER inside the container, so the
    // runtime bridge's address is container-dialed and joins
    // CONTAINER_REWRITE_ENV_KEYS with the DB/Redis/Nango endpoints rather than
    // getting a second mechanism. Its two secrets are credentials, not
    // addresses: they are never rewritten and never ownership-verified.
    expect(CONTAINER_REWRITE_ENV_KEYS).toContain("WAYFLOW_BASE_URL");
    expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain("CINATRA_BRIDGE_TOKEN");
    expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain("CINATRA_CONTEXT_ATTEST_KEY");
    const joined = buildPreviewRunEnvArgs({
      encryptionKey: KEY_64,
      env: {
        [ENCRYPTION_KEY_ENV]: KEY_64,
        WAYFLOW_BASE_URL: "http://127.0.0.1:3010",
        CINATRA_CONTEXT_ATTEST_KEY: "attest-key",
      },
    }).join(" ");
    expect(joined).toContain(`WAYFLOW_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:3010`);
    expect(joined).toContain("CINATRA_CONTEXT_ATTEST_KEY=attest-key");
    // …and the ownership gate sees the ADDRESS, exactly like every other
    // container-dialed loopback endpoint (cinatra-cli#219), and only it.
    expect(
      containerDialedLoopbackEndpoints({ WAYFLOW_BASE_URL: "http://127.0.0.1:3010", CINATRA_CONTEXT_ATTEST_KEY: "attest-key" }),
    ).toEqual([{ key: "WAYFLOW_BASE_URL", value: "http://127.0.0.1:3010" }]);
  });

  it("keeps the deliberately-absent keys absent", () => {
    for (const key of Object.keys(DELIBERATELY_NOT_FORWARDED)) {
      expect(PASSTHROUGH_ENV_KEYS).not.toContain(key);
    }
    // …and the safety-invariant bypass flag above all (AC7-iii): it is not a
    // dev-install variable at all, it is the one flag a preview must never
    // sanction — excluded from the list AND stripped in `buildPreviewRunEnvArgs`.
    expect(PASSTHROUGH_ENV_KEYS).not.toContain(MATERIALIZE_DISABLE_ENV);
  });
});

// --------------------------------------------------------------------------
// engineering#666 — `--fleet required|dev`: which extension fleet the preview
// IMAGE acquires. A preview image acquires only the required extensions, so a
// proof run on a preview has no agent to run; `--fleet dev` is what puts the
// dev fleet INTO the image.
// --------------------------------------------------------------------------

describe("preview extension fleet — --fleet required|dev (engineering#666)", () => {
  const buildArgv = (fake) => fake.calls.find((c) => c[0] === "build");
  const argFor = (argv, name) => {
    const out = [];
    for (let i = 0; i < argv.length - 1; i += 1) {
      if (argv[i] === "--build-arg" && String(argv[i + 1]).startsWith(`${name}=`)) {
        out.push(String(argv[i + 1]).slice(name.length + 1));
      }
    }
    return out;
  };
  const healthy = { status: 200, body: '{"status":"ok"}' };

  it("names the flag, the accepted values, the default and the build-arg the Dockerfile must declare", () => {
    // The build-arg name is the contract with the product half's Dockerfile: a
    // mismatch is SILENT (docker drops an unconsumed --build-arg with a warning).
    expect(PREVIEW_FLEET_ARG).toBe("CINATRA_EXTENSION_FLEET");
    expect(PREVIEW_FLEET_FLAG).toBe("--fleet");
    expect(PREVIEW_FLEETS).toEqual(["required", "dev"]);
    expect(PREVIEW_FLEET_DEFAULT).toBe("required");
  });

  it("defaults to the required fleet and accepts both values, in either spelling", () => {
    expect(resolveFleet([])).toBe("required");
    expect(resolveFleet(["--slug", "main"])).toBe("required");
    expect(resolveFleet(["--fleet", "dev"])).toBe("dev");
    expect(resolveFleet(["--fleet=dev"])).toBe("dev");
    expect(resolveFleet(["--fleet", " DEV "])).toBe("dev");
    expect(resolveFleet(["--fleet", "required"])).toBe("required");
    // The "said nothing" answer is distinguishable from an explicit `required`,
    // which is what lets refresh carry a row's fleet forward instead of resetting it.
    expect(resolveFleet([], { fallback: null })).toBeNull();
    expect(resolveFleet(["--fleet", "required"], { fallback: null })).toBe("required");
  });

  it("a typo is a HARD error naming the flag — never a silent fall back to required", () => {
    for (const v of ["", "devel", "dev-fleet", "all", "REQUIRED-ISH", "1"]) {
      let err;
      try {
        resolveFleet(["--fleet", v]);
      } catch (e) {
        err = e;
      }
      expect(err, `expected ${JSON.stringify(v)} to be rejected`).toBeTruthy();
      expect(err.message).toContain(PREVIEW_FLEET_FLAG);
      expect(err.message).toContain("required");
      expect(err.message).toContain("dev");
    }
    // A bare trailing `--fleet` is a typo too, not "unset".
    expect(() => resolveFleet(["--fleet"])).toThrow(/--fleet/);
    // So is a REPEATED one. `readOption` answers with the FIRST match, so
    // guessing would build the required set for an operator who typed `dev`
    // last, and would let a trailing bare `--fleet` slip past the refusal above.
    expect(() => resolveFleet(["--fleet", "required", "--fleet", "dev"])).toThrow(/--fleet/);
    expect(() => resolveFleet(["--fleet", "dev", "--fleet"])).toThrow(/--fleet/);
    expect(() => resolveFleet(["--fleet=dev", "--fleet=dev"])).toThrow(/--fleet/);
  });

  it("assembles the build-arg through the single seam, and ONLY for dev", () => {
    expect(argFor(buildPreviewBuildArgs({}).args, PREVIEW_FLEET_ARG)).toEqual([]);
    expect(buildPreviewBuildArgs({}).fleet).toBe("required");
    expect(argFor(buildPreviewBuildArgs({}, { fleet: "required" }).args, PREVIEW_FLEET_ARG)).toEqual([]);
    const dev = buildPreviewBuildArgs({}, { fleet: "dev" });
    expect(dev.fleet).toBe("dev");
    expect(argFor(dev.args, PREVIEW_FLEET_ARG)).toEqual(["dev"]);
  });

  it("the choice REACHES the real `docker build` argv from `preview create`", async () => {
    const { deps, fake } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "main", "--fleet", "dev"], deps);
    expect(argFor(buildArgv(fake), PREVIEW_FLEET_ARG)).toEqual(["dev"]);
    // It is a BUILD-time choice: never forwarded into the container.
    expect(fake.calls.find((c) => c[0] === "run").join(" ")).not.toContain(PREVIEW_FLEET_ARG);

    const { deps: d2, fake: f2 } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "plain"], d2);
    expect(argFor(buildArgv(f2), PREVIEW_FLEET_ARG)).toEqual([]);
  });

  it("records the fleet on the registry row and prints it in `preview status`", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "main", "--fleet", "dev"], deps);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.fleet).toBe("dev");
    // A row written before this lever reads as the required fleet, never undefined.
    expect(makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }).fleet).toBe(
      "required",
    );

    const logs = [];
    runPreviewStatus(["--slug", "main"], { registryPath, checkoutDir: tmp, log: (...m) => logs.push(m.join(" ")) });
    expect(logs.join("\n")).toContain("fleet=dev");
  });

  it("a later refresh REUSES the recorded fleet when the operator says nothing", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "main", "--fleet", "dev"], deps);
    const { deps: rdeps, fake: rfake } = makeDeps({ sha: SHA_B, health: healthy });
    await runPreviewRefresh(["--slug", "main"], rdeps);
    expect(argFor(buildArgv(rfake), PREVIEW_FLEET_ARG)).toEqual(["dev"]);
    expect(getPreview(readRegistry(registryPath).registry, "main").fleet).toBe("dev");
  });

  it("a refresh whose --fleet DISAGREES with the row refuses, before any build or teardown", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "main", "--fleet", "dev"], deps);
    const { deps: rdeps, fake: rfake } = makeDeps({ sha: SHA_B, health: healthy });
    // "before any build or teardown" is only proved by measuring what the
    // refusal TOUCHED, not by reading the final row: a run that removed the
    // container and then threw, or wrote the `provisioning` claim and restored
    // it, would leave the same final row. So: the registry FILE is not written
    // at all (its mtime and its whole content are unchanged), and docker is
    // asked to do nothing that mutates anything.
    const registryBefore = readFileSync(registryPath, "utf8");
    const mtimeBefore = statSync(registryPath).mtimeMs;
    await expect(runPreviewRefresh(["--slug", "main", "--fleet", "required"], rdeps)).rejects.toThrow(
      /fleet/i,
    );
    const MUTATING_DOCKER_VERBS = new Set(["build", "run", "create", "rm", "stop", "kill", "start", "rename"]);
    expect(rfake.calls.filter((c) => MUTATING_DOCKER_VERBS.has(String(c[0])))).toEqual([]);
    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(statSync(registryPath).mtimeMs).toBe(mtimeBefore);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");
    expect(row.fleet).toBe("dev");
    // The AGREEING value is not a mismatch.
    const { deps: ok, fake: okFake } = makeDeps({ sha: SHA_B, health: healthy });
    await runPreviewRefresh(["--slug", "main", "--fleet", "dev"], ok);
    expect(argFor(buildArgv(okFake), PREVIEW_FLEET_ARG)).toEqual(["dev"]);
  });

  it("a row carrying a fleet this CLI does not accept is registry CORRUPTION, refused before anything is claimed", async () => {
    // The tag is derived from the fleet and `previewImageTag` normalises an
    // unknown one back to the default — so without an explicit check the row
    // below (a hand-edited or forward-version registry) reads as perfectly
    // valid, `status` prints a fleet no build produced, and a plain `refresh`
    // carries it past the claim into the build assembly, which refuses it only
    // after the row has been flipped to `provisioning`.
    const corrupt = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" });
    corrupt.fleet = "devel"; // not one of PREVIEW_FLEETS; tag stays the required one
    writeFileSync(registryPath, JSON.stringify({ version: 1, previews: { main: corrupt } }));
    expect(readRegistry(registryPath).status).toBe("malformed");

    const { deps: rdeps, fake: rfake } = makeDeps({ sha: SHA_B, health: healthy });
    await expect(runPreviewRefresh(["--slug", "main"], rdeps)).rejects.toThrow();
    expect(rfake.calls.find((c) => c[0] === "build")).toBeUndefined();

    // An ABSENT field is not corruption: that is every row written before this
    // lever, and it reads as the required set it was built with.
    const legacy = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" });
    delete legacy.fleet;
    writeFileSync(registryPath, JSON.stringify({ version: 1, previews: { main: legacy } }));
    expect(readRegistry(registryPath).status).toBe("ok");
  });

  it("create and refresh FAIL FAST on a typo'd fleet, before a slug is claimed or a preview is touched", async () => {
    const { deps: bad, fake: badFake } = makeDeps({ sha: SHA_A, health: healthy });
    await expect(runPreviewCreate(["--slug", "other", "--fleet", "devel"], bad)).rejects.toThrow(/--fleet/);
    expect(badFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry ?? { previews: {} }, "other")).toBeFalsy();

    writeRegistry(registryPath, {
      version: 1,
      previews: { main: makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" }) },
    });
    const { deps: badRefresh, fake: badRefreshFake } = makeDeps({ sha: SHA_B, health: healthy });
    await expect(runPreviewRefresh(["--slug", "main", "--fleet", "devel"], badRefresh)).rejects.toThrow(/--fleet/);
    expect(badRefreshFake.calls.find((c) => c[0] === "build")).toBeUndefined();
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.sha).toBe(SHA_A);
    expect(row.state).toBe("ready");
  });

  it("logs the fleet as part of the build's identity, and warns when the SHA's Dockerfile cannot honour it", () => {
    const lines = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: "/ctx",
      fleet: "dev",
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines.push(m) },
    });
    expect(lines.join("\n")).toMatch(/fleet: dev/);

    // A SHA whose Dockerfile predates the ARG cannot honour the choice, and
    // docker would drop it with only a warning — so the build says so.
    const old = path.join(tmp, "ctx-no-fleet-arg");
    mkdirSync(old, { recursive: true });
    writeFileSync(path.join(old, "Dockerfile"), "FROM node:24-alpine\nARG CI=\nRUN echo hi\n");
    const lines2 = [];
    buildPreviewImage({
      tag: previewImageTag(SHA_A),
      contextDir: old,
      fleet: "dev",
      deps: { runDocker: makeFakeDocker({}).runDocker, buildControlEnv: {}, log: (m) => lines2.push(m) },
    });
    expect(lines2.join("\n")).toContain(`ARG ${PREVIEW_FLEET_ARG}`);
  });

  it("the fleet is part of the IMAGE TAG, so a dev image never reuses (or overwrites) the required one", async () => {
    // The tag is the image's identity and the reuse probe reads only the
    // `cinatra.preview.sha` label — so a SHA-only tag would let a `--fleet dev`
    // create SKIP the build and boot the required image: a proof instance with
    // no agent to run, which is the one failure engineering#666 exists to remove.
    expect(previewImageTag(SHA_A)).toBe(`${PREVIEW_IMAGE_TAG_PREFIX}${SHA_A}`);
    expect(previewImageTag(SHA_A, "required")).toBe(previewImageTag(SHA_A));
    expect(previewImageTag(SHA_A, "dev")).toBe(`${PREVIEW_IMAGE_TAG_PREFIX}${SHA_A}-dev`);
    expect(previewImageTag(SHA_A, "dev")).not.toBe(previewImageTag(SHA_A));

    // The required image for this SHA is ALREADY here. A dev create must build
    // anyway, and must not touch the required tag.
    const { deps, fake } = makeDeps({ sha: SHA_A, health: healthy, images: new Set([previewImageTag(SHA_A)]) });
    await runPreviewCreate(["--slug", "proof", "--fleet", "dev"], deps);
    const build = buildArgv(fake);
    expect(build, "a dev create must BUILD, never reuse the required image").toBeTruthy();
    expect(argFor(build, PREVIEW_FLEET_ARG)).toEqual(["dev"]);
    expect(build).toContain(previewImageTag(SHA_A, "dev"));
    expect(build).not.toContain(previewImageTag(SHA_A));
    const row = getPreview(readRegistry(registryPath).registry, "proof");
    expect(row.imageTag).toBe(previewImageTag(SHA_A, "dev"));
    expect(row.fleet).toBe("dev");

    // And the mirror image of the same hazard: with the DEV image present, a
    // plain create still builds the required one.
    const { deps: d2, fake: f2 } = makeDeps({ sha: SHA_A, health: healthy, images: new Set([previewImageTag(SHA_A, "dev")]) });
    await runPreviewCreate(["--slug", "plain"], d2);
    expect(buildArgv(f2)).toBeTruthy();
    expect(buildArgv(f2)).toContain(previewImageTag(SHA_A));
    expect(getPreview(readRegistry(registryPath).registry, "plain").imageTag).toBe(previewImageTag(SHA_A));
  });

  it("`preview start` re-materializes a dev-fleet preview from ITS OWN image, with the row unchanged", async () => {
    const { deps } = makeDeps({ sha: SHA_A, health: healthy });
    await runPreviewCreate(["--slug", "main", "--fleet", "dev"], deps);

    // The container is gone; start re-materializes it from the RECORDED tag —
    // which is the dev one, so the proof instance comes back with its fleet.
    const { deps: sdeps, fake: sfake } = makeDeps(
      {
        containerAbsent: true,
        health: healthy,
        images: new Set([previewImageTag(SHA_A, "dev")]),
        compose: { containers: [{ id: "own-redis", name: "cinatra-redis-1", service: "redis", project: "cinatra", workingDir: tmp, ports: [["127.0.0.1", 6379, 6379]] }] },
      },
      { env: { [ENCRYPTION_KEY_ENV]: KEY_64, REDIS_URL: "redis://127.0.0.1:6379" } },
    );
    const out = await runPreviewStart(["--slug", "main"], sdeps);
    expect(out.rematerialized).toBe(true);
    // start NEVER builds — it honours the recorded fleet by re-using its image.
    expect(sfake.calls.some((c) => c[0] === "build")).toBe(false);
    expect(sfake.calls.find((c) => c[0] === "run").join(" ")).toContain(previewImageTag(SHA_A, "dev"));
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.fleet).toBe("dev");
    expect(row.imageTag).toBe(previewImageTag(SHA_A, "dev"));
  });

  it("a row written BEFORE this lever (no `fleet` field at all) stays valid and reads as the required fleet", async () => {
    // Not `makePreviewSlot(...)` without the option — that writes the field.
    // This is the shape a registry file on disk actually has today.
    const legacy = makePreviewSlot({ slug: "main", ref: "main", sha: SHA_A, hostPort: 3400, now: () => "T0" });
    delete legacy.fleet;
    expect(legacy.fleet).toBeUndefined();
    writeRegistry(registryPath, { version: 1, previews: { main: legacy } });
    // Still structurally valid: the tag it carries is the required-fleet tag.
    const read = readRegistry(registryPath);
    expect(read.state).not.toBe("malformed");
    expect(getPreview(read.registry, "main")).toBeTruthy();

    const logs = [];
    runPreviewStatus(["--slug", "main"], { registryPath, checkoutDir: tmp, log: (...m) => logs.push(m.join(" ")) });
    expect(logs.join("\n")).toContain("fleet=required");

    // A refresh that says nothing rebuilds it on the required fleet, and a
    // refresh that asks for `dev` is refused — it would be a different image.
    const { deps: bad } = makeDeps({ sha: SHA_B, health: healthy });
    await expect(runPreviewRefresh(["--slug", "main", "--fleet", "dev"], bad)).rejects.toThrow(/fleet/i);
    const { deps: ok, fake: okFake } = makeDeps({ sha: SHA_B, health: healthy });
    await runPreviewRefresh(["--slug", "main"], ok);
    expect(argFor(buildArgv(okFake), PREVIEW_FLEET_ARG)).toEqual([]);
    const row = getPreview(readRegistry(registryPath).registry, "main");
    expect(row.fleet).toBe("required");
    expect(row.imageTag).toBe(previewImageTag(SHA_B));
  });
});


describe("preview — separately owned durable artifact storage", () => {
  const artifactMutations = fake => fake.calls.filter(a => a[0] === "volume" && a[1] !== "inspect" && a.at(-1).startsWith("cinatra-preview-artifacts-"));
  it("creates and verifies an owned artifact volume before first app, distinct from extensions", async () => {
    const state={artifactExists:false,health:{status:200,body:'{"status":"ok"}'}};
    const {deps,fake}=makeDeps(state,{env:{[ENCRYPTION_KEY_ENV]:KEY_64,BULLMQ_QUEUE_NAME:"isolated-queue"}});
    await runPreviewCreate(["--slug","artifact","--ref","main"],deps);
    const created=fake.calls.findIndex(a=>a[0]==="volume"&&a[1]==="create");
    const boot=fake.calls.findIndex(a=>a[0]==="run");
    expect(created).toBeGreaterThan(-1);expect(created).toBeLessThan(boot);
    expect(fake.calls[created]).toContain(`${ARTIFACT_VOLUME_OWNER_LABEL}=artifact`);
    expect(fake.calls.slice(created+1,boot).some(a=>a[0]==="volume"&&a[1]==="inspect"&&a.at(-1)===previewArtifactVolumeName("artifact"))).toBe(true);
    const argv=fake.calls[boot];
    expect(argv).toContain("cinatra-preview-artifacts-artifact:/data/artifacts");
    expect(argv).toContain("cinatra-preview-data-artifact:/data/extensions");
    expect(argv).toContain("CINATRA_ARTIFACT_DATA_ROOT=/data/artifacts");
    expect(argv).toContain("BULLMQ_QUEUE_NAME=isolated-queue");
    expect(readRegistry(registryPath).registry.previews.artifact.artifactVolumeName).toBe(previewArtifactVolumeName("artifact"));
  });
  it.each([true,false])("retains preseeded=%s artifact volume after failed app health",async preseeded=>{
    const state={artifactExists:preseeded,health:{status:503,body:'{"status":"degraded"}'},artifactBytes:"real preserved fixture"};
    const {deps,fake}=makeDeps(state);
    await expect(runPreviewCreate(["--slug","artifact"],deps)).rejects.toThrow(/did not reach healthy/);
    expect(state.artifactExists).toBe(true);expect(state.artifactDeleted).not.toBe(true);
    expect(state.artifactBytes).toBe("real preserved fixture");
    expect(artifactMutations(fake).map(a=>a[1])).toEqual(preseeded?[]:["create"]);
  });
  it.each([{artifactOwner:"foreign"},{artifactOwner:""},{artifactOptions:{device:"/unowned",o:"bind",type:"none"}},{artifactProbeUnknown:true}])("refuses unknown preexisting ownership before any write: %j",async extra=>{
    const {deps,fake}=makeDeps(extra);
    await expect(runPreviewCreate(["--slug","artifact"],deps)).rejects.toThrow(/artifact volume|Artifact volume/);
    expect(existsSync(registryPath)).toBe(false);
    expect(fake.calls.every(a=>a[0]==="volume"&&a[1]==="inspect")).toBe(true);
  });
  it("does not boot or delete on uncertain volume creation",async()=>{
    const state={artifactExists:false,artifactCreateUnknown:true};const {deps,fake}=makeDeps(state);
    await expect(runPreviewCreate(["--slug","artifact"],deps)).rejects.toThrow(/uncertain/);
    expect(fake.calls.some(a=>a[0]==="run")).toBe(false);
    expect(artifactMutations(fake).map(a=>a[1])).toEqual(["create"]);
    expect(state.artifactExists).toBe(true);expect(state.artifactDeleted).not.toBe(true);
  });
  it.each(["start","refresh"])("legacy %s refuses without a storage declaration and leaves row/container unchanged",async verb=>{
    const row=makePreviewSlot({slug:"artifact",ref:"main",sha:SHA_A,hostPort:3400});delete row.artifactVolumeName;
    writeRegistry(registryPath,{version:1,previews:{artifact:row}});const original=readFileSync(registryPath,"utf8");
    const {deps,fake}=makeDeps({containerRunning:true});
    await expect((verb==="start"?runPreviewStart:runPreviewRefresh)(["--slug","artifact"],deps)).rejects.toThrow(/predates separate artifact storage/);
    expect(readFileSync(registryPath,"utf8")).toBe(original);expect(fake.calls).toEqual([]);
  });
  it.each(["start","refresh"])("missing recorded artifact volume refuses %s before touching serving container",async verb=>{
    const row=makePreviewSlot({slug:"artifact",ref:"main",sha:SHA_A,hostPort:3400});writeRegistry(registryPath,{version:1,previews:{artifact:row}});
    const state={artifactExists:false,containerRunning:true};const {deps,fake}=makeDeps(state);
    await expect((verb==="start"?runPreviewStart:runPreviewRefresh)(["--slug","artifact"],deps)).rejects.toThrow(/missing/);
    expect(fake.calls.every(a=>a[0]==="volume"&&a[1]==="inspect")).toBe(true);expect(state.containerRunning).toBe(true);
  });
  it("refresh and start recreate reuse the same artifact bytes and exact volume",async()=>{
    const state={health:{status:200,body:'{"status":"ok"}'},artifactBytes:"snapshot"};const {deps,fake}=makeDeps(state);
    await runPreviewCreate(["--slug","artifact"],deps);
    state.sha=SHA_B;await runPreviewRefresh(["--slug","artifact"],deps);
    state.images=new Set([previewImageTag(SHA_B)]);
    await runPreviewStart(["--slug","artifact","--recreate"],deps);
    const boots=fake.calls.filter(a=>a[0]==="run");expect(boots.length).toBe(3);
    for(const argv of boots)expect(argv).toContain("cinatra-preview-artifacts-artifact:/data/artifacts");
    expect(artifactMutations(fake)).toEqual([]);expect(state.artifactBytes).toBe("snapshot");
  });
  it("refresh build failure leaves serving preview and artifact data untouched",async()=>{
    const state={health:{status:200,body:'{"status":"ok"}'},artifactBytes:"snapshot"};const {deps,fake}=makeDeps(state);
    await runPreviewCreate(["--slug","artifact"],deps);const n=fake.calls.length;state.sha=SHA_B;state.buildFails=true;
    await expect(runPreviewRefresh(["--slug","artifact"],deps)).rejects.toThrow(/build/);
    expect(fake.calls.slice(n).some(a=>["stop","rm","run"].includes(a[0]))).toBe(false);
    expect(state.containerRunning).toBe(true);expect(state.artifactBytes).toBe("snapshot");expect(state.artifactDeleted).not.toBe(true);
  });
  it.each([{artifactMounts:[]},{artifactEnv:["CINATRA_ARTIFACT_DATA_ROOT=/wrong"]}])("start refuses existing container with incorrect artifact mount/root: %j",async extra=>{
    writeRegistry(registryPath,{version:1,previews:{artifact:makePreviewSlot({slug:"artifact",ref:"main",sha:SHA_A,hostPort:3400})}});
    const {deps,fake}=makeDeps({containerPresentStopped:true,...extra});
    await expect(runPreviewStart(["--slug","artifact"],deps)).rejects.toThrow(/artifact mount\/root/);
    expect(fake.calls.some(a=>["start","run","rm","rename"].includes(a[0]))).toBe(false);
  });
});


describe("preview — refresh storage read races and absence evidence",()=>{
  it.each([{artifactMounts:[]},{artifactEnv:["CINATRA_ARTIFACT_DATA_ROOT=/wrong"]},
      {artifactMounts:[{Type:"volume",Name:"foreign",Destination:"/data/artifacts",RW:true}]}])("refuses refresh of incorrectly bound serving container: %j",async extra=>{
    const row=makePreviewSlot({slug:"artifact",ref:"main",sha:SHA_A,hostPort:3400});
    writeRegistry(registryPath,{version:1,previews:{artifact:row}});const original=readFileSync(registryPath,"utf8");
    const state={containerRunning:true,artifactBytes:"preserved",...extra};const {deps,fake}=makeDeps(state);
    await expect(runPreviewRefresh(["--slug","artifact"],deps)).rejects.toThrow(/artifact mount\/root/);
    expect(readFileSync(registryPath,"utf8")).toBe(original);expect(state.containerRunning).toBe(true);expect(state.artifactBytes).toBe("preserved");
    expect(fake.calls.every(a=>a[1]==="inspect")).toBe(true);
  });
  it.each([{status:null},{status:2},{status:1,signal:"SIGTERM"}])("never treats uncertain or non-Docker failure as absent: %j",async failure=>{
    const {deps,fake}=makeDeps({artifactProbeOverride:{stdout:"",stderr:"no such volume",...failure}});
    await expect(runPreviewCreate(["--slug","artifact"],deps)).rejects.toThrow(/Could not verify artifact volume/);
    expect(existsSync(registryPath)).toBe(false);expect(fake.calls.every(a=>a[1]==="inspect")).toBe(true);
  });
});
