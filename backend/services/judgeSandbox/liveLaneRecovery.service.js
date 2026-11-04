'use strict';
// Explicit owner-only recovery, never registered on an HTTP/business route.
// Unknown TEST money and the original attempt remain untouched.
const { execFileSync } = require('node:child_process');
const { hash } = require('./contract.service');
const policy = require('./liveBudgetPolicy.service');
const protocols = require('./liveProtocol.service');
const APPROVAL = 'msg_dacfd06dda9c';
const TEST_APPROVAL = 'msg_6c44a602a73b';
// Owner dropped pair5 resume and waived its completed-run prerequisite for
// this recording only. This reference is never an execution GO.
const RECORDING_WAIVER = 'msg_bfba169914d8';
const ATTEMPT = 'guarded_70c1d518-90bf-451d-95bb-7cad5ed6c826';
const RECORDING = 'iris-recording-20261104-v1';
const PAIR1 = '6ae8e1dcbbeb8e11afb110de';
const PAIR4 = '6ae8e1dfbbeb8e11afb11144';
const PAIR5 = '6ae8e1e1bbeb8e11afb11166';
const PAIR5_RUN = '6aeb0440e9f3579f9599c876';
const PAIR5_REQUEST = '6aeb04d3e9f3579f9599f98b';
const PAIR5_COMPLETION = '6aeb0f69e9f3579f959cd4cd';
const PAIR5_CLARIFICATION = '6aeb0f70e9f3579f959cd7a5';
const PAIR5_LANDLORD = '6ae8e1e1bbeb8e11afb11151';
const PAIR5_INVOICE_HASH = 'e5ffff2805fb5f965dd47edd26e2e5029e870102f3a6ed0820322f9d8ffc9414';
const LANE = 'meta-standard-single-flight-v1';
const RESERVE = 1321345000;
const exitProofs = new WeakSet();

function verifyPriorRuntimeExit(now = new Date(), priorPids = [25980, 12372]) {
  // Fixed public process/port metadata only: no commands, env, terminal or keys.
  let observed;
  try {
    if (!Array.isArray(priorPids) || priorPids.length !== 2 || new Set(priorPids).size !== 2 ||
        priorPids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw Error('INVALID_PIDS');
    const script = "$ErrorActionPreference='Stop';$p=@(Get-Process | Where-Object { $_.Id -in @(" + priorPids.join(',') + ") } | Select-Object -ExpandProperty Id);$l=@(Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in @(8028,3144) } | Select-Object -ExpandProperty LocalPort);@{processIds=$p;ports=$l}|ConvertTo-Json -Compress";
    observed = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(['SystemRoot','WINDIR','PATH','TEMP','TMP'].filter(key => typeof process.env[key] === 'string').map(key => [key,process.env[key]])) }));
  } catch { throw policy.fail('LIVE_RECOVERY_EXIT_UNVERIFIED'); }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) ||
      !Array.isArray(observed?.processIds) || !Array.isArray(observed?.ports) || observed.processIds.length || observed.ports.length)
    throw policy.fail('LIVE_RECOVERY_EXIT_UNVERIFIED');
  const proof = Object.freeze({ atUTC: now.toISOString(), processIds: Object.freeze([...priorPids]),
    ports: Object.freeze([8028, 3144]), absent: true });
  exitProofs.add(proof);return proof;
}

function validateRelease({ protocol, approvalRef, exitProof, acceptanceRef, waiverRef }, now, kind) {
  const isTest = kind === 'test';
  const waived = !isTest && waiverRef === RECORDING_WAIVER;
  const buildRefs = [APPROVAL, TEST_APPROVAL, RECORDING_WAIVER];
  if (approvalRef !== (isTest ? TEST_APPROVAL : APPROVAL) || !protocols.isProtocolBinding(protocol) || protocol.kind !== kind ||
      protocol.phase !== (isTest ? 'test-rehearsal-b' : 'recording') || protocol.campaignId !== (isTest ? policy.TEST_PLAN.campaignId : RECORDING) || protocol.allowedPairs.length !== 1 ||
      protocol.allowedPairs[0].realm !== policy.TEST_PLAN.realm || protocol.allowedPairs[0].pairRef !== (isTest ? PAIR5 : PAIR1) ||
      isTest && (protocol.phaseMaximumCalls !== 20 || protocol.testPlanHash !== policy.TEST_PLAN_HASH) ||
      isTest && waiverRef != null || !isTest && waiverRef != null && !waived ||
      waived && acceptanceRef != null ||
      !isTest && !waived && (!/^msg_[a-f0-9]{12}$/.test(acceptanceRef || '') || [...buildRefs, protocol.goRef].includes(acceptanceRef)) ||
      buildRefs.includes(protocol.goRef) || !exitProofs.has(exitProof) || !exitProof.absent ||
      !(now instanceof Date) || !Number.isFinite(now.getTime()) || now >= new Date(policy.EXPIRES_AT) ||
      now.getTime() < Date.parse(exitProof.atUTC) || now.getTime() - Date.parse(exitProof.atUTC) > 60000)
    throw policy.fail('LIVE_RECOVERY_NOT_AUTHORIZED');
}

function createLiveLaneRecovery({ connection, now = () => new Date() } = {}) {
  if (!connection?.db || !/^artrelo_judge_budget_control(?:_[a-z0-9_]+)?_test$/.test(connection.name || '') ||
      typeof connection.getClient !== 'function' || typeof connection.getClient()?.startSession !== 'function')
    throw policy.fail('ISOLATED_BUDGET_DATABASE_REQUIRED');
  const campaigns = connection.db.collection('judge_live_campaigns');
  const attempts = connection.db.collection('judge_live_attempts');
  const pairs = connection.db.collection('judge_live_pairs');
  const lanes = connection.db.collection('judge_live_lanes');
  const audits = connection.db.collection('judge_live_recovery_audits');
  async function release(input, kind) {
    validateRelease(input, now(), kind);
    const isTest = kind === 'test';
    const waived = !isTest && input.waiverRef === RECORDING_WAIVER;
    const { protocol, approvalRef, exitProof } = input;
    const id = hash({ approvalRef, attemptRef: ATTEMPT, destination: kind });
    const session = connection.getClient().startSession();
    try {
      return await session.withTransaction(async () => {
        validateRelease(input, now(), kind);
        const opt = { session };
        if (await audits.findOne({ _id: id }, opt)) throw policy.fail('LIVE_RECOVERY_ALREADY_APPLIED');
        const lane = await lanes.findOne({ _id: LANE }, opt);
        const attempt = await attempts.findOne({ _id: ATTEMPT }, opt);
        const campaign = await campaigns.findOne({ _id: policy.TEST_PLAN.campaignId }, opt);
        const expected = policy.campaignConfig({ campaignId: policy.TEST_PLAN.campaignId, kind: 'test', authorizationRef: policy.TEST_PLAN.authorizationRef });
        const initialLane = lane && lane.version === 1 && lane.halted === true && lane.haltReason === 'transport_unknown' &&
          lane.attemptRef === ATTEMPT && lane.campaignId === policy.TEST_PLAN.campaignId && !lane.recoveryScope;
        const priorScope = lane?.recoveryScope;
        const cleanTestLane = lane && lane.version === 1 && lane.halted === false && lane.attemptRef === null &&
          priorScope?.kind === 'test' && priorScope.status === 'active' && priorScope.approvalRef === TEST_APPROVAL &&
          priorScope.campaignId === policy.TEST_PLAN.campaignId && priorScope.realm === policy.TEST_PLAN.realm && priorScope.pairRef === PAIR5 &&
          priorScope.originalAttemptRef === ATTEMPT && priorScope.retainedReservedNano === RESERVE &&
          priorScope.originalHaltReason === 'transport_unknown' && priorScope.expiresAt === policy.EXPIRES_AT;
        if (!(isTest ? initialLane : cleanTestLane) ||
            !attempt || attempt.state !== 'unknown' || attempt.haltReason !== 'transport_unknown' ||
            attempt.campaignId !== policy.TEST_PLAN.campaignId || attempt.realm !== policy.TEST_PLAN.realm || attempt.pairRef !== PAIR4 ||
            attempt.actualNano !== null || attempt.usage !== null || attempt.reservedNano !== RESERVE ||
            !attempt.wireClaimedAt || !attempt.holderId || isTest && lane.holderId !== attempt.holderId ||
            !campaign || campaign.kind !== 'test' || campaign.halted !== true || campaign.haltReason !== 'transport_unknown' ||
            campaign.configHash !== expected.configHash || campaign.baselineNano !== expected.baselineNano ||
            campaign.baselineRef !== expected.baselineRef || campaign.testPlanHash !== expected.testPlanHash ||
            !Number.isSafeInteger(campaign.chargedNano) || campaign.chargedNano < 472977750 ||
            campaign.reservedNano !== RESERVE || !Number.isSafeInteger(campaign.attemptCount) || campaign.attemptCount < 3 ||
            !Number.isSafeInteger(campaign.sentCount) || campaign.sentCount !== campaign.attemptCount)
          throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        if (await attempts.countDocuments({ state: { $in: ['reserved', 'started', 'unknown'] }, _id: { $ne: ATTEMPT } }, opt))
          throw policy.fail('LIVE_RECOVERY_OTHER_UNRESOLVED');
        if (await connection.db.collection('judge_live_model_turn_lanes').countDocuments({ activeTurnRef: { $ne: null } }, opt))
          throw policy.fail('LIVE_RECOVERY_ACTIVE_TURN');
        const pair = await pairs.findOne({ _id: attempt.pairKey }, opt);
        if (!pair || pair._id !== hash({ campaignId: campaign._id, realm: policy.TEST_PLAN.realm, pairRef: PAIR4 }) ||
            pair.campaignId !== campaign._id || pair.pairRef !== PAIR4 || pair.reservedNano !== RESERVE)
          throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        let waiverEvidence = null;
        if (!isTest) {
          const prior = await audits.findOne({ _id: priorScope.recoveryRef, state: 'active', action: 'release_test_pair5_only' }, opt);
          if (!prior || hash(prior.destination) !== hash(priorScope) || protocol.goRef === priorScope.goRef) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
          const ObjectId = require('mongodb').ObjectId, app = connection.getClient().db(policy.TEST_PLAN.realm);
          const run = await app.collection('judgesandboxruns').findOne(
            { pairId: new ObjectId(PAIR5) }, { ...opt, projection: { state: 1, stepCode: 1, error: 1, inFlightActionId: 1, completedAt: 1,
              requestId: 1, landlordId: 1, paused: 1, completedDirectives: 1 } });
          if (waived) {
            if (!run || String(run._id) !== PAIR5_RUN || String(run.requestId) !== PAIR5_REQUEST || String(run.landlordId) !== PAIR5_LANDLORD ||
                run.state !== 'waiting_on_landlord' || run.stepCode !== 'landlord_review' || run.error || run.inFlightActionId || run.completedAt ||
                run.paused || !Array.isArray(run.completedDirectives) || !run.completedDirectives.includes('vendor_work')) throw policy.fail('LIVE_RECOVERY_WAIVER_BASIS_CHANGED');
            const owned = { landlordId: new ObjectId(PAIR5_LANDLORD), requestId: new ObjectId(PAIR5_REQUEST) };
            const request = await app.collection('maintenancerequests').findOne({ _id: owned.requestId, landlordId: owned.landlordId,
              archivedAt: null, status: 'approved' }, { ...opt, projection: { status: 1, landlordId: 1, finalCost: 1 } });
            const completion = await app.collection('jobcompletions').findOne({ _id: new ObjectId(PAIR5_COMPLETION), ...owned,
              status: 'confirmed', quoteContractVersion: 2, closedAt: null, 'invoiceReview.state': 'waiting_clarification',
              'tenantConfirmation.outcome': 'confirmed', 'report.actualCost': 240, 'report.finalStatement.revision': 1,
              'report.finalStatement.hash': PAIR5_INVOICE_HASH, 'invoiceReview.quoteHash': PAIR5_INVOICE_HASH },
            { ...opt, projection: { status: 1, report: 1, tenantConfirmation: 1, invoiceReview: 1, closedAt: 1 } });
            if (!request || request.finalCost !== 0 || !completion || String(completion.invoiceReview.clarificationId) !== PAIR5_CLARIFICATION ||
                !completion.invoiceReview.contextHash) throw policy.fail('LIVE_RECOVERY_WAIVER_BASIS_CHANGED');
            const clarification = await app.collection('quoteclarifications').findOne({ _id: new ObjectId(PAIR5_CLARIFICATION), ...owned,
              subjectId: new ObjectId(PAIR5_COMPLETION), stage: 'invoice', state: { $in: ['draft', 'ready'] }, answers: { $size: 0 },
              expiresAt: { $gt: now() }, quoteRevision: 1, quoteHash: PAIR5_INVOICE_HASH, contextHash: completion.invoiceReview.contextHash },
            { ...opt, projection: { stage: 1, state: 1, expiresAt: 1, quoteRevision: 1, quoteHash: 1, contextHash: 1 } });
            if (!clarification) throw policy.fail('LIVE_RECOVERY_WAIVER_BASIS_CHANGED');
            waiverEvidence = { waiverRef: RECORDING_WAIVER, pair5Outcome: 'blocked_invoice_clarification',
              runRef: PAIR5_RUN, requestRef: PAIR5_REQUEST, completionRef: PAIR5_COMPLETION,
              beforeHashes: { run: hash(run), request: hash(request), completion: hash(completion), clarification: hash(clarification) } };
          } else if (!run || run.state !== 'completed' || run.stepCode !== 'complete' || run.error || run.inFlightActionId || !run.completedAt)
            throw policy.fail('LIVE_RECOVERY_PAIR5_CLOSEOUT_REQUIRED');
        }
        const target = await campaigns.findOne({ _id: isTest ? policy.TEST_PLAN.campaignId : RECORDING }, opt);
        if (!isTest && target && (target.kind !== 'recording' || target.halted || target.reservedNano !== 0))
          throw policy.fail('LIVE_RECOVERY_DESTINATION_UNAVAILABLE');
        const releasedAt = now();
        const recoveryScope = { recoveryRef: id, approvalRef, kind, status: 'active', campaignId: protocol.campaignId, protocolHash: protocol.protocolHash,
          goRef: protocol.goRef, realm: policy.TEST_PLAN.realm, pairRef: isTest ? PAIR5 : PAIR1, expiresAt: policy.EXPIRES_AT,
          originalAttemptRef: ATTEMPT, retainedReservedNano: RESERVE, originalHaltReason: 'transport_unknown' };
        await audits.insertOne({ _id: id, state: 'active', action: isTest ? 'release_test_pair5_only' : 'release_recording_only', approvalRef, createdAt: releasedAt,
          exitProof, originalAttemptRef: ATTEMPT, retainedReservedNano: RESERVE,
          beforeHashes: { lane: hash(lane), attempt: hash(attempt), campaign: hash(campaign), pair: hash(pair) },
          destination: recoveryScope, oldRemoteOutcome: 'unknown', originalTestHaltPreserved: true,
          ...(waiverEvidence ? { pair5CompletionWaived: true, waiverEvidence } : {}) }, opt);
        if (!isTest) {
          const closed = await audits.updateOne({ _id: priorScope.recoveryRef, state: 'active' },
            { $set: { state: waived ? 'waived' : 'accepted', ...(waived ? { waiverRef: RECORDING_WAIVER, pair5Outcome: 'blocked_invoice_clarification' } :
              { acceptanceRef: input.acceptanceRef }), closedAt: releasedAt, nextRecoveryRef: id } }, opt);
          if (closed.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        }
        const changed = await lanes.updateOne(isTest ? { _id: LANE, attemptRef: ATTEMPT, holderId: attempt.holderId, halted: true } :
          { _id: LANE, attemptRef: null, halted: false, 'recoveryScope.recoveryRef': priorScope.recoveryRef, 'recoveryScope.status': 'active' },
          { $set: { attemptRef: null, holderId: null, campaignId: null, halted: false, haltReason: null,
            recoveryScope, updatedAt: releasedAt } }, opt);
        if (changed.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        // No writes to original campaign, pair, attempt, source protocol or money.
        return { status: isTest ? 'PAIR5_ONLY_TEST_EXCEPTION_RELEASED' : 'RECORDING_ONLY_LANE_RELEASED', recoveryRef: id, goRef: protocol.goRef,
          protocolHash: protocol.protocolHash, retainedTESTReservedUSD: RESERVE / policy.NANO,
          originalTESTHalted: true, originalRemoteOutcome: 'unknown',
          ...(waived ? { pair5CompletionWaived: true, waiverRef: RECORDING_WAIVER, pair5Outcome: 'blocked_invoice_clarification' } : {}) };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
  }
  return { releaseRecording: input => release(input, 'recording'), releaseTestPair5: input => release(input, 'test') };
}
module.exports = { createLiveLaneRecovery, verifyPriorRuntimeExit };
