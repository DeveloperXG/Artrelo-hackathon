import type { Metadata } from 'next';
import Link from 'next/link';
import { Home, Building2, Building, Check, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import MarketingCta from '@/components/MarketingCta';
import RevealInit from '@/components/RevealInit';

export const metadata: Metadata = {
  title: 'Solutions',
  description:
    "Artrelo adapts to how you operate — whether you're an independent landlord, a property manager, or running a multi-family portfolio. See the right fit for your maintenance workflow.",
  alternates: { canonical: '/solutions' },
};

interface Segment {
  id: string;
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  intro: string;
  painPoints: string[];
  outcomes: string[];
  // Set when the segment has a page of its own. Only property managers does
  // today — the lead ICP gets the depth first.
  href?: string;
}

const segments: Segment[] = [
  {
    id: 'independent-landlords',
    icon: Home,
    eyebrow: 'Independent Landlords',
    title: 'Run your rentals without the 2am phone calls',
    intro:
      'When you manage a handful of units alongside a day job, every maintenance request competes for time you don’t have. Artrelo handles intake and triage so you only step in when it matters.',
    painPoints: [
      'Tenants call and text at all hours with vague problem descriptions',
      'Chasing quotes and scheduling eats entire evenings',
      'No easy way to track what’s open across properties',
    ],
    outcomes: [
      'AI captures the full issue with photos — no back-and-forth',
      'One-tap approval to dispatch your preferred vendors',
      'A single timeline shows the status of every request',
    ],
  },
  {
    id: 'property-managers',
    icon: Building2,
    href: '/solutions/property-managers',
    eyebrow: 'Property Managers',
    title: 'Scale your doors without scaling your team',
    intro:
      'Managing maintenance across dozens of owners means juggling priorities, vendors, and approvals all day. Artrelo automates the routine so your team focuses on the exceptions.',
    painPoints: [
      'High request volume buries true emergencies',
      'Manual vendor dispatch is slow and inconsistent',
      'Owners want visibility you can’t easily provide',
    ],
    outcomes: [
      'Urgency scoring surfaces critical work first',
      'Automated routing matches the right vendor every time',
      'Auto-approval rules keep routine jobs moving hands-off',
    ],
  },
  {
    id: 'multi-family',
    icon: Building,
    eyebrow: 'Multi-Family',
    title: 'Consistent service across every unit and building',
    intro:
      'Large multi-family portfolios demand standardized, auditable maintenance workflows. Artrelo brings enterprise-grade automation with the controls and reporting your operation needs.',
    painPoints: [
      'Inconsistent processes across sites and staff',
      'Compliance and audit trails are hard to maintain',
      'Fragmented tools create data silos',
    ],
    outcomes: [
      'One standardized intake-to-resolution workflow',
      'A complete agent timeline on every request',
      'Per-property rules, quotas, and approval policies',
    ],
  },
];

export default function SolutionsPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            Solutions
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Built for the way you manage
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            From a single rental to thousands of units, Artrelo shapes its automation around your portfolio and workflow.
          </p>
        </div>
      </section>

      {/* Segments */}
      {segments.map((segment, i) => {
        const dark = i % 2 === 1;
        return (
          <section
            key={segment.id}
            id={segment.id}
            className={`scroll-mt-16 ${dark ? 'bg-slate-50 border-y border-slate-100' : 'bg-white'}`}
          >
            <div className="max-w-7xl mx-auto px-6 py-20 md:py-24">
              <div className="grid md:grid-cols-2 gap-12 lg:gap-16 items-center">
                <div data-reveal className={i % 2 === 1 ? 'md:order-2' : ''}>
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#137fec]/[0.06] border border-[#137fec]/15 text-[#137fec] text-xs font-semibold tracking-wide mb-4">
                    <segment.icon className="w-3.5 h-3.5" />
                    {segment.eyebrow}
                  </div>
                  <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">{segment.title}</h2>
                  <p className="text-slate-600 text-lg leading-relaxed">{segment.intro}</p>
                  {segment.href && (
                    <Link
                      href={segment.href}
                      className="group inline-flex items-center gap-2 text-[#137fec] font-semibold mt-6 hover:gap-3 transition-all"
                    >
                      See how it works for property managers
                      <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                    </Link>
                  )}
                </div>
                <div data-reveal className={`grid gap-4 ${i % 2 === 1 ? 'md:order-1' : ''}`}>
                  <div className="rounded-2xl border border-slate-200 bg-white p-6">
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">The challenge</p>
                    <ul className="space-y-3">
                      {segment.painPoints.map((point) => (
                        <li key={point} className="flex items-start gap-2.5 text-sm text-slate-600">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0 mt-2"></span>
                          {point}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-2xl border border-[#137fec]/20 bg-[#137fec]/[0.04] p-6">
                    <p className="text-xs font-bold uppercase tracking-wider text-[#137fec] mb-4">With Artrelo</p>
                    <ul className="space-y-3">
                      {segment.outcomes.map((outcome) => (
                        <li key={outcome} className="flex items-start gap-2.5 text-sm text-slate-700 font-medium">
                          <Check className="w-[18px] h-[18px] text-[#137fec] shrink-0 mt-0.5" />
                          {outcome}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </section>
        );
      })}

      <MarketingCta
        heading={<>Find your fit with <span className="text-gradient-animated">Artrelo.</span></>}
        body="Tell us about your portfolio and we'll show you exactly how automation works for your operation."
      />
    </>
  );
}
