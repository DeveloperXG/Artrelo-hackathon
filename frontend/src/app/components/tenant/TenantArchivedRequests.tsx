import { useEffect, useMemo, useState } from 'react';
import { Archive, Loader2 } from 'lucide-react';
import { TenantAPI } from '../../api/client';
import { Card } from '../ui/card';
import ArchivedRequestRow from '../archive/ArchivedRequestRow';
import { groupByUnit, propertyName, type ArchivedRequest } from '../archive/archiveFormat';

/**
 * The tenant's finished requests, moved off the working list 7 days after they
 * were completed or cancelled. Grouped by home (property, then unit) -- today a
 * tenant has one unit, so this is one heading, but the grouping is what keeps
 * the history findable the same way a landlord finds it.
 */
export default function TenantArchivedRequests() {
  const [rows, setRows] = useState<ArchivedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    TenantAPI.listRequests({ archived: true })
      .then((response) => !cancelled && setRows(((response as { data?: ArchivedRequest[] }).data) || []))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load archived requests'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Property first, then unit within it.
  const homes = useMemo(() => {
    const byProperty = new Map<string, ArchivedRequest[]>();
    for (const row of rows) {
      const name = propertyName(row);
      byProperty.set(name, [...(byProperty.get(name) || []), row]);
    }
    return [...byProperty.entries()].map(([name, items]) => ({ name, units: groupByUnit(items) }));
  }, [rows]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400 in-[.lichen-d5]:text-meta" />
      </div>
    );
  }
  if (error) {
    return <Card className="border border-rose-100 bg-rose-50 p-5 text-sm text-rose-700 in-[.lichen-d5]:bg-alert-tint in-[.lichen-d5]:text-alert-text in-[.lichen-d5]:border-alert-line">{error}</Card>;
  }
  if (!rows.length) {
    return (
      <Card className="border border-slate-100 p-8 text-center shadow-sm in-[.lichen-d5]:border-hairline in-[.lichen-d5]:shadow-none" data-testid="tenant-archive-empty">
        <Archive className="mx-auto h-7 w-7 text-slate-300 in-[.lichen-d5]:text-meta" />
        <p className="mt-2 text-sm font-medium text-slate-700 in-[.lichen-d5]:text-ink">Nothing archived yet</p>
        <p className="mt-1 text-sm text-slate-500 in-[.lichen-d5]:text-meta">
          Completed and cancelled requests move here a week after they finish.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="tenant-archive">
      {homes.map((home) => (
        <Card key={home.name} className="gap-4 border border-slate-100 p-5 shadow-sm in-[.lichen-d5]:border-hairline in-[.lichen-d5]:shadow-none">
          <h2 className="text-sm font-semibold text-slate-900 in-[.lichen-d5]:text-ink">{home.name}</h2>
          {home.units.map((group) => (
            <section key={group.key}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 in-[.lichen-d5]:text-meta">{group.label}</h3>
              <div className="space-y-2">
                {group.rows.map((request) => (
                  <ArchivedRequestRow key={request._id} request={request} to={`/portal/requests/${request._id}`} />
                ))}
              </div>
            </section>
          ))}
        </Card>
      ))}
    </div>
  );
}
