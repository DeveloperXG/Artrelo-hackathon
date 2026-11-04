const assert = require("assert");
const Request = require("../../../models/MaintenanceRequest");
const Appointment = require("../../../models/Appointment");
const Completion = require("../../../models/JobCompletion");
const Ledger = require("../../../models/LedgerEntry");
const Outreach = require("../../../models/VendorOutreach");
const Vendor = require("../../../models/Vendor");
const { buildVisit, getWorkRecord } = require("../../../services/completion/workRecord.service");
let owner = true, relatedReads = 0;
const query = value => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
Request.findOne = filter => { assert.deepStrictEqual(filter, { _id: "r1", landlordId: "l1" });
  return query(owner ? { _id: "r1", status: "completed", archivedAt: new Date(), finalCost: 350 } : null); };
const scope = filter => { relatedReads++; assert.strictEqual(filter.landlordId, "l1"); assert.strictEqual(filter.requestId, "r1"); };
Appointment.find = filter => { scope(filter); return query([
  { _id: "a1", vendorId: "v1", status: "failed", failureReason: "no_show" },
  { _id: "a2", vendorId: "v1", status: "completed", paymentMode: "direct", directPayment: { status: "paid", amountCents: 35000 } },
]); };
Completion.find = filter => { scope(filter); return query([{ appointmentId: "a2", report: { workPerformed: "Fixed trap", actualCost: 400 },
  approvedCeiling: 300, overage: { decision: "approved", approvedAmount: 350 },
  submitterIpHash: "SECRET", ledger: { payoutStatus: "pending" } }]); };
Ledger.find = filter => { scope(filter); return query([]); };
Outreach.find = filter => { scope(filter); return query([{ appointmentId: "a2", vendorNameSnapshot: "Booked vendor name", tokenHash: "SECRET" }]); };
Vendor.find = () => query([{ _id: "v1", name: "Current vendor name" }]);
async function main() {
  assert.strictEqual(await getWorkRecord({ requestId: "r1", landlordId: "l1" }), null);
}
async function run() {
  owner = false; await main(); assert.strictEqual(relatedReads, 0, "no related reads for a non-owner");
  owner = true;
  const record = await getWorkRecord({ requestId: "r1", landlordId: "l1" });
  assert.strictEqual(record.visits.length, 2, "failed visits remain in the historical timeline");
  assert.strictEqual(record.visits[0].report, null);
  assert.strictEqual(record.visits[1].vendorName, "Booked vendor name");
  assert.strictEqual(record.visits[1].payment.status, "paid");
  assert.strictEqual(record.visits[1].report.reportedCost, 400);
  assert.strictEqual(record.visits[1].report.approvedOverage, 350);
  assert.strictEqual(record.finalCost, 350);
  assert.ok(!JSON.stringify(record).includes("SECRET"));
  const visit = buildVisit({ appointment: { _id: "legacy-platform", status: "completed" },
    completion: { report: { actualCost: 20 }, ledger: { payoutStatus: "pending" },
      checkIn: { source: "client_reported", at: new Date(), accuracyMeters: 90, lat: 51, lng: -104 },
      photos: [{ url: "https://evidence.test/before.jpg", receivedAt: "2026-10-19T00:00:00Z", stage: "before" }, { url: "javascript:alert(1)" }] },
    payouts: [{ _id: "p1", amountCents: 2000, providerStatus: "paid", providerRef: "SECRET" }] });
  assert.strictEqual(visit.payment.mode, "platform", "legacy missing mode stays platform");
  assert.strictEqual(visit.payment.payouts[0].status, "paid", "canonical ledger wins over stale completion cache");
  assert.strictEqual(visit.report.checkIn.accuracyMeters, 90);
  assert.strictEqual(visit.report.photos.length, 1);
  assert.strictEqual(visit.report.photos[0].receivedAt, "2026-10-19T00:00:00Z");
  assert.ok(!JSON.stringify(visit).includes("SECRET"));
  console.log("work record ownership/history/privacy tests passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
