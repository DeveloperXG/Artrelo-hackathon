const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  disputeId: { type: String, required: true, unique: true },
  paymentIntentId: { type: String, required: true, index: true },
  landlordId: { type: mongoose.Schema.Types.ObjectId, ref: "Landlord", required: true, index: true },
  status: String,
  withdrawnGrossCents: { type: Number, default: 0, min: 0 },
  reinstatedGrossCents: { type: Number, default: 0, min: 0 },
  reversedCents: { type: Number, default: 0, min: 0 },
  restoredCents: { type: Number, default: 0, min: 0 },
  stripeCostCents: { type: Number, default: 0 },
  transactions: [{ _id: false, id: String, createdAt: Date, amountCents: Number, feeCents: Number }],
  needsDeposit: { type: Boolean, default: true },
  checkedAt: Date,
}, { timestamps: true });
schema.index({ checkedAt: 1 });
module.exports = mongoose.model("FundingDispute", schema);
