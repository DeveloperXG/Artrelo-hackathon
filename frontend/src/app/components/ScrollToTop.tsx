import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType, type NavigationType } from 'react-router-dom';

/**
 * Whether a navigation should start the new page at the top.
 *
 * - Keyed on the pathname only: several pages keep filter state in the query
 *   string (`?view=archived`, `?unit=`), and flipping a filter must not throw
 *   the reader back to the top of the list they are working through.
 * - Not on POP (back/forward, and the first render after a reload): that is the
 *   browser's own scroll restoration. It only works where the page is already
 *   tall enough when it runs; a list that refetches on mount clamps it to the
 *   top. Restoring after data loads would need per-entry saved positions, which
 *   is a separate change.
 */
export function shouldResetScroll(prevPathname: string | null, nextPathname: string, navigationType: NavigationType) {
  if (navigationType === 'POP') return false;
  return prevPathname !== nextPathname;
}

/**
 * The SPA scrolls the window, and `BrowserRouter` (unlike the data routers'
 * `<ScrollRestoration>`) leaves it alone, so without this a page opened from a
 * scrolled list starts part-way down. Mounted once, inside the router.
 */
export default function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<string | null>(null);

  // Layout effect, so the reset lands before the new page paints rather than
  // flashing it at the old offset first.
  useLayoutEffect(() => {
    if (shouldResetScroll(previous.current, pathname, navigationType)) {
      window.scrollTo(0, 0);
    }
    previous.current = pathname;
  }, [pathname, navigationType]);

  return null;
}
