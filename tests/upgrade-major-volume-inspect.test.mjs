// cinatra-cli#324: `cinatra instance db upgrade-major` reads its volumes with a
// three-way reader. Only docker's own exit 1 with "no such volume" is an
// absent volume; a timeout, a signal, a spawn error and a non-zero exit with
// other text are an inspect ERROR. The detection step (`runPreflight`, the
// core `upgrade-preflight` runs too) then fails closed instead of reading a
// fresh volume, and the recheck after the probes reads a failed final inspect
// as uncertain, never as "still absent".
//
// The rows drive the exported reader and seams with a stand-in for spawnSync
// (no docker, no container), and pin that the command's transport is built
// from them.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeUpgradeMajorInspectVolume, makeUpgradeMajorVolumeSeams } from "../src/upgrade-major.mjs";
import { recheckVolumeStability, runPreflight, VERDICTS } from "../src/upgrade-preflight.mjs";

const VOL = "cinatra_acme_pgdata";
const ROW = { Name: VOL, CreatedAt: "2026-01-01T00:00:00Z" };

// spawnSync answers. A timed-out spawnSync carries error ETIMEDOUT, the
// signal and a null status; what the child printed before it is kept.
const answer = (r) => ({ status: 0, signal: null, error: null, stdout: "", stderr: "", ...r });
const OK = answer({ stdout: JSON.stringify([ROW]) });
const ABSENT = answer({ status: 1, stderr: `Error response from daemon: get ${VOL}: no such volume\n` });
const etimedout = () => Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" });
const FAILED = {
  "a timeout": answer({ status: null, signal: "SIGTERM", error: etimedout() }),
  "a timeout after docker printed no such volume": answer({
    status: null,
    signal: "SIGTERM",
    error: etimedout(),
    stderr: `Error response from daemon: get ${VOL}: no such volume\n`,
  }),
  "a timeout whose status reads 0 with a row": answer({ error: etimedout(), stdout: JSON.stringify([ROW]) }),
  "a signal": answer({ status: null, signal: "SIGKILL" }),
  "a spawn error": answer({ status: null, error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }) }),
  "a non-zero exit with other text": answer({ status: 1, stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?\n" }),
  "a non-zero exit other than 1 with no such volume": answer({ status: 125, stderr: "no such volume\n" }),
  "an exit 0 with no row": answer({ stdout: "[]" }),
  "an exit 0 with text that is not JSON": answer({ stdout: "not json" }),
  "an exit 0 with JSON null": answer({ stdout: "null" }),
  "an exit 0 whose row is not an object": answer({ stdout: "[5]" }),
  "an exit 0 whose row is an array": answer({ stdout: JSON.stringify([[ROW]]) }),
  "no answer object from spawn": undefined,
};

// A spawn stand-in that answers in turn and records each call.
function spawnOf(answers) {
  const queue = [...answers];
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (!queue.length) throw new Error("no answer left");
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { spawn, calls };
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cinatra-cli-324-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("cinatra-cli#324: the upgrade-major volume reader is three-way", () => {
  it("cinatra-cli#324 reads exit 0 with a row as ok, and runs `docker volume inspect` with the given bound", () => {
    const { spawn, calls } = spawnOf([OK]);
    expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "ok", row: ROW });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args).toEqual(["volume", "inspect", VOL]);
    expect(calls[0].opts.timeout).toBe(15_000);
  });

  it("cinatra-cli#324 reads exit 0 with one row object (not an array) as ok", () => {
    const { spawn } = spawnOf([answer({ stdout: JSON.stringify(ROW) })]);
    expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "ok", row: ROW });
  });

  it("cinatra-cli#324 reads docker's own exit 1 with no such volume as absent", () => {
    const { spawn } = spawnOf([ABSENT]);
    expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "absent", row: null });
  });

  it("cinatra-cli#324 reads docker's exit 1 as absent in either case and on either stream", () => {
    for (const r of [
      answer({ status: 1, stderr: `Error: No such volume: ${VOL}\n` }),
      answer({ status: 1, stdout: `Error response from daemon: get ${VOL}: no such volume\n` }),
    ]) {
      const { spawn } = spawnOf([r]);
      expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "absent", row: null });
    }
  });

  for (const [what, r] of Object.entries(FAILED)) {
    it(`cinatra-cli#324 reads ${what} as an inspect error, never as absent`, () => {
      const { spawn } = spawnOf([r]);
      expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "error", row: null });
    });
  }

  it("cinatra-cli#324 reads a spawn that throws as an inspect error", () => {
    const { spawn } = spawnOf([new Error("spawn failed")]);
    expect(makeUpgradeMajorInspectVolume(spawn, 15_000)(VOL)).toEqual({ status: "error", row: null });
  });
});

describe("cinatra-cli#324: the upgrade-major transport seams over the three-way reader", () => {
  const seamsFor = (answers, listVolume = () => null) => {
    const { spawn, calls } = spawnOf(answers);
    return { seams: makeUpgradeMajorVolumeSeams(makeUpgradeMajorInspectVolume(spawn, 15_000), listVolume), calls };
  };

  for (const [what, r] of Object.entries(FAILED)) {
    it(`cinatra-cli#324 seams: a volume whose inspect gives ${what} is present to the detection step, with no row and an error status`, () => {
      let listed = 0;
      const { seams } = seamsFor([r, r, r], () => (listed += 1, ""));
      expect(seams.inspectVolume(VOL)).toBeNull();
      expect(seams.volumeState(VOL)).toBe("present");
      expect(seams.inspectVolumeStatus(VOL)).toEqual({ status: "error", row: null });
      // A failed inspect is never followed by the emptiness read.
      expect(listed).toBe(0);
    });
  }

  it("cinatra-cli#324 an absent volume stays absent, and an inspected volume is empty or present by its listing", () => {
    expect(seamsFor([ABSENT]).seams.volumeState(VOL)).toBe("absent");
    expect(seamsFor([OK], () => "").seams.volumeState(VOL)).toBe("empty");
    expect(seamsFor([OK], () => "PG_VERSION").seams.volumeState(VOL)).toBe("present");
    // A listing that could not be read is present, never empty.
    expect(seamsFor([OK], () => null).seams.volumeState(VOL)).toBe("present");
    expect(seamsFor([OK], () => undefined).seams.volumeState(VOL)).toBe("present");
    expect(seamsFor([OK]).seams.inspectVolume(VOL)).toEqual(ROW);
    expect(seamsFor([OK]).seams.inspectVolumeStatus(VOL)).toEqual({ status: "ok", row: ROW });
  });

  it("cinatra-cli#324 an empty volume name makes no docker call: no row, absent", () => {
    const { seams, calls } = seamsFor([]);
    for (const name of ["", null, undefined]) {
      expect(seams.inspectVolume(name)).toBeNull();
      expect(seams.inspectVolumeStatus(name)).toEqual({ status: "absent", row: null });
      expect(seams.volumeState(name)).toBe("absent");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("cinatra-cli#324: the detection step upgrade-major runs refuses a failed inspect", () => {
  // `runDbUpgradeMajor`'s resolvePlan runs `runPreflight` on its transport and
  // refuses (exit 3) a FAIL_CLOSED verdict. A legacy install (no ledger entry)
  // with no probe and no marker answer is the case where an inspect read as
  // absent gives a PASS ("empty/fresh volume").
  const transportOf = (answers, probe = null) => {
    const { spawn, calls } = spawnOf(answers);
    return {
      calls,
      transport: {
        ...makeUpgradeMajorVolumeSeams(makeUpgradeMajorInspectVolume(spawn, 15_000), () => null),
        probeVersion: () => probe,
        readMarker: () => null,
        profileEnabled: () => true,
      },
    };
  };
  const detect = (transport) =>
    runPreflight({ slug: "acme", ledgerDir: dir, services: [{ service: "postgres", target: "18", volumeName: VOL }], transport });
  // The live probe answers a supported source major (nango-db 15 -> 17, the
  // hop whose STOP verdict upgrade-major goes on with).
  const detectProbed = (transport) =>
    runPreflight({ slug: "acme", ledgerDir: dir, services: [{ service: "nango-db", target: "17", volumeName: VOL }], transport });

  for (const [what, r] of Object.entries(FAILED)) {
    it(`cinatra-cli#324 detection: a volume whose every inspect gives ${what} fails closed, never an empty/fresh PASS`, () => {
      const { transport } = transportOf([r, r, r]);
      const rep = detect(transport);
      expect(rep.ok).toBe(false);
      expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    });

    it(`cinatra-cli#324 detection: a volume first found absent whose final inspect gives ${what} fails closed (the recheck is uncertain)`, () => {
      // Two reads before the probes (the row and the state), then the recheck.
      const { transport, calls } = transportOf([ABSENT, ABSENT, r]);
      expect(recheckVolumeStability(transportOf([r]).transport, VOL, null)).toBe("uncertain");
      const rep = detect(transport);
      expect(calls).toHaveLength(3);
      expect(rep.ok).toBe(false);
      expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    });
  }

  for (const what of ["a timeout", "a signal", "a non-zero exit with other text"]) {
    it(`cinatra-cli#324 detection: a probed version on a volume whose every inspect gives ${what} fails closed, never the STOP upgrade-major goes on with`, () => {
      const r = FAILED[what];
      const { transport } = transportOf([r, r, r], "15");
      const rep = detectProbed(transport);
      expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    });

    it(`cinatra-cli#324 detection: a probed version on a volume first found absent whose final inspect gives ${what} fails closed`, () => {
      const r = FAILED[what];
      const { transport } = transportOf([ABSENT, ABSENT, r], "15");
      const rep = detectProbed(transport);
      expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    });
  }

  for (const what of ["a timeout", "a signal", "a non-zero exit with other text"]) {
    it(`cinatra-cli#324 detection: a probed version on a volume first inspected whose final inspect gives ${what} fails closed`, () => {
      const { transport, calls } = transportOf([OK, OK, FAILED[what]], "15");
      const rep = detectProbed(transport);
      expect(calls).toHaveLength(3);
      expect(rep.results[0].verdict).toBe(VERDICTS.FAIL_CLOSED);
    });
  }

  it("cinatra-cli#324 control: a probed version on an inspected volume is the supported STOP", () => {
    const { transport, calls } = transportOf([OK, OK, OK], "15");
    const rep = detectProbed(transport);
    expect(calls).toHaveLength(3);
    expect(rep.results[0].verdict).toBe(VERDICTS.STOP);
  });

  it("cinatra-cli#324 control: a volume docker reports absent at every inspect is still the fresh-volume PASS", () => {
    const { transport, calls } = transportOf([ABSENT, ABSENT, ABSENT]);
    const rep = detect(transport);
    expect(calls).toHaveLength(3);
    expect(rep.results[0].verdict).toBe(VERDICTS.PASS);
  });
});

describe("cinatra-cli#324: `instance db upgrade-major` builds its transport from the three-way reader", () => {
  const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const start = src.indexOf("async function runDbUpgradeMajor(rest) {");
  const end = start >= 0 ? src.indexOf("\nasync function ", start + 1) : -1;
  const body = start >= 0 && end > start ? src.slice(start, end) : "";

  it("cinatra-cli#324 the command reads volumes only through makeUpgradeMajorInspectVolume and its seams", () => {
    expect(body, "runDbUpgradeMajor is found").not.toBe("");
    expect(body).toMatch(/const \{ runUpgradeMajorCommand, UPGRADE_EXIT, makeUpgradeMajorInspectVolume, makeUpgradeMajorVolumeSeams \} = await import\("\.\/upgrade-major\.mjs"\);/);
    expect(body).toMatch(/const inspectVolumeThreeWay = makeUpgradeMajorInspectVolume\(spawnSync, DOCKER_CLI_PROBE_TIMEOUT_MS\);/);
    // No volume inspect of its own over the lossy capture.
    expect(body).not.toMatch(/inspectVolumeRow/);
    expect(body).not.toMatch(/"volume", "inspect"/);
  });

  it("cinatra-cli#324 the transport takes the three seams, the three-way status seam among them, and no inspect seam of its own", () => {
    const at = body.indexOf("const transport = {");
    const transportText = at >= 0 ? body.slice(at, body.indexOf("\n  };", at)) : "";
    expect(transportText, "the transport is found").not.toBe("");
    expect(transportText).toMatch(/\n    \.\.\.makeUpgradeMajorVolumeSeams\(inspectVolumeThreeWay, /);
    expect(transportText).not.toMatch(/\n    (inspectVolume|inspectVolumeStatus|volumeState):/);
    // The listing: the volume's own image, read only, or null (a present volume) when no image is known.
    expect(transportText).toMatch(/const image = volumeImages\.get\(name\);\n      return image \? dockerReadVolume\(name, image, "ls -A \/__cinatra_pgver 2>\/dev\/null"\) : null;/);
  });
});
