import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/config/site';

// Statically generated at build time (compatible with output: 'export').
// Mirrors the changefreq/priority the SPA's hand-written sitemap.xml used.
export const dynamic = 'force-static';

const routes: { path: string; changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency']; priority: number }[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  // The primary commercial conversion, so it ranks with pricing rather than
  // with the company pages.
  { path: '/demo', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/solutions', changeFrequency: 'monthly', priority: 0.8 },
  // The lead ICP gets its own page and outranks the hub it sits under.
  { path: '/solutions/property-managers', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/contact', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
