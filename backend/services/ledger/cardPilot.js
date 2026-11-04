// An exact $1 exception for one explicitly configured landlord and one intent.
// Maximum lifetime is two hours, below Stripe's 24-hour idempotency retention.
// No browser-supplied flag or amount can activate it. Bank limits are separate.
const env = require("../../config/env");
const MAX_WINDOW_MS = 2 * 3600_000;
function cardPilotFor(landlordId, now = Date.now()) {
  const owner = env.card_pilot_landlord_id;
  const start = Date.parse(env.card_pilot_starts_at), end = Date.parse(env.card_pilot_expires_at);
  if (!/^[a-f0-9]{24}$/.test(owner || "") || String(landlordId) !== owner ||
    !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS ||
    now < start || now >= end) return null;
  return { amountCents: 100, expiresAt: new Date(end).toISOString(), reference: String(start) };
}
module.exports = { cardPilotFor, MAX_WINDOW_MS };
