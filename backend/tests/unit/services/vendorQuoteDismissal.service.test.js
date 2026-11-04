// Turning down an accepted quote: one path for both doors (Dismiss this quote,
// and rejecting the quote's approval in Decisions), and the vendor is told.

const assert = require("assert");

const VendorOutreach = require("../../../models/VendorOutreach");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const Property = require("../../../models/Property");
const Landlord = require("../../../models/Landlord");
const AgentActionLog = require("../../../models/AgentActionLog");
const emailService = require("../../../services/notification/email.service");
const sweeper = require("../../../services/vendor/vendorOutreachSweeper.service");

let outreachRow = null;
let claimFilter = null;
let approvalUpdates = [];
let emails = [];
let advanced = [];

VendorOutreach.findOneAndUpdate = async (filter, update) => {
  claimFilter = filter;
  if (!outreachRow || outreachRow.status !== "accepted") return null;
  outreachRow = { ...outreachRow, status: "declined", response: { declineReason: update.$set["response.declineReason"] } };
  return outreachRow;
};
ApprovalRequest.updateMany = async (filter, update) => {
  approvalUpdates.push({ filter, update });
  return { modifiedCount: 1 };
};
Property.findById = () => ({ select: () => ({ lean: async () => ({ city: "Saskatoon" }) }) });
Landlord.findById = () => ({ select: () => ({ lean: async () => ({ firstName: "Omar", lastName: "Owner" }) }) });
AgentActionLog.create = async (row) => row;
emailService.sendEmail = async (message) => {
  emails.push(message);
  return { sent: true };
};
sweeper.advanceOutreach = async (args) => {
  advanced.push(args);
  return { exhausted: true };
};

const {
  dismissVendorQuote,
  expireOrphanedQuoteApprovals,
} = require("../../../services/vendor/vendorQuoteDismissal.service");

const request = { _id: "req-1", landlordId: "landlord-1", category: "Plumbing", propertyId: "prop-1" };
const reset = (overrides = {}) => {
  outreachRow = {
    _id: "outreach-1",
    status: "accepted",
    vendorNameSnapshot: "Reads Plumbing",
    toEmail: "reads@artrelo.test",
    candidateKey: "preset__reads",
    ...overrides,
  };
  approvalUpdates = [];
  emails = [];
  advanced = [];
};

async function main() {
  /* -------- the manager's reason reaches the vendor -------- */
  reset();
  let result = await dismissVendorQuote({ request, outreach: outreachRow, reason: "  Over our budget  " });
  assert.deepStrictEqual(result, { dismissed: true });
  assert.deepStrictEqual(claimFilter, { _id: "outreach-1", status: "accepted", appointmentId: null }, "claimed atomically");
  assert.strictEqual(outreachRow.response.declineReason, "Over our budget");

  assert.strictEqual(emails.length, 1, "the vendor is told -- they had already said yes");
  assert.strictEqual(emails[0].to, "reads@artrelo.test");
  assert.match(emails[0].subject, /Quote not accepted — plumbing job in Saskatoon/);
  assert.match(emails[0].text, /Their reason: Over our budget/);
  assert.match(emails[0].text, /Omar Owner has decided not to go ahead/);
  assert.ok(!/\$|quota|limit/i.test(emails[0].text), "no quota, limit or amounts in the vendor's email");

  /* -------- the quote's approval leaves Decisions Needed -------- */
  assert.deepStrictEqual(approvalUpdates[0].filter, {
    requestId: "req-1",
    status: "pending",
    "payload.outreachId": "outreach-1",
  });
  assert.strictEqual(approvalUpdates[0].update.$set.status, "rejected");

  /* -------- and routing moves on -------- */
  assert.strictEqual(advanced.length, 1);
  assert.strictEqual(advanced[0].reason, "manager_dismissed");

  /* -------- no reason given: a polite email without one -------- */
  reset();
  await dismissVendorQuote({ request, outreach: outreachRow });
  assert.strictEqual(outreachRow.response.declineReason, "Dismissed by the property manager");
  assert.ok(!/Their reason/.test(emails[0].text));

  /* -------- a second click, or both doors at once: once -------- */
  reset({ status: "declined" });
  result = await dismissVendorQuote({ request, outreach: outreachRow, reason: "again" });
  assert.deepStrictEqual(result, { dismissed: false, reason: "not_dismissable" });
  assert.strictEqual(emails.length, 0, "no second email");
  assert.strictEqual(advanced.length, 0, "no second advance");

  /* -------- no email on file: still dismissed -------- */
  reset({ toEmail: null });
  result = await dismissVendorQuote({ request, outreach: outreachRow });
  assert.strictEqual(result.dismissed, true);
  assert.strictEqual(emails.length, 0);

  /* -------- stale quote approvals leave Decisions Needed -------- */
  // Two pending quote approvals: one for a vendor still waiting on the
  // manager, one for a vendor already turned down (left stale before
  // dismissals settled their own approval).
  ApprovalRequest.find = () => ({
    select: () => ({
      lean: async () => [
        { _id: "appr-open", payload: { outreachId: "out-open" } },
        { _id: "appr-gone", payload: { outreachId: "out-gone" } },
      ],
    }),
  });
  let openFilter = null;
  VendorOutreach.find = (filter) => {
    openFilter = filter;
    return { select: () => ({ lean: async () => [{ _id: "out-open" }] }) };
  };
  approvalUpdates = [];
  const expired = await expireOrphanedQuoteApprovals("landlord-1");
  assert.strictEqual(expired, 1);
  assert.deepStrictEqual(openFilter.status, "accepted", "open means still accepted...");
  assert.strictEqual(openFilter.appointmentId, null, "...and not yet booked");
  assert.deepStrictEqual(approvalUpdates[0].filter._id, { $in: ["appr-gone"] }, "only the orphan");
  assert.strictEqual(approvalUpdates[0].update.$set.status, "expired");

  ApprovalRequest.find = () => ({ select: () => ({ lean: async () => [] }) });
  approvalUpdates = [];
  assert.strictEqual(await expireOrphanedQuoteApprovals("landlord-1"), 0);
  assert.strictEqual(approvalUpdates.length, 0, "nothing pending, nothing written");

  console.log("vendorQuoteDismissal.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
