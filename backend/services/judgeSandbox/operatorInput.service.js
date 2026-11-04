'use strict';
// Non-HTTP, explicit operator input. No secret files, environment lookup or I/O.
const crypto = require('crypto');
const MAX_PIPE_BYTES = 32768;
const fail = code => Object.assign(new Error(code), { code });
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join();
}
function validateOptions(options) {
  if (!exact(options, ['mode', 'database', 'frontendOrigin', 'port']) || !['setup', 'serve'].includes(options.mode) ||
    !/^artrelo_(?:iris_judge_|judge_)[a-z0-9_]+_test$/.test(options.database || '') ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):\d{4,5}$/.test(options.frontendOrigin || '') ||
    !Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw fail('INVALID_OPERATOR_INPUT');
  return options;
}
function validateRoster(roster, count) {
  if (!exact(roster, ['version', 'pairs']) || roster.version !== 1 || !Array.isArray(roster.pairs) || roster.pairs.length !== count) throw fail('INVALID_PUBLIC_ROSTER');
  for (let i = 0; i < count; i++) {
    const row = roster.pairs[i], n = i + 1;
    if (!exact(row, ['ordinal', 'landlordEmail', 'tenantEmail']) || row.ordinal !== n ||
      row.landlordEmail !== `landlord${n}@artrelo.judge` || row.tenantEmail !== `tenant${n}@artrelo.judge`) throw fail('INVALID_PUBLIC_ROSTER');
  }
  return roster;
}
function validSecret(value, min, max) {
  return typeof value === 'string' && Buffer.byteLength(value) >= min && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function validateSigning(signing) {
  if (!exact(signing, ['access', 'refresh', 'session']) || !Object.values(signing).every(value => validSecret(value, 32, 256)) || new Set(Object.values(signing)).size !== 3) throw fail('INVALID_SIGNING_INPUT');
  return signing;
}
function validateCredentials(rows, count) {
  if (!Array.isArray(rows) || rows.length !== count || rows.some((row, i) => !exact(row, ['ordinal', 'landlord', 'tenant']) || row.ordinal !== i + 1 ||
    !validSecret(row.landlord, 12, 72) || !validSecret(row.tenant, 12, 72))) throw fail('INVALID_PASSWORD_INPUT');
  return rows;
}
function validateEnvelope(input) {
  if (!exact(input, ['version', 'options', 'manifest', 'roster', 'signing', 'credentials']) || input.version !== 1) throw fail('INVALID_PIPE_INPUT');
  validateOptions(input.options);
  require('./fixture.service').validateManifest(input.manifest);
  const count = input.manifest.assignedPairs + input.manifest.sparePairs;
  validateRoster(input.roster, count);validateSigning(input.signing);
  if (input.options.mode === 'setup') validateCredentials(input.credentials, count);
  else if (input.credentials !== null) throw fail('SERVE_PASSWORDS_REFUSED');
  return input;
}
function bindingFor(input) {
  validateEnvelope(input);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const rosterHash = digest(JSON.stringify(input.roster));
  const signingFingerprint = digest(JSON.stringify(['artrelo-judge-no-file-v1', input.options.database, rosterHash,
    input.signing.access, input.signing.refresh, input.signing.session]));
  return { version: 1, rosterHash, signingFingerprint };
}
function matchesBinding(saved, expected) {
  if (!saved || saved.version !== 1 || saved.rosterHash !== expected.rosterHash || !/^[a-f0-9]{64}$/.test(saved.signingFingerprint || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(saved.signingFingerprint, 'hex'), Buffer.from(expected.signingFingerprint, 'hex'));
}
async function readEnvelope(stream) {
  const chunks = [];let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);bytes += buf.length;
      if (bytes > MAX_PIPE_BYTES) { buf.fill(0);throw fail('PIPE_INPUT_TOO_LARGE'); }
      chunks.push(buf);
    }
    let parsed;const joined = Buffer.concat(chunks);
    try { parsed = JSON.parse(joined.toString('utf8')); } catch { throw fail('INVALID_PIPE_INPUT'); }
    finally { joined.fill(0); }
    return validateEnvelope(parsed);
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
function safeError(error) {
  const allowed = new Set(['INVALID_OPERATOR_INPUT','INVALID_PUBLIC_ROSTER','INVALID_SIGNING_INPUT','INVALID_PASSWORD_INPUT','INVALID_PIPE_INPUT','SERVE_PASSWORDS_REFUSED',
    'PIPE_INPUT_TOO_LARGE','EXISTING_FIXTURE_NO_RESET','READY_BOUND_FIXTURE_REQUIRED','SIGNING_OR_ROSTER_MISMATCH','HIDDEN_TTY_REQUIRED','SECRET_INPUT_CANCELLED',
    'SECRET_INPUT_TOO_LONG','MULTILINE_SECRET_INPUT_REFUSED','SECRET_CONFIRMATION_MISMATCH','EXPLICIT_OPERATOR_INPUTS_REQUIRED','INVALID_OPERATOR_ARGUMENT',
    'INVALID_PUBLIC_INPUT_FILE','OPERATOR_CHILD_FAILED']);
  return allowed.has(error?.code) ? error.code : 'OPERATOR_FAILED';
}
module.exports = { MAX_PIPE_BYTES, fail, exact, validateOptions, validateRoster, validSecret, validateSigning, validateCredentials, validateEnvelope, bindingFor, matchesBinding, readEnvelope, safeError };
