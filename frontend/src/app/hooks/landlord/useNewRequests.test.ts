import { afterEach, describe, expect, it, vi } from 'vitest';
import { markRequestOpened } from './useNewRequests';

afterEach(() => vi.unstubAllGlobals());
describe('request-opened storage', () => {
  it('keeps each landlord separate, expires old entries, and notifies the list', () => {
    const values = new Map<string, string>();
    values.set('artrelo:requestsOpened:owner-a', JSON.stringify({ expired: Date.now() - 31 * 86400000 }));
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) }, dispatchEvent });
    markRequestOpened('owner-a', 'request-a');
    markRequestOpened('owner-b', 'request-b');
    expect(Object.keys(JSON.parse(values.get('artrelo:requestsOpened:owner-a')!))).toEqual(['request-a']);
    expect(Object.keys(JSON.parse(values.get('artrelo:requestsOpened:owner-b')!))).toEqual(['request-b']);
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });
  it('does not block request access when browser storage is unavailable', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw Error('blocked'); }, setItem: () => { throw Error('blocked'); } }, dispatchEvent: vi.fn() });
    expect(() => markRequestOpened('owner', 'request')).not.toThrow();
  });
});
