const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  landlordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  period: { type: String, required: true },
  customerId: { type: String, required: true },
  stripeInvoiceId: { type: String, default: null },
  status: { type: String, enum: ["creating", "draft", "open", "paid", "void", "uncollectible", "disputed"], default: "creating" },
  subtotalCents: { type: Number, required: true, min: 0 },
  totalCents: { type: Number, default: 0 },
  paidCents: { type: Number, default: 0 },
  cashCollectedCents: { type: Number, default: 0 },
  collectedFeeCents: { type: Number, default: 0 },
  disputedCents: { type: Number, default: 0 },
  creditedCents: { type: Number, default: 0 },
  refundedCents: { type: Number, default: 0 },
  processingFeeCents: { type: Number, default: null },
  hostedUrl: String, pdfUrl: String,
  firstFailedAt: Date,
  paidAt: Date,
  checkedAt: Date,
}, { timestamps: true });
schema.index({ landlordId: 1, period: 1 }, { unique: true });
schema.index({ stripeInvoiceId: 1 }, { unique: true, partialFilterExpression: { stripeInvoiceId: { $type: "string" } } });
module.exports = mongoose.model("BillingInvoice", schema);
