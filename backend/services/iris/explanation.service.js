const { id, validate, safeText } = require('./contract.service');

// Reference/format checks limit what may be displayed; they are not a proof
// of natural-language truth. Canonical tables and human Confirm stay separate.
function validateExplanation(value, { registry, turnRef, selected, preview = null }) {
  if (value === null || value === undefined) return null;
  const fail = reason => { throw Object.assign(new Error('Unverified explanation'), { code: 'invalid_model_output', explanationReason: reason }); };
  if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 800 || !Array.isArray(value.factIds) || !value.factIds.length || value.factIds.length > 8) fail('invalid_shape');
  const text = value.text;
  if (safeText(text, 800) !== text || /[<>]|https?:|www\.|\[[^\]]*\]\(|\b(?:fact|ev|req|pc|turn|seg)_[\w-]+|\b[a-f\d]{24}\b/i.test(text)) fail('unsafe_content');
  if (/\b(?:I|Iris|we)\s+(?:(?:have|has|will|can|successfully|already)\s+)*(?:save[ds]?|updat(?:e[ds]?|ing)|chang(?:e[ds]?|ing)|execut(?:e[ds]?|ing)|approv(?:e[ds]?|ing)|pa(?:y|id)|book(?:ed)?|confirm(?:ed)?|sen[dt]|contact(?:ed)?|schedul(?:e[ds]?|ing))\b/i.test(text) || /\b(?:spend(?:ing)?|payment|quote)\s+(?:is |was |has been )?approved\b/i.test(text)) fail('execution_claim');
  const facts = [...new Set(value.factIds)].map(ref => registry.facts.get(ref));
  if (facts.some(f => !f || f.turnRef !== turnRef || !selected.includes(f.value.factId))) fail('invalid_reference');
  const evidenceRefs = [...new Set(facts.flatMap(f => f.value.evidenceRefs))];
  if (!evidenceRefs.length || evidenceRefs.length > 8 || evidenceRefs.some(ref => registry.sources.get(ref)?.turnRef !== turnRef)) fail('invalid_evidence');
  const basis = facts.map(f => f.value.text).join(' ') + ' ' + (preview ? JSON.stringify(preview.changes) : '');
  for (const status of ['scheduled', 'cancelled', 'declined', 'completed', 'paid', 'confirmed', 'approved', 'expired', 'booked']) if (new RegExp('\\b' + status + '\\b', 'i').test(text) && !new RegExp('\\b' + status + '\\b', 'i').test(basis)) fail('unsupported_status');
  // Never allow unsupported numeric values or a fabricated preview/save claim.
  const normalized = s => s.replace(/,/g, '');
  const supportedNumbers = new Set((normalized(basis).match(/\d+(?:\.\d+)?/g) || []).map(Number));
  if ((normalized(text).match(/\d+(?:\.\d+)?/g) || []).some(n => !supportedNumbers.has(Number(n)))) fail('unsupported_number');
  if (!preview && /\b(?:proposed change|prepared (?:a |the )?preview|review (?:the |this )?(?:change|preview)|confirm (?:the |this )?change)\b/i.test(text)) fail('unbacked_preview');
  if (/\b(?:has been|was|is now|successfully)\s+(?:saved|applied|updated|approved|booked|paid)\b/i.test(text)) fail('execution_claim');
  return validate('ExplanationBlock', { id: id('block'), kind: 'explanation', text, factIds: facts.map(f => f.value.factId), evidenceRefs });
}
module.exports = { validateExplanation };
