'use strict';
// Private child entry. Never imported by normal server; stdin only, no secret argv/env/file.
const { readEnvelope, bindingFor, matchesBinding, fail, safeError } = require('../services/judgeSandbox/operatorInput.service');
async function run(stream = process.stdin, emit = value => process.stdout.write(JSON.stringify(value) + '\n')) {
  const envelope = await readEnvelope(stream), { options, manifest, roster } = envelope;
  const manifestHash = require('../services/judgeSandbox/contract.service').hash(manifest), binding = bindingFor(envelope);
  const proof = require('../services/judgeSandbox/offlineGuard.service').installOfflineSandbox({ database: options.database, frontendOrigin: options.frontendOrigin, signingSecrets: envelope.signing });
  const mongoose = require('mongoose');let runtime, server, closing;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      if (runtime) await runtime.notifications.dispose();
      if (server) { server.closeAllConnections();await new Promise(resolve => server.close(resolve)); }
      await mongoose.disconnect();
    })();return closing;
  };
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
    const Seed = require('../models/JudgeSandboxSeed'), old = await Seed.findById('judge-core-v1').lean();
    if (options.mode === 'setup') {
      if (old) throw fail('EXISTING_FIXTURE_NO_RESET');
      const result = await require('../services/judgeSandbox/fixture.service').seedFixtures({ manifest, roster, operatorBinding: binding, credentialsForPair: async n => envelope.credentials[n - 1] });
      envelope.credentials = null;envelope.signing = null;
      emit({ status: 'OFFLINE_SYNTHETIC_FIXTURE_READY', database: options.database, pairCount: result.pairCount, credentialsPrinted: false, credentialFileCreated: false, realModelCalls: 0, realDelivery: false, realDeposits: 0 });
      await close();return { setupComplete: true };
    }
    if (old?.state !== 'ready' || old.manifestHash !== manifestHash || !old.operatorBinding) throw fail('READY_BOUND_FIXTURE_REQUIRED');
    if (!matchesBinding(old.operatorBinding, binding)) throw fail('SIGNING_OR_ROSTER_MISMATCH');
    envelope.signing = null;
    runtime = await require('../services/judgeSandbox/application.service').createSandboxApplication({ proof });
    await Promise.all(mongoose.modelNames().map(name => mongoose.model(name).init()));
    server = runtime.app.listen(options.port,'127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening',resolve);server.once('error',reject); });
    runtime.notifications.start();
    const shutdown = () => { void close().then(() => process.exit(0), () => process.exit(1)); };
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);process.once('disconnect',shutdown);
    process.on('message', message => { if (message && message.type === 'shutdown') shutdown(); });
    emit({ status: 'OFFLINE_SYNTHETIC_RUNTIME_READY', url: 'http://127.0.0.1:' + options.port, database: options.database, pairCount: old.pairCount,
      resetSupported: false, credentialFileUsed: false, realModelCalls: 0, realDelivery: false, realPayment: false });
  } catch (error) { await close();throw error; }
}
if (require.main === module) {
  const safeWrite = process.stdout.write.bind(process.stdout), safeErrorWrite = process.stderr.write.bind(process.stderr);
  // Do not forward arbitrary app/debug output through the operator terminal.
  process.stdout.write = process.stderr.write = () => true;
  console.log = console.warn = console.error = console.info = console.debug = () => {};
  const reportFailure = error => { safeErrorWrite(JSON.stringify({ status: 'SANDBOX_OPERATOR_FAILED', code: safeError(error), secretsPrinted: false }) + '\n');process.exitCode = 1; };
  let setupFinished = false;
  // Register before the first await: losing the parent during bootstrap must
  // not leave a newly listening child with private signing material behind.
  process.on('disconnect', () => {
    if (!setupFinished) { safeErrorWrite(JSON.stringify({ status: 'SANDBOX_OPERATOR_FAILED', code: 'OPERATOR_PARENT_DISCONNECTED', secretsPrinted: false }) + '\n');process.exit(1); }
  });
  process.on('unhandledRejection', reportFailure);
  process.on('uncaughtException', error => { reportFailure(error);process.exit(1); });
  run(process.stdin, value => safeWrite(JSON.stringify(value) + '\n')).then(result => {
    if (result?.setupComplete) { setupFinished = true;process.channel?.unref(); }
  }).catch(error => { reportFailure(error);process.channel?.unref(); });
}
module.exports = { run };
