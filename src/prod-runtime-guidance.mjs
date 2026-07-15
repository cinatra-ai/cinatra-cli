// Shared, side-effect-free copy for the production runtime lifecycle
// (cinatra-cli#146). Production runs the pinned published RELEASE IMAGE — never a
// host checkout / `pnpm dev` — per the ratified production-runtime contract
// (cinatra-ai/cinatra docs/internals/decisions/production-runtime-contract.md).
//
// One source of truth so the post-install completion hint (install.mjs) and the
// host dev-start refusal (index.mjs) print byte-identical guidance.

// The public Docker Hub image the release pipeline mirrors the GHCR build to.
// A bare repository name with a `VERSION` placeholder (uppercase, NOT `<version>`
// which the shell would read as a redirect if copied verbatim): the operator pins
// the concrete release tag or digest they are deploying (a git ref is not proof
// the corresponding published image exists).
export const PROD_IMAGE_REF = "cinatra/cinatra:VERSION";

// The ops-owned Compose deploy entry point (cinatra-ai/ops). It wires the
// platform services, env, mounted volumes, and persistence a bare `docker run`
// would not — so the guidance points here, never at a bare `docker run`.
export const PROD_DEPLOY_ENTRYPOINT = "deploy-instance.sh";

// The sanctioned local production-mode verification lane (cinatra-cli#149): builds
// and runs a preview image at a resolved SHA — non-production, but a real prod
// runtime for local checks.
export const PROD_PREVIEW_COMMAND = "cinatra instance preview create";

/**
 * The production run/deploy guidance, as an array of printable lines (no leading
 * or trailing blank line — the caller owns its surrounding framing). Both the
 * install completion hint and the `instance start` prod refusal render this, so
 * the two surfaces stay in lockstep.
 *
 * @param {{ indent?: string }} [opts]  string prepended to every line (default 4 spaces)
 * @returns {string[]}
 */
export function prodRuntimeGuidanceLines({ indent = "    " } = {}) {
  return [
    `${indent}Production runs the pinned published release image (production-runtime contract),`,
    `${indent}not a host checkout. To deploy this instance:`,
    `${indent}  1. Pull the pinned release image (replace VERSION with the release tag or digest):`,
    `${indent}       docker pull ${PROD_IMAGE_REF}`,
    `${indent}  2. Deploy it via the ops Compose lifecycle (platform services, env, volumes, persistence):`,
    `${indent}       ${PROD_DEPLOY_ENTRYPOINT}          # cinatra-ai/ops — never a bare \`docker run\``,
    `${indent}  For local production-mode verification, build + run a preview image at a resolved SHA:`,
    `${indent}       ${PROD_PREVIEW_COMMAND}`,
  ];
}
