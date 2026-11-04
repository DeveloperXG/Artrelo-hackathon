// Which proxy number to give this vendor.
//
// The constraint is narrow and absolute (see models/ProxySession.js): a number
// N is usable for vendor V only if no OPEN session already pairs (N, V). Any
// other pairing is fine — the same number simultaneously serving five different
// vendors is normal and is the point of a pool. Numbers are not per-tenant,
// per-job, or per-landlord; they are per (number, vendor) pair.
//
// So pool size does not cap total concurrent jobs. It caps concurrent jobs PER
// VENDOR. A pool of three numbers supports one vendor holding three live jobs,
// or three hundred vendors holding one each.
//
// Twilio Proxy would have done this allocation for us, but it is closed to new
// customers, so it is done here on Programmable Messaging plus a number pool.
// The entity model is the same one Proxy uses; only the plumbing is ours.

const env = require("../../config/env");
const ProxySession = require("../../models/ProxySession");

/**
 * Pick a number for `vendorPhoneE164`, or null when every number in the pool is
 * already paired with this vendor.
 *
 * Selection among the free candidates prefers the number this vendor has gone
 * LONGEST without using — including "never used", which sorts first. That is
 * not load balancing (any free number is equally correct); it is about the
 * vendor's phone. Their messaging app threads by sender, so reusing a number
 * they used last week drops a new job's messages into an old job's thread, and
 * a vendor reading upward sees the wrong address. Maximum separation is the
 * least confusing thing we can cheaply do.
 *
 * Returns null rather than throwing: the caller fails soft, because a full pool
 * must not cancel a job a vendor already accepted.
 */
async function allocateProxyNumber({ vendorPhoneE164 }) {
  const pool = env.twilio_proxy_numbers || [];
  if (!pool.length || !vendorPhoneE164) return null;

  // Every number currently pinned to this vendor. Small by construction — it is
  // bounded by how many jobs one vendor holds at once.
  const taken = await ProxySession.find({ vendorPhoneE164, status: "open" })
    .select("proxyNumber")
    .lean();
  const takenSet = new Set(taken.map((row) => row.proxyNumber));

  const free = pool.filter((number) => !takenSet.has(number));
  if (!free.length) return null;

  // Last time this vendor saw each free number. One query, not one per number.
  const history = await ProxySession.find({
    vendorPhoneE164,
    proxyNumber: { $in: free },
  })
    .select("proxyNumber closedAt openedAt")
    .lean();

  const lastSeen = new Map();
  for (const row of history) {
    const at = new Date(row.closedAt || row.openedAt || 0).getTime();
    if (at > (lastSeen.get(row.proxyNumber) || 0)) lastSeen.set(row.proxyNumber, at);
  }

  // Never-used numbers have no entry and score 0, so they win outright.
  // Ties break on pool order, which keeps the choice deterministic in tests.
  let best = free[0];
  let bestScore = lastSeen.get(best) || 0;
  for (const number of free.slice(1)) {
    const score = lastSeen.get(number) || 0;
    if (score < bestScore) {
      best = number;
      bestScore = score;
    }
  }
  return best;
}

/** Is a number one of ours? Used to reject inbound for a decommissioned line. */
function isPoolNumber(number) {
  return (env.twilio_proxy_numbers || []).includes(String(number || "").trim());
}

function poolSize() {
  return (env.twilio_proxy_numbers || []).length;
}

module.exports = { allocateProxyNumber, isPoolNumber, poolSize };
