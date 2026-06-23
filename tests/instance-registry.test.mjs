// Instance registry (cinatra-cli#17, T1) — pure + hermetic, mirrors the
// clone-registry test style.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readInstanceRegistry,
  requireUsableInstanceRegistry,
  writeInstanceRegistry,
  allocateInstance,
  markInstanceReady,
  releaseInstance,
  getInstance,
  listInstances,
  findInstanceByInstallDir,
  findInstanceByComposeProject,
} from "../src/instance-registry.mjs";

let tmp;
let regPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cin-inst-reg-"));
  regPath = path.join(tmp, "instances.json");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseFields = (overrides = {}) => ({
  mode: "dev",
  installDir: "/home/u/cinatra",
  composeProject: "cinatra_alpha",
  composeFiles: ["docker-compose.yml", "docker-compose.dev.yml"],
  ports: { postgres: [5434], neo4j: [7474, 7687] },
  appPort: 3300,
  repoUrl: "https://github.com/cinatra-ai/cinatra.git",
  ref: "main",
  sha: "abc123",
  infraMode: "new",
  ...overrides,
});

const fresh = () => ({ version: 1, instances: {} });

describe("readInstanceRegistry", () => {
  it("missing → fresh empty", () => {
    const r = readInstanceRegistry(regPath);
    expect(r.status).toBe("missing");
    expect(r.registry.instances).toEqual({});
  });

  it("ok → parses a valid file", () => {
    const reg = allocateInstance(fresh(), "alpha", baseFields()).registry;
    writeInstanceRegistry(regPath, markInstanceReady(reg, "alpha"));
    const r = readInstanceRegistry(regPath);
    expect(r.status).toBe("ok");
    expect(r.registry.instances.alpha.state).toBe("ready");
  });

  it("malformed → invalid JSON is classified malformed (raw preserved)", () => {
    writeFileSync(regPath, "{ not json");
    const r = readInstanceRegistry(regPath);
    expect(r.status).toBe("malformed");
    expect(r.registry).toBe(null);
    expect(r.raw).toContain("not json");
  });

  it("malformed → structurally-bad slot (missing composeFiles) is rejected", () => {
    const bad = {
      version: 1,
      instances: { alpha: { ...baseFields(), slug: "alpha", id: "inst_alpha", state: "ready", createdAt: "t", composeFiles: [] } },
    };
    writeFileSync(regPath, JSON.stringify(bad));
    expect(readInstanceRegistry(regPath).status).toBe("malformed");
  });

  it("malformed → ports map with a non-list value is rejected", () => {
    const bad = {
      version: 1,
      instances: {
        alpha: { ...baseFields(), slug: "alpha", id: "inst_alpha", state: "ready", createdAt: "t", ports: { postgres: 5434 } },
      },
    };
    writeFileSync(regPath, JSON.stringify(bad));
    expect(readInstanceRegistry(regPath).status).toBe("malformed");
  });

  it("malformed → two rows sharing a composeProject is cross-entry invalid", () => {
    const bad = {
      version: 1,
      instances: {
        alpha: { ...baseFields(), slug: "alpha", id: "inst_alpha", appPort: 3300, state: "ready", createdAt: "t" },
        beta: { ...baseFields({ installDir: "/home/u/beta", appPort: 3301 }), slug: "beta", id: "inst_beta", state: "ready", createdAt: "t" },
      },
    };
    // same composeProject "cinatra_alpha" for both → invalid.
    writeFileSync(regPath, JSON.stringify(bad));
    expect(readInstanceRegistry(regPath).status).toBe("malformed");
  });
});

describe("requireUsableInstanceRegistry", () => {
  it("throws (does NOT auto-reset) on a malformed file", () => {
    writeFileSync(regPath, "{bad");
    expect(() => requireUsableInstanceRegistry(regPath)).toThrow(/malformed/);
    // file is left in place untouched.
    expect(readFileSync(regPath, "utf8")).toBe("{bad");
  });
  it("returns an empty registry when missing", () => {
    expect(requireUsableInstanceRegistry(regPath).instances).toEqual({});
  });
});

describe("allocateInstance", () => {
  it("allocates a provisioning row", () => {
    const { slot } = allocateInstance(fresh(), "alpha", baseFields());
    expect(slot.state).toBe("provisioning");
    expect(slot.slug).toBe("alpha");
    expect(slot.ports.neo4j).toEqual([7474, 7687]);
  });

  it("idempotent: same slug + same installDir returns existing unchanged", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    const { slot } = allocateInstance(r1, "alpha", baseFields());
    expect(slot.installDir).toBe("/home/u/cinatra");
  });

  it("throws when the same slug maps to a DIFFERENT installDir", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    expect(() => allocateInstance(r1, "alpha", baseFields({ installDir: "/other" }))).toThrow(/already maps/);
  });

  it("rejects a different slug reusing an existing appPort", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    expect(() =>
      allocateInstance(r1, "beta", baseFields({ installDir: "/home/u/beta", composeProject: "cinatra_beta", appPort: 3300 })),
    ).toThrow(/App port 3300 is already recorded/);
  });

  it("rejects a different slug reusing an existing composeProject", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    expect(() =>
      allocateInstance(r1, "beta", baseFields({ installDir: "/home/u/beta", appPort: 3301 })),
    ).toThrow(/Compose project "cinatra_alpha" is already recorded/);
  });

  it("rejects an invalid slug / missing required fields", () => {
    expect(() => allocateInstance(fresh(), "Bad Slug", baseFields())).toThrow(/Invalid instance slug/);
    expect(() => allocateInstance(fresh(), "alpha", baseFields({ composeFiles: [] }))).toThrow(/composeFiles/);
    expect(() => allocateInstance(fresh(), "alpha", baseFields({ infraMode: "bogus" }))).toThrow(/infraMode/);
  });

  it("does not mutate the input registry (pure)", () => {
    const input = fresh();
    allocateInstance(input, "alpha", baseFields());
    expect(input.instances).toEqual({});
  });
});

describe("markInstanceReady / releaseInstance", () => {
  it("flips to ready and can patch sha/ports", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    const ready = markInstanceReady(r1, "alpha", { sha: "deadbeef" });
    expect(ready.instances.alpha.state).toBe("ready");
    expect(ready.instances.alpha.sha).toBe("deadbeef");
  });
  it("markInstanceReady throws on an unknown slug", () => {
    expect(() => markInstanceReady(fresh(), "nope")).toThrow(/unknown instance slug/);
  });
  it("releaseInstance removes the row and returns it", () => {
    const r1 = allocateInstance(fresh(), "alpha", baseFields()).registry;
    const { registry, removed } = releaseInstance(r1, "alpha");
    expect(removed.slug).toBe("alpha");
    expect(registry.instances.alpha).toBeUndefined();
  });
});

describe("lookups", () => {
  it("getInstance / listInstances / findBy*", () => {
    let reg = allocateInstance(fresh(), "alpha", baseFields()).registry;
    reg = allocateInstance(reg, "beta", baseFields({ installDir: "/home/u/beta", composeProject: "cinatra_beta", appPort: 3301 })).registry;
    expect(getInstance(reg, "alpha").appPort).toBe(3300);
    expect(listInstances(reg).map((s) => s.slug)).toEqual(["alpha", "beta"]);
    expect(findInstanceByInstallDir(reg, "/home/u/beta").slug).toBe("beta");
    expect(findInstanceByComposeProject(reg, "cinatra_alpha").slug).toBe("alpha");
    expect(findInstanceByInstallDir(reg, "/nowhere")).toBe(null);
  });
});

describe("writeInstanceRegistry", () => {
  it("round-trips through readInstanceRegistry", () => {
    const reg = markInstanceReady(allocateInstance(fresh(), "alpha", baseFields()).registry, "alpha");
    writeInstanceRegistry(regPath, reg);
    const back = readInstanceRegistry(regPath);
    expect(back.status).toBe("ok");
    expect(back.registry.instances.alpha.composeProject).toBe("cinatra_alpha");
  });
});
