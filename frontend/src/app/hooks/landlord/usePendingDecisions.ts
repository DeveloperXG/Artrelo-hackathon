import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { ApprovalRequestItem, RoutingDecisionItem } from '../../types/landlord';
import { createLatestGuard } from '../../lib/backgroundRefresh';

export function usePendingDecisions() {
  const [approvals, setApprovals] = useState<ApprovalRequestItem[]>([]);
  // Decisions with no ApprovalRequest row: Approve contact, paused routing.
  // The sidebar badge counts both lists, so the page has to show both.
  const [routingDecisions, setRoutingDecisions] = useState<RoutingDecisionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  const guard = useRef(createLatestGuard()).current;
  const loadedRef = useRef(false);

  // `silent` refetches without the loading state (a live nudge or poll), and a
  // failed silent refetch keeps the cards on screen. Only the newest call
  // writes, so a slow background response cannot resurrect a decision that a
  // later reload already showed as gone.
  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const isLatest = guard.begin();
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const [approvalResponse, routingResponse] = await Promise.all([
        LandlordAPI.listApprovalRequests({ status: 'pending' }),
        LandlordAPI.listRoutingDecisions(),
      ]);
      if (!isLatest()) return;
      setApprovals((approvalResponse.data as ApprovalRequestItem[]) || []);
      setRoutingDecisions((routingResponse.data as RoutingDecisionItem[]) || []);
      loadedRef.current = true;
      setError('');
    } catch (error) {
      if (!isLatest()) return;
      if (!silent || !loadedRef.current) {
        setError(error instanceof Error ? error.message : 'Failed to load pending decisions');
      }
    } finally {
      if (isLatest()) setLoading(false);
    }
  }, [guard]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending'),
    [approvals]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const approval of pendingApprovals) {
      counts[approval.type] = (counts[approval.type] || 0) + 1;
    }
    return counts;
  }, [pendingApprovals]);

  const filteredApprovals = useMemo(
    () =>
      typeFilter === 'all'
        ? pendingApprovals
        : pendingApprovals.filter((approval) => approval.type === typeFilter),
    [pendingApprovals, typeFilter]
  );

  return {
    approvals,
    setApprovals,
    pendingApprovals,
    filteredApprovals,
    routingDecisions,
    typeCounts,
    typeFilter,
    setTypeFilter,
    loading,
    error,
    reload,
  };
}
