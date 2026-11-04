// The landlord Reports page: maintenance spend, volume, speed and vendor
// performance over a chosen date range, each compared with the period of the
// same length just before it.
//
// Definitions match the dashboard's /landlords/stats, on purpose — a number on
// Reports must never disagree with the same number on the Overview:
//   - spend is the FINAL cost of requests COMPLETED in the range; a vendor's
//     quote on an open job is a ceiling, not money spent;
//   - "completed" is counted by completedAt; "incoming" by createdAt;
//   - resolution time is completedAt − createdAt of jobs completed in range.
//
// summarizeReport is pure and carries every rule; buildLandlordReport only
// fetches rows and attaches names.

const MaintenanceRequest = require("../../models/MaintenanceRequest");
const Property = require("../../models/Property");
const Vendor = require("../../models/Vendor");
const JobCompletion = require("../../models/JobCompletion");
const { trendBetween } = require("./trendBuckets");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Up to this span the charts bucket by day; longer, by calendar month. */
const DAILY_MAX_DAYS = 62;
const MAX_SPAN_DAYS = 3 * 366;

class ReportRangeError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
    this.status = 400;
  }
}

function parseDay(value, endOfDay) {
  if (!value) return null;
  // A bare date means the whole day, in server time — like the stats buckets.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (match && endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

/**
 * ?from&to as YYYY-MM-DD (inclusive). Defaults to this month so far.
 * Throws ReportRangeError with the offending field.
 */
function parseRange(query = {}, now = new Date()) {
  const from = parseDay(query.from, false);
  const to = parseDay(query.to, true);
  if (from === undefined) throw new ReportRangeError("Start date isn't a valid date.", "from");
  if (to === undefined) throw new ReportRangeError("End date isn't a valid date.", "to");
  const start = from || new Date(now.getFullYear(), now.getMonth(), 1);
  const end = to || now;
  if (start > end) throw new ReportRangeError("The start date must be on or before the end date.", "from");
  if ((end - start) / DAY_MS > MAX_SPAN_DAYS) {
    throw new ReportRangeError("Choose a range of three years or less.", "from");
  }
  return { from: start, to: end };
}

/** The equally long period immediately before [from, to]. */
function previousPeriod({ from, to }) {
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  return { from: new Date(prevTo.getTime() - span), to: prevTo };
}

const inRange = (date, range) => date && date >= range.from && date <= range.to;
const vendorKey = (r) => (r.selectedVendorId || r.vendorId ? String(r.selectedVendorId || r.vendorId) : null);
const round = (value, places = 1) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);

function totalsFor(requests, range) {
  const completed = requests.filter((r) => r.status === "completed" && inRange(new Date(r.completedAt || r.createdAt), range));
  const spend = completed.reduce((acc, r) => acc + (r.finalCost ?? 0), 0);
  const resolutionDays = completed
    .filter((r) => r.completedAt)
    .map((r) => (new Date(r.completedAt) - new Date(r.createdAt)) / DAY_MS)
    .filter((days) => days >= 0);
  return {
    spend,
    completed: completed.length,
    incoming: requests.filter((r) => inRange(new Date(r.createdAt), range)).length,
    avgResolutionDays: resolutionDays.length
      ? round(resolutionDays.reduce((acc, d) => acc + d, 0) / resolutionDays.length)
      : null,
    avgCostPerJob: completed.length ? round(spend / completed.length, 2) : null,
  };
}

/**
 * Everything the page shows, from request rows alone. `ratingsByRequest`
 * maps a completed request id to the tenant's 1–5 rating, where one was given.
 */
function summarizeReport(requests, range, { ratingsByRequest = new Map() } = {}) {
  const previous = previousPeriod(range);
  const spanDays = (range.to - range.from) / DAY_MS;
  const unit = spanDays <= DAILY_MAX_DAYS ? "day" : "month";

  const completedInRange = requests.filter(
    (r) => r.status === "completed" && inRange(new Date(r.completedAt || r.createdAt), range)
  );

  const byCategory = {};
  for (const r of requests) {
    if (!inRange(new Date(r.createdAt), range)) continue;
    const name = r.category || "Other";
    byCategory[name] = (byCategory[name] || 0) + 1;
  }

  const spendByProperty = new Map();
  const vendors = new Map();
  for (const r of completedInRange) {
    if (r.propertyId) {
      const key = String(r.propertyId);
      spendByProperty.set(key, (spendByProperty.get(key) || 0) + (r.finalCost ?? 0));
    }
    const key = vendorKey(r);
    if (!key) continue;
    const row = vendors.get(key) || { vendorId: key, jobs: 0, spend: 0, resolution: [], ratings: [] };
    row.jobs += 1;
    row.spend += r.finalCost ?? 0;
    if (r.completedAt) {
      const days = (new Date(r.completedAt) - new Date(r.createdAt)) / DAY_MS;
      if (days >= 0) row.resolution.push(days);
    }
    const rating = ratingsByRequest.get(String(r._id));
    if (rating) row.ratings.push(rating);
    vendors.set(key, row);
  }

  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

  return {
    range: { from: range.from, to: range.to, unit },
    previousRange: previous,
    totals: totalsFor(requests, range),
    previousTotals: totalsFor(requests, previous),
    trend: trendBetween(requests, { from: range.from, to: range.to, unit }),
    byCategory,
    spendByProperty: [...spendByProperty.entries()]
      .map(([propertyId, spend]) => ({ propertyId, spend }))
      .sort((a, b) => b.spend - a.spend),
    vendorPerformance: [...vendors.values()]
      .map((row) => ({
        vendorId: row.vendorId,
        jobs: row.jobs,
        spend: row.spend,
        avgResolutionDays: round(mean(row.resolution)),
        avgRating: round(mean(row.ratings)),
        ratingCount: row.ratings.length,
      }))
      .sort((a, b) => b.jobs - a.jobs || b.spend - a.spend),
  };
}

async function buildLandlordReport(landlordId, range) {
  const previous = previousPeriod(range);
  // Everything raised or finished in either period: the current numbers and
  // the comparison both come from this one read.
  const requests = await MaintenanceRequest.find({
    landlordId,
    $or: [
      { createdAt: { $gte: previous.from, $lte: range.to } },
      { completedAt: { $gte: previous.from, $lte: range.to } },
    ],
  })
    .select("status category urgency finalCost createdAt completedAt propertyId selectedVendorId vendorId")
    .lean();

  const completedIds = requests
    .filter((r) => r.status === "completed" && inRange(new Date(r.completedAt || r.createdAt), range))
    .map((r) => r._id);
  const ratings = completedIds.length
    ? await JobCompletion.find({
        landlordId,
        requestId: { $in: completedIds },
        "tenantConfirmation.rating": { $ne: null },
      })
        .select("requestId tenantConfirmation.rating")
        .lean()
    : [];
  const ratingsByRequest = new Map(ratings.map((row) => [String(row.requestId), row.tenantConfirmation.rating]));

  const report = summarizeReport(requests, range, { ratingsByRequest });

  // Names, last: only for what the report actually mentions. Retired
  // properties are included — money spent on them is still history.
  const propertyIds = report.spendByProperty.map((row) => row.propertyId);
  const vendorIds = report.vendorPerformance.map((row) => row.vendorId);
  const [properties, vendorRows] = await Promise.all([
    propertyIds.length ? Property.find({ _id: { $in: propertyIds }, landlordId }).select("name").lean() : [],
    vendorIds.length
      ? Vendor.find({ _id: { $in: vendorIds } }).select("name company responseStats.averageFirstResponseMinutes").lean()
      : [],
  ]);
  const propertyName = new Map(properties.map((p) => [String(p._id), p.name]));
  const vendorById = new Map(vendorRows.map((v) => [String(v._id), v]));

  return {
    ...report,
    spendByProperty: report.spendByProperty.map((row) => ({
      ...row,
      name: propertyName.get(row.propertyId) || "Removed property",
    })),
    vendorPerformance: report.vendorPerformance.map((row) => {
      const vendor = vendorById.get(row.vendorId);
      return {
        ...row,
        name: vendor?.name || "Removed vendor",
        company: vendor?.company || null,
        // A lifetime figure: first replies aren't stored per job, only as the
        // vendor's running average.
        avgFirstResponseMinutes: vendor?.responseStats?.averageFirstResponseMinutes || null,
      };
    }),
  };
}

module.exports = { parseRange, previousPeriod, summarizeReport, buildLandlordReport, ReportRangeError };
