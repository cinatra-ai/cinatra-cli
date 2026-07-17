// A presentational `registry:ui` item this extension CONTRIBUTES to the shared
// `@cinatra-ai` design registry — declared in `cinatra.artifact.ui.registryItems`
// (cinatra#1623, epic #1620). Publishing an item lets OTHER extensions vendor it
// the same way you vendor host primitives.
//
// PRESENTATIONAL-ONLY (#1607 doctrine): a registry item is consumer-executed
// source COPIED by `shadcn add` into a consuming tree — never host-executed. It
// may import ONLY public npm packages + other registry items: NO host/app
// imports, NO auth context, NO data fetching. Keep it a pure component over its
// props.
//
// Rename this file + the `name`/`description` in the `registryItems` manifest to
// your item (the manifest `name` is the strict lowercase-kebab `<component>`
// token, e.g. `stat-tile`), or drop the `registryItems` block if you are not
// contributing primitives.
export function SampleTile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
