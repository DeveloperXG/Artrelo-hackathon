import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Building2, CheckCircle2 } from 'lucide-react';
import RevealInit from '@/components/RevealInit';
import MarketingCta from '@/components/MarketingCta';
import { ctaClass } from '@/lib/analytics';

// The one ICP page worth writing first. /solutions stays the hub and keeps its
// three anchored segments; this is the deeper page for the audience the whole
// site now leads with.
//
// DELIBERATE OMISSION: nothing here says "your team". Artrelo is one login per
// operator today — models/Landlord.js has a single role field and no
// organisation or seat model — so team language would be describing software
// that does not exist. Write to the operator until that changes.

export const metadata: Metadata = {
  title: 'AI Maintenance Automation for Property Managers',
  description:
    'Artrelo handles maintenance coordination for property management companies — structured intake, urgency triage, vendor routing, spend approvals, scheduling, and verified vendor payment.',
  alternates: { canonical: '/solutions/property-managers' },
};

const painPoints = [
  'Every request arrives as a phone call or a vague text, and someone has to turn it into a work order.',
  'True emergencies are buried in a queue of dripping taps and broken blinds.',
  'Dispatching means texting three vendors and waiting to see who answers first.',
  'Spend approvals happen in your inbox, or not at all.',
  'Nobody can say what happened on a job six weeks ago without digging through messages.',
];

const capabilities = [
  {
    title: 'Requests arrive structured, not as a phone call',
    body: 'Tenants report through a guided chat. Artrelo asks the follow-up questions you would have asked, requests a photo when one helps, and produces a categorised request with an urgency on it.',
  },
  {
    title: 'Real emergencies are caught by rules, not by judgement',
    body: 'Suspected gas leaks, fire and smoke are detected by fixed code rules rather than a model deciding case by case. The request is forced to emergency, the tenant is told to leave and call 911 before anything else happens, and you are alerted straight away.',
  },
  {
    title: 'Your vendors, matched by trade and availability',
    body: 'Preferred vendors are matched first. Artrelo only looks beyond your list if you have allowed it, and a vendor who declines or goes quiet is replaced automatically — up to the number of attempts you set.',
  },
  {
    title: 'Approvals that scale with the money, not the volume',
    body: 'Set a spend quota and override it per property, per category, or per unit. Routine work inside the limits runs on its own; anything over quota, any first-time vendor, and anything high-severity comes to you.',
  },
  {
    title: 'Scheduling without the three-way phone tag',
    body: 'Artrelo coordinates the window between tenant and vendor, confirms it, and keeps the request timeline current so you are not the message bus.',
  },
  {
    title: 'Jobs close with proof, and the vendor gets paid',
    body: 'Vendors submit before-and-after photos, the tenant confirms the work, and payment is released after that — not on trust. A job whose evidence does not hold up becomes a decision on your desk instead of a payout.',
  },
];

export default function PropertyManagersPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <Building2 className="w-3.5 h-3.5" />
            For property managers
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Grow your portfolio.{' '}
            <span className="text-gradient-animated">Not your maintenance queue.</span>
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed mb-9">
            More doors usually means more calls, more vendors, more scheduling and more approvals.
            Artrelo takes the coordination between a tenant&rsquo;s report and a finished repair, so
            adding units stops meaning adding hours.
          </p>
          <Link
            href="/demo"
            className={`group inline-flex items-center justify-center gap-2 bg-[#137fec] text-white px-7 py-3.5 rounded-xl text-base font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 hover:-translate-y-0.5 ${ctaClass('solutions-pm-hero')}`}
          >
            Book a Demo
            <ArrowRight className="w-[18px] h-[18px] group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </section>

      {/* The problem */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-10" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
              A maintenance request shouldn&rsquo;t create twelve more tasks
            </h2>
            <p className="text-slate-600 text-lg leading-relaxed">
              The work is rarely the hard part. The coordination around it is.
            </p>
          </div>
          <ul className="space-y-4" data-reveal>
            {painPoints.map((point) => (
              <li
                key={point}
                className="flex gap-3.5 rounded-xl border border-slate-200 bg-slate-50 px-5 py-4 text-slate-700 text-sm leading-relaxed"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400 shrink-0 mt-2"></span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What Artrelo does about it */}
      <section className="bg-slate-50 border-y border-slate-100">
        <div className="max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-12" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
              What Artrelo takes off your desk
            </h2>
            <p className="text-slate-600 text-lg leading-relaxed">
              Six things that currently need a person, and no longer do.
            </p>
          </div>
          <div className="space-y-4">
            {capabilities.map((item, i) => (
              <div
                key={item.title}
                className="rounded-2xl border border-slate-200 bg-white p-6 md:p-7"
                data-reveal
                style={{ transitionDelay: `${i * 60}ms` }}
              >
                <div className="flex gap-4">
                  <CheckCircle2 className="w-5 h-5 text-[#137fec] shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-base font-bold text-slate-900 mb-2">{item.title}</h3>
                    <p className="text-slate-600 text-sm leading-relaxed">{item.body}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Fit with what you already run */}
      <section className="relative bg-white">
        <div className="max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
              It fits around what you already run
            </h2>
            <div className="space-y-4 text-slate-600 leading-relaxed">
              <p>
                Artrelo does not replace your property management software. It is the maintenance
                coordination layer beside it — intake, triage, routing, approvals, scheduling and
                paying for repairs. Leasing, rent and accounting stay where they are.
              </p>
              <p>
                Your vendors stay your vendors. There is no marketplace to join and no network you
                have to hire from, and your contractors do not download anything — they work from a
                private link to the one job they were offered.
              </p>
              <p>
                Getting started is a spreadsheet: import your properties and units as a CSV, set your
                approval rules, and go. There is no integration to build first.
              </p>
            </div>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link href="/pricing" className="text-[#137fec] font-semibold hover:underline">
                See how pricing works
              </Link>
              <Link href="/security" className="text-[#137fec] font-semibold hover:underline">
                Read about security
              </Link>
            </div>
          </div>
        </div>
      </section>

      <MarketingCta
        heading={<>Show us your <span className="text-gradient-animated">maintenance workflow.</span></>}
        body="Tell us how requests reach you today and we'll show you exactly what Artrelo would automate — and what it would leave with you."
      />
    </>
  );
}
