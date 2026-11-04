'use strict';
// Exact public/no-key retake operator. Does not start a runtime or provider.
const path = require('node:path'), { MongoClient } = require('mongodb');
const input = require('./judge-sandbox.cjs'), live = require('../services/judgeSandbox/liveOperatorInput.service');
const protocols = require('../services/judgeSandbox/liveProtocol.service');
const recovery = require('../services/judgeSandbox/recordingRetake.service');
const contract = require('../contracts/judgeSandboxRecordingRetake.v1.json'), root = path.resolve(__dirname, '../..');
function argsOf(argv) {
  if (argv.length !== 6 || argv[0] !== 'release-recording-pair8' || argv[1] !== '--protocol' || argv[3] !== '--approval-ref' ||
      argv[4] !== contract.approvalRef || argv[5] !== '--apply') throw Error('EXACT_RETAKE_COMMAND_REQUIRED');
  const protocolPath = path.resolve(argv[2]);
  if (protocolPath !== path.join(root, 'docs/iris-hackathon/pair8-recording-protocol.json')) throw Error('EXACT_RETAKE_PROTOCOL_PATH_REQUIRED');
  return { protocolPath, approvalRef: argv[4] };
}
async function main(argv) {
  const args = argsOf(argv), source = live.sourceState();
  const manifest = input.readPublicJson(path.join(root, 'docs/iris-hackathon/judge-rehearsal-manifest.json'));
  const protocol = live.checkProtocol(input.readPublicJson(args.protocolPath), { options: { database: contract.realm }, manifest }, source);
  if (protocol.phase !== 'recording' || protocol.allowedOrdinals.join() !== '8' || protocol.campaignId !== contract.campaignId)
    throw Error('LIVE_RETAKE_NOT_AUTHORIZED');
  recovery.verifyRetakeRuntimeExit();
  const client = new MongoClient('mongodb://127.0.0.1:27128/?replicaSet=artreloIrisTests', {
    serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 10000 });
  try {
    await client.connect();
    const pair = await client.db(contract.realm).collection('judgesandboxpairs').findOne({ ordinal: 8, active: true },
      { projection: { ordinal: 1, active: 1 } });
    const binding = protocols.resolveBinding(protocol, pair ? [pair] : []), exitProof = recovery.verifyRetakeRuntimeExit();
    const service = recovery.createRecordingRetake({ connection: { name: protocols.CONTROL_DATABASE,
      db: client.db(protocols.CONTROL_DATABASE), getClient: () => client } });
    const result = await service.release({ protocol: binding, approvalRef: args.approvalRef, exitProof });
    process.stdout.write(JSON.stringify({ ...result, source, appRuntimeStarted: false, keyRead: false }) + '\n');
  } finally { await client.close(); }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  const value = error?.code || error?.message || '';
  const code = /^(?:LIVE_RETAKE_[A-Z_]+|EXACT_RETAKE_[A-Z_]+|INVALID_FROZEN_LIVE_PROTOCOL|LIVE_SOURCE_NOT_FROZEN|LIVE_PROTOCOL_PAIR_MISMATCH)$/.test(value)
    ? value : 'RETAKE_OPERATOR_FAILED';
  process.stderr.write(JSON.stringify({ status: 'RECORDING_RETAKE_REFUSED', code, secretsPrinted: false }) + '\n');process.exitCode = 1;
});
module.exports = { argsOf, main };
