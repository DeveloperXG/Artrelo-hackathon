import { Settings } from 'lucide-react';
import { TenantPage, TenantPageHeader } from '../../components/tenant/tenantPresentation';
import { EmptyState, useLandlordEntrance } from '../../components/landlord/landlordUi';
import { Card } from '../../components/ui/card';

export default function SettingsPage() {
  useLandlordEntrance();

  return (
    <TenantPage>
      <TenantPageHeader
        icon={Settings}
        title="Settings"
        description="Manage your tenant account preferences."
        titleTestId="tenant-settings-title"
      />

      <Card className="ll-fade-up border border-slate-100 p-5 shadow-sm in-[.lichen-d5]:rounded-lg in-[.lichen-d5]:border-border in-[.lichen-d5]:bg-card in-[.lichen-d5]:shadow-none">
        <EmptyState
          icon={Settings}
          title="Settings coming soon"
          description="Account and notification preferences will live here."
        />
      </Card>
    </TenantPage>
  );
}
