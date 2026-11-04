// The hub's privacy boundary.
//
// The hub is the one surface where a vendor sees several jobs at once, which
// makes it the easiest place to widen the boundary by accident — joining
// everything and rendering it is the natural implementation and the wrong one.
//
// An offer the vendor has NOT accepted must carry no street address and no
// tenant identity, exactly as the emailed brief does. This file uses the same
// distinctive magic values as vendorBrief.service.test.js so a substring search
// cannot produce a false pass.

const assert = require("assert");

const VendorOutreach = require("../../../models/VendorOutreach");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const Landlord = require("../../../models/Landlord");
const Property = require("../../../models/Property");
const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");
const LedgerEntry = require("../../../models/LedgerEntry");

const STREET = "8842 Zephyrhill Crescent";
const UNIT_NUMBER = "3071B";
const TENANT_FIRST = "Marisol";
const TENANT_LAST = "Vandergriff";
const TENANT_PHONE = "+1-306-555-8842";
const ENTRY_NOTES = "Lockbox code 9931 by the side gate";

const IDENTITY = "identity-1";

const request = {
  _id: "req-1",
  propertyId: "prop-1",
  category: "Plumbing",
  urgency: "medium",
  issueTitle: "Kitchen sink leaking",
  preferredTime: ENTRY_NOTES,
  accessPermission: true,
  ai: { shortTitle: "Kitchen sink leaking under cabinet" },
  incidentRecord: {
    trade: "Plumbing",
    summary: "Steady drip from the P-trap",
    access: { permissionToEnter: true, preferredTimes: ["Weekday mornings"] },
  },
};

const outreach = {
  _id: "60a1b2c3d4e5f60718293a4b",
  requestId: "req-1",
  landlordId: "landlord-1",
  identityId: IDENTITY,
  status: "sent",
  tier: "normal",
  vendorNameSnapshot: "Northline Plumbing",
  responseDeadlineAt: new Date(Date.now() + 3600000),
  offeredWindows: [{ slotId: "w1", label: "Wed 8-12", kind: "window" }],
  messageBody: "Artrelo is coordinating a maintenance request in Regina.",
};

const lean = (value) => ({ lean: async () => value });
const chain = (value) => ({
  sort: () => chain(value),
  limit: () => chain(value),
  select: () => chain(value),
  lean: async () => value,
});

VendorOutreach.find = () => chain([outreach]);
MaintenanceRequest.find = () => chain([request]);
Landlord.find = () => chain([{ _id: "landlord-1", firstName: "Excel", lastName: "Ojeifo", companyName: "Northline Properties" }]);
Property.find = () => chain([{ _id: "prop-1", name: "Quillfeather Court", address: `${STREET}, Regina, SK` }]);
Appointment.find = () => chain([]);
JobCompletion.find = () => chain([]);
LedgerEntry.find = () => chain([]);

const { buildOpenOffers, buildHubView } = require("../../../services/vendor/hubProjection.service");

async function main() {
  const offers = await buildOpenOffers(IDENTITY);
  assert.strictEqual(offers.length, 1, "the offer is listed");

  const serialized = JSON.stringify(offers);

  // The whole point of the file.
  const FORBIDDEN = [STREET, UNIT_NUMBER, TENANT_FIRST, TENANT_LAST, TENANT_PHONE, ENTRY_NOTES];
  FORBIDDEN.forEach((secret) => {
    assert.ok(
      !serialized.includes(secret),
      `The hub leaked a protected value for an UNACCEPTED offer: ${secret}\nPayload: ${serialized}`
    );
  });

  // But it still carries enough to decide whether to take the job.
  const offer = offers[0];
  assert.strictEqual(offer.city, "Regina", "city only — never the street");
  assert.strictEqual(offer.trade, "Plumbing");
  assert.strictEqual(offer.title, "Kitchen sink leaking under cabinet");
  assert.strictEqual(offer.manager.company, "Northline Properties");
  assert.ok(offer.jobReference.startsWith("JOB-"));

  // No token: answering an offer needs the emailed OFFER link. Minting one from
  // a hub session would let the hub bypass the single-use guarantee the offer
  // flow depends on.
  assert.strictEqual(offer.jobUrl, undefined);
  assert.strictEqual(offer.needsEmailLink, true);
  assert.ok(!serialized.includes("60a1b2c3d4e5f60718293a4b"), "raw outreach id must not appear");

  // The vendor summary exposes payout STATUS, never the Connect account id.
  const view = await buildHubView({
    _id: IDENTITY,
    displayName: "Pat Okonkwo",
    emailNormalized: "pat@fixit.example",
    connectStatus: "enabled",
    stripeConnectAccountId: "acct_SHOULD_NOT_APPEAR",
    aggregate: { completedJobs: 3, ratingSum: 14, ratingCount: 3 },
  });

  assert.strictEqual(view.vendor.payouts.status, "enabled");
  assert.ok(
    !JSON.stringify(view).includes("acct_SHOULD_NOT_APPEAR"),
    "the Connect account id is one more identifier with no reason to leave the server"
  );
  // (4*1 + ...) -> 14/3 = 4.666 -> 4.7
  assert.strictEqual(view.vendor.rating, 4.7);
  assert.strictEqual(view.vendor.ratingCount, 3);

  console.log("hubProjection.service privacy-boundary tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
