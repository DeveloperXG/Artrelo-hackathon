// Site-wide constants used by SEO metadata and marketing pages.
// Mirrors frontend/src/app/config/site.ts (kept in sync intentionally — the two
// apps deploy independently).
export const SITE_URL =
  (process.env.NEXT_PUBLIC_SITE_URL as string | undefined)?.replace(/\/$/, '') ?? 'https://artrelo.com';
export const SITE_NAME = 'Artrelo';
export const SITE_TAGLINE = 'AI maintenance on autopilot';
export const SALES_EMAIL = 'sales@artrelo.com';
export const PRIVACY_EMAIL = 'privacy@artrelo.com';

// Plausible's site identifier — the bare hostname, no scheme. Derived from
// SITE_URL so a preview deployment does not silently report into production's
// numbers. Set NEXT_PUBLIC_PLAUSIBLE_DOMAIN to "" to disable analytics entirely
// for a build (the layout skips the script when this is empty).
export const PLAUSIBLE_DOMAIN =
  process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN ?? new URL(SITE_URL).hostname;

// Base URL for the Express API. In production the proxy serves the marketing
// export and /api/ from one host (see deploy/nginx.conf), so a relative path is
// correct and no CORS preflight happens. In dev the two are separate servers.
// Baked in at build time — set NEXT_PUBLIC_API_URL if marketing is deployed to
// its own host, and add that origin to MARKETING_URL on the backend.
export const API_BASE_URL =
  (process.env.NEXT_PUBLIC_API_URL as string | undefined)?.replace(/\/$/, '') ??
  (process.env.NODE_ENV === 'development' ? 'http://localhost:5500' : '');
