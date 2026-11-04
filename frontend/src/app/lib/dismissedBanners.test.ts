import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissBanner, isBannerDismissed } from './dismissedBanners';

// A minimal localStorage, as the test environment has none.
function installStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal('window', { localStorage: storage });
  return store;
}

describe('dismissed banners', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('hides a banner for the state it was dismissed in, and shows it again when that changes', () => {
    expect(isBannerDismissed('u1', 'bank-owed', '5.00')).toBe(false);
    dismissBanner('u1', 'bank-owed', '5.00');
    expect(isBannerDismissed('u1', 'bank-owed', '5.00')).toBe(true);
    // The debt grew: that is news, so it shows.
    expect(isBannerDismissed('u1', 'bank-owed', '12.00')).toBe(false);
  });

  it('is per user and per banner', () => {
    dismissBanner('u1', 'low-funds', 'a');
    expect(isBannerDismissed('u2', 'low-funds', 'a')).toBe(false);
    expect(isBannerDismissed('u1', 'unpaid-fees', 'a')).toBe(false);
  });

  it('keeps several dismissals for a list banner, but not without limit', () => {
    for (let i = 0; i < 25; i += 1) dismissBanner('u1', 'pending', `item-${i}`);
    expect(isBannerDismissed('u1', 'pending', 'item-24')).toBe(true);
    expect(isBannerDismissed('u1', 'pending', 'item-5')).toBe(true);
    expect(isBannerDismissed('u1', 'pending', 'item-0')).toBe(false);
  });

  it('never hides anything without a signed-in user', () => {
    dismissBanner(undefined, 'x', 'y');
    expect(isBannerDismissed(undefined, 'x', 'y')).toBe(false);
  });

  it('survives storage that throws or holds garbage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(() => dismissBanner('u1', 'x', 'y')).not.toThrow();
    expect(isBannerDismissed('u1', 'x', 'y')).toBe(false);

    const store = installStorage();
    store.set('artrelo:dismissed:u1:x', '{not json');
    expect(isBannerDismissed('u1', 'x', 'y')).toBe(false);
    store.set('artrelo:dismissed:u1:x', JSON.stringify({ y: true }));
    expect(isBannerDismissed('u1', 'x', 'y')).toBe(false);
  });
});
