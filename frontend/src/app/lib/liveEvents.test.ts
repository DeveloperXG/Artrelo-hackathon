import { describe, expect, it } from 'vitest';
import { backoffDelay, createSseParser } from './liveEvents';

describe('createSseParser', () => {
  it('parses whole events and drops heartbeat comments', () => {
    const parse = createSseParser();
    expect(parse('event: ready\ndata: {}\n\n: hb\n\nevent: nudge\ndata: {"topic":"wallet"}\n\n')).toEqual([
      { event: 'ready', data: '{}' },
      { event: 'nudge', data: '{"topic":"wallet"}' },
    ]);
  });

  it('holds a partial event until the rest arrives', () => {
    const parse = createSseParser();
    expect(parse('event: nudge\ndata: {"to')).toEqual([]);
    expect(parse('pic":"notifications"}\n')).toEqual([]);
    expect(parse('\n')).toEqual([{ event: 'nudge', data: '{"topic":"notifications"}' }]);
  });

  it('accepts CRLF line endings', () => {
    const parse = createSseParser();
    expect(parse('event: reauth\r\ndata: {}\r\n\r\n')).toEqual([{ event: 'reauth', data: '{}' }]);
  });
});

describe('backoffDelay', () => {
  it('doubles from one second and caps at thirty', () => {
    const noJitter = () => 0;
    expect(backoffDelay(0, noJitter)).toBe(1000);
    expect(backoffDelay(3, noJitter)).toBe(8000);
    expect(backoffDelay(10, noJitter)).toBe(30000);
  });

  it('adds at most 30% jitter', () => {
    expect(backoffDelay(0, () => 1)).toBe(1300);
  });
});
