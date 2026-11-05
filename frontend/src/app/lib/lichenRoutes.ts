/**
 * Landlord pages already migrated to the Lichen Light content scope.
 *
 * The shell (sidebar, phone bar) is always Lichen; the page column joins the
 * scope only on these paths. Every other landlord page still renders its own
 * light markup, and putting that under different semantic roles would make its
 * shared controls unreadable, so it keeps the legacy light column until its own
 * phase adds its path here.
 */
export const LICHEN_LANDLORD_PATHS: readonly string[] = ['/dashboard', '/dashboard/activity', '/dashboard/policy', '/dashboard/guided-demo', '/dashboard/requests', '/dashboard/decisions', '/dashboard/wallet', '/dashboard/schedule', '/dashboard/properties', '/dashboard/tenants', '/dashboard/vendors', '/dashboard/billing', '/dashboard/reports'];

export function isLichenLandlordPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return LICHEN_LANDLORD_PATHS.includes(path) || /^\/dashboard\/(?:requests|properties)\/[^/]+$/.test(path);
}

// Presentation only, never an access/role gate. Owner-authorized activation
// does not imply that all tenant presentation acceptance is complete.
export const LICHEN_TENANT_ENABLED = true;
const LICHEN_TENANT_PATHS: readonly string[] = ['/portal', '/portal/new', '/portal/safety', '/portal/schedule', '/portal/settings'];

export function isLichenTenantPath(pathname: string, enabled: boolean = LICHEN_TENANT_ENABLED): boolean {
  if (!enabled) return false;
  const path = pathname.replace(/\/+$/, '') || '/';
  return LICHEN_TENANT_PATHS.includes(path) || /^\/portal\/requests\/[^/]+$/.test(path);
}
