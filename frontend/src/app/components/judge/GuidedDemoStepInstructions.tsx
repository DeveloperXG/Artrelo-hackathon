import { Link } from 'react-router-dom';
import type { JudgeRun, JudgeStepCode } from '../../contracts/judgeSandbox';
import { DEMO_EXAMPLE } from './JudgeDemoScenario';

type Instruction = { actor: string; where: string; action: string; result: string; safeguards: string[] };
const tenantReturn = 'After the tenant action, switch back to the landlord profile and return to Guided demo. The tenant Return link stays within the tenant portal.';
const landlordReturn = 'Return to Guided demo in this landlord profile. Follow the freshly loaded server step; it may skip or revisit a checkpoint.';
const consent = 'The exact parties must accept the exact replacement, including Option B outside suggested windows. Opening or offering a new proposal requires at least 15 minutes remaining. Use the displayed response deadline: it can be sooner, and is no later than 2 hours before the earlier of the original and replacement visits, also bounded by existing expiry and 48 hours after creation. Refusal or expiry retains the original visit.';

const instructions: Record<JudgeStepCode, Instruction> = {
  tenant_submit: {
    actor: 'Paired tenant, separate browser profile', where: 'New request in the tenant portal',
    action: 'Choose the relevant category, describe the contained, non-emergency kitchen faucet drip in the chat, answer missing-detail questions and use Submit when the ordinary form allows it.',
    result: 'A recorded tenant request or a visible follow-up/hold. Do not submit a second request just because the Guide is still waiting.',
    safeguards: [`Example only: ${DEMO_EXAMPLE} Supply truthful impact, availability, pets and access details when known; ask for missing details rather than inventing them. Do not use an emergency or other scenario for this demo.`, 'Submission, quota, safety and intake checks remain authoritative. A missing-detail follow-up can keep this step open.'],
  },
  routing: {
    actor: 'Landlord profile', where: 'Guide, request routing and Activity',
    action: 'Read the current hold. Use Continue only when offered to recheck ordinary routing; open any actual Decision or request review before proceeding.',
    result: 'Actual contact/routing events in the request Activity, or a truthful manual, safety, intake, operating-hours or Policy hold.',
    safeguards: ['A contact is not guaranteed. Policy, operating hours and manual/safety reviews can stop routing. Continue cannot approve a hold or impersonate a tenant.', 'Automation events are Automation; simulated vendor events are labelled Simulated vendor. Iris is not credited for those actions.'],
  },
  vendor_decline: {
    actor: 'Landlord profile', where: 'Guide, then request Activity',
    action: 'If Continue is offered, record the labelled first simulated-vendor decline. Inspect Activity for that decline and any actual next-vendor contact.',
    result: 'A recorded decline and Policy-dependent recovery, or a genuine hold. A recovered quote requires an actual current-vendor delivery record.',
    safeguards: ['Saved Policy decides whether another vendor may be contacted. Do not promise recovery after a Policy change or repeat an unknown delivery.', 'No real vendor message is established by the simulation.'],
  },
  vendor_quote: {
    actor: 'Landlord profile', where: 'Guide, then request cost review',
    action: 'Use Continue only when offered for the current simulated vendor. Open the recorded itemized quote and compare labour, materials, total and advisory analysis.',
    result: 'A validated quote or an actual human checkpoint, not automatic permission to spend.',
    safeguards: ['Read the current submitted quote and approved spending ceiling from the actual record. Saved Default quota is a separate Policy value and does not rewrite that quote or its approved ceiling.', 'Advisory analysis never approves a quote or spending.'],
  },
  quote_resolution: {
    actor: 'Landlord profile', where: 'Actual Decisions and request cost review',
    action: 'Review the actual quote checkpoint. Resolve a required Decision on its ordinary page; use Continue only if offered for a bounded simulated clarification answer or human-authorized counteroffer.',
    result: 'The recorded clarification, exact authorized amount or human Decision. A clear review can still leave other booking checks outstanding.',
    safeguards: ['Review, clarify, counteroffer or keep paused according to the recorded facts and saved Policy. Do not approve just to advance the demo.', 'Clarification is not authorization; the simulator cannot choose a counteroffer amount or bypass the submitted-quote ceiling.'],
  },
  booking: {
    actor: 'Landlord profile', where: 'Guide and the ordinary request visit card',
    action: 'Read the current booking checkpoint. If Continue is offered it may supply a simulated vendor time; tenant confirmation stays on the paired tenant’s request.',
    result: 'A proposed time, a confirmed appointment after the required consent, or a truthful booking hold.',
    safeguards: ['A proposal is not an appointment. Confirm visit belongs on the ordinary visit card, with the exact tenant permission required there.', 'A synthetic Wallet hold needs organiser attention. Judge funding controls are unavailable; do not attempt a real transfer.'],
  },
  visit_change: {
    actor: 'Landlord profile', where: 'Request visit card → Request a different time',
    action: 'Enter a meaningful reason and proposed replacement windows in the displayed device time zone. Review the exact dates, times and response deadline before sending.',
    result: 'A recorded change proposal, not a moved appointment or manufactured tenant consent.',
    safeguards: [consent, 'The Guide cannot choose a reason, invent availability or fast-forward a visit.'],
  },
  vendor_reschedule: {
    actor: 'Landlord profile', where: 'Guide, then request visit-change card',
    action: 'Use Continue only when offered to submit the labelled simulated-vendor response. Inspect the exact replacement and its deadline on the request.',
    result: 'A recorded vendor response. Vendor agreement alone does not move the visit.',
    safeguards: [consent],
  },
  tenant_reschedule: {
    actor: 'Paired tenant, separate browser profile', where: 'Your request visit-change card',
    action: 'Read the exact replacement arrival, time zone and deadline. Accept or decline it yourself on the ordinary card; the landlord and Guide cannot consent for you.',
    result: 'A recorded tenant response; the visit changes only when all required exact-party consent is recorded.',
    safeguards: [consent],
  },
  vendor_work: {
    actor: 'Landlord profile', where: 'Guide, then request Work record',
    action: 'If Continue is offered, record the labelled synthetic work report. Open Work record to inspect the final statement, work notes, visits and available evidence.',
    result: 'A simulated report or a visible unmet visit/consent condition, not evidence of a physical repair or payment.',
    safeguards: ['Original tenant confirmation, a scheduled visit and no active visit change remain prerequisites. The Guide does not fast-forward time.', 'Inspect actual evidence and any missing-evidence warning. Synthetic work establishes no real location, repair or bank receipt.'],
  },
  tenant_completion: {
    actor: 'Paired tenant, separate browser profile', where: 'Schedule → Review the work',
    action: 'Read the supplied completion/evidence and use the ordinary Review the work flow to report the outcome and rating truthfully.',
    result: 'A recorded tenant completion response/rating. This is separate from the landlord’s final-cost approval.',
    safeguards: ['Follow the current server checkpoint, not a fixed step order. A pending landlord approval may appear before this tenant review.', 'A synthetic completion response is not a certificate of physical repair.'],
  },
  landlord_review: {
    actor: 'Landlord profile', where: 'Work record and any actual Decision',
    action: 'Compare the submitted final statement, itemized charges, agreed ceiling and available evidence. Resolve any real approval on Decisions; leave unsupported costs paused.',
    result: 'The recorded financial/evidence review and any remaining gate, not inferred payment or bank settlement.',
    safeguards: ['Do not sum unrelated invoices or treat invoiced and approved-payable amounts as interchangeable. Inspect the authoritative records.', 'Even a synthetic pending_manual entry without a bank reference does not establish payment or bank settlement. Tenant completion and landlord financial approval may appear in either order as actual checkpoints require.'],
  },
  iris_segment: {
    actor: 'Landlord profile', where: 'The owned request → Ask Iris, then Policy',
    action: 'Ask about the request’s history, then ask Iris to explain a Policy setting and its current saved value. Only after reviewing that answer, explicitly request a permitted change, inspect its preview and choose Confirm change yourself.',
    result: 'Only a verified saved receipt and read-back value prove a Policy change. Guide Continue is acknowledgement only; it does not prove an Iris conversation, model call or receipt happened.',
    safeguards: ['Example history question: “What happened on this request, and which records support that?” Then ask “What does Default quota mean, and what is its current saved value?” If appropriate after that read, explicitly ask “Set the default quota to CAD190.” This optional example requests a preview, not a preapproved change or an assumed current value.', 'Read old/new values, revision and the listed in-flight checkpoint impacts in the preview before human confirmation. Then verify the saved receipt and Policy page. Offline, unavailable, unknown or fallback output must remain labelled truthfully; no model success or write is inferred.', 'Returning between pages preserves the current Iris session; a full reload has a separate conversation lifecycle. No automatic confirmation or replay.'],
  },
  complete: {
    actor: 'Landlord profile', where: 'The recorded request, Activity and Policy',
    action: 'Review the retained records using the passive links below. No new run action is needed.',
    result: 'The server’s completed run and available records only; no inferred repair, payment, model usage or verified Iris receipt.',
    safeguards: [],
  },
};

/** Copy follows authoritative code/checkpoint/state, never index arithmetic or
 * a client-side advancement plan. This also supports retained legacy13 runs. */
export function currentStepInstruction(run: JudgeRun): Instruction {
  let copy = instructions[run.step.code];
  const kind = run.checkpoint?.kind;
  if (kind === 'tenant_submit') copy = instructions.tenant_submit;
  if (kind === 'tenant_completion') copy = instructions.tenant_completion;
  if (kind === 'booking' && run.state === 'waiting_on_tenant') copy = { ...instructions.booking, actor: 'Paired tenant, separate browser profile', where: 'Your request → original visit card', action: 'Read the exact proposed arrival and use Confirm visit on your ordinary request when it is offered. Supply your own permission; the landlord profile and Guide cannot substitute for it.' };
  if (run.step.code === 'landlord_review' && run.checkpoint === null && !run.error) {
    if (run.state === 'ready_to_continue' && run.allowedActions.includes('continue')) copy = {
      actor: 'Landlord profile', where: 'Guided demo → simulated vendor follow-up answer',
      action: 'If Continue is offered here, it records only the simulated vendor answer to the current final-statement follow-up. Review the recorded answer and the next server checkpoint afterwards.',
      result: 'A recorded simulated vendor reply, or a truthful remaining hold. This action does not confirm scope, approve a cost, change invoice prices, pay anyone or provide tenant consent.',
      safeguards: [...instructions.landlord_review.safeguards, 'The exact invoice revision and question remain server-owned. Do not repeat an uncertain action.', 'Any actual pending Decision must be handled separately by the human on its ordinary page. Tenant work confirmation remains separate.'],
    };
    else if (run.state === 'waiting_on_landlord') copy = {
      actor: 'Landlord profile', where: 'Recorded final-statement follow-up hold',
      action: run.step.detail.trim() ? run.step.detail : 'The server has not identified an answerable vendor follow-up. Read the ordinary request records; no Decision or simulated reply is inferred.',
      result: 'The recorded hold remains visible. Only a fresh server checkpoint can offer a simulated reply or identify an actual Decision.',
      safeguards: [...instructions.landlord_review.safeguards, 'Do not use Continue to bypass missing, stale or unknown follow-up data. No invoice amount, scope approval, payment or tenant consent changes here.'],
    };
  }
  if (kind === 'approval' && !run.checkpoint?.approvalId) copy = { ...copy, actor: 'Landlord profile', where: 'Owned request review and recorded hold', action: 'Open the owned request and read its intake, safety, completion or routing hold, including any operating-hours schedule. Use only the ordinary controls actually offered there, or wait for the recorded schedule. No Decision has been identified for this checkpoint; Continue cannot clear the hold.', result: 'A recorded request review, an unchanged scheduled/paused/retry hold, or a fresh server checkpoint. No financial approval or automatic progression is inferred.' };
  else if (kind === 'approval' || kind === 'quote_over_limit') copy = { ...copy, actor: 'Landlord profile', where: 'The actual request-focused Decision', action: 'Open Decisions, read the recorded reason, itemization and saved Policy, then choose the appropriate human response there or keep it paused. Continue cannot approve it.', result: 'A recorded human Decision and any remaining check; not a guaranteed next vendor, visit or payment.' };
  if (kind === 'wallet_funding') copy = { ...instructions.booking, actor: 'Landlord profile', where: 'Wallet hold and organiser support', action: 'Review the synthetic Wallet hold and ask the organisers to check it. Judge funding controls are intentionally unavailable; do not attempt a real payment.', result: 'A truthful hold until its prerequisite is resolved; no funds, transfer or bank receipt is created by Guide navigation.' };
  if (recordedScopeReviewBlocker(run)) copy = { ...copy, where: 'Recorded cost-review hold on the owned request', action: run.step.detail, result: 'Follow the recorded review status on the ordinary request. Reopening, when offered, still requires a separate explicit human confirmation in Decisions; it authorizes no spend or payment. Tenant completion is a separate record.' };
  if (run.state === 'paused') copy = { ...copy, actor: 'Landlord profile', where: 'Guided demo', action: 'The run is paused. Review the recorded checkpoint and choose Resume only if the server offers it. Nothing resumes automatically.', result: 'A fresh server projection after deliberate Resume, not a replay of an earlier action.' };
  if (run.state === 'failed') copy = { ...copy, actor: 'Landlord profile', where: 'Recorded run status and organiser support', action: 'Stop and review the recorded error. Use a read-only status check if offered, or ask the organisers. Do not Start again, reset, reseed or repeat an uncertain action.', result: 'The recorded stopped/unknown outcome remains visible; success is not invented.' };
  if (run.state === 'running') copy = { ...copy, action: 'The server is working on the current step. Wait for its recorded status; do not repeat the simulated action.', result: 'A fresh recorded state or an explicit unavailable/unknown outcome.' };
  return copy;
}

/** Existing server detail is the blocker, never parsed into client authority. */
export function recordedScopeReviewBlocker(run: JudgeRun): boolean {
  return ['landlord_review', 'quote_resolution'].includes(run.step.code) && run.checkpoint?.kind === 'approval' && !run.checkpoint.approvalId && Boolean(run.step.detail.trim());
}

/** The server hold is rendered verbatim as the instruction, rather than twice. */
export function recordedVendorFollowupHold(run: JudgeRun): boolean {
  return run.step.code === 'landlord_review' && run.state === 'waiting_on_landlord' && run.checkpoint === null && !run.error && Boolean(run.step.detail.trim());
}

export function GuidedDemoStepInstructions({ run, uncertain = false }: { run: JudgeRun; uncertain?: boolean }) {
  const copy = currentStepInstruction(run);
  const blocker = recordedScopeReviewBlocker(run);
  const requestId = run.requestId;
  return <section className="mt-4 min-w-0 rounded-lg border border-hairline bg-well p-3 text-sm [overflow-wrap:anywhere]" aria-labelledby="judge-next-action-title" data-testid="judge-step-instructions">
    <h4 id="judge-next-action-title" className="font-semibold">{blocker ? 'Recorded review blocker' : 'Your next action'}</h4>
    {blocker ? <p className="mt-2 font-medium text-ink">{run.step.detail}</p> : null}
    <p className="mt-2 font-medium">{copy.actor} · {copy.where}</p>
    {!blocker || uncertain || copy.action !== run.step.detail ? <p className="mt-2 text-meta">{uncertain ? 'The current outcome or status is unconfirmed. Read the server status again before taking another action; nothing is automatically resent. The guidance below is context, not confirmation.' : copy.action}</p> : null}
    <p className="mt-2 text-meta"><strong className="font-medium text-ink">Look for: </strong>{copy.result}</p>
    {run.state !== 'completed' ? <p className="mt-2 text-meta">{copy.actor.startsWith('Paired tenant') ? tenantReturn : landlordReturn}</p> : null}
    {copy.safeguards.length ? <details className="mt-3"><summary className="min-h-6 cursor-pointer rounded-md font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-current">Step details and safeguards</summary><ul className="mt-2 list-disc space-y-2 pl-5 text-meta">{copy.safeguards.map(text => <li key={text}>{text}</li>)}</ul></details> : null}
    {requestId && ['routing', 'vendor_decline'].includes(run.step.code) ? <Link to={`/dashboard/requests/${encodeURIComponent(requestId)}?tab=activity`} className="mt-3 inline-flex min-h-11 items-center rounded-md font-medium text-lichen-text underline underline-offset-2">Open request Activity</Link> : null}
  </section>;
}
