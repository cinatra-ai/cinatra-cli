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
// A declarer is REQUIRED unless its manifest sets
// `cinatra.previewHostHandoverOptional` to the boolean true. Every failure of a
// REQUIRED declarer refuses the preview: the census cannot read its manifest,
// its runner fails, exits or times out, it exports no function, returns no
// { env, forwards } object, or hands over any entry this contract does not
// take. An OPTIONAL declarer's failure skips its whole contribution, is
// recorded in the result's `skipped` list and reported in one warning line
// that names the key and its package dir, never a value. Each declarer runs in
// its own process group, bounded from its spawn: a runner that does not report
// that it started within the start bound, or a declarer that does not answer
// within its bound, gets an abort on its `signal`, then the group is killed, so
// nothing it started keeps the CLI alive. Every docker effect goes through the
// preview's `runDocker` seam, and its success is read from its exit status,
// never from its text. The forwarder is bound to the preview container's ID,
// never to a name: it joins that container's network namespace by ID, carries
// that ID in a label, and is removed only by the preview authority, by an ID
// read under a status check (preview-authority.mjs removeForwardersOf).
// A declared forward that is not served fails the preview, naming its port and
// the step.

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { discoverAllDevCliModulePaths } from "./dev-cli-modules.mjs";
// Every forwarder removal is the preview authority's (preview-authority.mjs): by
// a container token's ID, through a status-checked listing of its label.
import {
  CONTAINER_ID_RE, PREVIEW_FORWARDER_GENERIC_LABEL, PREVIEW_FORWARDER_OF_LABEL, answerOk, assertContainerToken, createContainer, holderOfName, outputText, removeForwardersOf,
} from "./preview-authority.mjs";

export const PREVIEW_HOST_HANDOVER_KEY = "preview-host-handover";
export const PREVIEW_HOST_HANDOVER_EXPORT = "previewHostHandover";
export const PREVIEW_HOST_HANDOVER_TIMEOUT_MS = 120_000;
/** The manifest flag that makes a declarer OPTIONAL (`cinatra.<flag>: true`). */
export const PREVIEW_HOST_HANDOVER_OPTIONAL_FLAG = "previewHostHandoverOptional";
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
/** The label every forwarder carries. */
export const PREVIEW_FORWARDER_LABEL = PREVIEW_FORWARDER_GENERIC_LABEL;
/** The label that names the preview container a forwarder serves, by its ID,
 *  and a full docker container ID (both the authority module's). */
export { PREVIEW_FORWARDER_OF_LABEL, CONTAINER_ID_RE };
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
/** How long the runner has, from its spawn, to report that it started; the
 *  declarer's own bound starts when it does. */
export const PREVIEW_HOST_HANDOVER_START_TIMEOUT_MS = 30_000;
const DECLARER_RUNNER =
  `import { pathToFileURL } from "node:url";const ac=new AbortController();` +
  `process.on("message",(m)=>{if(m==="abort")ac.abort();});` +
  // The CLI's end closes this channel, however it ends: the group ends with it.
  `process.on("disconnect",()=>{try{process.kill(0,"SIGKILL");}catch{process.exit(1);}});process.send("ready");` +
  `try{const mod=await import(pathToFileURL(process.argv[1]).href);const fn=mod?.${PREVIEW_HOST_HANDOVER_EXPORT};` +
  `if(typeof fn!=="function")process.send({noExport:true});` +
  `else process.send({result:await fn({log:(l)=>process.send({log:String(l)}),signal:ac.signal})});}` +
  `catch{process.send({failed:true});}`;

/** Run one declarer module in its own process group, bounded from its spawn:
 *  the start bound is armed right after the spawn, and the declarer's own bound
 *  replaces it when the runner reports that it started. Resolves `{ result }`,
 *  `{ noExport }`, `{ failed }` or `{ timedOut, started }`. Once a bound expires
 *  the outcome is `timedOut`, whatever the child sends or does after it: the
 *  child gets its abort and, after the grace, its group is killed. The group
 *  also ends when the CLI ends first: the runner kills it when its channel to
 *  the CLI closes. */
function runDeclarer(modulePath, { timeoutMs, startTimeoutMs, graceMs, log }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", DECLARER_RUNNER, modulePath],
      // stdout is the CLI's result channel: no declarer output reaches it.
      { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let settled = false;
    let started = false;
    let expired = null;
    let bound = null;
    let grace = null;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      clearTimeout(grace);
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      resolve(expired ?? outcome);
    };
    const expire = () => {
      expired = { timedOut: true, started };
      try { child.send("abort"); } catch { /* it is going anyway */ }
      grace = setTimeout(() => done(expired), graceMs);
    };
    bound = setTimeout(expire, startTimeoutMs);
    child.on("error", () => done({ failed: true }));
    child.on("exit", () => done({ failed: true }));
    child.on("message", (m) => {
      // A declarer's log line is ONE prefixed line: it can never start a line of
      // its own (a result line, say) on the CLI's stdout.
      if (m && typeof m === "object" && "log" in m) log(`  preview host handover log: ${String(m.log).replace(/[\r\n]+/g, " ").slice(0, 2000)}`);
      else if (expired) return;
      else if (m === "ready") {
        if (started) return;
        started = true;
        clearTimeout(bound);
        bound = setTimeout(expire, timeoutMs);
      } else done(m && typeof m === "object" ? m : { failed: true });
    });
  });
}

/** Why a declarer's run is no contribution, or null when it answered. */
function runFailure(run) {
  if (run.invalid) return run.invalid;
  if (run.noExport) return `it exports no ${PREVIEW_HOST_HANDOVER_EXPORT} function`;
  if (run.failed) return "it failed";
  if (run.timedOut) return run.started ? "it timed out" : "it timed out before it started";
  return null;
}

/**
 * Call every declarer once and merge what they hand over, validated:
 * `{ env: [[name, value], ...], forwards: [{ port, network, host, targetPort }, ...],
 *    skipped: [{ packageDir, why }, ...] }`.
 * A REQUIRED declarer's failure THROWS (the preview is refused); an OPTIONAL
 * declarer's failure skips its whole contribution and is recorded in `skipped`
 * and in one warning line. No line names a value.
 */
export async function collectPreviewHostHandover({ checkoutDir, deps = {}, log = () => {} }) {
  const warn = (line) => log(`  ⚠ preview host handover: ${line}`);
  const discover = deps.discoverHandoverDeclarers ??
    ((root) => discoverAllDevCliModulePaths(PREVIEW_HOST_HANDOVER_KEY, root, { optionalFlag: PREVIEW_HOST_HANDOVER_OPTIONAL_FLAG }));
  const timeoutMs = deps.handoverTimeoutMs ?? PREVIEW_HOST_HANDOVER_TIMEOUT_MS;
  const startTimeoutMs = deps.handoverStartTimeoutMs ?? PREVIEW_HOST_HANDOVER_START_TIMEOUT_MS;
  const graceMs = deps.handoverAbortGraceMs ?? PREVIEW_HOST_HANDOVER_ABORT_GRACE_MS;
  const env = [];
  const forwards = [];
  const skipped = [];
  const names = new Set();
  const ports = new Set();
  let declarers;
  try {
    declarers = discover(checkoutDir);
  } catch (err) {
    // The census could not read every manifest, so a required declarer may be
    // among the unread: nothing is assumed absent.
    throw new Error(`preview host handover: the declarers of "${PREVIEW_HOST_HANDOVER_KEY}" could not be read ` +
      `(${String(err?.message ?? err).slice(0, 300)}); the preview is refused, since a required handover may be among them.`);
  }
  for (const { packageDir, modulePath, optional = false, invalid = null } of declarers) {
    const who = `"${PREVIEW_HOST_HANDOVER_KEY}" of ${packageDir}`;
    const run = invalid ? { invalid } : await runDeclarer(modulePath, { timeoutMs, startTimeoutMs, graceMs, log });
    // The whole contribution is checked before any of it is taken: a declarer
    // is either taken in full or it failed.
    const takeEnv = [];
    const takeForwards = [];
    const takePorts = new Set();
    let why = runFailure(run);
    const result = run.result;
    if (!why && (!isPlainObject(result) ||
        (result.env !== undefined && !isPlainObject(result.env)) ||
        (result.forwards !== undefined && !Array.isArray(result.forwards)))) {
      why = "it returned no { env, forwards } object";
    }
    if (!why) {
      for (const [name, value] of Object.entries(result.env ?? {})) {
        if (!HANDOVER_ENV_NAME_RE.test(name)) why = `its env key ${JSON.stringify(name.slice(0, 120))} is not an extension override name`;
        else if (typeof value !== "string" || /[\n\r\0]/.test(value)) why = `the value of its env key ${name} is not one line of text`;
        else if (names.has(name) || takeEnv.some(([n]) => n === name)) why = `its env key ${name} was handed over already`;
        if (why) break;
        takeEnv.push([name, value]);
      }
    }
    if (!why) {
      for (const entry of result.forwards ?? []) {
        const target = parseForwardTarget(entry?.target);
        if (isPlainObject(entry) && RESERVED_FORWARD_PORTS.has(entry.port)) {
          why = `its forward on port ${entry.port} takes the preview app's own port`;
        } else if (!isPlainObject(entry) || !validPort(entry.port, 1024) || ports.has(entry.port) || takePorts.has(entry.port) ||
            typeof entry.network !== "string" || !NETWORK_RE.test(entry.network) || !target) {
          why = "a forward needs a unique port 1024-65535, a network name and a host:port target";
        }
        if (why) break;
        takePorts.add(entry.port);
        takeForwards.push({ port: entry.port, network: entry.network, host: target.host, targetPort: target.port });
      }
    }
    if (why) {
      if (!optional) {
        throw new Error(`preview host handover: the required declarer ${who} failed: ${why}. The preview is refused; ` +
          `a declarer whose handover may be skipped sets "cinatra.${PREVIEW_HOST_HANDOVER_OPTIONAL_FLAG}": true in its manifest.`);
      }
      skipped.push({ packageDir, why });
      warn(`skipped ${who}: ${why}. It is an optional declarer, so the preview goes on without it.`);
      continue;
    }
    for (const [name, value] of takeEnv) {
      names.add(name);
      env.push([name, value]);
    }
    for (const f of takeForwards) {
      ports.add(f.port);
      forwards.push(f);
    }
  }
  return { env, forwards, skipped };
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

/** Why a docker call failed: its error code, or its exit status. */
function dockerFailure(r) {
  return r.error ? String(r.error.code ?? "error") : r.timedOut ? "timed out" : `exit ${r.status}`;
}


/**
 * Read the forwarder's own report of each listener from its log, until every
 * port has reported or the attempts run out. Returns `{ ready: Set<port>,
 * failed: Map<port, code> }`; a port in neither did not report. A `docker logs`
 * that errs, times out or exits non-zero throws: its output is never read.
 */
export async function readForwarderReadiness({ name, ports, deps, id = name }) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const want = new Set(ports);
  const ready = new Set();
  const failed = new Map();
  for (let i = 0; i < FORWARDER_READY_ATTEMPTS; i++) {
    if (i > 0) await sleep(FORWARDER_READY_INTERVAL_MS);
    const r = deps.runDocker(["logs", id], { timeoutMs: 15_000 });
    if (!answerOk(r)) throw new Error(`docker logs ${name}: ${dockerFailure(r)}`);
    // Only text is read: when either stream is not a string, this answer reports no listener.
    const out = outputText(r, "stdout");
    const err = outputText(r, "stderr");
    const text = out === null || err === null ? "" : `${out}\n${err}`;
    for (const line of text.split("\n")) {
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

/** The `docker run` argv of the forwarder beside the container `containerId`
 *  (named `containerName`): it joins THAT container's network namespace by ID
 *  and carries the ID in its label. */
export function previewForwarderRunArgs({ containerName, containerId, tag, forwards }) {
  return [
    "run", "-d",
    "--name", previewForwarderName(containerName),
    "--network", `container:${containerId}`,
    "--label", PREVIEW_FORWARDER_LABEL,
    "--label", `${PREVIEW_FORWARDER_OF_LABEL}=${containerId}`,
    "--entrypoint", "node",
    tag,
    "-e", previewForwarderScript(forwards),
  ];
}

/**
 * The names of the networks `containerName` is a member of, from its own
 * `docker container inspect`. Its output is read only after it exits 0 within
 * its bound; an error, a timeout, a non-zero exit or an answer that is not a
 * map of networks throws.
 */
export function readContainerNetworks(containerName, deps) {
  const r = deps.runDocker(["container", "inspect", "--format", "{{json .NetworkSettings.Networks}}", containerName],
    { timeoutMs: 15_000 });
  if (!answerOk(r)) {
    throw new Error(`docker container inspect ${containerName}: ${dockerFailure(r)}`);
  }
  let networks = null;
  try {
    const said = outputText(r, "stdout");
    networks = said === null ? null : JSON.parse(said);
  } catch { /* not a map of networks */ }
  if (!isPlainObject(networks)) throw new Error(`docker container inspect ${containerName}: its answer is not a map of networks`);
  return new Set(Object.keys(networks));
}

/**
 * After the boot: join each declared network, then replace this container's
 * forwarder with one serving every forward, and read that each listener reports
 * that it listens. Every step addresses the container by `containerId`, the ID
 * its own run returned or the row recorded, never by its name. A join that
 * exits 0 is a join. A join that exits non-zero is one only when the
 * container's own membership read (readContainerNetworks) lists the network:
 * an existing membership is fine, and the join's text is never read. A
 * declared forward that is not served FAILS the preview: the forwarders of this
 * container are removed (status-checked) and the error names the port and the
 * step; a removal that fails is named too and carried as `cleanupIncomplete`.
 */
export async function attachPreviewHostForwards({ inv, containerName, container, tag, forwards, deps, log = () => {} }) {
  if (!forwards.length) return { forwarder: null, forwards: [] };
  // The forwarder's label names a container authority token's ID only: one
  // this invocation created, parked, or verified as the row's recorded ID.
  const containerId = assertContainerToken(inv, container, `the forwards of ${containerName}`).id;
  // A failed removal is an outcome the authority module also keeps in the
  // invocation's ledger: the caller's settle records it on the row.
  const fail = (step, ports, why) => {
    const gone = removeForwardersOf(inv, container, deps);
    const note = gone.removed ? "" : `; ${gone.left.map((l) => l.why).join("; ")}`;
    throw new Error(`preview host handover: ${step} failed for ${ports.map((p) => `127.0.0.1:${p}`).join(", ")} ` +
      `in ${containerName} (${why}); a declared forward that is not served fails the preview${note}.`);
  };
  const ports = forwards.map((f) => f.port);
  for (const network of [...new Set(forwards.map((f) => f.network))].sort()) {
    const joined = forwards.filter((f) => f.network === network).map((f) => f.port);
    const r = deps.runDocker(["network", "connect", network, containerId], { timeoutMs: 15_000 });
    if (r.error || r.timedOut) fail(`docker network connect ${network}`, joined, dockerFailure(r));
    if (!answerOk(r)) {
      let member;
      try {
        member = readContainerNetworks(containerId, deps).has(network);
      } catch (err) {
        fail(`docker network connect ${network}`, joined, `${dockerFailure(r)}; its membership read failed: ${err.message}`);
      }
      if (!member) fail(`docker network connect ${network}`, joined, dockerFailure(r));
    }
  }
  const name = previewForwarderName(containerName);
  // An earlier forwarder of THIS container (labelled with its ID) goes first.
  const earlier = removeForwardersOf(inv, container, deps);
  if (!earlier.removed) {
    throw new Error(`preview host handover: the earlier forwarder of ${containerName} could not be replaced ` +
      `(${earlier.left.map((l) => l.why).join("; ")}).`);
  }
  // The forwarder's run is the one creating call's: a run with no success is
  // never judged "not made" by a read after it (the daemon may still make the
  // forwarder): with no ID in its cidfile it is an unknown run under the
  // forwarder's exact name, kept in the ledger (the row settles degraded). The
  // removal in fail() is cleanup only, never that judgment.
  const runArgs = previewForwarderRunArgs({ containerName, containerId, tag, forwards });
  const made = createContainer(inv, deps, runArgs, { imageAt: runArgs.indexOf(tag), timeoutMs: 60_000 });
  if (made.outcome !== "done") {
    const r = made.answer;
    // A run docker refused may have met the forwarder name held already (by a
    // forwarder no listing of this container finds): the outcome names its holder.
    const holder = answerOk(r) || r?.error || r?.timedOut ? null : holderOfName(name, deps);
    fail(`docker run of the forwarder ${name}`, ports, (answerOk(r) ? "it answered no container ID" : dockerFailure(r)) +
      (holder === "unknown" ? `; the holder of the name ${name} could not be read`
        : holder ? `; the name ${name} is held by container ${holder}` : ""));
  }
  const forwarderId = made.id;
  let report;
  try {
    report = await readForwarderReadiness({ name, id: forwarderId, ports, deps });
  } catch (err) {
    fail("the readiness read", ports, err.message);
  }
  const unserved = forwards.filter((f) => !report.ready.has(f.port));
  if (unserved.length) {
    fail("the readiness read", unserved.map((f) => f.port), unserved.map((f) => report.failed.has(f.port)
      ? `${f.port} could not listen: ${report.failed.get(f.port)}` : `${f.port} did not report that it listens`).join("; "));
  }
  log(`  preview host handover: ${name} serves ${ports.map((p) => `127.0.0.1:${p}`).join(", ")} in ${containerName}.`);
  return { forwarder: name, forwarderId, forwards };
}

/**
 * A container that came back with `docker start` has a new network namespace,
 * which an earlier forwarder does not share. It gets the forwards its
 * declarers hand over now, exactly as after a boot (attachPreviewHostForwards:
 * the joins, the earlier forwarder of this container removed first, the
 * readiness read). With no forward, the forwarders labelled with this
 * container's ID are removed (a status-checked listing; a failed one THROWS,
 * never reads as none). The env stays what the container was created with:
 * only a new container takes an env file.
 */
export async function reattachPreviewHostForwards({ inv, containerName, container, tag, handover, deps, log = () => {} }) {
  if (handover.env.length > 0) {
    log(`  preview host handover: ${containerName} keeps the env it was created with; ` +
      "`instance preview start --recreate` hands the declared env over again.");
  }
  if (handover.forwards.length > 0) {
    return attachPreviewHostForwards({ inv, containerName, container, tag, forwards: handover.forwards, deps, log });
  }
  const gone = removeForwardersOf(inv, container, deps);
  if (!gone.removed) {
    throw new Error(`preview host handover: the earlier forwarder of ${containerName} could not be removed ` +
      `(${gone.left.map((l) => l.why).join("; ")}).`);
  }
  return { forwarder: null, forwards: [] };
}
