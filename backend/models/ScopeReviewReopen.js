const { Schema, model } = require("mongoose");

// Append-only recovery receipt. A caller's raw retry key is never persisted.
const ScopeReviewReopenSchema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  stage: { type: String, enum: ["quote", "invoice"], required: true, immutable: true },
  keyHash: { type: String, required: true, immutable: true },
  fingerprint: { type: String, required: true, immutable: true },
  declinedApprovalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  approvalId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  reviewRevision: { type: Number, required: true, min: 1, immutable: true, validate: Number.isSafeInteger },
  quoteRevision: { type: Number, required: true, min: 1, immutable: true },
  quoteHash: { type: String, required: true, immutable: true },
  contextHash: { type: String, required: true, immutable: true },
  auditId: { type: Schema.Types.ObjectId, required: true, immutable: true },
}, { timestamps: true, strict: "throw" });
ScopeReviewReopenSchema.index({ landlordId: 1, keyHash: 1 }, { unique: true });
module.exports = model("ScopeReviewReopen", ScopeReviewReopenSchema);
