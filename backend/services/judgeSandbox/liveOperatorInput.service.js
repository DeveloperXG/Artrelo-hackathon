'use strict';
const path = require('node:path'), { execFileSync } = require('node:child_process');
const rules = require('./operatorInput.service'), protocolRules = require('./liveProtocol.service');
const { hash } = require('./contract.service');
const root = path.resolve(__dirname,'../../..');
function sourceState() {
  // Never inherit signing/provider variables into the read-only Git process.
  const env = Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
  try {
    const options = { cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore','pipe','pipe'] };
    execFileSync('git',['--no-optional-locks','diff','--quiet','--no-ext-diff','HEAD','--','backend','frontend'],options);
    const trees = execFileSync('git',['rev-parse','HEAD:backend','HEAD:frontend'],options).trim().split(/\r?\n/);
    if (trees.length !== 2 || trees.some(value=>!/^[a-f0-9]{40}$/.test(value))) throw Error('INVALID_SOURCE');
    return { backendTree: trees[0], frontendTree: trees[1] };
  } catch { throw rules.fail('LIVE_SOURCE_NOT_FROZEN'); }
}
function checkProtocol(protocol, offline, state = sourceState(), now = new Date()) {
  return protocolRules.validateProtocol(protocol,{database:offline.options.database,manifestHash:hash(offline.manifest),...state,now});
}
function validateLiveEnvelope(input, { state = sourceState(), now = new Date() } = {}) {
  if (!rules.exact(input,['version','offline','protocol','modelKey']) || input.version !== 1) throw rules.fail('INVALID_LIVE_PIPE_INPUT');
  rules.validateEnvelope(input.offline);
  if (input.offline.options.mode !== 'serve' || input.offline.credentials !== null) throw rules.fail('LIVE_SETUP_REFUSED');
  if (!rules.validSecret(input.modelKey,1,1024) || /\s/.test(input.modelKey)) throw rules.fail('INVALID_LIVE_KEY_INPUT');
  checkProtocol(input.protocol,input.offline,state,now);return input;
}
async function readLiveEnvelope(stream) {
  const chunks=[];let bytes=0;
  try {
    for await(const chunk of stream){const buffer=Buffer.from(chunk);bytes+=buffer.length;if(bytes>rules.MAX_PIPE_BYTES){buffer.fill(0);throw rules.fail('PIPE_INPUT_TOO_LARGE');}chunks.push(buffer);}
    const joined=Buffer.concat(chunks);let parsed;
    try {parsed=JSON.parse(joined.toString('utf8'));}catch{throw rules.fail('INVALID_LIVE_PIPE_INPUT');}finally{joined.fill(0);}
    return validateLiveEnvelope(parsed);
  } finally {for(const chunk of chunks)chunk.fill(0);}
}
function safeLiveError(error) {
  const legacy=rules.safeError(error);if(legacy!=='OPERATOR_FAILED')return legacy;
  return new Set(['LIVE_SOURCE_NOT_FROZEN','INVALID_FROZEN_LIVE_PROTOCOL','INVALID_LIVE_PIPE_INPUT','LIVE_SETUP_REFUSED','INVALID_LIVE_KEY_INPUT',
    'LIVE_PROTOCOL_PAIR_MISMATCH','LIVE_PROTOCOL_MISMATCH','LIVE_CONFIGURATION_MISMATCH','LIVE_CATEGORY_CAMPAIGN_MISMATCH','LIVE_BUDGET_NOT_INITIALIZED','ISOLATED_BUDGET_DATABASE_REQUIRED','LIVE_REPORT_FAILED']).has(error?.code)?error.code:'LIVE_OPERATOR_FAILED';
}
module.exports={sourceState,checkProtocol,validateLiveEnvelope,readLiveEnvelope,safeLiveError};
