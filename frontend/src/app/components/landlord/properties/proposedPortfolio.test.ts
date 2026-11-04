// Grouping a flat file into a portfolio, and deciding whether it can be created.
//
// Deliberately the same cases as
// backend/tests/unit/services/portfolioBatch.service.test.js — these rules live
// in two places so the landlord gets an answer as they edit, and that is only
// safe while the two agree.

import { describe, expect, it } from 'vitest';
import { parseUnitFile } from '../units/unitFileParser';
import {
  existingPropertyNames,
  groupImportedRows,
  reviewProposedPortfolio,
  toImportPayload,
  type ProposedProperty,
} from './proposedPortfolio';

const PORTFOLIO_CSV = [
  'Property Name,Address,Unit',
  'Maple Apartments,123 Main St,101',
  'Maple Apartments,123 Main St,102',
  'Maple Apartments,123 Main St,103',
  'Oak Tower,98 Oak Ave,PH1',
  'Oak Tower,98 Oak Ave,PH2',
].join('\n');

const group = (csv: string) => groupImportedRows(parseUnitFile(csv).rows);

const proposed = (
  name: string,
  address: string,
  units: string[]
): ProposedProperty => ({
  id: `p-${name}`,
  name,
  address,
  units: units.map((unit, index) => ({ id: `${name}-${index}`, name: unit })),
});

describe('grouping', () => {
  it('turns one row per unit into one entry per property', () => {
    const groups = group(PORTFOLIO_CSV);
    expect(groups).toHaveLength(2);
    expect(groups[0].name).toBe('Maple Apartments');
    expect(groups[0].address).toBe('123 Main St');
    expect(groups[0].units.map((unit) => unit.name)).toEqual(['101', '102', '103']);
    expect(groups[1].units.map((unit) => unit.name)).toEqual(['PH1', 'PH2']);
  });

  it('keeps properties in the order the file first mentions them', () => {
    const groups = group(
      ['Property,Address,Unit', 'Oak,1 St,1', 'Maple,2 St,1', 'Oak,1 St,2'].join('\n')
    );
    expect(groups.map((entry) => entry.name)).toEqual(['Oak', 'Maple']);
    expect(groups[0].units).toHaveLength(2);
  });

  it('treats a case difference as the same building', () => {
    // A spreadsheet saying "Maple Apartments" then "maple apartments" means one
    // building, and the first spelling is the one the landlord wrote.
    const groups = group(
      ['Property,Address,Unit', 'Maple Apartments,1 St,101', 'maple apartments,1 St,102'].join('\n')
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Maple Apartments');
    expect(groups[0].units).toHaveLength(2);
  });

  it('fills in an address from a later row when the first one is blank', () => {
    const groups = group(['Property,Address,Unit', 'Maple,,101', 'Maple,123 Main St,102'].join('\n'));
    expect(groups[0].address).toBe('123 Main St');
  });

  it('gives every property and unit a distinct row key', () => {
    const groups = group(PORTFOLIO_CSV);
    const ids = [...groups.map((entry) => entry.id), ...groups.flatMap((entry) => entry.units.map((u) => u.id))];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('review', () => {
  it('accepts a clean portfolio and counts it', () => {
    const { summary, valid } = reviewProposedPortfolio(group(PORTFOLIO_CSV));
    expect(valid).toBe(true);
    expect(summary.properties).toBe(2);
    expect(summary.units).toBe(5);
  });

  it('scopes units to their own property', () => {
    // "101" in Maple and "101" in Oak are two units, not a collision.
    const { valid, summary } = reviewProposedPortfolio([
      proposed('Maple', '1 St', ['101', '102']),
      proposed('Oak', '2 St', ['101', '102']),
    ]);
    expect(valid).toBe(true);
    expect(summary.duplicateUnits).toBe(0);
  });

  it('still catches a duplicate within one property', () => {
    const { valid, summary, properties } = reviewProposedPortfolio([
      proposed('Maple', '1 St', ['101', '101']),
    ]);
    expect(valid).toBe(false);
    expect(summary.duplicateUnits).toBe(1);
    expect(properties[0].unitReview.rows[1].errors[0].code).toBe('DUPLICATE_IN_BATCH');
  });

  it('requires a name and an address', () => {
    const { properties, valid } = reviewProposedPortfolio([
      proposed('', '1 St', ['101']),
      proposed('Oak', '', ['PH1']),
    ]);
    expect(valid).toBe(false);
    expect(properties[0].errors[0].code).toBe('NAME_REQUIRED');
    expect(properties[1].errors[0].code).toBe('ADDRESS_REQUIRED');
  });

  it('refuses a property with no units', () => {
    const { properties, valid } = reviewProposedPortfolio([proposed('Maple', '1 St', [])]);
    expect(valid).toBe(false);
    expect(properties[0].errors.some((error) => error.code === 'NO_UNITS')).toBe(true);
  });

  it('flags a duplicate property name, keeping the first', () => {
    const { properties, summary } = reviewProposedPortfolio([
      proposed('Maple', '1 St', ['101']),
      proposed('maple', '2 St', ['201']),
    ]);
    expect(summary.duplicateProperties).toBe(1);
    expect(properties[0].valid).toBe(true);
    expect(properties[1].valid).toBe(false);
  });

  it('refuses a name the landlord already owns rather than merging into it', () => {
    const { properties, summary, valid } = reviewProposedPortfolio(
      [proposed('MAPLE APARTMENTS', '1 St', ['101'])],
      ['Maple Apartments']
    );
    expect(valid).toBe(false);
    expect(summary.existingProperties).toBe(1);
    expect(properties[0].errors[0].code).toBe('ALREADY_EXISTS');
  });

  it('lets one bad property block the whole import', () => {
    const { valid, summary } = reviewProposedPortfolio([
      proposed('Maple', '1 St', ['101']),
      proposed('Oak', '2 St', ['PH1', 'PH1']),
    ]);
    expect(valid).toBe(false);
    expect(summary.invalidProperties).toBe(1);
    expect(summary.validProperties).toBe(1);
    expect(summary.units).toBe(3);
  });

  it('does not call an empty portfolio valid', () => {
    expect(reviewProposedPortfolio([]).valid).toBe(false);
  });

  it('reads existing names off the landlord’s properties', () => {
    expect(existingPropertyNames([{ _id: 'p1', name: 'Maple', address: '1 St' }])).toEqual(['Maple']);
    expect(existingPropertyNames(undefined)).toEqual([]);
  });
});

describe('payload', () => {
  it('normalizes on the way out, without touching capitalization', () => {
    const payload = toImportPayload([proposed('  Maple  Apartments ', ' 123  Main St ', [' ph1 '])]);
    expect(payload).toEqual([
      { name: 'Maple Apartments', address: '123 Main St', units: [{ name: 'ph1' }] },
    ]);
  });

  it('round-trips a parsed file into the shape the endpoint takes', () => {
    const payload = toImportPayload(group(PORTFOLIO_CSV));
    expect(payload).toHaveLength(2);
    expect(payload[1]).toEqual({
      name: 'Oak Tower',
      address: '98 Oak Ave',
      units: [{ name: 'PH1' }, { name: 'PH2' }],
    });
  });
});
