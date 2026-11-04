// A marketing-site enquiry, stored durably.
//
// WHY THIS EXISTS. The public contact endpoint used to do exactly one thing:
// send an email to the sales alias. That made email delivery the sole record of
// a lead, which fails in two directions:
//
//   * If Resend is unconfigured, sendEmail returns {stub:true} and the endpoint
//     still answers 200 — correct for local dev, silently lossy in production.
//   * Even when delivery works, a deleted or filtered message is an erased lead
//     with nothing to reconcile against.
//
// So the row is written FIRST and the delivery outcome is patched onto it after.
// A lead that exists with deliveryStatus "pending" is recoverable; a lead that
// was only ever an unsent email is not.
//
// Nothing here is authenticated, so every field arrives attacker-controlled.
// The controller sanitises and length-caps before this model ever sees it; the
// maxlengths below are a second floor, not the first one.

const mongoose = require("mongoose");

// "pending" is the state between the row being claimed and sendEmail returning.
// It is the default deliberately: a crash mid-send leaves an honest "we do not
// know", where defaulting to "failed" would over-report failures and defaulting
// to "delivered" would hide them.
const DELIVERY_STATUSES = ["pending", "delivered", "stubbed", "failed"];

const leadSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      index: true,
    },
    company: { type: String, required: true, trim: true, maxlength: 160 },
    // Free text rather than an enum: the controller already coerces anything
    // unrecognised to "Not specified", and a closed enum here would turn a
    // drifted marketing <select> into a hard 500 on a real lead.
    portfolioSize: { type: String, trim: true, maxlength: 60, default: "Not specified" },
    message: { type: String, required: true, maxlength: 4000 },
    // Which marketing page the form was on. Lets /demo be measured separately
    // from /contact without a second endpoint.
    sourcePage: { type: String, trim: true, maxlength: 200, default: "/contact" },
    deliveryStatus: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "pending",
      index: true,
    },
    providerMessageId: { type: String, default: null },
    deliveryError: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true }
);

// The queries this collection exists to serve: newest-first triage, "show me
// everything that did not reach the inbox", and the controller's per-address
// submission count, which filters on email within a recent createdAt window.
leadSchema.index({ createdAt: -1 });
leadSchema.index({ deliveryStatus: 1, createdAt: -1 });
leadSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model("Lead", leadSchema);
module.exports.DELIVERY_STATUSES = DELIVERY_STATUSES;
