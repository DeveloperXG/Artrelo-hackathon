const assert = require("assert");
const mongoose = require("mongoose");
const published = [];
require("../../../services/realtime/liveEvents.service").publish = (owner, topic) => published.push({ owner: String(owner), topic });
let notices = 0;
require("../../../services/notification/notify.service").notifyUser = async () => { notices++; };
const Approval = require("../../../models/ApprovalRequest");
const owner = new mongoose.Types.ObjectId(), request = new mongoose.Types.ObjectId();
const doc = new Approval({ landlordId: owner, requestId: request, type: "other", expiresAt: new Date(Date.now() + 10000), reason: "PRIVATE reason", payload: { token: "PRIVATE" } });
const postSave = () => new Promise((resolve, reject) => Approval.schema.s.hooks.execPost("save", doc, [doc], (error) => error ? reject(error) : resolve()));
async function main() {
  assert.equal(doc.validateSync(), undefined);
  assert.equal(Approval.schema.path("decisionClaimToken").options.select, false);
  doc.$locals.wasNew = true;
  await postSave();
  assert.equal(notices, 1, "existing approval notification is preserved and stubbed");
  assert.deepEqual(published.map((event) => event.topic), ["requests", `request:${request}`]);
  assert(published.every((event) => event.owner === String(owner)));
  assert(!/PRIVATE|payload|reason/.test(JSON.stringify(published)));
  published.length = 0; doc.$locals.wasNew = false; doc.status = "approved";
  await postSave();
  assert.equal(notices, 1, "existing saves do not create duplicate decision notices");
  assert.deepEqual(published.map((event) => event.topic), ["requests", `request:${request}`]);
  console.log("ApprovalRequest model: private claim identity and persisted-save invalidation hooks PASS");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
