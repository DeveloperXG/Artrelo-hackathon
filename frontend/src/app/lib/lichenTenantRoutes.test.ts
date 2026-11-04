import { describe, expect, it } from 'vitest';
import { isLichenLandlordPath, isLichenTenantPath, LICHEN_TENANT_ENABLED } from './lichenRoutes';

const tenantPaths = ['/portal', '/portal/new', '/portal/safety', '/portal/schedule', '/portal/settings', '/portal/requests/owned'];
describe('tenant presentation activation gate', () => {
  it('enables all six owner-authorized tenant route patterns by default', () => {
    expect(LICHEN_TENANT_ENABLED).toBe(true);
    for (const path of tenantPaths) {
      expect(isLichenTenantPath(path), path).toBe(true);
      expect(isLichenTenantPath(`${path}///`), path).toBe(true);
      expect(isLichenTenantPath(path, false), path).toBe(false);
    }
  });
  it('accepts only the exact enabled tenant pages and one record segment, normalizing trailing slashes', () => {
    for (const path of tenantPaths) {
      expect(isLichenTenantPath(path, true), path).toBe(true);
      expect(isLichenTenantPath(`${path}/`, true), path).toBe(true);
      expect(isLichenTenantPath(`${path}///`, true), path).toBe(true);
      expect(isLichenTenantPath(path, false), path).toBe(false);
    }
    for (const path of ['', '/', '/portal/requests', '/portal/requests/', '/portal/requests/a/extra', '/portal/new/extra', '/portal/safety/extra', '/portal/schedule/extra', '/portal/settings/extra', '/portal/unknown', '/portalish', '/tenant', '/tenant/requests/a', '/vendor', '/dashboard', '/dashboard/requests/a', '/dashboard/guided-demo', '/Portal']) {
      expect(isLichenTenantPath(path), path).toBe(false);
      expect(isLichenTenantPath(path, true), path).toBe(false);
    }
  });
  it('preserves the existing landlord and Guided demo matcher independently', () => {
    for (const path of ['/dashboard', '/dashboard/requests', '/dashboard/requests/owned/', '/dashboard/decisions', '/dashboard/guided-demo/']) expect(isLichenLandlordPath(path), path).toBe(true);
    for (const path of tenantPaths) expect(isLichenLandlordPath(path), path).toBe(false);
  });
});
