const crypto = require('crypto');
const contract = require('../../contracts/judgeSandbox.v1.json');
const { assertValid } = require('../../contracts/validate.cjs');
const MESSAGES = {
  invalid_input: 'Check this sandbox action and try again.', auth_expired: 'Sign in again to continue.',
  forbidden_role: 'This action is not available for your signed-in profile.', record_not_found: 'This guided run is not available.',
  sandbox_disabled: 'The judge sandbox is not enabled.', run_exists: 'This pair already has a guided run. Open it or ask for a spare pair.',
  stale_revision: 'The guided run changed. Refresh its current step.', step_not_ready: 'This step is waiting on its recorded checkpoint.',
  checkpoint_requires_human: 'Complete this checkpoint on its normal screen first.', tenant_quota_reached: 'The tenant request allowance is reached. Wait or ask for a spare pair.',
  open_request_cap: 'This unit has reached its open-request limit.', no_free_visit_time: 'No free visit time is available. The original visit is preserved.',
  wallet_funding_required: 'The synthetic wallet needs attention on the Wallet page.', idempotency_conflict: 'This action identifier was already used for a different action.',
  ambiguous_request: 'More than one eligible request was found. The operator must identify the intended run.',
  action_unknown: 'The prior action outcome is uncertain. No automatic retry was started; ask the operator to inspect its receipt.',
  unsupported_scenario: 'This guided demo supports a contained non-emergency faucet drip. This request stays available for ordinary handling; safety classification is unchanged.',
  run_busy: 'A guided action is already running. Refresh its status.', ai_unavailable: 'The AI step is unavailable. Recorded information remains available.',
  ai_cap_reached: 'The sandbox AI allowance is reached.', rate_limited: 'Wait before trying this action again.', service_unavailable: 'The guided run is unavailable. Refresh its status.'
};
const error = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.service_unavailable), { code: Object.hasOwn(contract.errors, code) ? code : 'service_unavailable', status: contract.errors[code] || 503 });
function validate(name, value) {
  assertValid(contract.$defs[name], value, contract.$defs);
  const run = name === 'Run' ? value : name === 'Status' ? value.run : null;
  if (run) {
    const sequence = run.step.total === contract.steps.length ? contract.steps : contract.legacySteps;
    if (sequence[run.step.index - 1] !== run.step.code) throw error('invalid_input');
  }
  return value;
}
const id = value => String(value?._id || value || '');
const iso = value => value ? new Date(value).toISOString() : null;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const titles = {
  tenant_submit: 'Submit the tenant request', routing: 'Match and contact a simulated vendor', vendor_decline: 'Simulated vendor declines', vendor_quote: 'Receive the itemized quote',
  quote_resolution: 'Review the quote checkpoint', booking: 'Confirm the original visit', visit_change: 'Request a visit change',
  vendor_reschedule: 'Receive the simulated vendor response', tenant_reschedule: 'Tenant confirms the changed visit', vendor_work: 'Record the simulated work',
  tenant_completion: 'Tenant reviews completion', landlord_review: 'Review final costs and evidence', iris_segment: 'Explore the records with Ask Iris', complete: 'Guided maintenance run complete'
};
function storySteps(run) {
  if (!run.storyVersion || run.storyVersion === contract.storyVersions.legacy) return contract.legacySteps;
  if ([contract.storyVersions.declineRecovery, contract.storyVersions.containedFaucet].includes(run.storyVersion)) return contract.steps;
  throw error('service_unavailable');
}
function view(run, role = 'landlord') {
  const sequence = storySteps(run);
  let state = run.state, checkpoint = run.checkpoint || null, failure = run.error || null;
  let detail = run.detail || '', title = titles[run.stepCode];
  if (role === 'tenant') {
    const visible = new Set(['tenant_submit', 'booking', 'visit_change', 'tenant_completion']);
    if (checkpoint && !visible.has(checkpoint.kind)) { checkpoint = null;detail = 'The property manager is reviewing the next step.';title = 'Waiting for the property manager'; }
    if (failure?.code === 'unsupported_scenario') {
      // New public Guide boundary only. Existing failure/financial redaction is
      // unchanged; neither pending approval IDs nor private detail is exposed.
      checkpoint = null;detail = MESSAGES.unsupported_scenario;title = 'Guided demo scenario boundary';
    } else if (failure) { failure = null;detail = 'The property manager is reviewing the next step.'; }
    if (state === 'waiting_on_landlord') state = 'waiting_on_landlord';
  }
  const allowedActions = role !== 'landlord' || run.inFlightActionId || run.state === 'completed' || ['action_unknown', 'unsupported_scenario'].includes(run.error?.code) ? []
    : run.paused ? ['resume'] : ['ready_to_continue'].includes(run.state) ? ['continue', 'pause'] : ['pause'];
  return validate('Run', { runId: id(run), requestId: run.requestId ? id(run.requestId) : null, revision: run.revision, state,
    step: { index: sequence.indexOf(run.stepCode) + 1, total: sequence.length, code: run.stepCode, title, detail }, allowedActions,
    checkpoint, error: failure, startedAt: iso(run.startedAt), updatedAt: iso(run.updatedAt), completedAt: iso(run.completedAt) });
}
module.exports = { contract, validate, error, id, iso, hash, view, storySteps, MESSAGES };
