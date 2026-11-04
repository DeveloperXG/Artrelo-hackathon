// Reading a landlord's spreadsheet export.
//
// The failure this file guards against is a quiet one: an import that reads the
// wrong column, or splits an address in half, and lands 400 wrong unit names in
// a property. Every case here is a shape a real export actually takes.

import { describe, expect, it } from 'vitest';
import { parseDelimited, parseUnitFile } from './unitFileParser';

describe('delimited parsing', () => {
  it('reads a plain comma file', () => {
    expect(parseDelimited('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('survives CRLF', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a quoted comma inside its cell', () => {
    // Splitting naively here is how half an address ends up as a unit name.
    expect(parseDelimited('Maple,"123 Main St, Apt 4",101')).toEqual([
      ['Maple', '123 Main St, Apt 4', '101'],
    ]);
  });

  it('unescapes a doubled quote', () => {
    expect(parseDelimited('"He said ""hi""",2')).toEqual([['He said "hi"', '2']]);
  });

  it('detects tab and semicolon files', () => {
    expect(parseDelimited('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not let a quoted comma win the delimiter vote', () => {
    expect(parseDelimited('"Oak Tower, West";PH1')).toEqual([['Oak Tower, West', 'PH1']]);
  });

  it('strips the byte order mark Excel writes', () => {
    expect(parseDelimited('﻿unit\n101')).toEqual([['unit'], ['101']]);
  });

  it('drops entirely blank lines', () => {
    expect(parseDelimited('101\n\n102\n')).toEqual([['101'], ['102']]);
  });
});

describe('unit files', () => {
  it('reads the minimal file from the brief', () => {
    const { rows, error } = parseUnitFile('unit\n101\n102\n103\nPH1\nPH2');
    expect(error).toBeUndefined();
    expect(rows.map((row) => row.unit)).toEqual(['101', '102', '103', 'PH1', 'PH2']);
  });

  it('reads a bare list with no header at all', () => {
    const { rows, columns } = parseUnitFile('A1\nA2\nPH1');
    expect(columns).toEqual([]);
    expect(rows.map((row) => row.unit)).toEqual(['A1', 'A2', 'PH1']);
  });

  it('matches the unit column by name, wherever it sits', () => {
    const { rows } = parseUnitFile('Property,Unit Number,Notes\nMaple,101,x\nMaple,102,y');
    expect(rows.map((row) => row.unit)).toEqual(['101', '102']);
  });

  it('is not fussy about header case or spacing', () => {
    const { rows } = parseUnitFile('  UNIT  \n101');
    expect(rows.map((row) => row.unit)).toEqual(['101']);
  });

  it('keeps identifiers exactly as written', () => {
    const { rows } = parseUnitFile('unit\n G01 \nph1\nRetail-A');
    expect(rows.map((row) => row.unit)).toEqual(['G01', 'ph1', 'Retail-A']);
  });

  it('skips rows with a blank unit cell', () => {
    const { rows } = parseUnitFile('unit\n101\n\n102');
    expect(rows.map((row) => row.unit)).toEqual(['101', '102']);
  });

  it('says which columns it found when there is no unit column', () => {
    const { rows, error } = parseUnitFile('Property,Address\nMaple,123 Main St');
    expect(rows).toEqual([]);
    expect(error).toMatch(/No unit column/);
    expect(error).toMatch(/Property, Address/);
  });

  it('reports an empty file rather than an empty success', () => {
    expect(parseUnitFile('').error).toBeTruthy();
    expect(parseUnitFile('unit\n').error).toMatch(/no unit rows/);
  });

  it('warns rather than guessing silently on a headerless multi-column file', () => {
    const { rows, warnings } = parseUnitFile('101,occupied\n102,vacant');
    expect(rows.map((row) => row.unit)).toEqual(['101', '102']);
    expect(warnings[0]).toMatch(/first column/);
  });
});

describe('portfolio shape', () => {
  // The same parse serves "400 units into one property" and "twelve properties
  // and their 438 units". Only the grouping afterwards differs.
  const portfolio = [
    'Property Name,Address,Unit',
    'Maple Apartments,123 Main St,101',
    'Maple Apartments,123 Main St,102',
    'Oak Tower,98 Oak Ave,PH1',
    'Oak Tower,98 Oak Ave,PH2',
  ].join('\n');

  it('carries the property name and address on each row', () => {
    const { rows, hasPropertyColumn } = parseUnitFile(portfolio);
    expect(hasPropertyColumn).toBe(true);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      unit: '101',
      propertyName: 'Maple Apartments',
      propertyAddress: '123 Main St',
    });
    expect(rows[3].propertyName).toBe('Oak Tower');
  });

  it('groups cleanly by property name', () => {
    const { rows } = parseUnitFile(portfolio);
    const byProperty = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.propertyName || '';
      byProperty.set(key, [...(byProperty.get(key) || []), row.unit]);
    }
    expect([...byProperty.keys()]).toEqual(['Maple Apartments', 'Oak Tower']);
    expect(byProperty.get('Oak Tower')).toEqual(['PH1', 'PH2']);
  });

  it('does not claim a property column when the cells are empty', () => {
    const { hasPropertyColumn } = parseUnitFile('Property,Unit\n,101\n,102');
    expect(hasPropertyColumn).toBe(false);
  });
});
