const assert = require("assert");
const { inspect, REQUIRED } = require("../../../scripts/platform_readiness");
const url = "https://api.artrelo.test/api/v1/webhooks/stripe";
let destinations = [
  { id: "snapshot", status: "enabled", event_payload: "snapshot", events_from: ["@self"], enabled_events: [...REQUIRED],
    webhook_endpoint: { url, signing_secret: "never-print-this" } },
  { id: "thin", status: "enabled", event_payload: "thin", events_from: ["@self"],
    enabled_events: ["v2.core.account.updated"], webhook_endpoint: { url } },
];
const stripe = { accounts: { retrieve: async () => ({ id: "acct_test", country: "CA" }) },
  v2: { core: { eventDestinations: { list: (params) => {
    assert.deepEqual(params.include, ["webhook_endpoint.url"]);
    return { async *[Symbol.asyncIterator]() { yield* destinations; } };
  } } } } };
async function main() {
  const result = await inspect(stripe, url);
  assert.ok(result.accountConfigurationReady);
  assert.ok(!JSON.stringify(result).includes("never-print-this"));
  destinations[0].enabled_events = REQUIRED.filter((e) => e !== "charge.dispute.funds_reinstated");
  assert.deepEqual((await inspect(stripe, url)).missingSnapshotEvents, ["charge.dispute.funds_reinstated"]);
  assert.equal((await inspect(stripe, "https://wrong.artrelo.test")).accountConfigurationReady, false);
  destinations[1].status = "disabled";
  assert.equal((await inspect(stripe, url)).hasConnectedAccountThinDestination, false);
  console.log("platform readiness tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
