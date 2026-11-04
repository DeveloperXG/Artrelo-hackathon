// Remembers, per browser, that a lead form was just submitted — so reloading
// the page shows the "we got it" screen again instead of an empty form that
// invites a duplicate.
//
// This is presentation, not enforcement. The API refuses rapid and repeated
// submissions on its own (a per-IP cooldown and a per-address daily ceiling);
// clearing storage or switching browsers gets past this, and that is fine.
// Its job is only to stop an honest visitor from resubmitting by accident.
//
// Only a timestamp is stored — never anything the visitor typed.

export type LeadFormId = 'contact' | 'demo';

// Matches the API's per-address window, so the confirmation lasts as long as
// the server would treat another send from this visitor as a likely duplicate.
const REMEMBER_MS = 24 * 60 * 60 * 1000;

const keyFor = (form: LeadFormId) => `artrelo:lead-sent:${form}`;

// Every accessor is wrapped: storage throws outright in some privacy modes and
// embedded browsers, and a form that crashes on mount is worse than one that
// forgets.
export function rememberSubmission(form: LeadFormId): void {
  try {
    window.localStorage.setItem(keyFor(form), String(Date.now()));
  } catch {
    /* storage unavailable — the API still enforces the limits */
  }
}

export function wasRecentlySubmitted(form: LeadFormId): boolean {
  try {
    const sentAt = Number(window.localStorage.getItem(keyFor(form)));
    if (!sentAt) return false;
    if (Date.now() - sentAt < REMEMBER_MS) return true;
    window.localStorage.removeItem(keyFor(form));
    return false;
  } catch {
    return false;
  }
}

export function forgetSubmission(form: LeadFormId): void {
  try {
    window.localStorage.removeItem(keyFor(form));
  } catch {
    /* nothing to clear */
  }
}
