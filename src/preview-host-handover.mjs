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
//     every connection to <target>. No forwards, no sidecar.
//
// A declarer that throws, times out or returns a bad shape is skipped with a
// warning that names the key and its package dir, never a value. Every docker
// effect goes through the preview's `runDocker` seam.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { discoverAllDevCliModulePaths } from "./dev-cli-modules.mjs";

export const PREVIEW_HOST_HANDOVER_KEY = "preview-host-handover";
export const PREVIEW_HOST_HANDOVER_EXPORT = "previewHostHandover";
export const PREVIEW_HOST_HANDOVER_TIMEOUT_MS = 120_000;
/** The extension override namespace (the product's `CINATRA_EXT_<NS>__<KEY>`). */
export const HANDOVER_ENV_NAME_RE = /^CINATRA_EXT_[A-Z0-9_]+__[A-Z0-9_]+$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TARGET_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/;

const NO_EXPORT = Symbol("no-export");
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

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const importModule = deps.importHandoverModule ?? ((file) => import(pathToFileURL(file).href));
  const timeoutMs = deps.handoverTimeoutMs ?? PREVIEW_HOST_HANDOVER_TIMEOUT_MS;
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
    let result;
    try {
      result = await withTimeout((async () => {
        const mod = await importModule(modulePath);
        const fn = mod?.[PREVIEW_HOST_HANDOVER_EXPORT];
        return typeof fn === "function" ? fn({ log }) : NO_EXPORT;
      })(), timeoutMs);
      if (result === NO_EXPORT) {
        warn(`skipped ${who}: it exports no ${PREVIEW_HOST_HANDOVER_EXPORT} function.`);
        continue;
      }
    } catch (err) {
      const why = err instanceof Error && err.message === "timed out" ? "it timed out" : "it failed";
      warn(`skipped ${who}: ${why}.`);
      continue;
    }
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

/** The forwarder program: one loopback listener per row, each piping to its target. */
export function previewForwarderScript(forwards) {
  const rows = JSON.stringify(forwards.map((f) => ({ port: f.port, host: f.host, targetPort: f.targetPort })));
  return (
    `const net=require("node:net");` +
    `for(const f of ${rows}){` +
    `net.createServer((c)=>{const u=net.connect(f.targetPort,f.host);` +
    `c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c);})` +
    `.listen(f.port,"127.0.0.1");}`
  );
}

/** The `docker run` argv of the forwarder beside `containerName`. */
export function previewForwarderRunArgs({ containerName, tag, forwards }) {
  return [
    "run", "-d",
    "--name", previewForwarderName(containerName),
    "--network", `container:${containerName}`,
    "--label", "cinatra.preview.forwarder=true",
    "--entrypoint", "node",
    tag,
    "-e", previewForwarderScript(forwards),
  ];
}

/**
 * After the boot: join each declared network (an existing membership is fine),
 * then replace this preview's forwarder with one serving every forward whose
 * network was joined. A failure is a named WARNING, never a failed preview.
 */
export function attachPreviewHostForwards({ containerName, tag, forwards, deps, log = () => {} }) {
  if (!forwards.length) return { forwarder: null, forwards: [] };
  const joined = new Set();
  for (const network of [...new Set(forwards.map((f) => f.network))].sort()) {
    const r = deps.runDocker(["network", "connect", network, containerName], { timeoutMs: 15_000 });
    if (!r.error && (r.status === 0 || /already exists/i.test(r.stderr ?? ""))) joined.add(network);
    else log(`  ⚠ preview host handover: could not join ${containerName} to the network ${network}; its forwards are skipped.`);
  }
  const served = forwards.filter((f) => joined.has(f.network));
  if (!served.length) return { forwarder: null, forwards: [] };
  const name = previewForwarderName(containerName);
  deps.runDocker(["rm", "-f", name], { timeoutMs: 60_000 });
  const r = deps.runDocker(previewForwarderRunArgs({ containerName, tag, forwards: served }), { timeoutMs: 60_000 });
  if (r.error || r.status !== 0) {
    log(`  ⚠ preview host handover: the forwarder ${name} did not start (exit ${r.status}).`);
    return { forwarder: null, forwards: [] };
  }
  log(`  preview host handover: ${name} serves ${served.map((f) => `127.0.0.1:${f.port}`).join(", ")} in ${containerName}.`);
  return { forwarder: name, forwards: served };
}
