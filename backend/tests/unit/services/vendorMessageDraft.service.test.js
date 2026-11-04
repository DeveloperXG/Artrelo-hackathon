const assert = require("assert");
const {
  buildVendorMessageDraft,
  stripDraftDisclaimer,
  DRAFT_ONLY_DISCLAIMER,
} = require("../../../services/vendor/vendorMessageDraft.service");

// The draft is a short note from the manager, NOT a copy of the job facts: the
// email and the response page carry the facts, the greeting and the
// attribution. It is also the body of a REAL outbound email, so it obeys the
// pre-accept privacy rule: city only -- no property name, no unit number, no
// tenant name. See services/vendor/vendorBrief.service.js.

const request = {
  issueTitle: "Kitchen sink leak",
  issueDescription: "Water pooling in the cabinet",
  category: "Plumbing",
  vendorTypeNeeded: "Plumbing",
  urgency: "high",
  accessPermission: true,
  preferredTime: "Weekday mornings",
  ai: { summary: "leak under the kitchen sink cabinet" },
  propertyId: { name: "Maple Apartments", address: "1200 Broad Street, Regina, SK" },
  unitId: { unitNumber: "12B" },
  tenantId: { firstName: "Marisol", lastName: "Vandergriff" },
};

const fresh = buildVendorMessageDraft({ request, priceEstimate: null, trade: "Plumbing" });
const seasoned = buildVendorMessageDraft({
  request,
  trade: "Plumbing",
  priceEstimate: { amountLow: 250, amountHigh: 250, basis: "paid_job_average", sampleSize: 2 },
});

/* ---------------- 1) The note itself ---------------- */

assert.strictEqual(
  fresh,
  [
    "We have a plumbing job in Regina: Leak under the kitchen sink cabinet.",
    "When you respond, pick the time window that suits you and include your quote.",
  ].join("\n\n"),
  "no history: two paragraphs, asks for a quote"
);
assert.strictEqual(
  seasoned,
  [
    "We have a plumbing job in Regina: Leak under the kitchen sink cabinet.",
    "Your past plumbing jobs with us have averaged $250.",
    "When you respond, pick the time window that suits you and confirm your price.",
  ].join("\n\n"),
  "with paid history: the vendor's own average, and asks them to confirm"
);

/* ---------------- 2) None of what the email already says ---------------- */

for (const draft of [fresh, seasoned]) {
  assert.ok(!/^(Hello|Hi)\b/m.test(draft), "no greeting -- the email and page supply it");
  assert.ok(!draft.includes("Urgency"), "urgency is the email's chip, not the note");
  assert.ok(!draft.includes("Summary:"), "no labelled fact lines");
  assert.ok(!draft.includes("Sent by Artrelo"), "the footer says that");
  assert.ok(!draft.includes(DRAFT_ONLY_DISCLAIMER), "the UI labels the draft; the text doesn't");
  assert.ok(!/listed (below|above)/.test(draft), "location-neutral: windows are above in the email, below on the page");
  assert.ok(!/slot/i.test(draft), "never a frozen slot -- it can be stale by the time it is sent");
  assert.ok(!/\.\./.test(draft), "no doubled periods");
  assert.ok(!/^[ \t]/m.test(draft), "no indented lines");
  assert.ok(!/\n\n\n/.test(draft), "one blank line between paragraphs, never two");
}

// Only a paid-job average is ever shown to a vendor -- never a provider
// estimate or anything else that could be the landlord's own number.
const providerEstimate = buildVendorMessageDraft({
  request,
  trade: "Plumbing",
  priceEstimate: { amountLow: 120, amountHigh: 900, basis: "estimate" },
});
assert.ok(!providerEstimate.includes("$"), "no figure that isn't the vendor's own paid average");

/* ---------------- 3) Leaks nothing protected ---------------- */

["Maple Apartments", "12B", "Unit 12B", "Marisol", "Vandergriff", "1200 Broad Street"].forEach((secret) => {
  assert.ok(!fresh.includes(secret), `draft leaked protected value: ${secret}`);
  assert.ok(!seasoned.includes(secret), `draft leaked protected value: ${secret}`);
});

/* ---------------- 4) Wording edge cases ---------------- */

const electrical = buildVendorMessageDraft({ request, trade: "Electrical" });
assert.ok(electrical.startsWith("We have an electrical job"), electrical);
const hvac = buildVendorMessageDraft({ request, trade: "HVAC" });
assert.ok(hvac.startsWith("We have an HVAC job"), hvac);

const noSummary = buildVendorMessageDraft({ request: { ...request, ai: null, issueDescription: "" }, trade: "Plumbing" });
assert.ok(noSummary.startsWith("We have a plumbing job in Regina."), noSummary);

const alreadyPunctuated = buildVendorMessageDraft({
  request: { ...request, ai: { summary: "Is the pipe frozen?" } },
  trade: "Plumbing",
});
assert.ok(alreadyPunctuated.includes("frozen?\n"), "existing punctuation is kept, not doubled");

/* ---------------- 4b) The tenant's time preference, when given ------------ */

const withPreference = buildVendorMessageDraft({
  request: { ...request, incidentRecord: { access: { preferredTimes: ["Weekday mornings", "Evenings"] } } },
  trade: "Plumbing",
});
assert.strictEqual(
  withPreference,
  [
    "We have a plumbing job in Regina: Leak under the kitchen sink cabinet.",
    "The tenant prefers weekday mornings or evenings.",
    "When you respond, pick the time window that suits you (closest to their preference) and include your quote.",
  ].join("\n\n")
);
assert.ok(!fresh.includes("prefers"), "no preference line when the tenant gave none");

/* ---------------- 5) Degrades without a known city ---------------- */

const noCity = buildVendorMessageDraft({
  request: { ...request, propertyId: { name: "Somewhere", address: "Unknown road" } },
  trade: "Plumbing",
});
assert.ok(noCity.includes("in your service area"), "falls back when the city can't be parsed");
assert.ok(!noCity.includes("Somewhere"), "still never names the property");

/* ---------------- 6) Old drafts still send clean ---------------- */
// Snapshots generated before this change still end with the disclaimer, and a
// landlord may have edited around it.

assert.strictEqual(stripDraftDisclaimer(`Hello.  ${DRAFT_ONLY_DISCLAIMER}`), "Hello.");
assert.strictEqual(stripDraftDisclaimer(""), "");
assert.strictEqual(stripDraftDisclaimer(null), "");
assert.strictEqual(stripDraftDisclaimer("Just a message"), "Just a message");

/* ---------------- 7) Tenant notes, masked ---------------- */
// Additional notes are raw tenant prose, so they pass through contactRedaction
// before landing in a pre-accept email.

const withNotes = buildVendorMessageDraft({
  request: {
    ...request,
    ai: {
      ...request.ai,
      additionalNotes:
        "Marisol says the leak is worse at night. Call 306-555-0199 or marisol@example.com. " +
        "Unit 12B at 1200 Broad Street, Maple Apartments, buzz #305.",
    },
  },
  trade: "Plumbing",
});
assert.ok(withNotes.includes("Additional details from the tenant: [name] says the leak is worse at night."));
for (const secret of ["Marisol", "306-555-0199", "marisol@example.com", "12B", "1200 Broad", "Maple", "#305"]) {
  assert.ok(!withNotes.includes(secret), `draft notes must not leak ${secret}`);
}
assert.ok(!fresh.includes("Additional details"), "no notes paragraph without notes");

const longNotes = buildVendorMessageDraft({
  request: { ...request, ai: { ...request.ai, additionalNotes: "drip ".repeat(400) } },
  trade: "Plumbing",
});
const notesLine = longNotes.split(/\n\n/).find((line) => line.startsWith("Additional details"));
assert.ok(notesLine.length < 700 && notesLine.endsWith("…"), "long notes are capped at a word boundary");

console.log("vendor message draft tests passed");
