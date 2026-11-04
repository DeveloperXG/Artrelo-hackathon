// Feature flags for the marketing site.
//
// Three switches, because "is registration open" is really three questions and
// a closed beta answers them differently:
//
//   REGISTRATION_ENABLED  — public landlord sign-up. Someone arriving from
//     nowhere and creating an account. Shut during the beta.
//   TENANT_SIGNUP_ENABLED — a tenant redeeming an invite code. They were
//     invited by a landlord who already has an account, so this is not public
//     sign-up; and a beta landlord with no tenants has no maintenance requests,
//     which is the product.
//   SIGN_IN_ENABLED       — existing accounts getting back in. Never a sign-up.
//
// The API mirrors the same split (REGISTRATION_ENABLED and
// TENANT_SIGNUP_ENABLED there, with login ungated), so a flag flipped here
// without flipping it there only changes what is on screen.
//
// Set per deployment at BUILD time, not in code, and all three default to off.
// They cannot be hard-coded: this app is built by two services at once during
// the Phase 2 cutover — the old marketing-only one and the combined one — and
// only the combined service serves the SPA. Marketing links into the SPA with
// a relative path, so on the marketing-only service a visible Sign In would
// lead to its own 404. Env-driven, each service gets the answer that is true
// of it. The Dockerfile maps one variable per flag to both apps; see
// deploy/README.md.
//
// Must be read as literal `process.env.NEXT_PUBLIC_*` references: Next inlines
// them at build time by that exact text, so a dynamic lookup would stay
// undefined in the static export.
// Accepts TRUE, True, " true ", 1, yes and on, because the operator setting
// this cannot see which spelling the code compares against, and a mismatch used
// to read as off and silently hide every CTA below. The API normalises the same
// way (backend/config/flags.js); keep the three in step.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const on = (value: string | undefined) => TRUTHY.has(String(value ?? '').trim().toLowerCase());

export const REGISTRATION_ENABLED = on(process.env.NEXT_PUBLIC_REGISTRATION_ENABLED);
export const TENANT_SIGNUP_ENABLED = on(process.env.NEXT_PUBLIC_TENANT_SIGNUP_ENABLED);
export const SIGN_IN_ENABLED = on(process.env.NEXT_PUBLIC_SIGN_IN_ENABLED);

// Routes that live in the SPA rather than this site, split by the flag that
// governs each. Used to hide CTAs that lead to a closed gate, and to render
// cross-app links as full-page navigations.
export const TENANT_SIGNUP_ROUTES = ['/signup'] as const;
export const LANDLORD_SIGNUP_ROUTES = ['/landlord-signup'] as const;
export const SIGN_IN_ROUTES = ['/login'] as const;

function matchesAny(routes: readonly string[], path: string): boolean {
  return routes.some((route) => path === route || path.startsWith(`${route}?`) || path.startsWith(`${route}/`));
}

// Any route served by the SPA. These need a plain <a>, not next/link: the page
// does not exist in this app, so a client-side navigation would 404.
export function isSpaAuthRoute(path: string): boolean {
  return (
    matchesAny(TENANT_SIGNUP_ROUTES, path) ||
    matchesAny(LANDLORD_SIGNUP_ROUTES, path) ||
    matchesAny(SIGN_IN_ROUTES, path)
  );
}

// Whether a link may be shown at all. Marketing routes are always available;
// SPA routes depend on their own gate, so "Enter Code" can be visible while
// "Get Started" is not, and "Talk to Sales" is never affected by either.
export function isRouteAvailable(path: string): boolean {
  if (matchesAny(TENANT_SIGNUP_ROUTES, path)) return TENANT_SIGNUP_ENABLED;
  if (matchesAny(LANDLORD_SIGNUP_ROUTES, path)) return REGISTRATION_ENABLED;
  if (matchesAny(SIGN_IN_ROUTES, path)) return SIGN_IN_ENABLED;
  return true;
}
