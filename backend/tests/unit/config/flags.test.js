// Reading boolean switches out of the environment.
//
// THE RULE THIS FILE EXISTS TO PROTECT: the value an operator types is read the
// same way everywhere, and a value nobody recognises is never taken as a silent
// "off".
//
// The bug: four flags were compared four ways — three against "TRUE", one
// against "true", one inverted against "false" — while both frontends compared
// against 'true'. So the same deployment needed TRUE for the API and true for
// the apps, and getting it wrong changed nothing visible except the feature
// quietly not being there. IS_PRODUCTION was the dangerous one: read as false
// it skips `trust proxy 1` and the X-Real-IP middleware, so every visitor
// shares one rate-limit bucket.
//
// Case 1 is that bug, as a truth table.

const assert = require("assert");

const { parseFlag, envFlag } = require("../../../config/flags");

function main() {
  /* ---------- 1) Spelling does not matter -------------------------------- */
  //
  // Every one of these was written by a real person in a real .env and meant
  // "on". "TRUE" is the spelling backend/.env.dev.local actually contained
  // while the marketing site rendered no sign-in button at all.

  for (const value of ["true", "TRUE", "True", "tRuE", " true ", "\ttrue\n", "1", "yes", "YES", "on", "ON"]) {
    assert.strictEqual(parseFlag(value), true, `${JSON.stringify(value)} must read as true`);
  }

  for (const value of ["false", "FALSE", "False", " false ", "0", "no", "NO", "off", "OFF"]) {
    assert.strictEqual(parseFlag(value), false, `${JSON.stringify(value)} must read as false`);
  }

  /* ---------- 2) Absence takes the default, either way ------------------- */
  //
  // Both directions are needed: the feature flags default OFF (unset means a
  // closed beta stays closed), but OUTREACH_EMAIL_ENABLED defaults ON, so
  // unset must not silence vendor email.

  for (const missing of [undefined, null, "", "   "]) {
    assert.strictEqual(parseFlag(missing), false, `${JSON.stringify(missing)} with no default`);
    assert.strictEqual(parseFlag(missing, true), true, `${JSON.stringify(missing)} must honour a true default`);
  }

  /* ---------- 3) A value nobody recognises WARNS ------------------------- */
  //
  // The whole point. Falling back to the default is fine; doing it silently is
  // the bug class this file closes, so the warning is the assertion.

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  try {
    assert.strictEqual(parseFlag("ture", false, "REGISTRATION_ENABLED"), false, "a typo falls back");
    assert.strictEqual(parseFlag("enabled", true, "OUTREACH_EMAIL_ENABLED"), true, "and honours the default");
    assert.strictEqual(parseFlag("maybe"), false);
  } finally {
    console.warn = realWarn;
  }

  assert.strictEqual(warnings.length, 3, "every unrecognised value must be reported");
  assert.ok(
    warnings[0].includes("REGISTRATION_ENABLED") && warnings[0].includes('"ture"'),
    `the warning must name the variable and show the value; got: ${warnings[0]}`
  );

  // And a value it DOES recognise must stay quiet, or the warning is noise
  // that gets filtered out of the logs and stops working.
  const noisy = [];
  console.warn = (msg) => noisy.push(String(msg));
  try {
    parseFlag("TRUE", false, "REGISTRATION_ENABLED");
    parseFlag(undefined, true, "OUTREACH_EMAIL_ENABLED");
  } finally {
    console.warn = realWarn;
  }
  assert.deepStrictEqual(noisy, [], "a recognised value must not warn");

  /* ---------- 4) Non-strings do not throw ------------------------------- */
  //
  // process.env only ever yields strings, but envFlag is exported and a caller
  // may hand it a parsed config value. Coerce rather than crash on boot.

  assert.strictEqual(parseFlag(true), true);
  assert.strictEqual(parseFlag(false), false);
  assert.strictEqual(parseFlag(1), true);
  assert.strictEqual(parseFlag(0), false);

  /* ---------- 5) envFlag reads process.env by that exact name ------------ */
  //
  // Guards the wiring, not the parsing: env.js passes a NAME, so a typo there
  // would read undefined and take the default forever.

  const KEY = "ARTRELO_FLAGS_TEST_ONLY";
  delete process.env[KEY];
  assert.strictEqual(envFlag(KEY), false, "unset");
  assert.strictEqual(envFlag(KEY, true), true, "unset honours the default");

  process.env[KEY] = "TRUE";
  assert.strictEqual(envFlag(KEY), true, "uppercase TRUE from the environment");
  process.env[KEY] = "false";
  assert.strictEqual(envFlag(KEY, true), false, "an explicit false beats a true default");
  delete process.env[KEY];

  /* ---------- 6) The real config is wired up ---------------------------- */
  //
  // End to end through config/env.js, because that is where the four call
  // sites disagreed. Set the awkward spelling and require it fresh.

  const ENV_KEYS = [
    ["REGISTRATION_ENABLED", "registration_enabled"],
    ["TENANT_SIGNUP_ENABLED", "tenant_signup_enabled"],
    ["IS_PRODUCTION", "is_production"],
    ["RELAY_SMS_ENABLED", "relay_sms_enabled"],
    ["OUTREACH_EMAIL_ENABLED", "outreach_email_enabled"],
  ];

  const saved = new Map(ENV_KEYS.map(([key]) => [key, process.env[key]]));
  const envPath = require.resolve("../../../config/env");

  const loadEnv = () => {
    delete require.cache[envPath];
    return require("../../../config/env");
  };

  // Three spellings, chosen so that reverting ANY single call site to its old
  // comparison fails here. "TRUE"/"false" alone would not: under the old
  // `=== "TRUE"` those two give exactly the right answers, and the regression
  // would sail through.
  //
  //   "TRUE"  catches RELAY_SMS_ENABLED reverting to === "true"   (-> false)
  //   "true"  catches the three that compared === "TRUE"          (-> false)
  //   "FALSE" catches OUTREACH_EMAIL_ENABLED reverting to !== "false" (-> true)
  const SPELLINGS = [
    ["TRUE", true],
    ["true", true],
    ["FALSE", false],
  ];

  try {
    for (const [spelling, expected] of SPELLINGS) {
      for (const [key] of ENV_KEYS) process.env[key] = spelling;
      const cfg = loadEnv();
      for (const [key, prop] of ENV_KEYS) {
        assert.strictEqual(cfg[prop], expected, `${key}=${spelling} must make env.${prop} ${expected}`);
      }
    }

    // is_production is a BOOLEAN now, not the raw string app.js used to
    // compare against "TRUE". If it ever reverts to a string, `if
    // (env.is_production)` in app.js goes true for "false" and pins CORS to
    // the wrong list.
    process.env.IS_PRODUCTION = "false";
    assert.strictEqual(typeof loadEnv().is_production, "boolean", "is_production must be a boolean");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[envPath];
  }

  console.log("flags tests passed");
}

main();
