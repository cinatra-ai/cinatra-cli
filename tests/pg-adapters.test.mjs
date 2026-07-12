// Real Postgres detection adapters (cinatra-cli#128 residual, landed with
// #129): live SHOW server_version probe + raw PG_VERSION marker read from the
// deployment's actual data path (pg18 parent-mount layout aware). Every failure
// path must yield null — the preflight's fail-closed default.

import { describe, expect, it } from "vitest";

import {
  buildPgMarkerAdapter,
  buildPgProbeAdapter,
  parsePgServerVersion,
  parsePgVersionFile,
  pgMarkerShellScript,
} from "../src/pg-adapters.mjs";

describe("parsePgServerVersion", () => {
  it("extracts the major from SHOW server_version shapes", () => {
    expect(parsePgServerVersion("17.5")).toBe("17");
    expect(parsePgServerVersion("17.5 (Debian 17.5-1.pgdg120+1)")).toBe("17");
    expect(parsePgServerVersion("PostgreSQL 16.3 on aarch64-unknown-linux-musl")).toBe("16");
  });
  it("returns null on garbage / implausible majors", () => {
    expect(parsePgServerVersion("")).toBeNull();
    expect(parsePgServerVersion("not a version")).toBeNull();
    expect(parsePgServerVersion(null)).toBeNull();
    expect(parsePgServerVersion("3.14")).toBeNull(); // below the plausible pg range
  });
});

describe("parsePgVersionFile", () => {
  it("accepts a bare major with whitespace", () => {
    expect(parsePgVersionFile("17\n")).toBe("17");
    expect(parsePgVersionFile(" 15 ")).toBe("15");
  });
  it("rejects non-major content (fail closed)", () => {
    expect(parsePgVersionFile("9.6")).toBeNull(); // pre-10 two-part markers are out of scope
    expect(parsePgVersionFile("")).toBeNull();
    expect(parsePgVersionFile("banana")).toBeNull();
    expect(parsePgVersionFile("170")).toBeNull();
  });
});

describe("pgMarkerShellScript", () => {
  it("prefers a root PG_VERSION, accepts exactly one <major>/docker/PG_VERSION, else exits 3", () => {
    const s = pgMarkerShellScript("/wa_probe");
    expect(s).toContain("/wa_probe/PG_VERSION");
    expect(s).toContain("/wa_probe/*/docker/PG_VERSION");
    expect(s).toContain('[ "$#" -eq 1 ]');
    expect(s).toContain("exit 3");
  });
});

describe("buildPgProbeAdapter", () => {
  const meta = new Map([["postgres", { containerName: "cin-postgres-1", pgUser: "postgres" }]]);
  it("execs psql in the running container and parses the major", () => {
    const calls = [];
    const probe = buildPgProbeAdapter({
      dockerCapture: (args) => {
        calls.push(args);
        return "17.5 (Debian)";
      },
      serviceMeta: meta,
    });
    expect(probe("postgres")).toBe("17");
    expect(calls[0].slice(0, 2)).toEqual(["exec", "cin-postgres-1"]);
    expect(calls[0]).toContain("SHOW server_version");
  });
  it("returns null when there is no running container, no meta, or the exec fails", () => {
    const probe = buildPgProbeAdapter({ dockerCapture: () => null, serviceMeta: meta });
    expect(probe("postgres")).toBeNull(); // capture failed
    const probe2 = buildPgProbeAdapter({ dockerCapture: () => "17.5", serviceMeta: new Map() });
    expect(probe2("postgres")).toBeNull(); // unknown service
    const probe3 = buildPgProbeAdapter({
      dockerCapture: () => "17.5",
      serviceMeta: new Map([["postgres", { containerName: null, pgUser: "postgres" }]]),
    });
    expect(probe3("postgres")).toBeNull(); // not running
  });
});

describe("buildPgMarkerAdapter", () => {
  const meta = new Map([["nango-db", { volumeName: "nango-postgres", image: "postgres:17-alpine@sha256:abc" }]]);
  it("reads PG_VERSION via a --pull=never read-only scratch run over the service's own image", () => {
    const calls = [];
    const marker = buildPgMarkerAdapter({
      dockerCapture: (args) => {
        calls.push(args);
        return "15\n";
      },
      serviceMeta: meta,
    });
    expect(marker("nango-db", "PG_VERSION")).toBe("15");
    const argv = calls[0];
    expect(argv).toContain("--pull=never");
    expect(argv).toContain("nango-postgres:/wa_probe:ro");
    expect(argv).toContain("postgres:17-alpine@sha256:abc");
  });
  it("only answers for the authoritative PG_VERSION marker; everything else is null", () => {
    const marker = buildPgMarkerAdapter({ dockerCapture: () => "15", serviceMeta: meta });
    expect(marker("nango-db", "SOME_OTHER_MARKER")).toBeNull();
    expect(marker("unknown", "PG_VERSION")).toBeNull();
  });
  it("returns null when the scratch run fails or emits a non-major (ambiguous/absent → fail closed)", () => {
    const failing = buildPgMarkerAdapter({ dockerCapture: () => null, serviceMeta: meta });
    expect(failing("nango-db", "PG_VERSION")).toBeNull();
    const garbage = buildPgMarkerAdapter({ dockerCapture: () => "not-a-version", serviceMeta: meta });
    expect(garbage("nango-db", "PG_VERSION")).toBeNull();
  });
});
