// One masked SMS channel, for one job.
//
// The product rule: the vendor texts from their own phone, off-app; the tenant
// stays in-app; NEITHER ever learns the other's real number. A ProxySession is
// the only place the pairing is written down, and it is deliberately a separate
// document rather than a field on Appointment or Tenant — the Tenant record is
// never mutated, so there is nothing to reverse when the job ends. Closing the
// session IS the teardown.
//
// THE ROUTING INVARIANT (the index at the bottom of this file):
//
//   An inbound SMS carries exactly two pieces of routing information — `From`
//   (the vendor's real phone) and `To` (our proxy number). Nothing else. There
//   is no thread id, no job reference, and a vendor standing in a basement is
//   not going to prefix their text with one.
//
//   So the pair (proxyNumber, vendorPhoneE164) MUST resolve to at most one open
//   session, or an inbound message is genuinely unroutable and we would have to
//   guess which job a vendor meant. Guessing here means showing one tenant a
//   message about a different tenant's unit.
//
//   The consequence: a one-person vendor holding two live jobs needs two
//   DIFFERENT proxy numbers. That is why there is a number pool at all, and it
//   is the deferred vendor double-booking problem resurfacing as a routing
//   constraint. The unique index is what makes it impossible to violate by
//   accident rather than merely discouraged by a comment.
//
// The pair is scoped to open sessions only: once a job closes, the same vendor
// may be re-allocated the same number for a future job, which is what keeps a
// small pool usable.

const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const PROXY_SESSION_STATUSES = ["open", "closed"];

// Why a session ended. Not cosmetic — "pool_exhausted" never produces a row at
// all, whereas these all describe a channel that really existed and stopped.
const PROXY_CLOSE_REASONS = ["job_closed", "job_cancelled", "revoked", "expired"];

const ProxySessionSchema = new Schema(
  {
    // E.164, drawn from the configured pool. The number a vendor sees as the
    // sender, and the number they reply to.
    proxyNumber: { type: String, required: true, trim: true },

    // The vendor's REAL phone, in E.164. Half of the inbound routing key.
    // Stored here rather than read through VendorIdentity at routing time on
    // purpose: a vendor who updates their number mid-job must not silently
    // reroute a live channel, and an inbound lookup must be one indexed query.
    vendorPhoneE164: { type: String, required: true, trim: true },

    requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", required: true, index: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", required: true },
    // Where an inbound message is delivered: as a comment on the request, and a
    // notification to this tenant. Never used to look up their phone number.
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    identityId: { type: Schema.Types.ObjectId, ref: "VendorIdentity", default: null },
    // Carried purely so the JOB-XXXXXX reference a vendor sees in an SMS is the
    // same string they see in the portal and the hub, both of which derive it
    // from the outreach id. A second, session-derived code would be a support
    // call waiting to happen.
    outreachId: { type: Schema.Types.ObjectId, ref: "VendorOutreach", default: null },
    landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", default: null, index: true },

    // Snapshot, for message prefixes and audit lines. A display string only.
    vendorNameSnapshot: { type: String, trim: true },

    status: { type: String, enum: PROXY_SESSION_STATUSES, default: "open", index: true },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, enum: PROXY_CLOSE_REASONS, default: undefined },

    // Cheap observability for a channel nobody can read the contents of.
    inboundCount: { type: Number, default: 0, min: 0 },
    // Twilio retries a webhook it believes failed, and a retry carries the SAME
    // MessageSid. Recording the last one deduplicates the consecutive-retry
    // case -- which is the case that actually happens -- without a whole
    // processed-message collection. It does NOT dedupe out-of-order replays;
    // if that ever matters, this becomes a real idempotency store.
    lastInboundSid: { type: String, default: null },
    outboundCount: { type: Number, default: 0, min: 0 },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// THE ROUTING INVARIANT. See the header.
//
// partialFilterExpression rather than sparse, for the same reason JobToken uses
// it: this has to constrain only the OPEN rows. A closed session must not
// reserve a number forever, or a pool of ten numbers dies after ten jobs.
ProxySessionSchema.index(
  { proxyNumber: 1, vendorPhoneE164: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);

// One open channel per job. Makes openProxySession idempotent under the same
// re-entry that finalizeVendorAcceptance already has to survive (a quota
// approval re-enters it), without needing a read-then-write.
ProxySessionSchema.index(
  { appointmentId: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);

// The inbound hot path: resolve (From, To) to a session.
ProxySessionSchema.index({ vendorPhoneE164: 1, proxyNumber: 1, status: 1 });

module.exports = mongoose.model("ProxySession", ProxySessionSchema);
module.exports.PROXY_SESSION_STATUSES = PROXY_SESSION_STATUSES;
module.exports.PROXY_CLOSE_REASONS = PROXY_CLOSE_REASONS;
