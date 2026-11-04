import {
  Building2,
  CalendarCheck,
  Mail,
  MapPin,
  MessageSquare,
  PawPrint,
  Phone,
  User,
} from 'lucide-react';
import type { VendorRevealedDetails as RevealedDetails } from './vendorPortalTypes';
import { formatDuration } from './durationOnSite';

function Row({
  icon: Icon,
  label,
  value,
  testId,
}: {
  icon: typeof MapPin;
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: '#137fec1a', color: '#137fec' }}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {label}
        </div>
        <div className="mt-0.5 text-sm font-medium break-words text-slate-900" data-testid={testId}>
          {value}
        </div>
      </div>
    </div>
  );
}

export default function VendorRevealedDetails({ revealed }: { revealed: RevealedDetails }) {
  const fullAddress = [revealed.property.address, revealed.property.unitNumber
    ? `Unit ${revealed.property.unitNumber}`
    : null]
    .filter(Boolean)
    .join(' · ');

  const accessBits: string[] = [];
  if (revealed.access.permissionToEnter === true) accessBits.push('Entry permission granted');
  if (revealed.access.permissionToEnter === false) accessBits.push('Tenant must be present');
  if (revealed.access.preferredTimes.length) {
    accessBits.push(`Prefers: ${revealed.access.preferredTimes.join(', ')}`);
  }
  // entryNotes is the tenant's free-text time preference, which intake also
  // copies into preferredTimes, so the same words used to print twice
  // ("Prefers: weekday mornings · weekday mornings").
  const normalize = (text: string) => text.trim().toLowerCase();
  const entryNotes = revealed.access.entryNotes?.trim();
  if (entryNotes && !revealed.access.preferredTimes.some((time) => normalize(time) === normalize(entryNotes))) {
    accessBits.push(entryNotes);
  }

  return (
    <section
      className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-5"
      data-testid="vendor-revealed-details"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
        Job details — now unlocked
      </div>
      <h2 className="mt-1 text-lg font-bold text-slate-900">Where to go &amp; who to ask for</h2>

      <div className="mt-4 divide-y divide-emerald-100 rounded-xl bg-white px-4">
        <Row
          icon={MapPin}
          label="Address"
          value={fullAddress || 'Address on file'}
          testId="vendor-revealed-address"
        />
        {revealed.property.name ? (
          <Row icon={Building2} label="Property" value={revealed.property.name} />
        ) : null}
        <Row
          icon={User}
          label="Tenant"
          value={revealed.tenant.displayName}
          testId="vendor-revealed-tenant"
        />
        {revealed.tenant.contact?.available && revealed.tenant.contact.phone ? (
          <Row
            icon={MessageSquare}
            label="Message tenant"
            value={revealed.tenant.contact.phone}
            testId="vendor-revealed-tenant-contact"
          />
        ) : (
          <Row
            icon={MessageSquare}
            label="Contacting the tenant"
            value={revealed.tenant.contact?.label || 'Your property manager can relay messages.'}
            testId="vendor-revealed-tenant-contact"
          />
        )}
        {accessBits.length ? (
          <Row icon={PawPrint} label="Access" value={accessBits.join(' · ')} />
        ) : null}
        {revealed.scheduledArrivalAt ? (
          <Row
            icon={CalendarCheck}
            label="Your arrival"
            value={`${new Date(revealed.scheduledArrivalAt).toLocaleString(undefined, {
              timeZone: revealed.confirmedWindow?.timeZone || undefined,
              timeZoneName: 'short',
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}${
              revealed.durationMinutes ? ` · about ${formatDuration(revealed.durationMinutes)} on site` : ''
            }`}
            testId="vendor-revealed-window"
          />
        ) : revealed.confirmedWindow?.label ? (
          <Row
            icon={CalendarCheck}
            label="Your window"
            value={revealed.confirmedWindow.label}
            testId="vendor-revealed-window"
          />
        ) : null}
        {revealed.manager.phone ? (
          <Row icon={Phone} label="Property manager" value={revealed.manager.phone} />
        ) : null}
        {revealed.manager.email ? (
          <Row icon={Mail} label="Manager email" value={revealed.manager.email} />
        ) : null}
      </div>

      <p className="mt-4 text-sm leading-6 text-slate-600">{revealed.nextSteps}</p>
    </section>
  );
}
