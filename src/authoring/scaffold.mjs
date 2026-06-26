// Scaffold orchestrator: resolve inputs → build the substitution vars → render
// the per-kind template tree → return a result. Pure of prompting/CLI concerns
// so tests can call it directly.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, copyFileSync, chmodSync } from "node:fs";

import { EXTENSION_KINDS, DEFAULT_SCOPE, SDK_EXTENSIONS_PIN, SDK_ABI_RANGE } from "./kinds.mjs";
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
// (Provenance: folded from cinatra-ai/create-cinatra-extension, where this same
// module sat at `src/` and resolved the root one level up — cinatra#402.)
const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");
export const TEMPLATES_ROOT = join(REPO_ROOT, "templates");

/** Kinds that ship the self-contained extension-kind-gate.mjs (agent, workflow). */
const KINDS_WITH_GATE = new Set(["agent", "workflow"]);

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
export function resolveInputs({ kind, name, scope, displayName, description, targetParent }) {
  const errors = [];
  if (!EXTENSION_KINDS.includes(kind)) {
    errors.push(`unknown kind "${kind}" — expected one of: ${EXTENSION_KINDS.join(", ")}`);
    return { ok: false, errors };
  }
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
  return { ok: true, errors: [], vars, kind, slug, scope: bareScope, packageName: pkgName, targetDir, base };
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

  // agent + workflow kinds ship the shared self-contained kind gate (verbatim,
  // not a template — it carries no placeholders).
  if (KINDS_WITH_GATE.has(kind)) {
    const gateSrc = join(TEMPLATES_ROOT, "_shared", "extension-kind-gate.mjs");
    const gateDest = join(targetDir, "extension-kind-gate.mjs");
    copyFileSync(gateSrc, gateDest);
    written.push("extension-kind-gate.mjs");
  }

  written.sort();
  return { targetDir, written, packageName: r.packageName, kind, slug: r.slug, vars };
}

export { EXTENSION_KINDS };
