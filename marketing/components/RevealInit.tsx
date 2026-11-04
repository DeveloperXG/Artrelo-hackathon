'use client';

import { useEffect } from 'react';
import { SECTION_STORAGE_KEY, scrollToSection } from '@/lib/scrollToSection';

// Replaces the SPA's useRevealOnScroll hook. Fades in every [data-reveal]
// element as it enters the viewport (styles live in app/globals.css, gated
// behind `html.js`). Mount once per page that uses [data-reveal] — layouts in
// the App Router don't remount on navigation, so a per-page mount is what
// re-runs the observer for each route.
//
// It also honors a pending cross-page section scroll left by SectionLink, so
// clicking e.g. "Product" from another page lands on the right section without
// a #fragment in the URL.
export default function RevealInit() {
  useEffect(() => {
    // Signals CSS that JS is running, which activates the reveal hidden-state
    // rules. Without this, content renders fully visible (good for no-JS/SEO).
    document.documentElement.classList.add('js');

    const els = Array.from(document.querySelectorAll('[data-reveal]'));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal-in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));

    // Honor a section target stashed by SectionLink during cross-page navigation.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(SECTION_STORAGE_KEY);
      if (pending) sessionStorage.removeItem(SECTION_STORAGE_KEY);
    } catch {
      pending = null;
    }
    if (pending) {
      const id = pending;
      // setTimeout (not rAF) so it still fires in a background/hidden tab.
      timer = setTimeout(() => scrollToSection(id), 0);
    }

    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return null;
}
