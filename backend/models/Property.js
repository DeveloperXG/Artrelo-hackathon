// propertySchema.js
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const propertySchema = new Schema({
  landlordId: {
    type: Schema.Types.ObjectId,
    ref: "User", // landlord who owns this property
    required: true,
  },
  name: { type: String, required: true }, // e.g., "Maple Apartments"
  address: { type: String, required: true },
  // Optional, and nothing geocodes it yet. It exists so the completion
  // geofence check HAS a reference point once addresses are geocoded; until
  // then evaluateCompletionEvidence treats its absence as "no geofence to
  // check" rather than as evidence against the vendor.
  geo: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
  },
  description: { type: String },
  amenities: [String], // e.g., ["Gym", "Pool", "Parking"]
  units: [
    {
      type: Schema.Types.ObjectId,
      ref: "Unit",
    },
  ],
  // Set instead of deleting once the property has any request history: past
  // requests, payments and ledger entries still point here, and the History
  // page needs it to resolve. Archived properties drop out of every list and
  // picker but stay readable by id. See services/portfolio/deletionGuard.service.js.
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model("Property", propertySchema);
