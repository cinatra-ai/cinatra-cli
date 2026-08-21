// cinatra-cli#230, sibling consumers — every install-dir lookup in
// `src/index.mjs` must go through the ONE unwrap, not the registry finder.
//
// `findInstanceByInstallDir` returns the `{ slug, slot }` ENVELOPE. The doctor
// path was fixed for this; three siblings were not, and each reads instance
// fields straight off whatever it got back:
//
//   * upgrade-preflight  — `row.installDir` / `row.composeFiles` /
//                          `row.composeProject` feed `resolveComposeConfig`.
//                          On the envelope all three are `undefined`, so the
//                          preflight resolved the BASE compose pair under the
//                          DEFAULT project — a different stack than the
//                          instance's, with no error raised.
//   * upgrade-major      — the same three fields, the same degrade.
//   * refresh's ledger   — `instRow.composeProject` becomes
//     capture               `requireProjectMatch`. `undefined` → the ternary
//                          yields null → captureDeployedVersions' "do not
//                          record the wrong stack" guard NEVER RAN for any
//                          recorded instance.
//
// The envelope is silent about all of this: `.slug` IS present on it, so
// `row?.slug` resolved, the handlers proceeded, and only the *addressed stack*
// was wrong. So these tests pin the returned SHAPE, and then drive the refresh
// derivation end to end through the real guard — including the negative
// control on the raw envelope, which is what the defect actually did.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allocateInstance,
  findInstanceByInstallDir,
  markInstanceReady,
} from "../src/instance-registry.mjs";
import { findInstanceRowByInstallDir } from "../src/index.mjs";
import { captureDeployedVersions } from "../src/version-ledger-capture.mjs";
import { readLedger } from "../src/version-ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(path.join(HERE, "..", "src", "index.mjs"), "utf8");

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
let ledgerDir;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cli230-consumers-"));
  installDir = path.join(tmp, CHECKOUT_BASENAME);
  ledgerDir = path.join(tmp, "ledger");
  mkdirSync(installDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A real, structurally valid `ready` registry holding one row for installDir. */
function registryWithRow({ composeProject = RECORDED_PROJECT } = {}) {
  const { registry } = allocateInstance({ version: 1, instances: {} }, SLUG, {
    mode: "dev",
    installDir,
    composeProject,
    composeFiles: RECORDED_FILES,
    ports: { postgres: [15434], redis: [16379] },
    appPort: 13300,
    repoUrl: "https://github.com/cinatra-ai/cinatra.git",
    ref: "main",
    sha: "1b820b7c22c18f4b79da89e033fbbceca841db7a",
    infraMode: "new",
  });
  return markInstanceReady(registry, SLUG);
}

// ===========================================================================
// STATIC boundary — nothing in index.mjs may look a checkout up in the registry
// without unwrapping. This is the pin that generalizes: the defect was three
// call sites drifting from one, and a behavioural test per consumer would not
// have caught the FOURTH one added tomorrow.
// ===========================================================================
describe("index.mjs — every install-dir lookup routes through the one unwrap", () => {
  it("never calls the registry's raw findInstanceByInstallDir", () => {
    // The registry export is imported under an ALIAS (`instanceRowByInstallDir`)
    // reserved for the unwrap helper. An unaliased call is the bug.
    expect(INDEX_SRC).not.toMatch(/(?<!Row)\bfindInstanceByInstallDir\s*\(/);
  });

  it("dereferences the aliased registry finder exactly once — inside the unwrap", () => {
    const calls = INDEX_SRC.match(/\binstanceRowByInstallDir\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const helper = INDEX_SRC.slice(
      INDEX_SRC.indexOf("function findInstanceRowByInstallDir"),
    ).split("\n}\n")[0];
    expect(helper).toMatch(/instanceRowByInstallDir\s*\(/);
  });

  it("does not lazy-import findInstanceByInstallDir into a command handler", () => {
    // The three sibling consumers pulled it out of a dynamic
    // `await import("./instance-registry.mjs")` destructure; that is how they
    // drifted from the doctor path in the first place.
    const destructures = INDEX_SRC.match(/const\s*\{[^}]*\}\s*=\s*\n?\s*await import\("\.\/instance-registry\.mjs"\)/g) ?? [];
    expect(destructures.length).toBeGreaterThan(0); // the handlers still import
    for (const d of destructures) expect(d).not.toMatch(/findInstanceByInstallDir/);
  });
});

// ===========================================================================
// The shape the sibling consumers read.
// ===========================================================================
describe("findInstanceRowByInstallDir — the flat slot the consumers actually read", () => {
  it("returns installDir, composeFiles AND composeProject — undefined on the raw envelope", () => {
    const registry = registryWithRow();

    // What the siblings used to call. `.slug` resolves, which is precisely why
    // the handlers proceeded; the three fields they then USE do not.
    const envelope = findInstanceByInstallDir(registry, installDir);
    expect(envelope.slug).toBe(SLUG);
    expect(envelope.composeProject).toBeUndefined();
    expect(envelope.installDir).toBeUndefined();
    expect(envelope.composeFiles).toBeUndefined();

    const row = findInstanceRowByInstallDir(registry, installDir);
    expect(row.slug).toBe(SLUG);
    expect(row.composeProject).toBe(RECORDED_PROJECT);
    expect(row.installDir).toBe(installDir);
    expect(row.composeFiles).toEqual(RECORDED_FILES);
  });

  it("resolves THIS checkout only, and survives a null/absent registry", () => {
    const registry = registryWithRow();
    expect(findInstanceRowByInstallDir(registry, path.join(tmp, "other"))).toBe(null);
    expect(findInstanceRowByInstallDir(null, installDir)).toBe(null);
  });

  it("is idempotent on an already-flat row", () => {
    const flat = {
      slug: SLUG,
      installDir,
      composeProject: RECORDED_PROJECT,
      composeFiles: RECORDED_FILES,
    };
    const registry = { version: 1, instances: { [SLUG]: flat } };
    expect(findInstanceRowByInstallDir(registry, installDir)).toMatchObject({
      slug: SLUG,
      installDir,
      composeProject: RECORDED_PROJECT,
      composeFiles: RECORDED_FILES,
    });
  });
});

// ===========================================================================
// Item 2: refresh's "do not record the wrong stack" guard, restored.
// ===========================================================================
//
// `cinatra refresh` runs `docker compose up -d` with NO `-p`, so it deploys the
// BARE/default project. When the instance row records a different explicit
// project, recording that deployment into the row's ledger would bind another
// stack's volumes to this slug. The guard is `requireProjectMatch`, and refresh
// derives it from the registry row.
describe("refresh ledger capture — requireProjectMatch derived from the unwrapped row", () => {
  // Resolves compose project name "cinatra" — the bare project a `-p`-less
  // `docker compose up` in this checkout deploys. NOT the recorded project.
  const BARE_PROJECT_DOCKER = (cmd, args) => {
    if (cmd !== "docker") return null;
    if (args.includes("config")) {
      return JSON.stringify({
        name: "cinatra",
        services: {
          postgres: {
            image: "postgres:18-alpine",
            volumes: [{ type: "volume", source: "postgres-data", target: "/var/lib/postgresql/data" }],
          },
        },
        volumes: { "postgres-data": { name: "cinatra_postgres-data" } },
      });
    }
    if (args.includes("ps")) {
      return JSON.stringify({ Service: "postgres", Image: "postgres:18-alpine", State: "running" });
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return JSON.stringify([{ Name: args[2], CreatedAt: "2026-03-01T00:00:00Z" }]);
    }
    return null;
  };

  /** refresh's derivation, verbatim (src/index.mjs — the ledger-capture block). */
  const rowProjectOf = (row) =>
    row?.composeProject && row.composeProject !== "cinatra" ? row.composeProject : null;

  const captureWith = (requireProjectMatch, logs) =>
    captureDeployedVersions({
      slug: SLUG,
      targetDir: installDir,
      requireProjectMatch,
      ledgerDir,
      capture: BARE_PROJECT_DOCKER,
      log: (l) => logs.push(l),
    });

  it("refuses to record the bare stack against an instance recording its own project", async () => {
    const registry = registryWithRow();
    const row = findInstanceRowByInstallDir(registry, installDir);
    const rowProject = rowProjectOf(row);

    expect(rowProject).toBe(RECORDED_PROJECT); // non-null: the guard is armed

    const logs = [];
    const res = await captureWith(rowProject, logs);

    expect(res.status).toBe("project-mismatch");
    expect(res.recorded).toEqual([]);
    expect(readLedger(SLUG, ledgerDir).status).toBe("missing");
    expect(logs.join("\n")).toMatch(/not recording against the wrong stack/);
  });

  it("REGRESSION: off the raw envelope the guard is disarmed and the wrong stack IS recorded", async () => {
    // The defect, executed. `envelope.composeProject` is undefined → the
    // ternary yields null → requireProjectMatch null → captureDeployedVersions
    // records the BARE project's volumes into instance "x2654-row1"'s ledger.
    const registry = registryWithRow();
    const envelope = findInstanceByInstallDir(registry, installDir);
    const rowProject = rowProjectOf(envelope);

    expect(rowProject).toBe(null); // the guard silently disarmed

    const logs = [];
    const res = await captureWith(rowProject, logs);

    expect(res.status).toBe("ok");
    expect(res.recorded).toContain("postgres");
    expect(logs.join("\n")).not.toMatch(/not recording against the wrong stack/);
  });

  it("a row recording the bare project records normally — the guard is not a blanket refusal", async () => {
    const registry = registryWithRow({ composeProject: "cinatra" });
    const row = findInstanceRowByInstallDir(registry, installDir);

    expect(row.composeProject).toBe("cinatra");
    expect(rowProjectOf(row)).toBe(null); // bare project ⇒ nothing to guard against

    const res = await captureWith(rowProjectOf(row), []);
    expect(res.status).toBe("ok");
    expect(res.recorded).toContain("postgres");
  });
});
