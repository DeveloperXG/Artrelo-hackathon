const { createHash, randomUUID } = require("node:crypto");

const QUOTE_CONTRACT_VERSION = 2;
const MAX_MINOR = 100_000_000;
const MAX_ITEMS = 50;
const MAX_REVISIONS = 5;
const CATEGORIES = Object.freeze(["labour", "materials", "callout", "travel", "disposal", "tax", "other"]);

class ItemizationError extends Error {
  constructor(code, field) {
    super(code);
    this.name = "ItemizationError";
    this.code = code;
    this.field = field;
    this.status = 400;
  }
}
const fail = (code, field) => { throw new ItemizationError(code, field); };
const own = (value, key) => Object.hasOwn(value, key);
function object(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid_itemization", field);
  if (Object.keys(value).some(key => !keys.includes(key))) fail("unexpected_field", field);
}
function required(value, keys, field) {
  if (keys.some(key => !own(value, key))) fail("invalid_itemization", field);
}
function minor(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_money", field);
  if (value > MAX_MINOR) fail("quote_limit_exceeded", field);
  return value === 0 ? 0 : value;
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validLineId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

/**
 * Raw API input must pass here with IDs loaded from the owned server record.
 * allowedLineIds and allocateLineId are trusted service arguments, never body fields.
 * ID allocation is separate from the content hash so identical retries compare equal.
 */
function normalizeItemization(input, { allowedLineIds = [], allocateLineId = randomUUID } = {}) {
  object(input, ["pricingMode", "currency", "items", "totals"], "itemization");
  required(input, ["pricingMode", "currency", "items", "totals"], "itemization");
  if (!["fixed", "range"].includes(input.pricingMode)) fail("invalid_pricing_mode", "pricingMode");
  if (input.currency !== "CAD") fail("unsupported_currency", "currency");
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_ITEMS) fail("invalid_items", "items");
  if (!Array.isArray(allowedLineIds) || !allowedLineIds.every(validLineId) || typeof allocateLineId !== "function") {
    throw new TypeError("Invalid trusted itemization options");
  }
  const allowed = new Set(allowedLineIds), seen = new Set();
  let lowMinor = 0, highMinor = 0;
  const items = Array.from(input.items, (line, index) => {
    const field = `items.${index}`;
    const fixed = input.pricingMode === "fixed";
    object(line, ["lineId", "description", "category", ...(fixed ? ["amountMinor"] : ["lowMinor", "highMinor"])], field);
    required(line, ["description", "category", ...(fixed ? ["amountMinor"] : ["lowMinor", "highMinor"])], field);
    if (typeof line.description !== "string" || !line.description.trim() || line.description.trim().length > 240) {
      fail("invalid_description", `${field}.description`);
    }
    if (!CATEGORIES.includes(line.category)) fail("invalid_category", `${field}.category`);
    let lineId;
    if (own(line, "lineId")) {
      if (!validLineId(line.lineId)) fail("invalid_line_id", `${field}.lineId`);
      if (!allowed.has(line.lineId)) fail("foreign_line_id", `${field}.lineId`);
      lineId = line.lineId;
    } else {
      lineId = allocateLineId();
      // A broken allocator must never reassign a removed/existing line's identity.
      if (!validLineId(lineId) || allowed.has(lineId)) throw new TypeError("Invalid server line ID allocation");
    }
    if (seen.has(lineId)) fail("duplicate_line_id", `${field}.lineId`);
    seen.add(lineId);
    const low = minor(fixed ? line.amountMinor : line.lowMinor, `${field}.${fixed ? "amountMinor" : "lowMinor"}`);
    const high = fixed ? low : minor(line.highMinor, `${field}.highMinor`);
    if (low > high) fail("inverted_range", field);
    lowMinor += low; highMinor += high;
    if (highMinor > MAX_MINOR) fail("quote_limit_exceeded", "totals");
    return { lineId, description: line.description.trim(), category: line.category,
      ...(fixed ? { amountMinor: low } : { lowMinor: low, highMinor: high }) };
  });
  object(input.totals, ["lowMinor", "highMinor"], "totals");
  required(input.totals, ["lowMinor", "highMinor"], "totals");
  const suppliedLow = minor(input.totals.lowMinor, "totals.lowMinor");
  const suppliedHigh = minor(input.totals.highMinor, "totals.highMinor");
  if (suppliedLow !== lowMinor || suppliedHigh !== highMinor) fail("quote_total_mismatch", "totals");
  return freeze({ pricingMode: input.pricingMode, currency: "CAD", items, totals: { lowMinor, highMinor } });
}

// Not an ownership validator. Call normalizeItemization with server-owned IDs first.
// Canonical content includes order and all price/text fields, excluding identities.
function itemizationContentHash(normalized) {
  const content = {
    quoteContractVersion: QUOTE_CONTRACT_VERSION,
    pricingMode: normalized.pricingMode,
    currency: normalized.currency,
    items: normalized.items.map(({ description, category, amountMinor, lowMinor, highMinor }) =>
      normalized.pricingMode === "fixed" ? { description, category, amountMinor } : { description, category, lowMinor, highMinor }),
    totals: { lowMinor: normalized.totals.lowMinor, highMinor: normalized.totals.highMinor },
  };
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function createQuoteSnapshot(input, { revision, ...options } = {}) {
  if (!Number.isInteger(revision) || revision < 1 || revision > MAX_REVISIONS) fail("invalid_quote_revision", "revision");
  const itemization = normalizeItemization(input, options);
  return freeze({ quoteContractVersion: QUOTE_CONTRACT_VERSION, revision,
    hash: itemizationContentHash(itemization), itemization });
}

function dollarToMinor(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("invalid_money", field);
  if (value > MAX_MINOR / 100) fail("quote_limit_exceeded", field);
  // Check precision before converting; don't round a caller's fractional cent.
  if (Number(value.toFixed(2)) !== value) fail("invalid_money", field);
  return minor(Math.round(value * 100), field);
}

/** Compare only explicitly supplied legacy projections; never coerce or rewrite history. */
function reconcileLegacyTotals(normalized, legacy = {}) {
  object(legacy, ["quoteLow", "quoteHigh", "actualCost"], "legacy");
  const { lowMinor, highMinor } = normalized.totals;
  if (own(legacy, "quoteLow") || own(legacy, "quoteHigh")) {
    if (dollarToMinor(legacy.quoteLow, "quoteLow") !== lowMinor || dollarToMinor(legacy.quoteHigh, "quoteHigh") !== highMinor) {
      fail("quote_total_mismatch", "legacy");
    }
  }
  if (own(legacy, "actualCost")) {
    if (normalized.pricingMode !== "fixed" || dollarToMinor(legacy.actualCost, "actualCost") !== highMinor) {
      fail("quote_total_mismatch", "actualCost");
    }
  }
  return freeze({ quoteLow: lowMinor / 100, quoteHigh: highMinor / 100 });
}

/** Absence is null; zero is a real price. Never infer an agreement from a range. */
function calculateQuoteDeltas(input) {
  object(input, ["originalLowMinor", "originalHighMinor", "agreedMinor", "finalMinor"], "basis");
  const read = key => input[key] === undefined || input[key] === null ? null : minor(input[key], key);
  const low = read("originalLowMinor"), high = read("originalHighMinor");
  const agreed = read("agreedMinor"), final = read("finalMinor");
  if ((low === null) !== (high === null)) fail("incomplete_estimate_basis", "basis");
  if (low !== null && low > high) fail("inverted_range", "basis");
  const againstRange = value => value === null || low === null ? null :
    { versusLowMinor: value - low, versusHighMinor: value - high };
  return freeze({ originalEstimate: low === null ? null : { lowMinor: low, highMinor: high },
    agreedMinor: agreed, finalMinor: final, agreedVsEstimate: againstRange(agreed), finalVsEstimate: againstRange(final),
    finalVsAgreed: agreed === null || final === null ? null : {
      amountMinor: final - agreed,
      percent: agreed === 0 ? null : Number(((final - agreed) * 100 / agreed).toFixed(4)),
    } });
}

module.exports = { QUOTE_CONTRACT_VERSION, MAX_MINOR, MAX_ITEMS, MAX_REVISIONS, CATEGORIES,
  ItemizationError, normalizeItemization, itemizationContentHash, createQuoteSnapshot,
  dollarToMinor, reconcileLegacyTotals, calculateQuoteDeltas };
