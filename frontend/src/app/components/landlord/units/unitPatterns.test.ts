// The generator's whole claim is that it is built from composable rules rather
// than a list of conventions someone guessed at. These tests are that claim,
// written down: every naming scheme in the brief is reproduced here, and none
// of them is a special case in the implementation.

import { describe, expect, it } from 'vitest';
import {
  MAX_GENERATED_UNITS,
  describeSample,
  generateUnits,
  indexToLetter,
  letterToIndex,
} from './unitPatterns';

const sequence = (
  prefix: string,
  from: string,
  to: string,
  suffix = '',
  kind: 'number' | 'letter' = 'number'
) =>
  generateUnits({
    strategy: 'sequence',
    prefix,
    suffix,
    sequence: { kind, from, to },
  });

describe('number ranges', () => {
  it('walks a plain range inclusively', () => {
    const { units } = sequence('', '1', '24');
    expect(units).toHaveLength(24);
    expect(units[0]).toBe('1');
    expect(units[23]).toBe('24');
  });

  it('starts wherever the landlord starts', () => {
    const { units } = sequence('', '101', '120');
    expect(units).toHaveLength(20);
    expect(units[0]).toBe('101');
    expect(units.at(-1)).toBe('120');
  });

  it('creates one unit when start equals end', () => {
    expect(sequence('', '7', '7').units).toEqual(['7']);
  });

  it('takes zero-padding from how the start was written', () => {
    // "01" is the landlord saying two digits, and saying it once.
    expect(sequence('', '01', '12').units.slice(0, 3)).toEqual(['01', '02', '03']);
    expect(sequence('', '1', '12').units.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(sequence('', '001', '10').units.at(-1)).toBe('010');
  });

  it('refuses a range that ends before it starts', () => {
    const { units, error } = sequence('', '20', '4');
    expect(units).toEqual([]);
    expect(error).toMatch(/ends before it starts/);
  });

  it('refuses a range it cannot read', () => {
    expect(sequence('', '', '10').error).toBeTruthy();
    expect(sequence('', 'abc', '10').error).toBeTruthy();
    expect(sequence('', '1.5', '10').error).toMatch(/whole numbers/);
  });
});

describe('prefixes and suffixes', () => {
  it('produces A1 through A10', () => {
    const { units } = sequence('A', '1', '10');
    expect(units).toHaveLength(10);
    expect(units[0]).toBe('A1');
    expect(units.at(-1)).toBe('A10');
  });

  it('produces Unit-1, Unit-2', () => {
    expect(sequence('Unit-', '1', '3').units).toEqual(['Unit-1', 'Unit-2', 'Unit-3']);
  });

  it('produces G01, G02 — prefix and padding compose', () => {
    expect(sequence('G', '01', '03').units).toEqual(['G01', 'G02', 'G03']);
  });

  it('produces PH1, PH2', () => {
    expect(sequence('PH', '1', '2').units).toEqual(['PH1', 'PH2']);
  });

  it('produces 1A, 1B — a letter sequence behind a numeric prefix', () => {
    // The mirror image of A1..A10, and not a second code path.
    expect(sequence('1', 'A', 'C', '', 'letter').units).toEqual(['1A', '1B', '1C']);
  });

  it('appends a suffix', () => {
    expect(sequence('', '1', '3', '-Rear').units).toEqual(['1-Rear', '2-Rear', '3-Rear']);
  });

  it('keeps the prefix exactly as typed', () => {
    expect(sequence('ph', '1', '1').units).toEqual(['ph1']);
    expect(sequence('Retail-', 'A', 'B', '', 'letter').units).toEqual(['Retail-A', 'Retail-B']);
  });
});

describe('letter sequences', () => {
  it('maps letters to positions and back', () => {
    expect(letterToIndex('A')).toBe(1);
    expect(letterToIndex('Z')).toBe(26);
    expect(letterToIndex('AA')).toBe(27);
    expect(indexToLetter(1)).toBe('A');
    expect(indexToLetter(26)).toBe('Z');
    expect(indexToLetter(27)).toBe('AA');
  });

  it('carries past Z instead of stopping there', () => {
    const { units } = sequence('', 'Y', 'AB', '', 'letter');
    expect(units).toEqual(['Y', 'Z', 'AA', 'AB']);
  });

  it('is case-insensitive about the bounds it is given', () => {
    expect(sequence('', 'a', 'c', '', 'letter').units).toEqual(['A', 'B', 'C']);
  });

  it('refuses bounds that are not letters', () => {
    expect(sequence('', '1', 'C', '', 'letter').error).toBeTruthy();
  });
});

describe('floor patterns', () => {
  const floors = (
    from: string,
    to: string,
    unitsPerFloor: number,
    unitFrom: string,
    separator = ''
  ) =>
    generateUnits({
      strategy: 'floors',
      prefix: '',
      suffix: '',
      floors: { kind: 'number', from, to },
      unitsPerFloor,
      unitFrom,
      separator,
    });

  it('produces 101..806 for eight floors of six', () => {
    const { units } = floors('1', '8', 6, '01');
    expect(units).toHaveLength(48);
    expect(units.slice(0, 6)).toEqual(['101', '102', '103', '104', '105', '106']);
    expect(units.slice(6, 8)).toEqual(['201', '202']);
    expect(units.at(-1)).toBe('806');
  });

  it('pads the unit index independently of the floor', () => {
    // Floor 12 with unit index 03 is 1203 — the floor is not padded, the unit is.
    const { units } = floors('12', '12', 3, '03');
    expect(units).toEqual(['1203', '1204', '1205']);
  });

  it('honours an explicit separator', () => {
    expect(floors('1', '2', 2, '1', '-').units).toEqual(['1-1', '1-2', '2-1', '2-2']);
  });

  it('leaves the unit index unpadded when written unpadded', () => {
    expect(floors('1', '2', 2, '1').units).toEqual(['11', '12', '21', '22']);
  });

  it('can start units at any index', () => {
    expect(floors('3', '3', 3, '05').units).toEqual(['305', '306', '307']);
  });

  it('refuses a floor count it cannot read', () => {
    expect(floors('', '8', 6, '01').error).toBeTruthy();
    expect(floors('1', '8', 0, '01').error).toMatch(/how many units/);
    expect(floors('8', '1', 6, '01').error).toMatch(/ends before it starts/);
    expect(floors('1', '8', 6, 'x').error).toMatch(/whole number/);
  });
});

describe('limits', () => {
  it('refuses a sequence larger than a batch may be', () => {
    const { units, error } = sequence('', '1', String(MAX_GENERATED_UNITS + 1));
    expect(units).toEqual([]);
    expect(error).toMatch(new RegExp(String(MAX_GENERATED_UNITS)));
  });

  it('refuses a floor pattern larger than a batch may be', () => {
    // A typo in the floor count is the realistic way to reach this.
    const { units, error } = generateUnits({
      strategy: 'floors',
      prefix: '',
      suffix: '',
      floors: { kind: 'number', from: '1', to: '9999' },
      unitsPerFloor: 6,
      unitFrom: '01',
      separator: '',
    });
    expect(units).toEqual([]);
    expect(error).toBeTruthy();
  });

  it('allows exactly the maximum', () => {
    expect(sequence('', '1', String(MAX_GENERATED_UNITS)).units).toHaveLength(MAX_GENERATED_UNITS);
  });

  it('never returns a partial list beside an error', () => {
    const { units, error } = sequence('', '20', '4');
    expect(error).toBeTruthy();
    expect(units).toEqual([]);
  });
});

describe('preview text', () => {
  it('shows the whole list when it is short', () => {
    expect(describeSample(['1', '2', '3'])).toBe('1, 2, 3');
  });

  it('shows the head and the last item when it is long', () => {
    const { units } = generateUnits({
      strategy: 'sequence',
      prefix: '',
      suffix: '',
      sequence: { kind: 'number', from: '1', to: '24' },
    });
    const sample = describeSample(units);
    expect(sample.startsWith('1, 2, 3, 4, 5, 6')).toBe(true);
    expect(sample.endsWith('24')).toBe(true);
  });

  it('says nothing when there is nothing', () => {
    expect(describeSample([])).toBe('');
  });
});
