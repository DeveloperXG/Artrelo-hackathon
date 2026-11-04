// Reading boolean switches out of the environment.
//
// This file exists because the same four flags were compared four different
// ways, and a human typing the value could not know which:
//
//   REGISTRATION_ENABLED  === "TRUE"    uppercase
//   TENANT_SIGNUP_ENABLED === "TRUE"    uppercase
//   IS_PRODUCTION         === "TRUE"    uppercase, and compared in app.js
//   RELAY_SMS_ENABLED     === "true"    lowercase
//   OUTREACH_EMAIL_ENABLED !== "false"  lowercase, inverted, defaults ON
//
// while the two frontends both used `value === 'true'`. So the operator had to
// write TRUE for the API and true for the apps, in the same deployment, and a
// mismatch failed SILENTLY: the flag simply read as its default. That cost a
// debugging session when every sign-in CTA vanished from the marketing site
// because the values said TRUE, and it is worse on IS_PRODUCTION, where the
// default skips `trust proxy 1` and the X-Real-IP middleware and quietly puts
// every visitor in one rate-limit bucket.
//
// One parser, one convention, and anything it does not recognise is logged
// rather than swallowed.

// Deliberately generous. The point is that an operator's reasonable guess
// works, so "1", "yes" and "on" are accepted alongside "true". Everything is
// trimmed and lowercased first, so TRUE, True and " true " are all true.
const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

/**
 * Read an environment value as a boolean.
 *
 * @param {unknown} value        raw value, usually process.env.SOMETHING
 * @param {boolean} defaultValue used when unset, empty, or unrecognised
 * @param {string}  [name]       variable name, for the warning
 * @returns {boolean}
 */
function parseFlag(value, defaultValue = false, name) {
  if (value === undefined || value === null) return defaultValue;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === "") return defaultValue;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;

  // Not recognised. Fall back to the default, but say so — a typo like
  // "ture" or "enabled" is the failure this whole file is about, and taking
  // the default without a word is how it stays hidden.
  console.warn(
    `[flags] ${name || "flag"}=${JSON.stringify(value)} is not a boolean; ` +
      `using ${defaultValue}. Accepted: ${[...TRUTHY].join("/")} or ${[...FALSY].join("/")}.`
  );
  return defaultValue;
}

/** parseFlag against process.env, so the name is never out of step. */
const envFlag = (name, defaultValue = false) => parseFlag(process.env[name], defaultValue, name);

module.exports = { parseFlag, envFlag, TRUTHY, FALSY };
