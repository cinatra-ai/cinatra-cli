// cinatra-cli#35 — default Compose project name + ownership preflight (PURE).
//
// These are the unit-of-test for the data-risk fix: the default `up` must use an
// EXPLICIT instance-scoped `-p` (never the dir basename), ADOPT a legacy stack
// already rooted here (keep volumes stable), and REFUSE when the candidate
// project / its named volumes belong to a DIFFERENT checkout — INCLUDING a
// STOPPED sibling (which holds no ports, so the port preflight misses it).

import { describe, expect, it } from "vitest";

import {
  computeDefaultProject,
  legacyBasenameProject,
  decideDefaultProjectOwnership,
} from "../src/install.mjs";

// A `docker ps -a` inspect row owning a project, rooted at a working_dir.
const containerRow = (project, workingDir) => ({
  Config: {
    Labels: {
      "com.docker.compose.project": project,
      ...(workingDir ? { "com.docker.compose.project.working_dir": workingDir } : {}),
    },
  },
});

describe("computeDefaultProject (cinatra-cli#35)", () => {
  it("derives `cinatra_<slug>` from the dir basename", () => {
    expect(computeDefaultProject({}, "/Users/me/Code/cinatra")).toBe("cinatra_cinatra");
    expect(computeDefaultProject({}, "/Users/me/Code/my-app")).toBe("cinatra_my_app");
  });

  it("honours an explicit --instance over the basename", () => {
    expect(computeDefaultProject({ instance: "alpha" }, "/x/cinatra")).toBe("cinatra_alpha");
  });

  it("two DIFFERENT dirs both named `cinatra` produce the SAME naive name (naming alone is NOT the guard)", () => {
    const a = computeDefaultProject({}, "/Users/ordnas/Code/cinatra-ai/cinatra");
    const b = computeDefaultProject({}, "/Users/ordnas/Code/_TEST/cinatra");
    expect(a).toBe("cinatra_cinatra");
    expect(b).toBe("cinatra_cinatra");
    expect(a).toBe(b); // → the ownership preflight is what must REFUSE the collision.
  });
});

describe("legacyBasenameProject (cinatra-cli#35)", () => {
  it("mirrors compose's basename-derived project (the legacy default behavior)", () => {
    expect(legacyBasenameProject("/Users/me/Code/cinatra")).toBe("cinatra");
    expect(legacyBasenameProject("/Users/me/Code/_TEST")).toBe("test");
    expect(legacyBasenameProject("/Users/me/Code/My.App")).toBe("my_app");
  });
});

describe("decideDefaultProjectOwnership (cinatra-cli#35)", () => {
  const targetDir = "/Users/ordnas/Code/_TEST/cinatra";
  const candidateProject = "cinatra_cinatra";
  const legacyProject = "cinatra";

  it("USE-DEFAULT for a brand-new install (no existing project/volume)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      volumeRows: [],
    });
    expect(d.action).toBe("use-default");
    expect(d.project).toBe(candidateProject);
  });

  it("ADOPT-LEGACY when a legacy basename project is rooted at THIS dir (keep volumes stable)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      // A legacy `cinatra` stack whose containers' working_dir IS this checkout.
      containerRows: [containerRow(legacyProject, targetDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("adopt-legacy");
    expect(d.project).toBe(legacyProject); // keep `-p cinatra` → stable named volumes
  });

  it("REFUSE when the candidate project exists at a DIFFERENT checkout (running)", () => {
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(candidateProject, otherDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("refuse");
    expect(d.conflictDir).toBe(otherDir);
    expect(d.reason).toMatch(/different checkout/);
  });

  it("REFUSE for a STOPPED sibling at a different dir (ps -a row, holds no ports)", () => {
    // The whole point of #35: a STOPPED stack passes the port preflight, yet the
    // project-name collision still fires. The inspector covers `docker ps -a`, so
    // a stopped container's working_dir is still attributed.
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      // (A stopped container still carries its compose labels in `docker inspect`.)
      containerRows: [containerRow(candidateProject, otherDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("refuse");
    expect(d.conflictDir).toBe(otherDir);
  });

  it("does NOT refuse when the candidate project is OUR OWN (idempotent re-run)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(candidateProject, targetDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("use-default");
    expect(d.project).toBe(candidateProject);
  });

  it("REFUSE when a candidate named VOLUME is owned by a different checkout (volume label attribution)", () => {
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      // A named volume of the candidate project rooted at a DIFFERENT checkout.
      volumeRows: [{ name: `${candidateProject}_postgres`, project: candidateProject, workingDir: otherDir }],
    });
    expect(d.action).toBe("refuse");
    expect(d.conflictDir).toBe(otherDir);
    expect(d.reason).toMatch(/named volume/);
  });

  it("REFUSE on a name-matching volume owned by a FOREIGN project (project-name-only label, no working_dir)", () => {
    // Compose may label a named volume with the project name ONLY (no
    // working_dir) — a name-matching volume owned by a DIFFERENT project is still
    // a conflict (risk #2: coarser-but-safe attribution).
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      volumeRows: [{ name: `${candidateProject}_postgres`, project: "cinatra_other", workingDir: null }],
    });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/different project/);
  });

  it("does NOT refuse for a candidate volume that IS ours (own working_dir)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      volumeRows: [{ name: `${candidateProject}_postgres`, project: candidateProject, workingDir: targetDir }],
    });
    expect(d.action).toBe("use-default");
  });

  // ── codex blocker #2: a candidate-named volume with NO working_dir and the
  //    candidate project label is a FOREIGN preserved volume unless proven ours.
  it("REFUSE a candidate volume with NO working_dir when ownership is NOT proven (codex blocker #2)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      // Same project label, NO working_dir → could be a different `cinatra`
      // checkout's preserved volume (two dirs both → cinatra_cinatra).
      volumeRows: [{ name: `${candidateProject}_postgres`, project: candidateProject, workingDir: null }],
      ownsCandidate: false,
    });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/unverifiable owner/);
  });

  it("does NOT refuse that same unknown-dir volume when ownership IS proven (registry/marker → ownsCandidate)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [],
      volumeRows: [{ name: `${candidateProject}_postgres`, project: candidateProject, workingDir: null }],
      ownsCandidate: true, // a registry/marker row for THIS dir records the candidate project.
    });
    expect(d.action).toBe("use-default");
  });

  // ── codex blocker #2 (containers): an unknown-dir candidate container is OURS
  //    only when proven; otherwise refuse.
  it("REFUSE a candidate container with NO working_dir when ownership is NOT proven", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(candidateProject, null)],
      volumeRows: [],
      ownsCandidate: false,
    });
    expect(d.action).toBe("refuse");
  });

  it("treats an unknown-dir candidate container as OUR ghost when proven (ownsCandidate)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(candidateProject, null)],
      volumeRows: [],
      ownsCandidate: true,
    });
    expect(d.action).toBe("use-default");
  });

  // ── codex blocker #3: a legacy basename project with a MIXED owner set must
  //    NOT be adopted — refuse.
  it("REFUSE (not adopt) a legacy project rooted here that ALSO has a foreign owner (codex blocker #3)", () => {
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [
        containerRow(legacyProject, targetDir),
        containerRow(legacyProject, otherDir), // same legacy project, DIFFERENT dir
      ],
      volumeRows: [],
    });
    expect(d.action).toBe("refuse");
    expect(d.reason).toMatch(/legacy basename project/);
  });

  it("REFUSE a legacy project rooted here that ALSO has an UNKNOWN-dir owner (codex blocker #3)", () => {
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [
        containerRow(legacyProject, targetDir),
        containerRow(legacyProject, null), // unattributable second owner
      ],
      volumeRows: [],
    });
    expect(d.action).toBe("refuse");
  });

  // eng#513 real-host regression (v0.1.7 closeout CLI sweep): a legacy `cinatra`
  // stack from a DIFFERENT checkout — with NO legacy containers rooted here —
  // refused EVERY install into a dir named `cinatra` (the CLI's own suggested
  // default dir), even with an explicit `--instance` slug, and the refusal
  // message advised the very `--instance` flag already in use. Nothing is
  // adoptable in that state and the candidate `-p` project name is distinct, so
  // the candidate stack cannot touch the foreign legacy stack.
  it("USE-DEFAULT when the legacy project exists ONLY at a foreign checkout (nothing to adopt; distinct -p cannot hijack)", () => {
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(legacyProject, otherDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("use-default");
    expect(d.project).toBe(candidateProject);
  });

  it("USE-DEFAULT for an explicit --instance candidate when the legacy project is foreign-only (the eng#513 repro shape)", () => {
    const otherDir = "/Users/ordnas/Code/cinatra-ai/.claude/scratch/lane-1003/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject: "cinatra_e2e513",
      legacyProject,
      targetDir,
      containerRows: [containerRow(legacyProject, otherDir)],
      volumeRows: [],
    });
    expect(d.action).toBe("use-default");
    expect(d.project).toBe("cinatra_e2e513");
  });

  it("still REFUSES when the only legacy owner is UNATTRIBUTABLE (could be OUR OWN old stack — codex convergence)", () => {
    // No working_dir label means the legacy stack cannot be proven foreign: it
    // could be THIS checkout's own old legacy stack, and falling through would
    // silently start a fresh candidate stack next to (and orphan) its data.
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [containerRow(legacyProject, null)],
      volumeRows: [],
    });
    expect(d.action).toBe("refuse");
  });

  it("ADOPT-LEGACY when the legacy project is rooted ONLY here, even if a SEPARATE (foreign) candidate project also exists", () => {
    // A legacy stack is rooted HERE (and nowhere else) and a separate (foreign)
    // candidate-named project also exists at another dir — adopting the legacy
    // stack we exclusively own here is the safe choice (it keeps OUR volumes).
    const otherDir = "/Users/ordnas/Code/cinatra-ai/cinatra";
    const d = decideDefaultProjectOwnership({
      candidateProject,
      legacyProject,
      targetDir,
      containerRows: [
        containerRow(legacyProject, targetDir),
        containerRow(candidateProject, otherDir),
      ],
      volumeRows: [],
    });
    expect(d.action).toBe("adopt-legacy");
    expect(d.project).toBe(legacyProject);
  });
});
