// Manifest-driven dev-CLI module discovery (cinatra#151 Stage 5c) pins.
//
// The CLI's tailscale provisioning reach into the extensions tree is now
// DISCOVERED from `cinatra.devCliModules` manifest declarations — the CLI
// names no extension. These tests pin: discovery against a fixture tree,
// the ERR_MODULE_NOT_FOUND absence posture (callers' degradation guards
// keep working), traversal confinement, and the REAL-TREE resolution of the
// tailscale keys when the connector is present.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
