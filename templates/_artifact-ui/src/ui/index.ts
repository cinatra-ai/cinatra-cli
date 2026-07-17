// Vendored @cinatra-ai design-registry primitives live in THIS directory.
//
// A renderer composes with your package's OWN copies of the shadcn primitives —
// never the host's UI package, never an ad-hoc UI library, never a host-internal
// import. Vendor them with the PINNED shadcn CLI (never `@latest`):
//
//   pnpm dlx shadcn@<pinned> add @cinatra-ai/<item>
//
// which copies the presentational SOURCE into this tree with RELATIVE imports.
// Re-export what you vendor from here so renderers import it by relative path:
//
//   // src/renderers/detail.tsx
//   import { Button } from "../ui";
//
// Consumption is dev/build-time only — the app never fetches the registry at
// runtime. (Empty until you vendor your first primitive.)
export {};
