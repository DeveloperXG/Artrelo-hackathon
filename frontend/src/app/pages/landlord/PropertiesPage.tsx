import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Building2, ChevronDown, Clock, DoorOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { LandlordAPI } from '../../api/client';
import PageHeader from '../../components/landlord/PageHeader';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  FieldLabel,
  LandlordError,
  LandlordLoading,
  PageContainer,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import AddPropertiesDialog from '../../components/landlord/properties/AddPropertiesDialog';
import AddUnitsDialog from '../../components/landlord/units/AddUnitsDialog';
import RetireDialog, { type RetireTarget } from '../../components/landlord/properties/RetireDialog';
import EditPortfolioDialog, { type EditTarget } from '../../components/landlord/properties/EditPortfolioDialog';
import { useLandlordProperties } from '../../hooks/landlord/useLandlordProperties';
import { useLandlordTenants } from '../../hooks/landlord/useLandlordTenants';
import type { Property } from '../../types/landlord';

const unitIdOf = (unit: unknown) =>
  unit && typeof unit === 'object' ? String((unit as { _id?: string })._id || '') : String(unit || '');

export default function PropertiesPage() {
  useLandlordEntrance();
  const { properties, loading, error, reload } = useLandlordProperties();
  // Only for the "Pending move-out" chips: which units have tenants asked to leave.
  const { tenants, reload: reloadTenants } = useLandlordTenants();
  const [archived, setArchived] = useState<Property[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [unitOpen, setUnitOpen] = useState(false);
  // Which property "Add units" opens against — set when the flow starts from a
  // specific property card so the landlord is not asked to pick it twice.
  const [unitTargetProperty, setUnitTargetProperty] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RetireTarget | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const loadArchived = useCallback(async () => {
    try {
      const response = await LandlordAPI.listProperties({ archived: true });
      setArchived((response.data as Property[]) || []);
    } catch {
      // The Archived section is secondary; the page works without it.
      setArchived([]);
    }
  }, []);

  useEffect(() => {
    void loadArchived();
  }, [loadArchived]);

  const pendingMoveOutUnits = useMemo(() => {
    const ids = new Set<string>();
    for (const tenant of tenants) {
      if (tenant.moveOut?.status === 'requested' && tenant.status !== 'inactive') {
        ids.add(unitIdOf(tenant.unit));
      }
    }
    return ids;
  }, [tenants]);

  const openAddUnits = (propertyId = '') => {
    setUnitTargetProperty(propertyId);
    setUnitOpen(true);
  };

  const handleRetired = async () => {
    setDeleteTarget(null);
    await Promise.all([reload(), loadArchived(), reloadTenants()]);
  };

  const closeRetire = (open: boolean) => {
    if (open) return;
    setDeleteTarget(null);
    // A notice sent from the dialog changes the move-out chips.
    void reloadTenants();
  };

  if (loading) {
    return <LandlordLoading label="Loading properties..." />;
  }

  if (error) {
    return <LandlordError title="Properties unavailable" message={error} onRetry={() => void reload()} />;
  }

  const totalUnits = properties.reduce((acc, property) => acc + (property.units || []).length, 0);

  return (
    <PageContainer>
      <PageHeader
        title="Properties & Units"
        description="Manage your properties and unit inventory."
        actions={
          <>
            <div className="mr-5 hidden items-center gap-4 sm:flex">
              <div className="text-right">
                <div className="text-lg font-bold text-slate-900">{properties.length}</div>
                <FieldLabel>Properties</FieldLabel>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div className="text-right">
                <div className="text-lg font-bold text-slate-900">{totalUnits}</div>
                <FieldLabel>Units</FieldLabel>
              </div>
            </div>
            <Button
              variant="outline"
              className="h-10 border-slate-200"
              onClick={() => openAddUnits()}
              disabled={properties.length === 0}
            >
              <DoorOpen className="mr-1.5 h-4 w-4" />
              Add units
            </Button>
            <Button
              data-testid="open-add-property"
              className="h-auto min-h-10 shrink whitespace-normal bg-[#137fec] px-4 hover:bg-[#137fec]/90"
              onClick={() => setPropertyOpen(true)}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              Add properties
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        {properties.length === 0 ? (
          <Card className="ll-fade-up border border-slate-100 p-6 shadow-sm">
            <EmptyState
              icon={Building2}
              title="No properties yet"
              description="Add your first property to start tracking units, tenants, and requests."
            />
            <div className="mt-4 flex justify-center">
              <Button
                className="bg-[#137fec] hover:bg-[#137fec]/90"
                onClick={() => setPropertyOpen(true)}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                Add property
              </Button>
            </div>
          </Card>
        ) : (
          properties.map((property, index) => (
            <Card
              key={property._id}
              data-testid={`property-card-${property._id}`}
              style={{ animationDelay: `${index * 60}ms` }}
              className="ll-fade-up gap-0 border border-slate-200/70 p-6 shadow-sm transition duration-300 hover:-translate-y-0.5 hover:border-[#137fec]/25 hover:shadow-md"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-4">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#137fec]/10 text-[#137fec]">
                    <Building2 className="h-6 w-6" />
                  </div>
                  <div className="min-w-min flex-1 basis-0">
                    <div className="text-lg font-semibold text-slate-900">{property.name}</div>
                    <div className="text-sm text-slate-500">{property.address}</div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {(property.units || []).some((unit) => pendingMoveOutUnits.has(unit._id)) ? (
                    <div className="flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
                      <Clock className="h-3.5 w-3.5" />
                      Pending move-out
                    </div>
                  ) : null}
                  <div className="rounded-full bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-slate-600">
                    {(property.units || []).length} units
                  </div>
                  <Link
                    to={`/dashboard/properties/${property._id}`}
                    data-testid={`property-history-${property._id}`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition hover:border-[#137fec]/40 hover:text-[#137fec]"
                  >
                    <Archive className="h-3.5 w-3.5" />
                    History
                  </Link>
                  <Button
                    data-testid={`edit-property-${property._id}`}
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${property.name}`}
                    className="h-8 w-8 text-slate-400 hover:bg-slate-100 hover:text-[#137fec]"
                    onClick={() => setEditTarget({ kind: 'property', property })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    data-testid={`delete-property-${property._id}`}
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${property.name}`}
                    className="h-8 w-8 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    onClick={() => setDeleteTarget({ kind: 'property', id: property._id, name: property.name })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {(property.units || []).length > 0 ? (
                <div className="mt-5 grid grid-cols-1 gap-3 @min-[38rem]/page:grid-cols-2 lg:@min-[42rem]/page:grid-cols-3 lg:@min-[74rem]/page:grid-cols-4">
                  {(property.units || []).map((unit) => (
                    <div
                      key={unit._id}
                      className="group/unit rounded-xl border border-slate-100 bg-slate-50/70 p-4 transition hover:border-[#137fec]/30 hover:bg-white"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2 font-medium text-slate-900">
                          <DoorOpen className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="truncate">Unit {unit.unitNumber}</span>
                          {pendingMoveOutUnits.has(unit._id) ? (
                            <span
                              title="Tenants here have been asked to move out"
                              className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700"
                            >
                              Move-out
                            </span>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Link
                            to={`/dashboard/properties/${property._id}?unit=${unit._id}`}
                            aria-label={`History for unit ${unit.unitNumber}`}
                            title="Job history"
                            className="rounded-md p-1.5 text-slate-300 transition hover:bg-white hover:text-[#137fec] group-hover/unit:text-slate-400"
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Link>
                          <Button
                            data-testid={`edit-unit-${unit._id}`}
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit unit ${unit.unitNumber}`}
                            title="Edit unit"
                            className="h-7 w-7 text-slate-300 transition hover:bg-white hover:text-[#137fec] group-hover/unit:text-slate-400"
                            onClick={() => setEditTarget({ kind: 'unit', unit, propertyName: property.name })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            data-testid={`delete-unit-${unit._id}`}
                            variant="ghost"
                            size="icon"
                            aria-label={`Delete unit ${unit.unitNumber}`}
                            className="h-7 w-7 text-slate-300 transition hover:bg-rose-50 hover:text-rose-600 group-hover/unit:text-slate-400"
                            onClick={() =>
                              setDeleteTarget({
                                kind: 'unit',
                                id: unit._id,
                                name: `Unit ${unit.unitNumber}`,
                              })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => openAddUnits(property._id)}
                  className="mt-5 w-full rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-4 text-sm text-slate-400 transition hover:border-[#137fec]/40 hover:text-[#137fec]"
                >
                  + Add the first unit
                </button>
              )}
            </Card>
          ))
        )}

        {archived.length > 0 ? (
          <Card className="ll-fade-up gap-0 border border-slate-100 p-0 shadow-sm" data-testid="archived-properties">
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              aria-expanded={archivedOpen}
              className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <Archive className="h-4 w-4 text-slate-400" />
                Archived ({archived.length})
              </span>
              <ChevronDown className={`h-4 w-4 text-slate-400 transition ${archivedOpen ? 'rotate-180' : ''}`} />
            </button>
            {archivedOpen ? (
              <ul className="divide-y divide-slate-100 border-t border-slate-100">
                {archived.map((property) => (
                  <li key={property._id} className="flex items-center justify-between gap-3 px-6 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-700">{property.name}</div>
                      <div className="truncate text-xs text-slate-400">
                        {property.address}
                        {property.archivedAt
                          ? ` · Archived ${new Date(property.archivedAt).toLocaleDateString(undefined, {
                              month: 'long',
                              day: 'numeric',
                              year: 'numeric',
                            })}`
                          : ''}
                      </div>
                    </div>
                    <Link
                      to={`/dashboard/properties/${property._id}`}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition hover:border-[#137fec]/40 hover:text-[#137fec]"
                    >
                      History
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}
      </div>

      <AddPropertiesDialog
        open={propertyOpen}
        onOpenChange={setPropertyOpen}
        properties={properties}
        onCreated={reload}
      />

      <AddUnitsDialog
        open={unitOpen}
        onOpenChange={setUnitOpen}
        properties={properties}
        initialPropertyId={unitTargetProperty}
        onCreated={reload}
      />

      <RetireDialog target={deleteTarget} onOpenChange={closeRetire} onRetired={handleRetired} />

      <EditPortfolioDialog
        target={editTarget}
        onOpenChange={(open) => (open ? null : setEditTarget(null))}
        onSaved={async () => {
          setEditTarget(null);
          await reload();
        }}
      />
    </PageContainer>
  );
}
