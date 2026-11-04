'use strict';
// Exact one-shot public operator: no application bootstrap or private inputs.
const path = require('node:path');
const { MongoClient } = require('mongodb');
const publicInput = require('./judge-sandbox.cjs');
const live = require('../services/judgeSandbox/liveOperatorInput.service');
const protocols = require('../services/judgeSandbox/liveProtocol.service');
const recovery = require('../services/judgeSandbox/liveLaneRecovery.service');
const contract = require('../contracts/judgeSandboxFreshRecording.v1.json');
const root = path.resolve(__dirname, '../..');
function argsOf(argv) {
  if (argv.length !== 8 || argv[0] !== 'release-recording-pair7' || argv[1] !== '--protocol' ||
      argv[3] !== '--approval-ref' || argv[4] !== contract.approvalRef || argv[5] !== '--prior-app-pids' || argv[7] !== '--apply' ||
      !/^[1-9]\d*,[1-9]\d*$/.test(argv[6] || '')) throw Error('EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED');
  const priorPids = argv[6].split(',').map(Number);
  if (new Set(priorPids).size !== 2 || priorPids.some(pid => !Number.isSafeInteger(pid) || pid > 2147483647)) throw Error('EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED');
  const protocolPath = path.resolve(argv[2]);
  if (protocolPath !== path.join(root, 'docs/iris-hackathon/pair7-recording-protocol.json')) throw Error('EXACT_RECORDING_PROTOCOL_PATH_REQUIRED');
  return { protocolPath, priorPids, approvalRef: argv[4] };
}
async function main(argv) {
  const args = argsOf(argv), source = live.sourceState();
  const input = publicInput.readPublicJson(args.protocolPath);
  const manifest = publicInput.readPublicJson(path.join(root, 'docs/iris-hackathon/judge-rehearsal-manifest.json'));
  const p = live.checkProtocol(input, { options: { database: contract.realm }, manifest }, source);
  if (p.phase !== 'recording' || p.allowedOrdinals.join() !== '7' || p.campaignId !== contract.campaignId) throw Error('LIVE_RECOVERY_NOT_AUTHORIZED');
  recovery.verifyPriorRuntimeExit(new Date(), args.priorPids);
  const client = new MongoClient('mongodb://127.0.0.1:27128/?replicaSet=artreloIrisTests',
    { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 10000 });
  try {
    await client.connect();
    const pair = await client.db(contract.realm).collection('judgesandboxpairs').findOne({ ordinal: 7, active: true },
      { projection: { ordinal: 1, active: 1 } });
    const binding = protocols.resolveBinding(p, pair ? [pair] : []);
    const exitProof = recovery.verifyPriorRuntimeExit(new Date(), args.priorPids);
    const service = recovery.createLiveLaneRecovery({ connection: { name: protocols.CONTROL_DATABASE,
      db: client.db(protocols.CONTROL_DATABASE), getClient: () => client } });
    const result = await service.releaseFreshRecording({ protocol: binding, approvalRef: args.approvalRef, exitProof });
    process.stdout.write(JSON.stringify({ ...result, source, appRuntimeStarted: false, keyRead: false }) + '\n');
  } finally { await client.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  const value = error?.code || error?.message || '';
  const code = /^(?:LIVE_RECOVERY_[A-Z_]+|EXACT_RECORDING_[A-Z_]+|INVALID_FROZEN_LIVE_PROTOCOL|LIVE_SOURCE_NOT_FROZEN|LIVE_PROTOCOL_PAIR_MISMATCH)$/.test(value)
    ? value : 'RECORDING_RECOVERY_FAILED';
  process.stderr.write(JSON.stringify({ status: 'RECORDING_RECOVERY_REFUSED', code, secretsPrinted: false }) + '\n'); process.exitCode = 1;
});
module.exports = { argsOf, main };
