// Pure confirmed-visit change contract. Persistence must apply the sole allowed
// effect atomically with the proposal audit and a fresh calendar/work-state
// check. No opening/answer/expiry action releases or replaces the old visit.
const { createHash } = require('node:crypto');
const HOUR = 3600000;
const RESPONSE_BUFFER_MS = 2 * HOUR;
const MIN_RESPONSE_WINDOW_MS = 15 * 60000;
const fail = code => { throw Object.assign(new Error(code === 'reschedule_response_window_closed'
  ? 'There is not enough time for both people to respond before the two-hour visit cutoff. The original visit stays booked.' : code), { code, status: 409 }); };
const oid = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail('reschedule_identity_required');
  return value.toLowerCase();
};
function date(value) {
  if (!(value instanceof Date)) {
    const parts = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!parts) fail('explicit_time_required');
    const [year, month, day, hour, minute, second] = parts.slice(1).map(value => value === undefined ? 0 : Number(value));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) fail('invalid_reschedule_time');
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) fail('invalid_reschedule_time');
  return result;
}
function slot(value, { availabilityWindow = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('reschedule_slot_required');
  const start = date(value.start), end = date(value.end), minutes = (end - start) / 60000;
  if (minutes < 15 || (!availabilityWindow && (!Number.isInteger(minutes) || minutes > 720 || minutes % 15))) fail('invalid_reschedule_duration');
  return { start: start.toISOString(), end: end.toISOString() };
}
const sameSlot = (a, b) => a.start === b.start && a.end === b.end;
function reason(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 800) fail('reschedule_reason_required');
  return value.trim();
}
function actorOf(proposal, actor, role) {
  if (!actor || actor.role !== role) fail('reschedule_party_required');
  const id = oid(actor.id);
  if (id !== proposal[role === 'vendor' ? 'identityId' : role === 'tenant' ? 'tenantId' : 'landlordId']) fail('reschedule_party_required');
  return { role, id };
}
function event(proposal, type, actor, now) {
  proposal.events.push({ type, actor, revision: proposal.revision, at: now.toISOString(), reason: proposal.reason,
    deadlineAt: proposal.expiresAt, responseBufferMinutes: RESPONSE_BUFFER_MS / 60000,
    oldSlot: { ...proposal.oldSlot }, proposedSlot: proposal.proposedSlot ? { ...proposal.proposedSlot } : null,
    vendorResponse: proposal.vendorResponse.status, tenantResponse: proposal.tenantResponse.status });
}
function pending(proposal, expectedRevision, now) {
  if (!proposal?.active || !Number.isInteger(expectedRevision) || expectedRevision !== proposal.revision) fail('reschedule_revision_conflict');
  if (effectiveDeadline(proposal) <= now) fail('reschedule_expired');
  return structuredClone(proposal);
}
function effectiveDeadline(proposal) {
  const limits = [date(proposal.expiresAt).getTime(), date(proposal.createdAt).getTime() + 48 * HOUR,
    date(proposal.oldSlot.start).getTime() - RESPONSE_BUFFER_MS];
  if (proposal.proposedSlot) limits.push(date(proposal.proposedSlot.start).getTime() - RESPONSE_BUFFER_MS);
  return new Date(Math.min(...limits));
}
function hasResponseWindow({ originalStart, proposedStart = null, now: rawNow = new Date() }) {
  try {
    const now = date(rawNow).getTime();
    return date(originalStart).getTime() - RESPONSE_BUFFER_MS - now >= MIN_RESPONSE_WINDOW_MS &&
      (!proposedStart || date(proposedStart).getTime() - RESPONSE_BUFFER_MS - now >= MIN_RESPONSE_WINDOW_MS);
  } catch (_) { return false; }
}
function enforceDeadline({ proposal, now: rawNow = new Date() }) {
  if (!proposal?.active) return { proposal: structuredClone(proposal), effect: null };
  const now = date(rawNow), next = structuredClone(proposal), deadline = effectiveDeadline(next);
  next.expiresAt = deadline.toISOString();
  if (deadline <= now) return changed(next, 'expired', { role: 'system', id: null }, now, 'expired');
  if (next.expiresAt !== proposal.expiresAt) {
    const result = changed(next, 'response_deadline_shortened', { role: 'system', id: null }, now);
    result.proposal.events.at(-1).previousDeadlineAt = proposal.expiresAt;
    return result;
  }
  return { proposal: next, effect: null };
}
function changed(proposal, type, actor, now, status = proposal.status) {
  proposal.revision++;
  proposal.status = status;
  proposal.active = !['declined', 'expired', 'conflict', 'invalidated', 'committed'].includes(status);
  event(proposal, type, actor, now);
  return { proposal, effect: null };
}
function validateWindows(windows, rawNow = new Date()) {
  const now = date(rawNow);
  if (!Array.isArray(windows) || windows.length < 1 || windows.length > 3) fail('invalid_reschedule_windows');
  return Array.from(windows, value => {
    const next = slot(value, { availabilityWindow: true });
    if (date(next.start) <= now || date(next.end) > new Date(now.getTime() + 60 * 24 * HOUR)) fail('invalid_reschedule_windows');
    return next;
  });
}
function begin({ id, ownership, actor, reason: suppliedReason, oldSlot, windows, now: rawNow = new Date() }) {
  const now = date(rawNow);
  const proposal = { id: oid(id) };
  for (const key of ['requestId', 'preparationId', 'appointmentId', 'landlordId', 'tenantId', 'identityId']) proposal[key] = oid(ownership?.[key]);
  const initiator = actorOf(proposal, actor, 'landlord');
  proposal.reason = reason(suppliedReason);
  proposal.oldSlot = slot(oldSlot);
  proposal.windows = validateWindows(windows, now);
  proposal.proposedSlot = null;
  proposal.slotKey = null;
  proposal.vendorResponse = { status: 'pending' };
  proposal.tenantResponse = { status: 'pending' };
  proposal.status = 'awaiting_vendor'; proposal.active = true; proposal.revision = 1; proposal.rounds = 0;
  proposal.createdAt = now.toISOString(); proposal.expiresAt = new Date(now.getTime() + 48 * HOUR).toISOString();
  proposal.expiresAt = effectiveDeadline(proposal).toISOString();
  if (date(proposal.expiresAt).getTime() - now.getTime() < MIN_RESPONSE_WINDOW_MS) fail('reschedule_response_window_closed');
  proposal.events = [];
  event(proposal, 'requested', initiator, now);
  return { proposal, effect: null };
}
function confirmVendorSlot({ proposal, expectedRevision, actor, proposedSlot, now: rawNow = new Date() }) {
  const now = date(rawNow), next = pending(proposal, expectedRevision, now);
  const vendor = actorOf(next, actor, 'vendor');
  if (!['awaiting_vendor', 'awaiting_tenant'].includes(next.status) || next.rounds >= 2) fail('reschedule_round_limit');
  const candidate = slot(proposedSlot);
  validateWindows([candidate], now);
  if (!hasResponseWindow({ originalStart: next.oldSlot.start, proposedStart: candidate.start, now }) ||
      effectiveDeadline(next).getTime() - now.getTime() < MIN_RESPONSE_WINDOW_MS) fail('reschedule_response_window_closed');
  if (sameSlot(candidate, next.oldSlot)) fail('reschedule_slot_not_offered');
  next.outsideSuggestedWindows = !next.windows.some(window => candidate.start >= window.start && candidate.end <= window.end);
  next.proposedSlot = candidate; next.rounds++;
  next.expiresAt = effectiveDeadline(next).toISOString();
  next.slotKey = createHash('sha256').update(JSON.stringify({ proposal: next.id, round: next.rounds, slot: candidate })).digest('hex');
  next.vendorResponse = { status: 'accepted', actor: vendor, at: now.toISOString(), slotKey: next.slotKey };
  next.tenantResponse = { status: 'pending' };
  return changed(next, 'vendor_confirmed_slot', vendor, now, 'awaiting_tenant');
}
function tenantResponse({ proposal, expectedRevision, actor, slotKey, accepted, now: rawNow = new Date() }) {
  const now = date(rawNow), next = pending(proposal, expectedRevision, now);
  const tenant = actorOf(next, actor, 'tenant');
  if (next.status !== 'awaiting_tenant' || typeof accepted !== 'boolean' || slotKey !== next.slotKey) fail('reschedule_slot_changed');
  next.tenantResponse = { status: accepted ? 'accepted' : 'declined', actor: tenant, at: now.toISOString(), slotKey };
  return changed(next, accepted ? 'tenant_confirmed_slot' : 'tenant_declined_slot', tenant, now, accepted ? 'ready_to_commit' : 'declined');
}
function decline({ proposal, expectedRevision, actor, now: rawNow = new Date() }) {
  const now = date(rawNow), next = pending(proposal, expectedRevision, now);
  if (!['vendor', 'tenant', 'landlord'].includes(actor?.role)) fail('reschedule_party_required');
  const party = actorOf(next, actor, actor.role);
  if (next.status === 'ready_to_commit') fail('reschedule_revision_conflict');
  if (actor.role !== 'landlord') next[actor.role === 'vendor' ? 'vendorResponse' : 'tenantResponse'] = { status: 'declined', actor: party, at: now.toISOString(), slotKey: next.slotKey };
  return changed(next, `${actor.role}_declined_change`, party, now, 'declined');
}
function expire({ proposal, now: rawNow = new Date() }) {
  const now = date(rawNow);
  if (!proposal?.active || effectiveDeadline(proposal) > now) return { proposal: structuredClone(proposal), effect: null };
  const next = structuredClone(proposal); next.expiresAt = effectiveDeadline(next).toISOString();
  return changed(next, 'expired', { role: 'system', id: null }, now, 'expired');
}
function finalize({ proposal, expectedRevision, originalSlot, workAllowed, calendarAvailable, now: rawNow = new Date() }) {
  const now = date(rawNow), next = pending(proposal, expectedRevision, now);
  if (next.status !== 'ready_to_commit' || next.vendorResponse.status !== 'accepted' || next.tenantResponse.status !== 'accepted' ||
      next.vendorResponse.slotKey !== next.slotKey || next.tenantResponse.slotKey !== next.slotKey) fail('both_reschedule_consents_required');
  if (typeof workAllowed !== 'boolean') fail('authoritative_work_check_required');
  if (typeof calendarAvailable !== 'boolean') fail('authoritative_calendar_check_required');
  const system = { role: 'system', id: null };
  if (workAllowed !== true || !sameSlot(slot(originalSlot), next.oldSlot)) return changed(next, 'original_basis_changed', system, now, 'invalidated');
  if (calendarAvailable !== true || date(next.proposedSlot.start) <= now) return changed(next, 'candidate_unavailable', system, now, 'conflict');
  const result = changed(next, 'committed', system, now, 'committed');
  result.effect = { kind: 'replace_slot', appointmentId: next.appointmentId,
    expectedOld: { ...next.oldSlot }, next: { ...next.proposedSlot } };
  return result;
}
function invalidate({ proposal, now: rawNow = new Date() }) {
  if (!proposal?.active) return { proposal: structuredClone(proposal), effect: null };
  return changed(structuredClone(proposal), 'original_basis_changed', { role: 'system', id: null }, date(rawNow), 'invalidated');
}
module.exports = { begin, confirmVendorSlot, tenantResponse, decline, expire, finalize, invalidate, validateWindows,
  effectiveDeadline, enforceDeadline, hasResponseWindow, RESPONSE_BUFFER_MS, MIN_RESPONSE_WINDOW_MS };
