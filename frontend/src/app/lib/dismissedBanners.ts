// Which banners a person has dismissed, in this browser.
//
// A banner is dismissed for ONE STATE OF AFFAIRS, not forever. Each banner has
// a stable `id` and a `signature` built from what it says (an amount, a date,
// a failure's time). Dismissing records that signature; a banner whose
// signature changes -- the debt grew, a new top-up failed -- shows again. So
// "I've read this" never hides news the landlord has not seen.
//
// Per user (one browser can hold two accounts) and per browser: it is a
// reading convenience, never state anything depends on. Storage can be missing
// or throw (private windows), so every access is wrapped and the worst case is
// a banner that shows again.

const PREFIX = 'artrelo:dismissed:';
// Per banner id. A list banner (one per pending top-up) keeps a few; the rest
// have long since changed signature and will never match again.
const KEEP = 20;

const storageKey = (userId: string, id: string) => `${PREFIX}${userId}:${id}`;

function read(userId: string, id: string): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, id));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function isBannerDismissed(userId: string | undefined, id: string, signature: string): boolean {
  if (!userId) return false;
  return read(userId, id).includes(signature);
}

export function dismissBanner(userId: string | undefined, id: string, signature: string): void {
  if (!userId) return;
  const next = [...read(userId, id).filter((v) => v !== signature), signature].slice(-KEEP);
  try {
    window.localStorage.setItem(storageKey(userId, id), JSON.stringify(next));
  } catch {
    // No storage: it shows again on the next visit. Acceptable.
  }
}
