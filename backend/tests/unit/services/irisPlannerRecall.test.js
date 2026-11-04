// Existing6-turn/16KiB model-discussion promise, independent of display retention.
const assert=require('assert/strict');
const {modelContext}=require('../../../services/iris/planner.service');
const input=discussion=>({registry:{factsFor:()=>[],sources:new Map()},turnRef:'turn_test',message:'Explain this request.',discussion,requestRef:'req_opaque',origin:{contextKind:'request'}});
const sized=x=>Buffer.byteLength(JSON.stringify(x),'utf8');
const ascii=Array.from({length:10},(_,i)=>({human:i+':'+ 'a'.repeat(998),answerIntent:'read',confirmationToken:'must-not-copy'}));
let selected=modelContext(input(ascii)).earlierDiscussion;
assert.equal(selected.length,6);assert.ok(selected[0].human.startsWith('4:'));assert.ok(sized(selected)<=16384);assert.equal(JSON.stringify(selected).includes('must-not-copy'),false);
const dense=Array.from({length:10},(_,i)=>({human:i+':'+ '界'.repeat(998),answerIntent:'read'}));
selected=modelContext(input(dense)).earlierDiscussion;
assert.ok(sized(selected)<=16384,'Selected Unicode discussion, including wrappers, must obey existing16KiB UTF8 budget');
assert.equal(selected.length,5,'Drop oldest whole selected entry, not the newest or part of a human prompt');assert.ok(selected[0].human.startsWith('5:'));assert.ok(selected.at(-1).human.startsWith('9:'));
const escaped=Array.from({length:6},()=>({human:'\ud800'.repeat(1000),answerIntent:'read'}));
selected=modelContext(input(escaped)).earlierDiscussion;assert.ok(sized(selected)<=16384,'JSON escape expansion is part of serialized discussion bytes');assert.ok(selected.length<6);
assert.deepEqual(modelContext(input([])).earlierDiscussion,[]);
const privateText=[{human:'password: fixture-only-value',answerIntent:'unexpected',confirmationToken:'must-not-copy'}];
selected=modelContext(input(privateText)).earlierDiscussion;assert.equal(selected[0].answerIntent,'read');assert.equal(JSON.stringify(selected).includes('fixture-only-value'),false);assert.equal(JSON.stringify(selected).includes('must-not-copy'),false);
console.log('Iris model recall: newest<=6, serialized<=16KiB incl wrappers/UTF8/JSON escapes, no token fields, redaction and empty context PASS');
const focused = modelContext({ ...input([]), origin: { contextKind: 'account' }, policyDiscussion: {
  fields: ['defaultQuotaMinor'], precedingAct: 'clarification', confirmationToken: 'must-not-copy', rawTranscript: 'PRIVATE_ACCOUNT_TEXT', before: 30000,
} }).policyDiscussion;
assert.deepEqual(focused, { kind: 'untrusted_policy_discussion', scope: 'same_account_policy', fields: ['defaultQuotaMinor'], precedingAct: 'clarification', awaitingQuotaAmount: true });
assert.equal(modelContext({ ...input([]), policyDiscussion: { fields: ['approveSpend'], precedingAct: 'preview' } }).policyDiscussion, null);
assert.equal(JSON.stringify(focused).includes('PRIVATE_ACCOUNT_TEXT'), false);
