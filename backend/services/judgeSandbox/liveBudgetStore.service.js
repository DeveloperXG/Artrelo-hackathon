'use strict';
// Isolated accounting database only; no HTTP registration, key or provider I/O.
const { randomUUID } = require('node:crypto');
const { hash } = require('./contract.service');
const policy = require('./liveBudgetPolicy.service');
function createLiveBudgetStore({ connection, config: input, protocol = null, now = () => new Date() } = {}) {
  if (!connection?.db || !/^artrelo_judge_budget_control(?:_[a-z0-9_]+)?_test$/.test(connection.name || '') ||
      typeof connection.getClient !== 'function') throw policy.fail('ISOLATED_BUDGET_DATABASE_REQUIRED');
  const client=connection.getClient();
  if(typeof client?.startSession!=='function')throw policy.fail('ISOLATED_BUDGET_DATABASE_REQUIRED');
  const config = policy.campaignConfig(input), holderId = randomUUID();
  if (protocol !== null && (!require('./liveProtocol.service').isProtocolBinding(protocol) || protocol.campaignId !== config.campaignId ||
      protocol.authorizationRef !== config.authorizationRef || protocol.kind !== config.kind)) throw policy.fail('LIVE_PROTOCOL_MISMATCH');
  if (config.kind === 'test' && (connection.name !== 'artrelo_judge_budget_control_test' ||
      !protocol || protocol.testPlanHash !== config.testPlanHash)) throw policy.fail('LIVE_PROTOCOL_MISMATCH');
  const campaigns = connection.db.collection('judge_live_campaigns');
  const pairs = connection.db.collection('judge_live_pairs');
  const attempts = connection.db.collection('judge_live_attempts');
  const lanes = connection.db.collection('judge_live_lanes');
  const protocols = connection.db.collection('judge_live_protocols');
  const categories = connection.db.collection('judge_live_category_slots');
  const modelTurnLanes = connection.db.collection('judge_live_model_turn_lanes');
  const modelTurns = connection.db.collection('judge_live_model_turns');
  const recoveryAudits = connection.db.collection('judge_live_recovery_audits');
  const laneId = 'meta-standard-single-flight-v1';
  let initialized = false;
  const at = () => { const value = now();if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw policy.fail('INVALID_LIVE_CLOCK');return value; };
  async function transaction(work) {
    // Collections below use this same native Mongo client. A Mongoose useDb
    // wrapper copies its parent's heartbeat only when created; its buffered
    // startSession can subsequently time out while that client is healthy.
    // Native sessions retain driver topology checks and transaction semantics.
    const session = client.startSession();
    try { return await session.withTransaction(() => work(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }); }
    finally { await session.endSession(); }
  }
  const options = session => ({ session });
  const pairKeyFor = (realm, pairRef) => hash({ campaignId: config.campaignId, realm, pairRef });
  function laneScopeAllowed(lane, realm = null, pairRef = null) {
    if (!lane?.recoveryScope) return true;
    const scope = lane.recoveryScope;
    return Boolean(scope.status === 'active' && protocol && scope.campaignId === config.campaignId && scope.protocolHash === protocol.protocolHash &&
      scope.goRef === protocol.goRef && scope.expiresAt === config.expiresAt &&
      protocol.allowedPairs.length === 1 && protocol.allowedPairs[0].realm === scope.realm &&
      protocol.allowedPairs[0].pairRef === scope.pairRef && (!realm || realm === scope.realm) && (!pairRef || pairRef === scope.pairRef));
  }
  function preservesOriginalTestHalt(campaign, lane) {
    const scope = lane?.recoveryScope;
    return config.kind === 'test' && scope?.kind === 'test' && scope.approvalRef === 'msg_6c44a602a73b' &&
      scope.originalAttemptRef === 'guarded_70c1d518-90bf-451d-95bb-7cad5ed6c826' &&
      scope.retainedReservedNano === 1321345000 && campaign?.halted === true && campaign.haltReason === scope.originalHaltReason;
  }
  async function admissionCampaign(campaign, lane, session) {
    if (!preservesOriginalTestHalt(campaign, lane) || !laneScopeAllowed(lane)) return campaign;
    const scope = lane.recoveryScope;
    const audit = await recoveryAudits.findOne({ _id: scope.recoveryRef, state: 'active', action: 'release_test_pair5_only' }, options(session));
    if (!audit || hash(audit.destination) !== hash(scope) || protocol.phase !== 'test-rehearsal-b' ||
        protocol.allowedPairs[0].ordinal !== 5 || protocol.phaseMaximumCalls !== 20 ||
        campaign.reservedNano < scope.retainedReservedNano) return campaign;
    // A protocol-scoped admission view, never a persisted unhalt or refund.
    return { ...campaign, halted: false };
  }
  async function closeRecovery(lane, reason, session) {
    if (!lane?.recoveryScope || !laneScopeAllowed(lane)) return;
    const stoppedAt = at(), opt = options(session);
    const changed = await recoveryAudits.updateOne({ _id: lane.recoveryScope.recoveryRef, state: 'active' },
      { $set: { state: 'stopped', stopReason: reason, stoppedAt } }, opt);
    if (changed.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
    await lanes.updateOne({ _id: laneId, 'recoveryScope.recoveryRef': lane.recoveryScope.recoveryRef },
      { $set: { halted: true, haltReason: reason, 'recoveryScope.status': 'stopped', updatedAt: stoppedAt } }, opt);
  }
  async function initialize() {
    const createdAt = at();
    await transaction(async session => {
      const opt=options(session);
      const slot=await categories.findOne({_id:config.kind},opt);
      const other=await campaigns.findOne({kind:config.kind,_id:{$ne:config.campaignId}},opt);
      if(other||slot&&slot.campaignId!==config.campaignId)throw policy.fail('LIVE_CATEGORY_CAMPAIGN_MISMATCH');
      if(slot&&slot.configHash!==config.configHash)throw policy.fail('LIVE_CONFIGURATION_MISMATCH');
      await categories.updateOne({_id:config.kind},{$setOnInsert:{campaignId:config.campaignId,configHash:config.configHash,createdAt}},{...opt,upsert:true});
      await campaigns.updateOne({ _id: config.campaignId }, { $setOnInsert: { ...config, chargedNano: 0, reservedNano: 0,
        ...(config.kind === 'test' ? { chargedNano: config.baselineNano } : {}),
        attemptCount: 0, sentCount: 0, halted: false, haltReason: null, createdAt } }, { ...opt, upsert: true });
      if (config.kind === 'test') {
        const existing = await campaigns.findOne({ _id: config.campaignId }, opt);
        if (existing?.configHash !== config.configHash) throw policy.fail('LIVE_CONFIGURATION_MISMATCH');
        assertTestAccounting(existing);
      }
      await lanes.updateOne({ _id: laneId }, { $setOnInsert: { version: 1, attemptRef: null, holderId: null, halted: false, createdAt } }, { ...opt, upsert: true });
      if(protocol){
        await protocols.updateOne({ _id: protocol.protocolKey }, { $setOnInsert: { ...protocol, createdAt } }, { ...opt, upsert: true });
        if((await protocols.findOne({_id:protocol.protocolKey},opt))?.bindingHash!==protocol.bindingHash)throw policy.fail('LIVE_PROTOCOL_MISMATCH');
      }
    });
    const campaign = await campaigns.findOne({ _id: config.campaignId });
    const lane = await lanes.findOne({ _id: laneId });
    if (campaign?.configHash !== config.configHash || lane?.version !== 1) throw policy.fail('LIVE_CONFIGURATION_MISMATCH');
    assertTestAccounting(campaign);
    initialized = true;
    const minimum=policy.WINDOW*policy.INPUT_NANO+2048*policy.OUTPUT_NANO;
    let admissible=false;
    const candidates=protocol?protocol.allowedPairs:[null];
    for(const candidate of candidates){
      const pair=candidate?await pairs.findOne({_id:pairKeyFor(candidate.realm,candidate.pairRef)}):null;
      try{policy.assertAdmission(config,await admissionCampaign(campaign,lane),pair||{chargedNano:0,reservedNano:0,attemptCount:0,sentCount:0},minimum,at());
        if((!protocol||campaign.attemptCount<protocol.maximumCalls) && (!candidate?.maximumCalls || !pair || pair.attemptCount<candidate.maximumCalls)){admissible=true;break;}
      }catch(error){if(error.code==='LIVE_ACCOUNTING_INVALID')throw error;}
    }
    return { ...(await summary()), liveAvailable: admissible && !lane.halted && lane.attemptRef === null && laneScopeAllowed(lane) };
  }
  function ready() { if (!initialized) throw policy.fail('LIVE_BUDGET_NOT_INITIALIZED'); }
  function assertTestAccounting(campaign) {
    if (config.kind === 'test' && (campaign?.baselineNano !== config.baselineNano || campaign?.baselineRef !== config.baselineRef ||
        campaign?.testPlanHash !== config.testPlanHash || !Number.isSafeInteger(campaign?.chargedNano) || campaign.chargedNano < config.baselineNano)) throw policy.fail('LIVE_ACCOUNTING_INVALID');
  }
  async function beginModelTurn({ turnRef, realm, pairRef, actorRef } = {}) {
    ready();if(![turnRef,pairRef,actorRef].every(policy.ref)||!policy.database(realm))throw policy.fail('INVALID_LIVE_ATTEMPT');
    const laneKey=hash({realm,pairRef}),startedAt=at();
    if(startedAt>=new Date(config.expiresAt))throw policy.fail('LIVE_EXPIRED');
    return transaction(async session=>{
      const opt=options(session),campaign=await campaigns.findOne({_id:config.campaignId},opt),global=await lanes.findOne({_id:laneId},opt);
      if(!campaign||campaign.configHash!==config.configHash||(await admissionCampaign(campaign,global,session)).halted||global?.halted!==false||!laneScopeAllowed(global,realm,pairRef))throw policy.fail('LIVE_CAMPAIGN_STOPPED');
      assertTestAccounting(campaign);
      if(protocol&&!protocol.allowedPairs.some(pair=>pair.realm===realm&&pair.pairRef===pairRef))throw policy.fail('LIVE_PROTOCOL_ADMISSION_DENIED');
      if(await modelTurns.findOne({_id:turnRef},opt))throw policy.fail('LIVE_PAIR_TURN_REPLAY');
      await modelTurnLanes.updateOne({_id:laneKey},{$setOnInsert:{activeTurnRef:null,holderId:null,createdAt:startedAt}},{...opt,upsert:true});
      const claimed=await modelTurnLanes.updateOne({_id:laneKey,activeTurnRef:null},{$set:{activeTurnRef:turnRef,holderId,updatedAt:startedAt}},opt);
      if(claimed.modifiedCount!==1)throw policy.fail('LIVE_PAIR_TURN_BUSY');
      await modelTurns.insertOne({_id:turnRef,laneKey,realm,pairRef,actorRef,holderId,campaignId:config.campaignId,
        protocolHash:protocol?.protocolHash||null,state:'active',startedAt},opt);
      return{turnRef};
    });
  }
  async function finishModelTurn(turnRef, outcome) {
    ready();if(!policy.ref(turnRef)||!['completed','failed'].includes(outcome))throw policy.fail('INVALID_LIVE_ATTEMPT');
    return transaction(async session=>{
      const opt=options(session),row=await modelTurns.findOne({_id:turnRef,holderId,campaignId:config.campaignId},opt);
      if(!row)throw policy.fail('LIVE_PAIR_TURN_NOT_OWNED');
      if(row.state==='closed')return{closed:true,replayed:true};
      const lane=await modelTurnLanes.findOne({_id:row.laneKey,activeTurnRef:turnRef,holderId},opt);
      if(!lane||row.state!=='active')throw policy.fail('LIVE_PAIR_TURN_NOT_OWNED');
      await modelTurns.updateOne({_id:turnRef,holderId,state:'active'},{$set:{state:'closed',outcome,closedAt:at()}},opt);
      await modelTurnLanes.updateOne({_id:row.laneKey,activeTurnRef:turnRef,holderId},{$set:{activeTurnRef:null,holderId:null,updatedAt:at()}},opt);
      // Logical-turn completion never settles/refunds a money reservation.
      return{closed:true,replayed:false};
    });
  }
  async function reserve({ attemptRef, realm, pairRef, actorRef, purpose, body, caseRef = null } = {}) {
    ready();
    // These are internal server-resolved references. The transport capability
    // must reauthorize ordinary auth/pair ownership before invoking this store.
    if (![attemptRef, pairRef, actorRef].every(policy.ref) || !policy.database(realm) || caseRef !== null && !policy.ref(caseRef)) throw policy.fail('INVALID_LIVE_ATTEMPT');
    const basis = policy.requestBasis(purpose, body), pairKey = pairKeyFor(realm, pairRef), createdAt = at();
    return transaction(async session => {
      const opt = options(session);
      if (await attempts.findOne({ _id: attemptRef }, opt)) throw policy.fail('LIVE_ATTEMPT_REPLAY');
      const lane = await lanes.findOne({ _id: laneId }, opt);
      if (!lane || lane.halted) throw policy.fail('LIVE_LANE_STOPPED');
      if (!laneScopeAllowed(lane, realm, pairRef)) throw policy.fail('LIVE_RECOVERY_SCOPE_DENIED');
      if (lane.attemptRef !== null) throw policy.fail('LIVE_LANE_BUSY');
      const campaign = await campaigns.findOne({ _id: config.campaignId }, opt);
      assertTestAccounting(campaign);
      if (protocol && ((await protocols.findOne({ _id: protocol.protocolKey }, opt))?.bindingHash !== protocol.bindingHash ||
          !protocol.allowedPairs.some(pair => pair.realm === realm && pair.pairRef === pairRef) || campaign?.attemptCount >= protocol.maximumCalls)) throw policy.fail('LIVE_PROTOCOL_ADMISSION_DENIED');
      await pairs.updateOne({ _id: pairKey }, { $setOnInsert: { campaignId: config.campaignId, realm, pairRef,
        chargedNano: 0, reservedNano: 0, attemptCount: 0, sentCount: 0, createdAt } }, { ...opt, upsert: true });
      const pair = await pairs.findOne({ _id: pairKey }, opt);
      policy.assertAdmission(config, await admissionCampaign(campaign,lane,session), pair, basis.reservedNano, createdAt);
      const phasePair = protocol?.allowedPairs.find(value => value.realm === realm && value.pairRef === pairRef);
      if (config.kind === 'test' && (!phasePair || pair.attemptCount >= phasePair.maximumCalls)) throw policy.fail('LIVE_SEND_LIMIT');
      const claimed = await lanes.updateOne({ _id: laneId, attemptRef: null, halted: false },
        { $set: { attemptRef, holderId, campaignId: config.campaignId, updatedAt: createdAt } }, opt);
      if (claimed.modifiedCount !== 1) throw policy.fail('LIVE_LANE_BUSY');
      await attempts.insertOne({ _id: attemptRef, campaignId: config.campaignId, configHash: config.configHash, pairKey, realm,
        pairRef, actorRef, caseRef, holderId, ...basis, ...(protocol ? { protocolHash: protocol.protocolHash, protocolBindingHash: protocol.bindingHash,
          protocolGoRef: protocol.goRef, backendTree: protocol.backendTree, frontendTree: protocol.frontendTree,
          ...(config.kind === 'test' ? { phase: protocol.phase, ordinal: phasePair.ordinal, testPlanHash: config.testPlanHash } : {}) } : {}), state: 'reserved', createdAt, actualNano: null, usage: null }, opt);
      await campaigns.updateOne({ _id: config.campaignId, configHash: config.configHash }, { $inc: { reservedNano: basis.reservedNano, attemptCount: 1 } }, opt);
      await pairs.updateOne({ _id: pairKey }, { $inc: { reservedNano: basis.reservedNano, attemptCount: 1 } }, opt);
      return { authorized: true, reservationRef: attemptRef, reservedNano: basis.reservedNano, reservedUSD: basis.reservedNano / policy.NANO };
    });
  }
  async function ownedAttempt(attemptRef, session) {
    ready();
    if (!policy.ref(attemptRef)) throw policy.fail('INVALID_LIVE_ATTEMPT');
    const row = await attempts.findOne({ _id: attemptRef, campaignId: config.campaignId, holderId, configHash: config.configHash }, options(session));
    const lane = await lanes.findOne({ _id: laneId, attemptRef, holderId }, options(session));
    if (!row || !lane) throw policy.fail('LIVE_ATTEMPT_NOT_OWNED');
    return row;
  }
  async function markSent(attemptRef, body) {
    return transaction(async session => {
      const row = await ownedAttempt(attemptRef, session), opt = options(session), sentAt = at();
      const basis = policy.requestBasis(row.purpose, body);
      if (row.state !== 'reserved' || row.bodyHash !== basis.bodyHash || row.bodyBytes !== basis.bodyBytes) throw policy.fail('LIVE_SEND_MISMATCH');
      const campaign = await campaigns.findOne({ _id: config.campaignId }, opt);
      const lane = await lanes.findOne({ _id: laneId }, opt);
      assertTestAccounting(campaign);
      if (sentAt >= new Date(config.expiresAt) || campaign?.configHash !== config.configHash || (await admissionCampaign(campaign,lane,session))?.halted || lane?.halted || !laneScopeAllowed(lane, row.realm, row.pairRef)) throw policy.fail('LIVE_CAMPAIGN_STOPPED');
      await attempts.updateOne({ _id: attemptRef, holderId, state: 'reserved' }, { $set: { state: 'started', sentAt } }, opt);
      await campaigns.updateOne({ _id: config.campaignId }, { $inc: { sentCount: 1 } }, opt);
      await pairs.updateOne({ _id: row.pairKey }, { $inc: { sentCount: 1 } }, opt);
      return { reservationRef: attemptRef, state: 'started' };
    });
  }
  async function assertReserved(attemptRef, { realm, pairRef, actorRef, purpose, body } = {}) {
    return transaction(async session => {
      const row = await ownedAttempt(attemptRef, session), basis = policy.requestBasis(purpose, body);
      if (row.state !== 'reserved' || row.realm !== realm || row.pairRef !== pairRef || row.actorRef !== actorRef ||
          row.purpose !== purpose || row.bodyHash !== basis.bodyHash || row.bodyBytes !== basis.bodyBytes) throw policy.fail('LIVE_RESERVATION_MISMATCH');
      return { authorized: true, reservationRef: attemptRef, reservedNano: row.reservedNano, reservedUSD: row.reservedNano / policy.NANO };
    });
  }
  async function viewAttempt(attemptRef) {
    ready();if (!policy.ref(attemptRef)) throw policy.fail('INVALID_LIVE_ATTEMPT');
    const row = await attempts.findOne({ _id: attemptRef, campaignId: config.campaignId, holderId, configHash: config.configHash },
      { projection: { state: 1, actualNano: 1, reservedNano: 1, wireClaimedAt: 1 } });
    return row ? { reservationRef: attemptRef, state: row.state, actualUSD: row.actualNano === null ? null : row.actualNano / policy.NANO,
      reservedUSD: ['reserved', 'started', 'unknown'].includes(row.state) ? row.reservedNano / policy.NANO : 0, wireClaimed: !!row.wireClaimedAt } : null;
  }
  async function claimTransport(attemptRef, { purpose, body, authority } = {}) {
    return transaction(async session => {
      const row = await ownedAttempt(attemptRef, session), opt = options(session), wireClaimedAt = at();
      const basis = policy.requestBasis(purpose, body);
      const campaign = await campaigns.findOne({ _id: config.campaignId }, opt);
      const lane = await lanes.findOne({ _id: laneId }, opt);
      assertTestAccounting(campaign);
      if (!policy.exactKeys(authority, ['realm', 'pairRef', 'actorRef']) || row.realm !== authority.realm || row.pairRef !== authority.pairRef || row.actorRef !== authority.actorRef ||
          row.state !== 'started' || row.wireClaimedAt || row.purpose !== purpose || row.bodyHash !== basis.bodyHash || row.bodyBytes !== basis.bodyBytes ||
          wireClaimedAt >= new Date(config.expiresAt) || campaign?.configHash !== config.configHash || (await admissionCampaign(campaign,lane,session)).halted || lane?.halted || !laneScopeAllowed(lane, row.realm, row.pairRef)) throw policy.fail('LIVE_TRANSPORT_CLAIM_DENIED');
      const update = await attempts.updateOne({ _id: attemptRef, holderId, state: 'started', wireClaimedAt: null }, { $set: { wireClaimedAt } }, opt);
      if (update.modifiedCount !== 1) throw policy.fail('LIVE_TRANSPORT_CLAIM_DENIED');
      return true;
    });
  }
  async function finish(attemptRef, { usage = null, httpStatus = null, model = null, notSent = false } = {}) {
    return transaction(async session => {
      const row = await ownedAttempt(attemptRef, session), opt = options(session), settledAt = at();
      if (notSent ? row.state !== 'reserved' : !['started', 'unknown'].includes(row.state)) throw policy.fail('LIVE_SETTLEMENT_REPLAY_OR_STATE');
      const campaign = await campaigns.findOne({ _id: config.campaignId }, opt);
      const pair = await pairs.findOne({ _id: row.pairKey }, opt);
      const lane = await lanes.findOne({ _id: laneId }, opt);
      assertTestAccounting(campaign);
      if (campaign?.configHash !== config.configHash || [campaign, pair].some(account => !account ||
          !Number.isSafeInteger(account.reservedNano) || account.reservedNano < row.reservedNano ||
          !Number.isSafeInteger(account.chargedNano) || account.chargedNano < 0)) throw policy.fail('LIVE_ACCOUNTING_INVALID');
      let actualNano = null, code = null;
      if (notSent) actualNano = 0;
      else if (!usage && !model) code = 'transport_unknown';
      else {
        try { actualNano = policy.usageCost(usage); } catch { code = 'usage_unknown'; }
        if (model !== policy.MODEL) { actualNano = null;code = 'model_unknown'; }
      }
      const known = actualNano !== null;
      if (known && [campaign, pair].some(account => !Number.isSafeInteger(account.chargedNano + actualNano))) throw policy.fail('LIVE_ACCOUNTING_INVALID');
      const boundsExceeded = known && !notSent && (usage.prompt_tokens > policy.WINDOW || usage.completion_tokens > row.maxCompletionTokens || actualNano > row.reservedNano);
      const badStatus = !notSent && (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 299);
      const haltReason = code || (boundsExceeded ? 'provider_bound_exceeded' : badStatus ? 'provider_error' : null);
      const late = row.state === 'unknown';
      if (late && !known) throw policy.fail('LIVE_LATE_USAGE_STILL_UNKNOWN');
      const state = notSent ? 'not_sent' : known ? 'settled' : 'unknown';
      await attempts.updateOne({ _id: attemptRef, holderId, state: row.state }, { $set: { state, actualNano,
        usage: known && !notSent ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens } : null,
        httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
        returnedModel: model === policy.MODEL ? model : model ? 'unexpected_model' : null, haltReason,
        firstHaltReason: row.firstHaltReason || haltReason, ...(state === 'unknown' ? { uncertainAt: row.uncertainAt || settledAt } : {}), settledAt } }, opt);
      const inc = known ? { reservedNano: -row.reservedNano, chargedNano: actualNano, ...(notSent ? { attemptCount: -1 } : {}) } : {};
      const campaignUpdate = { ...(known ? { $inc: inc } : {}), ...(haltReason && !preservesOriginalTestHalt(campaign,lane) ? { $set: { halted: true, haltReason } } : {}) };
      if (Object.keys(campaignUpdate).length) await campaigns.updateOne({ _id: config.campaignId }, campaignUpdate, opt);
      if (known) await pairs.updateOne({ _id: row.pairKey }, { $inc: inc }, opt);
      if (haltReason) await lanes.updateOne({ _id: laneId, attemptRef, holderId }, { $set: { halted: true, haltReason } }, opt);
      if (haltReason) await closeRecovery(lane, haltReason, session);
      if (known) await lanes.updateOne({ _id: laneId, attemptRef, holderId }, { $set: { attemptRef: null, holderId: null, campaignId: null, updatedAt: settledAt } }, opt);
      // A late accounting response can reconcile cost once, but cannot clear
      // the durable stop set by the original unknown outcome.
      return { reservationRef: attemptRef, state, actualUSD: known ? actualNano / policy.NANO : null,
        retainedReservationUSD: known ? 0 : row.reservedNano / policy.NANO, halted: Boolean(haltReason) || late, haltReason, lateSettlement: late };
    });
  }
  async function summary({ realm = null, pairRef = null } = {}) {
    ready();
    const row = await campaigns.findOne({ _id: config.campaignId });
    if (!row || row.configHash !== config.configHash) throw policy.fail('LIVE_CONFIGURATION_MISMATCH');
    assertTestAccounting(row);
    if(!['chargedNano','reservedNano','attemptCount','sentCount'].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0))throw policy.fail('LIVE_ACCOUNTING_INVALID');
    const lane = await lanes.findOne({ _id: laneId });
    const output = { kind: config.kind, campaignId: config.campaignId, chargedUSD: row.chargedNano / policy.NANO,
      reservedUSD: row.reservedNano / policy.NANO, chargedOrReservedUSD: (row.chargedNano + row.reservedNano) / policy.NANO,
      sentCalls: row.sentCount, sentOrReservedCalls: row.attemptCount, pauseUSD: config.pauseNano / policy.NANO,
      hardUSD: config.hardNano / policy.NANO, halted: (await admissionCampaign(row,lane)).halted || lane?.halted !== false || !laneScopeAllowed(lane),
      campaignHalted: row.halted, recoveryExceptionActive: Boolean(preservesOriginalTestHalt(row,lane) && !(await admissionCampaign(row,lane)).halted),
      ...(config.kind === 'test' ? { baselineUSD: config.baselineNano / policy.NANO, baselineRef: config.baselineRef } : {}),
      globalLaneOccupied: lane?.attemptRef !== null, maximumCalls: config.maximumCalls,
      ...(protocol?{protocol:{phase:protocol.phase,maximumCalls:protocol.maximumCalls,goRef:protocol.goRef,hash:protocol.protocolHash,
        ...(config.kind === 'test' ? { phaseMaximumCalls: protocol.phaseMaximumCalls } : {})}}:{}) };
    if (realm !== null || pairRef !== null) {
      if (!policy.database(realm) || !policy.ref(pairRef)) throw policy.fail('INVALID_LIVE_ATTEMPT');
      const pair = await pairs.findOne({ _id: pairKeyFor(realm, pairRef) });
      output.pair = { chargedUSD: (pair?.chargedNano || 0) / policy.NANO, reservedUSD: (pair?.reservedNano || 0) / policy.NANO,
        sentCalls: pair?.sentCount || 0, hardUSD: config.pairHardNano === null ? null : config.pairHardNano / policy.NANO };
    }
    return output;
  }
  async function halt(reason) {
    ready();
    if (!['report_delivery_failed', 'accounting_unavailable', 'transport_unknown', 'operator_stopped'].includes(reason)) throw policy.fail('INVALID_LIVE_STOP_REASON');
    return transaction(async session => {
      const opt = options(session);
      const lane = await lanes.findOne({ _id: laneId }, opt), campaign = await campaigns.findOne({ _id: config.campaignId }, opt);
      if (!laneScopeAllowed(lane)) throw policy.fail('LIVE_RECOVERY_SCOPE_DENIED');
      if (!preservesOriginalTestHalt(campaign,lane)) await campaigns.updateOne({ _id: config.campaignId, configHash: config.configHash }, { $set: { halted: true, haltReason: reason } }, opt);
      await lanes.updateOne({ _id: laneId }, { $set: { halted: true, haltReason: reason } }, opt);
      await closeRecovery(lane, reason, session);
      return { halted: true, reason };
    });
  }
  async function stopRecovery(reason) {
    ready();
    if (!['provider_validation_failed','unsupported_intake','model_turn_failed'].includes(reason)) throw policy.fail('INVALID_LIVE_STOP_REASON');
    return transaction(async session => {
      const lane = await lanes.findOne({ _id: laneId }, options(session));
      if (!lane?.recoveryScope || lane.recoveryScope.status !== 'active' || !laneScopeAllowed(lane)) return { stopped: false };
      await closeRecovery(lane,reason,session);return { stopped: true };
    });
  }
  async function categoryTotals() {
    ready();const rows=await campaigns.find({kind:{$in:['recording','judge','test']}}).toArray(),totals={recording:{chargedNano:0,reservedNano:0},judge:{chargedNano:0,reservedNano:0}};
    for(const row of rows){
      if (row.kind === 'test') {
        const expected=policy.campaignConfig({campaignId:policy.TEST_PLAN.campaignId,kind:'test',authorizationRef:policy.TEST_PLAN.authorizationRef});
        if(row._id!==expected.campaignId||row.configHash!==expected.configHash||row.baselineNano!==expected.baselineNano||
            row.baselineRef!==expected.baselineRef||row.testPlanHash!==expected.testPlanHash||row.chargedNano<expected.baselineNano||totals.test)throw policy.fail('LIVE_ACCOUNTING_INVALID');
        totals.test={chargedNano:0,reservedNano:0};
      }
      if(!Number.isSafeInteger(row.chargedNano)||row.chargedNano<0||!Number.isSafeInteger(row.reservedNano)||row.reservedNano<0)throw policy.fail('LIVE_ACCOUNTING_INVALID');
      totals[row.kind].chargedNano+=row.chargedNano;totals[row.kind].reservedNano+=row.reservedNano;
      if(!Object.values(totals[row.kind]).every(Number.isSafeInteger))throw policy.fail('LIVE_ACCOUNTING_INVALID');
    }return Object.fromEntries(Object.entries(totals).map(([kind,value])=>[kind,{chargedUSD:value.chargedNano/policy.NANO,reservedUSD:value.reservedNano/policy.NANO}]));
  }
  return { initialize, beginModelTurn, finishModelTurn, reserve, assertReserved, viewAttempt, markSent, claimTransport, settle: finish,
    cancelBeforeSend: attemptRef => finish(attemptRef, { notSent: true }), halt, stopRecovery, summary, categoryTotals, config };
}
module.exports = { createLiveBudgetStore };
