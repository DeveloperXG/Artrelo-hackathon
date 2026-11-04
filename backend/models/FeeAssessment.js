const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  sourceKey: { type: String, required: true, unique: true },
  source: { type: String, enum: ["job", "legacy"], default: "job" },
  landlordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },
  requestId: { type: mongoose.Schema.Types.ObjectId, ref: "MaintenanceRequest" },
  completionId: { type: mongoose.Schema.Types.ObjectId, ref: "JobCompletion" },
  feeCents: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  listCents: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  payableCents: { type: Number, min: 0 },
  basis: { flatCents: Number, percent: Number },
  agreementVersion: String,
  waivedReason: String,
  closedAt: { type: Date, required: true, index: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "BillingInvoice", default: null, index: true },
  stripeInvoiceItemId: String,
  legacyEntryIds: [mongoose.Schema.Types.ObjectId],
}, { timestamps: true });
schema.index({ landlordId: 1, invoiceId: 1, closedAt: 1 });
module.exports = mongoose.model("FeeAssessment", schema);
