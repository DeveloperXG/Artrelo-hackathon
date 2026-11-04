import { describe, expect, it } from 'vitest';
import type { AppointmentItem, AppointmentStatus } from '../../../types/appointment';
import {
  SCHEDULE_STYLES,
  appointmentPlace,
  matchesFilter,
  needsAttention,
  needsTenantAttention,
  scheduleState,
  scheduleStyle,
  tenantCanAct,
} from './scheduleStatus';

const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
const appt = (status: AppointmentStatus, extra: Partial<AppointmentItem> = {}): AppointmentItem => ({
  _id: status,
  status,
  confirmedStart: future,
  ...extra,
});

const ALL_STATUSES: AppointmentStatus[] = [
  'proposed',
  'awaiting_vendor',
  'awaiting_tenant',
  'scheduled',
  'work_verifying',
  'in_review',
  'disputed',
  'cancelled',
  'completed',
  'failed',
];

describe('scheduleState', () => {
  it('splits proposed by whether the tenant has answered', () => {
    expect(scheduleState(appt('proposed'))).toBe('awaiting_tenant');
    expect(scheduleState(appt('proposed', { tenantConfirmation: { respondedAt: past } }))).toBe('needs_new_time');
  });

  it('has a label and colours for every status the server can send', () => {
    for (const status of ALL_STATUSES) {
      const style = SCHEDULE_STYLES[scheduleState(appt(status))];
      expect(style, status).toBeDefined();
      expect(style.label, status).toBeTruthy();
    }
    expect(SCHEDULE_STYLES.needs_new_time.label).toBe('Needs a new time');
  });
});

describe('matchesFilter', () => {
  it('counts a booked time ahead as upcoming, but not one already past or needing a new time', () => {
    expect(matchesFilter(appt('scheduled'), 'upcoming')).toBe(true);
    expect(matchesFilter(appt('scheduled', { confirmedStart: past }), 'upcoming')).toBe(false);
    expect(matchesFilter(appt('awaiting_tenant', { confirmedStart: null }), 'upcoming')).toBe(false);
  });

  it('awaiting tenant includes an unanswered proposal', () => {
    expect(matchesFilter(appt('awaiting_tenant'), 'awaiting_tenant')).toBe(true);
    expect(matchesFilter(appt('proposed'), 'awaiting_tenant')).toBe(true);
    expect(matchesFilter(appt('proposed', { tenantConfirmation: { respondedAt: past } }), 'awaiting_tenant')).toBe(false);
  });

  it('needs review covers review, disputes and a declined time', () => {
    expect(matchesFilter(appt('in_review'), 'review')).toBe(true);
    expect(matchesFilter(appt('disputed'), 'review')).toBe(true);
    expect(matchesFilter(appt('proposed', { tenantConfirmation: { respondedAt: past } }), 'review')).toBe(true);
    expect(matchesFilter(appt('work_verifying'), 'review')).toBe(false);
    expect(matchesFilter(appt('work_verifying'), 'sign_off')).toBe(true);
  });
});

describe('needsAttention', () => {
  it('leaves a plain scheduled visit to the calendar', () => {
    expect(needsAttention(appt('scheduled'))).toBe(false);
  });

  it('lists anything with no time the calendar could place', () => {
    expect(needsAttention(appt('scheduled', { confirmedStart: null }))).toBe(true);
  });

  it('lists every visit someone owes an answer on', () => {
    for (const status of ['awaiting_tenant', 'work_verifying', 'in_review', 'disputed'] as const) {
      expect(needsAttention(appt(status)), status).toBe(true);
    }
  });
});

describe('appointmentPlace', () => {
  it('reads the property and unit populated through the request', () => {
    expect(
      appointmentPlace(
        appt('scheduled', { requestId: { _id: 'r', propertyId: { name: 'Maple Court' }, unitId: { unitNumber: '4B' } } })
      )
    ).toEqual({ property: 'Maple Court', unit: 'Unit 4B' });
  });

  it('is empty, not broken, against an older server that sends ids', () => {
    expect(appointmentPlace(appt('scheduled', { requestId: { _id: 'r', propertyId: 'p1', unitId: 'u1' } }))).toEqual({
      property: '',
      unit: '',
    });
  });
});

describe('the tenant side', () => {
  const verifying = (needsVerification: boolean) =>
    appt('work_verifying', {
      confirmedStart: past,
      completion: { status: 'submitted', needsVerification, workPerformed: '', partsUsed: '', followUpNeeded: false, followUpNotes: '', photos: [] },
    });

  it('words a visit from the tenant side, keeping the colours', () => {
    expect(scheduleStyle(appt('awaiting_tenant'), 'tenant').label).toBe('Confirm the time');
    expect(scheduleStyle(appt('proposed'), 'tenant').label).toBe('Confirm the time');
    expect(scheduleStyle(appt('proposed', { tenantConfirmation: { respondedAt: past } }), 'tenant').label).toBe(
      'New time coming'
    );
    expect(scheduleStyle(verifying(true), 'tenant').label).toBe('Review the work');
    expect(scheduleStyle(verifying(false), 'tenant').label).toBe('Being checked');
    expect(scheduleStyle(appt('scheduled'), 'tenant').label).toBe('Scheduled');
    expect(scheduleStyle(appt('awaiting_tenant'), 'tenant').block).toBe(scheduleStyle(appt('awaiting_tenant')).block);
  });

  it('leaves the landlord wording alone by default', () => {
    expect(scheduleStyle(appt('awaiting_tenant')).label).toBe('Awaiting tenant');
  });

  it('asks the tenant to review only when the completion asks for it', () => {
    expect(matchesFilter(verifying(true), 'your_review')).toBe(true);
    expect(matchesFilter(verifying(false), 'your_review')).toBe(false);
    expect(matchesFilter(verifying(false), 'waiting_on_manager')).toBe(true);
  });

  it('counts everything the manager or vendor owes as waiting on them', () => {
    for (const status of ['in_review', 'disputed', 'awaiting_vendor'] as const) {
      expect(matchesFilter(appt(status), 'waiting_on_manager'), status).toBe(true);
    }
    expect(matchesFilter(appt('proposed', { tenantConfirmation: { respondedAt: past } }), 'waiting_on_manager')).toBe(true);
    expect(matchesFilter(appt('awaiting_tenant'), 'waiting_on_manager')).toBe(false);
  });

  it('lists what the tenant can act on, and what has no time', () => {
    expect(tenantCanAct(appt('awaiting_tenant'))).toBe(true);
    expect(tenantCanAct(verifying(true))).toBe(true);
    expect(tenantCanAct(appt('scheduled', { confirmedStart: past, canReportNoShow: true }))).toBe(true);
    expect(tenantCanAct(appt('scheduled'))).toBe(false);

    expect(needsTenantAttention(appt('scheduled'))).toBe(false);
    expect(needsTenantAttention(appt('awaiting_vendor', { confirmedStart: null }))).toBe(true);
    expect(needsTenantAttention(verifying(false))).toBe(false);
  });
});
