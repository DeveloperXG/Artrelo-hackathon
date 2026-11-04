/**
 * The bell's data, with no React and no DOM so its rules are tested directly:
 *
 * - Read state lives on the server; mark-one and mark-all are optimistic and
 *   a failed mark-all puts the list back.
 * - An answer that started before a newer load, a local change, or close()
 *   is stale and dropped. The bell is remounted per signed-in identity, so a
 *   late answer for the previous account can never land in the new one.
 * - The live stream is the immediate path. The poll is only the fallback for
 *   a dropped stream: 60 s normally, 5 s for an enabled judge sandbox, and
 *   never while the tab is hidden.
 */
import type { AppNotification } from '../../api/client';

export const BELL_POLL_MS = 60_000;
export const JUDGE_BELL_POLL_MS = 5_000;

export const bellPollMs = (judgeSandbox: boolean) => (judgeSandbox ? JUDGE_BELL_POLL_MS : BELL_POLL_MS);

export interface NotificationApi {
  list: (limit: number) => Promise<{ notifications: AppNotification[]; unreadCount: number }>;
  markRead: (id: string) => Promise<unknown>;
  markAllRead: () => Promise<unknown>;
}

export interface FeedView {
  items: AppNotification[];
  unread: number;
  loaded: boolean;
}

export class NotificationFeed {
  view: FeedView = { items: [], unread: 0, loaded: false };

  private listeners = new Set<() => void>();
  private closed = false;
  /** Bumped by every load, local change and close: older answers are stale. */
  private version = 0;
  private generation = 0;
  private readMutations = new Set<Promise<void>>();
  private queuedLoad: Promise<void> | null = null;

  constructor(
    private api: NotificationApi,
    private limit = 15
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getView = () => this.view;

  private set(patch: Partial<FeedView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Reopen after close(); React effects run setup again on the same feed. */
  open() {
    this.closed = false;
  }

  /** Drop every answer still in flight and send nothing more until open(). */
  close() {
    this.closed = true;
    this.version += 1;
    this.generation += 1;
    this.readMutations.clear();
    this.queuedLoad = null;
  }

  async load() {
    if (this.closed) return;
    if (this.queuedLoad) return this.queuedLoad;
    // A list read before a read-marker commits can undo the optimistic count.
    // Preserve every nudge, coalesced into an authoritative read after settlement.
    if (this.readMutations.size) {
      const generation = this.generation;
      const queued = Promise.all([...this.readMutations]).then(() => {
        if (this.queuedLoad === queued) this.queuedLoad = null;
        if (this.closed || generation !== this.generation) return;
        return this.load();
      });
      this.queuedLoad = queued;
      return queued;
    }
    const asked = (this.version += 1);
    try {
      const { notifications, unreadCount } = await this.api.list(this.limit);
      if (asked !== this.version) return;
      this.set({ items: notifications, unread: unreadCount, loaded: true });
    } catch {
      // A bell that can't load must never break the page under it; it keeps
      // the last list it had until the next nudge or poll.
      if (asked === this.version) this.set({ loaded: true });
    }
  }

  markRead(item: AppNotification) {
    if (this.closed || item.read || this.view.items.find(row => row._id === item._id)?.read) return;
    this.version += 1;
    this.set({
      items: this.view.items.map((row) => (row._id === item._id ? { ...row, read: true } : row)),
      unread: Math.max(0, this.view.unread - 1),
    });
    // Fire-and-forget: opening a row must not wait on it, and the next load
    // reconciles if it failed.
    let failed = false;
    const generation = this.generation;
    void this.trackReadMutation(this.api.markRead(item._id), () => { failed = true; }).then(() => {
      // A refused/unknown read marker must not remain optimistically cleared.
      // This is a readback only, never a retry of the mutation.
      if (failed && generation === this.generation && !this.queuedLoad) void this.load();
    });
  }

  private trackReadMutation(operation: Promise<unknown>, onFailure: () => void) {
    const pending = operation.then(() => {}, onFailure).then(() => { this.readMutations.delete(pending); });
    this.readMutations.add(pending);
    return pending;
  }

  async markAllRead() {
    if (this.closed) return;
    const generation = this.generation;
    const before = { items: this.view.items, unread: this.view.unread };
    const mine = (this.version += 1);
    this.set({ items: before.items.map((item) => ({ ...item, read: true })), unread: 0 });
    await this.trackReadMutation(this.api.markAllRead(), () => {
      // Put the list back only if nothing newer has replaced it since.
      if (mine === this.version) this.set(before);
    });
    if (generation === this.generation && this.queuedLoad) await this.queuedLoad;
  }
}

export interface PollEnv {
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const browserEnv: PollEnv = {
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

/**
 * Run `fn` every `ms` while the tab is visible. A hidden tab holds no timer at
 * all; coming back restarts it (the live stream's resync reloads at once).
 */
export function visiblePoll(fn: () => void, ms: number, env: PollEnv = browserEnv): () => void {
  let handle: unknown = null;
  const sync = () => {
    if (env.isVisible()) {
      if (handle === null) handle = env.setInterval(fn, ms);
    } else if (handle !== null) {
      env.clearInterval(handle);
      handle = null;
    }
  };
  sync();
  const off = env.onVisibilityChange(sync);
  return () => {
    off();
    if (handle !== null) env.clearInterval(handle);
    handle = null;
  };
}
