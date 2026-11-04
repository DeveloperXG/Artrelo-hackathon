import { useCallback, useEffect, useRef, useState } from 'react';
import { LandlordAPI, TenantAPI } from '../api/client';
import type { AppointmentItem } from '../types/appointment';
import { useLiveTopic } from './useLiveTopic';

/**
 * Appointments for whichever portal is asking. Follows the same
 * `{ data, loading, error, reload }` contract as the other data hooks, and
 * carries the focus-refresh guard from useTenantRequests — a pending
 * confirmation should not look stale after the tab has been sitting open.
 */
export function useAppointments(role: 'landlord' | 'tenant') {
  const [appointments, setAppointments] = useState<AppointmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const inFlightRef = useRef(false);

  const reload = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      if (!silent) setLoading(true);
      setError('');
      try {
        const response =
          role === 'landlord' ? await LandlordAPI.listAppointments() : await TenantAPI.listAppointments();
        setAppointments((response.data as AppointmentItem[]) || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load appointments');
      } finally {
        inFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    },
    [role]
  );

  useEffect(() => {
    void reload();
  }, [reload]);
  useLiveTopic('requests', () => { void reload({ silent: true }); });

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reload({ silent: true });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reload]);

  return { appointments, setAppointments, loading, error, reload };
}
