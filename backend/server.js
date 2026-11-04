// First, before anything else loads: Sentry has to instrument Express and
// Mongoose as they are required. Does nothing without SENTRY_DSN.
require("./instrument");
const app = require("./app"); // imports your configured app
const PORT = require("./config/env").port;
const MONGODB_URI = require("./config/env").mongodb_uri;
const NODE_ENV = require("./config/env").node_env;
const mongoose = require("mongoose");
const { startRejectedRequestCleanup } = require("./services/request/rejectedRequestCleanup.service");
const { startVendorOutreachSweeper } = require("./services/vendor/vendorOutreachSweeper.service");
const { startCompletionSweeper } = require("./services/completion/completionSweeper.service");
const { startArchiveSweeper } = require("./services/request/archiveSweeper.service");
const { startBetaSweeper } = require("./services/beta/betaLifecycleSweeper.service");
const { startClearanceSweeper } = require("./services/ledger/clearanceSweeper.service");
const { startInitialRoutingSweeper } = require("./services/request/initialRouting.service");
const { startBookingRecovery } = require("./services/vendor/bookingRecovery.service");
const { startBillingSweeper } = require("./services/billing/billingSweeper.service");
const { startQuoteReviewSweeper } = require("./services/quotes/reviewSweeper.service");

// Checked before mongoose.connect so an unset URI reads as a misconfiguration
// rather than a TypeError from the .replace() in the success log below.
if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set — the server cannot start without a database. Set it and restart.");
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    // These unique indexes are part of the booking claim, not a background
    // optimization. Do not accept work until the new collections are ready.
    await Promise.all(["MaintenanceRequest", "BookingPreparation", "VendorCalendar", "VendorReservation", "CoordinationNotice", "JobToken", "Notification", "VendorOutreach", "FundingDispute", "WalletRefund", "BillingAccount", "BillingSetup", "FeeAssessment", "BillingInvoice", "BillingDispute", "QuoteAnalysis", "QuoteClarification", "ApprovalRequest", "PolicyCheckpoint", "LandlordPolicyRevision", "FirstContactDecision", "IrisTurn", "IrisToolAccess", "IrisPolicyChange", "IrisModelAttempt"]
      .map(name => (name === "Notification" ? require("./models/Notification").Notification : require(`./models/${name}`)).init()));
    console.log(`Using MongoDB URI: ${MONGODB_URI.replace(/:([^@]+)@/, ':****@')}`);
    console.log(`SUCCESSFUL CONNECTION to database in ${NODE_ENV ? NODE_ENV : 'development'} mode`);
    startRejectedRequestCleanup();
    startVendorOutreachSweeper();
    startCompletionSweeper();
    startArchiveSweeper();
    startBetaSweeper();
    startClearanceSweeper();
    startInitialRoutingSweeper();
    startBookingRecovery();
    startBillingSweeper();
    startQuoteReviewSweeper();
    require('./services/policy/policyWrite.service').startPolicyRefreshRecovery();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    // Exit rather than linger. app.listen is inside the .then, so without this
    // the process stays alive holding no listener — a container that looks up
    // to the supervisor while failing every healthcheck, and never restarts.
    console.error("Connection error:", err);
    process.exit(1);
  });
