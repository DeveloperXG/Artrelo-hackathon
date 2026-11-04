import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import './globals.css';
import MarketingHeader from '@/components/MarketingHeader';
import MarketingFooter from '@/components/MarketingFooter';
import JsonLd from '@/components/JsonLd';
import { SITE_URL, SITE_NAME, SITE_TAGLINE, SALES_EMAIL, PLAUSIBLE_DOMAIN } from '@/config/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Artrelo — AI Maintenance on Autopilot',
    template: '%s | Artrelo',
  },
  description:
    'Artrelo is the AI-first triage and dispatch platform for landlords. Automate request intake, urgency detection, vendor routing, and scheduling from one command center.',
  applicationName: SITE_NAME,
  // A real .png in public/, not Next's generated `opengraph-image` route.
  // That route emits an EXTENSIONLESS file, and production serves this export
  // with `serve out` (see railway.json), which types responses by file
  // extension — the card would have gone out as the wrong content type and
  // every crawler would have rejected it. An explicit .png is correct on any
  // static host.
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: SITE_URL,
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Artrelo — AI maintenance coordination for property managers',
      },
    ],
  },
  // Until this image existed, every share of an artrelo.com link — including
  // every CTA link anyone pasted into Slack or an email — rendered as a bare
  // text card.
  twitter: {
    card: 'summary_large_image',
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.ico', type: 'image/x-icon', sizes: '16x16 32x32 48x48 96x96 256x256' },
      { url: '/favicon.png', type: 'image/png', sizes: '96x96' },
    ],
    apple: [{ url: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0b1219',
};

// Organization structured data — helps search engines associate the brand,
// logo, and contact channel. No ratings/reviews (those would be fabricated).
const organizationLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/logo.svg`,
  description: SITE_TAGLINE,
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'sales',
    email: SALES_EMAIL,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white font-sans text-slate-900 antialiased overflow-x-hidden">
        <JsonLd data={organizationLd} />
        <MarketingHeader />
        <main>{children}</main>
        <MarketingFooter />

        {/* Plausible: cookieless and aggregate-only, which is why there is no
            consent banner on this site. The `tagged-events` build is what lets
            a CTA in a server component report itself through a class name
            instead of an onClick — see lib/analytics.ts.

            The inline stub defines the queue so a track() call during or just
            after hydration is never lost, and never throws if the script is
            blocked. */}
        {PLAUSIBLE_DOMAIN && (
          <>
            <Script
              id="plausible-init"
              strategy="afterInteractive"
            >{`window.plausible=window.plausible||function(){(window.plausible.q=window.plausible.q||[]).push(arguments)}`}</Script>
            <Script
              id="plausible"
              strategy="afterInteractive"
              data-domain={PLAUSIBLE_DOMAIN}
              src="https://plausible.io/js/script.tagged-events.js"
            />
          </>
        )}
      </body>
    </html>
  );
}
