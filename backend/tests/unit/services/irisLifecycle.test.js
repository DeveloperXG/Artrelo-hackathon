'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const { createConversations } = require('../../../services/iris/conversation.service');
const { contract, id } = require('../../../services/iris/contract.service');
const profile = n => ({ id: n.toString(16).padStart(24, '0'), accountId: 'a'.repeat(24), role: 'landlord' });
const auth = u => ({ subjectId: u.id, accountId: u.accountId, role: u.role });
const deferred = () => { let resolve;const promise = new Promise(r => { resolve = r; });return { promise, resolve }; };
function harness() {
  let at = Date.parse('2026-10-30T05:00:00Z'), contextBarrier = null;
  const jobs = [], discards = [];
  const service = createConversations({
    authorize: async u => auth(u), now: () => new Date(at), schedule: job => jobs.push(job),
    reads: { ownRequest: async () => { if (contextBarrier) await contextBarrier;return { issueTitle: 'Synthetic request' }; },
      read: async () => ({ result: { status: 'ok', facts: [], evidence: [], truncated: false }, notice: null }) },
    changes: { discard: async (a, previewId) => { discards.push({ subject: a.subjectId, previewId }); } },
    Turns: { create: async () => {}, updateOne: async () => {} }, Access: { create: async () => {} }, knowledge: {},
  });
  return { service, discards, advance: ms => { at += ms; }, blockContext: promise => { contextBarrier = promise; },
    drain: async () => { while (jobs.length) await jobs.shift()(); } };
}
const create = (h, u, clientConversationId = crypto.randomUUID()) => h.service.create(u, { clientConversationId });
const origin = (h, u, c, generation = 0, requestContextId = null) => h.service.context(u, c.conversationId, { contextGeneration: generation, requestContextId });
const live = h => [...h.service.conversations.values()].filter(c => !c.expired);
async function fill(h, count = contract.limits.conversationsPerProcess) {
  const rows = [];
  for (let i = 1; i <= count; i++) { const u = profile(i), c = await create(h, u);rows.push({ u, c });h.advance(1); }
  return rows;
}
(async () => {
  const h = harness();
  try {
    assert.equal(contract.limits.conversationsPerProcess, 100);
    assert.equal(contract.limits.conversationTombstones, 1000);
    const rows = await fill(h);
    await origin(h, rows[0].u, rows[0].c); // Oldest-created is now most recently used.
    await create(h, profile(101));
    assert.equal(live(h).length, 100);
    assert.equal(h.service.conversations.get(rows[0].c.conversationId).expired, false);
    assert.equal(h.service.conversations.get(rows[1].c.conversationId).expired, true, 'least recently used idle victim');
    await assert.rejects(origin(h, rows[1].u, rows[1].c), { code: 'conversation_expired' });
    await assert.rejects(h.service.close(profile(999), rows[1].c.conversationId), { code: 'conversation_expired' });
    const victim = h.service.conversations.get(rows[1].c.conversationId);
    assert.equal(victim.registry, null);assert.equal(victim.turns.size, 0);assert.deepEqual(victim.pendingTrimIds, []);
    const own = profile(102), first = await create(h, own), second = await create(h, own);
    await assert.rejects(create(h, own), { code: 'conversation_limit' });
    assert.equal(h.service.conversations.get(first.conversationId).expired, false);
    assert.equal(h.service.conversations.get(second.conversationId).expired, false, 'global admission never bypasses profile cap');
  } finally { h.service.dispose(); }

  const busy = harness();
  try {
    const rows = await fill(busy), release = [];
    for (const { u, c } of rows) {
      const o = await origin(busy, u, c);
      release.push(busy.service.reserveConfirm(auth(u), o, id('pc')));
    }
    await assert.rejects(create(busy, profile(101)), { code: 'service_unavailable', retryAfterSeconds: 1 });
    assert.equal(live(busy).length, 100);assert.equal(busy.service.tombstones.size, 0, 'no active victim or oversubscription');
    await release[37]();await release[37](); // release is idempotent
    await create(busy, profile(101));
    assert.equal(busy.service.conversations.get(rows[37].c.conversationId).expired, true, 'only released candidate can be evicted');
    assert.equal(live(busy).length, 100);
    await Promise.all(release.map(done => done()));
  } finally { busy.service.dispose(); }

  const pending = harness();
  try {
    const rows = await fill(pending), first = rows[0], o = await origin(pending, first.u, first.c);
    await pending.service.accept(first.u, first.c.conversationId, { clientTurnId: crypto.randomUUID(), text: 'What can Iris do?', requestContextId: null, contextGeneration: o.contextGeneration });
    // Make every other candidate newer without advancing expiry windows.
    for (const row of rows.slice(1)) { pending.advance(1);await origin(pending, row.u, row.c); }
    await create(pending, profile(101));
    assert.equal(pending.service.conversations.get(first.c.conversationId).expired, false, 'accepted queued work is not idle');
    assert.equal(pending.service.conversations.get(rows[1].c.conversationId).expired, true);
    await pending.drain();
  } finally { pending.service.dispose(); }

  const reading = harness();
  try {
    const rows = await fill(reading), gate = deferred();reading.blockContext(gate.promise);
    const lookup = origin(reading, rows[0].u, rows[0].c, 0, 'b'.repeat(24));
    await new Promise(resolve => setImmediate(resolve));
    for (const row of rows.slice(1)) { reading.advance(1);await origin(reading, row.u, row.c); }
    await create(reading, profile(101));
    assert.equal(reading.service.conversations.get(rows[0].c.conversationId).expired, false, 'in-flight context authorization is pinned');
    gate.resolve();await lookup;
    assert.equal(reading.service.conversations.get(rows[0].c.conversationId).inflight, 0);
  } finally { reading.service.dispose(); }

  const closed = harness();
  try {
    const u = profile(1), c = await create(closed, u), o = await origin(closed, u, c);
    const state = closed.service.conversations.get(c.conversationId), previewId = id('pc');
    // Attach a transient preview to exercise expiry cleanup without policy writes.
    state.turns.set('synthetic', { view: { turnId: id('turn'), preview: { id: previewId } } });
    const release1 = closed.service.reserveConfirm(auth(u), o, previewId);
    const release2 = closed.service.reserveConfirm(auth(u), o, previewId);
    await closed.service.close(u, c.conversationId);
    assert.equal(closed.discards.length, 0, 'pagehide cannot discard an already reserved confirm');
    assert.throws(() => closed.service.reserveConfirm(auth(u), o, previewId), { code: 'preview_expired' }, 'close first rejects a new confirm');
    await release1();assert.equal(closed.discards.length, 0, 'overlapping confirm reservation still protected');
    await release2();await release2();
    assert.equal(closed.discards.length, 1, 'only final release cleans up an unused preview; applied discard remains idempotent');
    assert.equal(state.inflight, 0);assert.equal(state.confirming.size, 0);
    const newC = await create(closed, u);assert.notEqual(newC.conversationId, c.conversationId);
  } finally { closed.service.dispose(); }

  const bounded = harness();
  try {
    const u = profile(1), oldClient = crypto.randomUUID(), first = await create(bounded, u, oldClient);
    await bounded.service.close(u, first.conversationId);
    for (let i = 0; i < 1005; i++) { const c = await create(bounded, u);await bounded.service.close(u, c.conversationId); }
    assert.equal(bounded.service.tombstones.size, 1000);
    assert.equal(bounded.service.conversations.size, 1000);
    assert.equal(bounded.service.conversations.has(first.conversationId), false);
    const recreated = await create(bounded, u, oldClient);
    assert.notEqual(recreated.conversationId, first.conversationId, 'pruned idempotency mapping cannot point into an unbounded dead store');
    bounded.advance(26 * 60 * 60000 + 1);bounded.service.sweep();
    assert.equal(bounded.service.conversations.size, 0);assert.equal(bounded.service.tombstones.size, 0);
  } finally { bounded.service.dispose(); }
  console.log('Iris lifecycle: 100-live LRU/no-inflight admission, busy refusal, bounded tombstones, ownership, confirm-close ordering PASS.');
})().catch(err => { console.error(err);process.exitCode = 1; });
