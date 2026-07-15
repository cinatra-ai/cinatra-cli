// cinatra-cli#146 — fail-closed prod refusal for host dev-start.
//
// Covers the pure decision seam behind `cinatra instance start`/`restart`
// (evaluateHostDevStartMode) and the shared production-runtime guidance copy that
// both the start refusal and the install completion hint render. The refusal is
// unit-tested at the decision seam (no real spawn), mirroring the repo's
// testable-decision-helper convention (resolveInstanceMoveTarget).

import { describe, it, expect } from "vitest";

import { evaluateHostDevStartMode, isDevelopmentModeValue } from "../src/index.mjs";
import {
  prodRuntimeGuidanceLines,
  PROD_IMAGE_REF,
  PROD_DEPLOY_ENTRYPOINT,
  PROD_PREVIEW_COMMAND,
} from "../src/prod-runtime-guidance.mjs";

describe("evaluateHostDevStartMode — host dev-start prod refusal (cinatra-cli#146)", () => {
  it("ALLOWS when no runtime-mode key is present (historical default, dev unchanged)", () => {
    expect(evaluateHostDevStartMode({})).toMatchObject({ allowed: true, mode: "development" });
    expect(evaluateHostDevStartMode({ SOME_OTHER: "x" })).toMatchObject({ allowed: true });
  });

  it("ALLOWS an explicit development/dev checkout", () => {
    expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: "development" })).toMatchObject({ allowed: true, mode: "development" });
    expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: "dev" })).toMatchObject({ allowed: true, mode: "development" });
    expect(evaluateHostDevStartMode({ APP_RUNTIME_MODE: "development" })).toMatchObject({ allowed: true });
  });

  it("ALLOWS a development checkout carrying whitespace / an inline comment / a quote (allowlist does not over-refuse)", () => {
    // A demo install writes CINATRA_RUNTIME_MODE=development too (demo is the
    // orthogonal profile axis), and an operator may annotate the line — none of
    // that should refuse host dev-start.
    for (const mode of ["  Development  ", "development # local dev box", '"development" # note', "'dev' # note"]) {
      expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: mode })).toMatchObject({ allowed: true, mode: "development" });
    }
  });

  it("REFUSES an explicit production/prod checkout (either mode key)", () => {
    expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: "production" })).toMatchObject({ allowed: false, mode: "production", fileMode: "production" });
    expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: "prod" })).toMatchObject({ allowed: false, mode: "production" });
    expect(evaluateHostDevStartMode({ APP_RUNTIME_MODE: "production" })).toMatchObject({ allowed: false });
  });

  it("REFUSES regardless of surrounding whitespace / case", () => {
    expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: "  Production  " })).toMatchObject({ allowed: false });
  });

  it("REFUSES a production mode carrying an inline comment / trailing content (fail-closed; parseEnvFile keeps text after `=`)", () => {
    // A hand-annotated .env.local line — `CINATRA_RUNTIME_MODE=production # keep,
    // live instance` — parses (no inline-comment stripping) to a mode value with
    // trailing text. An exact-match blocklist would downgrade it to development
    // and host-boot a real prod checkout; the guard must still refuse.
    for (const mode of [
      "production # keep, live customer instance",
      "production.",
      "prod # comment",
      "PRODUCTION  # x",
      "prod\t# tab-separated note",
      // parseEnvFile only strips a MATCHED surrounding quote pair, so a quoted
      // value followed by an inline comment keeps its opening quote — the guard
      // must still see through it (regression for the codex-found fail-open).
      '"production" # keep',
      "'production' # keep",
      '" production" # x',
    ]) {
      expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: mode })).toMatchObject({
        allowed: false,
        mode: "production",
        fileMode: mode,
      });
    }
    // Same via the APP_RUNTIME_MODE alias key.
    expect(evaluateHostDevStartMode({ APP_RUNTIME_MODE: "production # note" })).toMatchObject({ allowed: false });
  });

  it("REFUSES an unrecognized / non-development mode value (fail-closed allowlist)", () => {
    // The CLI only ever writes development|production, so an unrecognized value
    // ("staging", a typo, garbage) is not a supported host-dev checkout — the
    // fail-closed allowlist refuses it rather than host-booting `pnpm dev`.
    for (const mode of ["staging", "prd", "producton", "xyz"]) {
      expect(evaluateHostDevStartMode({ CINATRA_RUNTIME_MODE: mode })).toMatchObject({ allowed: false });
    }
  });
});

describe("isDevelopmentModeValue — fail-closed dev allowlist shared by both guards (cinatra-cli#146)", () => {
  // The same primitive gates BOTH the host dev-start refusal (evaluateHostDevStartMode)
  // AND the prod-update `--ref` rejection (runInstanceUpdate → resolveInstanceMoveTarget):
  // only a value that clearly names development is treated as dev; everything else
  // fails closed, so no production checkout (in any spelling) slips through as dev.
  it("recognizes a clearly-development value, tolerating whitespace / quote / inline comment", () => {
    for (const v of [
      "development",
      "dev",
      "  Development  ",
      "development # local dev box",
      '"development" # note',
      "'dev' # note",
      "DEV",
    ]) {
      expect(isDevelopmentModeValue(v)).toBe(true);
    }
  });

  it("does NOT recognize production (any spelling), unrecognized, or blank/unset as development", () => {
    for (const v of [
      "production",
      "prod",
      "production # keep, live customer instance",
      "production.",
      "prod # comment",
      "PRODUCTION  # x",
      '"production" # keep', // quote not stripped (trailing inline comment)
      "'production' # keep",
      "`production`", // backtick — parseEnvFile preserves it
      "staging",
      "prd",
      "",
      "   ",
      null,
      undefined,
    ]) {
      expect(isDevelopmentModeValue(v)).toBe(false);
    }
  });

  it("matches dev/development as a COMPLETE TOKEN, not an unbounded prefix", () => {
    // A prefix check would wrongly accept these as development; a token match
    // must not (they are garbage or, worse, could name production after "dev…").
    for (const v of ["devil", "device", "developmentish", "development-production", "dev staging", "dev-prod", '"development']) {
      expect(isDevelopmentModeValue(v)).toBe(false);
    }
    // …while genuine annotated development forms still match.
    for (const v of ["development", "dev", "development # x", '"dev" # x', "'development'"]) {
      expect(isDevelopmentModeValue(v)).toBe(true);
    }
  });
});

describe("prodRuntimeGuidanceLines — shared production-runtime copy (cinatra-cli#146)", () => {
  it("names the pinned image pull, the ops Compose deploy, and the preview lane; never `pnpm dev` or a bare `docker run`", () => {
    const out = prodRuntimeGuidanceLines().join("\n");
    expect(out).toContain(`docker pull ${PROD_IMAGE_REF}`);
    expect(out).toContain(PROD_DEPLOY_ENTRYPOINT);
    expect(out).toContain(PROD_PREVIEW_COMMAND);
    expect(out).not.toMatch(/pnpm dev/);
    // Points AT the ops Compose lifecycle, explicitly NOT a bare `docker run`.
    expect(out).toMatch(/never a bare `docker run`/);
    expect(out).not.toMatch(/^\s*docker run\b/m);
  });

  it("honours a custom indent", () => {
    const lines = prodRuntimeGuidanceLines({ indent: ">>" });
    expect(lines.every((l) => l.startsWith(">>"))).toBe(true);
  });
});
