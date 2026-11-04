import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock, HardHat, Plus, SearchX, Siren, Users } from 'lucide-react';
import { toast } from 'sonner';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import TablePagination from '../../components/landlord/TablePagination';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  ConfirmDialog,
  EmptyState,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import AutoFindComingSoon from '../../components/landlord/vendors/AutoFindComingSoon';
import CoverageCard from '../../components/landlord/vendors/CoverageCard';
import VendorCard from '../../components/landlord/vendors/VendorCard';
import VendorFilterBar from '../../components/landlord/vendors/VendorFilterBar';
import VendorFormDialog from '../../components/landlord/vendors/VendorFormDialog';
import VendorTable from '../../components/landlord/vendors/VendorTable';
import {
  EMPTY_FILTERS,
  averageResponseMinutes,
  filterVendors,
  formatMinutes,
  missingDetails,
  sortVendors,
  specialtyCounts,
  type VendorFilterState,
} from '../../components/landlord/vendors/vendorFilters';
import { useLandlordVendors } from '../../hooks/landlord/useLandlordVendors';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { paginate } from '../../lib/paginate';
import type { VendorItem } from '../../types/landlord';

const PAGE_SIZE = 8;

export default function VendorsPage() {
  useLandlordEntrance();
  const { vendors, loading, error, reload } = useLandlordVendors();
  // `undefined` = dialog closed, `null` = adding, a vendor = editing it.
  const [editing, setEditing] = useState<VendorItem | null | undefined>(undefined);
  const [vendorToDelete, setVendorToDelete] = useState<VendorItem | null>(null);
  const [filters, setFilters] = useState<VendorFilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  // One layout mounted at a time, so a vendor's row test ids never appear twice.
  const wide = useMediaQuery('(min-width: 768px)');

  const visible = useMemo(
    () => sortVendors(filterVendors(vendors, filters), filters.sort),
    [vendors, filters]
  );
  const specialties = useMemo(() => specialtyCounts(vendors), [vendors]);
  const paged = paginate(visible, page, PAGE_SIZE);
  // Any change to what's shown starts again from the first page.
  useEffect(() => setPage(1), [filters]);

  const stats = useMemo(
    () => ({
      trades: specialties.length,
      emergency: vendors.filter((v) => v.emergencyAvailable).length,
      response: averageResponseMinutes(vendors),
      missing: vendors.filter((v) => missingDetails(v).length).length,
    }),
    [vendors, specialties]
  );

  const confirmDeleteVendor = async () => {
    if (!vendorToDelete) return;
    try {
      await LandlordAPI.deleteVendor(vendorToDelete._id);
      setVendorToDelete(null);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove vendor');
    }
  };

  if (loading) {
    return <LandlordLoading label="Loading vendors..." />;
  }

  if (error) {
    return <LandlordError title="Vendor page unavailable" message={error} onRetry={() => void reload()} />;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Vendor Network"
        description="Build and manage your trusted maintenance vendor network."
        actions={
          <>
            <AutoFindComingSoon className="hidden md:inline-flex" />
            <Button
              data-testid="open-add-vendor"
              className="h-10 bg-[#137fec] px-4 hover:bg-[#137fec]/90"
              onClick={() => setEditing(null)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add vendor
            </Button>
          </>
        }
      />

      {vendors.length === 0 ? (
        <Card className="ll-fade-up border border-slate-200/70 p-6 shadow-sm">
          <EmptyState
            testId="empty-vendors"
            icon={HardHat}
            title="No vendors yet"
            description="Add your trusted contractors so Artrelo can route work to them."
          />
          <div className="mt-4 flex justify-center">
            <Button className="bg-[#137fec] hover:bg-[#137fec]/90" onClick={() => setEditing(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add vendor
            </Button>
          </div>
        </Card>
      ) : (
        <>
          <StatGrid className="mb-6">
            <StatCard
              icon={Users}
              tone="blue"
              label="Total vendors"
              value={vendors.length}
              sub={`Across ${stats.trades} trade${stats.trades === 1 ? '' : 's'}`}
            />
            <StatCard
              icon={Siren}
              tone="rose"
              label="Emergency-ready"
              value={stats.emergency}
              sub="Take emergency calls"
              delay={60}
            />
            <StatCard
              icon={Clock}
              tone="blue"
              label="Avg. first response"
              value={formatMinutes(stats.response)}
              sub={stats.response ? 'Across vendors with a record' : 'No responses recorded yet'}
              delay={120}
            />
            <StatCard
              icon={AlertTriangle}
              tone={stats.missing ? 'amber' : 'slate'}
              label="Missing details"
              value={stats.missing}
              sub="Can't receive job offers yet"
              onClick={stats.missing ? () => setFilters((f) => ({ ...f, missingOnly: !f.missingOnly })) : undefined}
              active={Boolean(filters.missingOnly)}
              delay={180}
              testId="vendor-stat-missing"
            />
          </StatGrid>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_16rem] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
            <Card className="ll-fade-up min-w-0 gap-0 overflow-hidden border border-slate-200/70 p-0 shadow-sm">
              <VendorFilterBar
                filters={filters}
                onChange={setFilters}
                specialties={specialties}
                shown={visible.length}
                total={vendors.length}
              />
              {visible.length === 0 ? (
                <div className="border-t border-slate-100 p-8 text-center" data-testid="vendors-no-match">
                  <SearchX className="mx-auto h-6 w-6 text-slate-300" />
                  <p className="mt-2 text-sm font-medium text-slate-700">No vendors match these filters</p>
                  <button
                    type="button"
                    onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}
                    className="mt-1 text-sm font-medium text-[#137fec] hover:underline"
                  >
                    Clear filters
                  </button>
                </div>
              ) : wide ? (
                <div className="border-t border-slate-100">
                  <VendorTable vendors={paged.rows} onEdit={setEditing} onDelete={setVendorToDelete} />
                </div>
              ) : (
                <div className="grid gap-4 border-t border-slate-100 p-4">
                  {paged.rows.map((vendor, index) => (
                    <VendorCard
                      key={vendor._id}
                      vendor={vendor}
                      index={index}
                      onEdit={() => setEditing(vendor)}
                      onDelete={() => setVendorToDelete(vendor)}
                    />
                  ))}
                </div>
              )}
              {paged.totalPages > 1 ? (
                <div className="border-t border-slate-100 px-5 py-3">
                  <TablePagination
                    page={paged.page}
                    totalPages={paged.totalPages}
                    total={paged.total}
                    from={paged.from}
                    to={paged.to}
                    noun="vendors"
                    onPageChange={setPage}
                    testId="vendor-pagination"
                  />
                </div>
              ) : null}
            </Card>

            <div className="min-w-0">
              <CoverageCard
                vendors={vendors}
                onAddVendor={() => setEditing(null)}
                onPickTrade={(trade) => setFilters((f) => ({ ...f, specialties: [trade] }))}
              />
            </div>
          </div>
        </>
      )}

      <VendorFormDialog
        open={editing !== undefined}
        onOpenChange={(next) => (next ? null : setEditing(undefined))}
        vendor={editing ?? null}
        onSaved={reload}
      />

      <ConfirmDialog
        open={Boolean(vendorToDelete)}
        onOpenChange={(next) => (next ? null : setVendorToDelete(null))}
        title="Remove vendor"
        description={
          <>
            Remove <span className="font-semibold text-slate-700">{vendorToDelete?.name}</span> from your
            network? This can't be undone.
          </>
        }
        confirmLabel="Remove vendor"
        onConfirm={confirmDeleteVendor}
      />
    </PageContainer>
  );
}
