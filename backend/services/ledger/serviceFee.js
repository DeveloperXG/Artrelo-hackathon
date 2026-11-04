// What Artrelo's service fee on one completed job IS. Pure: no models, no I/O.
//
// Deciding the fee and moving the money are separate on purpose. This file
// answers "how much, and is it waived"; ledger.service.chargeServiceFee is the
// only thing that ever posts it, and serviceFee.service wires the two together
// at the close.
//
// THE FEE IS A FLAT AMOUNT PLUS AN OPTIONAL PERCENTAGE of the job's payout.
// Flat because Artrelo's real costs are largely per vendor, not per dollar --
// Stripe's Connect account fee is $2 per vendor per month -- so a
// percentage-only fee loses money on small or infrequent jobs. Both parts
// default to 0, and with both at 0 there is no fee at all.
//
// WHICH RATE APPLIES, in order:
//
//   1. A founding landlord's LOCKED rate -- the numbers snapshotted onto their
//      agreement when they accepted it. Never re-read from the environment:
//      that is the whole point of "locked".
//   2. A founding landlord whose snapshot is 0/0. They accepted before any
//      rate was chosen, and the agreement told them they would be "told the
//      exact fee in advance". A 0 snapshot therefore means "not set yet", NOT
//      "free forever" -- they get today's founding rate.
//   3. Everyone else: the list rate.
//   (If the founding rate itself is unset, (2) falls through to the list rate.)
//
// WAIVED WHILE THE BETA RUNS. Decided by the beta's DATE (isBetaActive), never
// by beta.status, which lags the sweeper by up to an hour -- and it is decided
// at the moment the job CLOSED (`at`), so a replay after the end date cannot
// charge a fee the first run waived.

const env = require("../../config/env");
const { foundingTerms, toWholeNumber, toPercent, MAX_FEE_PERCENT, describeFee } = require("../../config/beta");
const { isBetaActive } = require("../beta/beta.service");

/** The list rate, from the environment. */
function listTerms() {
  return {
    flatCents: toWholeNumber(env.service_fee_cents, 0),
    percent: toPercent(env.service_fee_percent, MAX_FEE_PERCENT),
  };
}

const isZeroRate = (rate) => !rate || ((Number(rate.flatCents) || 0) <= 0 && (Number(rate.percent) || 0) <= 0);

/** Which rate this landlord pays, and why. */
function resolveRate(landlord) {
  const founding = landlord?.foundingAgreement;
  if (founding?.acceptedAt) {
    const locked = founding.terms?.serviceFee;
    if (!isZeroRate(locked)) {
      return { rate: { flatCents: Number(locked.flatCents) || 0, percent: Number(locked.percent) || 0 }, source: "founding_locked" };
    }
    const current = foundingTerms().serviceFee;
    if (!isZeroRate(current)) return { rate: current, source: "founding" };
  }
  return { rate: listTerms(), source: "list" };
}

/**
 * The fee on one job. Never more than the job itself: a $5 flat fee on a $3
 * job would charge the landlord more for the coordination than for the repair.
 */
function feeFor(rate, payoutCents) {
  if (!Number.isSafeInteger(payoutCents) || payoutCents <= 0) return 0;
  const flat = Number(rate?.flatCents) || 0;
  const percent = Number(rate?.percent) || 0;
  return Math.min(payoutCents, flat + Math.round((payoutCents * percent) / 100));
}

/**
 * @returns {{ listCents, chargeCents, waivedReason, basis, rateSource }}
 *   listCents    the fee at this landlord's rate, before any waiver
 *   chargeCents  what to actually take (0 when waived)
 *   waivedReason "beta" | null
 */
function quoteServiceFee({ landlord, payoutCents, at = new Date() }) {
  const { rate, source } = resolveRate(landlord);
  const listCents = feeFor(rate, payoutCents);
  const waived = listCents > 0 && isBetaActive(landlord?.beta, at);
  return {
    listCents,
    chargeCents: waived ? 0 : listCents,
    waivedReason: waived ? "beta" : null,
    basis: { flatCents: rate.flatCents, percent: rate.percent },
    rateSource: source,
  };
}

/**
 * The one line the Wallet shows about the service fee, for any landlord. Pure.
 *
 * It always names the rate that would ACTUALLY be charged (resolveRate), so the
 * line and the money can never disagree:
 *
 *   waived    the beta is running (by date, as the fee itself decides). `rate`
 *             is what applies after the end date, so the end is never a surprise.
 *             A founding landlord with no founding rate set yet gets rate null
 *             ("confirmed before then") rather than the LIST rate, which is not
 *             a founding fee -- quoting it would alarm them about a fee they
 *             will not be charged once the rate is set.
 *   founding  founding landlord, beta over, charged a founding rate.
 *   list      everyone else -- including a founding landlord whose founding
 *             rate was never set (the truthful label; that case also logs a
 *             warning at charge time).
 *
 * null when there is nothing true to say: no fee configured and nothing waived.
 */
function buildServiceFeeLine(landlord, now = new Date()) {
  const { rate, source } = resolveRate(landlord);
  const hasRate = !isZeroRate(rate);
  const founding = Boolean(landlord?.foundingAgreement?.acceptedAt);
  const foundingRate = source === "founding" || source === "founding_locked";
  const described = hasRate ? { description: describeFee(rate) } : null;

  if (isBetaActive(landlord?.beta, now)) {
    return {
      kind: "waived",
      rate: founding && !foundingRate ? null : described,
      waivedUntil: landlord.beta.endsAt,
      founding,
      foundingRate,
      locked: source === "founding_locked",
    };
  }

  if (!hasRate) return null;
  if (founding && foundingRate) {
    return { kind: "founding", rate: described, waivedUntil: null, founding, foundingRate, locked: source === "founding_locked" };
  }
  return { kind: "list", rate: described, waivedUntil: null, founding, foundingRate: false, locked: false };
}

module.exports = { listTerms, resolveRate, feeFor, quoteServiceFee, isZeroRate, buildServiceFeeLine };
