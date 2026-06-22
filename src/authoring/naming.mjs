// Slug + scope normalization and validation.
//
// Enforces the same naming rules the marketplace naming gate applies:
//   - directory name == unscoped package name, kebab-case.
//   - the package name ends with the `-<kind>` suffix.
//   - the scope obeys the kind's KIND_SCOPE_POLICY.
//   - agent slugs reject orchestrator-topology tokens.
//
// Pure functions, no I/O.

import {
  FIRST_PARTY_SCOPE,
  KIND_SCOPE_POLICY,
  VENDORED_SKILL_SCOPE_ALLOWLIST,
  FORBIDDEN_TOPOLOGY_TOKENS,
} from "./kinds.mjs";

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_RE = /^@[a-z0-9][a-z0-9-]*$/;

/** Normalize an arbitrary `@scope/name` or `name` input into a bare scope (no `@`). */
export function normalizeScope(rawScope) {
  if (!rawScope) return null;
  return rawScope.startsWith("@") ? rawScope.slice(1) : rawScope;
}

/**
 * Given a user-supplied name and a kind, derive the unscoped slug that ends with
 * the `-<kind>` suffix. The caller may pass `my-thing` or `my-thing-agent`; both
 * normalize to `my-thing-agent` for kind=agent. Skills use the `-skills` suffix.
 */
export function deriveSlug(rawName, kind) {
  const suffix = kind === "skill" ? "-skills" : `-${kind}`;
  let slug = String(rawName || "").trim().toLowerCase();
  // strip a leading scope if the user pasted a full package name
  if (slug.startsWith("@")) {
    const slashIdx = slug.indexOf("/");
    slug = slashIdx >= 0 ? slug.slice(slashIdx + 1) : slug.slice(1);
  }
  // collapse spaces/underscores to hyphens
  slug = slug.replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (slug.length === 0) return slug;
  if (!slug.endsWith(suffix)) slug = `${slug}${suffix}`;
  return slug;
}

/** The bare role/base portion of a slug (suffix stripped). */
export function baseOf(slug, kind) {
  const suffix = kind === "skill" ? "-skills" : `-${kind}`;
  return slug.endsWith(suffix) ? slug.slice(0, -suffix.length) : slug;
}

/** Validate a derived slug for a kind. Returns string[] of errors ([] = valid). */
export function validateSlug(slug, kind) {
  const errors = [];
  const suffix = kind === "skill" ? "-skills" : `-${kind}`;
  if (!KEBAB_RE.test(slug)) {
    errors.push(`slug "${slug}" must be kebab-case (lowercase letters, digits, single hyphens)`);
  }
  if (!slug.endsWith(suffix)) {
    errors.push(`slug "${slug}" must end with "${suffix}" for kind "${kind}"`);
  }
  const base = baseOf(slug, kind);
  if (base.length === 0) {
    errors.push(`slug "${slug}" has no name before the "${suffix}" suffix`);
  }
  if (kind === "agent") {
    for (const re of FORBIDDEN_TOPOLOGY_TOKENS) {
      if (re.test(base)) {
        errors.push(
          `agent slug base "${base}" names orchestrator topology (matched ${re}); an agent names a capability, not a topology role`,
        );
        break;
      }
    }
  }
  return errors;
}

/** Validate a bare scope against a kind's scope policy. Returns string[] errors. */
export function validateScope(bareScope, kind) {
  const errors = [];
  const scoped = `@${bareScope}`;
  if (!SCOPE_RE.test(scoped)) {
    errors.push(`scope "@${bareScope}" must be a lowercase npm scope (e.g. @cinatra-ai)`);
    return errors;
  }
  const policy = KIND_SCOPE_POLICY[kind];
  if (policy === "first-party-only" && scoped !== FIRST_PARTY_SCOPE) {
    errors.push(`kind "${kind}" is first-party-only — scope must be ${FIRST_PARTY_SCOPE} (got ${scoped})`);
  } else if (
    policy === "first-party-plus-vendored" &&
    scoped !== FIRST_PARTY_SCOPE &&
    !VENDORED_SKILL_SCOPE_ALLOWLIST.has(scoped)
  ) {
    errors.push(
      `kind "${kind}" allows ${FIRST_PARTY_SCOPE} or a vendored scope (${[...VENDORED_SKILL_SCOPE_ALLOWLIST].join(", ")}); got ${scoped}`,
    );
  }
  // any-scope: no further restriction
  return errors;
}

/** The full scoped package name, e.g. @cinatra-ai/my-thing-agent. */
export function packageName(bareScope, slug) {
  return `@${bareScope}/${slug}`;
}
