// Isolated A2A dev-peer pure helpers (cinatra-cli#113).
//
// These back the `cinatra instance a2a start|stop` command and the in-place
// isolated-compose regeneration. Everything under test is pure (no docker, fs,
// or registry) — the docker/registry-coupled orchestration in install.mjs is
// exercised end-to-end on a real isolated install.

import { describe, expect, it } from "vitest";

import {
  A2A_PEERS_PROFILE,
  A2A_PEER_ENV_KEY,
  deriveA2aPeerServices,
  isolatedComposeHasA2aPeers,
  a2aPeerUrlsFromServices,
  deriveBandOffsetFromRow,
  sharedServicePortsAgree,
  removeEnvKey,
} from "../src/isolated-a2a.mjs";

// A compose service as `docker compose config --format json` emits it: ports are
// objects with a (string) `published`, and `profiles` is a string array.
const svc = (published, profiles) => ({
  ...(published == null ? {} : { ports: [{ published: String(published), target: 80, protocol: "tcp" }] }),
  ...(profiles ? { profiles } : {}),
});

// A generated ISOLATED compose doc (remapped host ports baked in) mirroring the
// a2a-peers band shifted by an offset of 20000.
const isolatedDocWithPeers = () => ({
  services: {
    postgres: svc(25434),
    redis: svc(26379),
    "a2a-peer-helloworld": svc(30001, [A2A_PEERS_PROFILE]),
    "a2a-peer-number-alice": svc(30002, [A2A_PEERS_PROFILE]),
    "a2a-peer-dice-rest": svc(30005, [A2A_PEERS_PROFILE]),
    // In the a2a-peers profile but publishes NO host port → excluded (nothing to reach).
    "a2a-peer-number-bob": svc(null, [A2A_PEERS_PROFILE]),
    // A different profile with a port → not an a2a peer.
    wayflow: svc(23010, ["wayflow"]),
  },
});

describe("constants", () => {
  it("expose the profile + env-key the app boot-connect reads", () => {
    expect(A2A_PEERS_PROFILE).toBe("a2a-peers");
    expect(A2A_PEER_ENV_KEY).toBe("CINATRA_A2A_DEV_PEER_URLS");
  });
});

describe("deriveA2aPeerServices", () => {
  it("enumerates only a2a-peers-profiled services WITH a published port, sorted by host port", () => {
    const peers = deriveA2aPeerServices(isolatedDocWithPeers());
    expect(peers).toEqual([
      { name: "a2a-peer-helloworld", hostPort: 30001 },
      { name: "a2a-peer-number-alice", hostPort: 30002 },
      { name: "a2a-peer-dice-rest", hostPort: 30005 },
    ]);
  });

  it("excludes profile-less services, other-profile services, and port-less peers", () => {
    const peers = deriveA2aPeerServices(isolatedDocWithPeers());
    const names = peers.map((p) => p.name);
    expect(names).not.toContain("postgres"); // no profile
    expect(names).not.toContain("wayflow"); // wrong profile
    expect(names).not.toContain("a2a-peer-number-bob"); // no published port
  });

  it("is total on a malformed / empty doc", () => {
    expect(deriveA2aPeerServices(null)).toEqual([]);
    expect(deriveA2aPeerServices({})).toEqual([]);
    expect(deriveA2aPeerServices({ services: null })).toEqual([]);
    expect(deriveA2aPeerServices({ services: { x: {} } })).toEqual([]);
  });
});

describe("isolatedComposeHasA2aPeers", () => {
  it("is true when at least one a2a-peer publishes a port", () => {
    expect(isolatedComposeHasA2aPeers(isolatedDocWithPeers())).toBe(true);
  });

  it("is false for a profile-less (pre-baking) compose", () => {
    expect(isolatedComposeHasA2aPeers({ services: { postgres: svc(25434), redis: svc(26379) } })).toBe(false);
  });

  it("is false when the only a2a-peer publishes no port (unusual partial state → regenerate)", () => {
    expect(isolatedComposeHasA2aPeers({ services: { "a2a-peer-number-bob": svc(null, [A2A_PEERS_PROFILE]) } })).toBe(
      false,
    );
  });
});

describe("a2aPeerUrlsFromServices", () => {
  it("maps each peer to a loopback URL on its remapped host port", () => {
    expect(
      a2aPeerUrlsFromServices([
        { name: "a2a-peer-helloworld", hostPort: 30001 },
        { name: "a2a-peer-dice-rest", hostPort: 30005 },
      ]),
    ).toEqual(["http://localhost:30001", "http://localhost:30005"]);
  });

  it("is total on non-arrays", () => {
    expect(a2aPeerUrlsFromServices(null)).toEqual([]);
    expect(a2aPeerUrlsFromServices(undefined)).toEqual([]);
  });
});

describe("deriveBandOffsetFromRow", () => {
  // Base (un-remapped) published band, `[{ service, port }]` (the extra `host`
  // parseComposePublishedPorts emits is ignored here).
  const baseBand = [
    { service: "postgres", port: 5434 },
    { service: "redis", port: 6379 },
    { service: "nango-server", port: 3003 },
  ];

  it("derives a single consistent offset from the recorded remapped ports", () => {
    const rowPorts = { postgres: [25434], redis: [26379], "nango-server": [23003] };
    expect(deriveBandOffsetFromRow(rowPorts, baseBand)).toBe(20000);
  });

  it("tolerates extra recorded services not in the base band", () => {
    const rowPorts = { postgres: [25434], redis: [26379], "nango-server": [23003], "a2a-peer-helloworld": [30001] };
    expect(deriveBandOffsetFromRow(rowPorts, baseBand)).toBe(20000);
  });

  it("returns null on DISAGREEMENT across shared services (never guesses)", () => {
    const rowPorts = { postgres: [25434], redis: [16379] }; // postgres→+20000, redis→+10000
    expect(deriveBandOffsetFromRow(rowPorts, baseBand)).toBeNull();
  });

  it("returns null when a shared service's port count mismatches", () => {
    const rowPorts = { postgres: [25434, 25435] }; // base postgres has 1 port
    expect(deriveBandOffsetFromRow(rowPorts, baseBand)).toBeNull();
  });

  it("returns null when NO shared service lines up (0 overlap)", () => {
    expect(deriveBandOffsetFromRow({ unknown: [12345] }, baseBand)).toBeNull();
    expect(deriveBandOffsetFromRow({}, baseBand)).toBeNull();
  });

  it("returns null on a non-positive candidate offset (recorded below base)", () => {
    expect(deriveBandOffsetFromRow({ postgres: [5434] }, baseBand)).toBeNull(); // offset 0
    expect(deriveBandOffsetFromRow({ postgres: [5000] }, baseBand)).toBeNull(); // negative
  });

  it("is total on bad inputs", () => {
    expect(deriveBandOffsetFromRow(null, baseBand)).toBeNull();
    expect(deriveBandOffsetFromRow({ postgres: [25434] }, [])).toBeNull();
    expect(deriveBandOffsetFromRow({ postgres: [25434] }, null)).toBeNull();
  });
});

describe("sharedServicePortsAgree", () => {
  it("is true when every shared service keeps its port (order-insensitive)", () => {
    expect(sharedServicePortsAgree({ postgres: [25434], redis: [26379] }, { postgres: [25434], redis: [26379] })).toBe(
      true,
    );
    expect(sharedServicePortsAgree({ a: [1, 2] }, { a: [2, 1] })).toBe(true); // sorted compare
  });

  it("ignores services present on only ONE side (new peers / dropped ports)", () => {
    // A regenerated map adds the a2a peers — the shared infra ports still agree.
    expect(
      sharedServicePortsAgree(
        { postgres: [25434], redis: [26379] },
        { postgres: [25434], redis: [26379], "a2a-peer-helloworld": [30001] },
      ),
    ).toBe(true);
    // A service that dropped its published port cannot "move".
    expect(sharedServicePortsAgree({ postgres: [25434], gone: [9999] }, { postgres: [25434] })).toBe(true);
  });

  it("is false when a shared service's port MOVED (the live-relocation hazard)", () => {
    expect(sharedServicePortsAgree({ postgres: [25434] }, { postgres: [35434] })).toBe(false);
  });

  it("is false when a shared service's port COUNT changed", () => {
    expect(sharedServicePortsAgree({ postgres: [25434] }, { postgres: [25434, 25435] })).toBe(false);
  });

  it("treats an empty/absent recorded map as trivially agreeing", () => {
    expect(sharedServicePortsAgree({}, { postgres: [25434] })).toBe(true);
    expect(sharedServicePortsAgree(null, { postgres: [25434] })).toBe(true);
  });
});

describe("removeEnvKey", () => {
  it("removes the key line and collapses its newline, leaving siblings intact", () => {
    const body = "PORT=3000\nCINATRA_A2A_DEV_PEER_URLS=http://localhost:30001,http://localhost:30002\nREDIS_URL=redis://x\n";
    expect(removeEnvKey(body, A2A_PEER_ENV_KEY)).toBe("PORT=3000\nREDIS_URL=redis://x\n");
  });

  it("removes ALL occurrences", () => {
    const body = "A2A=1\nX=2\nA2A=3\n";
    expect(removeEnvKey(body, "A2A")).toBe("X=2\n");
  });

  it("is a no-op when the key is absent or the body is empty", () => {
    expect(removeEnvKey("X=1\n", A2A_PEER_ENV_KEY)).toBe("X=1\n");
    expect(removeEnvKey("", A2A_PEER_ENV_KEY)).toBe("");
    expect(removeEnvKey(null, A2A_PEER_ENV_KEY)).toBe("");
  });

  it("does not match a key that is only a PREFIX of another key", () => {
    const body = "CINATRA_A2A_DEV_PEER_URLS_EXTRA=keep\nCINATRA_A2A_DEV_PEER_URLS=drop\n";
    expect(removeEnvKey(body, A2A_PEER_ENV_KEY)).toBe("CINATRA_A2A_DEV_PEER_URLS_EXTRA=keep\n");
  });
});
