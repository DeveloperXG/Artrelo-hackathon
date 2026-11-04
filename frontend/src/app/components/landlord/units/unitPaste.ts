/**
 * The universal escape hatch.
 *
 * No generator covers every building. Landlords already keep their unit list
 * somewhere — a spreadsheet column, a lease schedule, a text file — and the
 * fastest path from that list into Artrelo is to let them paste it.
 *
 * So this parser is deliberately permissive about separators and deliberately
 * conservative about content: it decides where one identifier ends and the next
 * begins, and then leaves each identifier exactly as written. "PH1", "G01" and
 * "Retail-A" arrive intact, leading zeros and capitalization included.
 */

/**
 * Split pasted text into identifiers.
 *
 * Newlines, commas, semicolons and tabs all separate. Tabs and semicolons are
 * included because "copy a column out of Excel" and "export from a European
 * spreadsheet" are how this text usually arrives, and neither is worth an error
 * message when the intent is obvious.
 *
 * Blank entries are dropped rather than surfaced as empty rows: a trailing
 * newline or a stray ", ," is punctuation, not a unit the landlord meant to
 * create. An empty row added deliberately in the review table is a different
 * thing, and that one is still flagged.
 */
export function parsePastedUnits(text: string): string[] {
  return String(text ?? '')
    .split(/[\n\r,;\t]+/)
    .map((token) => token.replace(/\s+/g, ' ').trim())
    .filter((token) => token.length > 0);
}
