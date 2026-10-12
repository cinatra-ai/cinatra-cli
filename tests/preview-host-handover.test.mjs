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
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (verb === "container" && sub === "inspect") {
      const running = Boolean(state.containerRunning);
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "", stderr: running ? "" : "No such object" };
    }
    if (verb === "volume" && sub === "inspect") {
      return { status: 1, stdout: "", stderr: `Error response from daemon: get ${args.at(-1)}: no such volume` };
    }
    if (verb === "image" && sub === "inspect") return { status: 1, stdout: "", stderr: `Error: No such image: ${args.at(-1)}` };
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
