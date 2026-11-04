const { recoverAssessments } = require("./feeAssessment.service");
const { reconcileBilling } = require("./invoiceCollection.service");
async function sweepBilling() {
  await recoverAssessments();
  await reconcileBilling();
}
function startBillingSweeper(intervalMs = 3600_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await sweepBilling(); }
    catch (error) {
      console.error("[billing] sweep failed", error.code || "billing_recovery_failed");
      try { require("@sentry/node").captureException(error, { tags: { operation: "service_billing" } }); } catch (_) { /* monitoring is non-fatal */ }
    } finally { running = false; }
  };
  run(); const timer = setInterval(run, intervalMs); timer.unref?.(); return timer;
}
module.exports = { sweepBilling, startBillingSweeper };
