import { Camera, Clock, Lock, Wallet } from 'lucide-react';

// The section the product's strongest capability deserves, and the one the
// original marketing brief did not know existed: Artrelo does not stop at
// dispatch, it closes the job and settles what is owed -- recorded for a
// direct-pay landlord (the default), paid through Stripe when payouts are on.
//
// Every number and behaviour below is taken from the implementation, not from
// aspiration:
//   * evidence checks + verdicts     services/completion/evidenceCheck.service.js
//   * 48h tenant window, 24h trailing dispute window
//                                    services/completion/jobCompletion.service.js
//                                    (AUTO_CONFIRM_AFTER_REVIEW_MS, TRAILING_DISPUTE_MS)
//   * silence-vs-escalation split    services/completion/completionSweeper.service.js
//   * hold / settle                  services/ledger/ledger.service.js
//   * Stripe custody                 services/ledger/payoutProvider.service.js
//
// The honesty in "we cannot prove presence" is deliberate and load-bearing: the
// evidence service says so itself, geo is only ever client_reported, and a buyer
// who has been sold GPS-verified attendance elsewhere will recognise the
// difference.

const steps = [
  {
    step: '01',
    title: 'The vendor submits proof',
    body: 'Before-and-after photos with their original capture time read from the file, not from when they were uploaded.',
  },
  {
    step: '02',
    title: 'The evidence is scored',
    body: 'Photos that are stale, or taken far from the property, push the job to review rather than through it. Location is self-reported, so it can only ever raise a flag — never clear one.',
  },
  {
    step: '03',
    title: 'Your tenant has the final word',
    body: 'They confirm the work was actually done. Silence on evidence that already passed counts as acceptance after 48 hours; silence on evidence that did not pass comes to you instead.',
  },
  {
    step: '04',
    title: 'Then it is settled',
    body: 'A further 24 hours after that, the job closes and the payment is due: you pay the vendor your usual way, or Artrelo pays them if payouts are on. A dispute inside that window stops it.',
  },
];

const guarantees = [
  {
    icon: Wallet,
    title: 'Nothing is owed before it is checked',
    body: 'A job’s cost only becomes due once the work is verified, and you always see what each finished job owes and what you have paid.',
  },
  {
    icon: Camera,
    title: 'No proof, no sign-off',
    body: 'A job with weak evidence becomes a decision on your desk. It never quietly closes itself.',
  },
  {
    icon: Clock,
    title: 'Small overruns do not wake you',
    body: 'A final cost within 2% or $10 of the estimate settles on its own. Anything beyond that is yours to approve.',
  },
  {
    icon: Lock,
    title: 'If Artrelo pays, Stripe holds the money',
    body: 'With payouts on, Stripe handles vendor identity checks and bank custody. Vendor banking details never touch our database.',
  },
];

export default function CompletionProofSection() {
  return (
    <section className="relative bg-[#0b1219] overflow-hidden">
      <div className="absolute inset-0 panel-grid opacity-50"></div>
      <div className="absolute top-1/3 -left-40 w-[28rem] h-[28rem] bg-[#137fec]/10 rounded-full blur-[120px]"></div>
      <div className="absolute bottom-1/4 -right-40 w-[28rem] h-[28rem] bg-[#a855f7]/10 rounded-full blur-[120px]"></div>

      <div className="relative max-w-7xl mx-auto px-6 py-20 md:py-24">
        <div className="max-w-2xl mb-14" data-reveal>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[#5ea8ff] text-xs font-semibold tracking-wide mb-4">
            <Wallet className="w-3.5 h-3.5" />
            Proof, then payment
          </div>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white mb-4">
            The vendor gets paid after the work is verified.
          </h2>
          <p className="text-slate-400 text-lg leading-relaxed">
            Most tools hand you a dispatched vendor and stop. Artrelo closes the job: proof from the
            vendor, confirmation from your tenant, and only then is the vendor owed anything.
          </p>
        </div>

        {/* The sequence. Numbered rather than carded — it is one chain of events,
            not four independent features. */}
        <ol className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {steps.map((item, i) => (
            <li
              key={item.step}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-7"
              data-reveal
              style={{ transitionDelay: `${i * 70}ms` }}
            >
              <span className="text-sm font-semibold text-slate-600 tabular-nums">{item.step}</span>
              <h3 className="text-base font-bold text-white mt-3 mb-2">{item.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{item.body}</p>
            </li>
          ))}
        </ol>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {guarantees.map((item, i) => (
            <div
              key={item.title}
              className="rounded-2xl border border-white/10 bg-white/[0.03] p-6"
              data-reveal
              style={{ transitionDelay: `${i * 70}ms` }}
            >
              <div className="w-10 h-10 rounded-xl bg-[#137fec]/[0.15] text-[#5ea8ff] flex items-center justify-center mb-4">
                <item.icon className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-white mb-2">{item.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
