const mongoose = require("mongoose");
const { Schema } = mongoose;
const schema = new Schema({
  // Public references are opaque even for the vendor who owns this calendar.
  ref: { type: String, required: true, unique: true },
  identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", required: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", default: undefined },
  preparationId: { type: Schema.Types.ObjectId, ref: "BookingPreparation", default: null },
  kind: { type: String, enum: ["appointment", "busy"], required: true },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
  note: { type: String, maxlength: 200, default: "" },
  active: { type: Boolean, default: true },
  releasedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ identityId: 1, active: 1, start: 1, end: 1 });
schema.index({ appointmentId: 1 }, { unique: true, partialFilterExpression: { appointmentId: { $type: "objectId" } } });
module.exports = mongoose.model("VendorReservation", schema);
