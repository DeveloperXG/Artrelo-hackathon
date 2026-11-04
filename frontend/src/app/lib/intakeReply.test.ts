import { describe, expect, it } from 'vitest';
import { buildReadyReply } from './intakeReply';

const ready = (additionalNotes = '') => ({ readyToSubmit: true, additionalNotes });

describe('buildReadyReply', () => {
  it('says it has enough the first time intake is ready', () => {
    expect(buildReadyReply({ previous: { readyToSubmit: false }, current: ready(), urgentOrEmergency: false })).toBe(
      "I have enough detail to submit this request whenever you're ready."
    );
  });

  it('tells the tenant a later detail went into the additional notes', () => {
    expect(
      buildReadyReply({ previous: ready(), current: ready('Leak is worse at night.'), urgentOrEmergency: false })
    ).toBe(
      "Thanks — I'll add that to the additional notes for your property manager. You can submit whenever you're ready."
    );
  });

  it('keeps the submit-now push on urgent requests', () => {
    expect(buildReadyReply({ previous: ready('a'), current: ready('a b'), urgentOrEmergency: true })).toMatch(
      /additional notes.*Please submit this request now/
    );
  });

  it('does not claim a dropped remark was added', () => {
    expect(
      buildReadyReply({ previous: ready('Leak is worse at night.'), current: ready('Leak is worse  at night.'), urgentOrEmergency: false })
    ).toBe("I have enough detail to submit this request whenever you're ready.");
  });

  it('honours intakeStatus as readiness', () => {
    expect(
      buildReadyReply({
        previous: { intakeStatus: 'ready_to_submit' },
        current: { intakeStatus: 'ready_to_submit', additionalNotes: 'Also the tap drips.' },
        urgentOrEmergency: false,
      })
    ).toMatch(/additional notes/);
  });
});
