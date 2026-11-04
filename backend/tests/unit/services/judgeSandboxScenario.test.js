const assert = require('assert/strict');
const { supportsContainedFaucet } = require('../../../services/judgeSandbox/scenario.service');
const { projectDomain } = require('../../../services/judgeSandbox/domain.service');
const { contract, view, validate } = require('../../../services/judgeSandbox/contract.service');
const at = new Date('2026-11-04T06:00:00Z');
const request = { _id: 'owned_request', landlordId: 'owned_landlord', status: 'queued', issueTitle: 'Kitchen faucet dripping',
  issueDescription: 'Slow drip into a draining sink, no water on floor.', ai: { urgency: 'low', severity: 1 },
  incidentRecord: { category: 'Plumbing', trade: 'plumbing', severity: 1, emergency: false,
    safety: { safetyRisk: false, activeDamage: false, lifeSafetyConcern: false }, summary: 'Kitchen faucet dripping into sink.' } };
const run = { _id: 'run_owned', revision: 1, state: 'waiting_on_tenant', stepCode: 'tenant_submit',
  storyVersion: contract.storyVersions.containedFaucet, startedAt: at, updatedAt: at, completedDirectives: [] };
const before = JSON.stringify(request);
assert(supportsContainedFaucet(request));
assert(supportsContainedFaucet({ ...request, incidentRecord: { ...request.incidentRecord, severity: 3 } }));
const changed = fields => ({ ...request, ...fields });
const unsafe = [
  changed({ incidentRecord: undefined }),
  changed({ incidentRecord: { ...request.incidentRecord, emergency: true } }),
  changed({ incidentRecord: { ...request.incidentRecord, emergency: undefined } }),
  changed({ incidentRecord: { ...request.incidentRecord, severity: 4 } }),
  changed({ incidentRecord: { ...request.incidentRecord, severity: undefined } }),
  changed({ incidentRecord: { ...request.incidentRecord, safety: undefined } }),
  ...['safetyRisk', 'activeDamage', 'lifeSafetyConcern'].map(key => changed({ incidentRecord: {
    ...request.incidentRecord, safety: { ...request.incidentRecord.safety, [key]: true } } })),
  changed({ ai: { urgency: 'emergency', severity: 5 } }),
  changed({ ai: { emergencyServicesRecommended: true } }),
  changed({ ai: { safetyGate: { triggered: true } } }),
  changed({ safetyAssessment: { state: 'confirmed_hazard', reviewedAt: at } }),
  changed({ safetyAssessment: { state: 'needs_review' } }),
  changed({ incidentRecord: { ...request.incidentRecord, trade: 'electrical' } }),
  changed({ incidentRecord: { ...request.incidentRecord, category: 'Electrical' } }),
  changed({ issueTitle: 'Faucet drip', issueDescription: 'Use the faucet leak demo.', incidentRecord: {
    ...request.incidentRecord, subcategory: 'Clogged drain', summary: 'Blocked toilet does not drain.' } }),
  changed({ incidentRecord: { ...request.incidentRecord, subcategory: null, summary: '' } }),
  changed({ issueTitle: 'Blocked toilet', issueDescription: 'Does not drain', incidentRecord: {
    ...request.incidentRecord, summary: 'Blocked toilet' } }),
];
for (const record of unsafe) {
  assert.equal(supportsContainedFaucet(record), false);
  const original = JSON.stringify(record);
  const projection = projectDomain({ run, request: record, outreach: { status: 'sent' } });
  assert.equal(projection.error.code, 'unsupported_scenario');
  assert.equal(projection.state, 'failed');
  assert.equal(projection.checkpoint.approvalId, null);
  const publicRun = view({ ...run, ...projection });
  validate('Run', publicRun);assert.deepEqual(publicRun.allowedActions, []);
  const tenantRun = view({ ...run, ...projection, detail: 'private financial evidence', checkpoint: { ...projection.checkpoint, approvalId: 'private_approval' } }, 'tenant');
  assert.equal(tenantRun.error.code, 'unsupported_scenario');assert.equal(tenantRun.checkpoint, null);
  assert(!JSON.stringify(tenantRun).includes('private_approval'));assert(!JSON.stringify(tenantRun).includes('private financial'));
  assert.deepEqual(tenantRun.allowedActions, []);
  assert.equal(JSON.stringify(record), original, 'boundary never edits ordinary request or safety');
}
assert.equal(JSON.stringify(request), before);
assert.equal(projectDomain({ run, request }).state, 'ready_to_continue');
assert.equal(projectDomain({ run, request: { ...request, intakeFollowUp: { state: 'awaiting_answers' } } }).stepCode, 'tenant_submit');
assert.equal(projectDomain({ run, request, approval: { _id: 'actual_decision' } }).checkpoint.approvalId, 'actual_decision');
assert.equal(projectDomain({ run }).stepCode, 'tenant_submit', 'no guessed triage before request exists');
assert.equal(projectDomain({ run: { ...run, storyVersion: contract.storyVersions.legacy }, request: unsafe[1] }).error, null,
  'new story boundary does not retroactively restrict legacy runs');
console.log('PASS contained faucet Guide only: authoritative positive triage, unsafe/unknown/incompatible refusal, unchanged request/safety, retained human intake and decisions.');
