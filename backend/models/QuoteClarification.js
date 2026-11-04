const { Schema, model } = require("mongoose");
const schema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  requestId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  stage: { type: String, enum: ["quote", "invoice"], required: true, immutable: true },
  quoteRevision: { type: Number, required: true, immutable: true },
  quoteHash: { type: String, required: true, immutable: true },
  contextHash: { type: String, required: true, immutable: true },
  policyRevision: { type: Number, required: true, immutable: true },
  permissionApprovalId: { type: Schema.Types.ObjectId, immutable: true },
  nonce: { type: String, required: true, select: false },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  state: { type: String, enum: ["draft", "ready", "delivery_unknown", "answered", "expired", "failed"], default: "draft" },
  delivery: { type: String, enum: ["disabled", "delivering", "sent", "development_preview", "failed", "unknown"], default: "disabled" },
  deliveryStartedAt: Date,
  questions: [{ _id: false, id: { type: String, required: true }, code: String, lineIds: [String], text: String }],
  answers: [{ _id: false, questionId: String, answer: { type: String, maxlength: 800 } }],
  answeredAt: Date,
  resultingRevision: Number,
}, { timestamps: true, strict: "throw" });
// One follow-up round per subject/stage across all revisions, two per request.
schema.index({ subjectId: 1, stage: 1 }, { unique: true });
schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ requestId: 1, landlordId: 1 });
module.exports = model("QuoteClarification", schema);
