'use strict';
const assert = require('node:assert/strict'), cp = require('node:child_process'), path = require('node:path');
const original = cp.execFileSync;
cp.execFileSync = () => JSON.stringify({ processIds: [], ports: [] });
const recovery = require('../../../services/judgeSandbox/liveLaneRecovery.service');
const protocols = require('../../../services/judgeSandbox/liveProtocol.service');
const fresh = require('../../../contracts/judgeSandboxFreshRecording.v1.json');
const operator = require('../../../scripts/judge-fresh-recording.cjs');
const now = new Date('2026-11-04T20:00:00.000Z');
const proof = recovery.verifyPriorRuntimeExit(now);
let transactions = 0;
const connection = { name: protocols.CONTROL_DATABASE, db: { collection: () => ({}) },
  getClient: () => ({ startSession() { transactions++; throw Error('UNEXPECTED_TRANSACTION'); } }) };
const service = recovery.createLiveLaneRecovery({ connection, now: () => now });
function bind(changes = {}, pairRef = fresh.pairRef) {
  const input = { version: 1, phase: 'recording', campaignId: fresh.campaignId, campaignAuthorizationRef: fresh.authorizationRef,
    goRef: 'msg_aaaaaaaaaaaa', realm: fresh.realm, manifestHash: 'c'.repeat(64), backendTree: 'a'.repeat(40), frontendTree: 'b'.repeat(40),
    allowedOrdinals: [7], rates: { ...protocols.RATES }, ratesVerifiedAt: '2026-11-04T19:00:00.000Z', expiresAt: fresh.expiresAt, ...changes };
  const validated = protocols.validateProtocol(input, { database: input.realm, manifestHash: input.manifestHash,
    backendTree: input.backendTree, frontendTree: input.frontendTree, now });
  return protocols.resolveBinding(validated, input.allowedOrdinals.map(ordinal => ({ _id: pairRef, ordinal, active: true })));
}
async function main() {
  const request = { protocol: bind(), approvalRef: fresh.approvalRef, exitProof: proof };
  for (const changes of [{ approvalRef: fresh.previousGoRef }, { exitProof: { ...proof } }, { protocol: { ...request.protocol } },
    { protocol: bind({}, fresh.previousPairRef) }, { protocol: bind({ campaignId: 'inert-other-recording' }) },
    { protocol: bind({ campaignAuthorizationRef: 'msg_bbbbbbbbbbbb' }) }, { protocol: bind({ phase: 'judge' }) },
    ...[fresh.approvalRef, fresh.previousGoRef, fresh.authorizationRef, 'msg_dacfd06dda9c', 'msg_bfba169914d8'].map(goRef => ({ protocol: bind({ goRef }) })),
    { force: true }]) await assert.rejects(service.releaseFreshRecording({ ...request, ...changes }), /LIVE_RECOVERY_NOT_AUTHORIZED/);
  const stale = recovery.createLiveLaneRecovery({ connection, now: () => new Date(now.getTime() + 60001) });
  await assert.rejects(stale.releaseFreshRecording(request), /LIVE_RECOVERY_NOT_AUTHORIZED/);
  assert.equal(transactions, 0);
  const p = path.resolve(__dirname, '../../../../docs/iris-hackathon/pair7-recording-protocol.json');
  const argv = ['release-recording-pair7', '--protocol', p, '--approval-ref', fresh.approvalRef, '--prior-app-pids', '82416,39020', '--apply'];
  assert.equal(operator.argsOf(argv).approvalRef, fresh.approvalRef);
  for (const args of [[], argv.slice(0, -1), [...argv, '--force'], argv.map(v => v === fresh.approvalRef ? fresh.previousGoRef : v),
    argv.map(v => v === '82416,39020' ? '1,1' : v), argv.map(v => v === p ? p.replace('pair7-', 'pair1-') : v)])
    assert.throws(() => operator.argsOf(args), /EXACT_RECORDING_/);
  console.log('PASS fresh recording authority: exact pair/protocol/campaign/GO/ref, forged/stale exit proof and extra/force/wrong-path arguments refuse before transaction. No live call or real database.');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { cp.execFileSync = original; });
