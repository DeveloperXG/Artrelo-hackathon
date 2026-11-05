import { describe, expect, it } from 'vitest';
import { isLichenLandlordPath } from './lichenRoutes';

describe('isLichenLandlordPath', () => {
  it('scopes the migrated Overview, Activity and Policy pages', () => {
    expect(isLichenLandlordPath('/dashboard')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/activity')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/policy')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/policy/')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/guided-demo')).toBe(true);
    expect(isLichenLandlordPath('/dashboard/guided-demo/')).toBe(true);
  });

  it('activates only the exact Wallet/Payments and Schedule paths without cross-role aliases', () => {
    for (const path of ['/dashboard/wallet', '/dashboard/wallet/', '/dashboard/schedule', '/dashboard/schedule/']) expect(isLichenLandlordPath(path), path).toBe(true);
    for (const path of ['/portal/wallet', '/portal/schedule', '/dashboard/payments', '/dashboard/wallet/unknown', '/dashboard/schedule/unknown']) expect(isLichenLandlordPath(path), path).toBe(false);
  });

  it('activates the exact six remaining landlord patterns', () => {
    for (const path of ['/dashboard/properties', '/dashboard/properties/', '/dashboard/properties/owned', '/dashboard/properties/owned/', '/dashboard/tenants', '/dashboard/vendors', '/dashboard/billing', '/dashboard/reports']) expect(isLichenLandlordPath(path), path).toBe(true);
    for (const path of ['/portal/properties', '/vendor-hub', '/dashboard/properties/owned/extra', '/dashboard/tenants/extra', '/dashboard/vendors/extra', '/dashboard/billing/extra', '/dashboard/reports/extra']) expect(isLichenLandlordPath(path), path).toBe(false);
  });
  it('keeps unknown landlord paths outside the presentation scope', () => {
    for (const path of [
      '/dashboard/activity/extra',
      '/dashboard/requests/abc/extra',
      '/dashboard/wallet/extra',
      '/dashboard/schedule/extra',
      '/dashboard/policy/extra',
      '/dashboard/guided-demo/extra',
    ]) {
      expect(isLichenLandlordPath(path), path).toBe(false);
    }
  });
  it('activates only the D3 request list, single record and Decisions routes', () => {
    for (const path of ['/dashboard/requests', '/dashboard/requests/', '/dashboard/requests/abc', '/dashboard/requests/abc/', '/dashboard/decisions', '/dashboard/decisions/']) {
      expect(isLichenLandlordPath(path), path).toBe(true);
    }
    expect(isLichenLandlordPath('/tenant/requests/abc')).toBe(false);
  });
});
