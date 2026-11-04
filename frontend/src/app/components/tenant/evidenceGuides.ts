// Guided evidence prompts per category. These tell the tenant exactly which shots
// help a vendor diagnose and prepare, which raises routing confidence and lowers
// callback risk. Safety-sensitive captures (e.g. electrical) are flagged so the UI
// can warn the tenant to only photograph what is safe to reach.

export interface EvidenceGuideItem {
  key: string;
  label: string;
  hint: string;
  /** When true, only capture if it is safe to approach (shown with a caution note). */
  safetyGated?: boolean;
}

const GENERIC_GUIDE: EvidenceGuideItem[] = [
  { key: 'wide', label: 'Wide shot', hint: 'Step back so the whole area is visible.' },
  { key: 'close', label: 'Close-up', hint: 'Get close to the exact problem spot.' },
];

const GUIDES: Record<string, EvidenceGuideItem[]> = {
  Plumbing: [
    { key: 'wide', label: 'Wide shot', hint: 'The whole fixture or room.' },
    { key: 'close', label: 'Close-up of the leak', hint: 'Where water is coming from.' },
    { key: 'under_sink', label: 'Under the sink / source', hint: 'Pipes or connections involved.' },
    { key: 'shutoff', label: 'Shutoff valve', hint: 'The nearest water shutoff valve.' },
  ],
  Appliance: [
    { key: 'full', label: 'Full appliance', hint: 'The whole unit in place.' },
    { key: 'brand', label: 'Brand / model label', hint: 'Usually on a sticker inside the door or back.' },
    { key: 'error', label: 'Error code / display', hint: 'Any error code or warning light shown.' },
  ],
  Electrical: [
    { key: 'outlet', label: 'Outlet / fixture', hint: 'The affected outlet, switch, or fixture.', safetyGated: true },
    { key: 'breaker', label: 'Breaker panel', hint: 'The breaker box with labels visible.', safetyGated: true },
  ],
  HVAC: [
    { key: 'thermostat', label: 'Thermostat', hint: 'Current setting and any display reading.' },
    { key: 'filter', label: 'Air filter', hint: 'Pull it out if easy and photograph it.' },
    { key: 'unit', label: 'Furnace / AC panel', hint: 'The unit and any error light.', safetyGated: true },
  ],
  Structural: [
    { key: 'wide', label: 'Wide shot', hint: 'The whole affected wall, ceiling, or floor.' },
    { key: 'close', label: 'Close-up', hint: 'The crack, stain, or damage in detail.' },
  ],
  Pest: [
    { key: 'evidence', label: 'Pest or droppings', hint: 'The pest, nest, or droppings if visible.' },
    { key: 'location', label: 'Where you saw it', hint: 'The area or entry point.' },
  ],
  'Locks/Hardware': [
    { key: 'hardware', label: 'The lock / hardware', hint: 'The lock, handle, or hinge affected.' },
    { key: 'door', label: 'Door / window', hint: 'The full door or window it belongs to.' },
  ],
};

export function getEvidenceGuide(category: string): EvidenceGuideItem[] {
  return GUIDES[category] || GENERIC_GUIDE;
}
