// Builds a URL that points into the SPA (auth / portal / dashboard routes).
//
// In production the marketing site and the SPA are served from one origin via a
// reverse proxy (see deploy/nginx.conf), so a relative path like "/login" is
// correct. In dev they run as separate servers (marketing :3001, SPA :3000), so
// we prefix the SPA's dev origin to keep cross-app links clickable.
//
// Always render these with a plain <a> (not next/link): the target route does
// not exist in the Next app, so a client-side navigation would 404.
export function appUrl(path: string): string {
  return process.env.NODE_ENV === 'development' ? `http://localhost:3000${path}` : path;
}
