import type { JudgeView } from '../judge/judgeController';
import type { BookingPayload, TimeWindow } from '../../types/booking';
import { checkWindows, fromLocalInput, toLocalInput, type WindowRow } from './rescheduleModel';

export const DEMO_RESCHEDULE_REASON = 'Synthetic demo scheduling example: please move this visit to one of the proposed windows. Review and edit this reason before sending.';
export type DemoRescheduleContext = { view: JudgeView; requestId: string; revision: number; reason: string; rows: WindowRow[]; disabled?: boolean };
export const emptyDemoWindows = (rows: WindowRow[]) => rows.length > 0 && rows.every(row => row.start === '' && row.end === '');
export const demoDraftKey = ({ reason, rows }: DemoRescheduleContext) => JSON.stringify({ reason, rows });

/** A presentation helper, never authority to request a change or supply consent. */
export function demoRescheduleScope(context: DemoRescheduleContext): string | null {
  const { view, requestId, revision } = context, { run } = view.status;
  if (context.disabled || !view.loaded || !view.status.enabled || view.status.role !== 'landlord' || view.refreshFailed || view.pollExpired || view.busy || view.notice ||
    !run || run.requestId !== requestId || run.error || ['completed', 'failed'].includes(run.state) || !Number.isInteger(revision) || revision < 1) return null;
  return JSON.stringify([view.status.pairLabel, run.runId, run.requestId, run.startedAt, run.revision, requestId, revision]);
}

export function applyDemoReason(current: () => DemoRescheduleContext, apply: (reason: string) => void): boolean {
  const context = current();
  if (!demoRescheduleScope(context) || context.reason.length !== 0) return false;
  apply(DEMO_RESCHEDULE_REASON);
  return true;
}

/** Previously suggested server windows are candidates, not free-calendar proof.
 * No date is invented or moved. Ordinary validation remains authoritative. */
export function currentDemoWindows(data: BookingPayload | null | undefined, revision: number, now: number): TimeWindow[] {
  const state = data?.coordination;
  if (!Number.isFinite(now) || !state || state.revision !== revision || state.capabilities?.state !== 'confirmed' ||
    state.capabilities.canRequestReschedule !== true || !Array.isArray(data?.reschedules) || data.reschedules.some(change => change.active) || !Array.isArray(state.proposals)) return [];
  const original = Date.parse(state.arrivalAt || ''), duration = state.durationMinutes;
  if (!Number.isFinite(original) || !Number.isInteger(duration) || !duration || duration < 15 || duration > 720 || duration % 15) return [];
  const originalEnd = original + duration * 60_000, selected: TimeWindow[] = [], seen = new Set<string>();
  for (const window of state.proposals || []) {
    const start = Date.parse(window.start), end = Date.parse(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < duration * 60_000 ||
      !(end <= original || start >= originalEnd) || Math.min(original, start) - 2 * 3600_000 - now < 15 * 60_000) continue;
    const row = { start: toLocalInput(window.start), end: toLocalInput(window.end) };
    // datetime-local must preserve the exact instant, including DST ambiguity
    // and sub-minute values. A lossy conversion is left for manual entry.
    if (fromLocalInput(row.start) !== new Date(start).toISOString() || fromLocalInput(row.end) !== new Date(end).toISOString() ||
      checkWindows([row], new Date(now)).summary) continue;
    const key = `${start}:${end}`;
    if (!seen.has(key)) { selected.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }); seen.add(key); }
    if (selected.length === 3) break;
  }
  return selected;
}

export type DemoWindowResult = { kind: 'ready'; windows: TimeWindow[]; scope: string; draftKey: string } | { kind: 'unavailable' | 'changed' | 'error' };
/** Explicit click -> one ordinary read -> recheck scope, edits and clock. No write/retry. */
export async function readDemoWindows({ current, read, now = Date.now }: {
  current: () => DemoRescheduleContext;
  read: (requestId: string) => Promise<{ data?: BookingPayload | null }>;
  now?: () => number;
}): Promise<DemoWindowResult> {
  const before = current(), scope = demoRescheduleScope(before), draftKey = demoDraftKey(before), started = now();
  if (!scope || !Number.isFinite(started) || !emptyDemoWindows(before.rows)) return { kind: 'changed' };
  try {
    const response = await read(before.requestId), latest = current(), at = now();
    if (demoRescheduleScope(latest) !== scope || demoDraftKey(latest) !== draftKey || !Number.isFinite(at) || at < started || at - started > 30_000) return { kind: 'changed' };
    const windows = currentDemoWindows(response.data, before.revision, at);
    return windows.length ? { kind: 'ready', windows, scope, draftKey } : { kind: 'unavailable' };
  } catch { return { kind: 'error' }; }
}
