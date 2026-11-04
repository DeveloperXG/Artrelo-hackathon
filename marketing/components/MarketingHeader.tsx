import Link from 'next/link';
import AstreloLogo from './AstreloLogo';
import SectionLink from './SectionLink';
import MobileNav from './MobileNav';
import { SIGN_IN_ENABLED, TENANT_SIGNUP_ENABLED } from '@/config/features';
import { appUrl } from '@/lib/appUrl';
import { ctaClass } from '@/lib/analytics';

const navLinkClass = 'text-slate-400 hover:text-white text-sm font-medium transition-colors';

// Stays a server component — only the mobile menu needs state, and that lives in
// MobileNav so the rest of the header ships as static HTML.
//
// CTA hierarchy: "Book a Demo" is the filled button and is visible at every
// width, because it is the one conversion we can actually fulfil today. Sign In
// steps down to a text link (it used to be the white button, which made
// returning users the loudest call on a page aimed at new ones).
export default function MarketingHeader() {
  return (
    <header className="fixed top-0 w-full z-50 bg-[#0b1219]/70 backdrop-blur-xl border-b border-white/[0.07]">
      <div className="max-w-7xl mx-auto flex items-center justify-between px-6 h-16">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Artrelo home">
          <AstreloLogo className="w-9 h-9" />
          <span className="text-white text-lg font-bold tracking-tight">Artrelo</span>
        </Link>

        <nav className="hidden md:flex items-center gap-9" aria-label="Main">
          {/* Section links scroll to the section on the home page without adding
              a #fragment to the URL (see SectionLink). */}
          <SectionLink path="/" section="features" className={navLinkClass}>
            Product
          </SectionLink>
          <SectionLink path="/" section="how-it-works" className={navLinkClass}>
            How it works
          </SectionLink>
          <Link href="/solutions" className={navLinkClass}>
            Solutions
          </Link>
          <Link href="/pricing" className={navLinkClass}>
            Pricing
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {/* Separate gates, from config/features.ts. Enter Code redeems an
              invite a landlord issued, so it follows TENANT_SIGNUP_ENABLED, not
              public landlord sign-up; Sign In only lets an existing account back
              in and follows SIGN_IN_ENABLED. Both link into the SPA, so plain
              <a> + appUrl(), not next/link. */}
          {TENANT_SIGNUP_ENABLED && (
            <a
              href={appUrl('/signup')}
              data-testid="header-enter-code-btn"
              className="hidden lg:inline-flex px-3 py-2 text-slate-400 hover:text-white text-sm font-medium transition-colors"
            >
              Enter Code
            </a>
          )}
          {SIGN_IN_ENABLED && (
            <a
              href={appUrl('/login')}
              data-testid="header-sign-in-btn"
              className="hidden md:inline-flex px-3 py-2 text-slate-300 hover:text-white text-sm font-medium transition-colors"
            >
              Sign In
            </a>
          )}
          <Link
            href="/demo"
            data-testid="header-demo-btn"
            className={`inline-flex items-center bg-[#137fec] hover:bg-[#137fec]/90 text-white px-4 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-[#137fec]/25 ${ctaClass('nav')}`}
          >
            Book a Demo
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
