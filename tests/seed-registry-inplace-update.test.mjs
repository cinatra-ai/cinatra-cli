// cinatra-cli#200 — THE IN-PLACE UPDATE REGRESSION (AC5).
//
// The gap the from-zero e2e cannot see: a fresh install is born with the local
// registry and the on-disk sources identical, so it can never produce a
// same-version skew. Only a RE-RUN over an existing checkout can — the dev
// clones track branch tips, upstream moves without a version bump, and the seed
// finds bytes that differ from the tarball it published last time. That routine
// state used to exit the setup process non-zero, which `cinatra install` could
// only report as "cinatra instance setup dev failed inside the target" — over a
// setup that had substantively completed and, on `--mode preview`, before the
// preview composition ever ran.
//
// What is REAL here: the git upstream that advances, the branch-tracking clone
// the real sync fast-forwards, the `npm pack` whose bytes decide the skew, the
// setup tail in a CHILD PROCESS (the bug lives at the process boundary, so the
// assertion that matters is the child's EXIT STATUS), and the install boundary
// that reads it. Only the registry's HTTP surface is answered from a fixture
// (`CINATRA_TEST_REGISTRY_STATE`), which is what makes this hermetic and fast.
// The same scenarios were proven against a real Verdaccio + real `npm publish`
// in the docker-gated sibling (seed-registry-inplace-update-docker.test.mjs).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { classifySetupChildExit } from "../src/install.mjs";
import { SETUP_EXIT_REGISTRY_SKEW } from "../src/seed-local-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "fixtures", "registry-seed-setup-tail.mjs");
const VERSION = "0.1.0";
// Nothing listens here: hermetic mode answers the registry reads from the state
// file, and no scenario is expected to publish.
const REGISTRY_URL = "http://127.0.0.1:14899";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).toString().trim();

function makeUpstream(work, short) {
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

/** Upstream moves WITHOUT a version bump — the routine dev-clone drift shape. */
function advanceUpstream(up, body) {
  writeFileSync(path.join(up.seed, "index.js"), body);
  git(up.seed, ["add", "."]);
  git(up.seed, ["commit", "-q", "-m", "upstream moves without a version bump"]);
  git(up.seed, ["push", "-q", "origin", "HEAD:main"]);
  return git(up.seed, ["rev-parse", "HEAD"]);
}

function makeCheckout(work, name, ups) {
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

const cloneDirOf = (root, up) => path.join(root, "extensions", "cinatra-fixture", up.short);

/** The on-disk state a PREVIOUS install left behind: the branch-tracking clone
 *  in its extensions/ slot. (Materialized directly so no scenario has to
 *  publish — every run under test starts from an already-seeded registry.) */
function materializePreviousInstall(root, up) {
  const dest = cloneDirOf(root, up);
  mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", up.origin, dest]);
  return dest;
}

/** The integrity a seed WOULD publish for this working tree — real `npm pack`,
 *  hashed exactly as seed-local-registry.mjs hashes it. */
function packIntegrity(dir, outDir) {
  const r = spawnSync("npm", ["pack", "--pack-destination", outDir, "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`npm pack failed: ${r.stderr}`);
  const file = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
  const abs = path.join(outDir, path.basename(file));
  if (!existsSync(abs)) throw new Error(`npm pack produced no tarball for ${dir}`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(abs)).digest("base64")}`;
  rmSync(abs, { force: true });
  return integrity;
}

describe("local-registry seed on an IN-PLACE UPDATE (cinatra-cli#200)", () => {
  let work;
  let packDir;

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), "cinatra-cli-200-update-"));
    packDir = path.join(work, "packs");
    mkdirSync(packDir, { recursive: true });
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  /** Run the setup tail as a child, then let the install boundary judge it. */
  function runSetupChildThroughInstall(repoRoot, registryState, label) {
    const statePath = path.join(work, `registry-state-${label}.json`);
    writeFileSync(statePath, JSON.stringify(registryState));
    const child = spawnSync(process.execPath, [DRIVER, repoRoot, REGISTRY_URL], {
      encoding: "utf8",
      env: { ...process.env, CINATRA_TEST_REGISTRY_STATE: statePath },
    });
    const verdict = classifySetupChildExit(child.status, { canReportRegistrySkew: true });
    const tailLine = (child.stdout ?? "").split("\n").find((l) => l.startsWith("[setup-tail] "));
    return {
      status: child.status,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
      tail: tailLine ? JSON.parse(tailLine.slice("[setup-tail] ".length)) : null,
      // `runOrThrow` semantics: an intolerable status aborts the install before
      // the preview composition.
      installAborted: !verdict.tolerated,
      verdict,
    };
  }

  it("routine dev-clone drift completes the update: exit 0, install continues, skew still warned", () => {
    const up = makeUpstream(work, "drift-connector");
    const root = makeCheckout(work, "checkout-drift", [up]);

    // 1. The state a PREVIOUS install left behind: the clone on disk, and the
    //    registry holding exactly the bytes that clone packs to.
    materializePreviousInstall(root, up);
    const registry = { [up.pkg]: { [VERSION]: packIntegrity(cloneDirOf(root, up), packDir) } };

    // 2. A warm re-run with NOTHING changed is a plain no-op — no false skew.
    const warm = runSetupChildThroughInstall(root, registry, "drift-warm");
    expect(warm.tail.seed.skipped).toEqual([`${up.pkg}@${VERSION}`]);
    expect(warm.tail.seed.skew).toEqual([]);
    expect(warm.status).toBe(0);
    expect(warm.installAborted).toBe(false);

    // 3. Upstream advances WITHOUT a version bump; the update re-runs.
    const movedSha = advanceUpstream(up, "module.exports = { rev: 2 };\n");
    const update = runSetupChildThroughInstall(root, registry, "drift-update");

    // The sync fast-forwarded the clone and ATTESTED it at the fetched tip…
    expect(update.tail.syncResults).toEqual([
      expect.objectContaining({ action: "updated", changed: true, syncedSha: movedSha }),
    ]);
    expect(update.tail.exempt.synced).toEqual([path.resolve(cloneDirOf(root, up))]);
    // …the seed still reports the skew LOUDLY (the registry keeps serving the
    // previously seeded bytes for that version, and nothing is republished)…
    expect(update.tail.seed.skew).toEqual([`${up.pkg}@${VERSION}`]);
    expect(update.tail.seed.published).toEqual([]);
    expect(update.stderr).toMatch(/freshly-synced branch tip/);
    expect(update.stderr).toMatch(/NOT republishing the same version/);
    // …but it is attributed, so it is not exit-affecting (AC1) and the install
    // runs on to the preview composition.
    expect(update.tail.seed.unexemptedSkew).toEqual([]);
    expect(update.status).toBe(0);
    expect(update.installAborted).toBe(false);
  });

  it("genuine local edits still surface loudly, and the install NAMES the skew instead of failing", () => {
    const up = makeUpstream(work, "edited-connector");
    const root = makeCheckout(work, "checkout-edited", [up]);
    materializePreviousInstall(root, up);
    const registry = { [up.pkg]: { [VERSION]: packIntegrity(cloneDirOf(root, up), packDir) } };

    // The operator edits the clone's working tree — content the sync did NOT
    // produce, so the sync refuses to attest it.
    writeFileSync(
      path.join(cloneDirOf(root, up), "index.js"),
      "module.exports = { rev: 'LOCAL EDIT' };\n",
    );
    const edited = runSetupChildThroughInstall(root, registry, "edited-run");

    expect(edited.tail.syncResults).toEqual([
      expect.objectContaining({ action: "skipped-dirty", syncedSha: null }),
    ]);
    expect(edited.tail.exempt).toEqual({ pinned: [], synced: [] });
    expect(edited.tail.seed.unexemptedSkew).toEqual([`${up.pkg}@${VERSION}`]);
    expect(edited.stderr).toMatch(/local edits without a version bump/);
    // AC2: still loud, still non-zero — but with the TYPED code the install can
    // read, so the install names the condition + remedy and carries on instead
    // of declaring the completed setup failed.
    expect(edited.status).toBe(SETUP_EXIT_REGISTRY_SKEW);
    expect(edited.installAborted).toBe(false);
    expect(edited.verdict.registrySkew).toBe(true);
    const verdictText = edited.verdict.lines.join("\n");
    expect(verdictText).toMatch(/NOT a failed setup/i);
    expect(verdictText).toMatch(/bump the extension version/i);
    // The setup tail said the same thing, naming the extension. Asserted as a
    // plain substring: the id contains regex metacharacters, and hand-rolling
    // an escape for it is exactly the incomplete-sanitization pattern CodeQL
    // flags (js/incomplete-sanitization) — a literal match needs no regex.
    expect(edited.stderr).toContain(`${up.pkg}@${VERSION}`);
  });

  it("a genuine publish failure is UNCHANGED: exit 1, install aborts", () => {
    const up = makeUpstream(work, "ok-connector");
    const root = makeCheckout(work, "checkout-broken", [up]);
    materializePreviousInstall(root, up);
    const registry = { [up.pkg]: { [VERSION]: packIntegrity(cloneDirOf(root, up), packDir) } };

    // An on-disk extension npm refuses to publish (invalid version).
    const broken = path.join(root, "extensions", "cinatra-fixture", "broken-connector");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      path.join(broken, "package.json"),
      JSON.stringify({ name: "@cinatra-fixture/broken-connector", version: "not-a-semver", main: "index.js" }),
    );
    writeFileSync(path.join(broken, "index.js"), "module.exports = 1;\n");

    const run = runSetupChildThroughInstall(root, registry, "broken-run");
    expect(run.tail.seed.failed).toEqual(["@cinatra-fixture/broken-connector@not-a-semver"]);
    expect(run.status).toBe(1);
    expect(run.installAborted).toBe(true);
  });

  it("a real failure WINS over a concurrent skew (a skew never downgrades it)", () => {
    const up = makeUpstream(work, "both-connector");
    const root = makeCheckout(work, "checkout-both", [up]);
    materializePreviousInstall(root, up);
    const registry = { [up.pkg]: { [VERSION]: packIntegrity(cloneDirOf(root, up), packDir) } };

    // Unattributed skew AND a publish failure in the same run.
    writeFileSync(
      path.join(cloneDirOf(root, up), "index.js"),
      "module.exports = { rev: 'LOCAL EDIT' };\n",
    );
    const broken = path.join(root, "extensions", "cinatra-fixture", "broken-too");
    mkdirSync(broken, { recursive: true });
    writeFileSync(
      path.join(broken, "package.json"),
      JSON.stringify({ name: "@cinatra-fixture/broken-too", version: "not-a-semver", main: "index.js" }),
    );
    writeFileSync(path.join(broken, "index.js"), "module.exports = 1;\n");

    const run = runSetupChildThroughInstall(root, registry, "both-run");
    expect(run.tail.seed.unexemptedSkew).toEqual([`${up.pkg}@${VERSION}`]);
    expect(run.tail.seed.failed).toEqual(["@cinatra-fixture/broken-too@not-a-semver"]);
    expect(run.status).toBe(1);
    expect(run.installAborted).toBe(true);
  });
}, 60_000);
