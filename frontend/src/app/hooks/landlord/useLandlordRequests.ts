import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { RequestItem } from '../../types/landlord';
import { createLatestGuard } from '../../lib/backgroundRefresh';

export function useLandlordRequests(filters?: Record<string, string>) {
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const filterKey = useMemo(() => JSON.stringify(filters || {}), [filters]);
  const guard = useRef(createLatestGuard()).current;
  const loadedRef = useRef(false);

  // `silent` refetches without the loading state (a live nudge or poll), and a
  // failed silent refetch keeps the rows on screen. Only the newest call writes.
  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const isLatest = guard.begin();
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const response = await LandlordAPI.listRequests(filters);
      if (!isLatest()) return;
      setRequests((response.data as RequestItem[]) || []);
      loadedRef.current = true;
      setError('');
    } catch (error) {
      if (!isLatest()) return;
      if (!silent || !loadedRef.current) setError(error instanceof Error ? error.message : 'Failed to load requests');
    } finally {
      // The newest call always settles loading, so a silent call that
      // superseded a visible one cannot leave the spinner up.
      if (isLatest()) setLoading(false);
    }
  }, [filterKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { requests, setRequests, loading, error, reload };
}
