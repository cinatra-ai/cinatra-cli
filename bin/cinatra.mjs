#!/usr/bin/env node

import { runCli } from "../src/index.mjs";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  // Honor a typed exit code (e.g. `create-extension` raises `.exitCode === 2`
  // for usage/validation errors). Anything else exits 1.
  const code =
    error && Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
  process.exit(code);
});
