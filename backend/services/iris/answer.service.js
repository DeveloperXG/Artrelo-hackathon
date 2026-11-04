const { id, validate } = require('./contract.service');
const { money } = require('./readContext.service');
function noticeAnswer(code, text, now = new Date()) {
  return validate('Answer', { blocks: [{ id: id('block'), kind: 'notice', sourceType: 'system_notice', code, text, evidenceRefs: [] }], evidence: [], coverage: 'unknown', source: 'deterministic_records', model: null, observedAt: now.toISOString() });
}
function clarifyAnswer(code, now = new Date(), { offline = false } = {}) {
  const quotaCommand = 'Send a complete command, such as Set the default quota to CAD200. Replace 200 with the positive CAD amount you want.';
  const question = offline ? code === 'exact_quota_required' ? quotaCommand : code === 'current_value_differs' ? 'The current saved value differs from the amount you mentioned. ' + quotaCommand : code === 'severity_required' ? 'Send the severity and new setting in one command, such as Turn Low autopilot off or Turn Medium autopilot on.' : 'State the setting and new value together, such as Set the default quota to CAD200 or Turn Low autopilot off. An amount alone cannot prepare a change while the model is offline.' : code === 'current_value_differs' ? 'The current saved value differs from the amount you mentioned. What value would you like to set?' : code === 'exact_quota_required' ? 'What exact positive CAD default quota do you want?' : code === 'severity_required' ? 'Which severity, Low or Medium, and should autopilot be on or off?' : code === 'missing_context' ? 'Which request would you like to discuss? Open it from Requests, then ask again.' : 'What exact default-quota or Low/Medium policy change do you want?';
  return validate('Answer', { blocks: [{ id: id('block'), kind: 'clarification', sourceType: 'system_notice', questionCode: code, question, field: code === 'exact_quota_required' ? 'defaultQuotaMinor' : code === 'severity_required' ? 'lowAutopilot' : null, choices: [] }], evidence: [], coverage: 'unknown', source: 'deterministic_records', model: null, observedAt: now.toISOString() });
}
function compose({ registry, turnRef, results, source = 'deterministic_records', model = null, selected = null, explanation = null, now = new Date() }) {
  const records = [...registry.facts.values()].filter(row => row.turnRef === turnRef);
  const chosen = selected ? new Set(selected) : null;
  if (chosen) for (const key of chosen) if (!records.some(r => r.value.factId === key)) throw Object.assign(new Error('Unknown selected fact'), { code: 'invalid_model_output', status: 503 });
  const rows = chosen ? records.filter(r => chosen.has(r.value.factId)) : records;
  const blocks = [], used = new Set();
  if (explanation) {
    validate('ExplanationBlock', explanation);
    if (explanation.factIds.some(ref => !rows.some(r => r.value.factId === ref)) || explanation.evidenceRefs.some(ref => !explanation.factIds.some(key => registry.facts.get(key)?.value.evidenceRefs.includes(ref)))) throw Object.assign(new Error('Unknown explanation source'), { code: 'invalid_model_output' });
    blocks.push({ ...explanation });explanation.evidenceRefs.forEach(ref => used.add(ref));
  }
  const mark = row => { row.value.evidenceRefs.forEach(x => used.add(x));return { factIds: [row.value.factId], evidenceRefs: row.value.evidenceRefs }; };
  const guide = rows.filter(r => r.metadata.section === 'guide');
  for (const row of guide.slice(0, 2)) {
    // Canonical first two sentences; full verified source remains in the peek.
    const text = row.value.text.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
    blocks.push({ id: id('block'), kind: 'paragraph', sourceType: 'product_guide', text, ...mark(row) });
  }
  const quotes = rows.filter(r => r.metadata.quote);
  const final = rows.find(r => r.metadata.final);
  if (quotes.length || final) {
    const original = quotes[0], left = original?.metadata.quote?.itemization, right = final?.metadata.final?.itemization;
    const categories = [...new Set([...(left?.items || []), ...(right?.items || [])].map(x => x.category))].slice(0, 20);
    const cell = (snapshot, category, row) => {
      if (!snapshot || !row) return { text: 'Not recorded', minor: null, currency: null, factIds: [(original || final).value.factId], evidenceRefs: (original || final).value.evidenceRefs };
      const lines = category === null ? null : snapshot.items.filter(x => x.category === category);
      if (lines && !lines.length) return { text: 'Not itemized in this category', minor: null, currency: null, ...mark(row) };
      const low = lines ? lines.reduce((sum, x) => sum + (x.amountMinor ?? x.lowMinor), 0) : snapshot.totals.lowMinor;
      const high = lines ? lines.reduce((sum, x) => sum + (x.amountMinor ?? x.highMinor), 0) : snapshot.totals.highMinor;
      return { text: low === high ? money(high) : money(low) + ' to ' + money(high), minor: high, currency: 'CAD', ...mark(row) };
    };
    const footerRows = [{ label: 'Recorded totals', cells: [cell(left, null, original), cell(right, null, final)] }];
    if (final && final.metadata.agreed !== null) {
      const delta = right.totals.highMinor - final.metadata.agreed;
      footerRows.push({ label: 'Difference from agreed quote', cells: [{ text: money(delta), minor: delta < 0 ? null : delta, currency: 'CAD', ...mark(final) }] });
    }
    blocks.push({ id: id('block'), kind: 'cost_table', sourceType: 'account_record', caption: 'Recorded itemized quote and final charges by category; not bank-payment verification', columns: ['Original quote', 'Final charges'], rows: categories.length ? categories.map(category => ({ label: category.replace(/_/g, ' '), cells: [cell(left, category, original), cell(right, category, final)] })) : [{ label: 'Total', cells: [cell(left, null, original), cell(right, null, final)] }], footerRows });
  }
  const groups = [['scheduling', 'Visit changes'], ['decision', 'Recorded decisions and policy evidence'], ['policy', 'Your current setting']];
  for (const [section, title] of groups) {
    let group = rows.filter(r => r.metadata.section === section);
    if (guide.length && section === 'policy') {
      const wanted = new Set();
      for (const row of guide) {
        if (row.value.code.includes('auto-next-vendor')) wanted.add('policy_next_vendor');
        if (row.value.code.includes('max-vendors')) wanted.add('policy_max_vendors');
        if (row.value.code.includes('default-quota')) wanted.add('policy_default_quota');
        if (row.value.code.includes('low-medium-autopilot')) { wanted.add('policy_low');wanted.add('policy_medium'); }
      }
      group = group.filter(r => wanted.has(r.value.code));
    }
    if (!group.length) continue;
    const displayRows = group.flatMap(r => (r.metadata.displayRows || [{ label: r.metadata.label || title, value: r.metadata.displayValue ?? r.value.text }]).map(row => ({ label: row.label, value: row.value, ...mark(r) })));
    // Preserve every party/deadline even when more than one bounded block is needed.
    for (let offset = 0; offset < displayRows.length; offset += 20) blocks.push({ id: id('block'), kind: 'facts', sourceType: 'account_record', title, rows: displayRows.slice(offset, offset + 20) });
  }
  const history = rows.filter(r => r.metadata.section === 'history').slice(0, 8);
  if (history.length) blocks.push({ id: id('block'), kind: 'timeline', sourceType: 'account_record', events: history.map(r => ({ at: r.metadata.at, actorLabel: r.metadata.actor === 'unknown' ? 'Recorded actor unknown' : r.metadata.actor, title: r.metadata.title, text: r.metadata.displayText ?? r.value.text, ...mark(r) })) });
  const notices = results.map(x => x.notice).filter(Boolean);
  for (const code of new Set(notices)) blocks.push({ id: id('block'), kind: 'notice', sourceType: 'system_notice', code, text: code === 'restricted_topic' ? 'Iris can explain the landlord Policy features in this demo. Internal or technical material is not available.' : code === 'stale_guide' ? 'This guide is being updated. Review the Policy page for now.' : 'No reviewed guide for that topic is available in this demo.', evidenceRefs: [] });
  if (!blocks.length) return noticeAnswer('unknown', 'No supported recorded facts are available for this question.', now);
  const partial = results.some(x => x.result.truncated || x.result.status !== 'ok') || (chosen && rows.length < records.length);
  return validate('Answer', { blocks, evidence: [...used].map(key => registry.sources.get(key).evidence), coverage: partial ? 'partial' : 'complete', source, model, observedAt: now.toISOString() });
}
module.exports = { noticeAnswer, clarifyAnswer, compose };
