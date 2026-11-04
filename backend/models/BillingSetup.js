const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  landlordId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  attempt: { type: String, required: true },
  customerId: { type: String, required: true },
  checkoutSessionId: String,
  setupIntentId: String,
  completedAt: Date,
  checkedAt: Date,
}, { timestamps: true });
schema.index({ landlordId: 1, attempt: 1 }, { unique: true });
module.exports = mongoose.model("BillingSetup", schema);
