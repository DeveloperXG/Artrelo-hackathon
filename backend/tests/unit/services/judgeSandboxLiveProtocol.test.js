'use strict';
const assert=require('node:assert/strict');
const service=require('../../../services/judgeSandbox/liveProtocol.service');
const input=require('../../../services/judgeSandbox/liveOperatorInput.service');
const operator=require('../../../scripts/judge-sandbox-live.cjs');
const {hash}=require('../../../services/judgeSandbox/contract.service');
const manifest={version:1,authorizationRef:'inert-operator-proof',assignedPairs:8,sparePairs:2,initialPolicy:{defaultQuotaMinor:25000,lowAutopilot:true,mediumAutopilot:true,autoContact:true,maxVendors:3,quoteClarification:true},syntheticOpeningWalletMinor:100000};
const state={backendTree:'a'.repeat(40),frontendTree:'b'.repeat(40)},now=new Date('2026-11-01T02:00:00Z');
const protocol={version:1,phase:'qualification',campaignId:'fixture-live-campaign',campaignAuthorizationRef:'msg_4ea009b43c0b',goRef:'msg_aaaaaaaaaaaa',realm:'artrelo_iris_judge_live_protocol_unit_test',manifestHash:hash(manifest),...state,
 allowedOrdinals:[2],rates:{...service.RATES},ratesVerifiedAt:'2026-11-01T01:00:00.000Z',expiresAt:'2026-11-05T01:00:00.000Z'};
const options={database:protocol.realm,manifestHash:hash(manifest),...state,now};
const valid=service.validateProtocol(protocol,options),pairs=[{_id:'fixture-pair-2',ordinal:2,active:true}];
assert(Object.isFrozen(valid)&&Object.isFrozen(valid.allowedOrdinals));
const resolved=service.resolveBinding(valid,pairs);assert(service.isProtocolBinding(resolved));assert.equal(resolved.maximumCalls,12);assert.equal(resolved.kind,'recording');
assert.throws(()=>service.resolveBinding(protocol,pairs),/LIVE_PROTOCOL_PAIR_MISMATCH/);
assert.throws(()=>service.resolveBinding(valid,[{...pairs[0],active:false}]),/LIVE_PROTOCOL_PAIR_MISMATCH/);
for(const changed of [{allowedOrdinals:[1]},{allowedOrdinals:[2,2]},{allowedOrdinals:[11]},{rates:{...service.RATES,inputNanoPerToken:1}},{rates:{...service.RATES,discount:true}},
 {expiresAt:'2026-11-06T01:00:00.000Z'},{realm:'production'},{backendTree:'c'.repeat(40)},{frontendTree:'c'.repeat(40)},{manifestHash:'c'.repeat(64)},
 {ratesVerifiedAt:'2026-11-01T03:00:00.000Z'},{maximumCalls:999},{phase:'test'}])assert.throws(()=>service.validateProtocol({...protocol,...changed},options),/INVALID_FROZEN_LIVE_PROTOCOL/);
assert.throws(()=>service.validateProtocol(protocol,{...options,now:new Date(protocol.expiresAt)}),/INVALID_FROZEN_LIVE_PROTOCOL/);
const judge=service.resolveBinding(service.validateProtocol({...protocol,phase:'judge'},options),pairs);assert.equal(judge.maximumCalls,300);assert.equal(judge.kind,'judge');
const recording=service.resolveBinding(service.validateProtocol({...protocol,phase:'recording'},options),pairs);assert.equal(recording.maximumCalls,100);
const offline={version:1,options:{mode:'serve',database:protocol.realm,frontendOrigin:'http://127.0.0.1:3144',port:8028},manifest,
 roster:{version:1,pairs:Array.from({length:10},(_,i)=>({ordinal:i+1,landlordEmail:`landlord${i+1}@artrelo.judge`,tenantEmail:`tenant${i+1}@artrelo.judge`}))},
 signing:{access:'inert-access-'.repeat(4),refresh:'inert-refresh-'.repeat(4),session:'inert-session-'.repeat(4)},credentials:null};
const envelope={version:1,offline,protocol,modelKey:'inert-fixture-key-not-real'};
assert.equal(input.validateLiveEnvelope(envelope,{state,now}),envelope);
assert.throws(()=>input.validateLiveEnvelope({...envelope,modelKey:'inert key'},{state,now}),/INVALID_LIVE_KEY_INPUT/);
assert.throws(()=>input.validateLiveEnvelope({...envelope,modelKey:'x'.repeat(1025)},{state,now}),/INVALID_LIVE_KEY_INPUT/);
assert.throws(()=>input.validateLiveEnvelope({...envelope,other:'no'},{state,now}),/INVALID_LIVE_PIPE_INPUT/);
assert.equal(input.safeLiveError(Error('Bearer inert-raw-error')), 'LIVE_OPERATOR_FAILED');
assert.throws(()=>operator.argsOf(['setup','--protocol','inert.json','--database',protocol.realm,'--manifest','a','--roster','b','--frontend','http://127.0.0.1:3144']),/LIVE_SETUP_REFUSED/);
assert.throws(()=>operator.argsOf(['serve','--protocol','a','--protocol','b']),/EXPLICIT_OPERATOR_INPUTS_REQUIRED/);
console.log('PASS frozen protocol: closed source/realm/manifest/rate/expiry binding, qualification12/retake restriction, fixed recording100/judge300, genuine binding capability and no-file key envelope. No prompt, Git source scan, key lookup or network/provider call.');
async function collectorProof(){
 const parsed={options:offline.options,manifestPath:'inert-manifest',rosterPath:'inert-roster',protocolPath:'inert-protocol'};
 const read=file=>file===parsed.manifestPath?manifest:file===parsed.rosterPath?offline.roster:protocol;
 const prompts=[];let stateReads=0;
 const value=await operator.collectEnvelope(parsed,{readPublicJson:read,now:()=>now,state:()=>{stateReads++;return state;},prompt:async(label,limits)=>{
  prompts.push({label,maxBytes:limits.maxBytes});return label.startsWith('MODEL_API_KEY')?'inert-fixture-key-not-real':offline.signing[label.split(' ').at(-1)];
 }});
 assert.equal(stateReads,2);assert.deepEqual(prompts.map(value=>value.maxBytes),[256,256,256,1024]);assert.equal(value.modelKey,envelope.modelKey);assert.equal(value.offline.credentials,null);
 let privatePrompts=0;
 await assert.rejects(operator.collectEnvelope(parsed,{readPublicJson:read,now:()=>now,state:()=>({...state,backendTree:'d'.repeat(40)}),prompt:async()=>{privatePrompts++;return'inert';}}),/INVALID_FROZEN_LIVE_PROTOCOL/);
 assert.equal(privatePrompts,0);
 console.log('PASS live collector: public frozen validation before four confirmed-input capabilities, source recheck after input, no password/key file fallback. Simulated prompt only; no actual TTY, key or Git source scan.');
}
collectorProof().catch(error=>{console.error('FAIL live collector: '+(error.code||error.name));process.exitCode=1;});
