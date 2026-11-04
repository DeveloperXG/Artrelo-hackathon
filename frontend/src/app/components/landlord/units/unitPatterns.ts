/**
 * Unit identifiers, generated from composable rules rather than from a list of
 * conventions we guessed at.
 *
 * Real buildings number units as 1-24, as 101-120, as A1-A10, as 1A/1B, as
 * PH1/PH2, as G01/G02, as Unit-1. Enumerating those as presets means the
 * building that numbers its units some other way is stuck, and it means every
 * new convention is a code change.
 *
 * So there are exactly two primitives here and everything is built from them:
 *
 *   sequence  — a run of numbers or letters, optionally zero-padded,
 *               with a prefix and a suffix around each item
 *   floors    — the same sequence, repeated once per floor, with the floor
 *               folded into each item's prefix
 *
 * "1 to 24" is a sequence with no prefix. "A1-A10" is a sequence with prefix A.
 * "1A/1B" is a letter sequence with prefix 1. "G01/G02" is a padded sequence
 * with prefix G. "101...806" is floors 1-8 over a padded 01.. sequence. None of
 * those is a special case in this file.
 *
 * Everything returns plain strings and goes through the same review table as a
 * pasted list. The generator has no privileged path to the database.
 */

/** Ceiling shared with the server, so a runaway pattern fails here, loudly. */
export const MAX_GENERATED_UNITS = 5000;

export type SequenceKind = 'number' | 'letter';

export interface SequenceSpec {
  kind: SequenceKind;
  /** Written as the landlord typed it: "1", "101", "01", "A". */
  from: string;
  to: string;
}

export type UnitPattern =
  | {
      strategy: 'sequence';
      prefix: string;
      suffix: string;
      sequence: SequenceSpec;
    }
  | {
      strategy: 'floors';
      prefix: string;
      suffix: string;
      /** Floors are numeric and may be padded the same way units are. */
      floors: SequenceSpec;
      unitsPerFloor: number;
      /** First unit index on each floor. "01" pads to two digits, "1" does not. */
      unitFrom: string;
      /** Between floor and unit. Usually empty ("1203"), sometimes "-" ("12-03"). */
      separator: string;
    };

export interface GenerateResult {
  units: string[];
  /** Why nothing could be generated. Shown in place of a preview. */
  error?: string;
}

/* ---------------------------------------------------------------- numbers -- */

/**
 * How wide to pad, taken from how the landlord wrote the starting value.
 *
 * Typing "01" is the landlord saying units are two digits wide; typing "1" is
 * them saying they are not. Inferring it from the input beats a separate
 * "zero-pad?" checkbox that says the same thing twice and can contradict it.
 */
function inferPad(written: string): number {
  const trimmed = written.trim();
  return /^0\d/.test(trimmed) ? trimmed.length : 0;
}

function formatNumber(value: number, pad: number): string {
  return pad > 0 ? String(value).padStart(pad, '0') : String(value);
}

/* ---------------------------------------------------------------- letters -- */

/**
 * Spreadsheet-column lettering: A..Z, then AA, AB. Wrapping to two letters
 * rather than stopping at Z means a 30-unit floor of letters still works.
 */
export function letterToIndex(letters: string): number {
  const clean = letters.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(clean)) return NaN;
  let index = 0;
  for (const character of clean) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index;
}

export function indexToLetter(index: number): string {
  let remaining = index;
  let letters = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/* --------------------------------------------------------------- sequence -- */

interface ResolvedSequence {
  from: number;
  to: number;
  pad: number;
  kind: SequenceKind;
}

function resolveSequence(spec: SequenceSpec, label: string): ResolvedSequence | string {
  const from = spec.kind === 'letter' ? letterToIndex(spec.from) : Number(spec.from.trim());
  const to = spec.kind === 'letter' ? letterToIndex(spec.to) : Number(spec.to.trim());

  if (!Number.isFinite(from) || !Number.isFinite(to) || spec.from.trim() === '' || spec.to.trim() === '') {
    return `Enter a start and end for ${label}.`;
  }
  if (spec.kind === 'number' && (!Number.isInteger(from) || !Number.isInteger(to))) {
    return `${label} must be whole numbers.`;
  }
  if (from < (spec.kind === 'letter' ? 1 : 0)) {
    return `${label} cannot start below ${spec.kind === 'letter' ? 'A' : '0'}.`;
  }
  if (to < from) {
    return `${label} ends before it starts.`;
  }

  return { from, to, pad: spec.kind === 'number' ? inferPad(spec.from) : 0, kind: spec.kind };
}

function renderItem(value: number, resolved: ResolvedSequence): string {
  return resolved.kind === 'letter' ? indexToLetter(value) : formatNumber(value, resolved.pad);
}

/* -------------------------------------------------------------- generator -- */

/**
 * Turn a pattern into the identifiers it describes.
 *
 * Never throws and never returns a partial list next to an error: either the
 * pattern makes sense and you get every unit it names, or you get the reason it
 * does not and an empty list to show instead of a preview.
 */
export function generateUnits(pattern: UnitPattern): GenerateResult {
  const prefix = pattern.prefix ?? '';
  const suffix = pattern.suffix ?? '';

  if (pattern.strategy === 'sequence') {
    const resolved = resolveSequence(pattern.sequence, 'the sequence');
    if (typeof resolved === 'string') return { units: [], error: resolved };

    const count = resolved.to - resolved.from + 1;
    if (count > MAX_GENERATED_UNITS) {
      return { units: [], error: `That pattern makes ${count} units — the limit is ${MAX_GENERATED_UNITS}.` };
    }

    const units: string[] = [];
    for (let value = resolved.from; value <= resolved.to; value += 1) {
      units.push(`${prefix}${renderItem(value, resolved)}${suffix}`);
    }
    return { units };
  }

  const floors = resolveSequence(pattern.floors, 'the floors');
  if (typeof floors === 'string') return { units: [], error: floors };

  const perFloor = Number(pattern.unitsPerFloor);
  if (!Number.isInteger(perFloor) || perFloor < 1) {
    return { units: [], error: 'Enter how many units are on each floor.' };
  }

  const unitStart = Number(String(pattern.unitFrom).trim());
  if (!Number.isInteger(unitStart) || unitStart < 0) {
    return { units: [], error: 'Units must start at a whole number.' };
  }
  const unitPad = inferPad(String(pattern.unitFrom));

  const floorCount = floors.to - floors.from + 1;
  const total = floorCount * perFloor;
  if (total > MAX_GENERATED_UNITS) {
    return { units: [], error: `That pattern makes ${total} units — the limit is ${MAX_GENERATED_UNITS}.` };
  }

  // The floor is just another prefix. That is the whole trick: a floor pattern
  // is the sequence primitive run once per floor, not a separate generator.
  const units: string[] = [];
  for (let floor = floors.from; floor <= floors.to; floor += 1) {
    const floorLabel = renderItem(floor, floors);
    for (let offset = 0; offset < perFloor; offset += 1) {
      const unitLabel = formatNumber(unitStart + offset, unitPad);
      units.push(`${prefix}${floorLabel}${pattern.separator ?? ''}${unitLabel}${suffix}`);
    }
  }
  return { units };
}

/**
 * A short, honest sample of what will be created: the first few, an ellipsis,
 * and the last one. Enough to recognise the scheme at a glance without
 * pretending the review table is unnecessary.
 */
export function describeSample(units: string[], head = 6): string {
  if (units.length === 0) return '';
  if (units.length <= head + 1) return units.join(', ');
  return `${units.slice(0, head).join(', ')} … ${units[units.length - 1]}`;
}
