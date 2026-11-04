const mongoose = require('mongoose');
const { Schema } = mongoose;
// Explicit synthetic registry, written only by the isolated fixture bootstrap.
// No credential, public claim capability or reset generation lives here.
const schema = new Schema({
  ordinal: { type: Number, required: true, min: 1, max: 12, unique: true, validate: Number.isInteger },
  label: { type: String, required: true, maxlength: 50 },
  landlordId: { type: Schema.Types.ObjectId, ref: 'Landlord', required: true, unique: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
  propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true, unique: true },
  vendorIds: { type: [Schema.Types.ObjectId], required: true, validate: v => v.length >= 1 && v.length <= 4 && new Set(v.map(String)).size === v.length },
  identityIds: { type: [Schema.Types.ObjectId], required: true, validate: v => v.length >= 1 && v.length <= 4 && new Set(v.map(String)).size === v.length },
  active: { type: Boolean, default: true },
  spare: { type: Boolean, default: false },
  fixtureVersion: { type: String, required: true, maxlength: 80 }
}, { timestamps: true, strict: 'throw' });
// Prevent cross-pair calendar identity and vendor reuse at the database boundary.
schema.index({ vendorIds: 1 }, { unique: true });
schema.index({ identityIds: 1 }, { unique: true });
module.exports = mongoose.model('JudgeSandboxPair', schema);
