// cinatra-cli#287 — the preview HOST HANDOVER: the install profile that tells a
// preview from a production deployment, every declarer of the generic
// `cinatra.devCliModules["preview-host-handover"]` key, the env it hands over in
// a 0600 env file (never in an argv or a log), and the loopback forwarder its
// declared forwards get. Hermetic: docker is a fake; the declarers are made-up
// modules in a temporary checkout; the one real process is the forwarder
// program on loopback ports picked by the system.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";
import * as DCM from "../src/dev-cli-modules.mjs";
import * as PV from "../src/preview.mjs";

const loadHandover = () => import("../src/preview-host-handover.mjs");

const KEY = "preview-host-handover";
const SHA_A = "a".repeat(40);
const KEY_64 = "00000000000000000000000000000000000000000000000000000000000000e2";
const SECRET_A = "made-up-handover-value-alpha-0123456789";
const SECRET_B = "made-up-handover-value-beta-9876543210";
const NAME_A = "CINATRA_EXT_ACME_HALPHA__DEV_TOKEN";
const NAME_B = "CINATRA_EXT_ACME_HBETA__SERVICE_KEY";

let tmp;
let registryPath;
let checkoutDir;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cinatra-preview-handover-"));
  registryPath = path.join(tmp, "previews.json");
  checkoutDir = path.join(tmp, "checkout");
  mkdirSync(checkoutDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A made-up extension in the checkout: its manifest and, when given, the module it declares. */
function declarer(scope, name, { rel = "./handover.mjs", body = null, key = KEY } = {}) {
  const dir = path.join(checkoutDir, "extensions", scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@${scope}/${name}`, cinatra: { devCliModules: { [key]: rel } } }),
  );
  if (body !== null) writeFileSync(path.join(dir, rel), body);
  return dir;
}

const handing = (result) => `export async function previewHostHandover() { return ${JSON.stringify(result)}; }\n`;

function makeDeps(state = {}) {
  const calls = [];
  const logs = [];
  state.envFiles = [];
  // The forwarders docker holds, by name, and the ports of the last one run.
  state.forwarders = new Set();
  state.forwarderPorts = [];
  const runDocker = (args) => {
    calls.push(args);
    const ownership = answerComposeOwnership(args, state);
    if (ownership) return ownership;
    const [verb, sub] = args;
    if (verb === "volume" && String(args.at(-1)).startsWith("cinatra-preview-artifacts-")) {
      const name = args.at(-1);
      const slug = name.slice("cinatra-preview-artifacts-".length);
      if (sub === "create") return { status: 0, stdout: name, stderr: "" };
      if (sub === "inspect") {
        return {
          status: 0,
          stdout: JSON.stringify([{ Name: name, Driver: "local", Labels: { [PV.ARTIFACT_VOLUME_OWNER_LABEL]: slug } }]),
          stderr: "",
        };
      }
    }
    if (verb === "container" && sub === "inspect" && args.includes("{{json .}}")) {
      const slug = args.at(-1).slice("cinatra-preview-".length);
      return {
        status: 0,
        stdout: JSON.stringify({
          Mounts: [{ Type: "volume", Name: PV.previewArtifactVolumeName(slug), Destination: "/data/artifacts", RW: true }],
          Config: { Env: ["CINATRA_ARTIFACT_DATA_ROOT=/data/artifacts"] },
        }),
        stderr: "",
      };
    }
    if (verb === "network" && sub === "connect") {
      return state.networkAnswer?.(args) ?? { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "run" && sub === "-d") {
      const i = args.indexOf("--env-file");
      if (i !== -1) {
        const file = args[i + 1];
        state.envFiles.push({ file, mode: statSync(file).mode & 0o777, text: readFileSync(file, "utf8") });
      }
      if (!args.some((a) => String(a).startsWith("container:"))) state.containerRunning = true;
      else {
        if (state.forwarderRunAnswer) return state.forwarderRunAnswer(args);
        state.forwarders.add(args[args.indexOf("--name") + 1]);
        state.forwarderPorts = [...String(args.at(-1)).matchAll(/"port":([0-9]+)/g)].map((m) => Number(m[1]));
      }
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (verb === "rm") {
      state.forwarders.delete(args.at(-1));
      if (args.at(-1) === "cinatra-preview-s1") state.containerRunning = state.containerStopped = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "logs" && String(args.at(-1)).endsWith(".forward")) {
      return state.forwarderLog?.(args) ??
        { status: 0, stdout: state.forwarderPorts.map((port) => `forward-ready ${port}\n`).join(""), stderr: "" };
    }
    if (verb === "container" && sub === "ls") {
      if (state.containerLsAnswer) return state.containerLsAnswer(args);
      return { status: 0, stdout: [...state.forwarders].map((name) => `${name}\n`).join(""), stderr: "" };
    }
    if (verb === "stop" || verb === "start") {
      state.containerRunning = verb === "start";
      state.containerStopped = verb === "stop";
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "container" && sub === "inspect") {
      if (!state.containerRunning && state.containerStopped) return { status: 0, stdout: "false\n", stderr: "" };
      const running = Boolean(state.containerRunning);
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "", stderr: running ? "" : "No such object" };
    }
    if (verb === "volume" && sub === "inspect") {
      return { status: 1, stdout: "", stderr: `Error response from daemon: get ${args.at(-1)}: no such volume` };
    }
    if (verb === "image" && sub === "inspect") {
      return state.imagePresent
        ? { status: 0, stdout: `${SHA_A} \n`, stderr: "" }
        : { status: 1, stdout: "", stderr: `Error: No such image: ${args.at(-1)}` };
    }
    if (verb === "logs") return { status: 0, stdout: "log tail", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const deps = {
    registryPath,
    checkoutDir,
    env: { [PV.ENCRYPTION_KEY_ENV]: KEY_64 },
    buildControlEnv: { [PV.PREVIEW_BUILD_CACHE_ENV]: "off" },
    log: (line) => logs.push(String(line)),
    logError: (line) => logs.push(String(line)),
    now: () => 1000,
    sleep: async () => {},
    resolveSha: () => SHA_A,
    prepareContext: () => ({ contextDir: mkdtempSync(path.join(tmp, "ctx-")), cleanup: () => {} }),
    envFileTmpDir: tmp,
    handoverTimeoutMs: state.handoverTimeoutMs,
    probeHealth: async () => ({ status: 200, body: '{"status":"ok"}' }),
    probePort: async () => true,
    runDocker,
  };
  return { deps, calls, logs, state };
}

const previewRun = (calls) =>
  calls.find((a) => a[0] === "run" && a[1] === "-d" && !a.some((x) => String(x).startsWith("container:")));
const forwarderRuns = (calls) => calls.filter((a) => a[0] === "run" && a.some((x) => String(x).startsWith("container:")));

describe("cinatra-cli#287 — the preview container tells itself from a production deployment", () => {
  it("sets CINATRA_INSTALL_PROFILE=preview beside the production runtime mode, for both fleets", () => {
    for (const fleet of ["required", "dev"]) {
      const args = PV.buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: {}, fleet });
      expect(args).toContain("CINATRA_RUNTIME_MODE=production");
      expect(args).toContain("CINATRA_INSTALL_PROFILE=preview");
    }
  });

  it("never forwards an ambient install profile in its place", () => {
    const args = PV.buildPreviewRunEnvArgs({ encryptionKey: KEY_64, env: { CINATRA_INSTALL_PROFILE: "demo" } });
    expect(args.filter((a) => a.startsWith("CINATRA_INSTALL_PROFILE="))).toEqual(["CINATRA_INSTALL_PROFILE=preview"]);
  });
});

describe("cinatra-cli#287 — every declarer of a dev-CLI key", () => {
  it("lists every declarer in sorted order, confined to its own dir, and skips a path that leaves it", () => {
    declarer("zeta", "one");
    declarer("acme", "beta");
    declarer("acme", "alpha");
    declarer("acme", "escape", { rel: "../alpha/handover.mjs" });
    declarer("acme", "other", { key: "another-key" });
    const found = DCM.discoverAllDevCliModulePaths(KEY, checkoutDir);
    expect(found.map((d) => d.packageDir)).toEqual([
      path.join("extensions", "acme", "alpha"),
      path.join("extensions", "acme", "beta"),
      path.join("extensions", "zeta", "one"),
    ]);
    expect(found[0].modulePath).toBe(path.join(checkoutDir, "extensions", "acme", "alpha", "handover.mjs"));
    expect(DCM.discoverDevCliModulePath(KEY, checkoutDir)).toBe(found[0].modulePath);
    expect(DCM.discoverAllDevCliModulePaths("no-such-key", checkoutDir)).toEqual([]);
  });
});

describe("cinatra-cli#287 — the handed-over env reaches the container in a 0600 env file only", () => {
  it("boots with --env-file holding the namespaced entries; no value in any argv or log; the file is gone after the run", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A, PATH_LIKE_NAME: SECRET_B } }) });
    declarer("acme", "beta", { body: handing({ env: { [NAME_B]: SECRET_B } }) });
    const { deps, calls, logs, state } = makeDeps();
    const out = await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect(out.state).toBe("healthy");
    expect(previewRun(calls)).toContain("--env-file");
    expect(previewRun(calls)).toContain("CINATRA_INSTALL_PROFILE=preview");
    expect(state.envFiles).toHaveLength(1);
    expect(state.envFiles[0].mode).toBe(0o600);
    expect(state.envFiles[0].text).toBe(`${NAME_A}=${SECRET_A}\n${NAME_B}=${SECRET_B}\n`);
    expect(existsSync(state.envFiles[0].file)).toBe(false);
    expect(logs.some((l) => l.includes("PATH_LIKE_NAME") && l.includes("not an extension override name"))).toBe(true);
    for (const argv of calls) for (const a of argv) for (const v of [SECRET_A, SECRET_B]) expect(String(a)).not.toContain(v);
    for (const line of logs) for (const v of [SECRET_A, SECRET_B]) expect(line).not.toContain(v);
  });

  it("refuses an env-file entry whose name or value would break the file", async () => {
    const H = await loadHandover();
    expect(() => H.writeHandoverEnvFile([[NAME_A, "a\nB=c"]], { tmpDir: tmp })).toThrow(/unexpected shape/);
    expect(() => H.writeHandoverEnvFile([["lower_case", "x"]], { tmpDir: tmp })).toThrow(/unexpected shape/);
  });
});

describe("cinatra-cli#287 — the declared forwards are served inside the container", () => {
  it("joins each declared network and runs one forwarder per preview with a listener per declared port", async () => {
    declarer("acme", "alpha", {
      body: handing({ forwards: [{ port: 41001, network: "acme-net", target: "acme-svc:8080" }] }),
    });
    declarer("acme", "beta", {
      body: handing({ forwards: [
        { port: 41002, network: "beta_net", target: "beta-svc:9090" },
        { port: 41003, network: "acme-net", target: "acme-side:7070" },
      ] }),
    });
    const { deps, calls } = makeDeps({
      networkAnswer: (args) => args[2] === "beta_net"
        ? { status: 1, stdout: "", stderr: "Error response from daemon: endpoint with name cinatra-preview-s1 already exists in network beta_net" }
        : { status: 0, stdout: "", stderr: "" },
    });
    const out = await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect(calls.filter((a) => a[0] === "network")).toEqual([
      ["network", "connect", "acme-net", "cinatra-preview-s1"],
      ["network", "connect", "beta_net", "cinatra-preview-s1"],
    ]);
    expect(calls).toContainEqual(["rm", "-f", "cinatra-preview-s1.forward"]);
    const runs = forwarderRuns(calls);
    expect(runs).toHaveLength(1);
    const fwd = runs[0];
    expect(fwd.slice(0, 6)).toEqual(["run", "-d", "--name", "cinatra-preview-s1.forward", "--network", "container:cinatra-preview-s1"]);
    expect(fwd[fwd.indexOf("--entrypoint") + 1]).toBe("node");
    expect(fwd).toContain(out.tag);
    const script = fwd.at(-1);
    expect(script).toContain('{"port":41001,"host":"acme-svc","targetPort":8080}');
    expect(script).toContain('{"port":41002,"host":"beta-svc","targetPort":9090}');
    expect(script).toContain('{"port":41003,"host":"acme-side","targetPort":7070}');
    expect(script).toContain('"127.0.0.1"');
  });

  it("the forwarder program carries loopback traffic to its target", async () => {
    const H = await loadHandover();
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const script = H.previewForwarderScript([{ port, host: "127.0.0.1", targetPort: echo.address().port }]);
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    try {
      let answer = null;
      for (let i = 0; i < 50 && answer === null; i++) {
        answer = await new Promise((resolve) => {
          const s = net.connect(port, "127.0.0.1");
          s.on("error", () => resolve(null));
          s.on("connect", () => s.write("ping"));
          s.on("data", (d) => {
            resolve(String(d));
            s.destroy();
          });
        });
        if (answer === null) await new Promise((r) => setTimeout(r, 100));
      }
      expect(answer).toBe("ping");
    } finally {
      child.kill();
      await new Promise((r) => echo.close(r));
    }
  });

  it("without a declarer writes no env file, joins no network and starts no forwarder", async () => {
    const { deps, calls, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect(previewRun(calls)).not.toContain("--env-file");
    expect(state.envFiles).toHaveLength(0);
    expect(calls.some((a) => a[0] === "network")).toBe(false);
    expect(forwarderRuns(calls)).toHaveLength(0);
  });
});

describe("cinatra-cli#287 — what a declarer hands over is validated, and a failing declarer is skipped", () => {
  it("skips each invalid entry with a warning and keeps the valid ones", async () => {
    const H = await loadHandover();
    declarer("acme", "alpha", {
      body: handing({
        env: { [NAME_A]: "one\nline", lower_case_name: "x", [NAME_B]: SECRET_B },
        forwards: [
          { port: 80, network: "acme-net", target: "svc:1" },
          { port: 41001, network: "bad net", target: "svc:1" },
          { port: 41002, network: "acme-net", target: "no-port" },
          { port: 41003, network: "acme-net", target: "svc:99999" },
          { port: 41004.5, network: "acme-net", target: "svc:1" },
          { port: 41005, network: "acme-net", target: "svc:8080" },
          { port: 41005, network: "acme-net", target: "svc:8081" },
        ],
      }),
    });
    const logs = [];
    const out = await H.collectPreviewHostHandover({ checkoutDir, log: (l) => logs.push(l) });
    expect(out.env).toEqual([[NAME_B, SECRET_B]]);
    expect(out.forwards).toEqual([{ port: 41005, network: "acme-net", host: "svc", targetPort: 8080 }]);
    expect(logs.filter((l) => l.includes("skipped a forward"))).toHaveLength(6);
    expect(logs.filter((l) => l.includes("dropped the env key"))).toHaveLength(2);
    for (const line of logs) expect(line).not.toContain(SECRET_B);
  });

  it("skips a declarer that throws, times out, returns a bad shape or exports nothing, and keeps the others", async () => {
    const H = await loadHandover();
    declarer("acme", "a-throws", { body: `export async function previewHostHandover() { throw new Error("${SECRET_A}"); }\n` });
    declarer("acme", "b-hangs", { body: "export function previewHostHandover() { return new Promise(() => {}); }\n" });
    declarer("acme", "c-shape", { body: 'export async function previewHostHandover() { return "nope"; }\n' });
    declarer("acme", "d-none", { body: "export const other = 1;\n" });
    declarer("acme", "e-good", { body: handing({ env: { [NAME_B]: SECRET_B } }) });
    const logs = [];
    const out = await H.collectPreviewHostHandover({ checkoutDir, deps: { handoverTimeoutMs: 50 }, log: (l) => logs.push(l) });
    expect(out.env).toEqual([[NAME_B, SECRET_B]]);
    const skipped = logs.filter((l) => l.includes(`skipped "${KEY}" of`));
    expect(skipped).toHaveLength(4);
    expect(skipped[0]).toContain(path.join("extensions", "acme", "a-throws"));
    expect(skipped[1]).toContain("timed out");
    for (const line of logs) for (const v of [SECRET_A, SECRET_B]) expect(line).not.toContain(v);
  });
});

const FWD = "cinatra-preview-s1.forward";
const forwarding = (extra = {}) => handing({ forwards: [{ port: 41001, network: "acme-net", target: "acme-svc:8080" }], ...extra });
const unhealthy = async () => ({ status: 503, body: '{"status":"degraded"}' });

describe("cinatra-cli#287 — a re-materialized preview gets the same handover as a created one", () => {
  it("start --recreate boots the new container with the env file, the network joins and one forwarder", async () => {
    declarer("acme", "alpha", { body: forwarding({ env: { [NAME_A]: SECRET_A } }) });
    const { deps, calls, logs, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    calls.length = 0;
    state.envFiles.length = 0;
    const out = await PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    expect(out.rematerialized).toBe(true);
    const run = previewRun(calls);
    expect(run).toContain("--env-file");
    expect(state.envFiles.map((f) => f.text)).toEqual([`${NAME_A}=${SECRET_A}\n`]);
    expect(existsSync(state.envFiles[0].file)).toBe(false);
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", "cinatra-preview-s1"]]);
    expect(forwarderRuns(calls)).toHaveLength(1);
    const oldForwarderGone = calls.findIndex((a) => a[0] === "rm" && a[2] === FWD);
    expect(oldForwarderGone).toBeGreaterThan(-1);
    expect(oldForwarderGone).toBeLessThan(calls.indexOf(run));
    expect([...state.forwarders]).toEqual([FWD]);
    expect(logs.some((l) => l.includes(`${FWD} serves 127.0.0.1:41001`))).toBe(true);
    for (const argv of calls) for (const a of argv) expect(String(a)).not.toContain(SECRET_A);
  });

  it("start re-materializes an absent container with the handover too", async () => {
    declarer("acme", "alpha", { body: forwarding({ env: { [NAME_A]: SECRET_A } }) });
    const { deps, calls, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    state.containerRunning = false;
    calls.length = 0;
    state.envFiles.length = 0;
    const out = await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(out.rematerialized).toBe(true);
    expect(previewRun(calls)).toContain("--env-file");
    expect(state.envFiles.map((f) => f.text)).toEqual([`${NAME_A}=${SECRET_A}\n`]);
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", "cinatra-preview-s1"]]);
    expect(forwarderRuns(calls)).toHaveLength(1);
    expect([...state.forwarders]).toEqual([FWD]);
  });

  it("a recreate that fails its health gate gives the restored container its forwarder back", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, calls, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    calls.length = 0;
    deps.probeHealth = unhealthy;
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(/PREVIOUS container was restored/);
    const restarted = calls.findIndex((a) => a[0] === "start" && a[1] === "cinatra-preview-s1");
    expect(restarted).toBeGreaterThan(-1);
    const runs = forwarderRuns(calls);
    expect(runs).toHaveLength(2);
    expect(calls.indexOf(runs[1])).toBeGreaterThan(restarted);
    expect([...state.forwarders]).toEqual([FWD]);
  });
});

describe("cinatra-cli#287 — the forwarder never outlives the container it served", () => {
  it("a refresh after the declarers are gone removes the old forwarder", async () => {
    const dir = declarer("acme", "alpha", { body: forwarding() });
    const { deps, calls, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect([...state.forwarders]).toEqual([FWD]);
    rmSync(dir, { recursive: true, force: true });
    calls.length = 0;
    await PV.runPreviewRefresh(["--slug", "s1"], deps);
    expect(forwarderRuns(calls)).toHaveLength(0);
    expect(calls).toContainEqual(["rm", "-f", FWD]);
    expect(state.forwarders.size).toBe(0);
  });

  it("a refresh whose network join fails fails, naming the port and the step, and removes the old forwarder", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = {};
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    const { deps, calls } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect([...state.forwarders]).toEqual([FWD]);
    state.joinFails = true;
    calls.length = 0;
    await expect(PV.runPreviewRefresh(["--slug", "s1"], deps))
      .rejects.toThrow("preview host handover: docker network connect acme-net failed for 127.0.0.1:41001");
    expect(forwarderRuns(calls)).toHaveLength(0);
    expect(state.forwarders.size).toBe(0);
  });

  it("a failed health gate removes the forwarder with the container, on create and on refresh", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const failing = makeDeps();
    failing.deps.probeHealth = unhealthy;
    await expect(PV.runPreviewCreate(["--slug", "s1"], failing.deps)).rejects.toThrow(/did not reach healthy/);
    expect(forwarderRuns(failing.calls)).toHaveLength(1);
    expect(failing.state.forwarders.size).toBe(0);

    rmSync(registryPath, { force: true });
    const { deps, calls, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    calls.length = 0;
    deps.probeHealth = unhealthy;
    await expect(PV.runPreviewRefresh(["--slug", "s1"], deps)).rejects.toThrow(/did not reach healthy/);
    expect(forwarderRuns(calls)).toHaveLength(1);
    expect(state.forwarders.size).toBe(0);
  });
});

describe("cinatra-cli#287 — a forward is said to be served only when its listener listens", () => {
  it("a listener whose port is taken reports it, and the other listeners keep serving", async () => {
    const H = await loadHandover();
    const echo = net.createServer((c) => c.pipe(c));
    await new Promise((r) => echo.listen(0, "127.0.0.1", r));
    const taken = net.createServer();
    await new Promise((r) => taken.listen(0, "127.0.0.1", r));
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const free = probe.address().port;
    await new Promise((r) => probe.close(r));
    const busy = taken.address().port;
    const script = H.previewForwarderScript([
      { port: busy, host: "127.0.0.1", targetPort: echo.address().port },
      { port: free, host: "127.0.0.1", targetPort: echo.address().port },
    ]);
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    try {
      for (let i = 0; i < 30 && child.exitCode === null &&
        !(out.includes(`forward-ready ${free}`) && err.includes(`forward-failed ${busy}`)); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(out.split("\n")).toContain(`forward-ready ${free}`);
      expect(err.split("\n")).toContain(`forward-failed ${busy} EADDRINUSE`);
      const answer = await new Promise((resolve) => {
        const s = net.connect(free, "127.0.0.1");
        s.on("error", () => resolve(null));
        s.on("connect", () => s.write("ping"));
        s.on("data", (d) => {
          resolve(String(d));
          s.destroy();
        });
      });
      expect(answer).toBe("ping");
      expect(child.exitCode).toBe(null);
    } finally {
      child.kill();
      await new Promise((r) => taken.close(r));
      await new Promise((r) => echo.close(r));
    }
  });

  it("a declared forward whose listener does not listen fails the start, naming its port", async () => {
    declarer("acme", "alpha", {
      body: handing({ forwards: [
        { port: 41001, network: "acme-net", target: "acme-svc:8080" },
        { port: 41002, network: "acme-net", target: "acme-svc:8081" },
      ] }),
    });
    const { deps, logs, state } = makeDeps({
      forwarderLog: () => ({ status: 0, stdout: "forward-ready 41001\n", stderr: "forward-failed 41002 EADDRINUSE\n" }),
    });
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps))
      .rejects.toThrow("the readiness read failed for 127.0.0.1:41002 in cinatra-preview-s1 (41002 could not listen: EADDRINUSE)");
    expect(logs.some((l) => l.includes(`${FWD} serves`))).toBe(false);
    expect(state.forwarders.size).toBe(0);
  });

  it("a forwarder none of whose listeners listens is removed, and the start fails", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, logs, state } = makeDeps({
      forwarderLog: () => ({ status: 0, stdout: "", stderr: "forward-failed 41001 EADDRINUSE\n" }),
    });
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps))
      .rejects.toThrow("the readiness read failed for 127.0.0.1:41001 in cinatra-preview-s1 (41001 could not listen: EADDRINUSE)");
    expect(logs.some((l) => l.includes(`${FWD} serves`))).toBe(false);
    expect(state.forwarders.size).toBe(0);
  });

  it("refuses a forward on the preview app's own port", async () => {
    const H = await loadHandover();
    declarer("acme", "alpha", {
      body: handing({ forwards: [
        { port: 3000, network: "acme-net", target: "acme-svc:3000" },
        { port: 41001, network: "acme-net", target: "acme-svc:8080" },
      ] }),
    });
    const logs = [];
    const out = await H.collectPreviewHostHandover({ checkoutDir, log: (l) => logs.push(l) });
    expect(out.forwards.map((f) => f.port)).toEqual([41001]);
    expect(logs.filter((l) => l.includes("skipped a forward") && l.includes("the preview app's own port"))).toHaveLength(1);
    const { deps, calls } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    const run = previewRun(calls);
    expect(run[run.indexOf("-p") + 1].endsWith(`:${H.PREVIEW_APP_CONTAINER_PORT}`)).toBe(true);
  });
});

describe("cinatra-cli#287 — a stopped preview that starts again gets its forwards again", () => {
  it("a plain start of a stopped preview re-attaches its forwards: the old forwarder removed first, the network joined, readiness read", async () => {
    declarer("acme", "alpha", {
      body: handing({ env: { [NAME_A]: SECRET_A }, forwards: [
        { port: 3000, network: "acme-net", target: "acme-svc:3000" },
        { port: 41001, network: "acme-net", target: "acme-svc:8080" },
      ] }),
    });
    const { deps, calls, logs, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    calls.length = 0;
    logs.length = 0;
    const out = await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(out).toMatchObject({ container: "running", changed: true, rematerialized: false });
    expect(previewRun(calls)).toBeUndefined();
    const started = calls.findIndex((a) => a[0] === "start" && a[1] === "cinatra-preview-s1");
    const runs = forwarderRuns(calls);
    expect(runs).toHaveLength(1);
    const run = calls.indexOf(runs[0]);
    const removed = calls.findIndex((a) => a[0] === "rm" && a[2] === FWD);
    expect(started).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(started);
    expect(removed).toBeLessThan(run);
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", "cinatra-preview-s1"]]);
    expect(calls.findIndex((a) => a[0] === "logs" && a[1] === FWD)).toBeGreaterThan(run);
    expect(runs[0].at(-1)).not.toContain('"port":3000');
    expect(logs.some((l) => l.includes("port 3000 is the preview app's own port"))).toBe(true);
    expect(logs.some((l) => l.includes(`${FWD} serves 127.0.0.1:41001 in cinatra-preview-s1`))).toBe(true);
    expect(logs.some((l) => l.includes("keeps the env it was created with"))).toBe(true);
    expect([...state.forwarders]).toEqual([FWD]);
    for (const argv of calls) for (const a of argv) expect(String(a)).not.toContain(SECRET_A);
    for (const line of logs) expect(line).not.toContain(SECRET_A);
  });

  it("a plain start with no forward left removes the forwarder from before, and one with no forwarder removes nothing", async () => {
    const dir = declarer("acme", "alpha", { body: forwarding() });
    const { deps, calls, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    rmSync(dir, { recursive: true, force: true });
    calls.length = 0;
    await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(forwarderRuns(calls)).toHaveLength(0);
    expect(calls).toContainEqual(["rm", "-f", FWD]);
    expect(state.forwarders.size).toBe(0);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    calls.length = 0;
    await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(calls.some((a) => a[0] === "rm")).toBe(false);
  });
});

describe("cinatra-cli#303 — a declared forward whose handover failed fails the preview, naming the port and the step", () => {
  const timedOut = Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" });
  const refused = [
    ["network connect exits 1", "docker network connect acme-net",
      { networkAnswer: () => ({ status: 1, stdout: "acme-net\n", stderr: "Error response from daemon: network acme-net not found" }) }],
    ["the forwarder run exits 125 after printing an id", `docker run of the forwarder ${FWD}`,
      { forwarderRunAnswer: () => ({ status: 125, stdout: "deadbeef\n", stderr: "" }) }],
    ["docker logs exits 1 after a forward-ready line", "the readiness read",
      { forwarderLog: () => ({ status: 1, stdout: "forward-ready 41001\n", stderr: "" }) }],
    ["docker logs times out after a forward-ready line", "the readiness read",
      { forwarderLog: () => ({ status: null, error: timedOut, stdout: "forward-ready 41001\n", stderr: "" }) }],
  ];
  for (const [label, step, answer] of refused) {
    it(`refuses valid-looking output with a failed exit: ${label}`, async () => {
      declarer("acme", "alpha", { body: forwarding() });
      const { deps, logs, state } = makeDeps(answer);
      await expect(PV.runPreviewCreate(["--slug", "s1"], deps))
        .rejects.toThrow(`preview host handover: ${step} failed for 127.0.0.1:41001 in cinatra-preview-s1`);
      expect(logs.some((l) => l.includes(`${FWD} serves`))).toBe(false);
      expect(state.forwarders.size).toBe(0);
    });
  }

  it("a failed docker network connect for a declared port fails a plain start of a stopped preview", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = {};
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    const { deps, calls } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.joinFails = true;
    calls.length = 0;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps))
      .rejects.toThrow("preview host handover: docker network connect acme-net failed for 127.0.0.1:41001 in cinatra-preview-s1 (exit 1)");
    expect(forwarderRuns(calls)).toHaveLength(0);
    expect(state.forwarders.size).toBe(0);
  });

  it("a pack that declares no forward: create, stop and start join no network, run no forwarder and read no forwarder log", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A } }) });
    const { deps, calls, state } = makeDeps();
    expect((await PV.runPreviewCreate(["--slug", "s1"], deps)).state).toBe("healthy");
    await PV.runPreviewStop(["--slug", "s1"], deps);
    const created = calls.length;
    state.containerLsAnswer = () => ({ status: 1, stdout: `${FWD}\n`, stderr: "" });
    const out = await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(out).toMatchObject({ container: "running", changed: true, rematerialized: false });
    expect(calls.slice(created).some((a) => a[0] === "rm")).toBe(false);
    expect(calls.some((a) => a[0] === "network")).toBe(false);
    expect(calls.some((a) => a[0] === "logs" && a[1] === FWD)).toBe(false);
    expect(forwarderRuns(calls)).toHaveLength(0);
  });
});

describe("cinatra-cli#303 — the declarer runs under a terminating bound", () => {
  it("a declarer holding a handle gets its abort, is terminated with what it started at the bound, and the CLI exits", async () => {
    const marks = path.join(tmp, "marks");
    mkdirSync(marks);
    const kidFile = path.join(marks, "kid");
    const abortedFile = path.join(marks, "aborted");
    declarer("acme", "holds", {
      body: 'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n' +
        "export function previewHostHandover({ signal }) {\n" +
        '  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
        `  writeFileSync(${JSON.stringify(kidFile)}, String(kid.pid));\n` +
        `  signal?.addEventListener("abort", () => writeFileSync(${JSON.stringify(abortedFile)}, "1"));\n` +
        "  setInterval(() => {}, 1000);\n  return new Promise(() => {});\n}\n",
    });
    const cli = path.join(tmp, "cli.mjs");
    writeFileSync(cli,
      `import { collectPreviewHostHandover } from ${JSON.stringify(new URL("../src/preview-host-handover.mjs", import.meta.url).href)};\n` +
      `const out = await collectPreviewHostHandover({ checkoutDir: ${JSON.stringify(checkoutDir)}, ` +
      "deps: { handoverTimeoutMs: 1000, handoverAbortGraceMs: 500 }, log: (l) => console.log(l) });\n" +
      'console.log(`collected ${out.forwards.length}`);\n');
    const child = spawn(process.execPath, [cli], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 10 s"); }, 10_000);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    const kid = Number(readFileSync(kidFile, "utf8"));
    let kidAlive = true;
    for (let i = 0; i < 20 && kidAlive; i++) {
      try { process.kill(kid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { kidAlive = false; }
    }
    if (kidAlive) process.kill(kid, "SIGKILL");
    expect(code).toBe(0);
    expect(out).toContain(`skipped "${KEY}" of`);
    expect(out).toContain("it timed out");
    expect(existsSync(abortedFile)).toBe(true);
    expect(kidAlive).toBe(false);
  }, 20_000);
});

describe("cinatra-cli#303 — the declarer and what it started end when the CLI ends", () => {
  const endings = [
    ["SIGINT", (cli) => cli.kill("SIGINT")],
    ["SIGTERM", (cli) => cli.kill("SIGTERM")],
    ["SIGHUP", (cli) => cli.kill("SIGHUP")],
    ["a normal exit", (cli) => cli.stdin.write("exit\n")],
    ["an uncaught error", (cli) => cli.stdin.write("throw\n")],
  ];
  for (const [ending, end] of endings) {
    it(`a declarer still running when the CLI ends by ${ending} before the bound is ended with its child`, async () => {
      const pidsFile = path.join(tmp, "pids");
      declarer("acme", "holds", {
        body: 'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\n' +
          "export function previewHostHandover() {\n" +
          '  const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });\n' +
          `  writeFileSync(${JSON.stringify(pidsFile)}, \`\${process.pid} \${kid.pid}\`);\n` +
          "  setInterval(() => {}, 1000);\n  return new Promise(() => {});\n}\n",
      });
      const cli = path.join(tmp, "cli.mjs");
      writeFileSync(cli,
        `import { collectPreviewHostHandover } from ${JSON.stringify(new URL("../src/preview-host-handover.mjs", import.meta.url).href)};\n` +
        'process.stdin.on("data", (d) => { if (String(d).startsWith("exit")) process.exit(0); throw new Error("made-up failure"); });\n' +
        `await collectPreviewHostHandover({ checkoutDir: ${JSON.stringify(checkoutDir)}, deps: { handoverTimeoutMs: 60_000 } });\n`);
      const child = spawn(process.execPath, [cli], { stdio: ["pipe", "ignore", "ignore"] });
      const exited = new Promise((resolve) => child.on("exit", () => resolve(true)));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 100 && !existsSync(pidsFile); i++) await sleep(100);
      await sleep(200);
      const pids = readFileSync(pidsFile, "utf8").split(" ").map(Number);
      end(child);
      const ended = await Promise.race([exited, sleep(10_000).then(() => false)]);
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (let i = 0; i < 30 && pids.some(alive); i++) await sleep(100);
      const left = pids.filter(alive);
      for (const pid of left) process.kill(pid, "SIGKILL");
      if (!ended) child.kill("SIGKILL");
      expect(ended).toBe(true);
      expect(left).toEqual([]);
    }, 30_000);
  }
});

describe("cinatra-cli#303 — a start whose declared forward failed leaves no container running without it", () => {
  const failingJoins = (extra = {}) => {
    const state = { ...extra };
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    return state;
  };
  const JOIN_FAILED = "preview host handover: docker network connect acme-net failed for 127.0.0.1:41001";

  it("a plain start of a stopped preview whose attach fails stops it again, and a second start does not succeed without the forward", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins();
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.joinFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
  });

  it("a start that re-materializes an absent container whose attach fails removes it, and a second start does not succeed without the forward", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    state.containerRunning = false;
    state.joinFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
  });

  it("a recreate whose attach fails, and whose restored container's attach fails too, leaves it stopped; a second start does not succeed without the forward", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    state.joinFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
  });
});
