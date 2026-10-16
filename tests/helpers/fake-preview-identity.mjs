// A hermetic stand-in for the docker reads that bind a preview to the records
// its own run made: the ID a `docker run -d` prints, the status-checked
// `docker container inspect --format {{.Id}}` of the live container, and the
// data volume `create` makes with its own nonce label and reads back. A fake
// docker calls `answerPreviewIdentity` before its own branches and answers a
// preview `run -d` with `nextRunId(state)`.

/** The ID of a container a test seeds without a run (a row with no record). */
export const SEED_CONTAINER_ID = `5eed${"0".repeat(60)}`;

/** The next container ID a fake `docker run -d` prints; it becomes the live one. */
export function nextRunId(state) {
  state.runIds = (state.runIds ?? 0) + 1;
  const id = state.runIds.toString(16).padStart(64, "c");
  state.liveContainerId = id;
  return id;
}

export function liveContainerId(state) {
  return state.liveContainerId ?? SEED_CONTAINER_ID;
}

const timedOut = () => ({ status: null, stdout: "", stderr: "", timedOut: true, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });

/**
 * Answer a data-volume create, its label read, or a container's ID read; null
 * for anything else. `state.volumeExists` / `state.volumeLabels` model a data
 * volume that was there before the run (docker hands it back unchanged);
 * `state.volumeProbeUnanswered` makes the label read time out.
 */
export function answerPreviewIdentity(args, state, { containerExists }) {
  const [verb, sub] = args;
  const last = String(args.at(-1));
  if (verb === "volume" && !last.startsWith("cinatra-preview-artifacts-")) {
    state.dataVolumes ??= {};
    if (sub === "create") {
      if (!Object.hasOwn(state.dataVolumes, last)) {
        const label = String(args[args.indexOf("--label") + 1] ?? "");
        const [key, value = ""] = label.split(/=(.*)/s);
        state.dataVolumes[last] = state.volumeExists ? (state.volumeLabels ?? {}) : { [key]: value };
      }
      return { status: 0, stdout: `${last}\n`, stderr: "" };
    }
    if (sub === "inspect" && args.includes("{{json .Labels}}")) {
      if (state.volumeProbeUnanswered) return timedOut();
      // `volumeLabelsOnReread`: a volume replaced under the name after the first label read
      state.labelReads = (state.labelReads ?? 0) + 1;
      if (state.volumeLabelsOnReread && state.labelReads > 1) return { status: 0, stdout: `${JSON.stringify(state.volumeLabelsOnReread)}\n`, stderr: "" };
      if (state.labelRereadFails && state.labelReads > 1) return { status: 1, stdout: "", stderr: "" };
      if (Object.hasOwn(state.dataVolumes, last)) return { status: 0, stdout: `${JSON.stringify(state.dataVolumes[last])}\n`, stderr: "" };
      if (state.volumeExists) return { status: 0, stdout: `${JSON.stringify(state.volumeLabels ?? {})}\n`, stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    }
  }
  if (verb === "container" && sub === "inspect" && args.includes("{{.Id}}")) {
    if (state.idReadAnswer) return state.idReadAnswer(args);
    return containerExists(state) ? { status: 0, stdout: `${liveContainerId(state)}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "" };
  }
  return null;
}
