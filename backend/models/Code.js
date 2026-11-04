const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const InviteCodeSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      required: true,
    },
    propertyId: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    unitId: {
      type: Schema.Types.ObjectId,
      ref: "Unit",
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Auto-delete expired codes — MongoDB removes documents once expiresAt has passed
InviteCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("InviteCode", InviteCodeSchema);