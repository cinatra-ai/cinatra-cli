// ---------------------------------------------------------------------------
// cinatra-cli#176 — atomicity guard for the POST-SIDECAR window of
// `cinatra instance tunnel start`.
//
// `runDevTunnel` brings the Tailscale sidecar up (`docker compose up -d
// tailscale`) and only THEN does the work that makes the tunnel useful: wait
// for the registered node identity, check it against the prediction, and write
// `publicBaseUrl` into the app DB. Every step in that window can throw — a
// dev-CLI module that will not resolve, a docker exec that dies, a DB write
// that fails.
//
// An unguarded throw there leaves the operator with a REGISTERED, RUNNING
// Tailscale node and no provisioned URL, and the next `start` short-circuits on
// `isComposeProjectUp` and reports "already running" — so the half-up state is
// self-perpetuating and invisible. This guard makes the verb atomic at the
// operator-visible level: either the tunnel is provisioned, or nothing is left
// running.
//
// Plain ESM leaf — NO node builtins, NO I/O, NO logging. Both the failing
// segment and the teardown are injected, so the whole contract is exercised
// hermetically (no Docker, no network) in tests/dev-tunnel-cleanup.test.mjs.
//
// SCOPE NOTE: this guards THROWN failures only. A typed, RETURNED non-ok
// result (e.g. the hostname-collision guard's
// `{ ok: false, error: TailscaleProvisionError }`) is a decision, not a crash;
// what the verb does with one is owned by the provisioning policy, not by this
// module.
// ---------------------------------------------------------------------------

/**
 * Run the post-sidecar provisioning segment under a teardown guard.
 *
 * `provision` receives a `markProvisioned` callback. It MUST call it as soon
 * as the durable outcome (the `publicBaseUrl` write) has landed: after that
 * point the sidecar is legitimately in service and a later throw must NOT tear
 * it down.
 *
 * Contract:
 *   - resolves with `provision`'s value when it resolves;
 *   - on a throw BEFORE `markProvisioned()` → `tearDownSidecar(err)` is
 *     awaited, then the ORIGINAL error is rethrown (identity preserved, never
 *     wrapped — the caller's message is the operator's cause);
 *   - on a throw AFTER `markProvisioned()` → NO teardown, original rethrown;
 *   - a `tearDownSidecar` that itself throws is swallowed: a failed cleanup
 *     must never replace the failure that triggered it.
 *
 * @template T
 * @param {(markProvisioned: () => void) => Promise<T> | T} provision
 * @param {(cause: unknown) => Promise<unknown> | unknown} tearDownSidecar
 * @returns {Promise<T>}
 */
export async function runPostSidecarProvisioning(provision, tearDownSidecar) {
  if (typeof provision !== "function" || typeof tearDownSidecar !== "function") {
    throw new TypeError(
      "runPostSidecarProvisioning(provision, tearDownSidecar): both arguments must be functions.",
    );
  }
  let provisioned = false;
  const markProvisioned = () => {
    provisioned = true;
  };
  try {
    return await provision(markProvisioned);
  } catch (err) {
    if (!provisioned) {
      try {
        await tearDownSidecar(err);
      } catch {
        // Deliberately swallowed: the operator needs the ORIGINAL cause, and
        // the teardown path reports its own outcome on its own channel.
      }
    }
    throw err;
  }
}
