// Read-only Stripe preflight. Does not send pings, create links, or change settings.
const config = require("../config/stripe");
const env = require("../config/env");
const REQUIRED = ["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.processing",
  "payment_intent.canceled", "charge.updated", "charge.dispute.created", "charge.dispute.closed",
  "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "mandate.updated",
  "refund.created", "refund.updated", "refund.failed", "transfer.created", "transfer.reversed", "balance.available"];
async function inspect(stripe, url) {
  const account = await stripe.accounts.retrieve();
  const destinations = [];
  for await (const endpoint of stripe.v2.core.eventDestinations.list({ limit: 100, include: ["webhook_endpoint.url"] })) {
    // Never print the endpoint object: it can include its signing secret.
    destinations.push({ id: endpoint.id, url: endpoint.webhook_endpoint?.url, status: endpoint.status,
      payload: endpoint.event_payload, version: endpoint.snapshot_api_version,
      eventsFrom: endpoint.events_from, events: endpoint.enabled_events });
  }
  const matching = destinations.filter((e) => e.url === url && e.status === "enabled");
  const snapshot = matching.filter((e) => e.payload === "snapshot" && (e.eventsFrom || []).includes("@self"));
  const events = new Set(snapshot.flatMap((e) => e.events));
  const missing = REQUIRED.filter((type) => !events.has("*") && !events.has(type));
  const thin = matching.some((e) => e.payload === "thin" && (e.eventsFrom || []).some((source) => ["@self", "@accounts"].includes(source)) &&
    e.events.some((type) => type === "*" || type.startsWith("v2.core.account")));
  return { mode: config.keyMode(), accountId: account.id, country: account.country,
    bankCapability: account.capabilities?.acss_debit_payments || "not_active",
    platformBankPayoutSchedule: account.settings?.payouts?.schedule?.interval || "unknown",
    localBankDebitFlag: Boolean(env.bank_debit_enabled),
    webhookUrl: url, destinations, missingSnapshotEvents: missing, hasConnectedAccountThinDestination: thin,
    // This only confirms account configuration, never the deployed revision or secrets.
    accountConfigurationReady: missing.length === 0 && thin,
  };
}
async function main() {
  const index = process.argv.indexOf("--webhook-url"), url = process.argv[index + 1];
  if (index < 0 || !/^https:\/\//.test(url || "")) throw new Error("Pass the exact production --webhook-url https://.../api/v1/webhooks/stripe");
  const stripe = config.getStripe(); if (!stripe) throw new Error("Stripe is not configured");
  const result = await inspect(stripe, url);
  console.log(JSON.stringify(result, null, 2));
  if (!result.accountConfigurationReady) process.exitCode = 1;
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { inspect, REQUIRED };
