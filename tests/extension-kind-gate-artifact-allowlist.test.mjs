// AC2 of cinatra-ai/extension-release-tooling#54 (cinatra-cli#154): the gate as
// COPIED INTO a scaffolded artifact repo — not merely the source template —
// admits the two cross-kind presentation/byline keys the org allowlist now
// carries (cinatra.displayName + cinatra.vendor) and still rejects any key
// outside the seven-key artifact allowlist with the EXACT allowlist error.
//
// The point is to exercise the whole copy path `cinatra create-extension
// artifact` runs: scaffold() copies templates/_shared/extension-kind-gate.mjs
// verbatim into the generated repo, and the generated repo's standalone CI runs
// THAT copy. Importing the copied file (not the source template) proves the byte
// the external author's CI actually executes carries the seven-key allowlist —
// the exact drift class the daily release-template-drift-audit flags.

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scaffold } from "../src/authoring/scaffold.mjs";

// The exact seven-key allowlist error the copied gate must emit, kept as a
// literal so any drift in the gate's wording (key set, key order) reddens this.
const unexpectedKeyError = (k) =>
  `artifact extensions may only declare cinatra.{kind,apiVersion,artifact,dependencies,roles,displayName,vendor}; unexpected key "${k}"`;

let parent;
let targetDir;
let pkgPath;
let pristinePkg;
let runGate;

beforeAll(async () => {
  parent = mkdtempSync(join(tmpdir(), "cli154-allowlist-"));
  // Scaffold a real artifact repo exactly the way `cinatra create-extension
  // artifact` does — this copies the shared gate into the generated repo.
  const res = scaffold({ kind: "artifact", name: "blog-post", targetParent: parent });
  expect(res.written).toContain("extension-kind-gate.mjs");
  targetDir = res.targetDir;
  pkgPath = join(targetDir, "package.json");
  pristinePkg = readFileSync(pkgPath, "utf8");
  // Import the COPIED gate — the byte the generated repo's CI runs — NOT
  // ../templates/_shared/extension-kind-gate.mjs.
  const copiedGate = join(targetDir, "extension-kind-gate.mjs");
  ({ runGate } = await import(pathToFileURL(copiedGate).href));
});

afterAll(() => {
  if (parent) rmSync(parent, { recursive: true, force: true });
});

// Reset the scaffolded manifest to pristine, apply `mutate` to its cinatra
// block, persist it, and run the COPIED gate against the scaffold — so each
// case is independent of the others' mutations.
function runWithCinatra(mutate) {
  const pkg = JSON.parse(pristinePkg);
  mutate(pkg.cinatra);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return runGate(targetDir);
}

describe("scaffolded artifact — copied gate honors the seven-key cinatra allowlist", () => {
  it("an otherwise-valid manifest with string-valued cinatra.displayName + cinatra.vendor passes", () => {
    const { kind, errors } = runWithCinatra((c) => {
      c.displayName = "Blog Post";
      c.vendor = "Cinatra";
    });
    expect(kind).toBe("artifact");
    expect(errors).toEqual([]);
  });

  it("an added unknown cinatra key fails with the exact seven-key allowlist error", () => {
    const { errors } = runWithCinatra((c) => {
      c.displayName = "Blog Post";
      c.vendor = "Cinatra";
      c.bogus = "x";
    });
    expect(errors).toContain(unexpectedKeyError("bogus"));
  });
});

// cinatra#1621/#1622 (artifact-ui S3): the COPIED gate ADMITS a versioned
// `cinatra.artifact.ui` renderer block (nested in the descriptor) and shallow
// pre-screens it, so an M1 renderer PR no longer red-fails on its own repo's
// standalone kind-gate. The authoritative derived validation (closed slot enum /
// exact abiVersion / generated sdkAbiRange) is the reusable conformance gate's
// job — proven ADMITTED here, exercised through the real scaffold copy path.
describe("scaffolded artifact — copied gate admits + shape-screens cinatra.artifact.ui", () => {
  const uiOK = {
    abiVersion: 1,
    sdkAbiRange: "^2.4.0",
    renderers: { detail: { entry: "./src/renderers/detail.tsx", propsApiVersion: 1 } },
  };

  it("an otherwise-valid manifest carrying a well-formed cinatra.artifact.ui passes", () => {
    const { kind, errors } = runWithCinatra((c) => {
      c.artifact.ui = JSON.parse(JSON.stringify(uiOK));
    });
    expect(kind).toBe("artifact");
    expect(errors).toEqual([]);
  });

  it("a ui renderer with an uncontained entry fails the copied gate's shape screen", () => {
    const { errors } = runWithCinatra((c) => {
      c.artifact.ui = { abiVersion: 1, sdkAbiRange: "^2.4.0", renderers: { detail: { entry: "../evil.tsx", propsApiVersion: 1 } } };
    });
    expect(errors.join("|")).toContain("path-contained subpath");
  });

  it("a ui renderer requesting a host port (extra key) fails the v1 NO-PORTS rule", () => {
    const { errors } = runWithCinatra((c) => {
      c.artifact.ui = { abiVersion: 1, sdkAbiRange: "^2.4.0", renderers: { detail: { entry: "./src/d.tsx", propsApiVersion: 1, ports: ["settings"] } } };
    });
    expect(errors.join("|")).toContain("NO host ports");
  });
});
