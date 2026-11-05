import { REMAINDER_PORTAL } from '../remainderPresentation';
import { D3_FIELD } from '../../request-detail/d3Presentation';
import { D3FormDialog, D3_PORTAL, useD3Presentation } from '../../request-detail/d3Presentation';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Check, HardHat, Loader2, Pencil, Plus, ShieldCheck, Siren, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI } from '../../../api/client';
import type { VendorItem } from '../../../types/landlord';
import { Button } from '../../ui/button';
import { FieldError, invalidFieldClass } from '../../ui/FieldError';
import { Input } from '../../ui/input';
import { FieldLabel } from '../landlordUi';
import { DAY_LABELS, WEEK_ORDER, validateHours, type DayHours, type HoursPreset } from './vendorHours';
import { MAX_CUSTOM_LENGTH, MAX_CUSTOM_SPECIALTIES, SPECIALTY_OPTIONS, matchPreset } from './vendorSpecialties';

type DayRow = { enabled: boolean; open: string; close: string };

interface FormState {
  name: string;
  company: string;
  email: string;
  phone: string;
  city: string;
  serviceAreas: string;
  specialties: string[];
  customSpecialties: string[];
  hoursPreset: HoursPreset | '';
  days: Record<number, DayRow>;
  emergencyAvailable: boolean;
  trusted: boolean;
}

type FieldKey = 'name' | 'email' | 'phone' | 'operatingHours' | 'customSpecialties';
type Errors = Partial<Record<FieldKey, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const defaultDays = (): Record<number, DayRow> =>
  Object.fromEntries(
    [0, 1, 2, 3, 4, 5, 6].map((day) => [day, { enabled: day >= 1 && day <= 5, open: '09:00', close: '17:00' }])
  );

function fromVendor(vendor: VendorItem | null): FormState {
  const days = defaultDays();
  if (vendor?.operatingHours?.preset === 'custom') {
    for (const day of Object.keys(days)) days[Number(day)].enabled = false;
    for (const row of vendor.operatingHours.weekly) days[row.day] = { enabled: true, open: row.open, close: row.close };
  }
  return {
    name: vendor?.name || '',
    company: vendor?.company || '',
    email: vendor?.email || '',
    phone: vendor?.phone || '',
    city: vendor?.city || '',
    serviceAreas: (vendor?.serviceAreas || []).join(', '),
    specialties: vendor?.specialties || [],
    customSpecialties: vendor?.customSpecialties || [],
    // A vendor from before hours were required has none: leave the choice
    // empty rather than quietly asserting 9-5 on the landlord's behalf.
    hoursPreset: vendor?.operatingHours?.preset || '',
    days,
    emergencyAvailable: Boolean(vendor?.emergencyAvailable),
    trusted: vendor?.verificationStatus === 'trusted',
  };
}

function weeklyFrom(days: Record<number, DayRow>): DayHours[] {
  return WEEK_ORDER.filter((day) => days[day].enabled).map((day) => ({
    day,
    open: days[day].open,
    close: days[day].close,
  }));
}

function validate(form: FormState): Errors {
  const errors: Errors = {};
  if (!form.name.trim()) errors.name = "Enter the vendor's name.";
  const email = form.email.trim();
  if (!email) errors.email = 'Enter an email address. Job offers are sent by email.';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
  const phone = form.phone.trim();
  if (phone) {
    const digits = phone.replace(/\D/g, '').length;
    if (!/^[+\d\s().-]+$/.test(phone) || digits < 7 || digits > 15) {
      errors.phone = 'Enter a valid phone number, or leave it blank.';
    }
  }
  const hoursError = validateHours(
    form.hoursPreset ? { preset: form.hoursPreset, weekly: weeklyFrom(form.days) } : null
  );
  if (hoursError) errors.operatingHours = hoursError;
  return errors;
}

const PRESET_OPTIONS: { id: HoursPreset; label: string; hint: string }[] = [
  { id: 'weekdays', label: 'Weekdays', hint: 'Mon–Fri, 9–5' },
  { id: 'always', label: '24/7', hint: 'Any day, any time' },
  { id: 'custom', label: 'Custom', hint: 'Set each day' },
];

/**
 * Create or edit a vendor. Email and hours are required -- job offers go out
 * by email, and hours are what lets a landlord (and later the router) know
 * who can actually be called. Errors sit under their field; the server's
 * per-field 400 lands in the same place.
 */
export default function VendorFormDialog({
  open,
  onOpenChange,
  vendor,
  onSaved,
  presentation = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null to create, a vendor to edit. */
  vendor: VendorItem | null;
  onSaved: () => Promise<void> | void;
  presentation?: boolean;
}) {
  const d3 = useD3Presentation();
  const [form, setForm] = useState<FormState>(() => fromVendor(vendor));
  const [errors, setErrors] = useState<Errors>({});
  const [customDraft, setCustomDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(fromVendor(vendor));
    setErrors({});
    setCustomDraft('');
    setBusy(false);
  }, [open, vendor]);

  const editing = Boolean(vendor);
  const update = (patch: Partial<FormState>, clear?: FieldKey) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (clear) setErrors((prev) => ({ ...prev, [clear]: undefined }));
  };

  // Functional updates throughout: deriving the next list from the render's
  // `form` drops all but the last of several quick clicks.
  const togglePreset = (specialty: string) =>
    setForm((prev) => ({
      ...prev,
      specialties: prev.specialties.includes(specialty)
        ? prev.specialties.filter((value) => value !== specialty)
        : [...prev.specialties, specialty],
    }));

  const addCustom = () => {
    const value = customDraft.trim();
    if (!value) return;
    // Typing a preset's name just selects the preset.
    const preset = matchPreset(value);
    if (preset) {
      if (!form.specialties.includes(preset)) update({ specialties: [...form.specialties, preset] });
      setCustomDraft('');
      return;
    }
    if (value.length > MAX_CUSTOM_LENGTH) {
      setErrors((prev) => ({ ...prev, customSpecialties: `Keep each specialty under ${MAX_CUSTOM_LENGTH} characters.` }));
      return;
    }
    if (form.customSpecialties.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
      setCustomDraft('');
      return;
    }
    if (form.customSpecialties.length >= MAX_CUSTOM_SPECIALTIES) {
      setErrors((prev) => ({ ...prev, customSpecialties: `Add at most ${MAX_CUSTOM_SPECIALTIES} other specialties.` }));
      return;
    }
    update({ customSpecialties: [...form.customSpecialties, value] }, 'customSpecialties');
    setCustomDraft('');
  };

  const onCustomKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addCustom();
    }
  };

  const setDay = (day: number, patch: Partial<DayRow>) => {
    setForm((prev) => ({ ...prev, days: { ...prev.days, [day]: { ...prev.days[day], ...patch } } }));
    setErrors((prev) => ({ ...prev, operatingHours: undefined }));
  };

  const submit = async () => {
    const found = validate(form);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;

    const body = {
      name: form.name.trim(),
      company: form.company.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      city: form.city.trim(),
      serviceAreas: form.serviceAreas
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
      specialties: form.specialties,
      customSpecialties: form.customSpecialties,
      operatingHours:
        form.hoursPreset === 'custom'
          ? { preset: 'custom', weekly: weeklyFrom(form.days) }
          : { preset: form.hoursPreset },
      emergencyAvailable: form.emergencyAvailable,
      trusted: form.trusted,
    };

    setBusy(true);
    try {
      if (vendor) await LandlordAPI.updateVendor(vendor._id, body);
      else await LandlordAPI.createVendor(body);
      await onSaved();
      onOpenChange(false);
    } catch (error) {
      const fields = error instanceof ApiError ? (error.payload as { fields?: Errors } | null)?.fields : null;
      if (fields && Object.keys(fields).length) setErrors(fields);
      else toast.error(error instanceof Error ? error.message : 'Could not save this vendor');
    } finally {
      setBusy(false);
    }
  };

  const fieldProps = (key: FieldKey, testId: string) => ({
    'data-testid': testId,
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': errors[key] ? `${testId}-error` : undefined,
    className: `h-10 bg-white  lichen:bg-card ${D3_FIELD} ${errors[key] ? invalidFieldClass : ''}`,
  });

  return (
    <D3FormDialog presentation={presentation}
      open={open}
      onOpenChange={onOpenChange}
      icon={editing ? Pencil : HardHat}
      title={editing ? `Edit ${vendor?.name}` : 'Add vendor'}
      description={editing ? 'Update this contractor’s details.' : 'Save a contractor to your network.'}
      className={`${presentation ? REMAINDER_PORTAL : ''} max-h-[92vh] overflow-y-auto sm:max-w-xl ${d3 ? `${D3_PORTAL} [&_[data-slot=dialog-header]_.h-10]:rounded-md [&_[data-slot=dialog-header]_.h-10]:bg-chip! [&_[data-slot=dialog-header]_.h-10]:text-chip-icon!` : ''}`}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">
              Name <span className="text-rose-500 in-[.lichen-d3]:text-alert-text lichen:text-alert-text">*</span>
            </FieldLabel>
            <Input
              {...fieldProps('name', 'new-vendor-name')}
              placeholder="Jane Doe"
              value={form.name}
              onChange={(event) => update({ name: event.target.value }, 'name')}
            />
            <FieldError id="new-vendor-name-error">{errors.name}</FieldError>
          </label>
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">Company</FieldLabel>
            <Input
              data-testid="new-vendor-company"
              className={["h-10 bg-white in-[.lichen-d3]:bg-card lichen:bg-card", D3_FIELD].join(' ')}
              placeholder="Acme Plumbing"
              value={form.company}
              onChange={(event) => update({ company: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">
              Email <span className="text-rose-500 in-[.lichen-d3]:text-alert-text lichen:text-alert-text">*</span>
            </FieldLabel>
            <Input
              {...fieldProps('email', 'new-vendor-email')}
              type="email"
              placeholder="jane@acme.com"
              value={form.email}
              onChange={(event) => update({ email: event.target.value }, 'email')}
            />
            <FieldError id="new-vendor-email-error">{errors.email}</FieldError>
          </label>
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">
              Phone <span className="font-normal normal-case tracking-normal text-slate-400 in-[.lichen-d3]:text-meta lichen:tracking-normal lichen:text-meta">(optional)</span>
            </FieldLabel>
            <Input
              {...fieldProps('phone', 'new-vendor-phone')}
              type="tel"
              placeholder="(555) 123-4567"
              value={form.phone}
              onChange={(event) => update({ phone: event.target.value }, 'phone')}
            />
            <FieldError id="new-vendor-phone-error">{errors.phone}</FieldError>
          </label>
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">City</FieldLabel>
            <Input
              data-testid="new-vendor-city"
              className={["h-10 bg-white in-[.lichen-d3]:bg-card lichen:bg-card", D3_FIELD].join(' ')}
              placeholder="Calgary"
              value={form.city}
              onChange={(event) => update({ city: event.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <FieldLabel className="in-[.lichen-d3]:text-meta">Service areas</FieldLabel>
            <Input
              data-testid="new-vendor-service-areas"
              className={["h-10 bg-white in-[.lichen-d3]:bg-card lichen:bg-card", D3_FIELD].join(' ')}
              placeholder="Downtown, Beltline"
              value={form.serviceAreas}
              onChange={(event) => update({ serviceAreas: event.target.value })}
            />
          </label>
        </div>

        {/* Hours of operation */}
        <fieldset className="space-y-2" aria-describedby={errors.operatingHours ? 'vendor-hours-error' : undefined}>
          <legend className="mb-2">
            <FieldLabel className="in-[.lichen-d3]:text-meta">
              Hours of operation <span className="text-rose-500 in-[.lichen-d3]:text-alert-text lichen:text-alert-text">*</span>
            </FieldLabel>
          </legend>
          <div
            role="radiogroup"
            data-testid="vendor-hours-preset"
            className={`grid grid-cols-3 gap-2 rounded-xl in-[.lichen-d3]:rounded-lg  lichen:rounded-lg ${errors.operatingHours ? 'ring-1 ring-rose-300 ring-offset-2' : ''}`}
          >
            {PRESET_OPTIONS.map((option) => {
              const active = form.hoursPreset === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`vendor-hours-${option.id}`}
                  onClick={() => update({ hoursPreset: option.id }, 'operatingHours')}
                  className={`rounded-xl border px-3 py-2.5 text-left transition in-[.lichen-d3]:rounded-lg  lichen:rounded-lg ${
                    active
                      ? "border-[#137fec] bg-[#137fec]/5 shadow-sm in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:shadow-none lichen:border-lichen-line lichen:bg-chip lichen:shadow-lichen-card"
                      : "border-slate-200 bg-white hover:border-slate-300 in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:border-control-border lichen:border-hairline lichen:bg-card lichen:hover:border-hairline"
                  }`}
                >
                  <div className={`text-sm font-semibold ${active ? "text-[#137fec] in-[.lichen-d3]:text-lichen-text lichen:text-lichen-text" : "text-slate-800 in-[.lichen-d3]:text-ink lichen:text-ink"}`}>
                    {option.label}
                  </div>
                  <div className="text-[11px] text-slate-500 in-[.lichen-d3]:text-meta lichen:text-xs lichen:text-meta">{option.hint}</div>
                </button>
              );
            })}
          </div>
          {form.hoursPreset === 'custom' ? (
            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white in-[.lichen-d3]:divide-hairline in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card lichen:divide-hairline lichen:rounded-lg lichen:border-hairline lichen:bg-card" data-testid="vendor-hours-days">
              {WEEK_ORDER.map((day) => {
                const row = form.days[day];
                return (
                  <div key={day} className="flex items-center gap-3 px-3 py-2">
                    <label className="flex w-20 shrink-0 items-center gap-2 text-sm text-slate-700 in-[.lichen-d3]:text-ink lichen:text-ink">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(event) => setDay(day, { enabled: event.target.checked })}
                        className="h-4 w-4 rounded border-slate-300 accent-[#137fec] in-[.lichen-d3]:border-control-border in-[.lichen-d3]:accent-lichen-text lichen:border-hairline"
                        aria-label={`Works on ${DAY_LABELS[day]}`}
                      />
                      {DAY_LABELS[day]}
                    </label>
                    {row.enabled ? (
                      <div className="flex items-center gap-2 text-sm">
                        <input
                          type="time"
                          value={row.open}
                          onChange={(event) => setDay(day, { open: event.target.value })}
                          aria-label={`${DAY_LABELS[day]} opens`}
                          className={["h-8 rounded-md border border-slate-200 px-2 text-slate-800 in-[.lichen-d3]:border-border in-[.lichen-d3]:text-ink lichen:border-hairline lichen:text-ink", D3_FIELD].join(' ')}
                        />
                        <span className="text-slate-400 in-[.lichen-d3]:text-meta lichen:text-meta">to</span>
                        <input
                          type="time"
                          value={row.close}
                          onChange={(event) => setDay(day, { close: event.target.value })}
                          aria-label={`${DAY_LABELS[day]} closes`}
                          className={["h-8 rounded-md border border-slate-200 px-2 text-slate-800 in-[.lichen-d3]:border-border in-[.lichen-d3]:text-ink lichen:border-hairline lichen:text-ink", D3_FIELD].join(' ')}
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400 in-[.lichen-d3]:text-meta lichen:text-meta">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
          <FieldError id="vendor-hours-error">{errors.operatingHours}</FieldError>
        </fieldset>

        {/* Specialties */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <FieldLabel className="in-[.lichen-d3]:text-meta">Specialties</FieldLabel>
            <span className="text-[11px] text-slate-400 in-[.lichen-d3]:text-meta lichen:text-xs lichen:text-meta">Select all that apply</span>
          </div>
          <div className="flex flex-wrap gap-2" data-testid="new-vendor-specialties">
            {SPECIALTY_OPTIONS.map((specialty) => {
              const active = form.specialties.includes(specialty);
              return (
                <button
                  key={specialty}
                  type="button"
                  aria-pressed={active}
                  onClick={() => togglePreset(specialty)}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? "border-transparent bg-[#137fec] text-white shadow-sm shadow-[#137fec]/25 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:shadow-none in-[.lichen-d3]:text-primary-foreground lichen:bg-primary lichen:shadow-lichen-card lichen:text-primary-foreground"
                      : "border-slate-200 bg-white text-slate-600 hover:border-[#137fec]/40 hover:text-[#137fec] in-[.lichen-d3]:border-border in-[.lichen-d3]:bg-card in-[.lichen-d3]:text-meta in-[.lichen-d3]:hover:border-control-border in-[.lichen-d3]:hover:text-lichen-text lichen:border-hairline lichen:bg-card lichen:text-meta lichen:hover:border-lichen-line lichen:hover:text-lichen-text"
                  }`}
                >
                  {active ? <Check className="h-3 w-3" /> : null}
                  {specialty}
                </button>
              );
            })}
            {form.customSpecialties.map((specialty) => (
              <span
                key={specialty}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-[#137fec]/50 bg-[#137fec]/5 py-1.5 pl-3 pr-1.5 text-xs font-medium text-[#137fec] in-[.lichen-d3]:border-control-border in-[.lichen-d3]:bg-lichen-tint in-[.lichen-d3]:text-lichen-text lichen:border-lichen-line lichen:bg-chip lichen:text-lichen-text"
              >
                {specialty}
                <button
                  type="button"
                  aria-label={`Remove ${specialty}`}
                  onClick={() => {
                    setForm((prev) => ({
                      ...prev,
                      customSpecialties: prev.customSpecialties.filter((value) => value !== specialty),
                    }));
                    setErrors((prev) => ({ ...prev, customSpecialties: undefined }));
                  }}
                  className="rounded-full p-0.5 hover:bg-[#137fec]/10 in-[.lichen-d3]:hover:bg-lichen-tint lichen:hover:bg-chip"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              data-testid="new-vendor-custom-specialty"
              className={[`h-9 bg-white text-sm in-[.lichen-d3]:bg-card  lichen:bg-card ${errors.customSpecialties ? invalidFieldClass : ''}`, D3_FIELD].join(' ')}
              placeholder="Other specialty, e.g. Backflow testing"
              value={customDraft}
              maxLength={MAX_CUSTOM_LENGTH + 10}
              aria-invalid={Boolean(errors.customSpecialties)}
              aria-describedby={errors.customSpecialties ? 'new-vendor-custom-specialty-error' : undefined}
              onChange={(event) => {
                setCustomDraft(event.target.value);
                setErrors((prev) => ({ ...prev, customSpecialties: undefined }));
              }}
              onKeyDown={onCustomKey}
            />
            <Button
              type="button"
              variant="outline"
              data-testid="add-custom-specialty"
              className="h-9 shrink-0"
              disabled={!customDraft.trim()}
              onClick={addCustom}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add
            </Button>
          </div>
          <FieldError id="new-vendor-custom-specialty-error">{errors.customSpecialties}</FieldError>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={form.emergencyAvailable}
          data-testid="new-vendor-emergency"
          onClick={() => setForm((prev) => ({ ...prev, emergencyAvailable: !prev.emergencyAvailable }))}
          className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-100 bg-white px-4 py-3 text-left transition hover:border-[#137fec]/30 hover:bg-slate-50/60 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:bg-well in-[.lichen-d3]:hover:border-control-border lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:hover:border-lichen-line lichen:hover:bg-well"
        >
          <span>
            <span className="flex items-center gap-2 text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink lichen:text-ink">
              <Siren className="h-4 w-4 text-rose-500 in-[.lichen-d3]:text-alert-text lichen:text-alert-text" />
              Emergency ready
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 in-[.lichen-d3]:text-meta lichen:text-meta">Takes urgent, after-hours calls.</span>
          </span>
          <span
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition in-[.lichen-d3]:h-[24px] in-[.lichen-d3]:w-[44px] ${
              form.emergencyAvailable ? "bg-[#137fec] in-[.lichen-d3]:bg-lichen-text lichen:bg-primary lichen:text-primary-foreground" : "bg-slate-200 in-[.lichen-d3]:bg-control-border lichen:bg-chip"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition in-[.lichen-d3]:bg-card in-[.lichen-d3]:h-[20px] in-[.lichen-d3]:w-[20px]  lichen:bg-card lichen:shadow-lichen-card ${
                form.emergencyAvailable ? 'translate-x-[22px]' : 'translate-x-0.5 in-[.lichen-d3]:translate-x-[2px]'
              }`}
            />
          </span>
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={form.trusted}
          data-testid="new-vendor-trusted"
          onClick={() => setForm((prev) => ({ ...prev, trusted: !prev.trusted }))}
          className="flex w-full items-center justify-between gap-4 rounded-xl border border-slate-100 bg-white px-4 py-3 text-left transition hover:border-[#137fec]/30 hover:bg-slate-50/60 in-[.lichen-d3]:rounded-lg in-[.lichen-d3]:border-hairline in-[.lichen-d3]:bg-card in-[.lichen-d3]:hover:bg-well in-[.lichen-d3]:hover:border-control-border lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:hover:border-lichen-line lichen:hover:bg-well"
        >
          <span>
            <span className="flex items-center gap-2 text-sm font-medium text-slate-800 in-[.lichen-d3]:text-ink lichen:text-ink">
              <ShieldCheck className="h-4 w-4 text-emerald-600 in-[.lichen-d3]:text-mist-text lichen:text-mist-text" />
              Trusted vendor
            </span>
            <span className="mt-0.5 block text-xs text-slate-500 in-[.lichen-d3]:text-meta lichen:text-meta">
              Skip the approval step before Artrelo contacts them about a job.
            </span>
          </span>
          <span
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition in-[.lichen-d3]:h-[24px] in-[.lichen-d3]:w-[44px] ${
              form.trusted ? "bg-emerald-500 in-[.lichen-d3]:bg-mist-text lichen:bg-mist-tint" : "bg-slate-200 in-[.lichen-d3]:bg-control-border lichen:bg-chip"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition in-[.lichen-d3]:bg-card in-[.lichen-d3]:h-[20px] in-[.lichen-d3]:w-[20px]  lichen:bg-card lichen:shadow-lichen-card ${
                form.trusted ? 'translate-x-[22px]' : 'translate-x-0.5 in-[.lichen-d3]:translate-x-[2px]'
              }`}
            />
          </span>
        </button>

        <Button
          data-testid="create-vendor-btn"
          disabled={busy}
          onClick={() => void submit()}
          className="w-full bg-[#137fec] hover:bg-[#137fec]/90 in-[.lichen-d3]:bg-primary in-[.lichen-d3]:hover:bg-primary/90 in-[.lichen-d3]:text-primary-foreground lichen:bg-primary lichen:hover:bg-chip lichen:text-primary-foreground"
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : editing ? (
            <Check className="mr-1 h-4 w-4" />
          ) : (
            <Plus className="mr-1 h-4 w-4" />
          )}
          {editing ? 'Save changes' : 'Add vendor'}
        </Button>
      </div>
    </D3FormDialog>
  );
}
