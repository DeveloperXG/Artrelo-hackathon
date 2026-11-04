const assert = require("node:assert/strict");
const { buildAnalysisContext, validateAnalysis, developmentAnalysis } = require("../../../services/quotes/analysisContract.service");
const { createQuoteSnapshot } = require("../../../services/quotes/itemization.service");
const snapshot = createQuoteSnapshot({ pricingMode: "fixed", currency: "CAD", items: [
  { description: "Repair", category: "labour", amountMinor: 21000 },
], totals: { lowMinor: 21000, highMinor: 21000 } }, { revision: 1 });
const request = { _id: "owned-request", category: "Plumbing", issueTitle: "Sink repair",
  ai: { summary: "Dripping trap. Contact private@example.test or +1-306-555-0111" },
  tenantEmail: "never-expose@example.test", token: "never-expose-token" };
const basis = buildAnalysisContext({ request, snapshot, stage: "quote" });
assert.equal(basis.context.historyKnown, false);
assert.equal(basis.context.approvedScopeKnown, false);
assert.equal(basis.context.deltas.agreedMinor, null, "a submitted quote does not invent an agreed price");
assert(!JSON.stringify(basis).includes("private@example.test"));
assert(!JSON.stringify(basis).includes("306-555"));
assert(!JSON.stringify(basis).includes("never-expose"));
assert.equal(buildAnalysisContext({ request, snapshot, stage: "quote" }).contextHash, basis.contextHash);
const good = { schemaVersion: 1, summary: "Submitted total is CAD210.00; scope is not recorded.", flags: [{ code: "unsupported_basis",
  lineIds: [snapshot.itemization.items[0].lineId], sourceRefs: [basis.sourceRefs[0]], explanation: "Clarify the recorded scope." }],
  questions: [{ code: "unsupported_basis", lineIds: [], suggestedQuestion: "What work is included?" }], reviewRecommendation: "landlord_review" };
assert.deepEqual(validateAnalysis(good, basis), good);
for (const mutate of [
  x => { x.approve = true; }, x => { x.approvedAmount = 210; }, x => { x.tools = []; },
  x => { x.flags[0].lineIds = ["foreign-line"]; }, x => { x.flags[0].sourceRefs = ["request:other-owner"]; },
  x => { x.flags[0].sourceRefs = []; }, x => { x.flags[0].code = "fraudulent"; },
  x => { x.summary = "Market rate is CAD999.99."; }, x => { x.reviewRecommendation = "approved"; },
  x => { x.summary = "Total CAD21000."; }, x => { x.summary = "The total is 21000 dollars."; },
  x => { x.reviewRecommendation = "no_additional_flags"; }, x => { x.questions[0].approved = true; },
  x => { x.summary = "x".repeat(801); }, x => { x.questions = Array(5).fill(x.questions[0]); },
]) { const bad = JSON.parse(JSON.stringify(good)); mutate(bad); assert.equal(validateAnalysis(bad, basis), null); }
const copy = validateAnalysis(good, basis); good.flags[0].explanation = "Changed";
assert.notEqual(copy.flags[0].explanation, good.flags[0].explanation, "persisted validated data owns its copy");
const fake = developmentAnalysis();
assert.match(fake.summary, /Development simulation/);
assert.equal(fake.reviewRecommendation, "landlord_review", "a development fixture cannot silently clear review");
assert(validateAnalysis(fake, basis));
const invoice = createQuoteSnapshot({ pricingMode: 'fixed', currency: 'CAD', items: [
  { description: 'Faucet labour', category: 'labour', amountMinor: 18000 },
  { description: 'Faucet parts', category: 'materials', amountMinor: 6000 },
], totals: { lowMinor: 24000, highMinor: 24000 } }, { revision: 1 });
const invoiceBasis = buildAnalysisContext({ request, snapshot: invoice, stage: 'invoice', agreedMinor: 17749 });
const invoiceAdvisory = { schemaVersion: 1, summary: 'Final charges CAD240.00 exceed the agreed CAD177.49 by CAD62.51.', flags: [], questions: [], reviewRecommendation: 'landlord_review' };
assert.deepEqual(validateAnalysis(invoiceAdvisory, invoiceBasis), invoiceAdvisory);
assert.equal(validateAnalysis({ ...invoiceAdvisory, summary: invoiceAdvisory.summary + ' The difference is 35.2%.' }, invoiceBasis), null, 'an unsupplied rounded percentage stays rejected, matching the live failure');
console.log("Advisory contract: scoped context, missing evidence, reference/numeric grounding and no execution fields PASS");
