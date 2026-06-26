// Cinatra-owned SUPERSET skill-frontmatter validator (cinatra-cli#44 / #45).
//
// WHAT THIS IS. A zero-dependency validator for SKILL.md frontmatter that
// implements EVERY rule the upstream skills validator enforces
// (~/.codex/skills/.system/skill-creator/scripts/quick_validate.py) and adds
// ONE Cinatra-specific allowance: Cinatra project keys (`match_when`,
// `cinatra-watches`) are permitted ONLY when nested under the `metadata:`
// extension point — NEVER as top-level keys. The upstream validator already
// allows an opaque `metadata` mapping, so a SKILL.md that passes THIS validator
// also passes the upstream one. We are a superset of acceptance over a frontmatter
// shape, not a divergent schema: we never bless a key upstream rejects.
//
// WHY ZERO-DEP / WHY HAND-ROLLED. The thin `@cinatra-ai/cinatra` CLI ships zero
// runtime dependencies (CI asserts it), so we cannot pull `js-yaml`. SKILL.md
// frontmatter is a small, well-bounded shape — top-level scalar keys plus a
// `metadata:` block of nested mappings/sequences — so a focused, faithful parser
// is both sufficient and the established pattern for reading this frontmatter.
//
// The upstream rules we replicate (the complete list):
//   - file must start with `---` and contain a `---\n…\n---` block,
//   - frontmatter must parse to a mapping (dict),
//   - only {name, description, license, allowed-tools, metadata} top-level keys,
//   - `name` and `description` are required,
//   - `name` is a string, hyphen-case `^[a-z0-9-]+$`, ≤ 64 chars, no
//     leading/trailing/double hyphen,
//   - `description` is a string, contains no `<` or `>`, ≤ 1024 chars.

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
]);
const NAME_RE = /^[a-z0-9-]+$/;

/**
 * Extract the YAML frontmatter block from a SKILL.md string.
 * Returns { ok, frontmatter, error } where `frontmatter` is the raw text
 * between the leading `---` and the next `---` line.
 */
export function extractFrontmatter(content) {
  if (typeof content !== "string" || !content.startsWith("---")) {
    return { ok: false, error: "No YAML frontmatter found" };
  }
  // Mirror the upstream regex `^---\n(.*?)\n---` (DOTALL): the block is the text
  // from the first line after the opening `---` up to (not including) the next
  // `---` line. Normalize CRLF so authoring on Windows does not spuriously fail.
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n(.*?)\n---/s.exec(normalized);
  if (!match) return { ok: false, error: "Invalid frontmatter format" };
  return { ok: true, frontmatter: match[1] };
}

/**
 * Parse a SKILL.md frontmatter block into a shallow object of top-level keys.
 * This is NOT a general YAML parser: it understands the bounded frontmatter
 * shape (top-level `key: value` scalars + a nested `metadata:` block) and is
 * deliberately strict so that the YAML mistakes the upstream `yaml.safe_load`
 * rejects (chiefly an unquoted colon-bearing value) ALSO fail here with an
 * "Invalid YAML in frontmatter" error — the exact upstream failure string.
 *
 * Returns { ok, value, error }. On success `value` is a plain object whose
 * top-level keys map to either a string (scalars) or the sentinel object
 * { __block: true } for a nested block such as `metadata:` (we only need to
 * know a block key is PRESENT and well-indented, not its full structure).
 */
export function parseFrontmatter(frontmatterText) {
  const rawLines = frontmatterText.split("\n");
  const value = {};
  let i = 0;

  const invalid = (msg) => ({ ok: false, error: `Invalid YAML in frontmatter: ${msg}` });

  while (i < rawLines.length) {
    const line = rawLines[i];
    // Skip blank lines and comments at the top level.
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    // A non-blank top-level line must start in column 0 (no leading space). A
    // leading-space line here means a nested mapping with no parent key, which
    // safe_load rejects.
    if (/^\s/.test(line)) {
      return invalid(`unexpected indentation at line ${i + 1}: ${JSON.stringify(line)}`);
    }
    // Each top-level entry must be `key:` or `key: value`. The key is up to the
    // FIRST colon; a value with an UNQUOTED later colon is the classic
    // mapping-values-not-allowed YAML error and must be rejected.
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) {
      return invalid(`expected "key: value" at line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, colonIdx).trim();
    if (key === "") {
      return invalid(`empty key at line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const rest = line.slice(colonIdx + 1);

    // A block key (e.g. `metadata:` with no inline value, children indented
    // below). The upstream validator does not inspect the metadata STRUCTURE,
    // but it DOES require the whole document to `safe_load` — so a child block
    // with PyYAML-invalid syntax must fail here too. We validate every child
    // line well enough to reject the cases that crash safe_load (unrendered
    // {{token}}, tab indentation, an in-value colon-mapping `a: b`, and an
    // unbalanced flow collection), without trying to model arbitrary YAML.
    if (rest.trim() === "") {
      let j = i + 1;
      const childLines = [];
      while (j < rawLines.length) {
        const child = rawLines[j];
        if (child.trim() === "" || child.trimStart().startsWith("#")) {
          j += 1;
          continue;
        }
        if (/^\s/.test(child)) {
          childLines.push({ text: child, lineNo: j + 1 });
          j += 1;
          continue;
        }
        break; // next top-level key (dedented)
      }
      const blockErr = validateNestedBlock(childLines);
      if (blockErr) return invalid(`in nested "${key}" block: ${blockErr}`);
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        return invalid(`duplicate key "${key}" at line ${i + 1}`);
      }
      value[key] = { __block: true };
      i = j;
      continue;
    }

    // An inline scalar value. Reject an unquoted value that itself contains a
    // colon-space (`a: b`), which safe_load treats as a nested mapping and
    // rejects in this position — the unquoted colon-heavy description bug.
    const scalar = parseScalar(rest);
    if (!scalar.ok) return invalid(`${scalar.error} at line ${i + 1}`);
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return invalid(`duplicate key "${key}" at line ${i + 1}`);
    }
    value[key] = scalar.value;
    i += 1;
  }

  return { ok: true, value };
}

/**
 * Validate the child lines of a nested block (e.g. under `metadata:`) well enough
 * to reject the syntaxes that crash PyYAML's safe_load — WITHOUT modeling full
 * YAML. Returns null on OK, or an error string. Rejected: tab indentation, an
 * unrendered `{{token}}`, an in-value colon-mapping in a sequence/scalar item,
 * and an unbalanced flow collection. A nested `key:` block (deeper mapping) is
 * accepted recursively by the same rules.
 */
function validateNestedBlock(childLines) {
  // Block-collection consistency at the DIRECT-CHILD level: the block's own
  // immediate children (the shallowest indent under the block key) must be EITHER
  // all sequence items (`- …`) OR all mapping keys (`key:`), never both — PyYAML
  // rejects that mix. We only enforce this at the minimum indent (a deeper level
  // belongs to a sub-block under a different parent and is validated as its own
  // value), which avoids false-positives across sibling sub-blocks.
  const indents = childLines
    .filter((l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"))
    .map((l) => l.text.length - l.text.trimStart().length);
  const minIndent = indents.length ? Math.min(...indents) : 0;
  let directKind = null;

  for (const { text, lineNo } of childLines) {
    if (/^\t/.test(text) || /^\s*\t/.test(text)) {
      return `tab indentation is not allowed (line ${lineNo})`;
    }
    if (/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/.test(text)) {
      return `unrendered template placeholder (line ${lineNo})`;
    }
    const content = text.trim();
    if (content === "" || content.startsWith("#")) continue;

    const indent = text.length - text.trimStart().length;
    if (indent === minIndent) {
      const kind = content.startsWith("- ") || content === "-" ? "seq" : "map";
      if (directKind && directKind !== kind) {
        return `mixed sequence and mapping at the same indentation (line ${lineNo})`;
      }
      directKind = kind;
    }

    // A sequence item: `- <value>`. The item itself may be a one-line mapping
    // (`- key: value` → a mapping element), which is valid YAML — so when the
    // item carries a `key:`, validate only the mapping's VALUE part, not the
    // whole item (the item-level colon is the mapping separator, not an error).
    if (content.startsWith("- ") || content === "-") {
      const itemVal = content === "-" ? "" : content.slice(2).trim();
      const itemColon = itemVal.indexOf(":");
      const isInlineMapping =
        itemColon > 0 &&
        itemVal[0] !== '"' &&
        itemVal[0] !== "'" &&
        itemVal[0] !== "{" &&
        itemVal[0] !== "[" &&
        /^[\w.-]+:(\s|$)/.test(itemVal); // `key:` or `key: …`
      const toCheck = isInlineMapping ? itemVal.slice(itemColon + 1).trim() : itemVal;
      const e = checkNestedValue(toCheck, lineNo);
      if (e) return e;
      continue;
    }
    // A mapping line: `key: value` or `key:` (deeper block). A line with no
    // colon is a bare scalar continuation — validate it as a value too.
    const colonIdx = content.indexOf(":");
    if (colonIdx < 0) {
      const e = checkNestedValue(content, lineNo);
      if (e) return e;
      continue;
    }
    const valuePart = content.slice(colonIdx + 1).trim();
    const e = checkNestedValue(valuePart, lineNo);
    if (e) return e;
  }
  return null;
}

// YAML indicator characters that may NOT start a plain scalar. `{`/`[` are valid
// when they OPEN a flow collection (handled separately); the rest (`@`, `*`, `!`,
// `` ` ``, `&`, `%`, `?`, `,`, `>`, `|`, `#`) make a bare value invalid in this
// position — PyYAML rejects an unquoted value starting with one.
const PLAIN_FORBIDDEN_FIRST = "@*!`&%?,>|#}]";

/**
 * Validate a YAML FLOW value (`{...}` / `[...]`) the way PyYAML's parser does,
 * with a quote-aware, STACK-based scanner. Returns null on OK or an error string.
 * Catches: crossed delimiters (`[{]}`), unbalanced brackets, malformed entry
 * separators (`[a,,b]`), an indicator-starting bare scalar inside flow (`[@foo]`),
 * a double key separator (`{a: b: c}`), and an invalid escape in a quoted flow
 * entry (`["\q"]`). It recursively validates nested flow collections and quoted
 * strings; bare scalars are checked only for a leading indicator (their typed
 * resolution is irrelevant — metadata is opaque to the validator's rules).
 */
function validateFlow(s) {
  let i = 0;
  const n = s.length;
  const skipWs = () => {
    while (i < n && (s[i] === " " || s[i] === "\t")) i += 1;
  };
  // Parse one flow node starting at i. Returns null on OK or an error string.
  const parseNode = () => {
    skipWs();
    if (i >= n) return "unexpected end of flow value";
    const ch = s[i];
    if (ch === "[" || ch === "{") return parseCollection(ch);
    if (ch === '"' || ch === "'") {
      // Consume exactly the quoted token, then validate its escapes on that token
      // alone (so the flow delimiters that follow it — `]`, `,`, `:` — are not
      // mistaken for trailing junk).
      const end = advancePastQuoted(s, i, ch);
      const token = s.slice(i, end);
      const r = ch === '"' ? parseDoubleQuoted(token) : parseSingleQuoted(token);
      if (!r.ok) return r.error;
      i = end;
      return null;
    }
    // A bare plain scalar inside flow: read until a flow delimiter `, ] } :`.
    const start = i;
    while (i < n && ![",", "]", "}", ":"].includes(s[i])) i += 1;
    const token = s.slice(start, i).trim();
    if (token === "") return "empty flow entry";
    if (PLAIN_FORBIDDEN_FIRST.includes(token[0])) {
      return "flow scalar begins with a YAML indicator and must be quoted";
    }
    return null;
  };
  // Parse `[...]` or `{...}` (the opener at i). Returns null on OK or an error.
  const parseCollection = (opener) => {
    const closer = opener === "[" ? "]" : "}";
    i += 1; // past opener
    skipWs();
    if (i < n && s[i] === closer) {
      i += 1;
      return null;
    } // empty collection
    for (;;) {
      const keyErr = parseNode();
      if (keyErr) return keyErr;
      skipWs();
      // Optional `: value` (mapping entry). A SECOND `:` before the next
      // separator is the `{a: b: c}` malformation.
      if (i < n && s[i] === ":") {
        i += 1;
        const valErr = parseNode();
        if (valErr) return valErr;
        skipWs();
        if (i < n && s[i] === ":") return "malformed flow mapping (double key separator)";
      }
      if (i >= n) return "unterminated flow collection";
      if (s[i] === ",") {
        i += 1;
        skipWs();
        if (i < n && (s[i] === "," || s[i] === closer)) return "malformed flow separator";
        continue;
      }
      if (s[i] === closer) {
        i += 1;
        return null;
      }
      return `unexpected character "${s[i]}" in flow collection`;
    }
  };
  const err = parseNode();
  if (err) return err;
  skipWs();
  if (i !== n) {
    // Allow a trailing comment.
    if (s.slice(i).trimStart().startsWith("#")) return null;
    return "unexpected content after flow value";
  }
  return null;
}

/** Index just past a quoted string starting at `start` (quote char `q`). */
function advancePastQuoted(s, start, q) {
  let k = start + 1;
  while (k < s.length) {
    if (q === '"' && s[k] === "\\") {
      k += 2;
      continue;
    }
    if (s[k] === q) {
      if (q === "'" && s[k + 1] === "'") {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k += 1;
  }
  return s.length;
}

/** Check a nested VALUE (mapping value or sequence item) for PyYAML-fatal shapes. */
function checkNestedValue(valuePart, lineNo) {
  if (valuePart === "") return null; // `key:` opens a deeper block — fine
  const first = valuePart[0];

  // A quoted string: validate its escapes/termination exactly like a top-level
  // scalar (so `foo: "\q"` is rejected and a trailing-junk quote is caught).
  if (first === '"') {
    const r = parseDoubleQuoted(valuePart);
    return r.ok ? null : `${r.error} (line ${lineNo})`;
  }
  if (first === "'") {
    const r = parseSingleQuoted(valuePart);
    return r.ok ? null : `${r.error} (line ${lineNo})`;
  }

  // A flow collection (`{...}` / `[...]`): validate it with a real quote-aware,
  // stack-based scanner (regex/bracket-counting misses crossed delimiters, bad
  // separators, indicator-starting tokens, and escapes inside quoted entries).
  if (first === "{" || first === "[") {
    const e = validateFlow(valuePart);
    return e ? `${e} (line ${lineNo})` : null;
  }

  // A bare plain scalar. Reject a leading indicator char (`@x/y`, `*ref`, etc.).
  if (PLAIN_FORBIDDEN_FIRST.includes(first)) {
    return `value begins with a YAML indicator and must be quoted (line ${lineNo})`;
  }
  // An UNQUOTED value with a colon-space is a nested mapping in value position
  // (`foo: a: b`), which PyYAML rejects.
  const commentMatch = /\s+#.*$/.exec(valuePart);
  const bare = commentMatch ? valuePart.slice(0, commentMatch.index).trim() : valuePart;
  if (/:\s/.test(bare) || /:$/.test(bare)) {
    return `mapping value not allowed here — quote a value containing a colon (line ${lineNo})`;
  }
  // A bare value that LOOKS like a timestamp but is out of range (`2026-99-99`)
  // matches PyYAML's resolver regex but raises during date construction.
  if (YAML_TIMESTAMP_RE.test(bare) && !isConstructibleTimestamp(bare)) {
    return `invalid timestamp value (out of range) — quote it if it is a string (line ${lineNo})`;
  }
  return null;
}

// A bare (unquoted) plain scalar that PyYAML's SafeLoader resolves to a
// NON-STRING value. We resolve to the SAME typed JS value so the validator's
// "Name/Description must be a string" check fires exactly as upstream — a bare
// `name: 123`, `name: yes`, `name: 2026-06-26`, `description: false` must NOT be
// silently accepted as a string. These regexes mirror PyYAML's implicit-resolver
// (YAML 1.1 core schema): bool (yes/no/on/off/true/false), null, int (incl hex,
// octal, binary, underscored, sexagesimal), float (incl .inf/.nan, sexagesimal),
// and timestamp. A typed NON-string is represented by the sentinel object
// { __typed: "<kind>" } — its actual value is irrelevant; only its non-string-ness
// matters to the validator.
const YAML_BOOL_RE = /^(yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const YAML_NULL_RE = /^(null|Null|NULL|~)$/;
// int/float/timestamp regexes are ported VERBATIM from PyYAML's SafeLoader
// implicit resolvers (YAML 1.1 core schema) so this validator resolves the exact
// same set of bare values to non-strings as `yaml.safe_load`. Notably: a float
// REQUIRES a `.` and its exponent REQUIRES an explicit sign (so `1e3` and
// `1.0e3` are STRINGS, `1.0e+3` is a float); octal is `0[0-7]` (so `0o10` is a
// string); sexagesimal `1:20` is an int.
const YAML_INT_RE =
  /^[-+]?(0b[0-1_]+|0[0-7_]+|(0|[1-9][0-9_]*)|0x[0-9a-fA-F_]+|[1-9][0-9_]*(:[0-5]?[0-9])+)$/;
const YAML_FLOAT_RE =
  /^([-+]?([0-9][0-9_]*)\.[0-9_]*([eE][-+][0-9]+)?|\.[0-9][0-9_]*([eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/;
// timestamp: ISO date or date-time (PyYAML resolves to a date/datetime object).
const YAML_TIMESTAMP_RE =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(\.[0-9]*)?([ \t]*(Z|[-+][0-9]{1,2}(:[0-9]{2})?))?)$/;

/**
 * A value matching YAML_TIMESTAMP_RE may still be UN-constructible (`2026-99-99`):
 * PyYAML matches the regex but raises building the date. Return true only when
 * the month/day (and time fields, if present) are in range — so we can reject the
 * impossible ones exactly as safe_load does.
 */
function isConstructibleTimestamp(s) {
  const m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[Tt ]+([0-9]{1,2}):([0-9]{2}):([0-9]{2}))?/.exec(
    s,
  );
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (m[4] !== undefined) {
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    const ss = Number(m[6]);
    if (hh > 23 || mm > 59 || ss > 59) return false;
  }
  return true;
}

/**
 * Resolve a bare YAML 1.1 plain scalar. Returns the JS string for a real string,
 * or the sentinel { __typed: kind } when PyYAML would resolve it to a non-string
 * (bool/null/int/float/timestamp) so the caller's string check matches upstream.
 */
function resolveBareScalar(bare) {
  if (bare === "") return { __typed: "null" }; // empty plain scalar → null
  if (YAML_NULL_RE.test(bare)) return { __typed: "null" };
  if (YAML_BOOL_RE.test(bare)) return { __typed: "bool" };
  if (YAML_INT_RE.test(bare)) return { __typed: "int" };
  if (YAML_FLOAT_RE.test(bare)) return { __typed: "float" };
  if (YAML_TIMESTAMP_RE.test(bare)) return { __typed: "timestamp" };
  return bare; // a plain string
}

// PyYAML double-quote escapes that take NO hex argument. Anything outside this
// set (other than the hex forms below) is an invalid escape PyYAML rejects.
// \N \_ \L \P decode to specific Unicode separators (NEL/NBSP/LS/PS) — match
// PyYAML exactly so a value's resolved bytes are faithful (none introduce </>).
const SIMPLE_DQ_ESCAPES = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "",
  _: " ",
  L: " ",
  P: " ",
};
// Hex-argument escapes → [escape char, number of hex digits].
const HEX_DQ_ESCAPES = { x: 2, u: 4, U: 8 };

/**
 * Decode a double-quoted YAML string, faithfully to PyYAML: only the recognized
 * escapes are accepted; an unknown escape (`\q`) or a truncated hex escape
 * (`\u12`, `\x1`) is a hard error — and `\uXXXX`/`\xXX`/`\UXXXXXXXX` ARE decoded
 * (so e.g. `<` becomes `<` and is then caught by the angle-bracket rule).
 */
function parseDoubleQuoted(trimmed) {
  let out = "";
  let k = 1;
  while (k < trimmed.length) {
    const ch = trimmed[k];
    if (ch === "\\") {
      if (k + 1 >= trimmed.length) {
        return { ok: false, error: "unterminated escape in double-quoted string" };
      }
      const next = trimmed[k + 1];
      if (next in HEX_DQ_ESCAPES) {
        const digits = HEX_DQ_ESCAPES[next];
        const hex = trimmed.slice(k + 2, k + 2 + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) {
          return { ok: false, error: `invalid \\${next} escape in double-quoted string` };
        }
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        k += 2 + digits;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SIMPLE_DQ_ESCAPES, next)) {
        out += SIMPLE_DQ_ESCAPES[next];
        k += 2;
        continue;
      }
      return { ok: false, error: `unknown escape "\\${next}" in double-quoted string` };
    }
    if (ch === '"') {
      // Closing quote. Anything after it (beyond optional whitespace + comment)
      // is trailing junk that safe_load rejects.
      const tail = trimmed.slice(k + 1);
      if (tail.trim() !== "" && !/^\s+#/.test(tail) && tail.trim()[0] !== "#") {
        return { ok: false, error: "unexpected content after closing double quote" };
      }
      return { ok: true, value: out };
    }
    out += ch;
    k += 1;
  }
  return { ok: false, error: "unterminated double-quoted string" };
}

/** Decode a single-quoted YAML string body (`''` is an escaped quote). */
function parseSingleQuoted(trimmed) {
  let out = "";
  let k = 1;
  while (k < trimmed.length) {
    const ch = trimmed[k];
    if (ch === "'") {
      if (trimmed[k + 1] === "'") {
        out += "'";
        k += 2;
        continue;
      }
      const tail = trimmed.slice(k + 1);
      if (tail.trim() !== "" && tail.trim()[0] !== "#") {
        return { ok: false, error: "unexpected content after closing single quote" };
      }
      return { ok: true, value: out };
    }
    out += ch;
    k += 1;
  }
  return { ok: false, error: "unterminated single-quoted string" };
}

/**
 * Parse a single inline YAML scalar that follows `key:`. Supports a
 * single/double-quoted string (decoding escapes, rejecting trailing junk) and a
 * bare scalar (resolving YAML core typed scalars so non-strings surface). A BARE
 * value containing `: ` (colon-space) or a leading YAML indicator is rejected as
 * the YAML error safe_load raises — quoting is required, exactly the #44 fix.
 *
 * Returns { ok, value } where value may be a string, number, boolean, or null
 * (so the caller's string-type checks behave like upstream's `isinstance(str)`).
 */
function parseScalar(rest) {
  const trimmed = rest.trim();
  if (trimmed === "") return { ok: true, value: null }; // bare `key:` → null
  const first = trimmed[0];
  if (first === '"') return parseDoubleQuoted(trimmed);
  if (first === "'") return parseSingleQuoted(trimmed);

  // Bare scalar starting with a YAML indicator character is not a plain scalar:
  // safe_load parses it as a flow collection / alias / tag, or errors. ANY such
  // unquoted SKILL.md value is invalid here — the canonical case is the
  // UNRENDERED template token `{{base}}` (safe_load: "while constructing a
  // mapping"). Require quoting so we reproduce upstream's "Invalid YAML".
  if ("{[@`*&!%>|".includes(first)) {
    return { ok: false, error: "value begins with a YAML indicator and must be quoted" };
  }
  // Strip a trailing inline comment FIRST (a `#` preceded by whitespace), so a
  // legitimate `description: foo # note` does not trip the colon check below.
  const commentMatch = /\s+#.*$/.exec(trimmed);
  const beforeComment = commentMatch ? trimmed.slice(0, commentMatch.index).trim() : trimmed;
  // A colon followed by a space (or a trailing colon) in the VALUE makes it a
  // mapping in YAML — reject it; the value must be quoted.
  if (/:\s/.test(beforeComment) || /:$/.test(beforeComment)) {
    return {
      ok: false,
      error: "mapping values are not allowed here (quote a value containing a colon)",
    };
  }
  return { ok: true, value: resolveBareScalar(beforeComment) };
}

/** Human-readable type name for an error message (matches PyYAML resolution). */
function typeName(v) {
  if (v === null) return "null";
  if (v && typeof v === "object") {
    if (v.__block) return "mapping";
    if (v.__typed) return v.__typed;
  }
  return typeof v;
}

/**
 * Validate SKILL.md content (the full file string). Returns { valid, message }.
 * `message` is the human-readable reason on failure, or "Skill is valid!" on
 * success — matching the upstream tool's contract so output is interchangeable.
 */
export function validateSkillContent(content) {
  const fm = extractFrontmatter(content);
  if (!fm.ok) return { valid: false, message: fm.error };

  const parsed = parseFrontmatter(fm.frontmatter);
  if (!parsed.ok) return { valid: false, message: parsed.error };
  const frontmatter = parsed.value;

  if (typeof frontmatter !== "object" || frontmatter === null) {
    return { valid: false, message: "Frontmatter must be a YAML dictionary" };
  }

  const unexpected = Object.keys(frontmatter).filter((k) => !ALLOWED_TOP_LEVEL_KEYS.has(k));
  if (unexpected.length) {
    const allowed = [...ALLOWED_TOP_LEVEL_KEYS].sort().join(", ");
    const got = unexpected.sort().join(", ");
    // Sharper-than-upstream guidance for the two Cinatra project keys: tell the
    // author where they belong (the metadata extension point) instead of just
    // "unexpected key". Still a REJECTION — we never accept them at top level.
    const projectKeyHint = unexpected.some((k) => k === "match_when" || k === "cinatra-watches")
      ? ` Cinatra project keys (match_when, cinatra-watches) must be nested under "metadata:", not declared at the top level.`
      : "";
    return {
      valid: false,
      message: `Unexpected key(s) in SKILL.md frontmatter: ${got}. Allowed properties are: ${allowed}.${projectKeyHint}`,
    };
  }

  if (!("name" in frontmatter)) return { valid: false, message: "Missing 'name' in frontmatter" };
  if (!("description" in frontmatter)) {
    return { valid: false, message: "Missing 'description' in frontmatter" };
  }

  const name = frontmatter.name;
  if (typeof name !== "string") {
    return { valid: false, message: `Name must be a string, got ${typeName(name)}` };
  }
  const trimmedName = name.trim();
  if (trimmedName) {
    if (!NAME_RE.test(trimmedName)) {
      return {
        valid: false,
        message: `Name '${trimmedName}' should be hyphen-case (lowercase letters, digits, and hyphens only)`,
      };
    }
    if (trimmedName.startsWith("-") || trimmedName.endsWith("-") || trimmedName.includes("--")) {
      return {
        valid: false,
        message: `Name '${trimmedName}' cannot start/end with hyphen or contain consecutive hyphens`,
      };
    }
    if (trimmedName.length > MAX_SKILL_NAME_LENGTH) {
      return {
        valid: false,
        message: `Name is too long (${trimmedName.length} characters). Maximum is ${MAX_SKILL_NAME_LENGTH} characters.`,
      };
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string") {
    return { valid: false, message: `Description must be a string, got ${typeName(description)}` };
  }
  const trimmedDesc = description.trim();
  if (trimmedDesc) {
    if (trimmedDesc.includes("<") || trimmedDesc.includes(">")) {
      return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
    }
    if (trimmedDesc.length > MAX_DESCRIPTION_LENGTH) {
      return {
        valid: false,
        message: `Description is too long (${trimmedDesc.length} characters). Maximum is ${MAX_DESCRIPTION_LENGTH} characters.`,
      };
    }
  }

  return { valid: true, message: "Skill is valid!" };
}

// ── Placeholder-text guard (cinatra-cli#44 acceptance) ─────────────────────────
//
// A freshly scaffolded SKILL.md ships generic guidance copy that an author is
// meant to replace before publishing. These EXACT sentinel phrases come straight
// from the cinatra-cli SKILL.md templates; if any survive into a real, published
// package the author never filled the skill in. The lint (cinatra-cli#45) treats
// these as a violation for SOURCE skills (templates/fixtures are excluded). The
// phrases are stable, template-origin strings — not arbitrary heuristics — so the
// guard does not flag legitimately authored content that happens to say "edit".
const PLACEHOLDER_SENTINELS = [
  // Default placeholder descriptions emitted by the three SKILL.md templates.
  "System prompt for the",
  "Classifies an attached resource as a",
  // Body guidance lines the templates ship for the author to overwrite.
  "Write the skill's system prompt here.",
  "Edit this body to your skill's real instructions.",
  "Edit the recipe below to your agent's real instructions.",
  "Edit this step to the actual reasoning/tool-use your agent performs.",
  "Edit this rubric to the concrete signals that distinguish your artifact type.",
  // Legacy sentinel from older template revisions (defensive — still rejected).
  "Replace this",
];

/**
 * Return the list of placeholder sentinels still present in a SKILL.md string.
 * An empty array means no un-edited template scaffolding remains. Used by the
 * lint to fail SOURCE skills that ship un-filled template copy.
 */
export function findPlaceholders(content) {
  const text = typeof content === "string" ? content : "";
  return PLACEHOLDER_SENTINELS.filter((s) => text.includes(s));
}

/**
 * Lint a SKILL.md string: run the superset validator AND (unless disabled) the
 * placeholder guard. Returns { ok, errors } — `errors` is a list of strings.
 * This is the single per-file contract the directory-scanning lint command
 * (cinatra-cli#45) and the template tests (cinatra-cli#44) both consume, so the
 * frontmatter rules and the placeholder guard can never drift apart.
 *
 * @param {string} content        the full SKILL.md file text
 * @param {object} [opts]
 * @param {boolean} [opts.allowPlaceholders=false]  skip the placeholder guard
 *        (templates/fixtures legitimately carry scaffold copy)
 */
export function lintSkillContent(content, { allowPlaceholders = false } = {}) {
  const errors = [];
  const v = validateSkillContent(content);
  if (!v.valid) errors.push(v.message);
  if (!allowPlaceholders) {
    const placeholders = findPlaceholders(content);
    if (placeholders.length) {
      errors.push(
        `un-edited template placeholder text present: ${placeholders
          .map((p) => JSON.stringify(p))
          .join(", ")}`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

export { ALLOWED_TOP_LEVEL_KEYS, PLACEHOLDER_SENTINELS };
