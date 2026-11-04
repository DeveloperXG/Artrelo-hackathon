// Live nudges: who hears a publish, the per-user connection cap, and that an
// expired token ends its stream.

const assert = require("assert");
const live = require("../../../services/realtime/liveEvents.service");

function fakeRes() {
  return {
    chunks: [],
    ended: false,
    write(chunk) {
      if (this.ended) throw new Error("write after end");
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
}

const unsubscribers = [];

// 1) A publish reaches only the named user's streams, as a topic-only nudge.
const a1 = fakeRes();
const a2 = fakeRes();
const b1 = fakeRes();
unsubscribers.push(live.subscribe("userA", a1), live.subscribe("userA", a2), live.subscribe("userB", b1));
live.publish("userA", "wallet");
assert.deepStrictEqual(a1.chunks, ['event: nudge\ndata: {"topic":"wallet"}\n\n']);
assert.deepStrictEqual(a2.chunks, a1.chunks, "every tab of the user hears it");
assert.deepStrictEqual(b1.chunks, [], "another user hears nothing");

// 2) Many recipients, ObjectId-like ids, duplicates and nulls.
live.publish([{ toString: () => "userA" }, "userB", "userB", null], "request:r1");
assert.strictEqual(a1.chunks.length, 2);
assert.strictEqual(b1.chunks.length, 1, "a user listed twice is nudged once");

// 3) The cap closes the oldest stream instead of growing without bound.
const capped = [];
for (let i = 0; i < live.MAX_CONNECTIONS_PER_USER + 1; i += 1) {
  const res = fakeRes();
  capped.push(res);
  unsubscribers.push(live.subscribe("userC", res));
}
assert.strictEqual(live.connectionCount("userC"), live.MAX_CONNECTIONS_PER_USER);
assert.ok(capped[0].ended, "the oldest connection was closed");
assert.ok(!capped[capped.length - 1].ended);

// 4) Unsubscribing (the request's `close`) removes the stream.
const gone = fakeRes();
const unsubscribe = live.subscribe("userD", gone);
unsubscribe();
live.publish("userD", "notifications");
assert.deepStrictEqual(gone.chunks, []);
assert.strictEqual(live.connectionCount("userD"), 0);

// 5) The heartbeat tick pings live streams and ends ones whose token lapsed.
const fresh = fakeRes();
const stale = fakeRes();
unsubscribers.push(live.subscribe("userE", fresh, { expiresAt: Date.now() + 60_000 }));
unsubscribers.push(live.subscribe("userE", stale, { expiresAt: Date.now() - 1 }));
live.tick();
assert.deepStrictEqual(fresh.chunks, [": hb\n\n"]);
assert.ok(stale.chunks[0].startsWith("event: reauth"), "told to re-authenticate");
assert.ok(stale.ended);
assert.strictEqual(live.connectionCount("userE"), 1);

// 6) A dead socket throwing on write never breaks a publish.
const broken = { write() { throw new Error("EPIPE"); }, end() {} };
unsubscribers.push(live.subscribe("userF", broken));
assert.doesNotThrow(() => live.publish("userF", "wallet"));

for (const off of unsubscribers) off();
console.log("liveEvents service tests passed");
