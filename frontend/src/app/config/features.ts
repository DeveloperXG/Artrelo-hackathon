// Feature flags for the app.
//
// Three switches, because "is registration open" is really three questions and
// a closed beta answers them differently:
//
//   REGISTRATION_ENABLED  — /landlord-signup. Public sign-up: someone arriving
//     from nowhere and creating an account. Shut during the beta.
//   TENANT_SIGNUP_ENABLED — /signup, where a tenant redeems an invite code.
//     They were invited by a landlord who already has an account, so this is
//     not public sign-up; and a beta landlord with no tenants has no
//     maintenance requests, which is the product.
//   SIGN_IN_ENABLED       — /login. Never a sign-up, so closing registration
//     must not close it.
//
// A route behind a closed gate redirects to the marketing site, so it cannot be
// reached by direct URL either.
//
// The API mirrors the same split (REGISTRATION_ENABLED and
// TENANT_SIGNUP_ENABLED there, with login ungated), so a flag flipped here
// without flipping it there only hides the page.
//
// Set per deployment at BUILD time (VITE_*), not in code, and all three default
// to off — see marketing/config/features.ts for why they cannot be hard-coded.
// The Dockerfile feeds one variable per flag to both apps, so the two cannot
// drift. For local dev, set them in frontend/.env.local.
const env = (import.meta as { env: Record<string, string | undefined> }).env;
// Accepts TRUE, True, " true ", 1, yes and on, because the operator setting
// this cannot see which spelling the code compares against, and a mismatch used
// to read as off and silently hide every CTA below. The API normalises the same
// way (backend/config/flags.js); keep the three in step.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const on = (value: string | undefined) => TRUTHY.has(String(value ?? '').trim().toLowerCase());

export const REGISTRATION_ENABLED = on(env.VITE_REGISTRATION_ENABLED);
export const TENANT_SIGNUP_ENABLED = on(env.VITE_TENANT_SIGNUP_ENABLED);
export const SIGN_IN_ENABLED = on(env.VITE_SIGN_IN_ENABLED);

// Routes behind each gate, kept separate so a CTA pointing at one is not
// hidden by another (e.g. "Talk to Sales" -> /contact stays visible).
export const TENANT_SIGNUP_ROUTES = ['/signup'] as const;
export const LANDLORD_SIGNUP_ROUTES = ['/landlord-signup'] as const;
export const SIGN_IN_ROUTES = ['/login'] as const;

function matchesAny(routes: readonly string[], path: string): boolean {
  return routes.some((route) => path === route || path.startsWith(`${route}?`) || path.startsWith(`${route}/`));
}

export function isTenantSignupRoute(path: string): boolean {
  return matchesAny(TENANT_SIGNUP_ROUTES, path);
}

export function isLandlordSignupRoute(path: string): boolean {
  return matchesAny(LANDLORD_SIGNUP_ROUTES, path);
}

export function isSignInRoute(path: string): boolean {
  return matchesAny(SIGN_IN_ROUTES, path);
}
