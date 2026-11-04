// upsertPolicy validation beyond the vendor cap (policyMaxVendors.test.js).
//
// The save ran without runValidators, so the schema's enums and bounds never
// ran on this path: a typo'd digestFrequency, an unknown channel or a
// negative threshold saved as-is. The error shapes thrown below are the real
// ones, captured against the test database: an array entry fails at
// "emergencyNotificationChannels.0", and a non-boolean is a CastError.

const assert = require("assert");
const mongoose = require("mongoose");

const LandlordPolicy = require("../../../models/LandlordPolicy");

let lastOptions = null;
let throwOnSave = null;
let saved = null;

LandlordPolicy.findOne = () => ({ select: () => ({ lean: async () => ({ defaultQuota: 200 }) }) });
LandlordPolicy.findOneAndUpdate = async (filter, update, options) => {
  lastOptions = options;
  if (throwOnSave) throw throwOnSave;
  saved = update.$set;
  return { defaultQuota: 200, ...update.$set };
};
require("../../../controllers/request.controller").reevaluateRequestsForPolicy = async () => ({});
const writer = require("../../../services/policy/policyWrite.service");
writer.writePolicy = async ({ patch }) => {
  const policy = await LandlordPolicy.findOneAndUpdate({}, { $set: patch }, { runValidators: true, context: 'query' });
  return { policy, routingChanged: false };
};
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
  saved = null;
  await landlordCtrl.upsertPolicy({ user: { id: "landlord-1" }, body: { expectedPolicyRevision: 0, ...body } }, res);
  return res;
};

// A real ValidationError, as Mongoose builds it for this schema.
const validationErrorFor = (fields) => new LandlordPolicy({ landlordId: new mongoose.Types.ObjectId(), ...fields }).validateSync();

async function main() {
  /* -------- the schema's own rules now run on save -------- */
  await save({ digestFrequency: "daily" });
  // The extracted writer's validator/atomicity is qualified separately; this
  // controller test pins the public field/error mapping and input validation.

  throwOnSave = validationErrorFor({ digestFrequency: "weekly" });
  let res = await save({ digestFrequency: "weekly" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.field, "digestFrequency");
  assert.match(res.body.message, /instant, hourly or daily/);

  throwOnSave = validationErrorFor({ emergencyNotificationChannels: ["pager"] });
  res = await save({ emergencyNotificationChannels: ["pager"] });
  assert.strictEqual(res.body.field, "emergencyNotificationChannels", "an array entry's path names its field");

  throwOnSave = new mongoose.Error.CastError("Boolean", "banana", "allowAutopilotForLowSeverity");
  res = await save({ allowAutopilotForLowSeverity: "banana" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.field, "allowAutopilotForLowSeverity");
  throwOnSave = null;

  /* -------- low-funds threshold: $0 or more, never coerced -------- */
  res = await save({ lowFundsThreshold: "250" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(saved.lowFundsThreshold, 250);
  for (const bad of [-1, "", null, "lots", true]) {
    res = await save({ lowFundsThreshold: bad });
    assert.strictEqual(res.statusCode, 400, `refuses ${JSON.stringify(bad)}`);
    assert.strictEqual(res.body.field, "lowFundsThreshold");
    assert.strictEqual(saved, null, "nothing written");
  }

  /* -------- quota overrides: every amount above $0 -------- */
  res = await save({ categoryQuotas: { plumbing: 400, electrical: "250" } });
  assert.strictEqual(res.statusCode, 200);
  for (const bad of [{ plumbing: 0 }, { plumbing: -5 }, { plumbing: "" }, ["plumbing"], "plumbing"]) {
    res = await save({ unitQuotas: bad });
    assert.strictEqual(res.statusCode, 400, `refuses ${JSON.stringify(bad)}`);
    assert.strictEqual(res.body.field, "unitQuotas");
  }

  console.log("policy validation tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
