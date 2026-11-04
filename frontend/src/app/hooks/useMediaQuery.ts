import { useEffect, useState } from 'react';

/** Tailwind's `lg` — where the landlord layout swaps the mobile bar for the sidebar. */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * Whether a media query matches, kept live. For choosing what to MOUNT, not
 * just what to show: a component with side effects (a poller, a fetch) hidden
 * with CSS still runs, so rendering it twice for two breakpoints doubles them.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
