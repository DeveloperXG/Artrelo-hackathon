import { describe, expect, it } from 'vitest';
import { FOLLOW_SLACK, TranscriptFollow } from './irisScroll';

// A 400px viewport over content of the given height, scrolled to `top`.
const at = (scrollHeight: number, top: number) => ({ scrollTop: top, scrollHeight, clientHeight: 400 });
const bottom = (scrollHeight: number) => at(scrollHeight, scrollHeight - 400);
/** A person scrolling up from the latest message to `top`. */
const scrollUp = (f: TranscriptFollow, scrollHeight: number, top: number) => {
  f.scrolled(bottom(scrollHeight));
  f.scrolled(at(scrollHeight, top));
};
const turn = (key: string, signature = 'sending::') => ({ key, signature });

/** Opened on a conversation whose latest turn is `t1`, then scrolled up to read history. */
function readingHistory() {
  const f = new TranscriptFollow();
  f.latest(turn('t1', 'done:complete:'));
  scrollUp(f, 2000, 300);
  return f;
}

describe('Iris transcript follow', () => {
  it('does not follow record tables replacing a pending reply even from the bottom', () => {
    const f = new TranscriptFollow();
    f.latest(turn('t1'));
    f.scrolled(bottom(800));
    expect(f.latest({ ...turn('t1', 'done:records'), records: true })).toBe('answer');
    expect(f.resized(at(1800, 400))).toBeNull();
    expect([f.away, f.unseen]).toEqual([true, true]);
    expect(f.resized(at(2300, 400))).toBeNull();
    expect(f.jump(at(2300, 400))).toBe(2300);
    expect([f.away, f.unseen]).toEqual([false, false]);
  });
  it('preserves history for mixed explanation and records, repeated record updates and reflow', () => {
    const f = readingHistory();
    f.latest({ ...turn('t1', 'mixed-records'), records: true });
    expect(f.resized(at(2600, 300))).toBeNull();
    f.latest({ ...turn('t1', 'additional-records'), records: true });
    expect(f.resized(at(3000, 300))).toBeNull();
    expect(f.away).toBe(true);
    // A new ordinary Send retains its existing interaction model.
    expect(f.latest(turn('t2'))).toBe('send');
    expect(f.resized(at(3200, 300))).toBe(3200);
  });
  it('does not scroll a short record reply or an already-open record transcript, nor invent unseen on reflow', () => {
    const f = new TranscriptFollow();
    f.latest({ ...turn('t1', 'records'), records: true });
    expect(f.resized(at(300, 0))).toBeNull();
    expect([f.away, f.unseen]).toEqual([false, false]);
    expect(f.resized(at(1800, 0))).toBeNull();
    expect([f.away, f.unseen]).toEqual([true, false]);
    expect(f.latest(null)).toBe('reset');
    expect(f.resized(at(300, 0))).toBe(300);
  });
  it('follows a growing answer while the person is at the latest message', () => {
    const f = new TranscriptFollow();
    f.latest(turn('t1'));
    // Loading, then the answer, then a tall preview card: each growth is followed.
    expect(f.resized(at(600, 0))).toBe(600);
    f.scrolled(bottom(600));
    expect(f.resized(at(1400, 200))).toBe(1400);
    f.scrolled(bottom(1400));
    expect(f.resized(at(2600, 1000))).toBe(2600);
    expect(f.unseen).toBe(false);
  });

  it('counts a position within the slack of the bottom as reading the latest', () => {
    const f = new TranscriptFollow();
    scrollUp(f, 1000, 600 - FOLLOW_SLACK);
    expect(f.following).toBe(true);
    scrollUp(f, 1000, 600 - FOLLOW_SLACK - 1);
    expect(f.following).toBe(false);
  });

  it('keeps the reading position when a reply arrives, and flags it as a new response', () => {
    const f = readingHistory();
    f.latest(turn('t2'));
    scrollUp(f, 2000, 300); // the person scrolls back up while it loads
    expect(f.latest(turn('t2', 'done:complete:'))).toBe('answer');
    expect(f.resized(at(2600, 300))).toBeNull();
    expect(f.unseen).toBe(true);
  });

  it('a size change alone (source peek, viewport resize) never moves the history position or claims a new response', () => {
    const f = readingHistory();
    expect(f.resized(at(2300, 300))).toBeNull();
    expect(f.resized(at(1800, 300))).toBeNull();
    expect(f.unseen).toBe(false);
  });

  it('a re-render with the same latest turn (polling, navigation) changes nothing', () => {
    const f = readingHistory();
    expect(f.latest(turn('t1', 'done:complete:'))).toBeNull();
    expect([f.following, f.unseen]).toEqual([false, false]);
  });

  it('a new Send from history follows again', () => {
    const f = readingHistory();
    expect(f.latest(turn('t2'))).toBe('send');
    expect([f.following, f.unseen]).toEqual([true, false]);
    expect(f.resized(at(2800, 300))).toBe(2800);
  });

  it('a new Send still follows when retention trims older turns so the count stays equal or falls', () => {
    // Turns t1..t3 retained; the person reads history; sending t4 trims t1 and t2 server-side.
    const f = new TranscriptFollow();
    f.latest(turn('t3', 'done:complete:'));
    scrollUp(f, 3000, 200);
    expect(f.latest(turn('t4'))).toBe('send');
    expect(f.following).toBe(true);
  });

  it('New conversation empties the transcript and resets to following; its first Send is a send', () => {
    const f = readingHistory();
    f.latest(turn('t2'));
    scrollUp(f, 2000, 100);
    f.latest(turn('t2', 'done:complete:'));
    expect(f.unseen).toBe(true);
    expect(f.latest(null)).toBe('reset');
    expect([f.following, f.unseen]).toEqual([true, false]);
    expect(f.latest(turn('n1'))).toBe('send');
  });

  it('opening a conversation is never mistaken for a send, even when it is already long', () => {
    const f = new TranscriptFollow();
    scrollUp(f, 2000, 300);
    expect(f.latest(turn('t9', 'done:complete:'))).toBeNull();
    expect(f.following).toBe(false);
  });

  it('scrolling up a finished conversation offers Jump to bottom with no new reply at all', () => {
    const f = new TranscriptFollow();
    f.latest(turn('t1', 'done:complete:'));
    f.scrolled(bottom(2000));
    expect(f.away).toBe(false);
    scrollUp(f, 2000, 900);
    expect([f.away, f.unseen]).toEqual([true, false]);
    // A source peek opening further up keeps the offer without inventing a reply.
    expect(f.resized(at(2300, 900))).toBeNull();
    expect([f.away, f.unseen]).toEqual([true, false]);
  });

  it('Jump to bottom scrolls to the real bottom, follows again and hides; so does returning by hand', () => {
    const f = readingHistory();
    expect(f.away).toBe(true);
    expect(f.jump(at(2000, 300))).toBe(2000);
    expect([f.following, f.away]).toEqual([true, false]);
    scrollUp(f, 2000, 300);
    expect(f.away).toBe(true);
    f.scrolled(bottom(2000));
    expect([f.following, f.away]).toEqual([true, false]);
  });

  it('a scroll event from content growing under a following view (scroll anchoring) does not stop following', () => {
    const f = new TranscriptFollow();
    f.latest(turn('t1'));
    f.scrolled(bottom(3311));
    // The answer lands: the scroll event arrives with the new height before the resize does.
    f.scrolled(at(3945, 2966));
    expect([f.following, f.away]).toEqual([true, false]);
    expect(f.resized(at(3945, 2966))).toBe(3945);
  });

  it('a short or emptied transcript never offers the jump', () => {
    const f = readingHistory();
    // The content shrinks to fit the panel: nothing left to jump to, and following resumes.
    expect(f.resized(at(380, 0))).toBeNull();
    expect([f.away, f.following]).toEqual([false, true]);
    const g = readingHistory();
    g.latest(null);
    expect(g.away).toBe(false);
  });

  it('Jump to latest follows again and clears the flag; reaching the bottom by hand clears it too', () => {
    const f = readingHistory();
    f.latest(turn('t2'));
    scrollUp(f, 2000, 300);
    f.latest(turn('t2', 'done:complete:'));
    expect(f.jump(at(2400, 300))).toBe(2400);
    expect([f.following, f.unseen]).toEqual([true, false]);

    f.latest(turn('t3'));
    scrollUp(f, 2400, 100);
    f.latest(turn('t3', 'done:complete:'));
    expect(f.unseen).toBe(true);
    f.scrolled(bottom(2800));
    expect([f.following, f.unseen]).toEqual([true, false]);
  });
});
