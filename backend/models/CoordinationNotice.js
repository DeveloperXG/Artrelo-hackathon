const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  preparationId: { type: mongoose.Schema.Types.ObjectId, ref: "BookingPreparation", required: true },
  purpose: { type: String, enum: ['booking', 'reschedule'], default: 'booking' },
  rescheduleId: { type: mongoose.Schema.Types.ObjectId, ref: 'BookingReschedule' },
  revision: { type: Number, required: true },
  audience: { type: String, enum: ["landlord", "tenant", "vendor"], required: true },
  phase: { type: String, required: true },
  status: { type: String, enum: ["pending", "processing", "sent", "stale", "uncertain", "failed", "disabled"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: null },
  notificationCreatedAt: { type: Date, default: null },
  errorCode: { type: String, default: null },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1 });
module.exports = mongoose.model("CoordinationNotice", schema);
