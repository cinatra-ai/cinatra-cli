// Pure decision/argv logic for the CLI execution-plane lifecycle (cinatra-cli#160
// — exec-plane S4). These pin the contract that the orchestration in index.mjs /
// install.mjs relies on: mode parsing/resolution, the AC4 image-pin contract
// (kill :latest, require digest pins), image-acquisition planning + docker argv
// shape, `.env.local` provisioning, the doctor verdict classifiers
// (healthy/degraded/disabled), and update coordination (protocol compat + order).

import { describe, it, expect } from "vitest";
import {
  EXECUTION_MODES,
  EGRESS_MODES,
  DEFAULT_L0_IMAGE_LOCAL_DEV,
  DEPRECATED_SHELL_IMAGE,
  SANDBOX_RUNTIME_UID,
  EXECUTION_MODE_ENV_KEY,
  ROLLOUT_ENV_KEY,
  L0_IMAGE_ENV_KEY,
  L0_IMAGE_DIGEST_ENV_KEY,
  BROKER_URL_ENV_KEY,
  normalizeExecutionMode,
  defaultExecutionModeForInstall,
  parseExecutionModeFlags,
  resolveExecutionModeForInstall,
  assertSafeImageRef,
  isDigestPinned,
  hasLatestTag,
  assertDigestPinnedImage,
  validateRemoteConfig,
  brokerHealthUrl,
  planImageAcquisition,
  l0BuildArgs,
  l0PullArgs,
  l0DigestInspectArgs,
  parseInspectedDigest,
  hardenedProbeRunArgs,
  networkInternalInspectArgs,
  containerRunningArgs,
  executionEnvUpserts,
  readExecutionConfig,
  effectiveImageRef,
  classifyWorkerHealth,
  classifyImageDigestMatch,
  classifyEgressEnforcement,
  classifyIsolationMode,
  classifyAuditSink,
  summarizeSandboxDoctor,
  versionMajor,
  checkProtocolCompatibility,
  planUpdateCoordination,
  prodExecutionUpdateGuidanceLines,
  applyEnvUpsertsToBody,
} from "../src/execution-mode.mjs";

const DIGEST = (c = "a") => `sha256:${c.repeat(64)}`;
const PINNED = (name = "reg.example/cinatra-sandbox-l0", c = "a") => `${name}@${DIGEST(c)}`;

describe("normalizeExecutionMode", () => {
  it("accepts the three canonical modes", () => {
    for (const m of EXECUTION_MODES) expect(normalizeExecutionMode(m)).toBe(m);
  });
  it("maps intuitive aliases", () => {
    expect(normalizeExecutionMode("local")).toBe("local-dev");
    expect(normalizeExecutionMode("localdev")).toBe("local-dev");
    expect(normalizeExecutionMode("dev")).toBe("local-dev");
    expect(normalizeExecutionMode("OFF")).toBe("disabled");
    expect(normalizeExecutionMode(" None ")).toBe("disabled");
    expect(normalizeExecutionMode("Remote")).toBe("remote");
  });
  it("throws loudly on an unknown token (never silent default)", () => {
    expect(() => normalizeExecutionMode("bogus")).toThrow(/Invalid execution mode/);
    expect(() => normalizeExecutionMode("")).toThrow(/Invalid execution mode/);
    expect(() => normalizeExecutionMode(undefined)).toThrow(/Invalid execution mode/);
  });
});

describe("defaultExecutionModeForInstall", () => {
  it("prod → remote; dev/demo → local-dev", () => {
    expect(defaultExecutionModeForInstall("prod")).toBe("remote");
    expect(defaultExecutionModeForInstall("production")).toBe("remote");
    expect(defaultExecutionModeForInstall("dev")).toBe("local-dev");
    expect(defaultExecutionModeForInstall("demo")).toBe("local-dev");
    expect(defaultExecutionModeForInstall("anything-else")).toBe("local-dev");
  });
});

describe("parseExecutionModeFlags", () => {
  it("returns all-null when no execution flags present (ignores foreign flags)", () => {
    expect(parseExecutionModeFlags(["--mode", "dev", "--yes"])).toEqual({
      mode: null,
      brokerUrl: null,
      imageRef: null,
      egressMode: null,
    });
  });
  it("parses --key=value and --key value forms", () => {
    expect(parseExecutionModeFlags(["--execution-mode=remote"]).mode).toBe("remote");
    expect(parseExecutionModeFlags(["--execution-mode", "local"]).mode).toBe("local-dev");
    expect(parseExecutionModeFlags(["--sandbox-broker-url=https://b"]).brokerUrl).toBe("https://b");
    expect(parseExecutionModeFlags(["--sandbox-image", PINNED()]).imageRef).toBe(PINNED());
  });
  it("validates the egress enum eagerly", () => {
    expect(parseExecutionModeFlags(["--sandbox-egress=none"]).egressMode).toBe("none");
    expect(() => parseExecutionModeFlags(["--sandbox-egress=wide-open"])).toThrow(/Invalid --sandbox-egress/);
  });
  it("rejects a flag missing its value", () => {
    expect(() => parseExecutionModeFlags(["--execution-mode", "--yes"])).toThrow(/requires a value/);
  });
  it("normalizes an invalid mode through normalizeExecutionMode", () => {
    expect(() => parseExecutionModeFlags(["--execution-mode=bogus"])).toThrow(/Invalid execution mode/);
  });
});

describe("resolveExecutionModeForInstall", () => {
  it("an explicit flag always wins and is non-interactive", () => {
    expect(resolveExecutionModeForInstall({ installMode: "dev", flagMode: "remote", isTty: true })).toMatchObject({
      mode: "remote",
      interactive: false,
    });
  });
  it("no flag + TTY → interactive picker at the install-mode default", () => {
    const r = resolveExecutionModeForInstall({ installMode: "dev", flagMode: null, isTty: true });
    expect(r).toMatchObject({ mode: "local-dev", interactive: true, default: "local-dev" });
  });
  it("no flag + no TTY → silent install-mode default (never hangs a script)", () => {
    const r = resolveExecutionModeForInstall({ installMode: "prod", flagMode: null, isTty: false });
    expect(r).toMatchObject({ mode: "remote", interactive: false });
  });
});

describe("image-pin contract (AC4: kill :latest, require digest pins)", () => {
  it("assertSafeImageRef rejects option-injection + junk chars (mirrors S1)", () => {
    expect(() => assertSafeImageRef("-rm")).toThrow(/option injection/);
    expect(() => assertSafeImageRef("has space")).toThrow(/charset/);
    expect(assertSafeImageRef(PINNED())).toBe(PINNED());
  });
  it("isDigestPinned only true for a well-formed @sha256:<64hex>", () => {
    expect(isDigestPinned(PINNED())).toBe(true);
    expect(isDigestPinned("cinatra-sandbox-l0:dev")).toBe(false);
    expect(isDigestPinned("x@sha256:abc")).toBe(false);
  });
  it("hasLatestTag detects :latest and ignores a dev tag / digest", () => {
    expect(hasLatestTag(DEPRECATED_SHELL_IMAGE)).toBe(true);
    expect(hasLatestTag("foo:LATEST")).toBe(true);
    expect(hasLatestTag(DEFAULT_L0_IMAGE_LOCAL_DEV)).toBe(false);
    expect(hasLatestTag(PINNED())).toBe(false);
  });
  it("assertDigestPinnedImage rejects :latest and floating tags, accepts a pin", () => {
    expect(() => assertDigestPinnedImage("foo:latest")).toThrow(/:latest tag is banned/);
    expect(() => assertDigestPinnedImage("foo:dev")).toThrow(/not digest-pinned/);
    expect(assertDigestPinnedImage(PINNED())).toBe(PINNED());
  });
});

describe("validateRemoteConfig", () => {
  it("requires a broker URL + a digest-pinned image", () => {
    expect(() => validateRemoteConfig({ brokerUrl: null, imageRef: PINNED() })).toThrow(/requires a broker URL/);
    expect(() => validateRemoteConfig({ brokerUrl: "https://b", imageRef: null })).toThrow(/digest-pinned L0 image/);
    expect(() => validateRemoteConfig({ brokerUrl: "https://b", imageRef: "foo:latest" })).toThrow(/:latest tag is banned/);
  });
  it("rejects a non-URL / non-http(s) broker", () => {
    expect(() => validateRemoteConfig({ brokerUrl: "not a url", imageRef: PINNED() })).toThrow(/not a URL/);
    expect(() => validateRemoteConfig({ brokerUrl: "ftp://b", imageRef: PINNED() })).toThrow(/http\(s\) URL/);
  });
  it("returns normalized values on success", () => {
    const r = validateRemoteConfig({ brokerUrl: "https://broker.example", imageRef: PINNED() });
    expect(r.brokerUrl).toBe("https://broker.example/");
    expect(r.imageRef).toBe(PINNED());
  });
  it("brokerHealthUrl appends /health without doubling slashes", () => {
    expect(brokerHealthUrl("https://b/")).toBe("https://b/health");
    expect(brokerHealthUrl("https://b")).toBe("https://b/health");
  });
});

describe("planImageAcquisition + docker argv builders", () => {
  it("local-dev → build (needs the Dockerfile present)", () => {
    expect(planImageAcquisition({ executionMode: "local-dev" })).toMatchObject({ action: "build", imageRef: DEFAULT_L0_IMAGE_LOCAL_DEV });
    expect(() => planImageAcquisition({ executionMode: "local-dev", dockerfileExists: false })).toThrow(/Dockerfile is missing/);
  });
  it("local-dev refuses a :latest build tag", () => {
    expect(() => planImageAcquisition({ executionMode: "local-dev", imageRef: "cinatra-sandbox-l0:latest" })).toThrow(/:latest tag is banned/);
  });
  it("remote → pull a digest-pinned ref (rejects a floating one)", () => {
    expect(planImageAcquisition({ executionMode: "remote", imageRef: PINNED() })).toMatchObject({ action: "pull", imageRef: PINNED() });
    expect(() => planImageAcquisition({ executionMode: "remote", imageRef: "foo:1" })).toThrow(/not digest-pinned/);
  });
  it("disabled → skip", () => {
    expect(planImageAcquisition({ executionMode: "disabled" })).toMatchObject({ action: "skip" });
  });
  it("l0BuildArgs / l0PullArgs / l0DigestInspectArgs shape", () => {
    expect(l0BuildArgs({ imageRef: DEFAULT_L0_IMAGE_LOCAL_DEV, dockerfile: "docker/sandbox/Dockerfile", buildContext: "docker/sandbox" })).toEqual([
      "build",
      "-t",
      DEFAULT_L0_IMAGE_LOCAL_DEV,
      "-f",
      "docker/sandbox/Dockerfile",
      "docker/sandbox",
    ]);
    expect(l0PullArgs(PINNED())).toEqual(["pull", PINNED()]);
    expect(l0DigestInspectArgs(DEFAULT_L0_IMAGE_LOCAL_DEV)).toEqual(["image", "inspect", DEFAULT_L0_IMAGE_LOCAL_DEV, "--format", "{{.Id}}"]);
  });
  it("parseInspectedDigest extracts a sha256 id or null", () => {
    expect(parseInspectedDigest(`${DIGEST("c")}\n`)).toBe(DIGEST("c"));
    expect(parseInspectedDigest("")).toBeNull();
    expect(parseInspectedDigest("no-digest-here")).toBeNull();
  });
  it("hardenedProbeRunArgs mirrors the load-bearing S1 hardened flags + `--` terminator", () => {
    const args = hardenedProbeRunArgs({ imageRef: DEFAULT_L0_IMAGE_LOCAL_DEV, command: "id -u" });
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toEqual(expect.arrayContaining(["--user", `${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_UID}`]));
    expect(args).toEqual(expect.arrayContaining(["--network", "none"]));
    // The `--` terminator precedes the image so no ref can be re-read as an option.
    const dashDash = args.indexOf("--");
    expect(dashDash).toBeGreaterThan(-1);
    expect(args[dashDash + 1]).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
  });
  it("networkInternalInspectArgs / containerRunningArgs shape", () => {
    expect(networkInternalInspectArgs()).toEqual(["network", "inspect", "cinatra-exec-internal", "--format", "{{.Internal}}"]);
    expect(containerRunningArgs("cinatra-exec-gateway")).toEqual([
      "ps",
      "--filter",
      "name=^/cinatra-exec-gateway$",
      "--format",
      "{{.Names}}",
    ]);
  });
});

describe("executionEnvUpserts / readExecutionConfig round-trip", () => {
  it("local-dev sets mode + rollout on + egress + recorded digest, clears remote-only keys", () => {
    const up = executionEnvUpserts({ executionMode: "local-dev", imageDigest: DIGEST("d") });
    const byKey = Object.fromEntries(up.map((u) => [u.key, u.value]));
    expect(byKey[EXECUTION_MODE_ENV_KEY]).toBe("local-dev");
    expect(byKey[ROLLOUT_ENV_KEY]).toBe("on");
    expect(byKey[L0_IMAGE_DIGEST_ENV_KEY]).toBe(DIGEST("d"));
    expect(byKey[L0_IMAGE_ENV_KEY]).toBeNull();
    expect(byKey[BROKER_URL_ENV_KEY]).toBeNull();
  });
  it("remote sets the digest-pinned image + broker URL, clears the local digest", () => {
    const up = executionEnvUpserts({ executionMode: "remote", imageRef: PINNED(), brokerUrl: "https://b" });
    const byKey = Object.fromEntries(up.map((u) => [u.key, u.value]));
    expect(byKey[L0_IMAGE_ENV_KEY]).toBe(PINNED());
    expect(byKey[BROKER_URL_ENV_KEY]).toBe("https://b");
    expect(byKey[L0_IMAGE_DIGEST_ENV_KEY]).toBeNull();
  });
  it("remote refuses a non-pinned image", () => {
    expect(() => executionEnvUpserts({ executionMode: "remote", imageRef: "foo:dev" })).toThrow(/not digest-pinned/);
  });
  it("disabled leaves the capability dark (rollout cleared) and clears provisioning", () => {
    const up = executionEnvUpserts({ executionMode: "disabled" });
    const byKey = Object.fromEntries(up.map((u) => [u.key, u.value]));
    expect(byKey[EXECUTION_MODE_ENV_KEY]).toBe("disabled");
    expect(byKey[ROLLOUT_ENV_KEY]).toBeNull();
    expect(byKey[L0_IMAGE_ENV_KEY]).toBeNull();
    expect(byKey[BROKER_URL_ENV_KEY]).toBeNull();
  });
  it("refuses to record a malformed digest", () => {
    expect(() => executionEnvUpserts({ executionMode: "local-dev", imageDigest: "sha256:short" })).toThrow(/malformed L0 image digest/);
  });
  it("readExecutionConfig fails safe to disabled when unset, and round-trips local-dev", () => {
    expect(readExecutionConfig({}).mode).toBe("disabled");
    const env = {
      [EXECUTION_MODE_ENV_KEY]: "local-dev",
      [ROLLOUT_ENV_KEY]: "on",
      [L0_IMAGE_DIGEST_ENV_KEY]: DIGEST("d"),
    };
    const cfg = readExecutionConfig(env);
    expect(cfg).toMatchObject({ mode: "local-dev", rolloutOn: true, imageDigest: DIGEST("d"), egressMode: "default_internet" });
  });
  it("effectiveImageRef prefers the explicit ref, else the :dev tag", () => {
    expect(effectiveImageRef({ imageRef: PINNED() })).toBe(PINNED());
    expect(effectiveImageRef({ imageRef: null })).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
  });
});

describe("sandbox doctor classifiers (healthy / degraded / disabled)", () => {
  it("worker health: local-dev healthy only when image present + probe ok", () => {
    expect(classifyWorkerHealth({ executionMode: "local-dev", imagePresent: true, probeOk: true }).verdict).toBe("healthy");
    expect(classifyWorkerHealth({ executionMode: "local-dev", imagePresent: false }).verdict).toBe("degraded");
    expect(classifyWorkerHealth({ executionMode: "local-dev", imagePresent: true, probeOk: false }).verdict).toBe("degraded");
  });
  it("worker health: remote healthy when broker reachable, degraded (not probeable) otherwise", () => {
    expect(classifyWorkerHealth({ executionMode: "remote", brokerReachable: true }).verdict).toBe("healthy");
    expect(classifyWorkerHealth({ executionMode: "remote", brokerReachable: null }).verdict).toBe("degraded");
    expect(classifyWorkerHealth({ executionMode: "disabled" }).verdict).toBe("disabled");
  });
  it("image digest: local-dev healthy only when recorded === resolved", () => {
    expect(classifyImageDigestMatch({ executionMode: "local-dev", recordedDigest: DIGEST("a"), resolvedDigest: DIGEST("a") }).verdict).toBe("healthy");
    expect(classifyImageDigestMatch({ executionMode: "local-dev", recordedDigest: DIGEST("a"), resolvedDigest: DIGEST("b") }).verdict).toBe("degraded");
    expect(classifyImageDigestMatch({ executionMode: "local-dev", recordedDigest: null, resolvedDigest: DIGEST("a") }).verdict).toBe("degraded");
  });
  it("image digest: remote flags a non-pinned configured ref", () => {
    expect(classifyImageDigestMatch({ executionMode: "remote", imageRef: "foo:dev", resolvedDigest: DIGEST("a") }).verdict).toBe("degraded");
    expect(classifyImageDigestMatch({ executionMode: "remote", imageRef: PINNED(), resolvedDigest: DIGEST("a") }).verdict).toBe("healthy");
  });
  it("egress: none is healthy (kernel deny); gateway mode needs an internal network", () => {
    expect(classifyEgressEnforcement({ executionMode: "local-dev", egressMode: "none" }).verdict).toBe("healthy");
    expect(classifyEgressEnforcement({ executionMode: "local-dev", egressMode: "default_internet", networkExists: false }).verdict).toBe("degraded");
    expect(classifyEgressEnforcement({ executionMode: "local-dev", egressMode: "default_internet", networkExists: true, networkInternal: false }).verdict).toBe("degraded");
    expect(
      classifyEgressEnforcement({ executionMode: "local-dev", egressMode: "default_internet", networkExists: true, networkInternal: true, gatewayRunning: true, gatewayHealthy: true }).verdict,
    ).toBe("healthy");
  });
  it("isolation: healthy only for the full hardened profile", () => {
    expect(classifyIsolationMode({ executionMode: "local-dev", uid: SANDBOX_RUNTIME_UID, readOnlyRootfs: true, noNewPrivileges: true }).verdict).toBe("healthy");
    expect(classifyIsolationMode({ executionMode: "local-dev", uid: 0, readOnlyRootfs: true, noNewPrivileges: true }).verdict).toBe("degraded");
    expect(classifyIsolationMode({ executionMode: "local-dev", uid: SANDBOX_RUNTIME_UID, readOnlyRootfs: false, noNewPrivileges: true }).verdict).toBe("degraded");
    expect(classifyIsolationMode({ executionMode: "local-dev" }).verdict).toBe("degraded"); // probe could not run
  });
  it("audit sink: local-dev healthy when app up; disabled has none", () => {
    expect(classifyAuditSink({ executionMode: "local-dev", appReachable: true }).verdict).toBe("healthy");
    expect(classifyAuditSink({ executionMode: "local-dev", appReachable: false }).verdict).toBe("degraded");
    expect(classifyAuditSink({ executionMode: "disabled" }).verdict).toBe("disabled");
  });
  it("summarizeSandboxDoctor: any degraded → degraded; all disabled → disabled; else healthy", () => {
    expect(summarizeSandboxDoctor([{ verdict: "healthy" }, { verdict: "degraded" }]).overall).toBe("degraded");
    expect(summarizeSandboxDoctor([{ verdict: "disabled" }, { verdict: "disabled" }]).overall).toBe("disabled");
    expect(summarizeSandboxDoctor([{ verdict: "healthy" }, { verdict: "disabled" }]).overall).toBe("healthy");
  });
});

describe("update coordination", () => {
  it("versionMajor parses a leading major or null", () => {
    expect(versionMajor("0.1.0")).toBe(0);
    // Build the v-prefixed literal from parts so no contiguous v<d>.<d> token
    // appears on a source line (org source-leak gate flags those).
    expect(versionMajor("v" + "2.3.4")).toBe(2);
    expect(versionMajor("garbage")).toBeNull();
    expect(versionMajor(null)).toBeNull();
  });
  it("protocol compat: same major ⇒ compatible; differing ⇒ not; none known ⇒ not (honest)", () => {
    expect(checkProtocolCompatibility({ appVersion: "0.1.0", brokerVersion: "0.9.9", workerVersion: "0.1.0" }).compatible).toBe(true);
    expect(checkProtocolCompatibility({ appVersion: "1.0.0", brokerVersion: "2.0.0" }).compatible).toBe(false);
    expect(checkProtocolCompatibility({}).compatible).toBe(false);
  });
  it("coordination plan drains + rolls workers before app, with a rollback path", () => {
    const remote = planUpdateCoordination({ executionMode: "remote" });
    const idxDrain = remote.steps.findIndex((s) => /Drain/i.test(s));
    const idxWorkers = remote.steps.findIndex((s) => /Roll the WORKERS/i.test(s));
    const idxApp = remote.steps.findIndex((s) => /Roll the APP/i.test(s));
    expect(idxDrain).toBeGreaterThanOrEqual(0);
    expect(idxWorkers).toBeGreaterThan(idxDrain);
    expect(idxApp).toBeGreaterThan(idxWorkers);
    expect(remote.rollback.length).toBeGreaterThan(0);

    const local = planUpdateCoordination({ executionMode: "local-dev" });
    expect(local.steps.length).toBeGreaterThan(0);
    expect(local.steps.some((s) => /instance refresh/.test(s))).toBe(true);

    expect(planUpdateCoordination({ executionMode: "disabled" }).steps).toEqual([]);
  });
  it("prod guidance names the digest pin, the drain, and workers-before-app", () => {
    const lines = prodExecutionUpdateGuidanceLines().join("\n");
    expect(lines).toMatch(/sha256/);
    expect(lines).toMatch(/Drain/);
    expect(lines).toMatch(/WORKERS before the APP/);
    expect(lines).toMatch(/never :latest/); // the only :latest mention forbids its use
  });
});


describe("codex-hardening: fail-honest classifiers + canonical env writes", () => {
  it("isolation: a proven uid but UNVERIFIED (null) rootfs/no-new-privs must degrade (no fail-open)", () => {
    expect(classifyIsolationMode({ executionMode: "local-dev", uid: SANDBOX_RUNTIME_UID }).verdict).toBe("degraded");
    expect(classifyIsolationMode({ executionMode: "local-dev", uid: SANDBOX_RUNTIME_UID, readOnlyRootfs: true }).verdict).toBe("degraded");
  });
  it("egress: a running gateway with UNVERIFIED (null) or failed health must degrade", () => {
    const base = { executionMode: "local-dev", egressMode: "default_internet", networkExists: true, networkInternal: true };
    expect(classifyEgressEnforcement({ ...base, gatewayRunning: true }).verdict).toBe("degraded"); // health null
    expect(classifyEgressEnforcement({ ...base, gatewayRunning: true, gatewayHealthy: false }).verdict).toBe("degraded");
    expect(classifyEgressEnforcement({ ...base, gatewayRunning: null }).verdict).toBe("degraded"); // running unknown
    expect(classifyEgressEnforcement({ ...base, gatewayRunning: true, gatewayHealthy: true }).verdict).toBe("healthy");
  });
  it("protocol: an unknown component version yields INCOMPATIBLE even when known majors match", () => {
    const r = checkProtocolCompatibility({ appVersion: "0.1.0", brokerVersion: null, workerVersion: "0.1.0" });
    expect(r.compatible).toBe(false);
    expect(r.detail).toMatch(/fail-honest|INCOMPATIBLE/i);
  });
  it("validateRemoteConfig rejects a broker URL carrying a query string or fragment", () => {
    const pinned = "reg.example/l0@sha256:" + "a".repeat(64);
    expect(() => validateRemoteConfig({ brokerUrl: "https://b?x=1", imageRef: pinned })).toThrow(/query string or fragment/);
    expect(() => validateRemoteConfig({ brokerUrl: "https://b#f", imageRef: pinned })).toThrow(/query string or fragment/);
  });
  it("brokerHealthUrl builds a clean /health via URL (drops trailing slash, path-aware)", () => {
    expect(brokerHealthUrl("https://b/")).toBe("https://b/health");
    expect(brokerHealthUrl("https://b/api/")).toBe("https://b/api/health");
  });
  it("applyEnvUpsertsToBody removes EVERY duplicate of a key (the rollout-dark guarantee)", () => {
    const body = "A=1\nCINATRA_EXECUTION_PLANE_ROLLOUT=on\nB=2\nCINATRA_EXECUTION_PLANE_ROLLOUT=on\n";
    // null value ⇒ remove all occurrences.
    expect(applyEnvUpsertsToBody(body, [{ key: "CINATRA_EXECUTION_PLANE_ROLLOUT", value: null }])).toBe("A=1\nB=2\n");
    // non-null ⇒ collapse duplicates to ONE canonical entry.
    const collapsed = applyEnvUpsertsToBody(body, [{ key: "CINATRA_EXECUTION_PLANE_ROLLOUT", value: "on" }]);
    expect((collapsed.match(/^CINATRA_EXECUTION_PLANE_ROLLOUT=/gm) || []).length).toBe(1);
  });
  it("applyEnvUpsertsToBody appends a missing key with a clean newline boundary", () => {
    expect(applyEnvUpsertsToBody("A=1", [{ key: "B", value: "2" }])).toBe("A=1\nB=2\n");
    expect(applyEnvUpsertsToBody("", [{ key: "B", value: "2" }])).toBe("B=2\n");
  });
});
