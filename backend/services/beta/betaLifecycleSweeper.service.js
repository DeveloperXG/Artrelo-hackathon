// Walks every landlord's free beta toward its end: reminder emails at 30, 14
// and 3 days out, then flips the status when the date passes.
//
// Same shape as archiveSweeper: a pure decision function, a batch function, a
// start function that runs once immediately and then hourly. All three are
// safe to run on two instances at once -- see the claim below.
//
// WHAT "ENDING" DOES, AND DOES NOT. It sets beta.status = "ended". Nothing is
// locked: there is no billing yet, and the agreement tells landlords exactly
// that. The only effect anywhere is that the service-fee waiver stops, and that
// is decided by the date (beta.service.isBetaActive), not by this flag -- the
// flag lags this sweeper by up to an hour.

const env = require("../../config/env");
const Landlord = require("../../models/Landlord");
const { REMINDER_DAYS_BEFORE_END, CHARGE_NOTICE_DAYS, currentAgreement } = require("../../config/beta");
const { DAY_MS, buildBetaView, betaDaysLeft } = require("./beta.service");
const { notifyUser } = require("../notification/notify.service");
const { buildBetaReminderEmail } = require("../notification/templates/betaReminderEmail");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 200;

const reminderKey = (days) => `${days}d`;

/**
 * Which reminder, if any, a landlord is due, and which marks to retire.
 *
 * PURE. Three rules, each from a way this could embarrass us:
 *
 *   * A mark is only EVER sent if the beta was long enough to contain it. A
 *     14-day beta has no "30 days left" moment; without this a landlord would
 *     get a "your beta ends in 30 days" email on the day they joined it.
 *   * Several marks can be due at once (the sweeper was down, or the operator
 *     shortened the beta). Only the MOST URGENT is sent, but every due mark is
 *     retired, so the older ones do not fire on the next sweep and bury the
 *     landlord in three emails over three hours.
 *   * Nothing is sent after the end. The status flip handles that case.
 */
function dueReminder(landlord, now = new Date()) {
  const beta = landlord?.beta;
  if (!beta?.endsAt || !beta?.startedAt || beta.status === "ended") return { send: null, claim: [] };

  const endsAt = new Date(beta.endsAt);
  const length = endsAt - new Date(beta.startedAt);
  if (now >= endsAt) return { send: null, claim: [] };

  const alreadySent = new Set(beta.remindersSent || []);
  const due = REMINDER_DAYS_BEFORE_END.filter(
    (days) =>
      length > (days + 1) * DAY_MS &&
      now.getTime() >= endsAt.getTime() - days * DAY_MS &&
      !alreadySent.has(reminderKey(days))
  );
  if (!due.length) return { send: null, claim: [] };

  return { send: Math.min(...due), claim: due.map(reminderKey) };
}

/**
 * Where the button in the email goes. Only someone with the offer still open is
 * sent to it; a founding landlord or a decliner just goes to the dashboard,
 * because a link that reopens an offer they already answered reads as a nag.
 */
function reminderUrl(offer) {
  const base = String(env.app_public_url || "http://localhost:3000").replace(/\/+$/, "");
  return offer === "pending" ? `${base}/dashboard?founding=1` : `${base}/dashboard`;
}

async function sendReminders({ now = new Date(), model = Landlord, loadHighlights = null } = {}) {
  const windowEnd = new Date(now.getTime() + (Math.max(...REMINDER_DAYS_BEFORE_END) + 1) * DAY_MS);
  const candidates = await model
    .find({ "beta.status": "active", "beta.endsAt": { $gt: now, $lte: windowEnd } })
    .select("email firstName beta foundingAgreement")
    .limit(BATCH_LIMIT)
    .lean();

  const agreement = currentAgreement();
  let sent = 0;

  for (const landlord of candidates) {
    const { send, claim } = dueReminder(landlord, now);
    if (send === null) continue;

    // CLAIM BEFORE SENDING. The conditional $addToSet lets exactly one sweeper
    // win; a second instance finds the key already there and gets null. This is
    // the whole defence against a double email -- the read above is only a hint.
    const won = await model.findOneAndUpdate(
      { _id: landlord._id, "beta.remindersSent": { $ne: reminderKey(send) } },
      { $addToSet: { "beta.remindersSent": { $each: claim } } },
      { new: false }
    );
    if (!won) continue;

    let highlights = null;
    if (loadHighlights) {
      // Best effort: the email is still worth sending without the numbers.
      highlights = await loadHighlights(landlord, now).catch((err) => {
        console.error("[betaSweeper] highlights failed", err?.message || err);
        return null;
      });
    }

    const view = buildBetaView(landlord, { now, agreement });
    const url = reminderUrl(view.offer);
    const email = buildBetaReminderEmail({
      firstName: landlord.firstName,
      daysLeft: betaDaysLeft(landlord.beta, now),
      url,
      accepted: view.founding,
      declined: view.offer === "declined",
      highlights,
      chargeNoticeDays: CHARGE_NOTICE_DAYS,
    });

    // At most once, deliberately. If this fails the claim stays: a missed
    // reminder is recoverable (the operator can see who was not reached), while
    // releasing the claim would repeat the in-app notification every hour for
    // as long as the mail provider is down.
    const result = await notifyUser({
      userId: landlord._id,
      type: "beta_reminder",
      title: email.subject,
      message: `Your free beta ends in ${view.daysLeft} day${view.daysLeft === 1 ? "" : "s"}. Access doesn't switch off — only the service-fee waiver ends.`,
      metadata: { actionUrl: view.offer === "pending" ? "/dashboard?founding=1" : "/dashboard/wallet", priority: "normal" },
      email: landlord.email,
      emailSubject: email.subject,
      emailHtml: email.html,
      emailText: email.text,
      emailCategory: "beta_reminder",
    });
    if (result) sent += 1;
    else console.error(`[betaSweeper] reminder ${reminderKey(send)} for ${landlord.email} was claimed but not delivered`);
  }

  if (sent) console.log(`[betaSweeper] sent ${sent} beta reminder(s)`);
  return sent;
}

/** Flip landlords whose date has passed. A guarded updateMany: re-running is a no-op. */
async function endLapsedBetas({ now = new Date(), model = Landlord } = {}) {
  const result = await model.updateMany(
    { "beta.status": "active", "beta.endsAt": { $lte: now } },
    { $set: { "beta.status": "ended" } }
  );
  const count = result?.modifiedCount || 0;
  if (count) console.log(`[betaSweeper] ended ${count} beta(s)`);
  return count;
}

async function runBetaSweep(options = {}) {
  // Reminders first, then the flip, so a landlord whose end date passes while
  // the sweeper is mid-run is not both reminded and ended in the wrong order.
  const reminded = await sendReminders(options);
  const ended = await endLapsedBetas(options);
  return { reminded, ended };
}

function startBetaSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  // Required lazily: the highlights loader pulls in six models, and requiring
  // it at module load would drag them into every test that only wants the pure
  // decision above.
  const { loadHighlights } = require("../../controllers/beta.controller");
  const run = () => {
    runBetaSweep({ loadHighlights }).catch((err) => console.error("[betaSweeper] run failed", err));
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { dueReminder, sendReminders, endLapsedBetas, runBetaSweep, startBetaSweeper, reminderKey };
