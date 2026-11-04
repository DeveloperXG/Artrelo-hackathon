import type { Metadata } from 'next';
import Link from 'next/link';
import { KeyRound, Lock, ShieldCheck, Server, Users, Wallet } from 'lucide-react';
import RevealInit from '@/components/RevealInit';
import MarketingCta from '@/components/MarketingCta';
import { PRIVACY_EMAIL } from '@/config/site';

// EVERY CLAIM ON THIS PAGE IS DEFENSIBLE AGAINST THE CODEBASE. If you change a
// mechanism, change the sentence.
//
//   bcrypt cost 12            controllers/{auth,landlordAuth}.controller.js
//   cookie flags / TTLs       controllers/landlordAuth.controller.js setAuthCookies
//   helmet + CORS allowlist   app.js
//   role checks               middleware/authorization.middleware.js
//   rate limiters             middleware/{publicContactRateLimit,vendorPortalRateLimit,rateLimit}
//   job tokens                services/vendor/jobToken.service.js (256-bit, sha256 at rest)
//   tenant contact withheld   services/vendor/vendorBrief.service.js (the privacy boundary)
//   Stripe custody            services/ledger/payoutProvider.service.js
//   webhook verification      controllers/stripeWebhook.controller.js (raw-body signature)
//
// The "What we don't claim" section is deliberate and must not be quietly
// dropped as the company grows — it is the reason the rest of the page is
// believable. Remove an item only when the certification actually exists.

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How Artrelo protects portfolio, tenant and vendor data: authentication, access control, payment custody, tenant privacy, and the subprocessors we use.',
  alternates: { canonical: '/security' },
};

const sections = [
  {
    icon: KeyRound,
    title: 'Accounts and sessions',
    points: [
      'Passwords are hashed with bcrypt at cost 12. We never store them in a readable form and cannot recover one for you.',
      'Sessions use HTTP-only cookies, so page scripts cannot read your session token. They are marked Secure in production and restricted to our own site with SameSite=strict.',
      'Access tokens are short-lived and refreshed separately, and the refresh cookie is scoped to the single endpoint that consumes it.',
    ],
  },
  {
    icon: Users,
    title: 'Access control and isolation',
    points: [
      'Every account carries a role — landlord, tenant or vendor — and each endpoint checks it before doing any work.',
      'Handlers scope their queries to the authenticated account rather than filtering afterwards, so one operator cannot read another operator’s portfolio.',
      'A vendor sees only the job they were offered. A tenant sees only their own requests, and never what the work costs.',
    ],
  },
  {
    icon: Lock,
    title: 'Vendor access without accounts',
    points: [
      'Vendors work from a private link to a single job. There is no vendor account and no shared password to leak.',
      'Those links carry 256 bits of randomness and are stored only as a SHA-256 hash. The raw value is never written to the database and never written to a log.',
      'A link stops working when its job closes.',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Tenant privacy',
    points: [
      'Vendors never receive a tenant’s phone number or email. Before accepting a job they see only the issue, photos and city; after accepting, the address, access details and the tenant’s first name and last initial.',
      'Tenants are never shown what a repair costs, and vendors are never shown your budget for it.',
      'Photos and videos submitted with a request are stored with our media provider and attached to that request only.',
    ],
  },
  {
    icon: Wallet,
    title: 'Payments',
    points: [
      'Stripe holds the money and handles vendor identity verification. We store a reference to the Stripe account and nothing else.',
      'No card number and no vendor bank detail is ever stored in our database.',
      'Payment webhooks are verified against the raw request body before they are trusted, so a forged callback cannot move money.',
    ],
  },
  {
    icon: Server,
    title: 'Infrastructure',
    points: [
      'Traffic is served over HTTPS. The database is hosted on MongoDB Atlas, which encrypts data at rest.',
      'Standard HTTP hardening headers are applied to every response, and cross-origin access is limited to an allowlist rather than left open.',
      'Public endpoints — the contact form, the vendor portal, and tenant request intake — are rate limited per IP and in aggregate.',
    ],
  },
];

// Naming these is part of the answer, not a footnote: an operator handing us
// tenant data is entitled to know who else processes it.
const subprocessors = [
  { name: 'MongoDB Atlas', purpose: 'Application database' },
  { name: 'Stripe', purpose: 'Vendor payouts and payment custody' },
  { name: 'OpenAI', purpose: 'Request triage and categorisation' },
  { name: 'Cloudinary', purpose: 'Photo and video storage' },
  { name: 'Resend', purpose: 'Transactional email' },
  { name: 'Twilio', purpose: 'Automated emergency phone calls to property managers' },
  { name: 'Sentry', purpose: 'Error reports, scrubbed of request contents and contact details' },
  { name: 'Railway', purpose: 'Application hosting' },
];

const notClaimed = [
  'SOC 2 or ISO 27001 certification',
  'A formal GDPR or PIPEDA compliance programme',
  'Guaranteed data residency in a particular country',
  'A third-party penetration test',
  'A contractual uptime SLA',
];

export default function SecurityPage() {
  return (
    <>
      <RevealInit />

      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-16">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <ShieldCheck className="w-3.5 h-3.5" />
            Security
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            What we do with <span className="text-gradient-animated">your data.</span>
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            Artrelo handles tenant contact details, property records, vendor relationships and money.
            This page describes how each of those is protected — and, at the bottom, what we
            deliberately do not claim yet.
          </p>
        </div>
      </section>

      {/* Sections */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="grid md:grid-cols-2 gap-6">
            {sections.map((section, i) => (
              <div
                key={section.title}
                className="feature-card rounded-2xl p-7"
                data-reveal
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                <div className="w-11 h-11 rounded-xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center mb-5">
                  <section.icon className="w-5 h-5" />
                </div>
                <h2 className="text-lg font-bold text-slate-900 mb-3">{section.title}</h2>
                <ul className="space-y-2.5">
                  {section.points.map((point) => (
                    <li key={point} className="flex gap-2.5 text-sm text-slate-600 leading-relaxed">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#137fec] shrink-0 mt-2"></span>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Subprocessors */}
      <section className="bg-slate-50 border-y border-slate-100">
        <div className="max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-10" data-reveal>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-4">
              Who else processes your data
            </h2>
            <p className="text-slate-600 leading-relaxed">
              Artrelo is built on services that each handle one part of the job. These are all of
              them.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden" data-reveal>
            <dl>
              {subprocessors.map((item) => (
                <div
                  key={item.name}
                  className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-6 px-6 py-4 border-b border-slate-100 last:border-b-0"
                >
                  <dt className="text-sm font-semibold text-slate-900 sm:w-48 shrink-0">{item.name}</dt>
                  <dd className="text-sm text-slate-600">{item.purpose}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* What we don't claim */}
      <section className="relative bg-white">
        <div className="max-w-5xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-8" data-reveal>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-4">
              What we don&rsquo;t claim yet
            </h2>
            <p className="text-slate-600 leading-relaxed">
              Artrelo is an early-stage company. Plenty of vendors imply certifications they do not
              hold, so here is the list of things we have <span className="font-semibold">not</span>{' '}
              done. If one of these is a requirement for you, tell us and we will give you a straight
              answer about timing rather than a vague one.
            </p>
          </div>
          <ul className="grid sm:grid-cols-2 gap-x-8 gap-y-3" data-reveal>
            {notClaimed.map((item) => (
              <li key={item} className="flex gap-2.5 text-sm text-slate-600">
                <span className="text-slate-400 shrink-0">—</span>
                {item}
              </li>
            ))}
          </ul>
          <p className="text-sm text-slate-500 mt-10 leading-relaxed">
            Security questions, or a vulnerability to report? Email{' '}
            <a href={`mailto:${PRIVACY_EMAIL}`} className="text-[#137fec] font-semibold hover:underline">
              {PRIVACY_EMAIL}
            </a>
            . See also our{' '}
            <Link href="/privacy" className="text-[#137fec] font-semibold hover:underline">
              privacy policy
            </Link>
            .
          </p>
        </div>
      </section>

      <MarketingCta
        heading={<>Bring us your <span className="text-gradient-animated">hardest questions.</span></>}
        body="We would rather answer them on a call than have you guess from a page. Book a demo and ask."
      />
    </>
  );
}
