const assert = require('assert/strict');
const { Registry } = require('../../../services/iris/registry.service');
const { modelPolicyDiscussion, nextPolicyDiscussion } = require('../../../services/iris/policyDiscussion.service');
const registry = new Registry('a'.repeat(24)), turnRef = 'turn-current', prior = 'turn-earlier', segment = 'seg-current';
const source = registry.source({ kind: 'policy_revision', recordId: 'policy', requestId: null, routeKind: 'policy_current', publicRouteKind: null,
  lastVerifiedAt: null, revision: 3, hash: null, occurredAt: null, label: 'Your current Policy' }, {}, segment, turnRef);
const fact = (code, ref = turnRef) => registry.fact({ code, text: 'Synthetic current Policy value.', evidenceRefs: [source], observedAt: new Date().toISOString() }, segment, ref, { section: 'policy' });
const quota = fact('policy_default_quota'), low = fact('policy_low'), medium = fact('policy_medium'), old = fact('policy_default_quota', prior);
const derive = selection => nextPolicyDiscussion({ selection, registry, turnRef });
assert.deepEqual(derive({ selected: [quota.factId] }).fields, ['defaultQuotaMinor']);
assert.deepEqual(derive({ selected: [quota.factId, low.factId, medium.factId] }).fields, ['defaultQuotaMinor', 'lowAutopilot', 'mediumAutopilot'], 'several targets remain ambiguous');
assert.deepEqual(derive({ selected: [quota.factId, low.factId], explanation: { factIds: [low.factId] } }).fields, ['lowAutopilot'], 'only validated cited explanation meaning is retained');
assert.equal(derive({ selected: [old.factId] }), null, 'earlier factual values cannot seed current answer meaning');
assert.equal(derive({ selected: [] }), null, 'unrelated answer clears focus');
assert.equal(derive({ outcome: 'refuse' }), null);
assert.equal(derive({ outcome: 'clarify', clarificationCode: 'severity_required' }), null, 'unknown severity is not guessed');
assert.equal(derive({ outcome: 'clarify', clarificationCode: 'exact_quota_required' }).awaitingQuotaAmount, true);
assert.deepEqual(nextPolicyDiscussion({ selection: {}, registry, turnRef, proposed: { defaultQuotaMinor: null, lowAutopilot: false, mediumAutopilot: null } }).fields, ['lowAutopilot']);
assert.equal(modelPolicyDiscussion({ fields: ['approveSpend'], precedingAct: 'preview' }), null);
const help = registry.source({ kind: 'help_article', recordId: 'landlord-default-quota', requestId: null, routeKind: 'help_context', publicRouteKind: 'policy',
  lastVerifiedAt: new Date().toISOString(), revision: 1, hash: null, occurredAt: null, label: 'Default quota guide' }, {}, segment, turnRef);
const guide = registry.fact({ code: 'guide_landlord-default-quota', text: 'The default quota is the baseline Policy limit. Review the current saved value.', evidenceRefs: [help], observedAt: new Date().toISOString() }, segment, turnRef, { section: 'guide' });
const broadSelection = { selected: [quota.factId, low.factId, medium.factId, guide.factId] };
const answer = require('../../../services/iris/answer.service').compose({ registry, turnRef, selected: broadSelection.selected, results: [{ result: { status: 'ok' } }] });
assert.equal(answer.blocks.find(b => b.kind === 'facts').rows.length, 1, 'canonical guide answer intentionally shows only its related current setting');
assert.deepEqual(nextPolicyDiscussion({ selection: broadSelection, registry, turnRef, answer }).fields, ['defaultQuotaMinor'], 'hidden unrelated selected Policy facts must not make the visible single-setting answer ambiguous');
console.log('Iris private Policy meaning: exact current citations, ambiguity, clarification, supported fields and no old-value/consent authority PASS');
