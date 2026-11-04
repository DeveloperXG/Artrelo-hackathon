// Routing decisions derived from request state.
//
// Decisions Needed listed only ApprovalRequest rows, so the commonest decision
// -- "Approve contact" for the recommended vendor -- and a request paused
// because every vendor declined never appeared there. Pins:
//   1. a request with an uncontacted recommendation is a contact_approval
//   2. a paused request is routing_paused, with the last round's reason
//   3. an active vendor, terminal status, or no snapshot owes nothing
//   4. a request that already has a pending ApprovalRequest is left out (that
//      row puts it on the page already) -- so the badge never double-counts
//   5. bookings: a tenant past the confirm deadline and a reported no-show are
//      owed; a booking still inside its window, or on a closed request, is not

const assert = require("assert");
const MaintenanceRequest = require("../../../models/MaintenanceRequest");
const ApprovalRequest = require("../../../models/ApprovalRequest");
const Appointment = require("../../../models/Appointment");
const VendorOutreach = require("../../../models/VendorOutreach");

let rows = [];
let withApproval = [];
let appointments = [];
let bookingRequests = [];
let appealRows = [];
const chainOf = (value) => {
  const chain = { populate: () => chain, lean: async () => value() };
  return chain;
};
// The booking lookup asks for requests by id; the routing one by landlord.
// Appeals ask for rejected-and-appealed requests.
MaintenanceRequest.find = (filter) => ({
  select: () => chainOf(() => (filter._id ? bookingRequests : filter.isAppealed ? appealRows : rows)),
});
// Filters on the deadline like the real query, so "not yet due" is tested.
Appointment.find = (filter) => {
  const now = filter.$or[0].$or[0].tenantConfirmBy.$lte;
  const due = appointments.filter(
    (row) =>
      (row.status === "awaiting_tenant" && row.tenantConfirmBy <= now) ||
      (row.status === "scheduled" && row.noShowReport?.status === "reported")
  );
  return { select: () => ({ lean: async () => due }) };
};
VendorOutreach.find = () => ({
  select: () => ({ lean: async () => [{ appointmentId: "a1", vendorNameSnapshot: "Reads Plumbing" }] }),
});
ApprovalRequest.distinct = async () => withApproval;

const {
  classifyRequest,
  getPauseKind,
  listRoutingDecisions,
} = require("../../../services/request/decisionQueue.service");

const recommended = (key, overrides = {}) => ({
  candidateKey: key,
  name: key,
  state: "recommended",
  outreach: { status: "not_sent" },
  ...overrides,
});
const request = (id, overrides = {}) => ({
  _id: id,
  status: "queued",
  intakeFollowUp: {state:'reviewed',revision:1,remainingTopics:[]},
  routingStatus: "ready",
  issueTitle: `Request ${id}`,
  createdAt: new Date(`2026-10-0${id.slice(-1)}T00:00:00Z`),
  vendorRecommendationSnapshot: {
    recommendations: [recommended("v1")],
    candidateLedger: [recommended("v1")],
  },
  ...overrides,
});

async function main() {
  /* 1) contact approval -------------------------------------------------- */
  let decision = classifyRequest(request("r1"));
  assert.strictEqual(decision.type, "contact_approval");
  assert.strictEqual(decision.candidate.candidateKey, "v1");

  // The top one already contacted: the next uncontacted recommendation is owed.
  decision = classifyRequest(
    request("r1", {
      vendorRecommendationSnapshot: {
        recommendations: [recommended("v1", { state: "excluded", outreach: { status: "declined" } }), recommended("v2")],
        candidateLedger: [],
      },
    })
  );
  assert.strictEqual(decision.candidate.candidateKey, "v2");

  /* 2) paused ------------------------------------------------------------- */
  decision = classifyRequest(
    request("r2", {
      routingStatus: "paused",
      vendorRecommendationSnapshot: {
        recommendations: [],
        candidateLedger: [],
        lastRound: { reasonLabel: "Vendor declined" },
      },
    })
  );
  assert.deepStrictEqual(decision, { type: "routing_paused", reason: "Vendor declined", pauseKind: "paused" });

  /* 2b) why it paused, so the card can say something true ----------------- */
  assert.strictEqual(
    getPauseKind({ lastRound: { resolution: "exhausted", at: "2026-10-01T10:00:00Z" } }),
    "vendors_exhausted"
  );
  assert.strictEqual(
    getPauseKind({ diagnostics: { outcomeCode: "no_candidates_discovered" } }),
    "no_eligible_vendors",
    "an empty network never had anyone 'in line'"
  );
  assert.strictEqual(
    getPauseKind({ lastManagerAction: { type: "reject_recommendation", at: "2026-10-01T10:00:00Z" } }),
    "manager_rejected"
  );
  assert.strictEqual(
    getPauseKind({ diagnostics: { outcomeCode: "all_vendors_contacted" } }),
    "vendors_exhausted",
    "a fresh search after everyone declined is still 'every vendor has been tried'"
  );
  assert.strictEqual(
    getPauseKind({
      lastRound: { resolution: "exhausted", at: "2026-10-01T10:00:00Z" },
      lastManagerAction: { type: "reject_recommendation", at: "2026-10-02T10:00:00Z" },
    }),
    "manager_rejected",
    "the later of the two is the reason"
  );

  /* 3) nothing owed ------------------------------------------------------- */
  const active = recommended("v1", { state: "approved_for_contact", outreach: { status: "sent" } });
  assert.strictEqual(
    classifyRequest(request("r3", { vendorRecommendationSnapshot: { recommendations: [], candidateLedger: [active] } })),
    null,
    "waiting on a vendor, not on the manager"
  );
  assert.strictEqual(classifyRequest(request("r3", { status: "completed" })), null);
  assert.strictEqual(classifyRequest(request("r3", { vendorRecommendationSnapshot: null })), null);

  /* 4) listing: sorted oldest first, pending approvals left out ---------- */
  rows = [request("r2"), request("r1"), request("r3")];
  withApproval = ["r3"];
  const items = await listRoutingDecisions("landlord-1");
  assert.deepStrictEqual(
    items.map((item) => item.requestId),
    ["r1", "r2"],
    "oldest first; r3 already has a pending approval"
  );
  assert.deepStrictEqual(items[0].candidate, { candidateKey: "v1", name: "v1" });
  assert.ok(!("vendorRecommendationSnapshot" in items[0]), "no snapshot shipped to the list");

  /* 5) bookings ----------------------------------------------------------- */
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const future = new Date(Date.now() + 60 * 60 * 1000);
  appointments = [
    { _id: "a1", requestId: "b1", status: "awaiting_tenant", tenantConfirmBy: past, confirmedStart: future },
    { _id: "a2", requestId: "b2", status: "awaiting_tenant", tenantConfirmBy: future },
    { _id: "a3", requestId: "b3", status: "scheduled", noShowReport: { status: "reported", note: "Nobody came", reportedAt: past } },
    { _id: "a4", requestId: "b4", status: "scheduled", noShowReport: { status: "reported" } },
  ];
  bookingRequests = [
    { _id: "b1", status: "assigned", issueTitle: "Tap", createdAt: new Date("2026-09-01T00:00:00Z") },
    { _id: "b3", status: "assigned", issueTitle: "Heat", createdAt: new Date("2026-09-02T00:00:00Z") },
    { _id: "b4", status: "cancelled", issueTitle: "Gone" },
  ];
  rows = [];
  withApproval = [];
  const bookings = await listRoutingDecisions("landlord-1");
  assert.deepStrictEqual(
    bookings.map((item) => [item.type, item.appointmentId]),
    [
      ["tenant_time_unconfirmed", "a1"],
      ["vendor_no_show", "a3"],
    ],
    "a2 is inside its window; a4 belongs to a closed request"
  );
  assert.strictEqual(bookings[0].vendorName, "Reads Plumbing");
  assert.strictEqual(new Date(bookings[0].deadline).getTime(), past.getTime());
  assert.strictEqual(bookings[1].note, "Nobody came");

  /* 6) appeals waiting on the landlord ----------------------------------- */
  appointments = [];
  appealRows = [
    {
      _id: "ap1",
      issueTitle: "Mould in bathroom",
      rejectionReason: "Tenant-caused",
      appealNote: "It's a leak from upstairs",
      appealedAt: new Date("2026-10-02T00:00:00Z"),
      createdAt: new Date("2026-09-30T00:00:00Z"),
    },
  ];
  const appeals = await listRoutingDecisions("landlord-1");
  assert.deepStrictEqual(appeals.map((item) => item.type), ["appeal_review"]);
  assert.strictEqual(appeals[0].reason, "Tenant-caused", "the original rejection reason");
  assert.strictEqual(appeals[0].note, "It's a leak from upstairs", "the tenant's appeal");
  appealRows = [];

  console.log("decisionQueue.service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
