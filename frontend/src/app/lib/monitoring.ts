import * as Sentry from '@sentry/react';

// Error monitoring for the SPA (Sentry). Off unless VITE_SENTRY_DSN is set at
// build time, so local dev and the test stack report nothing.
//
// PRIVACY, mirroring backend/instrument.js: no performance tracing, no user or
// request details beyond the page, and no secrets from URLs. The browser SDK
// sends no default PII; Sentry's "Prevent Storing of IP Addresses" project
// setting stops it inferring the visitor's IP on its side.
//
// Vendor job links, magic sign-in links, invite and reset links carry their
// token in the path or the fragment, so any path segment of 32+ characters is
// redacted and query strings and fragments are dropped -- from the page URL and
// from every breadcrumb.

const LONG_SEGMENT = /\/[A-Za-z0-9_-]{32,}(?=\/|$)/g;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

export function scrubUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  return url.split(/[?#]/)[0].replace(LONG_SEGMENT, '/[redacted]');
}

const scrubText = (text: unknown) => (typeof text === 'string' ? text.replace(LONG_TOKEN, '[redacted]') : text);

export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request) {
    event.request.url = scrubUrl(event.request.url) as string | undefined;
    delete event.request.query_string;
    delete event.request.headers;
    delete event.request.cookies;
  }
  if (event.message) event.message = scrubText(event.message) as string;
  for (const ex of event.exception?.values || []) ex.value = scrubText(ex.value) as string | undefined;
  return event;
}

function scrubBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  if (crumb.data) {
    // Console breadcrumbs keep the raw arguments: a logged object could be a
    // tenant's request or a payload. The scrubbed message line is enough.
    delete crumb.data.arguments;
    for (const key of ['url', 'from', 'to']) {
      if (key in crumb.data) crumb.data[key] = scrubUrl(crumb.data[key]);
    }
  }
  if (crumb.message) crumb.message = scrubText(crumb.message) as string;
  return crumb;
}

export function initMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) || import.meta.env.MODE,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

/** For createRoot: report errors React catches or can't recover from. */
export const reactErrorHandler = Sentry.reactErrorHandler;
