import { AlertTriangle, Building2, Clock, Mail, MapPin, Pencil, Phone, ShieldCheck, Siren, Trash2, TrendingUp } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { VendorItem } from '../../../types/landlord';
import { formatHours, isOpenNow } from './vendorHours';
import { initials, vendorTone } from './vendorSpecialties';

const MAX_CHIPS = 4;

function trackRecord(vendor: VendorItem): string | null {
  const jobs = vendor.successfulJobs || 0;
  if (!jobs) return null;
  const minutes = vendor.responseStats?.averageFirstResponseMinutes || 0;
  const reply =
    minutes <= 0 ? '' : minutes < 60 ? ` · replies in ~${Math.round(minutes)} min` : ` · replies in ~${Math.round(minutes / 60)} h`;
  return `${jobs} job${jobs === 1 ? '' : 's'} completed${reply}`;
}

/**
 * One vendor in the landlord's network. The card leads with who they are and
 * whether they can be called right now (hours, emergency readiness), then how
 * to reach them, then what they do -- the order a landlord scans in when a
 * pipe has burst. The tone colour follows the vendor's primary trade so a
 * roster reads at a glance.
 */
export default function VendorCard({
  vendor,
  index,
  onEdit,
  onDelete,
}: {
  vendor: VendorItem;
  index: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tone = vendorTone(vendor);
  const hoursLabel = formatHours(vendor.operatingHours);
  const open = isOpenNow(vendor.operatingHours);
  const presets = vendor.specialties || [];
  const customs = vendor.customSpecialties || [];
  const chips = [...presets.map((label) => ({ label, custom: false })), ...customs.map((label) => ({ label, custom: true }))];
  const shown = chips.slice(0, MAX_CHIPS);
  const hidden = chips.length - shown.length;
  const missing = [!vendor.email ? 'an email' : null, !vendor.operatingHours ? 'hours' : null].filter(Boolean);
  const record = trackRecord(vendor);
  const location = [vendor.city, (vendor.serviceAreas || []).join(', ')].filter(Boolean).join(' · ');

  return (
    <article
      data-testid={`vendor-row-${vendor._id}`}
      style={{ animationDelay: `${index * 50}ms` } as CSSProperties}
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-slate-200/70 bg-white shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_14px_34px_-18px_rgba(15,23,42,0.35)] focus-within:shadow-md lichen:rounded-lg lichen:border-hairline lichen:bg-card lichen:shadow-lichen-card lichen:hover:translate-y-0 lichen:hover:shadow-lichen-card lichen:focus-within:shadow-lichen-card"
    >
      {/* Trade-coloured edge and a faint wash behind the header. */}
      <div className="h-1 w-full" style={{ background: 'var(--color-hairline)' }} />
      <div
        className="pointer-events-none absolute inset-x-0 top-1 h-20"
        style={{ background: 'transparent' }}
      />

      <div className="relative flex flex-1 flex-col p-5">
        <header className="flex items-start gap-3">
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-sm font-bold tracking-wide lichen:rounded-lg lichen:tracking-normal"
            style={{ backgroundColor: 'var(--color-chip)', color: 'var(--color-chip-icon)', boxShadow: 'none' }}
            aria-hidden
          >
            {initials(vendor.name)}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold text-slate-900 lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere] lichen:text-ink">{vendor.name}</h3>
            {vendor.company ? (
              <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500 lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere] lichen:text-meta">
                <Building2 className="h-3 w-3 shrink-0 text-slate-400 lichen:text-meta" />
                {vendor.company}
              </p>
            ) : (
              <p className="mt-0.5 text-xs text-slate-400 lichen:text-meta">Independent</p>
            )}
          </div>
          <div className="-mr-1.5 -mt-1 flex items-center gap-0.5 transition sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
            <button
              type="button"
              data-testid={`edit-vendor-${vendor._id}`}
              aria-label={`Edit ${vendor.name}`}
              onClick={onEdit}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 lichen:rounded-lg lichen:text-meta lichen:hover:bg-chip lichen:hover:text-ink"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-testid={`delete-vendor-${vendor._id}`}
              aria-label={`Remove ${vendor.name}`}
              onClick={onDelete}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 lichen:rounded-lg lichen:text-meta lichen:hover:bg-alert-tint lichen:hover:text-alert-text"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {vendor.operatingHours ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 lichen:border-hairline lichen:bg-card lichen:text-xs lichen:text-meta"
              title="Open / closed is based on your local time"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${open ? "bg-emerald-500 lichen:bg-mist-tint" : 'bg-slate-300'}`} />
              <span className={open ? "text-emerald-700 lichen:text-mist-text" : "text-slate-500 lichen:text-meta"}>{open ? 'Open now' : 'Closed'}</span>
              <span className="text-slate-300 lichen:text-meta">·</span>
              <Clock className="h-3 w-3 text-slate-400 lichen:text-meta" />
              {hoursLabel}
            </span>
          ) : null}
          {vendor.verificationStatus === 'trusted' ? (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 lichen:border-mist-line lichen:bg-mist-tint lichen:text-xs lichen:text-mist-text"
              title="Contacted without a per-job approval"
            >
              <ShieldCheck className="h-3 w-3" />
              Trusted
            </span>
          ) : null}
          {vendor.emergencyAvailable ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700 lichen:border-alert-line lichen:bg-alert-tint lichen:text-xs lichen:text-alert-text">
              <Siren className="h-3 w-3" />
              Emergency ready
            </span>
          ) : null}
        </div>

        {missing.length ? (
          <button
            type="button"
            onClick={onEdit}
            className="mt-3 flex w-full items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-left text-xs text-amber-800 transition hover:bg-amber-50 lichen:rounded-lg lichen:border-lichen-line lichen:bg-lichen-tint lichen:text-lichen-text lichen:hover:bg-lichen-tint"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500 lichen:text-lichen-text" />
            <span>
              Add {missing.join(' and ')} so this vendor can receive job offers.
            </span>
          </button>
        ) : null}

        <dl className="mt-4 space-y-2 text-[13px]">
          {vendor.phone ? (
            <div className="flex items-center gap-2.5">
              <dt className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400 lichen:rounded-lg lichen:bg-well lichen:text-meta">
                <Phone className="h-3.5 w-3.5" />
                <span className="sr-only">Phone</span>
              </dt>
              <dd className="min-w-0 truncate lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere]">
                <a href={`tel:${vendor.phone}`} className="text-slate-700 hover:text-[#137fec] hover:underline lichen:text-ink lichen:hover:text-lichen-text">
                  {vendor.phone}
                </a>
              </dd>
            </div>
          ) : null}
          {vendor.email ? (
            <div className="flex items-center gap-2.5">
              <dt className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400 lichen:rounded-lg lichen:bg-well lichen:text-meta">
                <Mail className="h-3.5 w-3.5" />
                <span className="sr-only">Email</span>
              </dt>
              <dd className="min-w-0 truncate lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere]">
                <a href={`mailto:${vendor.email}`} className="text-slate-700 hover:text-[#137fec] hover:underline lichen:text-ink lichen:hover:text-lichen-text">
                  {vendor.email}
                </a>
              </dd>
            </div>
          ) : null}
          {location ? (
            <div className="flex items-center gap-2.5">
              <dt className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-400 lichen:rounded-lg lichen:bg-well lichen:text-meta">
                <MapPin className="h-3.5 w-3.5" />
                <span className="sr-only">Service area</span>
              </dt>
              <dd className="min-w-0 truncate text-slate-600 lichen:whitespace-normal lichen:overflow-visible lichen:text-clip lichen:[overflow-wrap:anywhere] lichen:text-meta">{location}</dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-auto pt-4">
          {chips.length ? (
            <div className="flex flex-wrap gap-1.5">
              {shown.map((chip) =>
                chip.custom ? (
                  <span
                    key={`c-${chip.label}`}
                    className="rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-[11px] font-medium text-slate-600 lichen:border-hairline lichen:text-xs lichen:text-meta"
                    title="Added by you"
                  >
                    {chip.label}
                  </span>
                ) : (
                  <span
                    key={`p-${chip.label}`}
                    className="rounded-md px-2 py-0.5 text-[11px] font-medium lichen:text-xs"
                    style={{ backgroundColor: 'var(--color-chip)', color: 'var(--color-meta)' }}
                  >
                    {chip.label}
                  </span>
                )
              )}
              {hidden > 0 ? (
                <span
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 lichen:bg-chip lichen:text-xs lichen:text-meta"
                  title={chips.slice(MAX_CHIPS).map((chip) => chip.label).join(', ')}
                >
                  +{hidden}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-slate-400 lichen:text-meta">No specialties yet</p>
          )}

          <div className="mt-4 flex items-center gap-1.5 border-t border-slate-100 pt-3 text-[11px] text-slate-500 lichen:border-hairline lichen:text-xs lichen:text-meta">
            <TrendingUp className="h-3.5 w-3.5 text-slate-400 lichen:text-meta" />
            {record || 'New to your network'}
          </div>
        </div>
      </div>
    </article>
  );
}
