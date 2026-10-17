// cinatra-cli#287 — the preview HOST HANDOVER: the install profile that tells a
// preview from a production deployment, every declarer of the generic
// `cinatra.devCliModules["preview-host-handover"]` key, the env it hands over in
// a 0600 env file (never in an argv or a log), and the loopback forwarder its
// declared forwards get. Hermetic: docker is a fake; the declarers are made-up
// modules in a temporary checkout; the one real process is the forwarder
// program on loopback ports picked by the system.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";
import { answerPreviewIdentity, liveContainerId, nextRunId } from "./helpers/fake-preview-identity.mjs";
import * as DCM from "../src/dev-cli-modules.mjs";
import * as PV from "../src/preview.mjs";

const loadHandover = () => import("../src/preview-host-handover.mjs");
const H_FORWARDER_OF = "cinatra.preview.forwarder-of";
// The IDs the fake docker prints: the n-th preview run, and the n-th forwarder run.
const RUN_ID = (n) => n.toString(16).padStart(64, "c");
const FWD_ID = (n) => n.toString(16).padStart(64, "f");

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
function declarer(scope, name, { rel = "./handover.mjs", body = null, key = KEY, optional = false } = {}) {
  const dir = path.join(checkoutDir, "extensions", scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@${scope}/${name}`, cinatra: { devCliModules: { [key]: rel }, ...(optional ? { previewHostHandoverOptional: true } : {}) } }),
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
  // The forwarders by the ID their run printed: their name and the container they serve.
  state.forwarderIds = new Map();
  state.forwarderPorts = [];
  const runDocker = (args) => {
    calls.push(args);
    const ownership = answerComposeOwnership(args, state);
    if (ownership) return ownership;
    const identity = answerPreviewIdentity(args, state, { containerExists: (s) => Boolean(s.containerRunning || s.containerStopped) });
    if (identity) return identity;
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
    if (verb === "container" && sub === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
      return state.membershipAnswer?.(args) ?? { status: 0, stdout: '{"bridge":{}}\n', stderr: "" };
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
      if (!args.some((a) => String(a).startsWith("container:"))) {
        state.containerRunning = true;
        return { status: 0, stdout: `${nextRunId(state)}\n`, stderr: "" };
      }
      if (state.forwarderRunAnswer) return state.forwarderRunAnswer(args);
      const name = args[args.indexOf("--name") + 1];
      const of = String(args.find((a) => String(a).startsWith(`${H_FORWARDER_OF}=`)) ?? "").slice(H_FORWARDER_OF.length + 1);
      state.forwarderRunCount = (state.forwarderRunCount ?? 0) + 1;
      const id = state.forwarderRunCount.toString(16).padStart(64, "f");
      state.forwarderIds.set(id, { name, of });
      state.forwarders.add(name);
      state.forwarderPorts = [...String(args.at(-1)).matchAll(/"port":([0-9]+)/g)].map((m) => Number(m[1]));
      return { status: 0, stdout: `${id}\n`, stderr: "" };
    }
    if (verb === "rm") {
      const target = String(args.at(-1));
      if (state.rmAnswer) {
        const answer = state.rmAnswer(args);
        if (answer) return answer;
      }
      const fwd = state.forwarderIds.get(target);
      if (fwd) {
        state.forwarders.delete(fwd.name);
        state.forwarderIds.delete(target);
      }
      // A removal by name (as a CLI before the result line made it) removes that forwarder too.
      if (state.forwarders.delete(target)) {
        for (const [id, f] of state.forwarderIds) if (f.name === target) state.forwarderIds.delete(id);
      }
      if (target === liveContainerId(state) || target === "cinatra-preview-s1") state.containerRunning = state.containerStopped = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "logs" && (state.forwarderIds.has(String(args.at(-1))) || String(args.at(-1)).endsWith(".forward"))) {
      return state.forwarderLog?.(args) ??
        { status: 0, stdout: state.forwarderPorts.map((port) => `forward-ready ${port}\n`).join(""), stderr: "" };
    }
    if (verb === "container" && sub === "ls") {
      if (state.containerLsAnswer) return state.containerLsAnswer(args);
      // A listing by a name (docker matches a part of a name) that prints the IDs: the forwarders under it, each with
      // the container its forwarder-of label names (empty for a forwarder made before that label) when that is asked.
      const byName = args.find((a) => String(a).startsWith("name="));
      const format = String(args[args.indexOf("--format") + 1] ?? "");
      if (byName && format.startsWith("{{.ID}} {{.Names}}")) {
        const part = String(byName).slice("name=".length);
        const rows = [...state.forwarderIds].filter(([, f]) => f.name.includes(part))
          .map(([id, f]) => (format.includes("Label") ? `${id} ${f.name} ${f.of}` : `${id} ${f.name}`));
        return { status: 0, stdout: rows.map((row) => `${row}\n`).join(""), stderr: "" };
      }
      const filter = String(args[args.indexOf("--filter") + 1] ?? "");
      // The status-checked absence listing by name: no other container holds it.
      if (filter.startsWith("name=")) return { status: 0, stdout: "", stderr: "" };
      // The listing by the plain forwarder label names every forwarder (as a CLI before the result line read it).
      if (filter === `label=${"cinatra.preview.forwarder=true"}`) {
        return { status: 0, stdout: [...state.forwarders].map((name) => `${name}\n`).join(""), stderr: "" };
      }
      const of = filter.startsWith(`label=${H_FORWARDER_OF}=`) ? filter.slice(`label=${H_FORWARDER_OF}=`.length) : null;
      const ids = [...state.forwarderIds].filter(([, f]) => f.of === of).map(([id]) => id);
      return { status: 0, stdout: ids.map((id) => `${id}\n`).join(""), stderr: "" };
    }
    if (verb === "rename" && args[2] === "cinatra-preview-s1") state.liveContainerId = args[1];
    if (verb === "stop" && state.stopFails && (state.stops = (state.stops ?? 0) + 1) > (state.stopFailsAfter ?? 0)) {
      return { status: 1, stdout: "", stderr: "Error response from daemon: made-up stop failure" };
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

const membershipReads = (calls) =>
  calls.filter((a) => a[0] === "container" && a[1] === "inspect" && a.includes("{{json .NetworkSettings.Networks}}"));
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
  it("lists every declarer in sorted order, confined to its own dir, and names a path that leaves it as that declarer's failure", () => {
    declarer("zeta", "one");
    declarer("acme", "beta");
    declarer("acme", "alpha");
    declarer("acme", "escape", { rel: "../alpha/handover.mjs" });
    declarer("acme", "other", { key: "another-key" });
    const found = DCM.discoverAllDevCliModulePaths(KEY, checkoutDir);
    expect(found.map((d) => d.packageDir)).toEqual([
      path.join("extensions", "acme", "alpha"),
      path.join("extensions", "acme", "beta"),
      path.join("extensions", "acme", "escape"),
      path.join("extensions", "zeta", "one"),
    ]);
    expect(found[2]).toMatchObject({ modulePath: null, invalid: "its declared module path leaves its package" });
    expect(found[0].modulePath).toBe(path.join(checkoutDir, "extensions", "acme", "alpha", "handover.mjs"));
    expect(DCM.discoverDevCliModulePath(KEY, checkoutDir)).toBe(found[0].modulePath);
    expect(DCM.discoverAllDevCliModulePaths("no-such-key", checkoutDir)).toEqual([]);
  });
});

describe("cinatra-cli#287 — the handed-over env reaches the container in a 0600 env file only", () => {
  it("boots with --env-file holding the namespaced entries; no value in any argv or log; the file is gone after the run", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A } }) });
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
      membershipAnswer: () => ({ status: 0, stdout: '{"acme-net":{},"beta_net":{},"bridge":{}}\n', stderr: "" }),
    });
    const out = await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect(calls.filter((a) => a[0] === "network")).toEqual([
      ["network", "connect", "acme-net", RUN_ID(1)],
      ["network", "connect", "beta_net", RUN_ID(1)],
    ]);
    // The join that exited 1 is a join because the container's membership read lists beta_net, not by its text.
    const reads = membershipReads(calls);
    expect(reads).toEqual([["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", RUN_ID(1)]]);
    expect(calls.indexOf(reads[0])).toBe(calls.findIndex((a) => a[0] === "network" && a[2] === "beta_net") + 1);
    // An earlier forwarder of THIS container is looked up by the label naming its ID before the run.
    const lookup = ["container", "ls", "-a", "--no-trunc", "--filter", `label=${H_FORWARDER_OF}=${RUN_ID(1)}`, "--format", "{{.ID}}"];
    const runs = forwarderRuns(calls);
    expect(runs).toHaveLength(1);
    const fwd = runs[0];
    expect(calls.findIndex((a) => JSON.stringify(a) === JSON.stringify(lookup))).toBeLessThan(calls.indexOf(fwd));
    expect(fwd.slice(0, 6)).toEqual(["run", "-d", "--name", "cinatra-preview-s1.forward", "--network", `container:${RUN_ID(1)}`]);
    expect(fwd).toContain(`${H_FORWARDER_OF}=${RUN_ID(1)}`);
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
  const invalidEntries = [
    ["an env value of two lines", { env: { [NAME_A]: "one\nline" } }, "is not one line of text"],
    ["an env name outside the extension namespace", { env: { lower_case_name: "x" } }, "is not an extension override name"],
    ["a forward below port 1024", { forwards: [{ port: 80, network: "acme-net", target: "svc:1" }] }, "a forward needs"],
    ["a forward on a bad network name", { forwards: [{ port: 41001, network: "bad net", target: "svc:1" }] }, "a forward needs"],
    ["a forward with no target port", { forwards: [{ port: 41002, network: "acme-net", target: "no-port" }] }, "a forward needs"],
    ["a forward to a port past 65535", { forwards: [{ port: 41003, network: "acme-net", target: "svc:99999" }] }, "a forward needs"],
    ["a forward on a fractional port", { forwards: [{ port: 41004.5, network: "acme-net", target: "svc:1" }] }, "a forward needs"],
    ["two forwards on one port", { forwards: [{ port: 41005, network: "acme-net", target: "svc:8080" }, { port: 41005, network: "acme-net", target: "svc:8081" }] }, "a forward needs"],
    ["a forward on the preview app's own port", { forwards: [{ port: 3000, network: "acme-net", target: "svc:3000" }] }, "the preview app's own port"],
  ];
  for (const [label, handed, why] of invalidEntries) {
    it(`a required declarer that hands over ${label} refuses the preview; marked optional, it is skipped whole and named`, async () => {
      const H = await loadHandover();
      const good = { env: { [NAME_B]: SECRET_B }, forwards: [{ port: 41009, network: "acme-net", target: "svc:9" }] };
      const merged = { env: { ...good.env, ...(handed.env ?? {}) }, forwards: [...good.forwards, ...(handed.forwards ?? [])] };
      const dir = declarer("acme", "alpha", { body: handing(merged) });
      await expect(H.collectPreviewHostHandover({ checkoutDir })).rejects.toThrow(
        `the required declarer "${KEY}" of ${path.join("extensions", "acme", "alpha")} failed: `);
      await expect(H.collectPreviewHostHandover({ checkoutDir })).rejects.toThrow(why);
      rmSync(dir, { recursive: true, force: true });
      declarer("acme", "alpha", { body: handing(merged), optional: true });
      const logs = [];
      const out = await H.collectPreviewHostHandover({ checkoutDir, log: (l) => logs.push(l) });
      expect(out.env).toEqual([]);
      expect(out.forwards).toEqual([]);
      expect(out.skipped).toHaveLength(1);
      expect(out.skipped[0].packageDir).toBe(path.join("extensions", "acme", "alpha"));
      expect(out.skipped[0].why).toContain(why);
      expect(logs.filter((l) => l.includes(`skipped "${KEY}" of ${path.join("extensions", "acme", "alpha")}: `))).toHaveLength(1);
      for (const line of logs) expect(line).not.toContain(SECRET_B);
    });
  }

  const failingDeclarers = [
    ["throws", `export async function previewHostHandover() { throw new Error("${SECRET_A}"); }\n`, "it failed"],
    ["hangs past its bound", "export function previewHostHandover() { return new Promise(() => {}); }\n", "it timed out"],
    ["returns a bad shape", 'export async function previewHostHandover() { return "nope"; }\n', "it returned no { env, forwards } object"],
    ["exports nothing", "export const other = 1;\n", "it exports no previewHostHandover function"],
  ];
  for (const [label, body, why] of failingDeclarers) {
    it(`a required declarer that ${label} refuses the create before anything boots, naming it`, async () => {
      declarer("acme", "a-failing", { body });
      declarer("acme", "e-good", { body: handing({ env: { [NAME_B]: SECRET_B } }) });
      const { deps, calls, logs } = makeDeps({ handoverTimeoutMs: 50 });
      const first = PV.runPreviewCreate(["--slug", "s1"], deps);
      await expect(first).rejects.toThrow(`the required declarer "${KEY}" of ${path.join("extensions", "acme", "a-failing")} failed: ${why}`);
      expect(previewRun(calls)).toBeUndefined();
      expect(forwarderRuns(calls)).toHaveLength(0);
      expect(PV.getPreview(PV.readRegistry(registryPath).registry, "s1")).toBeNull();
      for (const line of logs) for (const v of [SECRET_A, SECRET_B]) expect(line).not.toContain(v);
    });
  }

  it("an optional declarer that throws, times out, returns a bad shape or exports nothing is skipped, recorded and named; the others are kept", async () => {
    const H = await loadHandover();
    declarer("acme", "a-throws", { body: failingDeclarers[0][1], optional: true });
    declarer("acme", "b-hangs", { body: failingDeclarers[1][1], optional: true });
    declarer("acme", "c-shape", { body: failingDeclarers[2][1], optional: true });
    declarer("acme", "d-none", { body: failingDeclarers[3][1], optional: true });
    declarer("acme", "e-good", { body: handing({ env: { [NAME_B]: SECRET_B } }) });
    const logs = [];
    const out = await H.collectPreviewHostHandover({ checkoutDir, deps: { handoverTimeoutMs: 50 }, log: (l) => logs.push(l) });
    expect(out.env).toEqual([[NAME_B, SECRET_B]]);
    expect(out.skipped.map((x) => x.packageDir)).toEqual(["a-throws", "b-hangs", "c-shape", "d-none"].map((n) => path.join("extensions", "acme", n)));
    expect(out.skipped.map((x) => x.why)).toEqual(failingDeclarers.map(([, , why]) => why));
    const skipped = logs.filter((l) => l.includes(`skipped "${KEY}" of`));
    expect(skipped).toHaveLength(4);
    expect(skipped[0]).toContain(path.join("extensions", "acme", "a-throws"));
    expect(skipped[1]).toContain("timed out");
    for (const line of logs) for (const v of [SECRET_A, SECRET_B]) expect(line).not.toContain(v);
  });

  it("a manifest the census cannot read refuses the preview: a required declarer may be behind it", async () => {
    const H = await loadHandover();
    declarer("acme", "e-good", { body: handing({ env: { [NAME_B]: SECRET_B } }) });
    const broken = path.join(checkoutDir, "extensions", "acme", "f-broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, "package.json"), "{ not json");
    await expect(H.collectPreviewHostHandover({ checkoutDir })).rejects.toThrow(
      `the declarers of "${KEY}" could not be read (the manifest of ${path.join("extensions", "acme", "f-broken")} is not valid JSON.)`);
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
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", RUN_ID(2)]]);
    expect(forwarderRuns(calls)).toHaveLength(1);
    // The old container's forwarder goes by its own ID, found by the label naming the old container.
    const oldForwarderGone = calls.findIndex((a) => a[0] === "rm" && a[2] === FWD_ID(1));
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
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", RUN_ID(2)]]);
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
    const restarted = calls.findIndex((a) => a[0] === "start" && a[1] === RUN_ID(1));
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
    expect(calls).toContainEqual(["rm", "-f", FWD_ID(1)]);
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
    await expect(H.collectPreviewHostHandover({ checkoutDir })).rejects.toThrow("its forward on port 3000 takes the preview app's own port");
    rmSync(path.join(checkoutDir, "extensions"), { recursive: true, force: true });
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
    const started = calls.findIndex((a) => a[0] === "start" && a[1] === RUN_ID(1));
    const runs = forwarderRuns(calls);
    expect(runs).toHaveLength(1);
    const run = calls.indexOf(runs[0]);
    const removed = calls.findIndex((a) => a[0] === "rm" && a[2] === FWD_ID(1));
    expect(started).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(started);
    expect(removed).toBeLessThan(run);
    expect(calls.filter((a) => a[0] === "network")).toEqual([["network", "connect", "acme-net", RUN_ID(1)]]);
    expect(calls.findIndex((a) => a[0] === "logs" && a[1] === FWD_ID(2))).toBeGreaterThan(run);
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
    expect(calls).toContainEqual(["rm", "-f", FWD_ID(1)]);
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
      optional: true,
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

  it("on a row without a recorded ID, a recreate whose restored container's attach fails and is stopped again records it on the row, not running; the next plain start re-checks it", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    const reg = PV.readRegistry(registryPath).registry;
    const { containerId: _recorded, ...legacy } = PV.getPreview(reg, "s1");
    PV.writeRegistry(registryPath, { ...reg, previews: { ...reg.previews, s1: legacy } });
    state.joinFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow("and STOPPED, because its declared forwards failed");
    const after = PV.getPreview(PV.readRegistry(registryPath).registry, "s1");
    expect(after.state).toBe("degraded");
    expect(after.containerId).toBe(RUN_ID(1));
    expect(after.containerConditions).toEqual([{ id: RUN_ID(1), condition: "not-running", why: "its declared forwards failed after the restore; it was stopped again" }]);
    // the instructed plain start is not refused: it re-checks the recorded container (its forward still fails)
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(JOIN_FAILED);
    expect(state.containerRunning).toBe(false);
  });
});

describe("cinatra-cli#303 — a container whose stop failed is never left ready without its forward", () => {
  const JOIN_FAILED = "preview host handover: docker network connect acme-net failed for 127.0.0.1:41001";
  const REFUSED = "a plain start refuses it until `cinatra instance preview start --slug s1 --recreate` replaces its container. Nothing was changed.";
  const failingJoins = (extra = {}) => {
    const state = { ...extra };
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    return state;
  };

  it("a recreate whose restored container's attach and stop both fail says whether it was stopped again is not settled, and a second plain start is refused", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps, logs } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    state.joinFails = true;
    state.stopFails = true;
    state.stopFailsAfter = 1; // the stop that sets the old container aside succeeds; the restored one's fails
    const first = PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    await expect(first).rejects.toThrow("docker stop answered exit 1: whether it was stopped again is not settled");
    await expect(first).rejects.not.toThrow("and STOPPED");
    logs.length = 0;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(REFUSED);
    expect(logs.some((l) => l.includes("is already running"))).toBe(false);
  });

  it("a plain start whose attach and stop both fail leaves the row degraded, and a second plain start is refused", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins();
    const { deps, logs } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.joinFails = true;
    state.stopFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow("perhaps NOT stopped again: docker stop answered exit 1");
    logs.length = 0;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(REFUSED);
    expect(logs.some((l) => l.includes("is already running"))).toBe(false);
  });
});

describe("cinatra-cli#305 — a network join is read by its exit status and the container's membership, never by its text", () => {
  const ALREADY = "Error response from daemon: endpoint with name cinatra-preview-s1 already exists in network acme-net";
  const JOIN_FAILED = "preview host handover: docker network connect acme-net failed for 127.0.0.1:41001 in cinatra-preview-s1";
  const timedOut = Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" });
  const joinExits1 = (stderr) => () => ({ status: 1, stdout: "", stderr });

  it("a join that exits 1 saying it already exists, whose membership read does not list the network, fails the preview", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, calls, logs, state } = makeDeps({ networkAnswer: joinExits1(ALREADY) });
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow(`${JOIN_FAILED} (exit 1)`);
    expect(membershipReads(calls)).toHaveLength(1);
    expect(forwarderRuns(calls)).toHaveLength(0);
    expect(logs.some((l) => l.includes(`${FWD} serves`))).toBe(false);
    expect(state.forwarders.size).toBe(0);
  });

  it("a join that exits 1 with any text is a join when the membership read exits 0 listing the network", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, calls, logs, state } = makeDeps({
      networkAnswer: joinExits1("Error response from daemon: made-up join failure"),
      membershipAnswer: () => ({ status: 0, stdout: '{"acme-net":{"NetworkID":"n1"},"bridge":{}}\n', stderr: "" }),
    });
    expect((await PV.runPreviewCreate(["--slug", "s1"], deps)).state).toBe("healthy");
    const reads = membershipReads(calls);
    expect(reads).toHaveLength(1);
    expect(calls.indexOf(reads[0])).toBe(calls.findIndex((a) => a[0] === "network" && a[1] === "connect") + 1);
    expect(forwarderRuns(calls)).toHaveLength(1);
    expect(logs.some((l) => l.includes(`${FWD} serves 127.0.0.1:41001`))).toBe(true);
    expect([...state.forwarders]).toEqual([FWD]);
  });

  const unread = [
    ["the membership read exits 1 after printing the network", `its membership read failed: docker container inspect ${RUN_ID(1)}: exit 1`,
      () => ({ status: 1, stdout: '{"acme-net":{}}\n', stderr: "Error: made-up inspect failure" })],
    ["the membership read times out after printing the network", `its membership read failed: docker container inspect ${RUN_ID(1)}: ETIMEDOUT`,
      () => ({ status: null, error: timedOut, stdout: '{"acme-net":{}}\n', stderr: "" })],
    ["the membership read exits 0 with no map of networks", "its answer is not a map of networks",
      () => ({ status: 0, stdout: "acme-net\n", stderr: "" })],
  ];
  for (const [label, why, membershipAnswer] of unread) {
    it(`a join that exits 1 saying it already exists fails the preview when ${label}`, async () => {
      declarer("acme", "alpha", { body: forwarding() });
      const { deps, calls, logs, state } = makeDeps({ networkAnswer: joinExits1(ALREADY), membershipAnswer });
      const first = PV.runPreviewCreate(["--slug", "s1"], deps);
      await expect(first).rejects.toThrow(`${JOIN_FAILED} (exit 1; `);
      await expect(first).rejects.toThrow(why);
      expect(forwarderRuns(calls)).toHaveLength(0);
      expect(logs.some((l) => l.includes(`${FWD} serves`))).toBe(false);
      expect(state.forwarders.size).toBe(0);
    });
  }
});

describe("cinatra-cli#305 — the declarer is bounded from its spawn", () => {
  it("a runner stopped before it reports that it started settles at the start bound, and its group is killed", async () => {
    const pidsFile = path.join(tmp, "pids");
    const stopper = path.join(tmp, "stop-before-start.cjs");
    // Loaded before the runner's own code: it starts a child in its group, records both pids and stops itself.
    writeFileSync(stopper,
      'const { spawn } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\n' +
      "const env = { ...process.env };\ndelete env.NODE_OPTIONS;\n" +
      'const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });\n' +
      `writeFileSync(${JSON.stringify(pidsFile)}, \`\${process.pid} \${kid.pid}\`);\n` +
      'process.kill(process.pid, "SIGSTOP");\n');
    declarer("acme", "never-starts", { body: handing({ env: { [NAME_B]: SECRET_B } }), optional: true });
    const cli = path.join(tmp, "cli.mjs");
    writeFileSync(cli,
      `import { collectPreviewHostHandover } from ${JSON.stringify(new URL("../src/preview-host-handover.mjs", import.meta.url).href)};\n` +
      `process.env.NODE_OPTIONS = ${JSON.stringify(`--require ${stopper}`)};\n` +
      `const out = await collectPreviewHostHandover({ checkoutDir: ${JSON.stringify(checkoutDir)}, ` +
      "deps: { handoverStartTimeoutMs: 1000, handoverTimeoutMs: 60_000, handoverAbortGraceMs: 300 }, log: (l) => console.log(l) });\n" +
      'console.log(`collected ${out.env.length}`);\n');
    const child = spawn(process.execPath, [cli], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let pids = [];
    let left = [];
    let code;
    try {
      code = await new Promise((resolve) => {
        const t = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 10 s"); }, 10_000);
        child.on("exit", (c) => { clearTimeout(t); resolve(c); });
      });
      pids = existsSync(pidsFile) ? readFileSync(pidsFile, "utf8").split(" ").map(Number) : [];
      for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
      left = pids.filter(alive);
    } finally {
      if (!pids.length && existsSync(pidsFile)) pids = readFileSync(pidsFile, "utf8").split(" ").map(Number);
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    expect(code).toBe(0);
    expect(pids).toHaveLength(2);
    expect(out).toContain(`skipped "${KEY}" of ${path.join("extensions", "acme", "never-starts")}: it timed out before it started.`);
    expect(out).toContain("collected 0");
    expect(left).toEqual([]);
  }, 20_000);

  it("a declarer that answers after its abort is still timed out: the bound, once expired, is the outcome", async () => {
    const H = await loadHandover();
    declarer("acme", "late", {
      optional: true,
      body: "export function previewHostHandover({ signal }) {\n" +
        `  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(${JSON.stringify({ env: { [NAME_B]: SECRET_B } })})));\n}\n`,
    });
    const logs = [];
    const out = await H.collectPreviewHostHandover({
      checkoutDir, deps: { handoverTimeoutMs: 300, handoverAbortGraceMs: 2_000 }, log: (l) => logs.push(l),
    });
    expect(out.env).toEqual([]);
    expect(logs.filter((l) => l.includes(`skipped "${KEY}" of`) && l.includes("it timed out."))).toHaveLength(1);
    for (const line of logs) expect(line).not.toContain(SECRET_B);
  });
});

// A failed forwarder removal or listing on the attach, the restore and the plain start leaves the row degraded with a
// non-empty cleanupIncomplete list naming what is left, and no result line.
describe("cinatra-cli#307 — a forwarder cleanup that fails is recorded on a degraded row", () => {
  const fwdFails = (id) => (args) => (args.at(-1) === id ? { status: 1, stdout: "", stderr: "Error: made-up forwarder removal failure" } : null);
  const notReady = (id) => (args) => (args.at(-1) === id ? { status: 0, stdout: "forward-failed 41001 EADDRINUSE\n", stderr: "" } : null);
  const idLines = (logs) => logs.filter((l) => /^preview_container_id=/.test(l));
  const slot = () => PV.getPreview(PV.readRegistry(registryPath).registry, "s1");

  it("a create whose forwarder is not served and cannot be removed leaves the row degraded with the forwarder in cleanupIncomplete", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = {};
    state.forwarderLog = (args) => notReady(FWD_ID(1))(args) ??
      { status: 0, stdout: state.forwarderPorts.map((port) => `forward-ready ${port}\n`).join(""), stderr: "" };
    state.rmAnswer = fwdFails(FWD_ID(1));
    const { deps, logs } = makeDeps(state);
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow(/cleanup-incomplete: forwarder/);
    expect(idLines(logs)).toEqual([]);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toEqual([{ kind: "forwarder", id: FWD_ID(1), why: "docker rm: exit 1" }]);
  });

  it("a recreate whose restored container's forwarder is not served and cannot be removed leaves the row degraded, with no result line", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = { imagePresent: true };
    state.forwarderLog = (args) => notReady(FWD_ID(3))(args) ??
      { status: 0, stdout: state.forwarderPorts.map((port) => `forward-ready ${port}\n`).join(""), stderr: "" };
    const { deps, logs } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    deps.probeHealth = unhealthy;
    state.rmAnswer = fwdFails(FWD_ID(3));
    logs.length = 0;
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(/did not reach healthy after re-materializing/);
    expect(idLines(logs)).toEqual([]);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toEqual([{ kind: "forwarder", id: FWD_ID(3), why: "docker rm: exit 1" }]);
  });

  it("a plain start whose forwarder listing fails leaves the row degraded with the listing in cleanupIncomplete", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A } }) });
    const state = {};
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.containerLsAnswer = (args) => (args.some((x) => String(x).startsWith(`label=${H_FORWARDER_OF}=`))
      ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: "", stderr: "" });
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(/could not be removed/);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toHaveLength(1);
    expect(slot().cleanupIncomplete[0]).toMatchObject({ kind: "forwarder-listing", id: RUN_ID(1) });
  });
});

describe("cinatra-cli#307 — the result line has one writer, and a failed stop after a failed attach is recorded", () => {
  it("a declarer can print nothing on the CLI's stdout: its own output is dropped and its log lines are one prefixed line each", async () => {
    const forged = `preview_container_id=${"e".repeat(64)}`;
    declarer("acme", "forger", {
      body: "export async function previewHostHandover({ log }) {\n" +
        `  console.log(${JSON.stringify(forged)});\n  log(${JSON.stringify(`x\n${forged}`)});\n  return {};\n}\n`,
    });
    const cli = path.join(tmp, "cli.mjs");
    writeFileSync(cli,
      `import { collectPreviewHostHandover } from ${JSON.stringify(new URL("../src/preview-host-handover.mjs", import.meta.url).href)};\n` +
      `await collectPreviewHostHandover({ checkoutDir: ${JSON.stringify(checkoutDir)}, log: (l) => console.log(l) });\n` +
      'console.log("collected");\n');
    const child = spawn(process.execPath, [cli], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); resolve("still running after 10 s"); }, 10_000);
      child.on("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    expect(code).toBe(0);
    expect(out).toContain("collected");
    expect(out.split("\n").filter((l) => l.startsWith("preview_container_id="))).toEqual([]);
    expect(out).toContain(`preview host handover log: x ${forged}`);
  }, 20_000);

  it("a plain start whose attach and stop both fail records the running container as a condition, never a leftover; no read clears it: the next plain start is refused and start --recreate replaces it", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = { imagePresent: true };
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    const { deps, logs } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.joinFails = true;
    state.stopFails = true;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow("perhaps NOT stopped again: docker stop answered exit 1");
    let slot = PV.getPreview(PV.readRegistry(registryPath).registry, "s1");
    expect(slot.state).toBe("degraded");
    // The row's own container is never a thing to remove: it is a condition of it.
    expect(slot.cleanupIncomplete).toBeUndefined();
    expect(slot.containerConditions).toEqual([{ id: RUN_ID(1), condition: "state-unsettled", why: "docker stop answered exit 1; whether it took effect is not settled" }]);
    // No read clears it (the stop may still land): the next plain start is refused, changing nothing.
    state.joinFails = false;
    state.stopFails = false;
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(
      "a plain start refuses it until `cinatra instance preview start --slug s1 --recreate` replaces its container. Nothing was changed.");
    expect(PV.getPreview(PV.readRegistry(registryPath).registry, "s1").containerConditions).toEqual(slot.containerConditions);
    // start --recreate replaces the container: the new one, with its forward, reads ready.
    logs.length = 0;
    await PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    slot = PV.getPreview(PV.readRegistry(registryPath).registry, "s1");
    expect(slot.state).toBe("ready");
    expect(slot.containerId).not.toBe(RUN_ID(1));
    expect(slot.containerConditions).toBeUndefined();
    expect(slot.cleanupIncomplete).toBeUndefined();
    expect(state.forwarders.size).toBe(1);
    expect(logs.filter((l) => /^preview_container_id=/.test(l))).toEqual([`preview_container_id=${slot.containerId}`]);
  });
});


describe("cinatra-cli#307 — the handover's declaration, re-probe and env-file rows", () => {
  it("a declaration of the key with no module path, or one that leaves its package, refuses when required and is named when optional", async () => {
    const H = await loadHandover();
    const dir = declarer("acme", "bad", { rel: "../elsewhere.mjs" });
    await expect(H.collectPreviewHostHandover({ checkoutDir })).rejects.toThrow(
      `the required declarer "${KEY}" of ${path.join("extensions", "acme", "bad")} failed: its declared module path leaves its package`);
    rmSync(dir, { recursive: true, force: true });
    declarer("acme", "bad", { rel: "", optional: true });
    const logs = [];
    const out = await H.collectPreviewHostHandover({ checkoutDir, log: (l) => logs.push(l) });
    expect(out.skipped).toEqual([{ packageDir: path.join("extensions", "acme", "bad"), why: "it declares the key with no module path" }]);
    expect(logs.filter((l) => l.includes(`skipped "${KEY}" of ${path.join("extensions", "acme", "bad")}`))).toHaveLength(1);
  });

  it("a degraded re-probe with no forward left removes the forwarder an earlier contribution left on the container", async () => {
    const dir = declarer("acme", "alpha", { body: forwarding() });
    const { deps, state } = makeDeps();
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect([...state.forwarders]).toEqual([FWD]);
    const reg = PV.readRegistry(registryPath).registry;
    PV.writeRegistry(registryPath, { ...reg, previews: { s1: { ...reg.previews.s1, state: "degraded" } } });
    rmSync(dir, { recursive: true, force: true });
    await PV.runPreviewStart(["--slug", "s1"], deps);
    expect(state.forwarders.size).toBe(0);
    expect(PV.getPreview(PV.readRegistry(registryPath).registry, "s1").state).toBe("ready");
  });

  it("a handover env file that cannot be removed refuses the create and removes the container its own run made, by its ID", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A } }) });
    const envDir = path.join(tmp, "envdir");
    mkdirSync(envDir);
    const state = {};
    const { deps, calls } = makeDeps(state);
    deps.envFileTmpDir = envDir;
    const run = deps.runDocker;
    deps.runDocker = (args, o) => {
      const r = run(args, o);
      if (args[0] === "run" && !args.some((a) => String(a).startsWith("container:"))) spawnSyncChmod(envDir, 0o500);
      return r;
    };
    try {
      await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow(/the handover env file could not be removed/);
    } finally {
      spawnSyncChmod(envDir, 0o700);
    }
    expect(calls).toContainEqual(["rm", "-f", RUN_ID(1)]);
  });
});

  it("a run that exits non-zero after docker created its container, with an env file that cannot be removed, still removes exactly the cidfile's ID", async () => {
    declarer("acme", "alpha", { body: handing({ env: { [NAME_A]: SECRET_A } }) });
    const envDir = path.join(tmp, "envdir");
    mkdirSync(envDir);
    const state = {};
    const { deps, calls } = makeDeps(state);
    deps.envFileTmpDir = envDir;
    const created = "a".repeat(64);
    const run = deps.runDocker;
    deps.runDocker = (args, o) => {
      if (args[0] === "run" && !args.some((a) => String(a).startsWith("container:"))) {
        const cid = args.indexOf("--cidfile");
        if (cid !== -1) writeFileSync(args[cid + 1], `${created}\n`);
        spawnSyncChmod(envDir, 0o500);
        calls.push(args);
        return { status: 125, stdout: "", stderr: "Error: made-up start failure after the create" };
      }
      return run(args, o);
    };
    try {
      await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow(/the handover env file could not be removed/);
    } finally {
      spawnSyncChmod(envDir, 0o700);
    }
    expect(calls.filter((c) => c[0] === "rm" && !c.includes("-rf"))).toEqual([["rm", "-f", created]]);
    expect(PV.getPreview(PV.readRegistry(registryPath).registry, "s1")).toBeNull();
  });

/** chmod of the test's own temporary folder: a folder the env file's removal then cannot change. */
function spawnSyncChmod(dir, mode) {
  chmodSync(dir, mode);
}

describe("cinatra-cli#307 — a container change docker answers with no success is never settled by the command that made it", () => {
  const timedOut = () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  /** The `n`-th `docker <verb>` call (1-based). */
  const nth = (verb, n) => {
    let seen = 0;
    return (args) => args[0] === verb && ++seen === n;
  };
  /**
   * The call `pick` selects answers a timeout BEFORE it takes effect (a client
   * timeout on a busy daemon, which finishes the call later): its effect lands
   * right after the next read of that container's state by its ID (that read
   * still sees the old state), or when the returned `land()` is called. No read
   * the command makes can see it done.
   */
  const effectAfterAnswer = (deps, pick) => {
    const run = deps.runDocker;
    let pending = null;
    const land = () => {
      if (!pending) return;
      const args = pending;
      pending = null;
      run(args, {});
    };
    deps.runDocker = (args, o) => {
      if (pending && args[0] === "container" && args[1] === "inspect" && args.includes("{{.State.Running}}") && args.at(-1) === pending.at(-1)) {
        const seen = run(args, o);
        land();
        return seen;
      }
      if (pick(args)) {
        pending = args;
        return timedOut();
      }
      return run(args, o);
    };
    return land;
  };
  const slot = () => PV.getPreview(PV.readRegistry(registryPath).registry, "s1");
  const failingJoins = (extra = {}) => {
    const state = { ...extra };
    state.networkAnswer = () => state.joinFails
      ? { status: 1, stdout: "", stderr: "Error response from daemon: network acme-net not found" }
      : { status: 0, stdout: "", stderr: "" };
    return state;
  };
  const dropRecordedId = () => {
    const reg = PV.readRegistry(registryPath).registry;
    const { containerId: _recorded, ...legacy } = PV.getPreview(reg, "s1");
    PV.writeRegistry(registryPath, { ...reg, previews: { ...reg.previews, s1: legacy } });
  };
  const unsettled = (verb) => [{ id: RUN_ID(1), condition: "state-unsettled", why: `docker ${verb} answered timed out; whether it took effect is not settled` }];
  const REFUSES = "a plain start refuses it until `cinatra instance preview start --slug s1 --recreate` replaces its container";
  /**
   * No read clears a stop or start that is not settled: the plain start is
   * refused before any docker call and changes nothing; start --recreate
   * replaces the container, and the row reads ready.
   */
  const refusedThenReplaced = async (deps) => {
    const before = JSON.stringify(slot());
    const run = deps.runDocker;
    let calls = 0;
    deps.runDocker = (args, o) => {
      calls += 1;
      return run(args, o);
    };
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(`${REFUSES}. Nothing was changed.`);
    deps.runDocker = run;
    expect(calls).toBe(0);
    expect(JSON.stringify(slot())).toBe(before);
    await PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    expect(slot().state).toBe("ready");
    expect(slot().containerId).not.toBe(RUN_ID(1));
    expect(slot().containerConditions).toBeUndefined();
  };
  /**
   * The forwarder's run answers `answer` BEFORE it takes effect: the daemon
   * makes the forwarder only after the attach's own listing of the forwarders
   * labelled with the container's ID has read none. No read the command makes
   * can see it made.
   */
  const forwarderLandsAfterListing = (deps, answer) => {
    const run = deps.runDocker;
    let pending = null;
    deps.runDocker = (args, o) => {
      if (args[0] === "run" && args.some((a) => String(a).startsWith("container:"))) {
        pending = args;
        return answer();
      }
      const seen = run(args, o);
      if (pending && args[0] === "container" && args[1] === "ls" && args.some((a) => String(a).startsWith(`label=${H_FORWARDER_OF}=`))) {
        const late = pending;
        pending = null;
        run(late, {});
      }
      return seen;
    };
  };
  const forwarderUnknownRun = (why) => ({ kind: "run", name: FWD,
    why: `docker run answered ${why} and named no container ID; a container may exist under ${FWD}` });

  it.each([
    ["times out", () => timedOut(), "timed out"],
    ["exits non-zero", () => ({ status: 125, stdout: "", stderr: "docker: Error response from daemon: Conflict." }), "exit 125"],
  ])("a forwarder run that %s and lands after the attach's listing leaves the row degraded naming the run by the forwarder's name, never the prior ready", async (_, answer, why) => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    expect(slot().state).toBe("ready");
    forwarderLandsAfterListing(deps, answer);
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(`docker run of the forwarder ${FWD}`);
    // the forwarder exists now: no read of this command saw it
    expect(state.forwarders.has(FWD)).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toContainEqual(forwarderUnknownRun(why));
  });

  it("a forwarder run that times out and lands only after a later start: that start never reads the row ready, and the row still names the run once it lands", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    // the forwarder's run answers a timeout; the daemon makes it only when the test lands it
    const run = deps.runDocker;
    let pending = null;
    deps.runDocker = (args, o) => {
      if (!pending && args[0] === "run" && args.some((a) => String(a).startsWith("container:"))) {
        pending = args;
        return timedOut();
      }
      return run(args, o);
    };
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(`docker run of the forwarder ${FWD}`);
    expect(slot().cleanupIncomplete).toContainEqual(forwarderUnknownRun("timed out"));
    // the declarers ask for no forward now: the later start runs nothing under that name, and every read it makes finds none there
    declarer("acme", "alpha", { body: handing({}) });
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(FWD);
    expect(state.forwarders.has(FWD)).toBe(false);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toContainEqual(forwarderUnknownRun("timed out"));
    run(pending, {});
    expect(state.forwarders.has(FWD)).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toContainEqual(forwarderUnknownRun("timed out"));
  });

  it("a fresh create whose forwarder run times out and lands after the attach's listing keeps its row degraded, naming the run, never deleted", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, state } = makeDeps({});
    forwarderLandsAfterListing(deps, () => timedOut());
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow(`docker run of the forwarder ${FWD}`);
    // the forwarder was made after the attach's read (a later removal of the create's own may take it away: cleanup only)
    expect(state.forwarderRunCount).toBe(1);
    expect(slot()).toMatchObject({ state: "degraded" });
    expect(slot().cleanupIncomplete).toContainEqual(forwarderUnknownRun("timed out"));
  });


  it("stop: a stop that answers a timeout and lands only after a later start: that plain start was refused, so the row never reads ready while the stop may still land", async () => {
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    const land = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStop(["--slug", "s1"], deps)).rejects.toThrow(
      `docker stop of preview cinatra-preview-s1 answered timed out; whether it took effect is not settled. Its row is degraded; ${REFUSES}.`);
    expect(state.containerRunning).toBe(true);
    // the later plain start would read the container running: it is refused before any read
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(`${REFUSES}. Nothing was changed.`);
    land();
    expect(state.containerStopped).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    await refusedThenReplaced(deps);
  });

  it("stop on a row without a recorded ID: a stop that answers a timeout names its container on the row and names start --recreate as the step", async () => {
    const { deps } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    dropRecordedId();
    const land = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStop(["--slug", "s1"], deps)).rejects.toThrow(`Its row is degraded; ${REFUSES}.`);
    land();
    expect(slot().state).toBe("degraded");
    expect(slot().cleanupIncomplete).toEqual([{ kind: "container", id: RUN_ID(1), why: "docker stop answered timed out; whether it took effect is not settled" }]);
  });

  /** The registry the next command reads: it parses, and the row's two lists pass the row's own validator. */
  const rowReadable = (label) => {
    expect(PV.readRegistry(registryPath).status, label).toBe("ok");
  };
  const STOP_WHY = "docker stop answered timed out; whether it took effect is not settled";
  const failForwarderListing = (deps) => {
    const run = deps.runDocker;
    deps.runDocker = (args, o) => (args[0] === "container" && args[1] === "ls" && args.some((x) => String(x).startsWith(`label=${H_FORWARDER_OF}=`))
      ? { status: 1, stdout: "", stderr: "" } : run(args, o));
    return () => { deps.runDocker = run; };
  };

  it("stop, then start --recreate, on a row without a recorded ID, each stop answering a timeout: the stop's leftover becomes a condition of the container put back, and the registry still reads", async () => {
    const { deps } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    dropRecordedId();
    const landStop = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStop(["--slug", "s1"], deps)).rejects.toThrow(`Its row is degraded; ${REFUSES}.`);
    landStop();
    const landAside = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow("whether it is stopped is not settled");
    landAside();
    rowReadable("after the recreate");
    expect(slot().state).toBe("degraded");
    expect(slot().containerId).toBe(RUN_ID(1));
    expect(slot().cleanupIncomplete).toBeUndefined();
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    await refusedThenReplaced(deps);
  });

  it("stop answering a timeout on a row without a recorded ID, then start --recreate putting the container back stopped: the earlier stop stays as state-unsettled beside not-running, so the step named is start --recreate", async () => {
    const { deps } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    dropRecordedId();
    const landStop = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStop(["--slug", "s1"], deps)).rejects.toThrow(`Its row is degraded; ${REFUSES}.`);
    landStop();
    const listsAgain = failForwarderListing(deps);
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(
      `it keeps its name cinatra-preview-s1, stopped, and an earlier change of it is not settled; its row is degraded, and ${REFUSES}.`);
    listsAgain();
    rowReadable("after the recreate");
    expect(slot().state).toBe("degraded");
    expect(slot().containerId).toBe(RUN_ID(1));
    expect(slot().containerConditions).toEqual([
      { id: RUN_ID(1), condition: "state-unsettled", why: STOP_WHY },
      { id: RUN_ID(1), condition: "not-running", why: "set aside and stopped, then put back stopped: the removal of its forwarders failed" },
    ]);
    expect(slot().cleanupIncomplete).toHaveLength(1);
    expect(slot().cleanupIncomplete[0]).toMatchObject({ kind: "forwarder-listing", id: RUN_ID(1) });
    await refusedThenReplaced(deps);
  });

  /**
   * Every ordered pair of the commands that write an existing row, on a row
   * with and without a recorded ID, each command with each of its container
   * changes answering a timeout first (or none): after each command the
   * registry reads, and the row passes its own validator.
   */
  const PAIR_COMMANDS = {
    stop: (deps) => PV.runPreviewStop(["--slug", "s1"], deps),
    start: (deps) => PV.runPreviewStart(["--slug", "s1"], deps),
    recreate: (deps) => PV.runPreviewStart(["--slug", "s1", "--recreate"], deps),
  };
  const PAIR_FAULTS = [null, "stop", "start", "rename", "rm"];
  const pairs = [false, true].flatMap((legacy) => Object.keys(PAIR_COMMANDS)
    .flatMap((a) => Object.keys(PAIR_COMMANDS).map((b) => [legacy ? "without a recorded ID" : "with a recorded ID", a, b])));
  it.each(pairs)("a row %s: %s then %s, with each change answering a timeout in turn, always leaves a row the registry reads", async (kind, a, b) => {
    for (const fa of PAIR_FAULTS) {
      for (const fb of PAIR_FAULTS) {
        const label = `${kind}: ${a}${fa ? ` (${fa} timed out)` : ""}, then ${b}${fb ? ` (${fb} timed out)` : ""}`;
        rmSync(registryPath, { force: true });
        const { deps } = makeDeps({ imagePresent: true });
        await PV.runPreviewCreate(["--slug", "s1"], deps);
        if (kind === "without a recorded ID") dropRecordedId();
        const landA = fa ? effectAfterAnswer(deps, nth(fa, 1)) : () => {};
        await PAIR_COMMANDS[a](deps).catch(() => {});
        landA();
        rowReadable(`${label}: after ${a}`);
        const landB = fb ? effectAfterAnswer(deps, nth(fb, 1)) : () => {};
        await PAIR_COMMANDS[b](deps).catch(() => {});
        landB();
        rowReadable(`${label}: after ${b}`);
      }
    }
  });

  it("plain start: a start that answers a timeout and lands after it leaves the row degraded with state-unsettled, so a plain start is refused, never the running no-op", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, state, logs } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.forwarders.clear();
    state.forwarderIds.clear();
    const land = effectAfterAnswer(deps, nth("start", 1));
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(
      "answered timed out; whether it took effect is not settled, so it may be running without its health gate and its declared forwards.");
    land();
    expect(state.containerRunning).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().containerConditions).toEqual(unsettled("start"));
    logs.length = 0;
    await refusedThenReplaced(deps);
    expect(logs.some((l) => l.includes("is already running"))).toBe(false);
    expect(state.forwarders.has(FWD)).toBe(true);
  });

  it("plain start: a stop after a failed attach that answers a timeout and lands after it is a condition, never 'stopped again'; a plain start is refused until start --recreate replaces it", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    await PV.runPreviewStop(["--slug", "s1"], deps);
    state.joinFails = true;
    const land = effectAfterAnswer(deps, nth("stop", 1));
    const failed = PV.runPreviewStart(["--slug", "s1"], deps);
    await expect(failed).rejects.toThrow("perhaps NOT stopped again: docker stop answered timed out, and whether it took effect is not settled");
    await expect(failed).rejects.not.toThrow("stopped again.");
    land();
    expect(slot().state).toBe("degraded");
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    state.joinFails = false;
    await refusedThenReplaced(deps);
  });

  it("recreate: a stop of the container set aside that answers a timeout and lands after it puts it back with state-unsettled, never as found; a plain start is refused until start --recreate replaces it", async () => {
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    const land = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(
      `it keeps its name cinatra-preview-s1, and whether it is stopped is not settled; its row is degraded, and ${REFUSES}.`,
    );
    land();
    expect(state.containerStopped).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().containerId).toBe(RUN_ID(1));
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    await refusedThenReplaced(deps);
  });

  it("recreate on a row without a recorded ID: a stop of the container set aside that answers a timeout and lands after it records it on the row with state-unsettled; a plain start is refused until start --recreate replaces it", async () => {
    const { deps } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    dropRecordedId();
    const land = effectAfterAnswer(deps, nth("stop", 1));
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow("whether it is stopped is not settled");
    land();
    expect(slot().state).toBe("degraded");
    expect(slot().containerId).toBe(RUN_ID(1));
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    await refusedThenReplaced(deps);
  });

  const failNewRun = (deps) => {
    const run = deps.runDocker;
    deps.runDocker = (args, o) => (args[0] === "run" && !args.some((a) => String(a).startsWith("container:"))
      ? { status: 1, stdout: "", stderr: "made-up run failure" } : run(args, o));
  };

  it("recreate: a start of the restored container that answers a timeout and lands after it is the condition state-unsettled; a plain start is refused until start --recreate replaces it", async () => {
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    const healthy = deps.runDocker;
    failNewRun(deps);
    const land = effectAfterAnswer(deps, nth("start", 1));
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(
      "but docker start answered timed out: whether it took effect is not settled, so it may or may not be running",
    );
    land();
    expect(state.containerRunning).toBe(true);
    expect(slot().state).toBe("degraded");
    expect(slot().containerConditions).toEqual(unsettled("start"));
    deps.runDocker = healthy;
    await refusedThenReplaced(deps);
  });

  it("recreate: a stop of the restored container after its failed attach that answers a timeout and lands after it is the condition state-unsettled, never 'STOPPED'; a plain start is refused until start --recreate replaces it", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = failingJoins({ imagePresent: true });
    const { deps } = makeDeps(state);
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    state.joinFails = true;
    const land = effectAfterAnswer(deps, nth("stop", 2));
    const failed = PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    await expect(failed).rejects.toThrow("whether it was stopped again is not settled");
    await expect(failed).rejects.not.toThrow("and STOPPED");
    land();
    expect(slot().state).toBe("degraded");
    expect(slot().containerConditions).toEqual(unsettled("stop"));
    state.joinFails = false;
    await refusedThenReplaced(deps);
  });

  it("recreate on a row without a recorded ID: a restore that puts the container back clean names start --recreate, the step the row accepts", async () => {
    const { deps } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    dropRecordedId();
    failNewRun(deps);
    await expect(PV.runPreviewStart(["--slug", "s1", "--recreate"], deps)).rejects.toThrow(
      "this run left the preview as it found it; its row still records no container ID, so a plain start refuses it and " +
        "`cinatra instance preview start --slug s1 --recreate` is the step it accepts.",
    );
    expect(slot().containerId).toBeUndefined();
  });

  it("start --recreate removes a forwarder an older CLI made (no forwarder-of label) by its exact name; a forwarder name another container holds is named", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const { deps, state } = makeDeps({ imagePresent: true });
    await PV.runPreviewCreate(["--slug", "s1"], deps);
    // the row and its forwarder as an older CLI left them: no recorded ID, no forwarder-of label
    dropRecordedId();
    const [[oldId]] = [...state.forwarderIds];
    state.forwarderIds.set(oldId, { name: FWD, of: "" });
    // a forwarder of another name that merely contains it, with no label either, is not this preview's
    state.forwarderIds.set(FWD_ID(0xabc), { name: `x${FWD}x`, of: "" });
    await PV.runPreviewStart(["--slug", "s1", "--recreate"], deps);
    expect(state.forwarderIds.has(oldId)).toBe(false);
    expect(state.forwarderIds.has(FWD_ID(0xabc))).toBe(true);
    expect(slot()).toMatchObject({ state: "ready", containerId: RUN_ID(2) });
    expect([...state.forwarderIds.values()].filter((f) => f.name === FWD)).toEqual([{ name: FWD, of: RUN_ID(2) }]);
    // the forwarder name held by a container no listing of this preview's container finds: the failed run names it
    await PV.runPreviewStop(["--slug", "s1"], deps);
    for (const [id, f] of state.forwarderIds) if (f.name === FWD) state.forwarderIds.delete(id);
    state.forwarderIds.set(FWD_ID(0xdef), { name: FWD, of: RUN_ID(9) });
    state.forwarderRunAnswer = () => ({ status: 125, stdout: "", stderr: "docker: Error response from daemon: Conflict." });
    await expect(PV.runPreviewStart(["--slug", "s1"], deps)).rejects.toThrow(`the name ${FWD} is held by container ${FWD_ID(0xdef)}`);
  });

  it("a forwarder run that timed out after it took effect leaves no forwarder: the forwarders labelled with the container's ID are removed", async () => {
    declarer("acme", "alpha", { body: forwarding() });
    const state = {};
    const { deps } = makeDeps(state);
    const run = deps.runDocker;
    deps.runDocker = (args, o) => {
      if (args[0] === "run" && args.some((a) => String(a).startsWith("container:"))) {
        run(args, o);
        return timedOut();
      }
      return run(args, o);
    };
    await expect(PV.runPreviewCreate(["--slug", "s1"], deps)).rejects.toThrow("docker run of the forwarder");
    expect(state.forwarders.size).toBe(0);
  });
});
