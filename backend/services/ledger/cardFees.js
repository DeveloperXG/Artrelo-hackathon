// Card processing fee, charged on top of a wallet top-up.
//
// WHY ON TOP. Stripe keeps its fee out of every charge (2.9% + $0.30 on a
// domestic card), and the platform is configured to pay Stripe's fees. If the
// wallet were credited the full charge, every top-up would leave the Stripe
// balance short of the ledger by the fee — a $1 top-up landed as $0.67 while
// the wallet read $1.00, and over many deposits vendor transfers start failing
// for insufficient funds against wallets that look healthy.
//
// So the landlord is shown and charged wallet + fee, grossed up so that what
// Stripe leaves behind equals exactly the wallet credit:
//
//     charge = ceil((wallet + fixed) / (1 - pct))
//     charge - (charge * pct + fixed) >= wallet
//
// The rate comes from config, not code. Canadian card-network rules cap
// surcharges (and some provinces restrict them); if the advised cap is lower
// than Stripe's real cost, set CARD_FEE_PERCENT to it and the platform absorbs
// the difference. That is a deploy-time setting, never a code change.
//
// International and premium cards cost more than the domestic rate, so the
// gross-up can fall a few cents short on them. The actual Stripe fee is
// recorded on each deposit entry (card.stripeFeeCents), so the gap is visible.

const env = require("../../config/env");
const { assertCents } = require("./money");

// Below this, the fixed $0.30 is a large share of the payment — a $1 top-up
// would be a third fee. Also comfortably above Stripe's CAD minimum charge.
const MIN_CARD_DEPOSIT_CENTS = 2000;

function feeRate() {
  const pct = Number(env.card_fee_percent);
  const fixed = Number(env.card_fee_fixed_cents);
  return {
    // Fall back to Stripe's domestic Canadian rate on a missing or nonsense value
    // rather than charging 0% or dividing by zero.
    pct: Number.isFinite(pct) && pct >= 0 && pct < 50 ? pct : 2.9,
    fixedCents: Number.isSafeInteger(fixed) && fixed >= 0 ? fixed : 30,
  };
}

/** What to charge so the wallet receives exactly `walletCents` after Stripe's fee. */
function grossUpForCardFee(walletCents) {
  assertCents(walletCents, "walletCents");
  const { pct, fixedCents } = feeRate();
  const chargeCents = Math.ceil((walletCents + fixedCents) / (1 - pct / 100));
  return { walletCents, chargeCents, feeCents: chargeCents - walletCents };
}

module.exports = { grossUpForCardFee, feeRate, MIN_CARD_DEPOSIT_CENTS };
