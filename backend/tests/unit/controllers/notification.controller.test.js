// The landlord notification bell reads these routes.
//
// Covers the bugs fixed alongside it: an empty list answered twice, a missing
// notification answered 405 with success:true, and delete dropping the user
// filter — findByIdAndDelete casts `{ _id, userId }` down to `{ _id }`, so any
// signed-in user could delete anyone's notification by id.

const assert = require("assert");
const { Notification } = require("../../../models/Notification");

let findCalls = [];
let rows = [];
let unread = 0;
let lastUpdate = null;
let lastDeleteFilter = null;

Notification.find = (filter) => {
  const call = { filter, limit: null };
  findCalls.push(call);
  const chain = {
    sort: () => chain,
    limit: (n) => {
      call.limit = n;
      return chain;
    },
    lean: async () => rows,
  };
  return chain;
};
Notification.countDocuments = async (filter) => {
  assert.deepStrictEqual(filter, { userId: "landlord-1", read: false });
  return unread;
};
Notification.findOne = async () => null;
Notification.updateMany = async (filter, update) => {
  lastUpdate = { filter, update };
  return { modifiedCount: 2 };
};
Notification.findOneAndDelete = async (filter) => {
  lastDeleteFilter = filter;
  return null;
};
Notification.findByIdAndDelete = () => {
  throw new Error("findByIdAndDelete drops the userId filter; use findOneAndDelete");
};

const ctrl = require("../../../controllers/notification.controller");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    sends: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.sends += 1;
      this.body = payload;
      return this;
    },
  };
}
const user = { id: "landlord-1" };

const run = async () => {
  /* ===== 1) An empty list answers once, with an unread count ===== */
  rows = [];
  unread = 0;
  let res = makeRes();
  await ctrl.getNotifications({ user, query: {} }, res);
  assert.strictEqual(res.sends, 1, "an empty list must not send two responses");
  assert.deepStrictEqual(res.body, { success: true, notifications: [], unreadCount: 0 });

  /* ===== 2) limit is honoured and capped; unreadCount spans everything ===== */
  rows = [{ _id: "n1", read: false }];
  unread = 7;
  findCalls = [];
  res = makeRes();
  await ctrl.getNotifications({ user, query: { limit: "15" } }, res);
  assert.strictEqual(findCalls[0].limit, 15);
  assert.deepStrictEqual(findCalls[0].filter, { userId: "landlord-1" });
  assert.strictEqual(res.body.unreadCount, 7, "unread is counted beyond the returned page");

  findCalls = [];
  await ctrl.getNotifications({ user, query: { limit: "5000" } }, makeRes());
  assert.strictEqual(findCalls[0].limit, 50, "limit is capped");

  findCalls = [];
  await ctrl.getNotifications({ user, query: { limit: "nope" } }, makeRes());
  assert.strictEqual(findCalls[0].limit, 50, "a bad limit falls back to the default");

  /* ===== 3) A missing notification is a 404, not a 405 success ===== */
  res = makeRes();
  await ctrl.getNotification({ user, params: { id: "missing" } }, res);
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.sends, 1);

  /* ===== 4) Mark all read touches only unread rows and stamps readAt ===== */
  res = makeRes();
  await ctrl.markAllRead({ user }, res);
  assert.deepStrictEqual(lastUpdate.filter, { userId: "landlord-1", read: false });
  assert.strictEqual(lastUpdate.update.$set.read, true);
  assert.ok(lastUpdate.update.$set.readAt, "readAt is set");

  /* ===== 5) Delete keeps the user in the filter ===== */
  res = makeRes();
  await ctrl.deleteNotification({ user, params: { id: "n9" } }, res);
  assert.deepStrictEqual(lastDeleteFilter, { _id: "n9", userId: "landlord-1" });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(res.body.success, false);

  console.log("notification.controller tests passed");
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
