'use strict';
// Explicit operator: hidden TTY -> anonymous pipe -> child memory. No secret file.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const rules = require('../services/judgeSandbox/operatorInput.service');
const { confirmedInput } = require('../services/judgeSandbox/hiddenInput.service');
const root = path.resolve(__dirname, '../..');
function argsOf(argv) {
  const [mode, ...rest] = argv, args = {};
  if (!['setup','serve'].includes(mode) || rest.length % 2) throw rules.fail('INVALID_OPERATOR_ARGUMENT');
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--database','--manifest','--roster','--frontend','--port'].includes(rest[i]) || Object.hasOwn(args, rest[i])) throw rules.fail('INVALID_OPERATOR_ARGUMENT');
    args[rest[i]] = rest[i + 1];
  }
  if (!['--database','--manifest','--roster','--frontend'].every(key => args[key])) throw rules.fail('EXPLICIT_OPERATOR_INPUTS_REQUIRED');
  const options = { mode, database: args['--database'], frontendOrigin: args['--frontend'], port: Number(args['--port'] || 8026) };
  rules.validateOptions(options);
  return { options, manifestPath: path.resolve(args['--manifest']), rosterPath: path.resolve(args['--roster']) };
}
function readPublicJson(file) {
  const permitted = [path.join(root, 'docs','iris-hackathon'), path.join(root,'backend','tests','fixtures')];
  const inside = candidate => permitted.some(dir => candidate.startsWith(dir + path.sep));
  if (!inside(file)) throw rules.fail('INVALID_PUBLIC_INPUT_FILE');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536 || !inside(fs.realpathSync(file))) throw rules.fail('INVALID_PUBLIC_INPUT_FILE');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw rules.fail('INVALID_PUBLIC_INPUT_FILE'); }
}
async function collectEnvelope(parsed, { prompt = confirmedInput } = {}) {
  const manifest = require('../services/judgeSandbox/fixture.service').validateManifest(readPublicJson(parsed.manifestPath));
  const roster = rules.validateRoster(readPublicJson(parsed.rosterPath), manifest.assignedPairs + manifest.sparePairs);
  const signing = {};
  for (const name of ['access','refresh','session']) signing[name] = await prompt('Signing secret ' + name, { maxBytes: 256 });
  rules.validateSigning(signing);
  let credentials = null;
  if (parsed.options.mode === 'setup') {
    credentials = [];
    for (const row of roster.pairs) credentials.push({ ordinal: row.ordinal,
      landlord: await prompt(row.landlordEmail + ' password', { maxBytes: 72 }),
      tenant: await prompt(row.tenantEmail + ' password', { maxBytes: 72 }) });
  }
  return rules.validateEnvelope({ version: 1, options: parsed.options, manifest, roster, signing, credentials });
}
function safeChildEnv() {
  return Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(key => typeof process.env[key] === 'string')
    .map(key => [key, process.env[key]]).concat([['NODE_ENV','test']]));
}
async function launch(envelope) {
  rules.validateEnvelope(envelope);
  const child = spawn(process.execPath, [path.join(__dirname,'judge-sandbox-runtime.cjs')], {
    cwd: path.join(root,'backend'), env: safeChildEnv(), stdio: ['pipe','inherit','inherit','ipc'], windowsHide: true
  });
  let stopRequested = false;
  const stop = () => { if (!stopRequested && child.connected) { stopRequested = true;child.send({ type: 'shutdown' }); } };
  process.once('SIGINT', stop);process.once('SIGTERM', stop);
  let bytes;
  try {
    bytes = Buffer.from(JSON.stringify(envelope));child.stdin.on('error', () => {});
    child.stdin.end(bytes, () => { bytes.fill(0);envelope.signing = null;envelope.credentials = null; });
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(rules.fail('OPERATOR_CHILD_FAILED')));
      child.once('exit', code => { if (code === 0) resolve(0);else reject(rules.fail('OPERATOR_CHILD_FAILED')); });
    });
  } finally {
    if (bytes) bytes.fill(0);envelope.signing = null;envelope.credentials = null;
    process.off('SIGINT', stop);process.off('SIGTERM', stop);
  }
}
async function main(argv) { return launch(await collectEnvelope(argsOf(argv))); }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ status: 'SANDBOX_OPERATOR_FAILED', code: rules.safeError(error), secretsPrinted: false }) + '\n');process.exitCode = 1;
});
module.exports = { argsOf, readPublicJson, collectEnvelope, safeChildEnv, launch, main };
