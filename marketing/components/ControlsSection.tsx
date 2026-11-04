import { ShieldCheck } from 'lucide-react';

// "Automate the coordination. Keep the judgment."
//
// Everything named here maps to a real field on backend/models/LandlordPolicy.js
// or a real approval type rendered by the landlord SPA's DecisionsNeededPage.
// That is the whole point of the section: a buyer's objection to an AI running
// their maintenance is answered by showing the actual switches, not by promising
// "you stay in control".
//
// The defaults quoted are the schema defaults — defaultQuota unset (null: the
// manager chooses it, and approves every vendor contact until they do),
// allowAutopilotForLowSeverity true, allowAutopilotForMediumSeverity false.
// If those change, change them here too.

const runsAutomatically = [
  {
    title: 'Low-severity jobs inside your quota',
    body: 'Autopilot is on for low severity by default and off for medium — you decide where the line sits.',
  },
  {
    title: 'Vendors you have used before',
    body: 'A known preferred vendor for the trade gets the job without asking you first.',
  },
  {
    title: 'Scheduling between tenant and vendor',
    body: 'Availability, the booked window, and the reminders around it.',
  },
  {
    title: 'Moving on when a vendor declines',
    body: 'The next-best vendor is contacted automatically, up to the number of attempts you allow.',
  },
];

const comesToYou = [
  {
    title: 'Anything over quota',
    body: 'You choose the default — nothing runs on its own until you do — and override it per property, per category, or per unit.',
  },
  { title: 'A first-time vendor', body: 'Nobody new works on your properties without your say-so.' },
  { title: 'Looking beyond your vendor list', body: 'External search is gated until you allow it.' },
  { title: 'High severity', body: 'Serious work is a decision, not an automation.' },
  { title: 'Completion review', body: 'Weak evidence on a finished job comes to you instead of paying out.' },
  { title: 'Tenant-caused cost', body: 'Who pays is a judgement call, so it stays yours.' },
];

// Real field labels from the landlord Policy screen.
const policyFields = [
  { label: 'Default quota', value: '$300' },
  { label: 'Low funds threshold', value: '$100' },
  { label: 'Autopilot · low severity', value: 'On' },
  { label: 'Autopilot · medium severity', value: 'Off' },
  { label: 'Max vendors contacted per request', value: '3' },
];

export default function ControlsSection() {
  return (
    <section className="relative bg-white overflow-hidden">
      <div className="absolute inset-0 light-grid"></div>
      <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
        <div className="max-w-2xl mb-14" data-reveal>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#137fec]/[0.06] border border-[#137fec]/15 text-[#137fec] text-xs font-semibold tracking-wide mb-4">
            <ShieldCheck className="w-3.5 h-3.5" />
            Automation with judgment
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
            Automate the coordination. Keep the judgment.
          </h2>
          <p className="text-slate-600 text-lg leading-relaxed">
            You set the rules once. Artrelo runs everything inside them and brings you in the moment
            something falls outside — which is a short, specific list, not a vague promise.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6 mb-6">
          {/* Runs automatically */}
          <div className="rounded-2xl border border-[#137fec]/20 bg-[#137fec]/[0.04] p-7" data-reveal>
            <p className="text-xs font-bold uppercase tracking-wider text-[#137fec] mb-5">
              Runs without you
            </p>
            <ul className="space-y-5">
              {runsAutomatically.map((item) => (
                <li key={item.title}>
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  <p className="text-sm text-slate-600 leading-relaxed mt-1">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>

          {/* Comes to you */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-7" data-reveal style={{ transitionDelay: '90ms' }}>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-5">
              Comes to you
            </p>
            <ul className="space-y-5">
              {comesToYou.map((item) => (
                <li key={item.title}>
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  <p className="text-sm text-slate-600 leading-relaxed mt-1">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* The actual settings, so "you set the rules" is concrete rather than a claim. */}
        <div className="rounded-2xl border border-slate-200 bg-white p-7 md:p-8" data-reveal>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-5 mb-6">
            <div>
              <p className="text-base font-bold text-slate-900">Your policy</p>
              <p className="text-sm text-slate-600 mt-1">
                Set once, overridable per property, per category, and per unit.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3.5">
            {policyFields.map((field) => (
              <div
                key={field.label}
                className="flex items-center justify-between gap-4 border-b border-slate-100 pb-2.5"
              >
                <dt className="text-sm text-slate-600">{field.label}</dt>
                <dd className="text-sm font-semibold text-slate-900 tabular-nums">{field.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
