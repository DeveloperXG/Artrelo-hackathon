'use strict';
// Private guarded-live child. No normal-server registration, key/env/file path.
const input=require('../services/judgeSandbox/liveOperatorInput.service');
const rules=require('../services/judgeSandbox/operatorInput.service');
async function run(stream=process.stdin,emit=value=>new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve()))){
  const envelope=await input.readLiveEnvelope(stream),base=envelope.offline,{options,manifest,roster}=base;
  const nativeFetch=globalThis.fetch;
  let budget,authority,transport,runtime,server,closing,sourceValid=true,readyPublished=false;
  const verifySource=()=>{
    if(!sourceValid)throw rules.fail('LIVE_SOURCE_NOT_FROZEN');
    try{input.checkProtocol(envelope.protocol,base,input.sourceState());}catch{sourceValid=false;throw rules.fail('LIVE_SOURCE_NOT_FROZEN');}
  };
  const network=require('../services/judgeSandbox/liveNetwork.service').createLiveNetwork({fetchImpl:nativeFetch,
    claimAttempt:async(ref,value)=>{verifySource();return budget.claimTransport(ref,{...value,authority:await authority.authorize(value.purpose)});}});
  const proof=require('../services/judgeSandbox/offlineGuard.service').installGuardedLiveSandbox({database:options.database,frontendOrigin:options.frontendOrigin,signingSecrets:base.signing},network);
  const mongoose=require('mongoose');
  const close=()=>{
    if(closing)return closing;
    closing=(async()=>{
      await transport?.dispose();network.dispose();envelope.modelKey=null;base.signing=null;
      server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));
      await runtime?.notifications.dispose();await mongoose.disconnect();
    })();return closing;
  };
  try{
    await mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:3000});
    const old=await require('../models/JudgeSandboxSeed').findById('judge-core-v1').lean();
    if(old?.state!=='ready'||old.manifestHash!==require('../services/judgeSandbox/contract.service').hash(manifest)||!old.operatorBinding)throw rules.fail('READY_BOUND_FIXTURE_REQUIRED');
    if(!rules.matchesBinding(old.operatorBinding,rules.bindingFor(base)))throw rules.fail('SIGNING_OR_ROSTER_MISMATCH');
    const config=input.checkProtocol(envelope.protocol,base,input.sourceState());
    const pairs=await require('../models/JudgeSandboxPair').find({active:true}).lean();
    const protocol=require('../services/judgeSandbox/liveProtocol.service').resolveBinding(config,pairs);
    const control=mongoose.connection.useDb(require('../services/judgeSandbox/liveProtocol.service').CONTROL_DATABASE,{useCache:true});
    budget=require('../services/judgeSandbox/liveBudgetStore.service').createLiveBudgetStore({connection:control,
      config:{campaignId:config.campaignId,kind:protocol.kind,authorizationRef:config.campaignAuthorizationRef},protocol});
    const initial=await budget.initialize();
    authority=require('../services/judgeSandbox/liveAuthority.service').createLiveAuthority({proof,authorizePair:require('../services/judgeSandbox/auth.service').createPairAuthorizer(),
      loadBasis:require('../services/quotes/review.service').loadBasis});
    const totals=async()=>{
      const categories=await budget.categoryTotals();
      return {historicalTESTUSD:0.45719725,...categories,
        cumulativeTESTUSD:categories.test?.chargedUSD??0.45719725,
        cumulativeTESTReservedUSD:categories.test?.reservedUSD??0,
        historicalTESTIncludedInCumulative:true};
    };
    const publish=async value=>{
      let deadline;
      try{return await Promise.race([Promise.resolve().then(()=>emit(value)),new Promise((resolve,reject)=>{deadline=setTimeout(()=>reject(rules.fail('LIVE_REPORT_FAILED')),3000);})]);}
      catch{await budget.halt('report_delivery_failed');throw rules.fail('LIVE_REPORT_FAILED');}
      finally{clearTimeout(deadline);}
    };
    transport=require('../services/judgeSandbox/liveTransport.service').createLiveTransport({budget,apiKey:envelope.modelKey,
      authorize:async purpose=>{if(!readyPublished)throw rules.fail('LIVE_RUNTIME_NOT_READY');verifySource();return authority.authorize(purpose);},fetchImpl:network.guardedFetch,
      report:async event=>publish({status:'GUARDED_LIVE_ATTEMPT',phase:config.phase,protocolHash:protocol.protocolHash,goRef:config.goRef,...event,totals:await totals()})});
    envelope.modelKey=null;base.signing=null;
    const providers=require('../services/judgeSandbox/liveProviders.service').createLiveProviders({proof,authority,budget,transport});
    runtime=await require('../services/judgeSandbox/application.service').createSandboxApplication({proof,liveProviders:providers});
    await Promise.all(mongoose.modelNames().map(name=>mongoose.model(name).init()));
    server=runtime.app.listen(options.port,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    runtime.notifications.start();
    const shutdown=()=>{const deadline=setTimeout(()=>process.exit(1),5000);void close().then(()=>{clearTimeout(deadline);process.exit(0);},()=>{clearTimeout(deadline);process.exit(1);});};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);process.once('disconnect',shutdown);
    process.on('message',message=>{if(message?.type==='shutdown')shutdown();});
    await publish({status:'GUARDED_LIVE_SYNTHETIC_RUNTIME_READY',database:options.database,url:'http://127.0.0.1:'+options.port,pairCount:old.pairCount,
      phase:config.phase,protocolHash:protocol.protocolHash,goRef:config.goRef,maximumCampaignCalls:protocol.maximumCalls,liveAvailable:initial.liveAvailable,
      unresolvedReservationsUSD:initial.reservedUSD,realDelivery:false,realPayment:false,credentialFileUsed:false,totals:await totals()});
    readyPublished=true;
  }catch(error){await close();throw error;}
}
if(require.main===module){
  const write=process.stdout.write.bind(process.stdout),failureWrite=process.stderr.write.bind(process.stderr);
  // Let the awaited write callback persist a reporting stop before shutdown;
  // an unhandled EPIPE must not exit between known settlement and that stop.
  process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
  process.stdout.write=process.stderr.write=()=>true;console.log=console.warn=console.error=console.info=console.debug=()=>{};
  const emit=value=>new Promise((resolve,reject)=>write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve()));
  const failure=error=>{failureWrite(JSON.stringify({status:'LIVE_SANDBOX_OPERATOR_FAILED',code:input.safeLiveError(error),secretsPrinted:false})+'\n');};
  // Before first await: a lost parent cannot leave private key material running.
  let bootstrapped=false;
  process.once('disconnect',()=>{if(!bootstrapped){failureWrite(JSON.stringify({status:'LIVE_SANDBOX_OPERATOR_FAILED',code:'OPERATOR_PARENT_DISCONNECTED',secretsPrinted:false})+'\n');process.exit(1);}});
  process.on('message',message=>{if(message?.type==='shutdown'&&!bootstrapped){failureWrite(JSON.stringify({status:'LIVE_SANDBOX_OPERATOR_FAILED',code:'OPERATOR_STOPPED_DURING_BOOT',secretsPrinted:false})+'\n');process.exit(1);}});
  process.on('unhandledRejection',error=>{failure(error);process.exit(1);});process.on('uncaughtException',error=>{failure(error);process.exit(1);});
  run(process.stdin,emit).then(()=>{bootstrapped=true;}).catch(error=>{failure(error);process.exitCode=1;process.channel?.unref();});
}
module.exports={run};
