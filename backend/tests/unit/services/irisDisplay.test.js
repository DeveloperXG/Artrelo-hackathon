const assert = require('assert/strict');
const { Registry } = require('../../../services/iris/registry.service');
const { createReadContext } = require('../../../services/iris/readContext.service');
const { compose } = require('../../../services/iris/answer.service');
const { humanInstant, decisionLabel } = require('../../../services/iris/display.service');
const { validate } = require('../../../services/iris/contract.service');
const at = '2026-11-03T08:35:53.200Z', owner = 'a'.repeat(24), requestId = 'b'.repeat(24);
const query = value => ({ sort() { return this; }, async lean() { return value; } });
const row = (n, stage, status) => ({ _id: n.toString(16).padStart(24, '0'), type: 'cost_review', status, createdAt: at, decidedAt: at,
  payload: { stage, ...(status === 'approved' ? { reopenedFromApprovalId: 'c'.repeat(24) } : {}) } });
const decisions = [row(1, 'quote', 'rejected'), row(2, 'invoice', 'approved'), row(3, undefined, 'pending')];
const visit = n => ({ _id: n.toString(16).padStart(24, '0'), status: 'committed', revision: 2, updatedAt: at, expiresAt: at,
  proposal: { reason: 'Synthetic water shut-off conflict.', oldSlot: { start: '2026-11-04T14:00:00.000Z', end: '2026-11-04T16:00:00.000Z' },
    proposedSlot: { start: '2026-11-05T14:00:00.000Z', end: '2026-11-05T16:00:00.000Z' }, vendorResponse: { status: 'accepted' }, tenantResponse: { status: 'accepted' } } });
const visits = Array.from({ length: 4 }, (_, i) => visit(10 + i));
const service = createReadContext({ Requests: { findOne: () => query({ _id: requestId, landlordId: owner, status: 'in_progress' }) },
  Approvals: { find: () => query(decisions) }, Checkpoints: { find: () => query([{ _id: 'd'.repeat(24), quoteRevision: 2, policyRevision: 7, state: 'passed', effectiveLimit: 275, quotaSource: 'default', evaluatedAt: at, basisHash: 'f'.repeat(64) }]) },
  Contacts: { findOne: () => query(null) }, Reschedules: { find: () => query(visits) }, Appointments: { findOne: () => query(null) },
  activity: { detail: async () => ({ events: [{ id: 'audit:' + 'e'.repeat(24), type: 'cost_review_approved', title: 'Scope confirmed', summary: 'The landlord confirmed the scope.', at, actor: 'Landlord' },
    { id: 'lifecycle:' + requestId + ':0', type: 'request_completed', title: 'Request completed', summary: 'Request completed.', at, actor: 'System' }], nextCursor: null }) }, now: () => new Date(at) });
const registry = new Registry(owner), origin = { segmentId: 'seg_display', contextGeneration: 0, requestContextId: requestId, contextKind: 'request', contextLabel: 'Synthetic display' }, turnRef = 'turn_display';
const requestRef = registry.reference('req', requestId, origin.segmentId), context = { auth: { subjectId: owner }, registry, origin, turnRef };
(async () => {
  assert.match(humanInstant(at), /^Nov 3, 2026, 8:35 AM UTC$/);
  assert.match(humanInstant(at, 'America/Toronto'), /3:35 AM America\/Toronto$/);
  assert.match(humanInstant('2026-07-03T08:35:00Z', 'America/Toronto'), /4:35 AM America\/Toronto$/, 'DST follows explicit record zone');
  assert.match(humanInstant(at, 'invalid/timezone'), /UTC$/);assert.equal(humanInstant(null), 'Unknown time');
  assert.equal(decisionLabel({ type: 'cost_review' }), 'Scope review (stage not recorded)');
  const outputs = [];
  for (const tool of ['read_request_history', 'read_decisions_and_policy_basis', 'read_scheduling']) outputs.push(await service.read(tool, { requestRef, cursor: null, limit: 8 }, context));
  const answer = compose({ registry, turnRef, results: outputs });validate('Answer', answer);
  const history = answer.blocks.find(b => b.kind === 'timeline');
  assert.equal(history.events[0].text, 'The landlord confirmed the scope.');
  assert.equal(history.events[1].text, '', 'exact duplicate title/summary is not repeated');
  assert.equal(history.events[0].actorLabel, 'landlord');assert.equal(history.events[1].actorLabel, 'system', 'mixed provenance retained');
  const decisionRows = answer.blocks.filter(b => b.kind === 'facts' && /decisions/.test(b.title)).flatMap(b => b.rows);
  assert(decisionRows.some(r => r.label === 'Quote scope review' && /rejected/.test(r.value)));
  assert(decisionRows.some(r => r.label === 'Final statement scope review' && /Reopened after/.test(r.value) && /does not authorize spending/.test(r.value)));
  assert(decisionRows.some(r => r.label === 'Scope review (stage not recorded)'));
  assert(decisionRows.some(r => r.label === 'Initial-contact policy check' && /^Unknown historical/.test(r.value)));
  assert(decisionRows.every(r => !r.value.includes('Actor:')), 'implied landlord actor omitted from display only');
  assert(registry.factsFor(turnRef).some(f => /Actor: Landlord decision recorded/.test(f.text)), 'full model/evidence grounding retained');
  const scheduling = answer.blocks.filter(b => b.kind === 'facts' && b.title === 'Visit changes');
  const rows = scheduling.flatMap(b => b.rows);
  assert.equal(rows.filter(r => r.label === 'Response deadline').length, 4, 'chunking never silently drops deadlines');
  assert.equal(rows.filter(r => r.label === 'Party responses').length, 4);
  assert(rows.filter(r => /Original visit|Proposed replacement|Response deadline/.test(r.label)).every(r => /UTC/.test(r.value) && !/T\d\d:/.test(r.value)), 'typed display uses explicit UTC, no raw ISO');
  assert(rows.filter(r => r.label === 'Party responses').every(r => /Vendor: accepted · Tenant: accepted/.test(r.value)));
  assert(scheduling.every(b => b.rows.length <= 20));
  for (const r of rows) { assert(r.factIds.every(id => registry.facts.has(id)));assert(r.evidenceRefs.every(id => registry.sources.has(id))); }
  assert(registry.factsFor(turnRef).some(f => f.code === 'visit_change' && f.text.includes('2026-11-04T14:00:00.000Z')), 'machine ISO/full factual source preserved');
  console.log('Iris display: typed stage/lineage/unknown, concise source-backed rows, mixed actors, complete party/deadline chunks and explicit-zone timestamps PASS');
})().catch(error => { console.error(error);process.exitCode = 1; });
