import type { VendorItem } from '../../../types/landlord';

// The preset trades on the Vendor Network form. Each one except Landscaping
// resolves to a service the recommendation engine routes on -- pinned by
// backend/tests/unit/services/vendorInput.service.test.js, which mirrors this
// list. Add a label here and add it there (and to SERVICE_ALIASES if it is a
// new word for an existing trade).
export const SPECIALTY_OPTIONS = [
  'Plumbing',
  'Electrical',
  'HVAC',
  'Appliance Repair',
  'Carpentry',
  'Painting',
  'Roofing',
  'Flooring',
  'Landscaping',
  'Pest Control',
  'Cleaning',
  'Locksmith',
  'Drywall',
  'Structural',
  'General Maintenance',
];

export const MAX_CUSTOM_SPECIALTIES = 5;
export const MAX_CUSTOM_LENGTH = 40;

// A colour per trade family, so a roster of cards reads at a glance instead of
// as a wall of identical blue tiles.
const TONES: Record<string, string> = {
  Plumbing: '#137fec',
  Electrical: '#d97706',
  HVAC: '#0891b2',
  'Appliance Repair': '#7c3aed',
  Carpentry: '#ea580c',
  Painting: '#db2777',
  Roofing: '#78716c',
  Flooring: '#a16207',
  Landscaping: '#16a34a',
  'Pest Control': '#65a30d',
  Cleaning: '#0d9488',
  Locksmith: '#475569',
  Drywall: '#9a3412',
  Structural: '#57534e',
  'General Maintenance': '#4f46e5',
};
const DEFAULT_TONE = '#a855f7';

/** Every trade on a vendor: presets first, then the landlord's own. */
export function vendorSpecialties(vendor: Pick<VendorItem, 'specialties' | 'customSpecialties'>): string[] {
  return [...(vendor.specialties || []), ...(vendor.customSpecialties || [])];
}

export function vendorTone(vendor: Pick<VendorItem, 'specialties' | 'customSpecialties'>): string {
  const first = (vendor.specialties || []).find((specialty) => TONES[specialty]);
  return first ? TONES[first] : DEFAULT_TONE;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`;
  return letters.toUpperCase();
}

/** Is `value` one of the presets, ignoring case? Returns the canonical label. */
export function matchPreset(value: string): string | null {
  const key = value.trim().toLowerCase();
  return SPECIALTY_OPTIONS.find((option) => option.toLowerCase() === key) || null;
}
