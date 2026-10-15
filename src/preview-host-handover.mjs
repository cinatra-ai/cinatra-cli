// The preview HOST HANDOVER: what extensions present in the checkout hand a
// preview container from the host, through the generic manifest road
// `cinatra.devCliModules["preview-host-handover"]` (see dev-cli-modules.mjs).
//
// A declarer module exports `previewHostHandover({ log })`, async, returning
// `{ env?: Record<string, string>, forwards?: Array<{ port, network, target }> }`.
// The CLI names no extension and knows no value's meaning:
//
//   - ENV: only names in the extension override namespace
//     (`CINATRA_EXT_<NAMESPACE>__<KEY>`) are taken; they reach the container
//     ONLY through a 0600 env file passed with `--env-file` and removed as soon
//     as `docker run` returns. A value is never an argument, a log line or an
//     error text.
//   - FORWARDS: a service the host runs on a network the preview container does
//     not see, which the extension dials at a LOCAL address inside the
//     container. The preview container joins each declared network, and ONE
//     sidecar sharing its network namespace (`--network container:<preview>`)
//     runs the preview image's own `node` to listen on 127.0.0.1:<port> and pipe
//     every connection to <target>. No forwards, no sidecar. The preview app's
//     own port is never a forward port. Each listener reports whether it
//     listens, and only a forward that reported so is said to be served.
//
// A declarer that throws, times out or returns a bad shape is skipped with a
// warning that names the key and its package dir, never a value. Each declarer
// runs in its own process group: at the bound it gets an abort on its `signal`,
// then the group is killed, so nothing it started keeps the CLI alive. Every
// docker effect goes through the preview's `runDocker` seam, and a declared
// forward that is not served fails the preview, naming its port and the step.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverAllDevCliModulePaths } from "./dev-cli-modules.mjs";

export const PREVIEW_HOST_HANDOVER_KEY = "preview-host-handover";
export const PREVIEW_HOST_HANDOVER_EXPORT = "previewHostHandover";
export const PREVIEW_HOST_HANDOVER_TIMEOUT_MS = 120_000;
/** The extension override namespace (the product's `CINATRA_EXT_<NS>__<KEY>`). */
export const HANDOVER_ENV_NAME_RE = /^CINATRA_EXT_[A-Z0-9_]+__[A-Z0-9_]+$/;
/** The port the preview app binds inside its container (the image's PORT, the
 *  container side of `bootPreviewContainer`'s `-p <host>:3000`). The forwarder
 *  shares that network namespace, so a forward on it would take the app's port. */
export const PREVIEW_APP_CONTAINER_PORT = 3000;
const RESERVED_FORWARD_PORTS = new Set([PREVIEW_APP_CONTAINER_PORT]);
/** How long the CLI reads the forwarder's report of its listeners. */
export const FORWARDER_READY_ATTEMPTS = 40;
export const FORWARDER_READY_INTERVAL_MS = 250;
const FORWARDER_REPORT_RE = /^forward-(ready|failed) ([0-9]{1,5})(?: ([A-Za-z0-9_]{1,40}))?$/;
/** The label every forwarder carries; a plain start finds a leftover forwarder by it. */
export const PREVIEW_FORWARDER_LABEL = "cinatra.preview.forwarder=true";
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TARGET_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validPort(value, min) {
  return Number.isInteger(value) && value >= min && value <= 65535;
}

/** `host:port` -> { host, port }, or null. */
export function parseForwardTarget(target) {
  if (typeof target !== "string") return null;
  const i = target.lastIndexOf(":");
  if (i <= 0) return null;
  const host = target.slice(0, i);
  const portText = target.slice(i + 1);
  if (!TARGET_HOST_RE.test(host) || !/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  return validPort(port, 1) ? { host, port } : null;
}

/** How long a declarer past its bound has, after its abort, before its group is killed. */
export const PREVIEW_HOST_HANDOVER_ABORT_GRACE_MS = 1_000;
const DECLARER_RUNNER =
  `import { pathToFileURL } from "node:url";const ac=new AbortController();` +
  `process.on("message",(m)=>{if(m==="abort")ac.abort();});` +
  // The CLI's end closes this channel, however it ends: the group ends with it.
  `process.on("disconnect",()=>{try{process.kill(0,"SIGKILL");}catch{process.exit(1);}});process.send("ready");` +
  `try{const mod=await import(pathToFileURL(process.argv[1]).href);const fn=mod?.${PREVIEW_HOST_HANDOVER_EXPORT};` +
  `if(typeof fn!=="function")process.send({noExport:true});` +
  `else process.send({result:await fn({log:(l)=>process.send({log:String(l)}),signal:ac.signal})});}` +
  `catch{process.send({failed:true});}`;

/** Run one declarer module in its own process group, bounded from its start:
 *  resolves `{ result }`, `{ noExport }`, `{ failed }` or `{ timedOut }`. The
 *  group also ends when the CLI ends first: the runner kills it when its channel
 *  to the CLI closes. */
function runDeclarer(modulePath, { timeoutMs, graceMs, log }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", DECLARER_RUNNER, modulePath],
      { detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const timers = [];
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolve(outcome);
    };
    child.on("error", () => done({ failed: true }));
    child.on("exit", () => done({ failed: true }));
    child.on("message", (m) => {
      if (m === "ready") {
        timers.push(setTimeout(() => {
          try { child.send("abort"); } catch { /* it is going anyway */ }
          timers.push(setTimeout(() => done({ timedOut: true }), graceMs));
        }, timeoutMs));
      } else if (m && typeof m === "object" && "log" in m) log(m.log);
      else done(m && typeof m === "object" ? m : { failed: true });
    });
  });
}

/**
 * Call every declarer once and merge what they hand over, validated:
 * `{ env: [[name, value], ...], forwards: [{ port, network, host, targetPort }, ...] }`.
 * Never throws; every skip is one warning line naming no value.
 */
export async function collectPreviewHostHandover({ checkoutDir, deps = {}, log = () => {} }) {
  const warn = (line) => log(`  ⚠ preview host handover: ${line}`);
  const discover = deps.discoverHandoverDeclarers ??
    ((root) => discoverAllDevCliModulePaths(PREVIEW_HOST_HANDOVER_KEY, root));
  const timeoutMs = deps.handoverTimeoutMs ?? PREVIEW_HOST_HANDOVER_TIMEOUT_MS;
  const graceMs = deps.handoverAbortGraceMs ?? PREVIEW_HOST_HANDOVER_ABORT_GRACE_MS;
  const env = [];
  const forwards = [];
  const names = new Set();
  const ports = new Set();
  let declarers;
  try {
    declarers = discover(checkoutDir);
  } catch {
    warn(`the declarers of "${PREVIEW_HOST_HANDOVER_KEY}" could not be read; nothing is handed over.`);
    return { env, forwards };
  }
  for (const { packageDir, modulePath } of declarers) {
    const who = `"${PREVIEW_HOST_HANDOVER_KEY}" of ${packageDir}`;
    const run = await runDeclarer(modulePath, { timeoutMs, graceMs, log });
    if (run.noExport) {
      warn(`skipped ${who}: it exports no ${PREVIEW_HOST_HANDOVER_EXPORT} function.`);
      continue;
    }
    if (run.timedOut || run.failed) {
      warn(`skipped ${who}: ${run.timedOut ? "it timed out" : "it failed"}.`);
      continue;
    }
    const result = run.result;
    if (!isPlainObject(result) ||
        (result.env !== undefined && !isPlainObject(result.env)) ||
        (result.forwards !== undefined && !Array.isArray(result.forwards))) {
      warn(`skipped ${who}: it returned no { env, forwards } object.`);
      continue;
    }
    for (const [name, value] of Object.entries(result.env ?? {})) {
      if (!HANDOVER_ENV_NAME_RE.test(name)) {
        warn(`dropped the env key ${JSON.stringify(name.slice(0, 120))} of ${who}: not an extension override name.`);
      } else if (typeof value !== "string" || /[\n\r\0]/.test(value)) {
        warn(`dropped the env key ${name} of ${who}: its value is not one line of text.`);
      } else if (names.has(name)) {
        warn(`dropped the env key ${name} of ${who}: an earlier declarer handed it over.`);
      } else {
        names.add(name);
        env.push([name, value]);
      }
    }
    for (const entry of result.forwards ?? []) {
      const target = parseForwardTarget(entry?.target);
      if (isPlainObject(entry) && RESERVED_FORWARD_PORTS.has(entry.port)) {
        warn(`skipped a forward of ${who}: port ${entry.port} is the preview app's own port.`);
        continue;
      }
      if (!isPlainObject(entry) || !validPort(entry.port, 1024) || ports.has(entry.port) ||
          typeof entry.network !== "string" || !NETWORK_RE.test(entry.network) || !target) {
        warn(`skipped a forward of ${who}: it needs a unique port 1024-65535, a network name and a host:port target.`);
        continue;
      }
      ports.add(entry.port);
      forwards.push({ port: entry.port, network: entry.network, host: target.host, targetPort: target.port });
    }
  }
  return { env, forwards };
}

/** Write `entries` to a fresh 0600 env file in a fresh 0700 folder. */
export function writeHandoverEnvFile(entries, { tmpDir = os.tmpdir() } = {}) {
  for (const [name, value] of entries) {
    if (!HANDOVER_ENV_NAME_RE.test(name) || typeof value !== "string" || /[\n\r\0]/.test(value)) {
      throw new Error(`preview: refusing an env-file entry with an unexpected shape (${name}).`);
    }
  }
  const dir = mkdtempSync(path.join(tmpDir, "cinatra-preview-env-"));
  chmodSync(dir, 0o700);
  const file = path.join(dir, "preview.env");
  try {
    writeFileSync(file, entries.map(([name, value]) => `${name}=${value}\n`).join(""), { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The forwarder's container name. The DOT is load-bearing: a slug can never
 *  hold one, so this name never collides with another preview's container. */
export function previewForwarderName(containerName) {
  return `${containerName}.forward`;
}

/**
 * The forwarder program: one loopback listener per row, each piping to its
 * target. Each listener reports on its own line: `forward-ready <port>` once it
 * listens, `forward-failed <port> <code>` when it cannot (a port in use). A
 * listener that fails ends only itself; the others keep serving.
 */
export function previewForwarderScript(forwards) {
  const rows = JSON.stringify(forwards.map((f) => ({ port: f.port, host: f.host, targetPort: f.targetPort })));
  return (
    `const net=require("node:net");` +
    `for(const f of ${rows}){` +
    `const s=net.createServer((c)=>{const u=net.connect(f.targetPort,f.host);` +
    `c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c);});` +
    `s.on("error",(e)=>console.error("forward-failed "+f.port+" "+String((e&&e.code)||"error").replace(/[^A-Za-z0-9_]/g,"")));` +
    `s.listen(f.port,"127.0.0.1",()=>console.log("forward-ready "+f.port));}`
  );
}

/** Remove this preview's forwarder (best-effort, forced). A forwarder lives in
 *  its preview container's network namespace, so it never outlives that
 *  container: every removal or replacement of the container removes it too. */
export function removePreviewForwarder(containerName, deps) {
  deps.runDocker(["rm", "-f", previewForwarderName(containerName)], { timeoutMs: 60_000 });
}

/**
 * Read the forwarder's own report of each listener from its log, until every
 * port has reported or the attempts run out. Returns `{ ready: Set<port>,
 * failed: Map<port, code> }`; a port in neither did not report. A `docker logs`
 * that errs, times out or exits non-zero throws: its output is never read.
 */
export async function readForwarderReadiness({ name, ports, deps }) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const want = new Set(ports);
  const ready = new Set();
  const failed = new Map();
  for (let i = 0; i < FORWARDER_READY_ATTEMPTS; i++) {
    if (i > 0) await sleep(FORWARDER_READY_INTERVAL_MS);
    const r = deps.runDocker(["logs", name], { timeoutMs: 15_000 });
    if (r.error || r.status !== 0) throw new Error(`docker logs ${name}: ${dockerFailure(r)}`);
    for (const line of `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n")) {
      const m = FORWARDER_REPORT_RE.exec(line.trim());
      if (!m || !want.has(Number(m[2]))) continue;
      const port = Number(m[2]);
      if (m[1] === "failed") {
        failed.set(port, m[3] ?? "error");
        ready.delete(port);
      } else if (!failed.has(port)) {
        ready.add(port);
      }
    }
    if (ready.size + failed.size >= want.size) break;
  }
  return { ready, failed };
}

/** The `docker run` argv of the forwarder beside `containerName`. */
export function previewForwarderRunArgs({ containerName, tag, forwards }) {
  return [
    "run", "-d",
    "--name", previewForwarderName(containerName),
    "--network", `container:${containerName}`,
    "--label", PREVIEW_FORWARDER_LABEL,
    "--entrypoint", "node",
    tag,
    "-e", previewForwarderScript(forwards),
  ];
}

/** Why a docker call failed: its error code, or its exit status. */
function dockerFailure(r) {
  return r.error ? String(r.error.code ?? "error") : `exit ${r.status}`;
}

/**
 * After the boot: join each declared network (an existing membership is fine),
 * then replace this preview's forwarder with one serving every forward, and read
 * that each listener reports that it listens. A declared forward that is not
 * served FAILS the preview: the forwarder is removed and the error names the
 * port and the step. An earlier forwarder of this container is removed with the
 * container (see removePreviewForwarder).
 */
export async function attachPreviewHostForwards({ containerName, tag, forwards, deps, log = () => {} }) {
  if (!forwards.length) return { forwarder: null, forwards: [] };
  const fail = (step, ports, why) => {
    removePreviewForwarder(containerName, deps);
    throw new Error(`preview host handover: ${step} failed for ${ports.map((p) => `127.0.0.1:${p}`).join(", ")} ` +
      `in ${containerName} (${why}); a declared forward that is not served fails the preview.`);
  };
  const ports = forwards.map((f) => f.port);
  for (const network of [...new Set(forwards.map((f) => f.network))].sort()) {
    const r = deps.runDocker(["network", "connect", network, containerName], { timeoutMs: 15_000 });
    if (r.error || (r.status !== 0 && !/already exists/i.test(r.stderr ?? ""))) {
      fail(`docker network connect ${network}`, forwards.filter((f) => f.network === network).map((f) => f.port), dockerFailure(r));
    }
  }
  const name = previewForwarderName(containerName);
  removePreviewForwarder(containerName, deps);
  const r = deps.runDocker(previewForwarderRunArgs({ containerName, tag, forwards }), { timeoutMs: 60_000 });
  if (r.error || r.status !== 0) fail(`docker run of the forwarder ${name}`, ports, dockerFailure(r));
  let report;
  try {
    report = await readForwarderReadiness({ name, ports, deps });
  } catch (err) {
    fail("the readiness read", ports, err.message);
  }
  const unserved = forwards.filter((f) => !report.ready.has(f.port));
  if (unserved.length) {
    fail("the readiness read", unserved.map((f) => f.port), unserved.map((f) => report.failed.has(f.port)
      ? `${f.port} could not listen: ${report.failed.get(f.port)}` : `${f.port} did not report that it listens`).join("; "));
  }
  log(`  preview host handover: ${name} serves ${ports.map((p) => `127.0.0.1:${p}`).join(", ")} in ${containerName}.`);
  return { forwarder: name, forwards };
}

/**
 * A container that came back with `docker start` has a new network namespace,
 * which an earlier forwarder does not share. It gets the forwards its
 * declarers hand over now, exactly as after a boot (attachPreviewHostForwards:
 * the joins, the earlier forwarder removed first, the readiness read). With no
 * forward, a forwarder left from an earlier boot is removed when the forwarder
 * label lists it, so a start with nothing to attach removes nothing. The env
 * stays what the container was created with: only a new container takes an
 * env file.
 */
export async function reattachPreviewHostForwards({ containerName, tag, handover, deps, log = () => {} }) {
  if (handover.env.length > 0) {
    log(`  preview host handover: ${containerName} keeps the env it was created with; ` +
      "`instance preview start --recreate` hands the declared env over again.");
  }
  if (handover.forwards.length > 0) {
    return attachPreviewHostForwards({ containerName, tag, forwards: handover.forwards, deps, log });
  }
  const r = deps.runDocker(
    ["container", "ls", "-a", "--filter", `label=${PREVIEW_FORWARDER_LABEL}`, "--format", "{{.Names}}"],
    { timeoutMs: 15_000 },
  );
  const listed = !r.error && r.status === 0 ? String(r.stdout ?? "").split("\n").map((line) => line.trim()) : [];
  if (listed.includes(previewForwarderName(containerName))) removePreviewForwarder(containerName, deps);
  return { forwarder: null, forwards: [] };
}
