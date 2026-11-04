import { MapPin, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import type { VendorItem } from '../../../types/landlord';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { cn } from '../../ui/utils';
import { formatMinutes, vendorTags, type VendorTag } from './vendorFilters';
import { formatHours, isOpenNow } from './vendorHours';
import { vendorSpecialties } from './vendorSpecialties';

// One chip and a "+N" (full list on hover): trade names run long, and two
// side by side pushed the table into a sideways scroll at laptop widths.
const MAX_CHIPS = 1;

const TAG_STYLES: Record<VendorTag['key'], string> = {
  trusted: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  emergency: 'border-rose-200 bg-rose-50 text-rose-700',
  new: 'border-slate-200 bg-slate-50 text-slate-600',
  incomplete: 'border-amber-200 bg-amber-50 text-amber-700',
  blocked: 'border-slate-300 bg-slate-100 text-slate-700',
};

export function VendorTagList({ vendor }: { vendor: VendorItem }) {
  const tags = vendorTags(vendor);
  if (!tags.length) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      {tags.map((tag) => (
        <span
          key={tag.key}
          title={tag.key === 'incomplete' ? 'Add an email and hours so this vendor can receive job offers' : undefined}
          className={cn('whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-semibold', TAG_STYLES[tag.key])}
        >
          {tag.label}
        </span>
      ))}
    </div>
  );
}

/**
 * The vendor network as a table (md and up; phones get the card list).
 * "Edit" opens the same VendorFormDialog the cards did; removing lives behind
 * the row menu so it can't be hit by accident.
 */
export default function VendorTable({
  vendors,
  onEdit,
  onDelete,
}: {
  vendors: VendorItem[];
  onEdit: (vendor: VendorItem) => void;
  onDelete: (vendor: VendorItem) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-xs font-semibold text-slate-500">
            <th className="px-4 py-3 font-semibold">Vendor</th>
            <th className="px-3 py-3 font-semibold">Specialties</th>
            <th className="hidden px-3 py-3 font-semibold 2xl:table-cell">Service area</th>
            <th className="px-3 py-3 font-semibold">Availability</th>
            <th className="whitespace-nowrap px-3 py-3 font-semibold" title="Average time to a vendor's first reply">Response</th>
            <th className="px-3 py-3 font-semibold">Jobs</th>
            <th className="px-3 py-3 font-semibold">Status</th>
            <th className="px-3 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {vendors.map((vendor) => {
            const trades = vendorSpecialties(vendor);
            const shown = trades.slice(0, MAX_CHIPS);
            const hidden = trades.length - shown.length;
            const open = isOpenNow(vendor.operatingHours);
            const area = [vendor.city, (vendor.serviceAreas || []).join(', ')].filter(Boolean);
            return (
              <tr key={vendor._id} data-testid={`vendor-row-${vendor._id}`} className="align-middle transition hover:bg-slate-50/70">
                <td className="max-w-[10rem] px-4 py-3.5">
                  <div className="truncate font-semibold text-slate-900">{vendor.name}</div>
                  <div className="truncate text-xs text-slate-500">
                    {vendor.company || vendor.email || vendor.phone || 'Independent'}
                  </div>
                  {/* Below 2xl the service-area column folds in here. */}
                  {area.length ? (
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-slate-400 2xl:hidden">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span className="truncate">{area.join(' · ')}</span>
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3.5">
                  {trades.length ? (
                    <div className="flex flex-nowrap items-center gap-1">
                      {shown.map((trade) => (
                        <span key={trade} className="whitespace-nowrap rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {trade}
                        </span>
                      ))}
                      {hidden > 0 ? (
                        <span
                          className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500"
                          title={trades.slice(MAX_CHIPS).join(', ')}
                        >
                          +{hidden}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">None yet</span>
                  )}
                </td>
                <td className="hidden max-w-[10rem] px-3 py-3.5 2xl:table-cell" title={area.join(' · ') || undefined}>
                  {area.length ? (
                    <div className="flex items-start gap-1.5 text-slate-600">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                      <span className="min-w-0">
                        <span className="block truncate">{area[0]}</span>
                        {area[1] ? <span className="block truncate text-xs text-slate-500">{area[1]}</span> : null}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-3.5">
                  {vendor.operatingHours ? (
                    <div className="max-w-[8rem]" title={`${formatHours(vendor.operatingHours)} — open / closed is based on your local time`}>
                      <div className={cn('flex items-center gap-1.5 whitespace-nowrap text-sm font-medium', open ? 'text-emerald-700' : 'text-slate-500')}>
                        <span className={cn('h-2 w-2 shrink-0 rounded-full', open ? 'bg-emerald-500' : 'bg-slate-300')} />
                        {open ? 'Open now' : 'Closed'}
                      </div>
                      <div className="truncate pl-3.5 text-xs text-slate-500">{formatHours(vendor.operatingHours)}</div>
                    </div>
                  ) : (
                    <span className="text-xs text-amber-700">Hours not set</span>
                  )}
                </td>
                <td className="px-3 py-3.5 text-slate-700 tabular-nums">
                  {formatMinutes(vendor.responseStats?.averageFirstResponseMinutes)}
                </td>
                <td className="px-3 py-3.5 text-slate-700 tabular-nums">{vendor.successfulJobs || 0}</td>
                <td className="px-3 py-3.5">
                  <VendorTagList vendor={vendor} />
                </td>
                <td className="px-3 py-3.5">
                  <div className="flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      data-testid={`edit-vendor-${vendor._id}`}
                      aria-label={`Edit ${vendor.name}`}
                      onClick={() => onEdit(vendor)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-[#137fec] transition hover:border-[#137fec]/30 hover:bg-[#137fec]/5"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`More actions for ${vendor.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          data-testid={`delete-vendor-${vendor._id}`}
                          onSelect={() => onDelete(vendor)}
                          className="text-rose-600 focus:text-rose-700"
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove vendor
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
  );
}
