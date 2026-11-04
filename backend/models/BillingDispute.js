const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  disputeId: { type: String, required: true, unique: true },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "BillingInvoice", required: true, index: true },
  landlordId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: String, openedAt: Date, checkedAt: Date,
  outstandingCents: { type: Number, default: 0 },
  stripeCostCents: { type: Number, default: 0 },
  transactions: [{ _id: false, id: String, amountCents: Number, feeCents: Number, createdAt: Date }],
}, { timestamps: true });
module.exports = mongoose.model("BillingDispute", schema);
