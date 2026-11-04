import { useEffect, useState } from 'react';
import { AuthAPI } from '../../api/client';

export type PropertyManagerContact = { name: string | null; phone: string | null };

// Read once per page load and shared: it changes only when the landlord edits
// their profile, and the strip that shows it must never wait on a refetch.
let cached: PropertyManagerContact | null | undefined;

/**
 * The tenant's property manager, for "call them if it can't wait". Null until
 * loaded, or when there is nothing to show. A failed read just hides the
 * number; the 911 line beside it never depends on this.
 */
export function usePropertyManagerContact(): PropertyManagerContact | null {
  const [contact, setContact] = useState<PropertyManagerContact | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return;
    let live = true;
    AuthAPI.me()
      .then((body) => {
        const pm = (body as { propertyManager?: PropertyManagerContact }).propertyManager || null;
        cached = pm;
        if (live) setContact(pm);
      })
      .catch(() => {
        // Left undefined so the next mount can try again.
      });
    return () => {
      live = false;
    };
  }, []);
  return contact;
}
