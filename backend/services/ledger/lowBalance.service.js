// The landlord's low-funds warning (LandlordPolicy.lowFundsThreshold).
//
// It used to run only after a job's payout, reach only the notification bell,
// and say nothing to a landlord who was already under the threshold. The
// balance actually drops earlier -- when a vendor is booked and the job's
// amount is held -- and that is when a warning buys days instead of minutes.
// So it now also runs after a hold, it is emailed as well, and the Wallet
// shows the current state on every visit.

const LandlordLedger = require("../../models/LandlordLedger");
const LandlordPolicy = require("../../models/LandlordPolicy");
const Landlord = require("../../models/Landlord");
const { notifyUser } = require("../notification/notify.service");
const { toCents, fromCents } = require("./money");

const WARN_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * The threshold in cents: the landlord's policy when set, else the ledger's
 * own default. Pure -- exported for tests.
 */
function resolveThresholdCents(policy, ledger) {
  const fromPolicy = policy?.lowFundsThreshold;
  if (fromPolicy !== undefined && fromPolicy !== null) return toCents(fromPolicy);
  return ledger?.lowBalanceThresholdCents ?? 0;
}

/**
 * Where a landlord's balance stands against their threshold, for the Wallet.
 * `availableCents` is passed in because the caller has just read the balance.
 */
async function getLowFundsStatus({ landlordId, availableCents }) {
  const [ledger, policy] = await Promise.all([
    LandlordLedger.findOne({ landlordId }).select("lowBalanceThresholdCents").lean(),
    LandlordPolicy.findOne({ landlordId }).select("lowFundsThreshold").lean(),
  ]);
  const thresholdCents = resolveThresholdCents(policy, ledger);
  return { threshold: fromCents(thresholdCents), below: availableCents < thresholdCents };
}

/**
 * Warn once (per day, per dip) when the available balance is below the
 * threshold: a notification in the bell and an email. A recovered balance
 * clears the dedupe so the next dip warns again. Callers treat it as
 * non-fatal; money has already moved by the time it runs.
 */
async function warnIfLowBalance({ landlordId }) {
  const [ledger, policy] = await Promise.all([
    LandlordLedger.findOne({ landlordId }),
    LandlordPolicy.findOne({ landlordId }).lean(),
  ]);
  if (!ledger) return { warned: false, reason: "no_ledger" };

  const thresholdCents = resolveThresholdCents(policy, ledger);
  if (ledger.available >= thresholdCents) {
    if (ledger.lowBalanceNotifiedAt) {
      await LandlordLedger.updateOne({ _id: ledger._id }, { $set: { lowBalanceNotifiedAt: null } });
    }
    return { warned: false, reason: "above_threshold" };
  }

  const lastWarned = ledger.lowBalanceNotifiedAt?.getTime() || 0;
  if (Date.now() - lastWarned < WARN_EVERY_MS) return { warned: false, reason: "recently_warned" };

  // Claim the warning before sending it, so two holds landing together send one.
  const claimed = await LandlordLedger.updateOne(
    { _id: ledger._id, lowBalanceNotifiedAt: ledger.lowBalanceNotifiedAt || null },
    { $set: { lowBalanceNotifiedAt: new Date() } }
  );
  if (claimed && claimed.modifiedCount === 0) return { warned: false, reason: "recently_warned" };

  const landlord = await Landlord.findById(landlordId).select("email").lean();
  const available = `${fromCents(ledger.available)} ${ledger.currency}`;
  const threshold = `${fromCents(thresholdCents)} ${ledger.currency}`;
  await notifyUser({
    userId: landlordId,
    type: "payment_overdue",
    title: "Maintenance balance is running low",
    message: `Your available balance is ${available}, below your low-funds threshold of ${threshold}. Top up so booked jobs can be paid when they're completed.`,
    metadata: { amount: fromCents(ledger.available), threshold: fromCents(thresholdCents) },
    email: landlord?.email || undefined,
    emailSubject: "Your Artrelo maintenance balance is running low",
  });
  return { warned: true };
}

module.exports = { getLowFundsStatus, resolveThresholdCents, warnIfLowBalance };
