// Sends vendor payouts that were waiting on Stripe to clear card money.
//
// The balance.available webhook is the primary route (stripeWebhook.controller)
// and normally gets there first. This is the safety net, for the same reasons
// drainParkedPayouts has one: Stripe gives up on an endpoint after its retry
// schedule, the event has to be enabled on the destination by hand, and a
// dropped `stripe listen` tunnel loses it outright. Without a second route one
// missed event leaves a vendor's money parked with nothing to ever send it.
//
// It is also what gets a payout past Stripe's idempotency replay: a transfer
// refused for insufficient funds keeps replaying that refusal for its key for
// at least 24 hours, so a payout caught that way can only go on a LATER try.
//
// Cheap when idle: one indexed query, and no Stripe call unless something is
// actually parked.

const { releaseClearedPayouts } = require("./ledger.service");
const { reconcileCardSettlements } = require("./cardSettlement.service");
const { reconcileCardDisputes } = require("./cardDispute.service");
const { reconcileRefunds } = require("./walletRefund.service");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

function startClearanceSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const run = async () => {
    reconcileCardSettlements().catch(() => console.error("[clearanceSweeper] card settlement recovery failed"));
    // Reconcile funding withdrawals before retrying transfers. Fail closed.
    try { await reconcileCardDisputes(); }
    catch (error) { console.error("[clearanceSweeper] dispute recovery failed", error.message); return; }
    try { await reconcileRefunds(); }
    catch (error) { console.error("[clearanceSweeper] refund recovery failed", error.message); return; }
    releaseClearedPayouts().catch((err) => console.error("[clearanceSweeper] run failed", err));
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { startClearanceSweeper };
