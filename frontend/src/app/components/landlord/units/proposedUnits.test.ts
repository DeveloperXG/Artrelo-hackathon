// The client half of validation, and the paste parser that feeds it.
//
// These rules exist twice on purpose — here for an answer as the landlord
// types, and on the server because that is the only place a guarantee can
// live. The duplication is only safe while the two agree, so these tests are
// deliberately the same cases as
// backend/tests/unit/services/unitBatch.service.test.js. If one file has to
// change, the other almost certainly does too.

import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_LENGTH,
  comparisonKey,
  existingIdentifiers,
  normalizeIdentifier,
  reviewProposedUnits,
  toProposedUnits,
} from './proposedUnits';
import { parsePastedUnits } from './unitPaste';

describe('normalization', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeIdentifier('  101  ')).toBe('101');
    expect(normalizeIdentifier('Unit   A')).toBe('Unit A');
    expect(normalizeIdentifier('\tPH1\n')).toBe('PH1');
  });

  it('treats a spreadsheet non-breaking space as a space', () => {
    expect(normalizeIdentifier('Retail A')).toBe('Retail A');
  });

  it('leaves the landlord’s own naming alone', () => {
    // Capitalization and leading zeros are choices, not typos.
    expect(normalizeIdentifier('ph1')).toBe('ph1');
    expect(normalizeIdentifier('G01')).toBe('G01');
    expect(normalizeIdentifier('Retail-A')).toBe('Retail-A');
  });
});

describe('comparison', () => {
  it('folds case, because nobody keeps a1 and A1 apart', () => {
    expect(comparisonKey('A1')).toBe(comparisonKey('a1'));
    expect(comparisonKey('A1')).not.toBe(comparisonKey('A2'));
  });
});

describe('review', () => {
  const review = (names: string[], existing: string[] = []) =>
    reviewProposedUnits(toProposedUnits(names), existing);

  it('passes a clean batch and keeps its order', () => {
    const { rows, valid, summary } = review(['101', '102', 'PH1']);
    expect(valid).toBe(true);
    expect(summary.valid).toBe(3);
    expect(rows.map((row) => row.name)).toEqual(['101', '102', 'PH1']);
    expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
  });

  it('flags an empty identifier rather than dropping the row', () => {
    const { rows, summary, valid } = review(['101', '   ']);
    expect(valid).toBe(false);
    expect(summary.empty).toBe(1);
    expect(rows[1].errors[0].code).toBe('EMPTY');
    expect(rows[1].errors[0].message).toBeTruthy();
  });

  it('flags duplicates, keeping the first occurrence', () => {
    const { rows, summary } = review(['101', '102', '101', '101']);
    expect(summary.duplicates).toBe(2);
    expect(rows[0].valid).toBe(true);
    expect(rows[2].valid).toBe(false);
    expect(rows[3].valid).toBe(false);
  });

  it('treats a case difference as the same unit', () => {
    expect(review(['A1', 'a1']).summary.duplicates).toBe(1);
  });

  it('flags collisions with units the property already has', () => {
    const { rows, summary } = review(['101', '102'], ['102']);
    expect(summary.collisions).toBe(1);
    expect(rows[0].valid).toBe(true);
    expect(rows[1].errors[0].code).toBe('ALREADY_EXISTS');
  });

  it('folds case against existing units too', () => {
    expect(review(['ph1'], ['PH1']).summary.collisions).toBe(1);
  });

  it('reports every reason a row is wrong', () => {
    const { rows } = review(['101', '101'], ['101']);
    expect(rows[1].errors.map((error) => error.code)).toEqual([
      'DUPLICATE_IN_BATCH',
      'ALREADY_EXISTS',
    ]);
  });

  it('rejects an identifier past the length ceiling', () => {
    const { rows, summary } = review(['x'.repeat(MAX_IDENTIFIER_LENGTH + 1)]);
    expect(summary.tooLong).toBe(1);
    expect(rows[0].errors[0].code).toBe('TOO_LONG');
  });

  it('does not call an empty proposal valid', () => {
    expect(review([]).valid).toBe(false);
  });

  it('reads existing identifiers off a property', () => {
    expect(existingIdentifiers([{ _id: 'u1', unitNumber: '101' }])).toEqual(['101']);
    expect(existingIdentifiers(undefined)).toEqual([]);
  });

  it('gives every row a stable, distinct key', () => {
    // The review table edits and deletes rows in place; two rows sharing a key
    // is how an edit lands on the wrong line.
    const rows = toProposedUnits(['101', '101', '102']);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  });
});

describe('paste parsing', () => {
  it('splits one name per line', () => {
    expect(parsePastedUnits('A1\nA2\nPH1')).toEqual(['A1', 'A2', 'PH1']);
  });

  it('splits a comma separated list', () => {
    expect(parsePastedUnits('A1, A2, A3, B1')).toEqual(['A1', 'A2', 'A3', 'B1']);
  });

  it('handles a spreadsheet column, tabs and CRLF and all', () => {
    expect(parsePastedUnits('101\r\n102\t103;104')).toEqual(['101', '102', '103', '104']);
  });

  it('drops blank entries instead of proposing empty units', () => {
    // A trailing newline is punctuation, not a unit the landlord meant to add.
    expect(parsePastedUnits('A1\n\nA2\n')).toEqual(['A1', 'A2']);
    expect(parsePastedUnits('A1, , A2')).toEqual(['A1', 'A2']);
    expect(parsePastedUnits('   ')).toEqual([]);
    expect(parsePastedUnits('')).toEqual([]);
  });

  it('preserves each identifier exactly as written', () => {
    expect(parsePastedUnits('  PH1  \n g01 \nRetail-A')).toEqual(['PH1', 'g01', 'Retail-A']);
  });

  it('keeps a name that legitimately contains a space', () => {
    expect(parsePastedUnits('Retail A\nRetail B')).toEqual(['Retail A', 'Retail B']);
  });
});
