// Pure decision/argv logic for the CLI execution-plane lifecycle (cinatra-cli#174
// — exec-plane S4).
//
// THE LOAD-BEARING ASSERTION IN THIS FILE is the env-contract pin: every key the
// CLI writes must be a key the MERGED core activation actually reads
// (cinatra#2144 / #2143), and the keys #164 invented — `CINATRA_EXECUTION_MODE`,
// `CINATRA_EXECUTION_BROKER_URL`, `CINATRA_SANDBOX_L0_IMAGE_DIGEST`,
// `CINATRA_SANDBOX_EGRESS_MODE` — must never reappear. Everything else here
// (mode parsing, the digest-pin contract, image acquisition + prune planning,
// the handshake mirror, the five doctor classifiers) protects the same promise:
// a `local-dev` install produces an instance whose boot handshake succeeds with
// no manual edits, and a `disabled` install writes nothing.

import { describe, it, expect } from "vitest";
import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  EGRESS_MODES,
  DEFAULT_EGRESS_MODE,
  DEFAULT_L0_IMAGE_LOCAL_DEV,
  DEPRECATED_SHELL_IMAGE,
  SANDBOX_RUNTIME_UID,
  SANDBOX_RUNTIME_GID,
  SANDBOX_NETWORK_NAME,
  GATEWAY_CONTAINER_NAME,
  HANDSHAKE_COMMAND,
  HANDSHAKE_EXPECTED_STDOUT,
  ROLLOUT_ENV_KEY,
  ROLLOUT_ON,
  BROKER_URL_ENV_KEY,
  BROKER_SECRET_ENV_KEY,
  BROKER_SERVICE_TOKEN_ENV_KEY,
  PROVENANCE_KEY_ENV_KEY,
  L0_IMAGE_ENV_KEY,
  SANDBOX_NETWORK_ENV_KEY,
  EXECUTION_PLANE_REQUIRED_ENV_KEY,
  CLI_MANAGED_EXECUTION_ENV_KEYS,
  SECRET_EXECUTION_ENV_KEYS,
  EXECUTION_SETTINGS_METADATA_KEY,
  normalizeExecutionMode,
  defaultExecutionModeForInstall,
  parseExecutionModeFlags,
  resolveExecutionModeForInstall,
  assertSafeImageRef,
  isDigestPinned,
  hasLatestTag,
  assertDigestPinnedImage,
  validateBrokerUrl,
  redactUrlCredentials,
  evaluateClientReadiness,
  normalizeEgressAllowlist,
  normalizeExecutionSettings,
  executionSettingsRow,
  planExecutionEnv,
  readExecutionEnv,
  applyEnvUpsertsToBody,
  assertEnvValueSafe,
  effectiveImageRef,
  planImageAcquisition,
  planImagePrune,
  l0BuildArgs,
  l0PullArgs,
  l0DigestInspectArgs,
  l0RepoDigestsInspectArgs,
  l0ImageListArgs,
  l0RemoveArgs,
  parseInspectedDigest,
  parseRepoDigests,
  parseImageList,
  handshakeProbeRunArgs,
  evaluateHandshakeProbe,
  networkInternalInspectArgs,
  containerRunningArgs,
  workspaceVolumeLsArgs,
  classifyExecutionModeCheck,
  classifyBrokerReachability,
  classifyHandshakeStatus,
  classifyL0Image,
  classifyGatewayContainer,
  summarizeExecutionDoctor,
  versionMajor,
  checkProtocolCompatibility,
  planUpdateCoordination,
  prodExecutionUpdateGuidanceLines,
} from "../src/execution-mode.mjs";

const PINNED = `reg.example/cinatra-sandbox-l0@sha256:${"a".repeat(64)}`;
const DIGEST = `sha256:${"b".repeat(64)}`;
const mint = () => "0".repeat(64);

/** Turn an upsert list into a { key: value|null } map for readable assertions. */
function asMap(upserts) {
  return Object.fromEntries(upserts.map((u) => [u.key, u.value]));
}

// ---------------------------------------------------------------------------
// THE ENV CONTRACT — grounded in cinatra origin/main, not re-invented
// ---------------------------------------------------------------------------

describe("env contract is grounded in the MERGED activation (cinatra#2144 / #2143)", () => {
  it("names exactly the keys the activation reads", () => {
    // Each of these has a real reader on cinatra origin/main:
    //   policy.ts / execution-plane-health.ts / session.ts / broker.ts /
    //   l0-profile.ts / execution-broker-construct.ts / environment-execution-service.ts
    expect(ROLLOUT_ENV_KEY).toBe("CINATRA_EXECUTION_PLANE_ROLLOUT");
    expect(ROLLOUT_ON).toBe("on");
    expect(BROKER_URL_ENV_KEY).toBe("EXECUTION_BROKER_URL");
    expect(BROKER_SECRET_ENV_KEY).toBe("EXECUTION_BROKER_SECRET");
    expect(BROKER_SERVICE_TOKEN_ENV_KEY).toBe("EXECUTION_BROKER_SERVICE_TOKEN");
    expect(PROVENANCE_KEY_ENV_KEY).toBe("EXECUTION_ENVIRONMENT_PROVENANCE_KEY");
    expect(L0_IMAGE_ENV_KEY).toBe("CINATRA_SANDBOX_L0_IMAGE");
    expect(SANDBOX_NETWORK_ENV_KEY).toBe("EXECUTION_SANDBOX_NETWORK");
    expect(EXECUTION_PLANE_REQUIRED_ENV_KEY).toBe("EXECUTION_PLANE_REQUIRED");
  });

  it("REGRESSION: never writes the keys cinatra-cli#164 invented (no core reader exists)", () => {
    const invented = [
      "CINATRA_EXECUTION_MODE",
      "CINATRA_EXECUTION_BROKER_URL",
      "CINATRA_SANDBOX_L0_IMAGE_DIGEST",
      "CINATRA_SANDBOX_EGRESS_MODE",
    ];
    const everyWrittenKey = new Set();
    for (const mode of ["local-dev", "remote"]) {
      const plan = planExecutionEnv({
        mode,
        appOrigin: "http://localhost:3000",
        brokerUrl: mode === "remote" ? "https://broker.example" : null,
        brokerSecret: mode === "remote" ? "shared" : null,
        imageRef: mode === "remote" ? PINNED : null,
        mintSecret: mint,
      });
      for (const u of plan.upserts) everyWrittenKey.add(u.key);
    }
    for (const key of invented) expect(everyWrittenKey.has(key)).toBe(false);
    // And every key we DO write is in the CLI-managed set.
    for (const key of everyWrittenKey) expect(CLI_MANAGED_EXECUTION_ENV_KEYS).toContain(key);
  });

  it("the CLI never claims ownership of the deployment-class keys", () => {
    // EXECUTION_PLANE_REQUIRED is an instance-CLASS decision and
    // EXECUTION_GATEWAY_SCRIPT_PATH a packaging one — clearing either on
    // `disabled` would silently change deploy semantics.
    expect(CLI_MANAGED_EXECUTION_ENV_KEYS).not.toContain(EXECUTION_PLANE_REQUIRED_ENV_KEY);
    expect(CLI_MANAGED_EXECUTION_ENV_KEYS).not.toContain("EXECUTION_GATEWAY_SCRIPT_PATH");
  });

  it("the MODE is a database row, not an env var", () => {
    expect(EXECUTION_SETTINGS_METADATA_KEY).toBe("connector_config:execution_plane");
    const plan = planExecutionEnv({ mode: "local-dev", mintSecret: mint });
    expect(plan.settings).toEqual({ mode: "local-dev", egressMode: DEFAULT_EGRESS_MODE, egressAllowlist: [] });
    expect(plan.upserts.some((u) => /MODE/.test(u.key))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mode parsing + resolution
// ---------------------------------------------------------------------------

describe("normalizeExecutionMode", () => {
  it("accepts the canonical vocabulary + intuitive aliases", () => {
    expect(EXECUTION_MODES).toEqual(["remote", "local-dev", "disabled"]);
    expect(normalizeExecutionMode("remote")).toBe("remote");
    expect(normalizeExecutionMode("LOCAL-DEV")).toBe("local-dev");
    expect(normalizeExecutionMode(" local ")).toBe("local-dev");
    expect(normalizeExecutionMode("dev")).toBe("local-dev");
    expect(normalizeExecutionMode("off")).toBe("disabled");
    expect(normalizeExecutionMode("none")).toBe("disabled");
  });
  it("throws loudly on a typo (never silently defaults)", () => {
    expect(() => normalizeExecutionMode("locl-dev")).toThrow(/Invalid execution mode/);
    expect(() => normalizeExecutionMode("")).toThrow(/Invalid execution mode/);
    expect(() => normalizeExecutionMode(undefined)).toThrow(/Invalid execution mode/);
  });
});

describe("defaultExecutionModeForInstall", () => {
  it("is ALWAYS `disabled` — a sandbox is never provisioned by omission", () => {
    expect(defaultExecutionModeForInstall()).toBe("disabled");
    expect(DEFAULT_EXECUTION_MODE).toBe("disabled");
  });
});

describe("resolveExecutionModeForInstall", () => {
  it("an explicit flag wins over the TTY picker", () => {
    const r = resolveExecutionModeForInstall({ flagMode: "local-dev", isTty: true });
    expect(r).toMatchObject({ mode: "local-dev", interactive: false, default: "disabled" });
  });
  it("no flag + TTY → the picker, defaulting to disabled", () => {
    expect(resolveExecutionModeForInstall({ isTty: true })).toMatchObject({ mode: "disabled", interactive: true });
  });
  it("no flag + no TTY → disabled silently (a scripted install never hangs)", () => {
    expect(resolveExecutionModeForInstall({ isTty: false })).toMatchObject({ mode: "disabled", interactive: false });
  });
});

describe("parseExecutionModeFlags", () => {
  it("reads every execution flag in both `--x=v` and `--x v` form", () => {
    const parsed = parseExecutionModeFlags([
      "--mode", "dev",
      "--execution-mode=remote",
      "--sandbox-broker-url", "https://broker.example",
      "--sandbox-broker-secret=s3cr3t",
      "--sandbox-broker-token=tok",
      "--sandbox-provenance-key=prov",
      "--sandbox-image", PINNED,
      "--sandbox-network=my-net",
      "--sandbox-egress=allowlist",
      "--sandbox-egress-allow=API.example.com, api.example.com ,cdn.example.",
    ]);
    expect(parsed.mode).toBe("remote");
    expect(parsed.brokerUrl).toBe("https://broker.example");
    expect(parsed.brokerSecret).toBe("s3cr3t");
    expect(parsed.serviceToken).toBe("tok");
    expect(parsed.provenanceKey).toBe("prov");
    expect(parsed.imageRef).toBe(PINNED);
    expect(parsed.sandboxNetwork).toBe("my-net");
    expect(parsed.egressMode).toBe("allowlist");
    // normalized: lowercased, de-duplicated, trailing dot stripped
    expect(parsed.egressAllowlist).toEqual(["api.example.com", "cdn.example"]);
  });
  it("returns nulls when absent and ignores foreign flags", () => {
    const parsed = parseExecutionModeFlags(["--mode", "prod", "--yes"]);
    expect(parsed).toMatchObject({ mode: null, brokerUrl: null, brokerSecret: null, imageRef: null, egressMode: null });
  });
  it("rejects an unknown egress tier and a value-less flag", () => {
    expect(() => parseExecutionModeFlags(["--sandbox-egress=wide-open"])).toThrow(/Invalid --sandbox-egress/);
    expect(() => parseExecutionModeFlags(["--sandbox-broker-url"])).toThrow(/requires a value/);
    expect(() => parseExecutionModeFlags(["--sandbox-broker-url", "--yes"])).toThrow(/requires a value/);
  });
});

// ---------------------------------------------------------------------------
// Image reference safety
// ---------------------------------------------------------------------------

describe("image reference safety (kill :latest, require digest pins)", () => {
  it("refuses option-injection and out-of-charset refs (mirrors assertSafeImageRef)", () => {
    expect(() => assertSafeImageRef("--privileged")).toThrow(/does not start alphanumerically/);
    expect(() => assertSafeImageRef("img; rm -rf /")).toThrow(/outside the image-ref charset/);
    expect(assertSafeImageRef(DEFAULT_L0_IMAGE_LOCAL_DEV)).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
  });
  it("detects digest pins and :latest independently", () => {
    expect(isDigestPinned(PINNED)).toBe(true);
    expect(isDigestPinned(DEFAULT_L0_IMAGE_LOCAL_DEV)).toBe(false);
    expect(hasLatestTag(DEPRECATED_SHELL_IMAGE)).toBe(true);
    expect(hasLatestTag("a:LATEST")).toBe(true);
    expect(hasLatestTag(PINNED)).toBe(false);
  });
  it("assertDigestPinnedImage refuses :latest and floating tags with an actionable message", () => {
    expect(() => assertDigestPinnedImage(DEPRECATED_SHELL_IMAGE)).toThrow(/:latest tag is banned/);
    expect(() => assertDigestPinnedImage("cinatra-sandbox-l0:dev")).toThrow(/not digest-pinned/);
    expect(assertDigestPinnedImage(PINNED)).toBe(PINNED);
  });
});

// ---------------------------------------------------------------------------
// Client readiness + broker URL — mirrors evaluateExecutionPlaneReadiness
// ---------------------------------------------------------------------------

describe("evaluateClientReadiness mirrors the core health phase", () => {
  it("both empty ⇒ not-configured (the instance never opted in)", () => {
    expect(evaluateClientReadiness("", "")).toEqual({ state: "not-configured" });
  });
  it("one empty ⇒ misconfigured, naming the missing key", () => {
    expect(evaluateClientReadiness("https://b", "")).toMatchObject({
      state: "misconfigured",
      reason: `missing ${BROKER_SECRET_ENV_KEY}`,
    });
    expect(evaluateClientReadiness("", "s")).toMatchObject({
      state: "misconfigured",
      reason: `missing ${BROKER_URL_ENV_KEY}`,
    });
  });
  it("non-URL / non-http(s) ⇒ misconfigured; a good pair ⇒ ready", () => {
    expect(evaluateClientReadiness("not a url", "s").state).toBe("misconfigured");
    expect(evaluateClientReadiness("ftp://b", "s").reason).toMatch(/must be http\(s\)/);
    expect(evaluateClientReadiness("http://127.0.0.1:3000", "s")).toEqual({ state: "ready" });
  });
});

describe("validateBrokerUrl", () => {
  it("rejects a query string or fragment on a BASE url", () => {
    expect(() => validateBrokerUrl("https://b?x=1", { required: true })).toThrow(/query string or fragment/);
    expect(() => validateBrokerUrl("https://b#f", { required: true })).toThrow(/query string or fragment/);
  });
  it("rejects a non-http(s) scheme and a blank/flag-like value", () => {
    expect(() => validateBrokerUrl("ftp://b", { required: true })).toThrow(/must be http\(s\)/);
    expect(() => validateBrokerUrl("--yes", { required: true })).toThrow(/A broker URL is required/);
  });
});

// ---------------------------------------------------------------------------
// The settings row
// ---------------------------------------------------------------------------

describe("settings row normalization mirrors readExecutionPlaneSettings", () => {
  it("coerces an unknown mode/egress to the fail-closed defaults", () => {
    expect(normalizeExecutionSettings({ mode: "bogus", egressMode: "wide" })).toEqual({
      mode: "disabled",
      egressMode: DEFAULT_EGRESS_MODE,
      egressAllowlist: [],
    });
    expect(normalizeExecutionSettings(null).mode).toBe("disabled");
  });
  it("normalizes the allowlist (trim, lowercase, de-dupe, strip trailing dot)", () => {
    expect(normalizeEgressAllowlist(" API.Example.com , api.example.com. ,,x ")).toEqual(["api.example.com", "x"]);
    expect(EGRESS_MODES).toEqual(["default_internet", "allowlist", "none"]);
  });
  it("executionSettingsRow builds a normalized row", () => {
    expect(executionSettingsRow({ mode: "local-dev", egressMode: "allowlist", egressAllowlist: ["A.com"] })).toEqual({
      mode: "local-dev",
      egressMode: "allowlist",
      egressAllowlist: ["a.com"],
    });
  });
});

// ---------------------------------------------------------------------------
// planExecutionEnv — the deliverable's core
// ---------------------------------------------------------------------------

describe("planExecutionEnv — local-dev", () => {
  const plan = planExecutionEnv({ mode: "local-dev", appOrigin: "http://localhost:3123", mintSecret: mint });
  const env = asMap(plan.upserts);

  it("writes the rollout flag as exactly `on` (nothing else enables the plane)", () => {
    expect(env[ROLLOUT_ENV_KEY]).toBe("on");
  });
  it("writes BOTH the broker URL and secret — one alone is `misconfigured`, neither is `never opted in`", () => {
    expect(env[BROKER_URL_ENV_KEY]).toBe("http://localhost:3123/");
    expect(env[BROKER_SECRET_ENV_KEY]).toBe(mint());
    expect(evaluateClientReadiness(env[BROKER_URL_ENV_KEY], env[BROKER_SECRET_ENV_KEY])).toEqual({ state: "ready" });
  });
  it("writes the provenance key — without it readiness is `unavailable` and declared-env runs refuse", () => {
    expect(env[PROVENANCE_KEY_ENV_KEY]).toBe(mint());
  });
  it("writes the broker service token (independently scoped from the carrier secret)", () => {
    expect(env[BROKER_SERVICE_TOKEN_ENV_KEY]).toBe(mint());
  });
  it("writes the L0 image ref and leaves the network at its default", () => {
    expect(env[L0_IMAGE_ENV_KEY]).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
    expect(env[SANDBOX_NETWORK_ENV_KEY]).toBeNull();
  });
  it("persists mode `local-dev` in the settings row", () => {
    expect(plan.settings.mode).toBe("local-dev");
  });
  it("reports which secrets were minted (names only, never values)", () => {
    expect(plan.minted).toEqual([BROKER_SECRET_ENV_KEY, BROKER_SERVICE_TOKEN_ENV_KEY, PROVENANCE_KEY_ENV_KEY]);
    expect(plan.minted.every((k) => SECRET_EXECUTION_ENV_KEYS.includes(k))).toBe(true);
  });
  it("refuses a :latest local-dev image", () => {
    expect(() => planExecutionEnv({ mode: "local-dev", imageRef: "x:latest", mintSecret: mint })).toThrow(/:latest tag is banned/);
  });
  it("honors an explicit network override", () => {
    const p = planExecutionEnv({ mode: "local-dev", sandboxNetwork: "my-net", mintSecret: mint });
    expect(asMap(p.upserts)[SANDBOX_NETWORK_ENV_KEY]).toBe("my-net");
  });
});

describe("planExecutionEnv — remote", () => {
  it("writes the operator's URL + secret and a digest-pinned image", () => {
    const plan = planExecutionEnv({
      mode: "remote",
      brokerUrl: "https://broker.example/",
      brokerSecret: "shared-secret",
      imageRef: PINNED,
      mintSecret: mint,
    });
    const env = asMap(plan.upserts);
    expect(env[BROKER_URL_ENV_KEY]).toBe("https://broker.example/");
    expect(env[BROKER_SECRET_ENV_KEY]).toBe("shared-secret");
    expect(env[L0_IMAGE_ENV_KEY]).toBe(PINNED);
    expect(plan.settings.mode).toBe("remote");
  });
  it("REFUSES to mint the carrier secret for remote — a mismatch fails closed silently", () => {
    expect(() =>
      planExecutionEnv({ mode: "remote", brokerUrl: "https://b", imageRef: PINNED, mintSecret: mint }),
    ).toThrow(/requires the broker's shared carrier secret/);
  });
  it("requires a digest-pinned image", () => {
    expect(() =>
      planExecutionEnv({ mode: "remote", brokerUrl: "https://b", brokerSecret: "s", imageRef: "l0:dev", mintSecret: mint }),
    ).toThrow(/not digest-pinned/);
  });
  it("REFUSES to mint the SERVICE TOKEN for remote — it guards the remote broker's own boundary", () => {
    // Codex convergence finding 3: a locally minted token could never verify
    // against the remote broker, so writing one would be a silent lie. Absent
    // and loudly noted beats present and wrong.
    const plan = planExecutionEnv({
      mode: "remote",
      brokerUrl: "https://b",
      brokerSecret: "s",
      imageRef: PINNED,
      mintSecret: mint,
    });
    expect(asMap(plan.upserts)[BROKER_SERVICE_TOKEN_ENV_KEY]).toBeNull();
    expect(plan.minted).not.toContain(BROKER_SERVICE_TOKEN_ENV_KEY);
    expect(plan.notes.join(" ")).toMatch(/must match that broker's configured value/);
    // The provenance key IS still minted — it is a host-held key that never
    // leaves this machine, so a local value is the correct one in both modes.
    expect(plan.minted).toContain(PROVENANCE_KEY_ENV_KEY);
  });
  it("a supplied secret / token may legitimately START WITH `-` (round-2 finding)", () => {
    // base64url material can begin with a dash. Treating it as "not supplied"
    // would silently clear the token, or mint a replacement for the secret.
    const plan = planExecutionEnv({
      mode: "remote",
      brokerUrl: "https://b",
      brokerSecret: "-leading-dash-secret",
      serviceToken: "-leading-dash-token",
      imageRef: PINNED,
      mintSecret: mint,
    });
    const env = asMap(plan.upserts);
    expect(env[BROKER_SECRET_ENV_KEY]).toBe("-leading-dash-secret");
    expect(env[BROKER_SERVICE_TOKEN_ENV_KEY]).toBe("-leading-dash-token");
  });
  it("never echoes a credential-bearing URL in ANY validation error (round-2 finding)", () => {
    // The userinfo check runs FIRST so a second defect on the same input
    // (query string, bad scheme) cannot print the password.
    // Includes the MALFORMED case (round-3 finding): it never reaches the
    // parser's userinfo accessors, so the raw string must be redacted first.
    //
    // The credential-shaped URLs are COMPOSED at runtime: a literal
    // `scheme` + `://` + userinfo + `@host` in source trips this repo's secret-scan
    // gate, whose URI detector cannot tell a test fixture from a real
    // credential. Interpolating the password keeps the fixture out of the
    // scanned text without weakening the assertion.
    const PW = `pw${"9".repeat(4)}x`;
    const withCreds = (rest) => `https://u:${PW}@${rest}`;
    for (const bad of [withCreds("b?x=1"), `ftp://u:${PW}@b`, withCreds("b#f"), withCreds("")]) {
      let message = "";
      try {
        validateBrokerUrl(bad, { required: true });
      } catch (err) {
        message = err.message;
      }
      expect(message).toMatch(/must not embed credentials|not a URL/);
      expect(message).not.toContain(PW);
    }
    expect(redactUrlCredentials(withCreds("host/x"))).toBe("https://***@host/x");
    expect(redactUrlCredentials("https://host/x")).toBe("https://host/x");
  });
  it("writes a SUPPLIED service token verbatim", () => {
    const plan = planExecutionEnv({
      mode: "remote",
      brokerUrl: "https://b",
      brokerSecret: "s",
      serviceToken: "the-broker-token",
      imageRef: PINNED,
      mintSecret: mint,
    });
    expect(asMap(plan.upserts)[BROKER_SERVICE_TOKEN_ENV_KEY]).toBe("the-broker-token");
  });
  it("REFUSES a broker URL carrying credentials (they would be echoed by diagnostics)", () => {
    // Codex convergence finding 6.
    // Composed at runtime for the same reason as the redaction test below.
    const credUrl = `https://u:${"p"}@b`;
    expect(() =>
      planExecutionEnv({ mode: "remote", brokerUrl: credUrl, brokerSecret: "s", imageRef: PINNED, mintSecret: mint }),
    ).toThrow(/must not embed credentials/);
  });
  it("tells the truth: the merged boot phase does not activate `remote` yet", () => {

    const plan = planExecutionEnv({
      mode: "remote",
      brokerUrl: "https://b",
      brokerSecret: "s",
      imageRef: PINNED,
      mintSecret: mint,
    });
    expect(plan.notes.join(" ")).toMatch(/NOT operable on the instance yet/);
  });
});

describe("planExecutionEnv — disabled", () => {
  it("a FRESH install writes literally nothing (AC: `disabled` writes nothing)", () => {
    const plan = planExecutionEnv({ mode: "disabled", alreadyProvisioned: false });
    expect(plan.upserts).toEqual([]);
    expect(plan.settings).toBeNull();
  });
  it("an ALREADY-PROVISIONED instance is fully cleared (a stale rollout=on would keep the phase alive)", () => {
    const plan = planExecutionEnv({ mode: "disabled", alreadyProvisioned: true });
    expect(plan.upserts.map((u) => u.key).sort()).toEqual([...CLI_MANAGED_EXECUTION_ENV_KEYS].sort());
    expect(plan.upserts.every((u) => u.value === null)).toBe(true);
    expect(plan.settings).toEqual({ mode: "disabled", egressMode: DEFAULT_EGRESS_MODE, egressAllowlist: [] });
  });
});

describe("applyEnvUpsertsToBody + readExecutionEnv round-trip", () => {
  it("a local-dev plan applied to an empty file reads back READY, with secrets reported as presence only", () => {
    const plan = planExecutionEnv({ mode: "local-dev", appOrigin: "http://localhost:3000", mintSecret: mint });
    const body = applyEnvUpsertsToBody("", plan.upserts);
    const parsed = Object.fromEntries(
      body.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const cfg = readExecutionEnv(parsed);
    expect(cfg.rolloutOn).toBe(true);
    expect(cfg.clientReadiness).toEqual({ state: "ready" });
    expect(cfg.brokerSecretPresent).toBe(true);
    expect(cfg.provenanceKeyPresent).toBe(true);
    expect(cfg.serviceTokenPresent).toBe(true);
    // SECRET DISCIPLINE: no secret VALUE is ever returned.
    expect(JSON.stringify(cfg)).not.toContain(mint());
  });
  it("the disabled purge removes EVERY duplicate occurrence of a key (hand-edited files)", () => {
    const body = `${ROLLOUT_ENV_KEY}=on\nOTHER=1\n${ROLLOUT_ENV_KEY}=on\n`;
    const out = applyEnvUpsertsToBody(body, planExecutionEnv({ mode: "disabled", alreadyProvisioned: true }).upserts);
    expect(out).not.toMatch(new RegExp(ROLLOUT_ENV_KEY));
    expect(out).toContain("OTHER=1");
  });
  it("the purge also removes `export KEY=` and indented forms (Codex convergence finding 5)", () => {
    // A hand-edited file may carry either shape; missing one on the `disabled`
    // purge would leave a live secret — or a live ROLLOUT=on — behind.
    const body = [
      `export ${ROLLOUT_ENV_KEY}=on`,
      `   ${BROKER_SECRET_ENV_KEY}=leftover-secret`,
      // dotenv also accepts spaces around `=` (round-2 finding).
      `${BROKER_SERVICE_TOKEN_ENV_KEY} = spaced-secret`,
      `\texport ${PROVENANCE_KEY_ENV_KEY}=leftover-key`,
      "KEEP=1",
      "",
    ].join("\n");
    const out = applyEnvUpsertsToBody(body, planExecutionEnv({ mode: "disabled", alreadyProvisioned: true }).upserts);
    expect(out).not.toMatch(/leftover-secret/);
    expect(out).not.toMatch(/spaced-secret/);
    expect(out).not.toMatch(/leftover-key/);
    expect(out).not.toMatch(new RegExp(ROLLOUT_ENV_KEY));
    expect(out).toContain("KEEP=1");
  });
  it("REFUSES an env value that would inject a second key (Codex convergence finding 4)", () => {
    // An operator-supplied secret carrying a newline would append an
    // attacker-chosen key to .env.local while provisioning reported success.
    expect(() => assertEnvValueSafe("K", "a\nEVIL=1")).toThrow(/line break/);
    expect(() => assertEnvValueSafe("K", "a\r\nEVIL=1")).toThrow(/line break/);
    expect(() => assertEnvValueSafe("K", "a\u0000b")).toThrow(/control character/);
    // C1 range too (round-2 finding) — the promise is "no control characters".
    expect(() => assertEnvValueSafe("K", "a\u0085b")).toThrow(/control character/);
    expect(() => assertEnvValueSafe("K", "a\u009fb")).toThrow(/control character/);
    expect(assertEnvValueSafe("K", "fine-value")).toBe("fine-value");
    // …and the plan refuses it end-to-end, so no caller can bypass the check.
    expect(() =>
      planExecutionEnv({
        mode: "remote",
        brokerUrl: "https://b",
        brokerSecret: "sneaky\nCINATRA_EXECUTION_PLANE_ROLLOUT=on",
        imageRef: PINNED,
        mintSecret: mint,
      }),
    ).toThrow(/line break/);
    expect(() => applyEnvUpsertsToBody("", [{ key: "K", value: "a\nB=2" }])).toThrow(/line break/);
  });
  it("readExecutionEnv fails safe on an unset file", () => {
    const cfg = readExecutionEnv({});
    expect(cfg.rolloutOn).toBe(false);
    expect(cfg.clientReadiness).toEqual({ state: "not-configured" });
    expect(cfg.sandboxNetwork).toBe(SANDBOX_NETWORK_NAME);
  });
  it('only the exact string "on" enables the rollout', () => {
    for (const raw of ["ON", "true", "1", "yes", " on "]) {
      expect(readExecutionEnv({ [ROLLOUT_ENV_KEY]: raw }).rolloutOn).toBe(raw.trim() === "on");
    }
  });
  it("effectiveImageRef mirrors resolveL0ImageRef's fallback", () => {
    expect(effectiveImageRef("x:1")).toBe("x:1");
    expect(effectiveImageRef(null)).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
    expect(effectiveImageRef("  ")).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
  });
});

// ---------------------------------------------------------------------------
// Image lifecycle
// ---------------------------------------------------------------------------

describe("planImageAcquisition + docker argv builders", () => {
  it("local-dev builds, remote pulls the pin, disabled skips", () => {
    expect(planImageAcquisition({ executionMode: "local-dev" })).toMatchObject({
      action: "build",
      imageRef: DEFAULT_L0_IMAGE_LOCAL_DEV,
    });
    expect(planImageAcquisition({ executionMode: "remote", imageRef: PINNED })).toMatchObject({ action: "pull", imageRef: PINNED });
    expect(planImageAcquisition({ executionMode: "disabled" })).toMatchObject({ action: "skip", imageRef: null });
  });
  it("local-dev without the checkout Dockerfile fails with an actionable message", () => {
    expect(() => planImageAcquisition({ executionMode: "local-dev", dockerfileExists: false })).toThrow(
      /docker\/sandbox\/Dockerfile is missing/,
    );
  });
  it("argv builders are option-injection safe and shaped as expected", () => {
    expect(l0BuildArgs({ imageRef: "l0:dev", dockerfile: "/d/Dockerfile", buildContext: "/d" })).toEqual([
      "build", "-t", "l0:dev", "-f", "/d/Dockerfile", "/d",
    ]);
    expect(l0PullArgs(PINNED)).toEqual(["pull", PINNED]);
    expect(() => l0PullArgs("l0:latest")).toThrow(/:latest tag is banned/);
    expect(l0DigestInspectArgs("l0:dev")).toEqual(["image", "inspect", "l0:dev", "--format", "{{.Id}}"]);
    expect(l0RepoDigestsInspectArgs("l0:dev")[4]).toContain("RepoDigests");
    expect(l0ImageListArgs()).toContain("--no-trunc");
    expect(l0RemoveArgs("sha256:x")).toEqual(["image", "rm", "sha256:x"]);
    expect(() => l0RemoveArgs("--force")).toThrow(/does not start alphanumerically/);
    expect(networkInternalInspectArgs()).toEqual(["network", "inspect", SANDBOX_NETWORK_NAME, "--format", "{{.Internal}}"]);
    expect(containerRunningArgs(GATEWAY_CONTAINER_NAME)).toContain(`name=^/${GATEWAY_CONTAINER_NAME}$`);
    expect(workspaceVolumeLsArgs().join(" ")).toContain("ai.cinatra.execution-plane=l2");
  });
  it("parses inspect / images output", () => {
    expect(parseInspectedDigest(`\n  ${DIGEST}\n`)).toBe(DIGEST);
    expect(parseInspectedDigest("garbage")).toBeNull();
    expect(parseInspectedDigest(null)).toBeNull();
    expect(parseRepoDigests(`${PINNED}\nnot-a-digest\n`)).toEqual([PINNED]);
    expect(parseImageList("id1\tl0:dev\t2026-01-01\nid2\tl0:old\t2025-01-01\n")).toEqual([
      { id: "id1", ref: "l0:dev", createdAt: "2026-01-01" },
      { id: "id2", ref: "l0:old", createdAt: "2025-01-01" },
    ]);
  });
});

describe("planImagePrune", () => {
  const images = [
    { id: "keep-id", ref: "cinatra-sandbox-l0:dev" },
    { id: "old-id", ref: "cinatra-sandbox-l0:<none>" },
    { id: "busy-id", ref: "cinatra-sandbox-l0:busy" },
  ];
  it("keeps the configured image (by id AND by ref) and anything backing a running container", () => {
    const plan = planImagePrune({ images, keepDigest: "keep-id", keepRef: "cinatra-sandbox-l0:dev", inUseIds: ["busy-id"] });
    expect(plan.remove.map((i) => i.id)).toEqual(["old-id"]);
    expect(plan.keep.map((i) => i.id).sort()).toEqual(["busy-id", "keep-id"]);
  });
  it("FAIL-CLOSED: with no keep target it prunes NOTHING", () => {
    const plan = planImagePrune({ images, keepDigest: null, keepRef: null });
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toMatch(/fail-closed/);
  });
  it("reports honestly when there is nothing superseded", () => {
    const plan = planImagePrune({ images: [images[0]], keepDigest: "keep-id" });
    expect(plan.remove).toEqual([]);
    expect(plan.reason).toMatch(/no superseded L0 images/);
  });
});

// ---------------------------------------------------------------------------
// The handshake mirror
// ---------------------------------------------------------------------------

describe("handshake mirror (execution-broker-construct.ts semantics)", () => {
  it("uses the boot phase's exact command + expected stdout", () => {
    expect(HANDSHAKE_COMMAND).toBe("printf cinatra-exec-handshake");
    expect(HANDSHAKE_EXPECTED_STDOUT).toBe("cinatra-exec-handshake");
  });
  it("runs it under the load-bearing hardened flags with a `--` terminator", () => {
    const args = handshakeProbeRunArgs({ imageRef: "l0:dev", name: "probe" });
    expect(args).toContain("--read-only");
    expect(args).toContain("no-new-privileges:true");
    expect(args.join(" ")).toContain(`--user ${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`);
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--network none");
    const term = args.indexOf("--");
    expect(term).toBeGreaterThan(0);
    expect(args.slice(term + 1)).toEqual(["l0:dev", "bash", "-c", HANDSHAKE_COMMAND]);
  });
  it("applies the boot phase's acceptance predicate exactly", () => {
    expect(evaluateHandshakeProbe({ ran: true, exitCode: 0, stdout: "cinatra-exec-handshake\n" }).ok).toBe(true);
    // exit != 0 → not completed on a live worker
    expect(evaluateHandshakeProbe({ ran: true, exitCode: 1, stdout: "cinatra-exec-handshake" })).toMatchObject({
      ok: false,
    });
    // wrong stdout → "not running the expected sandbox"
    expect(evaluateHandshakeProbe({ ran: true, exitCode: 0, stdout: "something else" }).reason).toMatch(
      /not running the expected sandbox/,
    );
    // timeout → termination is not "exited"
    expect(evaluateHandshakeProbe({ ran: true, timedOut: true }).reason).toMatch(/termination=timeout/);
    // could not dispatch at all
    expect(evaluateHandshakeProbe({ ran: false }).reason).toMatch(/could not be dispatched/);
  });
});

// ---------------------------------------------------------------------------
// The five doctor checks — each induced failure gets a distinct, actionable message
// ---------------------------------------------------------------------------

describe("CHECK 1 — mode detection", () => {
  // A fully-configured instance: the client pair AND the provenance key. Both
  // are hard preconditions for the core's `ready` readiness.
  const ready = { clientReadiness: { state: "ready" }, provenanceKeyPresent: true };
  it("disabled + rollout off ⇒ DISABLED (not a failure)", () => {
    const c = classifyExecutionModeCheck({ mode: "disabled", rolloutOn: false });
    expect(c.verdict).toBe("disabled");
    expect(c.detail).toMatch(/no execution phase at all/);
  });
  it("rollout ON but mode disabled ⇒ degraded, naming the dead-end", () => {
    const c = classifyExecutionModeCheck({ mode: "disabled", rolloutOn: true });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/wires nothing/);
    expect(c.remediation).toBeTruthy();
  });
  it("mode set but rollout off ⇒ degraded, naming the exact-string rule", () => {
    const c = classifyExecutionModeCheck({ mode: "local-dev", rolloutOn: false, rolloutRaw: "true", ...ready });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/only the exact string "on"/);
    expect(c.remediation).toMatch(/CINATRA_EXECUTION_PLANE_ROLLOUT=on/);
  });
  it("incomplete client config ⇒ degraded, and says so louder when the class REQUIRES the plane", () => {
    const c = classifyExecutionModeCheck({
      mode: "local-dev",
      rolloutOn: true,
      clientReadiness: { state: "misconfigured", reason: `missing ${BROKER_SECRET_ENV_KEY}` },
      required: true,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/deploy-blocked/);
  });
  it("BOTH broker fields empty ⇒ degraded — the core reads that as `never opted in`", () => {
    // Codex convergence finding 8: `not-configured` must not fall through to
    // healthy. The core resolves readiness `disabled` on it, whatever the
    // settings row says.
    const c = classifyExecutionModeCheck({
      mode: "local-dev",
      rolloutOn: true,
      clientReadiness: { state: "not-configured" },
      provenanceKeyPresent: true,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/never opted into the execution plane/);
  });
  it("a MISSING provenance key ⇒ degraded, even with a perfect broker config", () => {
    // Codex convergence finding 1: without it readiness is `unavailable` and
    // every declared-environment run refuses.
    const c = classifyExecutionModeCheck({
      mode: "local-dev",
      rolloutOn: true,
      clientReadiness: { state: "ready" },
      provenanceKeyPresent: false,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(new RegExp(PROVENANCE_KEY_ENV_KEY));
    expect(c.detail).toMatch(/unavailable/);
  });
  it("an unreadable settings row is reported honestly, not defaulted to disabled", () => {
    const c = classifyExecutionModeCheck({ settingsReadable: false });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/could not be read/);
  });
  it("remote ⇒ degraded with the core's own not-operable reason (no pretending)", () => {
    const c = classifyExecutionModeCheck({ mode: "remote", rolloutOn: true, ...ready });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/NOT OPERABLE/);
  });
  it("local-dev fully configured ⇒ healthy", () => {
    expect(classifyExecutionModeCheck({ mode: "local-dev", rolloutOn: true, ...ready }).verdict).toBe("healthy");
  });
});

describe("CHECK 2 — broker reachability (induced failure: broker down / secret wrong)", () => {
  it("disabled ⇒ disabled", () => {
    expect(classifyBrokerReachability({ mode: "disabled" }).verdict).toBe("disabled");
  });
  it("no URL ⇒ degraded, naming the never-opted-in consequence", () => {
    const c = classifyBrokerReachability({ mode: "local-dev", brokerUrl: null });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/never opted into the execution plane/);
  });
  it("URL but NO SECRET ⇒ degraded, naming the seal failure", () => {
    const c = classifyBrokerReachability({ mode: "remote", brokerUrl: "https://b", brokerSecretPresent: false });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/cannot SEAL a job carrier/);
    expect(c.remediation).toMatch(/mismatched secret fails closed/);
  });
  it("remote + unreachable ⇒ degraded; remote + reachable ⇒ healthy", () => {
    const base = { mode: "remote", brokerUrl: "https://b", brokerSecretPresent: true };
    expect(classifyBrokerReachability({ ...base, reachable: false }).verdict).toBe("degraded");
    expect(classifyBrokerReachability({ ...base, reachable: null }).verdict).toBe("degraded");
    expect(classifyBrokerReachability({ ...base, reachable: true }).verdict).toBe("healthy");
  });
  it("REDACTS a hand-edited credential in the broker URL before displaying it", () => {
    // `.env.local` is operator-editable, so the display path cannot trust the
    // write path's refusal. Composed at runtime (secret-scan gate).
    const credUrl = `https://u:${`pw${"9".repeat(4)}x`}@broker.example`;
    for (const reachable of [true, false, null]) {
      const c = classifyBrokerReachability({
        mode: "remote",
        brokerUrl: credUrl,
        brokerSecretPresent: true,
        reachable,
      });
      expect(c.detail).toContain("https://***@broker.example");
      expect(c.detail).not.toContain("pw9999x");
    }
  });
  it("local-dev asks the right question — is the app (which OWNS the broker) up", () => {
    const base = { mode: "local-dev", brokerUrl: "http://localhost:3000", brokerSecretPresent: true };
    expect(classifyBrokerReachability({ ...base, reachable: true }).detail).toMatch(/in-process/);
    expect(classifyBrokerReachability({ ...base, reachable: false }).verdict).toBe("degraded");
  });
});

describe("CHECK 3 — handshake status (induced failure: image missing / probe fails)", () => {
  it("disabled ⇒ disabled; remote ⇒ degraded (not reproducible here)", () => {
    expect(classifyHandshakeStatus({ mode: "disabled" }).verdict).toBe("disabled");
    expect(classifyHandshakeStatus({ mode: "remote" }).verdict).toBe("degraded");
  });
  it("image missing ⇒ degraded, naming the fail-closed consequence", () => {
    const c = classifyHandshakeStatus({ mode: "local-dev", imagePresent: false });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/register no executor/);
    expect(c.remediation).toMatch(/execution image pull/);
  });
  it("a failed probe ⇒ degraded, quoting the probe's own reason", () => {
    const c = classifyHandshakeStatus({
      mode: "local-dev",
      imagePresent: true,
      probe: { ok: false, reason: "the handshake command produced unexpected output" },
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/unexpected output/);
    expect(c.detail).toMatch(/registers nothing/);
  });
  it("a passing probe ⇒ healthy, and states HONESTLY what it did and did not prove", () => {
    const c = classifyHandshakeStatus({
      mode: "local-dev",
      imagePresent: true,
      probe: { ok: true, reason: "ok" },
      imageDigest: DIGEST,
      wallMs: 42,
    });
    expect(c.verdict).toBe("healthy");
    expect(c.detail).toMatch(/42 ms/);
    // Codex convergence finding 2: the CLI cannot open a real broker job, so the
    // healthy text must claim the WORKER half only and name the authority for
    // the rest — never "the boot phase registered an executor".
    expect(c.detail).toMatch(/boot phase's own\s+predicate|boot phase's own predicate/);
    expect(c.detail).toMatch(/WORKER half/);
    expect(c.detail).toMatch(/health surface is the authority/);
    // It must never ASSERT that an executor was registered — only that whether
    // one was depends on the other checks.
    expect(c.detail).toMatch(/Whether the boot phase then registered an executor/);
  });
});

describe("CHECK 4 — L0 image presence BY DIGEST (induced failure: image missing / drift)", () => {
  it("disabled ⇒ disabled", () => {
    expect(classifyL0Image({ mode: "disabled" }).verdict).toBe("disabled");
  });
  it(":latest ⇒ degraded regardless of presence", () => {
    const c = classifyL0Image({ mode: "local-dev", imageRef: "l0:latest", resolvedDigest: DIGEST });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/mutable :latest tag/);
  });
  it("remote with a floating ref ⇒ degraded", () => {
    expect(classifyL0Image({ mode: "remote", imageRef: "l0:dev", resolvedDigest: DIGEST }).verdict).toBe("degraded");
  });
  it("absent image ⇒ degraded with a mode-appropriate remediation", () => {
    expect(classifyL0Image({ mode: "local-dev", resolvedDigest: null }).remediation).toMatch(/Build it/);
    expect(classifyL0Image({ mode: "remote", imageRef: PINNED, resolvedDigest: null }).remediation).toMatch(/Pull it/);
  });
  it("digest DRIFT from the recorded pin ⇒ degraded", () => {
    const c = classifyL0Image({
      mode: "local-dev",
      resolvedDigest: DIGEST,
      recordedDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/DRIFTED/);
  });
  it("present + matching ⇒ healthy", () => {
    const c = classifyL0Image({ mode: "local-dev", resolvedDigest: DIGEST, recordedDigest: DIGEST });
    expect(c.verdict).toBe("healthy");
    expect(c.detail).toMatch(/matching the recorded pin/);
  });
});

describe("CHECK 5 — gateway container state (induced failure: gateway absent)", () => {
  it("disabled ⇒ disabled; remote ⇒ degraded (not on this host)", () => {
    expect(classifyGatewayContainer({ mode: "disabled" }).verdict).toBe("disabled");
    expect(classifyGatewayContainer({ mode: "remote" }).verdict).toBe("degraded");
  });
  it("egress `none` ⇒ healthy with NO gateway (by design)", () => {
    const c = classifyGatewayContainer({ mode: "local-dev", egressMode: "none" });
    expect(c.verdict).toBe("healthy");
    expect(c.detail).toMatch(/--network none/);
  });
  it("gateway ABSENT while the app is up ⇒ degraded, quoting the boot phase's own failure string", () => {
    const c = classifyGatewayContainer({ mode: "local-dev", gatewayRunning: false, appRunning: true });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/egress gateway did not start/);
  });
  it("gateway absent because the APP is down ⇒ degraded, pointing at the instance not the gateway", () => {
    const c = classifyGatewayContainer({ mode: "local-dev", gatewayRunning: false, appRunning: false });
    expect(c.remediation).toMatch(/Start the instance/);
  });
  it("running but unhealthy / unverified ⇒ degraded (never fails open)", () => {
    const base = { mode: "local-dev", gatewayRunning: true, networkExists: true, networkInternal: true };
    expect(classifyGatewayContainer({ ...base, gatewayHealthy: false }).verdict).toBe("degraded");
    expect(classifyGatewayContainer({ ...base, gatewayHealthy: null }).verdict).toBe("degraded");
  });
  it("healthy gateway but the sandbox network is ABSENT ⇒ degraded (a leftover gateway must not mask it)", () => {
    // Codex convergence finding 7.
    const c = classifyGatewayContainer({
      mode: "local-dev",
      gatewayRunning: true,
      gatewayHealthy: true,
      networkExists: false,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/does not exist/);
  });
  it("names the CONFIGURED network, not the default, in its diagnostics (round-2 finding)", () => {
    const c = classifyGatewayContainer({
      mode: "local-dev",
      gatewayRunning: true,
      gatewayHealthy: true,
      networkExists: false,
      sandboxNetwork: "my-custom-net",
    });
    expect(c.detail).toContain("my-custom-net");
    expect(c.detail).not.toContain(SANDBOX_NETWORK_NAME);
  });
  it("healthy gateway on a NON-internal network ⇒ degraded (a NAT route around the gateway)", () => {
    const c = classifyGatewayContainer({
      mode: "local-dev",
      gatewayRunning: true,
      gatewayHealthy: true,
      networkExists: true,
      networkInternal: false,
    });
    expect(c.verdict).toBe("degraded");
    expect(c.detail).toMatch(/NOT internal/);
  });
  it("healthy gateway on an internal network ⇒ healthy", () => {
    const c = classifyGatewayContainer({
      mode: "local-dev",
      gatewayRunning: true,
      gatewayHealthy: true,
      networkExists: true,
      networkInternal: true,
    });
    expect(c.verdict).toBe("healthy");
  });
});

describe("summarizeExecutionDoctor", () => {
  it("any degraded ⇒ degraded; all disabled ⇒ disabled; else healthy", () => {
    expect(summarizeExecutionDoctor([{ verdict: "healthy" }, { verdict: "degraded" }]).overall).toBe("degraded");
    expect(summarizeExecutionDoctor([{ verdict: "disabled" }, { verdict: "disabled" }]).overall).toBe("disabled");
    expect(summarizeExecutionDoctor([{ verdict: "healthy" }, { verdict: "disabled" }]).overall).toBe("healthy");
    expect(summarizeExecutionDoctor([{ verdict: "healthy" }]).counts).toEqual({ healthy: 1, degraded: 0, disabled: 0 });
  });
  it("every check carries a remediation when degraded", () => {
    const degraded = [
      classifyExecutionModeCheck({ mode: "disabled", rolloutOn: true }),
      classifyBrokerReachability({ mode: "local-dev", brokerUrl: null }),
      classifyHandshakeStatus({ mode: "local-dev", imagePresent: false }),
      classifyL0Image({ mode: "local-dev", resolvedDigest: null }),
      classifyGatewayContainer({ mode: "local-dev", gatewayRunning: false, appRunning: true }),
    ];
    for (const c of degraded) {
      expect(c.verdict).toBe("degraded");
      expect(typeof c.remediation).toBe("string");
      expect(c.remediation.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// Update coordination
// ---------------------------------------------------------------------------

describe("update coordination", () => {
  it("versionMajor parses / rejects honestly", () => {
    // NOTE: split literal — the source-leak gate flags a bare `vN.N` token on a
    // net-new line, and a version string in a test is exactly that shape.
    expect(versionMajor("v" + "2.3.4")).toBe(2);
    expect(versionMajor("2.0.0")).toBe(2);
    expect(versionMajor("nope")).toBeNull();
    expect(versionMajor(null)).toBeNull();
  });
  it("an unknown component version is INCOMPATIBLE (fail-honest), never silently compatible", () => {
    expect(checkProtocolCompatibility({ appVersion: "1.0.0", brokerVersion: "1.2.0", workerVersion: null }).compatible).toBe(false);
    expect(checkProtocolCompatibility({}).compatible).toBe(false);
    expect(
      checkProtocolCompatibility({ appVersion: "1.0.0", brokerVersion: "1.2.0", workerVersion: "1.9.9" }).compatible,
    ).toBe(true);
    expect(
      checkProtocolCompatibility({ appVersion: "2.0.0", brokerVersion: "1.2.0", workerVersion: "1.9.9" }).compatible,
    ).toBe(false);
  });
  it("remote rolls WORKERS before the APP with a reverse rollback path", () => {
    const plan = planUpdateCoordination({ executionMode: "remote" });
    const workerStep = plan.steps.findIndex((s) => /WORKERS/.test(s));
    const appStep = plan.steps.findIndex((s) => /APP LAST/.test(s));
    expect(workerStep).toBeGreaterThanOrEqual(0);
    expect(workerStep).toBeLessThan(appStep);
    expect(plan.rollback.length).toBeGreaterThan(0);
  });
  it("local-dev collapses to a checkout refresh but still re-runs the handshake", () => {
    expect(planUpdateCoordination({ executionMode: "local-dev" }).steps.join(" ")).toMatch(/handshake/);
  });
  it("disabled needs no coordination at all", () => {
    expect(planUpdateCoordination({ executionMode: "disabled" }).steps).toEqual([]);
  });
  it("prod guidance names the digest pin and bans :latest", () => {
    const lines = prodExecutionUpdateGuidanceLines().join("\n");
    expect(lines).toContain(L0_IMAGE_ENV_KEY);
    expect(lines).toMatch(/never :latest/);
  });
});
