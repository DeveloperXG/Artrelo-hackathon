const mongoose = require('mongoose');
const c = require('../contracts/judgeSandbox.v1.json'), { Schema } = mongoose;
const schema = new Schema({
  pairId: { type: Schema.Types.ObjectId, ref: 'JudgeSandboxPair', required: true, unique: true },
  landlordId: { type: Schema.Types.ObjectId, ref: 'Landlord', required: true, index: true },
  requestId: { type: Schema.Types.ObjectId, ref: 'MaintenanceRequest', default: null },
  // Absent historical rows remain legacy; only an explicit new start opts in.
  storyVersion: { type: String, enum: Object.values(c.storyVersions), default: c.storyVersions.legacy },
  revision: { type: Number, required: true, default: 1, min: 1 },
  state: { type: String, required: true, enum: c.states },
  stepCode: { type: String, required: true, enum: c.steps },
  detail: { type: String, default: '', maxlength: 500 },
  checkpoint: { type: Schema.Types.Mixed, default: null },
  error: { type: Schema.Types.Mixed, default: null },
  paused: { type: Boolean, default: false },
  stateBeforePause: { type: String, enum: [...c.states, null], default: null },
  inFlightActionId: { type: Schema.Types.ObjectId, default: null },
  completedDirectives: { type: [String], default: [] },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null }
}, { timestamps: true, strict: 'throw' });
module.exports = mongoose.model('JudgeSandboxRun', schema);
