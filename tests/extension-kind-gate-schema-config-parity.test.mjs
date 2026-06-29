// schema-config DSL drift guard (cinatra-cli#72 / hot-install).
//
// The shipped extension-kind-gate.mjs validates a connector's declarative
// `cinatra.configSchema` (the hot-installable schema-config UI surface). That
// validator MUST stay in lock-step with the AUTHORITATIVE host gate in the
// cinatra monorepo (scripts/extensions/generate-extension-manifest.mjs
// validateConfigSchema) — otherwise an author scaffolds a connector the gate
// accepts but the install pipeline rejects (or vice versa).
//
// This test is the canonical FIXTURE MATRIX. It pins:
//   - the exact extended field-kind set (cinatra#658 added select/record-list/
//     banner/advisory),
//   - a positive example per field kind,
//   - negative cases for every drift axis: unknown root key, unknown field kind,
//     a SMUGGLED per-field key (the pure-data invariant), a missing required
//     key, an empty fields array, and per-kind value rules (select default not
//     in options, banner tone, record-list badge variant, duplicate key).
//
// extension-release-tooling#36 mirrors the gate; this matrix is what its parity
// test re-runs against its copy so the two cannot silently diverge.
//
// AUTHORITY NOTE: the strictest host authority is the RUNTIME RENDERER
// `parseSchemaConfig` (src/lib/extension-schema-config.ts) — it produces the
// `invalid-schema-config` verdict an author actually sees. The install-time
// generator (`generate-extension-manifest.mjs validateConfigSchema`) is slightly
// LOOSER (it omits the renderer's duplicate-select-value and duplicate-banner-
// variant-name checks). This gate is deliberately mirrored to the STRICTER
// renderer so an author cannot pass the gate and then render invalid. The two
// "duplicate …" negative cases below pin that the gate is renderer-strict, not
// generator-loose. (A pure host-vs-CLI parity check runs in the cinatra repo's
// own gate-suite; here we encode the host's expected verdicts as fixtures.)

import { describe, expect, it } from "vitest";

import { validateConfigSchema } from "../templates/_shared/extension-kind-gate.mjs";

// The expected field-kind vocabulary (host generate-extension-manifest.mjs
// SCHEMA_CONFIG_FIELD_KINDS as of cinatra#658). A new host field kind must be
// added HERE and in the gate together, or this test fails.
const EXPECTED_FIELD_KINDS = [
  "text",
  "secret",
  "nango-connect",
  "repeatable-list",
  "status-probe",
  "copyable-credential",
  "named-action",
  "select",
  "record-list",
  "banner",
  "advisory",
];

// One VALID minimal field per kind — the gate must accept each.
const VALID_FIELD = {
  text: { kind: "text", key: "u", label: "U" },
  secret: { kind: "secret", key: "s", label: "S" },
  "nango-connect": { kind: "nango-connect", label: "Connect", providerConfigKey: "acme" },
  "repeatable-list": {
    kind: "repeatable-list",
    key: "rows",
    label: "Rows",
    itemFields: [{ kind: "text", key: "a", label: "A" }],
  },
  "status-probe": { kind: "status-probe", label: "Status", actionId: "check" },
  "copyable-credential": { kind: "copyable-credential", key: "tok", label: "Token" },
  "named-action": { kind: "named-action", label: "Go", actionId: "do_it" },
  select: {
    kind: "select",
    key: "scope",
    label: "Scope",
    options: [{ value: "a", label: "A" }, { value: "b", label: "B", adminOnly: true }],
    defaultValue: "a",
  },
  "record-list": {
    kind: "record-list",
    label: "Servers",
    listActionId: "list_servers",
    deleteActionId: "del_server",
    emptyState: "None yet",
    itemTitleKey: "label",
    itemBadges: [{ key: "scope", label: "Scope", variant: "secondary" }],
  },
  banner: { kind: "banner", label: "B", variants: [{ name: "saved", tone: "success", message: "Saved" }] },
  advisory: {
    kind: "advisory",
    label: "A",
    tone: "warning",
    probeActionId: "probe",
    whenReady: "Ready",
    whenNotReady: "Not ready",
  },
};

describe("schema-config validator — field-kind vocabulary", () => {
  it("accepts a positive example of every supported field kind", () => {
    for (const kind of EXPECTED_FIELD_KINDS) {
      const errs = validateConfigSchema({ fields: [VALID_FIELD[kind]] });
      expect(errs, `${kind} should be valid: ${errs.join("; ")}`).toEqual([]);
    }
  });

  it("accepts the extended cinatra#658 vocabulary (select/record-list/banner/advisory)", () => {
    for (const kind of ["select", "record-list", "banner", "advisory"]) {
      expect(EXPECTED_FIELD_KINDS).toContain(kind);
      expect(validateConfigSchema({ fields: [VALID_FIELD[kind]] })).toEqual([]);
    }
  });

  it("accepts a full multi-field schema with title + description", () => {
    const schema = {
      title: "Acme",
      description: "Configure Acme.",
      fields: EXPECTED_FIELD_KINDS.map((k) => VALID_FIELD[k]),
    };
    expect(validateConfigSchema(schema)).toEqual([]);
  });
});

describe("schema-config validator — negative cases (fail-closed pure-data invariant)", () => {
  const NEGATIVE = {
    "non-object schema": "nope",
    "empty fields array": { fields: [] },
    "missing fields array": { title: "x" },
    "unknown root key": { fields: [VALID_FIELD.text], bogus: 1 },
    "unknown field kind": { fields: [{ kind: "totally-fake", label: "X" }] },
    "smuggled per-field key (executable carrier)": {
      fields: [{ kind: "text", key: "u", label: "U", onClick: "alert(1)" }],
    },
    "missing required key (text without key)": { fields: [{ kind: "text", label: "U" }] },
    "duplicate key across fields": {
      fields: [
        { kind: "text", key: "dup", label: "A" },
        { kind: "secret", key: "dup", label: "B" },
      ],
    },
    "select default not in options": {
      fields: [{ kind: "select", key: "s", label: "S", options: [{ value: "a", label: "A" }], defaultValue: "zzz" }],
    },
    "select smuggled option key": {
      fields: [{ kind: "select", key: "s", label: "S", options: [{ value: "a", label: "A", evil: 1 }] }],
    },
    "banner invalid tone": {
      fields: [{ kind: "banner", label: "B", variants: [{ name: "x", tone: "neon", message: "m" }] }],
    },
    "record-list invalid badge variant": {
      fields: [
        {
          kind: "record-list",
          label: "L",
          listActionId: "l",
          emptyState: "e",
          itemTitleKey: "t",
          itemBadges: [{ key: "k", label: "L", variant: "rainbow" }],
        },
      ],
    },
    "advisory missing whenNotReady": {
      fields: [{ kind: "advisory", label: "A", tone: "warning", probeActionId: "p", whenReady: "ok" }],
    },
    // Renderer-strict (vs the looser install generator): a duplicate select
    // option value / banner variant name renders `invalid-schema-config`, so the
    // gate rejects it too.
    "select duplicate option value": {
      fields: [
        {
          kind: "select",
          key: "s",
          label: "S",
          options: [{ value: "a", label: "A" }, { value: "a", label: "Again" }],
        },
      ],
    },
    "banner duplicate variant name": {
      fields: [
        {
          kind: "banner",
          label: "B",
          variants: [
            { name: "saved", tone: "success", message: "Saved" },
            { name: "saved", tone: "info", message: "Saved again" },
          ],
        },
      ],
    },
  };

  for (const [name, input] of Object.entries(NEGATIVE)) {
    it(`rejects: ${name}`, () => {
      const errs = validateConfigSchema(input);
      expect(errs.length, `expected ≥1 error for "${name}", got none`).toBeGreaterThan(0);
    });
  }
});
