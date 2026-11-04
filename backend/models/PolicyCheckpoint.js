const { Schema, model } = require("mongoose");
const PolicyCheckpointSchema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  stage: { type: String, enum: ["vendor_quote"], required: true, immutable: true },
  basisHash: { type: String, required: true, immutable: true },
  policyHash: { type: String, required: true, immutable: true },
  policyRevision: { type: Number, min: 0, required: true, immutable: true },
  quoteRevision: { type: Number, required: true, immutable: true },
  quoteHash: { type: String, required: true, immutable: true },
  quoteHighMinor: { type: Number, required: true, min: 0, immutable: true,
    validate: { validator: Number.isSafeInteger, message: "Quote price must be cents" } },
  effectiveLimit: { type: Number, default: null, immutable: true },
  quotaSource: { type: String, enum: ["request", "unit", "property", "category", "default", "unset"], required: true, immutable: true },
  // An append-only attempt. A new policy/authority basis may create another
  // unpassed attempt; any passed attempt for this exact quote basis is reused.
  state: { type: String, enum: ["passed", "review_required"], required: true, immutable: true },
  submittedAt: { type: Date, required: true, immutable: true },
  evaluatedAt: { type: Date, required: true, immutable: true },
  passedAt: { type: Date, default: null, immutable: true },
}, { timestamps: true, strict: "throw" });
PolicyCheckpointSchema.index({ landlordId: 1, subjectId: 1, stage: 1, basisHash: 1, policyHash: 1 }, { unique: true });
PolicyCheckpointSchema.index({ landlordId: 1, subjectId: 1, stage: 1, basisHash: 1, state: 1 });
module.exports = model("PolicyCheckpoint", PolicyCheckpointSchema);
