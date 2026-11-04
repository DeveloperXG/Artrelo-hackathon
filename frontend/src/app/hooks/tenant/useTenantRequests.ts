import { useCallback, useEffect, useRef, useState } from 'react';
import { TenantAPI } from '../../api/client';
import type { Request } from '../../components/tenant/tenantRequests';
import { useLiveTopic } from '../useLiveTopic';

/**
 * Loads the signed-in tenant's maintenance requests and keeps them fresh when
 * the tab regains focus. Mirrors the landlord `useLandlordRequests` hook so the
 * tenant pages follow the same data-loading contract.
 */
export function useTenantRequests() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inFlightRef = useRef(false);

  const reload = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (!silent) setLoading(true);
    try {
      const response = await TenantAPI.listRequests();
      setRequests((response.data as Request[]) || []);
      setError('');
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : 'Failed to load requests');
    } finally {
      inFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, []);
  useLiveTopic('requests', () => { void reload({ silent: true }); });

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') {
        void reload({ silent: true });
      }
    };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [reload]);

  return { requests, setRequests, loading, error, reload };
}
