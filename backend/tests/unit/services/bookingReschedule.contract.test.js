const assert = require('node:assert/strict');
const contract = require('../../../services/vendor/bookingReschedule.contract');
const id = value => value.toString(16).padStart(24, '0');
const now = new Date('2026-10-29T00:00:00Z');
const oldSlot = { start: '2026-10-30T15:00:00Z', end: '2026-10-30T16:00:00Z' };
const windows = [{ start: '2026-10-31T15:00:00Z', end: '2026-10-31T19:00:00Z' }];
const ownership = Object.fromEntries(['requestId', 'preparationId', 'appointmentId', 'landlordId', 'tenantId', 'identityId'].map((key, i) => [key, id(i + 1)]));
const landlord = { role: 'landlord', id: ownership.landlordId }, vendor = { role: 'vendor', id: ownership.identityId }, tenant = { role: 'tenant', id: ownership.tenantId };
const input = { id: id(20), ownership, actor: landlord, reason: 'Vendor access route unavailable; original booking remains in place.', oldSlot, windows, now };
const open = () => contract.begin(input).proposal;
const candidate = { start: '2026-10-31T16:00:00Z', end: '2026-10-31T17:00:00Z' };
const vendorConfirm = (proposal, proposedSlot = candidate) => contract.confirmVendorSlot({ proposal, expectedRevision: proposal.revision, actor: vendor, proposedSlot, now });
const tenantConfirm = proposal => contract.tenantResponse({ proposal, expectedRevision: proposal.revision, actor: tenant, accepted: true, slotKey: proposal.slotKey, now });
const finish = (proposal, extras = {}) => contract.finalize({ proposal, expectedRevision: proposal.revision, originalSlot: oldSlot, workAllowed: true, calendarAvailable: true, now, ...extras });
const error = (code, work) => assert.throws(work, value => value.code === code);

for (const reason of ['', '   ', null, 7, true, {}, 'x'.repeat(801)]) error('reschedule_reason_required', () => contract.begin({ ...input, reason }));
error('reschedule_party_required', () => contract.begin({ ...input, actor: tenant }));
error('reschedule_party_required', () => contract.begin({ ...input, actor: { role: 'landlord', id: id(99) } }));
error('invalid_reschedule_windows', () => contract.begin({ ...input, windows: [] }));
error('explicit_time_required', () => contract.begin({ ...input, windows: [{ ...windows[0], start: '2026-10-31T15:00:00' }] }));
error('invalid_reschedule_time', () => contract.begin({ ...input, oldSlot: { start: '2026-02-30T15:00:00Z', end: '2026-02-30T16:00:00Z' } }));
error('invalid_reschedule_duration', () => contract.begin({ ...input, windows: [{ start: windows[0].start, end: '2026-10-31T15:10:00Z' }] }));
error('invalid_reschedule_windows', () => contract.begin({ ...input, windows: [{ start: '2026-10-28T15:00:00Z', end: '2026-10-28T16:00:00Z' }] }));
assert.equal(contract.begin({ ...input, windows: [{ start: '2026-10-31T00:00:00Z', end: '2026-11-01T00:00:00Z' }] }).effect, null, 'an availability window is not restricted to appointment duration');

const before = JSON.stringify(input), started = contract.begin(input);
assert.equal(JSON.stringify(input), before); assert.equal(started.effect, null);
assert.deepEqual(started.proposal.oldSlot, { start: '2026-10-30T15:00:00.000Z', end: '2026-10-30T16:00:00.000Z' });
assert.equal(started.proposal.events[0].reason, input.reason);
assert.deepEqual(started.proposal.events[0].actor, landlord);
assert.equal(started.proposal.expiresAt, '2026-10-30T13:00:00.000Z', 'two hours before original visit, not the later48h cap');
const nearOriginal = minutes => ({ start: new Date(now.getTime() + minutes * 60000), end: new Date(now.getTime() + (minutes + 60) * 60000) });
error('reschedule_response_window_closed', () => contract.begin({ ...input, oldSlot: nearOriginal(134) }));
assert.equal(new Date(contract.begin({ ...input, oldSlot: nearOriginal(135) }).proposal.expiresAt) - now, 15 * 60000, 'minimum15min response window at boundary');
error('reschedule_response_window_closed', () => contract.begin({ ...input, oldSlot: { start: '2026-10-28T15:00:00Z', end: '2026-10-28T16:00:00Z' } }));
const distant = contract.begin({ ...input, oldSlot: { start: '2026-11-02T15:00:00Z', end: '2026-11-02T16:00:00Z' } }).proposal;
assert.equal(distant.expiresAt, '2026-10-31T00:00:00.000Z', '48h remains upper bound when visit is distant');
const original = open(), originalBytes = JSON.stringify(original);
error('both_reschedule_consents_required', () => finish(original));
error('reschedule_revision_conflict', () => contract.confirmVendorSlot({ proposal: original, expectedRevision: '1', actor: vendor, proposedSlot: candidate, now }));
error('reschedule_party_required', () => contract.confirmVendorSlot({ proposal: original, expectedRevision: 1, actor: landlord, proposedSlot: candidate, now }));
error('reschedule_slot_not_offered', () => vendorConfirm(original, oldSlot));
assert.equal(JSON.stringify(original), originalBytes, 'failed actions do not mutate the input proposal or old visit basis');

const confirmedVendor = vendorConfirm(original);
assert.equal(confirmedVendor.effect, null); assert.equal(confirmedVendor.proposal.status, 'awaiting_tenant');
assert.equal(JSON.stringify(original), originalBytes);
error('both_reschedule_consents_required', () => finish(confirmedVendor.proposal));
error('reschedule_party_required', () => contract.tenantResponse({ proposal: confirmedVendor.proposal, expectedRevision: 2, actor: landlord, accepted: true, slotKey: confirmedVendor.proposal.slotKey, now }));
error('reschedule_slot_changed', () => contract.tenantResponse({ proposal: confirmedVendor.proposal, expectedRevision: 2, actor: tenant, accepted: true, slotKey: 'old-slot-key', now }));
const ready = tenantConfirm(confirmedVendor.proposal);
assert.equal(ready.effect, null); assert.equal(ready.proposal.status, 'ready_to_commit');
const success = finish(ready.proposal);
assert.equal(success.proposal.status, 'committed'); assert.equal(success.proposal.active, false);
assert.deepEqual(success.effect, { kind: 'replace_slot', appointmentId: ownership.appointmentId, expectedOld: original.oldSlot,
  next: { start: '2026-10-31T16:00:00.000Z', end: '2026-10-31T17:00:00.000Z' } });
assert.equal(success.proposal.events.length, 4);
assert.deepEqual(success.proposal.events.map(row => row.actor.role), ['landlord', 'vendor', 'tenant', 'system']);
assert(success.proposal.events.every(row => row.reason === input.reason && JSON.stringify(row.oldSlot) === JSON.stringify(original.oldSlot)));
error('reschedule_revision_conflict', () => finish(success.proposal));

error('authoritative_work_check_required', () => finish(ready.proposal, { workAllowed: undefined }));
error('authoritative_calendar_check_required', () => finish(ready.proposal, { calendarAvailable: undefined }));
for (const extras of [{ calendarAvailable: false }, { workAllowed: false },
  { originalSlot: { ...oldSlot, end: '2026-10-30T16:15:00Z' } }]) {
  const refused = finish(ready.proposal, extras);
  assert.equal(refused.effect, null); assert.equal(refused.proposal.active, false);
  assert.deepEqual(refused.proposal.oldSlot, original.oldSlot);
  assert.equal(ready.proposal.status, 'ready_to_commit', 'caller-owned input remains unchanged on failed final check');
}
for (const actor of [vendor, tenant]) {
  const declined = contract.decline({ proposal: confirmedVendor.proposal, expectedRevision: 2, actor, now });
  assert.equal(declined.effect, null); assert.equal(declined.proposal.status, 'declined');
  assert.deepEqual(declined.proposal.oldSlot, original.oldSlot);
}
const declinedTenant = contract.tenantResponse({ proposal: confirmedVendor.proposal, expectedRevision: 2, actor: tenant, accepted: false, slotKey: confirmedVendor.proposal.slotKey, now });
assert.equal(declinedTenant.effect, null); assert.equal(declinedTenant.proposal.status, 'declined');
const cutoff = new Date(original.expiresAt);
assert(cutoff < new Date(oldSlot.start), 'expiration occurs while the original is still a future fallback');
const expired = contract.expire({ proposal: ready.proposal, now: cutoff });
assert.equal(expired.effect, null); assert.equal(expired.proposal.status, 'expired');
assert.deepEqual(expired.proposal.oldSlot, original.oldSlot);
error('reschedule_expired', () => finish(ready.proposal, { now: cutoff }));
error('reschedule_expired', () => contract.tenantResponse({ proposal: confirmedVendor.proposal, expectedRevision: 2, actor: tenant,
  accepted: true, slotKey: confirmedVendor.proposal.slotKey, now: cutoff }));
assert.equal(contract.expire({ proposal: ready.proposal, now: new Date(cutoff.getTime() - 1) }).proposal.status, 'ready_to_commit');
const earlier = vendorConfirm(original, { start: '2026-10-29T12:00:00Z', end: '2026-10-29T13:00:00Z' }).proposal;
assert.equal(earlier.expiresAt, '2026-10-29T10:00:00.000Z', 'earlier replacement shortens the deadline before both visits');
const laterAgain = vendorConfirm(earlier, candidate).proposal;
assert.equal(laterAgain.expiresAt, earlier.expiresAt, 'revising a candidate never extends a promised response deadline');
error('reschedule_response_window_closed', () => vendorConfirm(original, { start: '2026-10-29T02:00:00Z', end: '2026-10-29T03:00:00Z' }));
const legacy = { ...open(), expiresAt: '2026-10-31T00:00:00.000Z' };
const legacyBytes = JSON.stringify(legacy), corrected = contract.enforceDeadline({ proposal: legacy, now });
assert.equal(corrected.effect, null); assert.equal(corrected.proposal.expiresAt, original.expiresAt);
assert.equal(corrected.proposal.revision, legacy.revision + 1);
assert.equal(corrected.proposal.events.at(-1).type, 'response_deadline_shortened');
assert.equal(corrected.proposal.events.at(-1).actor.role, 'system'); assert.equal(JSON.stringify(legacy), legacyBytes);
assert.equal(contract.enforceDeadline({ proposal: corrected.proposal, now }).proposal.revision, corrected.proposal.revision, 'recovery is idempotent');
assert.equal(contract.enforceDeadline({ proposal: legacy, now: cutoff }).proposal.status, 'expired', 'unsafe legacy48h cannot outlive fallback cutoff');
error('reschedule_expired', () => contract.confirmVendorSlot({ proposal: legacy, expectedRevision: legacy.revision, actor: vendor, proposedSlot: candidate, now: cutoff }));
const revised = vendorConfirm(confirmedVendor.proposal, { start: '2026-10-31T17:00:00Z', end: '2026-10-31T18:00:00Z' });
assert.notEqual(revised.proposal.slotKey, confirmedVendor.proposal.slotKey);
assert.equal(revised.proposal.tenantResponse.status, 'pending'); assert.equal(revised.effect, null);
error('reschedule_round_limit', () => vendorConfirm(revised.proposal));
error('reschedule_revision_conflict', () => contract.tenantResponse({ proposal: revised.proposal, expectedRevision: 2, actor: tenant, accepted: true, slotKey: confirmedVendor.proposal.slotKey, now }));
const counterproposal = vendorConfirm(original, { start: '2026-11-02T17:00:00Z', end: '2026-11-02T18:00:00Z' });
assert.equal(counterproposal.proposal.outsideSuggestedWindows, true);
assert.equal(counterproposal.effect, null); assert.equal(counterproposal.proposal.tenantResponse.status, 'pending');
console.log('booking reschedule contract: reason, exact actual-party consent, bounded rounds, audit and original-slot preservation PASS (pure foundation only)');
