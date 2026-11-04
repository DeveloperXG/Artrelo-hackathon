// The beta lifecycle: reminders at 30/14/3 days, each at most once, then the end.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * a beta too short to contain a mark never gets that mark's email (no "30
//     days left" on the day a 14-day beta begins);
//   * when several marks are due at once only the most urgent is SENT, but all
//     are retired -- the landlord gets one email, not three over three hours;
//   * a second sweeper racing the first sends nothing: the claim is atomic;
//   * the banner's phase follows the date and the accepted VERSION;
//   * the end flips status only for betas whose date has passed.

const assert = require("assert");

// Stub the two I/O edges BEFORE the sweeper (and notify.service) are required:
// notify.service destructures sendEmail at load.
const emailService = require("../../../services/notification/email.service");
const sentEmails = [];
emailService.sendEmail = async (msg) => {
  sentEmails.push(msg);
  return { ok: true };
};
const { Notification } = require("../../../models/Notification");
const inApp = [];
Notification.create = async (doc) => {
  inApp.push(doc);
  return doc;
};

const sweeper = require("../../../services/beta/betaLifecycleSweeper.service");
const { buildBetaView } = require("../../../services/beta/beta.service");
const { currentAgreement, REMINDER_DAYS_BEFORE_END } = require("../../../config/beta");
const { buildBetaReminderEmail } = require("../../../services/notification/templates/betaReminderEmail");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-09T12:00:00.000Z");
const daysFromNow = (n) => new Date(NOW.getTime() + n * DAY);

const mk = (over = {}) => ({
  _id: over._id || "L1",
  email: "dana@example.com",
  firstName: "Dana",
  beta: {
    status: "active",
    startedAt: daysFromNow(-100),
    endsAt: daysFromNow(20),
    remindersSent: [],
    ...(over.beta || {}),
  },
  ...(over.rest || {}),
});

// A minimal in-memory Landlord collection honouring only the operators the
// sweeper sends.
function makeModel(rows) {
  const model = {
    find: () => ({
      select: () => ({ limit: () => ({ lean: async () => rows.filter((r) => r.beta?.status === "active" && r.beta.endsAt > NOW) }) }),
    }),
    findOneAndUpdate: async (filter, update) => {
      const row = rows.find((r) => r._id === filter._id);
      if (!row) return null;
      const sent = row.beta.remindersSent || [];
      if (sent.includes(filter["beta.remindersSent"].$ne)) return null; // someone else got there first
      row.beta.remindersSent = [...new Set([...sent, ...update.$addToSet["beta.remindersSent"].$each])];
      return { ...row };
    },
    updateMany: async (filter, update) => {
      let n = 0;
      for (const r of rows) {
        if (r.beta?.status === "active" && r.beta.endsAt <= filter["beta.endsAt"].$lte) {
          Object.assign(r.beta, { status: update.$set["beta.status"] });
          n += 1;
        }
      }
      return { modifiedCount: n };
    },
  };
  return model;
}

async function main() {
  assert.deepStrictEqual(REMINDER_DAYS_BEFORE_END, [30, 14, 3]);

  /* -------- 1) dueReminder: the marks ----------------------------------- */
  // 20 days left, 100 days in: the 30d mark has passed, 14d not yet.
  let r = sweeper.dueReminder(mk(), NOW);
  assert.deepStrictEqual(r, { send: 30, claim: ["30d"] });

  r = sweeper.dueReminder(mk({ beta: { endsAt: daysFromNow(14) } }), NOW);
  assert.strictEqual(r.send, 14, "exactly 14 days out is due");
  r = sweeper.dueReminder(mk({ beta: { endsAt: daysFromNow(14.01) } }), NOW);
  assert.strictEqual(r.send, 30, "just before the 14d mark it is still the 30d one");
  r = sweeper.dueReminder(mk({ beta: { endsAt: daysFromNow(60) } }), NOW);
  assert.strictEqual(r.send, null, "nothing is due 60 days out");

  /* -------- 2) Already sent --------------------------------------------- */
  r = sweeper.dueReminder(mk({ beta: { remindersSent: ["30d"] } }), NOW);
  assert.strictEqual(r.send, null, "30d already went");

  /* -------- 3) Several due at once: send the most urgent, retire all ---- */
  r = sweeper.dueReminder(mk({ beta: { endsAt: daysFromNow(2) } }), NOW);
  assert.strictEqual(r.send, 3);
  assert.deepStrictEqual(r.claim.sort(), ["14d", "30d", "3d"], "the older marks are retired so they never fire late");

  /* -------- 4) A beta too short for a mark never gets it ---------------- */
  const short = (len, left) =>
    mk({ beta: { startedAt: daysFromNow(left - len), endsAt: daysFromNow(left) } });
  assert.strictEqual(sweeper.dueReminder(short(14, 14), NOW).send, null, "a 14-day beta has no 14d moment on day 0");
  assert.strictEqual(sweeper.dueReminder(short(14, 3), NOW).send, 3, "but it does get the 3d one");
  assert.deepStrictEqual(sweeper.dueReminder(short(14, 3), NOW).claim, ["3d"], "30d/14d never fit, so they are not even claimed");
  assert.strictEqual(sweeper.dueReminder(short(30, 30), NOW).send, null, "a 30-day beta skips the 30d mark");

  /* -------- 5) Ended / absent betas ------------------------------------- */
  assert.strictEqual(sweeper.dueReminder(mk({ beta: { endsAt: daysFromNow(-1) } }), NOW).send, null, "nothing after the end");
  assert.strictEqual(sweeper.dueReminder(mk({ beta: { status: "ended", endsAt: daysFromNow(2) } }), NOW).send, null);
  assert.strictEqual(sweeper.dueReminder({ _id: "x" }, NOW).send, null, "no beta -> nothing");

  /* -------- 6) sendReminders: sends once, the second pass sends none ---- */
  const rows = [mk(), mk({ _id: "L2", beta: { endsAt: daysFromNow(60) } })];
  const model = makeModel(rows);
  let sent = await sweeper.sendReminders({ now: NOW, model, loadHighlights: async () => ({ requests: 12, bookedRequests: 10, medianMinutesToBook: 45, autopilotRequests: 6 }) });
  assert.strictEqual(sent, 1, "only L1 is due");
  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to, "dana@example.com");
  assert.ok(/ends in 20 days/.test(sentEmails[0].subject), sentEmails[0].subject);
  assert.ok(sentEmails[0].text.includes("12 maintenance requests handled"));
  assert.ok(sentEmails[0].text.includes("/dashboard?founding=1"), "the button opens the offer");
  assert.strictEqual(inApp.length, 1);
  assert.strictEqual(inApp[0].type, "beta_reminder");
  assert.deepStrictEqual(rows[0].beta.remindersSent, ["30d"]);

  sent = await sweeper.sendReminders({ now: NOW, model });
  assert.strictEqual(sent, 0, "a second sweep sends nothing");
  assert.strictEqual(sentEmails.length, 1);

  // A second instance that read the same stale row loses the claim.
  const stale = mk({ _id: "L3" });
  const racing = makeModel([{ ...stale, beta: { ...stale.beta, remindersSent: ["30d"] } }]);
  // ...it sees the row as unsent (stale read) but the store already has the key:
  racing.find = () => ({ select: () => ({ limit: () => ({ lean: async () => [stale] }) }) });
  assert.strictEqual(await sweeper.sendReminders({ now: NOW, model: racing }), 0, "the atomic claim stops the duplicate");
  assert.strictEqual(sentEmails.length, 1);

  // A failing highlights loader does not stop the email.
  const rows2 = [mk({ _id: "L4" })];
  const origErr = console.error;
  console.error = () => {};
  sent = await sweeper.sendReminders({ now: NOW, model: makeModel(rows2), loadHighlights: async () => { throw new Error("boom"); } });
  console.error = origErr;
  assert.strictEqual(sent, 1, "the reminder goes out without the numbers");

  /* -------- 7) The end -------------------------------------------------- */
  const endRows = [mk({ _id: "E1", beta: { endsAt: daysFromNow(-1) } }), mk({ _id: "E2" })];
  const ended = await sweeper.endLapsedBetas({ now: NOW, model: makeModel(endRows) });
  assert.strictEqual(ended, 1);
  assert.strictEqual(endRows[0].beta.status, "ended");
  assert.strictEqual(endRows[1].beta.status, "active");

  /* -------- 8) The banner phase ----------------------------------------- */
  const agreement = currentAgreement();
  const phase = (landlord) => buildBetaView(landlord, { now: NOW, agreement }).phase;
  assert.strictEqual(phase({}), "none", "an account with no beta");
  assert.strictEqual(phase(mk({ beta: { endsAt: daysFromNow(90) } })), "quiet");
  assert.strictEqual(phase(mk({ beta: { endsAt: daysFromNow(30) } })), "prominent", "inside 30 days, un-accepted");
  assert.strictEqual(phase(mk({ beta: { endsAt: daysFromNow(-1) } })), "ended");
  const accepted = { foundingAgreement: { version: agreement.version, acceptedAt: NOW } };
  assert.strictEqual(phase(mk({ rest: accepted })), "accepted");
  // FOUNDING IS PERMANENT: an older acceptance still counts, and is not re-asked.
  const old = { foundingAgreement: { version: "founding-2025-old", acceptedAt: NOW } };
  assert.strictEqual(phase(mk({ rest: old, beta: { endsAt: daysFromNow(10) } })), "accepted", "an older version still counts");
  assert.strictEqual(buildBetaView(mk({ rest: old }), { now: NOW, agreement }).acceptedVersion, "founding-2025-old");
  assert.strictEqual(phase(mk({ rest: { foundingAgreement: { declinedAt: NOW } } })), "declined");

  /* -------- 9) The email says the true thing ---------------------------- */
  const mail = buildBetaReminderEmail({ firstName: "<b>Dana</b>", daysLeft: 3, url: "https://x/y", accepted: false, highlights: null });
  assert.ok(!mail.html.includes("<b>Dana</b>"), "the name is escaped");
  assert.ok(/does not switch off/.test(mail.text), "it says access continues");
  assert.ok(/ends in 3 days/.test(mail.subject));
  assert.ok(buildBetaReminderEmail({ daysLeft: 1, url: "u" }).subject.includes("tomorrow"));
  assert.ok(buildBetaReminderEmail({ daysLeft: 5, url: "u", accepted: true }).text.includes("locked in"));
  assert.ok(!/\bhandled\b/.test(buildBetaReminderEmail({ daysLeft: 5, url: "u", highlights: { requests: 0 } }).text), "a zero is not an argument");

  /* -------- 10) A decliner is not nagged, but is still warned ------------ */
  //
  // The reminders double as the notice that the service fee is about to start,
  // which every landlord is promised. So a decliner still gets them -- with no
  // offer button, and a link that does not reopen what they answered.
  sentEmails.length = 0;
  inApp.length = 0;
  const people = [
    mk({ _id: "P1", rest: { email: "pending@example.com" } }),
    mk({ _id: "P2", rest: { email: "accepted@example.com", foundingAgreement: { version: "v", acceptedAt: NOW } } }),
    mk({ _id: "P3", rest: { email: "declined@example.com", foundingAgreement: { declinedAt: NOW } } }),
  ];
  const sent3 = await sweeper.sendReminders({ now: NOW, model: makeModel(people) });
  assert.strictEqual(sent3, 3, "all three are due, decliner included");
  const mailTo = (to) => sentEmails.find((m) => m.to === to);

  assert.ok(/founding\?=1|founding=1/.test(mailTo("pending@example.com").text), "the open offer is linked");
  assert.ok(/Review the founding offer/.test(mailTo("pending@example.com").html));

  const decl = mailTo("declined@example.com");
  assert.ok(!/founding=1/.test(decl.text + decl.html), "a decliner's email does not link back to the offer");
  assert.ok(!/Review the founding offer/.test(decl.html), "and has no offer button");
  assert.ok(/does not switch off/.test(decl.text), "but still says the fee waiver ends");
  assert.ok(/chose not to take the founding/.test(decl.text), "it mentions the offer once, plainly");
  assert.ok(/Wallet page/.test(decl.text));

  const acc = mailTo("accepted@example.com");
  assert.ok(!/founding=1/.test(acc.text + acc.html), "a founding landlord is not sent to the offer either");
  assert.ok(/locked in/.test(acc.text));

  const target = (to) => inApp.find((n) => n.userId === people.find((p) => p.email === to)._id).metadata.actionUrl;
  assert.strictEqual(target("pending@example.com"), "/dashboard?founding=1");
  assert.strictEqual(target("declined@example.com"), "/dashboard/wallet");
  assert.strictEqual(target("accepted@example.com"), "/dashboard/wallet");

  console.log("betaLifecycleSweeper tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
