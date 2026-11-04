import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { TenantAPI } from '../../api/client';
import type { TenantMoveOutStatus } from '../../types/landlord';

/** Fetched once by TenantLayout and shared with the pages through the outlet. */
export function useTenantMoveOutState() {
  const [status, setStatus] = useState<TenantMoveOutStatus | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await TenantAPI.getMoveOut();
      setStatus(response.data as TenantMoveOutStatus);
    } catch {
      // Unknown is treated as linked: the server still refuses a request from
      // a tenant with no unit, so failing open here only costs a clear message.
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { status, reload };
}

export type TenantOutletContext = ReturnType<typeof useTenantMoveOutState>;

/** For pages under TenantLayout. `linked` is true until proven otherwise. */
export function useTenantMoveOut() {
  const context = useOutletContext<TenantOutletContext | undefined>();
  const status = context?.status ?? null;
  return {
    status,
    linked: status ? status.linked : true,
    reload: context?.reload ?? (async () => {}),
  };
}
