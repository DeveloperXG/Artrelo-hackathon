// Only typed meaning from a completed, validated Policy answer survives across
// pages. No account transcript, assistant prose, saved values or consent does.
const fields = Object.freeze({ policy_default_quota: 'defaultQuotaMinor', policy_low: 'lowAutopilot', policy_medium: 'mediumAutopilot' });
const allowed = new Set(Object.values(fields));
function modelPolicyDiscussion(focus) {
  if (!focus || !Array.isArray(focus.fields) || !focus.fields.length || focus.fields.length > 3 ||
      focus.fields.some(key => !allowed.has(key)) || !['policy_answer', 'clarification', 'preview'].includes(focus.precedingAct)) return null;
  return Object.freeze({ kind: 'untrusted_policy_discussion', scope: 'same_account_policy',
    fields: Object.freeze([...new Set(focus.fields)].sort()), precedingAct: focus.precedingAct,
    awaitingQuotaAmount: focus.precedingAct === 'clarification' && focus.fields.length === 1 && focus.fields[0] === 'defaultQuotaMinor' });
}
function nextPolicyDiscussion({ selection, registry, turnRef, proposed, answer }) {
  if (!selection || selection.outcome === 'refuse') return null;
  if (proposed) return modelPolicyDiscussion({ fields: Object.keys(proposed).filter(key => allowed.has(key) && proposed[key] !== null), precedingAct: 'preview' });
  if (selection.outcome === 'clarify') return selection.clarificationCode === 'exact_quota_required'
    ? modelPolicyDiscussion({ fields: ['defaultQuotaMinor'], precedingAct: 'clarification' }) : null;
  const chosen = refs => [...new Set((refs || []).flatMap(ref => {
    const row = registry.facts.get(ref);
    return row?.turnRef === turnRef && row.metadata.section === 'policy' && fields[row.value.code] &&
      row.value.evidenceRefs.some(ev => registry.sources.get(ev)?.evidence.kind === 'policy_revision') ? [fields[row.value.code]] : [];
  }))];
  // An assistant-only reference must cite an exact current Policy fact. If it
  // mentions several settings, retain that ambiguity rather than pick one.
  const explained = chosen(selection.explanation?.factIds);
  // The guide compiler can intentionally hide unrelated seeded Policy rows.
  // Without a cited explanation, retain the setting(s) actually displayed,
  // rather than making a one-setting answer ambiguous from hidden selection.
  const displayed = chosen(answer?.blocks.filter(block => block.kind === 'facts').flatMap(block => block.rows.flatMap(row => row.factIds)));
  const selected = explained.length ? explained : answer ? displayed : chosen(selection.selected);
  return selected.length ? modelPolicyDiscussion({ fields: selected, precedingAct: 'policy_answer' }) : null;
}
module.exports = { modelPolicyDiscussion, nextPolicyDiscussion };
