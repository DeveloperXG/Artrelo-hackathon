import type { VendorItem } from '../../../types/landlord';
import { vendorSpecialties } from './vendorSpecialties';

// Filtering runs in the browser: listVendors returns the landlord's whole
// roster, which is tens of rows, not thousands. If rosters ever reach the
// hundreds this belongs on the server.

export type VendorSort = 'name' | 'jobs' | 'response';

export interface VendorFilterState {
  query: string;
  specialties: string[];
  emergencyOnly: boolean;
  /** Only vendors that can't receive job offers yet (no email or no hours). */
  missingOnly?: boolean;
  sort?: VendorSort;
}

export const EMPTY_FILTERS: VendorFilterState = {
  query: '',
  specialties: [],
  emergencyOnly: false,
  missingOnly: false,
  sort: 'name',
};

/** Sort order is a view preference, not a filter, so it never counts here. */
export const hasActiveFilters = (filters: VendorFilterState) =>
  Boolean(filters.query.trim()) || filters.specialties.length > 0 || filters.emergencyOnly || Boolean(filters.missingOnly);

/**
 * What stops a vendor receiving job offers: outreach is by email, and send
 * timing needs their hours. Phrased for "Add … so this vendor can …".
 */
export function missingDetails(vendor: Pick<VendorItem, 'email' | 'operatingHours'>): string[] {
  return [!vendor.email ? 'an email' : null, !vendor.operatingHours ? 'hours' : null].filter(
    (value): value is string => Boolean(value)
  );
}

export type VendorTag = { key: 'trusted' | 'emergency' | 'new' | 'incomplete' | 'blocked'; label: string };

/** The status column. Order is the order they're drawn in. */
export function vendorTags(vendor: VendorItem): VendorTag[] {
  const tags: VendorTag[] = [];
  if (vendor.verificationStatus === 'blocked') tags.push({ key: 'blocked', label: 'Blocked' });
  if (vendor.verificationStatus === 'trusted') tags.push({ key: 'trusted', label: 'Trusted' });
  if (vendor.emergencyAvailable) tags.push({ key: 'emergency', label: 'Emergency ready' });
  if (missingDetails(vendor).length) tags.push({ key: 'incomplete', label: 'Incomplete' });
  // "New" only when nothing more useful is true of them.
  if (!vendor.successfulJobs && !tags.length) tags.push({ key: 'new', label: 'New' });
  return tags;
}

const responseMinutes = (vendor: VendorItem) => vendor.responseStats?.averageFirstResponseMinutes || 0;

/** Name A–Z, most completed jobs, or fastest first reply (no record sorts last). */
export function sortVendors(vendors: VendorItem[], sort: VendorSort = 'name'): VendorItem[] {
  const byName = (a: VendorItem, b: VendorItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...vendors].sort((a, b) => {
    if (sort === 'jobs') return (b.successfulJobs || 0) - (a.successfulJobs || 0) || byName(a, b);
    if (sort === 'response') {
      const ra = responseMinutes(a);
      const rb = responseMinutes(b);
      if (!ra !== !rb) return ra ? -1 : 1;
      return ra - rb || byName(a, b);
    }
    return byName(a, b);
  });
}

/** Mean first-response time over vendors that have one, or null when none do. */
export function averageResponseMinutes(vendors: VendorItem[]): number | null {
  const known = vendors.map(responseMinutes).filter((minutes) => minutes > 0);
  if (!known.length) return null;
  return known.reduce((acc, minutes) => acc + minutes, 0) / known.length;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '—';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
}

/**
 * Trades every rental needs covered. Tenant requests route on these, so a zero
 * here is a routing exception waiting to happen — the coverage panel always
 * shows them, flagged when empty. Other trades appear only once someone in the
 * roster has them.
 */
export const CORE_TRADES = ['Plumbing', 'Electrical', 'HVAC', 'Appliance Repair', 'Locksmith', 'General Maintenance'];

export function tradeCoverage(vendors: VendorItem[]): { label: string; count: number; gap: boolean }[] {
  // Blocked vendors are never contacted, so they don't cover anything.
  const counted = specialtyCounts(vendors.filter((vendor) => vendor.verificationStatus !== 'blocked'));
  const byKey = new Map(counted.map((row) => [row.label.toLowerCase(), row]));
  const rows = [...counted];
  for (const trade of CORE_TRADES) {
    if (!byKey.has(trade.toLowerCase())) rows.push({ label: trade, count: 0 });
  }
  return rows
    .map((row) => ({ ...row, gap: row.count === 0 }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Name/company search is a case-insensitive substring match. Specialty chips
 * are OR'd -- "Plumbing or HVAC" is the useful question when hunting for
 * someone to call; AND would mostly return nobody.
 */
export function filterVendors(vendors: VendorItem[], filters: VendorFilterState): VendorItem[] {
  const query = filters.query.trim().toLowerCase();
  const wanted = new Set(filters.specialties.map((value) => value.toLowerCase()));

  return vendors.filter((vendor) => {
    if (filters.emergencyOnly && !vendor.emergencyAvailable) return false;
    if (filters.missingOnly && !missingDetails(vendor).length) return false;
    if (query) {
      const haystack = `${vendor.name} ${vendor.company || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (wanted.size) {
      const has = vendorSpecialties(vendor).some((value) => wanted.has(value.toLowerCase()));
      if (!has) return false;
    }
    return true;
  });
}

/**
 * The specialty chips to offer: only trades someone in the roster actually has
 * (a chip that can only ever return zero is noise), with how many vendors have
 * each, most common first.
 */
export function specialtyCounts(vendors: VendorItem[]): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const vendor of vendors) {
    const seen = new Set<string>();
    for (const label of vendorSpecialties(vendor)) {
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) || { label, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
