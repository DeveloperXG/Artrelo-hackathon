import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/config/site';

// Statically generated at build time (compatible with output: 'export').
export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // App-shell routes served by the SPA under the same domain — not content
      // pages, so keep them out of the index.
      disallow: ['/dashboard', '/portal', '/login', '/signup', '/landlord-signup'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
