const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// One row per non-emergency request a tenant SENT -- the ledger the daily and
// weekly request limits count (services/request/requestQuota.service.js).
//
// A separate collection, not a count of MaintenanceRequest rows, because
// requests get hard-deleted (an expired rejection, a declined appeal, a tenant
// deleting a queued request) and deleting a request must not hand its slot
// back. Rows outlive their request on purpose; requestId may point at nothing.
//
// The TTL index prunes rows once they are older than the longest window, so the
// collection never needs a sweeper.
const RETENTION_SECONDS = 8 * 24 * 60 * 60;

const RequestSubmissionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  unitId: { type: Schema.Types.ObjectId, ref: "Unit", default: null },
  landlordId: { type: Schema.Types.ObjectId, ref: "Landlord", default: null },
  // Null while the slot is reserved and the request is still being created.
  requestId: { type: Schema.Types.ObjectId, ref: "MaintenanceRequest", default: null },
  at: { type: Date, required: true, default: Date.now },
});

RequestSubmissionSchema.index({ tenantId: 1, at: -1 });
RequestSubmissionSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

module.exports = mongoose.model("RequestSubmission", RequestSubmissionSchema);
module.exports.RETENTION_SECONDS = RETENTION_SECONDS;
