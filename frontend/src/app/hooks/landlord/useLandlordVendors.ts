import { useCallback, useEffect, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { VendorItem } from '../../types/landlord';

export function useLandlordVendors() {
  const [vendors, setVendors] = useState<VendorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await LandlordAPI.listVendors();
      setVendors((response.data as VendorItem[]) || []);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load vendors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { vendors, setVendors, loading, error, reload };
}
