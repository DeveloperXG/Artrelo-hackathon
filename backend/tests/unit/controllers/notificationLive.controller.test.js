// A successful read/delete must invalidate every own-account bell, including
// another tab. Use the real SSE publisher; never send notification contents.
const assert = require('assert/strict');
const { Notification } = require('../../../models/Notification');
const live = require('../../../services/realtime/liveEvents.service');
const ctrl = require('../../../controllers/notification.controller');

let rows = [], failWrite = false, pendingWrite = null;
const own = row => row.userId === 'tenant-1';
Notification.updateMany = async filter => {
  assert.deepEqual(filter, { userId: 'tenant-1', read: false });
  if (failWrite) throw Error('synthetic write failure');
  if (pendingWrite) await pendingWrite;
  const unread = rows.filter(row => own(row) && !row.read);
  unread.forEach(row => { row.read = true; });
  return { modifiedCount: unread.length };
};
Notification.findOneAndUpdate = async filter => {
  assert.equal(filter.userId, 'tenant-1');
  if (failWrite) throw Error('synthetic write failure');
  const row = rows.find(row => own(row) && row._id === filter._id);
  if (row) row.read = true;
  return row || null;
};
Notification.findOneAndDelete = async filter => {
  assert.equal(filter.userId, 'tenant-1');
  if (failWrite) throw Error('synthetic write failure');
  const index = rows.findIndex(row => own(row) && row._id === filter._id);
  return index < 0 ? null : rows.splice(index, 1)[0];
};
Notification.deleteMany = async filter => {
  assert.deepEqual(filter, { userId: 'tenant-1' });
  if (failWrite) throw Error('synthetic write failure');
  const before = rows.length;
  rows = rows.filter(row => !own(row));
  return { deletedCount: before - rows.length };
};
const seen = [[], [], []], offs = [];
for (const [i, userId] of ['tenant-1', 'tenant-1', 'foreign-landlord'].entries()) {
  offs.push(live.subscribe(userId, { write(chunk) {
    seen[i].push({ chunk, snapshot: structuredClone(rows) });
  }, end() {} }));
}
const reset = () => {
  rows = [{ _id: 'n1', userId: 'tenant-1', read: false, title: 'Private detail' },
    { _id: 'n2', userId: 'tenant-1', read: false },
    { _id: 'foreign', userId: 'foreign-landlord', read: false }];
  seen.forEach(events => { events.length = 0; });
};
async function invoke(handler, id = 'n1') {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ user: { id: 'tenant-1', role: 'tenant' }, params: { id } }, res);
  return res;
}
function assertNudge() {
  assert.equal(seen[0].length, 1, 'successful mutation invalidates first own tab');
  assert.deepEqual(seen[1], seen[0], 'second own tab receives the same invalidation');
  assert.deepEqual(seen[2], [], 'another account receives no event');
  assert.equal(seen[0][0].chunk, 'event: nudge\ndata: {"topic":"notifications"}\n\n');
  assert.deepEqual(seen[0][0].snapshot, rows, 'publish happens after the persisted write');
}
async function main() {
  for (const handler of [ctrl.markRead, ctrl.markAllRead, ctrl.deleteNotification, ctrl.deleteNotifications]) {
    reset();
    const res = await invoke(handler);
    assert.equal(res.statusCode, 200); assert.equal(res.body.success, true);
    assertNudge();
    assert.equal(rows.find(row => row._id === 'foreign').read, false);
  }
  // A slow write cannot announce success before the authoritative state changes.
  reset(); let release;
  pendingWrite = new Promise(resolve => { release = resolve; });
  const mutation = invoke(ctrl.markAllRead);
  await Promise.resolve(); assert.equal(seen[0].length, 0);
  release(); await mutation; pendingWrite = null; assertNudge();

  for (const handler of [ctrl.markRead, ctrl.deleteNotification]) {
    reset(); assert.equal((await invoke(handler, 'foreign')).statusCode, 404);
    assert.ok(seen.every(events => !events.length), 'not-found/foreign target never invalidates');
  }
  reset(); rows.forEach(row => { row.read = true; });
  await invoke(ctrl.markAllRead); assert.equal(seen[0].length, 0, 'read-all no-op does not publish');
  reset(); rows = rows.filter(row => !own(row));
  await invoke(ctrl.deleteNotifications); assert.equal(seen[0].length, 0, 'empty delete does not publish');

  for (const handler of [ctrl.markRead, ctrl.markAllRead, ctrl.deleteNotification, ctrl.deleteNotifications]) {
    reset(); failWrite = true;
    const log = console.log, error = console.error;
    console.log = console.error = () => {};
    let res;
    try { res = await invoke(handler); } finally { console.log = log; console.error = error; failWrite = false; }
    assert.equal(res.statusCode, 500);
    assert.ok(seen.every(events => !events.length), 'failed writes never announce a change');
  }
  console.log('PASS notification live invalidation: post-write, both own tabs, no payload/foreign event, failures/no-ops.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => offs.forEach(off => off()));
