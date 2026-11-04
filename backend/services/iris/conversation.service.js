const { Registry } = require('./registry.service');
const { contract, validate, error, id, hash, iso, safeText } = require('./contract.service');
const { directIntent, planReads } = require('./intent.service');
const { noticeAnswer, clarifyAnswer, compose } = require('./answer.service');
const { assertActionProposal } = require('./proposal.service');
const { modelPolicyDiscussion, nextPolicyDiscussion } = require('./policyDiscussion.service');
const terminal = new Set(['completed', 'refused', 'cancelled', 'interrupted', 'unavailable']);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

// This store deliberately contains transient dialogue only. Persistent turns
// contain no dialogue, answer or confirmation capability. A process restart
// interrupts rather than re-executes a prior accepted turn.
function createConversations({ authorize, reads, changes, Turns, Access, knowledge, planner = null, now = () => new Date(), schedule = fn => setImmediate(fn) }) {
  const conversations = new Map(), tombstones = new Map(), turns = new Map(), clients = new Map(), rates = new Map();
  const stamp = () => now().getTime();
  const ownerKey = auth => auth.subjectId + ':' + auth.accountId + ':' + auth.role;
  function forget(c) {
    conversations.delete(c.id);tombstones.delete(c.id);
    if (clients.get(c.clientKey) === c.id) clients.delete(c.clientKey);
  }
  function lease(c) {
    c.inflight++;
    let released = false;
    return () => { if (!released) { released = true;c.inflight--; } };
  }
  function rate(auth, kind, max, windowMs) {
    const key = ownerKey(auth) + ':' + kind, at = stamp();
    const row = (rates.get(key) || []).filter(x => x > at - windowMs);
    if (row.length >= max) throw error('rate_limited', 'Please wait before trying this Iris action again.', { retryAfterSeconds: Math.ceil((row[0] + windowMs - at) / 1000) });
    row.push(at);rates.set(key, row);
  }
  async function authenticate(user) {
    try { return await authorize(user); }
    catch (err) {
      // A failed current-profile check invalidates every transient capability
      // for that subject. Durable policy receipts remain account-authorized.
      for (const c of conversations.values()) if (c.auth.subjectId === String(user?.id)) expire(c);
      throw err;
    }
  }
  function expire(c) {
    if (c.expired) return;
    c.expired = true;
    for (const turn of c.turns.values()) {
      turn.cancelled = true;
      turn.abort?.abort();
      if (turn.view.preview && !c.confirming.has(turn.view.preview.id)) changes.discard(c.auth, turn.view.preview.id).catch(() => {});
      turns.delete(turn.view.turnId);
      turn.message = '';turn.discussion = [];turn.policyDiscussion = null;turn.answerRecipe = null;turn.view.answer = null;turn.view.preview = null;turn.view.confirmationToken = null;
    }
    c.turns.clear();c.segments = [];c.pendingTrimIds = [];c.registry = null;c.current = null;c.policyFocus = null;
    tombstones.set(c.id, c);
    while (tombstones.size > contract.limits.conversationTombstones) forget(tombstones.values().next().value);
  }
  function sweep() {
    const at = stamp();
    for (const [key, c] of conversations) {
      if (!c.expired && (c.idle <= at || c.absolute <= at)) expire(c);
      if (c.absolute + 86400000 <= at) {
        forget(c);
      }
    }
    for (const [key, row] of rates) if (!row.length || row.at(-1) < at - 900000) rates.delete(key);
  }
  function own(auth, conversationId, touch = true) {
    sweep();
    const c = conversations.get(conversationId);
    if (!c || c.owner !== ownerKey(auth)) throw error('conversation_expired', 'This conversation is no longer available. Start a new conversation.');
    if (c.expired) throw error('conversation_expired', 'This conversation expired. Start a new conversation.');
    if (touch) { c.lastActiveAt = stamp();c.idle = Math.min(c.lastActiveAt + 30 * 60000, c.absolute); }
    return c;
  }
  const conversationView = c => validate('ConversationView', { conversationId: c.id, createdAt: iso(c.created), idleExpiresAt: iso(c.idle), absoluteExpiresAt: iso(c.absolute), limits: { maxMessageChars: 2000, maxTurns: 20 }, serverTime: iso(now()) });
  async function create(user, input) {
    const auth = await authenticate(user);sweep();
    const clientKey = ownerKey(auth) + ':' + input.clientConversationId;
    if (clients.has(clientKey)) return conversationView(own(auth, clients.get(clientKey)));
    if ([...conversations.values()].filter(c => c.owner === ownerKey(auth) && !c.expired).length >= 2) throw error('conversation_limit', 'Close an existing Iris conversation before starting another.');
    const live = [...conversations.values()].filter(c => !c.expired);
    if (live.length >= contract.limits.conversationsPerProcess) {
      const victim = live.filter(c => c.pending === 0 && c.inflight === 0)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt || a.created - b.created || a.id.localeCompare(b.id))[0];
      if (!victim) throw error('service_unavailable', 'Iris is busy. Please try again shortly.', { retryAfterSeconds: 1 });
      expire(victim);
    }
    const at = stamp(), c = { id: id('conv'), clientKey, owner: ownerKey(auth), auth, created: at, lastActiveAt: at, idle: at + 1800000, absolute: at + 7200000, expired: false, current: null, segments: [], pendingTrimIds: [], turns: new Map(), confirming: new Map(), count: 0, pending: 0, inflight: 0, registry: new Registry(auth.subjectId) };
    conversations.set(c.id, c);clients.set(clientKey, c.id);
    return conversationView(c);
  }
  async function context(user, conversationId, input) {
    const auth = await authenticate(user), c = own(auth, conversationId);
    const release = lease(c);
    try {
    // Ownership is checked even for an idempotent generation replay.
    const request = input.requestContextId ? await reads.ownRequest(auth.subjectId, input.requestContextId) : null;
    if (c.current && input.contextGeneration <= c.current.contextGeneration) {
      if (input.contextGeneration === c.current.contextGeneration && input.requestContextId === c.current.requestContextId) return c.current;
      throw error('stale_context', 'The page context changed. Reopen Iris in the current page.');
    }
    const origin = validate('Origin', { segmentId: id('seg'), contextGeneration: input.contextGeneration, requestContextId: input.requestContextId,
      contextKind: request ? 'request' : 'account', contextLabel: request ? safeText(request.issueTitle || 'Maintenance request', 160) : 'Your account policy' });
    c.current = Object.freeze(origin);
    // Empty navigation contexts carry no dialogue, evidence or consent. Avoid
    // retaining thousands of them before a first turn can enforce its cap.
    const occupied = new Set([...c.turns.values()].map(t => t.view.origin.segmentId));
    c.segments = c.segments.filter(s => occupied.has(s.segmentId));c.segments.push(origin);
    c.pendingTrimIds.push(...trim(c, origin.segmentId));
    // Old reads may finish under their original label, but cannot leave an
    // actionable preview behind after the page context changed.
    for (const turn of c.turns.values()) if (turn.view.origin.segmentId !== origin.segmentId && turn.view.preview) {
      if (!c.confirming.has(turn.view.preview.id)) await changes.discard(auth, turn.view.preview.id);
      turn.view.preview = null;turn.view.confirmationToken = null;
    }
    checkActive(c, { cancelled: false });return origin;
    } finally { release(); }
  }
  async function close(user, conversationId) {
    const auth = await authenticate(user), c = conversations.get(conversationId);
    if (!c || c.owner !== ownerKey(auth)) throw error('conversation_expired', 'This conversation is no longer available.');
    expire(c);
    return validate('ConversationClosed', { conversationId, status: 'closed', serverTime: iso(now()) });
  }
  const accepted = turn => validate('AcceptedTurn', { turnId: turn.view.turnId, status: 'accepted', origin: turn.view.origin, serverTime: iso(now()) });
  function memoryBytes(c) {
    return bytes({ segments: c.segments, nextOrdinal: c.nextOrdinal ?? 0, policyFocus: c.policyFocus ?? null, turns: [...c.turns.values()].map(t => ({ message: t.message, ordinal: t.ordinal, discussion: t.discussion, policyDiscussion: t.policyDiscussion ?? null, view: t.view, answerRecipe: t.answerRecipe ?? null })), contexts: [...c.registry.contexts], facts: [...c.registry.facts], sources: [...c.registry.sources], refs: [...c.registry.refs], cursors: [...c.registry.cursors] });
  }
  function trim(c, active, extra = 0) {
    const removed = [];
    for (const segment of [...c.segments]) {
      if (memoryBytes(c) + extra <= contract.limits.transcriptBytes && c.segments.length <= 40) break;
      if (segment.segmentId === active) continue;
      if ([...c.turns.values()].some(t => t.view.origin.segmentId === segment.segmentId && !terminal.has(t.view.status))) continue;
      c.segments = c.segments.filter(s => s.segmentId !== segment.segmentId);
      if (c.policyFocus?.segmentId === segment.segmentId) c.policyFocus = null;
      for (const [key, turn] of c.turns) if (turn.view.origin.segmentId === segment.segmentId) { c.turns.delete(key);turns.delete(turn.view.turnId); }
      c.registry.dropSegments(new Set([segment.segmentId]));removed.push(segment.segmentId);
    }
    if (memoryBytes(c) + extra > contract.limits.transcriptBytes) throw error('transcript_limit', 'This conversation is full. Start a new conversation.');
    return removed;
  }
  // Discussion selection is separate from facts. No evidence refs, previews,
  // tokens, account dialogue or another request can enter model recall.
  function recall(c, origin, excludingTurn) {
    if (!origin.requestContextId) return [];
    return [...c.turns.values()].filter(t => t.view.turnId !== excludingTurn && t.view.origin.requestContextId === origin.requestContextId && terminal.has(t.view.status))
      .slice(-contract.limits.modelRecallTurns).map(t => ({ kind: 'untrusted_discussion', human: safeText(t.message, 1000), answerIntent: t.intentKind || 'read' }));
  }
  async function auditTool(auth, turn, tool, outcome, results = null) {
    try { await Access.create({ subjectId: auth.subjectId, accountId: auth.accountId, turnRef: turn.view.turnId, tool,
      scopeRefHashes: [hash(turn.view.origin.segmentId), ...(turn.view.origin.requestContextId ? [hash(turn.view.origin.requestContextId)] : [])], outcome,
      recordCount: results?.result?.facts?.length || 0, sourceVersionHashes: results?.result?.evidence?.map(e => hash([e.revision, e.hash])) || [] }); }
    catch { throw error('audit_unavailable', 'Iris could not record this read safely. Please try later.'); }
  }
  async function runRead(user, c, turn, tool, args) {
    const auth = await authenticate(user);checkActive(c, turn);
    if (turn.view.origin.requestContextId) await reads.ownRequest(auth.subjectId, turn.view.origin.requestContextId);
    rate(auth, 'reads', 100, 60000);
    const a = { seq: turn.view.activities.length + 1, tool, status: 'started', label: tool === 'search_landlord_help' ? 'Reading the published Policy guide' : 'Reading your authorized records', startedAt: iso(now()), endedAt: null };
    turn.view.activities.push(a);
    try {
      const result = await reads.read(tool, args, { auth, registry: c.registry, turnRef: turn.view.turnId, origin: turn.view.origin });
      await auditTool(auth, turn, tool, result.result.status, result);
      checkActive(c, turn);a.status = 'completed';a.endedAt = iso(now());return result;
    } catch (err) {
      a.status = 'failed';a.endedAt = iso(now());
      if (err.code !== 'audit_unavailable') await auditTool(auth, turn, tool, 'failed');
      throw err;
    }
  }
  function checkActive(c, turn) {
    if (c.expired || c.idle <= stamp() || c.absolute <= stamp() || turn.cancelled) throw error('turn_interrupted', 'This Iris turn stopped.');
  }
  async function execute(user, c, turn) {
    let answerRecipe = null, policyMeaning = null;
    try {
      checkActive(c, turn);turn.view.status = 'reading';
      // The configured planner owns online language interpretation. The narrow
      // phrase parser belongs exclusively to the offline/unavailable lane.
      let intent = planner ? { kind: 'read' } : directIntent(turn.message);turn.intentKind = intent.kind;
      turn.discussion = recall(c, turn.view.origin, turn.view.turnId); // private, untrusted and never factual authority
      if (intent.kind === 'unsupported') {
        turn.view.answer = noticeAnswer('unsupported_setting', 'Iris can preview a positive CAD default quota and Low or Medium autopilot changes. Other settings, approvals and spending actions stay with the existing human controls.', now());turn.view.status = 'refused';
      } else if (intent.kind === 'clarify') {
        turn.view.answer = clarifyAnswer(intent.code, now(), { offline: true });turn.view.status = 'completed';
      } else {
        const results = [], tools = planner ? ['read_policy'] : intent.kind === 'write' ? ['read_policy'] : planReads(turn.message, Boolean(turn.view.origin.requestContextId));
        let previewPrepared = false, guardedPreview = null;
        let proposedPolicy = null;
        const requestRef = turn.view.origin.requestContextId ? c.registry.reference('req', turn.view.origin.requestContextId, turn.view.origin.segmentId) : null;
        const completedTools = new Set();
        const run = async (tool, args) => { const result = await runRead(user, c, turn, tool, args);results.push(result);completedTools.add(tool);return result.result; };
        const standardArgs = tool => {
          const args = tool === 'read_policy' ? {} : tool === 'search_landlord_help' ? { query: safeText(turn.message, 160), featureRef: null, cursor: null, limit: 2 }
            : tool === 'read_costs' ? { requestRef, subjectRef: null, revision: null, cursor: null, limitSnapshots: 2 }
              : { requestRef, cursor: null, limit: tool === 'read_scheduling' ? 3 : 8 };
          return args;
        };
        const preview = async (args, proposal = null, offline = false) => {
          previewPrepared = true;
          const auth = await authenticate(user);checkActive(c, turn);
          if (planner && !offline) assertActionProposal(proposal, { auth, origin: turn.view.origin, message: turn.message, proposed: args, turnRef: turn.view.turnId });
          if (c.current.segmentId !== turn.view.origin.segmentId) throw error('stale_context', 'The page changed before the preview was ready. Ask again in the current context.');
          rate(auth, 'preview', 20, 900000);
          const result = await changes.preview({ auth, origin: turn.view.origin, message: turn.message, proposed: args, registry: c.registry, turnRef: turn.view.turnId, proposal });
          proposedPolicy = args;
          if (result.noop || result.mismatch) guardedPreview = result;
          if (result.currentFactIds) {
            // The fresh draft check supersedes this turn's seed Policy read,
            // even when Policy changed between retrieval and interpretation.
            // Earlier turns keep their own immutable historical snapshots.
            const keep = new Set(result.currentFactIds);
            for (const [ref, row] of c.registry.sources) if (row.turnRef === turn.view.turnId && row.evidence.kind === 'policy_revision' && !row.factIds.some(key => keep.has(key))) {
              row.factIds.forEach(key => c.registry.facts.delete(key));c.registry.sources.delete(ref);
            }
            for (const prior of results) if (prior.result.tool === 'read_policy') { prior.result.data = null;prior.result.facts = [];prior.result.evidence = []; }
          }
          if (result.preview && (turn.cancelled || c.expired || c.current.segmentId !== turn.view.origin.segmentId)) {
            await changes.discard(auth, result.preview.id);throw error('turn_interrupted', 'The preview was discarded because the context changed.');
          }
          turn.view.preview = result.preview;turn.view.confirmationToken = result.confirmationToken;
          try { await auditTool(auth, turn, 'preview_policy_change', result.mismatch ? 'current_value_differs' : result.noop ? 'no_change' : 'preview_ready', { result: { facts: result.facts || [], evidence: result.evidence || [] } }); }
          catch (err) { if (result.preview) await changes.discard(auth, result.preview.id);throw err; }
          // Only safe preview facts may reach the planner. The UI-only token
          // remains private to TurnView and is never in this tool result.
          const p = result.preview;
          const page = validate('ToolResult_preview_policy_change', { schemaVersion: 2, tool: 'preview_policy_change', status: 'ok', observedAt: iso(now()), facts: result.facts || [], evidence: result.evidence || [],
            data: p ? { previewRef: p.id, basePolicyRevision: p.basePolicyRevision, policyExisted: p.basePolicyRevision !== null, patchHash: p.patchHash, impactHash: p.impactHash, createdAt: p.asOf, expiresAt: p.expiresAt,
              changes: p.changes, impactCounts: p.impactCounts, impactCursor: p.impactCursor, complete: p.impactComplete } : null, nextCursor: null, truncated: false, errorCode: null });
          results.push({ result: page, notice: null });return page;
        };
        for (const tool of planner ? tools.slice(0, 2) : tools) await run(tool, standardArgs(tool));
        let selection = null, modelFallback = false;
        if (planner) {
          try {
            const auth = await authenticate(user);
            selection = await planner({ auth, registry: c.registry, turnRef: turn.view.turnId, origin: turn.view.origin, requestRef, message: turn.message, discussion: turn.discussion, policyDiscussion: turn.policyDiscussion, toolResults: results,
              signal: turn.abort.signal,
              beforeModel: async () => { const current = await authenticate(user);checkActive(c, turn);if (turn.view.origin.requestContextId) await reads.ownRequest(current.subjectId, turn.view.origin.requestContextId); },
              isCancelled: () => turn.cancelled || c.expired || c.current.segmentId !== turn.view.origin.segmentId,
              getPreview: () => turn.view.preview,
              runTool: (tool, args, proposal) => tool === 'preview_policy_change' ? preview(args, proposal) : run(tool, args) });
          } catch (err) {
            if (!['model_unavailable', 'invalid_model_output', 'tool_limit'].includes(err.code)) throw err;
            modelFallback = true;
            // Invalid online proposals never become hidden phrase-filter writes.
            // A genuine unavailable model can use the explicitly offline lane.
            if (turn.view.preview) await changes.discard(c.auth, turn.view.preview.id);
            turn.view.preview = null;turn.view.confirmationToken = null;
            if (err.code === 'model_unavailable' && !previewPrepared) intent = directIntent(turn.message);
            if (intent.kind !== 'clarify') for (const tool of planReads(turn.message, Boolean(turn.view.origin.requestContextId))) if (!completedTools.has(tool)) await run(tool, standardArgs(tool));
          }
        }
        checkActive(c, turn);turn.view.status = 'formatting';
        if (intent.kind === 'write' && !previewPrepared) await preview(intent.input, null, true);
        const selected = guardedPreview?.currentFactIds || selection?.selected || null;
        const explanation = guardedPreview || selection?.outcome ? null : selection?.explanation || null;
        turn.view.answer = results.length ? compose({ registry: c.registry, turnRef: turn.view.turnId, results, ...(selection ? { source: selection.source, model: selection.model } : {}), selected, explanation, now: now() }) : noticeAnswer('request_context_required', 'Open Requests, choose a request, then ask Iris for its history. You can ask about your current Policy here.', now());
        if (results.length) answerRecipe = {
          // The canonical facts and exact source revisions already live in the
          // registry. Retain only rendering choices, flags and stable block IDs.
          // This recipe is included in the strict owner-approved transcript memory accounting.
          results: results.map(x => ({ result: { status: x.result.status, truncated: Boolean(x.result.truncated) }, notice: x.notice ?? null })),
          selected, explanation, source: turn.view.answer.source, model: turn.view.answer.model,
          observedAt: turn.view.answer.observedAt, blockIds: turn.view.answer.blocks.map(b => b.id), extraBlocks: []
        };
        if (modelFallback) turn.view.answer.blocks.push({ id: id('block'), kind: 'notice', sourceType: 'system_notice', code: 'unavailable', text: 'The model is unavailable. These are your authorized backend records and published guide facts.', evidenceRefs: [] });
        if (selection?.explanationUnavailable && !guardedPreview) turn.view.answer.blocks.push({ id: id('block'), kind: 'notice', sourceType: 'system_notice', code: 'explanation_unavailable', text: 'A verified explanation is unavailable. Your authorized records are shown.', evidenceRefs: [] });
        if (guardedPreview?.mismatch) turn.view.answer.blocks.push(...clarifyAnswer('current_value_differs', now(), { offline: !selection }).blocks);
        else if (guardedPreview?.noop) turn.view.answer.blocks.push({ id: id('block'), kind: 'notice', sourceType: 'system_notice', code: 'no_change_needed', text: 'This setting already matches your current Policy. No change was prepared.', evidenceRefs: [] });
        else if (selection?.outcome === 'clarify') turn.view.answer.blocks.push(...clarifyAnswer(selection.clarificationCode, now()).blocks);
        else if (selection?.outcome === 'refuse') turn.view.answer.blocks.push(...noticeAnswer(selection.clarificationCode === 'restricted_topic' ? 'restricted_topic' : 'unsupported_setting', 'Iris can explain your authorized records and preview a positive CAD default quota or Low/Medium autopilot change. Use the existing human controls for other actions.', now()).blocks);
        else if (modelFallback && intent.kind === 'clarify') turn.view.answer.blocks.push(...clarifyAnswer(intent.code, now(), { offline: true }).blocks);
        turn.intentKind = selection?.outcome === 'clarify' ? 'clarify' : selection?.outcome === 'refuse' ? 'unsupported' : previewPrepared ? 'write' : intent.kind;
        turn.view.status = selection?.outcome === 'refuse' ? 'refused' : 'completed';
        if (!modelFallback) policyMeaning = nextPolicyDiscussion({ selection, registry: c.registry, turnRef: turn.view.turnId, proposed: proposedPolicy, answer: turn.view.answer });
      }
      await authenticate(user);checkActive(c, turn);
      if (answerRecipe) {
        answerRecipe.extraBlocks = turn.view.answer.blocks.slice(answerRecipe.blockIds.length);
        turn.answerRecipe = answerRecipe;turn.view.answer = null;
      }
      turn.view.trimmedSegmentIds.push(...trim(c, c.current.segmentId));
      // An older/slower completion cannot replace the topic of a later accepted
      // human turn. Failed, unrelated or cancelled latest turns clear the focus.
      if (planner && turn.ordinal === c.nextOrdinal) c.policyFocus = policyMeaning && c.segments.some(s => s.segmentId === turn.view.origin.segmentId) ? Object.freeze({ ...policyMeaning, segmentId: turn.view.origin.segmentId }) : null;
    } catch (err) {
      if (turn.view.preview) await changes.discard(c.auth, turn.view.preview.id).catch(() => {});
      turn.answerRecipe = null;turn.view.preview = null;turn.view.confirmationToken = null;turn.view.answer = null;
      turn.view.status = turn.cancelled ? 'cancelled' : err.code === 'turn_interrupted' ? 'interrupted' : 'unavailable';
      turn.view.error = validate('Error', { code: Object.hasOwn(contract.errors, err.code) ? err.code : 'service_unavailable', message: Object.hasOwn(contract.errors, err.code) ? err.message.slice(0, 800) : 'Iris is unavailable. Your existing records and settings are unchanged.', retryAfterSeconds: err.retryAfterSeconds ?? null });
      if (turn.ordinal === c.nextOrdinal) c.policyFocus = null;
      // Never retain a too-large active answer/registry after failing closed.
      if (err.code === 'transcript_limit' && c.registry) {
        c.full = true;
        c.registry.dropSegments(new Set(c.segments.map(s => s.segmentId)));
        for (const cached of c.turns.values()) { cached.message = '';cached.discussion = [];cached.policyDiscussion = null;cached.answerRecipe = null;cached.view.answer = null; }
      }
    } finally {
      turn.view.serverTime = iso(now());c.pending--;
      await Turns.updateOne({ turnRef: turn.view.turnId, subjectId: c.auth.subjectId }, { $set: { status: turn.view.status } }).catch(() => {});
    }
  }
  async function accept(user, conversationId, input) {
    const auth = await authenticate(user), c = own(auth, conversationId);
    const release = lease(c);
    try {
    const duplicate = c.turns.get(input.clientTurnId);
    if (duplicate) {
      if (duplicate.inputHash !== hash(input)) throw error('invalid_input', 'This turn identifier belongs to a different message.');
      await duplicate.acceptance;
      return accepted(duplicate);
    }
    if (c.full) throw error('transcript_limit', 'This conversation is full. Start a new conversation.');
    if (!c.current || c.current.contextGeneration !== input.contextGeneration || c.current.requestContextId !== input.requestContextId) throw error('context_mismatch', 'Resolve the current page context before sending.');
    if (input.requestContextId) await reads.ownRequest(auth.subjectId, input.requestContextId);
    const raced = c.turns.get(input.clientTurnId);
    if (raced) {
      if (raced.inputHash !== hash(input)) throw error('invalid_input', 'This turn identifier belongs to a different message.');
      await raced.acceptance;return accepted(raced);
    }
    if (c.expired || c.current.contextGeneration !== input.contextGeneration || c.current.requestContextId !== input.requestContextId) throw error('context_mismatch', 'The page changed before this message was accepted.');
    if (bytes(input.text) > contract.limits.messageBytes || !input.text.trim()) throw error('invalid_input', 'Enter a shorter Iris message.');
    if (c.count >= 20) throw error('turn_limit', 'This conversation reached its turn limit. Start a new conversation.');
    if ([...conversations.values()].filter(x => x.owner === c.owner).reduce((sum, x) => sum + x.pending, 0) >= 2) throw error('concurrent_turn_limit', 'Wait for an Iris turn to finish before sending another.');
    let trimmed;
    try { trimmed = [...c.pendingTrimIds, ...trim(c, c.current.segmentId, bytes(input.text) + 2048)]; }
    catch (err) { if (err.code === 'transcript_limit') c.full = true;throw err; }
    rate(auth, 'turn', 20, 900000);
    const turnRef = id('turn'), origin = c.current;
    // Usage count can roll back after failed durable acceptance. A separate
    // monotonic order must never roll back or reassign an older topic's turn.
    c.nextOrdinal = (c.nextOrdinal || 0) + 1;
    const turn = { message: input.text, inputHash: hash(input), ordinal: c.nextOrdinal,
      policyDiscussion: planner && c.pending === 0 ? modelPolicyDiscussion(c.policyFocus) : null,
      cancelled: false, abort: new AbortController(), view: validate('TurnView', { schemaVersion: 2, turnId: turnRef, conversationId, origin, trimmedSegmentIds: trimmed, status: 'accepted', activities: [], answer: null, preview: null, confirmationToken: null, error: null, serverTime: iso(now()) }) };
    // Reserve synchronously before durable acceptance so concurrent requests
    // cannot oversubscribe the turn/concurrency caps.
    c.count++;c.pending++;c.turns.set(input.clientTurnId, turn);turns.set(turnRef, { c, turn });
    turn.acceptance = Turns.create({ turnRef, subjectId: auth.subjectId, accountId: auth.accountId, role: auth.role, clientTurnId: input.clientTurnId, conversationHash: hash(conversationId), requestId: origin.requestContextId, contextGeneration: origin.contextGeneration, status: 'accepted', expiresAt: new Date(stamp() + 86400000) });
    try { await turn.acceptance; }
    catch (err) {
      c.count--;c.pending--;c.turns.delete(input.clientTurnId);turns.delete(turnRef);
      if (turn.ordinal === c.nextOrdinal) c.policyFocus = null;
      throw error(err.code === 11000 ? 'turn_interrupted' : 'audit_unavailable', err.code === 11000 ? 'This turn was already accepted. It will not run again. Start a new message after checking the earlier result.' : 'Iris could not record this turn. No action was started.');
    }
    c.pendingTrimIds = [];schedule(() => execute(user, c, turn));return accepted(turn);
    } finally { release(); }
  }
  async function getTurn(user, turnRef) {
    const auth = await authenticate(user);sweep();
    rate(auth, 'reads', 100, 60000);
    const row = turns.get(turnRef);
    if (!row) throw error('conversation_expired', 'This conversation is no longer available. Start a new conversation.');
    own(auth, row.c.id, false); // Background result polling is not human activity.
    const release = lease(row.c);
    try {
    if (row.turn.view.origin.requestContextId) await reads.ownRequest(auth.subjectId, row.turn.view.origin.requestContextId);
    let answer = row.turn.view.answer;
    const recipe = row.turn.answerRecipe;
    if (recipe) {
      answer = compose({ registry: row.c.registry, turnRef, results: recipe.results, selected: recipe.selected,
        source: recipe.source, model: recipe.model, explanation: recipe.explanation, now: new Date(recipe.observedAt) });
      if (answer.blocks.length !== recipe.blockIds.length) throw error('stale_evidence', 'This earlier answer is no longer available.');
      answer.blocks.forEach((block, index) => { block.id = recipe.blockIds[index]; });
      answer.blocks.push(...recipe.extraBlocks);
    }
    checkActive(row.c, { cancelled: false });
    return validate('TurnView', { ...row.turn.view, answer, serverTime: iso(now()) });
    } finally { release(); }
  }
  async function cancel(user, turnRef) {
    const auth = await authenticate(user);sweep();
    const row = turns.get(turnRef);
    if (!row || row.c.owner !== ownerKey(auth)) throw error('record_not_found', 'This turn is not available.');
    const release = lease(row.c);
    try {
    const { turn } = row;
    if (!terminal.has(turn.view.status)) { turn.cancelled = true;turn.abort.abort();turn.view.status = 'cancelled'; }
    if (turn.ordinal === row.c.nextOrdinal) row.c.policyFocus = null;
    if (turn.view.preview) {
      if (!row.c.confirming.has(turn.view.preview.id)) await changes.discard(auth, turn.view.preview.id);
      turn.view.preview = null;turn.view.confirmationToken = null;
    }
    return validate('Cancellation', { turnId: turnRef, status: turn.view.status, serverTime: iso(now()) });
    } finally { release(); }
  }
  async function evidence(user, ref) {
    const auth = await authenticate(user);sweep();rate(auth, 'reads', 100, 60000);
    for (const c of conversations.values()) {
      if (c.expired || c.owner !== ownerKey(auth)) continue;
      const source = c.registry.sources.get(ref);if (!source) continue;
      const release = lease(c);
      try {
      if (source.evidence.requestId) await reads.ownRequest(auth.subjectId, source.evidence.requestId);
      if (source.pointer.model === 'help' && !knowledge.get(source.pointer.articleId, source.pointer.revision)) throw error('stale_evidence', 'This published guide is no longer available.');
      if (reads.verifyEvidence) await reads.verifyEvidence(auth, source);
      const pseudo = { view: { turnId: source.turnRef, origin: { segmentId: source.scope, requestContextId: source.evidence.requestId } } };
      await auditTool(auth, pseudo, 'evidence_peek', 'ok');
      checkActive(c, { cancelled: false });
      return validate('EvidenceView', { evidence: source.evidence, facts: c.registry.factsForSource(source).slice(0, 50), observedAt: iso(now()) });
      } finally { release(); }
    }
    if (changes.auditEvidence) {
      const durable = await changes.auditEvidence(auth, ref);
      await auditTool(auth, { view: { turnId: durable.turnRef, origin: { segmentId: 'policy_receipt_' + ref, requestContextId: null } } }, 'policy_receipt_peek', 'ok');
      return durable.view;
    }
    throw error('record_not_found', 'This source is no longer available.');
  }
  function assertOriginActive(auth, origin) {
    sweep();
    const found = [...conversations.values()].find(c => c.owner === ownerKey(auth) && !c.expired && c.current?.segmentId === origin.segmentId);
    if (!found) throw error('preview_expired', 'This preview is no longer active. Review a fresh preview.');
    return found;
  }
  function reserveConfirm(auth, origin, previewId) {
    const c = assertOriginActive(auth, origin), release = lease(c);
    c.confirming.set(previewId, (c.confirming.get(previewId) || 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const remaining = c.confirming.get(previewId) - 1;
      if (remaining) c.confirming.set(previewId, remaining);else c.confirming.delete(previewId);
      release();
      if (c.expired && !remaining) await changes.discard(c.auth, previewId).catch(() => {});
    };
  }
  const timer = setInterval(sweep, 1000);timer.unref?.();
  return { create, context, close, accept, getTurn, cancel, evidence, authenticate, rate, sweep, recall, conversations, tombstones, assertOriginActive, reserveConfirm, dispose: () => clearInterval(timer) };
}
module.exports = { createConversations };
