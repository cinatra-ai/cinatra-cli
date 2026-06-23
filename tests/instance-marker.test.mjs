// Per-checkout instance marker (cinatra-cli#17, T2) — read/write + reconcile.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeMarker, readMarker, reconcileMarker, markerPath } from "../src/instance-marker.mjs";

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cin-marker-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeMarker / readMarker", () => {
  it("round-trips the salient fields", () => {
    writeMarker(tmp, {
      slug: "alpha",
      id: "inst_alpha",
      mode: "dev",
      composeProject: "cinatra_alpha",
      composeFiles: ["docker-compose.cinatra-isolated.yml"],
      appPort: 3300,
      ref: "main",
      sha: "abc",
      infraMode: "new",
      state: "ready",
    });
    const r = readMarker(tmp);
    expect(r.status).toBe("ok");
    expect(r.marker.slug).toBe("alpha");
    expect(r.marker.composeProject).toBe("cinatra_alpha");
    expect(r.marker.state).toBe("ready");
  });

  it("missing → status missing", () => {
    expect(readMarker(tmp).status).toBe("missing");
  });

  it("malformed → status malformed", () => {
    mkdirSync(path.join(tmp, ".cinatra"), { recursive: true });
    writeFileSync(markerPath(tmp), "{nope");
    expect(readMarker(tmp).status).toBe("malformed");
  });
});

describe("reconcileMarker — marker is a HINT, never authority", () => {
  const marker = { slug: "alpha", state: "ready" };

  it("no registry row → never healthy (even with a present marker)", () => {
    const res = reconcileMarker(marker, null, true);
    expect(res.healthy).toBe(false);
    expect(res.state).toBe("unknown");
  });

  it("no marker and no row → absent", () => {
    const res = reconcileMarker(null, null, false);
    expect(res.healthy).toBe(false);
    expect(res.state).toBe("absent");
  });

  it("provisioning row → never healthy (ghost)", () => {
    const res = reconcileMarker(marker, { state: "provisioning" }, true);
    expect(res.healthy).toBe(false);
    expect(res.state).toBe("provisioning");
  });

  it("ready row but NO live containers → stale, not healthy", () => {
    const res = reconcileMarker(marker, { state: "ready" }, false);
    expect(res.healthy).toBe(false);
    expect(res.state).toBe("stale");
  });

  it("ready row + live-owned → healthy", () => {
    const res = reconcileMarker(marker, { state: "ready" }, true);
    expect(res.healthy).toBe(true);
    expect(res.state).toBe("ready");
  });

  it("external row → healthy=external regardless of live containers", () => {
    const res = reconcileMarker(marker, { state: "external" }, false);
    expect(res.healthy).toBe(true);
    expect(res.state).toBe("external");
  });
});
