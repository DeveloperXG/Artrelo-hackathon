const mongoose = require('mongoose'), { Schema } = mongoose;
const schema = new Schema({
  pairId: { type: Schema.Types.ObjectId, required: true, index: true },
  runId: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, required: true, min: 1 },
  kind: { type: String, required: true, enum: ['started', 'observed', 'claimed', 'completed', 'refused', 'unknown', 'paused', 'resumed'] },
  actorRole: { type: String, required: true, enum: ['landlord', 'automation'] },
  actorId: { type: Schema.Types.ObjectId, default: null },
  stepCode: { type: String, required: true },
  actionId: { type: Schema.Types.ObjectId, default: null },
  receiptRef: { type: String, maxlength: 100, default: null }
}, { timestamps: true, strict: 'throw' });
schema.index({ runId: 1, revision: 1 }, { unique: true });
module.exports = mongoose.model('JudgeSandboxEvent', schema);
