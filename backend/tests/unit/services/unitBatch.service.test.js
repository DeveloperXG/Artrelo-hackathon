// The rules every bulk unit path is funnelled through.
//
// The point of this module is that the generator, the paste box and the CSV
// importer cannot disagree about what a valid unit identifier is. So these
// tests pin the rules themselves, not any one input method.

const assert = require("assert");

const {
  MAX_IDENTIFIER_LENGTH,
  normalizeIdentifier,
  comparisonKey,
  validateUnitBatch,
} = require("../../../services/property/unitBatch.service");

/* ===== 1) Normalization touches whitespace and nothing else ===== */

assert.strictEqual(normalizeIdentifier("  101  "), "101");
assert.strictEqual(normalizeIdentifier("Unit   A"), "Unit A", "runs of spaces collapse to one");
assert.strictEqual(normalizeIdentifier("Retail\u00a0A"), "Retail A", "Excel's nbsp is still a space");
assert.strictEqual(normalizeIdentifier("\tPH1\n"), "PH1");
assert.strictEqual(normalizeIdentifier(null), "");
assert.strictEqual(normalizeIdentifier(undefined), "");

// Capitalization is the landlord's naming scheme, not a typo to fix.
assert.strictEqual(normalizeIdentifier("ph1"), "ph1");
assert.strictEqual(normalizeIdentifier("Unit-A"), "Unit-A");
assert.strictEqual(normalizeIdentifier("G01"), "G01", "leading zeros survive");

/* ===== 2) Comparison folds case; storage does not ===== */

assert.strictEqual(comparisonKey("A1"), comparisonKey("a1"));
assert.notStrictEqual(comparisonKey("A1"), comparisonKey("A2"));

{
  // Nobody keeps "a1" and "A1" as two separate units, so a batch proposing both
  // is proposing the same unit twice — and the surviving row keeps its casing.
  const { rows, summary } = validateUnitBatch(["A1", "a1"]);
  assert.strictEqual(summary.duplicates, 1);
  assert.strictEqual(rows[0].valid, true);
  assert.strictEqual(rows[0].name, "A1", "the kept row is stored exactly as typed");
  assert.strictEqual(rows[1].valid, false);
}

/* ===== 3) A clean batch passes, in order, unchanged ===== */

{
  const { rows, summary, valid } = validateUnitBatch(["101", "102", "PH1", "Retail-A"]);
  assert.strictEqual(valid, true);
  assert.strictEqual(summary.total, 4);
  assert.strictEqual(summary.valid, 4);
  assert.deepStrictEqual(
    rows.map((row) => row.name),
    ["101", "102", "PH1", "Retail-A"],
    "order is preserved so a review table can line results up with its own rows"
  );
  assert.deepStrictEqual(
    rows.map((row) => row.index),
    [0, 1, 2, 3]
  );
}

/* ===== 4) Empty identifiers are an error, never a silently skipped row ===== */

{
  const { rows, summary, valid } = validateUnitBatch(["101", "   ", ""]);
  assert.strictEqual(valid, false);
  assert.strictEqual(summary.empty, 2);
  assert.strictEqual(rows[1].errors[0].code, "EMPTY");
  assert.ok(rows[1].errors[0].message, "errors carry a message the UI can show inline");
}

/* ===== 5) Duplicates: first occurrence wins ===== */

{
  const { rows, summary } = validateUnitBatch(["101", "102", "101", "101"]);
  assert.strictEqual(summary.duplicates, 2, "both copies flagged, the original is not");
  assert.strictEqual(rows[0].valid, true);
  assert.strictEqual(rows[2].valid, false);
  assert.strictEqual(rows[3].valid, false);
  assert.strictEqual(rows[2].errors[0].code, "DUPLICATE_IN_BATCH");
}

{
  // Whitespace differences are not a different unit.
  const { summary } = validateUnitBatch(["Unit A", "Unit  A"]);
  assert.strictEqual(summary.duplicates, 1);
}

/* ===== 6) Collisions with what the property already holds ===== */

{
  const { rows, summary, valid } = validateUnitBatch(["101", "102", "103"], ["102"]);
  assert.strictEqual(valid, false);
  assert.strictEqual(summary.collisions, 1);
  assert.strictEqual(rows[1].errors[0].code, "ALREADY_EXISTS");
  assert.strictEqual(rows[0].valid, true, "the other rows are still fine");
}

{
  // Case-folded against existing units too, or an import quietly doubles them.
  const { summary } = validateUnitBatch(["ph1"], ["PH1"]);
  assert.strictEqual(summary.collisions, 1);
}

{
  // A row can be wrong in two ways at once, and the review table should say so.
  const { rows } = validateUnitBatch(["101", "101"], ["101"]);
  const codes = rows[1].errors.map((error) => error.code);
  assert.deepStrictEqual(codes, ["DUPLICATE_IN_BATCH", "ALREADY_EXISTS"]);
}

/* ===== 7) Length ceiling stops a pasted paragraph becoming a unit ===== */

{
  const long = "x".repeat(MAX_IDENTIFIER_LENGTH + 1);
  const { rows, summary } = validateUnitBatch([long, "x".repeat(MAX_IDENTIFIER_LENGTH)]);
  assert.strictEqual(summary.tooLong, 1);
  assert.strictEqual(rows[0].errors[0].code, "TOO_LONG");
  assert.strictEqual(rows[1].valid, true, "exactly at the limit is allowed");
}

/* ===== 8) Rows may arrive as objects, not just strings ===== */

// The CSV importer and a future AI parser both produce objects with a name,
// and neither should have to flatten to strings first.
{
  const { rows, valid } = validateUnitBatch([{ name: " 201 " }, { unitNumber: "202" }]);
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(rows.map((row) => row.name), ["201", "202"]);
}

/* ===== 9) An empty batch is not "valid" ===== */

{
  const { valid, summary } = validateUnitBatch([]);
  assert.strictEqual(valid, false, "nothing to create is not success");
  assert.strictEqual(summary.total, 0);
}

console.log("unitBatch.service tests passed");
