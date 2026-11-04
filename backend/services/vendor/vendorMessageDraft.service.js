const { resolveRequestCity, formatCityLabel } = require("./vendorScoring.service");
const { redactContactDetails, knownDetailsFromRequest } = require("./contactRedaction.service");

// The outreach draft: a short note from the property manager, NOT a copy of
// the job facts.
//
// It used to restate everything the email already showed -- Summary, Urgency,
// the access note, "Sent by Artrelo" (the footer says it), a greeting (the
// email header says it), an "Earliest available slot" frozen at generate time
// and stale by the time it was sent, and "Preferred time windows are listed
// below" in an email that lists them ABOVE the message. The email and the
// vendor's response page now carry the facts, the greeting and the
// attribution; this carries what only the manager would say.
//
// Privacy: this becomes the body of a real outbound email, so it obeys the
// pre-accept rule of the vendor-facing surface -- city only. No property name,
// no unit number, no tenant name, no approvedCeiling. See
// services/vendor/vendorBrief.service.js.

function endWithPeriod(text) {
  const compact = String(text || "").trim();
  if (!compact) return "";
  return /[.!?]["')\]]?$/.test(compact) ? compact : `${compact}.`;
}

function sentenceCase(text) {
  const compact = String(text || "").trim();
  return compact ? compact.charAt(0).toUpperCase() + compact.slice(1) : "";
}

// "plumbing", but "HVAC" keeps its capitals.
function tradeLabel(trade) {
  const value = String(trade || "").trim();
  if (!value) return "maintenance";
  return value === value.toUpperCase() ? value : value.toLowerCase();
}

// "an electrical job", "an HVAC job" (aitch), "a plumbing job".
function withArticle(label) {
  const isAcronym = label === label.toUpperCase() && /[A-Z]/.test(label);
  const vowelSound = isAcronym ? /^[AEFHILMNORSX]/.test(label) : /^[aeiou]/i.test(label);
  return `${vowelSound ? "an" : "a"} ${label}`;
}

// A paid-job average is the vendor's OWN history with this manager, so it is
// fine to share. Anything else is not a figure to put in front of a vendor.
function paidAverage(priceEstimate) {
  if (!priceEstimate || priceEstimate.basis !== "paid_job_average") return null;
  const amount = Number(priceEstimate.amountHigh);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
}

// Kept only so drafts saved in snapshots before this change, which still end
// with it, are cleaned on send by stripDraftDisclaimer. New drafts don't carry
// it -- the landlord UI already labels the draft "Draft outreach".
const DRAFT_ONLY_DISCLAIMER = "This is a draft only and has not been sent.";

/**
 * Two or three plain paragraphs separated by one blank line:
 *
 *   We have a plumbing job in Regina: Leak under the kitchen sink.
 *
 *   Additional details from the tenant: ...            (only with notes)
 *
 *   Your past plumbing jobs with us have averaged $250.   (only with history)
 *
 *   When you respond, pick the time window that suits you and include your quote.
 *
 * The wording is location-neutral ("pick the time window") because the same
 * note is read in the email, where the windows come first, and on the
 * response page, where they come after.
 */
// ["Weekday mornings", "Evenings"] -> "weekday mornings or evenings".
function joinPreferences(preferredTimes) {
  const phrases = (Array.isArray(preferredTimes) ? preferredTimes : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => (value === value.toUpperCase() ? value : value.charAt(0).toLowerCase() + value.slice(1)));
  if (!phrases.length) return null;
  if (phrases.length === 1) return phrases[0];
  return `${phrases.slice(0, -1).join(", ")} or ${phrases[phrases.length - 1]}`;
}

const NOTES_MAX_CHARS = 600;

// The tenant's additional notes, masked and capped. These are the only raw
// tenant words in the draft, so they go through contactRedaction first: the
// draft is a pre-accept email and the city-only rule still holds.
function tenantNotes(request) {
  const redacted = redactContactDetails(request?.ai?.additionalNotes, knownDetailsFromRequest(request))
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return null;
  if (redacted.length <= NOTES_MAX_CHARS) return endWithPeriod(redacted);
  const cut = redacted.slice(0, NOTES_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > NOTES_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

function buildVendorMessageDraft({ request, priceEstimate = null, trade = null, preferredTimes = null }) {
  const city = formatCityLabel(resolveRequestCity({ property: request.propertyId })) || "your service area";
  const label = tradeLabel(trade || request.vendorTypeNeeded || request.category);
  const summary = endWithPeriod(sentenceCase(request.ai?.summary || request.issueDescription));
  const average = paidAverage(priceEstimate);
  // The tenant's timing, when they gave one, so the vendor can choose the
  // window closest to it. The AI-normalised phrases only -- see
  // vendorBrief.buildPreferredTimes for why the free text stays out.
  const preference = joinPreferences(preferredTimes ?? request?.incidentRecord?.access?.preferredTimes);
  const notes = tenantNotes(request);

  const opening = summary
    ? `We have ${withArticle(label)} job in ${city}: ${summary}`
    : `We have ${withArticle(label)} job in ${city}.`;
  const closing = average
    ? `When you respond, pick the time window that suits you${preference ? " (closest to their preference)" : ""} and confirm your price.`
    : `When you respond, pick the time window that suits you${preference ? " (closest to their preference)" : ""} and include your quote.`;

  return [
    opening,
    notes ? `Additional details from the tenant: ${notes}` : null,
    preference ? `The tenant prefers ${preference}.` : null,
    average ? `Your past ${label} jobs with us have averaged $${average}.` : null,
    closing,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Strips the draft-only disclaimer from an already-built (and possibly
// landlord-edited) draft, so the same text can be reused as the body of a real
// outbound message.
function stripDraftDisclaimer(message) {
  if (message === null || message === undefined) return "";
  return String(message).split(DRAFT_ONLY_DISCLAIMER).join("").replace(/[ \t]+$/gm, "").trim();
}

module.exports = {
  DRAFT_ONLY_DISCLAIMER,
  buildVendorMessageDraft,
  stripDraftDisclaimer,
};
