import type { CSSProperties } from 'react';
import {
  MessageSquare,
  Route,
  Gauge,
  ClipboardCheck,
  CalendarClock,
  MessagesSquare,
} from 'lucide-react';

const steps = [
  {
    icon: MessageSquare,
    accent: '#137fec',
    title: 'AI Request Intake',
    body: 'Tenants report issues in seconds through a guided AI chat. Artrelo captures photos, location, and symptoms automatically — no forms, no phone tag.',
  },
  {
    icon: Gauge,
    accent: '#a855f7',
    title: 'Issue Triage & Urgency Detection',
    body: 'AI determines the likely category, assesses urgency, and flags true emergencies so the most critical work is surfaced and prioritized first.',
  },
  {
    icon: Route,
    accent: '#137fec',
    title: 'Vendor Routing',
    body: 'Each request is matched to the best-fit vendor in your network by trade, location, and availability — no manual dispatching.',
  },
  {
    icon: ClipboardCheck,
    accent: '#a855f7',
    title: 'Landlord Approval Workflow',
    body: 'Review the recommendation and approve dispatch in one tap, or set rules to auto-approve routine jobs and stay hands-off.',
  },
  {
    icon: CalendarClock,
    accent: '#137fec',
    title: 'Scheduling Coordination',
    body: 'Artrelo coordinates timing between tenant and vendor, books the visit, and sends reminders so nothing slips through the cracks.',
  },
  {
    icon: MessagesSquare,
    accent: '#a855f7',
    title: 'Request Timeline & Communication',
    body: 'Every update, message, and status change lives on one shared timeline — tenant, vendor, and landlord always stay in the loop.',
  },
];

// One step's turn, matching the original 12s CSS loop split across six cards.
// Static on purpose: the cards glow only while hovered or focused, which is
// pure CSS (.hiw-card:hover / :focus-visible in globals.css). With no state
// there is no client JS, and nothing re-renders the cards -- RevealInit adds
// `reveal-in` to them imperatively, and a re-render that rewrote className
// would strip it (that is what made the cards vanish under the old animated
// version).
export default function HowItWorksSteps() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {steps.map((step, i) => (
        <div
          key={step.title}
          tabIndex={0}
          className="hiw-card rounded-2xl p-7 outline-none"
          data-reveal
          style={{ transitionDelay: `${i * 70}ms`, '--hiw-accent': step.accent } as CSSProperties}
        >
          <div className="flex items-center justify-between mb-5">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${step.accent}1f` }}
            >
              <step.icon className="w-[22px] h-[22px]" style={{ color: step.accent }} />
            </div>
            <span className="text-sm font-semibold text-slate-600 tabular-nums">{String(i + 1).padStart(2, '0')}</span>
          </div>
          <h3 className="text-base font-bold text-white mb-2">{step.title}</h3>
          <p className="text-slate-400 text-sm leading-relaxed">{step.body}</p>
        </div>
      ))}
    </div>
  );
}
