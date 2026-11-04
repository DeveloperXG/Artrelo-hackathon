// Shaping archived requests for the history views (landlord Property -> Unit,
// tenant "Archived"). Pure, so the grouping and labels are unit-tested.

type Ref<T> = (T & { _id: string }) | string | null | undefined;

export interface ArchivedRequest {
  _id: string;
  issueTitle: string;
  ai?: { shortTitle?: string } | null;
  category?: string;
  status: string;
  completedAt?: string | null;
  cancelledAt?: string | null;
  archivedAt: string;
  updatedAt?: string;
  createdAt?: string;
  finalCost?: number | null;
  propertyId?: Ref<{ name?: string }>;
  unitId?: Ref<{ unitNumber?: string }>;
  tenantId?: Ref<{ firstName?: string; lastName?: string }>;
  vendorId?: Ref<{ name?: string; company?: string }>;
}

export interface UnitGroup {
  /** The unit id, or "none" for requests that carry no unit. */
  key: string;
  label: string;
  rows: ArchivedRequest[];
}

const refId = (ref: Ref<object>) => (ref && typeof ref === 'object' ? ref._id : ref || null);

export const archivedTitle = (r: ArchivedRequest) => r.ai?.shortTitle || r.issueTitle;

/** When the job ended: completion or cancellation, falling back to the archive date. */
export function finishedAt(r: ArchivedRequest): string {
  if (r.status === 'completed' && r.completedAt) return r.completedAt;
  if (r.status === 'cancelled' && r.cancelledAt) return r.cancelledAt;
  return r.updatedAt || r.archivedAt;
}

export function outcomeLabel(r: ArchivedRequest): string {
  return r.status === 'completed' ? 'Completed' : r.status === 'cancelled' ? 'Cancelled' : r.status;
}

/**
 * One group per unit, in natural unit order ("2" before "10", "4B" before
 * "5A"), with unit-less requests last under "No unit" -- the order a landlord
 * reads a building in. Rows keep the order they arrived in (newest first).
 */
export function groupByUnit(rows: ArchivedRequest[]): UnitGroup[] {
  const groups = new Map<string, UnitGroup>();
  for (const row of rows) {
    const id = refId(row.unitId);
    const key = id || 'none';
    if (!groups.has(key)) {
      const unitNumber = row.unitId && typeof row.unitId === 'object' ? row.unitId.unitNumber : undefined;
      groups.set(key, { key, label: id ? `Unit ${unitNumber || '—'}` : 'No unit', rows: [] });
    }
    groups.get(key)!.rows.push(row);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'none') return 1;
    if (b.key === 'none') return -1;
    return collator.compare(a.label, b.label);
  });
}

export function propertyName(r: ArchivedRequest): string {
  return r.propertyId && typeof r.propertyId === 'object' ? r.propertyId.name || 'Property' : 'Property';
}
