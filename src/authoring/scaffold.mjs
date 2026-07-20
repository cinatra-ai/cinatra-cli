// Scaffold orchestrator: resolve inputs → build the substitution vars → render
// the per-kind template tree → return a result. Pure of prompting/CLI concerns
// so tests can call it directly.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";

import {
  EXTENSION_KINDS,
  DEFAULT_SCOPE,
  SDK_EXTENSIONS_PIN,
  SDK_ABI_RANGE,
  ARTIFACT_UI_ABI_VERSION,
  ARTIFACT_UI_SDK_ABI_RANGE,
  ARTIFACT_RENDERER_PROPS_API_VERSION,
  REACT_PEER_RANGE,
  REACT_TYPES_RANGE,
} from "./kinds.mjs";
import {
  normalizeScope,
  deriveSlug,
  baseOf,
  validateSlug,
  validateScope,
  packageName,
} from "./naming.mjs";
import { renderTree, isNonEmptyDir } from "./template.mjs";

// This authoring core lives at `src/authoring/` inside the cinatra-cli repo;
// the scaffold templates ship at the repo root under `templates/`. So the repo
// root is TWO levels up from this module (src/authoring → src → <repo root>).
// This module sits at `src/authoring/` so the repo root is two levels up.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const TEMPLATES_ROOT = join(REPO_ROOT, "templates");

/** Kinds that ship the self-contained extension-kind-gate.mjs.
 *
 * ALL FOUR kinds ship it (cinatra-cli#72 / hot-install): the shared gate now
 * runs the COMMON cross-kind rules (manifest shape, host ports, sdkAbiRange,
 * @/ + SDK-only import bans, host-peer value-import ban, README/license,
 * serverEntry preflight, schema-config) PLUS the kind-specific gate — so every
 * scaffolded repo catches what the install pipeline rejects BEFORE publishing. */
const KINDS_WITH_GATE = new Set(EXTENSION_KINDS);

/** The ASSISTANT FLAVOR (cinatra#1874 W1) is a VARIANT of the `agent` kind: an
 *  assistant is an agent-kind extension whose package-root cinatra/config.json
 *  carries an `assistant` block (the host adopts it as a first-class chat
 *  assistant — its own handle/persona/skill bundle, launch + delivery topology,
 *  run surface on the host runtime). Only `agent` may take `--assistant`; the
 *  overlay tree (templates/_assistant, rendered ON TOP of the agent template)
 *  merges the well-formed cinatra/config.json into the agent's existing
 *  cinatra/ directory. The agent template already packages `cinatra`
 *  (package.json#files), so the declaration ships in the tarball. */
const ASSISTANT_FLAVOR_KIND = "agent";
const ASSISTANT_OVERLAY_DIR = "_assistant";

/** Titleize a slug base, e.g. "web-research" → "Web Research". */
export function titleize(base) {
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** camelCase identifier from a kebab base, e.g. "web-research" → "webResearch". */
export function camelCase(base) {
  const parts = base.split("-").filter(Boolean);
  return parts
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

/** PascalCase identifier from a kebab base, e.g. "web-research" → "WebResearch". */
export function pascalCase(base) {
  return base
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/**
 * Resolve and validate all inputs. Returns { ok, errors, vars, kind, slug,
 * scope, packageName, targetDir } — `vars` is the substitution map.
 */
export function resolveInputs({
  kind,
  name,
  scope,
  displayName,
  description,
  targetParent,
  withUi = false,
  withRegistryItems = false,
  assistant = false,
}) {
  const errors = [];
  if (!EXTENSION_KINDS.includes(kind)) {
    errors.push(`unknown kind "${kind}" — expected one of: ${EXTENSION_KINDS.join(", ")}`);
    return { ok: false, errors };
  }
  // The opt-in renderer/registry template is an artifact-kind-only surface.
  if ((withUi || withRegistryItems) && kind !== "artifact") {
    errors.push(
      `--with-ui / --with-registry-items apply only to kind "artifact" (a renderer/registry-item block lives in cinatra.artifact.ui); got kind "${kind}"`,
    );
  }
  if (withRegistryItems && !withUi) {
    errors.push("--with-registry-items requires --with-ui (registryItems is declared inside cinatra.artifact.ui)");
  }
  // The assistant flavor is a variant of the agent kind only (cinatra#1874 W1).
  if (assistant && kind !== ASSISTANT_FLAVOR_KIND) {
    errors.push(
      `--assistant is only valid for kind "${ASSISTANT_FLAVOR_KIND}" (an assistant is an agent-kind extension whose cinatra/config.json declares an \`assistant\` block); got kind "${kind}"`,
    );
  }
  if (errors.length) return { ok: false, errors, kind };
  const slug = deriveSlug(name, kind);
  if (!slug) errors.push("name is required");
  const bareScope = normalizeScope(scope) || DEFAULT_SCOPE;

  errors.push(...validateSlug(slug, kind));
  errors.push(...validateScope(bareScope, kind));
  if (errors.length) return { ok: false, errors, slug, scope: bareScope, kind };

  const base = baseOf(slug, kind);
  const pkgName = packageName(bareScope, slug);
  const dn = displayName && displayName.trim() ? displayName.trim() : titleize(base);
  // `displayName` is interpolated INSIDE double-quoted SKILL.md frontmatter
  // (`description: "...the {{displayName}}..."`). Reject characters that would
  // either break that quoting (`"`, `\`, a newline/CR) or be rejected by the
  // skills validator (`<`, `>`) — otherwise a generated SKILL.md could fail to
  // parse or fail validation. The default (titleized slug) never contains these.
  const badDisplayChars = [...new Set(dn.match(/["\\<>\r\n]/g) || [])];
  if (badDisplayChars.length) {
    errors.push(
      `displayName must not contain ${JSON.stringify(badDisplayChars.join(""))} ` +
        `(it is embedded in SKILL.md frontmatter and the skills validator rejects < and >)`,
    );
  }
  const desc =
    description && description.trim()
      ? description.trim()
      : `A Cinatra ${kind} extension: ${dn}.`;
  if (errors.length) return { ok: false, errors, slug, scope: bareScope, kind };

  // capability id used by skill templates: <base>.<base> namespaced, kebab→dot
  const capabilityId = `${base.replace(/-/g, ".")}.run`;

  // Per-source migration ledger namespace for connectors (host contract #118):
  // `@<scope>/<slug>` → `ext_<scope>_<slug>__`. Migration MODULE filenames carry
  // this exact prefix; the host derives the same string from the package name
  // and fences the shared `pgmigrations` ledger on it. `tableNs` is the same
  // identity flattened to underscores (raw SQL identifiers forbid `-`/`.`) — the
  // recommended table-name prefix so a connector's tables never collide in the
  // shared app schema. Both are derived for every kind but only the connector
  // template references them.
  const migrationNs = `ext_${bareScope}_${slug}__`;
  const tableNs = `ext_${bareScope}_${slug}`.replace(/-/g, "_");

  const vars = {
    kind,
    slug,
    base,
    camelBase: camelCase(base),
    pascalBase: pascalCase(base),
    scope: bareScope,
    packageName: pkgName,
    displayName: dn,
    description: desc,
    sdkPin: SDK_EXTENSIONS_PIN,
    sdkAbiRange: SDK_ABI_RANGE,
    capabilityId,
    migrationNs,
    tableNs,
    // a slug-derived id for OAS / BPMN process ids
    flowId: `${slug}-flow`,
    year: String(new Date().getUTCFullYear()),
  };

  const targetDir = join(targetParent || process.cwd(), slug);
  return {
    ok: true,
    errors: [],
    vars,
    kind,
    slug,
    scope: bareScope,
    packageName: pkgName,
    targetDir,
    base,
    withUi: Boolean(withUi),
    withRegistryItems: Boolean(withRegistryItems),
    assistant: Boolean(assistant),
  };
}

/**
 * Run the scaffold. Throws on a hard error (e.g. target exists). Returns
 * { targetDir, written, packageName, kind }.
 */
export function scaffold(opts) {
  const r = resolveInputs(opts);
  if (!r.ok) {
    const err = new Error(`invalid inputs:\n  - ${r.errors.join("\n  - ")}`);
    err.validation = r.errors;
    throw err;
  }
  const { vars, kind, targetDir } = r;
  if (!opts.force && isNonEmptyDir(targetDir)) {
    throw new Error(`target directory already exists and is not empty: ${targetDir}`);
  }
  const srcDir = join(TEMPLATES_ROOT, kind);
  if (!existsSync(srcDir)) throw new Error(`no template for kind "${kind}" at ${srcDir}`);

  const written = renderTree(srcDir, targetDir, vars);

  // Opt-in artifact `ui` template (cinatra#1627 AC3): overlay the RSC renderer
  // stub + vendored-primitives seed (+ registry-item seed) and patch the
  // rendered package.json / README with the `cinatra.artifact.ui` manifest,
  // exports subpath(s), and the React toolchain delta. Applied BEFORE the gate
  // copy so the gate lands last (it is not part of the ui overlay).
  if (r.withUi) {
    written.push(...applyArtifactUiOverlay(targetDir, vars, { withRegistryItems: r.withRegistryItems }));
  }

  // ASSISTANT FLAVOR (cinatra#1874 W1): overlay the assistant declaration onto
  // the agent scaffold — a package-root cinatra/config.json with a well-formed
  // `assistant` block the host's SINGLE shared assistant-declaration parser
  // accepts (fail-closed: unknown key / bad preferredTag / wrong abiVersion is
  // rejected at install). The agent template already packages "cinatra"
  // (package.json#files), so the config.json ships. Rendered AFTER the base tree
  // so it merges into the existing cinatra/ directory; BEFORE the gate copy so
  // the gate lands last. The install-time assistant⊕executor XOR is on the
  // `access` block (never scaffolded here), so shipping the agent oas.json
  // alongside the declaration is gate-clean at W1.
  if (r.assistant) {
    const overlaySrc = join(TEMPLATES_ROOT, ASSISTANT_OVERLAY_DIR);
    if (!existsSync(overlaySrc)) throw new Error(`no assistant overlay template at ${overlaySrc}`);
    written.push(...renderTree(overlaySrc, targetDir, vars));
  }

  // All kinds ship the shared self-contained kind gate (verbatim, not a
  // template — it carries no placeholders).
  if (KINDS_WITH_GATE.has(kind)) {
    const gateSrc = join(TEMPLATES_ROOT, "_shared", "extension-kind-gate.mjs");
    const gateDest = join(targetDir, "extension-kind-gate.mjs");
    copyFileSync(gateSrc, gateDest);
    written.push("extension-kind-gate.mjs");
  }

  // Deduplicate (the ui overlay may re-render a path already present) + sort.
  const uniqueWritten = [...new Set(written)].sort();
  return {
    targetDir,
    written: uniqueWritten,
    packageName: r.packageName,
    kind,
    slug: r.slug,
    vars,
    withUi: r.withUi,
    withRegistryItems: r.withRegistryItems,
    assistant: r.assistant,
  };
}

/**
 * Apply the opt-in artifact `ui` overlay onto an already-rendered artifact repo:
 * render the renderer stub + vendored-primitives seed (+ optional registry-item
 * seed), then patch the rendered package.json (the `cinatra.artifact.ui`
 * manifest, the `exports` subpath map, and the React toolchain delta) and the
 * README (a discoverability bullet). Returns the list of paths written/patched
 * (relative to targetDir). Kept pure of CLI concerns so tests call it directly.
 */
export function applyArtifactUiOverlay(targetDir, vars, { withRegistryItems = false } = {}) {
  const touched = [];

  // 1. Overlay the ui delta FILES (renderer stub + vendored-primitives seed).
  const uiOverlay = join(TEMPLATES_ROOT, "_artifact-ui");
  touched.push(...renderTree(uiOverlay, targetDir, vars));
  if (withRegistryItems) {
    const regOverlay = join(TEMPLATES_ROOT, "_artifact-registry");
    touched.push(...renderTree(regOverlay, targetDir, vars));
  }

  // 2. Patch the rendered package.json — the ui manifest, exports, toolchain.
  const pkgPath = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  // exports subpath(s) — a stable import for the renderer (and registry item).
  const exportsMap = { ".": "./src/index.ts", "./renderers/detail": "./src/renderers/detail.tsx" };
  if (withRegistryItems) exportsMap["./registry/sample-tile"] = "./src/registry/sample-tile.tsx";
  pkg.exports = exportsMap;

  // React toolchain delta — optional host peers (external at bundle time) + dev
  // deps for local authoring/typecheck. Never @cinatra-ai, so no first-party rule.
  pkg.peerDependencies = { ...(pkg.peerDependencies || {}), react: REACT_PEER_RANGE, "react-dom": REACT_PEER_RANGE };
  pkg.peerDependenciesMeta = {
    ...(pkg.peerDependenciesMeta || {}),
    react: { optional: true },
    "react-dom": { optional: true },
  };
  pkg.devDependencies = {
    ...(pkg.devDependencies || {}),
    react: REACT_PEER_RANGE,
    "react-dom": REACT_PEER_RANGE,
    "@types/react": REACT_TYPES_RANGE,
    "@types/react-dom": REACT_TYPES_RANGE,
  };

  // The versioned cinatra.artifact.ui block: a `detail`-slot renderer (+ optional
  // registryItems). The `entry` files are shipped by `files: ["src", …]`.
  const ui = {
    abiVersion: ARTIFACT_UI_ABI_VERSION,
    sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
    renderers: {
      detail: { entry: "./src/renderers/detail.tsx", propsApiVersion: ARTIFACT_RENDERER_PROPS_API_VERSION },
    },
  };
  if (withRegistryItems) {
    ui.registryItems = [
      {
        name: "sample-tile",
        entry: "./src/registry/sample-tile.tsx",
        type: "registry:ui",
        description: "A presentational sample tile — replace with your own primitive.",
      },
    ];
  }
  pkg.cinatra.artifact.ui = ui;

  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  touched.push("package.json");

  // 3. README discoverability bullet (stays under the gate-allowed "## Capabilities"
  // H2 — the last section — so the one-H1 / allowed-H2 README contract holds).
  const readmePath = join(targetDir, "README.md");
  let readme = readFileSync(readmePath, "utf8");
  if (!readme.endsWith("\n")) readme += "\n";
  readme +=
    "- Renders its own detail view (an RSC renderer under `src/renderers/`, wired via `cinatra.artifact.ui`)\n";
  writeFileSync(readmePath, readme);
  touched.push("README.md");

  return touched;
}

export { EXTENSION_KINDS };
