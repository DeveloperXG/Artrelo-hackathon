const { Schema, model } = require('mongoose');
// Specific scheduling aggregate, not an approval or a second appointment.
// Only the server transition contract writes proposal/events; no raw client
// document is accepted. The same transaction records consent and application.
const schema = new Schema({
  preparationId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  appointmentId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  creationKey: { type: String, required: true, immutable: true, unique: true },
  inputHash: { type: String, required: true, immutable: true },
  revision: { type: Number, required: true, min: 1 },
  status: { type: String, required: true, enum: ['awaiting_vendor', 'awaiting_tenant', 'ready_to_commit', 'committed', 'declined', 'expired', 'conflict', 'invalidated'] },
  active: { type: Boolean, required: true },
  expiresAt: { type: Date, required: true },
  nextCheckAt: { type: Date, default: Date.now },
  proposal: { type: Schema.Types.Mixed, required: true },
  receipts: { type: [String], default: [] },
}, { timestamps: true, strict: 'throw' });
schema.index({ preparationId: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ active: 1, expiresAt: 1 });
schema.index({ active: 1, nextCheckAt: 1 });
schema.index({ landlordId: 1, requestId: 1, createdAt: -1 });
module.exports = model('BookingReschedule', schema);
