const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TenantSchema = new Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    // The login identity. Unique because one account holds at most one tenant
    // profile — i.e. one tenancy per person, which is what the app did before
    // accounts existed.
    accountId: {
      type: Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      unique: true,
    },

    // A copy of Account.email, written only from the account and never from a
    // request body. See models/Landlord.js for why the copy is kept.
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },

    // 🔗 Relationships
    unit: {
      type: Schema.Types.ObjectId,
      ref: "Unit",
    },
    landlord: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
    },

    // 🧾 Invite / Verification
    inviteCode: {
      type: String,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["pending", "active", "inactive"],
      default: "pending",
    },
    role: {
      type: String,
      enum: ["tenant", "co-tenant", "primary_tenant"],
      default: "tenant",
    },

    // A landlord retiring a unit (or the whole property) asks its tenants to
    // move out first; the unit cannot be deleted while anyone is still linked
    // to it. Completing a move-out clears `unit` and sets status "inactive" --
    // `fromUnit` keeps the link traceable, and past requests keep tenantId.
    moveOut: {
      type: new Schema(
        {
          status: { type: String, enum: ["requested", "completed"], required: true },
          reason: {
            type: String,
            enum: ["unit_retired", "property_retired", "landlord"],
            default: "landlord",
          },
          requestedAt: { type: Date, default: null },
          requestedBy: { type: Schema.Types.ObjectId, default: null },
          completedAt: { type: Date, default: null },
          completedBy: { type: String, enum: ["tenant", "landlord", null], default: null },
          fromUnit: { type: Schema.Types.ObjectId, ref: "Unit", default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },

    // 🕒 Metadata
    dateJoined: {
      type: Date,
      default: Date.now,
    },
    lastLogin: {
      type: Date,
    },

    // 🧩 Extras
    profilePicture: {
      type: String,
    },
    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt automatically
  }
);

// 🧠 Indexing for fast lookups
// 🧠 Indexing for fast lookups
// TenantSchema.index({ email: 1 }); // Already indexed by unique: true
TenantSchema.index({ unit: 1 });
TenantSchema.index({ landlord: 1 });

// 🧹 Helper method example
TenantSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

//hasRole function

module.exports =mongoose.model("Tenant", TenantSchema);

