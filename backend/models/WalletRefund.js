const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  operation: { type: String, required: true, unique: true },
  landlordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  paymentIntentId: { type: String, required: true },
  amountCents: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  refundId: { type: String, default: null },
  status: { type: String, enum: ["reserved", "pending", "requires_action", "succeeded", "failed", "canceled"], default: "reserved", index: true },
  reason: { type: String, required: true },
}, { timestamps: true });
schema.index({ refundId: 1 }, { unique: true, partialFilterExpression: { refundId: { $type: "string" } } });
module.exports = mongoose.model("WalletRefund", schema);
