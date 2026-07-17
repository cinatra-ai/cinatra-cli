// Detail renderer for {{displayName}} artifacts — the extension-shipped view for
// the `detail` slot of this package's `cinatra.artifact.ui` block (epic #1620,
// "artifact extensions own their UI").
//
// THE CONTRACT (v1):
//  - A React Server Component with a DEFAULT export. It receives ONE argument: a
//    versioned, normalized, SERIALIZABLE `ArtifactRendererProps` snapshot the
//    host assembles AFTER it has already access-checked the row. Row metadata,
//    the resolved representation, host-authorized preview/download URLs, the
//    flattened effective identity, and sanctioned actions as navigational HREFS
//    — nothing else crosses. The renderer may run as a client component, so the
//    RSC→client serialization boundary must hold.
//  - v1 renderers request NO host ports: render ONLY from these props. Never
//    import a host internal (`@/…`) or reach for `ctx`; actions are host links,
//    never closures.
//  - UI primitives are VENDORED, not imported from the host: compose with your
//    package's OWN copies of the `@cinatra-ai` shadcn primitives — vendor them
//    into `src/ui/` with the PINNED shadcn CLI (never `@latest`) and import them
//    by RELATIVE path. See `src/ui/index.ts`.
//  - "Requires rebuild": renderers are build-known (wired through the host's
//    generated import map). Until your extension is in the base image build, its
//    renderer is not wired — the type renders GENERICALLY with a "requires
//    rebuild" indicator. It is never blank and never errors.
//
// FIRST-PARTY LOCK: shipping a renderer is available to first-party
// (`@cinatra-ai/<slug>-artifact`) extensions only, until an external-vendor
// publishing phase exists — which is why the scaffolder locks `kind:"artifact"`
// to the `@cinatra-ai` scope. Do not relist your own props type: import it from
// the SDK (the exact subpath below), which is the single source of truth.
import type { ArtifactRendererProps } from "@cinatra-ai/sdk-extensions/artifact-renderer-props";

export default function {{pascalBase}}Detail(props: ArtifactRendererProps) {
  const { artifact, urls, actions } = props;
  return (
    <article>
      <h1>{artifact.title ?? "Untitled {{displayName}}"}</h1>
      {urls.preview ? (
        <iframe src={urls.preview} title={`${artifact.title ?? "artifact"} preview`} />
      ) : null}
      {actions.download ? <a href={actions.download}>Download</a> : null}
    </article>
  );
}
