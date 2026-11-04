const { validate, error, hash } = require('./contract.service');

// These capabilities exist only in this process. JSON from a client/model,
// including an object with identical properties, cannot manufacture one.
const proofs = new WeakSet();
const binding = ({ auth, origin, turnRef, message, proposed }) => hash([
  String(auth.subjectId), String(auth.accountId), auth.role, origin.segmentId,
  origin.contextGeneration, origin.requestContextId, turnRef, message, proposed,
]);
function validateActionProposal(context, proposed, plan) {
  validate('ToolInput_preview_policy_change', proposed);
  if (!['landlord', 'property_manager', 'admin'].includes(context.auth.role)) throw error('forbidden', 'This Policy preview is not available.');
  const evidence = plan.requestEvidence;
  const start = typeof evidence === 'string' && evidence.trim() ? context.message.indexOf(evidence) : -1;
  if (start < 0) throw error('invalid_model_output', 'The proposed change could not be linked to your current message.');
  // Evidence from a quoted/fenced span cannot authorize a proposal. This is a
  // data-boundary check, not a replacement language/intent classifier.
  const quoted = /```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)|"[^"\n]*(?:"|$)|\u201c[^\u201d]*(?:\u201d|$)|(?<![A-Za-z0-9])'[^'\n]*'(?![A-Za-z0-9])|\u2018[^\u2019]*\u2019|^\s*>[^\n]*/gm;
  for (const match of context.message.matchAll(quoted)) {
    if (start < match.index + match[0].length && start + evidence.length > match.index) throw error('invalid_model_output', 'Quoted content cannot prepare a Policy change.');
  }
  if (/\b(?:USD|EUR|GBP)(?![A-Za-z])/i.test(evidence)) throw error('invalid_model_output', 'Only a positive CAD default quota can be prepared.');
  const quota = proposed.defaultQuotaMinor;
  if (quota !== null && (!Number.isSafeInteger(quota) || quota < 1 || Math.round(quota / 100 * 100) !== quota)) throw error('invalid_model_output', 'An exact positive CAD amount is required.');
  // If the user supplied numeric literals, a model cannot invent another
  // amount. Spelled-out amounts remain model interpretation + human review.
  const numbers = [...evidence.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map(m => Number(m[0].replace(/,/g, '')) * 100);
  if (quota !== null && numbers.length && !numbers.some(n => Math.abs(n - quota) < 0.000001)) throw error('invalid_model_output', 'The proposed amount does not match your message.');
  const asserted = plan.assertedCurrentDefaultQuotaMinor;
  if (asserted !== null && (!Number.isSafeInteger(asserted) || asserted < 0 || quota === null || numbers.length && !numbers.some(n => Math.abs(n - asserted) < 0.000001))) throw error('invalid_model_output', 'The stated current amount could not be validated.');
  const patch = {
    ...(quota === null ? {} : { defaultQuota: quota / 100 }),
    ...(proposed.lowAutopilot === null ? {} : { allowAutopilotForLowSeverity: proposed.lowAutopilot }),
    ...(proposed.mediumAutopilot === null ? {} : { allowAutopilotForMediumSeverity: proposed.mediumAutopilot }),
  };
  if (!Object.keys(patch).length) throw error('invalid_model_output', 'Choose a setting to change.');
  const proof = Object.freeze({ binding: binding({ ...context, proposed }), patch: Object.freeze(patch), assertedCurrentDefaultQuotaMinor: asserted });
  proofs.add(proof);return proof;
}
function assertActionProposal(proof, context) {
  if (!proofs.has(proof) || proof.binding !== binding(context)) throw error('invalid_model_output', 'This proposed change is not available in the current context.');
  return proof;
}
module.exports = { validateActionProposal, assertActionProposal };
