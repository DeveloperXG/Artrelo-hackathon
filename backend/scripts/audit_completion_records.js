// Read-only reconciliation: IDs and state/cost differences, never tenant notes,
// location, media URLs, credentials or provider references. Does not settle jobs.
const mongoose = require("mongoose");
const env = require("../config/env");
const Completion = require("../models/JobCompletion");
const Request = require("../models/MaintenanceRequest");
const Appointment = require("../models/Appointment");
const Ledger = require("../models/LedgerEntry");
const { authorizedPayable } = require("../services/completion/completionRecovery.service");
const { toCents } = require("../services/ledger/money");

function compareCompletion({ completion, request, appointment, payouts }) {
  const issues = [];
  const payableCents = completion.closeRecovery?.payableCents ?? toCents(authorizedPayable(completion));
  if (!request) issues.push("request_missing");
  else if (request.status !== "completed" || request.appointmentStatus !== "completed" || toCents(request.finalCost || 0) !== payableCents) issues.push("request_projection_mismatch");
  if (!appointment || appointment.status !== "completed") issues.push("appointment_projection_mismatch");
  const direct = appointment?.paymentMode === "direct";
  if (direct && payableCents > 0 && (!appointment.directPayment?.status || appointment.directPayment.amountCents !== payableCents)) issues.push("direct_payment_record_mismatch");
  if (!direct && payableCents > 0) {
    if (payouts.reduce((sum, entry) => sum + entry.amountCents, 0) !== payableCents) issues.push("payout_amount_mismatch");
    if (payouts.length === 1 && completion.ledger?.payoutStatus !== payouts[0].providerStatus) issues.push("completion_payout_cache_stale");
  }
  return { completionId: String(completion._id), requestId: String(completion.requestId), appointmentId: String(completion.appointmentId),
    payableCents, paymentMode: direct ? "direct" : "platform", issues,
    payoutStates: payouts.map(entry => ({ amountCents: entry.amountCents, status: entry.providerStatus })) };
}
async function auditCompletionRecords({ requestId = null } = {}) {
  const query = { status: "closed", closedAt: { $ne: null }, ...(requestId ? { requestId } : {}) };
  const cursor = Completion.find(query).lean().cursor();
  const findings = []; let checked = 0;
  for await (const completion of cursor) {
    const scope = { _id: completion.requestId, landlordId: completion.landlordId };
    const [request, appointment, payouts] = await Promise.all([
      Request.findOne(scope).select("status appointmentStatus finalCost").lean(),
      Appointment.findOne({ _id: completion.appointmentId, landlordId: completion.landlordId }).select("status paymentMode directPayment").lean(),
      Ledger.find({ completionId: completion._id, landlordId: completion.landlordId, type: "payout" }).select("amountCents providerStatus").lean(),
    ]);
    const result = compareCompletion({ completion, request, appointment, payouts }); checked++;
    if (result.issues.length) findings.push(result);
  }
  return { checked, mismatches: findings.length, findings, writes: 0 };
}
if (require.main === module) {
  const at = process.argv.indexOf("--request"); const requestId = at >= 0 ? process.argv[at + 1] : null;
  (async () => {
    if (at >= 0 && !mongoose.isValidObjectId(requestId)) throw new Error("--request needs a valid request ID");
    await mongoose.connect(env.mongodb_uri, { autoIndex: false, autoCreate: false });
    const result = await auditCompletionRecords({ requestId });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.mismatches ? 1 : 0;
  })().catch(error => { console.error("Completion audit failed:", error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
module.exports = { compareCompletion, auditCompletionRecords };
