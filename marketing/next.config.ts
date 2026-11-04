import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// Static export (SSG): `next build` emits pure static HTML/CSS/JS to ./out with
// no Node server required. This is what makes the marketing pages fully
// crawlable — meta tags and body content are in the HTML at build time.
const nextConfig: NextConfig = {
  output: 'export',
  // This app lives inside the ronarAI repo (which has its own lockfile), so
  // pin the tracing root to this directory to avoid Next inferring the repo root.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // Emit /pricing.html rather than /pricing/index.html so URLs stay identical
  // to the existing sitemap/canonicals. The reverse proxy resolves extensionless
  // paths with `try_files $uri $uri.html` (see deploy/nginx.conf).
  trailingSlash: false,
  // Required for output:'export' — there is no image optimizer server.
  images: { unoptimized: true },
};

export default nextConfig;
