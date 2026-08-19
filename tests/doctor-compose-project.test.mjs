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

/** The healthy runtime from the row-7 evidence: HTTP 200, status ok. */
function healthyFetch(expectedUrl = null) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (expectedUrl && String(url) !== expectedUrl) throw new Error("ECONNREFUSED");
    return {
      ok: true,
      status: 200,
      async json() {
        return { status: "ok", agents: 0, failed: 0, failed_agents: [], last_reload_at: null };
      },
    };
  };
  fetchImpl.seen = seen;
  return fetchImpl;
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
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(),
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
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(),
      dockerImpl: dockerWithWayflowIn(basenameProject),
      repoRoot: installDir,
      env: {},
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

  it("the by-design opt-outs still win — they do not depend on project resolution", async () => {
    // `off`/`external` are read from the install's own .env.local, so an
    // unreadable registry must not convert a deliberate opt-out into a
    // registry-repair SKIP that misdescribes it.
    writeUnreadableRegistry();
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
    const a = await doctorAssertWayflowReadiness({
      fetchImpl: healthyFetch(),
      dockerImpl: dockerWithWayflowIn(RECORDED_PROJECT),
      repoRoot: installDir,
      env: {},
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
    const report = await gatherDoctorReport({
      client: metadataClient({
        [LLM_MCP_SETTINGS_KEY]: { providers: { openai: { clientId: "x", clientSecret: "y" } } },
        [MCP_SETTINGS_KEY]: { publicBaseUrl: "https://node.example.ts.net", publicBaseUrlSource: "tailscale-auto" },
      }),
      schemaName: "cinatra",
      env: { BETTER_AUTH_URL: "http://localhost:13300", WAYFLOW_BASE_URL: "http://localhost:13010/" },
      repoRoot: installDir,
      fetchImpl: healthyFetch("http://localhost:13010/.health"),
      dockerImpl: dockerWithWayflowIn(RECORDED_PROJECT),
    });
    const a = report.assertions.find((x) => x.id === "wayflow-readiness");
    expect(a.verdict).toBe("pass");
  });
});
