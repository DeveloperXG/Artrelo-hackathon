// Itemized quotes and final statements (quote contract v2).
//
// Mirrors backend/services/quotes/itemization.service.js. Money is integer
// cents from the moment it is typed: a dollar string is split on its decimal
// point and never passes through a float, so 0.1 + 0.2 cannot happen and no
// amount is ever rounded on the vendor's behalf. The server stays the
// authority; this lets the vendor see each problem beside its line first.

export const QUOTE_CONTRACT_VERSION = 2;
export const MAX_MINOR = 100_000_000;
export const MAX_ITEMS = 50;
export const MAX_DESCRIPTION = 240;
export const MAX_INVOICE_REFERENCE = 120;

export const CATEGORIES = ['labour', 'materials', 'callout', 'travel', 'disposal', 'tax', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = {
  labour: 'Labour',
  materials: 'Materials',
  callout: 'Call-out',
  travel: 'Travel',
  disposal: 'Disposal',
  tax: 'Tax',
  other: 'Other',
};

export type PricingMode = 'fixed' | 'range';

export interface ItemizationLine {
  lineId: string;
  description: string;
  category: Category;
  amountMinor?: number;
  lowMinor?: number;
  highMinor?: number;
}
export interface Itemization {
  pricingMode: PricingMode;
  currency: 'CAD';
  items: ItemizationLine[];
  totals: { lowMinor: number; highMinor: number };
}
/** A stored, immutable quote or final statement. */
export interface QuoteSnapshot {
  quoteContractVersion: 2;
  revision: number;
  hash: string;
  itemization: Itemization;
}

/** What is sent. A new line has no lineId: the server assigns one. */
export type ItemizationInputLine = Omit<ItemizationLine, 'lineId'> & { lineId?: string };
export interface ItemizationInput {
  pricingMode: PricingMode;
  currency: 'CAD';
  items: ItemizationInputLine[];
  totals: { lowMinor: number; highMinor: number };
}

/** One editable line. Amounts stay as typed until submit. */
export interface DraftLine {
  key: string;
  /** Present only on a line the server already owns (a clarification revision). */
  lineId?: string;
  description: string;
  category: Category | '';
  amount: string;
  low: string;
  high: string;
}
export type LineField = 'description' | 'category' | 'amount' | 'low' | 'high';
export type LineErrors = Partial<Record<LineField, string>>;

let draftCounter = 0;
export function emptyLine(): DraftLine {
  draftCounter += 1;
  return { key: `line-${draftCounter}`, description: '', category: '', amount: '', low: '', high: '' };
}

export function addLine(lines: DraftLine[]): DraftLine[] {
  return lines.length >= MAX_ITEMS ? lines : [...lines, emptyLine()];
}

/** The last line stays: an itemization needs at least one. */
export function removeLine(lines: DraftLine[], key: string): DraftLine[] {
  if (lines.length <= 1) return lines;
  return lines.filter((line) => line.key !== key);
}

/**
 * "120", "120.5", "120.50" and "$1,200.50" to integer cents. Anything with a
 * third decimal place, a sign, an exponent or no digits is refused rather than
 * rounded: a fractional cent is the vendor's mistake to see, not ours to fix.
 */
export function parseMinor(value: string): number | null {
  const text = value.trim().replace(/^\$/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  if (whole.length > 7) return null;
  const minor = Number(whole) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR ? minor : null;
}

/** Cents back to an editable string, without a float: 12345 -> "123.45". */
export function minorToInput(minor: number): string {
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Display only. Built from the integer, so it can't drift by a cent. */
export function formatCAD(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100).toLocaleString('en-CA');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatSignedCAD(minor: number): string {
  if (minor === 0) return formatCAD(0);
  return minor > 0 ? `+${formatCAD(minor)}` : `−${formatCAD(-minor)}`;
}

export function formatTotals(itemization: Pick<Itemization, 'pricingMode' | 'totals'>): string {
  const { lowMinor, highMinor } = itemization.totals;
  return itemization.pricingMode === 'fixed' || lowMinor === highMinor
    ? formatCAD(highMinor)
    : `${formatCAD(lowMinor)}–${formatCAD(highMinor)}`;
}

/**
 * The legacy dollar projection the server compares against (actualCost,
 * quoteLow/quoteHigh). minor / 100 round-trips exactly through the server's
 * dollarToMinor for every integer up to MAX_MINOR; see itemization.test.ts.
 */
export function minorToDollars(minor: number): number {
  return minor / 100;
}

/** A stored dollar figure to cents, or null when it isn't a whole cent. */
export function dollarsToMinor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (Number(value.toFixed(2)) !== value) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR ? minor : null;
}

/** Running totals while typing. `complete` is false while any amount is unreadable. */
export function draftTotals(mode: PricingMode, lines: DraftLine[]) {
  let lowMinor = 0;
  let highMinor = 0;
  let complete = lines.length > 0;
  for (const line of lines) {
    const low = parseMinor(mode === 'fixed' ? line.amount : line.low);
    const high = mode === 'fixed' ? low : parseMinor(line.high);
    if (low === null || high === null) {
      complete = false;
      continue;
    }
    lowMinor += low;
    highMinor += high;
  }
  return { lowMinor, highMinor, complete };
}

export type ItemizationCheck =
  | { ok: true; itemization: ItemizationInput }
  | { ok: false; lineErrors: Record<string, LineErrors>; message: string };

/** Every line checked at once, so the vendor fixes the form in one pass. */
export function buildItemization(mode: PricingMode, lines: DraftLine[]): ItemizationCheck {
  const lineErrors: Record<string, LineErrors> = {};
  const items: ItemizationInputLine[] = [];
  let lowMinor = 0;
  let highMinor = 0;
  let overLimit = false;
  if (!lines.length) return { ok: false, lineErrors, message: 'Add at least one line.' };
  if (lines.length > MAX_ITEMS) return { ok: false, lineErrors, message: `Use at most ${MAX_ITEMS} lines.` };
  const amountError = 'Enter an amount in dollars and cents, like 120 or 120.50.';
  for (const line of lines) {
    const errors: LineErrors = {};
    const description = line.description.trim();
    if (!description) errors.description = 'Describe this line.';
    else if (description.length > MAX_DESCRIPTION) errors.description = `Keep this under ${MAX_DESCRIPTION} characters.`;
    if (!line.category) errors.category = 'Choose a category.';
    let low: number | null;
    let high: number | null;
    if (mode === 'fixed') {
      low = high = parseMinor(line.amount);
      if (low === null) errors.amount = amountError;
    } else {
      low = parseMinor(line.low);
      high = parseMinor(line.high);
      if (low === null) errors.low = amountError;
      if (high === null) errors.high = amountError;
      if (low !== null && high !== null && low > high) errors.high = 'The high amount must be at least the low amount.';
    }
    if (Object.keys(errors).length || low === null || high === null) {
      lineErrors[line.key] = errors;
      continue;
    }
    lowMinor += low;
    highMinor += high;
    if (highMinor > MAX_MINOR) overLimit = true;
    items.push({
      ...(line.lineId ? { lineId: line.lineId } : {}),
      description,
      category: line.category as Category,
      ...(mode === 'fixed' ? { amountMinor: low } : { lowMinor: low, highMinor: high }),
    });
  }
  if (Object.keys(lineErrors).length) {
    return { ok: false, lineErrors, message: 'Check the highlighted lines.' };
  }
  if (overLimit) return { ok: false, lineErrors, message: 'The total is above the limit for one job.' };
  return { ok: true, itemization: { pricingMode: mode, currency: 'CAD', items, totals: { lowMinor, highMinor } } };
}

/** A stored itemization back into editable lines, keeping the owned lineIds. */
export function linesFromItemization(itemization: Itemization): DraftLine[] {
  return itemization.items.map((item) => ({
    ...emptyLine(),
    lineId: item.lineId,
    description: item.description,
    category: item.category,
    amount: item.amountMinor != null ? minorToInput(item.amountMinor) : '',
    low: item.lowMinor != null ? minorToInput(item.lowMinor) : '',
    high: item.highMinor != null ? minorToInput(item.highMinor) : '',
  }));
}

/**
 * A server field path ("items.2.amountMinor", "totals") to the line and field
 * it names, so a 400 lands beside the input instead of in a toast.
 */
export function lineErrorFromServer(
  field: string | undefined,
  lines: DraftLine[],
  mode: PricingMode
): { key: string; field: LineField } | null {
  const match = /^items\.(\d+)(?:\.(\w+))?$/.exec(field || '');
  if (!match) return null;
  const line = lines[Number(match[1])];
  if (!line) return null;
  const map: Record<string, LineField> = {
    description: 'description',
    category: 'category',
    amountMinor: 'amount',
    lowMinor: 'low',
    highMinor: 'high',
  };
  return { key: line.key, field: map[match[2] || ''] || (mode === 'fixed' ? 'amount' : 'high') };
}

/** Server codes from the itemization contract, in words. */
export function itemizationErrorMessage(code?: string): string {
  switch (code) {
    case 'invalid_money':
      return 'Amounts must be whole cents and not negative.';
    case 'quote_limit_exceeded':
      return 'The total is above the limit for one job.';
    case 'quote_total_mismatch':
      return 'The total does not match the lines. Check each amount.';
    case 'inverted_range':
      return 'A high amount is below its low amount.';
    case 'invalid_description':
      return 'Each line needs a description of up to 240 characters.';
    case 'invalid_category':
      return 'Each line needs a category.';
    case 'final_statement_must_be_fixed':
      return 'Final charges must be exact amounts, not ranges.';
    case 'invalid_invoice_reference':
      return 'Keep the invoice reference under 120 characters.';
    case 'quote_revision_conflict':
      return 'This job changed while you were filling the form. Reload to see the current version.';
    default:
      return 'Check the itemized amounts and try again.';
  }
}

export type QuoteDeltas = {
  originalEstimate: { lowMinor: number; highMinor: number } | null;
  agreedMinor: number | null;
  finalMinor: number | null;
  agreedVsEstimate: { versusLowMinor: number; versusHighMinor: number } | null;
  finalVsEstimate: { versusLowMinor: number; versusHighMinor: number } | null;
  finalVsAgreed: { amountMinor: number; percent: number | null } | null;
};

/**
 * Mirror of the server's calculateQuoteDeltas. Absence is null and zero is a
 * real price; a range is compared against both ends, never a midpoint.
 */
export function quoteDeltas(input: {
  originalLowMinor?: number | null;
  originalHighMinor?: number | null;
  agreedMinor?: number | null;
  finalMinor?: number | null;
}): QuoteDeltas {
  const read = (value?: number | null) => (value == null ? null : value);
  const low = read(input.originalLowMinor);
  const high = read(input.originalHighMinor);
  const agreed = read(input.agreedMinor);
  const final = read(input.finalMinor);
  const estimate = low === null || high === null ? null : { lowMinor: low, highMinor: high };
  const againstRange = (value: number | null) =>
    value === null || estimate === null
      ? null
      : { versusLowMinor: value - estimate.lowMinor, versusHighMinor: value - estimate.highMinor };
  return {
    originalEstimate: estimate,
    agreedMinor: agreed,
    finalMinor: final,
    agreedVsEstimate: againstRange(agreed),
    finalVsEstimate: againstRange(final),
    finalVsAgreed:
      agreed === null || final === null
        ? null
        : {
            amountMinor: final - agreed,
            percent: agreed === 0 ? null : Number((((final - agreed) * 100) / agreed).toFixed(4)),
          },
  };
}
