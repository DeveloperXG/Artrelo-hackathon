// Time-bucketed request counts and spend, shared by the dashboard stats and the
// reports endpoint so the two can never disagree about what a month held.
//
// The rules, in one place:
//   - "requests" (incoming) lands in the bucket the request was CREATED in.
//   - "resolved" and "cost" land in the bucket the job was COMPLETED in —
//     spend is realised when the work is done, not when it was raised.
//   - cost is the final cost of completed work only. Nullish, not truthy:
//     `finalCost: 0` is a real value (warranty, goodwill).
//
// Buckets are in the server's local time, as they always were.

const MONTH_FMT = { month: "short" };

function monthKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}`;
}

function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** The last `count` calendar months, oldest first, ending with the current one. */
function emptyMonths(now, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: monthKey(d), label: d.toLocaleString("en", MONTH_FMT), requests: 0, resolved: 0, cost: 0 });
  }
  return out;
}

/** The last `count` calendar days, oldest first, ending with today. */
function emptyDays(now, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push({
      key: dayKey(d),
      // "Oct 5" — a day label that stays unambiguous across a month boundary.
      label: d.toLocaleString("en", { month: "short", day: "numeric" }),
      requests: 0,
      resolved: 0,
      cost: 0,
    });
  }
  return out;
}

// `range` clips to exact instants. A month bucket spans its whole calendar
// month, so a report starting on the 15th would otherwise count the 1st–14th
// in its first bar and disagree with its own totals.
function fill(buckets, keyOf, requests, range = null) {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const within = (date) => !range || (date >= range.from && date <= range.to);
  for (const r of requests) {
    const createdAt = new Date(r.createdAt);
    const created = within(createdAt) ? byKey.get(keyOf(createdAt)) : null;
    if (created) created.requests += 1;
    if (r.status === "completed") {
      const doneAt = new Date(r.completedAt || r.createdAt);
      const done = within(doneAt) ? byKey.get(keyOf(doneAt)) : null;
      if (done) {
        done.resolved += 1;
        done.cost += r.finalCost ?? 0;
      }
    }
  }
  return buckets;
}

function monthlyTrend(requests, { now = new Date(), months = 12 } = {}) {
  return fill(emptyMonths(now, months), monthKey, requests);
}

function dailyTrend(requests, { now = new Date(), days = 30 } = {}) {
  return fill(emptyDays(now, days), dayKey, requests);
}

/**
 * Buckets covering an arbitrary [from, to] range, for the reports page: one
 * per day or per calendar month, oldest first. Month labels carry the year
 * ("Oct '25") only when the range spans more than one.
 */
function trendBetween(requests, { from, to, unit }) {
  const buckets = [];
  if (unit === "day") {
    for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      buckets.push({
        key: dayKey(d),
        label: d.toLocaleString("en", { month: "short", day: "numeric" }),
        requests: 0,
        resolved: 0,
        cost: 0,
      });
    }
    return fill(buckets, dayKey, requests, { from, to });
  }
  const multiYear = from.getFullYear() !== to.getFullYear();
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const month = d.toLocaleString("en", MONTH_FMT);
    buckets.push({
      key: monthKey(d),
      label: multiYear ? `${month} '${String(d.getFullYear()).slice(-2)}` : month,
      requests: 0,
      resolved: 0,
      cost: 0,
    });
  }
  return fill(buckets, monthKey, requests, { from, to });
}

module.exports = { monthlyTrend, dailyTrend, trendBetween, monthKey, dayKey };
