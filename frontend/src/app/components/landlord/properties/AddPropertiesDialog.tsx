import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Building2, FileSpreadsheet, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI } from '../../../api/client';
import type { PortfolioBatchResult, Property } from '../../../types/landlord';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { FieldError, invalidFieldClass } from '../../ui/FieldError';
import { FieldLabel, FormDialog } from '../landlordUi';
import CreationMethodPicker, { type CreationMethod } from '../CreationMethodPicker';
import UnitFileImport from '../units/UnitFileImport';
import type { ParsedUnitFile } from '../units/unitFileParser';
import PortfolioReview from './PortfolioReview';
import {
  existingPropertyNames,
  groupImportedRows,
  reviewProposedPortfolio,
  toImportPayload,
  type ProposedProperty,
} from './proposedPortfolio';

/**
 * "Add properties" — the same funnel as "Add units", one level up.
 *
 * A landlord with one building still gets a two-field form and one button; the
 * picker costs them a single click and keeps the portfolio importer out of
 * their way. A landlord with twelve buildings and 438 units gets a file upload
 * instead of 450 forms.
 *
 *   add one ──────────────────────────────→ POST /properties
 *   CSV ──→ grouped → review → validate → confirm → POST /properties/import
 *
 * The parse, the review table for units, and the validation rules are all the
 * ones the unit pipeline already uses. This file adds the property layer over
 * them and nothing else.
 */
type Method = 'one' | 'portfolio';
type Step = 'method' | 'compose' | 'review';

const METHODS: CreationMethod<Method>[] = [
  {
    id: 'one',
    icon: Building2,
    title: 'Add one property',
    description: 'A single property, entered by hand.',
    accent: '#137fec',
  },
  {
    id: 'portfolio',
    icon: FileSpreadsheet,
    title: 'Import a portfolio',
    description: 'Upload a CSV of properties and their units, all at once.',
    accent: '#a855f7',
  },
];

const SAMPLE_CSV = `Property Name,Address,Unit
Maple Apartments,123 Main St,101
Maple Apartments,123 Main St,102
Oak Tower,98 Oak Ave,PH1`;

export interface AddPropertiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing properties, for the name-collision check. */
  properties: Property[];
  onCreated: () => void | Promise<void>;
}

export default function AddPropertiesDialog({
  open,
  onOpenChange,
  properties,
  onCreated,
}: AddPropertiesDialogProps) {
  const [step, setStep] = useState<Step>('method');
  const [method, setMethod] = useState<Method | null>(null);
  const [single, setSingle] = useState({ name: '', address: '' });
  const [singleErrors, setSingleErrors] = useState<{ name?: string; address?: string }>({});
  const [proposed, setProposed] = useState<ProposedProperty[]>([]);
  const [busy, setBusy] = useState(false);
  const [serverRows, setServerRows] = useState<PortfolioBatchResult['properties'] | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('method');
    setMethod(null);
    setSingle({ name: '', address: '' });
    setSingleErrors({});
    setProposed([]);
    setServerRows(null);
    setBusy(false);
  }, [open]);

  const review = useMemo(
    () => reviewProposedPortfolio(proposed, existingPropertyNames(properties)),
    [proposed, properties]
  );

  // Whatever the server objected to outranks the local check, by position,
  // until the landlord edits again.
  const merged = useMemo(() => {
    if (!serverRows) return review;
    const rows = review.properties.map((property, index) => {
      const fromServer = serverRows[index];
      if (!fromServer || fromServer.valid || property.name !== fromServer.name) return property;
      return { ...property, valid: false, errors: fromServer.errors };
    });
    const invalid = rows.filter((property) => !property.valid).length;
    return {
      properties: rows,
      summary: {
        ...review.summary,
        invalidProperties: invalid,
        validProperties: rows.length - invalid,
      },
      valid: invalid === 0 && rows.length > 0,
    };
  }, [review, serverRows]);

  const onFileParsed = (_units: string[], parsed: ParsedUnitFile) => {
    if (!parsed.hasPropertyColumn) {
      toast.error('That file has no property column — add "Property Name" and "Address".');
      return;
    }
    setProposed(groupImportedRows(parsed.rows));
    setServerRows(null);
    setStep('review');
  };

  const createSingle = async () => {
    const errors = {
      name: single.name.trim() ? undefined : 'Enter a property name.',
      address: single.address.trim() ? undefined : 'Enter the street address.',
    };
    setSingleErrors(errors);
    if (errors.name || errors.address) return;
    setBusy(true);
    try {
      await LandlordAPI.createProperty({
        name: single.name.trim(),
        address: single.address.trim(),
      });
      await onCreated();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const importPortfolio = async () => {
    setBusy(true);
    try {
      const response = await LandlordAPI.importPortfolio(toImportPayload(proposed));
      const summary = response.data?.summary;
      toast.success(
        `Created ${summary?.propertiesCreated ?? proposed.length} properties and ${
          summary?.unitsCreated ?? merged.summary.units
        } units`
      );
      await onCreated();
      onOpenChange(false);
    } catch (error) {
      const payload =
        error instanceof ApiError
          ? (error.payload as { data?: PortfolioBatchResult } | null)
          : null;
      if (payload?.data?.properties) {
        setServerRows(payload.data.properties);
        toast.error(`${payload.data.summary.invalidProperties} propert${
          payload.data.summary.invalidProperties === 1 ? 'y needs' : 'ies need'
        } attention`);
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to import portfolio');
      }
    } finally {
      setBusy(false);
    }
  };

  const title = step === 'review' ? 'Review portfolio' : 'Add properties';
  const description =
    step === 'method'
      ? 'Add one property, or bring a whole portfolio in at once.'
      : step === 'review'
        ? 'Check the list before anything is created. Nothing is saved until you confirm.'
        : method === 'one'
          ? 'A name and an address is all a property needs.'
          : 'Upload a CSV with a property, address and unit column.';

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={Building2}
      title={title}
      description={description}
      className={step === 'review' ? 'sm:max-w-2xl' : undefined}
    >
      <div className="space-y-4">
        {step === 'method' ? (
          <CreationMethodPicker
            methods={METHODS}
            onSelect={(id) => {
              setMethod(id);
              setStep('compose');
            }}
          />
        ) : null}

        {step === 'compose' && method === 'one' ? (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <FieldLabel>Name</FieldLabel>
              <Input
                data-testid="new-property-name"
                className={`h-10 bg-white ${singleErrors.name ? invalidFieldClass : ''}`}
                value={single.name}
                disabled={busy}
                aria-invalid={Boolean(singleErrors.name)}
                aria-describedby={singleErrors.name ? 'new-property-name-error' : undefined}
                onChange={(event) => {
                  setSingle({ ...single, name: event.target.value });
                  setSingleErrors((prev) => ({ ...prev, name: undefined }));
                }}
                placeholder="Northgate Apartments"
              />
              <FieldError id="new-property-name-error">{singleErrors.name}</FieldError>
            </label>
            <label className="block space-y-1.5">
              <FieldLabel>Address</FieldLabel>
              <Input
                data-testid="new-property-address"
                className={`h-10 bg-white ${singleErrors.address ? invalidFieldClass : ''}`}
                value={single.address}
                disabled={busy}
                aria-invalid={Boolean(singleErrors.address)}
                aria-describedby={singleErrors.address ? 'new-property-address-error' : undefined}
                onChange={(event) => {
                  setSingle({ ...single, address: event.target.value });
                  setSingleErrors((prev) => ({ ...prev, address: undefined }));
                }}
                placeholder="123 Main Street"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createSingle();
                }}
              />
              <FieldError id="new-property-address-error">{singleErrors.address}</FieldError>
            </label>
            <Button
              data-testid="create-property-btn"
              disabled={busy}
              onClick={() => void createSingle()}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90"
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Create Property
            </Button>
          </div>
        ) : null}

        {step === 'compose' && method === 'portfolio' ? (
          <div className="space-y-3">
            <UnitFileImport mode="portfolio" onParsed={onFileParsed} />
            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <FieldLabel>Expected shape</FieldLabel>
              <pre className="mt-1.5 overflow-x-auto text-xs leading-relaxed text-slate-600">
                {SAMPLE_CSV}
              </pre>
            </div>
          </div>
        ) : null}

        {step === 'review' ? (
          <div className="space-y-4">
            <PortfolioReview
              properties={proposed}
              review={merged}
              busy={busy}
              onChange={(next) => {
                setProposed(next);
                setServerRows(null);
              }}
            />
            <Button
              data-testid="import-portfolio-btn"
              disabled={busy || !merged.valid}
              onClick={() => void importPortfolio()}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90"
            >
              {busy ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-1 h-4 w-4" />
              )}
              Create {merged.summary.properties} propert
              {merged.summary.properties === 1 ? 'y' : 'ies'} and {merged.summary.units} unit
              {merged.summary.units === 1 ? '' : 's'}
            </Button>
          </div>
        ) : null}

        {step !== 'method' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setStep(step === 'review' ? 'compose' : 'method')}
            className="h-8 px-2 text-slate-500 hover:text-slate-900"
          >
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back
          </Button>
        ) : null}
      </div>
    </FormDialog>
  );
}
