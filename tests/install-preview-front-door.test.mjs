// `cinatra install --mode preview` — the FRONT DOOR over the preview lifecycle
// (cinatra-ai/cinatra-cli#188).
//
// HERMETIC: no real docker/git/network. The whole composition is exercised
// through `preview.mjs`'s own injectable `deps` (runDocker / resolveSha /
// prepareContext / probeHealth / probePort / now / sleep) with the registry and
// the secrets store pointed at temp files. The fake docker runner RECORDS every
// argv, which is how the load-bearing invariant + the three inherited HARD
// NEVERs are asserted STRUCTURALLY rather than by inspection.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";

import { __test as F } from "../src/install-preview.mjs";
import { __test as P } from "../src/preview.mjs";
import {
  installModeLabel,
  isDevLikeMode,
  installProfileForMode,
  isSurfaceOnlyMode,
  parseInstallArgs,
  resolveInstallMode,
  underlyingInstallMode,
} from "../src/install.mjs";

const {
  PREVIEW_APP_URL_KEYS,
  derivePreviewEnvFromInstall,
  ensurePreviewEncryptionKey,
  lookupPreviewEncryptionKey,
  runInstallPreviewRefresh,
  previewHandoffLines,
  previewSlugArgs,
  previewBindArgs,
  decidePreviewAction,
  previewSkipReportLines,
  previewInFlightReportLines,
  runInstallPreviewBootstrap,
  readInstalledEnvValues,
} = F;

const {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_REWRITE_ENV_KEYS,
  ENCRYPTION_KEY_ENV,
  MATERIALIZE_DISABLE_ENV,
  PREVIEW_RUNTIME_MODE,
  PREVIEW_HOST_PORT_MIN,
  PASSTHROUGH_ENV_KEYS,
  assertPreviewCheckoutAllowed,
  readCheckoutEnvMode,
  getPreview,
  makePreviewSlot,
  previewImageTag,
  readRegistry,
  writeRegistry,
} = P;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Credential-bearing URIs are ASSEMBLED, never written as a literal: the
// repo's secret-scan gate matches the `scheme://user:pass@host` shape, and a
// throwaway test fixture must not look like a credential to it (the same reason
// tests/clone-*.test.mjs interpolate their `${cred}` fragments).
const pgUrl = (cred, hostPort, db) => ["postgresql:/", `${cred}@${hostPort}`, db].join("/");
const DEV_DB_CRED = ["postgres", "devpw"].join(":");
const OTHER_DB_CRED = ["u", "p"].join(":");

// A dev `.env.local` exactly as `install --mode dev` seeds it from the target
// checkout's `.env.example`: HOST-loopback infra endpoints, the app on the
// installed instance's own port, and NO prod-only encryption key.
const DEV_ENV_LOCAL = [
  "CINATRA_RUNTIME_MODE=development",
  `SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, "127.0.0.1:5434", "postgres")}`,
  "SUPABASE_SCHEMA=public",
  "REDIS_URL=redis://127.0.0.1:6381",
  "BETTER_AUTH_SECRET=devsecret",
  "BETTER_AUTH_URL=http://localhost:3000",
  "NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000",
  "NEXT_PUBLIC_APP_URL=http://localhost:3000",
  "NANGO_ENCRYPTION_KEY=bmFuZ28=",
  // cinatra-cli#219: the install writes the connection service's address
  // (`.env.example`) and, since cinatra-cli#214, its seeded secret key.
  "NANGO_SERVER_URL=http://localhost:3003",
  "NANGO_SECRET_KEY=nango-env-key",
  "CINATRA_BRIDGE_TOKEN=bridgetoken",
  "",
].join("\n");

let tmp;
let checkoutDir;
let registryPath;
let secretsPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cinatra-install-preview-"));
  checkoutDir = path.join(tmp, "cinatra");
  registryPath = path.join(tmp, "previews.json");
  secretsPath = path.join(tmp, "state", "preview-secrets.json");
  mkdirSync(checkoutDir, { recursive: true });
  writeFileSync(path.join(checkoutDir, ".env.local"), DEV_ENV_LOCAL);
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// --- fake docker ------------------------------------------------------------

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
    // cinatra-cli#194: the image-build budget is read from the OPERATOR's
    // environment, so pin an EMPTY map here — without it a developer who
    // exports CINATRA_PREVIEW_BUILD_TIMEOUT_MS in their shell changes (or, with
    // a deliberately invalid value, breaks) this suite.
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
// AC1 / AC2 / AC6 — the surface accepts `preview` and it translates to `dev`
// ---------------------------------------------------------------------------

describe("install --mode preview — surface acceptance + mode translation (AC1, AC2, AC6)", () => {
  it("AC1: `--mode preview` is accepted (no longer a bare enum rejection)", () => {
    expect(resolveInstallMode([], "preview")).toBe("preview");
    expect(() => resolveInstallMode([], "preview")).not.toThrow();
  });

  it("AC2: the POSITIONAL `install preview` behaves identically to the flag form", () => {
    expect(resolveInstallMode(["preview"], null)).toBe("preview");
    const positional = parseInstallArgs(["preview"]);
    const flag = parseInstallArgs(["--mode", "preview"]);
    expect(positional.mode).toBe(flag.mode);
    expect(positional.surfaceMode).toBe(flag.surfaceMode);
    expect(positional.previewFrontDoor).toBe(flag.previewFrontDoor);
  });

  it("AC2: the conflict + unknown-trailing-arg rules still hold for preview", () => {
    expect(() => resolveInstallMode(["preview"], "prod")).toThrow(/Conflicting mode/);
    expect(() => resolveInstallMode(["preview", "extra"], null)).toThrow(/Unexpected extra argument/);
    expect(() => resolveInstallMode([], "previews")).toThrow(/Invalid --mode "previews"/);
  });

  it("AC1/AC10: both rejection paths now NAME preview in the accepted set", () => {
    let flagErr;
    try {
      resolveInstallMode([], "nope");
    } catch (e) {
      flagErr = e.message;
    }
    expect(flagErr).toContain("preview");
    let posErr;
    try {
      resolveInstallMode(["nope"], null);
    } catch (e) {
      posErr = e.message;
    }
    expect(posErr).toContain("preview");
  });

  it("AC6: `preview` resolves to the UNDERLYING mode dev before any install site sees it", () => {
    expect(underlyingInstallMode("preview")).toBe("dev");
    expect(isSurfaceOnlyMode("preview")).toBe(true);
    const opts = parseInstallArgs(["--mode", "preview"]);
    // Everything downstream (env generation, setup, marker, instance registry)
    // reads `opts.mode` — it must be a REAL install mode, never "preview".
    expect(opts.mode).toBe("dev");
    expect(opts.surfaceMode).toBe("preview");
    expect(opts.previewFrontDoor).toBe(true);
    // The two predicates the issue calls out by name.
    expect(isDevLikeMode(opts.mode)).toBe(true); // NOT falling through to prod handling
    expect(installProfileForMode(opts.mode)).toBeNull(); // no demo overlay
    // instance-registry.mjs only accepts dev|prod|demo — this is the value it gets.
    expect(["dev", "prod", "demo"]).toContain(opts.mode);
  });

  it("AC6: the operator still SEES preview — the summary never silently reads `dev`", () => {
    const label = installModeLabel(parseInstallArgs(["--mode", "preview"]));
    expect(label).toMatch(/^preview /);
    expect(label).toContain("dev install");
    // Unchanged for every runtime topology.
    expect(installModeLabel(parseInstallArgs(["--mode", "dev"]))).toBe("dev");
    expect(installModeLabel(parseInstallArgs(["--mode", "prod"]))).toBe("prod");
    expect(installModeLabel(parseInstallArgs(["--mode", "demo"]))).toBe("demo");
  });

  it("AC11: dev/prod/demo parse EXACTLY as before (no surface-mode leakage)", () => {
    for (const m of ["dev", "prod", "demo"]) {
      const opts = parseInstallArgs(["--mode", m]);
      expect(opts.mode).toBe(m);
      expect(opts.surfaceMode).toBe(m);
      expect(opts.previewFrontDoor).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — container→host reachability (distinct from the app-URL adjustment)
// ---------------------------------------------------------------------------

describe("preview front door — container reachability rides ONE shared mechanism (AC5)", () => {
  it("SUPABASE_DB_URL and REDIS_URL are members of preview.mjs's container-rewrite set", () => {
    // AC5 is satisfied by JOINING the single rewrite `preview.mjs` owns
    // (cinatra-cli#190's CONTAINER_REWRITE_ENV_KEYS), never by a second rewrite
    // in the front door that could drift from it.
    expect(CONTAINER_REWRITE_ENV_KEYS).toEqual(expect.arrayContaining(["SUPABASE_DB_URL", "REDIS_URL"]));
    for (const key of CONTAINER_REWRITE_ENV_KEYS) expect(PASSTHROUGH_ENV_KEYS).toContain(key);
  });

  it("the app/auth URLs are DELIBERATELY excluded from it — they are browser-resolved", () => {
    for (const key of PREVIEW_APP_URL_KEYS) expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain(key);
  });
});

// ---------------------------------------------------------------------------
// AC3 — env plumbing sourced from the INSTALL, not ambient shell state
// ---------------------------------------------------------------------------

describe("preview front door — env plumbing (AC3, AC5)", () => {
  it("composes the container env from the installed .env.local, with both rewrites", () => {
    const envValues = readInstalledEnvValues(checkoutDir);
    const { env, appUrlKeys, containerDialedKeys, forwardedKeys, missingKeys } = derivePreviewEnvFromInstall({
      envValues,
      previewHostPort: 3400,
    });
    // AC5 (a): the install's endpoints are forwarded as-is and CLASSIFIED as
    // container-dialed; `preview.mjs` performs the single host-gateway rewrite.
    expect(env.SUPABASE_DB_URL).toBe(envValues.SUPABASE_DB_URL);
    expect(env.REDIS_URL).toBe(envValues.REDIS_URL);
    expect(containerDialedKeys).toEqual(expect.arrayContaining(["SUPABASE_DB_URL", "REDIS_URL"]));
    // AC5 (b): app/auth URLs → the PREVIEW's own published port, NOT the alias
    // and NOT the installed instance's app port.
    for (const key of PREVIEW_APP_URL_KEYS) expect(env[key]).toBe("http://localhost:3400");
    expect(appUrlKeys).toEqual(expect.arrayContaining([...PREVIEW_APP_URL_KEYS]));
    // Secrets + scalars forwarded verbatim.
    expect(env.BETTER_AUTH_SECRET).toBe("devsecret");
    expect(env.SUPABASE_SCHEMA).toBe("public");
    expect(forwardedKeys).toEqual(expect.arrayContaining(["BETTER_AUTH_SECRET", "SUPABASE_SCHEMA"]));
    // A key the install did not set is reported by NAME and simply omitted.
    expect(missingKeys).toContain("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("stays inside the set preview.mjs actually forwards (composing outside it would be dropped)", () => {
    const { env } = derivePreviewEnvFromInstall({
      envValues: readInstalledEnvValues(checkoutDir),
      previewHostPort: 3400,
    });
    for (const key of Object.keys(env)) expect(PASSTHROUGH_ENV_KEYS).toContain(key);
  });

  it("AC3: the values come from the INSTALL, never from ambient shell state", () => {
    // A hostile ambient value for the same key must not win: the composer is
    // handed the install's parsed values and reads nothing else.
    const { env } = derivePreviewEnvFromInstall({
      envValues: { SUPABASE_DB_URL: pgUrl(OTHER_DB_CRED, "127.0.0.1:9999", "from-install") },
      previewHostPort: 3400,
    });
    expect(env.SUPABASE_DB_URL).toContain("from-install");
    expect(env.SUPABASE_DB_URL).not.toContain("5434");
  });

  it("refuses to compose without the preview's resolved host port", () => {
    expect(() => derivePreviewEnvFromInstall({ envValues: {}, previewHostPort: null })).toThrow(
      /resolved host port/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — the boot encryption key, provisioned OUTSIDE the dev checkout
// ---------------------------------------------------------------------------

describe("preview front door — encryption key provisioning (AC4)", () => {
  it("mints a valid 64-hex key, persists it 0600, and REUSES it on a second call", async () => {
    const first = await ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath });
    expect(first.minted).toBe(true);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(secretsPath)).toBe(true);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    const second = await ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath });
    expect(second.minted).toBe(false);
    // Re-minting would ORPHAN the durable volume's already-encrypted data.
    expect(second.key).toBe(first.key);
    expect(lookupPreviewEncryptionKey({ slug: "main", filePath: secretsPath })).toBe(first.key);
    expect(lookupPreviewEncryptionKey({ slug: "absent", filePath: secretsPath })).toBeNull();
  });

  it("keys are PER-SLUG, so coexisting previews never share one", async () => {
    const a = await ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath });
    const b = await ensurePreviewEncryptionKey({ slug: "other", filePath: secretsPath });
    expect(b.key).not.toBe(a.key);
    expect((await ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath })).key).toBe(a.key);
  });

  it("CONCURRENT mints never drop a sibling's key (the store is locked)", async () => {
    const slugs = ["one", "two", "three", "four"];
    const results = await Promise.all(
      slugs.map((slug) => ensurePreviewEncryptionKey({ slug, filePath: secretsPath })),
    );
    for (const r of results) expect(r.minted).toBe(true);
    const store = JSON.parse(readFileSync(secretsPath, "utf8"));
    for (const slug of slugs) expect(store.keys[slug]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(Object.values(store.keys)).size).toBe(slugs.length);
  });

  it("fails LOUD on a corrupt store rather than re-minting over existing previews", async () => {
    mkdirSync(path.dirname(secretsPath), { recursive: true });
    writeFileSync(secretsPath, "{ not json");
    await expect(ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath })).rejects.toThrow(
      /unreadable or malformed/,
    );
    // Parses, but has no usable keys map — still corruption, still fail-closed.
    writeFileSync(secretsPath, JSON.stringify({ version: 1 }));
    await expect(ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath })).rejects.toThrow(
      /malformed/,
    );
    // A PRESENT but malformed per-slug entry is a live preview's key: never rotate it.
    writeFileSync(secretsPath, JSON.stringify({ version: 1, keys: { main: "short" } }));
    await expect(ensurePreviewEncryptionKey({ slug: "main", filePath: secretsPath })).rejects.toThrow(
      /orphan this preview's encrypted data/,
    );
    // The read-only lookup is fail-closed on the SAME entry (never null).
    expect(() => lookupPreviewEncryptionKey({ slug: "main", filePath: secretsPath })).toThrow(
      /orphan this preview's encrypted data/,
    );
  });

  it("a MINTED key is persisted only after the create it belongs to succeeds", async () => {
    // A create that never reaches healthy must leave NO key behind — a later
    // refresh would otherwise boot some other preview's volume with it.
    const failed = makeBootstrapDeps({ sha: SHA_A, health: { status: 503, body: '{"status":"degraded"}' } });
    await expect(
      runInstallPreviewBootstrap({
        targetDir: checkoutDir,
        ref: "main",
        instanceSlug: "inst-one",
        log: () => {},
        deps: failed.deps,
      }),
    ).rejects.toThrow(/did not reach healthy/);
    expect(existsSync(secretsPath)).toBe(false);

    const ok = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: ok.deps,
    });
    expect(lookupPreviewEncryptionKey({ slug: "inst-one", filePath: secretsPath })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC4: it is NOT added to the dev checkout's .env.local contract", async () => {
    const { deps } = makeBootstrapDeps();
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    const body = readFileSync(path.join(checkoutDir, ".env.local"), "utf8");
    expect(body).not.toContain(ENCRYPTION_KEY_ENV);
    // The checkout's bytes are exactly what the dev install wrote.
    expect(body).toBe(DEV_ENV_LOCAL);
  });
});

// ---------------------------------------------------------------------------
// AC1 + the LOAD-BEARING INVARIANT + the three inherited HARD NEVERs
// ---------------------------------------------------------------------------

describe("preview front door — end to end over the EXISTING create path (AC1, invariant, NEVERs)", () => {
  it("AC1: builds + boots at the resolved SHA and health-gates, via runPreviewCreate", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      log: () => {},
      deps,
    });
    expect(out.created).toBe(true);
    expect(out.sha).toBe(SHA_A);
    expect(out.state).toBe("healthy");
    expect(out.hostPort).toBeGreaterThanOrEqual(PREVIEW_HOST_PORT_MIN);

    // The EXISTING lifecycle ran: one build at the preview tag, one docker run.
    const build = fake.calls.find((c) => c[0] === "build");
    expect(build).toContain(previewImageTag(SHA_A));
    expect(runArgv(fake)).toContain(previewImageTag(SHA_A));

    // The slug is the preview lifecycle's OWN derivation (branch, else "main") —
    // the front door invents no slug scheme.
    expect(out.slug).toBe("main");
    // The EXISTING registry recorded the row — no second registry.
    const row = getPreview(readRegistry(registryPath).registry, out.slug);
    expect(row?.sha).toBe(SHA_A);
    expect(row?.state).toBe("ready");
  });

  it("AC3+AC5 proven on the actual `docker run` argv", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      log: () => {},
      deps,
    });
    const argv = runArgv(fake);
    // AC5: the host-gateway mapping is present…
    expect(argv).toContain(`--add-host ${CONTAINER_HOST_GATEWAY}:host-gateway`);
    // …and the infra endpoints point AT it, not at the container's own loopback.
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, `${CONTAINER_HOST_GATEWAY}:5434`, "postgres")}`);
    expect(argv).toContain(`REDIS_URL=redis://${CONTAINER_HOST_GATEWAY}:6381`);
    expect(argv).not.toContain("127.0.0.1:5434");
    // AC5 (distinct): the app/auth URLs name the PREVIEW's own published port.
    expect(argv).toContain(`NEXT_PUBLIC_APP_URL=http://localhost:${out.hostPort}`);
    expect(argv).toContain(`BETTER_AUTH_URL=http://localhost:${out.hostPort}`);
    // AC3: install-sourced secrets reached the container.
    expect(argv).toContain("BETTER_AUTH_SECRET=devsecret");
    // cinatra-cli#219: the connection service's ADDRESS is container-rewritten
    // and its CREDENTIAL rides along — the composition carries the pair, so a
    // connector save inside the preview reaches THIS instance's own Nango.
    expect(argv).toContain(`NANGO_SERVER_URL=http://${CONTAINER_HOST_GATEWAY}:3003`);
    expect(argv).toContain("NANGO_SECRET_KEY=nango-env-key");
    // AC4: the provisioned key reached the container.
    expect(argv).toMatch(new RegExp(`${ENCRYPTION_KEY_ENV}=[0-9a-f]{64}`));
  });

  it("INVARIANT: production semantics live INSIDE the container; the checkout stays development", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    // Inside the container: production.
    expect(runArgv(fake)).toContain(`CINATRA_RUNTIME_MODE=${PREVIEW_RUNTIME_MODE}`);
    // On disk: development, and the file is byte-unchanged.
    expect(readCheckoutEnvMode(checkoutDir)).toBe("development");
    expect(readFileSync(path.join(checkoutDir, ".env.local"), "utf8")).toBe(DEV_ENV_LOCAL);
  });

  it("AC8: the checkout still reads a DEVELOPMENT runtime mode and a later `preview create` is not refused", async () => {
    const { deps } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    const envMode = readCheckoutEnvMode(checkoutDir);
    expect(envMode).toBe("development");
    // The exact guard `instance preview create|refresh` applies to this directory.
    expect(() => assertPreviewCheckoutAllowed({ envMode })).not.toThrow();
  });

  it("NEVER (i): the only boot path is docker build + docker run — never a host next start", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    expect(fake.calls.flat().join(" ")).not.toMatch(/next start|standalone\/server\.js|server\.js/);
  });

  it("NEVER (ii): the tag stays in the local preview namespace, never a published production name", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    const all = fake.calls.flat().join(" ");
    expect(all).toContain("cinatra-preview:local-");
    expect(all).not.toContain("ghcr.io/cinatra-ai/cinatra");
    expect(all).not.toContain("docker.io/cinatra/cinatra");
    expect(fake.calls.find((c) => c[0] === "push")).toBeUndefined();
  });

  it("NEVER (iii): the bypass flag is never forwarded, and an AMBIENT truthy value refuses the run", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    expect(runArgv(fake)).not.toContain(MATERIALIZE_DISABLE_ENV);

    const second = makeBootstrapDeps({ sha: SHA_A });
    await expect(
      runInstallPreviewBootstrap({
        targetDir: checkoutDir,
        ref: "main",
        log: () => {},
        deps: second.deps,
        env: { [MATERIALIZE_DISABLE_ENV]: "true" },
      }),
    ).rejects.toThrow(/SAFETY invariant/);
    expect(second.fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });

  it("refuses outright against a genuine production checkout (inherited AC9 guard)", async () => {
    writeFileSync(path.join(checkoutDir, ".env.local"), "CINATRA_RUNTIME_MODE=production\n");
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await expect(
      runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps }),
    ).rejects.toThrow(/real production install/);
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC7 — rerun semantics: skip and report, never a failure, never a rebuild
// ---------------------------------------------------------------------------

describe("preview front door — rerun semantics (AC7)", () => {
  function seedExistingPreview({ sha = SHA_A, hostPort = 3400 } = {}) {
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        main: makePreviewSlot({ slug: "main", ref: "main", sha, hostPort, now: () => "T0" }),
      },
    });
  }

  it("an IN-FLIGHT (provisioning) claim is never reported as an existing preview", async () => {
    // A provisioning row is a CLAIM with no container behind it — reporting it as
    // "a preview already exists" strands the operator, because `refresh` refuses
    // a provisioning row too.
    writeRegistry(registryPath, {
      version: 1,
      previews: {
        stuck: {
          ...makePreviewSlot({ slug: "stuck", ref: "main", sha: SHA_A, hostPort: 3402, now: () => "T0" }),
          state: "provisioning",
        },
      },
    });
    expect(decidePreviewAction({ existing: { state: "provisioning", sha: SHA_A }, resolvedSha: SHA_B }).action)
      .toBe("in-flight");

    const { deps, fake, logs } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "stuck",
      log: (m) => logs.push(m),
      deps,
    });
    expect(out.inFlight).toBe(true);
    expect(out.created).toBe(false);
    const text = logs.join("\n");
    expect(text).toMatch(/IN FLIGHT/);
    expect(text).not.toMatch(/already exists/);
    expect(text).toContain("cinatra instance preview status --slug stuck");
    // Never adopts or deletes another operation's claim, and never builds.
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(getPreview(readRegistry(registryPath).registry, "stuck").state).toBe("provisioning");
  });

  it("decides SKIP when a row exists, CREATE when it does not, and flags ref drift", () => {
    expect(decidePreviewAction({ existing: null, resolvedSha: SHA_A })).toEqual({
      action: "create",
      existing: null,
      drift: false,
    });
    const existing = { slug: "cinatra", sha: SHA_A, state: "ready" };
    expect(decidePreviewAction({ existing, resolvedSha: SHA_A }).action).toBe("skip");
    expect(decidePreviewAction({ existing, resolvedSha: SHA_A }).drift).toBe(false);
    expect(decidePreviewAction({ existing, resolvedSha: SHA_B }).drift).toBe(true);
  });

  it("a SECOND run does not fail and does NOT rebuild the image — it reports the existing preview", async () => {
    seedExistingPreview({ sha: SHA_A, hostPort: 3407 });
    const { deps, fake, logs } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      log: (m) => logs.push(m),
      deps,
    });
    expect(out.skipped).toBe(true);
    expect(out.created).toBe(false);
    expect(out.drift).toBe(false);
    // AC7: no implicit rebuild, no boot.
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
    expect(fake.calls.find((c) => c[0] === "run")).toBeUndefined();
    // AC7: it REPORTS slug / SHA / port from previews.json.
    const text = logs.join("\n");
    expect(text).toContain("slug: main");
    expect(text).toContain(SHA_A);
    expect(text).toContain("3407");
    expect(text).toMatch(/SKIPPING create/);
  });

  it("REF DRIFT is reported and points at `instance preview refresh` (rebuilds stay explicit)", async () => {
    seedExistingPreview({ sha: SHA_A, hostPort: 3401 });
    const { deps, fake, logs } = makeBootstrapDeps({ sha: SHA_B });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      log: (m) => logs.push(m),
      deps,
    });
    expect(out.skipped).toBe(true);
    expect(out.drift).toBe(true);
    expect(out.sha).toBe(SHA_A); // still the REGISTERED sha
    expect(out.resolvedSha).toBe(SHA_B);
    const text = logs.join("\n");
    expect(text).toMatch(/Ref drift/);
    expect(text).toContain("cinatra instance preview refresh --slug main --ref main");
    expect(fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });

  it("the skip report names the existing row's facts, and the drift pointer only on drift", () => {
    const existing = {
      slug: "cinatra",
      sha: SHA_A,
      hostPort: 3400,
      state: "ready",
      imageTag: previewImageTag(SHA_A),
      provenance: `local-image:${SHA_A}`,
    };
    expect(previewInFlightReportLines({ existing }).join("\n")).toMatch(/IN FLIGHT/);
    const clean = previewSkipReportLines({ existing, resolvedSha: SHA_A, ref: "main", drift: false }).join("\n");
    expect(clean).not.toMatch(/Ref drift/);
    expect(clean).toContain("nothing to rebuild");
    const drifted = previewSkipReportLines({ existing, resolvedSha: SHA_B, ref: "main", drift: true }).join("\n");
    expect(drifted).toMatch(/Ref drift/);
    expect(drifted).toContain("instance preview refresh");
    // A `degraded` row is a preview whose last boot never reached healthy: even
    // at the same SHA, recovery is an explicit refresh — never "nothing to rebuild".
    const degraded = previewSkipReportLines({
      existing: { ...existing, state: "degraded" },
      resolvedSha: SHA_A,
      ref: "main",
      drift: false,
    }).join("\n");
    expect(degraded).not.toContain("nothing to rebuild");
    expect(degraded).toMatch(/did not reach healthy/);
    expect(degraded).toContain("cinatra instance preview refresh --slug cinatra --ref main");
  });
});

// ---------------------------------------------------------------------------
// Slug: the preview belongs to the INSTALLED INSTANCE, via the lifecycle's own
// `--slug` seam (no parallel slug scheme, no new registry)
// ---------------------------------------------------------------------------

describe("preview front door — slug derivation reuses the lifecycle's own seam", () => {
  it("names the preview after the installed instance, falling back to the branch default", () => {
    expect(previewSlugArgs({ instanceSlug: "cinatra-lane3" })).toEqual(["--slug", "cinatra-lane3"]);
    // An explicit caller-supplied slug always wins.
    expect(previewSlugArgs({ instanceSlug: "inst", rest: ["--slug", "chosen"] })).toEqual([
      "--slug",
      "chosen",
    ]);
    // An instance slug that does not satisfy the shared slug rules degrades to
    // the lifecycle default rather than throwing.
    for (const bad of [null, "", "-leading", "UPPER", "a".repeat(31)]) {
      expect(previewSlugArgs({ instanceSlug: bad })).toEqual([]);
    }
  });

  it("two installs of the SAME branch in different dirs get DIFFERENT previews", async () => {
    const a = makeBootstrapDeps({ sha: SHA_A });
    const first = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: a.deps,
    });
    expect(first.slug).toBe("inst-one");
    expect(first.created).toBe(true);

    const otherDir = path.join(tmp, "cinatra-2");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(path.join(otherDir, ".env.local"), DEV_ENV_LOCAL);
    const b = makeBootstrapDeps({ sha: SHA_A });
    const second = await runInstallPreviewBootstrap({
      targetDir: otherDir,
      ref: "main",
      instanceSlug: "inst-two",
      log: () => {},
      deps: b.deps,
    });
    // Not a false "already exists" skip: a different instance gets its own row,
    // its own container name and its own host port from the SHARED pool.
    expect(second.slug).toBe("inst-two");
    expect(second.created).toBe(true);
    expect(second.hostPort).not.toBe(first.hostPort);
    const reg = readRegistry(registryPath).registry;
    expect(getPreview(reg, "inst-one")).toBeTruthy();
    expect(getPreview(reg, "inst-two")).toBeTruthy();
  });

  it("AC7: the SAME instance re-run is the skip path (keyed by the instance, not the branch)", async () => {
    const a = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: a.deps,
    });
    const b = makeBootstrapDeps({ sha: SHA_A });
    const rerun = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: b.deps,
    });
    expect(rerun.skipped).toBe(true);
    expect(b.fake.calls.find((c) => c[0] === "build")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The handoff must be TRUE: `instance preview refresh` can continue a preview
// the front door created (AC7 image rebuilds, AC9 handoff)
// ---------------------------------------------------------------------------

describe("preview front door — `instance preview refresh` continues a front-door preview", () => {
  it("rebuilds at a new SHA using the persisted key + the container-reachable endpoints", async () => {
    const created = makeBootstrapDeps({ sha: SHA_A });
    const first = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: created.deps,
    });
    expect(first.created).toBe(true);

    // The operator follows the printed handoff — with NOTHING exported.
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    refreshed.state = { containerRunning: true };
    await runInstallPreviewRefresh(["--slug", "inst-one", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir,
      env: {}, // no CINATRA_ENCRYPTION_KEY, no DB/redis — the pre-fix dead end
    });
    const argv = runArgv(refreshed.fake);
    // It booted at all (the key came from the front door's own store)…
    expect(argv).toMatch(new RegExp(`${ENCRYPTION_KEY_ENV}=[0-9a-f]{64}`));
    // …with the SAME key the create used (never rotated — the volume is reused).
    const key = lookupPreviewEncryptionKey({ slug: "inst-one", filePath: secretsPath });
    expect(argv).toContain(`${ENCRYPTION_KEY_ENV}=${key}`);
    // …and still container-reachable + on its own durable port.
    expect(argv).toContain(`--add-host ${CONTAINER_HOST_GATEWAY}:host-gateway`);
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(DEV_DB_CRED, `${CONTAINER_HOST_GATEWAY}:5434`, "postgres")}`);
    expect(argv).toContain(`NEXT_PUBLIC_APP_URL=http://localhost:${first.hostPort}`);
    expect(argv).toContain(previewImageTag(SHA_B));
  });

  it("an EXPORTED value still wins — an env-driven refresh is unchanged", async () => {
    const created = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: created.deps,
    });
    const ownKey = "f".repeat(64);
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    await runInstallPreviewRefresh(["--slug", "inst-one", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir,
      env: {
        [ENCRYPTION_KEY_ENV]: ownKey,
        SUPABASE_DB_URL: pgUrl(OTHER_DB_CRED, "db.example.com:5432", "mine"),
      },
    });
    const argv = runArgv(refreshed.fake);
    expect(argv).toContain(`${ENCRYPTION_KEY_ENV}=${ownKey}`);
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(OTHER_DB_CRED, "db.example.com:5432", "mine")}`);
  });

  it("is a NO-OP for a preview the front door did not create (no invented env, no --add-host)", async () => {
    // A checkout with NO .env.local and no persisted key: the pre-#188 contract
    // is that refresh runs purely on the operator's exported environment.
    const bare = path.join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
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
      env: { [ENCRYPTION_KEY_ENV]: ownKey, SUPABASE_DB_URL: pgUrl(OTHER_DB_CRED, "db.example.com:5432", "x") },
    });
    const argv = runArgv(refreshed.fake);
    // The gateway mapping is preview.mjs's own, unconditional since #190 — what
    // must be absent is any env this checkout did not define.
    for (const key of PREVIEW_APP_URL_KEYS) expect(argv).not.toContain(`${key}=`);
    expect(argv).toContain(`${ENCRYPTION_KEY_ENV}=${ownKey}`);
    expect(argv).toContain(`SUPABASE_DB_URL=${pgUrl(OTHER_DB_CRED, "db.example.com:5432", "x")}`);
  });

  it("an ambient key DEFINED AS EMPTY suppresses the install value (it does not fall back)", async () => {
    const created = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: created.deps,
    });
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    await runInstallPreviewRefresh(["--slug", "inst-one", "--ref", "main"], {
      ...refreshed.deps,
      checkoutDir,
      env: { BETTER_AUTH_SECRET: "" },
    });
    // An explicitly-emptied key is dropped from the container env, exactly as an
    // unset value always was — the composition never resurrects it.
    expect(runArgv(refreshed.fake)).not.toContain("BETTER_AUTH_SECRET=");
  });

  it("NEVER (iii) still refuses on refresh when the bypass is forced on", async () => {
    const created = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      instanceSlug: "inst-one",
      log: () => {},
      deps: created.deps,
    });
    const refreshed = makeBootstrapDeps({ sha: SHA_B });
    await expect(
      runInstallPreviewRefresh(["--slug", "inst-one"], {
        ...refreshed.deps,
        checkoutDir,
        env: { [MATERIALIZE_DISABLE_ENV]: "true" },
      }),
    ).rejects.toThrow(/SAFETY invariant/);
  });
});

// ---------------------------------------------------------------------------
// Terminal install tails must not silently swallow the composition
// ---------------------------------------------------------------------------

describe("install --mode preview — terminal-tail safety", () => {
  it("refuses an EXPLICIT co-use request before any side effect (co-use owns the tail)", () => {
    for (const argv of [
      ["--mode", "preview", "--infra=share"],
      ["--mode", "preview", "--on-conflict=co-use"],
      ["preview", "--infra", "share"],
      ["--mode", "preview", "--reuse-from", "other"],
    ]) {
      expect(() => parseInstallArgs(argv)).toThrow(/cannot be combined with co-use/);
    }
    // dev/prod/demo co-use requests are untouched.
    expect(() => parseInstallArgs(["--mode", "dev", "--infra=share"])).not.toThrow();
  });

  // cinatra-cli#194: the front door is a COMPOSITION — the whole dev install
  // runs before the preview lifecycle is reached — so a malformed build budget
  // has to be caught while parsing arguments, or a typo costs a full install
  // before it surfaces.
  it("rejects a malformed build-budget override at ARG-PARSE time, before the install runs", () => {
    const KEY = "CINATRA_PREVIEW_BUILD_TIMEOUT_MS";
    const original = process.env[KEY];
    const restore = () => {
      if (original === undefined) delete process.env[KEY];
      else process.env[KEY] = original;
    };
    try {
      for (const bad of ["90m", "0", "-1", "Infinity", "99999999999"]) {
        process.env[KEY] = bad;
        expect(() => parseInstallArgs(["--mode", "preview"]), `expected ${bad} to be rejected`).toThrow(
          new RegExp(KEY),
        );
        // The variable is meaningless for a plain dev/prod/demo install, so it
        // must NOT break an operator who simply exports it in their profile.
        expect(() => parseInstallArgs(["--mode", "dev"])).not.toThrow();
      }
      process.env[KEY] = "10800000";
      expect(() => parseInstallArgs(["--mode", "preview"])).not.toThrow();
      delete process.env[KEY];
      expect(() => parseInstallArgs(["--mode", "preview"])).not.toThrow();
    } finally {
      restore();
    }
  });

  // The same argument covers every `--build-arg` lever: they are read from the
  // same operator environment and reach the same build, so a typo in any of them
  // must cost nothing, not a full dev install.
  it("rejects a malformed BUILD-ARG lever at ARG-PARSE time, before the install runs", () => {
    const cases = [
      ["CINATRA_PREVIEW_BUILD_MEMORY_MB", ["4g", "0", "-1", "4096MB"], "8192"],
      ["CINATRA_PREVIEW_BUILD_TYPECHECK", ["yes-please", "2", "maybe"], "1"],
      ["CINATRA_PREVIEW_BUILD_CPUS", ["auto", "0", "1.5", "4 cores"], "3"],
      ["CINATRA_PREVIEW_BUILD_BUNDLER", ["turbo", "rspack", "webpack5"], "webpack"],
    ];
    for (const [KEY, bad, good] of cases) {
      const original = process.env[KEY];
      try {
        for (const value of bad) {
          process.env[KEY] = value;
          expect(() => parseInstallArgs(["--mode", "preview"]), `expected ${KEY}=${value} to be rejected`).toThrow(
            new RegExp(KEY),
          );
          // Meaningless for a plain dev/prod/demo install, so it must NOT break
          // an operator who simply exports it in their shell profile.
          expect(() => parseInstallArgs(["--mode", "dev"])).not.toThrow();
        }
        process.env[KEY] = good;
        expect(() => parseInstallArgs(["--mode", "preview"])).not.toThrow();
        delete process.env[KEY];
        expect(() => parseInstallArgs(["--mode", "preview"])).not.toThrow();
      } finally {
        if (original === undefined) delete process.env[KEY];
        else process.env[KEY] = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC9 — the terminating handoff
// ---------------------------------------------------------------------------

describe("preview front door — handoff (AC9)", () => {
  it("names the verb family that MANAGES the preview: refresh | status | list", () => {
    const text = previewHandoffLines({ slug: "cinatra", ref: "main", hostPort: 3400 }).join("\n");
    expect(text).toContain("cinatra instance preview refresh --slug cinatra --ref main");
    expect(text).toContain("cinatra instance preview status --slug cinatra");
    expect(text).toContain("cinatra instance preview list");
    expect(text).toContain("http://localhost:3400");
    // A preview that is NOT running has a recorded port but nothing behind it —
    // the handoff must never offer to open it.
    const notRunning = previewHandoffLines({ slug: "cinatra", ref: "main", hostPort: 3400, running: false }).join("\n");
    expect(notRunning).not.toContain("Open it at");
    expect(notRunning).toContain("cinatra instance preview status --slug cinatra");
    // AC9 + the invariant: the divergence is STATED, not discovered.
    expect(text).toMatch(/INSIDE the container/);
    expect(text).toMatch(/CINATRA_RUNTIME_MODE=development/);
  });
});

// ---------------------------------------------------------------------------
// cinatra-cli#248 — the front door carries the bind flag and the new
// deployment-registry passthrough keys
// ---------------------------------------------------------------------------

describe("preview front door — bind + deployment-registry passthrough (cinatra-cli#248)", () => {
  const REGISTRY_KEYS = {
    CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_URL: "https://deployments.example.test",
    CINATRA_DEPLOYMENT_REGISTRY_PUBLIC_READ_TOKEN: "read-only-token",
    CINATRA_DEPLOYMENT_REGISTRY_ROUTING_MODE: "hosted",
    CINATRA_DEPLOYMENT_REGISTRY_ALLOW_FIXTURE: "false",
  };

  it("AC2: the four keys are composed from the install with NO second change site", () => {
    const { env, forwardedKeys } = derivePreviewEnvFromInstall({
      envValues: { ...REGISTRY_KEYS },
      previewHostPort: 3400,
      onlyDefinedKeys: true,
    });
    for (const [k, v] of Object.entries(REGISTRY_KEYS)) {
      expect(env[k]).toBe(v);
      expect(forwardedKeys).toContain(k);
      // Composed, never rewritten — they are not container-dialed loopback keys.
      expect(CONTAINER_REWRITE_ENV_KEYS).not.toContain(k);
      expect(PASSTHROUGH_ENV_KEYS).toContain(k);
    }
  });

  it("AC2: they reach the container on the real `install --mode preview` argv", async () => {
    writeFileSync(
      path.join(checkoutDir, ".env.local"),
      `${DEV_ENV_LOCAL}\n${Object.entries(REGISTRY_KEYS).map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
    );
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    const argv = runArgv(fake);
    for (const [k, v] of Object.entries(REGISTRY_KEYS)) expect(argv).toContain(`${k}=${v}`);
  });

  it("AC1: `--bind` survives the front door's argv RECONSTRUCTION and reaches `docker run`", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      rest: ["--bind", "127.0.0.1"],
      log: () => {},
      deps,
    });
    const argv = runArgv(fake);
    expect(argv).toContain(`127.0.0.1:${out.hostPort}:3000`);
    expect(argv).not.toContain(`-p ${out.hostPort}:3000`);
  });

  it("AC1: with no `--bind` the front door's publish is unchanged", async () => {
    const { deps, fake } = makeBootstrapDeps({ sha: SHA_A });
    const out = await runInstallPreviewBootstrap({ targetDir: checkoutDir, ref: "main", log: () => {}, deps });
    expect(runArgv(fake)).toContain(`-p ${out.hostPort}:3000`);
  });

  it("previewBindArgs extracts BOTH spellings and forwards nothing else", () => {
    expect(previewBindArgs({ rest: [] })).toEqual([]);
    expect(previewBindArgs({ rest: ["--slug", "x", "--rebuild"] })).toEqual([]);
    expect(previewBindArgs({ rest: ["--bind", "127.0.0.1"] })).toEqual(["--bind", "127.0.0.1"]);
    expect(previewBindArgs({ rest: ["--bind=127.0.0.1"] })).toEqual(["--bind", "127.0.0.1"]);
    // A bare trailing `--bind` is forwarded as an EMPTY value so create's own
    // validator refuses it, rather than being silently dropped here.
    expect(previewBindArgs({ rest: ["--bind"] })).toEqual(["--bind", ""]);
  });

  it("AC1: `install --mode preview --bind` is validated while ARGUMENTS are parsed, before any install work", () => {
    expect(parseInstallArgs(["--mode", "preview", "--bind", "127.0.0.1"]).previewBind).toBe("127.0.0.1");
    expect(parseInstallArgs(["--mode", "preview"]).previewBind).toBe(null);
    expect(() => parseInstallArgs(["--mode", "preview", "--bind", "127.0.0.1:3400"])).toThrow(/--bind/);
    // Preview-only: it names the interface the PREVIEW container publishes on.
    expect(() => parseInstallArgs(["--mode", "dev", "--bind", "127.0.0.1"])).toThrow(/--mode preview/);
  });

  it("AC1: `install --mode preview` honours CINATRA_PREVIEW_BIND_HOST, and the flag still wins", () => {
    const prior = process.env.CINATRA_PREVIEW_BIND_HOST;
    try {
      // The front door hands the lifecycle a RECONSTRUCTED argv and a COMPOSED
      // env, so the env form only reaches `docker run` if the install itself
      // resolves it — without that, this whole invocation publishes wide while
      // the operator believes it is narrowed.
      process.env.CINATRA_PREVIEW_BIND_HOST = "127.0.0.1";
      expect(parseInstallArgs(["--mode", "preview"]).previewBind).toBe("127.0.0.1");
      expect(parseInstallArgs(["--mode", "preview", "--bind", "10.0.0.5"]).previewBind).toBe("10.0.0.5");
      process.env.CINATRA_PREVIEW_BIND_HOST = "127.0.0.1:3400";
      expect(() => parseInstallArgs(["--mode", "preview"])).toThrow(/--bind/);
      // A dev install neither reads nor refuses it — it publishes no preview.
      process.env.CINATRA_PREVIEW_BIND_HOST = "127.0.0.1";
      expect(parseInstallArgs(["--mode", "dev"]).previewBind).toBe(null);
    } finally {
      if (prior === undefined) delete process.env.CINATRA_PREVIEW_BIND_HOST;
      else process.env.CINATRA_PREVIEW_BIND_HOST = prior;
    }
  });
});
