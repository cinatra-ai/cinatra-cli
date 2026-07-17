// `cinatra create-extension <kind> [name] [options]` — scaffold a new Cinatra
// extension package on disk (class-B authoring).
//
// This is the single authoring entry point for `cinatra create-extension`.
// The scaffold CORE (scaffold/kinds/naming/
// template + the templates/ tree) is shared, zero-dependency, Node-builtins
// only — no network, no @cinatra-ai dependency. Generated templates pin
// @cinatra-ai/sdk-extensions as an OPTIONAL peer; the CLI never installs it.
//
//   cinatra create-extension <kind> [name] [options]
//
// <kind>  one of: agent | connector | artifact | skill
// [name]  the extension name; the `-<kind>` (or `-skills`) suffix is appended
//         automatically if absent. Prompted for when omitted on a TTY.
//
// Options:
//   --scope <scope>          npm scope (default cinatra-ai; connectors may use
//                            any scope, skills may use a vendored scope)
//   --display-name <name>    human display name (README H1)
//   --description <text>     one-line description
//   --dir <path>             parent directory to scaffold into (default cwd)
//   --force                  scaffold into a non-empty directory
//   --yes, -y                accept defaults, never prompt
//   --with-ui                (artifact only) also scaffold the opt-in
//                            `cinatra.artifact.ui` renderer: an RSC detail-slot
//                            renderer stub, the exports subpath, the React
//                            toolchain delta, and a vendored-primitives seed.
//   --with-registry-items    (artifact only; implies --with-ui) also seed a
//                            contributed shadcn registry item (registryItems).
//
// `runCreateExtension(argv)` RETURNS 0 on success and THROWS on error. A usage /
// validation error throws an Error carrying `.exitCode = 2` so the bin exits
// 2 for bad usage; any other failure throws a plain Error (exit 1 via the
// central runCli catch).

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { EXTENSION_KINDS, KIND_SCOPE_POLICY, DEFAULT_SCOPE } from "./kinds.mjs";
import { scaffold, titleize } from "./scaffold.mjs";
import { deriveSlug, baseOf } from "./naming.mjs";

/** A usage/validation error that should exit with code 2, not the generic 1. */
function usageError(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

export function parseCreateExtensionArgv(argv) {
  const opts = { _: [], yes: false, force: false, withUi: false, withRegistryItems: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--with-ui") opts.withUi = true;
    else if (a === "--with-registry-items") {
      // registryItems lives inside cinatra.artifact.ui, so it implies --with-ui.
      opts.withRegistryItems = true;
      opts.withUi = true;
    } else if (a === "--scope") opts.scope = argv[++i];
    else if (a.startsWith("--scope=")) opts.scope = a.slice("--scope=".length);
    else if (a === "--display-name") opts.displayName = argv[++i];
    else if (a.startsWith("--display-name=")) opts.displayName = a.slice("--display-name=".length);
    else if (a === "--description") opts.description = argv[++i];
    else if (a.startsWith("--description=")) opts.description = a.slice("--description=".length);
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a.startsWith("--dir=")) opts.dir = a.slice("--dir=".length);
    else if (a.startsWith("-")) {
      // Unknown flag — usage error (exit 2).
      throw usageError(`Unknown option: ${a}`);
    } else opts._.push(a);
  }
  return opts;
}

async function maybePrompt(rl, yes, question, fallback) {
  if (yes || !rl) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

/**
 * Run the `create-extension` scaffolder. `argv` is the token list AFTER the
 * `create-extension` command word (e.g. `["agent","invoice-extractor"]`).
 * Returns 0 on success; throws on error (`.exitCode === 2` for usage/validation).
 */
export async function runCreateExtension(argv) {
  const opts = parseCreateExtensionArgv(argv);

  const interactive = stdin.isTTY && !opts.yes;
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    // ── kind ──────────────────────────────────────────────────────────────
    let kind = opts._[0];
    if (!kind) {
      kind = await maybePrompt(rl, opts.yes, `Kind (${EXTENSION_KINDS.join(" | ")}): `, "");
    }
    if (!EXTENSION_KINDS.includes(kind)) {
      throw usageError(
        `kind must be one of: ${EXTENSION_KINDS.join(", ")} (got ${JSON.stringify(kind)})`,
      );
    }

    // ── name ──────────────────────────────────────────────────────────────
    let name = opts._[1];
    if (!name) {
      name = await maybePrompt(
        rl,
        opts.yes,
        `Name (a "-${kind === "skill" ? "skills" : kind}" suffix is added if absent): `,
        "",
      );
    }
    if (!name) {
      throw usageError("a name is required.");
    }
    const slug = deriveSlug(name, kind);
    const base = baseOf(slug, kind);

    // ── scope ─────────────────────────────────────────────────────────────
    let scope = opts.scope;
    if (!scope) {
      const policy = KIND_SCOPE_POLICY[kind];
      if (policy === "first-party-only") {
        scope = DEFAULT_SCOPE; // locked; no prompt
      } else {
        scope = await maybePrompt(rl, opts.yes, `npm scope [${DEFAULT_SCOPE}]: `, DEFAULT_SCOPE);
      }
    }

    // ── display name + description ─────────────────────────────────────────
    const defaultDisplay = titleize(base);
    const displayName =
      opts.displayName || (await maybePrompt(rl, opts.yes, `Display name [${defaultDisplay}]: `, defaultDisplay));
    const defaultDesc = `A Cinatra ${kind} extension: ${displayName}.`;
    const description =
      opts.description || (await maybePrompt(rl, opts.yes, `Description [${defaultDesc}]: `, defaultDesc));

    // ── opt-in artifact ui template (cinatra#1627 AC3) ──────────────────────
    // Guard here too (in addition to resolveInputs) so the usage error is typed
    // (exit 2) and reported before any prompting side effects.
    if ((opts.withUi || opts.withRegistryItems) && kind !== "artifact") {
      throw usageError(
        `--with-ui / --with-registry-items apply only to kind "artifact" (got "${kind}")`,
      );
    }

    // ── scaffold ────────────────────────────────────────────────────────────
    const result = scaffold({
      kind,
      name,
      scope,
      displayName,
      description,
      targetParent: opts.dir,
      force: opts.force,
      withUi: opts.withUi,
      withRegistryItems: opts.withRegistryItems,
    });

    stdout.write(`\nScaffolded ${result.packageName} (kind: ${kind})\n`);
    stdout.write(`  ${result.targetDir}\n\n`);
    if (result.withUi) {
      stdout.write(
        `  Includes the opt-in cinatra.artifact.ui renderer (src/renderers/detail.tsx). It renders\n` +
          `  from the SDK-supplied ArtifactRendererProps snapshot (no host ports); vendor UI primitives\n` +
          `  into src/ui/ with the PINNED shadcn CLI. Until your extension is in the base image build,\n` +
          `  it renders generically with a "requires rebuild" indicator.\n\n`,
      );
    }
    stdout.write(`  ${result.written.length} files:\n`);
    for (const f of result.written) stdout.write(`    ${f}\n`);
    stdout.write(`\nNext steps:\n`);
    stdout.write(`  1. cd ${result.slug}\n`);
    stdout.write(`  2. Edit README.md, then fill in the kind-specific payload (the generated README explains the kind).\n`);
    stdout.write(`  3. Run the kind gate:  node extension-kind-gate.mjs --package-root .\n`);
    stdout.write(`     (the same self-contained gate the install pipeline mirrors — catches blockers before you publish.)\n`);
    stdout.write(`  4. Validate package shape:  npm pack --dry-run\n`);
    stdout.write(`  5. Publish: cut a GitHub Release tagged v<version> to trigger the marketplace submit pipeline.\n`);
    stdout.write(`     (Deferred until @cinatra-ai/sdk-extensions@0.1.1 is published; the SDK peer is optional today.)\n`);
    return 0;
  } catch (err) {
    // A scaffold-thrown validation error (`err.validation`) is also a usage
    // error (exit 2); rethrow with the typed code. Anything else propagates as-is.
    if (err && err.validation && err.exitCode === undefined) {
      err.exitCode = 2;
    }
    throw err;
  } finally {
    if (rl) rl.close();
  }
}
