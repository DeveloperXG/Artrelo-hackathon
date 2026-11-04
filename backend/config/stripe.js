// Lazily-configured Stripe client.
//
// Same optional-dependency shape as notification/email.service.js: when there
// is no key the module reports isConfigured() === false and every caller falls
// back to the offline rail rather than throwing. That is what keeps the whole
// payout flow exercisable on a machine with no Stripe account at all.
//
// This file was 0 bytes until the ledger needed it.

const env = require("./env");

let client = null;
let attempted = false;

function getStripe() {
  if (attempted) return client;
  attempted = true;

  if (!env.stripe_secret_key) return null;
  try {
    const Stripe = require("stripe");
    client = new Stripe(env.stripe_secret_key, {
      // Pinned rather than floating: an account-level API version change should
      // never silently alter the shape of a webhook this code parses.
      //
      // Must be recent enough for the v2 API — Accounts v2 rejects older
      // versions outright ("Invalid Stripe API version"), and Stripe now
      // refuses v1 account creation for new Connect integrations, so there is
      // no version that satisfies both. Bump deliberately, never incidentally.
      apiVersion: "2026-07-29.dahlia",
      // Every request is retried with the same idempotency key we already
      // derive from domain identity, so a network blip cannot double-transfer.
      maxNetworkRetries: 2,
      appInfo: { name: "Artrelo", url: "https://artrelo.com" },
    });
  } catch (err) {
    console.error("[stripe] client init failed:", err.message);
    client = null;
  }
  return client;
}

function isConfigured() {
  return Boolean(getStripe());
}

/**
 * Guards against pointing a dev/staging deploy at a live key by accident.
 * Returns "test" | "live" | null — never the key itself.
 */
function keyMode() {
  const key = env.stripe_secret_key;
  if (!key) return null;
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return "unknown";
}

module.exports = { getStripe, isConfigured, keyMode };
