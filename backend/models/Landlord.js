const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const LandlordSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    // The login identity. Unique because one account holds at most one landlord
    // profile; a second role for the same person is a Tenant profile, not a
    // second Landlord.
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true, unique: true },

    // A copy of Account.email, written only from the account and never from a
    // request body. Kept because several places read it off the profile — the
    // vendor brief's manager.email, the landlord's tenant list, request
    // population — and going through the account for each would be a join for
    // a value that cannot currently change. A change-email flow would have to
    // update the account and both profiles together.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    companyName: { type: String, trim: true },

    role: {
      type: String,
      enum: ["landlord", "property_manager", "admin"],
      default: "landlord",
    },

    properties: [{ type: Schema.Types.ObjectId, ref: "Property" }],

    isVerified: { type: Boolean, default: true },
    status: { type: String, enum: ["active", "inactive"], default: "active" },

    profilePicture: { type: String },
    notificationPreferences: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
    },

    lastLogin: { type: Date },

    // THE FREE BETA. Stamped once, at sign-up, by createOrAttachProfile; read by
    // services/beta/beta.service.js. A landlord with no `beta` (an account that
    // predates the program) is simply not in a beta -- every consumer treats the
    // absence as "no beta", never as an error.
    beta: {
      startedAt: { type: Date },
      endsAt: { type: Date },
      // Flipped to "ended" by the lifecycle sweeper. Money decisions must use
      // beta.service.isBetaActive (the date), because this lags by up to an hour.
      status: { type: String, enum: ["active", "ended"] },
      // Which reminder emails have gone out ("30d", "14d", "3d"). A reminder is
      // CLAIMED here before it is sent, which is what stops a second sweeper
      // instance mailing the same landlord twice.
      remindersSent: { type: [String], default: undefined },
      // When the operator last moved the end date (beta_admin.js).
      extendedAt: { type: Date },
    },

    // Acceptance of the sign-up Terms. Nothing recorded this before.
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String, trim: true },

    // The founding-landlord agreement. `terms` is a SNAPSHOT of the numbers
    // offered at acceptance (config/beta.js foundingTerms), so a later change to
    // the environment never rewrites what someone agreed to.
    foundingAgreement: {
      version: { type: String, trim: true },
      acceptedAt: { type: Date },
      // They said no, explicitly. Mutually exclusive with acceptedAt: accepting
      // replaces this whole subdocument (see beta.controller.postAgreement), so
      // a landlord who declines and later changes their mind loses this field
      // and gains the acceptance in one write. The decline itself survives only
      // in the audit log.
      declinedAt: { type: Date },
      // Set when a snapshot taken before any rate existed (0/0) was frozen at
      // the first job actually charged. See serviceFee.service.lockFoundingRate.
      feeLockedAt: { type: Date },
      // Opaque, for dispute evidence only. Never returned by any API.
      ipHash: { type: String },
      terms: {
        serviceFee: {
          flatCents: { type: Number, min: 0 },
          percent: { type: Number, min: 0 },
        },
        planDiscountPercent: { type: Number, min: 0 },
      },
    },

    // HOW THIS LANDLORD'S VENDORS ARE PAID.
    //
    //   direct    the landlord pays the vendor themselves (e-transfer, cheque)
    //             and marks the job paid. Nothing touches the wallet or the
    //             ledger, and the vendor is never asked to set up payouts.
    //   platform  Artrelo pays the vendor from the wallet via Stripe Connect.
    //
    // Direct is the default: a first customer should get the whole repair loop
    // without trusting a new company with money or asking their plumber to
    // onboard to Stripe. Platform is switched on per landlord by the operator
    // (scripts/payment_mode.js). Read it through services/ledger/paymentMode.js,
    // never directly: a .lean() read skips this default, and an absent value
    // must still mean "direct".
    //
    // Each Appointment takes a COPY at vendor acceptance, so changing this only
    // affects jobs booked afterwards and no job is ever split across rails.
    paymentMode: { type: String, enum: ["direct", "platform"], default: "direct" },

    // BANK TOP-UPS (Canadian pre-authorized debit). The Stripe Customer the
    // saved bank account and its mandate belong to: Artrelo charges on the
    // PLATFORM and transfers to vendors separately, so the platform owns the
    // mandate and no vendor ever needs one.
    stripeCustomerId: { type: String, default: null },
    // Sticky cutover marker: a feature-flag rollback must not resume charging
    // the wallet for jobs already assessed by monthly billing.
    serviceBillingEnabledAt: { type: Date },
    bankDebit: {
      transactionType: { type: String, enum: ["personal", "business"] },
      // Written by the webhook once Stripe has the account and the mandate --
      // never from a request body. Present = "pay from bank ••6789" in one click.
      paymentMethodId: { type: String },
      mandateId: { type: String },
      last4: { type: String },
      institution: { type: String },
      savedAt: { type: Date },
      // After a dispute, bank top-ups are refused until the operator lifts it
      // (scripts/bank_debit_admin.js). A PAD dispute cannot be contested, so
      // the only defence against a repeat is not to debit again.
      blockedAt: { type: Date },
      blockedReason: { type: String },
    },

    // Last day the landlord DID something -- signed in, refreshed a session, or
    // made an audited decision. lastLogin only moves on a password sign-in, so
    // it understates anyone who stays signed in. See services/metrics/activity.
    lastActiveAt: { type: Date },
  },
  { timestamps: true }
);

LandlordSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Landlord", LandlordSchema);
