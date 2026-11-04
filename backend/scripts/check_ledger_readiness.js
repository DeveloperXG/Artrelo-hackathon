// Entry point for a SEPARATE scheduled service. Read-only: no repair flags,
// provider settlement, deposits or billing collection. Monitoring initializes
// before Mongoose so failures use the API's existing scrubbed Sentry pipeline.
require("../instrument");
const mongoose = require("mongoose");
const Sentry = require("@sentry/node");
const env = require("../config/env");
const { reconcile } = require("./reconcileLedger");

async function checkLedgerReadiness({ check = reconcile, capture = Sentry.captureMessage } = {}) {
  const result = await check();
  if (!result.ok) capture("Scheduled ledger reconciliation failed", { level: "error", tags: { check: "ledger_reconciliation" } });
  return result;
}
if (require.main === module) {
  (async () => {
    if (!env.mongodb_uri) throw new Error("MONGODB_URI is required");
    await mongoose.connect(env.mongodb_uri, { autoIndex: false, autoCreate: false });
    const result = await checkLedgerReadiness();
    process.exitCode = result.ok ? 0 : 1;
  })().catch(error => { console.error("[ledger-monitor] check failed", error.message); process.exitCode = 1; })
    .finally(async () => { await mongoose.disconnect().catch(() => {}); await Sentry.flush(5000); });
}
module.exports = { checkLedgerReadiness };
