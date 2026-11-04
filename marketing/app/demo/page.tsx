import type { Metadata } from 'next';
import { CalendarCheck, ListChecks, Wallet } from 'lucide-react';
import RevealInit from '@/components/RevealInit';
import DemoForm from '@/components/DemoForm';
import { SALES_EMAIL } from '@/config/site';

// The primary commercial conversion. /contact stays for everything that is not
// a demo request — partnerships, press, support — so this page can be about one
// thing.
//
// Safe to add as a route: the reverse proxy hands the SPA an explicit allowlist
// (login|signup|landlord-signup|portal|dashboard|requests|vendor-response) and
// marketing owns the catch-all, so /demo needs no deploy change.
export const metadata: Metadata = {
  title: 'Book a Demo',
  description:
    'See Artrelo run your maintenance workflow — from a tenant’s report to a verified, paid repair. Bring your current process and vendors.',
  alternates: { canonical: '/demo' },
};

const expectations = [
  {
    icon: ListChecks,
    title: 'Your workflow, not a tour',
    body: 'Tell us how requests reach you today and we will walk that exact path through Artrelo — including the parts it would not automate.',
  },
  {
    icon: Wallet,
    title: 'The money question, answered early',
    body: 'By default you pay vendors yourself and Artrelo keeps the record; it can also pay them once a job is verified. We would rather show you both on the first call than the fourth.',
  },
  {
    icon: CalendarCheck,
    title: 'No commitment',
    body: 'There is no billing to sign up for yet. We are choosing our first customers as carefully as they are choosing us.',
  },
];

export default function DemoPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <CalendarCheck className="w-3.5 h-3.5" />
            Book a Demo
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            See Artrelo run <span className="text-gradient-animated">your</span> maintenance workflow.
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            Bring us the way you handle maintenance today — who takes the call, how vendors get
            picked, who approves the spend. We&rsquo;ll show you what Artrelo would take off your desk,
            and what it would leave with you.
          </p>
        </div>
      </section>

      {/* Two-column */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="grid md:grid-cols-2 gap-12 lg:gap-16">
            <div data-reveal>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-6">
                What to expect
              </h2>
              <div className="space-y-6 mb-10">
                {expectations.map((item) => (
                  <div key={item.title} className="flex gap-4">
                    <div className="w-11 h-11 rounded-xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center shrink-0">
                      <item.icon className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-slate-900 mb-1">{item.title}</h3>
                      <p className="text-slate-600 text-sm leading-relaxed">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-sm text-slate-500">
                Not looking for a demo? Reach us at{' '}
                <a href={`mailto:${SALES_EMAIL}`} className="text-[#137fec] font-semibold hover:underline">
                  {SALES_EMAIL}
                </a>
                .
              </p>
            </div>

            <div data-reveal>
              <DemoForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
