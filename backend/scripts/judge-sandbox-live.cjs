'use strict';
// Explicit owner-only live serve: public frozen protocol + hidden confirmed key.
// Never used by normal/offline startup. Separate executive GO remains required.
const path=require('node:path'),{spawn}=require('node:child_process');
const offline=require('./judge-sandbox.cjs'),rules=require('../services/judgeSandbox/operatorInput.service');
const live=require('../services/judgeSandbox/liveOperatorInput.service');
const {confirmedInput}=require('../services/judgeSandbox/hiddenInput.service');
function argsOf(argv){
  const index=argv.indexOf('--protocol');
  if(index<1||!argv[index+1]||argv.lastIndexOf('--protocol')!==index)throw rules.fail('EXPLICIT_OPERATOR_INPUTS_REQUIRED');
  const args=[...argv];const protocolPath=path.resolve(args.splice(index,2)[1]);const parsed=offline.argsOf(args);
  if(parsed.options.mode!=='serve')throw rules.fail('LIVE_SETUP_REFUSED');return{...parsed,protocolPath};
}
async function collectEnvelope(parsed,{prompt=confirmedInput,state=live.sourceState,readPublicJson=offline.readPublicJson,now=()=>new Date()}={}){
  const manifest=require('../services/judgeSandbox/fixture.service').validateManifest(readPublicJson(parsed.manifestPath));
  const roster=rules.validateRoster(readPublicJson(parsed.rosterPath),manifest.assignedPairs+manifest.sparePairs);
  const publicProtocol=readPublicJson(parsed.protocolPath);
  live.checkProtocol(publicProtocol,{options:parsed.options,manifest},state(),now()); // Before any private prompt.
  const signing={};for(const name of ['access','refresh','session'])signing[name]=await prompt('Signing secret '+name,{maxBytes:256});rules.validateSigning(signing);
  const base=rules.validateEnvelope({version:1,options:parsed.options,manifest,roster,signing,credentials:null});
  const modelKey=await prompt('MODEL_API_KEY (approved frozen live protocol only)',{maxBytes:1024});
  return live.validateLiveEnvelope({version:1,offline:base,protocol:publicProtocol,modelKey},{state:state(),now:now()});
}
async function launch(envelope){
  live.validateLiveEnvelope(envelope);
  let bytes=Buffer.from(JSON.stringify(envelope));
  if(bytes.length>rules.MAX_PIPE_BYTES){bytes.fill(0);throw rules.fail('PIPE_INPUT_TOO_LARGE');}
  const child=spawn(process.execPath,[path.join(__dirname,'judge-sandbox-live-runtime.cjs')],{
    cwd:path.resolve(__dirname,'..'),env:offline.safeChildEnv(),stdio:['pipe','inherit','inherit','ipc'],windowsHide:true});
  let stopRequested=false;
  const stop=()=>{if(!stopRequested&&child.connected){stopRequested=true;child.send({type:'shutdown'});}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const clear=()=>{bytes?.fill(0);envelope.modelKey=null;envelope.offline.signing=null;};
  try{
    child.stdin.on('error',()=>{});child.stdin.end(bytes,clear);
    return await new Promise((resolve,reject)=>{child.once('error',()=>reject(rules.fail('OPERATOR_CHILD_FAILED')));child.once('exit',code=>code===0?resolve(0):reject(rules.fail('OPERATOR_CHILD_FAILED')));});
  }finally{clear();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
}
async function main(argv){return launch(await collectEnvelope(argsOf(argv)));}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{process.stderr.write(JSON.stringify({status:'LIVE_SANDBOX_OPERATOR_FAILED',code:live.safeLiveError(error),secretsPrinted:false})+'\n');process.exitCode=1;});
module.exports={argsOf,collectEnvelope,launch,main};
