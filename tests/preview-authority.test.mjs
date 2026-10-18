// The preview authority (cinatra-cli#307): the one module that removes a
// preview's container, forwarder and data volume and promotes its row to the
// finished state, and only on the authority tokens it mints itself in the same
// invocation. Hermetic: a fake `runDocker` records every call; no docker runs.
// The module is imported inside each case, so each case fails on its own where
// the module does not exist.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const authority = () => import("../src/preview-authority.mjs");
const preview = () => import("../src/preview.mjs");

const ID = (n) => n.toString(16).padStart(64, "c");
const FWD = (n) => n.toString(16).padStart(64, "f");
const SHA = "a".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const exit1 = () => ({ status: 1, stdout: "", stderr: "" });
/** The state of a container read by its ID after a removal that failed: it is still there. */
const stillThere = (args) => (args[0] === "container" && args.includes("{{.State.Running}}") ? ok("true\n") : null);

let tmp;
let registryPath;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "preview-authority-"));
  registryPath = path.join(tmp, "previews.json");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake docker: `answer(args)` first, else exit 0 with nothing; every call recorded. */
function fakeDocker(answer = () => null) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    return answer(args) ?? ok();
  };
  return { calls, deps: { runDocker, log: () => {}, envFileTmpDir: tmp } };
}

/** A `docker run -d` argv of a preview container (its last element the image). */
const RUN_ARGS = ["run", "-d", "--name", "cinatra-preview-s1", "cinatra-preview:local-x"];

/** Write a registry with one row of slug s1. */
async function seed(fields = {}) {
  const P = await preview();
  const row = { ...P.makePreviewSlot({ slug: "s1", ref: "main", sha: SHA, hostPort: 3400, state: "ready", now: () => "T0" }), ...fields };
  P.writeRegistry(registryPath, { version: 1, previews: { s1: row } });
  return row;
}
const rowOf = async () => (await preview()).getPreview((await preview()).readRegistry(registryPath).registry, "s1");

describe("the preview authority's tokens (cinatra-cli#307)", () => {
  it("only a token this module minted in this invocation is authority: a string, a plain object, a copy or another invocation's token removes nothing", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => (args[0] === "run" ? ok(`${ID(1)}\n`) : null));
    const inv = A.beginInvocation();
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(token.id).toBe(ID(1));
    expect(Object.isFrozen(token)).toBe(true);
    calls.length = 0;
    const forged = [ID(1), { kind: "container-created", id: ID(1) }, Object.freeze({ ...token }), [ID(1)]];
    for (const f of forged) {
      expect(() => A.removeContainer(inv, f, deps)).toThrow(/a string, a plain object or another invocation's token is no authority/);
      expect(() => A.removeForwardersOf(inv, f, deps)).toThrow(/no authority/);
      expect(() => A.liveness(inv, f, deps)).toThrow(/no authority/);
    }
    const other = A.beginInvocation();
    expect(() => A.removeContainer(other, token, deps)).toThrow(/no authority/);
    expect(calls).toEqual([]);
    expect(A.isAuthorityToken(inv, token, A.TOKEN_KINDS.CREATED)).toBe(true);
    expect(A.isAuthorityToken(other, token, A.TOKEN_KINDS.CREATED)).toBe(false);
  });

  it("no value is turned into a string to pass a check: an array holding a full ID is refused by every reader and validator", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker();
    const arr = [ID(1)];
    expect(A.containerStateById(arr, deps)).toBe("unknown");
    expect(() => A.listForwardersOf(arr, deps)).toThrow(/only by a full container ID/);
    expect(calls).toEqual([]);
    expect(A.isLeftoverEntry({ kind: "container", id: arr, why: "x" })).toBe(false);
    expect(A.isLeftoverEntry({ kind: "volume", name: ["v"], why: "x" })).toBe(false);
    expect(A.isConditionEntry({ id: arr, condition: "not-running", why: "x" }, ID(1))).toBe(false);
    expect(A.areRowListsValid({ containerId: arr })).toBe(false);
    expect(A.areRowListsValid({ containerId: ID(1), cleanupIncomplete: [{ kind: "forwarder", id: arr, why: "x" }] })).toBe(false);
    // the registry itself: a row whose containerId or leftover ID is an array is corruption
    const P = await preview();
    await seed({ containerId: arr });
    expect(P.readRegistry(registryPath).status).toBe("malformed");
    await seed({ containerId: ID(2), cleanupIncomplete: [{ kind: "container", id: arr, why: "docker rm: exit 1" }] });
    expect(P.readRegistry(registryPath).status).toBe("malformed");
  });

  it("a leftover never names the row's own container under its own name, and a condition names only it", async () => {
    const A = await authority();
    const own = { containerId: ID(1), containerName: "cinatra-preview-s1" };
    expect(A.areRowListsValid({ ...own, cleanupIncomplete: [{ kind: "container", id: ID(1), why: "left stopped" }] })).toBe(false);
    expect(A.areRowListsValid({ ...own, cleanupIncomplete: [{ kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded", why: "set aside" }] })).toBe(true);
    expect(A.areRowListsValid({ ...own, cleanupIncomplete: [{ kind: "container", id: ID(2), why: "docker rm: exit 1" }] })).toBe(true);
    expect(A.areRowListsValid({ ...own, containerConditions: [{ id: ID(1), condition: "not-running", why: "left stopped" }] })).toBe(true);
    expect(A.areRowListsValid({ ...own, containerConditions: [{ id: ID(2), condition: "not-running", why: "left stopped" }] })).toBe(false);
    expect(A.areRowListsValid({ ...own, containerConditions: [{ id: ID(1), condition: "made-up", why: "x" }] })).toBe(false);
    expect(A.areRowListsValid({ ...own, containerConditions: [] })).toBe(false);
    expect(A.areRowListsValid({ ...own, cleanupIncomplete: [] })).toBe(false);
    expect(A.areRowListsValid({ containerConditions: [{ id: ID(1), condition: "not-running", why: "x" }] })).toBe(false);
  });
});

describe("the preview authority's removals return outcomes kept in the ledger (cinatra-cli#307)", () => {
  it("a run that exits non-zero after docker created the container is in the ledger, and removeCreated removes exactly that ID", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "run") {
        const cid = args.indexOf("--cidfile");
        if (cid !== -1) writeFileSync(args[cid + 1], `${ID(7)}\n`);
        return { status: 125, stdout: "", stderr: "Error: made-up start failure" };
      }
      return null;
    });
    const inv = A.beginInvocation();
    expect(() => A.runOwnContainer(inv, { args: RUN_ARGS, deps })).toThrow(/docker run of the preview container failed/);
    expect(A.createdNotRemoved(inv).map((t) => t.id)).toEqual([ID(7)]);
    const out = A.removeCreated(inv, deps);
    expect(out.removed).toBe(true);
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", ID(7)]]);
    expect(A.createdNotRemoved(inv)).toEqual([]);
  });

  it("a run that errors or times out with no ID in its cidfile is an unknown run: a leftover by its name, so a fresh row is kept degraded, never deleted", async () => {
    const A = await authority();
    let listed = "";
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "run") return { status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
      if (args[0] === "container" && args[1] === "ls" && args.includes("{{.Names}}")) return ok(listed);
      // docker's own answer for a name it holds no container under: it settles nothing about a run that may still land
      if (args[0] === "container" && args[1] === "inspect") return { status: 1, stdout: "", stderr: "Error: No such container: cinatra-preview-s1" };
      return null;
    });
    const inv = A.beginInvocation();
    const P = await preview();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1",
      take: () => P.makePreviewSlot({ slug: "s1", ref: "main", sha: SHA, hostPort: 3400, state: "provisioning", now: () => "T0" }) });
    expect(() => A.runOwnContainer(inv, { args: RUN_ARGS, deps })).toThrow(/docker run of the preview container failed/);
    const unknownRun = { kind: "run", name: "cinatra-preview-s1",
      why: "docker run answered timed out and named no container ID; a container may exist under cinatra-preview-s1" };
    expect(A.ledgerFailures(inv)).toEqual([unknownRun]);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    expect((await rowOf()).cleanupIncomplete).toEqual([unknownRun]);
    // no later read of it clears it, whether a container holds the name or not: the run may still land
    const reads = calls.length;
    listed = "cinatra-preview-s1-old\ncinatra-preview-s1\n";
    expect(A.remainingLeftovers([unknownRun], deps)).toEqual([unknownRun]);
    listed = "cinatra-preview-s1-old\n";
    expect(A.remainingLeftovers([unknownRun], deps)).toEqual([unknownRun]);
    expect(calls.length).toBe(reads);
  });

  it("a failed removal is an outcome naming what is left, kept in the ledger until the same removal succeeds", async () => {
    const A = await authority();
    let rmFails = true;
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(1)}\n`);
      if (args[0] === "rm") return rmFails ? exit1() : ok();
      return stillThere(args);
    });
    const inv = A.beginInvocation();
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    const first = A.removeContainer(inv, token, deps);
    expect(first).toEqual({ removed: false, left: [{ kind: "container", id: ID(1), why: "docker rm: exit 1" }] });
    expect(A.ledgerFailures(inv)).toEqual([{ kind: "container", id: ID(1), why: "docker rm: exit 1" }]);
    rmFails = false;
    expect(A.removeContainer(inv, token, deps).removed).toBe(true);
    expect(A.ledgerFailures(inv)).toEqual([]);
  });

  it("a docker seam that throws is a failed call: the run's cidfile container is in the ledger, and a removal that throws is an outcome kept in the ledger", async () => {
    const A = await authority();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") {
        const cid = args.indexOf("--cidfile");
        if (cid !== -1) writeFileSync(args[cid + 1], `${ID(8)}\n`);
        throw new Error("made-up seam crash after the create");
      }
      if (args[0] === "rm") throw new Error("made-up seam crash on the removal");
      return stillThere(args);
    });
    const inv = A.beginInvocation();
    expect(() => A.runOwnContainer(inv, { args: RUN_ARGS, deps })).toThrow(/docker run of the preview container failed/);
    expect(A.createdNotRemoved(inv).map((t) => t.id)).toEqual([ID(8)]);
    const out = A.removeCreated(inv, deps);
    expect(out.removed).toBe(false);
    expect(out.left).toEqual([{ kind: "container", id: ID(8), why: "docker rm: error" }]);
    expect(A.ledgerFailures(inv)).toEqual([{ kind: "container", id: ID(8), why: "docker rm: error" }]);
  });

  it("an answer that is not text proves nothing: a listing reads unknown, a forwarder listing fails and a leftover stays", async () => {
    const A = await authority();
    const { deps } = fakeDocker(() => ({ status: 0, stdout: { toString: () => "" }, stderr: "" }));
    expect(A.containerStateById(ID(1), deps)).toBe("unknown");
    expect(() => A.listForwardersOf(ID(1), deps)).toThrow(/its answer is no text/);
    const leftover = { kind: "forwarder", id: FWD(1), why: "docker rm: exit 1" };
    expect(A.remainingLeftovers([leftover], deps)).toEqual([leftover]);
  });

  it("a rename aside that answered no success is no park and is not settled: a named leftover that may be under the aside name", async () => {
    const A = await authority();
    for (const [answer, said] of [[() => ({ status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) }), "timed out"], [exit1, "exit 1"]]) {
      await seed({ containerId: ID(1) });
      const { calls, deps } = fakeDocker((args) => {
        if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
        if (args[0] === "rename") return answer();
        return null;
      });
      const inv = A.beginInvocation();
      const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
      const target = A.parkTarget(inv, claim, "cinatra-preview-s1", deps);
      calls.length = 0;
      expect(A.parkContainer(inv, target, "cinatra-preview-s1.superseded", deps)).toBeNull();
      // nothing reads the container again to judge the rename
      expect(calls).toEqual([["rename", ID(1), "cinatra-preview-s1.superseded"]]);
      expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
      expect((await rowOf()).cleanupIncomplete).toEqual([{ kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded",
        why: `the rename aside answered ${said}; whether it took effect is not settled, so it may be left under the aside name` }]);
    }
  });

  it("forwarders are removed only through the label of a container token's ID, each by its own ID; a failed listing is never none", async () => {
    const A = await authority();
    let listFails = false;
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "ls") return listFails ? exit1() : ok(`${FWD(1)}\n${FWD(2)}\n`);
      return null;
    });
    const inv = A.beginInvocation();
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    calls.length = 0;
    expect(A.removeForwardersOf(inv, token, deps).removed).toBe(true);
    expect(calls).toEqual([
      ["container", "ls", "-a", "--no-trunc", "--filter", `label=cinatra.preview.forwarder-of=${ID(1)}`, "--format", "{{.ID}}"],
      ["rm", "-f", FWD(1)],
      ["rm", "-f", FWD(2)],
    ]);
    listFails = true;
    const out = A.removeForwardersOf(inv, token, deps);
    expect(out.removed).toBe(false);
    expect(out.left).toHaveLength(1);
    expect(out.left[0]).toMatchObject({ kind: "forwarder-listing", id: ID(1) });
  });

  it("the data volume goes only while its label still holds this invocation's nonce, by a non-forced removal", async () => {
    const A = await authority();
    let labels = null;
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "volume" && args[1] === "create") {
        labels ??= { "cinatra.preview.volume-created-by": args[3].split("=")[1] };
        return ok("v\n");
      }
      if (args[0] === "volume" && args[1] === "inspect") return ok(`${JSON.stringify(labels)}\n`);
      return null;
    });
    const inv = A.beginInvocation();
    expect(A.createDataVolume(inv, "cinatra-preview-data-s1", deps)).toEqual({ createdHere: true });
    const [volume] = A.ownedVolumes(inv);
    labels = { "cinatra.preview.volume-created-by": "another-run" };
    expect(A.removeOwnedVolume(inv, volume, deps).removed).toBe(true);
    expect(calls.filter((c) => c[0] === "volume" && c[1] === "rm")).toEqual([]);
    labels = { "cinatra.preview.volume-created-by": volume.nonce };
    expect(A.removeOwnedVolume(inv, volume, deps).removed).toBe(true);
    expect(calls.filter((c) => c[0] === "volume" && c[1] === "rm")).toEqual([["volume", "rm", "cinatra-preview-data-s1"]]);
    expect(() => A.removeOwnedVolume(inv, { kind: "volume-owned", name: "cinatra-preview-data-s1", nonce: volume.nonce }, deps)).toThrow(/no authority/);
  });
});

describe("the preview authority's one reader of a result's output (cinatra-cli#307)", () => {
  it("outputText answers a stream's text, read once, or null: an answer that is not text is never coerced, parsed or trimmed", async () => {
    const A = await authority();
    expect(A.outputText({ status: 0, stdout: "x\n", stderr: "" }, "stdout")).toBe("x\n");
    expect(A.outputText({ status: 1, stdout: "", stderr: "boom" }, "stderr")).toBe("boom");
    const forged = { toString: () => "true", trim: () => "true", valueOf: () => "true" };
    for (const v of [Symbol("made-up"), forged, ["true"], 7, null, undefined, Buffer.from("true")]) {
      expect(A.outputText({ status: 0, stdout: v, stderr: v }, "stdout")).toBeNull();
      expect(A.outputText({ status: 0, stdout: v, stderr: v }, "stderr")).toBeNull();
    }
    for (const r of [null, undefined, "true", 0, Symbol("made-up")]) expect(A.outputText(r, "stdout")).toBeNull();
    let reads = 0;
    const once = { get stdout() { reads += 1; return reads === 1 ? "first" : Symbol("later"); } };
    expect(A.outputText(once, "stdout")).toBe("first");
    expect(reads).toBe(1);
    const throwing = { get stdout() { throw new Error("made-up getter"); } };
    expect(A.outputText(throwing, "stdout")).toBeNull();
    expect(() => A.outputText({ stdout: "x" }, "status")).toThrow(/its stdout or its stderr/);
  });

  it("answerOk is the one status predicate: OK only for an object answer with no error, no timeout and exit status 0", async () => {
    const A = await authority();
    expect(A.answerOk({ status: 0, stdout: "", stderr: "" })).toBe(true);
    expect(A.answerOk({ status: 1, stdout: "", stderr: "Error: No such object" })).toBe(false);
    // a timed-out child as the runner answers it: killed, so no exit status
    const timedOut = { status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" }), timedOut: true };
    expect(A.answerOk(timedOut)).toBe(false);
    expect(A.answerOk({ status: null, signal: "SIGKILL", stdout: "", stderr: "" })).toBe(false);
    expect(A.answerOk({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }) })).toBe(false);
    for (const r of [null, undefined, "ok", 0, Symbol("made-up")]) expect(A.answerOk(r)).toBe(false);
    const throwing = { get status() { throw new Error("made-up getter"); } };
    expect(A.answerOk(throwing)).toBe(false);
  });
});

describe("the preview authority's leftover ledger: what a run created or set aside is named until it is removed or put back (cinatra-cli#307)", () => {
  it("a run that throws between its boot and its restore never leaves the old ID ready: its settle is degraded, naming both containers", async () => {
    const A = await authority();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "run") return ok(`${ID(2)}\n`);
      return null;
    });
    await seed({ containerId: ID(1) });
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    A.parkContainer(inv, A.parkTarget(inv, claim, "cinatra-preview-s1", deps), "cinatra-preview-s1.superseded", deps);
    expect(A.runOwnContainer(inv, { args: RUN_ARGS, deps }).id).toBe(ID(2));
    // the throw: the verb's last catch settles with no container recorded
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    const row = await rowOf();
    expect(row).toMatchObject({ state: "degraded", containerId: ID(1) });
    expect(row.cleanupIncomplete).toEqual([
      { kind: "container", id: ID(2), why: "this run created it and did not remove it" },
      { kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded", why: "this run set it aside and did not put it back" },
    ]);
    // the restore: what it created is removed and the park is put back, so the row is as it was found
    await seed({ containerId: ID(1) });
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const parked = A.parkContainer(inv, A.parkTarget(inv, claim, "cinatra-preview-s1", deps), "cinatra-preview-s1.superseded", deps);
    A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(A.removeCreated(inv, deps).removed).toBe(true);
    expect(A.putBack(inv, parked, "cinatra-preview-s1", deps)).toBe(true);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "ready" });
    expect((await rowOf()).cleanupIncomplete).toBeUndefined();
  });

  it("a put-back whose rename fails names the park once, by that failure", async () => {
    const A = await authority();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "rename" && args[2] === "cinatra-preview-s1") return exit1();
      return null;
    });
    await seed({ containerId: ID(1) });
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const parked = A.parkContainer(inv, A.parkTarget(inv, claim, "cinatra-preview-s1", deps), "cinatra-preview-s1.superseded", deps);
    expect(A.putBack(inv, parked, "cinatra-preview-s1", deps)).toBe(false);
    expect(() => A.putBack(inv, { ...parked }, "cinatra-preview-s1", deps)).toThrow(/no authority/);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    expect((await rowOf()).cleanupIncomplete).toEqual([
      { kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded",
        why: "the rename back to its own name answered exit 1; whether it took effect is not settled" },
    ]);
  });
});

describe("the preview authority's row writes: the claim, the settle and the one promotion (cinatra-cli#307)", () => {
  it("a promotion takes only the liveness of the row's own container, and is refused while a leftover is still there or an entry of its own container stands", async () => {
    const A = await authority();
    await seed({ containerId: ID(1), state: "degraded", cleanupIncomplete: [{ kind: "forwarder", id: FWD(3), why: "docker rm: exit 1" }] });
    let leftoverListed = true;
    const { deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      if (args[0] === "container" && args[1] === "ls") return ok(leftoverListed ? `${FWD(3)}\n` : "");
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    expect(claim.prior).toBe("degraded");
    const recorded = A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps);
    const live = A.liveness(inv, recorded, deps);
    expect(live).not.toBeNull();
    // a container set aside is never promoted: it has no liveness token
    const parked = A.parkContainer(inv, A.parkTarget(inv, claim, "cinatra-preview-s1", deps), "cinatra-preview-s1.superseded", deps);
    expect(() => A.liveness(inv, parked, deps)).toThrow(/takes a container-created or container-recorded token/);
    await expect(A.promoteReady(inv, claim, { kind: "liveness", id: ID(1) }, { deps })).rejects.toThrow(/no authority/);
    const refused = await A.promoteReady(inv, claim, live, { deps });
    expect(refused).toMatchObject({ ready: false, state: "degraded" });
    expect((await rowOf()).state).toBe("degraded");
    // the park this invocation did not put back is named beside the earlier leftover
    expect((await rowOf()).cleanupIncomplete).toEqual([{ kind: "forwarder", id: FWD(3), why: "docker rm: exit 1" },
      { kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded", why: "this run set it aside and did not put it back" }]);
    // the forwarder is another object: a listing that no longer finds it clears it. The entry under the aside name is of the
    // row's own container: no read clears it, so the promotion is refused again
    leftoverListed = false;
    const inv2 = A.beginInvocation();
    const claim2 = await A.claimRow(inv2, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const live2 = A.liveness(inv2, A.verifyRecorded(inv2, claim2, "cinatra-preview-s1", deps), deps);
    expect(await A.promoteReady(inv2, claim2, live2, { deps })).toMatchObject({ ready: false, state: "degraded" });
    expect(await rowOf()).toMatchObject({ state: "degraded", cleanupIncomplete: [
      { kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded", why: "this run set it aside and did not put it back" }] });
    // a row whose only leftover is another object's is ready once a listing no longer finds it
    await seed({ containerId: ID(1), state: "degraded", cleanupIncomplete: [{ kind: "forwarder", id: FWD(3), why: "docker rm: exit 1" }] });
    const inv3 = A.beginInvocation();
    const claim3 = await A.claimRow(inv3, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const live3 = A.liveness(inv3, A.verifyRecorded(inv3, claim3, "cinatra-preview-s1", deps), deps);
    expect(await A.promoteReady(inv3, claim3, live3, { deps })).toMatchObject({ ready: true });
    expect((await rowOf()).state).toBe("ready");
    expect((await rowOf()).cleanupIncomplete).toBeUndefined();
  });

  it("a leftover that names the row's own container under its aside name is kept when that container is read under its own name and live: the promotion is refused, and only a replacement clears it", async () => {
    const A = await authority();
    const aside = { kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded", why: "the rename back to its own name answered timed out; whether it took effect is not settled" };
    await seed({ containerId: ID(1), state: "degraded", cleanupIncomplete: [aside] });
    const gone = new Set();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(2)}\n`);
      if (args[0] === "rm") { gone.add(args.at(-1)); return ok(); }
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      if (args[0] === "container" && args[1] === "ls") return ok(gone.has(ID(1)) ? "" : `${ID(1)}\n`);
      return null;
    });
    // the rename may still land after any read: a later command's liveness read never clears it
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    let live = A.liveness(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps);
    expect(await A.promoteReady(inv, claim, live, { deps })).toMatchObject({ ready: false, state: "degraded", left: [aside] });
    expect(await rowOf()).toMatchObject({ state: "degraded", containerId: ID(1), cleanupIncomplete: [aside] });
    expect(A.ownContainerEntries(await rowOf())).toEqual([aside]);
    // the replacement: a new container this invocation created, and the old one removed by its ID (exit 0)
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const old = A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps);
    expect(A.removeContainer(inv, old, deps).removed).toBe(true);
    const created = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    live = A.liveness(inv, created, deps);
    expect(await A.promoteReady(inv, claim, live, { container: created, deps })).toMatchObject({ ready: true });
    expect(await rowOf()).toMatchObject({ state: "ready", containerId: ID(2) });
    expect((await rowOf()).cleanupIncomplete).toBeUndefined();
  });

  it("a settle returns the row to the state the claim read: a degraded row stays degraded, never ready, and a failure in the ledger is never released as clean", async () => {
    const A = await authority();
    await seed({ containerId: ID(1), state: "degraded" });
    const { deps } = fakeDocker((args) => (args[0] === "run" ? ok(`${ID(2)}\n`) : args[0] === "rm" ? exit1() : stillThere(args)));
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing, state: "ready" }) });
    expect((await rowOf()).state).toBe("provisioning");
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    expect((await rowOf()).state).toBe("degraded");
    await seed({ containerId: ID(1) });
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    A.removeContainer(inv, A.runOwnContainer(inv, { args: RUN_ARGS, deps }), deps);
    const settled = await A.settleRow(inv, claim);
    expect(settled.state).toBe("degraded");
    expect((await rowOf()).cleanupIncomplete).toEqual([{ kind: "container", id: ID(2), why: "docker rm: exit 1" }]);
    await expect(A.settleRow(inv, claim, { patch: () => ({ state: "ready" }) })).resolves.toBeNull();
  });

  it("a claim writes its row once: a second settle after another invocation claimed the row changes nothing", async () => {
    const A = await authority();
    await seed({ containerId: ID(1) });
    const first = A.beginInvocation();
    const claim1 = await A.claimRow(first, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    expect(await A.settleRow(first, claim1, { unhealthy: true })).toMatchObject({ state: "degraded" });
    const second = A.beginInvocation();
    await A.claimRow(second, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    expect((await rowOf()).state).toBe("provisioning");
    // the first invocation's later settle (a final catch, say) is spent: the second claim stands
    expect(await A.settleRow(first, claim1)).toBeNull();
    expect((await rowOf()).state).toBe("provisioning");
  });

  it("a settle that records a new container always writes degraded: only a promotion records one as ready", async () => {
    const A = await authority();
    await seed({ containerId: ID(1) });
    const { deps } = fakeDocker((args) => (args[0] === "run" ? ok(`${ID(2)}\n`) : null));
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const created = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(await A.settleRow(inv, claim, { container: created })).toMatchObject({ state: "degraded" });
    expect((await rowOf()).containerId).toBe(ID(2));
    expect((await rowOf()).state).toBe("degraded");
  });

  it("a row patch never sets the state or a list, and a create's claim with nothing left is removed", async () => {
    const A = await authority();
    const P = await preview();
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, {
      registryPath,
      slug: "s1",
      take: () => P.makePreviewSlot({ slug: "s1", ref: "main", sha: SHA, hostPort: 3400, state: "provisioning", now: () => "T0" }),
    });
    expect(claim.prior).toBeNull();
    await expect(A.settleRow(inv, claim, { patch: () => ({ state: "ready" }) })).rejects.toThrow(/never sets state/);
    await expect(A.settleRow(inv, claim, { patch: () => ({ cleanupIncomplete: [] }) })).rejects.toThrow(/never sets cleanupIncomplete/);
    expect(await A.settleRow(inv, claim)).toEqual({ deleted: true });
    expect(await rowOf()).toBeNull();
  });

  it("the result line is printed only by a ready promotion, and only for a container this invocation created", async () => {
    const A = await authority();
    expect(() => A.previewContainerIdLine(A.beginInvocation(), ID(1))).toThrow(/only for a container this run created/);
    await seed({ containerId: ID(1) });
    const logs = [];
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(2)}\n`);
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      return null;
    });
    deps.log = (l) => logs.push(l);
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const recordedLive = A.liveness(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps);
    await A.promoteReady(inv, claim, recordedLive, { deps, resultLine: true });
    expect(logs).toEqual([]);
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const created = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    await expect(A.promoteReady(inv, claim, recordedLive, { container: created, deps })).rejects.toThrow(/no authority/);
    await expect(A.promoteReady(inv, claim, A.liveness(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps), { container: created, deps }))
      .rejects.toThrow(/the very container the row records/);
    // a genuine token of another invocation is no authority for this invocation's line
    expect(() => A.previewContainerIdLine(A.beginInvocation(), created)).toThrow(/only for a container this run created/);
    await A.promoteReady(inv, claim, A.liveness(inv, created, deps), { container: created, deps, resultLine: true });
    expect(logs).toEqual([`preview_container_id=${ID(2)}`]);
    expect((await rowOf()).containerId).toBe(ID(2));
  });

  it("a failed removal of the very container to be promoted refuses the promotion: the row is settled degraded naming it, and no result line is printed", async () => {
    const A = await authority();
    await seed({ containerId: ID(1) });
    const logs = [];
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(2)}\n`);
      if (args[0] === "rm") return exit1();
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      return null;
    });
    deps.log = (l) => logs.push(l);
    // the row's recorded container: its removal fails, and it still answers running
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const recorded = A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps);
    expect(A.removeContainer(inv, recorded, deps).removed).toBe(false);
    const recordedLive = A.liveness(inv, recorded, deps);
    expect(recordedLive).not.toBeNull();
    const refused = await A.promoteReady(inv, claim, recordedLive, { deps, resultLine: true });
    expect(refused).toMatchObject({ ready: false, state: "degraded" });
    expect(refused.failed.map((f) => f.id)).toEqual([ID(1)]);
    expect((await rowOf()).state).toBe("degraded");
    expect((await rowOf()).containerConditions).toEqual([{ id: ID(1), condition: "not-replaced", why: expect.stringMatching(/^docker rm/) }]);
    // the claim was spent by that settle: no later write of this invocation lands
    expect(await A.settleRow(inv, claim)).toBeNull();
    // a container this run created: its failed removal refuses the promotion and its result line
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const created = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(A.removeContainer(inv, created, deps).removed).toBe(false);
    const createdLive = A.liveness(inv, created, deps);
    expect(await A.promoteReady(inv, claim, createdLive, { container: created, deps, resultLine: true })).toMatchObject({ ready: false, state: "degraded" });
    expect(logs).toEqual([]);
    expect((await rowOf())).toMatchObject({ state: "degraded", containerId: ID(2) });
    expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-f", ID(1)], ["rm", "-f", ID(2)]]);
  });
});

describe("the preview authority's one mutating call: a change docker answers with no success is never settled by that call (cinatra-cli#307)", () => {
  const timedOut = () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  /** The container's state for any read by its ID: what it was before the call (the call's effect has not landed yet). */
  const before = (word) => (args) => (args[0] === "container" && args.includes("{{.State.Running}}") ? ok(`${word}\n`) : null);

  it("is done only on exit 0; any other answer is unsettled, with no read of the container after it", async () => {
    const A = await authority();
    const answers = [[timedOut, "timed out"], [exit1, "exit 1"], [() => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("x"), { code: "EPIPE" }) }), "EPIPE"]];
    for (const args of [["stop", ID(1)], ["start", ID(1)], ["rm", "-f", ID(1)], ["rename", ID(1), "n2"]]) {
      for (const [answer, said] of answers) {
        const { calls, deps } = fakeDocker((a) => (a[0] === args[0] ? answer() : before("true")(a)));
        const inv = A.beginInvocation();
        expect(A.mutateContainer(inv, deps, args, { timeoutMs: 1 })).toMatchObject({ outcome: "unsettled", why: said });
        expect(calls).toEqual([args]);
      }
      const { calls, deps: okDeps } = fakeDocker(() => null);
      expect(A.mutateContainer(A.beginInvocation(), okDeps, args, { timeoutMs: 1 })).toMatchObject({ outcome: "done", why: null });
      expect(calls).toEqual([args]);
    }
    const { deps } = fakeDocker(() => null);
    for (const bad of [["stop", "cinatra-preview-s1"], ["kill", ID(1)], ["rm", ID(1)], ["rename", ID(1)], ["start", ID(1), "x"], "stop"]) {
      expect(() => A.mutateContainer(A.beginInvocation(), deps, bad, { timeoutMs: 1 })).toThrow(/a container is changed by/);
    }
    expect(() => A.mutateContainer({}, deps, ["stop", ID(1)], { timeoutMs: 1 })).toThrow();
  });

  for (const [verb, was] of [["stop", "true"], ["start", "false"]]) {
    it(`a ${verb} that answers a timeout while the container still reads as before is not settled: the row's container gets state-unsettled, its promotion is refused`, async () => {
      const A = await authority();
      await seed({ containerId: ID(1) });
      const { deps } = fakeDocker((args) => {
        if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
        if (args[0] === verb) return timedOut();
        return before(was)(args);
      });
      const inv = A.beginInvocation();
      const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
      const recorded = A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps);
      expect(A.mutateContainer(inv, deps, [verb, ID(1)], { timeoutMs: 1 }).outcome).toBe("unsettled");
      const why = `docker ${verb} answered timed out; whether it took effect is not settled`;
      const expected = [{ id: ID(1), condition: "state-unsettled", why }];
      // a stop's container still reads running, and its promotion is refused; a start's reads stopped, and is settled
      const live = A.liveness(inv, recorded, deps);
      expect(live === null).toBe(verb === "start");
      if (live) expect(await A.promoteReady(inv, claim, live, { deps })).toMatchObject({ state: "degraded", ready: false, conditions: expected });
      else expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded", conditions: expected });
      expect((await rowOf()).containerConditions).toEqual(expected);
    });
  }

  for (const verb of ["stop", "start"]) {
    it(`a ${verb} an EARLIER command left not settled is never cleared by a later command's read: the promotion of that container is refused and the condition kept`, async () => {
      const A = await authority();
      const why = `docker ${verb} answered timed out; whether it took effect is not settled`;
      const pending = [{ id: ID(1), condition: "state-unsettled", why }];
      await seed({ containerId: ID(1), state: "degraded", containerConditions: pending });
      // every read of the later command reads the container running, by its own ID
      const { deps } = fakeDocker((args) => {
        if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
        if (args[0] === "container" && args[1] === "ls") return ok("");
        return before("true")(args);
      });
      const inv = A.beginInvocation();
      const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
      const recorded = A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps);
      const live = A.liveness(inv, recorded, deps);
      expect(live).not.toBeNull();
      expect(await A.promoteReady(inv, claim, live, { deps })).toMatchObject({ state: "degraded", ready: false, conditions: pending });
      expect(await rowOf()).toMatchObject({ state: "degraded", containerId: ID(1), containerConditions: pending });
    });
  }

  it("the default-keep rule: every condition of the row's own container is kept by a later command's liveness read, a kind added later included; only the closed exception is left to that read", async () => {
    const A = await authority();
    expect(A.READ_CLEARED_CONDITIONS).toEqual(["not-running", "without-forwards"]);
    expect(Object.isFrozen(A.READ_CLEARED_CONDITIONS)).toBe(true);
    const of = (condition) => ({ id: ID(1), condition, why: `made-up ${condition}` });
    // a kind added later is kept too (and a row holding it fails the row check, so no command reads it as clean)
    for (const condition of [...A.CONTAINER_CONDITIONS, "a-kind-added-later"]) {
      const kept = !A.READ_CLEARED_CONDITIONS.includes(condition);
      expect(A.ownContainerEntries({ containerId: ID(1), containerConditions: [of(condition)] }), condition).toEqual(kept ? [of(condition)] : []);
    }
    expect(A.areRowListsValid({ containerId: ID(1), containerConditions: [of("a-kind-added-later")] })).toBe(false);
    const { deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "ls") return ok("");
      return before("true")(args);
    });
    for (const condition of A.CONTAINER_CONDITIONS) {
      await seed({ containerId: ID(1), state: "degraded", containerConditions: [of(condition)] });
      const inv = A.beginInvocation();
      const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
      const live = A.liveness(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps);
      const promoted = await A.promoteReady(inv, claim, live, { deps });
      if (A.READ_CLEARED_CONDITIONS.includes(condition)) {
        expect(promoted, condition).toMatchObject({ ready: true });
        expect((await rowOf()).containerConditions, condition).toBeUndefined();
      } else {
        expect(promoted, condition).toMatchObject({ ready: false, state: "degraded", conditions: [of(condition)] });
        expect((await rowOf()).containerConditions, condition).toEqual([of(condition)]);
      }
    }
  });

  it("a removal of the row's own container that answers a timeout is never cleared by a later command's read: the promotion is refused and not-replaced kept until a replacement", async () => {
    const A = await authority();
    await seed({ containerId: ID(1) });
    const gone = new Set();
    let rmTimesOut = true;
    const { deps } = fakeDocker((args) => {
      if (args[0] === "rm") {
        if (rmTimesOut) return timedOut();
        gone.add(args.at(-1));
        return ok();
      }
      if (args[0] === "run") return ok(`${ID(2)}\n`);
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "ls") return ok(gone.has(ID(1)) ? "" : `${ID(1)}\n`);
      return before("true")(args);
    });
    // a refresh's removal of the old container answers a timeout: the row's container gets not-replaced
    let inv = A.beginInvocation();
    let claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    expect(A.removeContainer(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps).removed).toBe(false);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    const pending = [{ id: ID(1), condition: "not-replaced", why: "docker rm: timed out" }];
    expect((await rowOf()).containerConditions).toEqual(pending);
    // a later command reads the container running: the removal may still land, so its promotion is refused
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    let live = A.liveness(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps);
    expect(live).not.toBeNull();
    expect(await A.promoteReady(inv, claim, live, { deps })).toMatchObject({ ready: false, state: "degraded", conditions: pending });
    expect(await rowOf()).toMatchObject({ state: "degraded", containerId: ID(1), containerConditions: pending });
    expect(A.ownContainerEntries(await rowOf())).toEqual(pending);
    // the replacement: the old container removed by its ID (exit 0) and a new one promoted
    rmTimesOut = false;
    inv = A.beginInvocation();
    claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    expect(A.removeContainer(inv, A.verifyRecorded(inv, claim, "cinatra-preview-s1", deps), deps).removed).toBe(true);
    const created = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    live = A.liveness(inv, created, deps);
    expect(await A.promoteReady(inv, claim, live, { container: created, deps })).toMatchObject({ ready: true });
    expect(await rowOf()).toMatchObject({ state: "ready", containerId: ID(2) });
    expect((await rowOf()).containerConditions).toBeUndefined();
  });

  it("a volume create that answered no success is never cleared by a read; a volume leftover whose create exited 0 is, once a read finds it gone", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => (args[0] === "volume" && args[1] === "ls" ? ok("other\n") : null));
    const pending = { kind: "volume", name: "cinatra-preview-data-s1", why: "docker volume create answered timed out; whether it made cinatra-preview-data-s1 is not settled" };
    const made = { kind: "volume", name: "cinatra-preview-data-s1", why: "docker volume inspect answered no map of labels after its create exited 0; whether this run made cinatra-preview-data-s1 is unknown" };
    expect(A.remainingLeftovers([pending], deps)).toEqual([pending]);
    expect(calls).toEqual([]);
    expect(A.remainingLeftovers([made], deps)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("a container removal that answers a timeout is a leftover named by that answer, with no read after it, even when the removal lands later", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "ls" && args.some((a) => String(a).startsWith("label="))) return ok(`${FWD(1)}\n`);
      if (args[0] === "rm") return timedOut();
      return before("true")(args);
    });
    const inv = A.beginInvocation();
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    calls.length = 0;
    expect(A.removeContainer(inv, token, deps)).toEqual({ removed: false, left: [
      { kind: "forwarder", id: FWD(1), why: "docker rm: timed out" },
      { kind: "container", id: ID(1), why: "docker rm: timed out" },
    ] });
    expect(calls.filter((c) => c[0] === "container" && c[1] === "inspect")).toEqual([]);
  });

  it("a put-back whose rename answers a timeout is a leftover that may be under the aside name, with no read after it", async () => {
    const A = await authority();
    await seed({ containerId: ID(1) });
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args.includes("{{.Id}}")) return ok(`${ID(1)}\n`);
      if (args[0] === "rename") return args[2] === "cinatra-preview-s1" ? timedOut() : ok();
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const parked = A.parkContainer(inv, A.parkTarget(inv, claim, "cinatra-preview-s1", deps), "cinatra-preview-s1.superseded", deps);
    calls.length = 0;
    expect(A.putBack(inv, parked, "cinatra-preview-s1", deps)).toBe(false);
    expect(calls).toEqual([["rename", ID(1), "cinatra-preview-s1"]]);
    expect(A.ledgerFailures(inv)).toEqual([{ kind: "container", id: ID(1), name: "cinatra-preview-s1.superseded",
      why: "the rename back to its own name answered timed out; whether it took effect is not settled" }]);
  });

  it("a forwarder made before the forwarder-of label is listed by the generic label and its exact name, kept only with no label or this container's", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => {
      if (args[0] === "container" && args[1] === "ls" && args.includes(`label=cinatra.preview.forwarder-of=${ID(1)}`)) return ok(`${FWD(1)}\n`);
      if (args[0] === "container" && args[1] === "ls" && args.includes("label=cinatra.preview.forwarder=true")) {
        return ok(`${FWD(1)} n.forward ${ID(1)}\n${FWD(2)} n.forward\n${FWD(3)} n.forward ${ID(9)}\n${FWD(4)} xn.forwardx\n`);
      }
      return null;
    });
    expect(A.listForwardersOf(ID(1), deps)).toEqual([FWD(1)]);
    expect(A.listForwardersOf(ID(1), deps, { baseName: "n.forward" })).toEqual([FWD(1), FWD(2)]);
    expect(calls.at(-1)).toEqual(["container", "ls", "-a", "--no-trunc", "--filter", "label=cinatra.preview.forwarder=true", "--filter", "name=n.forward",
      "--format", '{{.ID}} {{.Names}} {{.Label "cinatra.preview.forwarder-of"}}']);
    const listing = { kind: "forwarder-listing", id: ID(1), name: "n.forward", why: "x" };
    expect(A.isLeftoverEntry(listing)).toBe(true);
    expect(A.remainingLeftovers([listing], deps)).toEqual([listing]);
  });
});

describe("the preview authority's one creating call: a create docker answers with no success is never judged not made by a read (cinatra-cli#307)", () => {
  const timedOut = () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  /** A forwarder's `docker run -d` argv (its image at index 6, a command after it). */
  const FWD_ARGS = ["run", "-d", "--name", "cinatra-preview-s1.forward", "--network", `container:${ID(1)}`, "cinatra-preview:local-x", "-e", "x"];
  const freshClaim = async (A, inv) => {
    const P = await preview();
    return A.claimRow(inv, { registryPath, slug: "s1",
      take: () => P.makePreviewSlot({ slug: "s1", ref: "main", sha: SHA, hostPort: 3400, state: "provisioning", now: () => "T0" }) });
  };
  const unknownRun = (name, why) => ({ kind: "run", name, why: `docker run answered ${why} and named no container ID; a container may exist under ${name}` });

  it.each([
    ["exits non-zero", () => ({ status: 125, stdout: "", stderr: "docker: Error response from daemon: Conflict." }), "exit 125"],
    ["times out", timedOut, "timed out"],
  ])("a run that %s with no ID in its cidfile is an unknown run, though a listing after it reads the name absent and the container lands only after that read", async (_, answer, why) => {
    const A = await authority();
    let made = false;
    let pendingRun = false;
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") {
        pendingRun = true;
        return answer();
      }
      if (args[0] === "container" && args[1] === "ls" && args.includes("{{.Names}}")) {
        // the read sees no container; the daemon's create lands right after it
        const seen = ok(made ? "cinatra-preview-s1\n" : "");
        if (pendingRun) made = true;
        return seen;
      }
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await freshClaim(A, inv);
    expect(() => A.runOwnContainer(inv, { args: RUN_ARGS, deps })).toThrow(/docker run of the preview container failed/);
    // a read after the answer would read it absent; the entry STAYS (no read is made), and the run lands later
    expect(A.remainingLeftovers([unknownRun("cinatra-preview-s1", why)], deps)).toEqual([unknownRun("cinatra-preview-s1", why)]);
    expect(made).toBe(false);
    deps.runDocker(["container", "ls", "-a", "--filter", "name=cinatra-preview-s1", "--format", "{{.Names}}"]);
    expect(made).toBe(true);
    expect(A.ledgerFailures(inv)).toEqual([unknownRun("cinatra-preview-s1", why)]);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    expect((await rowOf()).cleanupIncomplete).toEqual([unknownRun("cinatra-preview-s1", why)]);
  });

  it("a forwarder's run goes through it the same way: with no success and no ID it is an unknown run under the forwarder's exact name", async () => {
    const A = await authority();
    const { calls, deps } = fakeDocker((args) => (args[0] === "run" ? timedOut() : null));
    const inv = A.beginInvocation();
    const made = A.createContainer(inv, deps, FWD_ARGS, { imageAt: 6, timeoutMs: 60_000 });
    expect(made).toMatchObject({ outcome: "unsettled", id: null, name: "cinatra-preview-s1.forward", why: "timed out" });
    // its cidfile goes right before the image; no read follows the answer
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 6)).toEqual(FWD_ARGS.slice(0, 6));
    expect(calls[0][6]).toBe("--cidfile");
    expect(calls[0].slice(8)).toEqual(FWD_ARGS.slice(6));
    expect(A.ledgerFailures(inv)).toEqual([unknownRun("cinatra-preview-s1.forward", "timed out")]);
    // an argv that is not a named, detached run of its own is refused before any call
    for (const bad of [["run", "--rm", "--name", "n", "img"], ["create", "-d", "--name", "n", "img"], ["run", "-d", "--name", "n"],
      ["run", "-d", "--name", "n", "--cidfile", "f", "img"]]) {
      expect(() => A.createContainer(inv, deps, bad, { imageAt: bad.length - 1, timeoutMs: 1 })).toThrow(/a container is made by/);
    }
    expect(calls).toHaveLength(1);
  });

  it("the invocation that made an unknown run never clears it: the promotion keeps it though a listing reads the name absent", async () => {
    const A = await authority();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") return args.includes("cinatra-preview-s1.forward") ? timedOut() : ok(`${ID(1)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      if (args[0] === "container" && args[1] === "ls") return ok("");
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await freshClaim(A, inv);
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(A.createContainer(inv, deps, FWD_ARGS, { imageAt: 6, timeoutMs: 60_000 }).outcome).toBe("unsettled");
    const live = A.liveness(inv, token, deps);
    const out = await A.promoteReady(inv, claim, live, { container: token, deps });
    expect(out).toMatchObject({ ready: false, state: "degraded", left: [unknownRun("cinatra-preview-s1.forward", "timed out")] });
    expect((await rowOf()).state).toBe("degraded");
    expect((await rowOf()).cleanupIncomplete).toEqual([unknownRun("cinatra-preview-s1.forward", "timed out")]);
  });

  it("a later command's own create that takes the name clears an earlier unknown run of it, recorded as that create's container ID", async () => {
    const A = await authority();
    await seed({ state: "degraded", cleanupIncomplete: [unknownRun("cinatra-preview-s1", "timed out"), unknownRun("cinatra-preview-s1.forward", "exit 125")] });
    const { deps } = fakeDocker((args) => {
      if (args[0] === "run") return ok(`${args.includes("cinatra-preview-s1.forward") ? FWD(5) : ID(2)}\n`);
      if (args[0] === "container" && args[1] === "inspect") return ok("true\n");
      // each name is held now: by this command's own containers
      if (args[0] === "container" && args[1] === "ls") return ok("cinatra-preview-s1\ncinatra-preview-s1.forward\n");
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await A.claimRow(inv, { registryPath, slug: "s1", take: (existing) => ({ ...existing }) });
    const token = A.runOwnContainer(inv, { args: RUN_ARGS, deps });
    expect(A.createContainer(inv, deps, FWD_ARGS, { imageAt: 6, timeoutMs: 60_000 })).toMatchObject({ outcome: "done", id: FWD(5) });
    const out = await A.promoteReady(inv, claim, A.liveness(inv, token, deps), { container: token, deps });
    expect(out).toMatchObject({ ready: true, state: "ready" });
    expect(out.cleared).toEqual([{ kind: "run", name: "cinatra-preview-s1", clearedBy: ID(2) },
      { kind: "run", name: "cinatra-preview-s1.forward", clearedBy: FWD(5) }]);
    expect((await rowOf()).cleanupIncomplete).toBeUndefined();
  });

  it("a data volume create docker answers with no success is a leftover by its name, though a listing after it reads it absent", async () => {
    const A = await authority();
    const { deps } = fakeDocker((args) => {
      if (args[0] === "volume" && args[1] === "create") return timedOut();
      if (args[0] === "volume" && args[1] === "ls") return ok("");
      return null;
    });
    const inv = A.beginInvocation();
    const claim = await freshClaim(A, inv);
    expect(() => A.createDataVolume(inv, "cinatra-preview-data-s1", deps)).toThrow(/failed or is uncertain/);
    const volume = { kind: "volume", name: "cinatra-preview-data-s1",
      why: "docker volume create answered timed out; whether it made cinatra-preview-data-s1 is not settled" };
    expect(A.ledgerFailures(inv)).toEqual([volume]);
    expect(await A.settleRow(inv, claim)).toMatchObject({ state: "degraded" });
    expect((await rowOf()).cleanupIncomplete).toEqual([volume]);
  });
});
