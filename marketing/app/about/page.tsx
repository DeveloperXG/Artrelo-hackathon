import type { Metadata } from 'next';
import { Target, Zap, ShieldCheck, Heart } from 'lucide-react';
import MarketingCta from '@/components/MarketingCta';
import RevealInit from '@/components/RevealInit';

export const metadata: Metadata = {
  title: 'About',
  description:
    'Artrelo is building the operational layer between a tenant reporting a problem and the work getting done — automating maintenance coordination while operators keep the decisions.',
  alternates: { canonical: '/about' },
};

const values = [
  {
    icon: Zap,
    title: 'Automation with judgment',
    body: 'We automate the routine and escalate the exceptions. AI handles the busywork; people stay in control of what matters.',
  },
  {
    icon: ShieldCheck,
    title: 'Trust by default',
    body: 'Landlords and tenants trust us with their homes and data. Security and transparency are non-negotiable in everything we ship.',
  },
  {
    icon: Heart,
    title: 'Tenants are users too',
    body: 'A better maintenance experience starts with the person reporting the problem. We design for tenants as much as for owners.',
  },
];

// Truthful capability tiles — replaces the former fabricated metrics.
const capabilities = [
  { value: 'Seconds', label: 'From tenant report to triaged request' },
  { value: 'Auto', label: 'Vendor matching by trade & availability' },
  { value: '1 tap', label: 'Approve & dispatch from anywhere' },
  { value: '24/7', label: 'Request intake, even overnight' },
];

export default function AboutPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <Target className="w-3.5 h-3.5" />
            Our Mission
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Make maintenance <span className="text-gradient-animated">effortless.</span>
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            Property maintenance runs on phone tag, spreadsheets and guesswork. Artrelo is the
            operational layer between a tenant reporting a problem and the work actually being
            done — automating the repetitive coordination while the operator keeps control of the
            decisions.
          </p>
        </div>
      </section>

      {/* Story */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-3xl mx-auto px-6 py-20 md:py-24">
          <div className="space-y-6 text-slate-600 text-lg leading-relaxed" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900">Why we built Artrelo</h2>
            <p>
              Maintenance is the most time-consuming, least-loved part of managing property. A leaking faucet becomes a dozen messages, a handful of phone calls, and hours of coordination — repeated across every unit, every week.
            </p>
            <p>
              We saw AI change how work gets triaged in other industries and asked a simple question: why should a landlord ever manually read a request, work out the trade, find a vendor, and chase a schedule? The machine can do the routine parts in seconds.
            </p>
            <p>
              Artrelo is that machine, and it is running today. It captures the issue from the tenant,
              works out the urgency, routes it to the right vendor, coordinates the visit, and closes
              the job with proof before the vendor is paid — while the operator keeps the decisions
              that actually need judgement.
            </p>
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="relative bg-gradient-to-br from-[#137fec]/[0.04] via-white to-[#a855f7]/[0.05] overflow-hidden border-y border-slate-100">
        <div className="relative max-w-7xl mx-auto px-6 py-16">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 md:gap-4" data-reveal>
            {capabilities.map((item) => (
              <div key={item.label} className="text-center">
                <p className="text-3xl md:text-4xl font-bold tracking-tight text-gradient">{item.value}</p>
                <p className="mt-2 text-sm text-slate-500 font-medium">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Values */}
      <section className="bg-white">
        <div className="max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mx-auto text-center mb-14" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">What we value</h2>
            <p className="text-slate-600 text-lg leading-relaxed">The principles behind every decision we make.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {values.map((value, i) => (
              <div key={value.title} className="feature-card p-8 rounded-2xl" data-reveal style={{ transitionDelay: `${i * 90}ms` }}>
                <div className="w-14 h-14 rounded-2xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center mb-6">
                  <value.icon className="w-7 h-7" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2.5">{value.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{value.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Artrelo is small and early. That is a reason to be specific about who
          answers, not a reason to imitate a company with a sales floor. */}
      <MarketingCta
        heading={<>Talk to the people <span className="text-gradient-animated">building it.</span></>}
        body="We're early, and choosing our first customers as carefully as they're choosing us. Book a demo and you'll be talking to someone who works on the product."
      />
    </>
  );
}
