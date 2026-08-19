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
// Seven things must hold, and each one restores the bug (or a sibling of it) on
// its own:
//   1. the isolated render keeps `env_file:` (`--no-env-resolution`), so the
//      file's CONTENT is read at `up` time — a first install then reaches the
//      container with all six keys,
//   2. that flag is PROBED, never assumed, and a Compose without it takes a
//      stated fallback route that still carries the token,
//   3. an invariant refuses to WRITE a generated compose whose wayflow service
//      has no route for the token — including the precedence trap where an
//      EMPTY `environment:` value overrides a present `env_file:`, and the case
//      where the reference points at some other file,
//   4. the same invariant covers `nango-server`, `knowledge-graph-mcp` and
//      `plane-mcp`, which read narrow generated env files the same way,
//   5. a reconcile re-renders the generated compose (the matrix proved its mtime
//      was unchanged across one) and a regeneration FAILURE is loud,
//   6. an env file that cannot be produced FAILS the install, attributably, with
//      nothing built, nothing started and no ready instance, and
//   7. the generated file says, in itself, that it is CLI-owned.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKOUT_ENV_FILE_SERVICES,
  ISOLATED_COMPOSE_FILENAME,
  canonicalPath,
  checkoutDeclaredEnvFiles,
  composeEnvWiringGaps,
  generateIsolatedCompose,
  parseIsolatedComposeDoc,
  renderIsolatedComposeYaml,
  writeIsolatedComposeFile,
} from "../src/install-isolation.mjs";
import {
  __resetComposeFeatureProbe,
  bringUpInfra,
  composeConfigForFiles,
  composeSupportsNoEnvResolution,
  regenerateIsolatedCompose,
  regenerateIsolatedComposeInPlace,
  rollbackIsolatedInstance,
  runInstall,
} from "../src/install.mjs";
import {
  allocateInstance,
  getInstance,
  markInstanceReady,
  readInstanceRegistry,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";
import { envFileSuppliedKeys } from "../src/wayflow-runtime.mjs";
import { readMarker } from "../src/instance-marker.mjs";

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
 *  three static non-secret `environment:` keys) AND the three sibling services
 *  that read their own narrow generated env files the same way. */
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

/** The other three services that take host secrets from a narrow generated env
 *  file rather than from `environment:` — the same contract as wayflow, and the
 *  same reason (an empty `environment:` value would override the file).
 *
 *  Paths read off `cinatra-ai/cinatra`'s own `docker-compose.yml` `env_file:`
 *  blocks (round 3 — the earlier fixture guessed `docker/kg-mcp/.kg.env` and
 *  `docker/plane-mcp/.plane.env`, neither of which the checkout declares), and
 *  they MUST equal the production table `CHECKOUT_ENV_FILE_SERVICES` — asserted
 *  below, so the fixture cannot drift away from what the CLI actually protects. */
const SIBLING_ENV_FILE_SERVICES = {
  "nango-server": "docker/nango/.nango.env",
  "knowledge-graph-mcp": "docker/graphiti/.graphiti.env",
  "plane-mcp": "docker/plane-mcp/.plane-mcp.env",
};

/** The key each of those files supplies in the fixtures, and whether `.env.local`
 *  also supplies it (which decides whether the fallback render may re-symbolise
 *  it to `${KEY}` or has to freeze the literal). */
const SIBLING_ENV_FILE_KEYS = {
  "nango-server": { key: "NANGO_ENCRYPTION_KEY", value: "envlocal-nango-key", inEnvLocal: true },
  // The app's OpenAI key lives in the app DATABASE, not `.env.local` —
  // gen-graphiti-env.mjs resolves it from there (see the checkout's compose
  // comment), so it is NOT on the scrub allowlist.
  "knowledge-graph-mcp": { key: "OPENAI_API_KEY", value: "graphiti-only-openai-key", inEnvLocal: false },
  // The Plane PAT is minted into the env file by provision-plane.mjs.
  "plane-mcp": { key: "PLANE_API_TOKEN", value: "plane-only-pat", inEnvLocal: false },
};

/** Write the three sibling env files into a checkout, as their generators do. */
function writeSiblingEnvFiles(dir) {
  for (const [svc, rel] of Object.entries(SIBLING_ENV_FILE_SERVICES)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const { key, value } = SIBLING_ENV_FILE_KEYS[svc];
    writeFileSync(abs, `${key}=${value}\n`, { mode: 0o600 });
  }
}

/** `baseComposeDoc()` plus the three siblings, each with its own narrow
 *  `env_file:` and a published port so the band is non-empty. */
function baseComposeDocWithSiblings(dir) {
  const doc = baseComposeDoc();
  let port = 3003;
  for (const [svc, rel] of Object.entries(SIBLING_ENV_FILE_SERVICES)) {
    doc.services[svc] = {
      image: `cinatra/${svc}`,
      environment: { SERVICE_NAME: svc },
      env_file: [{ path: path.join(dir, rel), required: false }],
      ports: [
        { mode: "ingress", target: port, published: String(port), protocol: "tcp", host_ip: "127.0.0.1" },
      ],
    };
    port += 1;
  }
  return doc;
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
      for (const svc of Object.values(doc.services)) {
        for (const entry of Array.isArray(svc.env_file) ? svc.env_file : []) {
          const p = typeof entry === "string" ? entry : entry?.path;
          const fromFile = p && existsSync(p) ? parseEnvFile(readFileSync(p, "utf8")) : {};
          svc.environment = { ...fromFile, ...(svc.environment ?? {}) };
        }
        delete svc.env_file;
      }
    }
    return JSON.stringify(doc);
  };
}

/** What the bring-up does just before `docker compose up`: run the checkout's
 *  generator, which writes the narrow file from `.env.local`. */
function writeWayflowEnvFile(dir, {
  token = "fixture-bridge-token",
  attest = "fixture-attest-key",
  baseUrl = "http://localhost:13010/",
} = {}) {
  mkdirSync(path.join(dir, "docker", "wayflow"), { recursive: true });
  writeFileSync(
    path.join(dir, WAYFLOW_ENV_REL),
    [
      `CINATRA_BRIDGE_TOKEN=${token}`,
      `CINATRA_CONTEXT_ATTEST_KEY=${attest}`,
      `WAYFLOW_BASE_URL=${baseUrl}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "x2654-d1-"));
  __resetComposeFeatureProbe();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetComposeFeatureProbe();
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
// 2. COMPOSE VERSION SAFETY — the flag is probed, and the fallback still carries
//    the token.
// ---------------------------------------------------------------------------

describe("`config --no-env-resolution` is probed BEHAVIOURALLY, never assumed (cinatra#2654 D1)", () => {
  // The probe renders a throwaway compose whose only env source is an env_file
  // and asks whether the reference SURVIVED — it does not ask whether the flag
  // is spelled in `--help`, because those are different questions and this PR's
  // own CI proved they can disagree (see the 2.38.2 case below).
  const probeOutput = (svc) =>
    JSON.stringify({ services: { "cinatra-env-resolution-probe": svc } });

  it("reports SUPPORTED when the rendered probe still carries `env_file:`", () => {
    const calls = [];
    const supported = composeSupportsNoEnvResolution({
      captureImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, cwd: opts?.cwd });
        return probeOutput({ image: "busybox", env_file: [{ path: "/probe/.cinatra-probe.env", required: false }] });
      },
    });
    expect(supported).toBe(true);
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args).toContain("--no-env-resolution");
    expect(calls[0].args.indexOf("--no-env-resolution")).toBeGreaterThan(calls[0].args.indexOf("config"));
    // Rendered in a temp dir, never in the checkout.
    expect(calls[0].cwd).toMatch(/cinatra-compose-probe-/);
  });

  it("REGRESSION CONTROL (Compose 2.38.2): the flag is ACCEPTED and still inlines — UNSUPPORTED", () => {
    // Measured, not assumed: `docker compose config --help` on 2.38.2 (GitHub
    // ubuntu-latest) lists `--no-env-resolution`, the flag is accepted, exit 0 —
    // and the output has the env file's content in `environment:` with the
    // directive gone. A `--help` probe would have called that supported and the
    // render would have frozen a snapshot: the original defect, unchanged.
    expect(
      composeSupportsNoEnvResolution({
        captureImpl: () =>
          probeOutput({ image: "busybox", environment: { CINATRA_ENV_RESOLUTION_PROBE: "1" } }),
      }),
    ).toBe(false);
  });

  it("reports UNSUPPORTED when the probe itself fails (unknown flag → capture returns null)", () => {
    // Fail CLOSED: an unknown answer must not be read as "the reference is kept".
    expect(composeSupportsNoEnvResolution({ captureImpl: () => null })).toBe(false);
  });

  it("reports UNSUPPORTED on unparseable probe output", () => {
    expect(composeSupportsNoEnvResolution({ captureImpl: () => "not json" })).toBe(false);
  });

  it("caches the answer for the process (one probe per install, not one per render)", () => {
    let calls = 0;
    const probe = () => {
      calls += 1;
      return probeOutput({ env_file: ["/probe/.cinatra-probe.env"] });
    };
    composeSupportsNoEnvResolution({ captureImpl: probe });
    composeSupportsNoEnvResolution({ captureImpl: probe });
    expect(calls).toBe(1);
  });

  it("leaves nothing behind: the probe's temp dir is removed", () => {
    let seenCwd = null;
    composeSupportsNoEnvResolution({
      captureImpl: (_cmd, _args, opts) => {
        seenCwd = opts?.cwd;
        return probeOutput({ env_file: ["/probe/.cinatra-probe.env"] });
      },
    });
    expect(seenCwd).toBeTruthy();
    expect(existsSync(seenCwd)).toBe(false);
  });

  /** The whole isolated render, driven through `runInstall`'s executor seams,
   *  with the probe forced to a known answer. Returns the generated document. */
  const renderWithProbe = (supported) => {
    writeFileSync(
      path.join(dir, ".env.local"),
      "CINATRA_BRIDGE_TOKEN=fixture-bridge-token\nCINATRA_CONTEXT_ATTEST_KEY=fixture-attest-key\n",
      { mode: 0o600 },
    );
    writeWayflowEnvFile(dir);
    const seen = [];
    const resolved = composeConfigForFiles(
      dir,
      ["docker-compose.yml"],
      { capture: fakeComposeConfig(dir, seen) },
      { allProfiles: true, preserveEnvFiles: supported },
    );
    const { doc } = generateIsolatedCompose({
      resolvedConfig: resolved,
      offset: 10000,
      projectName: "cinatra_row1",
      slug: "row1",
      appPort: 3300,
      envFileKeys: new Set(["CINATRA_BRIDGE_TOKEN", "CINATRA_CONTEXT_ATTEST_KEY"]),
    });
    return { doc, seen, resolved };
  };

  it("FALLBACK: on an unsupported Compose the flag is not sent, and the token still has a route", () => {
    const { doc, seen } = renderWithProbe(false);
    expect(seen[0].args).not.toContain("--no-env-resolution");
    // The env file was provisioned BEFORE the render, so what compose inlined is
    // the real wiring — and the generator re-symbolised it, so the generated file
    // holds a resolvable placeholder rather than the secret itself.
    expect(doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("${CINATRA_BRIDGE_TOKEN}");
    expect(doc.services.wayflow.environment.CINATRA_CONTEXT_ATTEST_KEY).toBe("${CINATRA_CONTEXT_ATTEST_KEY}");
    expect(renderIsolatedComposeYaml(doc)).not.toContain("fixture-bridge-token");
    expect(renderIsolatedComposeYaml(doc)).not.toContain("fixture-attest-key");
    // And the invariant, told which route ran, accepts it.
    expect(composeEnvWiringGaps(doc, { envFilesPreserved: false })).toEqual([]);
  });

  it("FALLBACK: the invariant for that route still rejects a document with NO token value", () => {
    const { doc } = renderWithProbe(false);
    delete doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN;
    const gaps = composeEnvWiringGaps(doc, { envFilesPreserved: false });
    expect(gaps.join(" ")).toContain("no non-empty CINATRA_BRIDGE_TOKEN");
    expect(gaps.join(" ")).toContain("--no-env-resolution");
  });

  it("the SUPPORTED route is asserted as itself — a fallback-shaped document fails it", () => {
    const { doc } = renderWithProbe(false);
    // Same document, judged against the preferred route: no reference, so a gap.
    const gaps = composeEnvWiringGaps(doc, {
      envFilesPreserved: true,
      wayflowEnvFilePath: path.join(dir, WAYFLOW_ENV_REL),
    });
    expect(gaps.join(" ")).toContain("does not reference");
  });
});

// ---------------------------------------------------------------------------
// 3. The invariant: never WRITE a compose whose runtime cannot get the token.
// ---------------------------------------------------------------------------

describe("composeEnvWiringGaps — the generated document's token route", () => {
  const EXPECTED = "/checkout/docker/wayflow/.wayflow.env";
  const docWith = (svc) => ({ services: { wayflow: svc } });
  const gaps = (svc, opts = {}) =>
    composeEnvWiringGaps(docWith(svc), { wayflowEnvFilePath: EXPECTED, ...opts });

  it("a preserved reference to the EXPECTED path is a route (the file is read at up-time)", () => {
    expect(gaps({ env_file: [{ path: EXPECTED, required: false }] })).toEqual([]);
  });

  it("a reference to some OTHER file is NOT a route (the path is checked, not mere presence)", () => {
    const found = gaps({ env_file: [{ path: "/checkout/docker/wayflow/.other.env", required: false }] });
    expect(found.join(" ")).toContain("does not reference");
    expect(found.join(" ")).toContain(EXPECTED);
  });

  it("the D1 rendering — three static keys, no env_file — is a GAP", () => {
    const found = gaps({
      environment: { PORT: "3010", CINATRA_AGENTS_DIR: "/agents", CINATRA_BASE_URL: "http://x:3000" },
    });
    expect(found.join(" ")).toContain("CINATRA_BRIDGE_TOKEN");
    expect(found.join(" ")).toContain("crash-loop");
  });

  it("PRECEDENCE: an EMPTY token in `environment:` is a gap even WITH the env_file present", () => {
    // This is the trap the checkout's own compose comments name: compose gives
    // `environment:` precedence, so the empty value beats the file's value and
    // the container starts tokenless with a perfectly correct-looking reference.
    const found = gaps({
      env_file: [{ path: EXPECTED, required: false }],
      environment: { CINATRA_BRIDGE_TOKEN: "" },
    });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("OVERRIDES");
    expect(found[0]).toContain("EMPTY CINATRA_BRIDGE_TOKEN");
  });

  it("PRECEDENCE: a whitespace-only token value is empty too", () => {
    expect(gaps({ env_file: [{ path: EXPECTED, required: false }], environment: { CINATRA_BRIDGE_TOKEN: "   " } })
      .join(" ")).toContain("OVERRIDES");
  });

  it("a `${VAR}` placeholder counts as a route on the fallback path (the up resolves it)", () => {
    expect(
      composeEnvWiringGaps(docWith({ environment: { CINATRA_BRIDGE_TOKEN: "${CINATRA_BRIDGE_TOKEN}" } }), {
        envFilesPreserved: false,
      }),
    ).toEqual([]);
  });

  it("a document with no wayflow service at all has nothing to wire", () => {
    expect(composeEnvWiringGaps({ services: { postgres: {} } }, { wayflowEnvFilePath: EXPECTED })).toEqual([]);
  });

  it("resolves a RELATIVE env_file path against the checkout root", () => {
    expect(
      composeEnvWiringGaps(docWith({ env_file: ["./docker/wayflow/.wayflow.env"] }), {
        wayflowEnvFilePath: "/checkout/docker/wayflow/.wayflow.env",
        baseDir: "/checkout",
      }),
    ).toEqual([]);
  });

  // ── Requirement 5: the same protection story for the three siblings ─────────
  describe("the other three narrow-env-file services", () => {
    /** A source document (what `config --no-env-resolution` returned) and the
     *  generated one derived from it. */
    const pair = () => {
      const source = baseComposeDocWithSiblings("/checkout");
      const generated = JSON.parse(JSON.stringify(source));
      return { source, generated };
    };

    it("every `env_file:` the SOURCE document carried must survive into the generated one", () => {
      const { source, generated } = pair();
      expect(
        composeEnvWiringGaps(generated, {
          sourceDoc: source,
          wayflowEnvFilePath: "/checkout/docker/wayflow/.wayflow.env",
        }),
      ).toEqual([]);
    });

    for (const svc of Object.keys(SIBLING_ENV_FILE_SERVICES)) {
      it(`a generated compose that DROPPED ${svc}'s env_file is a named gap`, () => {
        const { source, generated } = pair();
        delete generated.services[svc].env_file;
        const found = composeEnvWiringGaps(generated, {
          sourceDoc: source,
          wayflowEnvFilePath: "/checkout/docker/wayflow/.wayflow.env",
        });
        expect(found.length).toBe(1);
        expect(found[0]).toContain(`service "${svc}"`);
        expect(found[0]).toContain(SIBLING_ENV_FILE_SERVICES[svc]);
        expect(found[0]).toContain("frozen at render time");
      });

      it(`an INLINED ${svc} (the D1 mechanism applied to a sibling) is the same gap`, () => {
        const { source, generated } = pair();
        // Exactly what a resolving `config` does: content in, directive out.
        generated.services[svc].environment = { ...generated.services[svc].environment, SOME_SECRET: "value" };
        delete generated.services[svc].env_file;
        expect(
          composeEnvWiringGaps(generated, { sourceDoc: source }).join(" "),
        ).toContain(`service "${svc}"`);
      });
    }

    it("PRECEDENCE is checked for every service, not just wayflow", () => {
      const { source, generated } = pair();
      generated.services["nango-server"].environment.NANGO_SECRET = "";
      const found = composeEnvWiringGaps(generated, {
        sourceDoc: source,
        // The reader the executor supplies: which NON-EMPTY keys the on-disk
        // env file actually provides.
        envFileKeysAt: (p) =>
          p.endsWith(".nango.env") ? new Set(["NANGO_SECRET"]) : null,
      });
      expect(found.length).toBe(1);
      expect(found[0]).toContain('service "nango-server"');
      expect(found[0]).toContain("EMPTY NANGO_SECRET");
      expect(found[0]).toContain("OVERRIDES");
    });

    it("an empty `environment:` value for a key the file does NOT supply is fine", () => {
      // A legitimately-unset OPENAI_API_KEY carried from `.env.example` must not
      // fail an install: it only overrides when the file supplies that key.
      const { source, generated } = pair();
      generated.services["nango-server"].environment.OPENAI_API_KEY = "";
      expect(
        composeEnvWiringGaps(generated, {
          sourceDoc: source,
          envFileKeysAt: () => new Set(["NANGO_SECRET"]),
        }),
      ).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3b. A SYMLINKED install directory (cinatra#2654 D1, round 4).
//
// `docker compose config` emits every `env_file:` path as a REALPATH. Every path
// the CLI compares them against is built from the caller's `targetDir` — what
// the operator typed, or what `getRepoRoot()` returned. Reach the checkout
// through a symlink (`~/src/app` → `/data/checkouts/app`, a linked home volume,
// a symlinked TMPDIR) and those are two different STRINGS for the same file, so
// every env-file comparison read as a missing reference: four gaps, aborting the
// install at the invariant — on the PRESERVING route, the one this PR adds.
// ---------------------------------------------------------------------------

describe("a SYMLINKED install directory compares by FILE IDENTITY, not by spelling (cinatra#2654 D1)", () => {
  let real;
  let link;

  beforeEach(() => {
    real = path.join(dir, "real-checkout");
    link = path.join(dir, "linked-checkout");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, "dir");
    writeWayflowEnvFile(real);
    writeSiblingEnvFiles(real);
  });

  /** The document as a PRESERVING engine emits it: every `env_file:` a realpath. */
  const enginePaths = () => {
    const doc = baseComposeDocWithSiblings(real);
    doc.services.wayflow.env_file = [{ path: path.join(real, WAYFLOW_ENV_REL), required: false }];
    doc.services.wayflow.build = { context: path.join(real, "docker", "wayflow") };
    return doc;
  };

  /** …checked against expectations spelled through the SYMLINK, which is how the
   *  CLI spells them (they all descend from `targetDir`). */
  const gapsThroughLink = (doc, extra = {}) =>
    composeEnvWiringGaps(doc, {
      sourceDoc: JSON.parse(JSON.stringify(doc)),
      wayflowEnvFilePath: path.join(link, WAYFLOW_ENV_REL),
      declaredEnvFiles: checkoutDeclaredEnvFiles(link),
      envFileKeysAt: (abs) => envFileSuppliedKeys(abs),
      baseDir: link,
      ...extra,
    });

  it("the preserving route's four references all hold through the link", () => {
    // Before the fix this returned exactly four gaps — wayflow's bridge-token
    // reference plus all three siblings — and aborted the install.
    expect(gapsThroughLink(enginePaths())).toEqual([]);
  });

  it("tolerates a not-yet-created env file: the reference still matches", () => {
    // The ordering this must survive: `.wayflow.env` is compared before a
    // dry-run (or a first render) has created it. Only the symlinked DIRECTORY
    // prefix needs canonicalising, and it is the only part that differs.
    rmSync(path.join(real, WAYFLOW_ENV_REL), { force: true });
    const found = gapsThroughLink(enginePaths()).filter((g) => g.includes("wayflow"));
    expect(found).toEqual([]);
  });

  it("still catches a REAL mismatch — it did not just make every path equal", () => {
    const doc = enginePaths();
    doc.services.wayflow.env_file = [{ path: path.join(real, "docker", "wayflow", ".other.env"), required: false }];
    expect(gapsThroughLink(doc).join(" ")).toContain("does not reference");
  });

  it("canonicalPath: an existing path realpaths; a wholly non-existent one resolves", () => {
    expect(canonicalPath(path.join(link, WAYFLOW_ENV_REL))).toBe(path.join(realpathSync(real), WAYFLOW_ENV_REL));
    // A deeper missing leaf still canonicalises its EXISTING ancestor — that is
    // the whole point, and it holds however deep the missing tail is.
    expect(canonicalPath(path.join(link, "docker", "wayflow", "not-created-yet.env")))
      .toBe(path.join(realpathSync(real), "docker", "wayflow", "not-created-yet.env"));
    // Nothing in the chain exists (only `/` resolves) → the plain resolved
    // spelling, never a throw.
    const nowhere = path.join(path.sep, "x2654-no-such-root", "deeper", ".env");
    expect(canonicalPath(nowhere)).toBe(path.resolve(nowhere));
    // Relative forms still resolve against the base first.
    expect(canonicalPath(`./${WAYFLOW_ENV_REL}`, link)).toBe(path.join(realpathSync(real), WAYFLOW_ENV_REL));
  });
});

// ---------------------------------------------------------------------------
// 4. The generated file is CLI-OWNED, and says so.
// ---------------------------------------------------------------------------

describe("the generated compose declares its own ownership (cinatra#2654 D1)", () => {
  it("carries a DO-NOT-EDIT header that states regeneration is the contract", () => {
    const body = renderIsolatedComposeYaml(baseComposeDoc());
    expect(body.startsWith("# GENERATED FILE — DO NOT EDIT.")).toBe(true);
    expect(body).toContain("CLI-OWNED");
    expect(body).toContain("preserves NOTHING from the previous copy");
    expect(body).toContain("edit the checkout's own compose files");
  });

  it("round-trips through the CLI's own reader; a hand-written YAML file does not", () => {
    const doc = baseComposeDoc();
    expect(parseIsolatedComposeDoc(renderIsolatedComposeYaml(doc))).toEqual(doc);
    expect(parseIsolatedComposeDoc("services:\n  wayflow:\n    image: hand-edited\n")).toBeNull();
    expect(parseIsolatedComposeDoc("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. A reconcile re-renders the generated compose, and says so out loud when it
//    cannot.
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

  const setup = (extraDeps = {}) => {
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
        composeSupportsNoEnvResolution: () => true,
        composeConfigForFiles: (targetDir, files, d, opts) =>
          JSON.parse(
            fakeComposeConfig(dir)("docker", [
              "compose",
              "config",
              ...(opts?.preserveEnvFiles ? ["--no-env-resolution"] : []),
            ]),
          ),
        ...extraDeps,
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
    const repaired = parseIsolatedComposeDoc(after);
    expect(
      composeEnvWiringGaps(repaired, { wayflowEnvFilePath: path.join(dir, WAYFLOW_ENV_REL), baseDir: dir }),
    ).toEqual([]);
    expect(repaired.services.wayflow.env_file[0].path).toBe(path.join(dir, WAYFLOW_ENV_REL));
  });

  it("keeps every already-remapped host port exactly where the registry recorded it", async () => {
    const { deps, registryPath } = setup();
    const result = await regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps });
    expect(result.ports.postgres).toEqual([15434]);
    expect(result.ports.wayflow).toEqual([13010]);
    expect(getInstance(readInstanceRegistry(registryPath).registry, row.slug).offset).toBe(OFFSET);
  });

  it("OPERATOR-EDITS POLICY: a hand-edited file is REPLACED, not silently honoured", async () => {
    // The old behaviour skipped any file it could not parse, which made
    // corrupting the file the way to pin a defective compose in place — and the
    // "never clobber an operator edit" comment claimed a preservation that did
    // not exist for the parseable case either (every one was overwritten whole).
    // The policy is now explicit and uniform: CLI-owned, re-derived, nothing kept.
    const { deps } = setup();
    const isoPath = path.join(dir, ISOLATED_COMPOSE_FILENAME);
    writeFileSync(isoPath, "services:\n  wayflow:\n    image: hand-edited\n", { mode: 0o600 });
    const lines = [];
    const result = await regenerateIsolatedComposeInPlace({
      targetDir: dir,
      row,
      log: (l) => lines.push(String(l)),
      deps,
    });
    expect(result.regenerated).toBe(true);
    const body = readFileSync(isoPath, "utf8");
    expect(body).not.toContain("hand-edited");
    // And the operator is told, in the log AND in the file itself.
    expect(lines.join("\n")).toContain("not a CLI-generated document");
    expect(body.startsWith("# GENERATED FILE — DO NOT EDIT.")).toBe(true);
  });

  it("an ABSENT file is the only no-op (nothing to re-derive in place)", async () => {
    const { deps } = setup();
    rmSync(path.join(dir, ISOLATED_COMPOSE_FILENAME));
    const result = await regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps });
    expect(result).toEqual({ regenerated: false, skipped: "absent" });
  });

  it("LOUD FAILURE: an unresolvable compose config THROWS instead of leaving the defective file", async () => {
    const { deps } = setup({ composeConfigForFiles: () => null });
    await expect(
      regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps }),
    ).rejects.toThrow(/could not resolve `docker compose config`/);
    // The old file is still there — which is exactly why the throw must reach the
    // caller rather than be swallowed: bringing this up would start the defect.
    expect(
      composeEnvWiringGaps(parseIsolatedComposeDoc(readFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), "utf8")), {
        wayflowEnvFilePath: path.join(dir, WAYFLOW_ENV_REL),
        baseDir: dir,
      }).length,
    ).toBeGreaterThan(0);
  });

  it("LOUD FAILURE: a regenerated document that violates the wiring invariant THROWS", async () => {
    const { deps } = setup({
      // A checkout whose compose lost the wayflow env_file altogether.
      composeConfigForFiles: () => {
        const doc = baseComposeDoc();
        delete doc.services.wayflow.env_file;
        return doc;
      },
    });
    await expect(
      regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, deps }),
    ).rejects.toThrow(/Refusing to write the isolated compose[\s\S]*CINATRA_BRIDGE_TOKEN/);
  });

  it("SKIP (not failure): an ambiguous legacy band offset is reported by name", async () => {
    const { deps } = setup();
    const legacyRow = { ...row, offset: null, ports: {} };
    const result = await regenerateIsolatedComposeInPlace({
      targetDir: dir,
      row: legacyRow,
      log: () => {},
      deps,
    });
    expect(result.regenerated).toBe(false);
    expect(result.skipped).toContain("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// 5b. All FOUR services are protected on the PRODUCTION assertion path, on BOTH
//     render routes — not only in a unit test that supplies its own key reader.
//     (cinatra#2654 D1, round 3)
// ---------------------------------------------------------------------------

describe("four-service protection is ACTIVE in production (cinatra#2654 D1)", () => {
  const OFFSET = 10000;
  /** The band `baseComposeDocWithSiblings` publishes, shifted by OFFSET. */
  const row = {
    slug: "row4",
    composeProject: "cinatra_row4",
    composeFiles: [ISOLATED_COMPOSE_FILENAME],
    ports: {
      postgres: [15434],
      wayflow: [13010],
      "nango-server": [13003],
      "knowledge-graph-mcp": [13004],
      "plane-mcp": [13005],
    },
    appPort: 3300,
    offset: OFFSET,
  };

  /** A `docker compose config` fake for a checkout with ALL FOUR narrow-env-file
   *  services. `mutate` edits the RESOLVED document, i.e. it models what the
   *  render (or a future generator change) actually hands the generator — so a
   *  reference the source itself never carried cannot be caught by the
   *  source-driven rule, which is the whole point of these cases. */
  const fourServiceConfig = (mutate = null) => (targetDir, files, d, opts) => {
    const doc = baseComposeDocWithSiblings(dir);
    doc.services.wayflow.env_file = [{ path: path.join(dir, WAYFLOW_ENV_REL), required: false }];
    doc.services.wayflow.build = { context: path.join(dir, "docker", "wayflow") };
    if (!opts?.preserveEnvFiles) {
      // The inlining engine: content in, directive out — the D1 mechanism.
      for (const svc of Object.values(doc.services)) {
        for (const entry of Array.isArray(svc.env_file) ? svc.env_file : []) {
          const f = typeof entry === "string" ? entry : entry?.path;
          const fromFile = f && existsSync(f) ? parseEnvFile(readFileSync(f, "utf8")) : {};
          svc.environment = { ...fromFile, ...(svc.environment ?? {}) };
        }
        delete svc.env_file;
      }
    }
    if (mutate) mutate(doc);
    return doc;
  };

  /** A checkout with all four env files on disk, a `.env.local` that supplies the
   *  keys the scrub allowlist needs, and a recorded registry row. */
  const setup = ({ preserves = true, mutate = null, recordedDoc = undefined } = {}) => {
    writeFileSync(
      path.join(dir, ".env.local"),
      [
        "CINATRA_BRIDGE_TOKEN=fixture-bridge-token",
        "CINATRA_CONTEXT_ATTEST_KEY=fixture-attest-key",
        `NANGO_ENCRYPTION_KEY=${SIBLING_ENV_FILE_KEYS["nango-server"].value}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeWayflowEnvFile(dir);
    writeSiblingEnvFiles(dir);
    writeFileSync(
      path.join(dir, ISOLATED_COMPOSE_FILENAME),
      recordedDoc === undefined ? renderIsolatedComposeYaml({ name: row.composeProject, services: {} }) : recordedDoc,
      { mode: 0o600 },
    );
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
        composeSupportsNoEnvResolution: () => preserves,
        composeVersionString: () => (preserves ? "5.5.0" : "2.38.2"),
        composeConfigForFiles: fourServiceConfig(mutate),
      },
    };
  };

  const regen = (deps, override = {}) =>
    regenerateIsolatedComposeInPlace({ targetDir: dir, row: { ...row, ...override }, log: () => {}, deps });

  it("the fixture's service→file table IS the production table", () => {
    // A fixture that names files the checkout does not declare protects nothing.
    expect(Object.fromEntries(CHECKOUT_ENV_FILE_SERVICES.map((e) => [e.service, e.file]))).toEqual({
      wayflow: WAYFLOW_ENV_REL,
      ...Object.fromEntries(
        Object.entries(SIBLING_ENV_FILE_SERVICES).map(([svc, rel]) => [svc, path.join(...rel.split("/"))]),
      ),
    });
  });

  it("checkoutDeclaredEnvFiles lists only files that EXIST (drift is fail-open)", () => {
    expect(checkoutDeclaredEnvFiles(dir)).toEqual([]);
    writeWayflowEnvFile(dir);
    writeSiblingEnvFiles(dir);
    expect(checkoutDeclaredEnvFiles(dir).map((e) => e.service).sort()).toEqual([
      "knowledge-graph-mcp",
      "nango-server",
      "plane-mcp",
      "wayflow",
    ]);
    // A renamed/removed env file drops out rather than failing the install.
    rmSync(path.join(dir, SIBLING_ENV_FILE_SERVICES["plane-mcp"]));
    expect(checkoutDeclaredEnvFiles(dir).map((e) => e.service)).not.toContain("plane-mcp");
  });

  it("PRESERVING route: a sibling reference the SOURCE never carried is still caught", async () => {
    // The source-driven rule cannot see this — the resolved document has no
    // `env_file:` for nango-server to compare against. Only the checkout's own
    // declared table does, which is exactly what round 3 added.
    const { deps } = setup({ preserves: true, mutate: (doc) => delete doc.services["nango-server"].env_file });
    await expect(regen(deps)).rejects.toThrow(
      /Refusing to write the isolated compose[\s\S]*"nango-server"[\s\S]*\.nango\.env/,
    );
  });

  for (const svc of Object.keys(SIBLING_ENV_FILE_SERVICES)) {
    it(`PRECEDENCE in production: an EMPTY ${svc} override is rejected with the REAL key reader`, async () => {
      // No `envFileKeysAt` is injected here — the production path reads the
      // sibling's env file off disk itself. Before round 3 it returned null for
      // every non-wayflow path and this rendering sailed through.
      const { key } = SIBLING_ENV_FILE_KEYS[svc];
      const { deps } = setup({
        preserves: true,
        mutate: (doc) => {
          doc.services[svc].environment = { ...doc.services[svc].environment, [key]: "" };
        },
      });
      await expect(regen(deps)).rejects.toThrow(
        new RegExp(`Refusing to write the isolated compose[\\s\\S]*"${svc}" sets an EMPTY ${key}`),
      );
    });
  }

  it("FALLBACK route: a sibling whose VALUE was lost fails the install by name", async () => {
    // On an inlining Compose the reference is gone by the engine's own doing, so
    // "did the reference survive" protects nothing. What must survive is the
    // value — and this render loses it.
    const { deps } = setup({
      preserves: false,
      mutate: (doc) => {
        doc.services["plane-mcp"].environment[SIBLING_ENV_FILE_KEYS["plane-mcp"].key] = "";
      },
    });
    await expect(regen(deps)).rejects.toThrow(
      /Refusing to write the isolated compose[\s\S]*"plane-mcp" would start with NO value for PLANE_API_TOKEN/,
    );
  });

  it("FALLBACK route, healthy: every sibling's value survives into the generated document", async () => {
    const { deps } = setup({ preserves: false });
    const result = await regen(deps);
    expect(result.regenerated).toBe(true);
    const doc = parseIsolatedComposeDoc(readFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), "utf8"));
    // A key `.env.local` supplies is re-symbolised (resolved from --env-file at
    // `up`, never persisted).
    expect(doc.services["nango-server"].environment.NANGO_ENCRYPTION_KEY).toBe("${NANGO_ENCRYPTION_KEY}");
    // A key `.env.local` does NOT supply cannot be re-symbolised — `${KEY}` would
    // resolve BLANK (cinatra-cli#57). It is frozen as its literal instead, which
    // is the documented cost of the fallback route (the file is written 0600).
    expect(doc.services["knowledge-graph-mcp"].environment.OPENAI_API_KEY).toBe("graphiti-only-openai-key");
    expect(doc.services["plane-mcp"].environment.PLANE_API_TOKEN).toBe("plane-only-pat");
    // wayflow's own full key set survives too, as placeholders.
    expect(doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("${CINATRA_BRIDGE_TOKEN}");
    expect(doc.services.wayflow.environment.CINATRA_CONTEXT_ATTEST_KEY).toBe("${CINATRA_CONTEXT_ATTEST_KEY}");
    expect(doc.services.wayflow.environment.WAYFLOW_BASE_URL).toBeTruthy();
  });

  // ── `--no-wayflow` OPTS OUT OF THE WAYFLOW ARM (cinatra#2654 D1, round 4) ──
  //
  // Provisioning `.wayflow.env` is already gated on the opt-out, but the
  // invariant was not: on an INLINING Compose the file is never written, so
  // nothing inlines a token, so the fallback arm found no non-empty
  // CINATRA_BRIDGE_TOKEN and aborted an install that had explicitly asked for no
  // agent runtime. The gate belongs on the SAME flag, and ONLY on the wayflow arm.

  it("--no-wayflow: the FALLBACK route no longer demands a token route it opted out of", async () => {
    const { deps } = setup({ preserves: false });
    // The opt-out ordering: no `.wayflow.env` was provisioned, so the inlining
    // render carries no token for the wayflow service.
    rmSync(path.join(dir, WAYFLOW_ENV_REL), { force: true });
    await expect(regen(deps)).rejects.toThrow(/carries no non-empty CINATRA_BRIDGE_TOKEN/);
    const result = await regenerateIsolatedComposeInPlace({
      targetDir: dir,
      row,
      log: () => {},
      wayflow: false,
      deps,
    });
    expect(result.regenerated).toBe(true);
  });

  it("--no-wayflow gates ONLY the wayflow arm — the three siblings stay protected", async () => {
    const { deps } = setup({
      preserves: false,
      mutate: (doc) => {
        doc.services["plane-mcp"].environment[SIBLING_ENV_FILE_KEYS["plane-mcp"].key] = "";
      },
    });
    rmSync(path.join(dir, WAYFLOW_ENV_REL), { force: true });
    await expect(
      regenerateIsolatedComposeInPlace({ targetDir: dir, row, log: () => {}, wayflow: false, deps }),
    ).rejects.toThrow(/"plane-mcp" would start with NO value for PLANE_API_TOKEN/);
  });

  it("--no-wayflow: a reconcile that must VALIDATE the recorded file gates it too", async () => {
    // The not-re-derivable route (round 3): the recorded file is checked against
    // the same invariant before the stack is started. A tokenless wayflow service
    // in that file is not a reason to refuse a `--no-wayflow` bring-up either.
    const tokenless = renderIsolatedComposeYaml({
      name: row.composeProject,
      services: {
        wayflow: { image: "cinatra/wayflow", environment: { PORT: "3010" } },
        ...Object.fromEntries(
          Object.entries(SIBLING_ENV_FILE_SERVICES).map(([svc]) => [
            svc,
            { image: `cinatra/${svc}`, environment: { [SIBLING_ENV_FILE_KEYS[svc].key]: SIBLING_ENV_FILE_KEYS[svc].value } },
          ]),
        ),
      },
    });
    const { deps } = setup({ preserves: false, recordedDoc: tokenless });
    const ambiguous = { ...row, offset: null, ports: {} };
    await expect(
      regenerateIsolatedCompose({ targetDir: dir, row: ambiguous, log: () => {}, deps }),
    ).rejects.toThrow(/FAILS the env-file wiring invariant[\s\S]*CINATRA_BRIDGE_TOKEN/);
    await expect(
      regenerateIsolatedCompose({ targetDir: dir, row: ambiguous, log: () => {}, wayflow: false, deps }),
    ).resolves.toMatchObject({ regenerated: false });
  });

  it("PRESERVING route, healthy: all four references survive into the generated document", async () => {
    const { deps } = setup({ preserves: true });
    expect((await regen(deps)).regenerated).toBe(true);
    const doc = parseIsolatedComposeDoc(readFileSync(path.join(dir, ISOLATED_COMPOSE_FILENAME), "utf8"));
    for (const entry of checkoutDeclaredEnvFiles(dir)) {
      expect(doc.services[entry.service].env_file.map((e) => e.path)).toContain(entry.path);
    }
  });

  // ── RECONCILE MUST NOT KNOWINGLY START THE TOKENLESS ARTIFACT (round 3) ────

  /** A generated document that IS wired correctly, at the recorded offset. */
  const healthyRecorded = () => {
    const { doc } = generateIsolatedCompose({
      resolvedConfig: fourServiceConfig()(dir, [], {}, { preserveEnvFiles: true }),
      offset: OFFSET,
      projectName: row.composeProject,
      slug: row.slug,
      appPort: row.appPort,
      envFileKeys: new Set(["CINATRA_BRIDGE_TOKEN", "CINATRA_CONTEXT_ATTEST_KEY", "NANGO_ENCRYPTION_KEY"]),
    });
    return renderIsolatedComposeYaml(doc);
  };

  /** The same document with the wayflow token route removed — the exact artifact
   *  D1 produced, and the one a reconcile used to start behind a ⚠. */
  const tokenlessRecorded = () => {
    const doc = parseIsolatedComposeDoc(healthyRecorded());
    delete doc.services.wayflow.env_file;
    return renderIsolatedComposeYaml(doc);
  };

  /** A legacy row whose recorded ports identify no single offset — a real,
   *  typed SKIP from the production code, not a stubbed one. */
  const legacyRow = { ...row, offset: null, ports: {} };

  it("SKIP + a recorded file that PASSES the invariant: proceed, and SAY it was validated", async () => {
    const { deps } = setup({ preserves: true, recordedDoc: healthyRecorded() });
    const lines = [];
    const result = await regenerateIsolatedCompose({
      targetDir: dir,
      row: legacyRow,
      log: (l) => lines.push(String(l)),
      deps,
    });
    expect(result.regenerated).toBe(false);
    expect(result.skipped).toContain("ambiguous");
    expect(lines.join("\n")).toContain("VALIDATED the recorded file");
    expect(lines.join("\n")).toContain("it PASSES");
  });

  it("SKIP + a recorded file that FAILS the invariant: REFUSE the bring-up, naming the recovery", async () => {
    const { deps } = setup({ preserves: true, recordedDoc: tokenlessRecorded() });
    const lines = [];
    await expect(
      regenerateIsolatedCompose({ targetDir: dir, row: legacyRow, log: (l) => lines.push(String(l)), deps }),
    ).rejects.toThrow(/Refusing to bring up isolated instance "row4"[\s\S]*FAILS the env-file wiring invariant/);
    // Attributable: the skip reason, the key that has no route, and the recovery.
    const err = await regenerateIsolatedCompose({ targetDir: dir, row: legacyRow, log: () => {}, deps }).catch((e) => e);
    expect(err.message).toContain("ambiguous");
    expect(err.message).toContain("CINATRA_BRIDGE_TOKEN");
    expect(err.message).toContain("cinatra instance remove row4");
    expect(err.message).toContain("--on-conflict=isolated");
    // …and it never said "bringing the stack up from the RECORDED file".
    expect(lines.join("\n")).not.toContain("Bringing the stack up");
  });

  it("SKIP + an UNPARSEABLE recorded file: REFUSE (it cannot be validated)", async () => {
    const { deps } = setup({ preserves: true, recordedDoc: "services:\n  wayflow:\n    image: busybox\n" });
    await expect(
      regenerateIsolatedCompose({ targetDir: dir, row: legacyRow, log: () => {}, deps }),
    ).rejects.toThrow(/is not a CLI-generated document, so its env-file wiring cannot be validated/);
  });

  it("SKIP on a SHIFTED BASE BAND is validated the same way", async () => {
    // The second not-re-derivable condition: regeneration would move a live
    // service's host port. The recorded file is tokenless, so the bring-up is
    // refused rather than warned about.
    const { deps } = setup({ preserves: true, recordedDoc: tokenlessRecorded() });
    const shifted = { ...row, ports: { ...row.ports, postgres: [19999] } };
    await expect(
      regenerateIsolatedCompose({ targetDir: dir, row: shifted, log: () => {}, deps }),
    ).rejects.toThrow(/base band shifted[\s\S]*FAILS the env-file wiring invariant/);
  });
});

// ---------------------------------------------------------------------------
// 6. An env file that cannot be produced fails the install — nothing marked ready.
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
// 7. END-TO-END: the real `runInstall` → `executeIsolatedInstall`, driven
//    through a real generation failure.
// ---------------------------------------------------------------------------
//
// Not a hand-built provisioning row: a real clone of a fixture origin, the real
// argument parsing, the real isolated executor, the real `bringUpInfra`, the
// real registry/marker writes and the real rollback. Only the seams that would
// touch the Docker daemon or the network are injected — and the WayFlow env
// generator is a REAL script in the checkout, so `generateWayflowEnv` runs for
// real and fails for a real reason.

describe("END-TO-END: a generation failure fails the install (cinatra#2654 D1)", () => {
  let sandbox;
  let originRepo;

  /** The checkout's own generator: derives the narrow env file from `.env.local`,
   *  exactly like the real `scripts/gen-wayflow-env.mjs`. Two env vars drive the
   *  fixture — a counter file (kept OUTSIDE the checkout, so the install's
   *  clean-worktree guard is untouched) and the invocation number at which it
   *  writes a PARTIAL file instead: a real generator defect, where it exits 0 and
   *  leaves a file with no CINATRA_CONTEXT_ATTEST_KEY. */
  const GENERATOR_SRC = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const countFile = process.env.CINATRA_TEST_WAYFLOW_CALLS;
const calls = (countFile && existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;
if (countFile) writeFileSync(countFile, String(calls));
const breakAt = Number(process.env.CINATRA_TEST_WAYFLOW_BREAK_AT ?? "0");

const env = {};
const envPath = path.join(root, ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\\n")) {
    const m = line.match(/^\\s*([A-Z0-9_]+)\\s*=\\s*(.*?)\\s*$/);
    if (m) env[m[1]] = m[2];
  }
}

mkdirSync(path.join(root, "docker", "wayflow"), { recursive: true });
const out = path.join(root, "docker", "wayflow", ".wayflow.env");
const lines = [\`CINATRA_BRIDGE_TOKEN=\${env.CINATRA_BRIDGE_TOKEN ?? ""}\`];
if (breakAt !== calls) {
  lines.push(\`CINATRA_CONTEXT_ATTEST_KEY=\${env.CINATRA_CONTEXT_ATTEST_KEY ?? ""}\`);
  lines.push("WAYFLOW_BASE_URL=http://localhost:3010/");
}
writeFileSync(out, lines.join("\\n") + "\\n", { mode: 0o600 });
process.exit(0);
`;

  function buildFixtureOrigin(root) {
    const src = path.join(root, "src");
    mkdirSync(path.join(src, "packages", "migrations"), { recursive: true });
    mkdirSync(path.join(src, "scripts"), { recursive: true });
    writeFileSync(path.join(src, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
    writeFileSync(
      path.join(src, "packages", "migrations", "package.json"),
      JSON.stringify({ name: "@cinatra-ai/migrations", version: "0.0.0" }),
    );
    writeFileSync(
      path.join(src, "package.json"),
      JSON.stringify({ name: "cinatra-host", cinatra: { devExtensions: {} } }),
    );
    writeFileSync(path.join(src, ".env.example"), "BETTER_AUTH_SECRET=\nCINATRA_RUNTIME_MODE=development\n");
    writeFileSync(path.join(src, ".gitignore"), ".env.local\nextensions/\n");
    writeFileSync(path.join(src, "scripts", "gen-wayflow-env.mjs"), GENERATOR_SRC);
    const G = (args, cwd) =>
      execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
        stdio: "ignore",
      });
    G(["init", "-b", "main"], src);
    G(["add", "-A"], src);
    G(["commit", "-m", "init"], src);
    const bare = path.join(root, "origin.git");
    G(["clone", "--bare", src, bare], root);
    return bare;
  }

  const BAND = [
    { service: "postgres", host: "127.0.0.1", port: 5434 },
    { service: "wayflow", host: "127.0.0.1", port: 3010 },
  ];

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), "x2654-e2e-"));
    originRepo = buildFixtureOrigin(sandbox);
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  let regPath;
  let callsPath;
  beforeEach(() => {
    const home = mkdtempSync(path.join(sandbox, "home-"));
    regPath = path.join(home, "instances.json");
    callsPath = path.join(home, "gen-calls");
    process.env.CINATRA_INSTANCE_REGISTRY = regPath;
    process.env.CINATRA_ALLOC_LOCK = path.join(home, "alloc.lock");
    process.env.CINATRA_TEST_WAYFLOW_CALLS = callsPath;
    delete process.env.CINATRA_TEST_WAYFLOW_BREAK_AT;
  });
  afterEach(() => {
    delete process.env.CINATRA_TEST_WAYFLOW_CALLS;
    delete process.env.CINATRA_TEST_WAYFLOW_BREAK_AT;
  });

  /** Every seam that would touch Docker or the network. `bringUpInfra` is NOT
   *  stubbed — the real one runs, so the real `generateWayflowEnv` does too. */
  const e2eDeps = (installDir, extra = {}) => ({
    runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
    commandExists: () => true,
    composeAvailable: () => true,
    composePublishedPortsForTarget: () => BAND,
    composeSupportsNoEnvResolution: () => true,
    composeConfigForFiles: (targetDir, files, d, opts) =>
      JSON.parse(
        fakeComposeConfig(installDir)("docker", [
          "compose",
          "config",
          ...(opts?.preserveEnvFiles ? ["--no-env-resolution"] : []),
        ]),
      ),
    // A stranger holds the default postgres port, so `--on-conflict=isolated`
    // actually routes the run into `executeIsolatedInstall` (an empty probe
    // would leave it on the default path and never exercise the isolated
    // executor at all).
    detectPortConflicts: async (band) =>
      band
        .filter((b) => b.port === 5434)
        .map((b) => ({ ...b, holder: "test-holder" })),
    readCloneRegistry: () => null,
    inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
    targetComposeOwnedPorts: () => new Set(),
    liveComposeInspect: () => [],
    // Inside the REAL bringUpInfra: everything after the env generation.
    assertRecreateSafe: () => {},
    ensureNangoSecretKey: () => null,
    buildWayflowImage: () => ({ ok: true, stderr: "", status: 0 }),
    runComposeDown: () => {},
    ...extra,
  });

  const clone = (name) => {
    const target = path.join(sandbox, name);
    execFileSync("git", ["clone", `file://${originRepo}`, target], { stdio: "ignore" });
    return target;
  };

  const install = (installDir, extra = {}, lines = []) =>
    runInstall(
      [
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-install",
        "--on-conflict", "isolated",
        "--instance", path.basename(installDir),
      ],
      { log: (l) => lines.push(String(l)), deps: e2eDeps(installDir, extra) },
    );

  it("a generator that cannot produce the env file fails the install BEFORE anything is recorded", async () => {
    const installDir = clone("e2e-render-fail");
    // Break the FIRST invocation — the one the isolated executor makes before it
    // resolves the compose. Nothing has been allocated at that point.
    process.env.CINATRA_TEST_WAYFLOW_BREAK_AT = "1";

    let thrown = null;
    let upCalls = 0;
    await install(installDir, { bringUpInfra: () => { upCalls += 1; } }).catch((e) => { thrown = e; });

    expect(thrown).toBeTruthy();
    // Attributable: the file, the missing key, and both recoveries.
    expect(thrown.message).toContain(".wayflow.env");
    expect(thrown.message).toContain("CINATRA_CONTEXT_ATTEST_KEY");
    expect(thrown.message).toContain("--no-wayflow");
    // (The EXIT STATUS is not asserted here — re-deriving it from the caught
    // error would only restate the mapping. It is proven for real by the
    // subprocess test below, which reads an actual `process.exit` status.)
    // Nothing started, nothing recorded, nothing generated.
    expect(upCalls).toBe(0);
    expect(readInstanceRegistry(regPath).registry.instances).toEqual({});
    expect(existsSync(path.join(installDir, ISOLATED_COMPOSE_FILENAME))).toBe(false);
    const marker = readMarker(installDir);
    expect(marker.status === "ok" ? marker.marker?.state : null).not.toBe("ready");
  });

  it("a generation failure at BRING-UP time rolls the pending instance back — no ready marker", async () => {
    const installDir = clone("e2e-bringup-fail");
    // The render-time invocation succeeds; the bring-up's (second) one writes a
    // partial file. So the install gets as far as a PROVISIONING row + a written
    // generated compose, and then must roll all of it back.
    process.env.CINATRA_TEST_WAYFLOW_BREAK_AT = "2";

    let thrown = null;
    const lines = [];
    await install(installDir, {}, lines).catch((e) => { thrown = e; });

    expect(thrown).toBeTruthy();
    expect(thrown.message).toContain("Refusing to start the WayFlow agent runtime");
    // The install got far enough to record a PROVISIONING row and write the
    // generated compose — proven by the rollback it then ran on them.
    expect(lines.join("\n")).toContain("rolling back the pending instance");
    expect(thrown.message).toContain("CINATRA_CONTEXT_ATTEST_KEY");

    // The generator really did run twice (render-time, then bring-up).
    expect(Number(readFileSync(callsPath, "utf8"))).toBe(2);

    // ROLLBACK RAN: the registry row is gone (not merely left provisioning) and
    // the generated compose it created was removed.
    expect(readInstanceRegistry(regPath).registry.instances).toEqual({});
    expect(existsSync(path.join(installDir, ISOLATED_COMPOSE_FILENAME))).toBe(false);

    // NO READY MARKER — the exact "exited 0 and recorded [ready]" lie D1 was.
    const marker = readMarker(installDir);
    expect(marker.status === "ok" ? marker.marker?.state : null).not.toBe("ready");
  });

  // ── REAL EXIT-CODE PROOF (cinatra#2654 D1, round 3) ──────────────────────
  //
  // The tests above run `runInstall` IN PROCESS and can only observe a thrown
  // error; the exit STATUS an operator's shell sees is `bin/cinatra.mjs`'s doing.
  // Reading that mapping out of the source with a regex is not a proof — it
  // cannot tell whether the error reaches the mapping at all. So this runs the
  // real binary as a SUBPROCESS and reads its actual status.
  //
  // `bin/cinatra.mjs` calls `runInstall(rest)` with no `deps`, so the Docker /
  // network seams are supplied through the TEST-ONLY injection seam
  // (`CINATRA_TEST_INSTALL_DEPS`, added for exactly this and named as such). The
  // FAILURE itself is not injected through it: it comes from the fixture
  // checkout's own `scripts/gen-wayflow-env.mjs`, which writes a partial file on
  // its Nth invocation — a real generator defect, in the real generator, reached
  // by the real bring-up.
  const DEPS_MODULE_SRC = `
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const installDir = process.env.CINATRA_TEST_E2E_INSTALL_DIR;
const BAND = [
  { service: "postgres", host: "127.0.0.1", port: 5434 },
  { service: "wayflow", host: "127.0.0.1", port: 3010 },
];

function parseEnvFile(body) {
  const out = {};
  for (const line of String(body).split("\\n")) {
    const m = line.match(/^\\s*([A-Z0-9_]+)\\s*=\\s*(.*?)\\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** The checkout's compose as \`config\` renders it, with the same env-file
 *  resolution behaviour the real engine has. */
function composeConfig(preserveEnvFiles) {
  const envFile = path.join(installDir, "docker", "wayflow", ".wayflow.env");
  const doc = {
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
        build: { context: path.join(installDir, "docker", "wayflow") },
        profiles: ["wayflow"],
        environment: {
          PORT: "3010",
          CINATRA_AGENTS_DIR: "/agents",
          CINATRA_BASE_URL: "http://host.docker.internal:3000",
        },
        env_file: [{ path: envFile, required: false }],
        ports: [{ mode: "ingress", target: 3010, published: "3010", protocol: "tcp", host_ip: "127.0.0.1" }],
      },
    },
  };
  if (!preserveEnvFiles) {
    for (const svc of Object.values(doc.services)) {
      for (const entry of Array.isArray(svc.env_file) ? svc.env_file : []) {
        const f = typeof entry === "string" ? entry : entry?.path;
        const fromFile = f && existsSync(f) ? parseEnvFile(readFileSync(f, "utf8")) : {};
        svc.environment = { ...fromFile, ...(svc.environment ?? {}) };
      }
      delete svc.env_file;
    }
  }
  return doc;
}

export default () => ({
  runPreflight: () => ({ ok: true, failures: [], warnings: [], mode: "dev", infraWillStart: true }),
  commandExists: () => true,
  composeAvailable: () => true,
  composePublishedPortsForTarget: () => BAND,
  composeSupportsNoEnvResolution: () => true,
  composeConfigForFiles: (targetDir, files, d, opts) => composeConfig(!!opts?.preserveEnvFiles),
  detectPortConflicts: async (band) =>
    band.filter((b) => b.port === 5434).map((b) => ({ ...b, holder: "test-holder" })),
  readCloneRegistry: () => null,
  inspectProjectOwnership: () => ({ containerRows: [], volumeRows: [] }),
  targetComposeOwnedPorts: () => new Set(),
  liveComposeInspect: () => [],
  assertRecreateSafe: () => {},
  ensureNangoSecretKey: () => null,
  buildWayflowImage: () => ({ ok: true, stderr: "", status: 0 }),
  runComposeDown: () => {},
});
`;

  it("REAL EXIT CODE: `bin/cinatra.mjs` exits NON-ZERO, rolls back, and leaves no ready marker", () => {
    const installDir = clone("e2e-subprocess");
    const depsModule = path.join(sandbox, "e2e-deps.mjs");
    writeFileSync(depsModule, DEPS_MODULE_SRC);

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url)),
        "install",
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-install",
        "--on-conflict", "isolated",
        "--instance", "e2e-subprocess",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CINATRA_INSTANCE_REGISTRY: regPath,
          CINATRA_ALLOC_LOCK: path.join(path.dirname(regPath), "alloc.lock"),
          CINATRA_TEST_WAYFLOW_CALLS: callsPath,
          // The render-time generation succeeds; the bring-up's (second) one
          // writes a partial file. So the run reaches a PROVISIONING row and a
          // written generated compose, and must then roll all of it back.
          CINATRA_TEST_WAYFLOW_BREAK_AT: "2",
          CINATRA_TEST_INSTALL_DEPS: depsModule,
          CINATRA_TEST_E2E_INSTALL_DIR: installDir,
        },
      },
    );

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // A REAL non-zero exit status, from a real `process.exit` — not a signal,
    // and not a mapping re-derived from a caught error.
    expect(result.signal).toBe(null);
    expect(result.status).toBeTypeOf("number");
    expect(result.status).not.toBe(0);
    // …for THIS failure, attributably.
    expect(output).toContain("Refusing to start the WayFlow agent runtime");
    expect(output).toContain("CINATRA_CONTEXT_ATTEST_KEY");
    // THE ROLLBACK RAN.
    expect(output).toContain("rolling back the pending instance");
    expect(readInstanceRegistry(regPath).registry.instances).toEqual({});
    expect(existsSync(path.join(installDir, ISOLATED_COMPOSE_FILENAME))).toBe(false);
    // NO READY MARKER — the exact "exited 0 and recorded [ready]" lie D1 was.
    const marker = readMarker(installDir);
    expect(marker.status === "ok" ? marker.marker?.state : null).not.toBe("ready");
    // The generator really did run twice (render-time, then bring-up).
    expect(Number(readFileSync(callsPath, "utf8"))).toBe(2);
  });

  it("REAL EXIT CODE, control: the same subprocess exits 0 when the generator is whole", () => {
    // Proves the non-zero status above is caused by the generation failure and
    // not by the harness — same binary, same seams, same fixture, one env var
    // different. The bring-up's `docker compose up` is the only thing stubbed.
    const installDir = clone("e2e-subprocess-ok");
    const depsModule = path.join(sandbox, "e2e-deps-ok.mjs");
    writeFileSync(
      depsModule,
      DEPS_MODULE_SRC.replace("export default () => ({", "export default () => ({\n  bringUpInfra: () => {},"),
    );

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../bin/cinatra.mjs", import.meta.url)),
        "install",
        "--dir", installDir,
        "--repo-url", `file://${originRepo}`,
        "--ref", "main",
        "--yes", "--no-install",
        "--on-conflict", "isolated",
        "--instance", "e2e-subprocess-ok",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CINATRA_INSTANCE_REGISTRY: regPath,
          CINATRA_ALLOC_LOCK: path.join(path.dirname(regPath), "alloc.lock"),
          CINATRA_TEST_WAYFLOW_CALLS: callsPath,
          CINATRA_TEST_INSTALL_DEPS: depsModule,
          CINATRA_TEST_E2E_INSTALL_DIR: installDir,
        },
      },
    );

    expect(`status=${result.status} ${result.stderr ?? ""}`).toBe("status=0 ");
    expect(readInstanceRegistry(regPath).registry.instances["e2e-subprocess-ok"].state).toBe("ready");
  });

  it("CONTROL: the same install SUCCEEDS when the generator writes the full key set", async () => {
    const installDir = clone("e2e-ok");
    // The bring-up is stubbed here (it would `docker compose up` a real stack);
    // the render-time generation, the invariant, the compose write, the registry
    // row and the ready marker are all the real ones.
    const res = await install(installDir, { bringUpInfra: () => {} });
    expect(res.infraPlan).toBe("isolated");
    const rows = readInstanceRegistry(regPath).registry.instances;
    expect(rows["e2e-ok"].state).toBe("ready");
    // The generated compose REFERENCES the env file the generator wrote.
    const doc = parseIsolatedComposeDoc(
      readFileSync(path.join(installDir, ISOLATED_COMPOSE_FILENAME), "utf8"),
    );
    expect(doc.services.wayflow.env_file[0].path).toBe(path.join(installDir, WAYFLOW_ENV_REL));
    expect(
      composeEnvWiringGaps(doc, {
        wayflowEnvFilePath: path.join(installDir, WAYFLOW_ENV_REL),
        baseDir: installDir,
      }),
    ).toEqual([]);
    // …and never persists the token it carries.
    const token = parseEnvFile(readFileSync(path.join(installDir, WAYFLOW_ENV_REL), "utf8")).CINATRA_BRIDGE_TOKEN;
    expect(token).toBeTruthy();
    expect(readFileSync(path.join(installDir, ISOLATED_COMPOSE_FILENAME), "utf8")).not.toContain(token);
  });

});

// ---------------------------------------------------------------------------
// 8. The same claim against the REAL `docker compose`, render-only.
// ---------------------------------------------------------------------------
//
// Render-only: `docker compose config` on a fixture with no published ports and
// no `up`. Nothing is started, nothing binds a host port.

/** Ask a REAL compose binary the two questions this suite needs: which version
 *  it is, and whether `config --no-env-resolution` actually PRESERVES an
 *  `env_file:` reference (not merely whether the flag is spelled in --help —
 *  2.38.2 accepts the flag and inlines anyway). `bin` is the `docker` wrapper
 *  by default; CINATRA_TEST_COMPOSE_BIN points at a standalone compose binary so
 *  a second version can be exercised on the same box. */
function probeRealCompose(bin = null) {
  const run = (args, opts = {}) =>
    bin
      ? execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })
      : execFileSync("docker", ["compose", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  try {
    const version = run(["version", "--short"]).trim();
    const probeDir = mkdtempSync(path.join(os.tmpdir(), "x2654-cprobe-"));
    try {
      writeFileSync(path.join(probeDir, ".p.env"), "P=1\n");
      writeFileSync(
        path.join(probeDir, "docker-compose.yml"),
        JSON.stringify({ services: { p: { image: "busybox", env_file: [{ path: "./.p.env", required: false }] } } }),
      );
      const out = run(["-f", "docker-compose.yml", "config", "--no-env-resolution", "--format", "json"], {
        cwd: probeDir,
      });
      const svc = JSON.parse(out)?.services?.p;
      const preserves = Array.isArray(svc?.env_file) ? svc.env_file.length > 0 : Boolean(svc?.env_file);
      return { available: true, version, preserves, bin };
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  } catch {
    return { available: false, version: null, preserves: false, bin };
  }
}

const realCompose = probeRealCompose();

// A SECOND compose binary, opt-in via CINATRA_TEST_COMPOSE_BIN — how the other
// route is exercised against a real engine on a box that ships only one Compose.
const altComposeBin = process.env.CINATRA_TEST_COMPOSE_BIN ?? null;
const altCompose = altComposeBin ? probeRealCompose(altComposeBin) : { available: false, version: null, preserves: false, bin: null };

// Record, in the run's own output, WHICH Compose this suite exercised — so
// "verified against the real compose" is a fact anyone can read off the log
// rather than a claim. Runs unconditionally, so a SKIPPED real-compose section
// is visible for what it is instead of silently absent.
describe("which Compose this suite exercised (cinatra#2654 D1)", () => {
  it("reports the real `docker compose` it found, or that it found none", () => {
    console.log(
      `[cinatra#2654 D1] real docker compose: available=${realCompose.available} ` +
        `version=${realCompose.version ?? "n/a"} preserves-env_file=${realCompose.preserves}`,
    );
    if (altComposeBin) {
      console.log(
        `[cinatra#2654 D1] alt compose (${altComposeBin}): available=${altCompose.available} ` +
          `version=${altCompose.version ?? "n/a"} preserves-env_file=${altCompose.preserves}`,
      );
    }
    expect(typeof realCompose.preserves).toBe("boolean");
    // An absent Compose can never claim the behaviour.
    if (!realCompose.available) expect(realCompose.preserves).toBe(false);
  });
});

/** The whole real-compose claim, run against ONE compose binary. Render-only:
 *  `config` on a fixture with no published ports and no `up` — nothing is
 *  started, nothing binds a host port.
 *
 *  Round 3 fixed the ASSERTION rather than the branch structure. A test that
 *  simply reds whenever the engine inlines would red CI forever (ubuntu-latest
 *  ships 2.38.2, which inlines). The dangerous case is not "this engine
 *  inlines" — it is the CLI believing something different from what the engine
 *  does, because that is what makes it write a frozen file while reporting a
 *  referenced one. So:
 *
 *    (a) the PROBE'S VERDICT is compared against this engine's actually observed
 *        rendering of THIS fixture. Either direction of mismatch FAILS.
 *    (b) on the fallback route the generated document is asserted to carry the
 *        FULL token route — every key every one of the four env files supplies —
 *        not merely that the fallback branch ran.
 *    (c) the fixture carries all FOUR of the checkout's narrow-env-file services.
 */
function realComposeSuite(engine) {
  const run = (args, opts = {}) =>
    engine.bin
      ? execFileSync(engine.bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })
      : execFileSync("docker", ["compose", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  const capture = (command, args, opts) =>
    engine.bin
      ? execFileSync(engine.bin, args.slice(1), { cwd: opts?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      : execFileSync(command, args, { cwd: opts?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // The keys `.env.local` supplies, so the generator may re-symbolise them. The
  // graphiti/plane secrets are deliberately NOT here — the checkout's own
  // compose says the OpenAI key lives in the app DATABASE and the Plane PAT is
  // minted by the provision script, so neither is on the scrub allowlist.
  const SCRUBBABLE = new Set(["CINATRA_BRIDGE_TOKEN", "CINATRA_CONTEXT_ATTEST_KEY", "NANGO_ENCRYPTION_KEY"]);
  const ENV_LOCAL_TOKEN = "envlocal-bridge-token";
  const ENV_LOCAL_ATTEST = "envlocal-attest-key";

  /** service → its narrow env file, as the checkout declares them. */
  const FOUR = { wayflow: WAYFLOW_ENV_REL, ...SIBLING_ENV_FILE_SERVICES };

  const writeFixtureCheckout = () => {
    const yaml = ["services:"];
    yaml.push(
      "  wayflow:",
      "    image: busybox",
      "    env_file:",
      `      - path: ./${WAYFLOW_ENV_REL.split(path.sep).join("/")}`,
      "        required: false",
      "    environment:",
      '      PORT: "3010"',
      '      CINATRA_AGENTS_DIR: "/agents"',
      '      CINATRA_BASE_URL: "http://host.docker.internal:3000"',
      "    profiles:",
      "      - wayflow",
    );
    for (const [svc, rel] of Object.entries(SIBLING_ENV_FILE_SERVICES)) {
      yaml.push(
        `  ${svc}:`,
        "    image: busybox",
        "    env_file:",
        `      - path: ./${rel}`,
        "        required: false",
        "    environment:",
        `      SERVICE_NAME: "${svc}"`,
      );
    }
    yaml.push("");
    writeFileSync(path.join(dir, "docker-compose.yml"), yaml.join("\n"));
    // What `ensureEnvLocal` minted; the isolated `up` reads it as --env-file.
    writeFileSync(
      path.join(dir, ".env.local"),
      [
        `CINATRA_BRIDGE_TOKEN=${ENV_LOCAL_TOKEN}`,
        `CINATRA_CONTEXT_ATTEST_KEY=${ENV_LOCAL_ATTEST}`,
        `NANGO_ENCRYPTION_KEY=${SIBLING_ENV_FILE_KEYS["nango-server"].value}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // What the four generators derive, before the render.
    writeWayflowEnvFile(dir, { token: ENV_LOCAL_TOKEN, attest: ENV_LOCAL_ATTEST });
    writeSiblingEnvFiles(dir);
  };

  /** What this engine ACTUALLY does to the fixture when asked to preserve
   *  references — per service, so a PARTIAL preservation is visible too. */
  const observePreservation = () => {
    const forced = composeConfigForFiles(dir, ["docker-compose.yml"], { capture }, {
      allProfiles: true,
      preserveEnvFiles: true,
    });
    // A render that FAILS (an engine that rejects the unknown flag) preserves
    // nothing — the same verdict the CLI's probe reaches by the same route.
    if (!forced) return Object.fromEntries(Object.keys(FOUR).map((svc) => [svc, false]));
    return Object.fromEntries(
      Object.keys(FOUR).map((svc) => {
        const raw = forced.services?.[svc]?.env_file;
        return [svc, Array.isArray(raw) ? raw.length > 0 : Boolean(raw)];
      }),
    );
  };

  const render = () => {
    const resolved = composeConfigForFiles(dir, ["docker-compose.yml"], { capture }, {
      allProfiles: true,
      preserveEnvFiles: engine.preserves,
    });
    const { doc } = generateIsolatedCompose({
      resolvedConfig: resolved,
      offset: 10000,
      projectName: "cinatra_row1",
      slug: "row1",
      appPort: 3300,
      envFileKeys: SCRUBBABLE,
    });
    return { doc, resolved };
  };

  /** The keys each of the four env files supplies, and the value it supplies. */
  const expectedWiring = () => {
    const out = {};
    for (const [svc, rel] of Object.entries(FOUR)) {
      out[svc] = parseEnvFile(readFileSync(path.join(dir, rel), "utf8"));
    }
    return out;
  };

  it(`(${engine.version}) THE PROBE'S VERDICT MATCHES what this engine does to the fixture`, () => {
    // The dangerous case, in BOTH directions: the CLI believing the reference
    // survives when the render inlines (it writes a frozen file and reports a
    // referenced one — the D1 defect, reached through the flag meant to prevent
    // it), or believing it inlines when the render preserves (it takes a
    // degraded route for no reason). Either FAILS here, loudly, by name.
    writeFixtureCheckout();
    const observed = observePreservation();
    const disagree = Object.entries(observed).filter(([, kept]) => kept !== engine.preserves);
    expect(
      disagree.length === 0
        ? "probe and render agree"
        : `probe says preserves=${engine.preserves}, but this engine rendered ` +
          disagree.map(([svc, kept]) => `${svc}: env_file ${kept ? "PRESERVED" : "INLINED"}`).join(", "),
    ).toBe("probe and render agree");
  });

  it(`(${engine.version}) a first-install render carries the FULL token route for all four services`, () => {
    writeFixtureCheckout();
    const { doc, resolved } = render();
    const wiring = expectedWiring();

    // STRICT: the route this engine actually takes is the one asserted.
    expect(
      composeEnvWiringGaps(doc, {
        sourceDoc: resolved,
        wayflowEnvFilePath: path.join(dir, WAYFLOW_ENV_REL),
        envFilesPreserved: engine.preserves,
        envFileKeysAt: (abs) => envFileSuppliedKeys(abs),
        declaredEnvFiles: checkoutDeclaredEnvFiles(dir),
        baseDir: dir,
      }),
    ).toEqual([]);

    if (engine.preserves) {
      for (const [svc, rel] of Object.entries(FOUR)) {
        // SAME FILE, not same string (cinatra#2654 D1, round 4): `compose config`
        // emits REALPATHS, while the expected path keeps the caller's `dir`
        // spelling — under a symlinked install directory (a symlinked TMPDIR is
        // enough) those differ. Compared here through `realpathSync` DIRECTLY,
        // not through the module's own canonicaliser, so this stays an
        // independent check of the same property `composeEnvWiringGaps` asserts.
        const want = realpathSync(path.join(dir, rel));
        expect(doc.services[svc].env_file.map((e) => realpathSync(e.path))).toContain(want);
      }
      expect(doc.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBeUndefined();
    } else {
      // FALLBACK: the reference is gone (this engine inlined it), so the
      // generated document itself has to carry the whole route — every key of
      // every one of the four files, with a NON-EMPTY value. Not "the branch
      // ran": the actual wiring.
      for (const [svc, supplied] of Object.entries(wiring)) {
        for (const key of Object.keys(supplied)) {
          const value = doc.services[svc].environment?.[key];
          expect(`${svc}.${key}=${value ?? "<missing>"}`).toBe(
            `${svc}.${key}=${SCRUBBABLE.has(key) ? `\${${key}}` : supplied[key]}`,
          );
        }
      }
    }

    // On BOTH routes: no key `.env.local` supplies is persisted in the file.
    const file = path.join(dir, ISOLATED_COMPOSE_FILENAME);
    writeIsolatedComposeFile(file, doc);
    const body = readFileSync(file, "utf8");
    expect(body).not.toContain(ENV_LOCAL_TOKEN);
    expect(body).not.toContain(ENV_LOCAL_ATTEST);
    expect(body).not.toContain(SIBLING_ENV_FILE_KEYS["nango-server"].value);
    // …and it declares its own ownership.
    expect(body.startsWith("# GENERATED FILE — DO NOT EDIT.")).toBe(true);

    // Ask compose itself what the isolated `up` would give each container —
    // which also proves the comment header is valid compose YAML.
    const rendered = JSON.parse(
      run(
        ["--env-file", ".env.local", "--profile", "*", "-f", ISOLATED_COMPOSE_FILENAME, "config", "--format", "json"],
        { cwd: dir },
      ),
    );
    for (const [svc, supplied] of Object.entries(wiring)) {
      for (const [key, value] of Object.entries(supplied)) {
        expect(`${svc}.${key}=${rendered.services[svc].environment?.[key]}`).toBe(`${svc}.${key}=${value}`);
      }
    }
    expect(Object.keys(rendered.services.wayflow.environment).sort()).toEqual([...SIX_KEYS].sort());
  });

  it(`(${engine.version}) a rotated token still reaches the container`, () => {
    writeFixtureCheckout();
    const { doc } = render();
    writeIsolatedComposeFile(path.join(dir, ISOLATED_COMPOSE_FILENAME), doc);

    // Rotation, as the CLI performs it: the new value goes into `.env.local`,
    // and the bring-up regenerates `.wayflow.env` from it. Both routes must
    // follow it — the preserved reference reads the file at `up` time, the
    // fallback's `${KEY}` resolves from `--env-file .env.local`.
    const rotated = "rotated-bridge-token";
    writeFileSync(
      path.join(dir, ".env.local"),
      `CINATRA_BRIDGE_TOKEN=${rotated}\nCINATRA_CONTEXT_ATTEST_KEY=${ENV_LOCAL_ATTEST}\n` +
        `NANGO_ENCRYPTION_KEY=${SIBLING_ENV_FILE_KEYS["nango-server"].value}\n`,
      { mode: 0o600 },
    );
    writeWayflowEnvFile(dir, { token: rotated, attest: ENV_LOCAL_ATTEST });

    const rendered = JSON.parse(
      run(
        ["--env-file", ".env.local", "--profile", "*", "-f", ISOLATED_COMPOSE_FILENAME, "config", "--format", "json"],
        { cwd: dir },
      ),
    );
    expect(rendered.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe(rotated);
  });

  it(`(${engine.version}) PRECEDENCE, asked of compose itself: an empty \`environment:\` value beats the env_file`, () => {
    // The premise the invariant is built on, verified against the real engine
    // rather than taken from a comment.
    writeWayflowEnvFile(dir);
    writeFileSync(
      path.join(dir, "docker-compose.yml"),
      [
        "services:",
        "  wayflow:",
        "    image: busybox",
        "    env_file:",
        `      - path: ./${WAYFLOW_ENV_REL.split(path.sep).join("/")}`,
        "        required: false",
        "    environment:",
        '      CINATRA_BRIDGE_TOKEN: ""',
        "",
      ].join("\n"),
    );
    const rendered = JSON.parse(run(["-f", "docker-compose.yml", "config", "--format", "json"], { cwd: dir }));
    expect(rendered.services.wayflow.environment.CINATRA_BRIDGE_TOKEN).toBe("");
  });

  it(`(${engine.version}) the CLI's own probe agrees with what this engine does`, () => {
    // Only meaningful for the DEFAULT `docker compose` — the CLI probes that one.
    if (engine.bin) return;
    writeFixtureCheckout();
    __resetComposeFeatureProbe();
    const cliVerdict = composeSupportsNoEnvResolution({});
    __resetComposeFeatureProbe();
    // The CLI's throwaway probe, the suite's own probe, and this engine's
    // rendering of the four-service fixture must all say the same thing.
    expect(cliVerdict).toBe(engine.preserves);
    expect(new Set(Object.values(observePreservation()))).toEqual(new Set([cliVerdict]));
  });
}

describe.skipIf(!realCompose.available)("real `docker compose config` (render only, no services)", () => {
  realComposeSuite(realCompose);
});

// Opt-in second engine (CINATRA_TEST_COMPOSE_BIN=<path to a compose binary>):
// how the OTHER route is exercised against a real engine on a box that ships
// only one Compose.
describe.skipIf(!altCompose.available)("real alternate `docker compose` (render only, no services)", () => {
  realComposeSuite(altCompose);
});
