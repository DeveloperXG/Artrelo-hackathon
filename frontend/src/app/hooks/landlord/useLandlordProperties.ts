import { useCallback, useEffect, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { Property } from '../../types/landlord';

/** `includeArchived` is for History: a retired property or unit must still
 *  resolve there. Everywhere else lists live ones only. */
export function useLandlordProperties({ includeArchived = false }: { includeArchived?: boolean } = {}) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await LandlordAPI.listProperties(includeArchived ? { archived: 'all' } : {});
      setProperties((response.data as Property[]) || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load properties');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { properties, setProperties, loading, error, reload };
}
