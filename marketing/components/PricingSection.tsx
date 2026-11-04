import Link from 'next/link';
import { ArrowRight, Check, ClipboardCheck, CreditCard, Lock, ShieldCheck, Wallet } from 'lucide-react';
import { ctaClass } from '@/lib/analytics';

// WHY THIS PAGE LOOKS LIKE THIS.
//
// It used to show three tiers at $1.50/$3 per unit with a monthly/annual
// toggle, a "start free trial" CTA, and an FAQ describing proration, accepted
// card types and cancellation. None of that was real: backend/services/payment/
// {stripe,subscription}.service.js are empty files and models/Landlord.js has no
// plan, subscription or trial field. The tier feature-gating was not enforced
// anywhere either, so the three columns were describing a product decision that
// had not been made.
//
// The model is what the code does: a free beta (Landlord.beta), then a
// per-completed-job service fee -- a flat amount plus a percentage, shown on the
// landlord's wallet before it applies. There is no subscription or per-unit
// billing; do not bring that copy back until it exists.
//
// THE PUBLISHED RATES MUST MATCH THE API'S ENV (Railway, API service):
//   LIST_RATE      SERVICE_FEE_CENTS=500, SERVICE_FEE_PERCENT=1
//   FOUNDING_RATE  SERVICE_FEE_FOUNDING_CENTS=300, SERVICE_FEE_FOUNDING_PERCENT=0.5
// Change one, change the other: this page is a static export and cannot read
// them. The landlord's wallet shows the rate that actually applies.
//
// The second half is how the WORK is paid for. Direct pay is the default
// (Landlord.paymentMode): the landlord pays the vendor and Artrelo records it.
// Platform payouts (ledger + Stripe Connect) are switched on per landlord.
//
// No 'use client': the billing toggle was the only stateful thing here.

// Published service fee rates. See the note above: keep in step with the API env.
export const LIST_RATE = { flat: '$5', percent: '1%' };
export const FOUNDING_RATE = { flat: '$3', percent: '0.5%' };

const payModel = [
  {
    icon: CreditCard,
    title: 'Free during the beta',
    body: 'Every beta account is free for the period shown when you join, and we remind you before it ends.',
  },
  {
    icon: Check,
    title: 'No setup fees',
    body: 'No onboarding charge and no implementation fee. Import your portfolio from a spreadsheet and start.',
  },
  {
    icon: ClipboardCheck,
    title: `Then ${LIST_RATE.flat} + ${LIST_RATE.percent} per completed job`,
    body: `Charged only on jobs that get done, with 30 days' notice before it starts. Founding landlords lock in ${FOUNDING_RATE.flat} + ${FOUNDING_RATE.percent} for good. Requests that don't become jobs cost nothing.`,
  },
];

// Each step maps to a real mechanism -- direct-pay records, optional platform
// payouts (deposits, holds), evidence-gated completion, policy quotas.
const moneyFlow = [
  {
    step: '01',
    title: 'You pay vendors your usual way',
    body: 'When a job is done and checked, Artrelo shows what you owe the vendor. Pay them by e-transfer or cheque and mark it paid. No balance to fund and no card fees.',
  },
  {
    step: '02',
    title: 'Or let Artrelo pay them',
    body: 'If you prefer, we switch on payouts: you fund a balance by card, the cost of each booked job is reserved, and the vendor is paid through Stripe once the work is verified.',
  },
  {
    step: '03',
    title: 'Either way, nothing is owed until the work is checked',
    body: 'Vendors submit completion evidence and your tenant confirms the work was actually done. A disputed job comes to you for review instead of closing.',
  },
  {
    step: '04',
    title: 'The limits stay yours',
    body: 'Set spend quotas per property, per category and per unit. Require approval for first-time vendors, for anything over quota, and before Artrelo looks beyond your own vendor list.',
  },
];

const included = [
  'AI request intake by guided chat',
  'Category and urgency assessment on every request',
  'Photo and video evidence capture',
  'Preferred-vendor routing',
  'Approval rules and spend quotas',
  'Scheduling coordination',
  'Shared request timeline',
  'Mobile-friendly tenant portal',
  'Encryption in transit and at rest',
];

export default function PricingSection() {
  return (
    <>
      {/* Hero */}
      <section className="relative bg-[#0b1219] overflow-hidden pt-32 pb-20">
        <div className="absolute inset-0 hero-grid"></div>
        <div className="absolute inset-0 hero-glow"></div>
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            Pricing
          </div>
          <h1 className="text-white text-4xl md:text-6xl font-bold tracking-tight mb-5">
            Pricing that scales with{' '}
            <span className="text-gradient-animated">your portfolio.</span>
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed mb-4">
            Free during the beta. Then {LIST_RATE.flat} + {LIST_RATE.percent} per completed job — no subscription and no setup fees.
          </p>
          <p className="text-slate-500 text-base leading-relaxed mb-9 max-w-xl mx-auto">
            On a $300 repair that&rsquo;s $8. Beta landlords can lock in a founding rate of{' '}
            {FOUNDING_RATE.flat} + {FOUNDING_RATE.percent} — $4.50 on the same job — for as long as they
            use Artrelo.
          </p>
          <Link
            href="/demo"
            className={`group inline-flex items-center justify-center gap-2 bg-[#137fec] text-white px-7 py-3.5 rounded-xl text-base font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 hover:-translate-y-0.5 ${ctaClass('pricing-hero')}`}
          >
            Book a Demo
            <ArrowRight className="w-[18px] h-[18px] group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>
      </section>

      {/* How you'd pay us */}
      <section className="relative bg-white overflow-hidden">
        <div className="absolute inset-0 light-grid"></div>
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-14" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
              How you&rsquo;d pay us
            </h2>
            <p className="text-slate-600 text-lg leading-relaxed">
              Free while we&rsquo;re in beta, then a fee per job that gets done. Simple enough to explain in a sentence.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {payModel.map((item, i) => (
              <div key={item.title} className="feature-card p-7 rounded-2xl" data-reveal style={{ transitionDelay: `${i * 90}ms` }}>
                <div className="w-12 h-12 rounded-xl bg-[#137fec]/[0.08] text-[#137fec] flex items-center justify-center mb-5">
                  <item.icon className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold mb-2.5 text-slate-900">{item.title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How the work gets paid for */}
      <section className="relative bg-[#0b1219] overflow-hidden">
        <div className="absolute inset-0 panel-grid opacity-50"></div>
        <div className="absolute top-1/4 -right-40 w-[28rem] h-[28rem] bg-[#a855f7]/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-1/4 -left-40 w-[28rem] h-[28rem] bg-[#137fec]/10 rounded-full blur-[120px]"></div>

        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-14" data-reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
              <Wallet className="w-3.5 h-3.5" />
              Paying for the work
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white mb-4">
              How the work itself gets paid for
            </h2>
            <p className="text-slate-400 text-lg leading-relaxed">
              Artrelo tracks the money for every job. You can pay vendors yourself, or let Artrelo pay
              them once the work is verified. Here is exactly how both work.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
            {moneyFlow.map((item, i) => (
              <div
                key={item.step}
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-7"
                data-reveal
                style={{ transitionDelay: `${i * 70}ms` }}
              >
                <span className="text-sm font-semibold text-slate-600 tabular-nums">{item.step}</span>
                <h3 className="text-base font-bold text-white mt-3 mb-2">{item.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-7 flex flex-col sm:flex-row gap-5 items-start" data-reveal>
            <div className="w-11 h-11 rounded-xl bg-[#137fec]/[0.15] text-[#5ea8ff] flex items-center justify-center shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white mb-2">Stripe holds the money, not us</h3>
              <p className="text-slate-400 text-sm leading-relaxed">
                Payments and vendor payouts run on Stripe, which handles vendor identity
                verification and bank custody. Vendor banking details never touch our database —
                we store only a reference to the Stripe account.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What's included */}
      <section className="relative bg-slate-50 border-y border-slate-100">
        <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
          <div className="max-w-2xl mb-12" data-reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#137fec]/[0.06] border border-[#137fec]/15 text-[#137fec] text-xs font-semibold tracking-wide mb-4">
              <ShieldCheck className="w-3.5 h-3.5" />
              Included
            </div>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
              What every account gets
            </h2>
            <p className="text-slate-600 text-lg leading-relaxed">
              There is no feature-gated tier ladder to decode. This is the product.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-3.5" data-reveal>
            {included.map((item) => (
              <div key={item} className="flex items-start gap-2.5">
                <Check className="w-[18px] h-[18px] text-[#137fec] shrink-0 mt-0.5" />
                <span className="text-sm text-slate-600">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
