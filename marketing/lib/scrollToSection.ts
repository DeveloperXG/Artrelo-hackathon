// Section navigation without #fragments in the URL. Target sections need an id
// and a scroll-mt-* class so they clear the fixed header. Mirrors the SPA's old
// useSectionScroll behavior: same-page clicks scroll directly; cross-page clicks
// stash the target here and RevealInit reads it on the destination page.
export const SECTION_STORAGE_KEY = 'astrelo:scrollToSection';

export function scrollToSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}
