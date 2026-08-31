// The loopback access-logging proxy, run as its own process.
//
// `cinatra instance verify-exposure up` is a one-shot CLI: it exits when its
// work is done, so the proxy the mapping points at cannot live inside it. This
// tiny runner is what `up` spawns detached. It binds LOOPBACK ONLY — the tunnel
// mapping is meant to be the one way in from outside, and a proxy on a routable
// interface would quietly be a second one.
//
// It also carries an identity NONCE. `up` will not publish a mapping until this
// process answers its health path with the nonce `up` generated, which is what
// proves the listener on the port is this child and not some unrelated process
// that already held the port; `down` re-checks the same nonce before it
// signals the recorded pid, so a recycled pid can never be killed.
//
// Configuration arrives through the environment rather than argv so nothing
// here shows up in `ps` output beyond the script name.

import {
  VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS,
  createAccessLoggingProxy,
} from "./verification-exposure.mjs";

const upstreamPort = Number(process.env.CINATRA_VERIFY_EXPOSURE_UPSTREAM_PORT);
const proxyPort = Number(process.env.CINATRA_VERIFY_EXPOSURE_PROXY_PORT);
const logPath = process.env.CINATRA_VERIFY_EXPOSURE_LOG_PATH ?? "";
const healthNonce = process.env.CINATRA_VERIFY_EXPOSURE_NONCE ?? "";
const refusedStatus =
  Number(process.env.CINATRA_VERIFY_EXPOSURE_REFUSED_STATUS) ||
  VERIFICATION_EXPOSURE_PROXY_REFUSED_STATUS;

if (!Number.isInteger(upstreamPort) || !Number.isInteger(proxyPort) || !logPath || !healthNonce) {
  console.error(
    "verification-exposure proxy: CINATRA_VERIFY_EXPOSURE_UPSTREAM_PORT, " +
      "CINATRA_VERIFY_EXPOSURE_PROXY_PORT, CINATRA_VERIFY_EXPOSURE_LOG_PATH and " +
      "CINATRA_VERIFY_EXPOSURE_NONCE are all required.",
  );
  process.exit(2);
}

const server = createAccessLoggingProxy({
  upstreamHost: "127.0.0.1",
  upstreamPort,
  logPath,
  refusedStatus,
  healthNonce,
});

// A bind that fails (the port is already taken, most often) must END this
// process, never leave a half-live runner behind: `up` waits for the health
// answer and refuses to publish a mapping when it never comes.
server.on("error", (err) => {
  console.error(`verification-exposure proxy failed: ${err?.message ?? err}`);
  process.exit(1);
});

server.listen(proxyPort, "127.0.0.1", () => {
  console.log(
    `verification-exposure proxy listening on 127.0.0.1:${proxyPort} -> 127.0.0.1:${upstreamPort}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
