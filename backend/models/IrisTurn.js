const { Schema, model } = require('mongoose');
const schema = new Schema({
  turnRef: { type: String, required: true, immutable: true, unique: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  role: { type: String, required: true, immutable: true },
  clientTurnId: { type: String, required: true, immutable: true },
  conversationHash: { type: String, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, default: null, immutable: true },
  contextGeneration: { type: Number, required: true, immutable: true },
  status: { type: String, enum: ['accepted', 'reading', 'formatting', 'completed', 'refused', 'cancelled', 'interrupted', 'unavailable'], required: true },
  attemptRefs: { type: [String], default: [] },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw' });
schema.index({ subjectId: 1, clientTurnId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = model('IrisTurn', schema);
