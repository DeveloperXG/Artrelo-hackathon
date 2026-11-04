// "Max vendors contacted per request" (LandlordPolicy.maxOutreachAttempts).
//
// Pinned: it starts at 3 for a new landlord, while the spending quota stays
// unset and requires approval. The save validates 0-5 by hand,
// because upsertPolicy runs without runValidators and the schema bounds would
// otherwise never be checked.

const assert = require("assert");

const LandlordPolicy = require("../../../models/LandlordPolicy");

let storedPolicy = null;

LandlordPolicy.findOne = () => ({ select: () => ({ lean: async () => storedPolicy }) });
LandlordPolicy.findOneAndUpdate = async (filter, update) => {
  storedPolicy = { ...(storedPolicy || { defaultQuota: 200 }), ...update.$set };
  return storedPolicy;
};
// A first quota save triggers this re-route after the response; not under test.
require("../../../controllers/request.controller").reevaluateRequestsForPolicy = async () => ({
  rerouted: 0,
  waiting: 0,
});
const writer = require("../../../services/policy/policyWrite.service");
writer.writePolicy = async ({ patch }) => ({ policy: await LandlordPolicy.findOneAndUpdate({}, { $set: patch }), routingChanged: false });
writer.queueRefresh = () => {};
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
  return res;
};

async function main() {
  const fresh = new LandlordPolicy({ landlordId: "64b000000000000000000001" });
  assert.strictEqual(fresh.maxOutreachAttempts, 3, "the cap allows routing; the unset quota still requires approval");
  assert.strictEqual(fresh.defaultQuota, null);

  for (const valid of [0, 1, 5, "3"]) {
    const res = await save({ maxOutreachAttempts: valid });
    assert.strictEqual(res.statusCode, 200, `accepts ${JSON.stringify(valid)}`);
    assert.strictEqual(storedPolicy.maxOutreachAttempts, Number(valid), "stored as a number");
  }

  for (const invalid of [-1, 6, 2.5, "lots", null, "", true]) {
    storedPolicy = { maxOutreachAttempts: 2 };
    const res = await save({ maxOutreachAttempts: invalid });
    assert.strictEqual(res.statusCode, 400, `refuses ${JSON.stringify(invalid)}`);
    assert.strictEqual(res.body.field, "maxOutreachAttempts", "so the page can put it beside the field");
    assert.strictEqual(storedPolicy.maxOutreachAttempts, 2, "and nothing is written");
  }

  console.log("policy max-vendors tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
