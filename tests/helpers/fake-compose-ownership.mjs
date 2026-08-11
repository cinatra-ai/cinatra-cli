// A hermetic stand-in for the docker CONTAINER-METADATA queries the preview
// endpoint-ownership gate runs (cinatra-ai/cinatra-cli#219):
//
//   docker ps -a -q
//   docker inspect <id> [<id> ...]
//
// `state.compose` is the modelled world:
//   { containers: [{ id, name, service, project, workingDir, running, state,
//                    ports: [[hostIp, hostPort, containerPort]] }] }
//
// When `state.compose` is ABSENT the responder reports the probe as
// UNAVAILABLE (a non-zero `docker ps`), which is what a fake that does not
// model compose truthfully is: an UNKNOWN, never an ownership claim. The gate
// then warns and proceeds, so a suite that is about something else is unchanged
// by the gate's existence.

export const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
export const PROJECT_LABEL = "com.docker.compose.project";
export const SERVICE_LABEL = "com.docker.compose.service";

/** One `docker inspect` row for a modelled container. */
export function inspectRowFor(c) {
  const ports = {};
  for (const [hostIp, hostPort, containerPort] of c.ports ?? []) {
    const spec = `${containerPort ?? hostPort}/tcp`;
    ports[spec] = [...(ports[spec] ?? []), { HostIp: hostIp, HostPort: String(hostPort) }];
  }
  return {
    Name: `/${c.name}`,
    State: { Running: c.running !== false, Status: c.state ?? (c.running === false ? "exited" : "running") },
    Config: {
      Labels: {
        [PROJECT_LABEL]: c.project,
        [WORKING_DIR_LABEL]: c.workingDir,
        [SERVICE_LABEL]: c.service,
      },
    },
    NetworkSettings: { Ports: ports },
  };
}

/**
 * Answer an ownership-probe argv, or return `null` when `args` is not one of
 * them (so a caller's own fake keeps handling everything else).
 */
export function answerComposeOwnership(args, state = {}) {
  const [verb] = args;
  const world = state.compose;
  if (verb === "ps") {
    if (!world) return { status: 1, stdout: "", stderr: "fake: container metadata not modelled" };
    const ids = (world.containers ?? []).map((c) => c.id);
    return { status: 0, stdout: ids.join("\n") + (ids.length ? "\n" : ""), stderr: "" };
  }
  if (verb === "inspect") {
    if (!world) return { status: 1, stdout: "", stderr: "fake: compose metadata not modelled" };
    const ids = args.slice(1);
    const rows = (world.containers ?? []).filter((c) => ids.includes(c.id)).map(inspectRowFor);
    return { status: 0, stdout: JSON.stringify(rows), stderr: "" };
  }
  return null;
}
