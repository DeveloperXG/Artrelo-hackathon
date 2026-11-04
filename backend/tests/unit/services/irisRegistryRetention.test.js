'use strict';
const assert = require('assert/strict');
const { Registry } = require('../../../services/iris/registry.service');
const registry = new Registry('a'.repeat(24));
const at = '2026-10-29T22:00:00.000Z';
function source(scope, turnRef) {
  return registry.source({ kind: 'request', recordId: 'c'.repeat(24), requestId: 'c'.repeat(24),
    routeKind: 'request_current', publicRouteKind: null, lastVerifiedAt: null, revision: null,
    hash: null, occurredAt: at, label: 'Synthetic saved source' }, { model: 'test' }, scope, turnRef);
}
function fact(ev, scope, turnRef, text) {
  return registry.fact({ code: 'recorded_test', text, evidenceRefs: [ev], observedAt: at }, scope, turnRef, { section: 'history' });
}
const a1 = source('seg_a', 'turn_a1'), a2 = source('seg_a', 'turn_a2'), b = source('seg_b', 'turn_b');
const f1 = fact(a1, 'seg_a', 'turn_a1', 'Earlier exact saved fact.');
fact(a1, 'seg_a', 'turn_a1', 'A second exact saved fact.');
fact(a2, 'seg_a', 'turn_a2', 'A later turn, same request segment.');
const fb = fact(b, 'seg_b', 'turn_b', 'Different segment.');
assert.equal(registry.contexts.size, 3, 'one immutable context record per exact segment and turn');
const row = registry.sources.get(a1);
assert.equal(row.scope, 'seg_a');assert.equal(row.turnRef, 'turn_a1');
assert.throws(() => { row.scope = 'seg_b'; }, TypeError, 'normalized rows cannot be rebound to another scope');
assert.equal(Object.hasOwn(row, 'facts'), false, 'source rows retain references instead of duplicate facts');
assert.deepEqual(registry.factsForSource(row).map(f => f.factId), row.factIds);
assert.deepEqual(registry.factsFor('turn_a1')[0], f1);
const stored = JSON.parse(JSON.stringify([...registry.facts.values()]));
assert.ok(stored.every(r => Number.isInteger(r.contextId) && !Object.hasOwn(r, 'scope') && !Object.hasOwn(r, 'turnRef')));
assert.ok([...registry.contexts.values()].every(Object.isFrozen));
registry.dropSegments(new Set(['seg_a']));
assert.equal(registry.contexts.size, 1);
assert.equal(registry.sources.has(a1), false);assert.equal(registry.facts.has(f1.factId), false);
assert.deepEqual(registry.factsForSource(row), [], 'a removed scope cannot rehydrate another segment as a substitute');
assert.equal(registry.sources.get(b).scope, 'seg_b');
assert.deepEqual(registry.factsForSource(registry.sources.get(b)), [fb]);
console.log('Iris registry retention: exact immutable scope/turn indirection, source fact references and whole-segment eviction PASS.');
