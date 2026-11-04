import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2,
  Check,
  CheckCircle2,
  Copy,
  DoorOpen,
  KeyRound,
  LogOut,
  MoreHorizontal,
  Search,
  Ticket,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, LandlordAPI } from '../../api/client';
import { FieldError, invalidFieldClass } from '../../components/ui/FieldError';
import PageHeader from '../../components/landlord/PageHeader';
import StatCard, { StatGrid } from '../../components/landlord/StatCard';
import TablePagination from '../../components/landlord/TablePagination';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { cn } from '../../components/ui/utils';
import {
  ConfirmDialog,
  EmptyState,
  FieldLabel,
  FormDialog,
  LandlordError,
  LandlordLoading,
  PageContainer,
  SectionCard,
  fieldClass,
  useLandlordEntrance,
} from '../../components/landlord/landlordUi';
import { useLandlordProperties } from '../../hooks/landlord/useLandlordProperties';
import { useLandlordTenants } from '../../hooks/landlord/useLandlordTenants';
import { paginate } from '../../lib/paginate';
import type { InviteCode, TenantItem } from '../../types/landlord';

const TENANTS_PER_PAGE = 10;
const CODES_PER_PAGE = 5;

function initials(first?: string, last?: string) {
  return `${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase() || '?';
}

const shortDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

/**
 * Where a tenant stands, in the order that matters: gone, leaving, living
 * there. No "unassigned": a tenant joins only through an invite code tied to a
 * unit, and completing a move-out makes them inactive.
 */
function tenantStatus(tenant: TenantItem): { label: string; className: string; dot: string } {
  if (tenant.status === 'inactive') return { label: 'Moved out', className: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' };
  if (tenant.moveOut?.status === 'requested') {
    return { label: 'Move-out requested', className: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' };
  }
  return { label: 'Active', className: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' };
}

const unitOf = (tenant: TenantItem) => (typeof tenant.unit === 'object' && tenant.unit ? tenant.unit : null);

export default function TenantsPage() {
  useLandlordEntrance();
  const { tenants, loading: tenantsLoading, error: tenantsError, reload: reloadTenants } =
    useLandlordTenants();
  const {
    properties,
    loading: propertiesLoading,
    error: propertiesError,
    reload: reloadProperties,
  } = useLandlordProperties();
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [codesLoading, setCodesLoading] = useState(true);
  const [codesError, setCodesError] = useState('');
  const [inviteForm, setInviteForm] = useState({ propertyId: '', unitId: '' });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteErrors, setInviteErrors] = useState<{ propertyId?: string; unitId?: string }>({});
  const [generating, setGenerating] = useState(false);
  // The code just minted, shown in the dialog rather than flashed in a toast.
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [codeToDelete, setCodeToDelete] = useState<InviteCode | null>(null);
  // The landlord-side move-out: for a tenant who left without confirming.
  const [tenantToMoveOut, setTenantToMoveOut] = useState<TenantItem | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('first-asc');
  const [tenantPage, setTenantPage] = useState(1);
  const [codePage, setCodePage] = useState(1);

  const loadCodes = useCallback(async () => {
    setCodesLoading(true);
    setCodesError('');
    try {
      const response = await LandlordAPI.listInviteCodes();
      setCodes((response.data as InviteCode[]) || []);
    } catch (error) {
      setCodesError(error instanceof Error ? error.message : 'Failed to load invite codes');
    } finally {
      setCodesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCodes();
  }, [loadCodes]);

  const openInvite = () => {
    setInviteForm({ propertyId: '', unitId: '' });
    setInviteErrors({});
    setGeneratedCode(null);
    setInviteOpen(true);
  };

  // A code needs BOTH a property and a unit: a unit-less code signed a tenant
  // up attached to nothing, and their requests could not be routed.
  const generateCode = async () => {
    const errors = {
      propertyId: inviteForm.propertyId ? undefined : 'Select a property.',
      unitId: inviteForm.unitId
        ? undefined
        : inviteForm.propertyId
          ? 'Select a unit.'
          : 'Select a property first, then a unit.',
    };
    setInviteErrors(errors);
    if (errors.propertyId || errors.unitId) return;

    setGenerating(true);
    try {
      const response = await LandlordAPI.generateInviteCode({
        propertyId: inviteForm.propertyId,
        unitId: inviteForm.unitId,
      });
      const code = (response.data as { code: string }).code;
      setGeneratedCode(code);
      await Promise.all([loadCodes(), reloadTenants(), reloadProperties()]);
    } catch (error) {
      const fields = error instanceof ApiError ? (error.payload as { fields?: typeof errors } | null)?.fields : null;
      if (fields) setInviteErrors(fields);
      else toast.error(error instanceof Error ? error.message : 'Could not generate a code');
    } finally {
      setGenerating(false);
    }
  };

  const confirmDeleteCode = async () => {
    if (!codeToDelete) return;
    try {
      await LandlordAPI.deleteInviteCode(codeToDelete._id);
      setCodeToDelete(null);
      await loadCodes();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete that code');
    }
  };

  const confirmMoveOut = async () => {
    if (!tenantToMoveOut) return;
    try {
      await LandlordAPI.moveOutTenant(tenantToMoveOut._id);
      setTenantToMoveOut(null);
      await reloadTenants();
    } catch (error) {
      // e.g. 409: the tenant still has an open request on the unit.
      toast.error(error instanceof Error ? error.message : 'Could not move this tenant out');
    }
  };

  const copyCode = (id: string, value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? '' : current)), 1500);
  };

  const propertyNames = useMemo(
    () => new Map(properties.map((property) => [property._id, property.name])),
    [properties]
  );

  const visibleTenants = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? tenants.filter(
          (tenant) =>
            `${tenant.firstName} ${tenant.lastName}`.toLowerCase().includes(query) ||
            (tenant.email || '').toLowerCase().includes(query)
        )
      : tenants;
    const [field, direction] = sort.split('-');
    const sorted = [...filtered].sort((a, b) => {
      const left = (field === 'last' ? a.lastName : a.firstName) || '';
      const right = (field === 'last' ? b.lastName : b.firstName) || '';
      return left.localeCompare(right, undefined, { sensitivity: 'base' });
    });
    if (direction === 'desc') sorted.reverse();
    return sorted;
  }, [tenants, search, sort]);

  // A new search or sort starts from the first page.
  useEffect(() => setTenantPage(1), [search, sort]);

  const counts = useMemo(() => {
    const current = tenants.filter((tenant) => tenant.status !== 'inactive');
    const occupied = new Set(current.map((tenant) => unitOf(tenant)?._id).filter(Boolean));
    return {
      current: current.filter((tenant) => tenant.unit).length,
      occupied: occupied.size,
      moveOuts: current.filter((tenant) => tenant.moveOut?.status === 'requested').length,
    };
  }, [tenants]);

  const loading = tenantsLoading || propertiesLoading || codesLoading;
  const error = tenantsError || propertiesError || codesError;

  if (loading) {
    return <LandlordLoading label="Loading tenants..." />;
  }

  if (error) {
    return (
      <LandlordError
        title="Tenant page unavailable"
        message={error}
        onRetry={() => {
          void Promise.all([reloadTenants(), reloadProperties(), loadCodes()]);
        }}
      />
    );
  }

  const selectedProperty = properties.find((property) => property._id === inviteForm.propertyId);
  const unitsOfSelected = selectedProperty?.units || [];
  const selectedUnit = unitsOfSelected.find((unit) => unit._id === inviteForm.unitId);
  const tenantPageData = paginate(visibleTenants, tenantPage, TENANTS_PER_PAGE);
  const codePageData = paginate(codes, codePage, CODES_PER_PAGE);

  return (
    <PageContainer>
      <PageHeader
        title="Tenants & Invites"
        description="Manage residents and share onboarding invite codes."
        actions={
          <Button
            data-testid="open-generate-code"
            className="h-auto min-h-10 shrink whitespace-normal bg-[#137fec] px-4 hover:bg-[#137fec]/90"
            onClick={openInvite}
          >
            <KeyRound className="mr-1.5 h-4 w-4" />
            Generate code
          </Button>
        }
      />

      <StatGrid className="mb-6">
        <StatCard icon={Users} tone="blue" label="Current tenants" value={counts.current} sub="Living in one of your units" />
        <StatCard
          icon={Building2}
          tone="blue"
          label="Occupied units"
          value={counts.occupied}
          sub="With at least one tenant"
          delay={60}
        />
        <StatCard
          icon={Ticket}
          tone="blue"
          label="Pending invites"
          value={codes.length}
          sub="Codes not used yet"
          delay={120}
        />
        <StatCard
          icon={UserMinus}
          tone={counts.moveOuts ? 'amber' : 'blue'}
          label="Move-outs requested"
          value={counts.moveOuts}
          sub="Waiting for the tenant to move out"
          delay={180}
        />
      </StatGrid>

      <div className="space-y-6">
        <SectionCard
          icon={Users}
          title="Current tenants"
          description="People onboarded across your portfolio."
          action={
            <span className="rounded-full bg-[#137fec]/10 px-3 py-1 text-xs font-semibold text-[#137fec]">
              {tenants.length} tenant{tenants.length === 1 ? '' : 's'}
            </span>
          }
        >
          {tenants.length === 0 ? (
            <EmptyState
              testId="empty-tenants"
              icon={Users}
              title="No tenants yet"
              description="Generate an invite code to onboard your first tenant."
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    data-testid="tenant-search"
                    className="h-10 border-slate-200 bg-white pl-9 shadow-sm focus-visible:border-[#137fec] focus-visible:ring-[#137fec]/15"
                    placeholder="Search by name or email..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <select
                  data-testid="tenant-sort"
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  className={`${fieldClass} sm:w-56`}
                  aria-label="Sort tenants"
                >
                  <option value="first-asc">First name (A–Z)</option>
                  <option value="first-desc">First name (Z–A)</option>
                  <option value="last-asc">Last name (A–Z)</option>
                  <option value="last-desc">Last name (Z–A)</option>
                </select>
              </div>

              {visibleTenants.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center text-sm text-slate-400">
                  No tenants match “{search}”.
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-xl border border-slate-100">
                    <table className="w-full min-w-[40rem] text-left text-sm">
                      <thead className="bg-slate-50/80 text-xs font-semibold text-slate-500">
                        <tr>
                          <th className="px-4 py-2.5 font-semibold">Tenant</th>
                          <th className="px-4 py-2.5 font-semibold">Property</th>
                          <th className="px-4 py-2.5 font-semibold">Unit</th>
                          <th className="px-4 py-2.5 font-semibold">Status</th>
                          <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {tenantPageData.rows.map((tenant) => {
                          const unit = unitOf(tenant);
                          const propertyName = unit?.propertyId ? propertyNames.get(unit.propertyId) : undefined;
                          const status = tenantStatus(tenant);
                          const canMoveOut = tenant.status !== 'inactive' && Boolean(tenant.unit);
                          return (
                            <tr key={tenant._id} data-testid={`tenant-row-${tenant._id}`} className="transition hover:bg-slate-50/60">
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#137fec] to-[#a855f7] text-xs font-bold text-white">
                                    {initials(tenant.firstName, tenant.lastName)}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="truncate font-medium text-slate-900">
                                      {tenant.firstName} {tenant.lastName}
                                    </div>
                                    <div className="truncate text-xs text-slate-500">{tenant.email}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                {propertyName && tenant.status !== 'inactive' ? (
                                  <span className="flex items-center gap-2 text-slate-700">
                                    <Building2 className="h-4 w-4 shrink-0 text-slate-400" />
                                    <span className="truncate">{propertyName}</span>
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-slate-700">
                                {unit?.unitNumber && tenant.status !== 'inactive' ? (
                                  <span className="flex items-center gap-1.5">
                                    <DoorOpen className="h-3.5 w-3.5 text-slate-400" />
                                    Unit {unit.unitNumber}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <span
                                  className={cn(
                                    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold',
                                    status.className
                                  )}
                                >
                                  <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
                                  {status.label}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                {canMoveOut ? (
                                  <Button
                                    data-testid={`move-out-tenant-${tenant._id}`}
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs text-slate-500 hover:bg-amber-50 hover:text-amber-700"
                                    aria-label={`Move out ${tenant.firstName} ${tenant.lastName}`}
                                    onClick={() => setTenantToMoveOut(tenant)}
                                  >
                                    <LogOut className="h-3.5 w-3.5" />
                                    Move out
                                  </Button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <TablePagination
                    page={tenantPageData.page}
                    totalPages={tenantPageData.totalPages}
                    total={tenantPageData.total}
                    from={tenantPageData.from}
                    to={tenantPageData.to}
                    noun="tenants"
                    onPageChange={setTenantPage}
                    testId="tenant-pagination"
                  />
                </>
              )}
            </div>
          )}
        </SectionCard>

        <SectionCard
          icon={Ticket}
          iconColor="#a855f7"
          title="Invite codes"
          description="Unused codes to share with tenants. A code disappears once it's used or expires."
          delay={70}
          action={
            codes.length ? (
              <span className="rounded-full bg-[#137fec]/10 px-3 py-1 text-xs font-semibold text-[#137fec]">
                {codes.length} code{codes.length === 1 ? '' : 's'}
              </span>
            ) : undefined
          }
        >
          {codes.length === 0 ? (
            <EmptyState
              testId="empty-codes"
              icon={Ticket}
              title="No invite codes yet"
              description="Generate a code to share with a new tenant."
            />
          ) : (
            <div className="space-y-4">
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[38rem] text-left text-sm">
                  <thead className="bg-slate-50/80 text-xs font-semibold text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Code</th>
                      <th className="px-4 py-2.5 font-semibold">Assigned to</th>
                      <th className="px-4 py-2.5 font-semibold">Created</th>
                      <th className="px-4 py-2.5 font-semibold">Expires</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {codePageData.rows.map((code) => {
                      const property = typeof code.propertyId === 'object' ? code.propertyId?.name : '';
                      const unitNumber = typeof code.unitId === 'object' ? code.unitId?.unitNumber : '';
                      return (
                        <tr key={code._id} data-testid={`code-row-${code._id}`} className="transition hover:bg-slate-50/60">
                          <td className="px-4 py-3 font-mono text-sm font-bold tracking-wider text-slate-900">{code.code}</td>
                          <td className="px-4 py-3 text-slate-700">
                            {[property, unitNumber ? `Unit ${unitNumber}` : ''].filter(Boolean).join(' – ') || '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-500">{shortDate(code.createdAt)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-slate-500">{shortDate(code.expiresAt)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                data-testid={`copy-code-${code._id}`}
                                variant="outline"
                                size="sm"
                                className="h-8 gap-1.5 border-slate-200 text-xs text-slate-600"
                                aria-label={copiedId === code._id ? 'Copied' : `Copy code ${code.code}`}
                                onClick={() => copyCode(code._id, code.code)}
                              >
                                {copiedId === code._id ? (
                                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5" />
                                )}
                                {copiedId === code._id ? 'Copied' : 'Copy'}
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    aria-label={`More actions for code ${code.code}`}
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem
                                    data-testid={`delete-code-${code._id}`}
                                    onSelect={() => setCodeToDelete(code)}
                                    className="text-rose-600 focus:text-rose-700"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    Delete code
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <TablePagination
                page={codePageData.page}
                totalPages={codePageData.totalPages}
                total={codePageData.total}
                from={codePageData.from}
                to={codePageData.to}
                noun="codes"
                onPageChange={setCodePage}
                testId="code-pagination"
              />
            </div>
          )}
        </SectionCard>
      </div>

      <FormDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        icon={UserPlus}
        title="Generate invite code"
        description="A code is tied to one unit. Share it with the tenant who lives there."
      >
        {generatedCode ? (
          <div className="space-y-4 text-center" data-testid="invite-code-result">
            <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
            <div>
              <div className="text-sm text-slate-500">
                Code for {selectedProperty?.name}
                {selectedUnit ? ` · Unit ${selectedUnit.unitNumber}` : ''}
              </div>
              <div className="mt-2 inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-xl font-bold tracking-[0.2em] text-slate-900">
                {generatedCode}
                <button
                  type="button"
                  data-testid="invite-code-copy"
                  onClick={() => copyCode('generated', generatedCode)}
                  aria-label={copiedId === 'generated' ? 'Copied' : 'Copy code'}
                  className="rounded-md p-1 text-slate-400 transition hover:bg-white hover:text-[#137fec]"
                >
                  {copiedId === 'generated' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <div className="mt-2 text-xs text-slate-500">Valid for 7 days, for one sign-up.</div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={openInvite}>
                Generate another
              </Button>
              <Button className="flex-1 bg-[#137fec] hover:bg-[#137fec]/90" onClick={() => setInviteOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Each error sits ON TOP of its field -- between the label and the
                select -- so it is read before the control it is about. */}
            <label className="block space-y-1.5">
              <FieldLabel>
                Property <span className="text-rose-500">*</span>
              </FieldLabel>
              <FieldError id="invite-property-error">{inviteErrors.propertyId}</FieldError>
              <select
                data-testid="invite-property-select"
                value={inviteForm.propertyId}
                aria-invalid={Boolean(inviteErrors.propertyId)}
                aria-describedby={inviteErrors.propertyId ? 'invite-property-error' : undefined}
                onChange={(event) => {
                  setInviteForm({ propertyId: event.target.value, unitId: '' });
                  setInviteErrors({});
                }}
                className={`${fieldClass} ${inviteErrors.propertyId ? invalidFieldClass : ''}`}
              >
                <option value="">Select property...</option>
                {properties.map((property) => (
                  <option key={property._id} value={property._id}>
                    {property.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1.5">
              <FieldLabel>
                Unit <span className="text-rose-500">*</span>
              </FieldLabel>
              <FieldError id="invite-unit-error">{inviteErrors.unitId}</FieldError>
              <select
                data-testid="invite-unit-select"
                value={inviteForm.unitId}
                disabled={!selectedProperty || unitsOfSelected.length === 0}
                aria-invalid={Boolean(inviteErrors.unitId)}
                aria-describedby={inviteErrors.unitId ? 'invite-unit-error' : undefined}
                onChange={(event) => {
                  setInviteForm({ ...inviteForm, unitId: event.target.value });
                  setInviteErrors((prev) => ({ ...prev, unitId: undefined }));
                }}
                className={`${fieldClass} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
                  inviteErrors.unitId ? invalidFieldClass : ''
                }`}
              >
                <option value="">{selectedProperty ? 'Select unit...' : 'Select a property first'}</option>
                {unitsOfSelected.map((unit) => (
                  <option key={unit._id} value={unit._id}>
                    Unit {unit.unitNumber}
                  </option>
                ))}
              </select>
              {selectedProperty && unitsOfSelected.length === 0 ? (
                <p className="text-xs text-slate-500" data-testid="invite-no-units">
                  {selectedProperty.name} has no units yet.{' '}
                  <Link to="/dashboard/properties" className="font-medium text-[#137fec] hover:underline">
                    Add one in Properties
                  </Link>
                </p>
              ) : null}
            </label>
            <Button
              data-testid="generate-code-btn"
              disabled={generating}
              onClick={() => void generateCode()}
              className="w-full bg-[#137fec] hover:bg-[#137fec]/90"
            >
              <KeyRound className="mr-1.5 h-4 w-4" />
              Generate Code
            </Button>
          </div>
        )}
      </FormDialog>

      <ConfirmDialog
        open={Boolean(codeToDelete)}
        onOpenChange={(next) => (next ? null : setCodeToDelete(null))}
        title="Delete invite code"
        description={
          <>
            Delete <span className="font-mono font-semibold text-slate-700">{codeToDelete?.code}</span>? Anyone
            holding it will no longer be able to sign up with it.
          </>
        }
        confirmLabel="Delete code"
        onConfirm={confirmDeleteCode}
      />

      <ConfirmDialog
        open={Boolean(tenantToMoveOut)}
        onOpenChange={(next) => (next ? null : setTenantToMoveOut(null))}
        title="Move out tenant"
        description={
          <>
            Unlink{' '}
            <span className="font-semibold text-slate-700">
              {tenantToMoveOut?.firstName} {tenantToMoveOut?.lastName}
            </span>{' '}
            from{' '}
            {typeof tenantToMoveOut?.unit === 'object' && tenantToMoveOut?.unit?.unitNumber
              ? `Unit ${tenantToMoveOut.unit.unitNumber}`
              : 'their unit'}
            ? They keep access to their past requests but can't file new ones until you invite them again.
          </>
        }
        confirmLabel="Move out"
        onConfirm={confirmMoveOut}
      />
    </PageContainer>
  );
}
