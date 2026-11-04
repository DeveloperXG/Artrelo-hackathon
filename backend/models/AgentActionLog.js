const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const AgentActionLogSchema = new Schema(
  {
    // OPTIONAL, and deliberately so. This log began as a per-request trail, but
    // the money path added landlord-level events that belong to no maintenance
    // request at all — wallet top-ups, a payout marked paid by hand, a card
    // decline. Requiring it meant every one of those failed validation, and
    // because logAgentAction swallows its own errors they vanished with only a
    // console line: the audit spine the money path depends on was quietly
    // dropping exactly the entries that concern money.
    //
    // landlordId stays required, so nothing is ever unattributable.
    requestId: {
      type: Schema.Types.ObjectId,
      ref: "MaintenanceRequest",
      default: null,
      index: true,
    },
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      required: true,
      index: true,
    },
    actor: {
      type: String,
      enum: ["ai_agent", "landlord", "tenant", "vendor", "system"],
      required: true,
    },
    actionType: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    input: { type: Schema.Types.Mixed },
    output: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

AgentActionLogSchema.index({ landlordId: 1, requestId: 1, createdAt: -1, _id: -1 });
AgentActionLogSchema.pre('validate', function () {
  const context = require('../services/judgeSandbox/simulationScope.service').metadataForRecord(this);
  if (context) this.metadata = { ...(this.metadata || {}), judgeSimulation: context };
});
module.exports = mongoose.model("AgentActionLog", AgentActionLogSchema);
