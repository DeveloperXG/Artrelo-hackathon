/**
 * Reading a unit list out of a spreadsheet export.
 *
 * Two decisions shape this file.
 *
 * First, it parses into portfolio-shaped rows even when the caller only wants
 * units for one property. A row is {unit, propertyName?, propertyAddress?}, so
 * "import 400 units into Maple Apartments" and "import twelve properties and
 * their 438 units" are the same parse with a different grouping afterwards.
 * Building the one-property case against a unit-only shape would have meant
 * rewriting the parser the day portfolio import lands.
 *
 * Second, it is forgiving about the file and strict about nothing else. A
 * landlord exporting from a spreadsheet gets whatever their locale and tool
 * chose: commas or semicolons or tabs, CRLF or LF, a header row or not, a BOM
 * on the front. None of that is worth an error message when the intent is
 * obvious. What comes out is exactly what was in the cells.
 */

export interface ImportedRow {
  /** The unit identifier, exactly as the cell had it (whitespace collapsed). */
  unit: string;
  /** Present when the file names a property per row — the portfolio shape. */
  propertyName?: string;
  propertyAddress?: string;
}

export interface ParsedUnitFile {
  rows: ImportedRow[];
  /** Header names as found, or [] when the file had no header row. */
  columns: string[];
  /** True when the file carries per-row property names. */
  hasPropertyColumn: boolean;
  /** Non-fatal notes worth showing above the review table. */
  warnings: string[];
  /** Set when nothing usable could be read. */
  error?: string;
}

const UNIT_HEADERS = ['unit', 'units', 'unit name', 'unit number', 'unit id', 'number', 'name', 'identifier', 'apt', 'apartment', 'suite'];
const PROPERTY_NAME_HEADERS = ['property', 'property name', 'building', 'building name'];
const PROPERTY_ADDRESS_HEADERS = ['address', 'property address', 'street', 'street address'];

/** Extensions this parser reads. XLSX is not among them — see importUnitFile. */
export const ACCEPTED_FILE_TYPES = '.csv,.tsv,.txt';

/* ------------------------------------------------------------ delimiters -- */

/**
 * Pick the delimiter by counting candidates in the first non-empty line.
 *
 * Guessing beats asking: a landlord exporting from a German Excel gets
 * semicolons and has no reason to know that, and being made to choose from a
 * dropdown to import a file is the friction this feature exists to remove.
 */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    // Count outside quotes only, or a quoted address with a comma wins the vote.
    let count = 0;
    let inQuotes = false;
    for (let at = 0; at < firstLine.length; at += 1) {
      const character = firstLine[at];
      if (character === '"') inQuotes = !inQuotes;
      else if (!inQuotes && character === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A CSV reader that understands quotes, because addresses contain commas.
 *
 * "Maple Apartments,""123 Main St, Apt 4"",101" is a three-cell row, and
 * splitting on commas would make it four and put half an address in the unit
 * column. Doubled quotes inside a quoted field are an escaped quote.
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\uFEFF/, ''); // strip the BOM Excel likes to add
  const sep = delimiter || detectDelimiter(source);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (row.some((value) => value.trim().length > 0)) rows.push(row);
    row = [];
  };

  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];

    if (inQuotes) {
      if (character === '"') {
        if (source[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"') inQuotes = true;
    else if (character === sep) endCell();
    else if (character === '\r') continue; // CRLF: the \n does the work
    else if (character === '\n') endRow();
    else cell += character;
  }
  if (cell.length > 0 || row.length > 0) endRow();

  return rows;
}

/* --------------------------------------------------------------- mapping -- */

const clean = (value: string) => String(value ?? '').replace(/\s+/g, ' ').trim();
const headerKey = (value: string) => clean(value).toLowerCase();

function looksLikeHeader(cells: string[]): boolean {
  return cells.some((cell) => {
    const key = headerKey(cell);
    return (
      UNIT_HEADERS.includes(key) ||
      PROPERTY_NAME_HEADERS.includes(key) ||
      PROPERTY_ADDRESS_HEADERS.includes(key)
    );
  });
}

function findColumn(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(headerKey(header)));
}

/**
 * Turn a delimited file into rows the review pipeline can use.
 *
 * With a header row the columns are matched by name. Without one the file is
 * assumed to be a bare list of identifiers, one per line — which is what a
 * landlord who pasted a column into a text file will actually have.
 */
export function parseUnitFile(text: string): ParsedUnitFile {
  const table = parseDelimited(text);
  const warnings: string[] = [];

  if (table.length === 0) {
    return { rows: [], columns: [], hasPropertyColumn: false, warnings, error: 'That file is empty.' };
  }

  const hasHeader = looksLikeHeader(table[0]);

  if (!hasHeader) {
    // No header. If there is one column it is the unit list; if there are
    // several we take the first and say so rather than guessing silently.
    const width = Math.max(...table.map((row) => row.length));
    if (width > 1) {
      warnings.push(
        `No header row found — using the first column as the unit name. Add a "unit" header to choose a different column.`
      );
    }
    const rows = table
      .map((row) => ({ unit: clean(row[0] || '') }))
      .filter((row) => row.unit.length > 0);
    return { rows, columns: [], hasPropertyColumn: false, warnings };
  }

  const headers = table[0];
  const unitAt = findColumn(headers, UNIT_HEADERS);
  const nameAt = findColumn(headers, PROPERTY_NAME_HEADERS);
  const addressAt = findColumn(headers, PROPERTY_ADDRESS_HEADERS);

  if (unitAt === -1) {
    return {
      rows: [],
      columns: headers.map(clean),
      hasPropertyColumn: nameAt !== -1,
      warnings,
      error: `No unit column found. Expected a column headed "unit". Found: ${headers
        .map(clean)
        .filter(Boolean)
        .join(', ')}.`,
    };
  }

  const rows: ImportedRow[] = [];
  for (const cells of table.slice(1)) {
    const unit = clean(cells[unitAt] || '');
    if (!unit) continue; // a blank line in a spreadsheet is not a unit
    const row: ImportedRow = { unit };
    if (nameAt !== -1) {
      const propertyName = clean(cells[nameAt] || '');
      if (propertyName) row.propertyName = propertyName;
    }
    if (addressAt !== -1) {
      const propertyAddress = clean(cells[addressAt] || '');
      if (propertyAddress) row.propertyAddress = propertyAddress;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return {
      rows,
      columns: headers.map(clean),
      hasPropertyColumn: nameAt !== -1,
      warnings,
      error: 'That file has a header but no unit rows.',
    };
  }

  return {
    rows,
    columns: headers.map(clean),
    hasPropertyColumn: nameAt !== -1 && rows.some((row) => row.propertyName),
    warnings,
  };
}

/**
 * Read a picked file and parse it.
 *
 * XLSX is deliberately not handled. Reading one means either a heavy
 * spreadsheet dependency in a bundle that is already large, or a hand-rolled
 * zip and XML reader — and a landlord with an .xlsx is two keystrokes from a
 * CSV, or can copy the column straight into the paste box, which already works.
 * The rejection says exactly that rather than failing on binary noise.
 */
export async function importUnitFile(file: File): Promise<ParsedUnitFile> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return {
      rows: [],
      columns: [],
      hasPropertyColumn: false,
      warnings: [],
      error:
        'Excel files are not read directly yet. Save the sheet as CSV, or copy the unit column and paste it instead.',
    };
  }

  const text = await file.text();
  return parseUnitFile(text);
}
