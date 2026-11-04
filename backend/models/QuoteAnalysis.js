const { Schema, model } = require("mongoose");
const QuoteAnalysisSchema = new Schema({
  landlordId: { type: Schema.Types.ObjectId, required: true, index: true },
  requestId: { type: Schema.Types.ObjectId, required: true, index: true },
  subjectId: { type: Schema.Types.ObjectId, required: true },
  stage: { type: String, enum: ["quote", "invoice"], required: true },
  quoteRevision: { type: Number, required: true, min: 1, max: 5 },
  quoteHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  contextHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  status: { type: String, enum: ["pending", "running", "ready", "unavailable", "stale"], default: "pending" },
  source: { type: String, enum: ["disabled", "development_stub", "meta"], default: "disabled" },
  provider: String, model: String,
  // Only validated output and numeric safe telemetry, never prompts/raw response.
  result: { type: Schema.Types.Mixed, default: null },
  errorCode: String,
  durationMs: { type: Number, min: 0 },
  usage: { promptTokens: Number, completionTokens: Number, totalTokens: Number },
  leaseToken: { type: String, select: false }, leaseUntil: Date,
}, { timestamps: true, strict: "throw" });
QuoteAnalysisSchema.index({ landlordId: 1, subjectId: 1, stage: 1, quoteHash: 1, contextHash: 1 }, { unique: true });
module.exports = model("QuoteAnalysis", QuoteAnalysisSchema);
