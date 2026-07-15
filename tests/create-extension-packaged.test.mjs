// The published `@cinatra-ai/cinatra` tarball MUST contain everything
// `cinatra create-extension` needs at runtime (cinatra#402). `npm pack` silently
// drops `.gitignore`/`.npmrc` even from a `files`-listed directory, which is why
// the templates store them as `gitignore`/`npmrc` sentinels — this test is the
// load-bearing guard that (a) the authoring core ships, (b) every template kind
// ships, (c) the sentinel dotfiles ship (so the renderer can restore them), and
// (d) NO real `.gitignore`/`.npmrc` lurks in templates/ (which npm would drop,
// silently breaking a globally-installed scaffold).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.join(HERE, "..");

function packlist() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG_ROOT, encoding: "utf8" });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

const KINDS = ["agent", "connector", "artifact", "skill"];

describe("@cinatra-ai/cinatra tarball ships the create-extension authoring assets", () => {
  const files = packlist();

  it("ships the shared authoring core under src/authoring/", () => {
    for (const m of ["scaffold", "kinds", "naming", "template", "cli"]) {
      expect(files, `src/authoring/${m}.mjs must ship`).toContain(`src/authoring/${m}.mjs`);
    }
  });

  it("ships the shared kind gate template", () => {
    expect(files).toContain("templates/_shared/extension-kind-gate.mjs");
  });

  it("ships a package.json + README for every kind template", () => {
    for (const kind of KINDS) {
      expect(files, `${kind} template package.json`).toContain(`templates/${kind}/package.json`);
      expect(files, `${kind} template README`).toContain(`templates/${kind}/README.md`);
    }
  });

  it("ships the npm-hostile dotfiles as non-dotted sentinels (so they survive packing)", () => {
    for (const kind of KINDS) {
      expect(files, `${kind} gitignore sentinel`).toContain(`templates/${kind}/gitignore`);
      expect(files, `${kind} npmrc sentinel`).toContain(`templates/${kind}/npmrc`);
    }
  });

  it("does NOT ship a literal templates/**/.gitignore or .npmrc (npm would drop them)", () => {
    // A real dotted file in templates/ is the silent-breakage trap: npm excludes
    // it, the global install lacks it, and `create-extension` scaffolds an
    // incomplete repo. The sentinel-rename is the only correct shape.
    const dotted = files.filter((f) => /templates\/.*\/\.(gitignore|npmrc)$/.test(f));
    expect(dotted, `no dotted gitignore/npmrc should be in the packlist, saw: ${dotted.join(", ")}`).toEqual([]);
  });

  it("ships the connector migrations template", () => {
    const mig = files.filter((f) => /^templates\/connector\/cinatra\/migrations\//.test(f));
    expect(mig.length, "connector migrations template must ship").toBeGreaterThan(0);
  });
});
