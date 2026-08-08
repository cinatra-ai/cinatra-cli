// Unit coverage for the `reset --purge-app-data` registry-user reconcile
// (cinatra-cli#208 — the un-done half of cinatra#2500).
//
// Two seams are covered here:
//   1. the PURE seam — which namespaces the purged database claims, and what an
//      `htpasswd` rewrite keeps vs. removes;
//   2. the ORCHESTRATION seam — `purgeLocalRegistryUsers` driven with a recording
//      fake transport, which proves the outcome matrix (including idempotence,
//      the mandatory post-rewrite restart, and the non-fatal failure paths)
//      without a container.
//
// The REAL proof that a removed entry actually unblocks re-onboarding — a live
// Verdaccio answering 401 before and 201 after — is the container E2E recorded
// on the PR. These tests pin the contract; they do not stand in for it. The
// restart these tests insist on is there BECAUSE of that E2E: the file rewrite
// alone left the running registry answering 401 from its merged in-memory copy.

import { describe, expect, it } from "vitest";

import {
  collectAppOwnedRegistryNamespaces,
  createComposeRegistryTransport,
  filterHtpasswdEntries,
  htpasswdUserName,
  parseMetadataRow,
  parseStoreRead,
  purgeLocalRegistryUsers,
  RESTART_READY_ATTEMPTS,
  STORE_CHANGED_EXIT,
  VERDACCIO_COMPOSE_SERVICE,
  VERDACCIO_HTPASSWD_PATH,
  VERDACCIO_HTPASSWD_SNAPSHOT_PATH,
  VERDACCIO_HTPASSWD_TMP_PATH,
} from "../src/purge-registry-users.mjs";

// A realistic store: the dev-seed publisher, this instance, a namespace it was
// renamed away from, a pending mint, and two throwaway users from e2e lanes.
const HTPASSWD_FIXTURE = [
  "cinatra-dev-seed:$apr1$aaaaaaaa$1111111111111111111111:autocreated 2026-08-01T10:00:00.000Z",
  "macbook-pro:$apr1$bbbbbbbb$2222222222222222222222:autocreated 2026-08-02T10:00:00.000Z",
  "macbook-pro-old:$apr1$cccccccc$3333333333333333333333:autocreated 2026-08-03T10:00:00.000Z",
  "macbook-pro-pending:$apr1$dddddddd$4444444444444444444444:autocreated 2026-08-04T10:00:00.000Z",
  "lane-2392-alpha:$apr1$eeeeeeee$5555555555555555555555:autocreated 2026-08-05T10:00:00.000Z",
  "lane-2392-beta:$apr1$ffffffff$6666666666666666666666:autocreated 2026-08-06T10:00:00.000Z",
  "",
].join("\n");

const IDENTITY_ROW = {
  instanceNamespace: "macbook-pro",
  instanceDisplayName: "MacBook Pro",
  oldInstanceNamespaces: [
    { name: "macbook-pro-old", frozenAt: "2026-08-03T10:00:00.000Z" },
  ],
};

const PENDING_ROW = {
  instanceNamespace: "macbook-pro-pending",
  mintedAt: "2026-08-04T10:00:00.000Z",
};

// Command shapes, matched by role rather than by literal, so the tests describe
// intent and the module owns the exact syntax.
const isProbe = (c) => c === "printf ready";
const isRead = (c) => c.startsWith("if [ -f") && c.includes("cp '");
const isVerify = (c) => c.startsWith("if [ -f") && !c.includes("cp '");
const isWrite = (c) => c.startsWith("cat > ");
const isCleanup = (c) => c.startsWith("rm -f");
const isReady = (c) => c.startsWith("node -e");
const isRestart = (c) => c === "<restart>";

/** What a healthy store read answers: the marker line, then the file. */
const storeRead = (contents) => ({ status: 0, stdout: `PRESENT\n${contents}` });
const storeAbsent = { status: 0, stdout: "ABSENT\n" };

/**
 * Recording fake for the container transport. `responses` maps a substring of
 * the shell command to the result it should produce; `restartStatus` drives the
 * service bounce. Every call is recorded in order.
 */
function fakeTransport({
  store = HTPASSWD_FIXTURE,
  readResult,
  writeResult,
  restartStatus = 0,
  readyAfter = 0,
  verifyResult,
} = {}) {
  const calls = [];
  let restarts = 0;
  let readyProbes = 0;
  return {
    calls,
    get restarts() { return restarts; },
    exec: ({ command, input }) => {
      calls.push({ command, input });
      if (isReady(command)) {
        // The post-restart readiness probe: pass once `readyAfter` misses are in.
        readyProbes += 1;
        return { status: readyProbes > readyAfter ? 0 : 1, stdout: "", stderr: "" };
      }
      if (isRead(command)) {
        return { stderr: "", ...(readResult ?? (store === null ? storeAbsent : storeRead(store))) };
      }
      if (isVerify(command)) {
        if (verifyResult) return { stderr: "", ...verifyResult };
        // By default the store reads back exactly as it was rewritten.
        const written = calls.find((call) => isWrite(call.command))?.input ?? "";
        return { status: 0, stdout: `PRESENT\n${written}`, stderr: "" };
      }
      if (isWrite(command)) return { status: 0, stdout: "", stderr: "", ...writeResult };
      return { status: 0, stdout: "", stderr: "" };
    },
    restart: () => {
      restarts += 1;
      calls.push({ command: "<restart>" });
      return { status: restartStatus, stdout: "", stderr: "" };
    },
  };
}

/** Never actually waits — the readiness ceiling is exercised, not the clock. */
const noSleep = async () => {};

function captureLines() {
  const lines = [];
  return { lines, sink: (line) => lines.push(line), get text() { return lines.join("\n"); } };
}

// ---------------------------------------------------------------------------
// Which namespaces the purged database claims
// ---------------------------------------------------------------------------

describe("collectAppOwnedRegistryNamespaces", () => {
  it("claims the live namespace, every renamed-away namespace, and a pending mint", () => {
    expect(
      collectAppOwnedRegistryNamespaces({ identity: IDENTITY_ROW, pendingProvision: PENDING_ROW }),
    ).toEqual(["macbook-pro", "macbook-pro-old", "macbook-pro-pending"]);
  });

  it("reads the legacy key spellings the app's own back-compat shim accepts", () => {
    expect(
      collectAppOwnedRegistryNamespaces({
        identity: { vendorName: "legacy-ns", oldVendorNames: [{ name: "legacy-old" }] },
      }),
    ).toEqual(["legacy-ns", "legacy-old"]);
  });

  it("de-duplicates and drops blank entries", () => {
    expect(
      collectAppOwnedRegistryNamespaces({
        identity: {
          instanceNamespace: " dup ",
          oldInstanceNamespaces: [{ name: "dup" }, { name: "" }, { name: null }, "dup"],
        },
      }),
    ).toEqual(["dup"]);
  });

  it("returns nothing for an absent row, a malformed row, or no argument at all", () => {
    expect(collectAppOwnedRegistryNamespaces()).toEqual([]);
    expect(collectAppOwnedRegistryNamespaces({ identity: null })).toEqual([]);
    expect(
      collectAppOwnedRegistryNamespaces({ identity: { oldInstanceNamespaces: "not-an-array" } }),
    ).toEqual([]);
  });
});

describe("parseMetadataRow", () => {
  it("parses the stored JSON string", () => {
    expect(parseMetadataRow('{"instanceNamespace":"ns"}')).toEqual({
      ok: true,
      value: { instanceNamespace: "ns" },
    });
  });

  it("passes an already-parsed object straight through", () => {
    const row = { instanceNamespace: "ns" };
    expect(parseMetadataRow(row)).toEqual({ ok: true, value: row });
  });

  // The app clears its pending-provision stash by writing literal JSON null, so
  // that shape is normal and means "no credential pending" — never a failure.
  it("accepts an absent row and a literal JSON null as the empty record", () => {
    expect(parseMetadataRow(null)).toEqual({ ok: true, value: null });
    expect(parseMetadataRow(undefined)).toEqual({ ok: true, value: null });
    expect(parseMetadataRow("null")).toEqual({ ok: true, value: null });
  });

  // A row that exists but is not a record could still name a minted registry
  // user, so it must be reported rather than read as "nothing recorded".
  it("refuses unparseable, empty, scalar and array values", () => {
    for (const raw of ["not json", "", "   ", '"a string"', "42", "[]", '[{"a":1}]', [], 7]) {
      expect(parseMetadataRow(raw)).toEqual({ ok: false });
    }
  });
});

// ---------------------------------------------------------------------------
// The htpasswd rewrite
// ---------------------------------------------------------------------------

describe("htpasswdUserName", () => {
  it("takes everything before the first colon", () => {
    expect(htpasswdUserName("alice:$apr1$x:autocreated 2026-01-01")).toBe("alice");
  });

  it("declares no user for blank lines and comments", () => {
    expect(htpasswdUserName("")).toBeNull();
    expect(htpasswdUserName("   ")).toBeNull();
    expect(htpasswdUserName("# a comment: with a colon")).toBeNull();
    expect(htpasswdUserName(":no-name")).toBeNull();
  });
});

describe("filterHtpasswdEntries", () => {
  it("removes only the listed users and keeps every other line", () => {
    const result = filterHtpasswdEntries(HTPASSWD_FIXTURE, [
      "macbook-pro",
      "macbook-pro-old",
      "macbook-pro-pending",
    ]);

    expect(result.changed).toBe(true);
    expect(result.removed).toEqual(["macbook-pro", "macbook-pro-old", "macbook-pro-pending"]);
    expect(result.remaining).toEqual(["cinatra-dev-seed", "lane-2392-alpha", "lane-2392-beta"]);
    expect(result.text).toBe(
      [
        "cinatra-dev-seed:$apr1$aaaaaaaa$1111111111111111111111:autocreated 2026-08-01T10:00:00.000Z",
        "lane-2392-alpha:$apr1$eeeeeeee$5555555555555555555555:autocreated 2026-08-05T10:00:00.000Z",
        "lane-2392-beta:$apr1$ffffffff$6666666666666666666666:autocreated 2026-08-06T10:00:00.000Z",
        "",
      ].join("\n"),
    );
  });

  it("matches the whole user name, never a prefix", () => {
    // "macbook-pro" must NOT take "macbook-pro-old" with it.
    const result = filterHtpasswdEntries(HTPASSWD_FIXTURE, ["macbook-pro"]);
    expect(result.removed).toEqual(["macbook-pro"]);
    expect(result.remaining).toContain("macbook-pro-old");
    expect(result.remaining).toContain("macbook-pro-pending");
  });

  it("reports no change when nothing listed is present", () => {
    const result = filterHtpasswdEntries(HTPASSWD_FIXTURE, ["never-registered"]);
    expect(result.changed).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.text).toContain("macbook-pro:");
  });

  it("keeps comments and normalizes the trailing newline", () => {
    const result = filterHtpasswdEntries("# header\n\nalice:hash\n\nbob:hash\n\n", ["bob"]);
    expect(result.text).toBe("# header\nalice:hash\n");
  });

  it("produces an empty file when every user is removed", () => {
    const result = filterHtpasswdEntries("alice:hash\n", ["alice"]);
    expect(result.text).toBe("");
    expect(result.remaining).toEqual([]);
  });

  it("survives an empty or absent store", () => {
    expect(filterHtpasswdEntries("", ["alice"]).changed).toBe(false);
    expect(filterHtpasswdEntries(undefined, ["alice"]).text).toBe("");
  });

  it("handles CRLF line endings", () => {
    const result = filterHtpasswdEntries("alice:hash\r\nbob:hash\r\n", ["alice"]);
    expect(result.removed).toEqual(["alice"]);
    expect(result.text).toBe("bob:hash\n");
  });
});


describe("parseStoreRead", () => {
  it("splits the marker from the file contents", () => {
    expect(parseStoreRead("PRESENT\nalice:hash\n")).toEqual({
      present: true,
      contents: "alice:hash\n",
    });
    expect(parseStoreRead("PRESENT\n")).toEqual({ present: true, contents: "" });
    expect(parseStoreRead("ABSENT\n")).toEqual({ present: false, contents: "" });
  });

  // Anything the module does not recognize must NOT read as "no store" — that
  // would report success while the users are still there.
  it("returns null for a missing or unrecognized marker", () => {
    expect(parseStoreRead("alice:hash\n")).toBeNull();
    expect(parseStoreRead("")).toBeNull();
    expect(parseStoreRead(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The orchestration seam
// ---------------------------------------------------------------------------

describe("purgeLocalRegistryUsers", () => {
  const owned = ["macbook-pro", "macbook-pro-old", "macbook-pro-pending"];
  const survivors = ["cinatra-dev-seed", "lane-2392-alpha", "lane-2392-beta"];

  it("rewrites the store, restarts the registry, verifies, and reports what it removed", async () => {
    const transport = fakeTransport();
    const log = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      log: log.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("purged");
    expect(result.removed).toEqual(owned);
    expect(result.remaining).toEqual(survivors);

    // probe → read(+snapshot) → compare-and-swap write → restart → ready → verify
    const roles = transport.calls.map((call) => {
      const c = call.command;
      if (isProbe(c)) return "probe";
      if (isRead(c)) return "read";
      if (isWrite(c)) return "write";
      if (isRestart(c)) return "restart";
      if (isReady(c)) return "ready";
      if (isVerify(c)) return "verify";
      if (isCleanup(c)) return "cleanup";
      return c;
    });
    expect(roles).toEqual(["probe", "read", "write", "restart", "ready", "verify"]);

    const write = transport.calls.find((call) => isWrite(call.command));
    expect(write.input).not.toContain("macbook-pro:");
    expect(write.input).toContain("cinatra-dev-seed:");
    expect(log.text).toContain("Package storage is untouched");
  });

  // The whole reason the restart exists: the registry merges htpasswd into an
  // in-memory map and never forgets a user that left the file, so a rewrite
  // alone changes nothing for the running process.
  it("never rewrites without restarting the registry afterwards", async () => {
    const transport = fakeTransport();
    await purgeLocalRegistryUsers({ namespaces: owned, transport, sleep: noSleep });
    expect(transport.restarts).toBe(1);
  });

  // The rewrite replaces the whole file, so it must refuse if the file moved.
  it("refuses to rewrite when the store changed under it", async () => {
    const transport = fakeTransport({ writeResult: { status: STORE_CHANGED_EXIT } });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      warn: warn.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("store-changed");
    expect(result.removed).toEqual([]);
    expect(transport.restarts).toBe(0);
    expect(warn.text).toContain("changed while the reset was reading it");
    for (const name of owned) expect(warn.text).toContain(name);
  });

  it("stages the rewrite through a temp path and compares against a snapshot", async () => {
    const transport = fakeTransport();
    await purgeLocalRegistryUsers({ namespaces: owned, transport, sleep: noSleep });

    const write = transport.calls.find((call) => isWrite(call.command)).command;
    expect(write).toContain(VERDACCIO_HTPASSWD_SNAPSHOT_PATH);
    expect(write).toContain(`mv '${VERDACCIO_HTPASSWD_TMP_PATH}' '${VERDACCIO_HTPASSWD_PATH}'`);
    expect(write).toContain(`exit ${STORE_CHANGED_EXIT}`);
    // The staging write precedes the compare, so check and rename are adjacent.
    expect(write.indexOf("cat > ")).toBeLessThan(write.indexOf("cmp -s"));
    expect(write.indexOf("cmp -s")).toBeLessThan(write.indexOf("mv '"));
  });

  it("waits for the registry to serve again before reporting success", async () => {
    const transport = fakeTransport({ readyAfter: 3 });
    const slept = [];

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      sleep: async (ms) => { slept.push(ms); },
    });

    expect(result.outcome).toBe("purged");
    expect(slept).toEqual([500, 500, 500]);
  });

  it("reports a registry that never comes back, without throwing", async () => {
    const transport = fakeTransport({ readyAfter: Infinity });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      warn: warn.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("restart-failed");
    expect(result.removed).toEqual(owned);
    expect(transport.calls.filter((call) => isReady(call.command))).toHaveLength(
      RESTART_READY_ATTEMPTS,
    );
    expect(warn.text).toContain("restart the \"verdaccio\" container before you onboard");
    expect(warn.text).toContain("Re-running the reset will NOT redo this");
  });

  it("reports a restart command that fails, without throwing", async () => {
    const transport = fakeTransport({ restartStatus: 1 });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      warn: warn.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("restart-failed");
    // A failed restart never enters the readiness loop.
    expect(transport.calls.some((call) => isReady(call.command))).toBe(false);
  });

  // The registry came back still holding a user that should be gone.
  it("verifies against the live store and reports a resurrected user", async () => {
    const transport = fakeTransport({
      verifyResult: { status: 0, stdout: `PRESENT\n${HTPASSWD_FIXTURE}` },
    });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      warn: warn.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("verify-failed");
    expect(result.stillPresent).toEqual(owned);
    expect(warn.text).toContain("still holds");
  });

  // A verification that cannot RUN is not a success either.
  it("reports an unverifiable removal rather than claiming success", async () => {
    const transport = fakeTransport({ verifyResult: { status: 1, stdout: "" } });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport,
      warn: warn.sink,
      sleep: noSleep,
    });

    expect(result.outcome).toBe("verify-failed");
    expect(result.stillPresent).toEqual([]);
    expect(warn.text).toContain("could not be verified");
    for (const name of owned) expect(warn.text).toContain(name);
  });

  it("is idempotent — a second run finds nothing of its own, writes nothing, restarts nothing", async () => {
    const first = fakeTransport();
    const firstResult = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport: first,
      sleep: noSleep,
    });
    const rewritten = first.calls.find((call) => isWrite(call.command)).input;

    const second = fakeTransport({ store: rewritten });
    const log = captureLines();
    const secondResult = await purgeLocalRegistryUsers({
      namespaces: owned,
      transport: second,
      log: log.sink,
      sleep: noSleep,
    });

    expect(firstResult.outcome).toBe("purged");
    expect(secondResult.outcome).toBe("already-clean");
    expect(secondResult.removed).toEqual([]);
    expect(secondResult.remaining).toEqual(survivors);
    // Probe, read, and a cleanup of the snapshot the read took. No write, no restart.
    expect(second.calls.some((call) => isWrite(call.command))).toBe(false);
    expect(second.calls.some((call) => isCleanup(call.command))).toBe(true);
    expect(second.restarts).toBe(0);
    expect(log.text).toContain("holds no user for this instance");
  });

  it("does nothing at all when the purged database recorded no namespace", async () => {
    const transport = fakeTransport();
    const log = captureLines();

    const result = await purgeLocalRegistryUsers({ namespaces: [], transport, log: log.sink });

    expect(result.outcome).toBe("nothing-recorded");
    expect(transport.calls).toEqual([]);
    expect(transport.restarts).toBe(0);
    expect(log.text).toContain("Nothing to reconcile");
  });

  it("warns and continues when the registry container is unreachable", async () => {
    const transport = fakeTransport();
    transport.exec = ({ command }) => {
      transport.calls.push({ command });
      return { status: 1, stdout: "", stderr: "no such service" };
    };
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({ namespaces: owned, transport, warn: warn.sink });

    expect(result.outcome).toBe("registry-unavailable");
    expect(transport.calls).toHaveLength(1);
    expect(transport.restarts).toBe(0);
    expect(warn.text).toContain("Could not reach the local registry container");
    for (const name of owned) expect(warn.text).toContain(name);
    expect(warn.text).toContain("Re-running the reset will NOT redo this");
  });

  it("treats an ABSENT store as nothing to reconcile", async () => {
    const transport = fakeTransport({ store: null });
    const log = captureLines();

    const result = await purgeLocalRegistryUsers({ namespaces: owned, transport, log: log.sink });

    expect(result.outcome).toBe("no-user-store");
    expect(transport.restarts).toBe(0);
    expect(log.text).toContain("no user store yet");
  });

  // A read that FAILS, or answers something unrecognized, is not an absent
  // store: the DB evidence is already gone, so it must warn and name the users.
  it("distinguishes an unreadable store from an absent one", async () => {
    for (const readResult of [
      { status: 1, stdout: "", stderr: "permission denied" },
      { status: 0, stdout: "alice:hash\n" }, // no marker — unrecognized
    ]) {
      const transport = fakeTransport({ readResult });
      const warn = captureLines();

      const result = await purgeLocalRegistryUsers({ namespaces: owned, transport, warn: warn.sink });

      expect(result.outcome).toBe("read-failed");
      expect(transport.restarts).toBe(0);
      // The read may have taken the snapshot before failing — clean it up.
      expect(transport.calls.some((call) => isCleanup(call.command))).toBe(true);
      expect(warn.text).toContain("Could not read the local registry user store");
      for (const name of owned) expect(warn.text).toContain(name);
    }
  });

  it("leaves the old file intact, clears the staging files, and warns when the rewrite fails", async () => {
    const transport = fakeTransport({ writeResult: { status: 1, stderr: "read-only file system" } });
    const warn = captureLines();

    const result = await purgeLocalRegistryUsers({ namespaces: owned, transport, warn: warn.sink });

    expect(result.outcome).toBe("write-failed");
    expect(result.removed).toEqual([]);
    expect(isCleanup(transport.calls.at(-1).command)).toBe(true);
    expect(transport.calls.at(-1).command).toContain(VERDACCIO_HTPASSWD_SNAPSHOT_PATH);
    // A failed rewrite never bounces the service.
    expect(transport.restarts).toBe(0);
    expect(warn.text).toContain("so it is unchanged");
    for (const name of owned) expect(warn.text).toContain(name);
  });

  it("never lets a namespace reach a shell command", async () => {
    const hostile = ["'; rm -rf /verdaccio/storage; echo '"];
    const transport = fakeTransport();

    await purgeLocalRegistryUsers({ namespaces: hostile, transport, sleep: noSleep });

    for (const call of transport.calls) {
      expect(call.command).not.toContain("rm -rf");
      expect(call.command).not.toContain(hostile[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// The default transport
// ---------------------------------------------------------------------------

describe("createComposeRegistryTransport", () => {
  function recordingSpawn(result = { status: 0, stdout: "out", stderr: "" }) {
    const seen = [];
    return { seen, spawn: (command, args, options) => { seen.push({ command, args, options }); return result; } };
  }

  it("execs one shell command in the compose registry service, from the checkout", () => {
    const recorder = recordingSpawn();
    const transport = createComposeRegistryTransport("/repo", { spawn: recorder.spawn });

    const result = transport.exec({ command: "printf ready", input: "payload" });

    expect(result).toEqual({ status: 0, stdout: "out", stderr: "" });
    expect(recorder.seen[0].command).toBe("docker");
    expect(recorder.seen[0].args).toEqual([
      "compose",
      "exec",
      "-T",
      VERDACCIO_COMPOSE_SERVICE,
      "sh",
      "-c",
      "printf ready",
    ]);
    expect(recorder.seen[0].options.cwd).toBe("/repo");
    expect(recorder.seen[0].options.input).toBe("payload");
  });

  it("restarts only the registry service", () => {
    const recorder = recordingSpawn();
    const transport = createComposeRegistryTransport("/repo", { spawn: recorder.spawn });

    transport.restart();

    expect(recorder.seen[0].args).toEqual(["compose", "restart", VERDACCIO_COMPOSE_SERVICE]);
    expect(recorder.seen[0].options.cwd).toBe("/repo");
  });

  it("reports a spawn error as a null status rather than throwing", () => {
    const transport = createComposeRegistryTransport("/repo", {
      spawn: () => ({ error: new Error("ENOENT"), status: null }),
    });

    expect(transport.exec({ command: "printf ready" })).toEqual({ status: null, stdout: "", stderr: "" });
    expect(transport.restart()).toEqual({ status: null, stdout: "", stderr: "" });
  });
});
