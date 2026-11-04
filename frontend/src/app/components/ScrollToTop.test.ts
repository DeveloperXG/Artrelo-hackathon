import { describe, expect, it } from 'vitest';
import { shouldResetScroll } from './ScrollToTop';

describe('shouldResetScroll', () => {
  it('resets when a link or redirect moves to a new page', () => {
    expect(shouldResetScroll('/dashboard/properties/p1', '/dashboard/requests/r1', 'PUSH')).toBe(true);
    expect(shouldResetScroll('/dashboard', '/dashboard/decisions', 'REPLACE')).toBe(true);
  });

  it('keeps the position when only the query string changes', () => {
    // Same pathname: a filter chip or the Active/Archived switch.
    expect(shouldResetScroll('/portal', '/portal', 'REPLACE')).toBe(false);
    expect(shouldResetScroll('/dashboard/properties/p1', '/dashboard/properties/p1', 'PUSH')).toBe(false);
  });

  it('leaves back/forward and the first load to the browser', () => {
    expect(shouldResetScroll('/dashboard/requests/r1', '/dashboard/requests', 'POP')).toBe(false);
    expect(shouldResetScroll(null, '/dashboard/requests', 'POP')).toBe(false);
  });
});
