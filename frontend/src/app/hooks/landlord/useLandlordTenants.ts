import { useCallback, useEffect, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { TenantItem } from '../../types/landlord';

export function useLandlordTenants() {
  const [tenants, setTenants] = useState<TenantItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await LandlordAPI.listTenants();
      setTenants((response.data as TenantItem[]) || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tenants, setTenants, loading, error, reload };
}
