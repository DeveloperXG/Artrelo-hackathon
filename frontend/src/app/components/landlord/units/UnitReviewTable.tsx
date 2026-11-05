import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AlertCircle, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Input } from '../../ui/input';
import { FieldLabel } from '../landlordUi';
import { nextRowId, type ProposedUnit, type ReviewResult } from './proposedUnits';

/**
 * The one place proposed units are reviewed, whatever produced them.
 *
 * The generator, the paste box and the CSV importer are all just different ways
 * of filling this table. They hand over ProposedUnit[] and get out of the way;
 * none of them writes to the database directly, and none of them gets its own
 * review screen to drift out of step with this one.
 *
 * Rendering is capped by default because a 500-unit portfolio is the case this
 * whole feature exists for, and 500 live inputs is a janky dialog. Invalid rows
 * are never hidden by the cap — the rows that need attention are exactly the
 * ones the landlord came here to find.
 */
const DEFAULT_VISIBLE_ROWS = 250;

export interface UnitReviewTableProps {
  rows: ProposedUnit[];
  review: ReviewResult;
  onChange: (rows: ProposedUnit[]) => void;
  /** Set while the batch is being written, to freeze editing. */
  busy?: boolean;
}

export default function UnitReviewTable({ rows, review, onChange, busy }: UnitReviewTableProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  // Keyed by row id so a newly added row can take focus once React has drawn it.
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  // A row that should take focus as soon as it exists. Rows are owned by the
  // parent, so the input is not in the DOM when the handler that created it
  // runs — the focus has to wait for the render that adds it.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocus) return;
    inputRefs.current.get(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus, rows]);

  const reviewed = review.rows;

  const visible = useMemo(() => {
    if (showAll || reviewed.length <= DEFAULT_VISIBLE_ROWS) return reviewed;
    const head = reviewed.slice(0, DEFAULT_VISIBLE_ROWS);
    const shownIds = new Set(head.map((row) => row.id));
    // Pull every problem row forward regardless of where it sits in the list.
    const problems = reviewed.filter((row) => !row.valid && !shownIds.has(row.id));
    return [...head, ...problems];
  }, [reviewed, showAll]);

  const hiddenCount = reviewed.length - visible.length;

  const setName = (id: string, name: string) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, name } : row)));
  };

  const removeRows = (ids: Set<string>) => {
    onChange(rows.filter((row) => !ids.has(row.id)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  };

  const addRowAfter = (id?: string) => {
    const row: ProposedUnit = { id: nextRowId(), name: '' };
    if (!id) {
      onChange([...rows, row]);
    } else {
      const at = rows.findIndex((candidate) => candidate.id === id);
      const next = [...rows];
      next.splice(at + 1, 0, row);
      onChange(next);
    }
    setPendingFocus(row.id);
  };

  /**
   * Keyboard editing, because correcting 40 rows with a mouse is the slow path
   * this feature was built to remove. Enter opens a row below the caret, arrows
   * walk the column, Backspace on an already-empty row deletes it.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, id: string, at: number) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addRowAfter(id);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = visible[at + (event.key === 'ArrowDown' ? 1 : -1)];
      if (target) {
        event.preventDefault();
        inputRefs.current.get(target.id)?.focus();
      }
      return;
    }
    if (event.key === 'Backspace' && !(event.target as HTMLInputElement).value && rows.length > 1) {
      event.preventDefault();
      const previous = visible[at - 1];
      removeRows(new Set([id]));
      if (previous) setPendingFocus(previous.id);
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((row) => selected.has(row.id));

  const toggleAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map((row) => row.id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FieldLabel>Proposed units</FieldLabel>
        <div className="flex items-center gap-2">
          {selected.size > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-8 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 lichen:border-alert-line lichen:text-alert-text lichen:hover:bg-alert-tint lichen:hover:text-alert-text"
              onClick={() => removeRows(selected)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Remove {selected.size}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            className="h-8 border-slate-200 lichen:border-hairline"
            onClick={() => addRowAfter()}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add unit
          </Button>
        </div>
      </div>

      <div className="max-h-[46vh] overflow-auto rounded-xl border border-slate-200 lichen:rounded-lg lichen:border-hairline">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur lichen:bg-well">
            <tr className="border-b border-slate-200 text-left lichen:border-hairline">
              <th scope="col" className="w-10 px-3 py-2">
                <Checkbox
                  checked={allVisibleSelected}
                  onCheckedChange={toggleAll}
                  disabled={busy || visible.length === 0}
                  aria-label="Select all proposed units"
                />
              </th>
              <th
                scope="col"
                className="px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 lichen:text-xs lichen:normal-case lichen:tracking-normal lichen:text-meta"
              >
                Unit
              </th>
              <th scope="col" className="w-10 px-3 py-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row, at) => (
              <tr
                key={row.id}
                data-testid={`review-row-${at}`}
                className={row.valid ? "border-b border-slate-100 lichen:border-hairline" : "border-b border-rose-100 bg-rose-50/40 lichen:border-alert-line lichen:bg-alert-tint"}
              >
                <td className="px-3 py-1.5 align-top">
                  <div className="pt-2">
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={() => toggleOne(row.id)}
                      disabled={busy}
                      aria-label={`Select ${row.name || 'empty unit'}`}
                    />
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    ref={(element) => {
                      if (element) inputRefs.current.set(row.id, element);
                      else inputRefs.current.delete(row.id);
                    }}
                    value={row.name}
                    disabled={busy}
                    aria-invalid={!row.valid}
                    aria-label={`Unit identifier, row ${row.index + 1}`}
                    aria-describedby={row.valid ? undefined : `review-error-${row.id}`}
                    className="h-9 bg-white lichen:bg-card"
                    onChange={(event) => setName(row.id, event.target.value)}
                    onKeyDown={(event) => onKeyDown(event, row.id, at)}
                  />
                  {row.valid ? null : (
                    <p
                      id={`review-error-${row.id}`}
                      className="mt-1 flex items-start gap-1 text-xs text-rose-600 lichen:text-alert-text"
                    >
                      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>{row.errors.map((error) => error.message).join('. ')}</span>
                    </p>
                  )}
                </td>
                <td className="px-3 py-1.5 align-top">
                  <div className="pt-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      aria-label={`Remove ${row.name || `row ${row.index + 1}`}`}
                      className="h-8 w-8 text-slate-300 hover:bg-rose-50 hover:text-rose-600 lichen:text-meta lichen:hover:bg-alert-tint lichen:hover:text-alert-text"
                      onClick={() => removeRows(new Set([row.id]))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-sm text-slate-400 lichen:text-meta">
                  No units proposed yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="w-full rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500 transition hover:border-[#137fec]/40 hover:text-[#137fec] lichen:rounded-lg lichen:border-hairline lichen:text-meta lichen:hover:border-lichen-line lichen:hover:text-lichen-text"
        >
          {hiddenCount} more {hiddenCount === 1 ? 'unit' : 'units'} not shown — every row with a
          problem is already listed above. Show all {reviewed.length}.
        </button>
      ) : null}
    </div>
  );
}
