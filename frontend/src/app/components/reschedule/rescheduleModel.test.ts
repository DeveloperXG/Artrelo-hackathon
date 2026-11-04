import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { BookingCapabilities, BookingPayload, BookingState } from '../../types/booking';
import {
  actionKeyFor, changeAnnouncement, changeSignature, checkDuration, checkReason, checkWindows, classifyFailure, deliveryLabel,
  bookedLabel, eventLabel, formatSlot, headline, insideWindows, mergeVendorResponse, requestBlockedReason, newActionId, panelControls, partyActionBody, receiptMessage, toLocalInput, fromLocalInput, deviceZone, deviceWallClockLabel,
} from './rescheduleModel';
import { change } from './rescheduleFixtures';

const NOW = new Date('2026-10-29T12:00:00Z');

describe('local wall-clock labels independent of preview zone', () => {
  it('reproduces missing Intl name with UTC-7 Date conversions without relabelling the form UTC', () => {
    // Pure Node TZ emulation, not a native browser/device timezone assertion.
    vi.stubEnv('TZ', 'Etc/GMT+7');
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ resolvedOptions: () => ({ timeZone: undefined }) } as unknown as Intl.DateTimeFormat);
    try {
      const start = '2026-11-06T09:00:00.000Z', end = '2026-11-06T12:00:00.000Z';
      expect(new Date(start).getTimezoneOffset()).toBe(420);
      expect(toLocalInput(start)).toBe('2026-11-06T02:00');
      expect(toLocalInput(end)).toBe('2026-11-06T05:00');
      expect(deviceWallClockLabel()).toBe('local device time; zone name unavailable');
      expect(deviceWallClockLabel()).not.toContain('UTC');
      expect(deviceZone()).toBe('UTC'); // Existing explicit preview default is unchanged.
      expect(fromLocalInput(toLocalInput(start))).toBe(start);
      expect(checkWindows([{ start: toLocalInput(start), end: toLocalInput(end) }], new Date('2026-11-01T00:00:00Z')).windows).toEqual([{ start, end }]);
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });
  it('keeps a supported explicit IANA label and falls back honestly if Intl throws', () => {
    const NativeFormatter = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: Parameters<typeof Intl.DateTimeFormat>) {
      return args.length ? new NativeFormatter(...args) : { resolvedOptions: () => ({ timeZone: 'America/Phoenix' }) } as Intl.DateTimeFormat;
    });
    try { expect(deviceWallClockLabel()).toBe('America/Phoenix'); }
    finally { vi.restoreAllMocks(); }
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw Error('missing metadata'); });
    try { expect(deviceWallClockLabel()).toBe('local device time; zone name unavailable'); }
    finally { vi.restoreAllMocks(); }
  });
});
const caps = (over: Partial<BookingCapabilities> = {}): BookingCapabilities => ({ state: 'confirmed', reasonCode: null,
  canConfirmInitial: false, canSuggestInitialAlternatives: false, canProposeInitialTime: false, canRequestReschedule: true,
  requiresRescheduleReason: true, ...over });
const coordination = (over: Partial<BookingState> = {}): BookingState => ({ phase: 'scheduled', revision: 4, rounds: 0,
  deadlineAt: '2026-10-30T00:00:00Z', proposals: [], arrivalAt: '2026-11-02T15:00:00Z', durationMinutes: 120, ...over });
const payload = (over: Partial<BookingPayload> = {}): BookingPayload => ({ vendorName: 'Synthetic Plumbing',
  coordination: coordination({ capabilities: caps() }), reschedules: [], ...over });

describe('controls come only from server capabilities', () => {
  it('offers a manager change request on an actually confirmed visit', () => {
    const controls = panelControls(payload(), 'landlord');
    expect(controls).toMatchObject({ canRequestReschedule: true, canSuggestInitialAlternatives: false, canConfirmInitial: false, legacyReadOnly: false });
  });

  it('never offers the tenant the manager request', () => {
    expect(panelControls(payload(), 'tenant').canRequestReschedule).toBe(false);
  });

  it('hides every time action after work is submitted, even though the retained phase still says scheduled', () => {
    const data = payload({ coordination: coordination({ phase: 'scheduled', capabilities: caps({ state: 'completion_submitted',
      reasonCode: 'work_already_started', canRequestReschedule: false }) }) });
    for (const audience of ['landlord', 'tenant'] as const) {
      expect(panelControls(data, audience)).toMatchObject({ canRequestReschedule: false, canSuggestInitialAlternatives: false, canConfirmInitial: false });
    }
    expect(headline('scheduled', data.coordination!.capabilities)).toBe('Work submitted; the visit time can no longer change');
  });

  it('treats a missing capability set as read-only legacy, with no phase fallback', () => {
    const data = payload({ coordination: coordination({ phase: 'scheduled' }) });
    expect(panelControls(data, 'landlord')).toMatchObject({ legacyReadOnly: true, canRequestReschedule: false, canSuggestInitialAlternatives: false });
    const awaiting = payload({ coordination: coordination({ phase: 'awaiting_tenant' }) });
    expect(panelControls(awaiting, 'tenant')).toMatchObject({ legacyReadOnly: true, canConfirmInitial: false });
    expect(headline('awaiting_tenant')).toBe('Please confirm the proposed time');
  });

  it('handles null data and a null coordination without controls', () => {
    expect(panelControls(null, 'landlord')).toMatchObject({ legacyReadOnly: false, canRequestReschedule: false, active: null, past: [] });
    expect(panelControls(payload({ coordination: null }), 'landlord').canRequestReschedule).toBe(false);
  });

  it('suppresses a new request while one is pending and separates earlier ones', () => {
    const old = change({ ref: 'old', active: false, status: 'declined' });
    const controls = panelControls(payload({ reschedules: [change(), old] }), 'landlord');
    expect(controls.canRequestReschedule).toBe(false);
    expect(controls.active?.ref).toBe(change().ref);
    expect(controls.past.map(item => item.ref)).toEqual(['old']);
  });

  it('keeps the initial-booking confirm and alternatives only while the server allows them', () => {
    const data = payload({ coordination: coordination({ phase: 'awaiting_tenant', capabilities: caps({ state: 'awaiting_confirmation',
      canConfirmInitial: true, canSuggestInitialAlternatives: true, canRequestReschedule: false }) }) });
    expect(panelControls(data, 'tenant')).toMatchObject({ canConfirmInitial: true, canSuggestInitialAlternatives: true, canRequestReschedule: false });
  });
});

describe('owner request validation mirrors the server rules', () => {
  const local = (iso: string) => toLocalInput(iso);
  it('accepts one to three future windows of at least 15 minutes within 60 days', () => {
    const result = checkWindows([{ start: local('2026-10-30T15:00:00Z'), end: local('2026-10-30T17:00:00Z') }], NOW);
    expect(result.summary).toBe('');
    expect(result.windows).toEqual([{ start: '2026-10-30T15:00:00.000Z', end: '2026-10-30T17:00:00.000Z' }]);
  });

  it.each([
    [{ start: '', end: '' }, 'Enter both the start and the end.'],
    [{ start: local('2026-10-29T11:00:00Z'), end: local('2026-10-29T13:00:00Z') }, 'Start this window in the future.'],
    [{ start: local('2026-10-30T15:00:00Z'), end: local('2026-10-30T15:10:00Z') }, 'Make this window at least 15 minutes long.'],
    [{ start: local('2026-12-20T15:00:00Z'), end: local('2026-12-30T15:00:00Z') }, 'End this window within the next 60 days.'],
  ])('refuses %o', (row, message) => {
    const result = checkWindows([row], NOW);
    expect(result.errors[0]).toBe(message);
    expect(result.windows).toEqual([]);
  });

  it('refuses zero or four windows', () => {
    expect(checkWindows([], NOW).summary).toBe('Add one to three windows.');
    const row = { start: local('2026-10-30T15:00:00Z'), end: local('2026-10-30T17:00:00Z') };
    expect(checkWindows([row, row, row, row], NOW).summary).toBe('Add one to three windows.');
  });

  it('requires a non-blank reason of at most 800 characters', () => {
    expect(checkReason('   ')).toMatch(/Explain why/);
    expect(checkReason('x'.repeat(801))).toMatch(/800/);
    expect(checkReason('x'.repeat(800))).toBe('');
  });

  it('accepts only 15-minute durations from 15 to 720', () => {
    expect([15, 120, 720].map(checkDuration)).toEqual(['', '', '']);
    expect([0, 10, 125, 735, 30.5].map(checkDuration).every(Boolean)).toBe(true);
  });

  it('flags a candidate outside the suggested windows without refusing it', () => {
    const windows = [{ start: '2026-11-03T19:00:00Z', end: '2026-11-03T23:00:00Z' }];
    expect(insideWindows({ start: '2026-11-03T20:00:00Z', end: '2026-11-03T22:00:00Z' }, windows)).toBe(true);
    expect(insideWindows({ start: '2026-11-04T20:00:00Z', end: '2026-11-04T22:00:00Z' }, windows)).toBe(false);
  });
});

describe('idempotent change requests', () => {
  it('generates keys the server accepts', () => {
    expect(newActionId()).toMatch(/^[A-Za-z0-9_-]{12,80}$/);
  });

  it('reuses the key for the same body and replaces it when the body changes', () => {
    let calls = 0;
    const make = () => `key-number-${++calls}-padding`;
    const first = actionKeyFor(null, 'body-a', make);
    expect(actionKeyFor(first, 'body-a', make)).toBe(first);
    expect(actionKeyFor(first, 'body-b', make).key).not.toBe(first.key);
  });
});

describe('failures and receipts', () => {
  it('treats a network failure or server error as an unknown outcome to reconcile', () => {
    expect(classifyFailure(new TypeError('Failed to fetch')).kind).toBe('unknown');
    expect(classifyFailure(new ApiError('boom', 500, { code: 'coordination_error' })).kind).toBe('unknown');
  });

  it('explains a calendar conflict and says the original visit is unchanged', () => {
    const failure = classifyFailure(new ApiError('busy', 409, { code: 'time_unavailable' }));
    expect(failure.kind).toBe('conflict');
    expect(failure.message).toMatch(/original visit is unchanged/);
  });

  it('turns a stale revision into a refresh notice, not a retry', () => {
    const failure = classifyFailure(new ApiError('stale', 409, { code: 'reschedule_revision_conflict' }));
    expect(failure).toEqual({ kind: 'stale', message: expect.stringMatching(/has not been replaced/) });
  });

  it('shows a role refusal from the server as refused', () => {
    expect(classifyFailure(new ApiError('Only the owning manager can start this change request.', 403, { code: 'reschedule_party_required' })))
      .toEqual({ kind: 'refused', message: 'Only the owning manager can start this change request.' });
  });

  it('reports only what the receipt proves', () => {
    const base = { proposalRef: 'r', revision: 3, duplicate: false };
    expect(receiptMessage({ ...base, status: 'conflict' })).toBe('The new time could not be booked. The original visit is kept.');
    expect(receiptMessage({ ...base, status: 'awaiting_tenant' })).not.toMatch(/changed/);
    expect(receiptMessage({ ...base, status: 'committed' }, { start: '2026-11-03T20:00:00Z', end: '2026-11-03T22:00:00Z' }))
      .toMatch(/^The visit time changed to .+\(.+\)\.$/);
    expect(receiptMessage({ ...base, status: 'declined', duplicate: true })).toMatch(/^Already recorded\. /);
  });
});

describe('party actions', () => {
  it('answers the exact candidate the tenant was shown', () => {
    expect(partyActionBody(change(), 'accept')).toEqual({ action: 'respond_reschedule', proposalRef: change().ref,
      expectedRevision: 2, slotKey: 'a'.repeat(64), accepted: true });
    expect(partyActionBody(change(), 'keep_original')).toMatchObject({ accepted: false });
  });

  it('cannot answer a change without a candidate', () => {
    expect(partyActionBody(change({ proposed: null, slotKey: null }), 'accept')).toBeNull();
  });

  it('withdraws and declines with only the supported keys', () => {
    for (const action of ['withdraw', 'decline'] as const) {
      expect(partyActionBody(change(), action)).toEqual({ action: 'decline_reschedule', proposalRef: change().ref, expectedRevision: 2 });
    }
  });
});

describe('announcements and labels', () => {
  it('announces only a real transition, never the first load or an unchanged refetch', () => {
    expect(changeAnnouncement(null, [change()])).toBe('');
    expect(changeAnnouncement(changeSignature([change()]), [change()])).toBe('');
    expect(changeAnnouncement(changeSignature([change()]), [change({ revision: 3, status: 'committed', active: false })]))
      .toBe('Visit change update: New time confirmed by the vendor and tenant.');
    expect(changeAnnouncement('', [change()])).toMatch(/Waiting for the tenant/);
  });

  it('writes slots with an explicit time zone', () => {
    const text = formatSlot({ start: '2026-11-02T15:00:00Z', end: '2026-11-02T17:00:00Z' }, 'America/Regina');
    expect(text).toContain('(America/Regina)');
    expect(text).toMatch(/9:00.+to 11:00/);
    expect(formatSlot({ start: 'bad', end: 'bad' }, 'UTC')).toBe('Time unavailable');
  });

  it('keeps delivery-off apart from an in-app notice and never claims an email', () => {
    expect(deliveryLabel('disabled', true, 'tenant')).toBe('Not sent: delivery is off · In-app notice recorded');
    expect(deliveryLabel('disabled', false, 'vendor')).toBe('Not sent: delivery is off');
    expect(['pending', 'disabled', 'failed', 'uncertain', 'stale', 'mystery'].map(status => deliveryLabel(status, false, 'landlord')).join(' '))
      .not.toMatch(/email/i);
  });
});

describe('vendor change response', () => {
  const previous = { coordination: null, brief: { shortTitle: 'Faucet', summary: 'Drip' }, reschedules: [] };
  it('keeps the loaded brief when a successful change response omits it (the page used to crash here)', () => {
    const receipt = { proposalRef: 'r', revision: 2, status: 'awaiting_tenant' as const, duplicate: false };
    const merged = mergeVendorResponse({ coordination: null, reschedules: [change()], receipt }, previous);
    expect(merged?.brief).toEqual(previous.brief);
    expect(merged?.receipt).toEqual(receipt);
    expect(merged?.reschedules?.[0].ref).toBe(change().ref);
  });

  it('reloads instead of rendering without any brief', () => {
    expect(mergeVendorResponse({ coordination: null }, null)).toBeNull();
    expect(mergeVendorResponse(undefined, previous)).toBeNull();
  });
});

describe('two-hour answer cutoff', () => {
  it('explains why a manager cannot start a change close to the visit', () => {
    const closed = caps({ canRequestReschedule: false, reasonCode: 'reschedule_response_window_closed' });
    expect(requestBlockedReason(closed, 'landlord')).toMatch(/two hours before the visit/);
    expect(requestBlockedReason(closed, 'tenant')).toBe('');
    expect(requestBlockedReason(caps(), 'landlord')).toBe('');
    expect(panelControls(payload({ coordination: coordination({ capabilities: closed }) }), 'landlord').canRequestReschedule).toBe(false);
  });

  it('turns the new server codes into plain outcomes that keep the original visit', () => {
    expect(classifyFailure(new ApiError('x', 409, { code: 'reschedule_response_window_closed' }))).toEqual({ kind: 'conflict', message: expect.stringMatching(/original visit stays booked/) });
    expect(classifyFailure(new ApiError('x', 409, { code: 'reschedule_deadline_changed' }))).toEqual({ kind: 'conflict', message: expect.stringMatching(/deadline moved earlier/) });
  });

  it('labels a shortened deadline and a missing confirmed time truthfully', () => {
    expect(eventLabel('response_deadline_shortened')).toBe('Answer deadline moved earlier');
    expect(headline('scheduled', caps({ state: 'confirmation_unknown', reasonCode: 'confirmed_time_unavailable', canRequestReschedule: false })))
      .toBe('Visit booked; the confirmed time is not on record');
  });
});

describe('vendor visit label', () => {
  it('keeps calling a confirmed visit booked after work starts', () => {
    expect(['confirmed', 'completion_submitted', 'work_started'].map(state => bookedLabel(state as never))).toEqual(['Booked visit', 'Booked visit', 'Booked visit']);
    expect(bookedLabel('awaiting_confirmation')).toBe('Proposed arrival');
    expect(bookedLabel(undefined)).toBe('Proposed arrival');
  });
});
