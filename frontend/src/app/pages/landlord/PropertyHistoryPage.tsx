import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Archive, ArrowLeft, Building2, Loader2 } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import ArchivedRequestRow from '../../components/archive/ArchivedRequestRow';
import { groupByUnit, type ArchivedRequest } from '../../components/archive/archiveFormat';
import { useLandlordProperties } from '../../hooks/landlord/useLandlordProperties';

/**
 * Property -> Unit history: the jobs that were finished and archived (7 days
 * after completion or cancellation), grouped by unit. `?unit=<id>` narrows to
 * one unit -- the Properties page links each unit straight here -- and the
 * narrowing happens on the server so paging stays correct.
 */
export default function PropertyHistoryPage() {
  useLandlordEntrance();
  const { propertyId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const unitFilter = searchParams.get('unit') || '';
  // Archived properties and units included: retiring one keeps its history here.
  const { properties, loading: propertiesLoading, error: propertiesError, reload } = useLandlordProperties({
    includeArchived: true,
  });
  const property = properties.find((candidate) => candidate._id === propertyId);

  const [rows, setRows] = useState<ArchivedRequest[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  const fetchPage = useCallback(
    async (before?: string) => {
      const response = (await LandlordAPI.getArchive({ propertyId, unitId: unitFilter || undefined, before })) as {
        data?: ArchivedRequest[];
        nextCursor?: string | null;
      };
      return { data: response.data || [], next: response.nextCursor || null };
    },
    [propertyId, unitFilter]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    fetchPage()
      .then(({ data, next }) => {
        if (cancelled) return;
        setRows(data);
        setCursor(next);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : 'Could not load the history'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fetchPage, attempt]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const { data, next } = await fetchPage(cursor);
      setRows((prev) => [...prev, ...data]);
      setCursor(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(() => groupByUnit(rows), [rows]);
  const setUnit = (unit: string) => setSearchParams(unit ? { unit } : {}, { replace: true });

  if (propertiesLoading) return <LandlordLoading label="Loading history..." />;
  if (propertiesError) {
    return <LandlordError title="History unavailable" message={propertiesError} onRetry={() => void reload()} />;
  }
  if (!property) {
    return (
      <PageContainer>
        <EmptyState icon={Building2} title="Property not found" description="It may have been deleted." />
        <div className="mt-4 text-center">
          <Link to="/dashboard/properties" className="text-sm font-medium text-[#137fec] hover:underline">
            Back to Properties
          </Link>
        </div>
      </PageContainer>
    );
  }

  const chip = (value: string, label: string) => {
    const active = unitFilter === value;
    return (
      <button
        key={value || 'all'}
        type="button"
        aria-pressed={active}
        data-testid={`history-unit-${value || 'all'}`}
        onClick={() => setUnit(value)}
        className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
          active ? 'border-transparent bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <PageContainer>
      <Link
        to="/dashboard/properties"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 transition hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Properties
      </Link>
      <PageHeader
        title={`${property.name} history`}
        description={`${property.address} · Finished jobs move here 7 days after they are completed or cancelled.`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-1.5" data-testid="history-unit-filter">
        {chip('', 'All units')}
        {(property.units || []).map((unit) => chip(unit._id, `Unit ${unit.unitNumber}`))}
      </div>

      {error ? (
        <LandlordError title="History unavailable" message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      ) : rows.length === 0 ? (
        <Card className="border border-slate-100 p-6 shadow-sm">
          <EmptyState
            icon={Archive}
            testId="history-empty"
            title="No archived jobs yet"
            description="Completed and cancelled jobs appear here a week after they finish, so the Requests list stays focused on live work."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} data-testid={`history-group-${group.key}`}>
              <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                {group.label}
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
                  {group.rows.length}
                </span>
              </h2>
              <div className="space-y-2">
                {group.rows.map((request) => (
                  <ArchivedRequestRow
                    key={request._id}
                    request={request}
                    to={`/dashboard/requests/${request._id}`}
                    showCost
                    showTenant
                  />
                ))}
              </div>
            </section>
          ))}
          {cursor ? (
            <div className="flex justify-center">
              <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Load older jobs
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageContainer>
  );
}
