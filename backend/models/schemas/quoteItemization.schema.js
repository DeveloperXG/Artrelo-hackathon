const { Schema } = require("mongoose");
const { CATEGORIES, MAX_MINOR, MAX_REVISIONS, normalizeItemization, itemizationContentHash } = require("../../services/quotes/itemization.service");

const options = { _id: false, strict: "throw" };
const money = () => ({ type: Number, min: 0, max: MAX_MINOR,
  validate: { validator: Number.isSafeInteger, message: "Money must be integer cents" } });
const LineSchema = new Schema({
  lineId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,80}$/ },
  description: { type: String, required: true, trim: true, maxlength: 240 },
  category: { type: String, required: true, enum: CATEGORIES },
  amountMinor: money(), lowMinor: money(), highMinor: money(),
}, options);
const TotalsSchema = new Schema({
  lowMinor: { ...money(), required: true }, highMinor: { ...money(), required: true },
}, options);
const ItemizationSchema = new Schema({
  pricingMode: { type: String, required: true, enum: ["fixed", "range"] },
  currency: { type: String, required: true, enum: ["CAD"] },
  items: { type: [LineSchema], required: true, default: undefined },
  totals: { type: TotalsSchema, required: true },
}, options);
// Persistence backstop, not raw API validation: Mongoose casts before validation.
// Call normalizeItemization BEFORE constructing/updating a document.
ItemizationSchema.path("items").validate(function () {
  try {
    const value = this.toObject({ virtuals: false });
    normalizeItemization(value, { allowedLineIds: (value.items || []).map(line => line.lineId) });
    return true;
  } catch (_) { return false; }
}, "Itemization mode, IDs, totals or bounds are inconsistent");

const QuoteSnapshotSchema = new Schema({
  quoteContractVersion: { type: Number, required: true, enum: [2], immutable: true },
  revision: { type: Number, required: true, min: 1, max: MAX_REVISIONS, immutable: true,
    validate: { validator: Number.isInteger, message: "Revision must be an integer" } },
  hash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  itemization: { type: ItemizationSchema, required: true, immutable: true },
}, options);
QuoteSnapshotSchema.path("hash").validate(function (hash) {
  try { return hash === itemizationContentHash(this.itemization.toObject({ virtuals: false })); }
  catch (_) { return false; }
}, "Quote hash must match the stored content");

// These are embedded schemas only, not registered collections or an append/CAS workflow.
module.exports = { ItemizationSchema, QuoteSnapshotSchema };
