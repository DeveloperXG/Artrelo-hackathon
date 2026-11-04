/**
 * Calendar geometry for the landlord schedule — pure, so the awkward cases
 * (several units booked into the same slot) are tested rather than eyeballed.
 *
 * Same-time visits are laid out the way Google Calendar does it:
 *   1. Events that overlap, directly or through a chain, form a CLUSTER. Only a
 *      cluster is split; a 9 a.m. visit is not squeezed because 10 a.m. is busy.
 *   2. Within a cluster each event takes the first LANE whose last event has
 *      ended — so a staggered 10:00–11:00 and 11:00–12:00 share one lane.
 *   3. Past `maxLanes`, the last visible lane becomes a "+N more" chip covering
 *      the time span of everything that didn't fit, so nothing is ever silently
 *      dropped from the grid.
 */

export type CalEvent = { id: string; start: Date; end: Date };

export type PlacedEvent = {
  id: string;
  /** 0-based lane within the cluster. */
  lane: number;
  /** How many lanes the cluster is drawn with (already capped). */
  lanes: number;
};

export type OverflowChip = {
  /** Lane the chip occupies — always the last visible one. */
  lane: number;
  lanes: number;
  start: Date;
  end: Date;
  /** Every event folded into the chip, in start order. */
  ids: string[];
};

/** A visit with no recorded end is drawn as an hour long. */
export const DEFAULT_DURATION_MIN = 60;

export function eventEnd(start: Date, end?: Date | null): Date {
  if (end && end.getTime() > start.getTime()) return end;
  return new Date(start.getTime() + DEFAULT_DURATION_MIN * 60_000);
}

export function layoutDay(
  events: CalEvent[],
  maxLanes: number
): { placed: PlacedEvent[]; overflow: OverflowChip[] } {
  const cap = Math.max(1, Math.floor(maxLanes));
  const sorted = [...events].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      // Longer first at the same start, so it takes the leftmost lane.
      b.end.getTime() - a.end.getTime() ||
      a.id.localeCompare(b.id)
  );

  const placed: PlacedEvent[] = [];
  const overflow: OverflowChip[] = [];

  let cluster: { event: CalEvent; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const total = laneEnds.length;
    if (total <= cap) {
      cluster.forEach(({ event, lane }) => placed.push({ id: event.id, lane, lanes: total }));
    } else {
      const lastVisible = cap - 1;
      const hidden = cluster.filter(({ lane }) => lane >= lastVisible).map(({ event }) => event);
      cluster
        .filter(({ lane }) => lane < lastVisible)
        .forEach(({ event, lane }) => placed.push({ id: event.id, lane, lanes: cap }));
      overflow.push({
        lane: lastVisible,
        lanes: cap,
        start: new Date(Math.min(...hidden.map((e) => e.start.getTime()))),
        end: new Date(Math.max(...hidden.map((e) => e.end.getTime()))),
        ids: hidden.map((e) => e.id),
      });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const event of sorted) {
    const start = event.start.getTime();
    const end = event.end.getTime();
    // Touching is not overlapping: an 11:00 start after an 11:00 end is a new cluster.
    if (start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    cluster.push({ event, lane });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return { placed, overflow };
}

/**
 * The hours the time grid shows: 8 a.m.–6 p.m. by default, stretched to the
 * whole hour around any visit outside that.
 */
export function hourRange(events: CalEvent[], defaults: [number, number] = [8, 18]): [number, number] {
  let [from, to] = defaults;
  for (const event of events) {
    from = Math.min(from, event.start.getHours());
    const end = event.end;
    // A visit ending at 7:00 exactly needs the grid to reach 7, not 8; one
    // running past midnight is drawn to the end of its own day.
    const endHour =
      end.toDateString() !== event.start.toDateString()
        ? 24
        : end.getHours() + (end.getMinutes() || end.getSeconds() ? 1 : 0);
    to = Math.max(to, endHour);
  }
  return [Math.max(0, from), Math.min(24, to)];
}

/* ---------------- dates ---------------- */

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const day = date.getDay(); // 0 = Sunday
  return addDays(startOfDay(date), day === 0 ? -6 : 1 - day);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** The 7 days of the week containing `date`, Monday first. */
export function weekDays(date: Date): Date[] {
  const monday = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Six Monday-first weeks covering the month of `date` — a fixed-height month grid. */
export function monthGrid(date: Date): Date[] {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Minutes since midnight, for placing an event on the time grid. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
