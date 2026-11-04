const mongoose = require("mongoose");
const Rate = new mongoose.Schema({ flatCents: { type: Number, min: 0 }, percent: { type: Number, min: 0, max: 20 } }, { _id: false });
const schema = new mongoose.Schema({
  landlordId: { type: mongoose.Schema.Types.ObjectId, ref: "Landlord", required: true, unique: true },
  version: { type: Number, default: 0 },
  offer: { version: String, rate: Rate, rateSource: String, createdAt: Date, noticeSentAt: Date, effectiveAt: Date },
  agreement: { version: String, rate: Rate, rateSource: String, acceptedAt: Date, ipHash: String },
  card: { paymentMethodId: String, brand: String, last4: String, setupIntentId: String, savedAt: Date, setupStartedAt: Date, setupRef: String },
  cutoverAt: Date, lastCollectionAttemptAt: Date,
}, { timestamps: true });
module.exports = mongoose.model("BillingAccount", schema);
