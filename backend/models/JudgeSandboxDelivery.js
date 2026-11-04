const mongoose = require('mongoose'), { Schema } = mongoose;
const schema = new Schema({
  pairId: { type: Schema.Types.ObjectId, required: true },
  landlordId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: Schema.Types.ObjectId, required: true },
  outreachId: { type: Schema.Types.ObjectId, required: true, unique: true },
  vendorId: { type: Schema.Types.ObjectId, required: true },
  identityId: { type: Schema.Types.ObjectId, required: true },
  channel: { type: String, enum: ['simulation'], default: 'simulation', immutable: true },
  realDelivery: { type: Boolean, default: false, immutable: true, validate: value => value === false },
  acceptedAt: { type: Date, required: true }
}, { timestamps: true, strict: 'throw' });
module.exports = mongoose.model('JudgeSandboxDelivery', schema);
