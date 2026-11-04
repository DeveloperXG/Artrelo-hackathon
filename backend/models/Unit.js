const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// A unit exists to anchor the Property -> Unit -> Tenant -> Request hierarchy.
// It deliberately carries no rent/bedroom/lease inventory: Artrelo coordinates
// maintenance, it is not a property-management system, and every extra field
// here is friction on the onboarding path that gates the whole product.
const unitSchema = new Schema(
  {
    propertyId: {
      type: Schema.Types.ObjectId,
      ref: "Property",
      required: true,
    },
    unitNumber: {
      type: String, // the identifier the landlord uses: "A1", "101", "PH2", "G01"
      required: true,
      trim: true,
    },
    isOccupied: {
      type: Boolean,
      default: false,
    },
    tenantId: {
      type: Schema.Types.ObjectId,
      ref: "User", // if occupied by tenant
      default: null,
    },
    status: {
      type: String,
      enum: ["Available", "Rented", "Under Maintenance"],
      default: "Available",
    },
    // Archived rather than deleted when requests reference it -- same reasoning
    // as Property.archivedAt. `{ archivedAt: null }` also matches rows that
    // predate the field, so no backfill is needed.
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Every collision check and per-property listing filters on this pair, and bulk
// creation runs one such query for a whole batch. NOT unique: existing
// deployments may already hold duplicate identifiers, and a unique index that
// fails to build would fail silently at startup and leave the guarantee
// imaginary. Uniqueness is enforced in the service layer instead.
unitSchema.index({ propertyId: 1, unitNumber: 1 });

module.exports = mongoose.model("Unit", unitSchema);
