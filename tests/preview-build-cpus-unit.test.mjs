// The UNIT of the preview build's CPU lever, pinned across every
// operator-facing surface at once (cinatra-cli#229 review).
//
// `CINATRA_PREVIEW_BUILD_CPUS=<n>` reaches the image build as
// `--build-arg CINATRA_BUILD_CPUS=<n>`, which the checkout hands to next as
// `experimental.cpus`, and next assigns THAT STRAIGHT to the page-data /
// static-generation worker count. So `<n>` IS the worker count. Only the UNSET
// default is derived (`os.cpus().length - 1`).
//
// The wording these assertions replace said the value became "one fewer
// page-data worker". Under that reading an operator who wants 3 workers sets 4
// — and gets 4: precisely the over-fan-out cinatra-cli#228 exists to stop. A
// documentation unit that is wrong in this direction is a functional bug, so it
// is guarded like one, on EVERY surface an operator can read it from: the help
// banner (rendered from the real binary), the command descriptions, the
// resolver's refusal, the build-identity log and the CHANGELOG.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COMMAND_DESCRIPTORS } from "../src/command-table.mjs";
import {
  PREVIEW_BUILD_CPUS_ENV,
  buildPreviewImage,
  previewImageTag,
  resolveBuildCpus,
} from "../src/preview.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const BIN = path.join(ROOT, "bin", "cinatra.mjs");
const SHA = "a".repeat(40);

// Every phrasing that expresses the OLD, wrong unit. Any operator-facing string
// about this lever must be clean of all of them.
const WRONG_UNIT = /one fewer|one process fewer|process fewer than|fewer page-data|fewer worker|one less/i;

const readRepoFile = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const runHelp = (argv) => {
  const r = spawnSync(process.execPath, [BIN, ...argv], { encoding: "utf8", timeout: 60_000 });
  expect(r.error, `spawning ${argv.join(" ")} failed`).toBeFalsy();
  expect(r.status).toBe(0);
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

// The CHANGELOG paragraph for THIS lever, not the whole file: other entries
// legitimately talk about fewer cores, fewer steps, and so on.
const changelogLeverParagraph = () => {
  const paragraphs = readRepoFile("CHANGELOG.md").split(/\n\s*\n/);
  const hit = paragraphs.filter((p) => p.includes(PREVIEW_BUILD_CPUS_ENV));
  expect(hit.length, "expected the CHANGELOG to describe the CPU lever").toBeGreaterThan(0);
  return hit.join("\n\n");
};

describe("the preview build CPU lever is documented as a WORKER COUNT (cinatra-cli#229)", () => {
  it("the help banner states the count IS the worker count, with the -1 only as the unset default", () => {
    const out = runHelp(["instance", "--help"]);
    const block = out.slice(out.indexOf("BUILD WORKERS"));
    expect(out).toContain("BUILD WORKERS");
    expect(block).toMatch(/3 gives three workers/);
    // The derived default is named, and named ONLY as the unset default.
    expect(block).toMatch(/UNSET default is derived, as os\.cpus\(\)\.length - 1/);
    // The lever's own phase (non-blocking note of the same review).
    expect(out).toMatch(/does not fix a death DURING compile/);
  });

  it("the command descriptions carry the same unit, and none of the old phrasing", () => {
    const preview = COMMAND_DESCRIPTORS.filter((d) => d.id === "preview.create" || d.id === "preview.refresh");
    expect(preview).toHaveLength(2);
    const create = preview.find((d) => d.id === "preview.create").summary;
    expect(create).toMatch(/page-data worker COUNT directly/);
    expect(create).toMatch(/3 gives three workers, not two/);
    expect(create).not.toMatch(WRONG_UNIT);
    expect(preview.find((d) => d.id === "preview.refresh").summary).toMatch(/build worker count/);
    expect(preview.find((d) => d.id === "preview.refresh").summary).not.toMatch(WRONG_UNIT);
  });

  it("the resolver's refusal names workers, and never advertises a fewer-by-one conversion", () => {
    let err;
    try {
      resolveBuildCpus({ [PREVIEW_BUILD_CPUS_ENV]: "4 cores" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/BUILD WORKERS/);
    expect(err.message).toMatch(/COUNT of WORKERS/);
    expect(err.message).toMatch(/3 means three/);
    expect(err.message).not.toMatch(WRONG_UNIT);
  });

  it("3 in means THREE on the build identity line and in the forwarded build-arg — never two", () => {
    const lines = [];
    const calls = [];
    buildPreviewImage({
      tag: previewImageTag(SHA),
      contextDir: "/ctx",
      deps: {
        runDocker: (args) => (calls.push(args), { status: 0, stdout: "", stderr: "" }),
        buildControlEnv: { [PREVIEW_BUILD_CPUS_ENV]: "3" },
        log: (m) => lines.push(m),
      },
    });
    const out = lines.join("\n");
    expect(out).toMatch(/build workers: 3/);
    expect(out).not.toMatch(/build workers: 2\b/);
    expect(out).not.toMatch(WRONG_UNIT);
    // What the operator asked for is what the build is told, verbatim.
    const build = calls.find((c) => c[0] === "build");
    expect(build.join(" ")).toContain("--build-arg CINATRA_BUILD_CPUS=3");
    expect(build.join(" ")).not.toContain("CINATRA_BUILD_CPUS=2");
  });

  it("the CHANGELOG entry for the lever says three workers, not two", () => {
    const entry = changelogLeverParagraph();
    expect(entry).toMatch(/worker COUNT directly/);
    expect(entry).toMatch(/`3` gives three workers, not\s+two/);
    expect(entry).toMatch(/UNSET default is derived/);
    expect(entry).not.toMatch(WRONG_UNIT);
  });

  it("no CLI source describes this lever with the old unit", () => {
    for (const rel of ["src/preview.mjs", "src/index.mjs", "src/command-table.mjs", "src/install.mjs"]) {
      for (const [i, line] of readRepoFile(rel).split("\n").entries()) {
        // "not one fewer" is the CORRECTION, not the claim.
        if (/not one fewer/.test(line)) continue;
        expect(WRONG_UNIT.test(line), `${rel}:${i + 1} still uses the old unit: ${line.trim()}`).toBe(false);
      }
    }
  });
});
