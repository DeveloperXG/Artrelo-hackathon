import type { PropertyUnit, UnitBatchErrorCode, UnitBatchSummary } from '../../../types/landlord';

/**
 * The single shape every unit-creation method produces.
 *
 * "Add one", the pattern generator, the paste box, the CSV importer and — one
 * day — an AI parser all differ only in how they arrive at a list of these.
 * From here on the pipeline is identical: review, validate, confirm, create.
 * A new input method's whole job is to return ProposedUnit[]; it never gets to
 * bring its own review table or its own idea of what is valid.
 *
 * `id` is a client-side row key so the review table can reorder, edit and
 * delete rows without React losing track of which row is which. It has nothing
 * to do with the database id a created unit eventually gets.
 */
export interface ProposedUnit {
  id: string;
  name: string;
}

export interface ProposedUnitIssue {
  code: UnitBatchErrorCode;
  message: string;
}

/** A proposed unit with the verdict on it. What the review table renders. */
export interface ReviewedUnit extends ProposedUnit {
  /** Position in the proposal, so a row can be named in an error or a label. */
  index: number;
  valid: boolean;
  errors: ProposedUnitIssue[];
}

export interface ReviewResult {
  rows: ReviewedUnit[];
  summary: UnitBatchSummary;
  valid: boolean;
}

/**
 * Kept in step with services/property/unitBatch.service.js on the server.
 *
 * The duplication is deliberate and one-directional: the client validates to
 * give the landlord an answer as they type, and the server validates because it
 * is the only place a guarantee can actually live. If the two ever disagree the
 * server wins — a batch that passes here and fails there comes back as a 422
 * with per-row detail, which the review table renders in place of these.
 */
const MAX_IDENTIFIER_LENGTH = 64;

const ERROR_MESSAGES: Record<UnitBatchErrorCode, string> = {
  EMPTY: 'Unit identifier is required',
  TOO_LONG: `Unit identifier must be ${MAX_IDENTIFIER_LENGTH} characters or fewer`,
  DUPLICATE_IN_BATCH: 'Duplicate of another unit in this batch',
  ALREADY_EXISTS: 'This property already has a unit with this identifier',
};

let rowCounter = 0;

/** A fresh row key. Monotonic, so it never collides with a row still on screen. */
export function nextRowId(): string {
  rowCounter += 1;
  return `proposed-${rowCounter}`;
}

export function toProposedUnits(names: string[]): ProposedUnit[] {
  return names.map((name) => ({ id: nextRowId(), name }));
}

/**
 * Collapse the incidental whitespace a paste or a spreadsheet cell drags along,
 * and nothing else. Capitalization is the landlord's naming scheme — "PH1",
 * "ph1" and "Retail-A" are choices, not typos.
 */
export function normalizeIdentifier(raw: string): string {
  // \s covers the U+00A0 non-breaking spaces a spreadsheet cell drags along,
  // so a value pasted out of Excel and the same value typed by hand are one unit.
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The key two identifiers are compared under. Case-folded: nobody maintains
 * "a1" and "A1" as separate units, so treating them as distinct is how an
 * import quietly creates a second copy of a unit that already exists.
 */
export function comparisonKey(identifier: string): string {
  return normalizeIdentifier(identifier).toLocaleLowerCase();
}

/**
 * Validate the whole proposal at once.
 *
 * @param proposed rows in the order the review table shows them
 * @param existing identifiers the destination property already holds
 */
export function reviewProposedUnits(
  proposed: ProposedUnit[],
  existing: Iterable<string> = []
): ReviewResult {
  const existingKeys = new Set<string>();
  for (const identifier of existing) {
    const key = comparisonKey(identifier);
    if (key) existingKeys.add(key);
  }

  // First occurrence wins, so row 7 is flagged as the copy of row 2 rather than
  // both being marked and the landlord left to guess which one to delete.
  const seen = new Set<string>();
  const rows: ReviewedUnit[] = proposed.map((row, index) => {
    const name = normalizeIdentifier(row.name);
    const key = comparisonKey(name);
    const codes: UnitBatchErrorCode[] = [];

    if (!name) {
      codes.push('EMPTY');
    } else if (name.length > MAX_IDENTIFIER_LENGTH) {
      codes.push('TOO_LONG');
    } else {
      if (seen.has(key)) codes.push('DUPLICATE_IN_BATCH');
      if (existingKeys.has(key)) codes.push('ALREADY_EXISTS');
      seen.add(key);
    }

    return {
      ...row,
      index,
      valid: codes.length === 0,
      errors: codes.map((code) => ({ code, message: ERROR_MESSAGES[code] })),
    };
  });

  const has = (code: UnitBatchErrorCode) => (row: ReviewedUnit) =>
    row.errors.some((error) => error.code === code);

  const summary: UnitBatchSummary = {
    total: rows.length,
    valid: rows.filter((row) => row.valid).length,
    invalid: rows.filter((row) => !row.valid).length,
    empty: rows.filter(has('EMPTY')).length,
    tooLong: rows.filter(has('TOO_LONG')).length,
    duplicates: rows.filter(has('DUPLICATE_IN_BATCH')).length,
    collisions: rows.filter(has('ALREADY_EXISTS')).length,
  };

  return { rows, summary, valid: summary.invalid === 0 && summary.total > 0 };
}

/** The identifiers a property already holds, for the collision check. */
export function existingIdentifiers(units: PropertyUnit[] | undefined): string[] {
  return (units || []).map((unit) => unit.unitNumber);
}

export { MAX_IDENTIFIER_LENGTH };
