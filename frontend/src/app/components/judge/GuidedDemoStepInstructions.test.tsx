import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import contract from '../../contracts/judgeSandbox.v1.json';
import { parseRun, type JudgeRun, type JudgeStepCode } from '../../contracts/judgeSandbox';
import { GuidedDemoStepInstructions, currentStepInstruction } from './GuidedDemoStepInstructions';
import { JudgeRunCardView } from './JudgeViews';
import { checkpointLink, errorCopy } from './judgeCopy';

const at = '2026-11-03T01:00:00Z';
function run(code: JudgeStepCode = 'routing', sequence = contract.steps): JudgeRun {
  return { runId: 'synthetic_run', requestId: 'owned_request', revision: 3, state: 'ready_to_continue', step: { index: sequence.indexOf(code) + 1, total: sequence.length, code, title: 'Actual server title', detail: 'Actual server detail for the recorded branch.' }, allowedActions: ['continue', 'pause'], checkpoint: null, error: null, startedAt: at, updatedAt: at, completedAt: null };
}
const html = (r: JudgeRun, uncertain = false) => renderToStaticMarkup(<MemoryRouter><GuidedDemoStepInstructions run={r} uncertain={uncertain} /></MemoryRouter>);
describe('server-code current-step guidance', () => {
  it('explains a server-ready invoice follow-up as simulated answer only, independent of numeric position', () => {
    for (const sequence of [contract.steps, contract.legacySteps]) {
      const r = { ...run('landlord_review', sequence), checkpoint: null, state: 'ready_to_continue' as const };
      const copy = currentStepInstruction(r);
      expect(copy.action).toContain('only the simulated vendor answer'); expect(copy.result).toContain('does not confirm scope');
      expect(copy.result).toContain('change invoice prices'); expect(copy.result).toContain('tenant consent');
      expect(html(r)).not.toContain('The actual request-focused Decision');
    }
  });
  it('shows the exact server follow-up hold without inventing a Decision or ready answer', () => {
    const r = { ...run('landlord_review'), checkpoint: null, state: 'waiting_on_landlord' as const, allowedActions: ['pause' as const], step: { ...run('landlord_review').step, detail: 'The current invoice follow-up revision is stale. Review the recorded request.' } };
    expect(currentStepInstruction(r).action).toBe(r.step.detail); expect(html(r)).toContain(r.step.detail);
    expect(html(r)).toContain('pending_manual'); expect(html(r)).toContain('without a bank reference'); expect(html(r)).toContain('does not establish payment or bank settlement');
    const card = renderToStaticMarkup(<MemoryRouter><JudgeRunCardView view={{ loaded: true, status: { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Synthetic pair', simulatedVendorIds: [], run: r }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false }} onStart={() => { throw Error('No Start'); }} onAction={() => { throw Error('No auto action'); }} onCheckAgain={() => { throw Error('No auto read'); }} /></MemoryRouter>);
    expect(card.split(r.step.detail)).toHaveLength(2); expect(card).not.toContain('data-testid="judge-continue"');
    expect(html(r)).toContain('Only a fresh server checkpoint'); expect(html(r)).not.toContain('records only the simulated vendor answer');
    const actual = { ...r, checkpoint: { kind: 'approval' as const, approvalId: 'actual', requestId: 'owned_request' } };
    expect(currentStepInstruction(actual).where).toBe('The actual request-focused Decision');
    const unknown = { ...r, error: { code: 'action_unknown' as const, retryable: false, retryAfterSeconds: null, nextAvailableAt: null } };
    expect(currentStepInstruction(unknown).where).not.toBe('Recorded final-statement follow-up hold');
  });
  it('covers every valid14 recovery and13 legacy position without changing the run or its server title/detail/actions', () => {
    for (const sequence of [contract.steps, contract.legacySteps]) for (const code of sequence) {
      const r = run(code as JudgeStepCode, sequence), original = JSON.stringify(r);expect(parseRun(r)).not.toBeNull();
      const instruction = currentStepInstruction(r);expect(instruction.actor).toBeTruthy();expect(instruction.where).toBeTruthy();expect(instruction.action.length).toBeGreaterThan(30);expect(instruction.result.length).toBeGreaterThan(30);
      const markup = html(r);expect(markup).toContain('Your next action');expect(markup).toContain('Look for:');expect(markup).not.toContain('<button');expect(JSON.stringify(r)).toBe(original);
      const card = renderToStaticMarkup(<MemoryRouter><JudgeRunCardView view={{ loaded: true, status: { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Synthetic pair', simulatedVendorIds: [], run: r }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false }} onStart={() => { throw Error('No automatic Start'); }} onAction={() => { throw Error('No automatic action'); }} onCheckAgain={() => { throw Error('No automatic read'); }} /></MemoryRouter>);
      expect(card).toContain(`Step ${r.step.index} of ${sequence.length}`);expect(card).toContain(r.step.title);expect(card).toContain(r.step.detail);
    }
  });

  it.each(['routing', 'quote_resolution', 'landlord_review'] as const)('lets an actual approval checkpoint govern %s instead of prescribing advancement', code => {
    const r = { ...run(code), state: 'waiting_on_landlord' as const, allowedActions: ['pause' as const], checkpoint: { kind: 'approval' as const, requestId: 'owned_request', approvalId: 'owned_approval' } };
    expect(currentStepInstruction(r).where).toBe('The actual request-focused Decision');expect(html(r)).toContain('Continue cannot approve');expect(html(r)).toContain('keep it paused');expect(html(r)).not.toContain('<button');
    expect(checkpointLink(r.checkpoint, 'landlord')?.href).toBe('/dashboard/decisions?request=owned_request');
  });

  it('explains real routing/decline recovery records and preserves safe intake missing-detail guidance', () => {
    const routing = html(run('routing'));expect(routing).toContain('operating-hours');expect(routing).toContain('manual');expect(routing).toContain('safety');expect(routing).toContain('href="/dashboard/requests/owned_request?tab=activity"');
    const decline = html(run('vendor_decline'));expect(decline).toContain('Policy-dependent');expect(decline).toContain('actual current-vendor delivery');expect(decline).toMatch(/simulated/i);
    const intake = html(run('tenant_submit'));for (const value of ['availability', 'pets', 'access', 'missing', 'Example only', 'separate browser profile']) expect(intake).toContain(value);
    expect(html({ ...run('routing'), requestId: null })).not.toContain('href=');
  });
  it.each(['Operating-hours schedule is still pending.', 'Recorded intake or safety review is required.', 'Routing is paused or has exhausted its retry allowance.'])('does not invent a Decision for a null-approval request hold: %s', detail => {
    const r = { ...run('routing'), state: 'waiting_on_landlord' as const, step: { ...run('routing').step, detail }, allowedActions: ['pause' as const], checkpoint: { kind: 'approval' as const, requestId: 'owned_request', approvalId: null } };
    const instruction = currentStepInstruction(r);expect(instruction.where).toBe('Owned request review and recorded hold');expect(instruction.action).toContain('No Decision has been identified');expect(instruction.result).toContain('No financial approval');
    expect(checkpointLink(r.checkpoint, 'landlord')).toEqual({ text: expect.stringContaining('No Decision has been identified'), href: '/dashboard/requests/owned_request', label: 'Open request review' });
    expect(checkpointLink({ ...r.checkpoint, requestId: null }, 'landlord')?.href).toBeNull();
    const card = renderToStaticMarkup(<MemoryRouter><JudgeRunCardView view={{ loaded: true, status: { contractVersion: '1.2.0', enabled: true, role: 'landlord', pairLabel: 'Synthetic pair', simulatedVendorIds: [], run: r }, busy: null, notice: null, polling: false, pollExpired: false, refreshFailed: false }} onStart={() => { throw Error('No Start'); }} onAction={() => { throw Error('No automatic Continue'); }} onCheckAgain={() => { throw Error('No automatic refresh'); }} /></MemoryRouter>);
    expect(card).toContain(detail);expect(card).toContain('href="/dashboard/requests/owned_request"');expect(card).not.toContain('/dashboard/decisions');expect(card).not.toContain('judge-continue');
  });

  it('keeps quote advisory, clarification/counteroffer authorization and record-owned amounts separate', () => {
    expect(html(run('vendor_quote'))).toContain('actual record');expect(html(run('vendor_quote'))).toContain('Default quota is a separate');expect(html(run('vendor_quote'))).toContain('never approves');
    for (const code of ['vendor_quote', 'landlord_review'] as const) expect(html(run(code))).not.toMatch(/CAD275|CAD240|CAD200/);
    const quote = html(run('quote_resolution'));expect(quote).toContain('human-authorized counteroffer');expect(quote).toContain('Clarification is not authorization');expect(quote).not.toContain('>Approve<');
  });

  it('puts original booking consent in the tenant profile and Wallet holds with organisers, never funding actions', () => {
    const r = { ...run('booking'), state: 'waiting_on_tenant' as const, checkpoint: { kind: 'booking' as const, requestId: 'owned_request', approvalId: null } };
    expect(currentStepInstruction(r).actor).toContain('Paired tenant');expect(html(r)).toContain('Confirm visit');expect(html(r)).toContain('not an appointment');expect(checkpointLink(r.checkpoint, 'tenant')?.href).toBe('/portal/requests/owned_request');
    const held = html({ ...r, checkpoint: { ...r.checkpoint, kind: 'wallet_funding' } });expect(held).toContain('organisers');expect(held).toContain('unavailable');expect(held).not.toContain('<button');expect(checkpointLink({ kind: 'wallet_funding', requestId: null, approvalId: null }, 'landlord')?.text).not.toContain('Fund the wallet');expect(errorCopy('wallet_funding_required', null, null)).toContain('synthetic');
  });

  it.each(['visit_change', 'vendor_reschedule', 'tenant_reschedule'] as const)('retains exact-party OptionB and15min/2hour/original protections for %s', code => {
    const markup = html(run(code));for (const text of ['Option B', '15 minutes remaining', 'displayed response deadline', 'can be sooner', 'no later than 2 hours', 'earlier', 'existing expiry', '48 hours', 'Refusal or expiry retains the original']) expect(markup).toContain(text);
    if (code === 'visit_change') expect(markup).toContain('meaningful reason');
    if (code === 'tenant_reschedule') expect(markup).toContain('Accept or decline it yourself');
    if (code === 'vendor_reschedule') expect(markup).toContain('alone does not move');
  });

  it('uses actual human checkpoint order and keeps work, tenant rating and final financial review distinct', () => {
    expect(html(run('vendor_work'))).toContain('not evidence of a physical repair or payment');
    expect(html(run('tenant_completion'))).toContain('Schedule');expect(html(run('tenant_completion'))).toContain('separate from the landlord');
    const earlyApproval = { ...run('tenant_completion'), checkpoint: { kind: 'approval' as const, requestId: 'owned_request', approvalId: 'owned_approval' } };expect(currentStepInstruction(earlyApproval).actor).toBe('Landlord profile');
    expect(html(run('landlord_review'))).toContain('pending_manual');expect(html(run('landlord_review'))).toContain('without a bank reference');expect(html(run('landlord_review'))).toContain('either order');
  });

  it('requires Iris history/current value/explicit preview/human confirmation/verified receipt without treating Continue as proof', () => {
    const markup = html(run('iris_segment'));for (const text of ['history', 'current saved value', 'Set the default quota to CAD190.', 'requests a preview', 'Confirm change', 'listed in-flight checkpoint impacts', 'before human confirmation', 'verified saved receipt', 'acknowledgement only', 'Offline', 'fallback', 'full reload']) expect(markup).toContain(text);
    expect(markup).not.toContain('Preview setting');
    expect(markup).not.toContain('<button');
  });

  it('keeps running, paused, failed and uncertain outcomes truthful without automatic resume/retry or new mutations', () => {
    expect(html({ ...run(), state: 'running' })).toContain('do not repeat');
    expect(html({ ...run(), state: 'paused', allowedActions: ['resume'] })).toContain('Nothing resumes automatically');
    expect(html({ ...run(), state: 'failed', allowedActions: [] })).toContain('Do not Start again, reset, reseed');
    expect(html(run(), true)).toContain('unconfirmed');expect(html(run(), true)).toContain('nothing is automatically resent');
  });
  it.each(['landlord_review', 'quote_resolution'] as const)('promotes the recorded %s null-approval blocker without inferring payable or tenant authority', code => {
    const detail = 'Recorded invoice scope review declined. Financial close is blocked; approved payable is not decided. Reopen scope review, then explicitly confirm in Decisions. Tenant confirmation does not resolve scope review.';
    const r = { ...run(code), state: 'waiting_on_landlord' as const, checkpoint: { kind: 'approval' as const, requestId: 'owned_request', approvalId: null }, step: { ...run(code).step, detail } };
    expect(currentStepInstruction(r).action).toBe(detail);expect(html(r)).toContain('Recorded review blocker');expect(html(r)).toContain(detail);expect(html(r)).toContain('authorizes no spend or payment');expect(html(r)).not.toContain('<button');
    const recordedPayable = 'Scope review declined. Recorded approved payable CAD240 remains unchanged; explicit scope confirmation is still required.';
    const out = html({ ...r, step: { ...r.step, detail: recordedPayable } });expect(out).toContain(recordedPayable);expect(out).not.toContain('payable is not decided');expect(html({ ...r, checkpoint: { ...r.checkpoint, approvalId: 'real_approval' } })).not.toContain('Recorded review blocker');
    expect(html({ ...r, state: 'paused', allowedActions: ['resume'] })).toContain('Nothing resumes automatically');
    expect(html({ ...r, state: 'running' })).toContain('do not repeat the simulated action');
    expect(html(r, true)).toContain('current outcome or status is unconfirmed');expect(html(r, true)).toContain(detail);
  });
});
