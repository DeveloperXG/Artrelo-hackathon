const mongoose = require("mongoose");
const { Schema } = mongoose;

// One active negotiation per request. Historical rounds remain readable after
// a rejection, fallback, or a negotiated return; an old link never revives one.
const BookingPreparationSchema = new Schema({
  requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", required: true },
  outreachId: { type: Schema.Types.ObjectId, ref: "VendorOutreach", required: true, unique: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", default: null },
  landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", required: true },
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
  identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", required: true },
  paymentMode: { type: String, enum: ["direct", "platform"], required: true },
  active: { type: Boolean, default: true },
  phase: { type: String, enum: ["preparing", "awaiting_approval", "awaiting_funds", "awaiting_vendor", "awaiting_tenant", "scheduled", "paused", "expired", "closed"], required: true },
  revision: { type: Number, default: 0 },
  rescheduleFence: { type: Number, default: 0, select: false },
  amountCents: { type: Number, min: 0, default: null },
  shortfallCents: { type: Number, min: 0, default: 0 },
  reasonCode: { type: String, default: null },
  deadlineAt: { type: Date, required: true },
  rounds: { type: Number, default: 0, min: 0, max: 2 },
  proposals: { type: [{ start: Date, end: Date }], default: [] },
  proposedBy: { type: String, enum: ["tenant", "vendor", "landlord", null], default: null },
  arrivalAt: { type: Date, default: null },
  durationMinutes: { type: Number, min: 15, max: 720, default: null },
  leaseToken: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  attempts: { type: Number, default: 0 },
  lastErrorCode: { type: String, default: null },
}, { timestamps: true });
BookingPreparationSchema.index({ requestId: 1 }, { unique: true, partialFilterExpression: { active: true } });
BookingPreparationSchema.index({ active: 1, phase: 1, nextAttemptAt: 1 });
module.exports = mongoose.model("BookingPreparation", BookingPreparationSchema);
