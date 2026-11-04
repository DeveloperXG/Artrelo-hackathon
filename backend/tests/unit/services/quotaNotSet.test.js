// A landlord who has not chosen a spending quota has NO quota.
//
// There used to be a hard-coded $300 (schema default plus `|| 300` fallbacks),
// so vendors were contacted on a budget nobody had agreed to. Now the quota is
// null until set, and the hazard this file guards is JavaScript itself:
// `quote > null` is `quote > 0`, so any comparison that let null through would
// silently mark every quote over quota and show the manager "$null".

const assert = require("assert");

const LandlordPolicy = require("../../../models/LandlordPolicy");

const { resolveQuotaLimit, buildRoutingDecision, QUOTA_NOT_SET_SUMMARY } = require(
  "../../../services/vendor/routingDecision.service"
);
const { evaluateQuoteAgainstQuota } = require("../../../services/vendor/vendorAcceptance.service");

/* ---- The policy save, with the re-evaluation it triggers stubbed. ------- */

let storedPolicy = null;
let reroutes = [];

LandlordPolicy.findOne = () => ({ select: () => ({ lean: async () => storedPolicy }) });
LandlordPolicy.findOneAndUpdate = async (filter, update) => {
  storedPolicy = { ...(storedPolicy || { defaultQuota: null }), ...update.$set };
  return storedPolicy;
};
require("../../../controllers/request.controller").reevaluateRequestsForPolicy = async (landlordId) => {
  reroutes.push(landlordId);
  return { rerouted: 0, waiting: 0 };
};
// The shared writer's transaction/audit/CAS and selective field results are
// tested against actual Mongo separately. Here pin controller queue dispatch.
const writer = require("../../../services/policy/policyWrite.service");
writer.writePolicy = async ({ landlordId, expectedRevision, patch }) => {
  assert.strictEqual(expectedRevision, 0);
  const routingChanged = Object.keys(patch).some(key => writer.ROUTING_FIELDS.includes(key) && writer.stable(storedPolicy?.[key]) !== writer.stable(patch[key]));
  return { policy: await LandlordPolicy.findOneAndUpdate({}, { $set: patch }), routingChanged, receiptId: landlordId };
};
writer.queueRefresh = id => setImmediate(() => require("../../../controllers/request.controller").reevaluateRequestsForPolicy(id));
const landlordCtrl = require("../../../controllers/landlord.controller");

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});
const save = async (body) => {
  const res = makeRes();
  await landlordCtrl.upsertPolicy({ user: { id: "landlord-1" }, body: { expectedPolicyRevision: 0, ...body } }, res);
  // The re-route runs after the response; let it land.
  await new Promise((resolve) => setImmediate(resolve));
  return res;
};

async function main() {
  /* -------------- 1) No default: a new policy has no quota -------------- */

  const fresh = new LandlordPolicy({ landlordId: "64b000000000000000000001" });
  assert.strictEqual(fresh.defaultQuota, null, "no limit until the landlord chooses one");
  assert.strictEqual(resolveQuotaLimit({}, {}), null, "and nothing falls back to $300");
  assert.strictEqual(resolveQuotaLimit({ defaultQuota: null }, { category: "plumbing" }), null);

  // Anything the landlord DID set still wins, most specific first.
  assert.strictEqual(resolveQuotaLimit({ defaultQuota: 250 }, {}), 250);
  assert.strictEqual(resolveQuotaLimit({ defaultQuota: 250, unitQuotas: { u1: 50 }, propertyQuotas: { p1: 100 } },
    { unitId: { _id: "u1" }, propertyId: { _id: "p1" } }), 50, "populated references retain the most specific quota");
  assert.strictEqual(
    resolveQuotaLimit({ defaultQuota: null, categoryQuotas: { plumbing: 400 } }, { category: "plumbing" }),
    400
  );
  assert.strictEqual(resolveQuotaLimit({ defaultQuota: null }, { quotaOverride: 600 }), 600, "an approved raise counts");

  /* -------------- 2) Routing: nothing goes ahead on its own -------------- */

  const decision = buildRoutingDecision({
    request: { urgency: "routine" },
    // A trusted preset would normally auto-route. With no quota it must not.
    bestCandidate: { source: "preset", verificationStatus: "trusted" },
    policy: { defaultQuota: null },
    priceEstimate: { amountHigh: 180 },
    eligibleCount: 2,
    vendorTypeNeeded: "plumbing",
    lowestEligibleCost: 150,
  });
  assert.strictEqual(decision.reasonCode, "quota_not_set");
  assert.strictEqual(decision.approvalRequired, true, "the manager approves contact");
  assert.strictEqual(decision.actionType, "request_vendor_contact_approval", "the existing Approve-contact flow");
  assert.strictEqual(decision.quotaLimit, null);
  assert.strictEqual(decision.managerSummary, QUOTA_NOT_SET_SUMMARY);
  assert.ok(!decision.managerSummary.includes("null"), "never '$null' in front of a manager");

  // With a quota the same candidate auto-routes, as before.
  const withQuota = buildRoutingDecision({
    request: { urgency: "routine" },
    bestCandidate: { source: "preset", verificationStatus: "trusted" },
    policy: { defaultQuota: 300 },
    priceEstimate: { amountHigh: 180 },
    eligibleCount: 2,
    vendorTypeNeeded: "plumbing",
    lowestEligibleCost: 150,
  });
  assert.strictEqual(withQuota.reasonCode, "trusted_preset_match");

  /* -------------- 3) A vendor's quote: approval, stated honestly -------- */

  const check = evaluateQuoteAgainstQuota({
    request: {},
    policy: { defaultQuota: null },
    outreach: { response: { quoteHigh: 120 } },
  });
  assert.strictEqual(check.limit, null);
  assert.strictEqual(check.overQuota, true, "no quota means every quote needs approval");

  /* -------------- 4) Saving the quota ----------------------------------- */

  storedPolicy = { defaultQuota: null };
  let res = await save({ defaultQuota: 0 });
  assert.strictEqual(res.statusCode, 400, "0 is not a quota — `|| null` downstream would read it as 'none'");
  assert.strictEqual(res.body.field, "defaultQuota", "shown beside the field");
  res = await save({ defaultQuota: "abc" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(reroutes.length, 0, "a refused save re-routes nothing");

  res = await save({ defaultQuota: "350" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(storedPolicy.defaultQuota, 350, "stored as a number");
  assert.deepStrictEqual(reroutes, ["landlord-1"], "the first quota re-routes the requests waiting on it");

  res = await save({ defaultQuota: 400 });
  assert.strictEqual(reroutes.length, 2, "changing an existing quota re-evaluates the open requests too");
  assert.strictEqual(res.body.reevaluating, true, "and the save says so, for the page's toast");

  res = await save({ defaultQuota: 400 });
  assert.strictEqual(reroutes.length, 2, "re-saving the same quota is not a change");

  res = await save({ digestFrequency: "hourly" });
  assert.strictEqual(res.statusCode, 200, "other settings save without touching the quota");
  assert.strictEqual(storedPolicy.defaultQuota, 400);
  assert.strictEqual(reroutes.length, 2, "a non-routing setting re-evaluates nothing");

  res = await save({ requireApprovalForFirstTimeVendor: false });
  assert.strictEqual(reroutes.length, 3, "an approval rule is a routing change");

  console.log("quotaNotSet tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
