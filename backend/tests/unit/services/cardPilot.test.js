const assert = require("assert");
const env = require("../../../config/env");
const { cardPilotFor, MAX_WINDOW_MS } = require("../../../services/ledger/cardPilot");
const owner = "000000000000000000000001", now = Date.parse("2026-10-18T12:00:00Z");
assert.equal(cardPilotFor(owner, now), null);
Object.assign(env, { card_pilot_landlord_id: owner, card_pilot_starts_at: new Date(now).toISOString(),
  card_pilot_expires_at: new Date(now + MAX_WINDOW_MS).toISOString() });
assert.equal(cardPilotFor(owner, now).amountCents, 100);
assert.equal(cardPilotFor("000000000000000000000002", now), null);
assert.equal(cardPilotFor(owner, now - 1), null);
assert.equal(cardPilotFor(owner, now + MAX_WINDOW_MS), null);
const first = cardPilotFor(owner, now).reference;
assert.equal(cardPilotFor(owner, now + 1000).reference, first, "all browser attempts share one Stripe key");
env.card_pilot_expires_at = new Date(now + MAX_WINDOW_MS + 1).toISOString();
assert.equal(cardPilotFor(owner, now), null, "an overlong window fails closed");
env.card_pilot_expires_at = "not-a-date";
assert.equal(cardPilotFor(owner, now), null);
console.log("card pilot scope, expiry and stable identity passed");
