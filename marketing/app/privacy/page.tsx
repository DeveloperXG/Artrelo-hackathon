import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import LegalArticle, { type LegalSection } from '@/components/LegalArticle';
import RevealInit from '@/components/RevealInit';
import { SITE_NAME, PRIVACY_EMAIL } from '@/config/site';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How Artrelo collects, uses, shares and protects personal information.',
  alternates: { canonical: '/privacy' },
};

// NOTE: written to match what the product actually does; have counsel review
// before public launch. Keep these true of the code:
//
//  - What a vendor sees before and after accepting is enforced in
//    backend/services/vendor/vendorBrief.service.js (the privacy boundary).
//    Change one, change the other.
//  - Only the TEXT of a request and the intake chat goes to the AI provider
//    (services/ai). Photos are not sent to it; if that changes, say so here.
//  - From completion photos we read only the capture time (exifTakenAt), not
//    GPS. Vendor check-in location is optional and self-reported.
//  - The service providers listed are the ones the code calls. Add a row when a
//    new one is introduced (e.g. error monitoring).
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

const PROVIDERS: { name: string; purpose: string }[] = [
  { name: 'Stripe', purpose: 'card and bank payments, and vendor payouts and identity checks' },
  { name: 'OpenAI', purpose: 'reading the text of maintenance requests to suggest a category and urgency' },
  { name: 'Cloudinary', purpose: 'storing photos and videos attached to requests and completed jobs' },
  { name: 'Resend', purpose: 'sending email' },
  { name: 'Twilio', purpose: 'automated emergency phone calls to property managers' },
  { name: 'MongoDB Atlas', purpose: 'our database' },
  { name: 'Railway', purpose: 'hosting the service' },
  {
    name: 'Sentry',
    purpose: 'error reports, so we can fix what breaks; they carry no request contents, contact details or link tokens',
  },
  { name: 'Plausible Analytics', purpose: 'cookieless visit counts on this marketing website only' },
];

const sections: LegalSection[] = [
  {
    id: 'scope',
    heading: 'Who this covers',
    body: (
      <p>
        This policy covers the personal information of everyone who uses {SITE_NAME}: property managers and landlords,
        their tenants, and the vendors who take jobs. We handle it in line with applicable Canadian privacy law, including
        Alberta&rsquo;s Personal Information Protection Act and the federal PIPEDA.
      </p>
    ),
  },
  {
    id: 'information-we-collect',
    heading: 'Information we collect',
    body: (
      <List
        items={[
          <>
            <strong>Property managers:</strong> name, email, phone number, company, your properties and units, the
            vendors you add, your approval rules, and your activity in the app. If you use platform payouts, Stripe holds
            your card or bank details; we keep only what identifies a saved method, such as the last four digits.
          </>,
          <>
            <strong>Tenants:</strong> name, email, phone number and unit; what you report, including your messages to
            our AI assistant, photos and videos, access notes and preferred times; your confirmations, ratings and any
            dispute or appeal you raise.
          </>,
          <>
            <strong>Vendors:</strong> name or business name, email, phone and trade; your quotes, availability and
            responses; completion reports and photos, including the time each photo was taken, read from the file; and,
            only if you choose to share it, your location when you check in on site. Payout and identity details are
            collected and held by Stripe.
          </>,
          <>
            <strong>Technical:</strong> sign-in cookies, logs of requests to our servers, and, for some security
            checks, a scrambled (hashed) form of your IP address and browser.
          </>,
        ]}
      />
    ),
  },
  {
    id: 'how-we-use-information',
    heading: 'How we use it',
    body: (
      <>
        <p>
          To run {SITE_NAME}: take and triage maintenance requests, find and contact vendors, schedule visits, verify
          finished work, record or make payments, send notifications (in the app, by email, and for emergencies by phone),
          provide support, keep the service secure, and meet legal obligations. We also use it, in aggregate, to
          understand how the service is used and improve it.
        </p>
        <p>We do not sell personal information, and we do not use it for advertising.</p>
      </>
    ),
  },
  {
    id: 'ai',
    heading: 'How our AI assistant uses your information',
    body: (
      <p>
        When a tenant reports an issue, the text of the report and their chat with our assistant is sent to OpenAI to
        suggest follow-up questions, a category and an urgency. Photos are not sent to it. Under OpenAI&rsquo;s terms for
        its API, this data is not used to train its models by default. The assistant&rsquo;s output is a suggestion: a
        person, the property manager, decides what happens. Separately, fixed safety rules (not AI) flag reports of gas,
        fire, smoke or carbon monoxide as emergencies.
      </p>
    ),
  },
  {
    id: 'how-we-share-information',
    heading: 'Who we share it with',
    body: (
      <>
        <List
          items={[
            <>
              <strong>Between a property manager and their tenants.</strong> A property manager sees their tenants&rsquo;
              requests, including the original messages sent to the AI assistant (tenants are told this in the chat).
              Tenants see their property manager&rsquo;s name and phone number so they can reach them when something is
              urgent.
            </>,
            <>
              <strong>With vendors, in two steps.</strong> Before accepting a job, a vendor sees the description,
              photos, urgency, the city, and the property manager&rsquo;s name and company. After accepting, they also
              see the address and unit, the tenant&rsquo;s first name and last initial, access notes, and the property
              manager&rsquo;s contact details. A tenant&rsquo;s phone number and email are never given to vendors.
            </>,
            <>
              <strong>With service providers</strong> who run parts of {SITE_NAME} for us, under contract, and only for
              that purpose (listed below).
            </>,
            <>
              <strong>When required by law</strong>, or to protect someone&rsquo;s safety, or in connection with a sale
              or reorganization of our business (in which case this policy continues to apply).
            </>,
          ]}
        />
        <p>Our service providers:</p>
        <List
          items={PROVIDERS.map((p) => (
            <>
              <strong>{p.name}</strong>: {p.purpose}
            </>
          ))}
        />
      </>
    ),
  },
  {
    id: 'outside-canada',
    heading: 'Storage outside Canada',
    body: (
      <p>
        Several of our service providers store or process information outside Canada, mainly in the United States. While
        it is there, it is subject to the laws of that country, which may allow authorities there to access it. You can
        ask us for more information about how providers outside Canada handle it.
      </p>
    ),
  },
  {
    id: 'cookies',
    heading: 'Cookies and analytics',
    body: (
      <>
        <p>
          The {SITE_NAME} app uses only essential cookies, to keep you signed in. It does not use analytics or advertising
          trackers.
        </p>
        <p>
          This marketing website uses Plausible Analytics, which sets no cookies, collects no personal data and does not
          track visitors across sites. It counts pages viewed, which buttons were clicked, whether the contact form was
          started and sent, and the portfolio-size range chosen on it. What you type into the form is never sent to
          analytics.
        </p>
      </>
    ),
  },
  {
    id: 'data-security',
    heading: 'Security',
    body: (
      <p>
        Information is encrypted in transit and at rest, access is limited to what each person and service needs, vendor
        job links expire, and passwords are stored only as secure hashes. No system is perfectly secure; if a breach puts
        you at real risk of significant harm, we will tell you and the regulator as the law requires.
      </p>
    ),
  },
  {
    id: 'data-retention',
    heading: 'How long we keep it',
    body: (
      <List
        items={[
          'Account information: while the account is open.',
          'Maintenance requests and their history: while the property manager’s account is open, because they are the property’s maintenance record. A rejected request that is not appealed is deleted when its appeal window closes.',
          'Payment and payout records: as long as tax and accounting law requires, even after an account closes.',
          'After an account closes, we delete or anonymize the rest within 90 days. Backups expire on their own schedule.',
        ]}
      />
    ),
  },
  {
    id: 'your-rights',
    heading: 'Your choices and rights',
    body: (
      <>
        <p>
          You can ask to see the personal information we hold about you, ask us to correct it, or withdraw your consent
          (which may mean we can no longer provide the service). You can also ask us to stop non-essential emails. A
          tenant&rsquo;s
          requests also belong to their property manager&rsquo;s records, so some requests are best made to them as well.
        </p>
        <p>
          We will reply within 30 days. If you are not satisfied, you can complain to the Office of the Information and
          Privacy Commissioner of Alberta or the Office of the Privacy Commissioner of Canada.
        </p>
      </>
    ),
  },
  {
    id: 'children',
    heading: 'Children',
    body: <p>{SITE_NAME} is not meant for children under 16, and we do not knowingly collect their information.</p>,
  },
  {
    id: 'changes',
    heading: 'Changes to this policy',
    body: (
      <p>
        We may update this policy. Material changes will be posted here with a new date, and we will email account
        holders about them before they take effect.
      </p>
    ),
  },
  {
    id: 'contact',
    heading: 'Contact us',
    body: (
      <p>
        Our privacy contact handles questions and requests about personal information. Email{' '}
        <a href={`mailto:${PRIVACY_EMAIL}`} className={linkClass}>
          {PRIVACY_EMAIL}
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <>
      <RevealInit />
      <LegalArticle
        title="Privacy Policy"
        updated="October 14, 2026"
        intro={
          <p>
            This policy explains what personal information {SITE_NAME} collects, why, who sees it, and the choices you
            have.
          </p>
        }
        sections={sections}
      />
    </>
  );
}
