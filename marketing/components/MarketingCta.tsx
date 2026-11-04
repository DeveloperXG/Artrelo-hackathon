import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { isRouteAvailable, isSpaAuthRoute } from '@/config/features';
import { appUrl } from '@/lib/appUrl';
import { ctaClass } from '@/lib/analytics';

interface MarketingCtaProps {
  heading: ReactNode;
  body: string;
  primaryLabel?: string;
  primaryTo?: string;
  secondaryLabel?: string;
  secondaryTo?: string;
}

// Renders an internal marketing link (next/link) or a cross-app SPA link
// (plain <a> + appUrl) depending on the destination. Sign-up and sign-in live
// in the SPA; everything else is a marketing page.
function CtaLink({ to, className, children }: { to: string; className: string; children: ReactNode }) {
  if (isSpaAuthRoute(to)) {
    return (
      <a href={appUrl(to)} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={to} className={className}>
      {children}
    </Link>
  );
}

// The dark closing CTA panel shared across marketing pages.
//
// Every marketing page renders this with the defaults, so these two lines are
// the site-wide primary CTA. Booking a demo — not self-serve sign-up — is the
// conversion we can actually fulfil today: there is no billing behind
// /landlord-signup, so "Get Started" pointed at an experience that does not
// finish.
//
// The secondary is opt-in rather than defaulted: its old default ("Talk to
// Sales" -> /contact) duplicated the primary, and two buttons to the same place
// only dilutes the click.
export default function MarketingCta({
  heading,
  body,
  primaryLabel = 'Book a Demo',
  primaryTo = '/demo',
  secondaryLabel,
  secondaryTo,
}: MarketingCtaProps) {
  // Hide the primary CTA while it points at a gate that is closed.
  const showPrimary = isRouteAvailable(primaryTo);

  return (
    <section className="bg-slate-50 px-6 py-20 md:py-24">
      <div className="max-w-7xl mx-auto" data-reveal>
        <div className="bg-[#0b1219] rounded-3xl p-12 md:p-20 text-center relative overflow-hidden border border-white/[0.06] shadow-2xl">
          <div className="absolute inset-0 panel-grid opacity-40"></div>
          <div className="absolute -top-32 -right-32 w-[30rem] h-[30rem] cta-glow-purple blur-[100px] opacity-60"></div>
          <div className="absolute -bottom-32 -left-32 w-[30rem] h-[30rem] cta-glow-blue blur-[100px] opacity-60"></div>
          <div className="relative z-10 max-w-2xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight text-white leading-[1.1]">{heading}</h2>
            <p className="text-slate-400 text-lg mb-10 leading-relaxed max-w-xl mx-auto">{body}</p>
            <div className="flex flex-col sm:flex-row justify-center gap-3.5">
              {showPrimary && (
                <CtaLink
                  to={primaryTo}
                  className={`group inline-flex items-center justify-center gap-2 bg-[#137fec] text-white px-8 py-4 rounded-xl text-base font-semibold hover:bg-[#137fec]/90 transition-all shadow-lg shadow-[#137fec]/30 hover:-translate-y-0.5 ${ctaClass('final-cta')}`}
                >
                  {primaryLabel}
                  <ArrowRight className="w-[18px] h-[18px] group-hover:translate-x-0.5 transition-transform" />
                </CtaLink>
              )}
              {secondaryLabel && secondaryTo && (
                <CtaLink
                  to={secondaryTo}
                  className="inline-flex items-center justify-center bg-white/[0.05] border border-white/10 backdrop-blur-md text-white px-8 py-4 rounded-xl text-base font-semibold hover:bg-white/[0.1] transition-all hover:-translate-y-0.5"
                >
                  {secondaryLabel}
                </CtaLink>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
