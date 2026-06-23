// A module-resolution probe (eng#232 §4.5 lean-startup test). Registered via
// `node --import`, it hooks `resolve` and prints a marker line to STDERR the
// first time a heavy Class-C dependency specifier is resolved. The lazy-pg test
// spawns the real `bin/cinatra.mjs` for the lean commands and asserts NO marker
// appears (the heavy deps never load at startup), and that a DB command DOES
// trigger the `pg` marker.
import { register } from "node:module";

register("./record-pg-resolve-hook.mjs", import.meta.url);
