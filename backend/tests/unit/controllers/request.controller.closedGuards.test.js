// The generic landlord setters (approve, assign, in-progress) must not move a
// closed request. They had no status check at all, so a rejected request could
// be pushed to "approved" -- skipping the appeal flow entirely and keeping its
// rejection reason and appeal window. Pins: each answers 409 request_closed for
// a rejected, cancelled or completed request and never saves it.

const assert = require("assert");

const MaintenanceRequest = require("../../../models/MaintenanceRequest");
let row = null;
let saved = false;
MaintenanceRequest.findOne = async () => row;

const ctrl = require("../../../controllers/request.controller");

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

async function main() {
  const handlers = [
    ["approve", ctrl.putMarkRequestApproved, {}],
    ["assign", ctrl.putMarkRequestAssigned, { vendorId: "v1" }],
    ["in-progress", ctrl.putMarkInProgress, {}],
  ];
  for (const status of ["rejected", "cancelled", "completed"]) {
    for (const [name, handler, body] of handlers) {
      saved = false;
      row = {
        _id: "r1",
        status,
        timeline: [],
        save: async () => {
          saved = true;
        },
      };
      const res = makeRes();
      await handler({ params: { id: "r1" }, user: { id: "l1" }, body }, res);
      assert.strictEqual(res.statusCode, 409, `${name} must refuse a ${status} request`);
      assert.strictEqual(res.body.code, "request_closed");
      assert.strictEqual(saved, false, `${name} must not save a ${status} request`);
    }
  }
  console.log("request.controller closed-request guard tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
