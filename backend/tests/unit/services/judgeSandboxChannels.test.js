const assert = require('assert/strict');
const guard = require('../../../services/judgeSandbox/offlineGuard.service');
guard.installOfflineSandbox({ database: 'artrelo_judge_channels_test', frontendOrigin: 'http://127.0.0.1:3143' });
(async () => {
  const before = console.log, output = [];
  let result;
  try { console.log = (...args) => output.push(args);result = await require('../../../services/notification/email.service').sendEmail({
    to: 'not-sent@example.invalid', subject: 'Synthetic', text: 'Not sent', previewUrl: 'http://127.0.0.1:3143/vendor-job/INERT_TEST_SECRET' }); }
  finally { console.log = before; }
  assert.equal(result.delivered, false);assert.equal(result.provider, 'disabled');assert.notEqual(result.stub, true);
  assert.deepEqual(output, [], 'neither destination nor capability link reaches dev-stub logs');
  assert.equal(guard.inAppOnly(), true);assert.equal(guard.isOfflineGuardProof({ mode: 'offline_judge_core' }), false);
  console.log('PASS offline channel guard: no send, no dev-stub delivery claim and no bearer-link logs.');
})().catch(e => { console.error(e);process.exitCode = 1; });
