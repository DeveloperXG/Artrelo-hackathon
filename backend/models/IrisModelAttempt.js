const { Schema, model } = require('mongoose');
// Minimal attempt accounting, with the same24h retention as its parent turn.
// The externally authorized spend ledger remains the source of budget truth.
const schema = new Schema({
  attemptRef: { type: String, required: true, immutable: true, unique: true },
  turnRef: { type: String, required: true, immutable: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  index: { type: Number, min: 1, max: 3, required: true, immutable: true },
  purpose: { type: String, enum: ['planning', 'selection'], required: true, immutable: true },
  bodyHash: { type: String, required: true, immutable: true },
  bodyBytes: { type: Number, required: true, immutable: true },
  maxCompletionTokens: { type: Number, required: true, immutable: true },
  reservationRef: { type: String, default: null },
  state: { type: String, enum: ['reserved', 'started', 'completed', 'rejected', 'unknown', 'cancelled'], required: true },
  usage: { prompt_tokens: Number, completion_tokens: Number, total_tokens: Number },
  errorCode: { type: String, default: null },
  expiresAt: { type: Date, required: true },
}, { strict: 'throw', timestamps: true });
schema.index({ turnRef: 1, index: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = model('IrisModelAttempt', schema);
