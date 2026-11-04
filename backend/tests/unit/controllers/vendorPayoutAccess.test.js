const assert = require("assert");
const express = require("express");
const http = require("http");
const sessions = require("../../../services/vendor/hubSession.service");
sessions.resolveSession = async (token) => token === "verified-hub-session" ? { identityId: "verified-vendor" } : null;
const identity = { _id: "verified-vendor", connectStatus: "pending" };
require("../../../models/VendorIdentity").findById = async () => identity;
const provider = require("../../../services/ledger/payoutProvider.service");
let calls = 0;
provider.ensureConnectAccount = async ({ identity: selected }) => {
  assert.equal(selected._id, "verified-vendor"); calls++;
  return { onboardingUrl: "https://connect.stripe.test/verified-vendor" };
};
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.cookies = Object.fromEntries((req.headers.cookie || "").split("; ").filter(Boolean).map((v) => v.split("="))); next(); });
app.use("/vendor-portal", require("../../../routes/vendorPortal.routes"));
app.use("/vendor-hub", require("../../../routes/vendorHub.routes"));
async function main() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((ok, no) => { server.once("listening", ok); server.once("error", no); });
  const request = (path, cookie = "") => new Promise((ok, no) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path, method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" } }, (res) => {
      let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => ok({ status: res.statusCode, body }));
    }); req.on("error", no); req.end(JSON.stringify({ identityId: "attacker-selected-identity" }));
  });
  try {
    for (const action of ["onboard", "update-link"]) {
      assert.equal((await request(`/vendor-portal/forwarded-job-token/payouts/${action}`)).status, 404);
      assert.equal((await request(`/vendor-hub/payouts/${action}`)).status, 401);
      assert.equal((await request(`/vendor-hub/payouts/${action}`, "artrelo_hub=forwarded-job-token")).status, 401);
    }
    const result = await request("/vendor-hub/payouts/onboard", "artrelo_hub=verified-hub-session");
    assert.equal(result.status, 200); assert.ok(result.body.includes("verified-vendor")); assert.equal(calls, 1);
  } finally { await new Promise((ok) => server.close(ok)); }
  console.log("vendor payout access tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
