'use strict';
const assert = require('node:assert/strict'), cp = require('node:child_process'), path = require('node:path');
const original = cp.execFileSync;
let observed = { epochNodeIds: [], ports: [] };
cp.execFileSync = () => JSON.stringify(observed);
const recovery = require('../../../services/judgeSandbox/recordingRetake.service');
const protocols = require('../../../services/judgeSandbox/liveProtocol.service');
const rules = require('../../../contracts/judgeSandboxRecordingRetake.v1.json');
const operator = require('../../../scripts/judge-recording-retake.cjs');
const now = new Date('2026-11-04T21:10:00.000Z'), proof = recovery.verifyRetakeRuntimeExit(now);
let transactions = 0;
const connection = { name: protocols.CONTROL_DATABASE, db: { collection: () => ({}) }, getClient: () => ({
  startSession() { transactions++;throw Error('UNEXPECTED_TRANSACTION'); } }) };
function binding(changes = {}, pairRef = rules.pairRef) {
  const input = { version: 1, phase: 'recording', campaignId: rules.campaignId, campaignAuthorizationRef: rules.authorizationRef,
    goRef: 'msg_aaaaaaaaaaaa', realm: rules.realm, manifestHash: 'c'.repeat(64), backendTree: 'a'.repeat(40), frontendTree: 'b'.repeat(40),
    allowedOrdinals: [8], rates: { ...protocols.RATES }, ratesVerifiedAt: '2026-11-04T20:00:00.000Z', expiresAt: rules.expiresAt, ...changes };
  return protocols.resolveBinding(protocols.validateProtocol(input, { database: input.realm, manifestHash: input.manifestHash,
    backendTree: input.backendTree, frontendTree: input.frontendTree, now }), input.allowedOrdinals.map(ordinal => ({ _id: pairRef, ordinal, active: true })));
}
async function main() {
  const service = recovery.createRecordingRetake({ connection, now: () => now });
  const request = { protocol: binding(), approvalRef: rules.approvalRef, exitProof: proof };
  for (const patch of [{ approvalRef: rules.previousGoRef },{ exitProof: { ...proof } },{ protocol: { ...request.protocol } },
    { protocol: binding({},rules.previousPairRef) },{ protocol: binding({ phase: 'judge' }) },
    { protocol: binding({ campaignId: 'inert-foreign-recording' }) },{ protocol: binding({ campaignAuthorizationRef: 'msg_bbbbbbbbbbbb' }) },
    { protocol: binding({ allowedOrdinals: [7] },rules.previousPairRef) },{ force: true },
    ...[rules.approvalRef,rules.previousGoRef,rules.authorizationRef].map(goRef => ({ protocol: binding({ goRef }) }))])
    await assert.rejects(service.release({ ...request,...patch }), /LIVE_RETAKE_NOT_AUTHORIZED/);
  await assert.rejects(recovery.createRecordingRetake({ connection, now: () => new Date(now.getTime()+60001) }).release(request), /LIVE_RETAKE_NOT_AUTHORIZED/);
  assert.equal(transactions,0);
  for (const row of [{ epochNodeIds: [123],ports: [] },{ epochNodeIds: [],ports: [8028] },{ epochNodeIds: null,ports: [] }]) {
    observed = row;assert.throws(() => recovery.verifyRetakeRuntimeExit(now), /LIVE_RETAKE_EXIT_UNVERIFIED/);
  }
  const p = path.resolve(__dirname,'../../../../docs/iris-hackathon/pair8-recording-protocol.json');
  const args = ['release-recording-pair8','--protocol',p,'--approval-ref',rules.approvalRef,'--apply'];
  assert.equal(operator.argsOf(args).approvalRef,rules.approvalRef);
  for (const bad of [[],args.slice(0,-1),[...args,'--force'],args.map(x => x === p ? p.replace('pair8-','pair7-') : x)])
    assert.throws(() => operator.argsOf(bad), /EXACT_RETAKE_/);
  console.log('PASS retake authority: exact pair8/campaign/protocol/newGO, forged/stale epoch proof, live process/port and force/path refusal before transaction; no database/provider.');
}
main().catch(e => { console.error(e);process.exitCode=1; }).finally(() => { cp.execFileSync=original; });
