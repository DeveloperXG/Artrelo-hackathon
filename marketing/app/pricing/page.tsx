import type { Metadata } from 'next';
import MarketingCta from '@/components/MarketingCta';
import RevealInit from '@/components/RevealInit';
import PricingSection from '@/components/PricingSection';
import { FAQ_EVENT_CLASS } from '@/lib/analytics';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Free during the beta, then $5 + 1% per completed job — no subscription and no setup fees. Founding landlords lock in $3 + 0.5%.',
  alternates: { canonical: '/pricing' },
};

// Every answer here is checkable against the product. The previous set described
// proration, accepted card types, cancellation windows and a free trial, none of
// which exist — see the note at the top of components/PricingSection.tsx.
const faqs = [
  {
    q: 'What does Artrelo cost?',
    a: "Nothing during the beta. After it, $5 plus 1% of the job for each completed job — $8 on a $300 repair. Founding landlords lock in $3 plus 0.5% for good. Your dashboard shows your rate before it ever applies, and we give at least 30 days' notice before anything is charged. No setup fees, and no charge for requests that don't become jobs.",
  },
  {
    q: 'What is the founding rate?',
    a: "Landlords who join during the beta can accept a founding offer: $3 plus 0.5% per completed job instead of $5 plus 1%, locked in for as long as they use Artrelo. It never starts billing on its own; the 30-day notice still applies.",
  },
  {
    q: 'Do I need to fund a wallet to use Artrelo?',
    a: 'No. By default you pay vendors yourself, by e-transfer or cheque, and mark the job paid; Artrelo keeps the record. If you would rather Artrelo paid them, we can switch that on: you fund a balance and the vendor is paid once the work is verified.',
  },
  {
    q: 'Can I keep my own vendors?',
    a: "Yes — your vendor list is yours, and preferred vendors are matched first. Artrelo only looks beyond your list if you've allowed it, and you can require approval before it does.",
  },
  {
    q: 'What happens if my tenant says the work was not done?',
    a: "The job moves to a disputed state and comes to you. Vendors submit completion evidence and the tenant confirms it; a job that fails either check goes to review before it is marked done or any money is released.",
  },
  {
    q: 'Does Artrelo replace my property management software?',
    a: 'No. Artrelo is the maintenance coordination layer around your existing operation — intake, triage, vendor routing, approvals, scheduling and tracking payment for repairs. It does not handle leasing, rent collection or accounting.',
  },
  {
    q: 'How do I get my portfolio into Artrelo?',
    a: 'You import it from a spreadsheet. Upload your properties and units as a CSV and configure your approval rules from there — there is no integration to build first.',
  },
];

export default function PricingPage() {
  return (
    <>
      <RevealInit />

      <PricingSection />

      {/* FAQ */}
      <section className="bg-white">
        <div className="max-w-3xl mx-auto px-6 py-20 md:py-24">
          <div className="text-center mb-12" data-reveal>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">Frequently asked questions</h2>
            <p className="text-slate-600 text-lg">Pricing, payments, and how Artrelo fits your operation.</p>
          </div>
          <div className="space-y-4">
            {faqs.map((faq, i) => (
              <details
                key={faq.q}
                data-reveal
                style={{ transitionDelay: `${i * 50}ms` }}
                className="group rounded-2xl border border-slate-200 bg-white p-6 [&_summary]:cursor-pointer"
              >
                <summary
                  className={`flex items-center justify-between gap-4 font-semibold text-slate-900 list-none ${FAQ_EVENT_CLASS}`}
                >
                  {faq.q}
                  <span className="text-[#137fec] text-xl leading-none transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="text-slate-600 text-sm leading-relaxed mt-3">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <MarketingCta
        heading={<>Get a number for <span className="text-gradient-animated">your portfolio.</span></>}
        body="Show us how you handle maintenance today and we'll show you what Artrelo would automate — and what it would cost to run."
      />
    </>
  );
}
