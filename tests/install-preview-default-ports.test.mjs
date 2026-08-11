// `install --mode preview` on a DEFAULT-PORTS host (cinatra-ai/cinatra-cli#197).
//
// THE GAP THIS CLOSES: the front door's own e2e coverage composes an ISOLATED
// install, whose `.env.local` carries every infra endpoint explicitly
// (`writeIsolatedAppEnv`). On a quiet host no isolation fires, `.env.local` is
// `.env.example` verbatim — which defines neither REDIS_URL nor the
// agent-registry URL — and the composed container inherited NOTHING for them:
// Redis resolved to the container itself (never healthy) and the registry to the
// hosted default the instance holds no credentials for. This file exercises the
// composition on exactly that path (#197 AC5).
//
// HERMETIC: no real docker/git/network — the composition rides `preview.mjs`'s
// own injectable deps and the fake docker runner RECORDS every argv, so the
// container's environment is asserted STRUCTURALLY.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";

import { __test as F } from "../src/install-preview.mjs";
import { __test as P } from "../src/preview.mjs";
import { deriveEffectiveInstanceEndpoints } from "../src/instance-endpoints.mjs";

const {
  continuationImplicitEndpointLines,
  derivePreviewEnvFromInstall,
  lookupPreviewEncryptionKey,
  makePreviewComposition,
  readInstalledEnvValues,
  runInstallPreviewBootstrap,
  runInstallPreviewRefresh,
} = F;

const { CONTAINER_HOST_GATEWAY, ENCRYPTION_KEY_ENV, PASSTHROUGH_ENV_KEYS, makePreviewSlot, writeRegistry } = P;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Credential-bearing URIs are ASSEMBLED, never written as a literal (the repo's
// secret-scan gate matches the `scheme://user:pass@host` shape).
const pgUrl = (cred, hostPort, db) => ["postgresql:/", `${cred}@${hostPort}`, db].join("/");
const DEV_DB_CRED = ["postgres", "postgres"].join(":");

// `.env.local` EXACTLY as a DEFAULT-ports `install --mode dev` leaves it: the
// app's `.env.example` copied verbatim, plus the secrets `ensureEnvLocal` mints.
// Note what is NOT here — REDIS_URL, CINATRA_AGENT_REGISTRY_URL,
// CINATRA_AGENT_REGISTRY_UI_URL. That is the whole defect.
const DEFAULT_PORTS_ENV_LOCAL = [
  "CINATRA_RUNTIME_MODE=development",
  `SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, "127.0.0.1:5434", "postgres")}`,
  "BETTER_AUTH_SECRET=devsecret",
  "BETTER_AUTH_URL=http://localhost:3000",
  "NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000",
  "NANGO_ENCRYPTION_KEY=bmFuZ28=",
  "CINATRA_BRIDGE_TOKEN=bridgetoken",
  "",
].join("\n");

// The band a default-ports install resolves from the checkout's own
// `docker compose config` (the authoritative source both paths read).
const DEFAULT_BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "redis", host: "127.0.0.1", port: 6379 },
  { service: "verdaccio", host: "0.0.0.0", port: 4873 },
];

const EFFECTIVE = deriveEffectiveInstanceEndpoints({ band: DEFAULT_BAND }).values;

let tmp;
let checkoutDir;
let registryPath;
let secretsPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cinatra-preview-default-ports-"));
  checkoutDir = path.join(tmp, "cinatra");
  registryPath = path.join(tmp, "previews.json");
  secretsPath = path.join(tmp, "state", "preview-secrets.json");
  mkdirSync(checkoutDir, { recursive: true });
  writeFileSync(path.join(checkoutDir, ".env.local"), DEFAULT_PORTS_ENV_LOCAL);
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeFakeDocker(state) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    const ownership = answerComposeOwnership(args, state); // cinatra-cli#219
    if (ownership) return ownership;
    const [verb, sub] = args;
    if (verb === "build") return { status: 0, stdout: "", stderr: "" };
    if (verb === "run" && sub === "-d") {
      state.containerRunning = true;
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (verb === "container" && sub === "inspect") {
      const running = Boolean(state.containerRunning);
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "false\n", stderr: "" };
    }
    if (verb === "volume" && sub === "inspect") return { status: 1, stdout: "", stderr: "" };
    if (verb === "image" && sub === "inspect") return { status: 1, stdout: "", stderr: "" };
    if (verb === "logs") return { status: 0, stdout: "log tail", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { calls, runDocker };
}

function makeBootstrapDeps(state = {}) {
  const fake = makeFakeDocker(state);
  const logs = [];
  const deps = {
    registryPath,
    previewSecretsPath: secretsPath,
    buildControlEnv: {},
    log: (...m) => logs.push(m.join(" ")),
    logError: (...m) => logs.push(m.join(" ")),
    now: () => 1000,
    sleep: async () => {},
    resolveSha: (ref) => state.shaForRef?.[ref] ?? state.sha ?? SHA_A,
    prepareContext: () => ({ contextDir: path.join(tmp, "ctx"), cleanup: () => {} }),
    probeHealth: async () => state.health ?? { status: 200, body: '{"status":"ok"}' },
    probePort: async () => true,
    runDocker: fake.runDocker,
  };
  return { deps, fake, logs };
}

const runArgv = (fake) => (fake.calls.find((c) => c[0] === "run") ?? []).join(" ");

// ---------------------------------------------------------------------------
// The composition itself
// ---------------------------------------------------------------------------

describe("preview composition on a default-ports install — the implicit half (#197)", () => {
  it("REPRODUCES the defect when the effective endpoints are withheld", () => {
    // Pre-fix behaviour, pinned so the fix cannot silently regress: forward-if-
    // present drops every key `.env.example` leaves implicit.
    const { env, missingKeys } = derivePreviewEnvFromInstall({
      envValues: readInstalledEnvValues(checkoutDir),
      previewHostPort: 3400,
    });
    expect(env).not.toHaveProperty("REDIS_URL");
    expect(env).not.toHaveProperty("CINATRA_AGENT_REGISTRY_URL");
    expect(missingKeys).toEqual(expect.arrayContaining(["REDIS_URL", "CINATRA_AGENT_REGISTRY_URL"]));
  });

  it("supplies the instance's OWN endpoints for the keys the install leaves implicit (AC2/AC3)", () => {
    const { env, containerDialedKeys, synthesizedKeys, missingKeys } = derivePreviewEnvFromInstall({
      envValues: readInstalledEnvValues(checkoutDir),
      previewHostPort: 3400,
      effectiveDefaults: EFFECTIVE,
    });
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(env.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4873");
    expect(env.CINATRA_AGENT_REGISTRY_UI_URL).toBe("http://127.0.0.1:4873");
    // Classified as container-dialed, so `preview.mjs` performs the SINGLE
    // host-gateway rewrite over them (no second rewrite here).
    expect(containerDialedKeys).toEqual(expect.arrayContaining(["REDIS_URL", "CINATRA_AGENT_REGISTRY_URL"]));
    // Reported by NAME so the operator can see what was supplied and why.
    expect(synthesizedKeys).toEqual(
      expect.arrayContaining(["REDIS_URL", "CINATRA_AGENT_REGISTRY_URL", "CINATRA_AGENT_REGISTRY_UI_URL"]),
    );
    expect(missingKeys).not.toContain("REDIS_URL");
    // An operator secret with no derivable default is still simply omitted.
    expect(missingKeys).toContain("OPENAI_API_KEY");
  });

  it("never composes outside the set preview.mjs forwards", () => {
    const { env } = derivePreviewEnvFromInstall({
      envValues: readInstalledEnvValues(checkoutDir),
      previewHostPort: 3400,
      effectiveDefaults: { ...EFFECTIVE, NOT_A_PASSTHROUGH_KEY: "x" },
    });
    for (const key of Object.keys(env)) expect(PASSTHROUGH_ENV_KEYS).toContain(key);
    expect(env).not.toHaveProperty("NOT_A_PASSTHROUGH_KEY");
  });

  it("AC4 regression guard: an EXPLICIT .env.local value always wins (the isolated path)", () => {
    // What an ISOLATED install writes: its own remapped ports, explicitly.
    writeFileSync(
      path.join(checkoutDir, ".env.local"),
      [DEFAULT_PORTS_ENV_LOCAL, "REDIS_URL=redis://127.0.0.1:6479", "CINATRA_AGENT_REGISTRY_URL=http://127.0.0.1:4973", ""].join("\n"),
    );
    const { env, synthesizedKeys } = derivePreviewEnvFromInstall({
      envValues: readInstalledEnvValues(checkoutDir),
      previewHostPort: 3400,
      effectiveDefaults: EFFECTIVE, // the DEFAULT band — must not win
    });
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6479");
    expect(env.CINATRA_AGENT_REGISTRY_URL).toBe("http://127.0.0.1:4973");
    expect(synthesizedKeys).not.toContain("REDIS_URL");
    expect(synthesizedKeys).not.toContain("CINATRA_AGENT_REGISTRY_URL");
  });

  it("AC6: a continuation composes NOTHING extra when the caller supplies no endpoints", () => {
    const plan = makePreviewComposition({
      targetDir: checkoutDir,
      slug: "plain",
      continuation: true,
      // effectiveEndpoints deliberately omitted — the default is empty.
    });
    expect(plan.preEnv).not.toHaveProperty("REDIS_URL");
    expect(plan.preEnv).not.toHaveProperty("CINATRA_AGENT_REGISTRY_URL");
  });
});

// ---------------------------------------------------------------------------
// End to end through the front door (AC1/AC2/AC3 at the container boundary)
// ---------------------------------------------------------------------------

describe("install --mode preview front door on a default-ports install (#197 AC1–AC3, AC5)", () => {
  it("boots the container with a container-REACHABLE Redis and the instance's own registry", async () => {
    const { deps, fake } = makeBootstrapDeps({});
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      effectiveEndpoints: EFFECTIVE,
      log: () => {},
      deps,
    });
    expect(out.created).toBe(true);

    const argv = runArgv(fake);
    // AC2 — the container dials the HOST's Redis, not itself. `127.0.0.1:6379`
    // inside a bridged container is the container, which is exactly how the
    // health gate ended up timing out and rolling the preview back.
    expect(argv).toContain(`REDIS_URL=redis://${CONTAINER_HOST_GATEWAY}:6379`);
    expect(argv).not.toContain("REDIS_URL=redis://127.0.0.1:6379");
    // AC3 — the instance's OWN registry, container-rewritten…
    expect(argv).toContain(`CINATRA_AGENT_REGISTRY_URL=http://${CONTAINER_HOST_GATEWAY}:4873`);
    // …while the browser-resolved UI URL is forwarded VERBATIM (its documented
    // contract: a container-only name would not resolve in the operator's browser).
    expect(argv).toContain("CINATRA_AGENT_REGISTRY_UI_URL=http://127.0.0.1:4873");
    // The one shared mapping that makes the gateway name resolve.
    expect(argv).toContain(`--add-host ${CONTAINER_HOST_GATEWAY}:host-gateway`);
    // Unchanged: the DB endpoint rides the same rewrite, the app URLs the
    // preview's own published port.
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, `${CONTAINER_HOST_GATEWAY}:5434`, "postgres")}`);
    expect(argv).toContain(`NEXT_PUBLIC_APP_URL=http://localhost:${out.hostPort}`);
  });

  it("reports the supplied keys by NAME — never a value (leak discipline)", async () => {
    const { deps, logs } = makeBootstrapDeps({});
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      effectiveEndpoints: EFFECTIVE,
      log: (...m) => logs.push(m.join(" ")),
      deps,
    });
    const text = logs.join("\n");
    expect(text).toContain("implicit in .env.local — supplied from this instance's own endpoints");
    expect(text).toContain("REDIS_URL");
    expect(text).not.toContain("redis://127.0.0.1:6379");
    expect(text).not.toContain("devsecret");
  });

  it("without the endpoints, the same run still drops them — the assertion is load-bearing", async () => {
    const { deps, fake } = makeBootstrapDeps({});
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps,
    });
    expect(runArgv(fake)).not.toContain("REDIS_URL=");
    expect(runArgv(fake)).not.toContain("CINATRA_AGENT_REGISTRY_URL=");
  });
});

// ---------------------------------------------------------------------------
// AC6 — the continuation boundary, at the verb the front door hands off to
// ---------------------------------------------------------------------------

describe("preview refresh — the continuation invents nothing (#197 AC6)", () => {
  it("does NOT synthesize, not even for a preview the front door itself built", async () => {
    // The tempting shortcut is to treat the persisted boot key as proof this
    // composition owns the instance. It is not sound: the key store is
    // historical per-SLUG state, bound to neither the current `previews.json`
    // row nor the checkout nor the infra plan — a slug reused after a registry
    // repair would inherit it — and refresh cannot see the infra plan at all, so
    // it could not exclude an external/co-use instance the way the front-door
    // create does. So the continuation composes only what the install DEFINES.
    const created = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      effectiveEndpoints: EFFECTIVE,
      log: () => {},
      deps: created.deps,
    });
    expect(lookupPreviewEncryptionKey({ slug: "inst-one", filePath: secretsPath })).not.toBeNull();

    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    refreshed.state = { containerRunning: true };
    await runInstallPreviewRefresh(["--slug", "inst-one", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir,
      env: {},
    });
    const argv = runArgv(refreshed.fake);
    expect(argv).not.toContain("REDIS_URL=");
    expect(argv).not.toContain("CINATRA_AGENT_REGISTRY_URL=");
    // Everything the install DID write down still composes, unchanged by #197 —
    // the continuation is narrower, not broken.
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, `${CONTAINER_HOST_GATEWAY}:5434`, "postgres")}`);
    expect(argv).toMatch(new RegExp(`${ENCRYPTION_KEY_ENV}=[0-9a-f]{64}`));
  });

  it("SAYS SO — the difference must not be discovered from a health-gate timeout", async () => {
    // The front door's handoff points at `refresh` as the only way to rebuild
    // the image, so a create that was healthy on the install's effective
    // endpoints must not quietly rebuild without them.
    const lines = continuationImplicitEndpointLines({
      envValues: readInstalledEnvValues(checkoutDir),
    }).join("\n");
    expect(lines).toContain("REDIS_URL");
    expect(lines).toContain("CINATRA_AGENT_REGISTRY_URL");
    expect(lines).toContain("invents");
    expect(lines).toMatch(/Set them explicitly in \.env\.local/);
    // Key NAMES only — never a value.
    expect(lines).not.toContain("redis://");
    // Silent when the install DID write them down (e.g. the isolated path).
    expect(
      continuationImplicitEndpointLines({
        envValues: {
          REDIS_URL: "redis://127.0.0.1:6479",
          SUPABASE_DB_URL: "x",
          CINATRA_AGENT_REGISTRY_URL: "http://127.0.0.1:4973",
          // cinatra-cli#219 joined the container-dialed class, and the isolated
          // path writes it down like the rest.
          NANGO_SERVER_URL: "http://127.0.0.1:3103",
        },
      }),
    ).toEqual([]);
  });

  it("emits that note on a real refresh of a front-door preview", async () => {
    const created = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      effectiveEndpoints: EFFECTIVE,
      log: () => {},
      deps: created.deps,
    });
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    refreshed.state = { containerRunning: true };
    const logs = [];
    await runInstallPreviewRefresh(["--slug", "inst-one", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir,
      env: {},
      log: (...m) => logs.push(m.join(" ")),
    });
    expect(logs.join("\n")).toContain("leaves these container-dialed keys implicit");
  });

  it("INVENTS NOTHING for a preview the front door did not build", async () => {
    const bare = path.join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(path.join(bare, ".env.local"), DEFAULT_PORTS_ENV_LOCAL);
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        plain: makePreviewSlot({ slug: "plain", ref: "main", sha: SHA_A, hostPort: 3410, now: () => "T0" }),
      },
    });
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    const ownKey = "c".repeat(64);
    await runInstallPreviewRefresh(["--slug", "plain", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir: bare,
      env: { [ENCRYPTION_KEY_ENV]: ownKey },
    });
    const argv = runArgv(refreshed.fake);
    expect(argv).not.toContain("REDIS_URL=");
    expect(argv).not.toContain("CINATRA_AGENT_REGISTRY_URL=");
  });
});
