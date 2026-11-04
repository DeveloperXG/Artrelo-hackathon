'use strict';
// Explicit owner-only recovery, never registered on an HTTP/business route.
// Unknown TEST money and the original attempt remain untouched.
const { execFileSync } = require('node:child_process');
const { hash } = require('./contract.service');
const policy = require('./liveBudgetPolicy.service');
const fresh = require('../../contracts/judgeSandboxFreshRecording.v1.json');
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
  const categories = connection.db.collection('judge_live_category_slots');
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
  function validateFresh(input) {
    const p = input?.protocol, time = now();
    if (!policy.exactKeys(input, ['protocol', 'approvalRef', 'exitProof']) || input.approvalRef !== fresh.approvalRef ||
        !protocols.isProtocolBinding(p) || p.kind !== 'recording' || p.phase !== 'recording' || p.campaignId !== fresh.campaignId ||
        p.authorizationRef !== fresh.authorizationRef || p.allowedPairs.length !== 1 || p.allowedPairs[0].realm !== fresh.realm ||
        p.allowedPairs[0].pairRef !== fresh.pairRef || p.maximumCalls !== fresh.maximumCalls ||
        [fresh.approvalRef, fresh.quarantineApprovalRef, fresh.irisQuarantineApprovalRef, fresh.timeoutApprovalRef, fresh.recordingPauseApprovalRef, fresh.previousGoRef, fresh.authorizationRef, APPROVAL, TEST_APPROVAL, RECORDING_WAIVER].includes(p.goRef) ||
        !exitProofs.has(input.exitProof) || !input.exitProof.absent || !(time instanceof Date) || !Number.isFinite(time.getTime()) ||
        time >= new Date(fresh.expiresAt) || time.getTime() < Date.parse(input.exitProof.atUTC) ||
        time.getTime() - Date.parse(input.exitProof.atUTC) > 60000) throw policy.fail('LIVE_RECOVERY_NOT_AUTHORIZED');
  }
  async function releaseFreshRecording(input) {
    validateFresh(input);
    const { protocol, approvalRef, exitProof } = input;
    const id = hash({ approvalRef, attemptRef: fresh.recordingAttemptRef, destination: fresh.pairRef });
    const session = connection.getClient().startSession();
    try {
      return await session.withTransaction(async () => {
        validateFresh(input); const opt = { session };
        if (await audits.findOne({ _id: id }, opt)) throw policy.fail('LIVE_RECOVERY_ALREADY_APPLIED');
        const lane = await lanes.findOne({ _id: LANE }, opt);
        const recording = await campaigns.findOne({ _id: fresh.campaignId }, opt);
        const expected = policy.campaignConfig({ campaignId: fresh.campaignId, kind: 'recording', authorizationRef: fresh.authorizationRef });
        const { configHash: nextConfigHash, capAmendmentRef, ...previousValues } = expected;
        previousValues.pauseNano = fresh.previousPauseNano;
        const previousConfigHash = hash(previousValues);
        const category = await categories.findOne({ _id: 'recording' }, opt);
        const original = await attempts.findOne({ _id: fresh.recordingAttemptRef }, opt);
        const previous = await audits.findOne({ _id: fresh.previousRecoveryRef }, opt);
        const stoppedScope = lane?.recoveryScope;
        if (!lane || lane.version !== 1 || lane.halted !== true || lane.haltReason !== 'transport_unknown' ||
            lane.attemptRef !== fresh.recordingAttemptRef || lane.campaignId !== fresh.campaignId ||
            stoppedScope?.kind !== 'recording' || stoppedScope.status !== 'stopped' || stoppedScope.recoveryRef !== fresh.previousRecoveryRef ||
            stoppedScope.goRef !== fresh.previousGoRef || stoppedScope.protocolHash !== fresh.previousProtocolHash ||
            stoppedScope.realm !== fresh.realm || stoppedScope.pairRef !== fresh.previousPairRef ||
            !previous || previous.state !== 'stopped' || previous.action !== 'release_recording_only' || previous.nextRecoveryRef ||
            previous.destination?.goRef !== fresh.previousGoRef || previous.destination?.protocolHash !== fresh.previousProtocolHash ||
            previous.destination?.pairRef !== fresh.previousPairRef || previous.destination?.realm !== fresh.realm ||
            !recording || recording.configHash !== previousConfigHash || recording.pauseNano !== fresh.previousPauseNano ||
            recording.hardNano !== fresh.hardNano || recording.capAmendmentRef || recording.kind !== 'recording' || !recording.halted ||
            !category || category.campaignId !== fresh.campaignId || category.configHash !== previousConfigHash ||
            recording.haltReason !== 'transport_unknown' || recording.chargedNano !== fresh.recordingChargedNano ||
            recording.reservedNano !== fresh.recordingReservedNano || recording.attemptCount !== fresh.recordingAttemptCount ||
            recording.sentCount !== fresh.recordingAttemptCount || expected.pauseNano !== fresh.pauseNano || expected.hardNano !== fresh.hardNano ||
            !original || original.state !== 'unknown' || original.campaignId !== fresh.campaignId || original.configHash !== previousConfigHash ||
            original.realm !== fresh.realm || original.pairRef !== fresh.previousPairRef || original.holderId !== lane.holderId ||
            original.haltReason !== 'transport_unknown' || original.actualNano !== null || original.usage !== null || !original.wireClaimedAt ||
            original.protocolGoRef !== fresh.previousGoRef || original.protocolHash !== fresh.previousProtocolHash ||
            original.reservedNano !== fresh.recordingReservedNano) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        const test = await campaigns.findOne({ _id: policy.TEST_PLAN.campaignId }, opt);
        const testExpected = policy.campaignConfig({ campaignId: policy.TEST_PLAN.campaignId, kind: 'test', authorizationRef: policy.TEST_PLAN.authorizationRef });
        const testAttempt = await attempts.findOne({ _id: fresh.testAttemptRef }, opt);
        if (!test || test.configHash !== testExpected.configHash || test.baselineNano !== testExpected.baselineNano ||
            test.testPlanHash !== testExpected.testPlanHash || !test.halted || test.haltReason !== 'transport_unknown' ||
            test.chargedNano !== fresh.testChargedNano || test.reservedNano !== fresh.testReservedNano ||
            test.attemptCount !== fresh.testAttemptCount || test.sentCount !== fresh.testAttemptCount ||
            !testAttempt || testAttempt.state !== 'unknown' || testAttempt.campaignId !== test._id ||
            testAttempt.reservedNano !== fresh.testReservedNano || testAttempt.actualNano !== null || testAttempt.usage !== null ||
            testAttempt.pairRef !== PAIR4 || testAttempt.realm !== fresh.realm || testAttempt.haltReason !== 'transport_unknown')
          throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        if (await attempts.countDocuments({ state: { $in: ['reserved', 'started', 'unknown'] },
          _id: { $nin: [fresh.testAttemptRef, fresh.recordingAttemptRef] } }, opt)) throw policy.fail('LIVE_RECOVERY_OTHER_UNRESOLVED');
        if (await connection.db.collection('judge_live_model_turn_lanes').countDocuments({ activeTurnRef: { $ne: null } }, opt))
          throw policy.fail('LIVE_RECOVERY_ACTIVE_TURN');
        const oldPair = await pairs.findOne({ _id: original.pairKey }, opt);
        if (!oldPair || oldPair._id !== hash({ campaignId: fresh.campaignId, realm: fresh.realm, pairRef: fresh.previousPairRef }) ||
            oldPair.reservedNano !== fresh.recordingReservedNano || oldPair.chargedNano !== fresh.recordingChargedNano ||
            oldPair.attemptCount !== fresh.recordingAttemptCount || oldPair.sentCount !== fresh.recordingAttemptCount)
          throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        const ObjectId = require('mongodb').ObjectId, app = connection.getClient().db(fresh.realm);
        const pair = await app.collection('judgesandboxpairs').findOne({ _id: new ObjectId(fresh.pairRef), ordinal: fresh.ordinal,
          active: true, fixtureVersion: protocol.manifestHash }, { ...opt, projection: { ordinal: 1, landlordId: 1, tenantId: 1 } });
        const seed = await app.collection('judgesandboxseeds').findOne({ _id: 'judge-core-v1', state: 'ready', manifestHash: protocol.manifestHash },
          { ...opt, projection: { state: 1 } });
        if (!pair || !pair.landlordId || !pair.tenantId || !seed ||
            await app.collection('judgesandboxruns').countDocuments({ pairId: pair._id }, opt) ||
            await app.collection('maintenancerequests').countDocuments({ $or: [{ landlordId: pair.landlordId }, { tenantId: pair.tenantId }] }, opt) ||
            await app.collection('iristurns').countDocuments({ subjectId: pair.landlordId }, opt) ||
            await pairs.countDocuments({ realm: fresh.realm, pairRef: fresh.pairRef }, opt) ||
            await attempts.countDocuments({ realm: fresh.realm, pairRef: fresh.pairRef }, opt)) throw policy.fail('LIVE_RECOVERY_FRESH_PAIR_REQUIRED');
        const consumed = await app.collection('judgesandboxruns').findOne({ pairId: new ObjectId(fresh.previousPairRef) },
          { ...opt, projection: { pairId: 1, requestId: 1, revision: 1, state: 1, stepCode: 1, inFlightActionId: 1 } });
        if (!consumed || String(consumed._id) !== '6ae92901916e242bfd83caac' || String(consumed.requestId) !== '6aeb7ca57fb86a60327ebea9' ||
            consumed.inFlightActionId) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        const releasedAt = now();
        const destination = { recoveryRef: id, approvalRef, kind: 'recording', status: 'active', campaignId: fresh.campaignId,
          protocolHash: protocol.protocolHash, goRef: protocol.goRef, realm: fresh.realm, pairRef: fresh.pairRef, expiresAt: fresh.expiresAt,
          originalAttemptRef: fresh.recordingAttemptRef, retainedReservedNano: fresh.recordingReservedNano, originalHaltReason: 'transport_unknown',
          quarantineApprovalRef: fresh.quarantineApprovalRef,
          irisQuarantineApprovalRef: fresh.irisQuarantineApprovalRef,
          retainedTestAttemptRef: fresh.testAttemptRef, retainedTestReservedNano: fresh.testReservedNano };
        await audits.insertOne({ _id: id, action: 'release_recording_pair7_only', state: 'active', approvalRef, createdAt: releasedAt,
          exitProof, destination, previousRecoveryRef: previous._id, originalRemoteOutcome: 'unknown', originalRecordingHaltPreserved: true,
          capAmendment: { approvalRef: capAmendmentRef, previousPauseNano: fresh.previousPauseNano, pauseNano: expected.pauseNano,
            hardNano: expected.hardNano, previousConfigHash, configHash: nextConfigHash },
          beforeHashes: { lane: hash(lane), recordingCampaign: hash(recording), recordingAttempt: hash(original), recordingPair: hash(oldPair),
            testCampaign: hash(test), testAttempt: hash(testAttempt), pair1Run: hash(consumed), previousAudit: hash(previous) } }, opt);
        const capChanged = await campaigns.updateOne({ _id: fresh.campaignId, configHash: previousConfigHash,
          pauseNano: fresh.previousPauseNano, capAmendmentRef: { $exists: false } },
        { $set: { pauseNano: expected.pauseNano, capAmendmentRef, configHash: nextConfigHash } }, opt);
        const categoryChanged = await categories.updateOne({ _id: 'recording', campaignId: fresh.campaignId, configHash: previousConfigHash },
          { $set: { configHash: nextConfigHash } }, opt);
        if (capChanged.modifiedCount !== 1 || categoryChanged.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        const auditChanged = await audits.updateOne({ _id: previous._id, state: 'stopped', nextRecoveryRef: { $exists: false } },
          { $set: { nextRecoveryRef: id } }, opt);
        if (auditChanged.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        const changed = await lanes.updateOne({ _id: LANE, attemptRef: original._id, holderId: original.holderId, halted: true,
          'recoveryScope.recoveryRef': previous._id, 'recoveryScope.status': 'stopped' },
        { $set: { attemptRef: null, holderId: null, campaignId: null, halted: false, haltReason: null, recoveryScope: destination, updatedAt: releasedAt } }, opt);
        if (changed.modifiedCount !== 1) throw policy.fail('LIVE_RECOVERY_BASIS_CHANGED');
        return { status: 'PAIR7_ONLY_RECORDING_EXCEPTION_RELEASED', recoveryRef: id, goRef: protocol.goRef, protocolHash: protocol.protocolHash,
          capAmendmentRef, recordingPauseUSD: expected.pauseNano / policy.NANO, recordingHardUSD: expected.hardNano / policy.NANO,
          previousConfigHash, configHash: nextConfigHash,
          originalRecordingHalted: true, retainedRecordingReservedUSD: fresh.recordingReservedNano / policy.NANO,
          retainedTESTReservedUSD: fresh.testReservedNano / policy.NANO, originalOutcomes: 'unknown', pair1Reset: false, providerCalls: 0 };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
  }
  return { releaseRecording: input => release(input, 'recording'), releaseTestPair5: input => release(input, 'test'), releaseFreshRecording };
}
module.exports = { createLiveLaneRecovery, verifyPriorRuntimeExit };
