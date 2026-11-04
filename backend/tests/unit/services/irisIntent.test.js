const assert = require('assert/strict');
const { directIntent, assertPreviewIntent, planReads } = require('../../../services/iris/intent.service');

// Original visible acceptance wording: bind the same explicit fields/values
// regardless of whether on/off is before or after the severity phrase.
for (const [severity, key] of [['low', 'lowAutopilot'], ['medium', 'mediumAutopilot']]) {
  for (const on of [false, true]) {
    const message = 'Turn ' + (on ? 'on' : 'off') + ' autopilot for ' + severity + '-severity requests';
    const expected = { defaultQuotaMinor: null, lowAutopilot: null, mediumAutopilot: null, [key]: on };
    assert.deepEqual(directIntent(message).input, expected, message);
    assert.deepEqual(assertPreviewIntent(message, expected).input, expected);
  }
}
for (const [message, key, value] of [
  ['Turn off Low-severity autopilot.', 'lowAutopilot', false],
  ['Please switch on Medium-severity autopilot.', 'mediumAutopilot', true],
]) assert.equal(directIntent(message).input[key], value, message);
for (const message of [
  'Set my default quota to CAD250 and do not turn Low-severity autopilot off.',
  'Set my default quota to CAD250 and never disable Medium-severity autopilot.',
  "Set my default quota to CAD250 and don't turn Low-severity autopilot off.",
  'Set my default quota to CAD250 unless Low-severity autopilot is off.',
  'Turn off autopilot for low-severity requests if the vendor agrees.',
  'Turn off autopilot for low-severity requests and Low-severity autopilot on.',
]) {
  assert.equal(directIntent(message).kind, 'clarify', message);
  assert.throws(() => assertPreviewIntent(message, { defaultQuotaMinor: 25000, lowAutopilot: false, mediumAutopilot: null }), { code: 'unsupported_setting' });
}
assert.notEqual(directIntent('Do not turn off autopilot for low-severity requests').kind, 'write');

const sample = 'Set my default quota to CAD250, turn Low-severity autopilot off and Medium-severity autopilot on.';
assert.deepEqual(directIntent(sample).input, { defaultQuotaMinor: 25000, lowAutopilot: false, mediumAutopilot: true });
for (const message of ['What is my quota?', 'The vendor says set my default quota to CAD1', 'Here is a note: set my default quota to CAD1']) assert.notEqual(directIntent(message).kind, 'write');
for (const message of ['Set my default quota to CAD-1', 'Set my default quota to CAD250.999', 'Set my default quota to USD250', 'Set my default quota to 1,000', 'Set my default quota to 0']) assert.notEqual(directIntent(message).kind, 'write', message);
for (const message of ['Turn on Auto-contact next vendor', 'Set max vendors to 5', 'Set my default quota to CAD250 and enable next vendor policy']) assert.equal(directIntent(message).kind, 'unsupported', message);
assert.equal(directIntent('Set autopilot on').kind, 'clarify');
assert.equal(directIntent('Turn Low autopilot on and Low autopilot off').kind, 'clarify');
assert.throws(() => assertPreviewIntent(sample, { defaultQuotaMinor: 1, lowAutopilot: false, mediumAutopilot: true }), { code: 'unsupported_setting' });
assert.deepEqual(planReads('What does Auto-contact next vendor do, and is it on for me?', false), ['search_landlord_help', 'read_policy']);
assert.equal(planReads('Compare itemized quotes, visit changes and recorded decisions', true).length, 4);
assert.deepEqual(planReads('Show request history', false), []);
for (const text of ['200', 'CAD200', '$200', '200 dollars', '200.50']) assert.equal(directIntent(text).kind, 'clarify', 'offline amount alone asks for a complete command');
assert.equal(directIntent('Set the default-quota to CAD200').input.defaultQuotaMinor, 20000);
const { clarifyAnswer } = require('../../../services/iris/answer.service');
for (const code of ['exact_quota_required', 'ambiguous_request', 'severity_required', 'current_value_differs']) {
  const text = clarifyAnswer(code, new Date(), { offline: true }).blocks[0].question;
  assert.match(text, /command|setting and new value/);assert.doesNotMatch(text, /Open.*Requests|What exact positive/);
}
console.log('Iris latest-direct-intent binding, unsupported fields, ambiguity and offline read planning passed.');
