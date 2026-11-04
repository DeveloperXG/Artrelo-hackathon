// Direct-pay jobs: the landlord pays the vendor themselves, Artrelo records it.
//
// DELIBERATELY NOT THE LEDGER. The ledger is a double-entry record of money
// that passes through the platform -- every line is backed by a Stripe charge
// or transfer, and reconcileLedger holds it to that. An e-transfer from the
// landlord to their plumber never touches the platform, so journaling it would
// be booking money that was never here. The offline rail tried that and left
// direct-pay landlords with arrears nothing could clear. The state lives on
// the Appointment instead (directPayment), which is what it describes.
//
// Two transitions, each a compare-and-set so a replay or a double-click lands
// once:
//
//   (none) -> due    when the job closes (closeJobCompletion, or the landlord's
//                    manual Mark complete). The first writer wins; both paths
//                    may run for the same job and only one amount is recorded.
//   due    -> paid   when the landlord says they paid. Their word is the
//                    evidence -- there is nothing else to check against.

const Appointment = require("../../models/Appointment");
const MaintenanceRequest = require("../../models/MaintenanceRequest");
const VendorOutreach = require("../../models/VendorOutreach");
const { notifyUser } = require("../notification/notify.service");
const { logAgentAction } = require("../audit/agentAction.service");
const { DIRECT, isDirectAppointment } = require("./paymentMode");
const { formatCents } = require("./money");

const MAX_REFERENCE_LENGTH = 120;
const PAID_HISTORY_LIMIT = 50;

/** The name the landlord knows the vendor by, from the outreach that booked them. */
async function vendorNameFor(appointmentId) {
  const outreach = await VendorOutreach.findOne({ appointmentId }).select("vendorNameSnapshot").lean();
  return outreach?.vendorNameSnapshot || "the vendor";
}

/**
 * Record what the landlord owes the vendor on a closed direct job, and tell
 * them. A no-op for a platform job, a zero amount, or a job already recorded.
 */
async function recordDirectPaymentDue({ appointmentId, amountCents, at = new Date() }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { recorded: false, reason: "nothing_owed" };

  const appointment = await Appointment.findOneAndUpdate(
    { _id: appointmentId, paymentMode: DIRECT, "directPayment.status": { $exists: false } },
    { $set: { directPayment: { status: "due", amountCents, dueSince: at } } },
    { new: true }
  ).lean();
  if (!appointment) return { recorded: false, reason: "not_direct_or_already_recorded" };

  const [request, vendorName] = await Promise.all([
    MaintenanceRequest.findById(appointment.requestId).select("issueTitle").lean(),
    vendorNameFor(appointment._id),
  ]);
  const amount = formatCents(amountCents);

  await notifyUser({
    userId: appointment.landlordId,
    type: "vendor_payment_due",
    title: `Pay ${vendorName} ${amount}`,
    message: `"${request?.issueTitle || "The job"}" is complete. Pay ${vendorName} ${amount} directly, then mark it paid.`,
    metadata: { workOrderId: String(appointment.requestId), appointmentId: String(appointment._id), amount: amountCents / 100 },
  });

  await logAgentAction({
    requestId: appointment.requestId,
    landlordId: appointment.landlordId,
    actor: "system",
    actionType: "direct_payment_due",
    summary: `Job closed; ${amount} is owed to ${vendorName}, paid directly by the landlord`,
    input: { appointmentId: String(appointment._id) },
    output: { amountCents },
  });

  return { recorded: true, appointment };
}

/**
 * The landlord says they paid. Scoped to their own appointment; repeating it
 * returns the payment as already recorded rather than an error, because a
 * double-click is not a mistake worth showing.
 *
 * @returns {{ appointment, alreadyPaid?, refused? }}
 *   refused: "not_found" | "not_direct" | "not_due" | "raced"
 */
async function markDirectPaymentPaid({ appointmentId, landlordId, reference = null }) {
  const appointment = await Appointment.findOne({ _id: appointmentId, landlordId }).lean();
  if (!appointment) return { appointment: null, refused: "not_found" };
  if (!isDirectAppointment(appointment)) return { appointment, refused: "not_direct" };

  const status = appointment.directPayment?.status;
  if (status === "paid") return { appointment, alreadyPaid: true };
  if (status !== "due") return { appointment, refused: "not_due" };

  const cleanReference = String(reference || "").trim().slice(0, MAX_REFERENCE_LENGTH) || null;
  const updated = await Appointment.findOneAndUpdate(
    { _id: appointment._id, landlordId, "directPayment.status": "due" },
    {
      $set: {
        "directPayment.status": "paid",
        "directPayment.paidAt": new Date(),
        "directPayment.reference": cleanReference,
        "directPayment.markedBy": landlordId,
      },
    },
    { new: true }
  ).lean();
  // Lost to a concurrent mark: re-read, and report whatever won.
  if (!updated) {
    const fresh = await Appointment.findById(appointment._id).lean();
    return fresh?.directPayment?.status === "paid" ? { appointment: fresh, alreadyPaid: true } : { appointment: fresh, refused: "raced" };
  }

  const vendorName = await vendorNameFor(appointment._id);
  await logAgentAction({
    requestId: appointment.requestId,
    landlordId,
    actor: "landlord",
    actionType: "direct_payment_marked_paid",
    summary: `Landlord marked ${formatCents(updated.directPayment.amountCents)} to ${vendorName} as paid`,
    input: { appointmentId: String(appointment._id) },
    output: { reference: cleanReference },
  });

  return { appointment: updated };
}

/** One row of the Payments page. Money in cents, like the ledger payload. */
function toPaymentRow(appointment, { requests, vendorNames }) {
  const request = requests.get(String(appointment.requestId)) || null;
  const payment = appointment.directPayment || {};
  return {
    appointmentId: String(appointment._id),
    requestId: String(appointment.requestId),
    issueTitle: request?.issueTitle || null,
    property: request?.propertyId?.name || null,
    unit: request?.unitId?.unitNumber || null,
    vendorName: vendorNames.get(String(appointment._id)) || null,
    amountCents: payment.amountCents || 0,
    status: payment.status,
    dueSince: payment.dueSince || null,
    paidAt: payment.paidAt || null,
    reference: payment.reference || null,
  };
}

/** Everything still owed, and the most recent payments marked paid. */
async function listDirectPayments(landlordId) {
  const [due, paid] = await Promise.all([
    Appointment.find({ landlordId, "directPayment.status": "due" }).sort({ "directPayment.dueSince": 1 }).lean(),
    Appointment.find({ landlordId, "directPayment.status": "paid" })
      .sort({ "directPayment.paidAt": -1 })
      .limit(PAID_HISTORY_LIMIT)
      .lean(),
  ]);
  const all = [...due, ...paid];
  const [requestRows, outreachRows] = await Promise.all([
    MaintenanceRequest.find({ _id: { $in: all.map((a) => a.requestId) } })
      .select("issueTitle propertyId unitId")
      .populate("propertyId", "name")
      .populate("unitId", "unitNumber")
      .lean(),
    VendorOutreach.find({ appointmentId: { $in: all.map((a) => a._id) } })
      .select("appointmentId vendorNameSnapshot")
      .lean(),
  ]);
  const lookups = {
    requests: new Map(requestRows.map((r) => [String(r._id), r])),
    vendorNames: new Map(outreachRows.map((o) => [String(o.appointmentId), o.vendorNameSnapshot])),
  };

  return {
    due: due.map((a) => toPaymentRow(a, lookups)),
    paid: paid.map((a) => toPaymentRow(a, lookups)),
    dueTotalCents: due.reduce((sum, a) => sum + (a.directPayment?.amountCents || 0), 0),
  };
}

/**
 * The direct payment on one request, for the landlord's request page. Null
 * when the job was not direct or has not closed. LANDLORD ONLY: it carries
 * the amount, and a tenant never receives a cost.
 */
async function loadRequestDirectPayment(requestId) {
  const appointment = await Appointment.findOne({ requestId, "directPayment.status": { $exists: true } })
    .sort({ createdAt: -1 })
    .lean();
  if (!appointment) return null;
  const payment = appointment.directPayment;
  return {
    appointmentId: String(appointment._id),
    status: payment.status,
    amountCents: payment.amountCents || 0,
    dueSince: payment.dueSince || null,
    paidAt: payment.paidAt || null,
    reference: payment.reference || null,
    vendorName: await vendorNameFor(appointment._id),
  };
}

const countDirectPaymentsDue = (landlordId) =>
  Appointment.countDocuments({ landlordId, "directPayment.status": "due" });

module.exports = {
  MAX_REFERENCE_LENGTH,
  recordDirectPaymentDue,
  markDirectPaymentPaid,
  listDirectPayments,
  loadRequestDirectPayment,
  countDirectPaymentsDue,
};
