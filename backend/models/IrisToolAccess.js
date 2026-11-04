const { Schema, model } = require('mongoose');
const schema = new Schema({
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  turnRef: { type: String, required: true, immutable: true },
  tool: { type: String, required: true, immutable: true },
  scopeRefHashes: { type: [String], required: true, immutable: true },
  outcome: { type: String, required: true, immutable: true },
  recordCount: { type: Number, min: 0, required: true, immutable: true },
  sourceVersionHashes: { type: [String], default: [], immutable: true },
}, { timestamps: true, strict: 'throw' });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });
schema.index({ subjectId: 1, createdAt: -1 });
module.exports = model('IrisToolAccess', schema);
