// Moves finished requests out of the working lists.
//
// A completed or cancelled request stays on the Requests page for
// ARCHIVE_AFTER_DAYS (7) -- long enough to dispute, review or follow up --
// then gets archivedAt. Archived requests drop out of the tenant's and the
// landlord's request lists and live under Property -> Unit history instead.
//
// Archiving is a flag, never a delete. Appointments, JobCompletions, ledger
// entries, vendor-hub history and ProxySessions all reference the request or
// its appointment by id; every one of them keeps working, and the request
// stays readable by id. Money views (overview spend, wallet) do not filter on
// archivedAt at all.
//
// Only completed/cancelled qualify. Rejected requests have their own
// lifecycle (appeal window, then rejectedRequestCleanup deletes them), and
// anything still open is by definition not finished.

const env = require("../../config/env");
const MaintenanceRequest = require("../../models/MaintenanceRequest");

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: the filter for requests due to be archived as of `now`. */
function archiveDueFilter(now = new Date(), days = env.archive_after_days) {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  return {
    archivedAt: null,
    $or: [
      { status: "completed", completedAt: { $lte: cutoff } },
      { status: "cancelled", cancelledAt: { $lte: cutoff } },
      // Finished before the timestamp existed (cancelledAt is new; completedAt
      // was always set, but be safe): the last write is the best we have.
      { status: "completed", completedAt: { $exists: false }, updatedAt: { $lte: cutoff } },
      { status: "cancelled", cancelledAt: { $exists: false }, updatedAt: { $lte: cutoff } },
    ],
  };
}

async function archiveFinishedRequests({ now = new Date(), days = env.archive_after_days, model = MaintenanceRequest } = {}) {
  // updateMany on purpose: no document hooks to re-run, and the guard
  // (archivedAt: null) makes concurrent sweeps on two instances harmless.
  // No timeline entry -- StatusEvent.status is the request-status enum and
  // "archived" is not a status; archivedAt is the record.
  const result = await model.updateMany(archiveDueFilter(now, days), { $set: { archivedAt: now } });
  const count = result?.modifiedCount || 0;
  if (count) console.log(`[archiveSweeper] archived ${count} finished request(s)`);
  return count;
}

function startArchiveSweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const run = () => {
    archiveFinishedRequests().catch((err) => console.error("[archiveSweeper] run failed", err));
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { archiveDueFilter, archiveFinishedRequests, startArchiveSweeper };
