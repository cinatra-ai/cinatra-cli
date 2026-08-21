// cinatra-cli#230 — `cinatra doctor` must resolve the Docker compose project
// from the INSTANCE REGISTRY RECORD for the install it is diagnosing, and treat
// the checkout directory basename as a fallback only.
//
// The defect this file pins: on an isolated install recorded as
// `cinatra_x2654_row1` in a checkout directory named `row1-dev`, doctor
// inspected the nonexistent project `row1-dev` and reported `FAIL — no running
// wayflow container` against a runtime that was demonstrably up and answering
// `/.health` (cinatra#2654, row 7).
//
// cinatra-cli#227 added `resolveRecordedComposeContext` for exactly this, but
// wired it to `findInstanceByInstallDir`, which returns the `{ slug, slot }`
// ENVELOPE rather than the row. `envelope.composeProject` is `undefined`, so
// every recorded install silently fell back to the basename. #227's tests never
// caught it because each one injected its OWN `findByInstallDir` stub returning
// a FLAT row; the production finder was never on the path under test.
//
// So these tests deliberately use NO finder stub. They write a real registry
// file with the real registry module, point `CINATRA_INSTANCE_REGISTRY` at it,
// and let the production wiring resolve. Docker and fetch are injected fakes —
// no containers, no services, no network.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  allocateInstance,
  findInstanceByInstallDir,
  markInstanceReady,
  writeInstanceRegistry,
} from "../src/instance-registry.mjs";
import { resolveRecordedComposeContext } from "../src/wayflow-runtime.mjs";
import {
  doctorAssertWayflowReadiness,
  effectiveComposeProjectName,
  gatherDoctorReport,
  wayflowComposeContext,
  LLM_MCP_SETTINGS_KEY,
  MCP_SETTINGS_KEY,
} from "../src/index.mjs";

// The evidence case, verbatim: recorded project ≠ checkout basename.
const SLUG = "x2654-row1";
const RECORDED_PROJECT = "cinatra_x2654_row1";
const CHECKOUT_BASENAME = "row1-dev";
const RECORDED_FILES = [
  "docker-compose.yml",
  "docker-compose.dev.yml",
  "docker-compose.cinatra-isolated.yml",
];

let tmp;
let installDir;
let registryPath;
let savedRegistryEnv;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cli230-"));
  installDir = path.join(tmp, CHECKOUT_BASENAME);
  mkdirSync(installDir, { recursive: true });
  registryPath = path.join(tmp, "instances.json");
  savedRegistryEnv = process.env.CINATRA_INSTANCE_REGISTRY;
  process.env.CINATRA_INSTANCE_REGISTRY = registryPath;
});

afterEach(() => {
  if (savedRegistryEnv === undefined) delete process.env.CINATRA_INSTANCE_REGISTRY;
  else process.env.CINATRA_INSTANCE_REGISTRY = savedRegistryEnv;
  rmSync(tmp, { recursive: true, force: true });
});

/** Record a real, structurally valid `ready` instance row for `installDir`. */
function recordInstance({ slug = SLUG, composeProject = RECORDED_PROJECT, dir = null } = {}) {
  const { registry } = allocateInstance({ version: 1, instances: {} }, slug, {
    mode: "dev",
    installDir: dir ?? installDir,
    composeProject,
    composeFiles: RECORDED_FILES,
    ports: { postgres: [15434], redis: [16379] },
    appPort: 13300,
    repoUrl: "https://github.com/cinatra-ai/cinatra.git",
    ref: "main",
    sha: "1b820b7c22c18f4b79da89e033fbbceca841db7a",
    infraMode: "new",
  });
  const ready = markInstanceReady(registry, slug);
  writeInstanceRegistry(registryPath, ready);
  return ready;
}

/**
 * A docker stub that reports a running wayflow container for exactly ONE
 * compose project. Anything addressed at another project comes back empty —
 * which is what a mis-resolved project really looks like against a live daemon.
 */
function dockerWithWayflowIn(project) {
  return function dockerImpl(args) {
    if (args[0] !== "ps") return { status: -1, stdout: "" };
    const filters = Object.fromEntries(
      args
        .filter((a) => typeof a === "string" && a.startsWith("label=com.docker.compose."))
        .map((a) => a.replace("label=", "").split("=")),
    );
    const wantProject = filters["com.docker.compose.project"];
    const wantService = filters["com.docker.compose.service"];
    if (wantProject === project && wantService === "wayflow") {
      return { status: 0, stdout: `${project}-wayflow-1\n` };
    }
    return { status: 0, stdout: "" };
  };
}

/**
 * The healthy runtime from the row-7 evidence: HTTP 200, status ok.
 * `agents` mirrors what the loader's `/.health` reports mounted — cinatra-cli#233's
 * availability check compares this against the agent sources found on disk, so a
 * fixture claiming a healthy runtime must report as many agents as it provisions.
 * An agent-route probe (`/agents/<vendor>/<slug>/`) is allowed through the
 * `expectedUrl` restriction too, since #233 probes those routes as part of the
 * same readiness check.
 */
function healthyFetch(expectedUrl = null, agents = 0) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (expectedUrl && String(url) !== expectedUrl && !String(url).includes("/agents/")) {
      throw new Error("ECONNREFUSED");
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "ok", agents, failed: 0, failed_agents: [], last_reload_at: null };
      },
    };
  };
  fetchImpl.seen = seen;
  return fetchImpl;
}

/**
 * Provision one agent source on disk the way cinatra-cli#233's own tests do
 * (`discoverAgentSources` / `wayflow-agent-mount.test.mjs`'s `makeCheckout`):
 * `extensions/<vendor>/<slug>/cinatra/oas.json`. A fixture asserting a PASS
 * readiness verdict must satisfy both features' contracts — a healthy runtime
 * (#234) AND agent sources actually present and mounted (#233) — rather than
 * the pre-#233 contract of health alone.
 */
function provisionAgentSource(dir, label = "acme/demo-agent") {
  const [vendor, slug] = label.split("/");
  mkdirSync(path.join(dir, "extensions", vendor, slug, "cinatra"), { recursive: true });
  writeFileSync(path.join(dir, "extensions", vendor, slug, "cinatra", "oas.json"), "{}");
  return label;
}

const REFUSING_FETCH = async () => {
  throw new Error("ECONNREFUSED");
};

// ===========================================================================
// The defect itself, through the real registry file and the real finder.
// ===========================================================================
describe("doctor wayflow readiness — the compose project comes from the registry record", () => {
  it("a healthy runtime under the RECORDED project is a PASS, not the basename false negative", async () => {
    recordInstance();
    provisionAgentSource(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(null, 1),
      dockerImpl: dockerWithWayflowIn(RECORDED_PROJECT),
      repoRoot: installDir,
      env: { WAYFLOW_BASE_URL: "http://localhost:13010/" },
    });
    expect(a.verdict).toBe("pass");
    expect(a.detail).toMatch(/ok/);
  });

  it("never addresses the checkout basename when a record exists", async () => {
    recordInstance();
    const seen = [];
    const dockerImpl = (args) => {
      seen.push(args);
      return { status: 0, stdout: "" };
    };
    await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl,
      repoRoot: installDir,
      env: {},
    });
    const projectFilters = seen
      .flat()
      .filter((a) => typeof a === "string" && a.startsWith("label=com.docker.compose.project="));
    expect(projectFilters).toContain(`label=com.docker.compose.project=${RECORDED_PROJECT}`);
    expect(projectFilters).not.toContain(`label=com.docker.compose.project=${CHECKOUT_BASENAME}`);
  });

  it("a container under the BASENAME project is NOT this instance's runtime → FAIL naming the recorded project", async () => {
    recordInstance();
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn(CHECKOUT_BASENAME),
      repoRoot: installDir,
      env: {},
    });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain(`compose project "${RECORDED_PROJECT}"`);
    expect(a.detail).not.toContain(`"${CHECKOUT_BASENAME}"`);
  });

  it("the FAIL verdict says the project came from the registry, and names the instance", async () => {
    recordInstance();
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("something-else"),
      repoRoot: installDir,
      env: {},
    });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain("recorded in the instance registry");
    expect(a.detail).toContain(`instance "${SLUG}"`);
  });

  it("resolves THIS checkout's row — another instance's record is not borrowed", async () => {
    // A registry that holds a row for a DIFFERENT directory must not resolve
    // this checkout onto that instance's project.
    const otherDir = path.join(tmp, "other-checkout");
    mkdirSync(otherDir, { recursive: true });
    recordInstance({ slug: "someone-else", composeProject: "cinatra_someone_else", dir: otherDir });
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("cinatra_someone_else"),
      repoRoot: installDir,
      env: {},
    });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain(`compose project "${effectiveComposeProjectName(installDir)}"`);
    expect(a.detail).not.toContain("cinatra_someone_else");
  });
});

// ===========================================================================
// The fallback, pinned: the basename is still correct when nothing is recorded.
// ===========================================================================
describe("doctor wayflow readiness — the basename fallback", () => {
  it("no registry record → the basename-derived project, and the verdict says so", async () => {
    // No registry file written at all.
    const basenameProject = effectiveComposeProjectName(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("anything-else"),
      repoRoot: installDir,
      env: {},
    });
    expect(a.verdict).toBe("fail");
    expect(a.detail).toContain(`compose project "${basenameProject}"`);
    expect(a.detail).toContain("derived from the checkout directory name");
    expect(a.detail).toContain("no instance registry record for this checkout");
  });

  it("no registry record + a container under the basename project → PASS (unchanged behaviour)", async () => {
    const basenameProject = effectiveComposeProjectName(installDir);
    provisionAgentSource(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(null, 1),
      dockerImpl: dockerWithWayflowIn(basenameProject),
      repoRoot: installDir,
      // The docker stub here (unlike doctor-step5's `makeDocker`) does not answer
      // `port`, so the endpoint must come from the record the way #233 requires —
      // an explicit WAYFLOW_BASE_URL, never a hardcoded default.
      env: { WAYFLOW_BASE_URL: "http://localhost:13010/" },
    });
    expect(a.verdict).toBe("pass");
  });
});

// ===========================================================================
// cinatra-cli#230 review, item 3 — an UNREADABLE registry is not "no record".
// ===========================================================================
//
// Both states fall back to the basename, but they are different CLAIMS:
//
//   no record          — the registry was read; this checkout is unmanaged, so
//                        the basename IS its project. A verdict about the
//                        container found there is authoritative.
//   registry unreadable— whether a record exists is UNKNOWN. The basename is a
//                        guess. A container found under it may belong to a
//                        different instance entirely, and one absent proves
//                        nothing about this instance's runtime.
//
// The note previously said "no instance registry record for this checkout" for
// both, and the unreadable case could PASS on whatever happened to be running
// under the basename — a silent, confident wrong answer of exactly the kind
// #230 is about, pointing the other way.
describe("doctor wayflow readiness — an unreadable registry is not a silent PASS", () => {
  /** Registry file present but unparseable — `readInstanceRegistry` → malformed. */
  function writeUnreadableRegistry() {
    writeFileSync(registryPath, "{ not json at all", "utf8");
  }

  it("does not PASS on a container found under the guessed basename project", async () => {
    writeUnreadableRegistry();
    const basenameProject = effectiveComposeProjectName(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(),
      dockerImpl: dockerWithWayflowIn(basenameProject),
      repoRoot: installDir,
      env: {},
    });
    // The container may be another instance's — doctor cannot tell, so it must
    // not bless it. SKIP is explicitly "NOT a pass" in the report footer.
    expect(a.verdict).not.toBe("pass");
    expect(a.verdict).toBe("skip");
    expect(a.detail).toContain("does NOT establish that it belongs to this instance");
    expect(a.detail).toContain(`"${basenameProject}-wayflow-1"`); // names what it found
    expect(a.remediation).toMatch(/registry/i);
    // The reason is stated ONCE — the note is embedded in a sentence that
    // already gives it, so repeating it reads as two different findings.
    expect(a.detail.match(/could not be read/g)).toHaveLength(1);
  });

  it("says the registry was UNREADABLE — never 'no instance registry record'", async () => {
    writeUnreadableRegistry();
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("anything-else"),
      repoRoot: installDir,
      env: {},
    });
    expect(a.detail).toContain("the instance registry could not be read");
    expect(a.detail).not.toContain("no instance registry record for this checkout");
  });

  it("does not FAIL either — an absent container under a guessed project proves nothing", async () => {
    // The symmetric false verdict: reporting this instance's runtime DOWN on
    // the strength of a project name doctor had to invent.
    writeUnreadableRegistry();
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("anything-else"),
      repoRoot: installDir,
      env: {},
    });
    expect(a.verdict).toBe("skip");
    expect(a.detail).toContain("does NOT establish that this instance's runtime is down");
  });

  it("still falls back rather than throwing — the lifecycle is never broken", async () => {
    writeUnreadableRegistry();
    const basenameProject = effectiveComposeProjectName(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(),
      dockerImpl: dockerWithWayflowIn(basenameProject),
      repoRoot: installDir,
      env: {},
    });
    expect(a.detail).toContain(`compose project "${basenameProject}"`);
  });

  // cinatra-cli#234 review, item 2 — the opt-out modes are NOT exempt.
  //
  // This block previously asserted that `off`/`external` "do not depend on
  // project resolution", because they are read from the install's own
  // .env.local. That was false as implemented: their opt-out SKIPs live inside
  // the `runningContainer === ""` branch, so excluding those two modes from the
  // unreadable-registry SKIP did not route them to their opt-out — it routed
  // them to the HEALTH PROBE whenever the guessed basename happened to have a
  // container. Both modes then returned PASS "runtime up" on a container doctor
  // had no basis to attribute to this instance. The two pins below execute that
  // defect; they fail on the PASS if the mode exclusions come back.
  for (const [mode, optOutPhrase] of [
    ["off", "--no-wayflow"],
    ["external", "owns no local compose stack"],
  ]) {
    it(`mode ${mode}: a container under the guessed basename is the unreadable-registry SKIP, never a PASS`, async () => {
      writeUnreadableRegistry();
      const basenameProject = effectiveComposeProjectName(installDir);
      const a = await doctorAssertWayflowReadiness({
        fetchImpl: healthyFetch(), // a healthy /.health — the PASS is one step away
        dockerImpl: dockerWithWayflowIn(basenameProject),
        repoRoot: installDir,
        env: { CINATRA_WAYFLOW_RUNTIME: mode },
      });
      expect(a.verdict).not.toBe("pass");
      expect(a.verdict).toBe("skip");
      // ...and it is the REGISTRY skip, naming the container it refused to
      // bless — not the opt-out, which says nothing about what was found.
      expect(a.detail).toContain("the instance registry could not be read");
      expect(a.detail).toContain("does NOT establish that it belongs to this instance");
      expect(a.detail).toContain(`"${basenameProject}-wayflow-1"`);
      expect(a.detail).not.toContain(optOutPhrase);
      expect(a.remediation).toMatch(/registry/i);
    });
  }

  it("the opt-out modes get the registry SKIP with no container either — the reason is the registry", async () => {
    // Same rule with nothing running: whether a record exists is UNKNOWN, so
    // the actionable finding is the unreadable registry, in every mode.
    writeUnreadableRegistry();
    for (const mode of ["off", "external"]) {
      const a = await doctorAssertWayflowReadiness({
        fetchImpl: REFUSING_FETCH,
        dockerImpl: dockerWithWayflowIn("anything-else"),
        repoRoot: installDir,
        env: { CINATRA_WAYFLOW_RUNTIME: mode },
      });
      expect(a.verdict).toBe("skip");
      expect(a.detail).toContain("the instance registry could not be read");
      expect(a.remediation).toMatch(/registry/i);
    }
  });

  it("a READABLE registry leaves the opt-outs stated as opt-outs", async () => {
    // The guard on the fix: where project resolution is sound (registry read,
    // no record → the basename IS this unmanaged checkout's project), `off` and
    // `external` still speak for themselves. The change is scoped to the case
    // where the project is a guess.
    writeInstanceRegistry(registryPath, { version: 1, instances: {} });
    const off = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("anything-else"),
      repoRoot: installDir,
      env: { CINATRA_WAYFLOW_RUNTIME: "off" },
    });
    expect(off.verdict).toBe("skip");
    expect(off.detail).toContain("--no-wayflow");

    const external = await doctorAssertWayflowReadiness({
      fetchImpl: REFUSING_FETCH,
      dockerImpl: dockerWithWayflowIn("anything-else"),
      repoRoot: installDir,
      env: { CINATRA_WAYFLOW_RUNTIME: "external" },
    });
    expect(external.verdict).toBe("skip");
    expect(external.detail).toContain("owns no local compose stack");
  });

  it("a readable registry recording the project is unaffected — still an authoritative PASS", async () => {
    recordInstance();
    provisionAgentSource(installDir);
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(null, 1),
      dockerImpl: dockerWithWayflowIn(RECORDED_PROJECT),
      repoRoot: installDir,
      // As above: the docker stub does not answer `port`, so the endpoint must
      // come from an explicit WAYFLOW_BASE_URL under #233's contract.
      env: { WAYFLOW_BASE_URL: "http://localhost:13010/" },
    });
    expect(a.verdict).toBe("pass");
  });
});

// ===========================================================================
// The exact miss in #227: the production finder's return SHAPE.
// ===========================================================================
describe("resolveRecordedComposeContext — the production finder's shape (cinatra-cli#230)", () => {
  it("resolves the recorded project when fed the REAL findInstanceByInstallDir", () => {
    const registry = recordInstance();
    // No stub. This is the pairing #227 shipped and never exercised: the real
    // finder returns { slug, slot }, and reading `.composeProject` off that
    // envelope is `undefined` → a silent basename fallback.
    const ctx = resolveRecordedComposeContext({
      repoRoot: installDir,
      fallbackProject: CHECKOUT_BASENAME,
      readRegistry: () => registry,
      findByInstallDir: findInstanceByInstallDir,
    });
    expect(ctx.project).toBe(RECORDED_PROJECT);
    expect(ctx.composeFiles).toEqual(RECORDED_FILES);
    expect(ctx.source).toBe("registry");
    expect(ctx.slug).toBe(SLUG);
  });

  it("accepts a flat row too — both finder shapes resolve identically", () => {
    const flat = {
      slug: SLUG,
      installDir,
      composeProject: RECORDED_PROJECT,
      composeFiles: RECORDED_FILES,
    };
    const enveloped = { slug: SLUG, slot: flat };
    const of = (row) =>
      resolveRecordedComposeContext({
        repoRoot: installDir,
        fallbackProject: CHECKOUT_BASENAME,
        readRegistry: () => ({ instances: { [SLUG]: flat } }),
        findByInstallDir: () => row,
      });
    expect(of(flat)).toEqual(of(enveloped));
    expect(of(enveloped).project).toBe(RECORDED_PROJECT);
  });

  it("a row that records NO project reports source 'fallback', not a false 'registry'", () => {
    // The lie that hid this defect: #227 returned source:"registry" while
    // handing back the basename. `source` must describe the project returned.
    const ctx = resolveRecordedComposeContext({
      repoRoot: installDir,
      fallbackProject: CHECKOUT_BASENAME,
      readRegistry: () => ({ instances: {} }),
      findByInstallDir: () => ({ slug: SLUG, slot: { slug: SLUG, installDir, composeFiles: RECORDED_FILES } }),
    });
    expect(ctx.project).toBe(CHECKOUT_BASENAME);
    expect(ctx.source).toBe("fallback");
    expect(ctx.slug).toBe(SLUG);
  });
});

// ===========================================================================
// The same resolution backs `cinatra instance wayflow start|stop`, which is the
// other half of the #227 claim — it addressed the basename for the same reason.
// ===========================================================================
describe("wayflowComposeContext — production wiring, no injected finder", () => {
  it("returns the recorded project and compose files for a recorded checkout", () => {
    recordInstance();
    const ctx = wayflowComposeContext(installDir);
    expect(ctx.project).toBe(RECORDED_PROJECT);
    expect(ctx.composeFiles).toEqual(RECORDED_FILES);
    expect(ctx.source).toBe("registry");
    expect(ctx.slug).toBe(SLUG);
  });

  it("falls back to the basename for an unrecorded checkout", () => {
    const ctx = wayflowComposeContext(installDir);
    expect(ctx.project).toBe(effectiveComposeProjectName(installDir));
    expect(ctx.source).toBe("fallback");
    expect(ctx.slug).toBeNull();
  });
});

// ===========================================================================
// The whole report, end to end: `cinatra doctor` on the recorded install dir.
// ===========================================================================
describe("gatherDoctorReport — the wayflow row follows the registry record", () => {
  function metadataClient(store = {}) {
    return {
      async query(text, params) {
        if (/select value from .*\.metadata where key/i.test(String(text))) {
          const value = store[params?.[0]];
          return {
            rows: value === undefined ? [] : [{ value: JSON.stringify(value) }],
            rowCount: value === undefined ? 0 : 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
  }

  it("a healthy runtime in the recorded project passes the wayflow assertion", async () => {
    recordInstance();
    provisionAgentSource(installDir);
    const report = await gatherDoctorReport({
      client: metadataClient({
        [LLM_MCP_SETTINGS_KEY]: { providers: { openai: { clientId: "x", clientSecret: "y" } } },
        [MCP_SETTINGS_KEY]: { publicBaseUrl: "https://node.example.ts.net", publicBaseUrlSource: "tailscale-auto" },
      }),
      schemaName: "cinatra",
      env: { BETTER_AUTH_URL: "http://localhost:13300", WAYFLOW_BASE_URL: "http://localhost:13010/" },
      repoRoot: installDir,
      fetchImpl: healthyFetch("http://localhost:13010/.health", 1),
      dockerImpl: dockerWithWayflowIn(RECORDED_PROJECT),
    });
    const a = report.assertions.find((x) => x.id === "wayflow-readiness");
    expect(a.verdict).toBe("pass");
  });
});
