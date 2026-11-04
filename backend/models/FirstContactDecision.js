const { Schema, model } = require('mongoose');
const schema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  candidateKey: { type: String, required: true, immutable: true },
  basisHash: { type: String, required: true, immutable: true },
  policyRevision: { type: Number, min: 0, required: true, immutable: true },
  policyValues: { type: Schema.Types.Mixed, required: true, immutable: true },
  mode: { type: String, enum: ['policy_auto_start', 'human_contact'], required: true, immutable: true },
  state: { type: String, enum: ['permitted', 'refused'], required: true, immutable: true },
  reasonCode: { type: String, required: true, immutable: true },
  approvalId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  auditId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  actorSubjectId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  authoritySource: { type: Schema.Types.Mixed, required: true, immutable: true },
  priorScreening: { type: [Schema.Types.Mixed], default: [], immutable: true },
  evaluatedAt: { type: Date, required: true, immutable: true },
}, { timestamps: true, strict: 'throw' });
schema.index({ requestId: 1, candidateKey: 1, basisHash: 1, mode: 1, policyRevision: 1 }, { unique: true });
schema.index({ landlordId: 1, requestId: 1, state: 1 });
module.exports = model('FirstContactDecision', schema);
