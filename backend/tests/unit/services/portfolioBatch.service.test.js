// Portfolio validation.
//
// The one structural claim worth pinning: a unit inside a portfolio import
// obeys exactly the rules a unit inside a single-property import obeys, because
// this module calls that validator rather than restating it. Everything else
// here is the property layer on top.

const assert = require("assert");

const {
  MAX_NAME_LENGTH,
  MAX_PROPERTIES,
  MAX_UNITS,
  validatePortfolioBatch,
  checkPortfolioSize,
} = require("../../../services/property/portfolioBatch.service");

const property = (name, address, units) => ({ name, address, units });

/* ===== 1) A clean portfolio passes, and is counted ===== */

{
  const { properties, summary, valid } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["101", "102", "103"]),
    property("Oak Tower", "98 Oak Ave", ["PH1", "PH2"]),
  ]);

  assert.strictEqual(valid, true);
  assert.strictEqual(summary.properties, 2);
  assert.strictEqual(summary.units, 5);
  assert.strictEqual(summary.validProperties, 2);
  assert.strictEqual(properties[1].units.rows[0].name, "PH1");
}

/* ===== 2) Units are scoped to their own property ===== */

{
  // "101" in Maple and "101" in Oak are two different units, and an importer
  // that flattened them into one namespace would reject a completely normal file.
  const { valid, summary } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["101", "102"]),
    property("Oak Tower", "98 Oak Ave", ["101", "102"]),
  ]);
  assert.strictEqual(valid, true);
  assert.strictEqual(summary.duplicateUnits, 0);
}

{
  // But a duplicate WITHIN one property is still a duplicate.
  const { valid, summary, properties } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["101", "101"]),
  ]);
  assert.strictEqual(valid, false);
  assert.strictEqual(summary.duplicateUnits, 1);
  assert.strictEqual(properties[0].units.rows[1].errors[0].code, "DUPLICATE_IN_BATCH");
}

{
  // And the unit rules themselves are the unit validator's, not a second copy:
  // case folding, whitespace collapsing and empties all behave identically.
  const { properties } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["A1", "a1", "  ", "Unit  B"]),
  ]);
  const units = properties[0].units;
  assert.strictEqual(units.summary.duplicates, 1);
  assert.strictEqual(units.summary.empty, 1);
  assert.strictEqual(units.rows[3].name, "Unit B");
}

/* ===== 3) A property needs a name and an address ===== */

{
  const { properties, valid } = validatePortfolioBatch([
    property("", "123 Main St", ["101"]),
    property("Oak Tower", "", ["PH1"]),
  ]);
  assert.strictEqual(valid, false);
  assert.strictEqual(properties[0].errors[0].code, "NAME_REQUIRED");
  assert.strictEqual(properties[1].errors[0].code, "ADDRESS_REQUIRED");
}

{
  const { properties } = validatePortfolioBatch([
    property("x".repeat(MAX_NAME_LENGTH + 1), "123 Main St", ["101"]),
  ]);
  assert.strictEqual(properties[0].errors[0].code, "NAME_TOO_LONG");
}

/* ===== 4) A property with no units is an error, not an empty shell ===== */

{
  // Importing a property that gets no units leaves a building nobody can file a
  // request against — the hierarchy exists to be filled in.
  const { properties, valid } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", []),
  ]);
  assert.strictEqual(valid, false);
  assert.ok(properties[0].errors.some((error) => error.code === "NO_UNITS"));
}

/* ===== 5) Duplicate property names, first occurrence wins ===== */

{
  const { properties, summary } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["101"]),
    property("maple apartments", "456 Other Rd", ["201"]),
  ]);
  assert.strictEqual(summary.duplicateProperties, 1);
  assert.strictEqual(properties[0].valid, true);
  assert.strictEqual(properties[1].valid, false);
  assert.strictEqual(properties[0].name, "Maple Apartments", "casing survives as typed");
}

/* ===== 6) A name the landlord already owns is refused, not merged into ===== */

{
  // Folding 40 imported units into an existing building is a surprise only
  // discovered afterwards. The review table lets them drop the row instead.
  const { properties, summary, valid } = validatePortfolioBatch(
    [property("Maple Apartments", "123 Main St", ["101"])],
    ["Maple Apartments"]
  );
  assert.strictEqual(valid, false);
  assert.strictEqual(summary.existingProperties, 1);
  assert.strictEqual(properties[0].errors[0].code, "ALREADY_EXISTS");
}

{
  // Case-folded against existing names, or the same building imports twice.
  const { summary } = validatePortfolioBatch(
    [property("MAPLE APARTMENTS", "123 Main St", ["101"])],
    ["Maple Apartments"]
  );
  assert.strictEqual(summary.existingProperties, 1);
}

/* ===== 7) One bad property invalidates the import ===== */

{
  const { valid, summary } = validatePortfolioBatch([
    property("Maple Apartments", "123 Main St", ["101", "102"]),
    property("Oak Tower", "98 Oak Ave", ["PH1", "PH1"]),
  ]);
  assert.strictEqual(valid, false, "a bad unit in one property blocks the whole import");
  assert.strictEqual(summary.invalidProperties, 1);
  assert.strictEqual(summary.validProperties, 1);
  assert.strictEqual(summary.units, 4, "counts still describe what was proposed");
}

/* ===== 8) An empty portfolio is not valid ===== */

{
  assert.strictEqual(validatePortfolioBatch([]).valid, false);
  assert.strictEqual(validatePortfolioBatch(null).valid, false);
}

/* ===== 9) Size guards run on shape, before the work of validating ===== */

assert.match(checkPortfolioSize([]), /non-empty/);
assert.match(checkPortfolioSize("nope"), /non-empty/);
assert.strictEqual(checkPortfolioSize([property("A", "1 St", ["1"])]), null);

{
  const tooMany = Array.from({ length: MAX_PROPERTIES + 1 }, (_, i) =>
    property(`P${i}`, "1 St", ["1"])
  );
  assert.match(checkPortfolioSize(tooMany), new RegExp(`at most ${MAX_PROPERTIES} properties`));
}

{
  const heavy = [property("Big", "1 St", Array.from({ length: MAX_UNITS + 1 }, (_, i) => `u${i}`))];
  assert.match(checkPortfolioSize(heavy), new RegExp(`at most ${MAX_UNITS} units`));
}

console.log("portfolioBatch.service tests passed");
