const BUFFER_MS = 30 * 60_000;
const LIVE_APPOINTMENT_STATUSES = ["awaiting_tenant", "scheduled", "work_verifying", "in_review", "disputed"];

function interval(start, end) {
  const from = new Date(start), to = new Date(end);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
    const error = new Error("Choose a valid start and end time.");
    error.code = "invalid_interval"; error.status = 400; throw error;
  }
  return { start: from, end: to };
}
function overlaps(a, b, bufferMs = BUFFER_MS) {
  return new Date(a.start).getTime() < new Date(b.end).getTime() + bufferMs &&
    new Date(b.start).getTime() < new Date(a.end).getTime() + bufferMs;
}
// Return free intervals, not the other customers' booking details. The duration
// picker further narrows these before a vendor commits a precise arrival.
function subtractBusy(windows, busy, { durationMinutes = 15, bufferMs = BUFFER_MS } = {}) {
  const required = durationMinutes * 60_000;
  const occupied = busy.map(row => ({ start: new Date(row.start).getTime() - bufferMs,
    end: new Date(row.end).getTime() + bufferMs })).sort((a, b) => a.start - b.start);
  return windows.flatMap(window => {
    let segments = [{ start: new Date(window.start).getTime(), end: new Date(window.end).getTime() }];
    for (const block of occupied) segments = segments.flatMap(segment => {
      if (block.end <= segment.start || block.start >= segment.end) return [segment];
      return [{ start: segment.start, end: Math.min(segment.end, block.start) },
        { start: Math.max(segment.start, block.end), end: segment.end }].filter(row => row.end > row.start);
    });
    return segments.filter(row => row.end - row.start >= required)
      .map(row => ({ ...window, start: new Date(row.start), end: new Date(row.end) }));
  });
}
module.exports = { BUFFER_MS, LIVE_APPOINTMENT_STATUSES, interval, overlaps, subtractBusy };
