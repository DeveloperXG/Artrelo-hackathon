// The terms a beta landlord signs up under, in one place.
//
// WHY THIS IS A SERVER FILE AND NOT FRONTEND COPY. Accepting the founding
// agreement stores a snapshot of exactly what was offered: the version, the
// fee terms, the discount. If the wording lived in the SPA it could drift from
// what the server recorded, and "what did this landlord actually agree to" is
// the one question a dispute turns on. The server owns the text, the page
// renders what it is sent, and the snapshot is taken from the same object.
//
// Changing the offer: bump AGREEMENT_VERSION. Landlords who accepted an older
// version keep their snapshot (that is the point of a locked rate) and are
// asked again, because acceptance is matched on version.

const crypto = require("crypto");
const env = require("./env");

// Bump when the sign-up Terms change. Stored on the landlord at acceptance.
const TERMS_VERSION = "2026-10-18";

// Bump when the founding offer's WORDING changes. The numbers need no bump: they
// are folded into the version that is actually compared and stored (see
// currentAgreement), so changing a rate is automatically a new version.
const AGREEMENT_VERSION = "founding-2026-10-v2";

const MAX_BETA_DAYS = 730;
// 60 days: long enough for a small landlord to see a few real requests go all
// the way through (maintenance is sporadic -- a handful of units can go a month
// with none), short enough that the free period -- and the vendor-payout fees
// Artrelo absorbs during it -- has a firm end. Shorten or lengthen one landlord
// with `invite_landlord.js --beta-days` or `beta_admin.js extend`.
const DEFAULT_BETA_DAYS = 60;
// How long before any charge begins a landlord is told. A constant rather than
// a setting: it is a promise made in the agreement text, so changing it is a
// new agreement version, not a config tweak.
const CHARGE_NOTICE_DAYS = 30;

// Reminder marks, in days before the beta ends. Order is the order they fire.
const REMINDER_DAYS_BEFORE_END = [30, 14, 3];

// A fee above this is a typo, not a price. Clamped rather than rejected so a
// bad deploy setting degrades to "too high" instead of "free".
const MAX_FEE_PERCENT = 20;

const toWholeNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
};

const toPercent = (value, max) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
};

/** Length of a beta when the inviter did not choose one. */
function defaultBetaDays() {
  const n = Number(env.beta_default_days);
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_BETA_DAYS ? n : DEFAULT_BETA_DAYS;
}

/**
 * The numbers a founding landlord is promised. Read at acceptance time and
 * SNAPSHOTTED onto the landlord, so a later change to the environment never
 * rewrites an agreement someone already accepted.
 *
 * Both fee figures default to 0: until a rate is chosen the agreement promises
 * "notice before any fee" rather than a number that does not exist yet.
 */
function foundingTerms() {
  return {
    serviceFee: {
      flatCents: toWholeNumber(env.service_fee_founding_cents, 0),
      percent: toPercent(env.service_fee_founding_percent, MAX_FEE_PERCENT),
    },
    planDiscountPercent: toPercent(env.founding_plan_discount_percent, 100),
  };
}

const money = (cents) => `$${(cents / 100).toFixed(2)}`;

function describeFee({ flatCents, percent }) {
  const parts = [];
  if (flatCents > 0) parts.push(`${money(flatCents)} per completed job`);
  if (percent > 0) parts.push(`${percent}% of the job payout`);
  return parts.join(" plus ");
}

/**
 * The agreement as the page renders it: a version, the numbers, and the prose.
 * `sections` is data so the dialog can lay it out without parsing a blob.
 */
function currentAgreement() {
  const terms = foundingTerms();
  const fee = describeFee(terms.serviceFee);

  const sections = [
    {
      heading: "Free while you test",
      body:
        "Artrelo is free for you for the length of your beta. Accepting this does not start any billing and does not commit you to buy anything.",
    },
    {
      heading: "What founding landlords get",
      body:
        terms.planDiscountPercent > 0
          ? `${terms.planDiscountPercent}% off any Artrelo plan, locked in at the price you are shown when plans launch.`
          : "A founding rate on any Artrelo plan, confirmed in writing before plans launch.",
    },
    {
      heading: "The service fee",
      body: fee
        ? `When the beta ends, a service fee of ${fee} applies to jobs completed through Artrelo. As a founding landlord this rate is locked in for you.`
        : "When the beta ends, a small service fee on jobs completed through Artrelo may apply. As a founding landlord you will be told the exact fee in advance and it will be locked in for you.",
    },
    {
      heading: "No surprise charges",
      body: `We will give you at least ${CHARGE_NOTICE_DAYS} days' notice before any charge begins, and you separately accept the exact pricing and authorize a billing card before paid bookings begin. You can stop using Artrelo at any time.`,
    },
    {
      heading: "When the beta ends",
      body:
        "Your account access does not switch off on the end date. New paid bookings require your pricing acceptance and billing card. Jobs booked during beta keep their fee waiver when completed later.",
    },
  ];

  // THE VERSION CARRIES THE NUMBERS. The wording is a constant but the rates
  // come from the environment, so a version string alone could stay the same
  // while the fee behind it changed -- and a landlord with the dialog open
  // would then accept "v1" at $4 and be recorded at $9.99. Hashing the terms
  // into the version closes that: any change to what is offered is a different
  // version, a stale dialog is refused (409), and anyone who accepted the old
  // numbers is asked again.
  const digest = crypto.createHash("sha256").update(JSON.stringify(terms)).digest("hex").slice(0, 8);
  return {
    version: `${AGREEMENT_VERSION}:${digest}`,
    terms,
    sections,
    chargeNoticeDays: CHARGE_NOTICE_DAYS,
  };
}

module.exports = {
  // The one description of a fee, used by the agreement text, the welcome email
  // and the wallet, so they can never word the same rate differently.
  describeFee,
  // Shared with services/ledger/serviceFee.js so the list rate and the founding
  // rate are parsed by the same rules and cannot disagree about "nonsense".
  toWholeNumber,
  toPercent,
  MAX_FEE_PERCENT,
  TERMS_VERSION,
  AGREEMENT_VERSION,
  MAX_BETA_DAYS,
  DEFAULT_BETA_DAYS,
  CHARGE_NOTICE_DAYS,
  REMINDER_DAYS_BEFORE_END,
  defaultBetaDays,
  foundingTerms,
  currentAgreement,
};
