// cinatra#2654 D1 — the isolated compose must REFERENCE the WayFlow bridge-token
// env file, not a render-time snapshot of it.
//
// The defect this locks shut, exactly as the clean-install matrix measured it:
// an isolated install renders `docker-compose.cinatra-isolated.yml` from
// `docker compose config`, which RESOLVES every service `env_file:` — it inlines
// whatever the file held at render time into `environment:` and drops the
// directive. The bring-up writes `docker/wayflow/.wayflow.env` one second LATER:
//
//   2026-08-18 05:45:58  docker-compose.cinatra-isolated.yml   <- rendered first
//   2026-08-18 05:45:59  docker/wayflow/.wayflow.env           <- written after
//
// So a FIRST install on a clean directory froze the wayflow service with three
// static keys and no CINATRA_BRIDGE_TOKEN; the runtime crash-looped ("[agent_
// loader] FATAL: CINATRA_BRIDGE_TOKEN is unset or empty"); the install still
// exited 0 and marked the instance ready; and every reconcile re-used the same
// frozen file. Only a SECOND install on the same directory worked — because the
// first attempt's file was on disk by the time the second one rendered.
//
// Four things must hold, and each one restores the bug on its own:
//   1. the isolated render keeps `env_file:` (`--no-env-resolution`), so the
//      file's CONTENT is read at `up` time — a first install then reaches the
//      container with all six keys,
//   2. an invariant refuses to WRITE a generated compose whose wayflow service
//      has no route for the token,
//   3. a reconcile re-renders the generated compose (the matrix proved its mtime
//      was unchanged across one), and
//   4. an env file that cannot be produced FAILS the install, attributably, with
//      nothing built, nothing started and no ready instance.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ISOLATED_COMPOSE_FILENAME,
  generateIsolatedCompose,
  renderIsolatedComposeYaml,
  wayflowEnvWiringGap,
  writeIsolatedComposeFile,
} from "../src/install-isolation.mjs";
import {
  bringUpInfra,
  composeConfigForFiles,
  regenerateIsolatedComposeInPlace,
  rollbackIsolatedInstance,
} from "../src/install.mjs";
import {
  allocateInstance,
  getInstance,
  markInstanceReady,
  readInstanceRegistry,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";

// The six keys the runtime's container config must carry. Three are static
// compose literals; three (plus WAYFLOW_BASE_URL) arrive through the narrow
// generated env file. The matrix measured exactly this set on the one isolated
// install whose runtime came up healthy.
const SIX_KEYS = [
  "CINATRA_AGENTS_DIR",
  "CINATRA_BASE_URL",
  "CINATRA_BRIDGE_TOKEN",
  "CINATRA_CONTEXT_ATTEST_KEY",
  "PORT",
  "WAYFLOW_BASE_URL",
];

const WAYFLOW_ENV_REL = path.join("docker", "wayflow", ".wayflow.env");

/** dotenv parse, the same shape `scripts/gen-wayflow-env.mjs` uses. */
function parseEnvFile(body) {
  const env = {};
  for (const line of String(body).split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** What the wayflow container's environment ACTUALLY is when compose starts it
 *  from a document: the env files it references, overlaid by `environment:`
 *  (compose's precedence — an `environment:` key wins over an env_file key). */
function effectiveServiceEnv(doc, service) {
  const svc = doc?.services?.[service] ?? {};
  const merged = {};
  for (const entry of Array.isArray(svc.env_file) ? svc.env_file : []) {
    const file = typeof entry === "string" ? entry : entry?.path;
    if (file && existsSync(file)) Object.assign(merged, parseEnvFile(readFileSync(file, "utf8")));
  }
  return { ...merged, ...(svc.environment ?? {}) };
}

/** The checkout's compose as `docker compose config --format json` renders it,
 *  mirroring the real `wayflow` service (narrow `env_file`, `required: false`,
 *  three static non-secret `environment:` keys). */
function baseComposeDoc() {
  return {
    name: "cinatra",
    networks: { default: { name: "cinatra_default" } },
    volumes: { pgdata: {} },
    services: {
      postgres: {
        image: "postgres:16",
        environment: { POSTGRES_PASSWORD: "postgres" },
        ports: [{ mode: "ingress", target: 5432, published: "5434", protocol: "tcp", host_ip: "127.0.0.1" }],
      },
      wayflow: {
        build: { context: "/checkout/docker/wayflow" },
        profiles: ["wayflow", "drupal", "wordpress"],
        environment: {
          PORT: "3010",
          CINATRA_AGENTS_DIR: "/agents",
          CINATRA_BASE_URL: "http://host.docker.internal:3000",
        },
        env_file: [{ path: "/checkout/docker/wayflow/.wayflow.env", required: false }],
        ports: [{ mode: "ingress", target: 3010, published: "3010", protocol: "tcp", host_ip: "127.0.0.1" }],
      },
    },
  };
}

/** A fake `capture` that behaves like `docker compose config` for the fixture
 *  checkout: it RESOLVES `env_file:` into `environment:` (dropping the
 *  directive) unless the caller passed `--no-env-resolution`. That resolution IS
 *  the D1 mechanism, so the fake reproduces it faithfully rather than assuming
 *  the outcome. */
function fakeComposeConfig(dir, seen = []) {
  return (command, args) => {
    seen.push({ command, args });
    const doc = baseComposeDoc();
    const envFile = path.join(dir, WAYFLOW_ENV_REL);
    doc.services.wayflow.env_file = [{ path: envFile, required: false }];
    doc.services.wayflow.build = { context: path.join(dir, "docker", "wayflow") };
    if (!args.includes("--no-env-resolution")) {
      const fromFile = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf8")) : {};
      doc.services.wayflow.environment = { ...fromFile, ...doc.services.wayflow.environment };
      delete doc.services.wayflow.env_file;
    }
    return JSON.stringify(doc);
  };
}

/** What the bring-up does just before `docker compose up`: run the checkout's
 *  generator, which writes the narrow file from `.env.local`. */
function writeWayflowEnvFile(dir, { token = "fixture-bridge-token", baseUrl = "http://localhost:13010/" } = {}) {
  mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
  writeFileSync(
    path.join(dir, WAYFLOW_ENV_REL),
    [
      `CINATRA_BRIDGE_TOKEN=${token}`,
      "CINATRA_CONTEXT_ATTEST_KEY=fixture-attest-key",
      `WAYFLOW_BASE_URL=${baseUrl}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "x2654-d1-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. A FIRST install on a clean directory reaches the container with all six keys.
// ---------------------------------------------------------------------------

describe("first isolated install on a clean directory (cinatra#2654 D1)", () => {
  // The install ordering, with the fs + `docker` calls injected. `provisionFirst`
  // is the fixed ordering (the env file is written BEFORE the compose is
  // resolved); `provisionFirst: false` is the ordering the matrix measured, where
  // the file appears one second after the render — the reference must carry the
  // keys in BOTH cases, since only the second half of the pair is under this
  // code's control once an instance exists.
  const renderThenGenerate = ({ preserveEnvFiles, provisionFirst = true }) => {
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\n", { mode: 0o600 });
    if (provisionFirst) writeWayflowEnvFile(dir);
    const seen = [];
    const resolved = composeConfigForFiles(
      dir,
      ["docker-compose.yml", "docker-compose.dev.yml"],
      { capture: fakeComposeConfig(dir, seen) },
      { allProfiles: true, preserveEnvFiles },
    );
    const { doc } = generateIsolatedCompose({
      resolvedConfig: resolved,
      offset: 10000,
      projectName: "cinatra_row1",
      slug: "row1",
      appPort: 3300,
      envFileKeys: new Set(["CINATRA_BRIDGE_TOKEN"]),
    });
    writeIsolatedComposeFile(path.join(dir, ISOLATED_COMPOSE_FILENAME), doc);
    // The bring-up (re)provisions the bridge-token env file just before `up`.
    writeWayflowEnvFile(dir);
    return { doc, seen };
  };

  it("the isolated render asks compose NOT to resolve service env files", () => {
    const { seen } = renderThenGenerate({ preserveEnvFiles: true });
    expect(seen[0].command).toBe("docker");
    expect(seen[0].args).toContain("--no-env-resolution");
    // The flag belongs to `config`, so it must follow the subcommand.
    expect(seen[0].args.indexOf("--no-env-resolution")).toBeGreaterThan(seen[0].args.indexOf("config"));
  });

  it("all six env keys reach the rendered wayflow service config", () => {
    const { doc } = renderThenGenerate({ preserveEnvFiles: true });
    const env = effectiveServiceEnv(doc, "wayflow");
    expect(Object.keys(env).sort()).toEqual([...SIX_KEYS].sort());
    expect(env.CINATRA_BRIDGE_TOKEN).not.toBe("");
    // The generated file REFERENCES the env file — it never persists the token.
    expect(readFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), "utf8")).not.toContain(
      env.CINATRA_BRIDGE_TOKEN,
    );
    expect(doc.services.wayflow.env_file[0].path).toBe(path.join(dir, WAYFLOW_ENV_REL));
  });

  it("all six keys still arrive when the env file appears AFTER the render", () => {
    // The matrix's mtimes (compose at :58, env at :59). The preserved reference
    // is what makes that ordering survivable at all.
    const { doc } = renderThenGenerate({ preserveEnvFiles: true, provisionFirst: false });
    expect(Object.keys(effectiveServiceEnv(doc, "wayflow")).sort()).toEqual([...SIX_KEYS].sort());
  });

  it("a rotated token propagates: the container follows the FILE, not the render", () => {
    const { doc } = renderThenGenerate({ preserveEnvFiles: true });
    writeWayflowEnvFile(dir, { token: "fixture-rotated-token" });
    expect(effectiveServiceEnv(doc, "wayflow").CINATRA_BRIDGE_TOKEN).toBe("fixture-rotated-token");
  });

  it("REGRESSION CONTROL: resolving env files at render time reproduces the defect exactly", () => {
    const { doc } = renderThenGenerate({ preserveEnvFiles: false, provisionFirst: false });
    // The matrix's measured rendering of rows 1 to 5, key for key.
    expect(Object.keys(doc.services.wayflow.environment ?? {}).sort()).toEqual([
      "CINATRA_AGENTS_DIR",
      "CINATRA_BASE_URL",
      "PORT",
    ]);
    expect(doc.services.wayflow.env_file).toBeUndefined();
    expect(effectiveServiceEnv(doc, "wayflow").CINATRA_BRIDGE_TOKEN).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. The invariant: never WRITE a compose whose runtime cannot get the token.
// ---------------------------------------------------------------------------

describe("wayflowEnvWiringGap — the generated document's token route", () => {
  const docWith = (svc) => ({ services: { wayflow: svc } });

  it("a preserved env_file reference is a route (the file is read at up-time)", () => {
    expect(wayflowEnvWiringGap(docWith({ env_file: [{ path: "/c/docker/wayflow/.wayflow.env", required: false }] }))).toBeNull();
  });

  it("an explicit non-empty token in environment is a route too", () => {
    expect(wayflowEnvWiringGap(docWith({ environment: { CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}" } }))).toBeNull();
  });

  it("the D1 rendering — three static keys, no env_file — is a GAP", () => {
    const gap = wayflowEnvWiringGap(
      docWith({ environment: { PORT: "3010", CINATRA_AGENTS_DIR: "/agents", CINATRA_BASE_URL: "http://x:3000" } }),
    );
    expect(gap).toContain("CINATRA_BRIDGE_TOKEN");
    expect(gap).toContain("crash-loop");
  });

  it("an EMPTY inlined token is a gap (an empty value overrides an env_file key)", () => {
    expect(wayflowEnvWiringGap(docWith({ environment: { CINATRA_BRIDGE_TOKEN: "" } }))).toBeTruthy();
  });

  it("a document with no wayflow service at all has nothing to wire", () => {
    expect(wayflowEnvWiringGap({ services: { postgres: {} } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. A reconcile re-renders the generated compose.
// ---------------------------------------------------------------------------

describe("reconcile regenerates the isolated compose (cinatra#2654 D1)", () => {
  const OFFSET = 10000;
  const row = {
    slug: "row5",
    composeProject: "cinatra_row5",
    composeFiles: [ISOLATED_COMPOSE_FILENAME],
    ports: { postgres: [15434], wayflow: [13010] },
    appPort: 3300,
    offset: OFFSET,
  };

  /** The artifact a pre-fix first install left behind: profile-gated services
   *  present (so the cinatra-cli#113 "already has the peers" test passes) AND a
   *  wayflow service with no bridge-token route. */
  const brokenIsolatedDoc = () => {
    const doc = baseComposeDoc();
    doc.name = row.composeProject;
    delete doc.services.wayflow.env_file;
    doc.services.wayflow.ports = [
      { mode: "ingress", target: 3010, published: "13010", protocol: "tcp", host_ip: "127.0.0.1" },
    ];
    doc.services.postgres.ports = [
      { mode: "ingress", target: 5432, published: "15434", protocol: "tcp", host_ip: "127.0.0.1" },
    ];
    doc.services["a2a-peer-number-bob"] = {
      image: "cinatra/a2a-peer",
      profiles: ["a2a-peers"],
      ports: [{ mode: "ingress", target: 41241, published: "51241", protocol: "tcp", host_ip: "127.0.0.1" }],
    };
    return doc;
  };

  const setup = () => {
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\n", { mode: 0o600 });
    writeFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), renderIsolatedComposeYaml(brokenIsolatedDoc()), {
      mode: 0o600,
    });
    const registryPath = path.join(dir, "instances.json");
    const { registry } = allocateInstance({ version: 1, instances: {} }, row.slug, {
      mode: "dev",
      installDir: dir,
      composeProject: row.composeProject,
      composeFiles: row.composeFiles,
      ports: row.ports,
      appPort: row.appPort,
      offset: OFFSET,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: "new",
      state: "provisioning",
    });
    writeInstanceRegistry(registryPath, markInstanceReady(registry, row.slug));
    return {
      registryPath,
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath: path.join(dir, "alloc.lock"),
        composeConfigForFiles: (targetDir, files, d, opts) =>
          JSON.parse(fakeComposeConfig(dir)("docker", ["compose", "config", ...(opts?.preserveEnvFiles ? ["--no-env-resolution"] : [])])),
      },
    };
  };

  it("re-renders a compose that already carries the profile-gated services", async () => {
    const { deps } = setup();
    const isoPath = path.join(dir, ISOLATED_COMPOSE_FILENAME);
    const before = readFileSync(isoPath, "utf8");
    const mtimeBefore = statSync(isoPath).mtimeMs;

    const result = await regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps });

    expect(result.regenerated).toBe(true);
    const after = readFileSync(isoPath, "utf8");
    expect(after).not.toBe(before);
    expect(statSync(isoPath).mtimeMs).toBeGreaterThanOrEqual(mtimeBefore);
    // The whole point: the repaired file carries the token route the old one lacked.
    const repaired = JSON.parse(after);
    expect(wayflowEnvWiringGap(repaired)).toBeNull();
    expect(repaired.services.wayflow.env_file[0].path).toBe(path.join(dir, WAYFLOW_ENV_REL));
  });

  it("keeps every already-remapped host port exactly where the registry recorded it", async () => {
    const { deps, registryPath } = setup();
    const result = await regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps });
    expect(result.ports.postgres).toEqual([15434]);
    expect(result.ports.wayflow).toEqual([13010]);
    expect(getInstance(readInstanceRegistry(registryPath).registry, row.slug).offset).toBe(OFFSET);
  });

  it("never clobbers a file it cannot parse (an operator edit stays untouched)", async () => {
    const { deps } = setup();
    const isoPath = path.join(dir, ISOLATED_COMPOSE_FILENAME);
    writeFileSync(isoPath, "services:\n  wayflow:\n    image: hand-edited\n", { mode: 0o600 });
    const result = await regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps });
    expect(result.regenerated).toBe(false);
    expect(readFileSync(isoPath, "utf8")).toContain("hand-edited");
  });
});

// ---------------------------------------------------------------------------
// 4. An env file that cannot be produced fails the install — nothing marked ready.
// ---------------------------------------------------------------------------

describe("an unproducible .wayflow.env fails the install attributably", () => {
  /** A checkout whose generator exists and exits 0 but writes nothing — the
   *  "cannot be produced" case the exit code alone cannot see. */
  const checkoutWithSilentGenerator = () => {
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "gen-wayflow-env.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(dir, ".env.local"), "CINATRA_RUNTIME_MODE=development\n", { mode: 0o600 });
  };

  it("aborts before the image build and before the `up` — nothing is started", () => {
    checkoutWithSilentGenerator();
    let built = false;
    let thrown = null;
    try {
      bringUpInfra({
        slug: "row1",
        deps: {
          assertRecreateSafe: () => {},
          ensureNangoSecretKey: () => null,
          buildWayflowImage: () => {
            built = true;
            return { ok: true, stderr: "", status: 0 };
          },
        },
        targetDir: dir,
        log: () => {},
        composeFiles: [ISOLATED_COMPOSE_FILENAME],
        composeProject: "cinatra_row1",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    // Attributable, like the broken-build path row 7 proved correct: it names the
    // step, the file, and BOTH recoveries.
    expect(thrown.message).toContain("CINATRA_BRIDGE_TOKEN");
    expect(thrown.message).toContain(".wayflow.env");
    expect(thrown.message).toContain("--no-wayflow");
    // The build never ran, so the `up` after it cannot have run either.
    expect(built).toBe(false);
  });

  it("a rolled-back pending instance leaves NO ready row and no generated compose", async () => {
    const registryPath = path.join(dir, "instances.json");
    const { registry } = allocateInstance({ version: 1, instances: {} }, "row1", {
      mode: "dev",
      installDir: dir,
      composeProject: "cinatra_row1",
      composeFiles: [ISOLATED_COMPOSE_FILENAME],
      ports: { postgres: [15434] },
      appPort: 3300,
      offset: 10000,
      repoUrl: "https://github.com/cinatra-ai/cinatra.git",
      ref: "main",
      infraMode: "new",
      state: "provisioning",
    });
    writeInstanceRegistry(registryPath, registry);
    writeFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), "{}\n", { mode: 0o600 });
    // The state the failed bring-up left: a PROVISIONING row, never ready.
    expect(getInstance(readInstanceRegistry(registryPath).registry, "row1").state).toBe("provisioning");

    await rollbackIsolatedInstance({
      targetDir: dir,
      slug: "row1",
      composeProject: "cinatra_row1",
      composeFiles: [ISOLATED_COMPOSE_FILENAME],
      envSnapshot: { path: path.join(dir, ".env.local"), existed: false, content: null },
      log: () => {},
      deps: {
        instanceRegistryPath: registryPath,
        allocLockPath: path.join(dir, "alloc.lock"),
        runComposeDown: () => {},
      },
    });

    expect(getInstance(readInstanceRegistry(registryPath).registry, "row1")).toBeNull();
    expect(existsSync(path.join(dir, ISOLATED_COMPOSE_FILENAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The same claim against the real `docker compose`, render-only.
// ---------------------------------------------------------------------------

const dockerComposeAvailable = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerComposeAvailable)("real `docker compose config` (render only, no services)", () => {
  it("a first-install render + a later env file gives the container all six keys", () => {
    // A fixture checkout shaped like the real one: the narrow env_file, three
    // static keys, no published ports (nothing is started, nothing is bound).
    writeFileSync(
      path.join(dir, "docker-compose.yml"),
      [
        "services:",
        "  wayflow:",
        "    image: busybox",
        "    env_file:",
        "      - path: ./docker/wayflow/.wayflow.env",
        "        required: false",
        "    environment:",
        '      PORT: "3010"',
        '      CINATRA_AGENTS_DIR: "/agents"',
        '      CINATRA_BASE_URL: "http://host.docker.internal:3000"',
        "    profiles:",
        "      - wayflow",
        "",
      ].join("\n"),
    );
    const capture = (command, args, opts) =>
      execFileSync(command, args, { cwd: opts?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    // The fixed ordering: the bridge-token env file is provisioned BEFORE the
    // isolated compose is resolved (Compose versions differ on whether they keep
    // a `required: false` env_file whose file does not exist yet).
    writeWayflowEnvFile(dir);
    const resolved = composeConfigForFiles(dir, ["docker-compose.yml"], { capture }, {
      allProfiles: true,
      preserveEnvFiles: true,
    });
    const { doc } = generateIsolatedCompose({
      resolvedConfig: resolved,
      offset: 10000,
      projectName: "cinatra_row1",
      slug: "row1",
      appPort: 3300,
      envFileKeys: new Set(),
    });
    expect(wayflowEnvWiringGap(doc)).toBeNull();
    // Where this Compose honours --no-env-resolution, the generated file carries
    // the REFERENCE and no host secret; where it inlines regardless, the keys are
    // still there. Both are asserted for what they are, never assumed.
    if (doc.services.wayflow.env_file) {
      expect(doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBeUndefined();
    }
    writeIsolatedComposeFile(path.join(dir, ISOLATED_COMPOSE_FILENAME), doc);

    // The bring-up regenerates the env file, then the `up` reads the GENERATED
    // compose. Ask compose itself what the service's environment resolves to.
    writeWayflowEnvFile(dir, { token: "fixture-rotated-token" });
    const rendered = JSON.parse(
      execFileSync("docker", ["compose", "--profile", "*", "-f", ISOLATED_COMPOSE_FILENAME, "config", "--format", "json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(Object.keys(rendered.services.wayflow.environment).sort()).toEqual([...SIX_KEYS].sort());
    expect(rendered.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).not.toBe("");
    // A preserved reference also means the rotated value is the one that reaches
    // the container, rather than a copy frozen at render time.
    if (doc.services.wayflow.env_file) {
      expect(rendered.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("fixture-rotated-token");
    }
  });
});
