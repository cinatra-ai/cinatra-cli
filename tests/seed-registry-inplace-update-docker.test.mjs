// cinatra-cli#200 — DOCKER-GATED end-to-end verification of the in-place update.
//
// The hermetic sibling (seed-registry-inplace-update.test.mjs) answers the
// registry's HTTP surface from a fixture. This file proves the SAME behaviour
// against the thing the bug was actually reported on: a REAL Verdaccio, seeded
// by a REAL `npm publish`, with the skew decided by REAL registry integrity
// metadata — plus the real git clone/fast-forward and the real setup-tail child
// process whose exit status `cinatra install` reads.
//
// Auto-SKIPS unless Docker is usable AND the Verdaccio image is ALREADY present
// locally (`docker pull verdaccio/verdaccio:6` to enable it). Gating on the
// cached image keeps this a deterministic local/agent live proof instead of a
// registry-pull dependency in CI — the hermetic sibling is the always-on
// regression coverage.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { classifySetupChildExit } from "../src/install.mjs";
import { SETUP_EXIT_REGISTRY_SKEW } from "../src/seed-local-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "fixtures", "registry-seed-setup-tail.mjs");
const IMAGE = "verdaccio/verdaccio:6";
const CONTAINER = "cinatra-cli-200-verdaccio-test";
const PORT = 14874;
const REGISTRY_URL = `http://127.0.0.1:${PORT}`;
const VERSION = "0.1.0";

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", ...opts });

function dockerWithImageAvailable() {
  if (docker(["version", "--format", "{{.Server.Version}}"]).status !== 0) return false;
  return docker(["image", "inspect", IMAGE]).status === 0;
}

const ENABLED = dockerWithImageAvailable();

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

describe.skipIf(!ENABLED)("local-registry seed on an IN-PLACE UPDATE — real Verdaccio (cinatra-cli#200)", () => {
  let work;

  async function waitForRegistry(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-docker-"));
    // A config with NO uplinks: the registry never reaches out to npmjs, so the
    // proof is about this instance's own state and nothing else.
    const confDir = path.join(work, "verdaccio");
    mkdirSync(confDir, { recursive: true });
    writeFileSync(
      path.join(confDir, "config.yaml"),
      [
        "storage: /verdaccio/storage/data",
        "auth:",
        "  htpasswd:",
        "    file: /verdaccio/storage/htpasswd",
        "    max_users: 1000",
        "uplinks: {}",
        "packages:",
        "  '@*/*':",
        "    access: $all",
        "    publish: $authenticated",
        "    unpublish: $authenticated",
        "  '**':",
        "    access: $all",
        "    publish: $authenticated",
        "    unpublish: $authenticated",
        "log: { type: stdout, format: pretty, level: warn }",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    docker(["rm", "-f", CONTAINER]);
    const run = docker([
      "run", "-d", "--name", CONTAINER,
      "-p", `127.0.0.1:${PORT}:4873`,
      "-v", `${path.join(confDir, "config.yaml")}:/verdaccio/conf/config.yaml:ro`,
      IMAGE,
    ]);
    if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
    if (!(await waitForRegistry())) throw new Error("Verdaccio never became reachable");
  }, 180_000);

  afterAll(() => {
    docker(["rm", "-f", CONTAINER]);
    rmSync(work, { recursive: true, force: true });
  });

  function makeUpstream(short) {
    const pkg = `@cinatra-fixture/${short}`;
    const origin = path.join(work, `${short}.git`);
    const seed = path.join(work, `${short}-seed`);
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    execFileSync("git", ["clone", "-q", origin, seed]);
    git(seed, ["config", "user.email", "t@t"]);
    git(seed, ["config", "user.name", "t"]);
    writeFileSync(
      path.join(seed, "package.json"),
      JSON.stringify({ name: pkg, version: VERSION, main: "index.js" }),
    );
    writeFileSync(path.join(seed, "index.js"), "module.exports = { rev: 1 };\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-q", "-m", "c1"]);
    git(seed, ["push", "-q", "origin", "HEAD:main"]);
    return { pkg, short, origin, seed };
  }

  function advanceUpstream(up, body) {
    writeFileSync(path.join(up.seed, "index.js"), body);
    git(up.seed, ["add", "."]);
    git(up.seed, ["commit", "-q", "-m", "upstream moves without a version bump"]);
    git(up.seed, ["push", "-q", "origin", "HEAD:main"]);
    return git(up.seed, ["rev-parse", "HEAD"]);
  }

  function makeCheckout(name, ups) {
    const root = path.join(work, name);
    mkdirSync(root, { recursive: true });
    const devExtensions = {};
    for (const up of ups) devExtensions[up.pkg] = { url: up.origin, branch: "main" };
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture-checkout", version: "0.0.0", private: true, cinatra: { devExtensions } }),
    );
    return root;
  }

  /** The REAL setup tail child (sync + seed + classification) → the REAL
   *  install-boundary decision. No registry fake: this publishes for real. */
  function runSetupChildThroughInstall(repoRoot) {
    const child = spawnSync(process.execPath, [DRIVER, repoRoot, REGISTRY_URL], {
      encoding: "utf8",
      // The hermetic fake must never leak in here.
      env: { ...process.env, CINATRA_TEST_REGISTRY_STATE: "" },
    });
    const verdict = classifySetupChildExit(child.status, { canReportRegistrySkew: true });
    const tailLine = (child.stdout ?? "").split("\n").find((l) => l.startsWith("[setup-tail] "));
    return {
      status: child.status,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      tail: tailLine ? JSON.parse(tailLine.slice("[setup-tail] ".length)) : null,
      installAborted: !verdict.tolerated,
      verdict,
    };
  }

  it("fresh install publishes and exits 0; routine drift on the RE-RUN keeps it at 0", () => {
    const up = makeUpstream("drift-connector");
    const root = makeCheckout("checkout-drift", [up]);

    // FROM ZERO — unchanged (AC3): the clone is made and the tarball published.
    const fresh = runSetupChildThroughInstall(root);
    expect(fresh.tail.seed.published).toEqual([`${up.pkg}@${VERSION}`]);
    expect(fresh.tail.seed.skew).toEqual([]);
    expect(fresh.status).toBe(0);

    // IN-PLACE UPDATE — upstream moved, version did not.
    const movedSha = advanceUpstream(up, "module.exports = { rev: 2 };\n");
    const update = runSetupChildThroughInstall(root);
    expect(update.tail.syncResults).toEqual([
      expect.objectContaining({ action: "updated", changed: true, syncedSha: movedSha }),
    ]);
    // Real Verdaccio integrity says the bytes differ; the seed says so LOUDLY,
    // republishes nothing, and the run still completes (AC1).
    expect(update.tail.seed.skew).toEqual([`${up.pkg}@${VERSION}`]);
    expect(update.tail.seed.published).toEqual([]);
    expect(update.tail.seed.unexemptedSkew).toEqual([]);
    expect(update.status).toBe(0);
    expect(update.installAborted).toBe(false);
  }, 180_000);

  it("genuine local edits: typed skew exit, named by the install, which continues", () => {
    const up = makeUpstream("edited-connector");
    const root = makeCheckout("checkout-edited", [up]);
    expect(runSetupChildThroughInstall(root).status).toBe(0);

    writeFileSync(
      path.join(root, "extensions", "cinatra-fixture", up.short, "index.js"),
      "module.exports = { rev: 'LOCAL EDIT' };\n",
    );
    const edited = runSetupChildThroughInstall(root);
    expect(edited.tail.seed.unexemptedSkew).toEqual([`${up.pkg}@${VERSION}`]);
    expect(edited.status).toBe(SETUP_EXIT_REGISTRY_SKEW);
    expect(edited.installAborted).toBe(false);
    expect(edited.verdict.lines.join("\n")).toMatch(/NOT a failed setup/i);
  }, 180_000);

  it("a genuine publish failure still exits 1 and still aborts the install", () => {
    const up = makeUpstream("ok-connector");
    const root = makeCheckout("checkout-broken", [up]);
    const broken = path.join(root, "extensions", "cinatra-fixture", "broken-connector");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      path.join(broken, "package.json"),
      JSON.stringify({ name: "@cinatra-fixture/broken-connector", version: "not-a-semver", main: "index.js" }),
    );
    writeFileSync(path.join(broken, "index.js"), "module.exports = 1;\n");

    const run = runSetupChildThroughInstall(root);
    expect(run.tail.seed.failed).toEqual(["@cinatra-fixture/broken-connector@not-a-semver"]);
    expect(run.status).toBe(1);
    expect(run.installAborted).toBe(true);
  }, 180_000);
});
