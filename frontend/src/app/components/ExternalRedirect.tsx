import { useEffect } from 'react';
import { marketingUrl } from '../lib/marketingUrl';

// Full-page navigation (not a client-side route) to a marketing path served by
// the separate Next.js app. In production a reverse proxy serves "/" and the
// other marketing paths from that build; in dev, marketingUrl() targets the
// marketing dev server so the redirect leaves the SPA instead of looping.
export default function ExternalRedirect({ to = '/' }: { to?: string }) {
  useEffect(() => {
    window.location.replace(marketingUrl(to));
  }, [to]);
  return null;
}
