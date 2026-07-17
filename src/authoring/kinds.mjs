// Kind catalog + naming/scope policy.
//
// Mirrors the public Cinatra extension contracts:
//   - EXTENSION_KINDS           — the four extension kinds.
//   - KIND_SCOPE_POLICY         — which npm scopes each kind may use.
//   - FORBIDDEN_TOPOLOGY_TOKENS — agent slugs may not name orchestrator topology.
//
// Kept as a single source of truth so the CLI validates a name exactly the way
// the marketplace naming gate will. No network, no @cinatra-ai dependency.

/** The four extension kinds. `cinatra.kind` is always one of these. */
export const EXTENSION_KINDS = ["agent", "connector", "artifact", "skill"];

/** The first-party npm scope. Most kinds are first-party-only. */
export const FIRST_PARTY_SCOPE = "@cinatra-ai";

/** Bare scope (no `@`) form used as the CLI default. */
export const DEFAULT_SCOPE = "cinatra-ai";

/**
 * Which npm scopes a kind may use:
 *   - first-party-only          → must be @cinatra-ai.
 *   - any-scope                 → any vendor scope is allowed (connectors).
 *   - first-party-plus-vendored → @cinatra-ai or a vendored allowlist (skills).
 */
export const KIND_SCOPE_POLICY = {
  agent: "first-party-only",
  connector: "any-scope",
  artifact: "first-party-only",
  skill: "first-party-plus-vendored",
};

/** Vendored scopes a `kind:"skill"` package may use. */
export const VENDORED_SKILL_SCOPE_ALLOWLIST = new Set(["@anthropics"]);

/**
 * Orchestrator-topology tokens forbidden in a `kind:"agent"` slug (applied
 * AFTER stripping the trailing `-agent` suffix). An agent names a capability,
 * never a place in an orchestration topology.
 */
export const FORBIDDEN_TOPOLOGY_TOKENS = [
  // exact-token (slug after -agent strip equals the token)
  /^pipeline$/,
  /^orchestrator$/,
  /^handler$/,
  /^child$/,
  /^stage-\d+$/,
  // suffix form
  /-pipeline$/,
  /-orchestrator$/,
  /-handler$/,
  /-child$/,
  /-stage-\d+$/,
  // prefix form
  /^pipeline-/,
  /^orchestrator-/,
  /^handler-/,
  /^child-/,
  /^stage-\d+-/,
];

/**
 * The npm version range generated templates pin `@cinatra-ai/sdk-extensions` to.
 * Declared as an OPTIONAL peerDependency (never a hard dep) so the dependency-
 * shape CI gate stays green and the host-clone path keeps resolving it from the
 * monorepo workspace. `0.1.1` is the first public SDK release line.
 */
export const SDK_EXTENSIONS_PIN = "^0.1.1";

/**
 * The host ABI range a SERVER-ENTRY extension declares in `cinatra.sdkAbiRange`.
 * This is the connector contract specifically: the host's runtime loader gates
 * dynamically-imported `cinatra.serverEntry` modules against this range, so only
 * a serverEntry-bearing kind (connector) declares it. Other code-bearing kinds
 * (e.g. an artifact that ships a typed `src/index.ts` mirror of its DATA
 * manifest) are NOT serverEntry-loaded and correctly OMIT it — matching every
 * first-party artifact in the host workspace. This is a DIFFERENT version axis
 * from the npm package version above: the host ABI is currently 2.x, so a
 * forward-compatible declaration is "^2".
 */
export const SDK_ABI_RANGE = "^2";

// ---------------------------------------------------------------------------
// Opt-in artifact `ui` template (cinatra#1627 AC3) — the values the `--with-ui`
// renderer template bakes into `cinatra.artifact.ui`. Centralized here (the one
// naming/version source) rather than scattered across template JSON.
// ---------------------------------------------------------------------------

/**
 * `cinatra.artifact.ui.abiVersion` — the versioned renderer-block ABI. Mirrors
 * `ARTIFACT_UI_ABI_VERSION` in packages/sdk-extensions/src/artifact-contract.ts.
 */
export const ARTIFACT_UI_ABI_VERSION = 1;

/**
 * `cinatra.artifact.ui.sdkAbiRange` — the GENERATED value
 * `^<SDK_EXTENSIONS_ABI_VERSION>` (see `generateArtifactUiSdkAbiRange()` in
 * packages/sdk-extensions/src/artifact-contract.ts). The publish conformance
 * gate asserts a manifest's range EQUALS this generated value, so it must move
 * in lock-step with the SDK ABI (currently 2.4.0 → "^2.4.0"). Bump here whenever
 * the SDK ABI bumps.
 */
export const ARTIFACT_UI_SDK_ABI_RANGE = "^2.4.0";

/**
 * `propsApiVersion` — the renderer-props contract version a v1 renderer stub
 * declares + imports. Mirrors `ARTIFACT_RENDERER_PROPS_API_VERSION` in the SDK
 * leaf packages/sdk-extensions/src/artifact-renderer-props.ts (the type the stub
 * imports from `@cinatra-ai/sdk-extensions/artifact-renderer-props`).
 */
export const ARTIFACT_RENDERER_PROPS_API_VERSION = 1;

/**
 * React toolchain delta for a renderer-shipping (`--with-ui`) artifact. React /
 * react-dom are host peers the renderer bundle leaves EXTERNAL (they resolve to
 * the host's single shared instances in the main realm), so they are declared as
 * OPTIONAL peers (never installed by the scaffolder) plus devDependencies for
 * local authoring/typecheck. Not @cinatra-ai, so the SDK-only first-party rule
 * does not apply.
 */
export const REACT_PEER_RANGE = "^19.0.0";
export const REACT_TYPES_RANGE = "^19";
