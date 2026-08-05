// cinatra-cli#200 — the `cinatra instance setup dev` TAIL, as a standalone child
// process: the setup-phase extension sync, the local-registry seed, and the exit
// classification, wired exactly as `runSetup`'s `mode === "dev"` block wires them
// (src/index.mjs — `collectSkewExemptSources` → `seedLocalRegistryExtensions` →
// `classifySetupExitCode`).
//
// WHY a driver instead of the real subcommand: the full `instance setup dev`
// opens a Postgres connection and applies the checkout's DDL before it ever
// reaches this tail, so it cannot run against a fixture. The tail is the part
// under test, and running it in a CHILD PROCESS is the point — the reported bug
// lives at the process boundary (the seed's exit code is all `cinatra install`
// can see of it), so the assertion that matters is this process's exit STATUS.
//
// Usage: node registry-seed-setup-tail.mjs <repoRoot> <registryUrl>
//
// TEST SEAM (hermetic mode): with `CINATRA_TEST_REGISTRY_STATE=<file>` set, the
// registry HTTP surface the seed reads — reachability, the throwaway publish
// user, and packuments — is answered from that JSON file instead of a live
// server, so the suite exercises the real sync + the real `npm pack` integrity
// comparison + the real exit classification without needing a registry process.
// `npm publish` is NOT faked: nothing in hermetic mode is expected to publish,
// so a publish attempt shows up as the real npm failure it is. The same driver
// runs UNFAKED against a real Verdaccio in the docker-gated sibling test.
import { readFileSync } from "node:fs";
import process from "node:process";

import {
  collectSkewExemptSources,
  syncCinatraDevExtensions,
} from "../../src/cinatra-dev-extensions.mjs";
import {
  SETUP_EXIT_REGISTRY_SKEW,
  classifySetupExitCode,
  registrySkewVerdictLines,
  seedLocalRegistryExtensions,
} from "../../src/seed-local-registry.mjs";

// Installed BEFORE the seed runs (the seed resolves `fetch` at call time).
if (process.env.CINATRA_TEST_REGISTRY_STATE) {
  // `{ "<pkgName>": { "<version>": "<integrity>" } }` — what a PREVIOUS seed
  // left in the local registry.
  const state = JSON.parse(readFileSync(process.env.CINATRA_TEST_REGISTRY_STATE, "utf8"));
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input instanceof URL ? input.href : input));
    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init.method === "PUT" && url.pathname.startsWith("/-/user/")) {
      return json(201, { ok: true, token: "hermetic-seed-token" });
    }
    if (url.pathname === "/") return json(200, { db_name: "registry" });
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const versions = state[name];
    if (!versions) return json(404, { error: "not found" });
    return json(200, {
      name,
      versions: Object.fromEntries(
        Object.entries(versions).map(([v, integrity]) => [v, { dist: { integrity } }]),
      ),
    });
  };
}

const [, , repoRoot, registryUrl] = process.argv;

let extensionSync;
try {
  extensionSync = await syncCinatraDevExtensions({
    repoRoot,
    targetRoot: repoRoot,
    argv: [],
    env: process.env,
    log: (line) => console.log(line),
  });
} catch (err) {
  // Mirrors the loud-but-non-fatal dev-extension sync arm in runSetup.
  console.error(`\n⚠ Dev extension sync FAILED:\n  ${err?.message ?? err}\n`);
  process.exitCode = 1;
}

const { pinnedSourceDirs, syncedSourceDirs } = collectSkewExemptSources(extensionSync);
const summary = await seedLocalRegistryExtensions({
  repoRoot,
  registryUrl,
  pinnedSourceDirs,
  syncedSourceDirs,
});

const classified = classifySetupExitCode(process.exitCode, summary.unexemptedSkew);
if (classified === SETUP_EXIT_REGISTRY_SKEW) {
  for (const line of registrySkewVerdictLines(summary.unexemptedSkew)) console.warn(line);
}
process.exitCode = classified;

// Machine-readable tail for the harness/test assertions.
console.log(
  `[setup-tail] ${JSON.stringify({
    syncResults: (extensionSync?.results ?? []).map((r) => ({
      pkgName: r.pkgName,
      action: r.action,
      changed: r.changed ?? null,
      syncedSha: r.syncedSha ?? null,
      pinnedSha: r.pinnedSha ?? null,
    })),
    exempt: { pinned: [...pinnedSourceDirs], synced: [...syncedSourceDirs] },
    seed: {
      published: summary.published,
      skipped: summary.skipped,
      failed: summary.failed,
      skew: summary.skew,
      unexemptedSkew: summary.unexemptedSkew,
    },
    exitCode: classified,
  })}`,
);
