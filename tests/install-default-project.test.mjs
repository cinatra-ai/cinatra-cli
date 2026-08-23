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
    // cinatra-cli#232 review R4: Compose DELETES characters outside
    // `[a-z0-9_-]`; it does not substitute them. This expectation used to read
    // "my_app" and locked the divergence in.
    expect(legacyBasenameProject("/Users/me/Code/My.App")).toBe("myapp");
  });

  // The reclaim gate (cinatra-cli#232) reads this name's EMPTINESS as permission
  // to release a live stack's port reservation, so every shape where the old
  // collapse-runs-to-`_` rule diverged from Compose is pinned here. The values
  // are Compose's own, read off `docker compose config` in a dir of each shape.
  it("DELETES invalid characters exactly as Compose does (never substitutes `_`)", () => {
    expect(legacyBasenameProject("/Users/me/Code/cinatra.dev")).toBe("cinatradev");
    expect(legacyBasenameProject("/Users/me/Code/My Instance")).toBe("myinstance");
    expect(legacyBasenameProject("/Users/me/Code/cinatra+two")).toBe("cinatratwo");
    expect(legacyBasenameProject("/Users/me/Code/release.1.2.3")).toBe("release123");
  });

  // The other edge of the same rule: a purely LEADING invalid run agrees under
  // both derivations, because the leading `_`/`-` trim removes what either rule
  // produced. Pinning it keeps a future "fix" from breaking the agreeing shape.
  it("agrees on a purely LEADING invalid run (the trim swallows it either way)", () => {
    expect(legacyBasenameProject("/Users/me/Code/.github")).toBe("github");
    expect(legacyBasenameProject("/Users/me/Code/...cinatra")).toBe("cinatra");
    expect(legacyBasenameProject("/Users/me/Code/--edge")).toBe("edge");
  });

  // Nothing derivable at all. The reclaim gate treats this as its THIRD state
  // (could-not-inspect → refuse), never as an all-clear.
  it("yields an EMPTY name when the basename holds no usable character", () => {
    expect(legacyBasenameProject("/Users/me/Code/...")).toBe("");
    expect(legacyBasenameProject("/Users/me/Code/@@@")).toBe("");
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
