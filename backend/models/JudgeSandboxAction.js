const mongoose = require('mongoose'), { Schema } = mongoose;
const schema = new Schema({
  pairId: { type: Schema.Types.ObjectId, ref: 'JudgeSandboxPair', required: true },
  runId: { type: Schema.Types.ObjectId, ref: 'JudgeSandboxRun', required: true },
  actorId: { type: Schema.Types.ObjectId, ref: 'Landlord', required: true },
  key: { type: String, required: true, minlength: 16, maxlength: 80 },
  inputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  action: { type: String, required: true, enum: ['start', 'continue', 'pause', 'resume'] },
  stepCode: { type: String, required: true },
  state: { type: String, required: true, enum: ['claimed', 'completed', 'refused', 'unknown'] },
  // Closed contract projection only; never a vendor capability or model body.
  result: { type: Schema.Types.Mixed, default: null },
  httpStatus: { type: Number, default: null },
  errorCode: { type: String, default: null },
  receiptRef: { type: String, maxlength: 100, default: null }
}, { timestamps: true, strict: 'throw' });
schema.index({ pairId: 1, key: 1 }, { unique: true });
module.exports = mongoose.model('JudgeSandboxAction', schema);
