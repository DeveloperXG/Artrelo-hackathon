'use strict';
// Owner-only, one-shot, no-key operator. Never starts the application/provider.
const path = require('node:path');
const { MongoClient } = require('mongodb');
const publicInput = require('./judge-sandbox.cjs');
const live = require('../services/judgeSandbox/liveOperatorInput.service');
const protocols = require('../services/judgeSandbox/liveProtocol.service');
const recovery = require('../services/judgeSandbox/liveLaneRecovery.service');
const { hash } = require('../services/judgeSandbox/contract.service');
const root = path.resolve(__dirname, '../..');
function argsOf(argv) {
  const isTest = argv[0] === 'release-test-pair5', isRecording = argv[0] === 'release-recording';
  const waived = isRecording && argv[7] === '--pair5-waiver-ref';
  if ((!isTest && !isRecording) || argv.length !== (isTest ? 8 : 10) || argv[1] !== '--protocol' ||
      argv[3] !== '--approval-ref' || argv[5] !== '--prior-app-pids' || argv.at(-1) !== '--apply' ||
      argv[4] !== (isTest ? 'msg_6c44a602a73b' : 'msg_dacfd06dda9c') ||
      !isTest && (waived ? argv[8] !== 'msg_bfba169914d8' : argv[7] !== '--accepted-pair5-ref' || !/^msg_[a-f0-9]{12}$/.test(argv[8] || '')))
    throw Error('EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED');
  if (!/^[1-9]\d*,[1-9]\d*$/.test(argv[6] || '')) throw Error('EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED');
  const priorPids = argv[6].split(',').map(Number);
  if (new Set(priorPids).size !== 2 || priorPids.some(pid => !Number.isSafeInteger(pid) || pid > 2147483647)) throw Error('EXACT_RECORDING_RECOVERY_COMMAND_REQUIRED');
  const protocolPath = path.resolve(argv[2]);
  if (protocolPath !== path.join(root, 'docs/iris-hackathon', isTest ? 'test-rehearsal-b-protocol.json' : 'pair1-recording-protocol.json'))
    throw Error('EXACT_RECORDING_PROTOCOL_PATH_REQUIRED');
  return { protocolPath, approvalRef: argv[4], isTest, priorPids, acceptanceRef: isTest || waived ? null : argv[8], waiverRef: waived ? argv[8] : null };
}
async function main(argv) {
  const args = argsOf(argv);
  const source = live.sourceState(); // committed/clean backend+frontend required
  const publicProtocol = publicInput.readPublicJson(args.protocolPath);
  const manifest = publicInput.readPublicJson(path.join(root, 'docs/iris-hackathon/judge-rehearsal-manifest.json'));
  const validated = live.checkProtocol(publicProtocol, { options: { database: publicProtocol.realm }, manifest }, source);
  if (validated.phase !== (args.isTest ? 'test-rehearsal-b' : 'recording') || validated.allowedOrdinals.join() !== (args.isTest ? '5' : '1')) throw Error('RECORDING_PAIR1_ONLY');
  const exitProof = recovery.verifyPriorRuntimeExit(new Date(), args.priorPids);
  const client = new MongoClient('mongodb://127.0.0.1:27128/?replicaSet=artreloIrisTests',
    { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 10000 });
  try {
    await client.connect();
    const app = client.db(publicProtocol.realm), control = client.db(protocols.CONTROL_DATABASE);
    const pair = await app.collection('judgesandboxpairs').findOne({ ordinal: args.isTest ? 5 : 1, active: true },
      { projection: { ordinal: 1, active: 1, fixtureVersion: 1 } });
    const seed = await app.collection('judgesandboxseeds').findOne({ _id: 'judge-core-v1' },
      { projection: { state: 1, manifestHash: 1 } });
    if (!pair || pair.fixtureVersion !== hash(manifest) || seed?.state !== 'ready' || seed.manifestHash !== hash(manifest))
      throw Error('READY_PAIR1_REQUIRED');
    const binding = protocols.resolveBinding(validated, [pair]);
    // Recheck exit after DB preparation, before committing an auditable exception.
    const freshExit = recovery.verifyPriorRuntimeExit(new Date(), args.priorPids);
    const service = recovery.createLiveLaneRecovery({ connection: { name: protocols.CONTROL_DATABASE, db: control, getClient: () => client } });
    const result = await service[args.isTest ? 'releaseTestPair5' : 'releaseRecording']({ protocol: binding,
      approvalRef: args.approvalRef, acceptanceRef: args.acceptanceRef, waiverRef: args.waiverRef, exitProof: freshExit });
    process.stdout.write(JSON.stringify({ ...result, source, oldRuntimeExitVerified: exitProof.absent && freshExit.absent,
      appRuntimeStarted: false, providerCalls: 0, keyRead: false }) + '\n');
  } finally { await client.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  const code = /^(?:LIVE_RECOVERY_[A-Z_]+|EXACT_RECORDING_[A-Z_]+|INVALID_FROZEN_LIVE_PROTOCOL|LIVE_SOURCE_NOT_FROZEN|READY_PAIR1_REQUIRED|RECORDING_PAIR1_ONLY)$/.test(error?.code || error?.message || '')
    ? error.code || error.message : 'RECORDING_RECOVERY_FAILED';
  process.stderr.write(JSON.stringify({ status: 'RECORDING_RECOVERY_REFUSED', code, secretsPrinted: false }) + '\n');process.exitCode = 1;
});
module.exports = { argsOf, main };
