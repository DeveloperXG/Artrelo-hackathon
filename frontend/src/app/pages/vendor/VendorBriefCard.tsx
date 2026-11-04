import { AlertTriangle, Clock, MapPin, ShieldAlert, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import MessageParagraphs from '../../components/MessageParagraphs';
import type { VendorBrief } from './vendorPortalTypes';

const TIER_CHIP: Record<string, string> = {
  emergency: 'bg-rose-100 text-rose-700',
  urgent: 'bg-orange-100 text-orange-700',
  normal: 'bg-sky-100 text-sky-700',
  low: 'bg-slate-100 text-slate-600',
};

const RISK_LABELS: Record<string, string> = {
  gas: 'Gas hazard',
  fire: 'Fire risk',
  smoke: 'Smoke',
  flooding: 'Active flooding',
  electrical: 'Electrical hazard',
  structural: 'Structural concern',
  sewage: 'Sewage',
  carbon_monoxide: 'Carbon monoxide',
  injury: 'Injury risk',
  other: 'Safety concern',
};

export default function VendorBriefCard({ brief }: { brief: VendorBrief }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={`border-transparent ${TIER_CHIP[brief.tier] || TIER_CHIP.normal}`}>
          {brief.tierLabel}
        </Badge>
        <Badge className="border-transparent bg-cyan-100 text-cyan-700">{brief.category}</Badge>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {brief.jobReference}
        </span>
      </div>

      <h1 className="mt-3 text-xl font-bold leading-tight tracking-tight text-slate-900 sm:text-2xl">
        {brief.shortTitle}
      </h1>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500">
        <span className="flex items-center gap-1.5">
          <MapPin className="h-4 w-4" aria-hidden="true" />
          {brief.city || 'Service area shared on acceptance'}
        </span>
        {brief.trade ? (
          <span className="flex items-center gap-1.5">
            <Wrench className="h-4 w-4" aria-hidden="true" />
            {brief.trade}
          </span>
        ) : null}
        {brief.timeline?.started ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4" aria-hidden="true" />
            Started {brief.timeline.started}
          </span>
        ) : null}
      </div>

      {brief.riskType || brief.safetyRisk ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <strong>{RISK_LABELS[brief.riskType || 'other'] || 'Safety concern'}</strong> reported.
            Bring appropriate protective equipment and follow your safety protocol on arrival.
          </span>
        </div>
      ) : null}

      {brief.summary ? (
        <p className="mt-4 text-sm leading-6 text-slate-700">{brief.summary}</p>
      ) : null}

      {brief.impact ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">
          <span className="font-medium text-slate-700">Impact:</span> {brief.impact}
        </p>
      ) : null}

      {brief.accessConstraints.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {brief.accessConstraints.map((item) => (
            <span
              key={item}
              className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600"
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}

      {brief.photos.length ? (
        <div className="mt-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Photos from the tenant
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {brief.photos.map((photo) => (
              <a
                key={photo.url}
                href={photo.url}
                target="_blank"
                rel="noreferrer noopener"
                className="group relative block overflow-hidden rounded-xl border border-slate-200 bg-slate-50"
              >
                {photo.type === 'video' ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video src={photo.url} className="h-28 w-full object-cover" />
                ) : (
                  <img
                    src={photo.url}
                    alt={photo.label || 'Evidence from the tenant'}
                    className="h-28 w-full object-cover transition group-hover:scale-105"
                    loading="lazy"
                  />
                )}
                {photo.label ? (
                  <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 px-2 py-1 text-[11px] text-white">
                    {photo.label}
                  </span>
                ) : null}
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {brief.messageBody ? (
        <div className="mt-5 rounded-xl border-l-[3px] border-l-[#137fec] bg-slate-50 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Message from your property manager
          </div>
          {/* Real paragraphs, not one pre-line blob: a landlord-edited draft
              with odd spacing still reads cleanly, with no indented lines. */}
          <MessageParagraphs text={brief.messageBody} className="mt-2 text-sm leading-6 text-slate-700" />
        </div>
      ) : null}

      <div className="mt-5 flex items-start gap-2 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        For the tenant&rsquo;s privacy, the exact address, unit number and contact details are shared
        as soon as you accept this job.
      </div>
    </section>
  );
}
