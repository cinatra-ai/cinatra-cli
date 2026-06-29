# Migrating to hot-installable extensions

Recent Cinatra releases make extensions **hot-installable**: a trusted package
installs into a running instance and its surfaces (connector cards, setup pages, agents,
skills, artifacts, workflows, dashboards) appear with **no app rebuild, no
restart, and no static-map regeneration** — and disabling/uninstalling removes
them immediately. This note explains what an extension author changes when moving
from the old cold/bundled-install assumptions to the hot-install contract.

If you scaffold a NEW extension with `cinatra create-extension`, you already get
the hot-install defaults. This guide is for **existing** extensions and for
understanding *why* the defaults are what they are.

## The one rule that changed everything

The host no longer treats the generated static manifest as the source of truth
for *what is installed*. The runtime `installed_extension` record is. A surface
appears because a live install row says it should — not because a build-time map
listed it. So an extension must be **fully describable from its published
package** (manifest + declared data), with **no host rebuild** required to render
it.

Two concrete consequences for authors:

1. **A connector setup page must be declarative data, not bundled React.**
2. **Every author-time check the install pipeline runs, you can run locally**
   with the shipped `extension-kind-gate.mjs` — for every kind, before publish.

## 1. Connector setup pages: bundled-React → `schema-config`

**Before (cold/bundled):** a connector shipped a `src/setup-page.tsx` React
component. That component was compiled INTO the host app image, so adding or
changing a connector required rebuilding and redeploying the host. A
runtime-installed connector with a bundled-React page could not render at all.

**After (hot-install):** a connector declares its setup UI as data in
`cinatra.uiSurface: "schema-config"` + `cinatra.configSchema`. The host renders
that declarative schema. No React is bundled; the connector is hot-installable.

```jsonc
// package.json
"cinatra": {
  "apiVersion": "cinatra.ai/v1",
  "kind": "connector",
  "displayName": "Acme",
  "serverEntry": "./register",
  "uiSurface": "schema-config",
  "configSchema": {
    "title": "Acme",
    "description": "Configure how this connector talks to its provider.",
    "fields": [
      { "kind": "text",   "key": "apiBaseUrl", "label": "API base URL", "required": true },
      { "kind": "secret", "key": "apiKey",     "label": "API key",      "required": true }
    ]
  }
}
```

### The `configSchema` field-kind vocabulary

Every field is **pure data** — no executable code, no arbitrary HTML. The host
owns rendering and any action dispatch. The supported field kinds are:

| kind | purpose |
| --- | --- |
| `text` | a single-line value (`key`, optional `placeholder`, `required`) |
| `secret` | a write-only secret stored in the host vault, never returned to the browser |
| `nango-connect` | an OAuth/Nango connect button (`providerConfigKey`) |
| `repeatable-list` | a create-time list of flat `text`/`secret` rows (`itemFields`) |
| `status-probe` | a readiness probe rendered from a host action result (`actionId`) |
| `copyable-credential` | a read-only copyable value the host computes (`key`) |
| `named-action` | a host-registered named action button (`actionId`, optional `confirm`) |
| `select` | a choice list (`options[{value,label[,adminOnly]}]`, optional `defaultValue`) |
| `record-list` | a live list of existing rows with per-row badges + delete (`listActionId`, `deleteActionId`, `itemBadges`, …) |
| `banner` | a result-driven feedback banner (`variants[{name,tone,message}]`) |
| `advisory` | a conditional readiness/warning bound to a probe (`probeActionId`, `tone`, `whenReady`, `whenNotReady`) |

Notes:

- **Actions are host-owned.** `named-action` / `record-list` / `status-probe` /
  `advisory` reference an `actionId` the **host** resolves and authorizes
  (`canExtensionAccess(..., "use")`) and dispatches through the single host
  endpoint. The connector's `register(ctx)` provides the capability; it does NOT
  embed the action handler in the setup page. Do not declare a `named-action`
  whose handler your `register(ctx)` does not actually back.
- **`adminOnly` visibility is host-evaluated** against the actor, never decided
  by the package.
- A connector can have BOTH a `serverEntry` (the capability provider) AND a
  `schema-config` setup surface — they are independent.

### If you truly cannot avoid a React page

`uiSurface: "bundled-react"` still exists for the legacy base-image path, but it
is **not hot-installable** — a bundled-React connector can only ship by being
bundled into the host build. Treat it as legacy; prefer `schema-config`.

## 2. Run the gate locally — for every kind

`cinatra create-extension` ships `extension-kind-gate.mjs` into every scaffolded
repo. It is self-contained (Node builtins only — runs unauthenticated, before the
`@cinatra-ai` registry is reachable). Run it before you publish:

```sh
node extension-kind-gate.mjs --package-root .
```

It enforces the same author→host rules the install pipeline enforces, so a clean
local run means the marketplace will not reject your package on these axes:

- **Common (every kind):** `cinatra.kind` is one of the five; `apiVersion` is
  `cinatra.ai/v1`; `dependencies` is a well-formed array; `requestedHostPorts`
  are real host ports; `sdkAbiRange` parses; no `@/` host-internal imports; the
  only first-party code deps are `@cinatra-ai/sdk-extensions` /
  `@cinatra-ai/sdk-ui`; no host-peer VALUE import is reachable from `serverEntry`
  (keep peers type-only or take values via `ctx`); a marketplace-ready README +
  policy license; the `serverEntry` resolves (a SOURCE entry warns — the release
  build produces the built `.mjs`); the retired `cinatra.migrations` JSON-DSL is
  rejected; a `schema-config` connector carries a valid `configSchema`.
- **Per kind:** agent OAS (no retired CRM primitive in LLM-visible strings),
  connector manifest, artifact descriptor, skill naming, workflow BPMN sidecar.

The gate **warns** (never fails) on things it cannot certify standalone — most
commonly a SOURCE `serverEntry` that the release build will compile. That warning
is expected in a source/dev repo.

## Checklist

- [ ] Connector setup is `uiSurface: "schema-config"` + a valid `configSchema`
      (drop the bundled `setup-page.tsx` unless you have a hard reason to keep
      the legacy `bundled-react` path).
- [ ] No host-internal (`@/…`) imports; only the SDK as a first-party code dep.
- [ ] No host-peer VALUE import reachable from `serverEntry` (type-only or `ctx`).
- [ ] `node extension-kind-gate.mjs --package-root .` is clean (warnings OK).
- [ ] `npm pack --dry-run` leaks no dev-only path.
- [ ] Publish by cutting a GitHub Release tagged `v<version>`.
