// THE PREVIEW AUTHORITY: the one module that REMOVES a preview's container, the
// forwarders that serve it and its data volume, and the one module that
// PROMOTES a preview's registry row to "ready". Nothing else in src/ runs a
// docker removal for a preview or writes that state; a static census in the
// tests reads src/ and fails on any such site outside this file.
//
// It acts only on AUTHORITY TOKENS: frozen objects that only this module mints,
// each recorded in a module-private WeakMap together with the INVOCATION that
// minted it. A string, a number, a plain object, a copy of a token or a token
// of another invocation is never authority: every check reads the WeakMap
// first, and every value is type-checked before any pattern is applied to it
// (no value is ever turned into a string to be checked).
//
// The producers, each in the invocation that acts:
//   - containerCreated:  this invocation's own `docker run -d` (the ID it
//                        printed after exit 0, or the one docker wrote to its
//                        --cidfile, which a failed run still names);
//   - containerParked:   this invocation's own park action (it renamed that ID
//                        aside itself);
//   - containerRecorded: the row's recorded containerId, read by THIS module
//                        from the registry under the claim, after a
//                        status-checked inspect confirmed it is the container
//                        under the preview's name;
//   - volumeOwned:       this invocation's own `docker volume create` whose
//                        label read back carries this invocation's nonce (the
//                        label is read again right before a non-forced removal);
//   - forwarderOf:       a forwarder listed, status-checked, by the label that
//                        names a container token's ID;
//   - liveness:          a status-checked inspect, by a container token's ID,
//                        that answered running;
//   - claim:             this module's own claim of the registry row.
//
// Every removal returns an OUTCOME, and every failure is also kept in the
// invocation's LEDGER. Every row write merges that ledger: a failed removal is
// never released as clean, and never promoted to "ready". What this
// invocation's own run created is in the ledger the moment docker names it, so
// an error path that loses its error object still removes it. A row records
// two separate lists: LEFTOVERS (`cleanupIncomplete`: things to remove, each
// re-read by a status-checked listing before a promotion) and CONDITIONS
// (`containerConditions`: facts about the row's own container). ONE RULE holds
// for the row's own container: every entry the row holds for it, a condition of
// any kind or a leftover that names its ID, is KEPT. A plain start refuses
// while one stands and a promotion keeps it and refuses; no read clears one,
// a liveness read included. Only a replacement by this invocation's own new
// container (start --recreate, or a refresh) takes them away, with the
// container. The one closed exception (READ_CLEARED_CONDITIONS) is a condition
// written only from an answered read, which the next start's fresh answered
// re-check clears. A container this invocation created and neither removed nor
// recorded on the row, and a container it set aside and did not put back, is a
// leftover of every row write: no error path that skips its cleanup releases
// the row as clean.
//
// THE ONE READER of a docker or exec result's output is outputText: it reads a
// stream once and answers its text or null. An answer that is not text proves
// nothing: it is never read as empty, parsed, trimmed or joined.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
/** The label a forwarder carries: the ID of the preview container it serves. */
export const PREVIEW_FORWARDER_OF_LABEL = "cinatra.preview.forwarder-of";
/** The label `create` puts on the data volume it makes: that invocation's nonce. */
export const PREVIEW_VOLUME_CREATOR_LABEL = "cinatra.preview.volume-created-by";
/** The durable list of what a cleanup could not remove. */
export const CLEANUP_INCOMPLETE_FIELD = "cleanupIncomplete";
/** The durable list of conditions of the row's own container. */
export const CONTAINER_CONDITIONS_FIELD = "containerConditions";
export const PREVIEW_CONTAINER_ID_KEY = "preview_container_id";
const PROBE_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 60_000;

const PROVISIONING = "provisioning";
const READY = "ready";
const DEGRADED = "degraded";
const ROW_STATES = Object.freeze([PROVISIONING, READY, DEGRADED]);
const LEFTOVER_KINDS = Object.freeze(["container", "forwarder", "forwarder-listing", "volume", "run"]);
/** not-running: it was left stopped; without-forwards: it runs without its
 *  declared forwards; not-replaced: a replacement could not remove it;
 *  state-unsettled: docker answered a stop or start of it with no success
 *  (a failure or a timeout), so whether that call took effect is not settled:
 *  the daemon may finish it after any read (mutateContainer's "unsettled").
 *  Every condition is KEPT (ownContainerEntries): a plain start of that row is
 *  refused and its promotion too; only a replacement of the container (start
 *  --recreate, or a refresh) takes it away. The one closed exception is
 *  READ_CLEARED_CONDITIONS. */
export const CONTAINER_CONDITIONS = Object.freeze(["not-running", "without-forwards", "not-replaced", "state-unsettled"]);
/** THE ONE CLOSED EXCEPTION to the default keep, a frozen set and never a list
 *  of kinds to keep: conditions written ONLY from an ANSWERED read (an
 *  observation: an inspect that answered stopped, a stop that exited 0), never
 *  from a change that went unanswered. No late-landing call can alter what
 *  they say, so the next plain start's fresh answered re-check (a liveness
 *  read that answered running) may clear them. */
export const READ_CLEARED_CONDITIONS = Object.freeze(["not-running", "without-forwards"]);

const isFullId = (v) => typeof v === "string" && CONTAINER_ID_RE.test(v);
const isText = (v) => typeof v === "string" && v.length > 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const dockerFailed = (r) => !answerOk(r);
const failure = (r) => (r?.timedOut ? "timed out" : r?.error ? (typeof r.error.code === "string" ? r.error.code : "error") : `exit ${r?.status}`);
/** A docker call through the caller's seam that never throws: a seam that
 *  throws is a FAILED call (its error recorded), never an escape past the
 *  outcome and the ledger. */
function dockerCall(deps, args, opts) {
  try {
    const r = deps.runDocker(args, opts);
    return r && typeof r === "object" ? r : { status: null, stdout: "", stderr: "", error: new Error("the docker seam answered nothing") };
  } catch (err) {
    return { status: null, stdout: "", stderr: "", error: err instanceof Error ? err : new Error("the docker seam threw") };
  }
}
/**
 * THE ONE READER of a docker or exec result's output: the text of its `stream`
 * ("stdout" or "stderr"), read ONCE, or null when the result is not an object,
 * the read throws, or the stream holds no string. An answer that is not text
 * proves nothing: the caller takes its refusal, unknown or degraded path, and
 * never reads it as empty, parses it, trims it or joins it.
 */
/**
 * THE ONE STATUS PREDICATE of a docker or exec answer: true only for an object
 * answer with no error, no timeout and exit status 0. Every status check of
 * such an answer in the preview files goes through it (a test reads them and
 * fails on any other); an answer it refuses proves nothing, and the caller
 * takes its refusal, unknown or degraded path.
 */
export function answerOk(r) {
  if (r === null || typeof r !== "object") return false;
  try {
    return !r.error && !r.timedOut && r.status === 0;
  } catch {
    return false;
  }
}

export function outputText(r, stream) {
  if (stream !== "stdout" && stream !== "stderr") throw new Error("preview authority: a result's output is its stdout or its stderr.");
  if (r === null || typeof r !== "object") return null;
  let text;
  try {
    text = r[stream];
  } catch {
    return null;
  }
  return typeof text === "string" ? text : null;
}

// --- row states (the reads; the writes are below) ---------------------------

/** True for a state a preview row may hold. */
export function isPreviewRowState(state) {
  return typeof state === "string" && ROW_STATES.includes(state);
}
/** True when the row's lifecycle says it finished (a read; never a write). */
export function rowIsReady(row) {
  return isPlainObject(row) && row.state === READY;
}

/** One leftover: { kind, id | name, why }, every value a non-empty string and
 *  an id a full container ID; a container may name the aside name it is left
 *  under, a forwarder listing the forwarder name it also lists by; a volume,
 *  and a run that named no container ID, by its name only. `ownId` is the
 *  row's recorded container: a leftover never names it under its own name
 *  (that is a condition), only under an aside name. */
export function isLeftoverEntry(e, ownId = null, ownName = null) {
  if (!isPlainObject(e)) return false;
  if (!Object.keys(e).every((k) => k === "kind" || k === "id" || k === "name" || k === "why")) return false;
  if (!isText(e.kind) || !LEFTOVER_KINDS.includes(e.kind) || !isText(e.why)) return false;
  if (Object.hasOwn(e, "name") && !isText(e.name)) return false;
  if (Object.hasOwn(e, "id") && !isFullId(e.id)) return false;
  if (e.kind === "volume" || e.kind === "run") return isText(e.name) && !Object.hasOwn(e, "id");
  if (!isFullId(e.id)) return false;
  if (e.kind !== "container" && e.kind !== "forwarder-listing" && Object.hasOwn(e, "name")) return false;
  if (e.kind === "container" && ownId !== null && e.id === ownId) return isText(e.name) && e.name !== ownName;
  return true;
}

/** One condition: { id, condition, why }, the id the row's own containerId. */
export function isConditionEntry(e, ownId) {
  if (!isPlainObject(e)) return false;
  if (!Object.keys(e).every((k) => k === "id" || k === "condition" || k === "why")) return false;
  return isFullId(e.id) && isFullId(ownId) && e.id === ownId && isText(e.condition) &&
    CONTAINER_CONDITIONS.includes(e.condition) && isText(e.why);
}

/** The two lists of a row, validated strictly: each, when present, a NON-EMPTY
 *  array of valid entries; conditions only on a row with a recorded ID. */
export function areRowListsValid(slot) {
  if (!isPlainObject(slot)) return false;
  const ownId = Object.hasOwn(slot, "containerId") ? slot.containerId : null;
  if (ownId !== null && !isFullId(ownId)) return false;
  const ownName = typeof slot.containerName === "string" ? slot.containerName : null;
  if (Object.hasOwn(slot, CLEANUP_INCOMPLETE_FIELD)) {
    const list = slot[CLEANUP_INCOMPLETE_FIELD];
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => isLeftoverEntry(e, ownId, ownName))) return false;
  }
  if (Object.hasOwn(slot, CONTAINER_CONDITIONS_FIELD)) {
    const list = slot[CONTAINER_CONDITIONS_FIELD];
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => isConditionEntry(e, ownId))) return false;
  }
  return true;
}

/**
 * THE ONE RULE for the row's own container (default keep): every entry the
 * row holds for it is kept, whatever its kind. That is every condition (of
 * any kind, known or added later) and every leftover that names its ID (an
 * entry under an aside name). A plain start refuses while one stands, and a
 * promotion keeps them all and refuses. No read clears one, a liveness read
 * included; only a replacement by this invocation's own new container
 * (start --recreate, or a refresh) takes them away, with the container. The
 * one closed exception, READ_CLEARED_CONDITIONS, is left to that read; every
 * other kind, an unknown one included, is kept.
 */
export function ownContainerEntries(slot, id = isPlainObject(slot) ? slot.containerId : null) {
  if (!isPlainObject(slot)) return [];
  const conditions = Array.isArray(slot[CONTAINER_CONDITIONS_FIELD]) ? slot[CONTAINER_CONDITIONS_FIELD] : [];
  const leftovers = Array.isArray(slot[CLEANUP_INCOMPLETE_FIELD]) ? slot[CLEANUP_INCOMPLETE_FIELD] : [];
  return [...conditions.filter((c) => !(isPlainObject(c) && READ_CLEARED_CONDITIONS.includes(c.condition))),
    ...leftovers.filter((e) => namesContainer(e, id))];
}

/** A leftover that names the container `id` (whatever its name). */
function namesContainer(e, id) {
  return isPlainObject(e) && e.kind === "container" && isFullId(id) && e.id === id;
}

// --- tokens and the invocation ledger ---------------------------------------

const KIND = Object.freeze({
  CREATED: "container-created",
  PARKED: "container-parked",
  RECORDED: "container-recorded",
  PARK_TARGET: "park-target",
  VOLUME: "volume-owned",
  FORWARDER: "forwarder-of",
  LIVENESS: "liveness",
  CLAIM: "claim",
});
const CONTAINER_KINDS = [KIND.CREATED, KIND.PARKED, KIND.RECORDED];
const TOKENS = new WeakMap(); // token -> { kind, inv }
const LEDGERS = new WeakMap(); // invocation -> its ledger
const SPENT = new WeakSet(); // claims that already wrote their row (or found it no longer theirs): single use

function mint(inv, kind, fields) {
  const token = Object.freeze({ kind, ...fields });
  TOKENS.set(token, Object.freeze({ kind, inv }));
  return token;
}

/** True only for a token this module minted, of one of `kinds`, in `inv`. */
function isTokenOf(inv, token, kinds) {
  if (token === null || typeof token !== "object") return false;
  const seen = TOKENS.get(token);
  return Boolean(seen) && seen.inv === inv && kinds.includes(seen.kind);
}

function requireToken(inv, token, kinds, what) {
  if (!isTokenOf(inv, token, kinds)) {
    throw new Error(`preview authority: ${what} takes a ${kinds.join(" or ")} token of this invocation; ` +
      "a string, a plain object or another invocation's token is no authority. Nothing was changed.");
  }
  return token;
}

function ledgerOf(inv) {
  const l = inv !== null && typeof inv === "object" ? LEDGERS.get(inv) : undefined;
  if (!l) throw new Error("preview authority: no invocation of this module; nothing was changed.");
  return l;
}

/** The container token itself when it is one of this invocation (created,
 *  parked or recorded); throws otherwise. */
export function assertContainerToken(inv, token, what = "this step") {
  return requireToken(inv, token, CONTAINER_KINDS, what);
}

/** True when `token` is an authority token of `kind` minted in `inv`. */
export function isAuthorityToken(inv, token, kind) {
  return typeof kind === "string" && isTokenOf(inv, token, [kind]);
}
export const TOKEN_KINDS = KIND;

/**
 * One invocation of a preview verb: the scope every token and the ledger
 * belong to. The ledger holds what this invocation created (containers, the
 * data volume), what it set aside and put back, what it removed, every removal
 * that failed (until a later removal of the same object succeeds) and every
 * condition it noted.
 */
export function beginInvocation() {
  const inv = Object.freeze({ preview: "invocation" });
  LEDGERS.set(inv, { created: [], parked: [], restored: new Set(), removed: new Set(), volumes: [], failures: new Map(), conditions: new Map(), unsettled: new Map(), took: new Map() });
  return inv;
}

const failureKey = (e) => `${e.kind}:${e.id ?? ""}:${e.name ?? ""}`;
function noteFailures(inv, entries) {
  const l = ledgerOf(inv);
  for (const e of entries) l.failures.set(failureKey(e), Object.freeze({ ...e }));
}
function clearFailure(inv, entry) {
  ledgerOf(inv).failures.delete(failureKey(entry));
}
const outcome = (left) => Object.freeze(left.length ? { removed: false, left: Object.freeze(left.map((e) => Object.freeze({ ...e }))) } : { removed: true, left: Object.freeze([]) });

/** What this invocation's ledger holds now (a read for messages and tests). */
export function ledgerFailures(inv) {
  return [...ledgerOf(inv).failures.values()];
}

// --- reads ------------------------------------------------------------------

/** "listed", "absent" (an exit-0 listing with no exact line) or "unknown". */
function listed(args, want, deps) {
  const r = dockerCall(deps, args, { timeoutMs: PROBE_TIMEOUT_MS });
  const out = outputText(r, "stdout");
  if (dockerFailed(r) || out === null) return "unknown";
  return out.split("\n").some((line) => line.trim() === want) ? "listed" : "absent";
}
const idListArgs = (id) => ["container", "ls", "-a", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"];
const volumeListArgs = (name) => ["volume", "ls", "--format", "{{.Name}}", "--filter", `name=${name}`];

/**
 * The state of the container `id`, read by its ID only: a status-checked
 * inspect (exit 0: running, stopped, or unknown for any other answer); a
 * non-zero inspect is "absent" only when an exit-0 listing by that ID names
 * nothing, else "unknown". An error or a timeout is "unknown".
 */
export function containerStateById(id, deps) {
  if (!isFullId(id)) return "unknown";
  const r = dockerCall(deps, ["container", "inspect", "-f", "{{.State.Running}}", id], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!dockerFailed(r)) {
    const said = outputText(r, "stdout");
    if (said === null) return "unknown";
    return said.trim() === "true" ? "running" : said.trim() === "false" ? "stopped" : "unknown";
  }
  if (r.error || r.timedOut) return "unknown";
  return listed(idListArgs(id), id, deps) === "absent" ? "absent" : "unknown";
}

/** Per mutating verb: where its argv holds the container's ID. */
const MUTATIONS = Object.freeze({
  stop: { id: (a) => a[1] },
  start: { id: (a) => a[1] },
  rm: { id: (a) => a[2] },
  rename: { id: (a) => a[1] },
});
const mutationArgsValid = (args) => Array.isArray(args) && args.every((a) => typeof a === "string") &&
  Object.hasOwn(MUTATIONS, args[0]) &&
  (args[0] === "rename" ? args.length === 3 && isText(args[2]) : args[0] === "rm" ? args.length === 3 && args[1] === "-f" : args.length === 2) &&
  isFullId(MUTATIONS[args[0]].id(args));

/**
 * THE ONE MUTATING CALL on a container, by its full ID: `stop <id>`,
 * `start <id>`, `rm -f <id>` or `rename <id> <name>`. Exit 0 is "done". Any
 * other answer (an error, a non-zero exit, a timeout) is "unsettled": the
 * daemon may still finish the call after it answered, and after any read of
 * the container, so no read in this call settles whether it took effect, and
 * none is made. An unsettled stop or start is kept in the invocation's ledger:
 * the settle writes the row degraded, with the condition `state-unsettled` on
 * the row's own container (or that container as a leftover), and a promotion
 * of that container is refused, in this command and in every later one. No
 * read settles it: only a replacement of the container takes it away. An
 * unsettled removal or rename is a leftover its caller names. Returns
 * { outcome, why, answer } (why: the call's failure; answer: the call's own
 * answer, for its stderr).
 * Every mutating container call in the preview files goes through it (a test
 * reads them and fails on any other).
 */
export function mutateContainer(inv, deps, args, { timeoutMs }) {
  const l = ledgerOf(inv);
  if (!mutationArgsValid(args)) throw new Error("preview authority: a container is changed by `stop`, `start`, `rm -f` or `rename` and its full ID.");
  const r = dockerCall(deps, args, { timeoutMs });
  if (!dockerFailed(r)) return { outcome: "done", why: null, answer: r };
  const why = failure(r);
  if (args[0] === "stop" || args[0] === "start") {
    const id = MUTATIONS[args[0]].id(args);
    l.unsettled.set(id, Object.freeze({ id, why: `docker ${args[0]} answered ${why}; whether it took effect is not settled` }));
  }
  return { outcome: "unsettled", why, answer: r };
}

/** The ID of the container `name` from a status-checked inspect, or null. */
export function readContainerIdByName(name, deps) {
  if (!isText(name)) return null;
  const r = dockerCall(deps, ["container", "inspect", "--format", "{{.Id}}", name], { timeoutMs: PROBE_TIMEOUT_MS });
  const said = dockerFailed(r) ? null : outputText(r, "stdout");
  if (said === null) return null;
  const id = said.trim();
  return isFullId(id) ? id : null;
}

/** The generic label every preview forwarder carries, the only one a forwarder
 *  made before the forwarder-of label has. */
export const PREVIEW_FORWARDER_GENERIC_LABEL = "cinatra.preview.forwarder=true";

/** The text of a status-checked listing's answer, or THROW naming `what`. */
function listingText(r, what) {
  if (dockerFailed(r)) throw new Error(`docker container ls of ${what}: ${failure(r)}`);
  const said = outputText(r, "stdout");
  if (said === null) throw new Error(`docker container ls of ${what}: its answer is no text`);
  return said.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** The IDs of the forwarders labelled with the container `containerId`, from a
 *  status-checked listing; a failed listing or an answer that is not a list of
 *  IDs THROWS, never reads as none. With `baseName` (the forwarder name of the
 *  container's own name), a forwarder made before the forwarder-of label is
 *  listed too: by the generic forwarder label and that exact name, kept only
 *  when it carries no forwarder-of label (or this container's). A read: no
 *  authority. */
export function listForwardersOf(containerId, deps, { baseName = null } = {}) {
  if (!isFullId(containerId)) throw new Error("preview authority: forwarders are listed only by a full container ID.");
  const what = `the forwarders of ${containerId.slice(0, 12)}`;
  const ids = listingText(dockerCall(deps,
    ["container", "ls", "-a", "--no-trunc", "--filter", `label=${PREVIEW_FORWARDER_OF_LABEL}=${containerId}`, "--format", "{{.ID}}"],
    { timeoutMs: PROBE_TIMEOUT_MS },
  ), what);
  if (!ids.every(isFullId)) throw new Error(`docker container ls of ${what}: its answer is not a list of container IDs`);
  if (baseName === null) return ids;
  if (!isText(baseName)) throw new Error("preview authority: a forwarder name is a non-empty string.");
  const rows = listingText(dockerCall(deps,
    ["container", "ls", "-a", "--no-trunc", "--filter", `label=${PREVIEW_FORWARDER_GENERIC_LABEL}`, "--filter", `name=${baseName}`,
      "--format", `{{.ID}} {{.Names}} {{.Label "${PREVIEW_FORWARDER_OF_LABEL}"}}`],
    { timeoutMs: PROBE_TIMEOUT_MS },
  ), `the forwarders named ${baseName}`);
  const found = new Set(ids);
  for (const row of rows) {
    const [id, name, of = "", ...rest] = row.split(/\s+/);
    if (!isFullId(id) || !isText(name) || rest.length) {
      throw new Error(`docker container ls of the forwarders named ${baseName}: its answer is not a list of container IDs`);
    }
    // The name filter matches a part of a name: only the exact name counts.
    if (name === baseName && (of === "" || of === containerId)) found.add(id);
  }
  return [...found];
}

/** The full ID of the container that holds the exact name `name`, from a
 *  status-checked listing: an ID, null when none holds it, or "unknown". A
 *  read: no authority. */
export function holderOfName(name, deps) {
  const r = dockerCall(deps, ["container", "ls", "-a", "--no-trunc", "--filter", `name=${name}`, "--format", "{{.ID}} {{.Names}}"],
    { timeoutMs: PROBE_TIMEOUT_MS });
  const said = outputText(r, "stdout");
  if (dockerFailed(r) || said === null) return "unknown";
  for (const line of said.split("\n")) {
    const [id, held] = line.trim().split(/\s+/);
    if (held === name) return isFullId(id) ? id : "unknown";
  }
  return null;
}

/** The labels of the volume `name` from a status-checked read: a map, or null. */
function readVolumeLabels(name, deps) {
  const r = dockerCall(deps, ["volume", "inspect", "--format", "{{json .Labels}}", name], { timeoutMs: PROBE_TIMEOUT_MS });
  const said = dockerFailed(r) ? null : outputText(r, "stdout");
  if (said === null) return null;
  let labels;
  try {
    labels = JSON.parse(said.trim());
  } catch {
    return null;
  }
  if (labels === null) return {};
  return isPlainObject(labels) ? labels : null;
}

/**
 * Whether an entry names a create that answered no success: a run that named
 * no container ID, or a volume create that did not exit 0. The daemon may
 * still make it after any read, in this command or a later one, so no read is
 * a completion barrier for it: an unanswered call has none. Only a later
 * create that exits 0 under the same name (docker refuses a duplicate
 * container name; promoteReady) clears a run.
 */
export function isUnansweredCreate(e) {
  return isPlainObject(e) && (e.kind === "run" || (e.kind === "volume" && /not settled$/.test(e.why ?? "")));
}

/**
 * The entries of a list that are still there, each re-read by a status-checked
 * listing: a container or a forwarder by its own ID, a forwarder listing by the
 * label of its container ID, a volume by its exact name. An unanswered create
 * (isUnansweredCreate) is never re-read: it always stays. An entry whose read
 * fails, or that is not a valid entry, stays.
 */
export function remainingLeftovers(list, deps) {
  return (Array.isArray(list) ? list : []).filter((e) => {
    if (!isLeftoverEntry(e) || isUnansweredCreate(e)) return true;
    try {
      if (e.kind === "container" || e.kind === "forwarder") return listed(idListArgs(e.id), e.id, deps) !== "absent";
      if (e.kind === "forwarder-listing") return listForwardersOf(e.id, deps, { baseName: e.name ?? null }).length > 0;
      return listed(volumeListArgs(e.name), e.name, deps) !== "absent";
    } catch {
      return true;
    }
  });
}

// --- the producers ------------------------------------------------------------

/** The container ID docker wrote to a run's --cidfile, or null: a regular file
 *  of at most 256 bytes holding one full ID (the folder is this run's own). */
function readCidFile(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 256) return null;
    const id = readFileSync(file, "utf8").trim();
    return isFullId(id) ? id : null;
  } catch {
    return null;
  }
}

function recordCreated(inv, id, name = null) {
  const token = mint(inv, KIND.CREATED, { id, name });
  ledgerOf(inv).created.push(token);
  return token;
}

const creatingArgsValid = (args, imageAt) => Array.isArray(args) && args.length >= 5 &&
  args.every((a) => typeof a === "string") && args[0] === "run" && args[1] === "-d" &&
  !args.includes("--rm") && !args.includes("--cidfile") && Number.isInteger(imageAt) && imageAt > 3 && imageAt < args.length &&
  args.indexOf("--name") > 1 && args.indexOf("--name") + 1 < imageAt && isText(args[args.indexOf("--name") + 1]);

/**
 * THE ONE CREATING CALL: `docker run -d ... --name <name> ... <image> [cmd]`
 * (the image at `imageAt`), with a --cidfile in a fresh 0700 folder; docker
 * writes the container's ID there when it creates it. Exit 0 with one full
 * printed ID (that agrees with the cidfile) is "done". Any other answer (an
 * error, a timeout, a non-zero exit, or exit 0 with no single ID) is
 * "unsettled": the daemon may still create the container after it answered,
 * and after any read, so no listing, inspect or ps, in this invocation or a
 * later one, decides that the container does not exist, and none is made.
 * With no ID in the cidfile it is an UNKNOWN RUN: a leftover of kind `run`
 * under the exact --name that no read clears (the settle writes degraded,
 * never the prior state); only a later create under that name that exits 0 does. With
 * an ID in the cidfile that ID is returned for the caller to keep.
 * Returns { outcome, id, name, why, answer }.
 * Every container-creating docker call in the preview files goes through it
 * (a test reads them and fails on any other).
 */
export function createContainer(inv, deps, args, { imageAt, timeoutMs, tmpDir = null }) {
  ledgerOf(inv);
  if (!creatingArgsValid(args, imageAt)) {
    throw new Error("preview authority: a container is made by `run -d --name <name> ... <image>` with no --rm and no --cidfile of its own.");
  }
  const name = args[args.indexOf("--name") + 1];
  const cidDir = mkdtempSync(path.join(typeof tmpDir === "string" && tmpDir ? tmpDir : os.tmpdir(), "cinatra-preview-cid-"));
  const cidFile = path.join(cidDir, "container.id");
  const argv = [...args.slice(0, imageAt), "--cidfile", cidFile, ...args.slice(imageAt)];
  let r;
  let cid = null;
  try {
    // dockerCall never throws: a seam that throws is a failed run, and the
    // cidfile is read whatever the run answered, before its folder goes.
    r = dockerCall(deps, argv, { timeoutMs });
  } finally {
    cid = readCidFile(cidFile);
    try {
      rmSync(cidDir, { recursive: true, force: true });
    } catch {
      /* the cidfile holds only the ID: a leftover temp folder never masks it */
    }
  }
  // The exit status first (the one predicate), then the printed ID.
  if (answerOk(r)) {
    const printed = (outputText(r, "stdout") ?? "").trim();
    if (isFullId(printed) && (cid === null || cid === printed)) {
      // docker refuses a duplicate name: the name is this container's now.
      ledgerOf(inv).took.set(name, printed);
      return { outcome: "done", id: printed, name, why: null, answer: r };
    }
  }
  const why = answerOk(r) ? "exit 0 with no single container ID" : failure(r);
  if (cid === null) {
    noteFailures(inv, [{ kind: "run", name,
      why: `docker run answered ${why} and named no container ID; a container may exist under ${name}` }]);
  }
  return { outcome: "unsettled", id: cid, name, why, answer: r };
}

/**
 * Run the preview's container (`docker run -d`, the argv `args`, its last
 * element the image) through the one creating call, and mint containerCreated
 * for the ID this run produced: the cidfile's ID (so a run that answered no
 * success after docker made it still names it) or the one full ID the run
 * printed after exit 0. The token is in the ledger BEFORE the run is judged,
 * so no failure path loses it. A run with no success and no ID is an unknown
 * run (createContainer). A run with no success throws.
 */
export function runOwnContainer(inv, { args, deps, tmpDir = null, what = "the preview container" }) {
  ledgerOf(inv);
  if (!Array.isArray(args) || args.length < 3 || !args.every((a) => typeof a === "string") ||
      args[0] !== "run" || args[1] !== "-d" || args.includes("--rm") || args.includes("--cidfile")) {
    throw new Error("preview authority: a container run is `run -d ... <image>` with no --rm and no --cidfile of its own.");
  }
  const made = createContainer(inv, deps, args, { imageAt: args.length - 1, timeoutMs: RUN_TIMEOUT_MS, tmpDir });
  if (made.outcome === "done") return recordCreated(inv, made.id, made.name);
  if (made.id !== null) recordCreated(inv, made.id, made.name);
  const stderr = (outputText(made.answer, "stderr") ?? "").trim();
  if (answerOk(made.answer)) {
    throw new Error(`docker run of ${what} exited 0 but answered no single container ID; ` +
      "no container is taken as this run's by its name.");
  }
  throw new Error(`docker run of ${what} failed` + (stderr ? `: ${stderr}` : "."));
}

/** The containers this invocation's own runs created and has not removed. */
export function createdNotRemoved(inv) {
  const l = ledgerOf(inv);
  return l.created.filter((t) => !l.removed.has(t.id));
}

/** The one refusal for a row written before the result line. */
export function legacyRowRefusal(slug) {
  return new Error(`preview "${slug}": this preview's registry row predates recorded container IDs; run ` +
    `\`cinatra instance preview start --slug ${slug} --recreate\` once. Nothing was removed or reused.`);
}

/**
 * containerRecorded: the container under `name`, by the ID a status-checked
 * inspect reads, and only when it is the ID this module read from the registry
 * under the claim. No recorded ID refuses (legacyRowRefusal); a failed read or
 * another ID throws. Neither is ever authority for a delete, a reuse or a ready.
 */
export function verifyRecorded(inv, claim, name, deps) {
  requireToken(inv, claim, [KIND.CLAIM], "verifyRecorded");
  if (claim.recordedId === null) throw legacyRowRefusal(claim.slug);
  const id = readContainerIdByName(name, deps);
  if (!id) throw new Error(`Could not read the ID of ${name} (docker inspect failed or answered no container ID). Nothing was changed.`);
  if (id !== claim.recordedId) {
    throw new Error(`The container named ${name} (${id.slice(0, 12)}) is not the one preview "${claim.slug}" recorded ` +
      `(${claim.recordedId.slice(0, 12)}): it was made by another run. Nothing was changed; ` +
      `\`cinatra instance preview status --slug ${claim.slug}\` shows the row.`);
  }
  return mint(inv, KIND.RECORDED, { id });
}

/**
 * The container `start --recreate` will set aside: the recorded container
 * (verifyRecorded) or, on a row written before the result line, the live
 * container by the ID a status-checked inspect reads now. A park target is no
 * authority to remove anything; parkContainer turns it into containerParked
 * only once THIS invocation has renamed it aside itself.
 */
export function parkTarget(inv, claim, name, deps) {
  requireToken(inv, claim, [KIND.CLAIM], "parkTarget");
  if (claim.recordedId !== null) return mint(inv, KIND.PARK_TARGET, { id: verifyRecorded(inv, claim, name, deps).id });
  const id = readContainerIdByName(name, deps);
  if (!id) throw new Error(`Could not read the ID of ${name} (docker inspect failed or answered no container ID). Nothing was changed.`);
  return mint(inv, KIND.PARK_TARGET, { id });
}

/** Rename the park target aside (by its ID). Returns containerParked (in the
 *  ledger until it is put back or removed), or null when the rename answered
 *  no success (then it is a leftover that may be under the aside name). */
export function parkContainer(inv, target, asideName, deps) {
  requireToken(inv, target, [KIND.PARK_TARGET], "parkContainer");
  if (!isText(asideName)) throw new Error("preview authority: a park needs its aside name.");
  const parked = () => {
    const token = mint(inv, KIND.PARKED, { id: target.id, asideName });
    ledgerOf(inv).parked.push(token);
    return token;
  };
  // Renamed (exit 0): it IS this invocation's park (the caller puts it back).
  // Unsettled: it is named as a leftover under the aside name, never forgotten.
  const r = mutateContainer(inv, deps, ["rename", target.id, asideName], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.outcome === "done") return parked();
  noteFailures(inv, [{ kind: "container", id: target.id, name: asideName,
    why: `the rename aside answered ${r.why}; whether it took effect is not settled, so it may be left under the aside name` }]);
  return null;
}

/**
 * Make the preview's data volume for THIS invocation with a fresh nonce label,
 * and read the label back (status-checked). Only a volume whose label holds
 * this nonce was made here (docker hands an existing volume back unchanged);
 * only then is volumeOwned minted (into the ledger). A failed create or read
 * throws, and nothing is removed on that account. Returns { createdHere }.
 */
export function createDataVolume(inv, name, deps) {
  const l = ledgerOf(inv);
  if (!isText(name)) throw new Error("preview authority: a data volume needs its name.");
  const nonce = (typeof deps.volumeNonce === "function" ? deps.volumeNonce : () => randomBytes(16).toString("hex"))();
  if (!isText(nonce)) throw new Error("preview authority: the volume nonce is not a string.");
  const made = dockerCall(deps, ["volume", "create", "--label", `${PREVIEW_VOLUME_CREATOR_LABEL}=${nonce}`, name], { timeoutMs: PROBE_TIMEOUT_MS });
  if (dockerFailed(made)) {
    // The daemon may still make it after it answered: a leftover by its name,
    // never judged absent by a read in this invocation.
    noteFailures(inv, [{ kind: "volume", name, why: `docker volume create answered ${failure(made)}; whether it made ${name} is not settled` }]);
    throw new Error(`docker volume create ${name} failed or is uncertain; nothing was removed.`);
  }
  const labels = readVolumeLabels(name, deps);
  if (labels === null) {
    // It exists (its create exited 0), and whether this run made it is not
    // known: a leftover by its name, so the settle never deletes the row it
    // was made for.
    noteFailures(inv, [{ kind: "volume", name, why: `docker volume inspect answered no map of labels after its create exited 0; whether this run made ${name} is unknown` }]);
    throw new Error(`docker volume inspect ${name} failed after its create or answered no map of labels; nothing was removed.`);
  }
  const createdHere = labels[PREVIEW_VOLUME_CREATOR_LABEL] === nonce;
  if (createdHere) l.volumes.push(mint(inv, KIND.VOLUME, { name, nonce }));
  return { createdHere };
}

/** The data volumes this invocation made and has not removed. */
export function ownedVolumes(inv) {
  const l = ledgerOf(inv);
  return l.volumes.filter((t) => !l.removed.has(`volume:${t.name}`));
}

/** liveness: a status-checked inspect by the ID of a container this
 *  invocation created or verified as the row's recorded one that answered
 *  running, or null (a parked container is never promoted). A promotion to
 *  ready takes nothing else. */
export function liveness(inv, container, deps) {
  requireToken(inv, container, [KIND.CREATED, KIND.RECORDED], "liveness");
  if (ledgerOf(inv).removed.has(container.id)) return null;
  const of = TOKENS.get(container).kind;
  return containerStateById(container.id, deps) === "running" ? mint(inv, KIND.LIVENESS, { id: container.id, of }) : null;
}

/** Note a condition of the row's own container (`container` is its token). */
export function noteCondition(inv, container, condition, why) {
  requireToken(inv, container, CONTAINER_KINDS, "noteCondition");
  if (!CONTAINER_CONDITIONS.includes(condition) || !isText(why)) throw new Error("preview authority: a condition names its kind and why.");
  ledgerOf(inv).conditions.set(container.id, Object.freeze({ id: container.id, condition, why }));
}

/** Note that a container this invocation set aside could not be put back: a
 *  leftover under its aside name (it only ever makes the row more degraded). */
export function noteParkedLeftover(inv, parked, why) {
  requireToken(inv, parked, [KIND.PARKED], "noteParkedLeftover");
  if (!isText(why)) throw new Error("preview authority: a leftover names why.");
  noteFailures(inv, [{ kind: "container", id: parked.id, name: parked.asideName, why }]);
}

/** Put a container this invocation set aside back under its own `name`, by its
 *  ID. True when the rename exits 0; the ledger then holds it as put back.
 *  Otherwise it is a leftover that may be under its aside name, and false. */
export function putBack(inv, parked, name, deps) {
  requireToken(inv, parked, [KIND.PARKED], "putBack");
  if (!isText(name)) throw new Error("preview authority: a container is put back under its own name.");
  const r = mutateContainer(inv, deps, ["rename", parked.id, name], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.outcome !== "done") {
    noteParkedLeftover(inv, parked, `the rename back to its own name answered ${r.why}; whether it took effect is not settled`);
    return false;
  }
  ledgerOf(inv).restored.add(parked.id);
  return true;
}

// --- the removals -------------------------------------------------------------

/**
 * Remove the forwarders labelled with the container token's ID, each by its
 * own ID (forwarderOf); with `baseName`, also the forwarder of that exact name
 * made before the forwarder-of label (listForwardersOf). A failed listing or
 * removal is an outcome naming what is left (and is kept in the ledger).
 */
export function removeForwardersOf(inv, container, deps, { baseName = null } = {}) {
  requireToken(inv, container, CONTAINER_KINDS, "removeForwardersOf");
  const listing = baseName === null ? { kind: "forwarder-listing", id: container.id }
    : { kind: "forwarder-listing", id: container.id, name: baseName };
  let ids;
  try {
    ids = listForwardersOf(container.id, deps, { baseName });
  } catch (err) {
    const left = [{ ...listing, why: `the listing of its forwarders failed: ${err.message}` }];
    noteFailures(inv, left);
    return outcome(left);
  }
  clearFailure(inv, listing);
  const left = [];
  for (const forwarder of ids.map((id) => mint(inv, KIND.FORWARDER, { id, of: container.id }))) {
    const r = mutateContainer(inv, deps, ["rm", "-f", forwarder.id], { timeoutMs: RUN_TIMEOUT_MS });
    if (r.outcome !== "done") left.push({ kind: "forwarder", id: forwarder.id, why: `docker rm: ${r.why}` });
    else clearFailure(inv, { kind: "forwarder", id: forwarder.id });
  }
  noteFailures(inv, left);
  return outcome(left);
}

/**
 * Remove a container this invocation created, parked or verified as recorded,
 * by its ID, with its forwarders first. Never by a name. An outcome names
 * what is left.
 */
export function removeContainer(inv, container, deps) {
  requireToken(inv, container, CONTAINER_KINDS, "removeContainer");
  const left = [...removeForwardersOf(inv, container, deps).left];
  const r = mutateContainer(inv, deps, ["rm", "-f", container.id], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.outcome !== "done") {
    const e = { kind: "container", id: container.id, why: `docker rm: ${r.why}` };
    left.push(e);
    noteFailures(inv, [e]);
  } else {
    ledgerOf(inv).removed.add(container.id);
    clearFailure(inv, { kind: "container", id: container.id });
  }
  return outcome(left);
}

/** Remove every container this invocation's own runs created and has not
 *  removed: the ledger, never an error object, says which. */
export function removeCreated(inv, deps) {
  const left = [];
  for (const token of createdNotRemoved(inv)) left.push(...removeContainer(inv, token, deps).left);
  return outcome(left);
}

/**
 * Remove a data volume this invocation made, only while its label still holds
 * this invocation's nonce, re-read (status-checked) right before a NON-forced
 * `volume rm` (which refuses a volume in use). A volume replaced under the name
 * since is not this run's and is kept; an unread label keeps it and names it.
 */
export function removeOwnedVolume(inv, volume, deps) {
  requireToken(inv, volume, [KIND.VOLUME], "removeOwnedVolume");
  const labels = readVolumeLabels(volume.name, deps);
  if (labels === null) {
    const left = [{ kind: "volume", name: volume.name, why: "its label could not be read again, so the volume this run made is kept" }];
    noteFailures(inv, left);
    return outcome(left);
  }
  if (labels[PREVIEW_VOLUME_CREATOR_LABEL] !== volume.nonce) return outcome([]);
  const r = dockerCall(deps, ["volume", "rm", volume.name], { timeoutMs: PROBE_TIMEOUT_MS });
  if (dockerFailed(r)) {
    const left = [{ kind: "volume", name: volume.name, why: `docker volume rm: ${failure(r)}` }];
    noteFailures(inv, left);
    return outcome(left);
  }
  ledgerOf(inv).removed.add(`volume:${volume.name}`);
  clearFailure(inv, { kind: "volume", name: volume.name });
  return outcome([]);
}

/**
 * The one named exception (tracked in cinatra-cli#306): an image tag that no
 * other preview row references, removed by the argv the preview road's wrapper
 * turns into a non-forced removal, which docker refuses while any container
 * uses the image. An image is rebuildable cache, not data. Returns true only
 * when the removal exited 0.
 */
export function removeUnreferencedImage(tag, deps) {
  if (!isText(tag)) return false;
  return !dockerFailed(dockerCall(deps, ["image", "rm", "-f", tag], { timeoutMs: PROBE_TIMEOUT_MS }));
}

// --- the row: the claim, the settle and the one promotion to "ready" --------

const registryIo = () => import("./preview.mjs");
const FORBIDDEN_PATCH_KEYS = ["state", "containerId", CLEANUP_INCOMPLETE_FIELD, CONTAINER_CONDITIONS_FIELD];

function checkedPatch(fields) {
  if (fields == null) return {};
  if (!isPlainObject(fields)) throw new Error("preview authority: a row patch is a plain object.");
  for (const k of FORBIDDEN_PATCH_KEYS) {
    if (Object.hasOwn(fields, k)) throw new Error(`preview authority: a row patch never sets ${k}; this module does.`);
  }
  return fields;
}

/**
 * Claim the row of `slug` under the registry lock: `take(existing, registry)`
 * validates the existing row (or its absence) and returns the row to write,
 * which this module writes as "provisioning". The claim records, from this
 * module's own read, the prior state and the recorded containerId.
 */
export async function claimRow(inv, { registryPath, slug, take }) {
  ledgerOf(inv);
  if (!isText(registryPath) || !isText(slug) || typeof take !== "function") throw new Error("preview authority: a claim needs its registry, slug and row.");
  const io = await registryIo();
  let claim = null;
  await io.withRegistryLock(registryPath, async () => {
    const reg = io.requireUsableRegistry(registryPath);
    const existing = io.getPreview(reg, slug);
    const row = await take(existing, reg);
    if (!isPlainObject(row)) throw new Error("preview authority: a claim writes a row object.");
    const next = { ...reg, previews: { ...reg.previews, [slug]: { ...row, state: PROVISIONING } } };
    io.writeRegistry(registryPath, next);
    const recordedId = existing && isFullId(existing.containerId) ? existing.containerId : null;
    claim = mint(inv, KIND.CLAIM, {
      slug,
      registryPath,
      sha: row.sha,
      prior: existing ? (isPreviewRowState(existing.state) ? existing.state : DEGRADED) : null,
      recordedId,
    });
  });
  return claim;
}

/** Split the ledger for the row whose container is `finalId`: a failure naming
 *  that container under its own name is a condition of it (not-replaced), every
 *  other failure a leftover. So is every container this invocation created and
 *  neither removed nor records as `finalId`, and every container it set aside
 *  and neither put back nor removed (a failure already naming one stands). */
function ledgerLists(inv, finalId) {
  const l = ledgerOf(inv);
  const leftovers = [];
  const conditions = [];
  for (const e of l.failures.values()) {
    if (e.kind === "container" && e.id === finalId && !Object.hasOwn(e, "name")) {
      conditions.push({ id: finalId, condition: "not-replaced", why: e.why });
    } else {
      leftovers.push({ ...e });
    }
  }
  const named = new Set([...l.failures.values()].filter((e) => e.kind === "container").map((e) => e.id));
  for (const t of l.created) {
    if (l.removed.has(t.id) || t.id === finalId || named.has(t.id)) continue;
    leftovers.push({ kind: "container", id: t.id, why: "this run created it and did not remove it" });
  }
  for (const t of l.parked) {
    if (l.removed.has(t.id) || l.restored.has(t.id) || named.has(t.id)) continue;
    leftovers.push({ kind: "container", id: t.id, name: t.asideName, why: "this run set it aside and did not put it back" });
  }
  for (const c of l.conditions.values()) if (c.id === finalId) conditions.push({ ...c });
  // An unsettled stop or start: a condition of the row's own container, else
  // that container is a leftover; never dropped.
  for (const u of l.unsettled.values()) {
    if (u.id === finalId) conditions.push({ id: u.id, condition: "state-unsettled", why: u.why });
    else leftovers.push({ kind: "container", id: u.id, why: u.why });
  }
  return { leftovers, conditions };
}

function mergeEntries(a, b) {
  const seen = new Set();
  const out = [];
  for (const e of [...a, ...b]) {
    const k = e.kind ? failureKey(e) : `${e.id}:${e.condition}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** A claim writes its row ONCE: the first settle or promotion that writes it
 *  (or finds the row no longer this claim's) spends it, so a later settle on
 *  any path (a final catch after a branch already settled) never overwrites a
 *  claim another invocation took since. A write that throws spends nothing. */
async function writeClaimed(claim, mutate) {
  if (SPENT.has(claim)) return null;
  const io = await registryIo();
  let written = null;
  await io.withRegistryLock(claim.registryPath, async () => {
    if (SPENT.has(claim)) return;
    const reg = io.requireUsableRegistry(claim.registryPath);
    const cur = io.getPreview(reg, claim.slug);
    // Only OUR claim (never a row another run finalized or claimed since).
    if (!cur || cur.state !== PROVISIONING || cur.sha !== claim.sha) {
      SPENT.add(claim);
      return;
    }
    const slot = await mutate(cur);
    const previews = { ...reg.previews };
    if (slot === null) delete previews[claim.slug];
    else previews[claim.slug] = slot;
    io.writeRegistry(claim.registryPath, { ...reg, previews });
    SPENT.add(claim);
    written = slot ?? { deleted: true };
  });
  return written;
}

function strip(cur) {
  const { [CLEANUP_INCOMPLETE_FIELD]: _l, [CONTAINER_CONDITIONS_FIELD]: _c, state: _s, ...rest } = cur;
  return rest;
}

/**
 * Release the claim WITHOUT a promotion. The row keeps its earlier leftovers
 * and gains this invocation's (the ledger's): its failures, every container it
 * created and neither removed nor records here, and every container it set
 * aside and did not put back; a failure naming the row's own container is a
 * condition of it. With any leftover or condition, or
 * `unhealthy`, the row is "degraded"; otherwise it returns to the state this
 * module read at the claim (a create's claim, with nothing left, is removed).
 * `container`, a containerCreated token, is the row's new container (the row
 * is then degraded: only promoteReady records a new container as ready).
 * `restored`, a containerParked token this invocation put back: on a row with
 * no recorded ID, when this invocation noted a condition of that container (or
 * an unsettled stop or start of it), it is the row's own container for this
 * settle, so the condition stands.
 * `patch(cur)` returns other fields (never a state or a list).
 * Returns { state, leftovers, conditions } or { deleted: true }, or null when
 * the claim was no longer ours.
 */
export async function settleRow(inv, claim, { patch = null, container = null, unhealthy = false, restored = null } = {}) {
  requireToken(inv, claim, [KIND.CLAIM], "settleRow");
  if (container !== null) requireToken(inv, container, [KIND.CREATED], "settleRow's container");
  if (restored !== null) requireToken(inv, restored, [KIND.PARKED], "settleRow's restored container");
  let result = null;
  await writeClaimed(claim, (cur) => {
    const fields = checkedPatch(patch ? patch(cur) : null);
    const recorded = isFullId(cur.containerId) ? cur.containerId : null;
    const l = ledgerOf(inv);
    const putBackId = restored !== null && recorded === null && l.restored.has(restored.id) &&
      ([...l.conditions.values()].some((c) => c.id === restored.id) || l.unsettled.has(restored.id)) ? restored.id : null;
    const finalId = container ? container.id : (recorded ?? putBackId);
    const own = ledgerLists(inv, finalId);
    const earlierLeftovers = Array.isArray(cur[CLEANUP_INCOMPLETE_FIELD]) ? cur[CLEANUP_INCOMPLETE_FIELD] : [];
    // An earlier leftover naming by ID only the container this settle records
    // (a row without a recorded ID, whose container is put back) is a
    // condition of it from now on, never a leftover of the row's own
    // container: its earlier change is not settled, so it is state-unsettled,
    // with its reason. It is moved, never dropped.
    const ofOwn = (e) => namesContainer(e, finalId) && !Object.hasOwn(e, "name");
    const earlierConditions = [
      ...(Array.isArray(cur[CONTAINER_CONDITIONS_FIELD]) ? cur[CONTAINER_CONDITIONS_FIELD] : []).filter((c) => isPlainObject(c) && c.id === finalId),
      ...earlierLeftovers.filter(ofOwn).map((e) => ({ id: finalId, condition: "state-unsettled", why: e.why })),
    ];
    const leftovers = mergeEntries(earlierLeftovers.filter((e) => !ofOwn(e)), own.leftovers);
    const conditions = mergeEntries(earlierConditions, own.conditions);
    // A new container is recorded as ready by promoteReady only: a settle that
    // records one (`container`) always writes degraded.
    const degraded = unhealthy === true || container !== null || leftovers.length > 0 || conditions.length > 0;
    if (!degraded && claim.prior === null) {
      result = { deleted: true };
      return null;
    }
    const state = degraded ? DEGRADED : claim.prior;
    result = { state, leftovers, conditions };
    return {
      ...strip(cur),
      ...fields,
      ...(finalId ? { containerId: finalId } : {}),
      ...(leftovers.length ? { [CLEANUP_INCOMPLETE_FIELD]: leftovers } : {}),
      ...(conditions.length ? { [CONTAINER_CONDITIONS_FIELD]: conditions } : {}),
      state,
    };
  });
  return result;
}

/** The text of a result line: the full ID of a container THIS invocation's own run created. */
export function previewContainerIdLine(inv, container) {
  if (!isTokenOf(inv, container, [KIND.CREATED]) || !isFullId(container.id)) {
    throw new Error("preview: a result line is printed only for a container this run created.");
  }
  return `${PREVIEW_CONTAINER_ID_KEY}=${container.id}`;
}

/**
 * THE ONE PROMOTION TO "ready". It takes a liveness token of this invocation
 * for the row's container: `container` (a containerCreated token: the new
 * container, recorded as containerId) or, without it, the ID this module read
 * from the registry at the claim. Every entry of that very container is KEPT
 * (ownContainerEntries): it is never re-read, and this liveness read clears
 * none of them except the closed exception READ_CLEARED_CONDITIONS, which it
 * re-checks. Every other earlier leftover of an object that existed is re-read
 * by a status-checked listing; an unanswered create is never read and always
 * stays. While any entry stands the row is "degraded", naming them, and the
 * promotion is REFUSED. Only the promotion of this invocation's own new
 * container (`container`: start --recreate, or a refresh) replaces the
 * recorded one, and the replaced container's entries go with it. Only a
 * "ready" write prints the result line, and only for a container this
 * invocation created.
 * A failure of THIS invocation that names the promoted container (its removal
 * or its rename back failed) is newer than any read of it, and so is a park of
 * it this invocation did not put back, and so is a stop or start of it that is
 * not settled: while the ledger holds one, the promotion is REFUSED and the
 * row is settled degraded, naming it, exactly as settleRow writes it.
 * Returns { state: "ready" } or { state: "degraded", left } (with `failed`,
 * this invocation's failures that name the container, on such a refusal), or
 * null when the claim was no longer ours.
 */
export async function promoteReady(inv, claim, live, { container = null, patch = null, deps, resultLine = false } = {}) {
  requireToken(inv, claim, [KIND.CLAIM], "promoteReady");
  requireToken(inv, live, [KIND.LIVENESS], "promoteReady's liveness");
  if (container !== null) requireToken(inv, container, [KIND.CREATED], "promoteReady's container");
  const id = container ? container.id : claim.recordedId;
  // The liveness of the new container this run created, or of the row's
  // recorded container verified in this invocation: never of another.
  if (!isFullId(id) || live.id !== id || live.of !== (container ? KIND.CREATED : KIND.RECORDED)) {
    throw new Error("preview authority: a promotion to ready takes the liveness of the very container the row records; nothing was changed.");
  }
  if (ledgerOf(inv).removed.has(id)) throw new Error("preview authority: a removed container is never promoted; nothing was changed.");
  const failed = ledgerFailures(inv).filter((e) => e.kind === "container" && e.id === id).map((e) => Object.freeze({ ...e }));
  const l = ledgerOf(inv);
  const aside = l.parked.some((t) => t.id === id && !l.restored.has(t.id));
  if (failed.length || aside || l.unsettled.has(id)) {
    const settled = await settleRow(inv, claim, { patch, container, unhealthy: true });
    if (!settled) return null;
    return { state: DEGRADED, ready: false, left: settled.leftovers ?? [], conditions: settled.conditions ?? [], failed: Object.freeze(failed) };
  }
  let result = null;
  await writeClaimed(claim, (cur) => {
    const fields = checkedPatch(patch ? patch(cur) : null);
    const own = ledgerLists(inv, id);
    const earlier = Array.isArray(cur[CLEANUP_INCOMPLETE_FIELD]) ? cur[CLEANUP_INCOMPLETE_FIELD] : [];
    // THE ONE RULE (ownContainerEntries): every entry of this very container,
    // an earlier command's or this invocation's, is KEPT and never re-read;
    // this liveness read clears only the closed exception. A container this
    // invocation created replaces the recorded one: the replaced one's
    // conditions go with it.
    const earlierConditions = (Array.isArray(cur[CONTAINER_CONDITIONS_FIELD]) ? cur[CONTAINER_CONDITIONS_FIELD] : [])
      .filter((c) => container === null || (isPlainObject(c) && c.id === id));
    const kept = ownContainerEntries({ [CONTAINER_CONDITIONS_FIELD]: mergeEntries(earlierConditions, own.conditions) }, id);
    // Every other entry is re-read by a status-checked listing. An unanswered
    // create (an unknown run, a volume create), this invocation's or an
    // earlier one's, is never re-read: the daemon may still make it after any
    // read (remainingLeftovers keeps it). An EARLIER unknown run under a name
    // one of this invocation's own creates then took (exit 0 with its ID)
    // cannot exist, since docker refuses a duplicate name: that create's own
    // container ID clears it.
    const ownUnsettled = own.leftovers.filter(isUnansweredCreate);
    const tookName = (e) => isPlainObject(e) && e.kind === "run" && l.took.has(e.name);
    const cleared = earlier.filter(tookName).map((e) => Object.freeze({ kind: "run", name: e.name, clearedBy: l.took.get(e.name) }));
    const merged = mergeEntries(earlier.filter((e) => !tookName(e)), own.leftovers.filter((e) => !ownUnsettled.includes(e)));
    const there = new Set(remainingLeftovers(merged.filter((e) => !namesContainer(e, id)), deps));
    const left = mergeEntries(merged.filter((e) => namesContainer(e, id) || there.has(e)), ownUnsettled);
    const base = { ...strip(cur), ...fields, containerId: id, ...(kept.length ? { [CONTAINER_CONDITIONS_FIELD]: kept } : {}) };
    if (left.length || kept.length) {
      result = { state: DEGRADED, ready: false, left, cleared, conditions: kept };
      return { ...base, ...(left.length ? { [CLEANUP_INCOMPLETE_FIELD]: left } : {}), state: DEGRADED };
    }
    result = { state: READY, ready: true, cleared };
    return { ...base, state: READY };
  });
  if (result?.ready && resultLine === true && container !== null) deps.log(previewContainerIdLine(inv, container));
  return result;
}
