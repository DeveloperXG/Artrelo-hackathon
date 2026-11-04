// Builds a URL into the marketing site (served at "/" and the other marketing
// paths by the separate Next.js app).
//
// In production the marketing site and this SPA share one origin via a reverse
// proxy (see deploy/nginx.conf), so a relative path like "/" is correct. In dev
// they run as separate servers (SPA :3000, marketing :3001), so we point at the
// marketing dev origin — otherwise a redirect to "/" would reload the SPA and,
// while registration is closed, loop.
export function marketingUrl(path: string = '/'): string {
  return import.meta.env.DEV ? `http://localhost:3001${path}` : path;
}
