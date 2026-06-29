// Unit tests for `parseDevRefreshFlags` in dev-refresh.mjs.
//
// Covers:
//   1. Default (no flags): dockerMode "auto", withDevApps false.
//   2. --no-docker: dockerMode "off", withDevApps false.
//   3. --docker=auto: dockerMode "auto", withDevApps false.
//   4. --docker=always: dockerMode "always", withDevApps false.
//   5. --with-dev-apps alone: dockerMode "auto", withDevApps true.
//   6. --with-dev-apps combined with docker flags.
//   7. Unknown flag throws.
//   8. Invalid --docker=<value> throws.
//   9. --no-docker wins over --docker=always when both present.

import { describe, it, expect } from "vitest";

import { parseDevRefreshFlags } from "../src/dev-refresh.mjs";

describe("parseDevRefreshFlags — docker mode (existing behaviour, unchanged)", () => {
  it("returns dockerMode 'auto' and withDevApps false when no flags given", () => {
    expect(parseDevRefreshFlags([])).toEqual({ dockerMode: "auto", withDevApps: false });
    expect(parseDevRefreshFlags()).toEqual({ dockerMode: "auto", withDevApps: false });
  });

  it("returns dockerMode 'off' for --no-docker", () => {
    expect(parseDevRefreshFlags(["--no-docker"])).toMatchObject({ dockerMode: "off" });
  });

  it("returns dockerMode 'auto' for --docker=auto", () => {
    expect(parseDevRefreshFlags(["--docker=auto"])).toMatchObject({ dockerMode: "auto" });
  });

  it("returns dockerMode 'always' for --docker=always", () => {
    expect(parseDevRefreshFlags(["--docker=always"])).toMatchObject({ dockerMode: "always" });
  });

  it("--no-docker wins over a valid --docker=always when both present", () => {
    expect(parseDevRefreshFlags(["--docker=always", "--no-docker"])).toMatchObject({
      dockerMode: "off",
    });
  });

  it("throws on an unknown flag", () => {
    expect(() => parseDevRefreshFlags(["--unknown"])).toThrow(/Unknown flag/);
  });

  it("throws on an invalid --docker= value", () => {
    expect(() => parseDevRefreshFlags(["--docker=sometimes"])).toThrow(
      /Invalid --docker=sometimes/,
    );
  });
});

describe("parseDevRefreshFlags — --with-dev-apps opt-in (cinatra-cli#73)", () => {
  it("withDevApps is false by default (dev-app sync stays skipped)", () => {
    expect(parseDevRefreshFlags([])).toMatchObject({ withDevApps: false });
    expect(parseDevRefreshFlags(["--docker=auto"])).toMatchObject({ withDevApps: false });
    expect(parseDevRefreshFlags(["--no-docker"])).toMatchObject({ withDevApps: false });
  });

  it("withDevApps is true when --with-dev-apps is passed", () => {
    expect(parseDevRefreshFlags(["--with-dev-apps"])).toMatchObject({ withDevApps: true });
  });

  it("--with-dev-apps + --no-docker: withDevApps true, dockerMode off", () => {
    expect(parseDevRefreshFlags(["--no-docker", "--with-dev-apps"])).toEqual({
      dockerMode: "off",
      withDevApps: true,
    });
  });

  it("--with-dev-apps + --docker=always: withDevApps true, dockerMode always", () => {
    expect(parseDevRefreshFlags(["--docker=always", "--with-dev-apps"])).toEqual({
      dockerMode: "always",
      withDevApps: true,
    });
  });

  it("--with-dev-apps + --docker=auto: withDevApps true, dockerMode auto", () => {
    expect(parseDevRefreshFlags(["--docker=auto", "--with-dev-apps"])).toEqual({
      dockerMode: "auto",
      withDevApps: true,
    });
  });

  it("--with-dev-apps is not confused with an unknown flag", () => {
    // valid flag must not throw
    expect(() => parseDevRefreshFlags(["--with-dev-apps"])).not.toThrow();
    // typo must still throw
    expect(() => parseDevRefreshFlags(["--with-dev-app"])).toThrow(/Unknown flag/);
  });
});
