'use strict';
// This limits only simulated Guide actions. It never edits or reclassifies the
// real request and never substitutes for ordinary safety, policy or intake.
function supportsContainedFaucet(request) {
  const incident = request?.incidentRecord, ai = request?.ai || {};
  if (!incident || incident.emergency !== false || ![1, 3].includes(incident.severity) ||
      !['safetyRisk', 'activeDamage', 'lifeSafetyConcern'].every(key => incident.safety?.[key] === false)) return false;
  if (ai.urgency === 'emergency' || ai.emergencyServicesRecommended || ai.safetyGate?.triggered ||
      Number(ai.severity) >= 4 || incident.safety?.safetyRisk || incident.safety?.activeDamage || incident.safety?.lifeSafetyConcern) return false;
  if (['needs_review', 'confirmed_hazard'].includes(request.safetyAssessment?.state)) return false;
  if (String(incident.trade || '').toLowerCase() !== 'plumbing' || String(incident.category || '').toLowerCase() !== 'plumbing') return false;
  // The stored canonical classification must identify the supported issue.
  // Raw client title/description cannot override a different or unknown triage.
  const evidence = [incident.subcategory, incident.summary].filter(v => typeof v === 'string').join(' ');
  return /\b(?:faucet|tap)\b/i.test(evidence) && /\b(?:drip\w*|leak\w*)\b/i.test(evidence);
}
module.exports = { supportsContainedFaucet };
