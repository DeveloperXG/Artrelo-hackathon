// The numbers a beta has to produce: evidence the product is worth paying for.
//
// Everything is derived from data the app already keeps (requests,
// appointments, the audit log, approvals, the ledger) plus the activity days
// recorded by activity.service. Nothing here writes.
//
// SHAPE. Loaders read; the summarize* functions are pure and take plain
// arrays, so the arithmetic is tested without a database -- the same split as
// services/reports/landlordReports.service.js. All money is integer cents.
//
// THE DEFINITIONS (they are the part worth arguing about, so they are written
// down where the code can't drift from them):
//
//   Time to vendor booked   first Appointment.createdAt for the request minus
//                           MaintenanceRequest.createdAt. An appointment is
//                           created when a vendor ACCEPTS (vendorAcceptance),
//                           so this is "reported -> a vendor said yes".
//
//   Decisions avoided       among requests that got booked, how many had ZERO
//                           audited landlord actions before the booking. Those
//                           ran on autopilot. The average number of landlord
//                           decisions per booked request is reported next to it.
//
//   Wallet volume (GMV)     payout entries minus payout reversals. Deposits are
//                           reported separately, because money loaded into the
//                           wallet is not money spent on jobs.
//
//   Retained at DN          the landlord was active on at least one day in the
//                           7 days ending N days after their beta started.
//                           A landlord whose beta is younger than N days is
//                           "not yet eligible", never "churned".

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Appointment = require("../../models/Appointment");
const AgentActionLog = require("../../models/AgentActionLog");
const ApprovalRequest = require("../../models/ApprovalRequest");
const LedgerEntry = require("../../models/LedgerEntry");
const JobCompletion = require("../../models/JobCompletion");
const LandlordActivityDay = require("../../models/LandlordActivityDay");
const { dayKey } = require("./activity.service");

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MARKS = [30, 60, 90];
const RETENTION_WINDOW_DAYS = 7;

const monthKey = (date) => new Date(date).toISOString().slice(0, 7);
const id = (value) => (value === null || value === undefined ? "" : String(value));

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: no interpolation, so the number is always one that happened.
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

function bump(map, key, field, by = 1) {
  if (!map.has(key)) map.set(key, {});
  const row = map.get(key);
  row[field] = (row[field] || 0) + by;
}

const sortedObject = (map) =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

/** Requests raised and finished, per month. */
function summarizeRequests(requests = []) {
  const byMonth = new Map();
  for (const r of requests) {
    if (r.createdAt) {
      bump(byMonth, monthKey(r.createdAt), "requests");
      if (r.urgency === "emergency") bump(byMonth, monthKey(r.createdAt), "emergencies");
    }
    if (r.status === "completed" && r.completedAt) bump(byMonth, monthKey(r.completedAt), "completed");
  }
  return {
    total: requests.length,
    completed: requests.filter((r) => r.status === "completed").length,
    byMonth: sortedObject(byMonth),
  };
}

/**
 * Minutes from request to vendor booked. `firstBookedAt` maps requestId -> Date.
 * Requests with no booking are simply absent: they have no time to report yet.
 */
function summarizeTimeToBook(requests = [], firstBookedAt = new Map()) {
  const all = [];
  const emergency = [];
  const normal = [];
  for (const r of requests) {
    const booked = firstBookedAt.get(id(r._id));
    if (!booked || !r.createdAt) continue;
    const minutes = (new Date(booked) - new Date(r.createdAt)) / MINUTE_MS;
    if (!Number.isFinite(minutes) || minutes < 0) continue;
    all.push(minutes);
    (r.urgency === "emergency" ? emergency : normal).push(minutes);
  }
  const stats = (list) => ({
    count: list.length,
    medianMinutes: round1(percentile(list, 50)),
    p75Minutes: round1(percentile(list, 75)),
  });
  return { ...stats(all), emergency: stats(emergency), nonEmergency: stats(normal) };
}

/**
 * Of the requests that got booked, how many needed no landlord action first.
 * `landlordActions` are AgentActionLog rows with actor "landlord".
 */
function summarizeDecisions(requests = [], firstBookedAt = new Map(), landlordActions = []) {
  const actionsByRequest = new Map();
  for (const a of landlordActions) {
    const key = id(a.requestId);
    if (!key) continue;
    if (!actionsByRequest.has(key)) actionsByRequest.set(key, []);
    actionsByRequest.get(key).push(a);
  }

  let booked = 0;
  let autopilot = 0;
  let decisions = 0;
  for (const r of requests) {
    const bookedAt = firstBookedAt.get(id(r._id));
    if (!bookedAt) continue;
    booked += 1;
    const before = (actionsByRequest.get(id(r._id)) || []).filter(
      (a) => !a.createdAt || new Date(a.createdAt) <= new Date(bookedAt)
    );
    if (before.length === 0) autopilot += 1;
    decisions += before.length;
  }
  return {
    bookedRequests: booked,
    autopilotRequests: autopilot,
    autopilotPercent: booked ? round1((autopilot / booked) * 100) : null,
    avgDecisionsPerBooked: booked ? round1(decisions / booked) : null,
  };
}

function summarizeApprovals(approvals = []) {
  const byType = {};
  const byStatus = {};
  for (const a of approvals) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }
  return { total: approvals.length, byType, byStatus };
}

/** Wallet volume per month. Entry `type` is payout / payout_reversal / deposit. */
function summarizeMoney(entries = []) {
  const byMonth = new Map();
  let payout = 0;
  let reversal = 0;
  let deposit = 0;
  let direct = 0;
  for (const e of entries) {
    const cents = Number(e.amountCents) || 0;
    const month = monthKey(e.createdAt);
    if (e.type === "payout") {
      payout += cents;
      bump(byMonth, month, "payoutCents", cents);
    } else if (e.type === "payout_reversal") {
      reversal += cents;
      bump(byMonth, month, "reversalCents", cents);
    } else if (e.type === "deposit") {
      deposit += cents;
      bump(byMonth, month, "depositCents", cents);
    } else if (e.type === "direct_payment") {
      direct += cents;
      bump(byMonth, month, "directCents", cents);
    }
  }
  return {
    gmvCents: payout - reversal,
    // Paid by the landlord outside Artrelo (direct pay), counted from when the
    // job closed. Not GMV: it never passed through the wallet.
    directCents: direct,
    // Every finished job's value, whichever rail paid it.
    jobVolumeCents: payout - reversal + direct,
    payoutCents: payout,
    reversalCents: reversal,
    depositCents: deposit,
    byMonth: sortedObject(byMonth),
  };
}

/**
 * Retention for ONE landlord. `activityDays` is a list of "YYYY-MM-DD" strings.
 */
function summarizeRetention({ startedAt, activityDays = [], now = new Date() } = {}) {
  const days = [...new Set(activityDays)].sort();
  if (!startedAt) return { startedAt: null, activeDays: days.length, marks: {} };
  const start = new Date(startedAt);
  const marks = {};
  for (const n of RETENTION_MARKS) {
    const windowEnd = new Date(start.getTime() + n * DAY_MS);
    if (windowEnd > now) {
      marks[`d${n}`] = { eligible: false, retained: null };
      continue;
    }
    const from = dayKey(new Date(windowEnd.getTime() - (RETENTION_WINDOW_DAYS - 1) * DAY_MS));
    const to = dayKey(windowEnd);
    marks[`d${n}`] = { eligible: true, retained: days.some((d) => d >= from && d <= to) };
  }
  const activeDaysByMonth = {};
  for (const d of days) activeDaysByMonth[d.slice(0, 7)] = (activeDaysByMonth[d.slice(0, 7)] || 0) + 1;
  return {
    startedAt: start.toISOString(),
    activeDays: days.length,
    lastActiveDay: days.length ? days[days.length - 1] : null,
    activeDaysByMonth,
    marks,
  };
}

function summarizeRatings(completions = []) {
  const ratings = completions
    .map((c) => c?.tenantConfirmation?.rating)
    .filter((n) => Number.isFinite(n));
  return {
    count: ratings.length,
    average: ratings.length ? round1(ratings.reduce((a, b) => a + b, 0) / ratings.length) : null,
  };
}

/**
 * Service-fee totals from JobCompletion.ledger.serviceFee. Absent until the fee
 * ships, which is fine: every figure is then 0 and the report says so.
 */
function summarizeServiceFee(completions = []) {
  let listed = 0;
  let waived = 0;
  let charged = 0;
  let owed = 0;
  let jobs = 0;
  for (const c of completions) {
    const fee = c?.ledger?.serviceFee;
    if (!fee) continue;
    jobs += 1;
    listed += Number(fee.listCents) || 0;
    charged += Number(fee.chargedCents) || 0;
    owed += Number(fee.owedCents) || 0;
    if (fee.waivedReason) waived += (Number(fee.listCents) || 0) - (Number(fee.chargedCents) || 0);
  }
  return { jobs, listedCents: listed, waivedCents: waived, chargedCents: charged, owedAtCloseCents: owed };
}

/** Everything for one landlord (or, with pooled inputs, for a cohort). */
function summarizeBeta(inputs = {}) {
  const requests = inputs.requests || [];
  const firstBookedAt = inputs.firstBookedAt || new Map();
  return {
    requests: summarizeRequests(requests),
    timeToBook: summarizeTimeToBook(requests, firstBookedAt),
    decisions: summarizeDecisions(requests, firstBookedAt, inputs.landlordActions || []),
    approvals: summarizeApprovals(inputs.approvals || []),
    money: summarizeMoney(inputs.ledgerEntries || []),
    satisfaction: summarizeRatings(inputs.completions || []),
    serviceFee: summarizeServiceFee(inputs.completions || []),
  };
}

const groupByLandlord = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const key = id(row.landlordId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

/**
 * Read everything for a set of landlords in a handful of bulk queries, grouped
 * per landlord. `range` ({from,to}) bounds when requests were raised and when
 * money moved; activity and the beta clock are never windowed, because
 * retention is about the whole life of the beta.
 */
async function loadBetaInputs(landlords, { range = null } = {}) {
  const ids = landlords.map((l) => l._id);
  const created =
    range && (range.from || range.to)
      ? { createdAt: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
      : {};

  const [requests, appointments, landlordActions, approvals, ledgerEntries, completions, activity] = await Promise.all([
    MaintenanceRequest.find({ landlordId: { $in: ids }, ...created })
      .select("landlordId status urgency createdAt completedAt")
      .lean(),
    Appointment.find({ landlordId: { $in: ids } }).select("landlordId requestId createdAt directPayment").lean(),
    AgentActionLog.find({ landlordId: { $in: ids }, actor: "landlord", requestId: { $ne: null } })
      .select("landlordId requestId createdAt")
      .lean(),
    ApprovalRequest.find({ landlordId: { $in: ids }, ...created }).select("landlordId type status").lean(),
    LedgerEntry.find({
      landlordId: { $in: ids },
      type: { $in: ["payout", "payout_reversal", "deposit"] },
      ...created,
    })
      .select("landlordId type amountCents createdAt")
      .lean(),
    JobCompletion.find({ landlordId: { $in: ids }, ...created })
      .select("landlordId tenantConfirmation.rating ledger.serviceFee")
      .lean(),
    LandlordActivityDay.find({ landlordId: { $in: ids } }).select("landlordId day").lean(),
  ]);

  // Direct-pay jobs owe or paid the vendor outside the ledger. Shaped like a
  // ledger row so summarizeMoney counts them on their own line, windowed by
  // when the job closed, the way ledger rows are windowed by when money moved.
  const inRange = (date) =>
    !range || ((!range.from || date >= range.from) && (!range.to || date <= range.to));
  for (const a of appointments) {
    const payment = a.directPayment;
    if (!payment?.status || !payment.dueSince || !inRange(new Date(payment.dueSince))) continue;
    ledgerEntries.push({
      landlordId: a.landlordId,
      type: "direct_payment",
      amountCents: payment.amountCents || 0,
      createdAt: payment.dueSince,
    });
  }

  const firstBookedAt = new Map();
  for (const a of appointments) {
    const key = id(a.requestId);
    const cur = firstBookedAt.get(key);
    if (!cur || a.createdAt < cur) firstBookedAt.set(key, a.createdAt);
  }

  return {
    firstBookedAt,
    grouped: {
      requests: groupByLandlord(requests),
      landlordActions: groupByLandlord(landlordActions),
      approvals: groupByLandlord(approvals),
      ledgerEntries: groupByLandlord(ledgerEntries),
      completions: groupByLandlord(completions),
      activity: groupByLandlord(activity),
    },
  };
}

/** One summary per landlord plus a pooled cohort summary. */
async function buildBetaReport(landlords, { range = null, now = new Date() } = {}) {
  const { grouped, firstBookedAt } = await loadBetaInputs(landlords, { range });
  const get = (name, landlordId) => grouped[name].get(id(landlordId)) || [];

  const perLandlord = landlords.map((landlord) => {
    const summary = summarizeBeta({
      requests: get("requests", landlord._id),
      firstBookedAt,
      landlordActions: get("landlordActions", landlord._id),
      approvals: get("approvals", landlord._id),
      ledgerEntries: get("ledgerEntries", landlord._id),
      completions: get("completions", landlord._id),
    });
    const retention = summarizeRetention({
      startedAt: landlord.beta?.startedAt || landlord.createdAt,
      activityDays: get("activity", landlord._id).map((row) => row.day),
      now,
    });
    return { landlordId: id(landlord._id), email: landlord.email, summary, retention };
  });

  const pooled = (name) => landlords.flatMap((l) => get(name, l._id));
  const cohort = {
    landlords: landlords.length,
    summary: summarizeBeta({
      requests: pooled("requests"),
      firstBookedAt,
      landlordActions: pooled("landlordActions"),
      approvals: pooled("approvals"),
      ledgerEntries: pooled("ledgerEntries"),
      completions: pooled("completions"),
    }),
    retention: Object.fromEntries(
      RETENTION_MARKS.map((n) => {
        const eligible = perLandlord.filter((p) => p.retention.marks[`d${n}`]?.eligible);
        const retained = eligible.filter((p) => p.retention.marks[`d${n}`].retained);
        return [`d${n}`, { eligible: eligible.length, retained: retained.length }];
      })
    ),
  };
  return { generatedAt: now.toISOString(), perLandlord, cohort };
}

module.exports = {
  percentile,
  summarizeRequests,
  summarizeTimeToBook,
  summarizeDecisions,
  summarizeApprovals,
  summarizeMoney,
  summarizeRetention,
  summarizeRatings,
  summarizeServiceFee,
  summarizeBeta,
  loadBetaInputs,
  buildBetaReport,
  RETENTION_MARKS,
};
