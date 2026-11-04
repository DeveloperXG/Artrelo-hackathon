// Live nudges to signed-in landlords and tenants over Server-Sent Events.
//
// An event is a NUDGE, not a payload: `{ topic }` and nothing else. The client
// answers it by refetching through the endpoints it already uses, so there is
// still exactly one source of truth and one privacy projection per surface --
// nothing here can leak a field the REST response would have withheld.
//
// Topics in use:
//   notifications   a notification was written for this user (notifyUser)
//   wallet          this landlord's ledger changed (deposit settled, payout moved)
//   request:<id>    a request this user can see got a new message
//
// SINGLE-PROCESS BY DESIGN. Subscribers live in this process's memory, which
// is correct while the API runs as one Railway replica (backend/railway.json,
// numReplicas: 1). A second replica would only nudge the clients connected to
// whichever process did the write; fan-out would then need Redis pub/sub or a
// Mongo change stream behind publish(). Nothing breaks meanwhile -- the
// clients keep their polling fallback -- it just gets slower, not wrong.

const HEARTBEAT_MS = 25 * 1000;
// One per open tab. Past this, the oldest is closed: a leaked connection (a
// tab that never fired `close`) must not pin sockets forever.
const MAX_CONNECTIONS_PER_USER = 5;

/** userId -> Set<{ res, expiresAt }> */
const subscribers = new Map();
let heartbeat = null;

function send(client, chunk) {
  try {
    client.res.write(chunk);
  } catch {
    // A write to a socket that just died. Its `close` handler cleans up.
  }
}

function close(client) {
  try {
    client.res.end();
  } catch {
    // already gone
  }
}

function removeClient(userId, client) {
  const set = subscribers.get(userId);
  if (!set) return;
  set.delete(client);
  if (!set.size) subscribers.delete(userId);
  if (!subscribers.size && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

// One timer for every connection rather than one each. It keeps idle proxies
// from dropping the stream, and ends any stream whose access token has
// expired, so the client reconnects with a fresh one instead of holding a
// channel open on a credential the REST API would already refuse.
function tick(now = Date.now()) {
  for (const [userId, set] of subscribers) {
    for (const client of [...set]) {
      if (client.expiresAt && client.expiresAt <= now) {
        send(client, "event: reauth\ndata: {}\n\n");
        close(client);
        removeClient(userId, client);
      } else {
        send(client, ": hb\n\n");
      }
    }
  }
}

function subscribe(userId, res, { expiresAt = null } = {}) {
  const key = String(userId);
  const client = { res, expiresAt };
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  if (set.size >= MAX_CONNECTIONS_PER_USER) {
    const oldest = set.values().next().value;
    close(oldest);
    set.delete(oldest);
  }
  set.add(client);
  if (!heartbeat) {
    heartbeat = setInterval(() => tick(), HEARTBEAT_MS);
    heartbeat.unref?.();
  }
  return () => removeClient(key, client);
}

/**
 * Nudge every open stream for these users. Never throws: a nudge is a
 * latency optimisation, and the write that triggered it has already happened.
 */
function publish(userIds, topic) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String);
  const chunk = `event: nudge\ndata: ${JSON.stringify({ topic })}\n\n`;
  for (const id of new Set(ids)) {
    const set = subscribers.get(id);
    if (!set) continue;
    for (const client of set) send(client, chunk);
  }
}

// GET /api/v1/live, behind userAuth.
function handleLiveStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells any buffering reverse proxy (nginx in deploy/nginx.conf) to pass
    // each event straight through.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: {}\n\n`);

  const unsubscribe = subscribe(req.user.id, res, { expiresAt: req.authExpiresAt || null });
  req.on("close", unsubscribe);
}

function connectionCount(userId) {
  return subscribers.get(String(userId))?.size || 0;
}

module.exports = {
  publish,
  subscribe,
  handleLiveStream,
  // exposed for tests
  tick,
  connectionCount,
  MAX_CONNECTIONS_PER_USER,
};
