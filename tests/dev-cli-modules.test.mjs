// Manifest-driven dev-CLI module discovery (cinatra#151 Stage 5c) pins.
//
// The CLI's tailscale provisioning reach into the extensions tree is now
// DISCOVERED from `cinatra.devCliModules` manifest declarations — the CLI
// names no extension. These tests pin: discovery against a fixture tree,
// the ERR_MODULE_NOT_FOUND absence posture (callers' degradation guards
// keep working), traversal confinement, and the REAL-TREE resolution of the
// tailscale keys when the connector is present.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as DCM from "../src/dev-cli-modules.mjs";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { symlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  discoverDevCliModulePath,
  loadDevCliModule,
  ERR_DEV_CLI_REPO_ROOT,
} from "../src/dev-cli-modules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let fixtureRoot = "";

function writePkg(scope, name, pkg, files = {}) {
  const dir = path.join(fixtureRoot, "extensions", scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "devcli-fixture-"));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("discoverDevCliModulePath", () => {
  it("finds the declared module file by KEY (no package name involved)", () => {
    writePkg("any-scope", "some-connector", {
      name: "@any-scope/some-connector",
      cinatra: { devCliModules: { "my-key": "./src/mod.mjs" } },
    }, { "src/mod.mjs": "export const ok = true;\n" });
    const p = discoverDevCliModulePath("my-key", fixtureRoot);
    expect(p).toBe(path.join(fixtureRoot, "extensions", "any-scope", "some-connector", "src", "mod.mjs"));
  });

  it("returns null when nothing declares the key or the tree is absent", () => {
    expect(discoverDevCliModulePath("my-key", fixtureRoot)).toBeNull();
    rmSync(fixtureRoot, { recursive: true, force: true });
    expect(discoverDevCliModulePath("my-key", fixtureRoot)).toBeNull();
  });

  it("REJECTS declared paths that traverse outside the declaring extension dir", () => {
    writePkg("s", "evil-connector", {
      name: "@s/evil-connector",
      cinatra: { devCliModules: { escape: "../../../package.json" } },
    });
    expect(discoverDevCliModulePath("escape", fixtureRoot)).toBeNull();
  });

  it("is deterministic: first sorted declarer wins on duplicate keys", () => {
    writePkg("s", "b-connector", {
      name: "@s/b-connector",
      cinatra: { devCliModules: { dup: "./b.mjs" } },
    }, { "b.mjs": "" });
    writePkg("s", "a-connector", {
      name: "@s/a-connector",
      cinatra: { devCliModules: { dup: "./a.mjs" } },
    }, { "a.mjs": "" });
    expect(discoverDevCliModulePath("dup", fixtureRoot)).toContain("a-connector");
  });
});

describe("loadDevCliModule", () => {
  it("imports the discovered module", async () => {
    writePkg("s", "mod-connector", {
      name: "@s/mod-connector",
      cinatra: { devCliModules: { loadme: "./src/loadme.mjs" } },
    }, { "src/loadme.mjs": "export const VALUE = 42;\n" });
    const mod = await loadDevCliModule("loadme", fixtureRoot);
    expect(mod.VALUE).toBe(42);
  });

  it("throws with code ERR_MODULE_NOT_FOUND when no declarer is present (degradation-guard parity)", async () => {
    await expect(loadDevCliModule("absent-key", fixtureRoot)).rejects.toMatchObject({
      code: "ERR_MODULE_NOT_FOUND",
    });
  });
});

// --- cinatra-cli#176: the PACKAGED-INSTALL resolution path ---------------------
//
// The shipped CLI lives at `<install>/node_modules/@cinatra-ai/cinatra/src/`
// and its published `files` list carries NO `extensions/` tree — that tree is a
// gitignored clone-back target inside the OPERATOR'S CHECKOUT. The retired
// default root (`import.meta.url` three-up, "packages/cli/src -> repo root")
// therefore landed on `<install>/node_modules` on every real install.
//
// These cases FABRICATE that installed layout in a temp dir and COPY the module
// under test into it: the retired default was derived from `import.meta.url`,
// so only a real on-disk relocation can pin it. Nothing here needs a cinatra
// checkout, so the suite runs identically in CI.
describe("packaged install (cinatra-cli#176) — no package-relative fallback", () => {
  let installRoot = "";
  let installedModuleUrl = "";
  let checkoutRoot = "";

  const HOSTNAME_KEY = "tailscale-hostname";

  beforeEach(() => {
    installRoot = mkdtempSync(path.join(tmpdir(), "cinatra-install-"));
    const installedPkgSrc = path.join(
      installRoot,
      "node_modules",
      "@cinatra-ai",
      "cinatra",
      "src",
    );
    mkdirSync(installedPkgSrc, { recursive: true });
    const installedModulePath = path.join(installedPkgSrc, "dev-cli-modules.mjs");
    copyFileSync(
      path.join(__dirname, "..", "src", "dev-cli-modules.mjs"),
      installedModulePath,
    );
    // Unique per test dir ⇒ a fresh module instance, never the ESM cache.
    installedModuleUrl = pathToFileURL(installedModulePath).href;

    // A DECOY declarer sitting EXACTLY where the retired three-up default
    // pointed: `<install>/node_modules/extensions/<scope>/<name>`. An installed
    // package may legitimately occupy that path; it must never be mistaken for
    // the trusted single source of truth for the predicted hostname.
    const decoyDir = path.join(
      installRoot,
      "node_modules",
      "extensions",
      "decoy-scope",
      "decoy-pkg",
    );
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(
      path.join(decoyDir, "package.json"),
      JSON.stringify({
        name: "@decoy-scope/decoy-pkg",
        cinatra: { devCliModules: { [HOSTNAME_KEY]: "./decoy.mjs" } },
      }),
    );
    writeFileSync(
      path.join(decoyDir, "decoy.mjs"),
      "export const deriveDevTailscaleHostname = () => 'decoy-hostname';\n",
    );

    // The operator's checkout — a SEPARATE tree, the only legitimate source.
    checkoutRoot = mkdtempSync(path.join(tmpdir(), "cinatra-checkout-"));
    const declarerDir = path.join(
      checkoutRoot,
      "extensions",
      "cinatra-ai",
      "some-connector",
    );
    mkdirSync(declarerDir, { recursive: true });
    writeFileSync(
      path.join(declarerDir, "package.json"),
      JSON.stringify({
        name: "@cinatra-ai/some-connector",
        cinatra: { devCliModules: { [HOSTNAME_KEY]: "./hostname.mjs" } },
      }),
    );
    writeFileSync(
      path.join(declarerDir, "hostname.mjs"),
      "export const deriveDevTailscaleHostname = () => 'checkout-hostname';\n",
    );
  });

  afterEach(() => {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(checkoutRoot, { recursive: true, force: true });
  });

  it("NEVER resolves a declarer from the package's own node_modules ancestor", async () => {
    const installed = await import(installedModuleUrl);
    expect(() => installed.discoverDevCliModulePath(HOSTNAME_KEY)).toThrow();
    // The decoy is on disk and IS discoverable when that path is scanned
    // deliberately — proving the case above fails for the right reason.
    const scannedDeliberately = installed.discoverDevCliModulePath(
      HOSTNAME_KEY,
      path.join(installRoot, "node_modules"),
    );
    expect(scannedDeliberately).toContain("decoy-pkg");
  });

  it("fails LOUD (and distinctly) when the caller threads no root", async () => {
    const installed = await import(installedModuleUrl);
    await expect(installed.loadDevCliModule(HOSTNAME_KEY)).rejects.toMatchObject({
      code: ERR_DEV_CLI_REPO_ROOT,
      cinatraDevCliRepoRootUnresolved: true,
    });
    // NOT the declarer-absent posture: `ensureDevPublicMcpUrl` degrades
    // gracefully on `cinatraDevCliDeclarerMissing`, and an installation defect
    // must never be masked as "the extension simply isn't installed".
    const err = await installed.loadDevCliModule(HOSTNAME_KEY).catch((e) => e);
    expect(err.cinatraDevCliDeclarerMissing).toBeUndefined();
    expect(err.code).not.toBe("ERR_MODULE_NOT_FOUND");
  });

  it.each([undefined, null, "", "   "])(
    "treats a blank root (%p) as unresolved rather than scanning a relative path",
    async (blank) => {
      const installed = await import(installedModuleUrl);
      expect(() => installed.discoverDevCliModulePath(HOSTNAME_KEY, blank)).toThrow(
        /RESOLVED checkout/,
      );
    },
  );

  it("resolves the OPERATOR'S checkout declarer when the root is threaded through", async () => {
    const installed = await import(installedModuleUrl);
    const resolved = installed.discoverDevCliModulePath(HOSTNAME_KEY, checkoutRoot);
    expect(resolved).toBe(
      path.join(
        checkoutRoot,
        "extensions",
        "cinatra-ai",
        "some-connector",
        "hostname.mjs",
      ),
    );
    const mod = await installed.loadDevCliModule(HOSTNAME_KEY, checkoutRoot);
    expect(mod.deriveDevTailscaleHostname()).toBe("checkout-hostname");
  });

  it("keeps the declarer-absent posture for an extension-empty checkout", async () => {
    const installed = await import(installedModuleUrl);
    const emptyCheckout = mkdtempSync(path.join(tmpdir(), "cinatra-empty-"));
    try {
      await expect(
        installed.loadDevCliModule(HOSTNAME_KEY, emptyCheckout),
      ).rejects.toMatchObject({
        code: "ERR_MODULE_NOT_FOUND",
        cinatraDevCliDeclarerMissing: true,
      });
    } finally {
      rmSync(emptyCheckout, { recursive: true, force: true });
    }
  });
});

describe("real-tree resolution (the tailscale connector's declaration)", () => {
  // Presence-aware: the extensions tree is a gitignored clone-back target.
  // When present (dev/CI clone-back), the tailscale keys MUST resolve to real
  // files; when absent, discovery returns null (the fresh-checkout posture).
  it("tailscale-api / tailscale-hostname resolve to on-disk modules when the tree is present", () => {
    const extRoot = path.join(REAL_REPO_ROOT, "extensions");
    const api = discoverDevCliModulePath("tailscale-api", REAL_REPO_ROOT);
    const hostname = discoverDevCliModulePath("tailscale-hostname", REAL_REPO_ROOT);
    if (!existsSync(extRoot) || api === null) {
      expect(api).toBeNull();
      expect(hostname).toBeNull();
      return;
    }
    expect(existsSync(api)).toBe(true);
    expect(existsSync(hostname)).toBe(true);
  });
});


// The single loader keeps its short-circuit, and the multi-declarer census is
// bounded by regular file, size and count: a manifest that would block or that
// cannot be read within the bounds is never a silent skip of a declarer.
describe("dev-cli module discovery is bounded (cinatra-cli#307)", () => {
  const moduleUrl = new URL("../src/dev-cli-modules.mjs", import.meta.url).href;
  /** Run `call` (an expression over `M`, the module) in a separate node process bounded at 5 s. */
  async function inChild(call) {
    const script = `const M = await import(${JSON.stringify(moduleUrl)});\n` +
      `try { console.log("ok " + JSON.stringify(${call})); } catch (err) { console.log("threw " + (err.code ?? "") + " " + err.message); }\n`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 5 s"); }, 5_000);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    return { code, out: out.trim() };
  }
  function fifoManifest(scope, name) {
    const dir = path.join(fixtureRoot, "extensions", scope, name);
    mkdirSync(dir, { recursive: true });
    const made = spawnSync("mkfifo", [path.join(dir, "package.json")]);
    expect(made.status).toBe(0);
  }

  it("the single loader stops at the first declarer: a later manifest that would block is never opened", async () => {
    writePkg("a-scope", "first", { cinatra: { devCliModules: { "my-key": "./m.mjs" } } }, { "m.mjs": "export const x = 1;\n" });
    fifoManifest("b-scope", "blocking");
    const r = await inChild(`M.discoverDevCliModulePath("my-key", ${JSON.stringify(fixtureRoot)})`);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`ok ${JSON.stringify(path.join(fixtureRoot, "extensions", "a-scope", "first", "m.mjs"))}`);
  }, 15_000);

  it("the multi-declarer census refuses a manifest that is not a regular file, without blocking on it", async () => {
    writePkg("a-scope", "first", { cinatra: { devCliModules: { "my-key": "./m.mjs" } } });
    fifoManifest("b-scope", "blocking");
    const r = await inChild(`M.discoverAllDevCliModulePaths("my-key", ${JSON.stringify(fixtureRoot)})`);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`threw ${DCM.ERR_DEV_CLI_DECLARER_CENSUS} the manifest of ${path.join("extensions", "b-scope", "blocking")} is not a regular file.`);
  }, 15_000);

  it("the census refuses an oversized manifest, a symlinked package dir and more packages than its bound", () => {
    writePkg("a-scope", "big", { cinatra: { devCliModules: { "my-key": "./m.mjs" } }, pad: "x".repeat(DCM.DECLARER_CENSUS_MAX_MANIFEST_BYTES) });
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`the manifest of ${path.join("extensions", "a-scope", "big")} is larger than`);
    rmSync(path.join(fixtureRoot, "extensions"), { recursive: true, force: true });
    writePkg("a-scope", "real", { cinatra: { devCliModules: { "my-key": "./m.mjs" } } });
    symlinkSync(path.join(fixtureRoot, "extensions", "a-scope", "real"), path.join(fixtureRoot, "extensions", "a-scope", "linked"));
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`${path.join("extensions", "a-scope", "linked")} is a symbolic link`);
    rmSync(path.join(fixtureRoot, "extensions"), { recursive: true, force: true });
    for (let i = 0; i <= DCM.DECLARER_CENSUS_MAX_PACKAGES; i++) writePkg("many", `p${String(i).padStart(4, "0")}`, { name: `p${i}` });
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`more than ${DCM.DECLARER_CENSUS_MAX_PACKAGES} packages`);
  });

  it("the census bounds every dir it examines: package dirs without a manifest and directory entries count against its bounds", () => {
    for (let i = 0; i <= DCM.DECLARER_CENSUS_MAX_PACKAGES; i++) {
      mkdirSync(path.join(fixtureRoot, "extensions", "empty", `d${String(i).padStart(4, "0")}`), { recursive: true });
    }
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`more than ${DCM.DECLARER_CENSUS_MAX_PACKAGES} packages`);
    rmSync(path.join(fixtureRoot, "extensions"), { recursive: true, force: true });
    const files = path.join(fixtureRoot, "extensions", "files");
    mkdirSync(files, { recursive: true });
    for (let i = 0; i <= DCM.DECLARER_CENSUS_MAX_ENTRIES; i++) writeFileSync(path.join(files, `f${i}`), "");
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`more than ${DCM.DECLARER_CENSUS_MAX_ENTRIES} entries`);
  });

  it("the census reads a malformed manifest as a failure, an absent one as no package, and names an optional declarer", () => {
    writePkg("a-scope", "opt", { cinatra: { devCliModules: { "my-key": "./m.mjs" }, myOptional: true } });
    writePkg("a-scope", "req", { cinatra: { devCliModules: { "my-key": "./m.mjs" }, myOptional: "true" } });
    mkdirSync(path.join(fixtureRoot, "extensions", "a-scope", "no-manifest"), { recursive: true });
    expect(DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot, { optionalFlag: "myOptional" }).map((d) => [d.packageDir, d.optional]))
      .toEqual([[path.join("extensions", "a-scope", "opt"), true], [path.join("extensions", "a-scope", "req"), false]]);
    writeFileSync(path.join(fixtureRoot, "extensions", "a-scope", "no-manifest", "package.json"), "{ not json");
    expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow(`the manifest of ${path.join("extensions", "a-scope", "no-manifest")} is not valid JSON.`);
  });
});

describe("the declarer census never follows a symlinked extensions root (cinatra-cli#307)", () => {
  it("throws when extensions/ itself is a symbolic link", () => {
    const real = mkdtempSync(path.join(tmpdir(), "devcli-real-"));
    mkdirSync(path.join(real, "a-scope", "pkg"), { recursive: true });
    writeFileSync(path.join(real, "a-scope", "pkg", "package.json"), JSON.stringify({ cinatra: { devCliModules: { "my-key": "./m.mjs" } } }));
    symlinkSync(real, path.join(fixtureRoot, "extensions"));
    try {
      expect(() => DCM.discoverAllDevCliModulePaths("my-key", fixtureRoot)).toThrow("extensions is a symbolic link; the census does not follow it.");
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});
