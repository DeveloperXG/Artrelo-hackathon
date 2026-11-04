const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  pairId: { type: mongoose.Schema.Types.ObjectId, required: true },
  runId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceKind: { type: String, enum: ['audit', 'closed_request'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  delivered: { type: Boolean, default: false },
  lastError: { type: String, enum: ['notification_unavailable', null], default: null }
}, { timestamps: true, strict: 'throw' });
schema.index({ runId: 1, sourceKind: 1, sourceId: 1 }, { unique: true });
module.exports = mongoose.model('JudgeSandboxNotice', schema);
