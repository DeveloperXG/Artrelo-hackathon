import { useRef, useState } from 'react';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import { Button } from '../../ui/button';
import { ACCEPTED_FILE_TYPES, importUnitFile, type ParsedUnitFile } from './unitFileParser';

/**
 * Upload a unit list.
 *
 * The file never becomes units on its own. It is parsed, summarised, and then
 * handed to the same review table a pasted list goes to — so an import that
 * read the wrong column is something the landlord sees and fixes, not something
 * they discover afterwards in a property with 400 wrong unit names.
 *
 * One component serves both flows, but they want opposite things from the same
 * file. Importing into a chosen property, a per-row property column is
 * something to warn about — those names are about to be ignored. Importing a
 * portfolio, that column is the entire point and its absence is the error.
 * `mode` is which of those this is.
 */
export type FileImportMode = 'units' | 'portfolio';

export interface UnitFileImportProps {
  onParsed: (units: string[], parsed: ParsedUnitFile) => void;
  mode?: FileImportMode;
}

export default function UnitFileImport({ onParsed, mode = 'units' }: UnitFileImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedUnitFile | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setFileName(file.name);
    try {
      const result = await importUnitFile(file);
      setParsed(result);
    } catch {
      setParsed({
        rows: [],
        columns: [],
        hasPropertyColumn: false,
        warnings: [],
        error: 'That file could not be read.',
      });
    } finally {
      setBusy(false);
    }
  };

  // How many distinct buildings the file describes. Case-folded, matching how
  // the portfolio grouper decides two rows name the same property.
  const propertyCount = parsed
    ? new Set(
        parsed.rows
          .map((row) => (row.propertyName || '').toLocaleLowerCase())
          .filter((name) => name.length > 0)
      ).size
    : 0;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        className={`rounded-xl border border-dashed px-4 py-8 text-center transition ${
          dragging ? 'border-[#137fec] bg-[#137fec]/5' : 'border-slate-200 bg-slate-50/60'
        }`}
      >
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          {busy ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <FileSpreadsheet className="h-5 w-5" />
          )}
        </div>
        <p className="mt-2.5 text-sm font-medium text-slate-600">
          {fileName || 'Drop a CSV here'}
        </p>
        <p className="mt-0.5 text-xs text-slate-400">
          {mode === 'portfolio' ? (
            <>
              Columns headed <code>property</code>, <code>address</code> and <code>unit</code>.
            </>
          ) : (
            <>
              One column headed <code>unit</code>, or a bare list of names.
            </>
          )}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          data-testid="unit-file-input"
          className="sr-only"
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="mt-3 border-slate-200"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          Choose file
        </Button>
      </div>

      {parsed?.error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {parsed.error}
        </p>
      ) : null}

      {parsed && !parsed.error ? (
        <div className="space-y-2">
          <p className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-sm text-slate-600">
            <span className="font-semibold text-slate-900">{parsed.rows.length}</span> unit
            {parsed.rows.length === 1 ? '' : 's'} read
            {mode === 'portfolio' && propertyCount > 0
              ? ` across ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`
              : ''}
            {parsed.columns.length > 0 ? ` from columns: ${parsed.columns.join(', ')}` : ''}.
          </p>

          {mode === 'units' && parsed.hasPropertyColumn ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This file names a property on each row. Those names will be ignored — every unit goes
              to the property selected above. To create the properties too, use{' '}
              <span className="font-semibold">Add properties → Import a portfolio</span>.
            </p>
          ) : null}

          {mode === 'portfolio' && !parsed.hasPropertyColumn ? (
            <p
              role="alert"
              className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
            >
              A portfolio import needs a property name on every row. Add{' '}
              <code>Property Name</code> and <code>Address</code> columns, or add these units to a
              single property with <span className="font-semibold">Add units</span>.
            </p>
          ) : null}

          {parsed.warnings.map((warning) => (
            <p
              key={warning}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
            >
              {warning}
            </p>
          ))}

          <Button
            data-testid="review-imported-units"
            disabled={parsed.rows.length === 0 || (mode === 'portfolio' && !parsed.hasPropertyColumn)}
            onClick={() => onParsed(parsed.rows.map((row) => row.unit), parsed)}
            className="w-full bg-[#137fec] hover:bg-[#137fec]/90"
          >
            {mode === 'portfolio'
              ? `Review ${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'} and ${
                  parsed.rows.length
                } unit${parsed.rows.length === 1 ? '' : 's'}`
              : `Review ${parsed.rows.length} unit${parsed.rows.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      ) : null}

    </div>
  );
}
