const assert = require("assert");
const jwt = require("jsonwebtoken");
const env = require("../../../config/env");
env.jwt_secret = "synthetic-activity-test-only";
const activity = require("../../../services/request/irisActivity.service");
const calls = [];
let failure = null;
activity.list = async (owner, query) => {
  calls.push({ owner, query }); if (failure) throw failure;
  return { version: 1, requests: [], nextCursor: null };
};
activity.detail = async (owner, request, query) => {
  calls.push({ owner, request, query }); if (failure) throw failure;
  return { version: 1, request: { requestId: request }, events: [], nextCursor: null };
};
const router = require("../../../routes/landlord.routes");
const controller = require("../../../controllers/irisActivity.controller");
const routes = router.stack.filter((layer) => layer.route && ["/iris-activity", "/requests/:id/iris-activity"].includes(layer.route.path));
assert.equal(routes.length, 2);
const owner = "000000000000000000000001", id = "000000000000000000000002";
function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function invoke(route, role) {
  const token = role ? jwt.sign({ typ: "access", userId: owner, role }, env.jwt_secret, { algorithm: "HS256", expiresIn: "5m" }) : null;
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, query: { limit: "5" }, params: { id } };
  const res = response();
  for (const middleware of route.route.stack) {
    let next = false;
    await middleware.handle(req, res, () => { next = true; });
    if (!next) break;
  }
  return res;
}
async function main() {
  for (const route of routes) {
    assert(route.route.methods.get);
    assert.equal((await invoke(route)).code, 401);
    for (const role of ["tenant", "vendor"]) assert.equal((await invoke(route, role)).code, 403);
    assert.equal(calls.length, 0, "rejected callers cannot read the activity service");
    for (const role of ["landlord", "property_manager", "admin"]) {
      const result = await invoke(route, role);
      assert.equal(result.code, 200); assert(result.body.success); assert.equal(result.body.data.version, 1);
      assert.equal(calls.at(-1).owner, owner); assert.deepEqual(calls.at(-1).query, { limit: "5" });
    }
    calls.length = 0;
    for (const status of [400, 404, 500]) {
      failure = Object.assign(new Error(status === 500 ? "PRIVATE failure body" : "Expected safe error"), { status });
      const result = await invoke(route, "landlord");
      assert.equal(result.code, status); assert.equal(result.body.success, false);
      assert(!JSON.stringify(result.body).includes("PRIVATE"));
    }
    failure = null; calls.length = 0;
  }
  const res = response();
  await controller.list({ user: { role: "tenant", id: owner }, query: {} }, res);
  assert.equal(res.code, 403); assert.equal(calls.length, 0);
  console.log("irisActivity controller: real JWT/role middleware, route contract, safe errors PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
