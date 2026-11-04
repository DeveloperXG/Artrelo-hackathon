import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Within this many pixels of the bottom counts as reading the latest message. */
export const FOLLOW_SLACK = 48;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** The newest turn: its key changes only on a new Send; its signature as its reply arrives. */
export type LatestTurn = { key: string; signature: string; records?: boolean } | null;

export const atBottom = (m: ScrollMetrics) => m.scrollHeight - m.scrollTop - m.clientHeight <= FOLLOW_SLACK;

/**
 * Whether the transcript follows new content. It follows while the person is
 * at the latest message; scrolling up to read history stops it and offers
 * Jump to bottom (`away`) for as long as they are up there, whether or not
 * anything new arrived. A reply that arrives meanwhile also marks `unseen`,
 * shown beside the jump but never needed for it. A new Send
 * (a new latest turn key, which trimming older turns never produces) or the
 * jump follows again. Size changes alone, such as a source peek or a viewport
 * resize, never mark a reply unseen, and only move the scroll while following.
 * Record replies suspend that automatic following until an explicit jump or
 * a new Send, preserving the question even when tables replace a short wait.
 */
export class TranscriptFollow {
  following = true;
  /** Scrolled away from the latest message, in a transcript long enough to scroll. */
  away = false;
  unseen = false;
  private lastTop = 0;
  private latestKey: string | null | undefined = undefined;
  private latestSignature: string | null = null;
  private preserveRecords = false;

  /**
   * A scroll event. Only a move up is the person leaving the latest message:
   * content growing under a following view (and the browser's scroll anchoring)
   * also fires scroll events, before the resize that follows it is seen.
   */
  scrolled(m: ScrollMetrics) {
    const up = m.scrollTop < this.lastTop - 1;
    this.lastTop = m.scrollTop;
    if (atBottom(m)) this.following = true;
    else if (up) this.following = false;
    this.away = !this.following;
    if (this.following) this.unseen = false;
  }

  /** The content changed size. Returns the scrollTop to apply, or null to leave it. */
  resized(m: ScrollMetrics): number | null {
    if (this.preserveRecords) {
      this.following = false;
      this.away = !atBottom(m);
      return null;
    }
    if (this.following) {
      this.away = false;
      return m.scrollHeight;
    }
    // Content that shrank to fit (or a taller viewport) leaves nothing to jump to.
    this.away = !atBottom(m);
    if (!this.away) {
      this.following = true;
      this.unseen = false;
    }
    return null;
  }

  /**
   * The newest turn as rendered. 'send' means a new turn appeared (follow and
   * scroll to it); 'reset' an emptied transcript (New conversation); 'answer'
   * a reply that changed while the person reads history. The first call is the
   * conversation as opened, never a send.
   */
  latest(turn: LatestTurn): 'send' | 'reset' | 'answer' | null {
    const first = this.latestKey === undefined;
    const previousKey = this.latestKey;
    const previousSignature = this.latestSignature;
    this.latestKey = turn?.key ?? null;
    this.latestSignature = turn?.signature ?? null;
    // Record replies preserve the question/reading position even if the person
    // was at the bottom of the pending reply. Explicit Jump remains available.
    if (turn?.records && (first || turn.key !== previousKey || turn.signature !== previousSignature)) {
      this.preserveRecords = true;
      this.following = false;
      if (!first) this.unseen = true;
      return first ? null : 'answer';
    }
    if (first) return null;
    if (!turn) {
      if (previousKey === null) return null;
      this.following = true;
      this.away = false;
      this.unseen = false;
      this.preserveRecords = false;
      return 'reset';
    }
    if (turn.key !== previousKey) {
      this.following = true;
      this.away = false;
      this.unseen = false;
      this.preserveRecords = false;
      return 'send';
    }
    if (turn.signature !== previousSignature && !this.following) {
      this.unseen = true;
      return 'answer';
    }
    return null;
  }

  jump(m: ScrollMetrics): number {
    this.preserveRecords = false;
    this.following = true;
    this.away = false;
    this.unseen = false;
    return m.scrollHeight;
  }
}

/**
 * Wires TranscriptFollow to a scroll container and its content. Scrolls are
 * immediate, never animated, so reduced motion needs no special case and a
 * smooth scroll can never be mistaken for the person scrolling up.
 */
export function useTranscriptFollow(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, latest: LatestTurn) {
  const follow = useRef(new TranscriptFollow());
  const [shown, setShown] = useState({ away: false, unseen: false });
  const publish = useCallback(() => {
    const { away, unseen } = follow.current;
    setShown((s) => (s.away === away && s.unseen === unseen ? s : { away, unseen }));
  }, []);

  const apply = useCallback((top: number | null) => {
    const el = scrollRef.current;
    if (el && top !== null) el.scrollTop = top;
    publish();
  }, [scrollRef, publish]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const onScroll = () => {
      follow.current.scrolled(el);
      publish();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => apply(follow.current.resized(el)));
    observer?.observe(content);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [scrollRef, contentRef, apply, publish]);

  const key = latest?.key ?? null;
  const signature = latest?.signature ?? null;
  const records = latest?.records ?? false;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const change = follow.current.latest(key === null ? null : { key, signature: signature ?? '', records });
    // Publish the changed follow policy before ResizeObserver can follow a
    // record table that just replaced the pending answer.
    if (el && records) follow.current.resized(el);
    apply(change === 'send' || change === 'reset' ? el?.scrollHeight ?? null : null);
  }, [key, signature, records, scrollRef, apply]);

  const jump = useCallback(() => {
    const el = scrollRef.current;
    if (el) apply(follow.current.jump(el));
  }, [scrollRef, apply]);

  return { ...shown, jump };
}
