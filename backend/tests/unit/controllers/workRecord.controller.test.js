const assert = require("assert");
let args, data = null, reads = 0;
require("../../../services/completion/workRecord.service").getWorkRecord = async value => { args = value; reads++; return data; };
const { getWorkRecord } = require("../../../controllers/workRecord.controller");
const res = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; return this; } });
async function run() {
  let response = res(); await getWorkRecord({ params: { id: "invalid" }, user: { id: "owner" } }, response);
  assert.strictEqual(response.code, 400); assert.strictEqual(reads, 0);
  const req = { params: { id: "507f191e810c19729de860eb" }, user: { id: "owner" } };
  response = res(); await getWorkRecord(req, response);
  assert.strictEqual(response.code, 404); assert.strictEqual(args.landlordId, "owner");
  data = { visits: [] }; response = res(); await getWorkRecord(req, response);
  assert.strictEqual(response.code, 200); assert.strictEqual(response.headers["Cache-Control"], "private, no-store");
  // The route's role gate rejects a tenant even when they know the request ID.
  const router = require("../../../routes/landlord.routes");
  const route = router.stack.find(layer => layer.route?.path === "/requests/:id/work-record").route;
  assert.strictEqual(route.methods.get, true);
  response = res(); let next = false;
  await route.stack[1].handle({ user: { id: "tenant", role: "tenant" } }, response, () => { next = true; });
  assert.strictEqual(response.code, 403); assert.strictEqual(next, false);
  console.log("work record validation/role gate/private caching tests passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
