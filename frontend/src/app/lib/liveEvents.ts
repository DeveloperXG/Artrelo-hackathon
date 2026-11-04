// One live connection per signed-in tab to GET /live (Server-Sent Events).
//
// The server sends NUDGES -- `{ topic }` only -- and components answer by
// refetching through the API they already use, so this never becomes a second
// source of truth. Every consumer keeps its own polling fallback: a dead
// stream makes the app slower to notice things, never wrong.
//
// streamed fetch, not EventSource: EventSource cannot send the Authorization
// header, and the access token lives in memory (api/client.ts), not a cookie.

import { getToken, refreshAccessToken } from '../api/client';

const BASE = (import.meta as { env: { VITE_API_URL?: string } }).env.VITE_API_URL || '/api/v1';

/** Fired when the stream (re)connects or the tab comes back: refetch everything. */
export const RESYNC_TOPIC = 'resync';

type Listener = (topic: string) => void;

export type SseMessage = { event: string; data: string };

/**
 * Incremental SSE parser. Feed it decoded text chunks as they arrive; it
 * returns the complete messages and keeps any partial one for the next chunk.
 * Comment lines (": hb") are dropped.
 */
export function createSseParser() {
  let buffer = '';
  return (chunk: string): SseMessage[] => {
    buffer += chunk.replace(/\r\n?/g, '\n');
    const messages: SseMessage[] = [];
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length || event !== 'message') messages.push({ event, data: data.join('\n') });
      boundary = buffer.indexOf('\n\n');
    }
    return messages;
  };
}

/** 1s, 2s, 4s ... capped at 30s, with up to 30% jitter so tabs don't stampede. */
export function backoffDelay(attempt: number, random = Math.random) {
  const base = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + random() * 0.3));
}

const listeners = new Set<Listener>();
let controller: AbortController | null = null;
let running = false;
let attempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function emit(topic: string) {
  for (const listener of [...listeners]) {
    try {
      listener(topic);
    } catch {
      // A broken consumer must not stop the others hearing the nudge.
    }
  }
}

function scheduleReconnect() {
  if (!running || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, backoffDelay(attempt++));
}

async function connect() {
  if (!running) return;
  controller?.abort();
  const abort = new AbortController();
  controller = abort;

  const token = getToken();
  if (!token) {
    scheduleReconnect();
    return;
  }

  try {
    const res = await fetch(`${BASE}/live`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      credentials: 'include',
      signal: abort.signal,
      cache: 'no-store',
    });

    if (res.status === 401) {
      // Only on a real 401 -- refreshAccessToken signs the user out when it
      // fails, so it must never run on a mere network error.
      if (await refreshAccessToken()) {
        attempt = 0;
        void connect();
      }
      return;
    }
    if (!res.ok || !res.body) throw new Error(`live stream ${res.status}`);

    attempt = 0;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parse = createSseParser();
    let reauth = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parse(decoder.decode(value, { stream: true }))) {
        if (message.event === 'ready') emit(RESYNC_TOPIC);
        else if (message.event === 'reauth') reauth = true;
        else if (message.event === 'nudge') {
          try {
            const topic = (JSON.parse(message.data) as { topic?: string }).topic;
            if (topic) emit(topic);
          } catch {
            // malformed nudge; ignore
          }
        }
      }
    }
    // The server ends the stream when the access token lapses. The next API
    // call would refresh it anyway; do it now so the stream comes straight back.
    if (reauth && running) {
      if (await refreshAccessToken()) void connect();
      return;
    }
  } catch {
    if (abort.signal.aborted) return;
  }
  if (controller === abort) scheduleReconnect();
}

function onVisible() {
  if (document.visibilityState !== 'visible' || !running) return;
  // Coming back to a tab: whatever happened while it slept, catch up now, and
  // revive the stream immediately rather than waiting out a backoff.
  emit(RESYNC_TOPIC);
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
    attempt = 0;
    void connect();
  }
}

/** Start the shared connection. Returns a stop function. Idempotent. */
export function startLiveEvents() {
  if (!running) {
    running = true;
    attempt = 0;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    void connect();
  }
  return stopLiveEvents;
}

export function stopLiveEvents() {
  running = false;
  controller?.abort();
  controller = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
}

/** Subscribe to every topic. Returns an unsubscribe function. */
export function onLiveEvent(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
