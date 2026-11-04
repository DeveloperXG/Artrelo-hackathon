const { error, validate } = require('./contract.service');
// A model proposal is never write authority. This recognizer binds the latest
// direct human command only; quoted records, recall and tool text cannot grant it.
function directIntent(message) {
  const text = String(message || '').trim();
  // Offline has no clarification state: an amount alone is never a request to
  // fetch maintenance history or implicit permission to change any setting.
  if (/^(?:CAD\s*|\$\s*)?\d+(?:[.,]\d+)?\s*(?:CAD|dollars?)?[.!]?$/i.test(text)) return { kind: 'clarify', code: 'ambiguous_request' };
  const writing = /^(?:please\s+)?(?:set|change|update|turn|switch|enable|disable)\b/i.test(text);
  if (!writing) return { kind: 'read', patch: null };
  if (/[`"\u201c\u201d]/.test(text) || /\b(?:quoted?|vendor says|example|pretend|ignore)\b/i.test(text)) return { kind: 'clarify', code: 'ambiguous_request' };
  if (/\b(?:auto.contact next vendor|max(?:imum)? vendors|vendor cap|next.vendor policy|high.severity|emergency|approve|pay|spend approval)\b/i.test(text)) return { kind: 'unsupported', code: 'unsupported_setting' };
  // Negated or conditional clauses cannot authorize even part of a write.
  // Ask for an explicit unconditional command instead of reversing intent.
  if (/\b(?:not|never|unless|except|without|if|don['\u2019]t)\b/i.test(text)) return { kind: 'clarify', code: 'ambiguous_request' };
  const input = { defaultQuotaMinor: null, lowAutopilot: null, mediumAutopilot: null };
  if (/\bquota\b/i.test(text)) {
    if (!/\bdefault[-\s]+quota\b/i.test(text) || /\b(?:USD|EUR|GBP|clear|unset|zero)\b/i.test(text)) return { kind: 'clarify', code: 'exact_quota_required' };
    const matches = [...text.matchAll(/\bdefault[-\s]+quota\s*(?:to|at|=)?\s*(?:CAD\s*|\$\s*)?(\d+(?:\.\d{1,2})?)(?![\dA-Za-z]|[.,]\d)/gi)];
    if (matches.length !== 1) return { kind: 'clarify', code: 'exact_quota_required' };
    const [whole, decimal = ''] = matches[0][1].split('.');
    const minor = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
    if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'clarify', code: 'exact_quota_required' };
    input.defaultQuotaMinor = Number(minor);
    if (Math.round((input.defaultQuotaMinor / 100) * 100) !== input.defaultQuotaMinor) return { kind: 'clarify', code: 'exact_quota_required' };
  }
  for (const [severity, key] of [['low', 'lowAutopilot'], ['medium', 'mediumAutopilot']]) {
    const tail = severity + '(?:[- ]severity)?(?:\\s+autopilot)?';
    const values = [...text.matchAll(new RegExp('\\b' + tail + '\\s*(?:to|=)?\\s+(on|off|enabled|disabled)\\b', 'gi'))].map(m => /^(on|enabled)$/i.test(m[1]));
    for (const pattern of [
      '\\b(?:turn|switch)\\s+(on|off)\\s+(?:the\\s+)?' + tail + '\\b',
      '\\b(?:turn|switch)\\s+(on|off)\\s+(?:the\\s+)?autopilot\\s+for\\s+(?:the\\s+)?' + severity + '(?:[- ]severity)?\\b',
    ]) for (const match of text.matchAll(new RegExp(pattern, 'gi'))) values.push(match[1].toLowerCase() === 'on');
    for (const verb of ['enable', 'disable']) if (new RegExp('\\b' + verb + '\\s+(?:the\\s+)?' + tail + '\\b', 'i').test(text)) values.push(verb === 'enable');
    if (new Set(values).size > 1) return { kind: 'clarify', code: 'ambiguous_request' };
    if (values.length) input[key] = values[0];
    else if (new RegExp('\\b' + severity + '\\b', 'i').test(text)) return { kind: 'clarify', code: 'severity_required' };
  }
  if (Object.values(input).every(x => x === null)) return { kind: 'clarify', code: /autopilot/i.test(text) ? 'severity_required' : 'ambiguous_request' };
  validate('ToolInput_preview_policy_change', input);
  return { kind: 'write', input, patch: { ...(input.defaultQuotaMinor === null ? {} : { defaultQuota: input.defaultQuotaMinor / 100 }), ...(input.lowAutopilot === null ? {} : { allowAutopilotForLowSeverity: input.lowAutopilot }), ...(input.mediumAutopilot === null ? {} : { allowAutopilotForMediumSeverity: input.mediumAutopilot }) } };
}
function assertPreviewIntent(message, proposed) {
  validate('ToolInput_preview_policy_change', proposed);
  const intent = directIntent(message);
  if (intent.kind !== 'write' || Object.keys(intent.input).some(key => intent.input[key] !== proposed[key])) throw error('unsupported_setting', 'Review an explicit default-quota or Low/Medium command before creating a preview.');
  return intent;
}
function planReads(text, hasRequest) {
  const q = String(text).toLowerCase();
  const help = /\b(what does|what is|how does|explain).*(autopilot|next vendor|vendor auto.contact|max vendors|quota)|\b(policy|setting).*(mean|work|do)\b/.test(q);
  if (help && !/\b(quote|charges|visit|decisions|history)\b/.test(q)) return ['search_landlord_help', 'read_policy'];
  if (/\b(policy|quota|autopilot|setting|max vendors|auto.contact|vendor auto.contact)\b/.test(q) && !/\b(history|quote|visit|decisions|recorded|earlier contact)\b/.test(q)) return ['read_policy'];
  if (!hasRequest) return [];
  return ['read_request_history', 'read_costs', 'read_decisions_and_policy_basis', 'read_scheduling'];
}
module.exports = { directIntent, assertPreviewIntent, planReads };
