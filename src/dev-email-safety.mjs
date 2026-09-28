// cinatra-cli#291 — the email safety switch a development install turns on.
//
// THE PRODUCT'S SETTING. The product keeps its email safety switch (the page
// /configuration/development, tab "Email": "Override recipient email" with its
// "Recipient override" address) in the instance database's key/value
// `metadata` table, under the connector-config key
// `connector_config:email-system-development`, as the JSON object
// `{ developmentModeEnabled, overrideRecipientEmail }`. It reads the switch as
// on ONLY when `developmentModeEnabled` is exactly `true`, so an ABSENT row
// reads as off, and a fresh installation delivered to the stored recipient
// addresses until someone ticked the box by hand. While the switch is on,
// outgoing email goes to the override address instead of its recipients, and a
// switch that is on without an address refuses to send at all.
//
// WHAT THE INSTALL DOES. A development install (`--mode dev`, `--mode demo`,
// and the preview composition, which performs a dev install) writes that
// setting right after its setup child — the step that creates the `metadata`
// table — with the switch ON and the override address from
// `--email-recipient-override`, else `CINATRA_EMAIL_RECIPIENT_OVERRIDE`, else
// the reserved default below. `instance refresh` (and `update`, which runs it)
// does the same after its reconcile, from the variable or the default. The
// write is INSERT-IF-ABSENT, the product's own seeding shape: a setting that is
// already stored is kept exactly as it is, switch and address — a person
// changes it on the page, the install never does. A production install never
// runs this step and stores nothing for this setting.
//
// THE DEFAULT ADDRESS. A name under `.invalid`, the top-level domain reserved
// never to resolve (RFC 2606, RFC 6761), so no mail system can deliver to it.
//
// WHAT IT PRINTS. Exactly one line: whether the switch is on and where the
// address came from (the flag, the variable or the default). Never the address
// itself — not in that line, not in an error.
//
// FAIL CLOSED. A malformed flag or variable value is refused while the install
// parses its arguments, before any side effect. A write that cannot be made
// stops the run with a named error instead of leaving a development
// installation that delivers email.
//
// The database access goes through an injectable seam (`deps.query`), so the
// unit suite drives this module with a fake database.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The product's metadata key for the setting (`connector_config:` + its key). */
export const EMAIL_SAFETY_SETTING_KEY = "connector_config:email-system-development";
/** The install flag that names the override address. */
export const EMAIL_RECIPIENT_OVERRIDE_FLAG = "--email-recipient-override";
/** The environment variable that names it when the flag is absent. */
export const EMAIL_RECIPIENT_OVERRIDE_ENV = "CINATRA_EMAIL_RECIPIENT_OVERRIDE";
/** The address used when neither names one: no mail system delivers to it. */
export const EMAIL_RECIPIENT_OVERRIDE_DEFAULT = "nobody@example.invalid";

/** One query attempt never outlives this, so a stalled database cannot hold a run. */
const QUERY_TIMEOUT_MS = 10_000;

// The "valid e-mail address" of the HTML standard — the check the product's own
// "Recipient override" field (an `<input type="email">`) applies. One address:
// no display name, no list, no whitespace.
const EMAIL_ADDRESS_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function checkAddress(raw, name) {
  const value = String(raw ?? "").trim();
  if (value === "") {
    throw new Error(
      `${name} is given but empty. Name one email address (name@domain), or leave it out to use the ` +
        "default address that no mail system delivers to.",
    );
  }
  if (!EMAIL_ADDRESS_RE.test(value)) {
    throw new Error(
      `${name} is not one email address (name@domain) — the shape the product's "Recipient override" ` +
        "field accepts. Name exactly one address, without a display name or a list.",
    );
  }
  return value;
}

/**
 * The override address for THIS run and its source. The flag wins over the
 * variable; neither gives the reserved default. `flagValue` is the flag's value
 * as the install read it (`null` when the flag is absent, `""` for a bare
 * `--email-recipient-override=`). A present but empty value — the flag's or the
 * variable's — is a typo, not "unset", and is refused like any other malformed
 * value.
 *
 * @returns {{ address: string, source: "flag" | "variable" | "default" }}
 */
export function resolveEmailRecipientOverride({ flagValue = null, env = {} } = {}) {
  if (flagValue != null) {
    return { address: checkAddress(flagValue, EMAIL_RECIPIENT_OVERRIDE_FLAG), source: "flag" };
  }
  const fromEnv = env?.[EMAIL_RECIPIENT_OVERRIDE_ENV];
  if (typeof fromEnv === "string") {
    return { address: checkAddress(fromEnv, EMAIL_RECIPIENT_OVERRIDE_ENV), source: "variable" };
  }
  return { address: EMAIL_RECIPIENT_OVERRIDE_DEFAULT, source: "default" };
}

/** The stored value, in the shape and key order the product's own page writes. */
export function emailSafetySetting(address) {
  return { developmentModeEnabled: true, overrideRecipientEmail: address };
}

/** The switch as the product reads it from a stored value (a JSON string). */
export function storedSwitchIsOn(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return parsed !== null && typeof parsed === "object" && parsed.developmentModeEnabled === true;
  } catch {
    return false;
  }
}

const SOURCE_NAME = {
  flag: EMAIL_RECIPIENT_OVERRIDE_FLAG,
  variable: EMAIL_RECIPIENT_OVERRIDE_ENV,
};

/** The one line a run prints. It names the address's source, never the address. */
export function emailSafetyLine({ action, source, switchOn }) {
  if (action === "written") {
    const to = SOURCE_NAME[source]
      ? `the recipient override set from ${SOURCE_NAME[source]}`
      : "the default recipient override, a reserved address that no mail system delivers to";
    return `- Email safety: the switch is on; outgoing email goes to ${to}.`;
  }
  const state = switchOn
    ? "the switch is on"
    : 'the switch is off; tick "Override recipient email" at /configuration/development, tab Email, to turn it on';
  const unapplied = SOURCE_NAME[source] ? `; ${SOURCE_NAME[source]} was not applied` : "";
  return `- Email safety: the stored setting is kept as it is (${state})${unapplied}.`;
}

// ---------------------------------------------------------------------------
// Default seams.
// ---------------------------------------------------------------------------

/** The database the setup child migrated: the checkout's `.env.local`
 *  OVERLAID BY the process environment, exactly as setup collects it. */
async function defaultReadEnv(targetDir, processEnv) {
  const envPath = path.join(targetDir, ".env.local");
  let fileEnv = {};
  if (existsSync(envPath)) {
    // Lazy: install.mjs imports this module, and owns the one dotenv parser.
    const { parseEnvBody } = await import("./install.mjs");
    fileEnv = parseEnvBody(readFileSync(envPath, "utf8"));
  }
  return { ...fileEnv, ...processEnv };
}

async function defaultQuery(connectionString, text, values) {
  const mod = await import("pg");
  const ns = mod.default ?? mod;
  const Client = ns.Client ?? mod.Client;
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end().catch(() => {});
  }
}

/** An error text with the connection string, its password and the address cut out. */
function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("****");
  }
  return out.slice(0, 200);
}

/** The password of a connection string, as written and decoded (none when it has none). */
function passwordsOf(connectionString) {
  let password = "";
  try {
    password = new URL(connectionString).password;
  } catch {
    return [];
  }
  try {
    return [password, decodeURIComponent(password)];
  } catch {
    return [password];
  }
}

/**
 * Turn the email safety switch on for a development installation, unless a
 * setting is already stored. Prints exactly one line; returns
 * `{ action: "written" | "kept" | "skipped", source, switchOn }`.
 *
 *   - `mode` other than dev or demo -> skipped: nothing is read or written.
 *   - `override` is the install's resolved `{ address, source }`; without it the
 *     variable, then the default, is resolved here (the refresh road).
 *   - no database named, or a statement that fails -> a named error (fail
 *     closed); the message carries neither the connection string nor the address.
 */
export async function ensureDevEmailSafety({ targetDir, mode = "dev", override = null, log = console.log, deps = {} } = {}) {
  if (mode !== "dev" && mode !== "demo") return { action: "skipped", reason: "not-development" };

  const processEnv = deps.processEnv ?? process.env;
  const { address, source } = override ?? resolveEmailRecipientOverride({ env: processEnv });
  const env = await (deps.readEnv ?? defaultReadEnv)(targetDir, processEnv);
  const connectionString = String(env?.SUPABASE_DB_URL ?? "").trim();
  if (!connectionString) {
    throw new Error(
      "Email safety: no instance database is named (SUPABASE_DB_URL is set neither in .env.local nor in the " +
        "environment), so the email safety switch cannot be turned on. This run stops rather than leave a " +
        "development installation that delivers email to its stored recipients.",
    );
  }
  const schema = String(env?.SUPABASE_SCHEMA ?? "").trim() || "cinatra";
  const table = `"${schema.replaceAll('"', '""')}"."metadata"`;
  const query = deps.query ?? ((text, values) => defaultQuery(connectionString, text, values));

  let written = false;
  let stored = null;
  try {
    const inserted = await query(
      `INSERT INTO ${table} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [EMAIL_SAFETY_SETTING_KEY, JSON.stringify(emailSafetySetting(address))],
    );
    written = Array.isArray(inserted?.rows) && inserted.rows.length > 0;
    if (!written) {
      const existing = await query(`SELECT value FROM ${table} WHERE key = $1`, [EMAIL_SAFETY_SETTING_KEY]);
      stored = existing?.rows?.[0]?.value ?? null;
    }
  } catch (err) {
    const detail = scrub(err instanceof Error ? err.message : err, [
      connectionString,
      ...passwordsOf(connectionString),
      address,
    ]);
    throw new Error(
      `Email safety: could not store the email safety setting in the instance database (${detail}). ` +
        "This run stops rather than leave a development installation that delivers email to its stored " +
        'recipients: re-run it once the database answers, or tick "Override recipient email" at ' +
        "/configuration/development, tab Email.",
    );
  }

  const result = written
    ? { action: "written", source, switchOn: true }
    : { action: "kept", source, switchOn: storedSwitchIsOn(stored) };
  log(emailSafetyLine(result));
  return result;
}
