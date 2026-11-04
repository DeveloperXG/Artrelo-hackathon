const mongoose = require('mongoose'), { Schema } = mongoose;
const schema = new Schema({
  _id: { type: String, default: 'judge-core-v1' },
  manifestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  authorizationRef: { type: String, required: true, maxlength: 120 },
  state: { type: String, required: true, enum: ['starting', 'ready', 'failed'] },
  pairCount: { type: Number, required: true, min: 1, max: 12 },
  // One-way operator binding, never a password or recoverable signing secret.
  operatorBinding: {
    type: new Schema({ version: { type: Number, enum: [1], required: true },
      rosterHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
      signingFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ }
    }, { _id: false, strict: 'throw' }), default: undefined, immutable: true
  },
  finishedAt: { type: Date, default: null }
}, { timestamps: true, strict: 'throw' });
module.exports = mongoose.model('JudgeSandboxSeed', schema);
