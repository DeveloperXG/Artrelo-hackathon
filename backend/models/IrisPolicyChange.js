const { Schema, model } = require('mongoose');
const schema = new Schema({
  changeRef: { type: String, required: true, immutable: true, unique: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  role: { type: String, required: true, immutable: true },
  turnRef: { type: String, required: true, immutable: true },
  origin: { type: Schema.Types.Mixed, required: true, immutable: true },
  basePolicyRevision: { type: Number, default: null, immutable: true },
  policyExisted: { type: Boolean, required: true, immutable: true },
  basePolicyHash: { type: String, required: true, immutable: true },
  patch: { type: Schema.Types.Mixed, required: true, immutable: true },
  changes: { type: [Schema.Types.Mixed], required: true, immutable: true },
  patchHash: { type: String, required: true, immutable: true },
  impactHash: { type: String, required: true, immutable: true },
  impactRows: { type: [Schema.Types.Mixed], required: true, immutable: true },
  impactComplete: { type: Boolean, required: true, immutable: true },
  asOf: { type: Date, required: true, immutable: true },
  expiresAt: { type: Date, required: true, immutable: true },
  tokenHash: { type: String, required: true, select: false },
  state: { type: String, enum: ['preview_ready', 'stale', 'expired', 'discarded', 'applied', 'failed'], required: true },
  clientActionId: { type: String, default: null },
  appliedRevision: { type: Number, default: null },
  verifiedValues: { type: Schema.Types.Mixed, default: null },
  auditRef: { type: String, default: null },
  policyReceiptId: { type: Schema.Types.ObjectId, default: null },
  appliedAt: { type: Date, default: null },
  attemptedAt: { type: Date, default: null },
  errorCode: { type: String, default: null },
}, { timestamps: true, strict: 'throw' });
schema.index({ subjectId: 1, createdAt: -1 });
schema.index({ subjectId: 1, turnRef: 1 }, { unique: true });
schema.index({ subjectId: 1, clientActionId: 1 }, { unique: true, partialFilterExpression: { clientActionId: { $type: 'string' } } });
module.exports = model('IrisPolicyChange', schema);
