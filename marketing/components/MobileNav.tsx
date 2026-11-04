'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import SectionLink from './SectionLink';
import { SIGN_IN_ENABLED, TENANT_SIGNUP_ENABLED } from '@/config/features';
import { appUrl } from '@/lib/appUrl';

// The mobile menu. Before this existed the header was `hidden md:flex` with no
// fallback, so every visitor under 768px had no navigation at all — only the
// logo and a Sign In button. This is net-new, not a restyle.
//
// The header keeps "Book a Demo" outside this menu so the primary action never
// costs a tap to reach.

// Anything tabbable that this panel can contain. Kept narrow on purpose: the
// panel holds links and one button, so a fuller selector would be dead weight.
const FOCUSABLE = 'a[href], button:not([disabled])';

const itemClass =
  'block w-full py-3 rounded-md text-slate-300 hover:text-white text-base font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5ea8ff]';

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  // The overlay is portalled to <body>, which only exists on the client.
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    // Move focus into the panel so a keyboard user is not left behind the
    // toggle. The panel itself takes it, not the first link: script focus on a
    // link draws its focus ring even after a tap, which outlined "Product" on
    // every open. Tab from here lands on the first link as before.
    // Also stop the page behind from scrolling. overflowY (not overflow)
    // because <body> carries overflow-x-hidden from the layout — clearing the
    // shorthand on close would silently drop it.
    panel.focus();
    document.body.style.overflowY = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        toggleRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped the panel.
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Rotating to a tablet/desktop width reveals the real nav, which would
    // leave this panel stranded on top of it.
    const onResize = () => {
      if (window.innerWidth >= 768) setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      document.body.style.overflowY = '';
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="md:hidden">
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="inline-flex items-center justify-center w-11 h-11 -mr-2 rounded-lg text-slate-300 hover:text-white hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5ea8ff]"
      >
        {open ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
      </button>

      {/* Portalled to <body> because the header carries backdrop-blur, and a
          backdrop-filter ancestor both becomes the containing block for fixed
          children (so the backdrop's bottom-0 collapsed to the header's 64px)
          and stops their own backdrop-filter seeing past it (so nothing
          behind the panel was blurred). */}
      {mounted &&
        createPortal(
          <>
            {/* Backdrop. Sits under the panel but over the page, blurs it the
                way the desktop header does, and closes on tap. */}
            {open && (
              <div
                className="md:hidden fixed inset-x-0 top-16 bottom-0 z-40 bg-[#0b1219]/50 backdrop-blur-md"
                onClick={close}
                aria-hidden="true"
              />
            )}

            <div
              id="mobile-nav-panel"
              ref={panelRef}
              hidden={!open}
              tabIndex={-1}
              className="md:hidden fixed inset-x-0 top-16 z-50 border-b border-white/[0.07] bg-[#0b1219]/80 backdrop-blur-xl focus:outline-none"
            >
              <nav aria-label="Mobile" className="max-w-7xl mx-auto px-6 py-4 divide-y divide-white/[0.06]">
                <SectionLink path="/" section="features" className={itemClass} onNavigate={close}>
                  Product
                </SectionLink>
                <SectionLink path="/" section="how-it-works" className={itemClass} onNavigate={close}>
                  How it works
                </SectionLink>
                <Link href="/solutions" className={itemClass} onClick={close}>
                  Solutions
                </Link>
                <Link href="/pricing" className={itemClass} onClick={close}>
                  Pricing
                </Link>
                <Link href="/contact" className={itemClass} onClick={close}>
                  Contact
                </Link>

                {/* These live in the SPA, so plain <a> + appUrl(). Gated separately:
                    Sign In by SIGN_IN_ENABLED, Enter Code by TENANT_SIGNUP_ENABLED. */}
                {(SIGN_IN_ENABLED || TENANT_SIGNUP_ENABLED) && (
                  <div className="pt-4 flex flex-col gap-3">
                    {SIGN_IN_ENABLED && (
                      <a
                        href={appUrl('/login')}
                        className="w-full text-center bg-white hover:bg-slate-100 text-[#0b1219] px-5 py-3 rounded-lg text-sm font-semibold transition-all"
                      >
                        Sign In
                      </a>
                    )}
                    {TENANT_SIGNUP_ENABLED && (
                      <a
                        href={appUrl('/signup')}
                        className="w-full text-center border border-white/10 text-slate-300 hover:text-white px-5 py-3 rounded-lg text-sm font-medium transition-colors"
                      >
                        Tenant: Enter Code
                      </a>
                    )}
                  </div>
                )}
              </nav>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
