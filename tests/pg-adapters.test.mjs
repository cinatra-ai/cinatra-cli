// Postgres detection adapters — the real live-probe + raw PG_VERSION marker
// readers behind the preflight's fenced seams (cinatra-cli#128 residual 1,
// folded in with cinatra-cli#129). Pure parsers + the injected-docker factories.

import { describe, expect, it } from "vitest";

import {
  PG_MARKER_READ_MOUNT,
  PG_MARKER_READ_SH,
  makeMarkerReader,
  makeProbeVersion,
  parsePgVersionMarker,
  parseServerVersionMajor,
} from "../src/pg-adapters.mjs";

describe("parseServerVersionMajor", () => {
  it("parses `SHOW server_version` output", () => {
    expect(parseServerVersionMajor("17.2")).toBe("17");
    expect(parseServerVersionMajor("18.0")).toBe("18");
    expect(parseServerVersionMajor("15.6 (Debian 15.6-1.pgdg120+2)")).toBe("15");
    expect(parseServerVersionMajor("18beta1")).toBe("18");
    expect(parseServerVersionMajor("  16.3\n")).toBe("16");
  });
  it("parses the verbose `SELECT version()` banner", () => {
    expect(
      parseServerVersionMajor("PostgreSQL 17.2 (Debian 17.2-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc"),
    ).toBe("17");
    expect(parseServerVersionMajor("PostgreSQL 15.6 on aarch64-unknown-linux-musl")).toBe("15");
  });
  it("returns null on empty / unparseable input (→ fail closed, never a guess)", () => {
    expect(parseServerVersionMajor("")).toBeNull();
    expect(parseServerVersionMajor(null)).toBeNull();
    expect(parseServerVersionMajor(undefined)).toBeNull();
    expect(parseServerVersionMajor("psql: could not connect")).toBeNull();
  });
});

describe("parsePgVersionMarker", () => {
  it("reads the major from a PG_VERSION file body", () => {
    expect(parsePgVersionMarker("17\n")).toBe("17");
    expect(parsePgVersionMarker("15")).toBe("15");
    expect(parsePgVersionMarker("18\n\n")).toBe("18");
    expect(parsePgVersionMarker("  16  ")).toBe("16");
  });
  it("returns null on empty / unreadable input", () => {
    expect(parsePgVersionMarker("")).toBeNull();
    expect(parsePgVersionMarker("\n")).toBeNull();
    expect(parsePgVersionMarker(null)).toBeNull();
  });
});

describe("PG_MARKER_READ_SH — layout-aware, both pg layouts", () => {
  it("checks the legacy `.../data` root marker AND the pg18 parent `<major>/docker` path", () => {
    // The mount root is bound to $M = the read mount.
    expect(PG_MARKER_READ_SH).toContain(`M=${PG_MARKER_READ_MOUNT};`);
    // Legacy: the volume is mounted AT .../data, so PG_VERSION is at the root.
    expect(PG_MARKER_READ_SH).toContain(`"$M/PG_VERSION"`);
    // pg18 parent layout: PGDATA moved to <major>/docker (globbed, not assumed).
    expect(PG_MARKER_READ_SH).toContain(`"$M"/*/docker`);
    // Must not `set -e` — a missing legacy file falls through to the parent search.
    expect(PG_MARKER_READ_SH).not.toContain("set -e");
  });
});

describe("makeProbeVersion (injected docker exec)", () => {
  it("probes the running container and parses the major", () => {
    const calls = [];
    const probe = makeProbeVersion({
      runningContainerFor: (s) => (s === "postgres" ? "cinatra-postgres-1" : null),
      dockerExec: (container, argv) => {
        calls.push({ container, argv });
        return "17.2";
      },
    });
    expect(probe("postgres")).toBe("17");
    expect(calls[0].container).toBe("cinatra-postgres-1");
    expect(calls[0].argv).toEqual(["psql", "-U", "postgres", "-tArc", "SHOW server_version"]);
  });
  it("returns null (falls through to the marker) when the server is not running", () => {
    let execCalled = false;
    const probe = makeProbeVersion({
      runningContainerFor: () => null,
      dockerExec: () => {
        execCalled = true;
        return "17.2";
      },
    });
    expect(probe("postgres")).toBeNull();
    expect(execCalled).toBe(false);
  });
  it("returns null when the exec fails (fail closed, never a guess)", () => {
    const probe = makeProbeVersion({ runningContainerFor: () => "c", dockerExec: () => null });
    expect(probe("postgres")).toBeNull();
  });
});

describe("makeMarkerReader (injected docker read-only volume mount)", () => {
  it("reads PG_VERSION from the deployment's data path via the service's own image", () => {
    const calls = [];
    const read = makeMarkerReader({
      volumeFor: () => "cinatra-postgres",
      imageFor: () => "postgres:18-alpine",
      dockerReadVolume: (vol, image, program) => {
        calls.push({ vol, image, program });
        return "18\n";
      },
    });
    expect(read("postgres", "PG_VERSION")).toBe("18");
    expect(calls[0]).toEqual({ vol: "cinatra-postgres", image: "postgres:18-alpine", program: PG_MARKER_READ_SH });
  });
  it("only reads the authoritative PG_VERSION marker", () => {
    const read = makeMarkerReader({ volumeFor: () => "v", imageFor: () => "i", dockerReadVolume: () => "x" });
    expect(read("postgres", "SOMETHING_ELSE")).toBeNull();
  });
  it("returns null when the volume or image cannot be identified", () => {
    const readNoVol = makeMarkerReader({ volumeFor: () => null, imageFor: () => "i", dockerReadVolume: () => "17" });
    const readNoImg = makeMarkerReader({ volumeFor: () => "v", imageFor: () => null, dockerReadVolume: () => "17" });
    expect(readNoVol("postgres", "PG_VERSION")).toBeNull();
    expect(readNoImg("postgres", "PG_VERSION")).toBeNull();
  });
  it("returns null when the read fails", () => {
    const read = makeMarkerReader({ volumeFor: () => "v", imageFor: () => "i", dockerReadVolume: () => null });
    expect(read("postgres", "PG_VERSION")).toBeNull();
  });
});
