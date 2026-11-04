// Batch validation for proposed properties and the units under them.
//
// This is unitBatch.service.js one level up, and it reuses it rather than
// restating it: a property's units are validated by exactly the code that
// validates a single-property bulk import, so the two can never drift into
// disagreeing about what a unit identifier is.
//
// Pure, like its sibling. The caller supplies the property names the landlord
// already owns, which keeps a 12-property, 438-unit import on one database
// round trip for the collision check instead of one per property.

const { validateUnitBatch, normalizeIdentifier, comparisonKey } = require("./unitBatch.service");

// A portfolio import is an onboarding event, not a data pipeline. These are
// high enough that no real portfolio hits them and low enough that a malformed
// file is rejected as input rather than absorbed as a multi-minute write.
const MAX_PROPERTIES = 500;
const MAX_UNITS = 5000;

const MAX_NAME_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 240;

const ERROR_MESSAGES = {
  NAME_REQUIRED: "Property name is required",
  ADDRESS_REQUIRED: "Property address is required",
  NAME_TOO_LONG: `Property name must be ${MAX_NAME_LENGTH} characters or fewer`,
  ADDRESS_TOO_LONG: `Property address must be ${MAX_ADDRESS_LENGTH} characters or fewer`,
  DUPLICATE_IN_BATCH: "Duplicate of another property in this batch",
  ALREADY_EXISTS: "You already have a property with this name",
  NO_UNITS: "This property has no units",
};

/**
 * Validate a whole portfolio at once.
 *
 * @param {Array<{name?: string, address?: string, units?: Array}>} proposed
 * @param {Iterable<string>} existingPropertyNames names the landlord already owns
 * @returns {{properties: Array, summary: Object, valid: boolean}}
 */
function validatePortfolioBatch(proposed, existingPropertyNames = []) {
  const list = Array.isArray(proposed) ? proposed : [];

  const existing = new Set();
  for (const name of existingPropertyNames) {
    const key = comparisonKey(name);
    if (key) existing.add(key);
  }

  const seen = new Set();
  const properties = list.map((entry, index) => {
    const name = normalizeIdentifier(entry?.name);
    const address = normalizeIdentifier(entry?.address);
    const key = comparisonKey(name);
    const errors = [];

    if (!name) errors.push("NAME_REQUIRED");
    else if (name.length > MAX_NAME_LENGTH) errors.push("NAME_TOO_LONG");
    if (!address) errors.push("ADDRESS_REQUIRED");
    else if (address.length > MAX_ADDRESS_LENGTH) errors.push("ADDRESS_TOO_LONG");

    if (name) {
      // First occurrence wins, matching how duplicate units are flagged.
      if (seen.has(key)) errors.push("DUPLICATE_IN_BATCH");
      // A name the landlord already uses is refused rather than merged into.
      // Silently folding 40 imported units into an existing property is the
      // kind of surprise that is only discovered after the fact; the review
      // table lets them drop the row and import those units on their own.
      if (existing.has(key)) errors.push("ALREADY_EXISTS");
      seen.add(key);
    }

    // Units are scoped to this property, so each property's batch is validated
    // against its own names only — "101" in Maple and "101" in Oak are fine.
    const units = validateUnitBatch(entry?.units || []);
    if (units.summary.total === 0) errors.push("NO_UNITS");

    return {
      index,
      name,
      address,
      valid: errors.length === 0 && units.valid,
      errors: errors.map((code) => ({ code, message: ERROR_MESSAGES[code] })),
      units,
    };
  });

  const hasError = (code) => (property) => property.errors.some((error) => error.code === code);
  const totalUnits = properties.reduce((sum, property) => sum + property.units.summary.total, 0);

  const summary = {
    properties: properties.length,
    units: totalUnits,
    validProperties: properties.filter((property) => property.valid).length,
    invalidProperties: properties.filter((property) => !property.valid).length,
    duplicateProperties: properties.filter(hasError("DUPLICATE_IN_BATCH")).length,
    existingProperties: properties.filter(hasError("ALREADY_EXISTS")).length,
    invalidUnits: properties.reduce((sum, property) => sum + property.units.summary.invalid, 0),
    duplicateUnits: properties.reduce((sum, property) => sum + property.units.summary.duplicates, 0),
  };

  return {
    properties,
    summary,
    valid: summary.invalidProperties === 0 && summary.properties > 0,
  };
}

/**
 * Size guard, run before validation so a wildly oversized payload is rejected
 * on its shape rather than after the work of checking every row.
 */
function checkPortfolioSize(proposed) {
  if (!Array.isArray(proposed) || proposed.length === 0) {
    return "properties must be a non-empty array";
  }
  if (proposed.length > MAX_PROPERTIES) {
    return `An import may contain at most ${MAX_PROPERTIES} properties (received ${proposed.length})`;
  }
  const units = proposed.reduce(
    (sum, property) => sum + (Array.isArray(property?.units) ? property.units.length : 0),
    0
  );
  if (units > MAX_UNITS) {
    return `An import may contain at most ${MAX_UNITS} units (received ${units})`;
  }
  return null;
}

module.exports = {
  MAX_PROPERTIES,
  MAX_UNITS,
  MAX_NAME_LENGTH,
  MAX_ADDRESS_LENGTH,
  ERROR_MESSAGES,
  validatePortfolioBatch,
  checkPortfolioSize,
};
