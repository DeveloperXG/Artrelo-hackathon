import { useCallback, useEffect, useState } from 'react';
import { LandlordAPI } from '../../api/client';
import type { RoutingSetup } from '../../types/landlord';

/**
 * Vendor count versus the policy's vendor cap, and whether routing can run at
 * all. Best-effort: a failed load leaves `setup` null, the guidance doesn't
 * render, and the server's own 409 routing_setup_incomplete still holds the
 * line. `enabled: false` skips the request (the tenant view shares a page).
 */
export function useRoutingSetup(enabled = true) {
  const [setup, setSetup] = useState<RoutingSetup | null>(null);

  // Returns what it read, so a caller can act on the fresh answer without
  // waiting for a re-render.
  const reload = useCallback(async (): Promise<RoutingSetup | null> => {
    if (!enabled) return null;
    try {
      const response = await LandlordAPI.routingSetup();
      const next = (response.data as RoutingSetup) || null;
      setSetup(next);
      return next;
    } catch {
      setSetup(null);
      return null;
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { setup, reload };
}
