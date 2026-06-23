// Resolve hook for the lean-startup probe (eng#232 §4.5). Emits a stable
// `__HEAVY_DEP_LOADED__:<name>` line to STDERR the first time any tracked heavy
// Class-C dependency is RESOLVED (which precedes loading). Tracking resolution
// (not just load) is conservative: if a specifier is resolved at all, it was
// reached by the import graph.
const HEAVY = [
  "pg",
  "node-pg-migrate",
  "@cinatra-ai/migrations",
  "@cinatra-ai/connectors-catalog",
  "@cinatra-ai/skills",
];

const seen = new Set();

export async function resolve(specifier, context, nextResolve) {
  for (const dep of HEAVY) {
    // Match the bare package specifier or a subpath import of it.
    if (specifier === dep || specifier.startsWith(`${dep}/`)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        process.stderr.write(`__HEAVY_DEP_LOADED__:${dep}\n`);
      }
    }
  }
  return nextResolve(specifier, context);
}
