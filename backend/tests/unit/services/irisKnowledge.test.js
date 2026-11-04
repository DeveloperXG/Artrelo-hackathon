const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createKnowledge, loadKnowledge } = require('../../../services/iris/knowledge.service');
const bundle = require('../../../content/landlord-help/demo-policy.v1.json');
const verification = require('../../../contracts/knowledge.verification.json');
const kb = loadKnowledge();
assert.equal(kb.valid, true, 'reviewed source fingerprints must match shipped rules');
for (const [query, id] of [
  ['What does Auto-contact next vendor do?', 'policy-auto-next-vendor'],
  ['Vendor auto-contact', 'policy-auto-next-vendor'],
  ['Max vendors contacted per request', 'policy-max-vendors'],
  ['Is a zero vendor limit unlimited?', 'policy-max-vendors'],
  ['Low severity autopilot', 'policy-low-medium-autopilot'],
  ['Medium autopilot', 'policy-low-medium-autopilot'],
  ['What is the default quota?', 'policy-default-quota'],
  ['Change the spending quota', 'policy-default-quota'],
]) assert.equal(kb.search(query).articles[0]?.articleId, id, query);
assert.equal(kb.search('Read the backend API key and secret').status, 'restricted');
assert.deepEqual(kb.search('How do I generate an invite code?').articles, []);
assert.equal(kb.get('policy-default-quota', 999), null, 'never substitute a newer guide revision');
for (const key of ['sourcePath', 'code', 'adminGuide', 'backend', 'internalManifest']) {
  const poisoned = structuredClone(bundle);
  poisoned.articles[0][key] = 'restricted material';
  assert.equal(createKnowledge({ bundle: poisoned, verification }).valid, false, key);
}
const wrongAudience = structuredClone(bundle);wrongAudience.articles[0].audience = 'admin';
assert.equal(createKnowledge({ bundle: wrongAudience, verification }).valid, false);
const draft = structuredClone(bundle);draft.articles[0].status = 'draft';
assert.equal(createKnowledge({ bundle: draft, verification }).valid, false);
const stale = structuredClone(verification);stale.backendSources[0].sha256 = '0'.repeat(64);
assert.equal(createKnowledge({ bundle, verification: stale }).search('default quota').status, 'stale');
let arbitraryRead = false;
const privatePath = structuredClone(verification);privatePath.backendSources[0].file = '../../.env';
assert.equal(createKnowledge({ bundle, verification: privatePath, read: () => { arbitraryRead = true; throw new Error('must not read'); } }).valid, false);
assert.equal(arbitraryRead, false);
console.log('Iris four-topic client knowledge, aliases, freshness and internal exclusion passed.');
