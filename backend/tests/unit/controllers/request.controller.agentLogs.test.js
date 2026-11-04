const assert = require("node:assert/strict");
const Log = require("../../../models/AgentActionLog");
let filter, sort, limit;
const rows = [{ _id: "newer" }, { _id: "older" }];
Log.find = (value) => {
  filter = value;
  return {
    sort(value) {
      sort = value;
      return this;
    },
    limit(value) {
      limit = value;
      return this;
    },
    lean: async () => rows,
  };
};
const {
  listAgentActionLogs,
} = require("../../../controllers/request.controller");
const res = {
  json(body) {
    this.body = body;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
};
(async () => {
  await listAgentActionLogs(
    {
      user: { id: "current-landlord" },
      query: {
        requestId: "request-one",
        actor: "system",
        actionType: "vendor_outreach_expired",
        limit: 800,
      },
    },
    res,
  );
  assert.deepEqual(filter, {
    landlordId: "current-landlord",
    requestId: "request-one",
    actor: "system",
    actionType: "vendor_outreach_expired",
  });
  assert.deepEqual(sort, { createdAt: -1, _id: -1 });
  assert.equal(limit, 500);
  assert.deepEqual(res.body.data, rows);
  console.log("agent log stable sort, filters and bounded limit tests passed");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
