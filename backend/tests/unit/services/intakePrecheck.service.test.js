const assert=require('assert');
const Request=require('../../../models/MaintenanceRequest');
let rows=[],openCount=0,seenFilter;
Request.find=filter=>{seenFilter=filter;const query={select(){return this},sort(){return this},limit(){return this},lean:async()=>rows};return query;};
Request.countDocuments=async()=>openCount;
const {precheckIntake}=require('../../../services/request/intakePrecheck.service');
const tenant={_id:'tenant-1',landlord:'landlord-1',unit:{_id:'unit-1'}};
let quota={blocked:false,daily:{remaining:3},weekly:{remaining:7},nextAvailableAt:null};
const check=(description,extra={})=>precheckIntake({tenant,description,getQuota:async()=>quota,...extra});
(async()=>{
  for(const text of ['There is active flooding from a burst pipe','No smoke, but I smell gas','No sparks earlier, and now sparks are coming from the outlet']) {
    openCount=2;assert.strictEqual((await check(text)).decision,'allow');assert.ok((await check(text)).isEmergency);
  }
  openCount=1;rows=[{_id:'sink1',issueTitle:'Kitchen faucet leaking',issueDescription:'Kitchen tap drips',createdAt:new Date()}];
  let result=await check('My kitchen sink is dripping again');
  assert.strictEqual(result.decision,'allow','similarity is advisory');assert.strictEqual(result.similarRequests[0].id,'sink1');
  assert.deepStrictEqual(seenFilter.tenantId,tenant._id);assert.deepStrictEqual(seenFilter.landlordId,tenant.landlord);assert.strictEqual(seenFilter.unitId,'unit-1');
  result=await check('My bathroom sink is dripping');assert.strictEqual(result.similarRequests.length,0,'different known rooms are not duplicates');
  openCount=2;assert.strictEqual((await check('The fridge is noisy')).decision,'blocked_cap');
  openCount=0;quota={blocked:true,daily:{remaining:0},weekly:{remaining:4},nextAvailableAt:new Date()};
  assert.strictEqual((await check('The fridge is noisy')).decision,'blocked_quota');
  result=await check('I am worried something might be dangerous',{intakeMode:'safety'});
  assert.strictEqual(result.decision,'allow');assert.strictEqual(result.emergencyOverride,true);
  console.log('intake precheck advisory similarity, authorization scope, limits and safety tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
