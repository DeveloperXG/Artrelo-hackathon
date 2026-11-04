'use strict';
const assert = require('node:assert/strict'), { PassThrough, Readable } = require('node:stream');
const { spawnSync } = require('node:child_process'), path = require('node:path');
const rules = require('../../../services/judgeSandbox/operatorInput.service');
const { hiddenInput, confirmedInput } = require('../../../services/judgeSandbox/hiddenInput.service');
const operator = require('../../../scripts/judge-sandbox.cjs');
const manifest = { version: 1, authorizationRef: 'unit-inert-operator', assignedPairs: 8, sparePairs: 2,
  initialPolicy: { defaultQuotaMinor: 25000, lowAutopilot: true, mediumAutopilot: true, autoContact: true, maxVendors: 3, quoteClarification: true }, syntheticOpeningWalletMinor: 100000 };
const roster = { version: 1, pairs: Array.from({ length: 10 }, (_, i) => ({ ordinal: i + 1, landlordEmail: `landlord${i + 1}@artrelo.judge`, tenantEmail: `tenant${i + 1}@artrelo.judge` })) };
const signing = { access: 'inert-access-value-'.repeat(3), refresh: 'inert-refresh-value-'.repeat(3), session: 'inert-session-value-'.repeat(3) };
const credentials = roster.pairs.map(row => ({ ordinal: row.ordinal, landlord: 'inert-landlord-password', tenant: 'inert-tenant-password' }));
const envelope = { version: 1, options: { mode: 'setup', database: 'artrelo_judge_operator_unit_test', frontendOrigin: 'http://127.0.0.1:3143', port: 8033 }, manifest, roster, signing, credentials };
function tty() {
  const input = new PassThrough(), output = new PassThrough();let written = '';
  input.isTTY = output.isTTY = true;input.isRaw = false;input.setRawMode = flag => { input.isRaw = flag; };
  output.on('data', chunk => { written += chunk; });return { input, output, text: () => written };
}
async function main() {
  rules.validateEnvelope(envelope);
  for (const mutate of [x => { x.credentials[0].landlord = 'short'; }, x => { x.signing.session = x.signing.access; }, x => { x.roster.pairs[0].tenantEmail = 'other@artrelo.judge'; },
    x => { x.options.database = 'production'; }, x => { x.options.frontendOrigin = 'https://external.invalid'; }, x => { x.credentials[0].passwordHint = 'forbidden'; }, x => { x.extra = 'forbidden'; }]) {
    const bad = structuredClone(envelope);mutate(bad);assert.throws(() => rules.validateEnvelope(bad));
  }
  const serve = { ...envelope, options: { ...envelope.options, mode: 'serve' }, credentials: null };
  rules.validateEnvelope(serve);assert.throws(() => rules.validateEnvelope({ ...serve, credentials }), /SERVE_PASSWORDS_REFUSED/);
  const binding = rules.bindingFor(envelope);
  assert(rules.matchesBinding(binding, rules.bindingFor(serve)));
  assert(!rules.matchesBinding(binding, rules.bindingFor({ ...serve, signing: { ...signing, access: signing.access + 'different' } })));
  assert(!rules.matchesBinding(null, binding));assert(!rules.matchesBinding({ ...binding, signingFingerprint: 'x' }, binding));
  assert.equal(rules.safeError({ message: signing.access, code: signing.refresh }), 'OPERATOR_FAILED');
  assert.equal(rules.safeError({ code: 'SECRET_CONFIRMATION_MISMATCH' }), 'SECRET_CONFIRMATION_MISMATCH');
  const validArgs = ['setup','--database',envelope.options.database,'--manifest','docs/iris-hackathon/public.json','--roster','docs/iris-hackathon/roster.json','--frontend',envelope.options.frontendOrigin];
  assert.equal(operator.argsOf(validArgs).options.mode, 'setup');
  for (const extra of [['--private-file','logs/judge-private/held.json'], ['--password',signing.access], ['--database','production']]) assert.throws(() => operator.argsOf(validArgs.concat(extra)));
  assert.throws(() => operator.readPublicJson(path.resolve(__dirname,'../../../../logs/judge-private/held.json')), /INVALID_PUBLIC_INPUT_FILE/);
  assert(!Object.keys(operator.safeChildEnv()).some(key => /SECRET|TOKEN|API_KEY|NODE_OPTIONS/.test(key)));
  const root = path.resolve(__dirname,'../../../..');
  const parsedArgs = operator.argsOf(['setup','--database',envelope.options.database,'--manifest',path.join(root,'backend/tests/fixtures/judge-operator-manifest.json'),
    '--roster',path.join(root,'docs/iris-hackathon/judge-public-roster.json'),'--frontend',envelope.options.frontendOrigin]);
  const answers = [...Object.values(signing), ...credentials.flatMap(row => [row.landlord,row.tenant])];let prompts = 0;
  const collected = await operator.collectEnvelope(parsedArgs, { prompt: async () => answers[prompts++] });
  assert.equal(prompts,23);assert.equal(collected.credentials.length,10);
  prompts = 0;const serveCollected = await operator.collectEnvelope({ ...parsedArgs, options: { ...parsedArgs.options, mode: 'serve' } }, { prompt: async () => Object.values(signing)[prompts++] });
  assert.equal(prompts,3);assert.equal(serveCollected.credentials,null);
  await assert.rejects(operator.collectEnvelope(parsedArgs, { prompt: async () => { throw rules.fail('SECRET_CONFIRMATION_MISMATCH'); } }), /SECRET_CONFIRMATION_MISMATCH/);
  const parsed = await rules.readEnvelope(Readable.from([Buffer.from(JSON.stringify(envelope).slice(0, 80)), Buffer.from(JSON.stringify(envelope).slice(80))]));
  assert.equal(parsed.credentials.length, 10);
  await assert.rejects(rules.readEnvelope(Readable.from([Buffer.alloc(rules.MAX_PIPE_BYTES + 1)])), /PIPE_INPUT_TOO_LARGE/);
  await assert.rejects(rules.readEnvelope(Readable.from([Buffer.from(signing.access)])), /INVALID_PIPE_INPUT/);
  await assert.rejects(hiddenInput('Secret: ', { input: new PassThrough(), output: new PassThrough() }), /HIDDEN_TTY_REQUIRED/);
  const a = tty(), p = hiddenInput('Secret: ', a);a.input.write('private-erase\x15correct-value\x7f!\r');assert.equal(await p, 'correct-valu!');
  assert.equal(a.text(), 'Secret: \n');assert.equal(a.input.isRaw, false);assert.equal(a.input.listenerCount('data'), 0);
  for (const [chars, code] of [['\x03','SECRET_INPUT_CANCELLED'],['abc\nsecond','MULTILINE_SECRET_INPUT_REFUSED'],['a'.repeat(257),'SECRET_INPUT_TOO_LONG']]) {
    const mock = tty(), result = hiddenInput('Secret: ', mock);mock.input.write(chars);await assert.rejects(result, { code });assert.equal(mock.text(), 'Secret: \n');assert.equal(mock.input.isRaw, false);
  }
  const b = tty(), confirmation = confirmedInput('Value', b);b.input.write('first-value\r');await new Promise(resolve => setImmediate(resolve));b.input.write('different-value\r');
  await assert.rejects(confirmation, /SECRET_CONFIRMATION_MISMATCH/);assert(!b.text().includes('first-value'));assert(!b.text().includes('different-value'));
  const runtimePath = path.resolve(__dirname,'../../../scripts/judge-sandbox-runtime.cjs');
  const invalid = spawnSync(process.execPath, [runtimePath], { input: signing.access, encoding: 'utf8', windowsHide: true, timeout: 10000, env: operator.safeChildEnv() });
  assert.equal(invalid.status, 1);assert(!invalid.stdout.includes(signing.access) && !invalid.stderr.includes(signing.access));
  assert.equal(JSON.parse(invalid.stderr.trim()).code, 'INVALID_PIPE_INPUT');
  console.log('PASS no-file operator: strict anonymous inputs, no private-file/secret argv, bound signing, non-echo TTY/edit/cancel/mismatch cleanup and redacted subprocess errors.');
}
main().catch(() => { console.error('FAIL no-file operator unit checks (details suppressed to protect test secret canaries)');process.exitCode = 1; });
