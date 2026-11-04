// The founding offer cannot be cleared out of sight through the delete routes.
//
// The bell has no delete control, so nothing a landlord sees changes -- this
// closes the API route that would let a hand-built request remove the stored
// reminders while the offer is still open.
//
// THE RULES THIS FILE EXISTS TO PROTECT:
//   * while the offer is OPEN (in a beta, neither accepted nor declined), a
//     landlord cannot delete a beta_reminder: single delete is refused with a
//     code that says why, bulk delete keeps those rows and clears the rest;
//   * once they ACCEPT or DECLINE, the reminders are ordinary notifications and
//     delete normally;
//   * everything else is deletable all along, and a tenant is never affected;
//   * "not yours" still reads as not found, not as pinned -- the guard must not
//     reveal that someone else's notification exists.

const assert = require("assert");
const { Notification } = require("../../../models/Notification");
const Landlord = require("../../../models/Landlord");

const DAY = 24 * 60 * 60 * 1000;

let rows;
let landlordDoc;

// The tiny slice of Mongo these handlers use: equality, $nin, $in.
const matches = (row, filter) =>
  Object.entries(filter).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && "$nin" in cond) return !cond.$nin.includes(value);
    if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.includes(value);
    return String(value) === String(cond);
  });

Notification.findOneAndDelete = async (filter) => {
  const i = rows.findIndex((r) => matches(r, filter));
  return i === -1 ? null : rows.splice(i, 1)[0];
};
Notification.exists = async (filter) => (rows.some((r) => matches(r, filter)) ? { _id: "x" } : null);
Notification.deleteMany = async (filter) => {
  const before = rows.length;
  rows = rows.filter((r) => !matches(r, filter));
  return { deletedCount: before - rows.length };
};
Notification.countDocuments = async (filter) => rows.filter((r) => matches(r, filter)).length;

Landlord.findById = () => ({ select: () => ({ lean: async () => landlordDoc }) });

const ctrl = require("../../../controllers/notification.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
const del = async (handler, { id, role = "landlord", userId = "L1" } = {}) => {
  const res = makeRes();
  await handler({ user: { id: userId, role }, params: { id } }, res);
  return res;
};

const inBeta = { beta: { endsAt: new Date(Date.now() + 30 * DAY) } };
const accepted = { ...inBeta, foundingAgreement: { acceptedAt: new Date() } };
const declined = { ...inBeta, foundingAgreement: { declinedAt: new Date() } };

const reset = (doc) => {
  landlordDoc = doc;
  rows = [
    { _id: "r1", userId: "L1", type: "beta_reminder" },
    { _id: "r2", userId: "L1", type: "beta_reminder" },
    { _id: "r3", userId: "L1", type: "payment_failed" },
    { _id: "r4", userId: "OTHER", type: "beta_reminder" },
  ];
};

async function main() {
  /* -------- 1) Open offer: a single delete is refused ------------------ */
  reset(inBeta);
  let res = await del(ctrl.deleteNotification, { id: "r1" });
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(res.body.code, "pinned_notification");
  assert.ok(/accept or decline/.test(res.body.message), "it says how to resolve it");
  assert.ok(rows.some((r) => r._id === "r1"), "and nothing was deleted");

  // Anything else is still deletable.
  res = await del(ctrl.deleteNotification, { id: "r3" });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!rows.some((r) => r._id === "r3"));

  // Someone else's notification is "not found", never "pinned": the guard must
  // not reveal that it exists.
  res = await del(ctrl.deleteNotification, { id: "r4" });
  assert.strictEqual(res.statusCode, 404);
  assert.ok(rows.some((r) => r._id === "r4"));

  // A genuinely missing one is not found either.
  res = await del(ctrl.deleteNotification, { id: "nope" });
  assert.strictEqual(res.statusCode, 404);

  /* -------- 2) Open offer: bulk delete keeps the pinned rows ------------ */
  reset(inBeta);
  res = await del(ctrl.deleteNotifications);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(rows.map((r) => r._id).sort(), ["r1", "r2", "r4"], "the reminders stay (and so does the other user's)");
  assert.strictEqual(res.body.kept, 2, "it says how many it kept");
  assert.ok(/Deleted 1 notifications/.test(res.body.message));

  // Nothing but pinned rows: nothing to delete, and it still says what it kept.
  res = await del(ctrl.deleteNotifications);
  assert.ok(/No notifications to delete/.test(res.body.message));
  assert.strictEqual(res.body.kept, 2);

  /* -------- 3) Accepted: the reminders are ordinary again ---------------- */
  reset(accepted);
  res = await del(ctrl.deleteNotification, { id: "r1" });
  assert.strictEqual(res.statusCode, 200, "a founding landlord can delete a reminder");
  res = await del(ctrl.deleteNotifications);
  assert.strictEqual(res.body.kept, undefined, "nothing is kept once the offer is resolved");
  assert.deepStrictEqual(rows.map((r) => r._id), ["r4"], "only the other user's remains");

  /* -------- 4) Declined: ordinary too ------------------------------------ */
  reset(declined);
  res = await del(ctrl.deleteNotification, { id: "r2" });
  assert.strictEqual(res.statusCode, 200, "someone who said no is not made to keep the reminder");

  /* -------- 5) Not in a beta: there is no offer to protect ---------------- */
  reset({});
  res = await del(ctrl.deleteNotification, { id: "r1" });
  assert.strictEqual(res.statusCode, 200);
  reset(null);
  res = await del(ctrl.deleteNotification, { id: "r1" });
  assert.strictEqual(res.statusCode, 200, "a landlord record that cannot be found protects nothing");

  /* -------- 6) A tenant is never affected -------------------------------- */
  reset(inBeta); // even if a landlord record with an open offer exists
  let landlordLookups = 0;
  const original = Landlord.findById;
  Landlord.findById = (...args) => {
    landlordLookups += 1;
    return original(...args);
  };
  res = await del(ctrl.deleteNotification, { id: "r1", role: "tenant" });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(landlordLookups, 0, "a tenant never even triggers the landlord lookup");
  Landlord.findById = original;

  /* -------- 7) The offer reopens: protection returns --------------------- */
  // Declined, then accepting is the only way back to resolved -- but an offer
  // that is open again (e.g. the operator reset it) protects again.
  reset(declined);
  res = await del(ctrl.deleteNotification, { id: "r1" });
  assert.strictEqual(res.statusCode, 200);
  landlordDoc = inBeta;
  res = await del(ctrl.deleteNotification, { id: "r2" });
  assert.strictEqual(res.statusCode, 409, "the guard follows the live state, not a flag set once");

  console.log("notificationPinned.controller tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
