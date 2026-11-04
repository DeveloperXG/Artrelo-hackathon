// Conservative projection: an old ai_agent label is not model provenance.
const AUTOMATION = new Set([
  'vendor_recommendations_generated', 'vendor_recommendations_narrowed', 'vendor_autopilot_started', 'initial_contact_authorized', 'initial_contact_refused',
  'vendor_outreach_scheduled', 'vendor_outreach_sent', 'vendor_outreach_send_failed', 'vendor_outreach_skipped', 'vendor_outreach_resent',
  'vendor_outreach_schedule_cancelled', 'vendor_outreach_expired', 'vendor_outreach_closed', 'vendor_outreach_exhausted', 'vendor_outreach_escalated',
  'vendor_outreach_reapproval_requested', 'vendor_outreach_advanced', 'vendor_quote_over_quota', 'vendor_appointment_created',
  'booking_reschedule_committed', 'booking_reschedule_response_deadline_shortened', 'booking_reschedule_expired', 'booking_reschedule_candidate_unavailable',
  'booking_reschedule_original_basis_changed', 'job_completion_closed', 'approval_requested', 'quote_clarification_prepared', 'appointment_proposed'
]);
function activityActor(row) {
  const provenance = (kind, label) => ({ kind, label });
  if (row.actor === 'landlord' || row.actor === 'tenant') return { actorKind: row.actor, actorLabel: row.actor === 'landlord' ? 'Landlord' : 'Tenant', simulated: false,
    provenance: provenance('records', row.actor === 'landlord' && row.metadata?.origin === 'iris_confirmed' ? 'Human confirmed; Iris assisted' : 'Recorded human action') };
  const simulation = row.metadata?.judgeSimulation;
  const simulated = simulation?.version === 1 && typeof simulation.pairId === 'string' && typeof simulation.vendorId === 'string';
  if (row.actor === 'vendor') return { actorKind: simulated ? 'simulated_vendor' : 'vendor', actorLabel: simulated ? 'Simulated vendor' : 'Vendor', simulated,
    provenance: provenance(simulated ? 'simulation' : 'records', simulated ? 'Server-owned vendor simulation; no real message or physical repair verified' : 'Recorded vendor action') };
  if (row.actionType === 'request_triaged') {
    const verified = row.output?.triageVerified === true, source = row.output?.triageSource;
    if (verified && ['meta', 'openai'].includes(source)) return { actorKind: 'ai_triage', actorLabel: 'AI triage', simulated: false, provenance: provenance('model', 'Recorded ' + (source === 'meta' ? 'Meta' : 'OpenAI') + ' intake assessment') };
    if (verified && ['deterministic', 'fallback', 'none'].includes(source)) return { actorKind: 'automation', actorLabel: 'Automation', simulated: false, provenance: provenance('fallback', 'Recorded rule-based intake fallback') };
    return { actorKind: 'unknown', actorLabel: 'Unknown', simulated: false, provenance: provenance('unknown', 'Historical intake actor or model provenance not established') };
  }
  if (row.actionType === 'quote_analysis_recorded' && row.output?.source === 'meta') return { actorKind: 'iris_assistant', actorLabel: 'AI cost analysis', simulated: false, provenance: provenance('model', 'Recorded model advisory; human decisions remain separate') };
  if (['ai_agent', 'system'].includes(row.actor) && AUTOMATION.has(row.actionType)) return { actorKind: 'automation', actorLabel: 'Automation', simulated,
    provenance: provenance(simulated || row.output?.provider === 'judge_simulation' ? 'simulation' : 'rules', simulated || row.output?.provider === 'judge_simulation' ? 'Server-owned simulation; no real delivery' : 'Recorded backend workflow') };
  if (row.actor === 'system') return { actorKind: 'system', actorLabel: 'System', simulated: false, provenance: provenance('records', 'Recorded system event') };
  return { actorKind: 'unknown', actorLabel: 'Unknown', simulated: false, provenance: provenance('unknown', 'Legacy actor does not establish who or what performed this action') };
}
module.exports = { activityActor };
