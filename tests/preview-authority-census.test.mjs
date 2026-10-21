// THE PREVIEW AUTHORITY CENSUS (cinatra-cli#307): a static reading of src/ that
// FAILS when a docker removal, a forwarder removal or a write of the finished
// row state appears outside src/preview-authority.mjs, the one module that owns
// every removal of a preview's container, forwarder and data volume and every
// promotion of its registry row.
//
// It reads every .mjs file under src/ with a small lexer that drops comments
// and keeps every string literal (quoted or template, escapes decoded, so
// "r\x6d" is "rm") with the code just before it, then holds these rules:
//
//   1. Every file outside the authority module holds EXACTLY the removal-verb
//      literals this census pins for it, site by site (the value and its whole
//      source line). A literal names a removal when it IS a removal verb ("rm",
//      "rmi", "remove", "prune", "down", "disconnect", "--rm"), wherever it
//      stands in an argv, or when it is a docker command line one of whose
//      words is one ("docker rm -f x"). Each pinned site is the file's own
//      non-preview object (an instance's container, a compose stack, a one-shot
//      `run --rm`, a git worktree, a file) or an operator's hint; a site added,
//      removed or rewritten anywhere fails here and is reviewed: a preview
//      container's, forwarder's or volume's removal belongs in the module.
//   2. A preview file (a file whose name contains "preview", the authority
//      module excepted) holds no "ready" literal except as the right side of a
//      comparison (a read); every other file's "ready" literals (another
//      registry's states) are pinned site by site the same way.
//   3. The authority module's callers are exactly the preview files that use it.
//   4. src/ holds only .mjs sources, so every source is read.
//   5. Every exit-0 check of a docker or exec answer in a src/preview*.mjs
//      file is the one predicate, answerOk (preview-authority.mjs): no other
//      code there compares a `status` with 0, either way round. A comparison
//      with another exit code (a `status` of 1) is not an exit-0 check and is
//      outside this rule.
//   6. Every docker argv in a src/preview*.mjs file that changes a container
//      (its first word, or its word after "container", one of stop, start,
//      restart, kill, pause, unpause, rename, rm, run, create, update) is an
//      argument of THE ONE MUTATING CALL, mutateContainer
//      (preview-authority.mjs), which never takes a change docker answered
//      with no success as done or as not done. The sites that are not its are
//      pinned site by site, each with its reason: the two container runs (the
//      one creating call's, rule 7) and the argvs that change a network, a
//      volume or an image, not a container.
//   7. Every docker argv in a src/preview*.mjs file that CREATES a container
//      (its first word run or create, or that word after "container") is built
//      for THE ONE CREATING CALL, createContainer (preview-authority.mjs), and
//      for nothing else. The creating argvs are pinned site by site; every
//      name that holds one after it is built and every call of the one
//      creating call is pinned by its whole source line (in code, comments and
//      literals blanked); and every docker call whose argv is a name rather
//      than a literal array is pinned the same way, so a creating argv run by
//      any other call fails here. THE CLASS: no read is a completion barrier
//      for a call that answered no success (a create with no success is an
//      unknown run; a stop or start with no success is not settled), in the
//      same command or a later one. Only a success under the same name (a
//      create that exits 0 there: docker refuses a duplicate container name),
//      or a removal that exits 0 having removed the existing container (start
//      --recreate removes it by the ID its park read back), clears one. So the
//      body of remainingLeftovers is pinned line by line, every use of
//      isUnansweredCreate and every quoted "state-unsettled" is pinned by its
//      whole source line, and no preview source holds docker's "No such
//      container" text.
//   8. THE DEFAULT-KEEP RULE: every entry a row holds for its own container
//      (a condition of any kind, or a leftover that names its ID) is kept; a
//      plain start refuses it and a promotion keeps it, and no read clears it.
//      Only a replacement by the invocation's own new container clears it. The
//      census enumerates every ledger kind the module names or writes against
//      a pinned table (an unknown kind fails), holds the one closed exception
//      (READ_CLEARED_CONDITIONS) to exactly "not-running" and
//      "without-forwards", pins every code line that reads a condition's kind
//      or uses the rule, and pins each writer of an exception kind with the
//      code lines before it, from the answered success it is written after.
// The census reads literals: a verb or a state computed at run time ("r" + "m")
// is outside any static census of literals, and the review reads it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const AUTHORITY = "preview-authority.mjs";
const REMOVAL_VERBS = new Set(["rm", "rmi", "remove", "prune", "down", "disconnect", "--rm"]);

// Rule 1's census: every removal-verb literal of every file outside the authority module, each pinned by its VALUE and its whole
// SOURCE LINE (a tab between), none of them a preview object's (an instance's container, a compose stack, a one-shot `run --rm`, a
// git worktree, a file, a command's name, a migration's direction, an operator's hint). A site added, removed or rewritten
// anywhere fails the census, so no swap can hide a new removal.
const REMOVAL_SITES = {
  "command-table.mjs": [
    "prune\tpath: [\"instance\", \"clone\", \"prune\"],",
    "prune\tpath: [\"instance\", \"execution\", \"prune\"],",
  ],
  "dev-twenty.mjs": [
    ". Remove the partial set (docker rm -f \t`missing ${absent.join(\", \")}. Remove the partial set (docker rm -f ${present.join(\" \")}) or restore ` +",
  ],
  "execution-mode.mjs": [
    "--rm\t\"--rm\",",
    "Remove the network (`docker network rm \t`Remove the network (\\`docker network rm ${network}\\`) so the next bring-up recreates it \\`--internal\\`.`,",
    "rm\treturn [\"image\", \"rm\", String(id)];",
  ],
  "index.mjs": [
    "  [partial] docker compose down exited \tconsole.warn(` [partial] docker compose down exited ${downResult.status} — continuing.`);",
    "--rm\t[\"run\", \"--rm\", \"--pull=never\", \"--entrypoint\", \"/bin/sh\", \"-v\", `${name}:/__preflight_probe:ro`, image, \"-c\", \"ls -A /__preflight_probe\"],",
    "--rm\t[\"run\", \"--rm\", \"--pull=never\", \"--entrypoint\", \"/bin/sh\", \"-v\", `${volumeName}:${PG_MARKER_READ_MOUNT}:ro`, image, \"-c\", program],",
    "--rm\tconst dockerArgs = [\"run\", \"--rm\"];",
    "--rm\tdockerCapture([\"run\", \"--rm\", \"--pull=never\", \"--entrypoint\", \"/bin/sh\", \"-v\", `${volumeName}:${PG_MARKER_READ_MOUNT}:ro`, image, \"-c\", program], { timeoutMs: 60_000 });",
    "Remove it by hand with `docker rm -f \t`Remove it by hand with \\`docker rm -f ${plan.container}\\`, then re-run this command.`,",
    "docker compose down exited \tconsole.warn(`docker compose down exited ${downResult.status}.`);",
    "docker compose down failed\tconsole.warn(`docker compose down failed${why}.`);",
    "down\t[\"compose\", \"-p\", projectName, \"-f\", cloneComposeYml, \"down\"],",
    "down\t[\"compose\", \"-p\", projectName, \"-f\", composePath, \"down\"],",
    "down\t[\"compose\", \"-p\", projectName, \"-f\", composePath, \"down\"],",
    "down\tconst VERIFY_EXPOSURE_ACTIONS = [\"up\", \"status\", \"down\", \"check\"];",
    "down\tconst mutates = action === \"up\" || action === \"down\";",
    "down\tdirection: down ? \"down\" : \"up\",",
    "down\tdirection: down ? \"down\" : \"up\",",
    "down\tif (action === \"down\") {",
    "down\tif (action === \"down\") {",
    "down\tif (action === \"down\") {",
    "down\tif (hasArtifacts || (action !== \"status\" && action !== \"down\")) throw err;",
    "down\trunCommandOrThrow(\"docker\", [\"compose\", \"down\", \"-v\"], \"Failed to stop Docker containers.\", { cwd: repoRoot });",
    "down\tspawnSync(\"docker\", [\"compose\", \"-p\", projectName, \"-f\", composePath, \"down\"], {",
    "remove\t[\"-C\", mainRepoRoot, \"worktree\", \"remove\", \"--force\", expectedSibling],",
    "remove\t[\"-C\", mainRepoRoot, \"worktree\", \"remove\", expectedSibling],",
    "rm\t: [...base, \"rm\", \"-sf\", WAYFLOW_SERVICE];",
    "rm\t: [...base, \"rm\", \"-sf\", service];",
    "rm\tconst r = executionDockerCapture([\"volume\", \"rm\", v]);",
  ],
  "install.mjs": [
    "\nOr stop that stack yourself (`docker compose down`\t`\\nOr stop that stack yourself (\\`docker compose down\\`${dir ? ` from ${dir}` : \"\"}) / free the ports and retry.`",
    "  named volumes (a `docker compose down -v` from EITHER checkout could then destroy the OTHER's data).\n\t` named volumes (a \\`docker compose down -v\\` from EITHER checkout could then destroy the OTHER's data).\\n` +",
    "`docker compose down` failed, so NOTHING was released — the row and its whole reservation are intact. \t`\\`docker compose down\\` failed, so NOTHING was released — the row and its whole reservation are intact. ` +",
    "`docker volume rm` if you want the disk back.\t`\\`docker volume rm\\` if you want the disk back.`,",
    "docker compose down failed (exit \tif (result.status !== 0) throw new Error(`docker compose down failed (exit ${result.status}).${stderr ? `\\n${stderr}` : \"\"}`);",
    "docker compose down failed: \tif (result.error) throw new Error(`docker compose down failed: ${result.error.message}`);",
    "down\tconst args = [...composeArgsFor({ composeFiles, composeProject }), \"down\"];",
    "rm\t: [...baseArgs, \"rm\", \"-sf\", ...peerNames];",
    "rm\tif (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
    "rm\tif (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
    "rm\tif (existsSync(markerFile)) spawnSync(\"rm\", [\"-f\", markerFile]);",
    "rm\tif (existsSync(p) && f === ISOLATED_COMPOSE_FILENAME) spawnSync(\"rm\", [\"-f\", p]);",
    "rm\tif (f === ISOLATED_COMPOSE_FILENAME && existsSync(generated)) spawnSync(\"rm\", [\"-f\", generated]);",
    "rm\tspawnSync(\"rm\", [\"-f\", envPath]);",
    "rm\tspawnSync(\"rm\", [\"-f\", probePath]); // best-effort cleanup of the probe file.",
  ],
  "instance-runtime.mjs": [
    "rm\treturn [\"rm\", \"-f\", plan.container];",
  ],
  "preview-endpoint-ownership.mjs": [
    "project (`docker compose -p <project> down`) and re-run.\t`project (\\`docker compose -p <project> down\\`) and re-run.`,",
  ],
  "preview.mjs": [
    "remove\trunSpawn(\"git\", [\"-C\", checkoutDir, \"worktree\", \"remove\", \"--force\", contextDir], {",
  ],
  "recreate-preflight.mjs": [
    "--rm\t[\"run\", \"--rm\", \"--pull=never\", \"--entrypoint\", \"/bin/sh\", \"-v\", `${name}:/__preflight_probe:ro`, image, \"-c\", \"ls -A /__preflight_probe\"],",
    "--rm\t[\"run\", \"--rm\", \"--pull=never\", \"--entrypoint\", \"/bin/sh\", \"-v\", `${volumeName}:${PG_MARKER_READ_MOUNT}:ro`, image, \"-c\", program],",
  ],
};
// Rule 2's census for the non-preview files: their "ready" literals (another registry's states: instances, clones, executions),
// pinned the same way; a preview file holds none but comparisons.
const OTHER_READY_SITES = {
  "clone-registry.mjs": [
    "ready\tconst CLONE_STATES = new Set([\"provisioning\", \"ready\"]);",
    "ready\tnext.clones[slug] = { ...existing, state: \"ready\" };",
  ],
  "execution-mode.mjs": [
    "ready\treturn { state: \"ready\" };",
  ],
  "install.mjs": [
    "ready\treturn { infraPlan: \"co-use\", instance: { ...persisted.slot, state: \"ready\", appPort, dbName } };",
    "ready\tstate: \"ready\",",
    "ready\tstate: \"ready\",",
    "ready\tstate: infraPlan === \"external\" ? \"external\" : \"ready\",",
  ],
  "instance-marker.mjs": [
    "ready\tstate: \"ready\",",
  ],
  "instance-registry.mjs": [
    "ready\texport const INSTANCE_STATES = new Set([\"provisioning\", \"ready\", \"external\"]);",
    "ready\tnext.instances[slug] = { ...existing, ...patch, slug, state: \"ready\" };",
  ],
};
/** Every file under src/, as a path relative to src/ (the census reads them all; see the case that holds them to .mjs). */
function allFiles(dir = SRC, rel = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...allFiles(full, path.join(rel, name)));
    else out.push(path.join(rel, name));
  }
  return out;
}
const sourceFiles = () => allFiles().filter((rel) => rel.endsWith(".mjs"));

const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

/**
 * The string literals of a source, comments dropped: [{ value, before }], where
 * `before` is the code (comments and literals dropped) that precedes it. A
 * template literal's static text is one literal per chunk; its `${...}` parts
 * are read as code, so a string inside them is found too.
 */
/** A literal's value as the program sees it: every escape decoded (so `"r\\x6d"` reads as "rm"). */
export function decodeEscapes(raw) {
  const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
  return raw.replace(/\\(?:x([0-9A-Fa-f]{2})|u\{([0-9A-Fa-f]+)\}|u([0-9A-Fa-f]{4})|\r?\n|([\s\S]))/g, (m, x, ub, u4, ch) => {
    if (x) return String.fromCharCode(parseInt(x, 16));
    if (ub) return String.fromCodePoint(parseInt(ub, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (ch === undefined) return "";
    return Object.hasOwn(simple, ch) ? simple[ch] : ch;
  });
}

/** The source line that holds offset `at`, whitespace collapsed: a site's identity in the census. */
export function lineAt(src, at) {
  const start = src.lastIndexOf("\n", at) + 1;
  const end = src.indexOf("\n", at);
  return src.slice(start, end === -1 ? src.length : end).trim().replace(/\s+/g, " ");
}

export function stringLiterals(src) {
  return lex(src).literals;
}

/** The line numbers of a source's ambiguous slashes (a slash after `}`, after a postfix `++` or `--`, or after a bare `of`), each read as division. */
export function ambiguousSlashes(src) {
  return lex(src).ambiguous;
}

/** The source with every comment, string literal and regex blanked (its newlines kept): its code only. */
export function codeOnly(src) {
  const chars = src.split("");
  for (const [a, b] of lex(src).spans) {
    for (let k = a; k < b && k < chars.length; k++) if (chars[k] !== "\n") chars[k] = " ";
  }
  return chars.join("");
}

function lex(src) {
  const out = [];
  const spans = [];
  const ambiguous = [];
  let code = "";
  let i = 0;
  const lineOf = (at) => {
    let line = 1;
    for (let k = 0; k < at; k++) if (src[k] === "\n") line++;
    return line;
  };
  const lastSignificant = () => {
    const m = /(\S+)\s*$/.exec(code);
    return m ? m[1] : "";
  };
  const regexAllowed = () => {
    const last = lastSignificant();
    if (last === "") return true;
    const ch = last.at(-1);
    // After `}` (a block or an object literal) or a postfix `++`/`--` a slash may
    // be division or a regex; without a parser it is read as division and its
    // line is recorded, so the census can refuse it.
    if (ch === "}" || /(?:\+\+|--)$/.test(last)) {
      ambiguous.push(lineOf(i));
      return false;
    }
    if (REGEX_BEFORE.has(ch)) return true;
    const word = /([A-Za-z_$][\w$]*)$/.exec(last);
    if (!word || !REGEX_AFTER_WORD.has(word[1])) return false;
    // A word after a property dot (`obj.of`, `obj?.in`, `obj. return`; a spread
    // `...` is no property dot) or a private `#` is a property name, never a
    // keyword: a slash after it is division.
    const head = word.index > 0 ? last.slice(0, word.index) : code.trimEnd().slice(0, -last.length).trimEnd();
    if (head.endsWith("#") || (head.endsWith(".") && !head.endsWith("..."))) return false;
    // `of` is a keyword only in a for-of head; anywhere else it may be a name
    // (`const of = 2; of / n`), so a slash after it is ambiguous: it is read as
    // division and its line is recorded. Every other word of the set is
    // reserved in a module, so after it a slash opens a regex.
    if (word[1] === "of") {
      ambiguous.push(lineOf(i));
      return false;
    }
    return true;
  };
  const readQuoted = (q) => {
    let j = i + 1;
    let value = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\") { value += src.slice(j, j + 2); j += 2; continue; }
      value += src[j++];
    }
    out.push({ value: decodeEscapes(value), before: code, at: i, end: j + 1 });
    spans.push([i, j + 1]);
    code += " __s ";
    i = j + 1;
  };
  const readTemplate = () => {
    let j = i + 1;
    let chunk = "";
    let chunkStart = i;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") { chunk += src.slice(j, j + 2); j += 2; continue; }
      if (src[j] === "$" && src[j + 1] === "{") {
        out.push({ value: decodeEscapes(chunk), before: code, at: j });
        spans.push([chunkStart, j + 2]);
        chunk = "";
        code += " __s ";
        // the expression: lexed as code up to its matching brace
        let depth = 1;
        i = j + 2;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "{") { depth++; code += c; i++; continue; }
          if (c === "}") { depth--; if (depth > 0) code += c; i++; continue; }
          if (!step()) { code += c; i++; }
        }
        j = i;
        chunkStart = i - 1;
        continue;
      }
      chunk += src[j++];
    }
    out.push({ value: decodeEscapes(chunk), before: code, at: i });
    spans.push([chunkStart, j + 1]);
    code += " __s ";
    i = j + 1;
  };
  // One lexing step at i for a comment, a literal or a regex; false for plain code.
  function step() {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); spans.push([i, e === -1 ? src.length : e]); i = e === -1 ? src.length : e; return true; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); spans.push([i, e === -1 ? src.length : e + 2]); i = e === -1 ? src.length : e + 2; return true; }
    if (c === "'" || c === '"') { readQuoted(c); return true; }
    if (c === "`") { readTemplate(); return true; }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { if (src[j + 1] === "\n") break; j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) { closed = true; break; }
        j++;
      }
      // A regex closes on its own line: a slash with no closing slash before the
      // line end or the source end is code (division).
      if (!closed) return false;
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      code += " __re ";
      spans.push([i, j]);
      i = j;
      return true;
    }
    return false;
  }
  while (i < src.length) {
    if (!step()) { code += src[i]; i++; }
  }
  return { literals: out, spans, ambiguous };
}

const isPreviewFile = (rel) => path.basename(rel).includes("preview") && path.basename(rel) !== AUTHORITY;
const read = (rel) => readFileSync(path.join(SRC, rel), "utf8");
/** A literal names a removal when it IS a removal verb, or when it is a docker command line one of whose words is one ("docker rm -f x"). */
const DOCKER_REMOVAL_LINE = /(?:^|[\s`'"(])(?:docker|podman|nerdctl)\s+(?:\S+\s+){0,6}?(?:rm|rmi|remove|prune|down|disconnect)(?=$|[\s`'")])/;
const namesRemoval = (value) => REMOVAL_VERBS.has(value) || DOCKER_REMOVAL_LINE.test(value);
const isComparison = (before) => /(?:===|!==|==|!=)\s*$/.test(before);
/** An inline exit-0 check: a `status` compared with 0, either way round. */
const INLINE_STATUS = /\bstatus\s*[!=]==?\s*0(?![\w$.])|(?<![\w$.])0\s*[!=]==?\s*[\w$.?]*\bstatus\b/g;
/** The one site that may hold one: the predicate itself. */
const PREDICATE_SITES = ["preview-authority.mjs\treturn !r.error && !r.timedOut && r.status === 0;"];
/** Rule 6: the verbs that change a container (docker's aliases included), the objects whose argv names one after its own word,
 *  the image removal's own short form, and the one mutating call. */
const CONTAINER_CHANGES = new Set(["stop", "start", "restart", "kill", "pause", "unpause", "rename", "rm", "remove", "prune", "run", "create", "update"]);
const OTHER_OBJECTS = new Set(["network", "volume", "image"]);
const OTHER_CHANGES = new Set(["create", "rm", "remove", "prune", "connect", "disconnect"]);
const MUTATING_CALL = /\bmutateContainer\(\s*inv\s*,\s*deps\s*,\s*\[\s*$/;
/** Rule 6's pinned sites outside the one mutating call: "file<TAB>argv words<TAB>its whole source line", each with its reason. */
const UNREAD_MUTATION_SITES = [
  // a preview container's run: it is the one creating call's (rule 7, through runOwnContainer); its effect is read from
  // its --cidfile, so a run that failed or timed out after the create still names the container it made, in the ledger,
  // and its removal is the one mutating call's; one with no success and no ID in its cidfile is an unknown run, kept by
  // the ledger under the container name it ran under
  "preview.mjs\trun -d\t\"run\", \"-d\",",
  // a forwarder's run: it is the one creating call's (rule 7); a run with no success and no ID in its cidfile is an unknown
  // run under the forwarder's exact name, kept by the ledger (the row settles degraded). The labelled listing and removal
  // that follow a failed run are cleanup only: no read there judges the run not made
  "preview-host-handover.mjs\trun -d\t\"run\", \"-d\",",
  // a network join changes no container's state or name: a join that answers a non-zero exit is read by the container's
  // membership, and one that errored, timed out or is not read as made fails the attach
  "preview-host-handover.mjs\tnetwork connect\tconst r = deps.runDocker([\"network\", \"connect\", network, containerId], { timeoutMs: 15_000 });",
  // a data volume's create is read back by its label (this invocation's nonce, or the label naming its slug) before any
  // authority is taken from it; a create with no success removes nothing and is kept by the ledger under its name, never
  // judged not made by a read after it
  "preview-authority.mjs\tvolume create\tconst made = dockerCall(deps, [\"volume\", \"create\", \"--label\", `${PREVIEW_VOLUME_CREATOR_LABEL}=${nonce}`, name], { timeoutMs: PROBE_TIMEOUT_MS });",
  "preview.mjs\tvolume create\tconst r = deps.runDocker([\"volume\", \"create\", \"--driver\", \"local\", \"--label\", `${ARTIFACT_VOLUME_OWNER_LABEL}=${slug}`, name], { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });",
  // a data volume's removal with no success keeps it named as a leftover (fail closed), never as removed
  "preview-authority.mjs\tvolume rm\tconst r = dockerCall(deps, [\"volume\", \"rm\", volume.name], { timeoutMs: PROBE_TIMEOUT_MS });",
  // an image is rebuildable cache: a removal with no success reads as kept
  "preview-authority.mjs\timage rm\treturn !dockerFailed(dockerCall(deps, [\"image\", \"rm\", \"-f\", tag], { timeoutMs: PROBE_TIMEOUT_MS }));",
].sort();
/** The argvs of a source that change something: each { words, viaMutatingCall, at }, its first two literal words read. */
function changingArgvs(src) {
  const lits = stringLiterals(src);
  const out = [];
  lits.forEach((l, i) => {
    if (!/\[\s*$/.test(l.before)) return;
    const next = lits[i + 1];
    const second = next && /^\s*__s\s*,\s*$/.test(next.before.slice(l.before.length)) ? next.value : null;
    const changesContainer = CONTAINER_CHANGES.has(l.value) || (l.value === "container" && CONTAINER_CHANGES.has(second));
    const changesOther = (OTHER_OBJECTS.has(l.value) && OTHER_CHANGES.has(second)) || l.value === "rmi";
    if (!changesContainer && !changesOther) return;
    const words = l.value === "container" || (changesOther && l.value !== "rmi") || l.value === "run" ? `${l.value} ${second ?? ""}`.trim() : l.value;
    out.push({ words, viaMutatingCall: changesContainer && MUTATING_CALL.test(l.before), at: l.at });
  });
  return out;
}

/** Rule 7: the argvs that create a container, by their first word (or their word after "container"). */
const CREATES = new Set(["run", "create"]);
/** Rule 7's creating argvs: "file<TAB>its whole source line"; each is built for the one creating call only. */
const CREATING_ARGV_SITES = [
  "preview-host-handover.mjs\t\"run\", \"-d\",",
  "preview.mjs\t\"run\", \"-d\",",
];
/** Rule 7's flow: every use in src/ (code only) of a name that holds a creating argv, and every call of the one creating
 *  call: "file<TAB>name<TAB>its whole source line (literals blanked)", one row per use. */
const CREATING_FLOW_NAMES = /\b(?:createContainer|runOwnContainer|previewForwarderRunArgs|runArgs)\b/g;
const CREATING_FLOW_SITES = [
  "preview-authority.mjs\tcreateContainer\texport function createContainer(inv, deps, args, { imageAt, timeoutMs, tmpDir = null }) {",
  "preview-authority.mjs\trunOwnContainer\texport function runOwnContainer(inv, { args, deps, tmpDir = null, what = }) {",
  "preview-authority.mjs\tcreateContainer\tconst made = createContainer(inv, deps, args, { imageAt: args.length - 1, timeoutMs: RUN_TIMEOUT_MS, tmpDir });",
  "preview-host-handover.mjs\tcreateContainer\tCONTAINER_ID_RE, PREVIEW_FORWARDER_GENERIC_LABEL, PREVIEW_FORWARDER_OF_LABEL, answerOk, assertContainerToken, createContainer, holderOfName, outputText, removeForwardersOf,",
  "preview-host-handover.mjs\tpreviewForwarderRunArgs\texport function previewForwarderRunArgs({ containerName, containerId, tag, forwards }) {",
  "preview-host-handover.mjs\trunArgs\tconst runArgs = previewForwarderRunArgs({ containerName, containerId, tag, forwards });",
  "preview-host-handover.mjs\tpreviewForwarderRunArgs\tconst runArgs = previewForwarderRunArgs({ containerName, containerId, tag, forwards });",
  "preview-host-handover.mjs\tcreateContainer\tconst made = createContainer(inv, deps, runArgs, { imageAt: runArgs.indexOf(tag), timeoutMs: 60_000 });",
  "preview-host-handover.mjs\trunArgs\tconst made = createContainer(inv, deps, runArgs, { imageAt: runArgs.indexOf(tag), timeoutMs: 60_000 });",
  "preview-host-handover.mjs\trunArgs\tconst made = createContainer(inv, deps, runArgs, { imageAt: runArgs.indexOf(tag), timeoutMs: 60_000 });",
  "preview.mjs\trunOwnContainer\trunOwnContainer,",
  "preview.mjs\trunOwnContainer\tconst token = runOwnContainer(inv, { args, deps, tmpDir: deps.envFileTmpDir ?? null, what: containerName tag });",
];
/** The preview container's argv is the local `args` of runPreviewContainer: its every use there. */
const PREVIEW_RUN_ARGS_USES = [
  "const args = [",
  "if (provenance) args.push( , provenance );",
  "if (sha) args.push( , sha );",
  "args.push(tag);",
  "const token = runOwnContainer(inv, { args, deps, tmpDir: deps.envFileTmpDir ?? null, what: containerName tag });",
];
/** Rule 7: every docker call in the preview files whose argv is NOT a literal array (and every alias of a docker call),
 *  "file<TAB>its whole source line (literals blanked)": none of them may be handed a creating argv. */
const DOCKER_CALL_NAMES = /\b(?:runDocker|dockerCall|mutateContainer|createContainer)\b(?!\s*\(\s*(?:deps\s*,\s*|inv\s*,\s*deps\s*,\s*)?\[)/g;
const NAMED_ARGV_CALLS = [
  "preview-authority.mjs\tdockerCall\tfunction dockerCall(deps, args, opts) {",
  "preview-authority.mjs\trunDocker\tconst r = deps.runDocker(args, opts);",
  "preview-authority.mjs\tdockerCall\tconst r = dockerCall(deps, args, { timeoutMs: PROBE_TIMEOUT_MS });",
  "preview-authority.mjs\tmutateContainer\texport function mutateContainer(inv, deps, args, { timeoutMs }) {",
  "preview-authority.mjs\tdockerCall\tconst r = dockerCall(deps, args, { timeoutMs });",
  "preview-authority.mjs\tcreateContainer\texport function createContainer(inv, deps, args, { imageAt, timeoutMs, tmpDir = null }) {",
  "preview-authority.mjs\tdockerCall\tr = dockerCall(deps, argv, { timeoutMs });",
  "preview-authority.mjs\tcreateContainer\tconst made = createContainer(inv, deps, args, { imageAt: args.length - 1, timeoutMs: RUN_TIMEOUT_MS, tmpDir });",
  "preview-host-handover.mjs\tcreateContainer\tCONTAINER_ID_RE, PREVIEW_FORWARDER_GENERIC_LABEL, PREVIEW_FORWARDER_OF_LABEL, answerOk, assertContainerToken, createContainer, holderOfName, outputText, removeForwardersOf,",
  "preview-host-handover.mjs\tcreateContainer\tconst made = createContainer(inv, deps, runArgs, { imageAt: runArgs.indexOf(tag), timeoutMs: 60_000 });",
  "preview.mjs\tmutateContainer\tmutateContainer,",
  "preview.mjs\trunDocker\trunDocker: (args, opts = {}) => runSpawn( , args, opts),",
  "preview.mjs\trunDocker\tr = deps.runDocker(args, {",
  "preview.mjs\trunDocker\tconst r = deps.runDocker(args, { timeoutMs: DOCKER_CLI_PROBE_TIMEOUT_MS });",
  "preview.mjs\trunDocker\tconst run = deps.runDocker;",
  "preview.mjs\trunDocker\tconst runDocker = (args, opts) => {",
  "preview.mjs\trunDocker\treturn { ...deps, ...logs, runDocker };",
];
/** Rule 7, the class: the body of remainingLeftovers (code only), line by line. An unanswered create stays, unread. */
const REMAINING_LEFTOVERS_BODY = [
  "return (Array.isArray(list) ? list : []).filter((e) => {",
  "if (!isLeftoverEntry(e) || isUnansweredCreate(e)) return true;",
  "try {",
  "if (e.kind === || e.kind === ) return listed(idListArgs(e.id), e.id, deps) !== ;",
  "if (e.kind === ) return listForwardersOf(e.id, deps, { baseName: e.name ?? null }).length > 0;",
  "return listed(volumeListArgs(e.name), e.name, deps) !== ;",
  "} catch {",
  "return true;",
  "}",
  "});",
];
/** Rule 7, the class: every use of isUnansweredCreate, "file<TAB>name<TAB>its whole source line (literals blanked)". */
const UNANSWERED_CREATE_SITES = [
  "preview-authority.mjs\tisUnansweredCreate\texport function isUnansweredCreate(e) {",
  "preview-authority.mjs\tisUnansweredCreate\tif (!isLeftoverEntry(e) || isUnansweredCreate(e)) return true;",
  "preview-authority.mjs\tisUnansweredCreate\tconst ownUnsettled = own.leftovers.filter(isUnansweredCreate);",
];
/** Rule 7, the class: every source line that quotes "state-unsettled": "file<TAB>its whole source line". */
const STATE_UNSETTLED_SITES = [
  "preview-authority.mjs\texport const CONTAINER_CONDITIONS = Object.freeze([\"not-running\", \"without-forwards\", \"not-replaced\", \"state-unsettled\"]);",
  "preview-authority.mjs\tif (u.id === finalId) conditions.push({ id: u.id, condition: \"state-unsettled\", why: u.why });",
  "preview-authority.mjs\t...earlierLeftovers.filter(ofOwn).map((e) => ({ id: finalId, condition: \"state-unsettled\", why: e.why })),",
];
/** Rule 8: every ledger kind the module names or writes, with what clears it. A kind not in this table fails the census. */
const LEDGER_KINDS = {
  container: "kept while it names the row's own container; one that names another container is re-read by a listing",
  forwarder: "another container: re-read by a listing",
  "forwarder-listing": "a listing that failed: re-read",
  volume: "re-read by a listing, unless its create went unanswered (kept)",
  run: "an unanswered create: kept until a create under its name exits 0",
  "not-replaced": "kept",
  "state-unsettled": "kept",
  "not-running": "the closed exception: written only after an answered success, re-checked by the next plain start",
  "without-forwards": "the closed exception: written only after an answered success, re-checked by the next plain start",
};
const EXCEPTION = ["not-running", "without-forwards"];
/** Rule 8: every code use of the rule, "file<TAB>name<TAB>its whole source line (literals blanked)". */
const DEFAULT_KEEP_SITES = [
  "preview-authority.mjs\tREAD_CLEARED_CONDITIONS\texport const READ_CLEARED_CONDITIONS = Object.freeze([ , ]);",
  "preview-authority.mjs\townContainerEntries\texport function ownContainerEntries(slot, id = isPlainObject(slot) ? slot.containerId : null) {",
  "preview-authority.mjs\tREAD_CLEARED_CONDITIONS\treturn [...conditions.filter((c) => !(isPlainObject(c) && READ_CLEARED_CONDITIONS.includes(c.condition))),",
  "preview-authority.mjs\tnamesContainer\t...leftovers.filter((e) => namesContainer(e, id))];",
  "preview-authority.mjs\tnamesContainer\tfunction namesContainer(e, id) {",
  "preview-authority.mjs\tnamesContainer\tconst ofOwn = (e) => namesContainer(e, finalId) && !Object.hasOwn(e, );",
  "preview-authority.mjs\townContainerEntries\tconst kept = ownContainerEntries({ [CONTAINER_CONDITIONS_FIELD]: mergeEntries(earlierConditions, own.conditions) }, id);",
  "preview-authority.mjs\tnamesContainer\tconst there = new Set(remainingLeftovers(merged.filter((e) => !namesContainer(e, id)), deps));",
  "preview-authority.mjs\tnamesContainer\tconst left = mergeEntries(merged.filter((e) => namesContainer(e, id) || there.has(e)), ownUnsettled);",
  "preview.mjs\townContainerEntries\townContainerEntries,",
  "preview.mjs\townContainerEntries\tconst pending = recreate ? null : (ownContainerEntries(existing)[0] ?? null);",
  "preview.mjs\townContainerEntries\tconst kept = ownContainerEntries({ [CLEANUP_INCOMPLETE_FIELD]: settled?.leftovers ?? [], [CONTAINER_CONDITIONS_FIELD]: settled?.conditions ?? [] }, parked.id);",
];
/** Rule 8: every code line of a preview source that reads a condition's kind: "file<TAB>match<TAB>its whole source line (literals blanked)". */
const CONDITION_READ_SITES = [
  "preview-authority.mjs\t.condition\treturn isFullId(e.id) && isFullId(ownId) && e.id === ownId && isText(e.condition) &&",
  "preview-authority.mjs\t.condition\tCONTAINER_CONDITIONS.includes(e.condition) && isText(e.why);",
  "preview-authority.mjs\t.condition\treturn [...conditions.filter((c) => !(isPlainObject(c) && READ_CLEARED_CONDITIONS.includes(c.condition))),",
  "preview-authority.mjs\t.condition\tconst k = e.kind ? failureKey(e) : e.id e.condition ;",
  "preview.mjs\t.condition\t...(settled.conditions ?? []).map((c) => c.id.slice(0, 12) c.condition )];",
];
/** Rule 8: each writer of an exception kind, with the code lines before it (comments dropped), from the answered success it is written after. */
const EXCEPTION_WRITERS = [
  ["preview.mjs", [
    "const down = mutateContainer(inv, deps, [\"stop\", parked.id], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });",
    "const stoppedAside = down.outcome === \"done\";",
    "let asideFailed = stoppedAside ? null : `docker stop ${asideName} answered ${down.why}; whether it took effect is not settled`;",
    "if (!asideFailed) {",
    "const fw = removeForwardersOf(inv, parked, deps, { baseName: previewForwarderName(name) });",
    "if (!fw.removed) asideFailed = fw.left.map((l) => l.why).join(\"; \");",
    "}",
    "if (asideFailed) {",
    "const back = putBack(inv, parked, name, deps);",
    "if (back && stoppedAside) noteCondition(inv, parked, \"not-running\", \"set aside and stopped, then put back stopped: the removal of its forwarders failed\");",
  ]],
  ["preview.mjs", [
    "const down = mutateContainer(inv, deps, [\"stop\", parked.id], { timeoutMs: PREVIEW_STOP_TIMEOUT_MS });",
    "const why = err?.message ?? String(err);",
    "if (down.outcome !== \"done\") return { outcome: \"restored-unsettled\", parked: null, why, stopWhy: down.why };",
    "noteCondition(inv, parked, \"not-running\", \"its declared forwards failed after the restore; it was stopped again\");",
  ]],
  ["preview.mjs", [
    "const state = containerStateById(parked.id, deps);",
    "if (state === \"running\") return { outcome: \"restored\", parked: null };",
    "if (state === \"unknown\") return { outcome: \"unconfirmed\", parked: null };",
    "if (state === \"stopped\") {",
    "noteCondition(inv, parked, \"not-running\", \"the restored container started and then exited\");",
  ]],
];
/** A file's code-only matches of `re`: "file<TAB>match<TAB>its whole source line, literals blanked", in order. */
const codeSites = (rel, re) => {
  const code = codeOnly(read(rel));
  return [...code.matchAll(re)].map((m) => `${rel}\t${m[0]}\t${lineAt(code, m.index)}`);
};

/** The census is defined against the authority module: every rule first reads it (it must exist). */
const authorityLiterals = () => stringLiterals(read(AUTHORITY)).map((l) => l.value);
/** The sites of a file's literals that `pick` selects: "value<TAB>its whole source line", sorted. */
const siteList = (rel, pick) => {
  const src = read(rel);
  return stringLiterals(src).filter(pick).map((l) => `${l.value}\t${lineAt(src, l.at)}`).sort();
};

describe("the preview authority census (cinatra-cli#307)", () => {
  it("the authority module exists and holds the preview's removals and its one promotion; the lexer reads literals in code only", () => {
    const literals = authorityLiterals();
    expect(literals).toContain("rm");
    expect(literals).toContain("ready");
    const src = 'const a = ["rm", x]; // "rm"\n/* "ready" */ const r = /"rm"/g; const t = `a${"down"}b`; const e = "r\\x6d"; if (s === "ready") {}';
    expect(stringLiterals(src).map((l) => l.value)).toEqual(["rm", "a", "down", "b", "rm", "ready"]);
    expect(isComparison(stringLiterals(src).at(-1).before)).toBe(true);
    // a shell-like string names its removal too
    expect(namesRemoval("docker rm -f x")).toBe(true);
    expect(namesRemoval("form")).toBe(false);
    expect(namesRemoval("or prune the existing preview first")).toBe(false);
    expect(namesRemoval("docker compose -p x down")).toBe(true);
    expect(namesRemoval("docker volume remove x")).toBe(true);
    // a removal verb counts wherever it stands in an argv: no word before it is read
    const argv = stringLiterals('run([kind, "remove", id]); run(["container", "remove", id]); git(["worktree", "remove", w]);');
    expect(argv.filter((l) => namesRemoval(l.value)).map((l) => l.value)).toEqual(["remove", "remove", "remove"]);
    expect(namesRemoval("[--docker=auto|always|--no-docker] ... prune")).toBe(false);
  });

  it("every file outside the authority module holds exactly the removal-verb sites this census pins for it, none of them a preview's", () => {
    expect(authorityLiterals()).toContain("rm");
    const sites = Object.fromEntries(sourceFiles().filter((rel) => rel !== AUTHORITY)
      .map((rel) => [rel, siteList(rel, (l) => namesRemoval(l.value))]).filter(([, s]) => s.length > 0));
    expect(sites).toEqual(REMOVAL_SITES);
  });

  it("no preview file outside the authority module writes the finished state: a \"ready\" literal is only ever compared", () => {
    expect(authorityLiterals()).toContain("rm");
    const hits = sourceFiles().filter(isPreviewFile).flatMap((rel) => stringLiterals(read(rel))
      .filter((l) => l.value === "ready" && !isComparison(l.before))
      .map((l) => `${rel}: "ready" after …${l.before.slice(-60).replace(/\s+/g, " ")}`));
    expect(hits).toEqual([]);
    // every other file's "ready" literals are another registry's states, pinned site by site
    const others = Object.fromEntries(sourceFiles().filter((rel) => !isPreviewFile(rel) && rel !== AUTHORITY)
      .map((rel) => [rel, siteList(rel, (l) => l.value === "ready" && !isComparison(l.before))]).filter(([, s]) => s.length > 0));
    expect(others).toEqual(OTHER_READY_SITES);
  });

  it("src/ holds only .mjs sources, every one read by this census", () => {
    expect(authorityLiterals()).toContain("rm");
    expect(allFiles().filter((rel) => !rel.endsWith(".mjs"))).toEqual([]);
  });

  it("the authority module's callers are exactly the preview lifecycle, its host handover and its endpoint ownership", () => {
    expect(authorityLiterals()).toContain("rm");
    const callers = sourceFiles().filter((rel) => rel !== AUTHORITY &&
      stringLiterals(read(rel)).some((l) => l.value === "./preview-authority.mjs"));
    expect(callers).toEqual(["preview-endpoint-ownership.mjs", "preview-host-handover.mjs", "preview.mjs"]);
  });

  it("every exit-0 check of a docker or exec answer in the preview files is the one predicate: no other code there compares a status with 0", () => {
    expect(authorityLiterals()).toContain("rm");
    // the reading itself: code only, either way round, never a comment or a literal
    const probe = '// r.status === 0\nconst s = "x.status !== 0"; if (r.status !== 0) {} if (0 === res?.status) {} if (r.status === 0.5) {}';
    expect([...codeOnly(probe).matchAll(INLINE_STATUS)].map((m) => m[0])).toEqual(["status !== 0", "0 === res?.status"]);
    const sites = sourceFiles().filter((rel) => path.basename(rel).startsWith("preview")).flatMap((rel) => {
      const src = read(rel);
      return [...codeOnly(src).matchAll(INLINE_STATUS)].map((m) => `${rel}\t${lineAt(src, m.index)}`);
    });
    expect(sites).toEqual(PREDICATE_SITES);
  });
  it("every docker argv in the preview files that changes a container is the one mutating call's; every other change is pinned with its reason", () => {
    expect(authorityLiterals()).toContain("rm");
    // the reading itself: a raw change, a change after "container" and a change of another object are each found; a read is not
    const probe = 'mutateContainer(inv, deps, ["stop", id], o); deps.runDocker(["stop", id]); x(["container", "rm", "-f", id]);\n' +
      'x(["volume", "inspect", v]); x(["volume", "rm", v]); x(["container", "inspect", id]); // x(["kill", id])\n' +
      'x(["container", "remove", "-f", id]); x(["container", "prune", "-f"]); x(["rmi", tag]);\n';
    expect(changingArgvs(probe).map((a) => `${a.words}:${a.viaMutatingCall}`)).toEqual(["stop:true", "stop:false", "container rm:false", "volume rm:false",
      "container remove:false", "container prune:false", "rmi:false"]);
    const files = sourceFiles().filter((rel) => path.basename(rel).startsWith("preview"));
    const unread = [];
    const viaCall = {};
    for (const rel of files) {
      const src = read(rel);
      for (const a of changingArgvs(src)) {
        if (a.viaMutatingCall) viaCall[rel] = (viaCall[rel] ?? 0) + 1;
        else unread.push(`${rel}\t${a.words}\t${lineAt(src, a.at)}`);
      }
    }
    expect(unread.sort()).toEqual(UNREAD_MUTATION_SITES);
    // the one mutating call's sites: the lifecycle's stops and starts, and the module's renames and removals
    expect(viaCall).toEqual({ "preview-authority.mjs": 4, "preview.mjs": 6 });
  });
  it("every docker argv in the preview files that creates a container is built for the one creating call and reaches no other call", () => {
    expect(authorityLiterals()).toContain("rm");
    // the reading itself: a run, a create and a container run or create are each found; a volume create is not one
    const probe = 'x(["run", "-d", "--name", n, img]); x(["create", "--name", n, img]); x(["container", "run", "-d", img]);\n' +
      'x(["container", "create", img]); x(["volume", "create", v]); x(["container", "inspect", id]); // x(["run", "-d"])\n';
    expect(changingArgvs(probe).filter((a) => CREATES.has(a.words.replace(/^container /, "").split(" ")[0]))
      .map((a) => a.words)).toEqual(["run -d", "create", "container run", "container create"]);
    // a docker call whose argv is a name is found; one whose argv is a literal array is not; a comment is not code
    const callProbe = codeOnly('deps.runDocker(["ps"]); dockerCall(deps, ["ps"]); deps.runDocker(argv, o); const run = deps.runDocker;\n' +
      'mutateContainer(inv, deps, ["stop", id]); mutateContainer(inv, deps, a); // dockerCall(deps, a)\n');
    expect([...callProbe.matchAll(DOCKER_CALL_NAMES)].map((m) => m[0]))
      .toEqual(["runDocker", "runDocker", "mutateContainer"]);
    const files = sourceFiles().filter((rel) => path.basename(rel).startsWith("preview"));
    const creating = files.flatMap((rel) => {
      const src = read(rel);
      return changingArgvs(src).filter((a) => CREATES.has(a.words.replace(/^container /, "").split(" ")[0]))
        .map((a) => `${rel}\t${lineAt(src, a.at)}`);
    });
    expect(creating.sort()).toEqual(CREATING_ARGV_SITES);
    // the forwarder's argv builder and the one creating call: every use in src/ is pinned
    expect(sourceFiles().flatMap((rel) => codeSites(rel, CREATING_FLOW_NAMES))).toEqual(CREATING_FLOW_SITES);
    // the preview container's argv: its every use in runPreviewContainer, the last one the one creating call's (runOwnContainer)
    const pv = codeOnly(read("preview.mjs"));
    const start = pv.indexOf("export function runPreviewContainer(");
    const body = pv.slice(start, pv.indexOf("\n}\n", start));
    expect(start).toBeGreaterThan(-1);
    expect([...body.matchAll(/\bargs\b/g)].map((m) => lineAt(body, m.index))).toEqual(PREVIEW_RUN_ARGS_USES);
    // no other docker call is handed an argv by name, save the pinned ones
    expect(files.flatMap((rel) => codeSites(rel, DOCKER_CALL_NAMES))).toEqual(NAMED_ARGV_CALLS);
  });
  it("no read is a completion barrier for a call that answered no success: no read clears an unknown run or a change of the row's own container", () => {
    const au = codeOnly(read(AUTHORITY));
    const start = au.indexOf("export function remainingLeftovers(");
    expect(start).toBeGreaterThan(-1);
    const body = au.slice(au.indexOf("\n", start) + 1, au.indexOf("\n}\n", start));
    expect(body.split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean)).toEqual(REMAINING_LEFTOVERS_BODY);
    expect(sourceFiles().flatMap((rel) => codeSites(rel, /\bisUnansweredCreate\b/g))).toEqual(UNANSWERED_CREATE_SITES);
    const files = sourceFiles().filter((rel) => path.basename(rel).startsWith("preview"));
    expect(files.flatMap((rel) => read(rel).split("\n").filter((l) => l.includes('"state-unsettled"'))
      .map((l) => `${rel}\t${l.trim().replace(/\s+/g, " ")}`))).toEqual(STATE_UNSETTLED_SITES);
    // docker's "No such container" answer is never read: it does not settle that a run did not, or will not, land
    expect(files.flatMap((rel) => read(rel).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /no\s+such\s+container/i.test(l)))).toEqual([]);
  });
  it("the default-keep rule: every ledger kind is in the census, the closed exception is exactly not-running and without-forwards, and each of its writers writes after an answered success", () => {
    const au = read(AUTHORITY);
    /** A frozen list constant of the authority module, read from its source. */
    const constant = (name) => {
      const m = new RegExp(`(?:export )?const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`).exec(au);
      expect(m, name).not.toBeNull();
      return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    };
    const leftoverKinds = constant("LEFTOVER_KINDS");
    const conditionKinds = constant("CONTAINER_CONDITIONS");
    // every kind the module names is in the census table, and every kind in the table is one the module names: an unknown kind fails
    expect([...leftoverKinds, ...conditionKinds].sort()).toEqual(Object.keys(LEDGER_KINDS).sort());
    // every kind a preview source writes is one of them: a `kind:` or `condition:` literal, or a noteCondition's literal kind
    const files = sourceFiles().filter((rel) => path.basename(rel).startsWith("preview"));
    const written = files.flatMap((rel) => stringLiterals(read(rel))
      .filter((l) => /\b(?:kind|condition)\s*:\s*$/.test(l.before) || /\bnoteCondition\(\s*\w+\s*,\s*[\w.]+\s*,\s*$/.test(l.before))
      .map((l) => l.value));
    expect(written.length).toBeGreaterThan(0);
    for (const kind of written) expect(Object.keys(LEDGER_KINDS), `a ledger kind written in src/: ${kind}`).toContain(kind);
    // every noteCondition call names its kind by a literal, so the census reads each one
    const calls = files.flatMap((rel) => [...codeOnly(read(rel)).matchAll(/\bnoteCondition\(/g)].map(() => rel));
    const literalCalls = files.flatMap((rel) => stringLiterals(read(rel))
      .filter((l) => /\bnoteCondition\(\s*\w+\s*,\s*[\w.]+\s*,\s*$/.test(l.before)).map(() => rel));
    expect(literalCalls).toEqual(calls.filter((rel) => rel !== AUTHORITY));
    // (a) the one closed exception: exactly the two kinds written from an answered read, frozen
    expect(constant("READ_CLEARED_CONDITIONS")).toEqual(EXCEPTION);
    expect(Object.keys(LEDGER_KINDS).filter((k) => LEDGER_KINDS[k].startsWith("the closed exception"))).toEqual(EXCEPTION);
    // the rule's every use, and every code line that reads a condition's kind: no per-kind logic beside the exception
    expect(sourceFiles().flatMap((rel) => codeSites(rel, /\b(?:READ_CLEARED_CONDITIONS|ownContainerEntries|namesContainer)\b/g)))
      .toEqual(DEFAULT_KEEP_SITES);
    expect(files.flatMap((rel) => codeSites(rel, /\.condition\b/g))).toEqual(CONDITION_READ_SITES);
    // (b) every writer of an exception kind: each source line that quotes one, past the two constants, is a pinned writer whose
    // code lines before it (comments dropped) are pinned from the answered success it is written after
    const codeLines = (rel) => read(rel).split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter((l) => l && !/^(\/\/|\*|\/\*)/.test(l));
    const quoting = sourceFiles().flatMap((rel) => codeLines(rel).map((l, i) => ({ rel, l, i }))
      .filter(({ l }) => EXCEPTION.some((k) => l.includes(`"${k}"`)))
      .filter(({ l }) => !/^export const (?:CONTAINER_CONDITIONS|READ_CLEARED_CONDITIONS) = /.test(l)));
    expect(quoting.map(({ rel, l }) => `${rel}\t${l}`)).toEqual(EXCEPTION_WRITERS.map(([rel, w]) => `${rel}\t${w.at(-1)}`));
    for (const { rel, i } of quoting) {
      const lines = codeLines(rel);
      const pinned = EXCEPTION_WRITERS.find(([r, w]) => r === rel && w.at(-1) === lines[i])[1];
      expect(lines.slice(i - pinned.length + 1, i + 1)).toEqual(pinned);
    }
  });

  it("F3-a: a division after an object literal is no regex: the removal literals after it are read", () => {
    const values = stringLiterals('const ignored = {} / 1; deps.runDocker(["rm", "-f", id]);').map((l) => l.value);
    expect(values).toContain("rm");
    expect(values).toContain("-f");
  });

  it("F3-b: a division after a postfix increment is no regex: the removal literals after it are read", () => {
    const values = stringLiterals('let n = 0; n++ / 1; deps.runDocker(["rm", "-f", id]);').map((l) => l.value);
    expect(values).toContain("rm");
    expect(values).toContain("-f");
  });

  it("F3-c: a slash with no closing slash before the line end is no regex: the literal after it is read", () => {
    // the slash follows `(`, which admits a regex, so the scan runs and meets no closing slash on its line
    const src = 'const half = ( / 2); const label = "rm";';
    expect(stringLiterals(src).map((l) => l.value)).toContain("rm");
    expect(codeOnly(src)).toContain("const label");
  });

  it("F3-d: ambiguousSlashes names the line of every slash after an object literal or a postfix increment", () => {
    const src = [
      'const ignored = {} / 1; deps.runDocker(["rm", "-f", id]);',
      'let n = 0; n++ / 1; deps.runDocker(["rm", "-f", id]);',
      'const half = {} / 2; const label = "rm";',
    ].join("\n");
    // read by name, so a lexer without the helper fails this assertion, never the file
    expect(typeof ambiguousSlashes === "function" ? ambiguousSlashes(src) : null).toEqual([1, 2, 3]);
  });

  it("F3-e: a real regex still reads as a regex (the control)", () => {
    const values = stringLiterals('const hit = /rm/.test(s); const word = "x";').map((l) => l.value);
    expect(values).toContain("x");
    expect(values).not.toContain("rm");
  });

  it("F3-f: no source file under src/ holds an ambiguous slash", () => {
    expect(authorityLiterals()).toContain("rm");
    const sites = sourceFiles().flatMap((rel) =>
      (typeof ambiguousSlashes === "function" ? ambiguousSlashes(read(rel)) : ["unread"]).map((line) => `${rel}:${line}`));
    expect(sites).toEqual([]);
  });

  it("F3-g: a backslash before a line end does not carry a would-be regex onto the next line: the literal there is read", () => {
    // the slash follows `=`; a backslash stands before the newline, and the next line holds a literal and a division
    const src = 'const r = / a \\\nconst label = "rm"; const half = n / 2;';
    expect(stringLiterals(src).map((l) => l.value)).toContain("rm");
    expect(codeOnly(src)).toContain("const label");
  });

  it("F3-h: a division after a postfix decrement is no regex: the removal literals after it are read, and its line is recorded", () => {
    const src = 'let n = 2; n-- / 1; deps.runDocker(["rm", "-f", id]);';
    const values = stringLiterals(src).map((l) => l.value);
    expect(values).toContain("rm");
    expect(values).toContain("-f");
    expect(typeof ambiguousSlashes === "function" ? ambiguousSlashes(src) : null).toEqual([1]);
  });

  it("F3-i: a division after a property named like a keyword is no regex: the removal literals after it are read, and no line is recorded", () => {
    const src = [
      'const a = obj.of / (deps.runDocker(["rm", "-f", id]), 2) / 1;',
      'const b = obj?.in / (["rmi"], 2) / 1;',
      'const c = obj. return / (["prune"], 2) / 1;',
      'const d = this.#await / (["down"], 2) / 1;',
    ].join("\n");
    const values = stringLiterals(src).map((l) => l.value);
    for (const v of ["rm", "-f", "rmi", "prune", "down"]) expect(values).toContain(v);
    expect(typeof ambiguousSlashes === "function" ? ambiguousSlashes(src) : null).toEqual([]);
  });

  it("F3-j: a slash after a bare `of` (a name outside a for-of head) is read as division, and its line is recorded", () => {
    const src = 'const of = 4;\nconst q = of / (deps.runDocker(["rm", "-f", id]), 2) / 1;';
    const values = stringLiterals(src).map((l) => l.value);
    expect(values).toContain("rm");
    expect(values).toContain("-f");
    expect(typeof ambiguousSlashes === "function" ? ambiguousSlashes(src) : null).toEqual([2]);
  });

  it("F3-k: a keyword that is no property still opens a regex, after a spread too (the control)", () => {
    const src = [
      'function f(s) { return /"rm"/.test(s); }',
      'const t = typeof /"rmi"/;',
      'const parts = [...await /"prune"/.exec(s)];',
    ].join("\n");
    const values = stringLiterals(src).map((l) => l.value);
    for (const v of ["rm", "rmi", "prune"]) expect(values).not.toContain(v);
    expect(typeof ambiguousSlashes === "function" ? ambiguousSlashes(src) : []).toEqual([]);
  });
});
