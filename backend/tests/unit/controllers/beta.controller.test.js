// A landlord's founding agreement: accepting, declining, and the email.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * only the CURRENT version can be accepted -- a stale dialog is told, not
//     silently bound to terms it never read;
//   * the snapshot stored is the numbers AS OFFERED, from the server's
//     agreement, never from the request body;
//   * FOUNDING IS PERMANENT: someone who accepted an older offer is a no-op on a
//     repeat (their locked terms are never overwritten by today's), and keeps the
//     ORIGINAL timestamp;
//   * the welcome email goes out exactly once per acceptance: not on a repeat,
//     not on a lost race, and a failing mailer never turns a recorded acceptance
//     into an error;
//   * declining is explicit, idempotent, refused once accepted, and reversible --
//     accepting afterwards simply replaces it;
//   * the proof numbers are opt-in, and a failing metrics query does not make the
//     agreement unreadable;
//   * a landlord can only ever read or sign for themselves.

const assert = require("assert");

const env = require("../../../config/env");
const Landlord = require("../../../models/Landlord");
const AgentActionLog = require("../../../models/AgentActionLog");

// Captured BEFORE the controller is required: it destructures sendEmail.
const emailService = require("../../../services/notification/email.service");
let sentEmails = [];
let mailerThrows = false;
emailService.sendEmail = async (message) => {
  if (mailerThrows) throw new Error("mail provider down");
  sentEmails.push(message);
  return { stub: true, delivered: false };
};

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

let store;
let writes;
let logged;
// Runs once, just before the next guarded write -- another request landing
// between this one's read and its update.
let interfere = null;

const selectLean = (row) => ({ select: () => ({ lean: async () => (row ? JSON.parse(JSON.stringify(row)) : null) }) });
Landlord.findById = (id) => selectLean(String(id) === String(store._id) ? store : null);

// Honours the two guards the controller sends: "not yet accepted" (and, for a
// decline, "not yet declined"), and applies $set the way Mongo does -- a whole
// subdocument replaces, a dotted path sets one field.
Landlord.updateOne = async (filter, update) => {
  const acceptedGuard = filter["foundingAgreement.acceptedAt"];
  if (!acceptedGuard) return { matchedCount: 0, modifiedCount: 0 }; // the activity tracker
  if (interfere) {
    const run = interfere;
    interfere = null;
    run();
  }
  const fa = store.foundingAgreement || {};
  if (acceptedGuard.$exists === false && fa.acceptedAt) return { matchedCount: 0, modifiedCount: 0 };
  if (filter["foundingAgreement.declinedAt"]?.$exists === false && fa.declinedAt) return { matchedCount: 0, modifiedCount: 0 };
  writes.push({ filter, update });
  for (const [key, value] of Object.entries(update.$set)) {
    if (key === "foundingAgreement") store.foundingAgreement = value;
    else if (key === "foundingAgreement.declinedAt") store.foundingAgreement = { ...fa, declinedAt: value };
  }
  return { matchedCount: 1, modifiedCount: 1 };
};
AgentActionLog.create = async (doc) => {
  logged.push(doc);
  return doc;
};

const ctrl = require("../../../controllers/beta.controller");
const { currentAgreement } = require("../../../config/beta");

function call(handler, { user = { id: "L1" }, body = {}, query = {}, ip = "203.0.113.9" } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload });
        return this;
      },
    };
    Promise.resolve(handler({ user, body, query, ip }, res)).catch(reject);
  });
}

const reset = () => {
  store = {
    _id: "L1",
    email: "dana@example.com",
    firstName: "Dana",
    createdAt: new Date(now - 10 * DAY),
    beta: { status: "active", startedAt: new Date(now - 10 * DAY), endsAt: new Date(now + 110 * DAY), remindersSent: [] },
  };
  writes = [];
  logged = [];
  sentEmails = [];
  mailerThrows = false;
  interfere = null;
};

async function main() {
  const saved = [env.service_fee_founding_cents, env.service_fee_founding_percent, env.founding_plan_discount_percent];
  env.service_fee_founding_cents = "400";
  env.service_fee_founding_percent = "1.5";
  env.founding_plan_discount_percent = "30";
  const agreement = currentAgreement();
  const origErr = console.error;

  try {
    /* -------- 1) Reading the status ----------------------------------- */
    reset();
    let res = await call(ctrl.getBeta);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.beta.phase, "quiet");
    assert.strictEqual(res.payload.beta.offer, "pending");
    assert.strictEqual(res.payload.beta.founding, false);
    assert.strictEqual(res.payload.beta.daysLeft, 110);
    assert.strictEqual(res.payload.beta.agreement.version, agreement.version);
    assert.strictEqual(res.payload.beta.highlights, undefined, "the cheap read carries no proof numbers");
    assert.strictEqual(res.payload.beta.ipHash, undefined);

    reset();
    delete store.beta;
    res = await call(ctrl.getBeta);
    assert.strictEqual(res.payload.beta.phase, "none", "a landlord with no beta is not an error");
    assert.strictEqual(res.payload.beta.offer, "none");

    reset();
    res = await call(ctrl.getBeta, { user: { id: "OTHER" } });
    assert.strictEqual(res.statusCode, 404, "someone else's id finds nothing");

    /* -------- 2) A stale version is refused --------------------------- */
    reset();
    res = await call(ctrl.postAgreement, { body: { version: "founding-2025-old" } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "agreement_changed");
    assert.strictEqual(res.payload.agreement.version, agreement.version, "and it hands back the current offer");
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(sentEmails.length, 0, "no email for a refusal");
    res = await call(ctrl.postAgreement, { body: {} });
    assert.strictEqual(res.statusCode, 409, "no version is not consent either");

    // An account with no beta has no offer to accept.
    reset();
    delete store.beta;
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "no_offer");

    /* -------- 3) Accepting records the SERVER's snapshot ----------------- */
    reset();
    res = await call(ctrl.postAgreement, {
      // A hostile body tries to write its own terms.
      body: { version: agreement.version, terms: { serviceFee: { flatCents: 0, percent: 0 }, planDiscountPercent: 99 } },
    });
    assert.strictEqual(res.statusCode, 201, JSON.stringify(res.payload));
    assert.strictEqual(res.payload.beta.phase, "accepted");
    assert.strictEqual(res.payload.beta.founding, true);
    assert.strictEqual(res.payload.beta.offer, "accepted");
    assert.strictEqual(store.foundingAgreement.version, agreement.version);
    assert.deepStrictEqual(store.foundingAgreement.terms, {
      serviceFee: { flatCents: 400, percent: 1.5 },
      planDiscountPercent: 30,
    });
    assert.ok(store.foundingAgreement.ipHash && store.foundingAgreement.ipHash !== "203.0.113.9", "the IP is hashed, never stored");
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].actionType, "founding_agreement_accepted");
    assert.strictEqual(logged[0].actor, "landlord");

    /* -------- 3b) THE WELCOME EMAIL ------------------------------------- */
    assert.strictEqual(sentEmails.length, 1, "exactly one email for a first acceptance");
    const mail = sentEmails[0];
    assert.strictEqual(mail.to, "dana@example.com");
    assert.deepStrictEqual(mail.categories, ["founding_welcome"]);
    assert.ok(/founding/i.test(mail.subject));
    assert.ok(mail.text.includes("$4.00 per completed job plus 1.5% of the job payout"), "the SNAPSHOT terms, not the body's");
    assert.ok(mail.text.includes("30% off any Artrelo plan"));
    assert.ok(!mail.text.includes("99%"), "a hostile body cannot reach the email either");
    assert.ok(!/founding-2026/.test(mail.text + mail.html), "the internal version hash never appears");

    /* -------- 4) A repeat is a no-op: same timestamp, no second email ------ */
    const firstAt = store.foundingAgreement.acceptedAt;
    await new Promise((r) => setTimeout(r, 5));
    const writesBefore = writes.length;
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes.length, writesBefore, "no second write");
    assert.strictEqual(String(store.foundingAgreement.acceptedAt), String(firstAt), "the original timestamp survives");
    assert.strictEqual(logged.length, 1, "and it is not audited twice");
    assert.strictEqual(sentEmails.length, 1, "nor emailed twice");

    // The offer's numbers move on. A founding landlord's locked snapshot does not.
    env.service_fee_founding_cents = "999";
    const moved = currentAgreement();
    assert.notStrictEqual(moved.version, agreement.version);
    res = await call(ctrl.postAgreement, { body: { version: moved.version } });
    assert.strictEqual(res.statusCode, 200, "a stale client cannot re-accept an already-founding landlord");
    assert.strictEqual(store.foundingAgreement.terms.serviceFee.flatCents, 400, "their LOCKED terms are never overwritten");
    assert.strictEqual(res.payload.beta.founding, true);
    assert.strictEqual(res.payload.beta.phase, "accepted", "and the offer change does not un-found them or re-ask");
    assert.strictEqual(sentEmails.length, 1);
    env.service_fee_founding_cents = "400";

    /* -------- 5) A lost race sends nothing --------------------------------- */
    reset();
    interfere = () => {
      // Another request accepts between this one's read and its write.
      store.foundingAgreement = { version: agreement.version, acceptedAt: new Date(now - 1000), terms: agreement.terms };
    };
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    assert.strictEqual(res.statusCode, 200, "the loser is told where things stand");
    assert.strictEqual(res.payload.beta.founding, true);
    assert.strictEqual(sentEmails.length, 0, "the winner sends the email, not the loser");
    assert.strictEqual(logged.length, 0, "and writes the audit row");

    /* -------- 6) A failing mailer never fails the acceptance --------------- */
    reset();
    mailerThrows = true;
    console.error = () => {};
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    console.error = origErr;
    assert.strictEqual(res.statusCode, 201, "a mail failure must not turn a recorded acceptance into an error");
    assert.strictEqual(res.payload.beta.founding, true);
    assert.ok(store.foundingAgreement.acceptedAt, "the acceptance stands");

    // No address on file: nothing to send to, nothing thrown.
    reset();
    delete store.email;
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(sentEmails.length, 0);

    /* -------- 7) Declining ------------------------------------------------- */
    reset();
    res = await call(ctrl.postDecline);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
    assert.strictEqual(res.payload.beta.offer, "declined");
    assert.strictEqual(res.payload.beta.phase, "declined");
    assert.strictEqual(res.payload.beta.founding, false);
    assert.ok(store.foundingAgreement.declinedAt);
    assert.strictEqual(store.foundingAgreement.acceptedAt, undefined);
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].actionType, "founding_agreement_declined");
    assert.strictEqual(sentEmails.length, 0, "declining sends no email");

    // Idempotent, and it keeps the ORIGINAL decline time.
    const declinedAt = store.foundingAgreement.declinedAt;
    await new Promise((r) => setTimeout(r, 5));
    const w = writes.length;
    res = await call(ctrl.postDecline);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(writes.length, w, "no second write");
    assert.strictEqual(String(store.foundingAgreement.declinedAt), String(declinedAt));
    assert.strictEqual(logged.length, 1, "not audited twice");

    /* -------- 8) Changing their mind: accepting replaces the decline ------- */
    res = await call(ctrl.postAgreement, { body: { version: agreement.version } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.payload.beta.founding, true);
    assert.strictEqual(store.foundingAgreement.declinedAt, undefined, "the decline is gone: accepted, not 'declined and accepted'");
    assert.ok(store.foundingAgreement.acceptedAt);
    assert.strictEqual(sentEmails.length, 1, "a real acceptance gets its welcome email");

    /* -------- 9) A founding landlord cannot decline ----------------------- */
    res = await call(ctrl.postDecline);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "already_accepted");
    assert.ok(store.foundingAgreement.acceptedAt, "locked terms are never quietly given up");

    // A decline that loses the race to an acceptance does not land on top of it.
    reset();
    interfere = () => {
      store.foundingAgreement = { version: agreement.version, acceptedAt: new Date(now - 1000), terms: agreement.terms };
    };
    res = await call(ctrl.postDecline);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "already_accepted");
    assert.strictEqual(store.foundingAgreement.declinedAt, undefined);

    // No beta, no offer to decline.
    reset();
    delete store.beta;
    res = await call(ctrl.postDecline);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, "no_offer");

    // Someone else's id finds nothing.
    reset();
    res = await call(ctrl.postDecline, { user: { id: "OTHER" } });
    assert.strictEqual(res.statusCode, 404);

    /* -------- 10) Highlights are opt-in and best-effort ------------------ */
    reset();
    const betaReport = require("../../../services/metrics/betaMetrics.service");
    const origBuild = betaReport.buildBetaReport;
    betaReport.buildBetaReport = async () => {
      throw new Error("mongo down");
    };
    console.error = () => {};
    res = await call(ctrl.getBeta, { query: { highlights: "1" } });
    console.error = origErr;
    betaReport.buildBetaReport = origBuild;
    assert.strictEqual(res.statusCode, 200, "a failing metrics query does not break the agreement");
    assert.strictEqual(res.payload.beta.highlights, null);
    assert.ok(res.payload.beta.agreement.sections.length > 0);
  } finally {
    console.error = origErr;
    [env.service_fee_founding_cents, env.service_fee_founding_percent, env.founding_plan_discount_percent] = saved;
  }

  console.log("beta.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
