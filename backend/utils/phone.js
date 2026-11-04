// Phone numbers, as typed by a person, into the form a phone network dials.
//
// Shared by landlord sign-up (which refuses a number that can't be dialled) and
// the emergency call (which dials it), so the two can never disagree about
// what counts as a usable number.

/**
 * A landlord's phone as E.164, or null. North American numbers are stored
 * however the landlord typed them ("(306) 555-0100", "306.555.0100"), so ten
 * digits get +1; anything else must already carry its country code.
 */
function toE164(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (text.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

module.exports = { toE164 };
