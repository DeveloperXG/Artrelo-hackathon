import type { PortfolioErrorCode, Property } from '../../../types/landlord';
import type { ImportedRow } from '../units/unitFileParser';
import {
  comparisonKey,
  nextRowId,
  normalizeIdentifier,
  reviewProposedUnits,
  toProposedUnits,
  type ProposedUnit,
  type ReviewResult,
} from '../units/proposedUnits';

/**
 * Turning a flat file into a portfolio, and deciding whether it can be created.
 *
 * The file the landlord has is one row per unit, repeating the property on each
 * one. What they mean is a handful of buildings. Grouping is the whole job of
 * the first half of this file; the second half is the same validation shape the
 * units pipeline uses, one level up, and it delegates the unit rules to that
 * pipeline rather than restating them.
 */
export interface ProposedProperty {
  id: string;
  name: string;
  address: string;
  units: ProposedUnit[];
}

export interface ReviewedProperty extends ProposedProperty {
  index: number;
  valid: boolean;
  errors: { code: PortfolioErrorCode; message: string }[];
  unitReview: ReviewResult;
}

export interface PortfolioReviewResult {
  properties: ReviewedProperty[];
  summary: {
    properties: number;
    units: number;
    validProperties: number;
    invalidProperties: number;
    duplicateProperties: number;
    existingProperties: number;
    invalidUnits: number;
    duplicateUnits: number;
  };
  valid: boolean;
}

/** Kept in step with services/property/portfolioBatch.service.js. */
const MAX_NAME_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 240;

const ERROR_MESSAGES: Record<PortfolioErrorCode, string> = {
  NAME_REQUIRED: 'Property name is required',
  ADDRESS_REQUIRED: 'Property address is required',
  NAME_TOO_LONG: `Property name must be ${MAX_NAME_LENGTH} characters or fewer`,
  ADDRESS_TOO_LONG: `Property address must be ${MAX_ADDRESS_LENGTH} characters or fewer`,
  DUPLICATE_IN_BATCH: 'Duplicate of another property in this batch',
  ALREADY_EXISTS: 'You already have a property with this name',
  NO_UNITS: 'This property has no units',
};

/**
 * Group one-row-per-unit into one entry per property, in first-seen order.
 *
 * Rows are matched on a case-folded name, because a spreadsheet that says
 * "Maple Apartments" on one row and "maple apartments" on the next means one
 * building. The first spelling and the first non-empty address win, so the
 * grouped record looks like what the landlord actually wrote first rather than
 * whatever happened to be last.
 *
 * Rows with no property name at all fall into one unnamed group, which the
 * review will flag rather than silently discard.
 */
export function groupImportedRows(rows: ImportedRow[]): ProposedProperty[] {
  const byKey = new Map<string, ProposedProperty>();

  for (const row of rows) {
    const name = normalizeIdentifier(row.propertyName || '');
    const key = comparisonKey(name);
    let group = byKey.get(key);
    if (!group) {
      group = { id: nextRowId(), name, address: normalizeIdentifier(row.propertyAddress || ''), units: [] };
      byKey.set(key, group);
    } else if (!group.address && row.propertyAddress) {
      group.address = normalizeIdentifier(row.propertyAddress);
    }
    group.units.push(...toProposedUnits([row.unit]));
  }

  return [...byKey.values()];
}

/** The property names a landlord already owns, for the collision check. */
export function existingPropertyNames(properties: Property[] | undefined): string[] {
  return (properties || []).map((property) => property.name);
}

/**
 * Validate the whole portfolio.
 *
 * Units are scoped to their own property: "101" in Maple and "101" in Oak are
 * two different units, and checking them in one namespace would reject an
 * entirely ordinary file.
 */
export function reviewProposedPortfolio(
  proposed: ProposedProperty[],
  existingNames: Iterable<string> = []
): PortfolioReviewResult {
  const existing = new Set<string>();
  for (const name of existingNames) {
    const key = comparisonKey(name);
    if (key) existing.add(key);
  }

  const seen = new Set<string>();
  const properties: ReviewedProperty[] = proposed.map((entry, index) => {
    const name = normalizeIdentifier(entry.name);
    const address = normalizeIdentifier(entry.address);
    const key = comparisonKey(name);
    const codes: PortfolioErrorCode[] = [];

    if (!name) codes.push('NAME_REQUIRED');
    else if (name.length > MAX_NAME_LENGTH) codes.push('NAME_TOO_LONG');
    if (!address) codes.push('ADDRESS_REQUIRED');
    else if (address.length > MAX_ADDRESS_LENGTH) codes.push('ADDRESS_TOO_LONG');

    if (name) {
      if (seen.has(key)) codes.push('DUPLICATE_IN_BATCH');
      if (existing.has(key)) codes.push('ALREADY_EXISTS');
      seen.add(key);
    }

    const unitReview = reviewProposedUnits(entry.units);
    if (unitReview.summary.total === 0) codes.push('NO_UNITS');

    return {
      ...entry,
      index,
      valid: codes.length === 0 && unitReview.valid,
      errors: codes.map((code) => ({ code, message: ERROR_MESSAGES[code] })),
      unitReview,
    };
  });

  const hasError = (code: PortfolioErrorCode) => (property: ReviewedProperty) =>
    property.errors.some((error) => error.code === code);

  const summary = {
    properties: properties.length,
    units: properties.reduce((sum, property) => sum + property.unitReview.summary.total, 0),
    validProperties: properties.filter((property) => property.valid).length,
    invalidProperties: properties.filter((property) => !property.valid).length,
    duplicateProperties: properties.filter(hasError('DUPLICATE_IN_BATCH')).length,
    existingProperties: properties.filter(hasError('ALREADY_EXISTS')).length,
    invalidUnits: properties.reduce((sum, property) => sum + property.unitReview.summary.invalid, 0),
    duplicateUnits: properties.reduce(
      (sum, property) => sum + property.unitReview.summary.duplicates,
      0
    ),
  };

  return {
    properties,
    summary,
    valid: summary.invalidProperties === 0 && summary.properties > 0,
  };
}

/** The payload shape the bulk endpoint takes. */
export function toImportPayload(properties: ProposedProperty[]) {
  return properties.map((property) => ({
    name: normalizeIdentifier(property.name),
    address: normalizeIdentifier(property.address),
    units: property.units.map((unit) => ({ name: normalizeIdentifier(unit.name) })),
  }));
}

export { MAX_NAME_LENGTH, MAX_ADDRESS_LENGTH };
