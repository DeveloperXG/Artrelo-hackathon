'use strict';
// Exact owner-approved stopped-runtime handoff. No HTTP registration or key I/O.
const { execFileSync } = require('node:child_process');
const { ObjectId } = require('mongodb');
const { hash } = require('./contract.service');
const policy = require('./liveBudgetPolicy.service'), protocols = require('./liveProtocol.service');
const retake = require('../../contracts/judgeSandboxRecordingRetake.v1.json');
const fresh = require('../../contracts/judgeSandboxFreshRecording.v1.json');
const exitProofs = new WeakSet(), laneId = 'meta-standard-single-flight-v1';
const fail = code => { throw policy.fail(code); };
function verifyRetakeRuntimeExit(now = new Date()) {
  let observed;
  try {
    const script = "$ErrorActionPreference='Stop';$start=[DateTimeOffset]::Parse('" + retake.priorEpochStartUTC + "').UtcDateTime;$end=[DateTimeOffset]::Parse('" + retake.priorEpochEndUTC + "').UtcDateTime;" +
      "$nodes=@(Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.StartTime.ToUniversalTime() -ge $start -and $_.StartTime.ToUniversalTime() -le $end } | Select-Object -ExpandProperty Id);" +
      "$ports=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(8028,3144) } | Select-Object -ExpandProperty LocalPort);@{epochNodeIds=$nodes;ports=$ports}|ConvertTo-Json -Compress";
    observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(k => typeof process.env[k] === 'string').map(k => [k,process.env[k]])) }));
  } catch { fail('LIVE_RETAKE_EXIT_UNVERIFIED'); }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now <= new Date(retake.priorEpochEndUTC) ||
      !Array.isArray(observed?.epochNodeIds) || !Array.isArray(observed.ports) || observed.epochNodeIds.length || observed.ports.length)
    fail('LIVE_RETAKE_EXIT_UNVERIFIED');
  const proof = Object.freeze({ atUTC: now.toISOString(), absent: true, ports: Object.freeze([8028,3144]),
    priorEpochStartUTC: retake.priorEpochStartUTC, priorEpochEndUTC: retake.priorEpochEndUTC, noLiveNodeInPriorEpoch: true });
  exitProofs.add(proof);return proof;
}
function validate(input, now) {
  const p = input?.protocol;
  if (!policy.exactKeys(input, ['protocol','approvalRef','exitProof']) || input.approvalRef !== retake.approvalRef ||
      !protocols.isProtocolBinding(p) || p.kind !== 'recording' || p.phase !== 'recording' ||
      p.campaignId !== retake.campaignId || p.authorizationRef !== retake.authorizationRef || p.maximumCalls !== retake.maximumCalls ||
      p.allowedPairs.length !== 1 || p.allowedPairs[0].realm !== retake.realm || p.allowedPairs[0].pairRef !== retake.pairRef ||
      [retake.approvalRef,retake.authorizationRef,retake.previousGoRef,fresh.approvalRef,fresh.previousGoRef,
        fresh.quarantineApprovalRef,fresh.irisQuarantineApprovalRef,fresh.recordingPauseApprovalRef].includes(p.goRef) ||
      !exitProofs.has(input.exitProof) || !input.exitProof.absent ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) || now >= new Date(retake.expiresAt) ||
      now.getTime() < Date.parse(input.exitProof.atUTC) || now.getTime() - Date.parse(input.exitProof.atUTC) > 60000)
    fail('LIVE_RETAKE_NOT_AUTHORIZED');
}
function createRecordingRetake({ connection, now = () => new Date() } = {}) {
  if (!connection?.db || !/^artrelo_judge_budget_control(?:_[a-z0-9_]+)?_test$/.test(connection.name || '') ||
      typeof connection.getClient?.()?.startSession !== 'function') fail('ISOLATED_BUDGET_DATABASE_REQUIRED');
  const client = connection.getClient(), db = connection.db;
  async function release(input) {
    validate(input, now());
    const id = hash({ approvalRef: retake.approvalRef, previousRecoveryRef: retake.previousRecoveryRef, destination: retake.pairRef });
    const session = client.startSession();
    try {
      return await session.withTransaction(async () => {
        validate(input, now());const opt = { session }, p = input.protocol;
        const audits = db.collection('judge_live_recovery_audits'), lanes = db.collection('judge_live_lanes');
        if (await audits.findOne({ _id: id }, opt)) fail('LIVE_RETAKE_ALREADY_APPLIED');
        const previous = await audits.findOne({ _id: retake.previousRecoveryRef }, opt), lane = await lanes.findOne({ _id: laneId }, opt);
        if (!previous || previous.state !== 'active' || previous.action !== retake.previousAction || previous.nextRecoveryRef ||
            !lane || lane.version !== 1 || lane.halted !== false || lane.attemptRef !== null || lane.holderId !== null ||
            lane.recoveryScope?.status !== 'active' || lane.recoveryScope.recoveryRef !== previous._id ||
            hash(previous.destination) !== hash(lane.recoveryScope) || lane.recoveryScope.goRef !== retake.previousGoRef ||
            lane.recoveryScope.protocolHash !== retake.previousProtocolHash || lane.recoveryScope.realm !== retake.realm ||
            lane.recoveryScope.pairRef !== retake.previousPairRef || lane.recoveryScope.approvalRef !== fresh.approvalRef ||
            lane.recoveryScope.originalAttemptRef !== fresh.recordingAttemptRef ||
            lane.recoveryScope.quarantineApprovalRef !== fresh.quarantineApprovalRef ||
            lane.recoveryScope.irisQuarantineApprovalRef !== fresh.irisQuarantineApprovalRef)
          fail('LIVE_RETAKE_BASIS_CHANGED');
        const campaign = await db.collection('judge_live_campaigns').findOne({ _id: retake.campaignId }, opt);
        const config = policy.campaignConfig({ campaignId: retake.campaignId, kind: 'recording', authorizationRef: retake.authorizationRef });
        const category = await db.collection('judge_live_category_slots').findOne({ _id: 'recording' }, opt);
        const original = await db.collection('judge_live_attempts').findOne({ _id: fresh.recordingAttemptRef }, opt);
        const originalPair = original && await db.collection('judge_live_pairs').findOne({ _id: original.pairKey }, opt);
        if (!campaign || campaign.kind !== 'recording' || campaign.configHash !== config.configHash ||
            campaign.pauseNano !== retake.pauseNano || campaign.hardNano !== retake.hardNano || !campaign.halted ||
            campaign.haltReason !== 'transport_unknown' || campaign.chargedNano !== retake.recordingChargedNano ||
            campaign.reservedNano !== retake.recordingReservedNano || campaign.attemptCount !== retake.recordingAttemptCount ||
            campaign.sentCount !== retake.recordingAttemptCount || category?.campaignId !== campaign._id || category.configHash !== config.configHash ||
            !original || original.state !== 'unknown' || original.actualNano !== null || original.usage !== null ||
            original.reservedNano !== fresh.recordingReservedNano || original.pairRef !== fresh.previousPairRef ||
            hash(original) !== previous.beforeHashes?.recordingAttempt || !originalPair || hash(originalPair) !== previous.beforeHashes.recordingPair)
          fail('LIVE_RETAKE_ACCOUNTING_CHANGED');
        const test = await db.collection('judge_live_campaigns').findOne({ _id: policy.TEST_PLAN.campaignId }, opt);
        const unknownTest = await db.collection('judge_live_attempts').findOne({ _id: fresh.testAttemptRef }, opt);
        if (!test || test.chargedNano !== retake.testChargedNano || test.reservedNano !== retake.testReservedNano ||
            test.attemptCount !== retake.testAttemptCount || test.sentCount !== retake.testAttemptCount ||
            hash(test) !== previous.beforeHashes?.testCampaign || !unknownTest || hash(unknownTest) !== previous.beforeHashes.testAttempt)
          fail('LIVE_RETAKE_ACCOUNTING_CHANGED');
        if (await db.collection('judge_live_attempts').countDocuments({ state: { $in: ['reserved','started','unknown'] },
          _id: { $nin: [fresh.recordingAttemptRef,fresh.testAttemptRef] } }, opt)) fail('LIVE_RETAKE_OTHER_UNRESOLVED');
        if (await db.collection('judge_live_model_turn_lanes').countDocuments({ activeTurnRef: { $ne: null } }, opt)) fail('LIVE_RETAKE_ACTIVE_TURN');
        const previousPair = await db.collection('judge_live_pairs').findOne({ _id: hash({ campaignId: retake.campaignId,
          realm: retake.realm, pairRef: retake.previousPairRef }) }, opt);
        if (!previousPair || previousPair.chargedNano !== retake.previousPairChargedNano || previousPair.reservedNano !== 0 ||
            previousPair.attemptCount !== retake.previousPairAttemptCount || previousPair.sentCount !== retake.previousPairAttemptCount)
          fail('LIVE_RETAKE_ACCOUNTING_CHANGED');
        const app = client.db(retake.realm), oldPair = await app.collection('judgesandboxpairs').findOne({
          _id: new ObjectId(retake.previousPairRef), ordinal: 7, active: true }, opt);
        const run = await app.collection('judgesandboxruns').findOne({ _id: new ObjectId(retake.previousRunRef), pairId: new ObjectId(retake.previousPairRef) }, opt);
        const oldRequest = await app.collection('maintenancerequests').findOne({ _id: new ObjectId(retake.previousRequestRef),
          landlordId: oldPair?.landlordId, tenantId: oldPair?.tenantId }, opt);
        if (!oldPair || !run || String(run.requestId) !== retake.previousRequestRef || run.revision !== retake.previousRunRevision ||
            run.state !== 'completed' || run.stepCode !== 'complete' || run.inFlightActionId || run.error || !run.completedAt ||
            !oldRequest || oldRequest.status !== 'completed') fail('LIVE_RETAKE_PRIOR_TAKE_CHANGED');
        const pair = await app.collection('judgesandboxpairs').findOne({ _id: new ObjectId(retake.pairRef), ordinal: retake.ordinal,
          active: true, fixtureVersion: p.manifestHash }, opt);
        const seed = await app.collection('judgesandboxseeds').findOne({ _id: 'judge-core-v1', state: 'ready', manifestHash: p.manifestHash }, opt);
        if (!pair?.landlordId || !pair.tenantId || !seed ||
            await app.collection('judgesandboxruns').countDocuments({ pairId: pair._id }, opt) ||
            await app.collection('maintenancerequests').countDocuments({ $or: [{ landlordId: pair.landlordId },{ tenantId: pair.tenantId }] }, opt) ||
            await app.collection('iristurns').countDocuments({ subjectId: pair.landlordId }, opt) ||
            await app.collection('irismodelattempts').countDocuments({ subjectId: pair.landlordId }, opt) ||
            await db.collection('judge_live_pairs').countDocuments({ realm: retake.realm, pairRef: retake.pairRef }, opt) ||
            await db.collection('judge_live_attempts').countDocuments({ realm: retake.realm, pairRef: retake.pairRef }, opt))
          fail('LIVE_RETAKE_FRESH_PAIR_REQUIRED');
        const releasedAt = now(), destination = { ...lane.recoveryScope, recoveryRef: id, approvalRef: retake.approvalRef,
          goRef: p.goRef, protocolHash: p.protocolHash, pairRef: retake.pairRef, operationalTakeCalls: retake.operationalTakeCalls };
        await audits.insertOne({ _id: id, action: 'release_recording_pair8_retake_only', state: 'active', approvalRef: retake.approvalRef,
          createdAt: releasedAt, destination, exitProof: input.exitProof, previousRecoveryRef: previous._id,
          previousTakeOutcome: 'guide_completed_online_not_accepted', originalOutcomes: 'unknown',
          beforeHashes: { campaign: hash(campaign), category: hash(category), originalAttempt: hash(original), originalPair: hash(originalPair),
            test: hash(test), testAttempt: hash(unknownTest), previousPair: hash(previousPair), priorRun: hash(run), priorRequest: hash(oldRequest),
            previousAudit: hash(previous), lane: hash(lane) } }, opt);
        const linked = await audits.updateOne({ _id: previous._id, state: 'active', nextRecoveryRef: { $exists: false } },
          { $set: { state: 'stopped', stopReason: 'owner_approved_recording_retake', stoppedAt: releasedAt, nextRecoveryRef: id } }, opt);
        const moved = await lanes.updateOne({ _id: laneId, halted: false, attemptRef: null, holderId: null,
          'recoveryScope.recoveryRef': previous._id, 'recoveryScope.status': 'active' },
        { $set: { recoveryScope: destination, updatedAt: releasedAt } }, opt);
        if (linked.modifiedCount !== 1 || moved.modifiedCount !== 1) fail('LIVE_RETAKE_BASIS_CHANGED');
        return { status: 'PAIR8_ONLY_RECORDING_RETAKE_RELEASED', recoveryRef: id, previousRecoveryRef: previous._id,
          goRef: p.goRef, protocolHash: p.protocolHash, operationalTakeCalls: retake.operationalTakeCalls,
          cumulativeRecordingSettledUSD: campaign.chargedNano / policy.NANO, cumulativeRecordingHeldUSD: campaign.reservedNano / policy.NANO,
          cumulativeTESTSettledUSD: test.chargedNano / policy.NANO, cumulativeTESTHeldUSD: test.reservedNano / policy.NANO,
          recordingPauseUSD: config.pauseNano / policy.NANO, recordingHardUSD: config.hardNano / policy.NANO,
          originalOutcomes: 'unknown', pair1Reset: false, providerCalls: 0 };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
  }
  return { release };
}
module.exports = { verifyRetakeRuntimeExit, createRecordingRetake };
