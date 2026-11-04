// Applies Artrelo's service fee when a job is settled. The glue between the
// pure quote (serviceFee.js) and the one function that posts it
// (ledger.service.chargeServiceFee).
//
// Called from BOTH settlement paths -- closeJobCompletion and the landlord's
// manual "Mark complete" -- after the vendor's payout, inside their own
// non-fatal try/catch. A fee problem must never stop a vendor being paid, and
// the fee is the last money step of the close for exactly that reason.
//
// ONCE, AND THE SAME ONCE. Three layers, because each covers a gap the others
// leave:
//   1. A decision already recorded on the JobCompletion wins outright. This is
//      what stops a waived fee being charged on a replay after the beta ended:
//      a waived fee has no ledger entry, so the ledger alone cannot remember it.
//   2. The quote is taken at the moment the job CLOSED (`at`), not "now", so a
//      re-run computes the same answer even before (1) is written.
//   3. chargeServiceFee's own key, `fee:<settlementId>`, makes the money move
//      at most once whatever the layers above decide.
//
// A manual completion of a job the vendor never reported has no JobCompletion,
// so layer 1 is unavailable there: a charged fee is still exactly-once (layer
// 3), but a waived one leaves no record and a replay that straddles the beta's
// end date could charge it. That needs a double-submit landing on either side
// of a landlord's end date, so it is accepted rather than given its own store.

const JobCompletion = require("../../models/JobCompletion");
const Landlord = require("../../models/Landlord");
const { chargeServiceFee } = require("./ledger.service");
const { quoteServiceFee } = require("./serviceFee");
const { fromCents } = require("./money");

function describeRate({ flatCents, percent }) {
  const parts = [];
  if (flatCents > 0) parts.push(`$${fromCents(flatCents)}`);
  if (percent > 0) parts.push(`${percent}%`);
  return parts.join(" + ");
}

/**
 * @returns the recorded decision ({ listCents, chargedCents, owedCents,
 *   waivedReason, basis, rateSource, entryId, decidedAt }), or null when no
 *   fee is configured for this landlord -- in which case nothing is recorded
 *   or shown anywhere.
 */
async function applyServiceFee({
  landlordId,
  settlementId,
  payoutCents,
  completionId = null,
  requestId = null,
  appointmentId = null,
  scope = {},
  at = new Date(),
}) {
  if (!settlementId || !Number.isSafeInteger(payoutCents) || payoutCents <= 0) return null;

  /* 1. A recorded decision wins. */
  if (completionId) {
    const recorded = await JobCompletion.findById(completionId).select("ledger.serviceFee").lean();
    if (recorded?.ledger?.serviceFee) return { ...recorded.ledger.serviceFee, replayed: true };
  }

  /* 2. Decide, as of the close. */
  const landlord = await Landlord.findById(landlordId).select("beta foundingAgreement serviceBillingEnabledAt").lean();
  if (require("../../config/env").service_billing_enabled || landlord?.serviceBillingEnabledAt) {
    return require("../billing/feeAssessment.service").assessFee({ appointmentId, requestId, completionId, payoutCents, at });
  }
  const quote = quoteServiceFee({ landlord, payoutCents, at });

  /* 3. Move the money -- or, on a replay, learn what an earlier run moved.
   *    Called even when the quote says 0: chargeServiceFee checks its key
   *    FIRST, so an entry an earlier run posted is reported, never repeated. */
  const charge = await chargeServiceFee({
    landlordId,
    settlementId,
    amountCents: quote.chargeCents,
    requestId,
    appointmentId,
    completionId,
    scope,
    memo: `Artrelo service fee (${describeRate(quote.basis) || "no rate"})`,
  });

  // Nothing configured and nothing ever charged: no fee exists for this job.
  if (quote.listCents <= 0 && !charge.entry) return null;

  const record = {
    listCents: Math.max(quote.listCents, charge.feeCents),
    // Billed in full: whatever the wallet did not cover is owed, not forgiven.
    chargedCents: charge.feeCents,
    owedCents: charge.owedCents,
    waivedReason: charge.feeCents > 0 ? null : quote.waivedReason,
    basis: quote.basis,
    rateSource: quote.rateSource,
    entryId: charge.entry?._id || null,
    decidedAt: at,
  };

  // The money has moved. Housekeeping that must never undo it:
  await lockFoundingRate({ landlord, landlordId, quote, charged: charge.feeCents }).catch((err) =>
    console.error("[serviceFee] founding rate lock failed", err.message)
  );

  // Guarded on null so a second writer can never overwrite the first decision.
  if (completionId) {
    await JobCompletion.updateOne(
      { _id: completionId, "ledger.serviceFee": null },
      { $set: { "ledger.serviceFee": record } }
    );
  }

  if (record.owedCents > 0) {
    console.warn(
      `[serviceFee] ${settlementId}: fee ${record.chargedCents} cents, ${record.owedCents} owed ` +
        "(the balance did not cover it; the next top-up pays it)"
    );
  }

  return record;
}

/**
 * Freeze a founding rate that was still floating.
 *
 * A landlord who accepted the founding offer BEFORE any rate existed holds a
 * 0/0 snapshot, which means "you will get today's founding rate, told in
 * advance". Left like that the rate is read from configuration on every job --
 * so changing the setting later would change what they pay, and "fixed" would
 * be a word rather than a fact. The first time a fee is really charged at that
 * rate (never in the beta, when it is waived) the rate is written onto their
 * agreement, and from then on they are `founding_locked`.
 *
 * Guarded on the snapshot still being zero, so two jobs closing together freeze
 * it once and the first rate wins. Also warns when a founding landlord is being
 * charged the LIST rate because no founding rate was ever set -- almost
 * certainly a deploy setting forgotten, and worth seeing in the logs.
 */
async function lockFoundingRate({ landlord, landlordId, quote, charged }) {
  const isFounding = Boolean(landlord?.foundingAgreement?.acceptedAt);
  if (!isFounding || charged <= 0) return;

  if (quote.rateSource === "list" && quote.listCents > 0) {
    console.warn(
      `[serviceFee] founding landlord ${landlordId} is being charged the LIST rate: no founding rate is set ` +
        "(SERVICE_FEE_FOUNDING_CENTS / SERVICE_FEE_FOUNDING_PERCENT)"
    );
    return;
  }
  if (quote.rateSource !== "founding") return;

  await Landlord.updateOne(
    {
      _id: landlordId,
      "foundingAgreement.acceptedAt": { $exists: true },
      "foundingAgreement.terms.serviceFee.flatCents": { $not: { $gt: 0 } },
      "foundingAgreement.terms.serviceFee.percent": { $not: { $gt: 0 } },
    },
    {
      $set: {
        "foundingAgreement.terms.serviceFee": { flatCents: quote.basis.flatCents, percent: quote.basis.percent },
        "foundingAgreement.feeLockedAt": new Date(),
      },
    }
  );
}

module.exports = { applyServiceFee, describeRate, lockFoundingRate };
