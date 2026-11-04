// A message in a request thread bells the OTHER party, coalesces per request,
// skips the author, and nudges both sides' open threads.

const assert = require("assert");

const Tenant = require("../../../models/Tenant");
const Landlord = require("../../../models/Landlord");
const { Notification } = require("../../../models/Notification");
const live = require("../../../services/realtime/liveEvents.service");

function chain(value) {
  const self = {
    select: () => self,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return self;
}

Tenant.findById = () => chain({ firstName: "Alex", lastName: "Thompson" });
Landlord.findById = () => chain({ firstName: "Pat", lastName: "Lee", companyName: "Pine Holdings" });

let unread = null; // the one unread coalescible row, if any
const created = [];
const titleUpdates = [];
Notification.findOneAndUpdate = async (filter, update) => {
  if (!unread || unread.type !== filter.type || String(unread.userId) !== String(filter.userId)) return null;
  unread.message = update.$set.message;
  unread.metadata.count += update.$inc["metadata.count"];
  return { ...unread, metadata: { ...unread.metadata } };
};
Notification.updateOne = async (filter, update) => {
  titleUpdates.push({ filter, update });
  if (unread && filter["metadata.count"] === unread.metadata.count) unread.title = update.$set.title;
  return { modifiedCount: 1 };
};
Notification.create = async (row) => {
  created.push(row);
  unread = { _id: `n${created.length}`, ...row, metadata: { ...row.metadata } };
  return unread;
};

const published = [];
live.publish = (ids, topic) => published.push({ ids: [].concat(ids).map(String), topic });

const { notifyThreadMessage } = require("../../../services/notification/threadMessage.service");

const request = { _id: "req1", tenantId: "tenant1", landlordId: "landlord1", issueTitle: "Leaking sink" };

async function main() {
  // 1) Tenant writes: the landlord is belled, both threads nudged.
  await notifyThreadMessage({ request, authorId: "tenant1", authorRole: "tenant", body: "It's dripping again." });
  assert.strictEqual(created.length, 1);
  assert.strictEqual(String(created[0].userId), "landlord1");
  assert.strictEqual(created[0].type, "tenant_message_received");
  assert.strictEqual(created[0].title, "Alex Thompson sent a message");
  assert.strictEqual(created[0].message, "Leaking sink: It's dripping again.");
  assert.strictEqual(created[0].metadata.workOrderId, "req1");
  assert.strictEqual(created[0].metadata.count, 1);
  assert.ok(published.some((p) => p.topic === "request:req1" && p.ids.includes("tenant1") && p.ids.includes("landlord1")));
  assert.ok(published.some((p) => p.topic === "notifications" && p.ids.includes("landlord1")));

  // 2) A second message while that row is unread folds into it.
  await notifyThreadMessage({ request, authorId: "tenant1", authorRole: "tenant", body: "Now it's a puddle." });
  assert.strictEqual(created.length, 1, "no second row");
  assert.strictEqual(unread.metadata.count, 2);
  assert.strictEqual(unread.message, "Leaking sink: Now it's a puddle.");
  assert.strictEqual(unread.title, "Alex Thompson sent 2 new messages");
  assert.strictEqual(titleUpdates[0].filter["metadata.count"], 2, "title write is guarded on its count");

  // 3) Landlord replies: the tenant is belled under the company name.
  unread = null;
  await notifyThreadMessage({ request, authorId: "landlord1", authorRole: "landlord", body: "Plumber booked." });
  assert.strictEqual(String(created[1].userId), "tenant1");
  assert.strictEqual(created[1].type, "landlord_message_received");
  assert.strictEqual(created[1].title, "Pine Holdings sent a message");

  // 4) One person holding both roles is not belled about their own message.
  const before = created.length;
  await notifyThreadMessage({
    request: { ...request, landlordId: "same", tenantId: "same" },
    authorId: "same",
    authorRole: "tenant",
    body: "note to self",
  });
  assert.strictEqual(created.length, before);

  // 5) System comments and missing requests notify nobody.
  assert.strictEqual(await notifyThreadMessage({ request, authorId: "x", authorRole: "system", body: "auto" }), null);
  assert.strictEqual(await notifyThreadMessage({ request: null, authorId: "x", authorRole: "tenant", body: "?" }), null);

  // 6) Long bodies are clamped under the schema's cap.
  unread = null;
  await notifyThreadMessage({ request, authorId: "tenant1", authorRole: "tenant", body: "x".repeat(2000) });
  assert.ok(created[created.length - 1].message.length <= 300);

  console.log("threadMessage service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
