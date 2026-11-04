import { describe, expect, it } from 'vitest';
import { decisionHref, decisionsFocusHref } from './decisionHref';

describe('decisionHref', () => {
  it('opens the Vendor Routing tab, where vendor decisions are made', () => {
    expect(decisionHref('r1')).toBe('/dashboard/requests/r1?tab=routing');
  });

  it('also focuses the next-steps panel when routing is paused', () => {
    expect(decisionHref('r1', { paused: true })).toBe(
      '/dashboard/requests/r1?tab=routing&focus=next-steps'
    );
  });
});

describe('decisionsFocusHref', () => {
  it('is the one request-focused Decisions link, with the id encoded', () => {
    expect(decisionsFocusHref('64f0c0ffee')).toBe('/dashboard/decisions?request=64f0c0ffee');
    expect(decisionsFocusHref('a&b=c')).toBe('/dashboard/decisions?request=a%26b%3Dc');
    expect(new URLSearchParams(decisionsFocusHref('a&b=c').split('?')[1]).get('request')).toBe('a&b=c');
  });
});
