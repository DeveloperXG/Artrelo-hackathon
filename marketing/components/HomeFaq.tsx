import JsonLd from '@/components/JsonLd';
import { FAQ_EVENT_CLASS } from '@/lib/analytics';

// Operational objections, not SaaS filler. Every answer is checkable:
//
//   own vendors / external search   models/LandlordPolicy.js
//   vendor access by link           services/vendor/jobToken.service.js
//   emergencies                     services/ai/safetyGate.service.js
//   vendor non-response             services/vendor/vendorOutreachSweeper.service.js
//   per-property rules              LandlordPolicy propertyQuotas/categoryQuotas/unitQuotas
//   tenant contact never to vendors services/vendor/vendorBrief.service.js
//   (masked texting returns to this answer when RELAY_SMS_ENABLED goes on)
//   portfolio import                services/property/{portfolioBatch,unitBatch}.service.js
//   uncertainty                     services/ai/routingReadiness.service.js READINESS_STATES
//
// Native <details>, so it still opens with JavaScript disabled.

const faqs = [
  {
    q: 'Can I use my own vendors?',
    a: 'Yes — your vendor list is yours, and a preferred vendor for the trade is matched first. Artrelo only looks beyond your list if you have allowed it, and you can require approval before it does.',
  },
  {
    q: 'Do my vendors have to download an app?',
    a: 'No. A vendor gets a private link to the one job they have been offered. No account, no app, no password — and the link stops working when the job is done.',
  },
  {
    q: 'Does Artrelo replace my property management software?',
    a: 'No. Artrelo is the maintenance coordination layer around your existing operation — intake, triage, routing, approvals, scheduling and paying for repairs. It does not do leasing, rent collection or accounting.',
  },
  {
    q: 'How do tenants report a problem?',
    a: 'Through a guided chat. Artrelo asks the follow-up questions you would have had to ask, and requests a photo when one would help.',
  },
  {
    q: 'What happens with a genuine emergency?',
    a: 'Hazards like a suspected gas leak, fire or smoke are caught by fixed rules rather than by a model deciding case by case. The request is forced to emergency, ordinary troubleshooting is suppressed, and the tenant is told to get out and call 911 or their gas utility first. You are emailed at once, and phoned where calling is set up.',
  },
  {
    q: 'What if a vendor does not respond?',
    a: 'Artrelo moves on. When a vendor declines or lets the window lapse, the next-best match is contacted automatically, up to the number of attempts you allow.',
  },
  {
    q: 'Can rules be different for different properties?',
    a: 'Yes. Set a default spend quota and override it per property, per category of work, or per individual unit.',
  },
  {
    q: 'Does my tenant’s phone number get shared with vendors?',
    a: 'No. A vendor sees the tenant’s first name and last initial, the address and the access notes once they accept the job — never the tenant’s phone number or email. The visit time is arranged through Artrelo: the vendor proposes it and the tenant confirms it.',
  },
  {
    q: 'How do I get my portfolio into Artrelo?',
    a: 'Import it from a spreadsheet. Upload your properties and units as a CSV, then set your approval rules — there is no integration to build first.',
  },
  {
    q: 'What happens when Artrelo is not sure?',
    a: 'It says so rather than guessing. A request can be held for one more answer from the tenant, for a photo, or for your review — and anything it cannot route confidently is handed to you to assign.',
  },
];

// Built from the same array the page renders, so the structured data can never
// describe questions the page does not show — the usual way FAQ schema turns
// into a rich-result penalty.
const faqLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.q,
    acceptedAnswer: { '@type': 'Answer', text: faq.a },
  })),
};

export default function HomeFaq() {
  return (
    <section className="bg-slate-50 border-t border-slate-100">
      <JsonLd data={faqLd} />
      <div className="max-w-3xl mx-auto px-6 py-20 md:py-24">
        <div className="text-center mb-12" data-reveal>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900 mb-4">
            The questions operators actually ask
          </h2>
          <p className="text-slate-600 text-lg">
            How Artrelo fits the vendors, properties and process you already have.
          </p>
        </div>
        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <details
              key={faq.q}
              data-reveal
              style={{ transitionDelay: `${i * 40}ms` }}
              className="group rounded-2xl border border-slate-200 bg-white p-6 [&_summary]:cursor-pointer"
            >
              <summary
                className={`flex items-center justify-between gap-4 font-semibold text-slate-900 list-none ${FAQ_EVENT_CLASS}`}
              >
                {faq.q}
                <span className="text-[#137fec] text-xl leading-none transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="text-slate-600 text-sm leading-relaxed mt-3">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
