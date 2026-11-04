const { Schema, model } = require('mongoose');
const schema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  revision: { type: Number, required: true, immutable: true, min: 1 },
  beforeRevision: { type: Number, default: null, immutable: true },
  beforeValues: { type: Schema.Types.Mixed, required: true, immutable: true },
  afterValues: { type: Schema.Types.Mixed, required: true, immutable: true },
  observedBeforeAt: { type: Date, required: true, immutable: true },
  actorSubjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actorRole: { type: String, required: true, immutable: true },
  origin: { type: String, enum: ['policy_ui', 'iris_confirmed'], required: true, immutable: true },
  auditId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  changeRef: { type: String, default: null, immutable: true },
  changedFields: { type: [String], required: true, immutable: true },
  refreshState: { type: String, enum: ['pending', 'running', 'completed', 'partial', 'failed', 'not_required'], default: 'pending' },
  refreshAttemptAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw' });
schema.index({ landlordId: 1, revision: 1 }, { unique: true });
schema.index({ refreshState: 1, updatedAt: 1 });
module.exports = model('LandlordPolicyRevision', schema);
