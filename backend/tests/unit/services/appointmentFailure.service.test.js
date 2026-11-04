// A booking that falls through: the vendor doesn't show, or the tenant never
// confirms the time. Pins:
//   1. failAppointment voids the hold, revokes the job link, CLOSES THE PROXY
//      SESSION, voids the draft completion, puts the request back into routing
//      and hands the vendor's round to advanceOutreach with the reason
//   2. it is idempotent -- the status claim means a second call does nothing,
//      so the hold is voided exactly once
//   3. the vendor is told not to go, without the address
//   4. reportNoShow refuses too early, a visit that isn't booked, and a vendor
//      who checked in; a valid report tells the manager and re-routes nothing
//   5. tenant silence: one reminder at 24h, one manager notice at the deadline

const assert = require("assert");

const Appointment = require("../../../models/Appointment");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const VendorOutreach = require("../../../models/VendorOutreach");
const LedgerEntry = require("../../../models/LedgerEntry");
const JobCompletion = require("../../../models/JobCompletion");
const Property = require("../../../models/Property");
const Landlord = require("../../../models/Landlord");

const calls = { voidHold: [], revoke: [], closeProxy: [], notify: [], audit: [], emails: [], advance: [], completionVoids: [] };
const reset = () => Object.keys(calls).forEach((key) => (calls[key] = []));

// Stubbed BEFORE the service loads: it destructures these on require.
require("../../../services/ledger/ledger.service").voidHold = async (args) => {
  calls.voidHold.push(args);
  return { _id: "void-1" };
};
require("../../../services/vendor/jobToken.service").revokeJobToken = async (args) => {
  calls.revoke.push(args);
};
require("../../../services/comms/proxySession.service").closeProxySession = async (args) => {
  calls.closeProxy.push(args);
};
require("../../../services/notification/notify.service").notifyUser = async (args) => {
  calls.notify.push(args);
};
require("../../../services/audit/agentAction.service").logAgentAction = async (args) => {
  calls.audit.push(args);
};
require("../../../services/notification/email.service").sendEmail = async (args) => {
  calls.emails.push(args);
};
// Lazily required by failAppointment, so patching the export is enough.
require("../../../services/vendor/vendorOutreachSweeper.service").advanceOutreach = async (args) => {
  calls.advance.push(args);
  return { awaitingApproval: true };
};

const lean = (value) => ({ select: () => ({ lean: async () => value }), lean: async () => value });

let appointment = null;
let request = null;
let completion = null;
const outreach = { _id: "out-1", toEmail: "reads@example.com", vendorNameSnapshot: "Reads Plumbing", candidateKey: "vendor:v1" };

Appointment.findOneAndUpdate = async (filter, update) => {
  if (!appointment || String(filter._id) !== String(appointment._id)) return null;
  if (filter.status?.$in && !filter.status.$in.includes(appointment.status)) return null;
  if (typeof filter.status === "string" && filter.status !== appointment.status) return null;
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("tenant") && key.endsWith("At") && value === null && appointment[key]) return null;
  }
  for (const [key, value] of Object.entries(update.$set)) {
    if (key.includes(".")) {
      const [outer, inner] = key.split(".");
      appointment[outer] = { ...(appointment[outer] || {}), [inner]: value };
    } else appointment[key] = value;
  }
  return appointment;
};
Appointment.findOne = async () => appointment;
MaintenanceRequest.findById = () => {
  const chain = { select: () => chain, then: (resolve, reject) => Promise.resolve(request).then(resolve, reject) };
  return chain;
};
VendorOutreach.findOne = async () => outreach;
LedgerEntry.findOne = () => lean({ _id: "hold-1", type: "hold", amountCents: 45000 });
JobCompletion.updateOne = async (filter, update) => {
  calls.completionVoids.push({ filter, update });
  return {};
};
JobCompletion.findOne = () => lean(completion);
Property.findById = () => lean({ address: "12 Hidden St", city: "Regina" });
Landlord.findById = () => lean({ companyName: "Prairie Homes" });

const service = require("../../../services/completion/appointmentFailure.service");

function makeAppointment(fields = {}) {
  return {
    _id: "appt-1",
    requestId: "req-1",
    tenantId: "tenant-1",
    landlordId: "landlord-1",
    status: "scheduled",
    confirmedStart: new Date("2026-10-01T15:00:00.000Z"),
    createdAt: new Date("2026-09-29T15:00:00.000Z"),
    tenantReminderSentAt: null,
    tenantOverdueNotifiedAt: null,
    noShowReport: null,
    save: async function save() {
      return this;
    },
    ...fields,
  };
}

function makeRequest() {
  return {
    _id: "req-1",
    landlordId: "landlord-1",
    tenantId: "tenant-1",
    issueTitle: "Leaking kitchen tap",
    category: "Plumbing",
    propertyId: "prop-1",
    status: "assigned",
    appointmentStatus: "scheduled",
    selectedVendorId: "v1",
    timeline: [],
    save: async function save() {
      return this;
    },
  };
}

const run = async () => {
  /* ===== 1) No-show: every cleanup step, then the next vendor ===== */
  reset();
  appointment = makeAppointment();
  request = makeRequest();
  const now = new Date("2026-10-01T18:00:00.000Z");
  let result = await service.failAppointment({ appointmentId: "appt-1", reason: "no_show", actorId: "landlord-1", now });
  assert.strictEqual(result.failed, true);
  assert.strictEqual(appointment.status, "failed");
  assert.strictEqual(appointment.failureReason, "no_show");
  assert.strictEqual(appointment.noShowReport.status, "confirmed");

  assert.strictEqual(calls.voidHold.length, 1, "the hold is voided");
  assert.strictEqual(calls.voidHold[0].amountCents, 45000);
  assert.strictEqual(calls.voidHold[0].appointmentId, "appt-1");
  assert.strictEqual(calls.revoke.length, 1, "the job link is revoked");
  assert.deepStrictEqual(calls.closeProxy, [{ appointmentId: "appt-1", reason: "job_cancelled" }], "the relay line is closed");
  assert.strictEqual(calls.completionVoids[0].update.$set.closeReason, "booking_failed");

  assert.strictEqual(request.status, "approved", "back to a routable state");
  assert.strictEqual(request.appointmentStatus, "failed");
  assert.strictEqual(request.selectedVendorId, null);
  assert.match(request.timeline[0].note, /Reads Plumbing didn't show up/);

  assert.strictEqual(calls.advance.length, 1);
  assert.strictEqual(calls.advance[0].reason, "no_show");
  assert.strictEqual(calls.advance[0].outreach, outreach);

  const tenantNotice = calls.notify.find((row) => row.userId === "tenant-1");
  assert.ok(tenantNotice, "the tenant is told");

  assert.strictEqual(calls.emails.length, 1, "the vendor is told not to go");
  const email = calls.emails[0];
  assert.strictEqual(email.to, "reads@example.com");
  assert.match(email.subject, /Booking cancelled/);
  assert.match(email.text, /nobody arrived/);
  assert.ok(!email.text.includes("12 Hidden St") && !email.html.includes("12 Hidden St"), "no address in a vendor email");

  /* ===== 2) Idempotent: the second caller loses the claim ===== */
  result = await service.failAppointment({ appointmentId: "appt-1", reason: "no_show", now });
  assert.deepStrictEqual(result, { failed: false, reason: "not_failable" });
  assert.strictEqual(calls.voidHold.length, 1, "voided exactly once");
  assert.strictEqual(calls.advance.length, 1);

  /* ===== 3) Tenant silence: same cleanup, not held against the vendor ===== */
  reset();
  appointment = makeAppointment({ status: "awaiting_tenant" });
  request = makeRequest();
  await service.failAppointment({ appointmentId: "appt-1", reason: "tenant_unconfirmed", now });
  assert.strictEqual(appointment.failureReason, "tenant_unconfirmed");
  assert.strictEqual(appointment.noShowReport, null, "no no-show recorded");
  assert.strictEqual(calls.advance[0].reason, "tenant_unconfirmed");
  assert.match(calls.emails[0].text, /isn't counted against you/);

  await assert.rejects(() => service.failAppointment({ appointmentId: "appt-1", reason: "bored" }), /Unknown failure reason/);

  /* ===== 4) reportNoShow guards ===== */
  reset();
  request = makeRequest();
  completion = null;
  const arrival = new Date("2026-10-01T15:00:00.000Z");

  appointment = makeAppointment({ confirmedStart: arrival });
  let report = await service.reportNoShow({
    appointmentId: "appt-1",
    tenantId: "tenant-1",
    now: new Date(arrival.getTime() + 60 * 60 * 1000),
  });
  assert.strictEqual(report.error.code, "too_early", "an hour late may just be late");

  appointment = makeAppointment({ status: "awaiting_tenant" });
  report = await service.reportNoShow({ appointmentId: "appt-1", tenantId: "tenant-1", now });
  assert.strictEqual(report.error.code, "not_reportable");

  appointment = makeAppointment({ confirmedStart: arrival });
  completion = { checkIn: { at: new Date(arrival.getTime() + 5 * 60 * 1000), source: "denied" } };
  report = await service.reportNoShow({ appointmentId: "appt-1", tenantId: "tenant-1", now });
  assert.strictEqual(report.error.code, "vendor_checked_in", "a check-in -- even without location -- means they came");

  completion = null;
  report = await service.reportNoShow({ appointmentId: "appt-1", tenantId: "tenant-1", note: "  Nobody came  ", now });
  assert.ok(!report.error);
  assert.strictEqual(appointment.noShowReport.status, "reported");
  assert.strictEqual(appointment.noShowReport.note, "Nobody came");
  assert.strictEqual(appointment.status, "scheduled", "a report alone re-routes nothing");
  assert.strictEqual(calls.voidHold.length, 0);
  const managerNotice = calls.notify.find((row) => row.userId === "landlord-1");
  assert.strictEqual(managerNotice.type, "vendor_no_show_reported");

  report = await service.reportNoShow({ appointmentId: "appt-1", tenantId: "tenant-1", now });
  assert.strictEqual(report.already, true, "a second report is a no-op");
  assert.strictEqual(calls.notify.length, 1);

  /* ===== 5) Dismissing a report ===== */
  let dismissed = await service.dismissNoShow({ appointmentId: "appt-1", landlordId: "landlord-1", now });
  // The stub's findOneAndUpdate ignores the noShowReport filter, so check the write.
  assert.strictEqual(dismissed.appointment.noShowReport.status, "dismissed");

  /* ===== 6) Tenant silence sweep: one reminder, then the manager ===== */
  reset();
  const created = new Date("2026-10-01T12:00:00.000Z");
  appointment = makeAppointment({
    status: "awaiting_tenant",
    createdAt: created,
    tenantConfirmBy: new Date(created.getTime() + service.TENANT_CONFIRM_MS),
  });
  const due = (filter) => {
    if (filter.tenantReminderSentAt === null) {
      // Planned reminder (tenantRemindAt), or the legacy createdAt + 24h.
      return (
        !appointment.tenantReminderSentAt &&
        filter.$or.some((clause) =>
          clause.tenantRemindAt?.$lte
            ? appointment.tenantRemindAt && appointment.tenantRemindAt <= clause.tenantRemindAt.$lte
            : !appointment.tenantRemindAt && appointment.createdAt <= clause.createdAt.$lte
        )
      );
    }
    return !appointment.tenantOverdueNotifiedAt && filter.$or.some((clause) => clause.tenantConfirmBy?.$lte >= appointment.tenantConfirmBy);
  };
  Appointment.find = (filter) => lean(appointment.status === filter.status && due(filter) ? [appointment] : []);

  let swept = await service.sweepTenantConfirmations(new Date(created.getTime() + 2 * 60 * 60 * 1000));
  assert.deepStrictEqual(swept, { reminded: 0, escalated: 0 }, "nothing at 2h");

  const at25h = new Date(created.getTime() + 25 * 60 * 60 * 1000);
  swept = await service.sweepTenantConfirmations(at25h);
  assert.deepStrictEqual(swept, { reminded: 1, escalated: 0 });
  assert.strictEqual(calls.notify[0].userId, "tenant-1");
  assert.strictEqual(calls.notify[0].type, "appointment_reminder");

  swept = await service.sweepTenantConfirmations(new Date(at25h.getTime() + 60 * 60 * 1000));
  assert.deepStrictEqual(swept, { reminded: 0, escalated: 0 }, "the reminder goes once");

  const at49h = new Date(created.getTime() + 49 * 60 * 60 * 1000);
  swept = await service.sweepTenantConfirmations(at49h);
  assert.deepStrictEqual(swept, { reminded: 0, escalated: 1 });
  const escalation = calls.notify[calls.notify.length - 1];
  assert.strictEqual(escalation.userId, "landlord-1");
  assert.strictEqual(escalation.type, "appointment_unconfirmed");
  assert.strictEqual(appointment.status, "awaiting_tenant", "the sweep never fails the booking itself");

  swept = await service.sweepTenantConfirmations(new Date(at49h.getTime() + 60 * 60 * 1000));
  assert.deepStrictEqual(swept, { reminded: 0, escalated: 0 }, "the manager is told once");

  /* ===== 6b) The deadline lands before the arrival ===== */
  const H = 60 * 60 * 1000;
  const t0 = new Date("2026-10-12T15:00:00.000Z");
  let plan = service.planTenantConfirmation({ now: t0, arrival: new Date(t0.getTime() + 18 * H) });
  assert.strictEqual(plan.tenantConfirmBy.getTime(), t0.getTime() + 17 * H, "an hour before tomorrow morning's visit, not 48h");
  assert.strictEqual(plan.tenantRemindAt.getTime(), t0.getTime() + 8.5 * H, "reminded halfway there");
  assert.strictEqual(plan.tenantReminderSentAt, null);

  plan = service.planTenantConfirmation({ now: t0, arrival: new Date(t0.getTime() + 5 * 24 * H) });
  assert.strictEqual(plan.tenantConfirmBy.getTime(), t0.getTime() + service.TENANT_CONFIRM_MS, "a far visit keeps 48h");

  plan = service.planTenantConfirmation({ now: t0, arrival: new Date(t0.getTime() + 40 * 60 * 1000) });
  assert.strictEqual(plan.tenantConfirmBy.getTime(), t0.getTime() + 40 * 60 * 1000, "urgent: confirm up to the arrival");
  assert.strictEqual(plan.tenantRemindAt, null, "no room for a reminder");
  assert.strictEqual(plan.tenantReminderSentAt, t0, "so it is marked done");

  plan = service.planTenantConfirmation({ now: t0, arrival: new Date(t0.getTime() - 2 * H) });
  assert.strictEqual(plan.tenantConfirmBy.getTime(), t0.getTime(), "already passed: straight to the manager");

  assert.strictEqual(service.isArrivalPassed({ confirmedStart: new Date(t0.getTime() - 10 * 60 * 1000) }, t0), false, "running late is not passed");
  assert.strictEqual(service.isArrivalPassed({ confirmedStart: new Date(t0.getTime() - H) }, t0), true);
  assert.strictEqual(service.isArrivalPassed({}, t0), false);

  // The manager's alert says the time is gone, not just unconfirmed.
  reset();
  appointment = makeAppointment({
    status: "awaiting_tenant",
    createdAt: new Date(t0.getTime() - 3 * H),
    tenantConfirmBy: new Date(t0.getTime() - 2 * H),
    tenantReminderSentAt: t0,
    confirmedStart: new Date(t0.getTime() - H),
  });
  Appointment.find = (filter) => lean(appointment.status === filter.status && due(filter) ? [appointment] : []);
  swept = await service.sweepTenantConfirmations(t0);
  assert.strictEqual(swept.escalated, 1);
  assert.match(calls.notify[calls.notify.length - 1].title, /arrival time passed/);
  assert.match(calls.notify[calls.notify.length - 1].message, /Find another vendor/);

  /* ===== 7) Deadline helpers ===== */
  assert.strictEqual(
    service.tenantConfirmDeadline({ createdAt: created }).getTime(),
    created.getTime() + service.TENANT_CONFIRM_MS,
    "legacy rows fall back to createdAt + 48h"
  );
  assert.strictEqual(service.noShowReportableAt({}), null);
  assert.strictEqual(
    service.noShowReportableAt({ confirmedStart: arrival }).getTime(),
    arrival.getTime() + service.NO_SHOW_GRACE_MS
  );

  console.log("appointmentFailure.service tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
