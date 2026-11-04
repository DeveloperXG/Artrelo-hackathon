// Batch validation for proposed units.
//
// Every bulk path — the pattern generator, a pasted list, a CSV upload, and one
// day an AI parser — converges here before anything reaches the database. The
// input methods differ only in how they produce a list of strings; the rules
// that decide whether those strings may become units live in this one place, so
// a new input method inherits them for free and cannot invent its own.
//
// This module is pure. It never touches Mongoose. The caller supplies the set of
// identifiers the property already holds, which keeps the whole batch on a
// single database round trip instead of one query per proposed unit.

// Long enough for "Building C - Retail Suite 12", short enough that a pasted
// paragraph fails loudly instead of silently becoming a unit name.
const MAX_IDENTIFIER_LENGTH = 64;

// A ceiling on one request. Well past the largest realistic building, and low
// enough that a runaway generator (floors: 1-9999) is rejected as input rather
// than absorbed as a multi-minute write.
const MAX_BATCH_SIZE = 5000;

const ERROR_MESSAGES = {
  EMPTY: "Unit identifier is required",
  TOO_LONG: `Unit identifier must be ${MAX_IDENTIFIER_LENGTH} characters or fewer`,
  DUPLICATE_IN_BATCH: "Duplicate of another unit in this batch",
  ALREADY_EXISTS: "This property already has a unit with this identifier",
};

/**
 * Collapse the incidental whitespace a paste or spreadsheet cell drags along,
 * and nothing else.
 *
 * Capitalization is the landlord's: "PH1", "ph1" and "Retail-A" are their
 * naming scheme, not a mistake to correct. Only runs of whitespace (including
 * the non-breaking spaces that come out of Excel) are normalized, so
 * "Unit  A" and "Unit A" are the same unit but "A1" never becomes "a1".
 */
function normalizeIdentifier(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/[\s\u00a0]+/g, " ").trim();
}

/**
 * The key two identifiers are compared under.
 *
 * Case-insensitive on purpose: no landlord maintains "a1" and "A1" as separate
 * units, so treating them as distinct would let a bulk import quietly create a
 * second copy of a unit that already exists. Storage keeps the original casing;
 * only comparison folds it.
 */
function comparisonKey(identifier) {
  return normalizeIdentifier(identifier).toLocaleLowerCase();
}

/**
 * Validate a whole batch of proposed identifiers at once.
 *
 * @param {Array<string|{name?: string, unitNumber?: string}>} proposed
 *   Raw rows, as strings or as objects carrying a name. Order is preserved so
 *   the caller can line results up against its own review table.
 * @param {Iterable<string>} existingIdentifiers
 *   Identifiers the destination property already holds.
 * @returns {{rows: Array, summary: Object, valid: boolean}}
 *   `rows` mirrors `proposed` one-for-one. `summary` counts what went wrong.
 */
function validateUnitBatch(proposed, existingIdentifiers = []) {
  const list = Array.isArray(proposed) ? proposed : [];
  const existing = new Set();
  for (const identifier of existingIdentifiers) {
    const key = comparisonKey(identifier);
    if (key) existing.add(key);
  }

  // First occurrence wins: row 3 is the duplicate of row 1, not the other way
  // round, so the review table flags the copy the user most likely pasted twice.
  const seen = new Set();
  const rows = list.map((entry, index) => {
    const input = typeof entry === "string" ? entry : entry?.name ?? entry?.unitNumber ?? "";
    const name = normalizeIdentifier(input);
    const key = comparisonKey(name);
    const errors = [];

    if (!name) {
      errors.push("EMPTY");
    } else if (name.length > MAX_IDENTIFIER_LENGTH) {
      errors.push("TOO_LONG");
    } else {
      if (seen.has(key)) errors.push("DUPLICATE_IN_BATCH");
      if (existing.has(key)) errors.push("ALREADY_EXISTS");
      seen.add(key);
    }

    return {
      index,
      input: typeof input === "string" ? input : String(input ?? ""),
      name,
      valid: errors.length === 0,
      errors: errors.map((code) => ({ code, message: ERROR_MESSAGES[code] })),
    };
  });

  const has = (code) => (row) => row.errors.some((error) => error.code === code);
  const summary = {
    total: rows.length,
    valid: rows.filter((row) => row.valid).length,
    invalid: rows.filter((row) => !row.valid).length,
    empty: rows.filter(has("EMPTY")).length,
    tooLong: rows.filter(has("TOO_LONG")).length,
    duplicates: rows.filter(has("DUPLICATE_IN_BATCH")).length,
    collisions: rows.filter(has("ALREADY_EXISTS")).length,
  };

  return { rows, summary, valid: summary.invalid === 0 && summary.total > 0 };
}

module.exports = {
  MAX_IDENTIFIER_LENGTH,
  MAX_BATCH_SIZE,
  ERROR_MESSAGES,
  normalizeIdentifier,
  comparisonKey,
  validateUnitBatch,
};
