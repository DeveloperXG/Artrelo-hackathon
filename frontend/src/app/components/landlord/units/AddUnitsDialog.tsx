import { REMAINDER_PORTAL } from '../remainderPresentation';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ClipboardList, DoorOpen, Loader2, Plus, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { LandlordAPI, ApiError } from '../../../api/client';
import type { Property, UnitBatchResult } from '../../../types/landlord';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { FieldError, invalidFieldClass } from '../../ui/FieldError';
import { Textarea } from '../../ui/textarea';
import { FieldLabel, FormDialog, fieldClass } from '../landlordUi';
import UnitFileImport from './UnitFileImport';
import UnitGeneratorForm from './UnitGeneratorForm';
import CreationMethodPicker, { type CreationMethod } from '../CreationMethodPicker';
import UnitReviewTable from './UnitReviewTable';
import { parsePastedUnits } from './unitPaste';
import {
  existingIdentifiers,
  reviewProposedUnits,
  toProposedUnits,
  type ProposedUnit,
} from './proposedUnits';

/**
 * "Add units", end to end.
 *
 * The shape that matters is the funnel: every method except "add one" produces
 * ProposedUnit[] and hands them to the same review table, the same validator and
 * the same bulk endpoint. Adding a method — a floor-pattern generator, a CSV
 * upload, one day an AI that reads "twelve floors, 01 through 08" — means
 * writing a panel that returns a list of names. It does not mean writing another
 * review screen, another set of validation rules, or another way to write to the
 * database.
 *
 *   add one ─────────────────────────────────────────→ POST /units
 *   generate ─┐
 *   paste ────┼─→ proposed → review → validate → confirm → POST .../units/bulk
 *   file ─────┘
 *
 * Nothing bulk reaches the database without the landlord seeing it first and
 * pressing a button that names the number.
 */
type Method = 'one' | 'generate' | 'import';
type Step = 'method' | 'compose' | 'review';
/** Import has two doors onto the same pipeline: paste it, or upload it. */
type ImportSource = 'paste' | 'file';

const METHODS: CreationMethod<Method>[] = [
  {
    id: 'one',
    icon: DoorOpen,
    title: 'Add one unit',
    description: 'A single unit, entered by hand.',
    accent: '#137fec',
  },
  {
    id: 'generate',
    icon: Wand2,
    title: 'Generate units',
    description: 'Many units from a numbering pattern — a range, floors, or a prefix.',
    accent: '#a855f7',
  },
  {
    id: 'import',
    icon: ClipboardList,
    title: 'Import units',
    description: 'Paste an existing list, or upload a CSV.',
    accent: '#f59e0b',
  },
];

export interface AddUnitsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  properties: Property[];
  /** Pre-selects the destination when opened from a specific property's card. */
  initialPropertyId?: string;
  /** Called after units are created, so the page can refetch. */
  onCreated: () => void | Promise<void>;
}

export default function AddUnitsDialog({
  open,
  onOpenChange,
  properties,
  initialPropertyId,
  onCreated,
}: AddUnitsDialogProps) {
  const [step, setStep] = useState<Step>('method');
  const [method, setMethod] = useState<Method | null>(null);
  const [propertyId, setPropertyId] = useState(initialPropertyId || '');
  const [singleName, setSingleName] = useState('');
  const [singleNameError, setSingleNameError] = useState('');
  const [pasted, setPasted] = useState('');
  const [importSource, setImportSource] = useState<ImportSource>('paste');
  const [proposed, setProposed] = useState<ProposedUnit[]>([]);
  const [busy, setBusy] = useState(false);
  // Per-row verdicts the server sent back with a 422. They outrank the local
  // check until the landlord edits again — the server is the one that knows.
  const [serverRows, setServerRows] = useState<UnitBatchResult['rows'] | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('method');
    setMethod(null);
    setPropertyId(initialPropertyId || '');
    setSingleName('');
    setSingleNameError('');
    setPasted('');
    setImportSource('paste');
    setProposed([]);
    setServerRows(null);
    setBusy(false);
  }, [open, initialPropertyId]);

  const property = properties.find((candidate) => candidate._id === propertyId) || null;

  const review = useMemo(
    () => reviewProposedUnits(proposed, existingIdentifiers(property?.units)),
    [proposed, property]
  );

  // Merge in whatever the server objected to, keyed by position.
  const merged = useMemo(() => {
    if (!serverRows) return review;
    const rows = review.rows.map((row, index) => {
      const fromServer = serverRows[index];
      if (!fromServer || fromServer.valid || row.name !== fromServer.name) return row;
      return { ...row, valid: false, errors: fromServer.errors };
    });
    const invalid = rows.filter((row) => !row.valid).length;
    return {
      rows,
      summary: { ...review.summary, invalid, valid: rows.length - invalid },
      valid: invalid === 0 && rows.length > 0,
    };
  }, [review, serverRows]);

  const goToReview = (names: string[]) => {
    if (names.length === 0) {
      toast.error('Nothing to add yet');
      return;
    }
    setProposed(toProposedUnits(names));
    setServerRows(null);
    setStep('review');
  };

  const createSingle = async () => {
    // The property is chosen before this form can be reached, so the unit
    // name is the only thing left to be missing.
    if (!propertyId) return;
    if (!singleName.trim()) {
      setSingleNameError('Enter a unit name, e.g. 4B.');
      return;
    }
    setBusy(true);
    try {
      await LandlordAPI.createUnit({ propertyId, unitNumber: singleName.trim() });
      await onCreated();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create unit');
    } finally {
      setBusy(false);
    }
  };

  const createBatch = async () => {
    if (!propertyId) return;
    setBusy(true);
    try {
      const units = merged.rows.map((row) => ({ name: row.name }));
      const response = await LandlordAPI.createUnits(propertyId, units);
      const created = response.data?.summary.created ?? units.length;
      toast.success(`Created ${created} unit${created === 1 ? '' : 's'}`);
      await onCreated();
      onOpenChange(false);
    } catch (error) {
      // A 422 is not a failure to report and forget — it is the server telling
      // the review table exactly which rows to mark, so the landlord can fix
      // them in place instead of starting over.
      const payload =
        error instanceof ApiError ? (error.payload as { data?: UnitBatchResult } | null) : null;
      if (payload?.data?.rows) {
        setServerRows(payload.data.rows);
        toast.error(`${payload.data.summary.invalid} unit(s) need attention`);
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to create units');
      }
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (step === 'review') setStep('compose');
    else if (step === 'compose') setStep('method');
  };

  const title = step === 'review' ? 'Review units' : 'Add units';
  const description =
    step === 'method'
      ? 'Pick how you want to add units to this property.'
      : step === 'review'
        ? 'Check the list before anything is created. Nothing is saved until you confirm.'
        : method === 'one'
          ? 'One unit, one name.'
          : method === 'generate'
            ? 'Describe the numbering and check the preview before reviewing.'
            : 'Bring a list you already have — paste it, or upload a CSV.';

  return (
    <FormDialog presentation
      open={open}
      onOpenChange={onOpenChange}
      icon={DoorOpen}
      iconColor="#a855f7"
      title={title}
      description={description}
      className={step === 'review' ? 'sm:max-w-2xl' : undefined}
    >
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <FieldLabel>Property</FieldLabel>
          <select
            data-testid="add-units-property"
            value={propertyId}
            disabled={busy || step === 'review'}
            onChange={(event) => setPropertyId(event.target.value)}
            className={fieldClass}
          >
            <option value="">Select property...</option>
            {properties.map((candidate) => (
              <option key={candidate._id} value={candidate._id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        {step === 'method' ? (
          <CreationMethodPicker
            methods={METHODS}
            disabled={!propertyId}
            hint={propertyId ? undefined : 'Choose a property first.'}
            onSelect={(id) => {
              setMethod(id);
              setStep('compose');
            }}
          />
        ) : null}

        {step === 'compose' && method === 'one' ? (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <FieldLabel>Unit name</FieldLabel>
              <Input
                data-testid="new-unit-number"
                className={`h-10 bg-white  lichen:bg-card ${singleNameError ? invalidFieldClass : ''}`}
                placeholder="e.g. 4B"
                value={singleName}
                disabled={busy}
                aria-invalid={Boolean(singleNameError)}
                aria-describedby={singleNameError ? 'new-unit-number-error' : undefined}
                onChange={(event) => {
                  setSingleName(event.target.value);
                  setSingleNameError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createSingle();
                }}
              />
              <FieldError id="new-unit-number-error">{singleNameError}</FieldError>
            </label>
            <Button
              data-testid="create-unit-btn"
              disabled={busy}
              onClick={() => void createSingle()}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90 lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Create Unit
            </Button>
          </div>
        ) : null}

        {step === 'compose' && method === 'generate' ? (
          <UnitGeneratorForm onGenerated={goToReview} />
        ) : null}

        {step === 'compose' && method === 'import' ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {(['paste', 'file'] as ImportSource[]).map((source) => {
                const active = importSource === source;
                return (
                  <button
                    key={source}
                    type="button"
                    data-testid={`import-source-${source}`}
                    aria-pressed={active}
                    onClick={() => setImportSource(source)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                      active
                        ? 'bg-slate-900 text-white'
                        : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 lichen:border-hairline lichen:bg-card lichen:text-meta lichen:hover:border-hairline"
                    }`}
                  >
                    {source === 'paste' ? 'Paste a list' : 'Upload a CSV'}
                  </button>
                );
              })}
            </div>

            {importSource === 'file' ? <UnitFileImport onParsed={goToReview} /> : null}

            <div className={importSource === 'paste' ? 'space-y-4' : 'hidden'}>
            <label className="block space-y-1.5">
              <FieldLabel>Unit names</FieldLabel>
              <Textarea
                data-testid="paste-units"
                rows={8}
                className="min-h-[9rem] bg-white font-mono text-sm lichen:bg-card"
                placeholder={'A1\nA2\nPH1\nG01\n\nor: A1, A2, A3'}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
              />
            </label>
            <p className="text-xs text-slate-400 lichen:text-meta">
              {parsePastedUnits(pasted).length} unit
              {parsePastedUnits(pasted).length === 1 ? '' : 's'} detected. Names are kept exactly as
              written.
            </p>
            <Button
              data-testid="review-pasted-units"
              disabled={parsePastedUnits(pasted).length === 0}
              onClick={() => goToReview(parsePastedUnits(pasted))}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90 lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
            >
              Review units
            </Button>
            </div>
          </div>
        ) : null}

        {step === 'review' ? (
          <div className="space-y-4">
            <UnitReviewTable
              rows={proposed}
              review={merged}
              busy={busy}
              onChange={(rows) => {
                setProposed(rows);
                // The landlord has moved on from whatever the server objected to.
                setServerRows(null);
              }}
            />

            {merged.summary.invalid > 0 ? (
              <p
                role="status"
                className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 lichen:rounded-lg lichen:border-alert-line lichen:bg-alert-tint lichen:text-alert-text"
              >
                {merged.summary.invalid} of {merged.summary.total} units need attention before
                anything can be created.
              </p>
            ) : null}

            <Button
              data-testid="create-units-btn"
              disabled={busy || !merged.valid}
              onClick={() => void createBatch()}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90 lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Create {merged.summary.total} unit{merged.summary.total === 1 ? '' : 's'}
            </Button>
          </div>
        ) : null}

        {step !== 'method' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={back}
            className="h-8 px-2 text-slate-500 hover:text-slate-900 lichen:text-meta lichen:hover:text-ink"
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back
          </Button>
        ) : null}
      </div>
    </FormDialog>
  );
}
