import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import LegalArticle, { type LegalSection } from '@/components/LegalArticle';
import RevealInit from '@/components/RevealInit';
import { SITE_NAME, SALES_EMAIL } from '@/config/site';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The terms governing your use of the Artrelo maintenance coordination platform.',
  alternates: { canonical: '/terms' },
};

// NOTE: written to match what the product actually does; have counsel review
// before public launch. Things that must stay true of the code, or be changed
// here when the code changes:
//
//  - "Last updated" below and TERMS_VERSION in backend/config/beta.js move
//    together: the version is stored on each landlord at sign-up.
//  - Direct pay is the default and platform payouts are switched on per
//    landlord (Landlord.paymentMode, scripts/payment_mode.js).
//  - Platform payouts: the balance is credited only when Stripe confirms the
//    payment; the job's cost is reserved at booking; the vendor is paid after
//    the tenant confirms (or 48h of silence on evidence that passed) and a
//    further 24h window.
//  - Bank top-up failure and dispute fees: BANK_FAILURE_FEE_CENTS and
//    BANK_DISPUTE_FEE_CENTS (default $5 each); the form states the amounts.
//  - "30 days' notice" before any service fee is the same promise as
//    CHARGE_NOTICE_DAYS in backend/config/beta.js.
//  - Refunds of an unused balance are manual for now (an operator refunds in
//    Stripe on request).
//  - TODO before launch: replace "Artrelo" with the registered legal name.

const linkClass = 'text-[#137fec] font-semibold hover:underline';

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 space-y-1.5">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

const sections: LegalSection[] = [
  {
    id: 'acceptance',
    heading: 'Who these terms are for',
    body: (
      <>
        <p>
          These terms apply to everyone who uses {SITE_NAME}: landlords and property managers, tenants who report
          maintenance issues, and vendors who take jobs through a link we send them. By creating an account, accepting an
          invite, or using a job link, you agree to them.
        </p>
        <p>If you use {SITE_NAME} for a company, you confirm you are allowed to accept these terms for it.</p>
      </>
    ),
  },
  {
    id: 'service',
    heading: 'What Artrelo does, and what it does not',
    body: (
      <>
        <p>
          {SITE_NAME} coordinates maintenance. Tenants report issues; an AI assistant asks follow-up questions and
          suggests a category and urgency; the property manager finds a vendor, approves the work and tracks it to
          completion. The property manager sets the rules, and {SITE_NAME} acts within them.
        </p>
        <List
          items={[
            <>
              <strong>We are not a contractor.</strong> Vendors are independent businesses chosen by the property
              manager. We do not perform repairs, and we do not employ, license, insure or supervise vendors.
            </>,
            <>
              <strong>AI suggestions can be wrong.</strong> Triage, categories, urgency and cost estimates help a person
              decide. The property manager remains responsible for decisions about their property and tenants.
            </>,
            <>
              <strong>Features may change</strong> as the service develops. During the beta, some features may be
              added, changed or removed.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'emergencies',
    heading: 'Emergencies',
    body: (
      <>
        <p>
          <strong>{SITE_NAME} is not an emergency service.</strong> If anyone is in danger, or you suspect a gas leak,
          fire, smoke or carbon monoxide, leave the area and call 911 or your gas utility first.
        </p>
        <p>
          When a tenant reports something urgent, we alert the property manager by in-app notification and email and,
          where it is set up, an automated phone call to the number on their account. These alerts rely on networks,
          devices and other companies&rsquo; services we do not control, so they can be delayed or fail. Property
          managers remain responsible for having their own way to respond to emergencies at their properties, and for
          keeping their phone number current.
        </p>
      </>
    ),
  },
  {
    id: 'accounts',
    heading: 'Accounts',
    body: (
      <p>
        Keep your sign-in details private, and tell us if you think someone else has used your account. You are
        responsible for activity under your account and for keeping your information accurate, including your phone
        number. A vendor job link is for the vendor it was sent to; do not share it.
      </p>
    ),
  },
  {
    id: 'property-managers',
    heading: 'If you manage properties',
    body: (
      <List
        items={[
          'You choose your vendors, and you are responsible for checking they are qualified, licensed and insured as your jurisdiction requires.',
          'You approve work and its cost. Rules you set, such as spending limits, act on your behalf within those limits.',
          "You are responsible for having a lawful basis to share your tenants' information with us, and for telling your tenants that you use Artrelo to manage maintenance.",
          'You remain responsible for your obligations to your tenants under your lease and the law.',
        ]}
      />
    ),
  },
  {
    id: 'tenants-and-vendors',
    heading: 'Tenants and vendors',
    body: (
      <>
        <p>
          <strong>Tenants:</strong> describe issues honestly, and only share photos you are comfortable with your
          property manager and the assigned vendor seeing. Your property manager can read the messages you send to the AI
          assistant. When asked to confirm a repair, tell us if it was not done: if you do not answer, a job whose
          evidence passed our checks is treated as accepted after 48 hours.
        </p>
        <p>
          <strong>Vendors:</strong> quote honestly, keep appointments you accept, and submit truthful completion
          evidence. Photos are checked against the time they were taken, and a job with weak evidence goes to the
          property manager for review instead of closing on its own.
        </p>
      </>
    ),
  },
  {
    id: 'paying-vendors',
    heading: 'Paying vendors',
    body: (
      <>
        <p>
          <strong>By default, property managers pay vendors directly.</strong> When a job is finished, {SITE_NAME} shows
          what is owed to the vendor. The property manager pays them their usual way, such as e-transfer or cheque, and
          marks it paid. That money never passes through {SITE_NAME}; we only keep a record of it. Any disagreement about
          the work or the amount is between the property manager and the vendor, though we will share the job&rsquo;s
          records with both on request.
        </p>
        <p>
          <strong>If we switch on platform payouts for an account</strong>, {SITE_NAME} pays vendors from a balance the
          property manager funds:
        </p>
        <List
          items={[
            <>
              You add funds by card, or by pre-authorized bank debit where offered. Payments are processed by Stripe, and
              your balance is credited only once Stripe confirms the payment. A card top-up includes Stripe&rsquo;s
              processing fee, shown before you pay.
            </>,
            <>
              Bank top-ups take several business days to clear. If your bank refuses a debit, or you dispute one
              afterwards, a fee applies (shown before you pay), and anything already spent from that top-up becomes an
              amount you owe us. Bank top-ups may be paused after a dispute.
            </>,
            <>
              When a vendor is booked, the job&rsquo;s cost is reserved from your balance. The vendor is paid after the
              tenant confirms the work (or the review period passes on evidence that passed our checks), plus a short
              further window in which a problem can still be raised. Work you approve beyond your balance is owed, and is
              paid from your next top-up.
            </>,
            <>
              Your balance is not a bank account and earns no interest. Ask us and we will refund an unused balance to
              the original payment method, less any amounts you owe under these terms.
            </>,
            <>
              Vendors receive payouts through Stripe Connect and agree to Stripe&rsquo;s terms for that. Bank details are
              held by Stripe, not by us.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: 'fees',
    heading: 'Fees',
    body: (
      <>
        <p>
          {SITE_NAME} is in a free beta. Each beta account is free for the period shown when you join, and we will remind
          you before it ends. No billing card is required during the beta. There is no subscription or monthly minimum.
        </p>
        <p>
          After the beta, a service fee may apply to each completed job. We will tell you the amount in advance and give
          you at least 30 days&rsquo; notice before any charge begins, and your access does not switch off when the beta
          ends. Founding terms, such as a locked-in rate, may be offered to beta participants; accepting them does not
          start any billing. Before paid bookings begin, you must separately accept your exact pricing and authorize a
          billing card. Bookings made during your free beta keep their fee waiver when completed later.
        </p>
        <p>
          The service fee is assessed when work is verified complete, whether you pay your vendor directly or use
          platform payouts. Marking the vendor paid records their payment; it does not start or delay the service fee.
          Chargeable completed-job fees are itemized in one monthly invoice and automatically charged to your authorized
          billing card, plus applicable tax. Small balances below the payment minimum carry forward.
        </p>
        <p>
          If an invoice remains unpaid for 14 days, new non-emergency bookings and vendor outreach pause until payment
          is resolved. Existing jobs, vendor payments, account access and emergency alerts continue. Your authorization
          includes retries of unpaid invoices, including after you update your billing card. Disputed charges require
          review rather than an automatic second charge for the disputed amount.
        </p>
      </>
    ),
  },
  {
    id: 'acceptable-use',
    heading: 'Acceptable use',
    body: (
      <p>
        Do not misuse {SITE_NAME}: no attempts to disrupt it or reach it without permission, no unlawful or abusive
        content, no false requests, quotes or completion evidence, and no use that violates other people&rsquo;s rights.
        We may suspend accounts or job links that break these terms.
      </p>
    ),
  },
  {
    id: 'content',
    heading: 'Your content',
    body: (
      <p>
        You keep ownership of what you submit: descriptions, messages, photos and documents. You give us permission to
        use it to run {SITE_NAME}, including sharing it with the people involved in a job as described in our{' '}
        <a href="/privacy" className={linkClass}>
          Privacy Policy
        </a>
        . {SITE_NAME} itself, including its software and design, belongs to us.
      </p>
    ),
  },
  {
    id: 'disclaimers',
    heading: 'Disclaimers',
    body: (
      <p>
        {SITE_NAME} is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we make
        no promises about how quickly a vendor responds or a repair is completed, about the quality of any vendor&rsquo;s
        work, or that the service or its AI suggestions will be error-free or uninterrupted.
      </p>
    ),
  },
  {
    id: 'limitation-of-liability',
    heading: 'Limitation of liability',
    body: (
      <p>
        To the extent the law allows, {SITE_NAME} is not liable for indirect, incidental or consequential losses, or for
        the acts of vendors, tenants or property managers. Our total liability for any claim is limited to the greater of
        the fees you paid us in the twelve months before the claim and $100. This does not limit our responsibility to
        return money in your balance that has not been spent.
      </p>
    ),
  },
  {
    id: 'termination',
    heading: 'Closing your account',
    body: (
      <p>
        You can stop using {SITE_NAME} at any time; contact us to close your account. We may suspend or close accounts
        that break these terms. When an account closes, any unused balance is refunded as described above, and records
        we must keep by law, such as payment records, are retained for the required period.
      </p>
    ),
  },
  {
    id: 'governing-law',
    heading: 'Governing law',
    body: (
      <p>
        These terms are governed by the laws of the Province of Alberta and the federal laws of Canada that apply there.
      </p>
    ),
  },
  {
    id: 'changes',
    heading: 'Changes to these terms',
    body: (
      <p>
        We may update these terms. For a material change, we will email account holders before it takes effect. If you
        keep using {SITE_NAME} after a change takes effect, the updated terms apply.
      </p>
    ),
  },
  {
    id: 'contact',
    heading: 'Contact us',
    body: (
      <p>
        Questions about these terms? Email{' '}
        <a href={`mailto:${SALES_EMAIL}`} className={linkClass}>
          {SALES_EMAIL}
        </a>
        .
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <>
      <RevealInit />
      <LegalArticle
        title="Terms of Service"
        updated="October 18, 2026"
        intro={
          <p>
            These terms explain how {SITE_NAME} works and what each of us is responsible for. We have tried to write them
            plainly; please read them before using the service.
          </p>
        }
        sections={sections}
      />
    </>
  );
}
