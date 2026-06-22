import type { SemanticArtifactManifest } from "@cinatra-ai/sdk-extensions";

// {{packageName}} models a specific kind of content as a semantic artifact.
//
// The `cinatra.artifact` block in package.json is the host-read manifest; this
// typed export mirrors it so the shape is checked against the SDK contract.
// `@cinatra-ai/sdk-extensions` is an OPTIONAL peer — the host workspace provides
// it; it is never installed from a registry by this template.
//
// This stub accepts text/markdown files and classifies them with a single
// matcher skill. Extend `accepts` (file / connectorRef / dashboard), add
// `satisfies`, `templates`, or more `skills` as your artifact type needs.
export const {{camelBase}}ArtifactManifest: SemanticArtifactManifest = {
  accepts: {
    file: {
      mimeTypes: ["text/markdown"],
    },
  },
  skills: {
    matchers: ["{{packageName}}:{{base}}-matcher"],
  },
  matcherConfidenceThreshold: 0.7,
};
