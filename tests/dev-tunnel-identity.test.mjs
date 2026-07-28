// Fail-closed dev-tunnel identity (cinatra#2172).
//
// THE REGRESSION: `cinatra instance tunnel` keyed ALL of its shared runtime
// state on a hardcoded reserved slug, and the hostname derivation fell through
// to the reserved `cinatra-main` identity for anything that matched neither
// isolation model. Any unregistered instance therefore provisioned under the
// dev main's identity and overwrote the dev main's serve config, rendered
// compose file and compose project.
//
// What this suite pins:
//   1. identity → slug is UNIQUE PER IDENTITY, valid, and reserves `dev-main`
//      for the declared main only;
//   2. runtime-directory ownership refuses a foreign or unproven directory;
//   3. an OLD/unknown identity helper fails closed (never falls back to the
//      retired derivation);
//   4. END-TO-END: `instance tunnel start` on an unregistered instance is
//      REFUSED and the reserved runtime directory is left untouched.
//
// (4) drives the real `runCli` against a synthetic checkout whose extensions
// tree declares a fixture identity helper, with HOME redirected to a tmpdir —
// so it touches no Docker, no Tailscale, and no real runtime state.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { isValidSlug } from "../src/clone-registry.mjs";
import {
  assertDevTunnelRuntimeDirOwnership,
  classifyDevTunnelIdentityFromModule,
  DEV_MAIN_SLUG,
  DEV_TUNNEL_IDENTITY_CONTRACT_VERSION,
  DEV_TUNNEL_MANIFEST_VERSION,
  devTunnelManifestPath,
  devTunnelRuntimeSlug,
  readDevTunnelManifest,
  claimDevTunnelRuntimeDir,
} from "../src/dev-tunnel-identity.mjs";
import { makeFakeCheckout } from "./helpers/fake-checkout.mjs";
import { runCli } from "../src/index.mjs";

const V = DEV_TUNNEL_IDENTITY_CONTRACT_VERSION;

function ok(kind, key, hostname) {
  return { version: V, ok: true, kind, key, hostname, code: null, reason: null };
}

// --- 1. identity → runtime slug ------------------------------------------

describe("devTunnelRuntimeSlug", () => {
  it("reserves `dev-main` for the DECLARED main identity only", () => {
    expect(devTunnelRuntimeSlug(ok("main", "main:h:5432/db", "cinatra-main"))).toBe(
      DEV_MAIN_SLUG,
    );
    // No other identity can ever produce the reserved slug.
    for (const identity of [
      ok("clone", "clone:cinatra_clone_main", "cinatra-clone-main"),
      ok("schema", "schema:cinatra_main", "cinatra-main"),
    ]) {
      expect(devTunnelRuntimeSlug(identity)).not.toBe(DEV_MAIN_SLUG);
    }
  });

  it("produces a VALID slug for long and awkward hostnames", () => {
    const long = `cinatra-clone-${"x".repeat(60)}`.slice(0, 63);
    for (const identity of [
      ok("clone", "clone:cinatra_clone_alpha", "cinatra-clone-alpha"),
      ok("clone", `clone:${long}`, long),
      ok("schema", "schema:cinatra_9", "cinatra-9"),
      ok("schema", "schema:cinatra_-", "cinatra-dev"),
    ]) {
      const slug = devTunnelRuntimeSlug(identity);
      expect(isValidSlug(slug)).toBe(true);
      expect(slug.length).toBeLessThanOrEqual(30);
    }
  });

  it("is deterministic and separates identities that share a HOSTNAME", () => {
    // Sanitisation collapses `_` and `-`, so these two schemas produce the SAME
    // Tailscale hostname. Their runtime state must still not be shared.
    const a = ok("schema", "schema:cinatra_a_b", "cinatra-a-b");
    const b = ok("schema", "schema:cinatra_a-b", "cinatra-a-b");
    expect(devTunnelRuntimeSlug(a)).toBe(devTunnelRuntimeSlug(a));
    expect(devTunnelRuntimeSlug(a)).not.toBe(devTunnelRuntimeSlug(b));
  });

  it("refuses to produce a slug for an instance with NO identity", () => {
    expect(() =>
      devTunnelRuntimeSlug({
        version: V,
        ok: false,
        kind: "unregistered",
        key: null,
        hostname: null,
        code: "tailscale.unregistered_dev_identity",
        reason: "nope",
      }),
    ).toThrow(/sanctioned identity/i);
  });

  it("refuses the reserved slug to a `main` kind without an endpoint-scoped key", () => {
    expect(() => devTunnelRuntimeSlug(ok("main", "whatever", "cinatra-main"))).toThrow(
      /endpoint-scoped key/,
    );
  });
});

// --- 2. runtime-directory ownership ---------------------------------------

describe("dev tunnel runtime-directory ownership", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "tunnel-owner-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a manifest and accepts the SAME identity", () => {
    const identity = ok("schema", "schema:cinatra_lane", "cinatra-lane");
    const slug = devTunnelRuntimeSlug(identity);
    const runtimeDir = path.join(dir, slug);
    claimDevTunnelRuntimeDir({ runtimeDir, identity });
    expect(readDevTunnelManifest(runtimeDir)).toMatchObject({
      version: DEV_TUNNEL_MANIFEST_VERSION,
      kind: "schema",
      key: "schema:cinatra_lane",
      slug,
    });
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity }),
    ).not.toThrow();
  });

  it("REFUSES a directory owned by a different identity", () => {
    const owner = ok("schema", "schema:cinatra_lane_a", "cinatra-lane-a");
    const runtimeDir = path.join(dir, "shared");
    claimDevTunnelRuntimeDir({ runtimeDir, identity: owner });
    const intruder = ok("schema", "schema:cinatra_lane_b", "cinatra-lane-b");
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({ runtimeDir, identity: intruder }),
    ).toThrow(/belongs to a DIFFERENT dev instance/);
  });

  it("REFUSES an unsupported manifest version", () => {
    const runtimeDir = path.join(dir, "future");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      devTunnelManifestPath(runtimeDir),
      JSON.stringify({ version: DEV_TUNNEL_MANIFEST_VERSION + 1, key: "x" }),
    );
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({
        runtimeDir,
        identity: ok("schema", "x", "cinatra-x"),
      }),
    ).toThrow(/unsupported version/);
  });

  it("the CLAIM is exclusive — a second identity cannot take an already-claimed dir", () => {
    const owner = ok("schema", "schema:h:5432/db#cinatra_a", "cinatra-a");
    const runtimeDir = path.join(dir, "contended");
    expect(claimDevTunnelRuntimeDir({ runtimeDir, identity: owner })).toMatchObject(
      { claimed: true },
    );
    // Re-claiming by the SAME identity is idempotent, not an error.
    expect(claimDevTunnelRuntimeDir({ runtimeDir, identity: owner })).toMatchObject(
      { claimed: false },
    );
    // A different identity loses.
    const intruder = ok("schema", "schema:h:5432/db#cinatra_b", "cinatra-b");
    expect(() =>
      claimDevTunnelRuntimeDir({ runtimeDir, identity: intruder }),
    ).toThrow(/belongs to a DIFFERENT dev instance/);
    // The winner's manifest survived intact.
    expect(readDevTunnelManifest(runtimeDir)).toMatchObject({ key: owner.key });
  });

  it("REFUSES a symlinked runtime path (state must not be redirected)", () => {
    const real = path.join(dir, "real-target");
    mkdirSync(real, { recursive: true });
    const link = path.join(dir, "linked");
    symlinkSync(real, link);
    const identity = ok("schema", "schema:h:5432/db#cinatra_l", "cinatra-l");
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({ runtimeDir: link, identity }),
    ).toThrow(/is a symlink/);
    expect(() =>
      claimDevTunnelRuntimeDir({ runtimeDir: link, identity }),
    ).toThrow(/is a symlink/);
  });

  it("REFUSES to adopt pre-manifest state that was provisioned for ANOTHER node", () => {
    // The reserved directory may adopt state that predates ownership tracking,
    // but only when the state itself does not contradict this identity.
    const legacy = path.join(dir, DEV_MAIN_SLUG);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      path.join(legacy, "tailscale-serve.json"),
      JSON.stringify({ TCP: {}, Web: { "cinatra-someone-else.tailnet.ts.net:443": {} } }),
    );
    const identity = ok("main", "main:h:5432/db", "cinatra-main");
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({ runtimeDir: legacy, identity }),
    ).toThrow(/provisioned for a DIFFERENT node/);
    expect(() => claimDevTunnelRuntimeDir({ runtimeDir: legacy, identity })).toThrow(
      /provisioned for a DIFFERENT node/,
    );
  });

  it("REFUSES to adopt manifest-less state with an FQDN-placeholder serve config (cinatra-cli#177 fail-closed)", () => {
    // Post-#177 serve configs are identity-independent (`${TS_CERT_DOMAIN}`
    // keys, no hostname) — but post-#177 provisioning always writes the
    // ownership manifest BEFORE the serve config, so a manifest-less directory
    // holding a placeholder-keyed config can only be tampered/hand-assembled
    // state. It names no node, so adoption must refuse, not assume ownership.
    const tampered = path.join(dir, DEV_MAIN_SLUG);
    mkdirSync(tampered, { recursive: true });
    writeFileSync(
      path.join(tampered, "tailscale-serve.json"),
      JSON.stringify({
        TCP: { 443: { HTTPS: true } },
        Web: { "${TS_CERT_DOMAIN}:443": { Handlers: { "/": { Proxy: "http://host.docker.internal:3000" } } } },
        AllowFunnel: { "${TS_CERT_DOMAIN}:443": true },
      }),
    );
    const identity = ok("main", "main:h:5432/db", "cinatra-main");
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({ runtimeDir: tampered, identity }),
    ).toThrow(/provisioned for a DIFFERENT node/);
    expect(() => claimDevTunnelRuntimeDir({ runtimeDir: tampered, identity })).toThrow(
      /provisioned for a DIFFERENT node/,
    );
  });

  it("RECORDS an adoption of pre-manifest state instead of stamping it silently", () => {
    const legacy = path.join(dir, DEV_MAIN_SLUG);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "compose.yml"), "services: {}\n");
    const identity = ok("main", "main:h:5432/db", "cinatra-main");
    const result = claimDevTunnelRuntimeDir({
      runtimeDir: legacy,
      identity,
    });
    expect(result).toMatchObject({ claimed: true, adoptedPreManifestState: true });
    expect(readDevTunnelManifest(legacy)).toMatchObject({
      key: "main:h:5432/db",
      adopted: "pre-manifest-state",
    });
  });

  it("adopts a pre-manifest directory ONLY for the reserved main slug", () => {
    const legacy = path.join(dir, DEV_MAIN_SLUG);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "compose.yml"), "services: {}\n");
    // The declared main adopts its own already-provisioned state.
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({
        runtimeDir: legacy,
        identity: ok("main", "main:h:5432/db", "cinatra-main"),
      }),
    ).not.toThrow();
    // Anything else refuses rather than writing over unproven state.
    const other = path.join(dir, "dev-lane-abc");
    mkdirSync(other, { recursive: true });
    expect(() =>
      assertDevTunnelRuntimeDirOwnership({
        runtimeDir: other,
        identity: ok("schema", "schema:cinatra_lane", "cinatra-lane"),
      }),
    ).toThrow(/no ownership manifest/);
  });
});

// --- 3. cross-version helper safety ---------------------------------------

describe("classifyDevTunnelIdentityFromModule", () => {
  it("fails closed on an OLD helper that only exports the retired derivation", () => {
    const oldHelper = { deriveDevTailscaleHostname: () => "cinatra-main" };
    expect(() =>
      classifyDevTunnelIdentityFromModule(oldHelper, { dbUrl: "x", schema: "" }),
    ).toThrow(/too old/);
  });

  it("fails closed on an unknown contract version", () => {
    const futureHelper = {
      classifyDevTailscaleIdentity: () => ({ version: V + 1, ok: true, hostname: "h", key: "k" }),
    };
    expect(() =>
      classifyDevTunnelIdentityFromModule(futureHelper, { dbUrl: "x", schema: "" }),
    ).toThrow(/contract version/);
  });

  it("fails closed on a sanctioned result missing its hostname/key", () => {
    const brokenHelper = {
      classifyDevTailscaleIdentity: () => ({ version: V, ok: true, hostname: "", key: "" }),
    };
    expect(() =>
      classifyDevTunnelIdentityFromModule(brokenHelper, { dbUrl: "x", schema: "" }),
    ).toThrow(/without a hostname\/key/);
  });

  it("fails closed when a helper claims the RESERVED main identity for an UNDECLARED instance", () => {
    // The reserved identity is declared, never inferred — and the CALLER knows
    // whether a declaration was supplied, so a malformed helper cannot mint one.
    const lyingHelper = {
      classifyDevTailscaleIdentity: () =>
        ok("main", "main:attacker:5432/db", "cinatra-main"),
    };
    expect(() =>
      classifyDevTunnelIdentityFromModule(lyingHelper, { dbUrl: "x", schema: "" }),
    ).toThrow(/declared none/);
    // And even WITH a declaration, a non-endpoint-scoped key is refused.
    expect(() =>
      classifyDevTunnelIdentityFromModule(
        { classifyDevTailscaleIdentity: () => ok("main", "main:whatever", "cinatra-main") },
        { dbUrl: "x", schema: "", mainDatabase: "h:5432/db" },
      ),
    ).toThrow(/endpoint-scoped key/);
  });

  it("passes a well-formed classification straight through", () => {
    const helper = {
      classifyDevTailscaleIdentity: ({ dbUrl }) =>
        ok("clone", `clone:${dbUrl}`, "cinatra-clone-alpha"),
    };
    expect(
      classifyDevTunnelIdentityFromModule(helper, { dbUrl: "cinatra_clone_alpha", schema: "" }),
    ).toMatchObject({ ok: true, kind: "clone" });
  });
});

// --- 4. END-TO-END refusal: the reserved runtime dir is NEVER written ------

// A fixture identity helper mirroring the connector's contract, declared
// through the SAME `cinatra.devCliModules` manifest key the real one uses.
const FIXTURE_HELPER = `
export const DEV_TAILSCALE_IDENTITY_CONTRACT_VERSION = ${V};
export function classifyDevTailscaleIdentity({ dbUrl, schema }) {
  const db = String(dbUrl ?? "").split("?")[0].split("/").pop() ?? "";
  const clone = db.match(/^cinatra_clone_(.+)$/);
  if (clone) {
    return { version: ${V}, ok: true, kind: "clone", key: "clone:" + db,
             hostname: "cinatra-clone-" + clone[1].replace(/_/g, "-"),
             code: null, reason: null };
  }
  const s = String(schema ?? "").trim();
  const iso = s.match(/^cinatra_(.+)$/);
  if (iso) {
    return { version: ${V}, ok: true, kind: "schema", key: "schema:" + s,
             hostname: "cinatra-" + iso[1].replace(/_/g, "-"),
             code: null, reason: null };
  }
  return { version: ${V}, ok: false, kind: "unregistered", key: null, hostname: null,
           code: "tailscale.unregistered_dev_identity",
           reason: 'This dev instance has no sanctioned Tailscale tunnel identity.' };
}
export function describeDevTailscaleIdentityRefusal(identity) {
  return identity.reason + "\\nAdopt one of the sanctioned identities: " +
    "a registered clone (cinatra_clone_<slug> database), or schema isolation " +
    "(SUPABASE_SCHEMA=cinatra_<slug>).";
}
`;

describe("instance tunnel — fail-closed refusal leaves the reserved runtime dir untouched", () => {
  let checkout = null;
  let fakeHome = "";
  const saved = {};

  beforeEach(() => {
    checkout = makeFakeCheckout();
    const helperDir = path.join(
      checkout.root,
      "extensions",
      "fixture-scope",
      "identity-connector",
    );
    mkdirSync(path.join(helperDir, "src"), { recursive: true });
    writeFileSync(path.join(helperDir, "src", "identity.mjs"), FIXTURE_HELPER);
    writeFileSync(
      path.join(helperDir, "package.json"),
      JSON.stringify({
        name: "@fixture-scope/identity-connector",
        cinatra: { devCliModules: { "tailscale-hostname": "./src/identity.mjs" } },
      }),
    );

    fakeHome = mkdtempSync(path.join(os.tmpdir(), "tunnel-home-"));
    for (const key of [
      "HOME",
      "CINATRA_REPO_ROOT",
      "CINATRA_RUNTIME_MODE",
      "SUPABASE_DB_URL",
      "SUPABASE_SCHEMA",
      "CINATRA_DEV_MAIN_DATABASE",
    ]) {
      saved[key] = process.env[key];
    }
    // `os.homedir()` (which `cloneRuntimeDir` uses) reads HOME on POSIX, so the
    // whole `~/.cinatra` tree is redirected into the tmpdir for this test.
    process.env.HOME = fakeHome;
    process.env.CINATRA_REPO_ROOT = checkout.root;
    process.env.CINATRA_RUNTIME_MODE = "development";
    // The exact reported shape: a scratch database, no schema isolation, no
    // explicit main declaration.
    process.env.SUPABASE_DB_URL = "postgresql://u:p@127.0.0.1:5434/scratch_2172";
    delete process.env.SUPABASE_SCHEMA;
    delete process.env.CINATRA_DEV_MAIN_DATABASE;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fakeHome, { recursive: true, force: true });
    checkout?.cleanup();
  });

  const reservedDir = () => path.join(fakeHome, ".cinatra", "clones", DEV_MAIN_SLUG);

  it("REFUSES `start` with a message naming both sanctioned identities", async () => {
    await expect(runCli(["instance", "tunnel", "start"])).rejects.toThrow(
      /no sanctioned Tailscale tunnel identity/,
    );
    let message = "";
    try {
      await runCli(["instance", "tunnel", "start"]);
    } catch (err) {
      message = String(err?.message ?? "");
    }
    expect(message).toContain("cinatra_clone_<slug>");
    expect(message).toContain("SUPABASE_SCHEMA=cinatra_<slug>");
  });

  it("writes NOTHING — the reserved runtime dir is untouched", async () => {
    await expect(runCli(["instance", "tunnel", "start"])).rejects.toThrow();
    expect(existsSync(reservedDir())).toBe(false);
    expect(existsSync(path.join(fakeHome, ".cinatra", "clones"))).toBe(false);
  });

  it("REFUSES `stop` too — an unregistered instance cannot tear down shared state", async () => {
    // A pre-existing reserved runtime dir stands in for the dev main's live
    // tunnel. `stop` must not reach its compose project.
    mkdirSync(reservedDir(), { recursive: true });
    writeFileSync(path.join(reservedDir(), "compose.yml"), "services: {}\n");
    await expect(runCli(["instance", "tunnel", "stop"])).rejects.toThrow(
      /no sanctioned Tailscale tunnel identity/,
    );
    // Untouched.
    expect(readFileSync(path.join(reservedDir(), "compose.yml"), "utf8")).toBe(
      "services: {}\n",
    );
  });

  it("`status` REPORTS the refusal instead of throwing, and still touches nothing", async () => {
    await expect(runCli(["instance", "tunnel", "status"])).resolves.toBeUndefined();
    expect(existsSync(reservedDir())).toBe(false);
  });

  it("a SCHEMA-ISOLATED instance is ACCEPTED and never reaches the reserved dir", async () => {
    // The sanctioned counterpart of the refusal above. No SUPABASE_DB_URL, so
    // the flow stays entirely off Docker and off Postgres: `stop` finds no
    // compose file for THIS identity's slug and returns cleanly.
    process.env.SUPABASE_SCHEMA = "cinatra_lane_2172";
    delete process.env.SUPABASE_DB_URL;

    const identity = ok("schema", "schema:cinatra_lane_2172", "cinatra-lane-2172");
    const slug = devTunnelRuntimeSlug(identity);
    expect(slug).not.toBe(DEV_MAIN_SLUG);

    // A reserved-identity runtime dir exists (the dev main's live tunnel).
    mkdirSync(reservedDir(), { recursive: true });
    writeFileSync(path.join(reservedDir(), "compose.yml"), "services: {}\n");

    await expect(runCli(["instance", "tunnel", "stop"])).resolves.toBeUndefined();

    // Accepted (no refusal) AND correctly scoped: the reserved identity's
    // compose file is untouched — under the retired hardcoded slug this call
    // would have run `docker compose down` against it.
    expect(readFileSync(path.join(reservedDir(), "compose.yml"), "utf8")).toBe(
      "services: {}\n",
    );
  });
});
