// cinatra-cli#295 — `--pin-extension <owner>/<repo>@<sha>`: a preview built with
// ONE extension pinned at a given commit.
//
// HERMETIC like tests/preview.test.mjs: no docker, git or network. The build
// context is a temp directory the injected `prepareContext` writes; the fake
// docker READS that context at `docker build` time, so the assertions are about
// what the image would really have been built from. The app commit's locks come
// from an injected `readFileAtSha`, the pinned commit's description from an
// injected `describePinnedCommit`.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerComposeOwnership } from "./helpers/fake-compose-ownership.mjs";
import { __test as P } from "../src/preview.mjs";
import { __test as F } from "../src/install-preview.mjs";
import { parseInstallArgs } from "../src/install.mjs";

const SHA_A = "a".repeat(40); // the app commit
const SHA_B = "b".repeat(40); // a second app commit (refresh)
const PACK_HEAD = "1234567890abcdef1234567890abcdef12345678"; // the pack PR head
const PACK_HEAD_2 = "fedcba0987654321fedcba0987654321fedcba09";
const OLD_PACK = "0".repeat(40);
const TREE = "c".repeat(64);
const KEY_64 = "00000000000000000000000000000000000000000000000000000000000000e2";
const REQ = "cinatra-required-extensions.lock.json";
const DEV = "cinatra-dev-extensions.lock.json";

const lockText = (packages) => JSON.stringify({ note: "fixture", schemaVersion: 1, packages }, null, 2) + "\n";
const REQUIRED_LOCK = lockText([
  { packageName: "@cinatra-ai/audio-artifact", repo: "cinatra-ai/audio-artifact", resolvedSha: "1".repeat(40), packageVersion: "0.1.1", treeSha256: "d".repeat(64) },
  { packageName: "@cinatra-ai/pdf-artifact", repo: "cinatra-ai/pdf-artifact", resolvedSha: OLD_PACK, packageVersion: "0.1.0", treeSha256: "e".repeat(64) },
]);
const DEV_LOCK = lockText([
  { packageName: "@cinatra-ai/apify-connector", repo: "cinatra-ai/apify-connector", resolvedSha: "2".repeat(40) },
  { packageName: "@cinatra-ai/blog-connector", repo: "cinatra-ai/blog-connector", resolvedSha: "3".repeat(40) },
]);
const DOCKERFILE = "FROM scratch\n";

let tmp;
let registryPath;
let checkoutDir;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "cinatra-preview-pin-"));
  registryPath = path.join(tmp, "previews.json");
  checkoutDir = path.join(tmp, "checkout");
  mkdirSync(checkoutDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(state = {}) {
  const calls = [];
  const built = [];
  state.locks ??= { [REQ]: REQUIRED_LOCK, [DEV]: DEV_LOCK };
  state.described ??= [];
  state.lockReads ??= [];
  const runDocker = (args) => {
    calls.push(args);
    const ownership = answerComposeOwnership(args, state);
    if (ownership) return ownership;
    const [verb, sub] = args;
    if (verb === "volume" && String(args.at(-1)).startsWith("cinatra-preview-artifacts-")) {
      const name = args.at(-1);
      const slug = name.slice("cinatra-preview-artifacts-".length);
      if (sub === "create") return { status: 0, stdout: name, stderr: "" };
      if (sub === "inspect") {
        return {
          status: 0,
          stdout: JSON.stringify([{ Name: name, Driver: "local", Labels: { [P.ARTIFACT_VOLUME_OWNER_LABEL]: slug } }]),
          stderr: "",
        };
      }
    }
    if (verb === "container" && sub === "inspect" && args.includes("{{json .}}")) {
      const slug = args.at(-1).slice("cinatra-preview-".length);
      return {
        status: 0,
        stdout: JSON.stringify({
          Mounts: [{ Type: "volume", Name: P.previewArtifactVolumeName(slug), Destination: "/data/artifacts", RW: true }],
          Config: { Env: ["CINATRA_ARTIFACT_DATA_ROOT=/data/artifacts"] },
        }),
        stderr: "",
      };
    }
    if (verb === "build") {
      // What the image would be built from: every file of the context, read NOW.
      const ctx = args.at(-1);
      const files = Object.fromEntries(readdirSync(ctx).map((f) => [f, readFileSync(path.join(ctx, f), "utf8")]));
      built.push({ args, files });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (verb === "run" && sub === "-d") {
      state.containerRunning = true;
      return { status: 0, stdout: "deadbeef\n", stderr: "" };
    }
    if (verb === "container" && sub === "inspect") {
      const running = Boolean(state.containerRunning);
      return { status: running ? 0 : 1, stdout: running ? "true\n" : "", stderr: running ? "" : "No such object" };
    }
    if (verb === "volume" && sub === "inspect") {
      return { status: 1, stdout: "", stderr: `Error response from daemon: get ${args.at(-1)}: no such volume` };
    }
    if (verb === "image" && sub === "inspect") {
      const stamp = state.images?.[args.at(-1)];
      if (stamp === undefined) return { status: 1, stdout: "", stderr: `Error: No such image: ${args.at(-1)}` };
      return { status: 0, stdout: `${stamp}\n`, stderr: "" };
    }
    if (verb === "logs") return { status: 0, stdout: "log tail", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const deps = {
    registryPath,
    checkoutDir,
    env: { [P.ENCRYPTION_KEY_ENV]: KEY_64 },
    buildControlEnv: { [P.PREVIEW_BUILD_CACHE_ENV]: "off" },
    log: () => {},
    logError: () => {},
    now: () => 1000,
    sleep: async () => {},
    resolveSha: (ref) => state.shaForRef?.[ref] ?? SHA_A,
    // The build context: a fresh directory holding the app commit's two locks
    // and one other file, exactly as a worktree at the commit would.
    prepareContext: () => {
      const contextDir = mkdtempSync(path.join(tmp, "ctx-"));
      for (const [file, text] of Object.entries(state.locks)) if (text != null) writeFileSync(path.join(contextDir, file), text);
      writeFileSync(path.join(contextDir, "Dockerfile"), DOCKERFILE);
      return { contextDir, cleanup: () => {} };
    },
    readFileAtSha: ({ sha, file }) => {
      state.lockReads.push({ sha, file });
      return state.locks[file] ?? null;
    },
    describePinnedCommit: async ({ repo, sha }) => {
      state.described.push(`${repo}@${sha}`);
      return state.description ?? { treeSha256: TREE, packageName: "@cinatra-ai/pdf-artifact", packageVersion: "0.2.0" };
    },
    probeHealth: async () => ({ status: 200, body: '{"status":"ok"}' }),
    probePort: async () => true,
    runDocker,
  };
  return { deps, calls, built, state };
}

const readRow = (slug) => JSON.parse(readFileSync(registryPath, "utf8")).previews[slug];

/** The indexes of the lines that differ between two texts of equal length. */
function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.map((line, i) => (line === b[i] ? null : [line.trim(), b[i].trim()])).filter(Boolean);
}

describe("cinatra-cli#295 — the --pin-extension flag", () => {
  it("parses both spellings to one canonical pin, and reads an absent flag as no pin", () => {
    expect(P.resolvePinExtension(["--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD}`])).toEqual({
      repo: "cinatra-ai/pdf-artifact",
      sha: PACK_HEAD,
      id: `cinatra-ai/pdf-artifact@${PACK_HEAD}`,
    });
    expect(P.resolvePinExtension([`--pin-extension=Cinatra-AI/PDF-Artifact@${PACK_HEAD}`]).id).toBe(
      `cinatra-ai/pdf-artifact@${PACK_HEAD}`,
    );
    expect(P.resolvePinExtension(["--slug", "x"])).toBe(null);
  });

  it("refuses a sha that is not 40 hex, a malformed repository, a bare flag and a repeated flag", () => {
    expect(() => P.resolvePinExtension(["--pin-extension", "cinatra-ai/pdf-artifact@1234567"])).toThrow(/40-hex/);
    expect(() => P.resolvePinExtension(["--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD.toUpperCase()}`])).toThrow(/40-hex/);
    expect(() => P.resolvePinExtension(["--pin-extension", "cinatra-ai/pdf-artifact@main"])).toThrow(/40-hex/);
    expect(() => P.resolvePinExtension(["--pin-extension", `pdf-artifact@${PACK_HEAD}`])).toThrow(/<owner>\/<repo>@/);
    expect(() => P.resolvePinExtension(["--pin-extension"])).toThrow(/--pin-extension/);
    expect(() =>
      P.resolvePinExtension(["--pin-extension", `a/b@${PACK_HEAD}`, "--pin-extension", `a/c@${PACK_HEAD}`]),
    ).toThrow(/exactly one/);
  });
});

describe("cinatra-cli#295 — the build context carries exactly one change", () => {
  it("create: the required-lock entry takes the pinned sha, packageVersion and treeSha256; nothing else moves", async () => {
    const { deps, built, state } = makeDeps();
    await P.runPreviewCreate(["--slug", "pin", "--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD}`], deps);
    expect(built).toHaveLength(1);
    const { files } = built[0];
    expect(Object.keys(files).sort()).toEqual(["Dockerfile", DEV, REQ].sort());
    expect(files.Dockerfile).toBe(DOCKERFILE);
    expect(files[DEV]).toBe(DEV_LOCK);
    expect(changedLines(REQUIRED_LOCK, files[REQ])).toEqual([
      [`"resolvedSha": "${OLD_PACK}",`, `"resolvedSha": "${PACK_HEAD}",`],
      [`"packageVersion": "0.1.0",`, `"packageVersion": "0.2.0",`],
      [`"treeSha256": "${"e".repeat(64)}"`, `"treeSha256": "${TREE}"`],
    ]);
    // The locks were read at the APP commit, the pinned commit described once.
    expect(state.lockReads.every((r) => r.sha === SHA_A)).toBe(true);
    expect(state.described).toEqual([`cinatra-ai/pdf-artifact@${PACK_HEAD}`]);
  });

  it("create --fleet dev: a dev-lock entry takes only the pinned resolvedSha, and nothing is downloaded", async () => {
    const { deps, built, state } = makeDeps();
    await P.runPreviewCreate(
      ["--slug", "pin", "--fleet", "dev", "--pin-extension", `cinatra-ai/blog-connector@${PACK_HEAD}`],
      deps,
    );
    const { files } = built[0];
    expect(files[REQ]).toBe(REQUIRED_LOCK);
    expect(files.Dockerfile).toBe(DOCKERFILE);
    expect(changedLines(DEV_LOCK, files[DEV])).toEqual([
      [`"resolvedSha": "${"3".repeat(40)}"`, `"resolvedSha": "${PACK_HEAD}"`],
    ]);
    expect(state.described).toEqual([]);
  });

  it("refresh: a new pin moves the entry at the NEW app commit; a refresh without the flag keeps the row's pin", async () => {
    const { deps, built, state } = makeDeps();
    await P.runPreviewCreate(["--slug", "pin", "--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD}`], deps);
    state.shaForRef = { main: SHA_B };
    await P.runPreviewRefresh(["--slug", "pin", "--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD_2}`], deps);
    expect(built).toHaveLength(2);
    expect(changedLines(REQUIRED_LOCK, built[1].files[REQ])[0]).toEqual([
      `"resolvedSha": "${OLD_PACK}",`,
      `"resolvedSha": "${PACK_HEAD_2}",`,
    ]);
    expect(built[1].files[DEV]).toBe(DEV_LOCK);
    expect(state.lockReads.slice(-2).every((r) => r.sha === SHA_B)).toBe(true);
    expect(readRow("pin").pin).toBe(`cinatra-ai/pdf-artifact@${PACK_HEAD_2}`);

    await P.runPreviewRefresh(["--slug", "pin", "--rebuild"], deps);
    expect(built).toHaveLength(3);
    expect(changedLines(REQUIRED_LOCK, built[2].files[REQ])[0][1]).toBe(`"resolvedSha": "${PACK_HEAD_2}",`);
    expect(readRow("pin").pin).toBe(`cinatra-ai/pdf-artifact@${PACK_HEAD_2}`);
  });

  it("without the flag the build context is the app commit's, untouched (no lock read, no download)", async () => {
    const { deps, built, state } = makeDeps();
    await P.runPreviewCreate(["--slug", "plain"], deps);
    expect(built[0].files[REQ]).toBe(REQUIRED_LOCK);
    expect(built[0].files[DEV]).toBe(DEV_LOCK);
    expect(state.lockReads).toEqual([]);
    expect(state.described).toEqual([]);
    expect(readRow("plain")).not.toHaveProperty("pin");
  });
});

describe("cinatra-cli#295 — the tree hash is the acquire step's definition", () => {
  // An independent statement of the app's foldTreeHash
  // (packages/cli/src/prod-extension-acquisition.mjs): regular files sorted by
  // path, `<path>\n<100755|100644>\n<sha256>\n` each.
  const fold = (files) => {
    const h = createHash("sha256");
    for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      h.update(`${f.rel}\n${f.exec ? "100755" : "100644"}\n${createHash("sha256").update(f.body).digest("hex")}\n`);
    }
    return h.digest("hex");
  };

  it("foldTreeHash sorts by path and keys the mode on the owner-exec bit", () => {
    const recs = [
      { relPath: "src/b.mjs", executable: false, sha256: "1".repeat(64) },
      { relPath: "bin/run", executable: true, sha256: "2".repeat(64) },
    ];
    const want = createHash("sha256")
      .update(`bin/run\n100755\n${"2".repeat(64)}\nsrc/b.mjs\n100644\n${"1".repeat(64)}\n`)
      .digest("hex");
    expect(P.foldTreeHash(recs)).toBe(want);
    expect(P.foldTreeHash([...recs].reverse())).toBe(want);
  });

  it("a codeload-shaped tarball is described by its tree hash and its package.json name and version", async () => {
    const root = path.join(tmp, "pack");
    const top = path.join(root, "pdf-artifact-1234567");
    mkdirSync(path.join(top, "src"), { recursive: true });
    mkdirSync(path.join(top, "bin"), { recursive: true });
    const files = [
      { rel: "package.json", body: JSON.stringify({ name: "@cinatra-ai/pdf-artifact", version: "0.2.0" }), exec: false },
      { rel: "src/index.mjs", body: "export const x = 1;\n", exec: false },
      { rel: "bin/run", body: "#!/bin/sh\necho hi\n", exec: true },
    ];
    for (const f of files) {
      writeFileSync(path.join(top, f.rel), f.body);
      chmodSync(path.join(top, f.rel), f.exec ? 0o755 : 0o644);
    }
    const tgz = path.join(tmp, "pack.tgz");
    tar.c({ gzip: true, sync: true, file: tgz, cwd: root, portable: true }, ["pdf-artifact-1234567"]);
    const described = await P.describeExtensionTarball(readFileSync(tgz), { tar });
    expect(described).toEqual({
      treeSha256: fold(files),
      packageName: "@cinatra-ai/pdf-artifact",
      packageVersion: "0.2.0",
    });
  });
});

describe("cinatra-cli#295 — the pin refuses by name before any build", () => {
  const refuses = async (rest, pattern, setup = {}) => {
    const { deps, calls, state } = makeDeps(setup);
    await expect(P.runPreviewCreate(["--slug", "pin", ...rest], deps)).rejects.toThrow(pattern);
    expect(calls.some((c) => c[0] === "build")).toBe(false);
    expect(existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, "utf8")).previews.pin : undefined).toBeUndefined();
    return state;
  };

  it("a repository listed in no lock", async () => {
    await refuses(["--pin-extension", `example-org/no-such-pack@${PACK_HEAD}`], /listed in no extension lock/);
  });

  it("a repository listed more than once in one lock", async () => {
    const twice = lockText([
      { packageName: "@cinatra-ai/pdf-artifact", repo: "cinatra-ai/pdf-artifact", resolvedSha: OLD_PACK, packageVersion: "0.1.0", treeSha256: "e".repeat(64) },
      { packageName: "@cinatra-ai/pdf-artifact", repo: "Cinatra-AI/pdf-artifact", resolvedSha: OLD_PACK, packageVersion: "0.1.0", treeSha256: "e".repeat(64) },
    ]);
    await refuses(["--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD}`], /listed 2 times in cinatra-required/, {
      locks: { [REQ]: twice, [DEV]: DEV_LOCK },
    });
  });

  it("a repository listed in both locks", async () => {
    const both = lockText([{ packageName: "@cinatra-ai/pdf-artifact", repo: "cinatra-ai/pdf-artifact", resolvedSha: OLD_PACK }]);
    await refuses(["--pin-extension", `cinatra-ai/pdf-artifact@${PACK_HEAD}`], /listed in both/, {
      locks: { [REQ]: REQUIRED_LOCK, [DEV]: both },
    });
  });

  it("a sha that is not 40 hex", async () => {
    await refuses(["--pin-extension", "cinatra-ai/pdf-artifact@abc123"], /40-hex/);
  });

  it("a dev-lock entry while the fleet is not dev (and nothing is downloaded)", async () => {
    const state = await refuses(["--pin-extension", `cinatra-ai/blog-connector@${PACK_HEAD}`], /--fleet dev/);
    expect(state.described).toEqual([]);
  });

  it("refresh: a refused pin builds nothing and leaves the running preview's row as it was", async () => {
    const { deps, calls } = makeDeps();
    await P.runPreviewCreate(["--slug", "pin"], deps);
    const before = readRow("pin");
    const builds = calls.filter((c) => c[0] === "build").length;
    await expect(
      P.runPreviewRefresh(["--slug", "pin", "--pin-extension", `example-org/no-such-pack@${PACK_HEAD}`], deps),
    ).rejects.toThrow(/listed in no extension lock/);
    expect(calls.filter((c) => c[0] === "build").length).toBe(builds);
    expect(readRow("pin")).toEqual(before);
  });
});

describe("cinatra-cli#295 — the pin is part of the image's identity", () => {
  const PIN = `cinatra-ai/pdf-artifact@${PACK_HEAD}`;
  const OTHER = `cinatra-ai/pdf-artifact@${PACK_HEAD_2}`;

  it("the tag names the pin; no pin keeps the tag byte-for-byte", () => {
    expect(P.previewImageTag(SHA_A, "required", null)).toBe(`${P.PREVIEW_IMAGE_TAG_PREFIX}${SHA_A}`);
    const pinned = P.previewImageTag(SHA_A, "required", PIN);
    expect(pinned).toContain(PACK_HEAD.slice(0, 12));
    expect(pinned).not.toBe(P.previewImageTag(SHA_A, "required", null));
    expect(pinned).not.toBe(P.previewImageTag(SHA_A, "required", OTHER));
    expect(pinned).not.toBe(P.previewImageTag(SHA_A, "required", `example-org/other-pack@${PACK_HEAD}`));
    expect(pinned.length).toBeLessThanOrEqual("cinatra-preview:".length + 128);
  });

  it("the build is labelled with the pin and the registry row records it", async () => {
    const { deps, built } = makeDeps();
    const result = await P.runPreviewCreate(["--slug", "pin", "--pin-extension", PIN], deps);
    expect(result.tag).toBe(P.previewImageTag(SHA_A, "required", PIN));
    expect(built[0].args.join(" ")).toContain(`--label ${P.PIN_EXTENSION_LABEL}=${PIN}`);
    const row = readRow("pin");
    expect(row.pin).toBe(PIN);
    expect(row.imageTag).toBe(result.tag);
    expect(P.readRegistry(registryPath).status).toBe("ok");
  });

  it("an image at the pinned tag stamped with another pin, or none, is rebuilt; the same pin is reused", async () => {
    const tag = P.previewImageTag(SHA_A, "required", PIN);
    for (const stamp of [`${SHA_A} ${OTHER}`, SHA_A]) {
      const { deps, built } = makeDeps({ images: { [tag]: stamp } });
      await P.runPreviewCreate(["--slug", "pin", "--pin-extension", PIN], deps);
      expect(built).toHaveLength(1);
      rmSync(registryPath, { force: true });
    }
    const { deps, built } = makeDeps({ images: { [tag]: `${SHA_A} ${PIN}` } });
    await P.runPreviewCreate(["--slug", "pin", "--pin-extension", PIN], deps);
    expect(built).toHaveLength(0);
  });

  it("an image built without the pin at the same SHA is never reused for a pinned create", async () => {
    const { deps, built } = makeDeps({ images: { [P.previewImageTag(SHA_A)]: SHA_A } });
    await P.runPreviewCreate(["--slug", "pin", "--pin-extension", PIN], deps);
    expect(built).toHaveLength(1);
  });
});

describe("cinatra-cli#295 — install --mode preview forwards the pin", () => {
  const PIN = `cinatra-ai/pdf-artifact@${PACK_HEAD}`;

  it("previewPinExtensionArgs extracts both spellings and forwards nothing else", () => {
    expect(F.previewPinExtensionArgs({ rest: [] })).toEqual([]);
    expect(F.previewPinExtensionArgs({ rest: ["--fleet", "dev"] })).toEqual([]);
    expect(F.previewPinExtensionArgs({ rest: ["--pin-extension", PIN] })).toEqual(["--pin-extension", PIN]);
    expect(F.previewPinExtensionArgs({ rest: [`--pin-extension=${PIN}`] })).toEqual(["--pin-extension", PIN]);
    expect(F.previewPinExtensionArgs({ rest: ["--pin-extension"] })).toEqual(["--pin-extension", ""]);
  });

  it("the install arguments parse and validate it, preview-only", () => {
    expect(parseInstallArgs(["--mode", "preview", "--pin-extension", PIN]).previewPin).toBe(PIN);
    expect(parseInstallArgs(["--mode", "preview"]).previewPin).toBe(null);
    expect(parseInstallArgs(["--mode", "preview", "--pin-extension", PIN]).surfaceMode).toBe("preview");
    expect(() => parseInstallArgs(["--mode", "preview", "--pin-extension", "x@y"])).toThrow(/--pin-extension/);
    expect(() => parseInstallArgs(["--mode", "dev", "--pin-extension", PIN])).toThrow(/--mode preview/);
  });

  it("the front door's composed create carries the pin to the build", async () => {
    writeFileSync(path.join(checkoutDir, ".env.local"), "CINATRA_RUNTIME_MODE=development\n");
    const { deps, built } = makeDeps();
    deps.previewSecretsPath = path.join(tmp, "state", "preview-secrets.json");
    await F.runInstallPreviewBootstrap({
      targetDir: checkoutDir,
      ref: "main",
      rest: ["--pin-extension", PIN],
      log: () => {},
      deps,
    });
    expect(built).toHaveLength(1);
    expect(built[0].args.join(" ")).toContain(`${P.PIN_EXTENSION_LABEL}=${PIN}`);
    expect(changedLines(REQUIRED_LOCK, built[0].files[REQ])[0][1]).toBe(`"resolvedSha": "${PACK_HEAD}",`);
  });
});
