// The beta clock: when a landlord's free period started, when it ends, and
// whether it is still running.
//
// PURE. No models, no I/O -- the same functions answer for the signup stamp,
// the banner, the reminder sweeper and (later) the service fee, so the four can
// never disagree about whether a given landlord is in beta.
//
// "ACTIVE" IS ABOUT THE DATE, NOT THE STATUS FIELD. beta.status is flipped to
// "ended" by an hourly sweeper, so for up to an hour after endsAt it still says
// "active". Anything that decides money (the fee waiver) must ask isBetaActive,
// which compares endsAt to now, rather than trust a flag that lags.

const { MAX_BETA_DAYS, defaultBetaDays } = require("../../config/beta");

const DAY_MS = 24 * 60 * 60 * 1000;

/** A number of days, validated. `undefined`/null means "use the default". */
function resolveBetaDays(value) {
  if (value === undefined || value === null || value === "") return defaultBetaDays();
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_BETA_DAYS || !Number.isInteger(n)) {
    throw new Error(`beta days must be a whole number between 1 and ${MAX_BETA_DAYS} (got ${JSON.stringify(value)})`);
  }
  return n;
}

/** The subdocument written onto a new landlord. */
function buildBetaStamp(days, now = new Date()) {
  const n = resolveBetaDays(days);
  return {
    startedAt: now,
    endsAt: new Date(now.getTime() + n * DAY_MS),
    status: "active",
    remindersSent: [],
  };
}

function isBetaActive(beta, now = new Date()) {
  if (!beta?.endsAt) return false;
  return new Date(beta.endsAt) > now;
}

/** Whole days left, rounded UP so "ends in 3 hours" reads as 1, never 0. */
function betaDaysLeft(beta, now = new Date()) {
  if (!beta?.endsAt) return null;
  const ms = new Date(beta.endsAt) - now;
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * Push a beta's end date out by `days`.
 *
 * Extends from whichever is later, the current end or now: extending a beta
 * that already lapsed by a month gives `days` from today, not a date that is
 * still in the past. Reminders are cleared because the new window deserves its
 * own 30/14/3-day notices. A landlord with no beta at all gets one, started at
 * `createdAt` (when they actually joined) so retention is measured from there.
 */
function extendBeta(beta, days, { now = new Date(), createdAt = null } = {}) {
  const n = resolveBetaDays(days);
  const current = beta?.endsAt ? new Date(beta.endsAt) : null;
  const base = current && current > now ? current : now;
  return {
    startedAt: beta?.startedAt || createdAt || now,
    endsAt: new Date(base.getTime() + n * DAY_MS),
    status: "active",
    remindersSent: [],
    extendedAt: now,
  };
}

/** Pin the end date to a specific moment. A date in the past ends the beta. */
function setBetaEnd(beta, endsAt, { now = new Date(), createdAt = null } = {}) {
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) throw new Error(`not a date: ${endsAt}`);
  return {
    startedAt: beta?.startedAt || createdAt || now,
    endsAt: end,
    status: end > now ? "active" : "ended",
    remindersSent: [],
    extendedAt: now,
  };
}

// Inside this many days of the end, an un-accepted offer stops being a quiet
// link and becomes the loudest thing in the banner.
const PROMINENT_WITHIN_DAYS = 30;

/**
 * Is the founding offer still open: in a beta, and neither accepted nor
 * declined. Pure, and independent of the CURRENT agreement on purpose -- it is
 * about what the landlord did, not about which version is on offer.
 *
 * Open includes a beta that has already ended: an unclaimed offer can still be
 * claimed afterwards, so it stays open (and pinned) until they answer it.
 */
function isOfferOpen(landlord) {
  if (!landlord?.beta?.endsAt) return false;
  const founding = landlord.foundingAgreement;
  return !founding?.acceptedAt && !founding?.declinedAt;
}

/**
 * What the landlord's banner, sidebar label and agreement dialog render. Pure:
 * the caller hands in the landlord and the CURRENT agreement, so the same
 * function serves the API, the reminder email and the tests.
 *
 * FOUNDING IS PERMANENT. `founding` means "has accepted", whatever version, and
 * it does not lapse when the offer's numbers change. The version hash only
 * guards the accept call itself (a stale dialog is refused), never a status.
 * That is what "locked in" means: a rate set later cannot un-found anyone, and
 * a snapshot taken at 0/0 already promises today's founding rate with notice.
 *
 * `offer` is what they have done about it:
 *   accepted    founding landlord (at any version, in or after the beta)
 *   declined    said no, explicitly; can still change their mind
 *   pending     in a beta and has not answered
 *   none        not in a beta (an account that predates the program)
 *
 * `phase` is the one word the banner switches on:
 *   none        not in a beta
 *   ended       the beta is over (the banner then also reads `offer`)
 *   accepted    in beta, offer accepted
 *   declined    in beta, offer declined
 *   quiet       in beta, offer pending, plenty of time
 *   prominent   in beta, offer pending, the end is close
 */
function buildBetaView(landlord, { now = new Date(), agreement } = {}) {
  const beta = landlord?.beta;
  const founding = landlord?.foundingAgreement;
  const inBeta = Boolean(beta?.endsAt);
  const active = isBetaActive(beta, now);
  const daysLeft = inBeta ? betaDaysLeft(beta, now) : null;

  const isFounding = Boolean(founding?.acceptedAt);
  const declined = !isFounding && Boolean(founding?.declinedAt);

  let offer = "none";
  if (isFounding) offer = "accepted";
  else if (inBeta) offer = declined ? "declined" : "pending";

  let phase = "none";
  if (inBeta) {
    if (!active) phase = "ended";
    else if (isFounding) phase = "accepted";
    else if (declined) phase = "declined";
    else phase = daysLeft <= PROMINENT_WITHIN_DAYS ? "prominent" : "quiet";
  }

  return {
    inBeta,
    active,
    phase,
    startedAt: beta?.startedAt || null,
    endsAt: beta?.endsAt || null,
    daysLeft,
    agreement: agreement
      ? { version: agreement.version, sections: agreement.sections, terms: agreement.terms, chargeNoticeDays: agreement.chargeNoticeDays }
      : null,
    offer,
    founding: isFounding,
    foundingSince: founding?.acceptedAt || null,
    declinedAt: declined ? founding.declinedAt : null,
    // Kept for existing consumers: "accepted" no longer depends on the version.
    agreementAccepted: isFounding,
    acceptedVersion: founding?.version || null,
    acceptedAt: founding?.acceptedAt || null,
  };
}

module.exports = {
  DAY_MS,
  PROMINENT_WITHIN_DAYS,
  resolveBetaDays,
  buildBetaStamp,
  isBetaActive,
  betaDaysLeft,
  extendBeta,
  setBetaEnd,
  buildBetaView,
  isOfferOpen,
};
