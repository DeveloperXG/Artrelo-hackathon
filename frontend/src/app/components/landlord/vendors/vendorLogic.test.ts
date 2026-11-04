import { describe, expect, it } from 'vitest';
import type { VendorItem } from '../../../types/landlord';
import {
  EMPTY_FILTERS,
  averageResponseMinutes,
  filterVendors,
  formatMinutes,
  hasActiveFilters,
  missingDetails,
  sortVendors,
  specialtyCounts,
  tradeCoverage,
  vendorTags,
} from './vendorFilters';
import { expandHours, formatHours, isOpenNow, validateHours } from './vendorHours';
import { initials, matchPreset, vendorTone } from './vendorSpecialties';

const vendor = (overrides: Partial<VendorItem>): VendorItem => ({ _id: overrides.name || 'v', name: 'V', ...overrides });

const roster: VendorItem[] = [
  vendor({ _id: '1', name: 'Ace Plumbing', company: 'Ace Ltd', specialties: ['Plumbing'], emergencyAvailable: true }),
  vendor({ _id: '2', name: 'Bright Sparks', specialties: ['Electrical', 'HVAC'] }),
  vendor({ _id: '3', name: 'Dana', company: 'Northside Locks', specialties: [], customSpecialties: ['Locksmith', 'Safe repair'] }),
  vendor({ _id: '4', name: 'Eve', specialties: ['Plumbing', 'HVAC'] }),
];
const ids = (list: VendorItem[]) => list.map((v) => v._id);

describe('filterVendors', () => {
  it('returns everyone with no filters', () => {
    expect(ids(filterVendors(roster, EMPTY_FILTERS))).toEqual(['1', '2', '3', '4']);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('searches name and company, case-insensitively', () => {
    expect(ids(filterVendors(roster, { ...EMPTY_FILTERS, query: 'ace' }))).toEqual(['1']);
    expect(ids(filterVendors(roster, { ...EMPTY_FILTERS, query: 'NORTHSIDE' }))).toEqual(['3']);
  });

  it('ORs specialty chips, and matches custom specialties too', () => {
    expect(ids(filterVendors(roster, { ...EMPTY_FILTERS, specialties: ['Electrical', 'Plumbing'] }))).toEqual([
      '1',
      '2',
      '4',
    ]);
    expect(ids(filterVendors(roster, { ...EMPTY_FILTERS, specialties: ['safe repair'] }))).toEqual(['3']);
  });

  it('combines filters with AND across kinds', () => {
    const result = filterVendors(roster, { query: '', specialties: ['Plumbing'], emergencyOnly: true });
    expect(ids(result)).toEqual(['1']);
  });
});

describe('specialtyCounts', () => {
  it('offers only trades the roster has, most common first', () => {
    expect(specialtyCounts(roster)).toEqual([
      { label: 'HVAC', count: 2 },
      { label: 'Plumbing', count: 2 },
      { label: 'Electrical', count: 1 },
      { label: 'Locksmith', count: 1 },
      { label: 'Safe repair', count: 1 },
    ]);
  });
});

describe('table helpers', () => {
  const hours = expandHours({ preset: 'always' });
  const staffed: VendorItem[] = [
    vendor({ _id: 'a', name: 'Zed', email: 'z@x.test', operatingHours: hours, successfulJobs: 3, responseStats: { averageFirstResponseMinutes: 40 } }),
    vendor({ _id: 'b', name: 'amy', email: 'a@x.test', operatingHours: hours, successfulJobs: 9 }),
    vendor({ _id: 'c', name: 'Mo', operatingHours: hours, responseStats: { averageFirstResponseMinutes: 8 } }),
  ];

  it('names what stops a vendor receiving offers', () => {
    expect(missingDetails(staffed[2])).toEqual(['an email']);
    expect(missingDetails(vendor({}))).toEqual(['an email', 'hours']);
    expect(missingDetails(staffed[0])).toEqual([]);
  });

  it('filters to vendors missing details, and counts that as a filter', () => {
    expect(ids(filterVendors(staffed, { ...EMPTY_FILTERS, missingOnly: true }))).toEqual(['c']);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, missingOnly: true })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, sort: 'jobs' })).toBe(false);
  });

  it('sorts by name, by jobs, and by fastest reply with no record last', () => {
    expect(ids(sortVendors(staffed, 'name'))).toEqual(['b', 'c', 'a']);
    expect(ids(sortVendors(staffed, 'jobs'))).toEqual(['b', 'a', 'c']);
    expect(ids(sortVendors(staffed, 'response'))).toEqual(['c', 'a', 'b']);
  });

  it('averages first response over vendors that have one', () => {
    expect(averageResponseMinutes(staffed)).toBe(24);
    expect(averageResponseMinutes([vendor({})])).toBeNull();
    expect(formatMinutes(8)).toBe('8 min');
    expect(formatMinutes(90)).toBe('1.5 h');
    expect(formatMinutes(null)).toBe('—');
  });

  it('tags trusted, emergency and incomplete vendors, and only calls an otherwise plain one new', () => {
    expect(vendorTags(vendor({ verificationStatus: 'trusted', emergencyAvailable: true, email: 'e', operatingHours: hours })).map((t) => t.key)).toEqual([
      'trusted',
      'emergency',
    ]);
    expect(vendorTags(vendor({ email: 'e', operatingHours: hours })).map((t) => t.key)).toEqual(['new']);
    expect(vendorTags(vendor({})).map((t) => t.key)).toEqual(['incomplete']);
    expect(vendorTags(vendor({ email: 'e', operatingHours: hours, successfulJobs: 2 }))).toEqual([]);
  });

  it('always lists the core trades in coverage, flagging the empty ones', () => {
    const coverage = tradeCoverage(roster);
    const row = (label: string) => coverage.find((r) => r.label === label);
    expect(row('Plumbing')).toEqual({ label: 'Plumbing', count: 2, gap: false });
    expect(row('Appliance Repair')).toEqual({ label: 'Appliance Repair', count: 0, gap: true });
    expect(row('Safe repair')?.gap).toBe(false);
    expect(coverage.filter((r) => r.gap).map((r) => r.label)).toEqual(['Appliance Repair', 'General Maintenance']);
    // Covered first, gaps last.
    expect(coverage.at(-1)?.gap).toBe(true);
  });

  it("doesn't count a blocked vendor as coverage", () => {
    const coverage = tradeCoverage([vendor({ specialties: ['Plumbing'], verificationStatus: 'blocked' })]);
    expect(coverage.find((r) => r.label === 'Plumbing')).toEqual({ label: 'Plumbing', count: 0, gap: true });
  });
});

describe('vendor hours', () => {
  it('requires a choice, and sane custom rows', () => {
    expect(validateHours(undefined)).toMatch(/hours of operation/);
    expect(validateHours({ preset: 'weekdays' })).toBeNull();
    expect(validateHours({ preset: 'custom', weekly: [] })).toMatch(/at least one day/);
    expect(validateHours({ preset: 'custom', weekly: [{ day: 2, open: '18:00', close: '08:00' }] })).toMatch(
      /close after it opens/
    );
  });

  it('formats like the server does', () => {
    expect(formatHours(expandHours({ preset: 'weekdays' }))).toBe('Mon–Fri 9:00–17:00');
    expect(formatHours(expandHours({ preset: 'always' }))).toBe('24/7');
    expect(
      formatHours(
        expandHours({
          preset: 'custom',
          weekly: [
            { day: 6, open: '10:00', close: '14:00' },
            { day: 1, open: '08:00', close: '16:00' },
            { day: 2, open: '08:00', close: '16:00' },
          ],
        })
      )
    ).toBe('Mon–Tue 8:00–16:00 · Sat 10:00–14:00');
  });

  it('knows whether a vendor is open at a given local time', () => {
    const weekdays = expandHours({ preset: 'weekdays' });
    const wednesdayNoon = new Date(2026, 8, 30, 12, 0); // 30 Sep 2026 is a Wednesday
    const wednesdayEvening = new Date(2026, 8, 30, 17, 0);
    const saturdayNoon = new Date(2026, 9, 3, 12, 0);
    expect(isOpenNow(weekdays, wednesdayNoon)).toBe(true);
    expect(isOpenNow(weekdays, wednesdayEvening)).toBe(false); // closing time is exclusive
    expect(isOpenNow(weekdays, saturdayNoon)).toBe(false);
    expect(isOpenNow(expandHours({ preset: 'always' }), saturdayNoon)).toBe(true);
    expect(isOpenNow(undefined, wednesdayNoon)).toBe(false);
  });
});

describe('specialty helpers', () => {
  it('canonicalises a typed preset and derives card identity', () => {
    expect(matchPreset('  pest control ')).toBe('Pest Control');
    expect(matchPreset('Backflow testing')).toBeNull();
    expect(initials('Ace Plumbing Co')).toBe('AC');
    expect(initials('Dana')).toBe('DA');
    expect(vendorTone({ specialties: ['Plumbing'] })).toBe('#137fec');
    expect(vendorTone({ specialties: [], customSpecialties: ['Safe repair'] })).toBe('#a855f7');
  });
});
