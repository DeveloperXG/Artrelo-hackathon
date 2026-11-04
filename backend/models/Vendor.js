const mongoose = require("mongoose");
const { formatHours } = require("../services/vendor/vendorHours");
const Schema = mongoose.Schema;

const GeoSchema = new Schema(
  {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
  },
  { _id: false }
);

const normalizeStringArray = (values = []) =>
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  )];

const VendorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    company: { type: String, trim: true },

    // Vendors are managed by landlords
    landlordId: {
      type: Schema.Types.ObjectId,
      ref: "Landlord",
      index: true,
    },

    // The GLOBAL contractor behind this landlord-scoped roster entry. The same
    // real plumber hired by two landlords is two Vendor documents but one
    // VendorIdentity, which is what lets payout onboarding and the vendor hub
    // happen once rather than once per landlord.
    identityId: {
      type: Schema.Types.ObjectId,
      ref: "VendorIdentity",
      default: null,
      index: true,
    },

    category: { type: String, trim: true },
    city: { type: String, trim: true },

    // List of issue categories this vendor specializes in.
    specialties: { type: [{ type: String, trim: true }], default: [] },
    categories: { type: [{ type: String, trim: true }], default: [] },
    // Trades the landlord typed that are not in the preset list. Kept apart from
    // `specialties` so the form can render them as removable custom chips; the
    // matcher reads both (providerShapes.normalizeVendorOption).
    customSpecialties: { type: [{ type: String, trim: true }], default: [] },

    // Service area can be a simple text location label for MVP.
    serviceArea: { type: String, trim: true },
    serviceAreas: [{ type: String, trim: true }],
    // Display string. Derived from operatingHours in pre-validate whenever those
    // are set; the default only survives on rows that predate structured hours.
    businessHours: {
      type: String,
      trim: true,
      default: "Mon-Fri 9:00-17:00",
    },
    // Structured hours (see services/vendor/vendorHours.js). Optional at the
    // schema level on purpose: vendors created before this field existed must
    // still load and save -- the sweepers .save() them to update stats. The
    // create/update API is where it is required.
    operatingHours: {
      type: new Schema(
        {
          preset: { type: String, enum: ["weekdays", "always", "custom"], required: true },
          weekly: [
            new Schema(
              {
                day: { type: Number, min: 0, max: 6, required: true },
                open: { type: String, required: true },
                close: { type: String, required: true },
              },
              { _id: false }
            ),
          ],
        },
        { _id: false }
      ),
      default: undefined,
    },
    emergencyAvailable: { type: Boolean, default: false },
    averageCost: { type: Number, default: 0, min: 0 },
    notes: { type: String },

    hourlyRate: { type: Number, default: 0, min: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
    responseStats: {
      averageFirstResponseMinutes: { type: Number, default: 0, min: 0 },
      totalRequests: { type: Number, default: 0, min: 0 },
      acceptedRequests: { type: Number, default: 0, min: 0 },
      declinedRequests: { type: Number, default: 0, min: 0 },
      noResponseCount: { type: Number, default: 0, min: 0 },
      // Booked jobs the vendor didn't turn up for, as confirmed by the manager.
      noShowCount: { type: Number, default: 0, min: 0 },
    },
    lastUsedAt: { type: Date },
    successfulJobs: { type: Number, default: 0, min: 0 },
    failedJobs: { type: Number, default: 0, min: 0 },
    providerVendorId: { type: String, trim: true },
    providerName: { type: String, trim: true, default: "manual" },
    preferred: { type: Boolean, default: false },
    hardCapacityLimit: { type: Number, min: 0, default: 0 },
    currentAssignments: { type: Number, min: 0, default: 0 },
    blacklistedPropertyIds: [{ type: Schema.Types.ObjectId, ref: "Property" }],
    blacklistedUnitIds: [{ type: Schema.Types.ObjectId, ref: "Unit" }],
    source: {
      type: String,
      enum: [
        "preset",
        "mock_external",
        "manual_dispatch",
        "taskrabbit",
        "thumbtack",
        "external",
        "suggested",
      ],
      default: "preset",
    },
    isDemoVendor: { type: Boolean, default: false },
    verificationStatus: {
      type: String,
      enum: ["trusted", "mock_verified", "unverified", "blocked"],
      default: "unverified",
    },
    insuranceVerified: { type: Boolean, default: false },
    licenseVerified: { type: Boolean, default: false },

    status: { type: String, enum: ["active", "inactive"], default: "active" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

VendorSchema.pre("validate", function (next) {
  this.specialties = normalizeStringArray(this.specialties);
  this.categories = normalizeStringArray(this.categories);
  this.serviceAreas = normalizeStringArray(this.serviceAreas);

  // A custom entry that matches a preset (any case) is just that preset.
  const presetKeys = new Set(this.specialties.map((value) => value.toLowerCase()));
  const seenCustom = new Set();
  this.customSpecialties = normalizeStringArray(this.customSpecialties).filter((value) => {
    const key = value.toLowerCase();
    if (presetKeys.has(key) || seenCustom.has(key)) return false;
    seenCustom.add(key);
    return true;
  });

  if (this.operatingHours?.weekly?.length) {
    this.businessHours = formatHours(this.operatingHours);
  }

  if (this.serviceArea && !this.serviceAreas.length) {
    this.serviceAreas = normalizeStringArray([this.serviceArea]);
  }

  if (!this.categories.length && this.specialties.length) {
    this.categories = [...this.specialties];
  }

  if (!this.specialties.length && this.categories.length) {
    this.specialties = [...this.categories];
  }

  if (typeof this.active !== "boolean") {
    this.active = this.status !== "inactive";
  }

  this.status = this.active ? "active" : "inactive";

  if (this.source === "trusted" && this.verificationStatus === "unverified") {
    this.verificationStatus = "trusted";
  }

  next();
});

module.exports = mongoose.model("Vendor", VendorSchema);
