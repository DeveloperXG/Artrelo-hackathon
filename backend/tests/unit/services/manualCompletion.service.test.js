// settleManualCompletion: the landlord's "Mark complete" settling the escrow.
//
// The bug this pins: the manual path flipped the request to completed and
// stopped. The appointment stayed "scheduled" (still uploadable, so the vendor
// could submit and get paid a second time through closeJobCompletion), the hold
// stayed in `held` against a terminal request (reconcile check 3 drifts), and
// the masked SMS channel stayed open.
//
// The REAL ledger.service runs here, over in-memory models that enforce the
// same unique idempotencyKey and the same { $gte } guards as Mongo — so the
// "pays once" and "never negative" assertions exercise the actual arithmetic,
// not a stub that agrees with it.

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const JobCompletion = require("../../../models/JobCompletion");
const LedgerEntry = require("../../../models/LedgerEntry");
const { linesBalance } = require("../../../models/LedgerEntry");
const LandlordLedger = require("../../../models/LandlordLedger");
const VendorIdentity = require("../../../models/VendorIdentity");

const LANDLORD = "landlord-1";
const REQUEST = { _id: "req-1", landlordId: LANDLORD };

let appointments = [];
let completions = [];
let entries = [];
let ledgerRow = null;
let nextId = 1;
let payoutCalls = [];
let revoked = [];
let proxyCloses = [];

/* ---------------- A filter matcher covering the operators used here. ------ */

const matches = (row, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.map(String).includes(String(value));
      if ("$nin" in cond) return !cond.$nin.map(String).includes(String(value));
      if ("$gte" in cond) return (value || 0) >= cond.$gte;
    }
    if (cond === null) return value === null || value === undefined;
    return String(value) === String(cond);
  });

// Mongoose queries are both awaitable and chainable; the services use both.
const query = (resolveRow) => {
  const chain = {
    select: () => chain,
    sort: () => chain,
    lean: () => chain,
    then: (resolve, reject) => Promise.resolve().then(resolveRow).then(resolve, reject),
  };
  return chain;
};

/* ---------------- Model stubs ------------------------------------------- */

Appointment.find = (filter) =>
  query(() => appointments.filter((a) => matches(a, filter)).map((a) => ({ ...a })));
Appointment.findOneAndUpdate = async (filter, update) => {
  const row = appointments.find((a) => matches(a, filter));
  if (!row) return null;
  Object.assign(row, update.$set);
  return { ...row };
};

JobCompletion.findOne = (filter) => query(() => completions.find((c) => matches(c, filter)) || null);
JobCompletion.updateOne = async (filter, update) => {
  const row = completions.find((c) => matches(c, filter));
  if (!row) return { matchedCount: 0, modifiedCount: 0 };
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.startsWith("ledger.")) {
      row.ledger = row.ledger || {};
      row.ledger[key.split(".")[1]] = value;
    } else row[key] = value;
  }
  return { matchedCount: 1, modifiedCount: 1 };
};

LedgerEntry.create = async (doc) => {
  if (entries.some((e) => e.idempotencyKey === doc.idempotencyKey)) {
    const err = new Error("E11000 duplicate key");
    err.code = 11000;
    throw err;
  }
  if (!linesBalance(doc.lines)) throw new Error("ledger entry lines do not balance to zero");
  const row = { _id: `e${nextId++}`, balanceAfter: {}, currency: "CAD", ...doc };
  entries.push(row);
  return row;
};
LedgerEntry.findOne = (filter) => query(() => entries.find((e) => matches(e, filter)) || null);
LedgerEntry.findById = async (id) => entries.find((e) => String(e._id) === String(id)) || null;
LedgerEntry.updateOne = async (filter, update) => {
  const row = entries.find((e) => String(e._id) === String(filter._id));
  if (!row) return { modifiedCount: 0 };
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.startsWith("balanceAfter.")) row.balanceAfter[key.split(".")[1]] = value;
    else row[key] = value;
  }
  return { modifiedCount: 1 };
};

LandlordLedger.findOne = async () => ledgerRow;
LandlordLedger.create = async (doc) => {
  ledgerRow = { available: 0, held: 0, arrears: 0, lifetimeDeposited: 0, lifetimeReleased: 0, version: 0, ...doc };
  return ledgerRow;
};
LandlordLedger.findOneAndUpdate = async (filter, update) => {
  if (!ledgerRow) return null;
  const { landlordId, ...guard } = filter;
  if (!matches(ledgerRow, guard)) return null;
  for (const [key, delta] of Object.entries(update.$inc || {})) {
    ledgerRow[key] = (ledgerRow[key] || 0) + delta;
  }
  return { ...ledgerRow };
};
LandlordLedger.updateOne = async () => ({ modifiedCount: 0 });

VendorIdentity.findById = async () => null;

// The service fee's inputs. Pinned to "no fee" so the sections above mean the
// same thing whatever fee a developer's own env file sets; section 12 opts in.
const env = require("../../../config/env");
env.service_fee_cents = "";
env.service_fee_percent = "";
env.service_fee_founding_cents = "";
env.service_fee_founding_percent = "";
const Landlord = require("../../../models/Landlord");
const DAY = 24 * 60 * 60 * 1000;
let landlordDoc = { _id: LANDLORD, beta: { startedAt: new Date(Date.now() - 90 * DAY), endsAt: new Date(Date.now() - DAY) } };
Landlord.findById = () => {
  const chain = { select: () => chain, lean: async () => landlordDoc };
  return chain;
};
JobCompletion.findById = (id) => {
  const chain = { select: () => chain, lean: async () => completions.find((c) => String(c._id) === String(id)) || null };
  return chain;
};

LedgerEntry.find = (filter) => query(() => entries.filter((e) => matches(e, filter)));

/* ---------------- Service stubs, BEFORE the modules that destructure them. */

// The offline rail, which is what the sendPayout stub below models. Pinned,
// because otherwise the rail follows whatever Stripe key the developer's own
// env file holds — and the Stripe rail splits a short payout in two.
const stripeConfig = require("../../../config/stripe");
stripeConfig.isConfigured = () => false;
stripeConfig.getStripe = () => null;

require("../../../services/ledger/payoutProvider.service").sendPayout = async (args) => {
  payoutCalls.push(args);
  return { provider: "offline", status: "pending_manual", reference: null, error: null };
};
require("../../../services/vendor/jobToken.service").revokeJobToken = async ({ appointmentId }) => {
  revoked.push(String(appointmentId));
  return { modifiedCount: 1 };
};
require("../../../services/comms/proxySession.service").closeProxySessionsForRequest = async (args) => {
  proxyCloses.push(args);
  return { closed: 1 };
};

const { createHold } = require("../../../services/ledger/ledger.service");
const { settleManualCompletion } = require("../../../services/completion/manualCompletion.service");

/* ---------------- Fixtures ---------------------------------------------- */

// A wallet of `walletCents`, then a hold of `holdCents` on appt-1, mirroring
// what finalizeVendorAcceptance does at booking.
async function reset({ walletCents = 100000, holdCents = 40000, appointmentStatus = "scheduled" } = {}) {
  appointments = [];
  completions = [];
  entries = [];
  nextId = 1;
  payoutCalls = [];
  revoked = [];
  proxyCloses = [];
  ledgerRow = null;
  await LandlordLedger.create({ landlordId: LANDLORD, available: walletCents });

  appointments.push({ _id: "appt-1", requestId: REQUEST._id, status: appointmentStatus, createdAt: 2 });
  if (holdCents) {
    await createHold({
      landlordId: LANDLORD,
      amountCents: holdCents,
      appointmentId: "appt-1",
      requestId: REQUEST._id,
      identityId: "identity-1",
    });
  }
}

const byKey = (key) => entries.find((e) => e.idempotencyKey === key) || null;
const ofType = (type) => entries.filter((e) => e.type === type);

async function main() {
  /* ---- 1) A cost was supplied: release the hold, pay that cost. -------- */
  await reset();
  assert.strictEqual(ledgerRow.held, 40000);
  assert.strictEqual(ledgerRow.available, 60000);

  let result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });

  assert.strictEqual(appointments[0].status, "completed", "the appointment must leave the uploadable states");
  assert.deepStrictEqual(revoked, ["appt-1"], "the vendor's job link is retired");
  assert.deepStrictEqual(proxyCloses, [{ requestId: "req-1", reason: "job_closed" }], "the relay line is closed");

  // No completion exists, so the domain identity is the manual close of this
  // appointment — stable across retries.
  const release = byKey("release:manual:appt-1");
  const payout = byKey("payout:manual:appt-1");
  assert.ok(release, "hold released under a domain-derived key");
  assert.ok(payout, "payout posted under a domain-derived key");
  assert.strictEqual(release.amountCents, 40000, "releases what was HELD, not the new cost");
  assert.strictEqual(payout.amountCents, 31200, "pays the landlord's figure");
  assert.strictEqual(payout.identityId, "identity-1", "paid to the vendor the hold was booked for");

  assert.strictEqual(ledgerRow.held, 0, "nothing stays held against a completed request");
  assert.strictEqual(ledgerRow.available, 100000 - 31200, "the unspent part of the hold comes back");
  assert.strictEqual(payoutCalls.length, 1);
  assert.strictEqual(payoutCalls[0].idempotencyKey, "payout:manual:appt-1");
  assert.strictEqual(result.workedAppointmentId, "appt-1");
  assert.strictEqual(result.outcomes[0].action, "paid");
  assert.strictEqual(result.shortfall, false);

  /* ---- 2) Clicked twice: nothing moves the second time. ---------------- */
  const entryCount = entries.length;
  const snapshot = { ...ledgerRow };
  await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(entries.length, entryCount, "no new journal entries on a repeat");
  assert.strictEqual(ledgerRow.available, snapshot.available);
  assert.strictEqual(ledgerRow.held, snapshot.held);
  assert.strictEqual(payoutCalls.length, 1, "no second provider call");

  /* ---- 3) No cost: void the hold back to the landlord. ------------------ */
  await reset();
  result = await settleManualCompletion({ request: REQUEST, finalCost: null });
  assert.strictEqual(appointments[0].status, "completed");
  assert.ok(byKey("hold_void:appt-1"), "voided under the same key cancelRequest uses");
  assert.strictEqual(ofType("payout").length, 0, "no figure was authorised, so nothing is paid");
  assert.strictEqual(payoutCalls.length, 0);
  assert.strictEqual(ledgerRow.held, 0);
  assert.strictEqual(ledgerRow.available, 100000, "the whole hold comes back");
  assert.strictEqual(result.outcomes[0].action, "voided");

  // And a later call WITH a cost cannot now pay against a hold already returned
  // — that would be spending the same escrow twice.
  await settleManualCompletion({ request: REQUEST, finalCost: 200 });
  assert.strictEqual(ofType("payout").length, 0, "no release after a void");
  assert.strictEqual(ledgerRow.available, 100000);

  /* ---- 4) A cost of zero is "nothing owed": void, not a $0 transfer. ---- */
  await reset();
  await settleManualCompletion({ request: REQUEST, finalCost: 0 });
  assert.ok(byKey("hold_void:appt-1"));
  assert.strictEqual(ofType("payout").length, 0);
  assert.strictEqual(payoutCalls.length, 0);

  /* ---- 5) Cost above the wallet: arrears, never a negative balance. ----- */
  await reset({ walletCents: 40000, holdCents: 40000 });
  assert.strictEqual(ledgerRow.available, 0);
  result = await settleManualCompletion({ request: REQUEST, finalCost: 500 });
  assert.strictEqual(ledgerRow.held, 0);
  assert.strictEqual(ledgerRow.available, 0, "available is never driven negative");
  assert.strictEqual(ledgerRow.arrears, 10000, "the uncovered $100 is owed, not invented");
  assert.strictEqual(byKey("payout:manual:appt-1").shortfall, true);
  assert.strictEqual(result.shortfall, true, "surfaced so the controller can tell the landlord");

  /* ---- 6) With a (voided) completion: share closeJobCompletion's keys. -- */
  await reset({ appointmentStatus: "work_verifying" });
  completions.push({ _id: "comp-1", appointmentId: "appt-1", status: "void", identityId: "identity-1" });
  await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.ok(byKey("release:comp-1"), "keyed on the completion, as closeJobCompletion would");
  assert.ok(byKey("payout:comp-1"));
  assert.strictEqual(byKey("payout:manual:appt-1"), null, "never a second key for the same payout");
  assert.strictEqual(completions[0].ledger.payoutStatus, "pending");
  assert.ok(completions[0].ledger.releaseEntryId);

  /* ---- 7) closeJobCompletion already owns it: hands off. ---------------- */
  // It claims the completion at step 2 and moves money at step 9. In that gap
  // the hold has no release yet, and a void here would return it twice.
  await reset({ appointmentStatus: "completed" });
  completions.push({ _id: "comp-1", appointmentId: "appt-1", status: "closed" });
  result = await settleManualCompletion({ request: REQUEST, finalCost: null });
  assert.strictEqual(ofType("hold_void").length, 0);
  assert.strictEqual(ofType("payout").length, 0);
  assert.strictEqual(ledgerRow.held, 40000, "left for closeJobCompletion to release");
  assert.strictEqual(result.outcomes[0].reason, "closed_by_vendor_flow");

  /* ---- 8) The appointment moved under us: hands off. -------------------- */
  await reset();
  const realCas = Appointment.findOneAndUpdate;
  Appointment.findOneAndUpdate = async () => null;
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  Appointment.findOneAndUpdate = realCas;
  assert.strictEqual(entries.filter((e) => e.type !== "hold").length, 0, "no money without the claim");
  assert.strictEqual(result.outcomes[0].reason, "status_moved");

  /* ---- 9) Siblings: an abandoned booking's leftover hold goes back, and a
   *         stray live one is cancelled so it can never be paid later. ---- */
  await reset();
  appointments[0].createdAt = 3; // appt-1 is the job
  appointments.push({ _id: "appt-old", requestId: REQUEST._id, status: "cancelled", createdAt: 1 });
  await createHold({ landlordId: LANDLORD, amountCents: 5000, appointmentId: "appt-old", requestId: REQUEST._id });
  appointments.push({ _id: "appt-stray", requestId: REQUEST._id, status: "scheduled", createdAt: 2 });
  await createHold({ landlordId: LANDLORD, amountCents: 7000, appointmentId: "appt-stray", requestId: REQUEST._id });
  completions.push({ _id: "comp-stray", appointmentId: "appt-stray", status: "awaiting_tenant", closedAt: null });
  // Newest first, as the real query sorts.
  appointments.sort((a, b) => b.createdAt - a.createdAt);

  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(result.workedAppointmentId, "appt-1", "the newest live booking is the job");
  assert.ok(byKey("payout:manual:appt-1"));
  assert.ok(byKey("hold_void:appt-old"), "a leftover hold on an abandoned booking comes back");
  assert.ok(byKey("hold_void:appt-stray"));
  assert.strictEqual(appointments.find((a) => a._id === "appt-stray").status, "cancelled");
  assert.strictEqual(completions[0].status, "void", "its completion can no longer be confirmed and paid");
  assert.ok(revoked.includes("appt-stray"));
  assert.strictEqual(ofType("payout").length, 1, "only the job is paid");
  assert.strictEqual(ledgerRow.held, 0, "a terminal request holds nothing — reconcile check 3");

  /* ---- 10) No booking at all: nothing to settle, channel still closed. -- */
  await reset({ holdCents: 0 });
  appointments = [];
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(result.workedAppointmentId, null);
  assert.strictEqual(entries.length, 0);
  assert.strictEqual(proxyCloses.length, 1);

  /* ---- 11) A booking with no hold (e.g. no booked amount): status only. - */
  await reset({ holdCents: 0 });
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(appointments[0].status, "completed");
  assert.strictEqual(entries.length, 0, "no hold, no money — never a payout out of thin air");
  assert.strictEqual(result.outcomes[0].reason, "no_hold");

  // (Every entry balancing is enforced throughout: the create stub rejects an
  // unbalanced one, exactly as the model's pre-validate hook does.)


  /* ---- 12) The service fee on the manual path. ------------------------- */
  env.service_fee_cents = "500";

  // After the payout, on the same settlement key the vendor path would use.
  await reset();
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  const fee = byKey("fee:manual:appt-1");
  assert.ok(fee, "the fee posts under fee:<settlementId>, like the payout");
  assert.ok(entries.indexOf(fee) > entries.indexOf(byKey("payout:manual:appt-1")), "after the payout");
  assert.strictEqual(ledgerRow.available, 100000 - 31200 - 500);
  assert.strictEqual(result.outcomes[0].serviceFee.chargedCents, 500);

  // Clicked twice: one fee.
  await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(ofType("fee").length, 1, "a double-click takes one fee");
  assert.strictEqual(ledgerRow.available, 100000 - 31200 - 500);

  // A void pays nobody, so there is nothing to take a fee on.
  await reset();
  await settleManualCompletion({ request: REQUEST, finalCost: null });
  assert.strictEqual(ofType("fee").length, 0, "no fee on a voided job");

  // With a completion: the decision is recorded on it, keyed like the vendor path.
  await reset({ appointmentStatus: "work_verifying" });
  completions.push({ _id: "comp-1", appointmentId: "appt-1", status: "void", identityId: "identity-1" });
  await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.ok(byKey("fee:comp-1"), "the completion's key, so both paths converge on one fee");
  assert.strictEqual(completions[0].ledger.serviceFee.chargedCents, 500);

  // In the beta: listed, waived, nothing taken.
  landlordDoc = { _id: LANDLORD, beta: { startedAt: new Date(), endsAt: new Date(Date.now() + 30 * DAY) } };
  await reset();
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  assert.strictEqual(ofType("fee").length, 0);
  assert.strictEqual(result.outcomes[0].serviceFee.waivedReason, "beta");
  assert.strictEqual(ledgerRow.available, 100000 - 31200);

  // A fee failure never undoes or blocks the payout.
  landlordDoc = { _id: LANDLORD };
  const origFindById = Landlord.findById;
  Landlord.findById = () => {
    throw new Error("landlord lookup down");
  };
  const origErr = console.error;
  console.error = () => {};
  await reset();
  result = await settleManualCompletion({ request: REQUEST, finalCost: 312 });
  console.error = origErr;
  Landlord.findById = origFindById;
  assert.strictEqual(result.outcomes[0].action, "paid", "the job is still paid");
  assert.ok(byKey("payout:manual:appt-1"));
  assert.strictEqual(payoutCalls.length, 1, "and the vendor transfer still went");
  assert.strictEqual(ofType("fee").length, 0);
  env.service_fee_cents = "";

  console.log("manualCompletion.service.test.js: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
