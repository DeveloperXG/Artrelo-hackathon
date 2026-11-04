import { describe, expect, it } from 'vitest';
import { activeCardPilot, validCardAmount } from './walletLimits';
describe('expiring card pilot', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const pilot = { amountCents: 100, reference: 'pilot', expiresAt: new Date(now + 1000).toISOString() };
  it('keeps normal minimum and permits only the pilot amount', () => {
    expect(validCardAmount(1, null, now)).toBe(false);
    expect(validCardAmount(20, null, now)).toBe(true);
    expect(validCardAmount(1, pilot, now)).toBe(true);
    expect(validCardAmount(2, pilot, now)).toBe(false);
    expect(validCardAmount(NaN, pilot, now)).toBe(false);
  });
  it('rejects expired and malformed exceptions', () => {
    expect(validCardAmount(1, pilot, now + 1000)).toBe(false);
    expect(activeCardPilot({ ...pilot, amountCents: 200 }, now)).toBe(false);
    expect(activeCardPilot({ ...pilot, expiresAt: 'bad' }, now)).toBe(false);
  });
});
