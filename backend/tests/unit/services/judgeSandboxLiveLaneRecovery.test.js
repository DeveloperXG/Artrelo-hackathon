'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
let observation = { processIds: [], ports: [] }, inspectFailed = false;
const original = cp.execFileSync;
cp.execFileSync = (file, argv, options) => {
  assert.equal(file, 'powershell.exe');assert(options.windowsHide);
  assert(argv.includes('-NonInteractive'));assert(!argv.join(' ').includes('CommandLine'));
  if (inspectFailed) throw Error('INERT_PROCESS_READ_FAILURE');
  return JSON.stringify(observation);
};
const { verifyPriorRuntimeExit, createLiveLaneRecovery } = require('../../../services/judgeSandbox/liveLaneRecovery.service');
const operator = require('../../../scripts/judge-live-recovery.cjs');
const protocols = require('../../../services/judgeSandbox/liveProtocol.service');
const policy = require('../../../services/judgeSandbox/liveBudgetPolicy.service');
const now = new Date('2026-11-04T08:00:00.000Z');
function recording(changes = {}) {
  const input = { version: 1, phase: 'recording', campaignId: 'iris-recording-20261104-v1', campaignAuthorizationRef: 'msg_4ea009b43c0b',
    goRef: 'msg_aaaaaaaaaaaa', realm: policy.TEST_PLAN.realm, manifestHash: 'c'.repeat(64), backendTree: 'a'.repeat(40), frontendTree: 'b'.repeat(40),
    allowedOrdinals: [1], rates: { ...protocols.RATES }, ratesVerifiedAt: '2026-11-04T07:00:00.000Z', expiresAt: policy.EXPIRES_AT, ...changes };
  const valid = protocols.validateProtocol(input, { database: input.realm, manifestHash: input.manifestHash,
    backendTree: input.backendTree, frontendTree: input.frontendTree, now });
  return protocols.resolveBinding(valid, [{ ordinal: input.allowedOrdinals[0], active: true,
    _id: input.allowedOrdinals[0] === 1 ? '6ae8e1dcbbeb8e11afb110de' : 'inert-other-pair-reference' }]);
}
const proof = verifyPriorRuntimeExit(now);
assert(Object.isFrozen(proof));assert(proof.absent);
for (const value of [{ processIds: [25980], ports: [] }, { processIds: [], ports: [8028] }, {}, { processIds: 'none', ports: [] }]) {
  observation = value;assert.throws(() => verifyPriorRuntimeExit(now), /LIVE_RECOVERY_EXIT_UNVERIFIED/);
}
observation = { processIds: [], ports: [] };inspectFailed = true;
assert.throws(() => verifyPriorRuntimeExit(now), /LIVE_RECOVERY_EXIT_UNVERIFIED/);inspectFailed = false;
let transactions = 0;
const service = createLiveLaneRecovery({ connection: { name: 'artrelo_judge_budget_control_unit_test', db: { collection: () => ({}) },
  getClient: () => ({ startSession: () => { transactions++;throw Error('MUST_NOT_OPEN_TRANSACTION'); } }) }, now: () => now });
const request = { protocol: recording(), approvalRef: 'msg_dacfd06dda9c', exitProof: proof, acceptanceRef: 'msg_cccccccccccc' };
async function main() {
  for (const changes of [{ approvalRef: 'msg_000000000001' }, { exitProof: { ...proof } }, { protocol: { ...request.protocol } },
    { protocol: recording({ campaignId: 'other-recording-campaign' }) }, { protocol: recording({ allowedOrdinals: [2] }) },
    { protocol: recording({ phase: 'judge' }) }, { protocol: recording({ goRef: 'msg_dacfd06dda9c' }) }])
    await assert.rejects(service.releaseRecording({ ...request, ...changes }), /LIVE_RECOVERY_NOT_AUTHORIZED/);
  const waiverRef = 'msg_bfba169914d8';
  for (const changes of [{ waiverRef: 'msg_000000000001', acceptanceRef: null }, { waiverRef },
    { waiverRef, acceptanceRef: null, protocol: recording({ goRef: waiverRef }) },
    { waiverRef, acceptanceRef: null, exitProof: { ...proof } },
    { waiverRef, acceptanceRef: null, protocol: { ...request.protocol } }])
    await assert.rejects(service.releaseRecording({ ...request, ...changes }), /LIVE_RECOVERY_NOT_AUTHORIZED/);
  const stale = createLiveLaneRecovery({ connection: { name: 'artrelo_judge_budget_control_unit_test', db: { collection: () => ({}) },
    getClient: () => ({ startSession: () => { transactions++;throw Error('MUST_NOT_OPEN_TRANSACTION'); } }) }, now: () => new Date(now.getTime() + 60001) });
  await assert.rejects(stale.releaseRecording(request), /LIVE_RECOVERY_NOT_AUTHORIZED/);
  assert.equal(transactions, 0);
  assert.throws(() => createLiveLaneRecovery({ connection: { name: 'production', db: {}, getClient: () => ({ startSession() {} }) } }), /ISOLATED_BUDGET_DATABASE_REQUIRED/);
  const protocolPath = require('node:path').resolve(__dirname, '../../../../docs/iris-hackathon/pair1-recording-protocol.json');
  const validArgs = ['release-recording', '--protocol', protocolPath, '--approval-ref', 'msg_dacfd06dda9c',
    '--prior-app-pids','25980,12372','--accepted-pair5-ref','msg_cccccccccccc','--apply'];
  assert.equal(operator.argsOf(validArgs).approvalRef, 'msg_dacfd06dda9c');
  const waivedArgs = validArgs.map((value, index) => index === 7 ? '--pair5-waiver-ref' : index === 8 ? waiverRef : value);
  assert.equal(operator.argsOf(waivedArgs).waiverRef, waiverRef);
  assert.equal(operator.argsOf(waivedArgs).acceptanceRef, null);
  assert.throws(() => operator.argsOf(waivedArgs.map(value => value === waiverRef ? 'msg_000000000001' : value)), /EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED/);
  assert.throws(() => operator.argsOf([...waivedArgs, '--accepted-pair5-ref', 'msg_cccccccccccc']), /EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED/);
  for (const args of [[], validArgs.slice(0, -1), [...validArgs, '--force'], validArgs.map(x => x === 'msg_dacfd06dda9c' ? 'msg_000000000001' : x)])
    assert.throws(() => operator.argsOf(args), /EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED/);
  console.log('PASS recording-only recovery refuses active/unverifiable processes, forged/stale proof, wrong owner/GO/protocol/pair/category, production DB and implicit/operator force paths before any transaction. No provider, real DB or key.');
}
main().catch(error => { console.error(error);process.exitCode = 1; }).finally(() => { cp.execFileSync = original; });
