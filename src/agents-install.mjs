// packages/cli/src/agents-install.mjs
//
// `cinatra agents install` — resolve an agent dependency graph against Verdaccio,
// write `cinatra-agents.lock`, and perform per-package install side-effects.
//
// Fully self-contained plain-Node.js implementation.
// Uses pacote for registry resolution (semver handled internally by pacote/npm-pick-manifest).
// Uses pg directly for DB writes — no Drizzle/server-only chain required.
//
// Exit codes:
//   0 success | 1 usage error | 2 resolver error | 3 integrity error | 4 config missing

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";

// The connector catalog (`@cinatra-ai/connectors-catalog`) is NOT bundled into
// the published thin CLI — it is resolved from the operator's cinatra checkout
// at COMMAND ENTRY via ./checkout-resolve.mjs and threaded into the resolver as
// `knownConnectorPackageIds`. This is why `KNOWN_CONNECTOR_PACKAGE_IDS` is no
// longer a module-scope constant (codex must-fix #4): the module-scope set used
// to feed the validator at resolve time, which would require the catalog at
// import time and re-couple the CLI to the workspace.
import { importFromCheckout } from "./checkout-resolve.mjs";

const USAGE = `Usage: cinatra agents install [<name>[@<range>]] [options]
Options:
  --manifest <path>       Read root name+range from a manifest file (package.json shape)
  --lockfile <path>       Lockfile path (default: ./cinatra-agents.lock)
  --lockfile-only         Write lockfile but skip install side-effects
  --dry-run               Print resolved tree and exit; write nothing
  --registry-url <url>    Verdaccio registry URL (default: env CINATRA_AGENT_REGISTRY_URL)
  --registry-token <tok>  Verdaccio token (default: env CINATRA_AGENT_REGISTRY_TOKEN)

Exit codes:
  0 success | 1 usage error | 2 resolver error | 3 integrity error | 4 config missing
`;

// Lockfile v2 adds `resolvedConnectors` per node (concrete versions for
// `cinatra.connectorDependencies` ranges) and a top-level
// `connectorPackageIds` aggregate. v1 lockfiles are NOT
// schema-compatible: any cache hit on a v1 lockfile forces a full
// re-resolution so the v2 fields land.
const LOCKFILE_VERSION = 2;
// `connectorDependencies` entries are validated against the CLI-safe connector
// catalog (the same descriptors the host registry consumes) instead of a
// hand-maintained copy of the package-id list — the copy had already drifted
// from the catalog, and a literal list re-pins extension instance names in
// core (instance-coupling gate). The catalog is loaded lazily from the
// CHECKOUT (see `loadKnownConnectorPackageIds`) so the thin CLI carries no
// `@cinatra-ai/*` dependency.
async function loadKnownConnectorPackageIds(repoRoot) {
  const mod = await importFromCheckout(
    repoRoot,
    "@cinatra-ai/connectors-catalog/descriptors.mjs",
  );
  const descriptors = mod.CONNECTOR_DESCRIPTORS;
  if (!Array.isArray(descriptors)) {
    throw new Error(
      "agents install: @cinatra-ai/connectors-catalog/descriptors.mjs did not export CONNECTOR_DESCRIPTORS[].",
    );
  }
  return new Set(descriptors.map((d) => d.packageId));
}
// Any well-formed scoped npm name is accepted in agentDependencies, matching
// Verdaccio's '@cinatra/*-agent' block.
const SCOPED_NAME_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/i;
const DEFAULT_REGISTRY_URL = "http://127.0.0.1:4873";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function redactToken(str, token) {
  if (!token) return String(str);
  return String(str).split(token).join("***");
}

/**
 * Registry-scoped credential entry for pacote option objects.
 *
 * npm-registry-fetch (pacote's HTTP layer) resolves credentials ONLY from
 * nerf-dart-scoped '//<host>/<path>:_authToken' option keys (or forceAuth) —
 * a flat `token` option is silently ignored and produces requests with NO
 * Authorization header (#179). Plain-JS mirror of the canonical TS helper
 * `registryScopedAuthOptions` in @cinatra-ai/registries (this CLI script
 * cannot import the TS source). Returns {} when no token is configured.
 */
function registryScopedAuthOptions(registryUrl, token) {
  if (!token) return {};
  const parsed = new URL(registryUrl);
  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return { [`//${parsed.host}${pathname}:_authToken`]: token };
}

// ---------------------------------------------------------------------------
// Derive inputSchema from cinatra/oas.json when a tarball lacks the canonical
// compiled agent.json.
// ---------------------------------------------------------------------------

/** Safe JSON.parse — returns null on parse failure instead of throwing. */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Derive `inputSchema` from the top-level Flow's `StartNode` referenced
 * component in cinatra/oas.json. Returns null when the OAS shape doesn't
 * match expectations — caller falls back to {}.
 *
 * Expected OAS Flow shape:
 *   $referenced_components.<startKey> = {
 *     component_type: "StartNode",
 *     inputs: [{ title, type, format?, default? }, ...],
 *     metadata: { cinatra: { required: ["foo"], hidden: ["bar"] } }
 *   }
 *
 * Maps to JSON Schema:
 *   { type: "object", required: [...], properties: { foo: { type, format } } }
 */
function deriveInputSchemaFromOas(oas) {
  if (!oas || typeof oas !== "object") return null;
  if (oas.component_type !== "Flow") return null;

  // Locate the start node via $referenced_components[start_node.$component_ref].
  const startRef = oas.start_node?.["$component_ref"];
  const refs = oas["$referenced_components"];
  if (!startRef || !refs || typeof refs !== "object") return null;
  const startNode = refs[startRef];
  if (!startNode || startNode.component_type !== "StartNode") return null;

  const inputs = Array.isArray(startNode.inputs) ? startNode.inputs : [];
  const required = Array.isArray(startNode.metadata?.cinatra?.required)
    ? startNode.metadata.cinatra.required.filter((s) => typeof s === "string")
    : [];

  const properties = {};
  for (const input of inputs) {
    if (!input || typeof input.title !== "string") continue;
    const prop = { type: typeof input.type === "string" ? input.type : "string" };
    if (typeof input.format === "string") prop.format = input.format;
    if (typeof input.description === "string") prop.description = input.description;
    properties[input.title] = prop;
  }

  return { type: "object", required, properties };
}

/**
 * Pick the best inputSchema source:
 *   1. agent.template.inputSchema (canonical — `publishAgentPackageFromGitDir`
 *      compiles + writes it via `compileOasAgentJson`).
 *   2. Derived from cinatra/oas.json StartNode metadata (defense-in-depth for
 *      tarballs that lack agent.json.
 *   3. Empty {} as last resort.
 *
 * The "non-empty" detection treats `agent.template.inputSchema` as missing
 * when both `required` and `properties` are empty/absent — same effective
 * gap as having no schema at all.
 */
function pickInputSchema(agent, oas) {
  const compiled = agent?.template?.inputSchema;
  const compiledHasContent =
    compiled &&
    typeof compiled === "object" &&
    ((Array.isArray(compiled.required) && compiled.required.length > 0) ||
      (compiled.properties && Object.keys(compiled.properties).length > 0));
  if (compiledHasContent) return compiled;

  const derived = deriveInputSchemaFromOas(oas);
  if (derived) return derived;

  return compiled && typeof compiled === "object" ? compiled : {};
}

function parseArgv(argv) {
  const flags = { lockfileOnly: false, dryRun: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lockfile-only") flags.lockfileOnly = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--manifest") flags.manifest = argv[++i];
    else if (a === "--lockfile") flags.lockfile = argv[++i];
    else if (a === "--registry-url") flags.registryUrl = argv[++i];
    else if (a === "--registry-token") flags.registryToken = argv[++i];
    else if (a.startsWith("--")) {
      flags.__error = `Unknown flag: ${a}`;
      break;
    } else {
      rest.push(a);
    }
  }
  if (rest.length > 0) flags.rootSpec = rest[0];
  return flags;
}

function parseSpec(spec) {
  if (!spec || typeof spec !== "string") {
    throw new Error(`Invalid package spec: must be a non-empty string`);
  }
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, range: "*" };
  const name = spec.slice(0, at);
  const range = spec.slice(at + 1);
  if (!name) throw new Error(`Invalid package spec: empty name in "${spec}"`);
  if (!range) throw new Error(`Invalid package spec: empty version range after "@" in "${spec}"`);
  return { name, range };
}

// ---------------------------------------------------------------------------
// Verdaccio config (env-only, no DB — safe for plain Node.js)
// ---------------------------------------------------------------------------

function loadVerdaccioConfig(overrides = {}) {
  const registryUrl = (
    overrides.registryUrl ??
    process.env.CINATRA_AGENT_REGISTRY_URL ??
    process.env.VERDACCIO_REGISTRY_URL ??
    DEFAULT_REGISTRY_URL
  ).replace(/\/+$/, "");
  const token = (
    overrides.token ??
    process.env.CINATRA_AGENT_REGISTRY_TOKEN ??
    process.env.VERDACCIO_TOKEN ??
    null
  );
  return { registryUrl, token };
}

// ---------------------------------------------------------------------------
// Dependency resolver using pacote
// ---------------------------------------------------------------------------

/**
 * Resolve a full agent dependency tree using pacote.manifest for each node.
 * pacote handles semver range resolution internally via npm-pick-manifest.
 * Returns { root: ResolvedNode, all: Map<name, ResolvedNode> }.
 *
 * `knownConnectorPackageIds` is the checkout-resolved connector catalog id set
 * (injected by the caller) — previously a module-scope constant; now passed in
 * so the thin CLI does not import `@cinatra-ai/connectors-catalog` at load time.
 */
async function resolveAgentDependencyTree({ rootPackageName, rootRange, registryUrl, token, knownConnectorPackageIds }) {
  const pacoteOpts = {
    registry: registryUrl + "/",
    preferOnline: true,
    fullMetadata: true,
    // Scoped key, NEVER a flat `token` — npm-registry-fetch ignores that (#179).
    ...registryScopedAuthOptions(registryUrl, token),
  };

  const { default: pacote } = await import("pacote");

  const resolved = new Map();
  const queue = [{ name: rootPackageName, range: rootRange, path: [], depth: 0 }];
  const MAX_NODES = 500;
  const MAX_DEPTH = 20;

  while (queue.length > 0) {
    const entry = queue.shift();
    const { name, range, path, depth } = entry;

    if (!SCOPED_NAME_PATTERN.test(name)) {
      throw Object.assign(
        new Error(`agentDependencies entries must be valid scoped npm names; received: ${name}`),
        { code: "ESCOPE" }
      );
    }

    if (path.includes(name)) {
      throw Object.assign(
        new Error(`Dependency cycle detected: ${[...path, name].join(" -> ")}`),
        { code: "ECYCLE", cyclePath: [...path, name] }
      );
    }

    if (depth > MAX_DEPTH) {
      throw Object.assign(
        new Error(`Dependency resolver exceeded depth limit of ${MAX_DEPTH}`),
        { code: "ELIMIT" }
      );
    }

    if (resolved.has(name)) {
      // Already resolved — verify the already-pinned version satisfies the incoming range.
      const existing = resolved.get(name);
      const { default: semver } = await import("semver");
      if (!semver.satisfies(existing.resolvedVersion, range)) {
        throw Object.assign(
          new Error(
            `Incompatible versions required for ${name}: already pinned at ${existing.resolvedVersion}, range ${range} not satisfied`
          ),
          { code: "ECONFLICT", packageName: name }
        );
      }
      continue;
    }

    if (resolved.size >= MAX_NODES) {
      throw Object.assign(
        new Error(`Dependency resolver exceeded nodes limit of ${MAX_NODES}`),
        { code: "ELIMIT" }
      );
    }

    let m;
    try {
      m = await pacote.manifest(`${name}@${range}`, pacoteOpts);
    } catch (err) {
      const code = err?.code ?? "";
      if (code === "E404" || code === "ETARGET") {
        throw Object.assign(
          new Error(`No version satisfying ${name}@${range}`),
          { code: "ENORESOLUTION", packageName: name, range }
        );
      }
      throw err;
    }

    const childDeps = m.cinatra?.agentDependencies ?? {};
    // connectorDependencies are declarative-only: validated here against the
    // known connector catalog but NEVER enqueued for tree walking. Connectors
    // are workspace-compiled and never runtime-installed from npm. Unknown
    // package ids fail fast.
    const childConnectorDeps = m.cinatra?.connectorDependencies ?? {};
    for (const connectorId of Object.keys(childConnectorDeps)) {
      if (!knownConnectorPackageIds.has(connectorId)) {
        throw Object.assign(
          new Error(
            `${name} declares connectorDependencies entry ${connectorId} which is not in the connector catalog`,
          ),
          { code: "EUNKNOWNCONNECTOR", packageName: name, connectorId },
        );
      }
    }

    resolved.set(name, {
      packageName: name,
      resolvedVersion: m.version,
      tarballUrl: m.dist?.tarball ?? "",
      integrity: m.dist?.integrity ?? "",
      requestedRange: range,
      dependencies: { ...childDeps },
      connectorDependencies: { ...childConnectorDeps },
    });

    const nextPath = [...path, name];
    for (const [depName, depRange] of Object.entries(childDeps)) {
      queue.push({ name: depName, range: depRange, path: nextPath, depth: depth + 1 });
    }
  }

  const root = resolved.get(rootPackageName);
  if (!root) {
    throw Object.assign(
      new Error(`Root package ${rootPackageName} was not resolved`),
      { code: "ENORESOLUTION" }
    );
  }

  return { root, all: resolved };
}

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

function lockfileFromTree(tree) {
  const packages = {};
  const connectorPackageIds = new Set();
  for (const [name, node] of tree.all) {
    const entry = {
      version: node.resolvedVersion,
      resolved: node.tarballUrl,
      integrity: node.integrity,
    };
    if (node.dependencies && Object.keys(node.dependencies).length > 0) {
      entry.dependencies = { ...node.dependencies };
    }
    if (
      node.connectorDependencies &&
      Object.keys(node.connectorDependencies).length > 0
    ) {
      entry.connectorDependencies = { ...node.connectorDependencies };
      for (const id of Object.keys(node.connectorDependencies)) {
        connectorPackageIds.add(id);
      }
    }
    packages[name] = entry;
  }
  return {
    lockfileVersion: LOCKFILE_VERSION,
    root: { packageName: tree.root.packageName, version: tree.root.resolvedVersion },
    packages,
    // Set of all connector packageIds the resolved tree touches, deduplicated
    // for quick preflight readiness scans.
    connectorPackageIds: [...connectorPackageIds].sort(),
  };
}

function stableStringifyLockfile(lockfile) {
  // Stable JSON: sort keys in packages object for byte-deterministic output.
  const sortedPackages = {};
  for (const key of Object.keys(lockfile.packages).sort()) {
    sortedPackages[key] = lockfile.packages[key];
  }
  return JSON.stringify({ ...lockfile, packages: sortedPackages }, null, 2) + "\n";
}

async function readLockfile(lockfilePath) {
  try {
    const raw = await readFile(lockfilePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLockfile(lockfilePath, lockfile) {
  await writeFile(lockfilePath, stableStringifyLockfile(lockfile), "utf8");
}

/**
 * Summarize a parsed lockfile's `packages` map into a deterministic,
 * alphabetically-sorted list of installed agent packages — the read model
 * behind `cinatra agents list`. The root package is flagged so the printer can
 * distinguish the requested agent from its resolved dependencies.
 *
 * Pure (no I/O): exported via `__test` and consumed by the CLI `agents list`
 * handler, which owns reading the lockfile bytes off disk.
 *
 * @param {object|null} lockfile A parsed `cinatra-agents.lock` (or null/garbage).
 * @returns {{ packageName: string, version: string, root: boolean }[]}
 */
function summarizeLockfilePackages(lockfile) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object") return [];
  const rootName = lockfile?.root?.packageName;
  return Object.keys(packages)
    .sort()
    .map((name) => ({
      packageName: name,
      version: packages[name]?.version ?? "",
      root: name === rootName,
    }));
}

function lockfileToTree(lockfile) {
  const all = new Map();
  for (const [name, entry] of Object.entries(lockfile.packages)) {
    all.set(name, {
      packageName: name,
      resolvedVersion: entry.version,
      tarballUrl: entry.resolved,
      integrity: entry.integrity,
      requestedRange: entry.version,
      dependencies: entry.dependencies ?? {},
      connectorDependencies: entry.connectorDependencies ?? {},
    });
  }
  const root = all.get(lockfile.root.packageName);
  return { root, all };
}

// ---------------------------------------------------------------------------
// Install tree traversal (leaf-first BFS)
// ---------------------------------------------------------------------------

async function installResolvedTree({ tree, install }) {
  // Build a dependency-ordered list: leaves first, root last.
  const visited = new Set();
  const ordered = [];

  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const node = tree.all.get(name);
    if (node) {
      for (const depName of Object.keys(node.dependencies)) {
        visit(depName);
      }
      ordered.push(node);
    }
  }

  visit(tree.root.packageName);
  for (const node of ordered) {
    await install(node);
  }
}

// ---------------------------------------------------------------------------
// Install single agent package — extract tarball + write to DB
// ---------------------------------------------------------------------------

/**
 * Extract a package from Verdaccio and upsert agent_template + agent_version rows.
 * Uses pg directly (no Drizzle) so it works in plain Node.js.
 */
async function installAgentFromPackage({ packageName, packageVersion, registryUrl, token }) {
  const { default: pacote } = await import("pacote");
  const { default: pg } = await import("pg");

  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL is required for the full install step. " +
      "Use --dry-run or --lockfile-only to skip DB writes."
    );
  }

  const pacoteOpts = {
    registry: registryUrl + "/",
    preferOnline: true,
    // Scoped key, NEVER a flat `token` — npm-registry-fetch ignores that (#179).
    ...registryScopedAuthOptions(registryUrl, token),
  };

  const spec = packageVersion ? `${packageName}@${packageVersion}` : packageName;
  const tempDir = await mkdtemp(tmpdir() + "/cinatra-agent-install-");

  try {
    await pacote.extract(spec, tempDir, pacoteOpts);

    const [pkgRaw, agentRaw, oasRaw] = await Promise.all([
      readFile(tempDir + "/package.json", "utf8"),
      readFile(tempDir + "/agent.json", "utf8").catch(() => null),
      // Defense-in-depth. When agent.json is missing from the tarball, we fall
      // back to deriving inputSchema directly from cinatra/oas.json. Without
      // this, `inputSchema = {}` prevents the setup-loop fallback from
      // surfacing required inputs.
      readFile(tempDir + "/cinatra/oas.json", "utf8").catch(() => null),
    ]);

    const pkg = JSON.parse(pkgRaw);
    const agent = agentRaw ? JSON.parse(agentRaw) : null;
    const oas = oasRaw ? safeJsonParse(oasRaw) : null;

    const cinatraMeta = pkg.cinatra ?? {};
    const agentDeps = cinatraMeta.agentDependencies ?? {};
    const agentType = cinatraMeta.type ?? "leaf";
    const executionMode = agent?.template?.executionMode ?? cinatraMeta.executionMode ?? "agentic";
    const templateName = agent?.title?.trim() || agent?.template?.name || pkg.name;
    const description = agent?.description ?? agent?.template?.description ?? null;
    const sourceNl = agent?.template?.sourceNl ?? "";
    const compiledPlan = agent?.template?.compiledPlan ?? [];
    // When agent.json supplies a non-empty inputSchema, use it. Otherwise
    // derive from cinatra/oas.json's StartNode metadata so setup-loop fallback
    // knows which inputs are required.
    const inputSchema = pickInputSchema(agent, oas);
    const outputSchema = agent?.template?.outputSchema ?? null;
    const approvalPolicy = agent?.template?.approvalPolicy ?? { steps: [] };
    const taskSpec = agent?.template?.taskSpec ?? null;
    const lgGraphCode = agent?.template?.lgGraphCode ?? null;
    const lgGraphId = agent?.template?.lgGraphId ?? null;
    const executionProvider = agent?.template?.executionProvider ?? cinatraMeta.executionProvider ?? "default";
    const snapshot = agent?.version?.snapshot ?? {};
    const sourceVersionId = agent?.version?.sourceVersionId ?? cinatraMeta.sourceVersionId ?? null;
    const sourceVersionNumber = agent?.version?.sourceVersionNumber ?? cinatraMeta.sourceVersionNumber ?? 1;

    const schema = process.env.SUPABASE_SCHEMA ?? "cinatra";
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();

    try {
      // Check for existing template by packageName
      const existingResult = await client.query(
        `SELECT id FROM ${schema}.agent_templates WHERE package_name = $1 LIMIT 1`,
        [packageName]
      );

      let templateId;
      const versionId = randomUUID();

      if (existingResult.rows.length > 0) {
        // Update existing template
        templateId = existingResult.rows[0].id;
        await client.query(
          `UPDATE ${schema}.agent_templates SET
            name = $2, description = $3, source_nl = $4, compiled_plan = $5,
            input_schema = $6, output_schema = $7, approval_policy = $8,
            type = $9, task_spec = $10,
            package_version = $11, agent_dependencies = $12,
            lg_graph_code = $13, lg_graph_id = $14, execution_provider = $15,
            updated_at = NOW()
          WHERE id = $1`,
          [
            templateId,
            templateName,
            description,
            sourceNl,
            JSON.stringify(compiledPlan),
            JSON.stringify(inputSchema),
            outputSchema ? JSON.stringify(outputSchema) : null,
            JSON.stringify(approvalPolicy),
            agentType,
            taskSpec,
            pkg.version,
            Object.keys(agentDeps).length > 0 ? JSON.stringify(agentDeps) : null,
            lgGraphCode,
            lgGraphId,
            executionProvider,
          ]
        );
      } else {
        // Insert new template
        templateId = randomUUID();
        await client.query(
          `INSERT INTO ${schema}.agent_templates (
            id, name, description, source_nl, compiled_plan, input_schema,
            output_schema, approval_policy, type, task_spec,
            package_name, package_version, agent_dependencies,
            lg_graph_code, lg_graph_id, execution_provider,
            hitl_required, status, created_at, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
            false, 'draft', NOW(), NOW()
          )`,
          [
            templateId,
            templateName,
            description,
            sourceNl,
            JSON.stringify(compiledPlan),
            JSON.stringify(inputSchema),
            outputSchema ? JSON.stringify(outputSchema) : null,
            JSON.stringify(approvalPolicy),
            agentType,
            taskSpec,
            packageName,
            pkg.version,
            Object.keys(agentDeps).length > 0 ? JSON.stringify(agentDeps) : null,
            lgGraphCode,
            lgGraphId,
            executionProvider,
          ]
        );
      }

      // Insert version row
      const contentHash = createHash("sha256")
        .update(JSON.stringify(snapshot))
        .digest("hex");

      // Determine next version number
      const versionNumResult = await client.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_num
         FROM ${schema}.agent_versions WHERE template_id = $1`,
        [templateId]
      );
      const versionNumber = versionNumResult.rows[0].next_num;

      await client.query(
        `INSERT INTO ${schema}.agent_versions (
          id, template_id, version_number, content_hash, snapshot, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [versionId, templateId, versionNumber, contentHash, JSON.stringify(snapshot)]
      );

      return { templateId, versionId, packageName, packageVersion: pkg.version, agentDependencies: agentDeps };
    } finally {
      await client.end();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function runAgentsInstall(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((c) => process.exit(c));
  // The CLI dispatch passes `io.repoRoot` (the cinatra checkout) so the
  // connector catalog can be resolved from the checkout. It is only consulted
  // when a fresh tree resolution runs (not on usage-error early exits nor on a
  // lockfile fast-path hit), so tests that drive only those paths need not set
  // it.
  const repoRoot = io.repoRoot;

  const flags = parseArgv(argv);
  if (flags.__error) {
    stderr.write(flags.__error + "\n" + USAGE);
    return exit(1);
  }
  if (!flags.rootSpec && !flags.manifest) {
    stderr.write(USAGE);
    return exit(1);
  }

  let rootName;
  let rootRange;
  try {
    if (flags.rootSpec) {
      ({ name: rootName, range: rootRange } = parseSpec(flags.rootSpec));
    } else {
      const manifestRaw = await readFile(resolvePath(flags.manifest), "utf8");
      const manifest = JSON.parse(manifestRaw);
      rootName = manifest.name;
      rootRange = manifest.version ?? "*";
    }
  } catch (err) {
    stderr.write(`Usage error: ${err.message}\n${USAGE}`);
    return exit(1);
  }

  // Verdaccio config precedence: flags → env → defaults
  const cfg = loadVerdaccioConfig({
    registryUrl: flags.registryUrl,
    token: flags.registryToken,
  });
  const effectiveRegistry = cfg.registryUrl;
  const effectiveToken = cfg.token;

  const lockfilePath = resolvePath(flags.lockfile ?? "./cinatra-agents.lock");

  // Lockfile fast-path: reuse only when lockfile pins the requested root at a version
  // that satisfies the requested range AND the lockfile version matches the current
  // LOCKFILE_VERSION. Otherwise re-resolve to pick up upgrades or v1→v2 schema fills.
  const existingLockfile = await readLockfile(lockfilePath);
  const { default: semver } = await import("semver");
  let tree;
  if (
    existingLockfile &&
    existingLockfile.lockfileVersion === LOCKFILE_VERSION &&
    existingLockfile.root.packageName === rootName &&
    semver.satisfies(existingLockfile.root.version, rootRange)
  ) {
    tree = lockfileToTree(existingLockfile);
  } else {
    // Resolve the connector catalog from the checkout ONLY when a fresh tree
    // resolution is actually needed (the validator consults it per node).
    let knownConnectorPackageIds;
    try {
      if (!repoRoot) {
        throw new Error(
          "agents install: no cinatra checkout root available to resolve the connector catalog " +
            "(@cinatra-ai/connectors-catalog). Run from inside a cinatra checkout.",
        );
      }
      knownConnectorPackageIds = await loadKnownConnectorPackageIds(repoRoot);
    } catch (err) {
      stderr.write(`Config error: ${err?.message ?? String(err)}\n`);
      return exit(4);
    }
    try {
      tree = await resolveAgentDependencyTree({
        rootPackageName: rootName,
        rootRange: rootRange,
        registryUrl: effectiveRegistry,
        token: effectiveToken,
        knownConnectorPackageIds,
      });
    } catch (err) {
      const msg = redactToken(err?.message ?? String(err), effectiveToken);
      stderr.write(`Resolver error: ${msg}\n`);
      if (err?.cyclePath) stderr.write(`Cycle: ${err.cyclePath.join(" -> ")}\n`);
      return exit(2);
    }
  }

  if (flags.dryRun) {
    stdout.write(
      JSON.stringify({ root: tree.root, nodes: [...tree.all.keys()] }, null, 2) + "\n"
    );
    return exit(0);
  }

  // Write lockfile
  const lockfile = lockfileFromTree(tree);
  await writeLockfile(lockfilePath, lockfile);

  if (flags.lockfileOnly) return exit(0);

  // Install side-effects — upsert agent_templates + agent_versions rows in DB
  const install = async (node) => {
    await installAgentFromPackage({
      packageName: node.packageName,
      packageVersion: node.resolvedVersion,
      registryUrl: effectiveRegistry,
      token: effectiveToken,
    });
  };

  try {
    await installResolvedTree({ tree, install });
  } catch (err) {
    const msg = redactToken(err?.message ?? String(err), effectiveToken);
    stderr.write(`Install error: ${msg}\n`);
    if (err?.code === "EINTEGRITY") {
      stderr.write(`Integrity mismatch: tarball sha512 does not match lockfile\n`);
      return exit(3);
    }
    return exit(1);
  }

  stdout.write(`Installed ${tree.all.size} agents from ${rootName}@${rootRange}\n`);
  return exit(0);
}

// ---------------------------------------------------------------------------
// `cinatra agents list` — read the lockfile and print installed agents.
// ---------------------------------------------------------------------------

const LIST_USAGE = `Usage: cinatra agents list [options]
Options:
  --lockfile <path>   Lockfile path (default: ./cinatra-agents.lock)
  --json              Emit the installed set as JSON instead of a table
`;

/**
 * Consume the value that follows a value-taking flag (e.g. `--lockfile`).
 * Rejects a missing value OR a value that is itself a `--flag`, so
 * `agents uninstall @a --lockfile --keep-db` can never silently swallow
 * `--keep-db` as the path and leave the destructive `--keep-db` un-set. Mirrors
 * the `Missing value for <flag>` guard in index.mjs's readOptionValue.
 *
 * @throws {Error} when no usable value follows the flag.
 * @returns {{ value: string, nextIndex: number }}
 */
function takeFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return { value, nextIndex: index + 1 };
}

/**
 * `cinatra agents list` — read `cinatra-agents.lock` (the file `agents install`
 * writes) and print the installed agent packages. The lockfile is the source of
 * truth for "what was installed from Verdaccio"; this never touches the DB, so
 * it is safe to run without SUPABASE_DB_URL.
 */
export async function runAgentsList(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((c) => process.exit(c));

  let lockfilePathArg;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--lockfile") {
      try {
        const { value, nextIndex } = takeFlagValue(argv, i, "--lockfile");
        lockfilePathArg = value;
        i = nextIndex;
      } catch (err) {
        stderr.write(`${err.message}\n${LIST_USAGE}`);
        return exit(1);
      }
    } else if (a && a.startsWith("--")) {
      stderr.write(`Unknown flag: ${a}\n${LIST_USAGE}`);
      return exit(1);
    } else if (a) {
      stderr.write(`Unexpected argument: ${a}\n${LIST_USAGE}`);
      return exit(1);
    }
  }

  const lockfilePath = resolvePath(lockfilePathArg ?? "./cinatra-agents.lock");
  const lockfile = await readLockfile(lockfilePath);
  const rows = summarizeLockfilePackages(lockfile);

  if (asJson) {
    stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return exit(0);
  }

  if (rows.length === 0) {
    stdout.write(
      lockfile
        ? "No agents installed (lockfile has no packages).\n"
        : `No agents installed (no lockfile at ${lockfilePath}).\n`,
    );
    return exit(0);
  }

  const nameWidth = Math.max(...rows.map((r) => r.packageName.length), 7);
  stdout.write(`${"PACKAGE".padEnd(nameWidth)}  VERSION  ROLE\n`);
  for (const r of rows) {
    stdout.write(
      `${r.packageName.padEnd(nameWidth)}  ${(r.version || "-").padEnd(7)}  ${r.root ? "root" : "dependency"}\n`,
    );
  }
  return exit(0);
}

// ---------------------------------------------------------------------------
// `cinatra agents uninstall` — counterpart to `agents install`: drop the agent
// template (and its versions) from the DB and prune the lockfile entry.
// ---------------------------------------------------------------------------

const UNINSTALL_USAGE = `Usage: cinatra agents uninstall <name> [options]
Options:
  --lockfile <path>   Lockfile path (default: ./cinatra-agents.lock)
  --keep-db           Prune the lockfile entry only; leave DB rows in place
  --keep-lockfile     Delete DB rows only; leave the lockfile entry in place

Exit codes:
  0 success | 1 usage error
`;

/**
 * Remove a single package entry from a parsed lockfile, returning a NEW lockfile
 * object (the input is not mutated). The root entry is left untouched even when
 * a dependency is removed — pruning the requested root is fine, but a `root`
 * field that points at a now-absent package is still a faithful record of what
 * was requested. Pure: exported via `__test`.
 *
 * @returns {{ lockfile: object, removed: boolean }}
 */
function removeLockfilePackage(lockfile, packageName) {
  if (!lockfile?.packages || typeof lockfile.packages !== "object") {
    return { lockfile, removed: false };
  }
  if (!Object.prototype.hasOwnProperty.call(lockfile.packages, packageName)) {
    return { lockfile, removed: false };
  }
  const packages = { ...lockfile.packages };
  delete packages[packageName];
  return { lockfile: { ...lockfile, packages }, removed: true };
}

/**
 * Delete the agent template matching `packageName` (and its versions) from the
 * app DB. Uses pg directly — same connection contract as the install side
 * (SUPABASE_DB_URL + SUPABASE_SCHEMA). Versions are deleted explicitly first so
 * the uninstall does not depend on a DB-level ON DELETE CASCADE being present.
 * Returns the number of templates removed (0 when nothing matched).
 */
async function deleteAgentTemplateByPackage(packageName) {
  const { default: pg } = await import("pg");
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "SUPABASE_DB_URL is required to remove DB rows. " +
        "Use --keep-db to prune the lockfile entry only.",
    );
  }
  const schema = process.env.SUPABASE_SCHEMA ?? "cinatra";
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    // The two deletes run in one transaction: since we deliberately do NOT rely
    // on a DB-level ON DELETE CASCADE, a mid-sequence failure (lock timeout,
    // connection drop) must not leave a template row orphaned without its
    // versions. BEGIN/COMMIT make the pair atomic; any error rolls back.
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id FROM ${schema}.agent_templates WHERE package_name = $1`,
      [packageName],
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return 0;
    }
    const ids = found.rows.map((r) => r.id);
    await client.query(
      `DELETE FROM ${schema}.agent_versions WHERE template_id = ANY($1::uuid[])`,
      [ids],
    );
    const deleted = await client.query(
      `DELETE FROM ${schema}.agent_templates WHERE package_name = $1`,
      [packageName],
    );
    await client.query("COMMIT");
    return deleted.rowCount ?? ids.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * `cinatra agents uninstall <name>` — the inverse of `agents install`. By
 * default it removes the template's DB rows (matched on `package_name`) AND
 * prunes the lockfile entry. `--keep-db` / `--keep-lockfile` scope it to one
 * side. It removes ONLY the named package, never its dependency closure
 * (dependencies may be shared by other installed agents).
 */
export async function runAgentsUninstall(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((c) => process.exit(c));

  let lockfilePathArg;
  let keepDb = false;
  let keepLockfile = false;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep-db") keepDb = true;
    else if (a === "--keep-lockfile") keepLockfile = true;
    else if (a === "--lockfile") {
      // A value-taking flag: reject a missing value or a flag-like next token so
      // `uninstall @a --lockfile --keep-db` cannot swallow --keep-db as the path
      // and silently fall through to a DB delete it was meant to skip.
      try {
        const { value, nextIndex } = takeFlagValue(argv, i, "--lockfile");
        lockfilePathArg = value;
        i = nextIndex;
      } catch (err) {
        stderr.write(`${err.message}\n${UNINSTALL_USAGE}`);
        return exit(1);
      }
    } else if (a && a.startsWith("--")) {
      stderr.write(`Unknown flag: ${a}\n${UNINSTALL_USAGE}`);
      return exit(1);
    } else if (a) {
      positionals.push(a);
    }
  }

  const packageName = positionals[0];
  if (!packageName) {
    stderr.write(UNINSTALL_USAGE);
    return exit(1);
  }
  // A single `<name>` is the entire contract; extra positionals are almost
  // certainly a mistake (e.g. an unquoted glob) — refuse rather than silently
  // operate on only the first for a destructive command.
  if (positionals.length > 1) {
    stderr.write(
      `agents uninstall takes exactly one <name>; received: ${positionals.join(" ")}\n${UNINSTALL_USAGE}`,
    );
    return exit(1);
  }
  if (keepDb && keepLockfile) {
    stderr.write(`--keep-db and --keep-lockfile cannot be combined (nothing left to do).\n${UNINSTALL_USAGE}`);
    return exit(1);
  }

  const lockfilePath = resolvePath(lockfilePathArg ?? "./cinatra-agents.lock");

  let dbRemoved = 0;
  if (!keepDb) {
    try {
      dbRemoved = await deleteAgentTemplateByPackage(packageName);
    } catch (err) {
      stderr.write(`Uninstall error: ${err?.message ?? String(err)}\n`);
      return exit(1);
    }
  }

  let lockfileRemoved = false;
  if (!keepLockfile) {
    // Guard the lockfile read/write: if the DB rows were already removed and the
    // write fails (permissions, disk), report it AND surface that the DB side
    // already succeeded, so the operator knows the uninstall was partial.
    try {
      const existing = await readLockfile(lockfilePath);
      if (existing) {
        const { lockfile: pruned, removed } = removeLockfilePackage(existing, packageName);
        lockfileRemoved = removed;
        if (removed) await writeLockfile(lockfilePath, pruned);
      }
    } catch (err) {
      stderr.write(
        `Uninstall error pruning lockfile: ${err?.message ?? String(err)}` +
          (dbRemoved > 0 ? " (DB rows were already removed)" : "") +
          "\n",
      );
      return exit(1);
    }
  }

  // "Nothing removed" across every side we were asked to operate on → report
  // the package was not installed (still exit 0; uninstall is idempotent).
  const dbDidNothing = keepDb || dbRemoved === 0;
  const lockfileDidNothing = keepLockfile || !lockfileRemoved;
  if (dbDidNothing && lockfileDidNothing) {
    stdout.write(`agents uninstall: ${packageName} was not installed (nothing to remove).\n`);
    return exit(0);
  }

  const parts = [];
  if (!keepDb) parts.push(dbRemoved > 0 ? `removed ${dbRemoved} template row(s)` : "no matching DB rows");
  if (!keepLockfile) parts.push(lockfileRemoved ? "pruned lockfile entry" : "no lockfile entry");
  stdout.write(`Uninstalled ${packageName}: ${parts.join("; ")}.\n`);
  return exit(0);
}

export const __test = {
  parseArgv,
  parseSpec,
  redactToken,
  summarizeLockfilePackages,
  removeLockfilePackage,
  // Exported so the #179 regression (flat pacote `token` option, ignored by
  // npm-registry-fetch) stays pinned at the CLI layer too.
  registryScopedAuthOptions,
  lockfileToTree,
  lockfileFromTree,
  stableStringifyLockfile,
  // Exported for unit test coverage of the inputSchema derivation fallback.
  deriveInputSchemaFromOas,
  pickInputSchema,
  safeJsonParse,
};
